"""Edge agent tests: python3 -m unittest discover -s edge/tests   (no GPU, cameras or packages needed)."""
import json
import os
import socket
import struct
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from edge_agent import broadcast, decisions as dec, outputs, pipeline, storage  # noqa: E402
from edge_agent.agent import Agent, CameraRuntime  # noqa: E402
from edge_agent.alarms import Dispatcher  # noqa: E402
from edge_agent.platform import Platform  # noqa: E402
from edge_agent.settings import Settings  # noqa: E402

D = dec.Detection
SQUARE = [[0.5, 0.2], [0.9, 0.2], [0.9, 0.8], [0.5, 0.8]]


def person(x, gear=(), track=1, conf=0.9, y=0.2, h=0.6):
    out = [D("person", conf, {"x": x, "y": y, "w": 0.1, "h": h}, track)]
    band = {"helmet": 0.03, "goggles": 0.1, "vest": 0.35, "boots": 0.85}
    for g in gear:
        out.append(D(g, 0.85, {"x": x + 0.02, "y": y + band[g] * h, "w": 0.06, "h": 0.04}))
    return out


class Geometry(unittest.TestCase):
    def test_point_in_polygon_and_tripwire(self):
        self.assertTrue(dec.point_in_polygon(0.7, 0.5, SQUARE))
        self.assertFalse(dec.point_in_polygon(0.3, 0.5, SQUARE))
        line = [[0, 0.5], [1, 0.5]]
        self.assertTrue(dec.crossed((0.5, 0.4), (0.5, 0.6), line))
        self.assertFalse(dec.crossed((0.5, 0.4), (0.6, 0.45), line))

    def test_camera_sizing_for_half_millimetre_defects(self):
        self.assertAlmostEqual(dec.required_pixel_size(0.5), 0.1667, places=3)


class Ppe(unittest.TestCase):
    def test_missing_gear_per_person(self):
        dets = person(0.1, ("helmet", "vest"), 1) + person(0.4, ("vest",), 2)
        res = {p.track_id: m for p, m in dec.ppe_check(dets, ["helmet", "vest"])}
        self.assertEqual(res, {1: [], 2: ["helmet"]})

    def test_gear_must_sit_on_the_right_body_part(self):
        dets = [D("person", 0.9, {"x": 0.1, "y": 0.2, "w": 0.1, "h": 0.6}, 1), D("helmet", 0.9, {"x": 0.12, "y": 0.7, "w": 0.06, "h": 0.04})]  # helmet in hand
        self.assertEqual(dec.ppe_check(dets, ["helmet"])[0][1], ["helmet"])

    def test_zone_and_confidence_filter(self):
        dets = person(0.1, (), 1, h=0.5) + person(0.6, (), 2, h=0.5) + person(0.7, (), 3, conf=0.4, h=0.5)
        res = dec.ppe_check(dets, ["helmet"], 0.6, zone=SQUARE)
        self.assertEqual([p.track_id for p, _ in res], [2])

    def test_cooldown(self):
        c = dec.Cooldown(30)
        self.assertTrue(c.ready("a", 0))
        self.assertFalse(c.ready("a", 10))
        self.assertTrue(c.ready("a", 31))


class FireSmoke(unittest.TestCase):
    def feed(self, conf, area_fn, seconds=2.0, fps=10, label="fire"):
        c = dec.FireSmokeConfirmer(1.5, "balanced")
        for i in range(int(seconds * fps)):
            t = i / fps
            a = area_fn(t)
            r = c.update(t, [D(label, conf, {"x": 0.4, "y": 0.4, "w": a ** 0.5, "h": a ** 0.5})])
            if r:
                return r, t
        return None, None

    def test_growing_flame_confirmed_within_two_seconds(self):
        label, t = self.feed(0.85, lambda t: 0.02 + 0.01 * t)
        self.assertEqual(label, "fire")
        self.assertLess(t, 2.0)

    def test_low_confidence_or_static_welding_arc_ignored(self):
        self.assertIsNone(self.feed(0.4, lambda t: 0.02 + 0.01 * t)[0])
        self.assertIsNone(self.feed(0.9, lambda t: 0.001)[0])

    def test_brief_glint_is_not_enough(self):
        c = dec.FireSmokeConfirmer(1.5, "balanced")
        hits = [c.update(i / 10, [D("smoke", 0.9, {"x": 0.4, "y": 0.4, "w": 0.2, "h": 0.2})] if i < 5 else []) for i in range(20)]
        self.assertTrue(all(h is None for h in hits))


class Intrusion(unittest.TestCase):
    ZONES = [{"id": "z1", "kind": "exclusion", "points": SQUARE, "classes": ["person", "vehicle"], "severity": "critical"},
             {"id": "z2", "kind": "allowed_motion", "points": [[0.75, 0.2], [0.9, 0.2], [0.9, 0.8], [0.75, 0.8]]}]

    def test_people_in_zone_flagged_robot_path_ignored(self):
        dets = [D("person", 0.9, {"x": 0.55, "y": 0.3, "w": 0.1, "h": 0.4}, 1),      # foot at (0.6, 0.7): inside
                D("person", 0.9, {"x": 0.1, "y": 0.3, "w": 0.1, "h": 0.4}, 2),       # outside
                D("robot_arm", 0.9, {"x": 0.78, "y": 0.3, "w": 0.06, "h": 0.4}, 3)]  # inside approved motion
        hits, ignored = dec.intrusions(dets, self.ZONES)
        self.assertEqual([d.track_id for d, _ in hits], [1])
        self.assertEqual(ignored, 1)

    def test_dwell(self):
        d = dec.Dwell(0.5)
        self.assertFalse(d.update("k", True, 0))
        self.assertTrue(d.update("k", True, 0.6))
        self.assertFalse(d.update("k", False, 0.7))


class Quality(unittest.TestCase):
    def test_minimum_size_with_calibration(self):
        dets = [D("scratch", 0.9, {"x": 0.1, "y": 0.1, "w": 0.002, "h": 0.001}, attributes={"size_px": 4}),   # 0.32 mm
                D("crack", 0.9, {"x": 0.3, "y": 0.3, "w": 0.01, "h": 0.01}, attributes={"size_px": 8}),       # 0.64 mm
                D("label", 0.9, {"x": 0.5, "y": 0.5, "w": 0.1, "h": 0.1})]
        res = dec.defect_findings(dets, ["scratch", "crack"], 0.08, 1920, 0.5)
        self.assertEqual([(d.label, s) for d, s in res], [("crack", 0.64)])


class ModbusFake(threading.Thread):
    """A minimal Modbus TCP server that echoes Write Single Coil requests like a PLC."""

    def __init__(self):
        super().__init__(daemon=True)
        self.sock = socket.socket()
        self.sock.bind(("127.0.0.1", 0))
        self.sock.listen()
        self.port = self.sock.getsockname()[1]
        self.frames = []

    def run(self):
        conn, _ = self.sock.accept()
        while True:
            data = conn.recv(12)
            if not data:
                return
            self.frames.append(data)
            conn.sendall(data)


class Outputs(unittest.TestCase):
    def test_modbus_frame(self):
        f = outputs.modbus_write_coil_frame(1, 4, True, 7)
        self.assertEqual(f.hex(), "00070000000601050004ff00")

    def test_reject_reaches_a_plc_well_inside_15_ms(self):
        plc = ModbusFake()
        plc.start()
        ms = outputs.fire({"protocol": "modbus_tcp", "host": "127.0.0.1", "port": plc.port, "unitId": 1, "coil": 9, "pulseMs": 20})
        self.assertLess(ms, 15)
        time.sleep(0.1)
        self.assertEqual([struct.unpack(">HHHBBHH", f)[5:] for f in plc.frames[:2]], [(9, 0xFF00), (9, 0x0000)])


class Broadcast(unittest.TestCase):
    def test_signed_packets(self):
        p = broadcast.packet({"id": "a1", "type": "fire"}, "secret")
        self.assertEqual(broadcast.verify(p, "secret")["type"], "fire")
        self.assertIsNone(broadcast.verify(p, "other"))
        tampered = p.replace(b'"fire"', b'"none"')
        self.assertIsNone(broadcast.verify(tampered, "secret"))

    def test_loopback_delivery_is_fast(self):
        rx = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        rx.bind(("127.0.0.1", 0))
        rx.settimeout(1)
        ms = broadcast.send({"id": "x", "type": "smoke"}, "s", "127.0.0.1", rx.getsockname()[1], repeats=1)
        self.assertEqual(broadcast.verify(rx.recv(65535), "s")["type"], "smoke")
        self.assertLess(ms, 50)


class FakePlatform:
    def __init__(self, config=None):
        self.events, self.heartbeats, self.config = [], [], config

    def send_events(self, events):
        self.events.append([e["type"] for e in events])

    def heartbeat(self, body):
        self.heartbeats.append(body)
        return {"configVersion": 3, **({"config": self.config} if self.config and len(self.heartbeats) == 1 else {})}

    def flush(self):
        return 0


def settings():
    return Settings(platform_url="http://x", node_key="vn_test", data_dir=tempfile.mkdtemp(), batch_seconds=0.05)


class Priority(unittest.TestCase):
    def test_life_safety_bypasses_the_batch_queue(self):
        p = FakePlatform()
        d = Dispatcher(p, settings(), "s", act=False)
        for _ in range(50):
            d.submit({"cameraId": "c", "module": "quality", "type": "defect"})
        d.submit({"cameraId": "c", "module": "fire_smoke", "type": "fire", "severity": "critical"})
        threading.Thread(target=d.run_critical, daemon=True).start()
        time.sleep(0.3)
        self.assertEqual(p.events[0], ["fire"])   # before any of the 50 queued defects
        d.flush_normal()
        self.assertEqual(len(p.events[1]), 50)
        d.stop.set()


class Outbox(unittest.TestCase):
    def test_events_survive_an_uplink_outage(self):
        received = []

        class H(BaseHTTPRequestHandler):
            def do_POST(self):
                received.append(json.loads(self.rfile.read(int(self.headers["content-length"]))))
                self.send_response(200)
                self.send_header("content-type", "application/json")
                self.end_headers()
                self.wfile.write(b'{"accepted":1}')

            def log_message(self, *a):
                pass

        s = socket.socket()
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
        s.close()
        out = tempfile.mkdtemp()
        plat = Platform(f"http://127.0.0.1:{port}", "vn_x", timeout=0.5, outbox_dir=out)
        self.assertIsNone(plat.send_events([{"type": "fire"}]))   # server down: spooled
        self.assertEqual(len(os.listdir(os.path.join(out, "outbox"))), 1)
        srv = HTTPServer(("127.0.0.1", port), H)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        self.assertEqual(plat.flush(), 1)
        self.assertEqual(received[0]["events"][0]["type"], "fire")
        srv.shutdown()


class Storage(unittest.TestCase):
    def test_clip_segments_and_commands(self):
        d = tempfile.mkdtemp()
        for t in range(100, 120, 2):
            open(os.path.join(d, f"{t}.mp4"), "w").close()
        segs = storage.segments_between(d, 105, 111)
        self.assertEqual([os.path.basename(s) for s in segs], ["104.mp4", "106.mp4", "108.mp4", "110.mp4"])
        cmd = storage.record_command("rtsp://cam/1", d)
        self.assertIn("-c", cmd)
        self.assertEqual(cmd[cmd.index("-c") + 1], "copy")

    def test_prune_oldest_unlocked_first_never_locked(self):
        d = tempfile.mkdtemp()
        names = ["1.mp4", "2.mp4", "3.locked.mp4", "4.mp4"]
        for i, n in enumerate(names):
            p = os.path.join(d, n)
            open(p, "w").close()
            os.utime(p, (1000 + i, 1000 + i))
        usage = {"pct": 92}

        def fake_usage(_):
            return usage["pct"]

        orig_remove = os.remove

        def counting_remove(p):
            orig_remove(p)
            usage["pct"] -= 4
        storage.os.remove = counting_remove
        try:
            deleted = storage.prune(d, 90, 85, usage=fake_usage)
        finally:
            storage.os.remove = orig_remove
        self.assertEqual([os.path.basename(p) for p in deleted], ["1.mp4", "2.mp4"])
        self.assertIn("3.locked.mp4", os.listdir(d))
        self.assertEqual(storage.prune(d, 90, 85, usage=lambda _: 50), [])


class Pipeline(unittest.TestCase):
    def test_pipeline_text(self):
        cams = [{"name": f"c{i}", "sourceType": "rtsp", "sourceUrl": f"rtsp://10.0.0.{i}/s"} for i in range(3)]
        txt = pipeline.build_pipeline(cams)
        self.assertIn("batch-size=3", txt)
        self.assertIn("nvtracker", txt)
        self.assertEqual(txt.count("rtspsrc"), 3)
        with self.assertRaises(ValueError):
            pipeline.build_pipeline(cams * 6)


class AgentEndToEnd(unittest.TestCase):
    CONFIG = {"configVersion": 3, "settings": {"broadcast": {"group": "239.10.10.10", "port": 5005}}, "cameras": [
        {"id": "gate", "name": "Gate", "sourceType": "rtsp", "sourceUrl": "rtsp://x", "zones": [], "modules": [{"module": "ppe", "config": {"requiredGear": ["helmet", "vest"], "cooldownSeconds": 30}}]},
        {"id": "line", "name": "Line", "sourceType": "rtsp", "sourceUrl": "rtsp://y", "zones": [], "modules": [{"module": "quality", "config": {"preset": "electronics", "mmPerPixel": 0.08, "minDefectMm": 0.5}}]}]}

    def test_config_frames_counters_and_events(self):
        p = FakePlatform(self.CONFIG)
        a = Agent(settings(), p)
        a.dispatcher.act = False
        a.heartbeat()
        self.assertEqual(set(a.cameras), {"gate", "line"})
        gate, line = a.cameras["gate"], a.cameras["line"]
        t = time.time()
        gate.on_frame(person(0.1, ("helmet", "vest"), 1) + person(0.4, ("vest",), 2), t)
        gate.on_frame(person(0.4, ("vest",), 2), t + 1)                      # same violation: cooldown
        line.on_part([D("crack", 0.95, {"x": 0.1, "y": 0.1, "w": 0.01, "h": 0.01}, attributes={"size_px": 10})], t, ["crack", "scratch"])
        line.on_part([], t, ["crack"])
        a.dispatcher.flush_normal()
        self.assertEqual(sorted(sum(p.events, [])), ["defect", "ppe_violation"])
        stats = {s["module"]: s for s in gate.drain_stats(t + 120) + line.drain_stats(t + 120)}
        self.assertEqual((stats["ppe"]["people"], stats["ppe"]["compliant"]), (3, 1))
        self.assertEqual((stats["quality"]["inspected"], stats["quality"]["passed"]), (2, 1))


if __name__ == "__main__":
    unittest.main()
