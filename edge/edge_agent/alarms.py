"""Alarm dispatch with life-safety pre-emption.

Two lanes. Critical events (fire, smoke, intrusion) are handled on a dedicated high-priority thread the moment
they are confirmed: local actions first (factory broadcast, siren/beacon outputs), then an immediate upload,
bypassing logging, statistics and the batch queue. Everything else (PPE warnings, quality defects) is batched
every couple of seconds. Quality rejects never wait for either lane: the pipeline fires the PLC output inline.
"""
import itertools
import queue
import threading
import time
import uuid

from . import broadcast, outputs

CRITICAL = {"fire", "smoke", "intrusion_person"}


class Dispatcher:
    def __init__(self, platform, settings, secret, clock=time.time, act=True):
        self.platform, self.settings, self.secret, self.clock, self.act = platform, settings, secret, clock, act
        self.critical = queue.Queue()
        self.normal = queue.Queue()
        self.sent = []                       # (lane, events) for tests and diagnostics
        self.stop = threading.Event()
        self.order = itertools.count()

    def submit(self, event, outputs_to_fire=()):
        """event: dict in the platform's format without externalId/occurredAt (added here)."""
        event = {"externalId": event.get("externalId") or uuid.uuid4().hex, "occurredAt": event.get("occurredAt") or _iso(self.clock()), **event}
        lane = self.critical if event["type"] in CRITICAL or event.get("severity") == "critical" else self.normal
        lane.put((next(self.order), event, tuple(outputs_to_fire)))
        return event["externalId"]

    def _act(self, event, outs):
        actions = {}
        if not self.act:
            return actions
        if event["type"] in ("fire", "smoke") or event.get("broadcast"):
            actions["broadcastMs"] = broadcast.send({"id": event["externalId"], "type": event["type"], "camera": event["cameraId"], "at": event["occurredAt"]},
                                                    self.secret, self.settings.broadcast_group, self.settings.broadcast_port)
        for o in outs:
            try:
                actions["relayMs"] = outputs.fire(o)
            except Exception as e:
                actions["outputError"] = str(e)[:200]
        return actions

    def run_critical(self):
        while not self.stop.is_set():
            try:
                _, event, outs = self.critical.get(timeout=0.2)
            except queue.Empty:
                continue
            start = time.perf_counter()
            event["edgeActions"] = {**event.get("edgeActions", {}), **self._act(event, outs)}
            event["edgeActions"]["decisionToUplinkMs"] = round((time.perf_counter() - start) * 1000, 1)
            event.pop("broadcast", None)
            self.platform.send_events([event])
            self.sent.append(("critical", [event]))

    def run_normal(self):
        while not self.stop.is_set():
            time.sleep(self.settings.batch_seconds)
            self.flush_normal()

    def flush_normal(self):
        batch = []
        while not self.normal.empty() and len(batch) < 200:
            _, event, outs = self.normal.get_nowait()
            if outs:
                event["edgeActions"] = {**event.get("edgeActions", {}), **self._act(event, outs)}
            batch.append(event)
        if batch:
            self.platform.send_events(batch)
            self.sent.append(("normal", batch))
        return len(batch)

    def start(self):
        threading.Thread(target=self.run_critical, name="alarms-critical", daemon=True).start()
        threading.Thread(target=self.run_normal, name="alarms-normal", daemon=True).start()


def _iso(t):
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(t)) + f".{int((t % 1) * 1000):03d}Z"
