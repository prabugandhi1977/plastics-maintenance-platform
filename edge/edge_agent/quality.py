"""Triggered quality inspection for a moulding cell: one PLC part-present signal, one image, one OK/NG answer.

  PLC part-present ↑ ─▶ capture (Cognex SW8+RB / Hikvision snapshot / RTSP frame / Keyence FTP image)
                     ─▶ model (segmentation or anomaly, on the GPU) ─▶ grade by surface class A/B/C
                     ─▶ NG or OK output to the PLC ─▶ report (defect events, counters, snapshot)

With a 3 s machine cycle the result is due well inside the cycle: the default budget is 500 ms from the rising
edge, leaving the robot and the PLC the rest. The PLC must treat a missing result within its own timeout as NG.

Typical budget on an RTX A4000 / L4: PLC poll ≤ 5 ms, capture 50–250 ms (camera and transfer), inference
20–60 ms at full resolution, grading < 1 ms, output < 15 ms.
"""
import threading
import time

from . import outputs
from .sources import CaptureError, open_source


class PartInspector:
    """Runs one quality camera. `model(frame) -> [Detection]` is the GPU model (see pipeline.py); `read_input` and
    `open_source` are injectable for tests and for cameras that trigger themselves."""

    def __init__(self, runtime, model, source=None, read_input=outputs.read_input, poll_s=0.005, clock=time.time):
        self.rt, self.model, self.read_input, self.poll_s, self.clock = runtime, model, read_input, poll_s, clock
        self.cfg = runtime.modules["quality"]
        self.source = source or open_source(runtime.cam)
        self.last = False
        self.errors = 0
        self.stop = threading.Event()

    def poll(self):
        """Reads the part-present signal once; inspects on a rising edge. Returns the inspection result or None."""
        try:
            level = bool(self.read_input(self.cfg["triggerInput"]))
        except Exception as e:
            self.errors += 1
            if self.errors in (1, 100) or self.errors % 1000 == 0:
                print(f"{self.rt.cam['name']}: trigger read failed ({e})")
            return None
        rising, self.last = level and not self.last, level
        return self.inspect() if rising else None

    def inspect(self, frame=None):
        """One part: capture, model, grade, output. Capture failures count as NG so a part is never passed unseen.
        `frame` is given when the camera triggered itself (the image arrived without a PLC signal)."""
        started, t = time.perf_counter(), self.clock()
        budget_s = self.cfg.get("resultBudgetMs", 500) / 1000
        try:
            if frame is None:
                frame = self.source.capture(after=t - 0.05, timeout=budget_s)
            detections = self.model(frame)
        except (CaptureError, OSError) as e:
            return self._no_image(t, started, str(e))
        events = self.rt.on_part(detections, t, image=frame, started=started)
        return {"ok": not events, "events": events}

    def _no_image(self, t, started, reason):
        actions = {}
        if self.cfg.get("rejectOutput") and self.rt.dispatcher.act:
            try:
                actions["plcMs"] = outputs.fire(self.cfg["rejectOutput"])
            except Exception as e:
                actions["outputError"] = str(e)[:200]
        actions["inspectionMs"] = round((time.perf_counter() - started) * 1000, 1)
        self.rt._count(t, "quality", frames=0, inspected=1, passed=0)
        self.rt.dispatcher.submit({"cameraId": self.rt.cam["id"], "module": "system", "type": "camera_offline", "severity": "warning",
                                   "occurredAt": _iso(t), "detail": {"reason": reason[:200], "part": "rejected"}, "edgeActions": actions})
        return {"ok": False, "events": [], "error": reason}

    def run(self):
        """Polls the PLC trigger until stopped. Without a trigger the camera triggers itself (its own sensor or I/O)
        and each new image is one part; waiting for the next part is not a failure."""
        since = self.clock()
        while not self.stop.is_set():
            if self.cfg.get("triggerMode", "plc") == "plc" and self.cfg.get("triggerInput"):
                self.poll()
                time.sleep(self.poll_s)
                continue
            try:
                frame = self.source.capture(after=since, timeout=1.0)
            except CaptureError:
                continue
            since = frame.t + 1e-6
            self.inspect(frame)
        if hasattr(self.source, "close"):
            self.source.close()

    def start(self):
        threading.Thread(target=self.run, name=f"quality-{self.rt.cam['id']}", daemon=True).start()
        return self


def _iso(t):
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(t)) + f".{int((t % 1) * 1000):03d}Z"
