"""The edge agent: keeps the configuration from the platform, runs each camera's modules on the detections from
the GPU pipeline, acts and reports through the dispatcher, sends heartbeats with health and per-minute counters,
flushes the offline outbox and prunes the disk.
"""
import os
import shutil
import threading
import time

from . import __version__, decisions as dec, outputs, storage
from .alarms import Dispatcher


def _minute(t):
    return time.strftime("%Y-%m-%dT%H:%M", time.gmtime(t))


class CameraRuntime:
    """One camera: its modules' settings and state (cooldowns, dwell timers, fire confirmation, counters)."""

    def __init__(self, cam, dispatcher, image_width_px=1920):
        self.cam, self.dispatcher, self.image_width_px = cam, dispatcher, image_width_px
        self.modules = {m["module"]: m["config"] for m in cam.get("modules", [])}
        self.zones = cam.get("zones", [])
        ppe = self.modules.get("ppe", {})
        self.ppe_cooldown = dec.Cooldown(ppe.get("cooldownSeconds", 30))
        fire = self.modules.get("fire_smoke", {})
        self.fire = dec.FireSmokeConfirmer(fire.get("confirmSeconds", 1.5), fire.get("sensitivity", "balanced"))
        intr = self.modules.get("intrusion", {})
        self.dwell = dec.Dwell(intr.get("dwellSeconds", 0.5))
        self.intrusion_cooldown = dec.Cooldown(30)
        self.stats = {}                      # (minute, module) -> counters

    def _count(self, t, module, **inc):
        s = self.stats.setdefault((_minute(t), module), {"frames": 0, "people": 0, "compliant": 0, "inspected": 0, "passed": 0, "ignored": 0})
        for k, v in inc.items():
            s[k] += v

    def _event(self, module, type_, t, **extra):
        return {"cameraId": self.cam["id"], "module": module, "type": type_, "occurredAt": _iso(t), **extra}

    def on_frame(self, detections, t):
        """Applies every module running on this camera to one frame. Returns the external ids submitted."""
        submitted = []
        if "ppe" in self.modules:
            c = self.modules["ppe"]
            zone = next((z["points"] for z in self.zones if z["kind"] == "ppe_zone"), None)
            checks = dec.ppe_check(detections, c.get("requiredGear", ["helmet", "vest"]), c.get("minConfidence", 0.6), zone)
            self._count(t, "ppe", frames=1, people=len(checks), compliant=sum(1 for _, m in checks if not m))
            for person, missing in checks:
                key = (person.track_id, tuple(missing))
                if missing and self.ppe_cooldown.ready(key, t):
                    submitted.append(self.dispatcher.submit(self._event("ppe", "ppe_violation", t, confidence=round(person.confidence, 3), detail={"missing": missing},
                        boxes=[{**person.box, "label": "no " + ", no ".join(missing), "confidence": person.confidence}]), [c["beaconOutput"]] if c.get("beaconOutput") else []))
        if "fire_smoke" in self.modules:
            c = self.modules["fire_smoke"]
            label = self.fire.update(t, detections)
            self._count(t, "fire_smoke", frames=1)
            if label:
                regions = [d for d in detections if d.label == label]
                submitted.append(self.dispatcher.submit(self._event("fire_smoke", label, t, severity="critical", confidence=round(max((d.confidence for d in regions), default=0), 3),
                    boxes=[{**d.box, "label": f"{d.label} {d.confidence:.2f}"} for d in regions], broadcast=c.get("broadcast", True)), [c["sirenOutput"]] if c.get("sirenOutput") else []))
        if "intrusion" in self.modules:
            c = self.modules["intrusion"]
            hits, ignored = dec.intrusions(detections, self.zones, tuple(c.get("classes", ["person", "vehicle"])))
            self._count(t, "intrusion", frames=1, ignored=ignored)
            inside = set()
            for d, zone in hits:
                key = (d.track_id, zone["id"])
                inside.add(key)
                if self.dwell.update(key, True, t) and self.intrusion_cooldown.ready(key, t):
                    submitted.append(self.dispatcher.submit(self._event("intrusion", "intrusion_vehicle" if d.label == "vehicle" else "intrusion_person", t, zoneId=zone["id"], severity=zone.get("severity", "critical"),
                        confidence=round(d.confidence, 3), boxes=[{**d.box, "label": f"{d.label} {d.confidence:.2f}"}]), [c["sirenOutput"]] if c.get("sirenOutput") else []))
            for key in list(self.dwell.since):
                if key not in inside:
                    self.dwell.update(key, False, t)
        return submitted

    def on_part(self, detections, t, preset_defects):
        """Quality: one inspected part. A failed part's reject output fires inline, before anything else."""
        c = self.modules["quality"]
        findings = dec.defect_findings(detections, preset_defects, c.get("mmPerPixel"), self.image_width_px, c.get("minDefectMm", 0.5))
        self._count(t, "quality", frames=1, inspected=1, passed=0 if findings else 1)
        if not findings:
            return []
        # The reject goes out before anything is logged or reported. A failing output never stops inspection:
        # the failure is reported with the defect (and the PLC's own watchdog treats a missing pulse as a reject).
        actions = {}
        if c.get("rejectOutput") and self.dispatcher.act:
            try:
                actions["plcMs"] = outputs.fire(c["rejectOutput"])
            except Exception as e:
                actions["outputError"] = str(e)[:200]
        return [self.dispatcher.submit(self._event("quality", "defect", t, confidence=round(d.confidence, 3),
            detail={"preset": c["preset"], "defect": d.label, **({"sizeMm": size} if size is not None else {})},
            boxes=[{**d.box, "label": f"{d.label}{f' {size} mm' if size else ''}"}], **({"edgeActions": actions} if actions else {})))
            for d, size in findings[:5]]

    def drain_stats(self, now):
        """Counters of finished minutes, as the heartbeat sends them (the current minute keeps counting)."""
        current, out = _minute(now), []
        for (minute, module), s in list(self.stats.items()):
            out.append({"minute": minute, "module": module, **s})
            if minute != current:
                del self.stats[(minute, module)]
        return out


class Agent:
    def __init__(self, settings, platform, secret=None, clock=time.time):
        self.settings, self.platform, self.clock = settings, platform, clock
        self.secret = secret or settings.node_key
        self.dispatcher = Dispatcher(platform, settings, self.secret, clock)
        self.config, self.version, self.cameras = None, 0, {}
        self.metrics = {}

    def apply_config(self, config):
        self.config, self.version = config, config["configVersion"]
        s = config.get("settings", {})
        b = s.get("broadcast", {})
        self.settings.broadcast_group = b.get("group", self.settings.broadcast_group)
        self.settings.broadcast_port = b.get("port", self.settings.broadcast_port)
        self.settings.disk_prune_pct = s.get("diskPrunePct", self.settings.disk_prune_pct)
        self.cameras = {c["id"]: CameraRuntime(c, self.dispatcher) for c in config["cameras"]}

    def heartbeat(self):
        now = self.clock()
        body = {"agentVersion": __version__, "configVersion": self.version, "metrics": {**self.metrics, "streams": len(self.cameras), "diskPct": round(self._disk(), 1)},
                "cameras": [{"id": cid, "status": "online", "stats": rt.drain_stats(now)} for cid, rt in self.cameras.items()]}
        reply = self.platform.heartbeat(body)
        if reply.get("config"):
            self.apply_config(reply["config"])
        self.platform.flush()
        return reply

    def _disk(self):
        try:
            u = shutil.disk_usage(self.settings.data_dir)
            return 100 * u.used / u.total
        except OSError:
            return 0.0

    def housekeeping(self):
        os.makedirs(self.settings.data_dir, exist_ok=True)
        return storage.prune(self.settings.data_dir, self.settings.disk_prune_pct, self.settings.disk_target_pct)

    def run_forever(self, pipeline_runner=None):
        """Heartbeat and housekeeping loops; pipeline_runner(agent) starts the GPU pipelines (pipeline.py)."""
        self.heartbeat()
        self.dispatcher.start()

        def loop(every, fn):
            while True:
                time.sleep(every)
                try:
                    fn()
                except Exception as e:
                    print(f"{fn.__name__} failed: {e}")
        threading.Thread(target=loop, args=(self.settings.heartbeat_seconds, self.heartbeat), daemon=True).start()
        threading.Thread(target=loop, args=(300, self.housekeeping), daemon=True).start()
        if pipeline_runner:
            pipeline_runner(self)
        else:
            while True:
                time.sleep(3600)


def _iso(t):
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(t)) + f".{int((t % 1) * 1000):03d}Z"
