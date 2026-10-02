"""Triggered quality inspection: PLC inputs, camera adapters (Cognex, HTTP snapshot, RTSP, folder), A/B/C grading
and the trigger -> OK/NG loop. python3 -m unittest discover -s edge/tests   (no cameras, PLC or packages needed)."""
import base64
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

from edge_agent import decisions as dec, outputs, sources  # noqa: E402
from edge_agent.agent import Agent, CameraRuntime  # noqa: E402
from edge_agent.alarms import Dispatcher  # noqa: E402
from edge_agent.quality import PartInspector  # noqa: E402
from edge_agent.settings import Settings  # noqa: E402

D = dec.Detection
FACE = {"id": "z-face", "kind": "inspection_roi", "surfaceClass": "A", "points": [[0.1, 0.1], [0.9, 0.1], [0.9, 0.6], [0.1, 0.6]]}
EDGE = {"id": "z-edge", "kind": "inspection_roi", "surfaceClass": "B", "points": [[0.1, 0.6], [0.9, 0.6], [0.9, 0.9], [0.1, 0.9]]}


def defect(label, cx, cy, size_px, conf=0.9):
    return D(label, conf, {"x": cx - 0.01, "y": cy - 0.01, "w": 0.02, "h": 0.02}, attributes={"size_px": size_px})


class PlcFake(threading.Thread):
    """Modbus TCP server like a PLC or I/O module: discrete inputs to read, coils written by the agent."""

    def __init__(self):
        super().__init__(daemon=True)
        self.sock = socket.socket()
        self.sock.bind(("127.0.0.1", 0))
        self.sock.listen()
        self.port = self.sock.getsockname()[1]
        self.inputs, self.writes = {}, []

    def run(self):
        while True:
            conn, _ = self.sock.accept()
            threading.Thread(target=self.serve, args=(conn,), daemon=True).start()

    def serve(self, conn):
        with conn:
            while True:
                req = conn.recv(12)
                if len(req) < 12:
                    return
                tid, _, _, unit, fn, addr, val = struct.unpack(">HHHBBHH", req)
                if fn == 0x05:
                    self.writes.append((addr, val == 0xFF00))
                    conn.sendall(req)
                elif fn in (0x01, 0x02):
                    bits = [self.inputs.get(addr + i, False) for i in range(val)]
                    data = bytes(sum(1 << j for j in range(8) if i * 8 + j < len(bits) and bits[i * 8 + j]) for i in range((len(bits) + 7) // 8))
                    conn.sendall(struct.pack(">HHHBBB", tid, 0, 3 + len(data), unit, fn, len(data)) + data)
                else:
                    conn.sendall(struct.pack(">HHHBBB", tid, 0, 3, unit, fn | 0x80, 1))


def bmp(size=70):
    return b"BM" + size.to_bytes(4, "little") + bytes(size - 6)


class CognexFake(threading.Thread):
    """In-Sight Native Mode: login prompts, SW8 (trigger), RB (bitmap as hex in 80-character lines)."""

    def __init__(self, password="pw", online=True, length_line=True):
        super().__init__(daemon=True)
        self.sock = socket.socket()
        self.sock.bind(("127.0.0.1", 0))
        self.sock.listen()
        self.port = self.sock.getsockname()[1]
        self.password, self.online, self.length_line = password, online, length_line
        self.commands, self.logins = [], 0

    def run(self):
        while True:
            conn, _ = self.sock.accept()
            threading.Thread(target=self.serve, args=(conn,), daemon=True).start()

    def serve(self, conn):
        f = conn.makefile("rb")
        line = lambda: f.readline().decode().strip()
        with conn:
            conn.sendall(b"Welcome to In-Sight(R) 2800 Session 0\r\nUser: ")
            line()
            conn.sendall(b"Password: ")
            if line() != self.password:
                conn.sendall(b"Invalid Password\r\n")
                return
            self.logins += 1
            conn.sendall(b"User Logged In\r\n")
            while True:
                cmd = line()
                if not cmd:
                    return
                self.commands.append(cmd)
                if cmd == "SW8":
                    conn.sendall(b"1\r\n" if self.online else b"-2\r\n")
                elif cmd == "RB":
                    h = bmp().hex().upper()
                    body = "\r\n".join(h[i:i + 80] for i in range(0, len(h), 80))
                    conn.sendall(("1\r\n" + (f"{len(bmp())}\r\n" if self.length_line else "") + body + "\r\n").encode())
                else:
                    conn.sendall(b"0\r\n")


class PlcInputs(unittest.TestCase):
    def test_read_frames(self):
        self.assertEqual(outputs.modbus_read_bits_frame(1, 0x02, 16, 1, 5).hex(), "000500000006010200100001")
        self.assertEqual(outputs.parse_read_bits_reply(bytes.fromhex("000500000004010201") + b"\x05", 0x02, 3), [True, False, True])
        with self.assertRaises(IOError):
            outputs.parse_read_bits_reply(bytes.fromhex("00050000000301820200"), 0x02, 1)

    def test_part_present_from_a_plc(self):
        plc = PlcFake()
        plc.start()
        inp = {"protocol": "modbus_tcp", "host": "127.0.0.1", "port": plc.port, "unitId": 1, "kind": "discrete_input", "address": 3}
        self.assertFalse(outputs.read_input(inp))
        plc.inputs[3] = True
        start = time.perf_counter()
        self.assertTrue(outputs.read_input(inp))
        self.assertLess((time.perf_counter() - start) * 1000, 15)
        plc.inputs[7] = True
        self.assertTrue(outputs.read_input({**inp, "kind": "coil", "address": 7}))


class Grading(unittest.TestCase):
    def test_surface_classes_and_limits(self):
        dets = [defect("sink_mark", 0.5, 0.3, 6),      # 0.6 mm on class A (limit 0.5): reject
                defect("scratch", 0.5, 0.75, 8),       # 0.8 mm on class B (limit 1.0): accept
                defect("flash", 0.5, 0.75, 12),        # 1.2 mm on class B: reject
                defect("burn_mark", 0.95, 0.95, 50),   # outside the part: ignored
                defect("person", 0.5, 0.3, 50)]        # not a defect class
        ok, graded = dec.grade_part(dets, ["sink_mark", "scratch", "flash", "burn_mark"], [FACE, EDGE], {"A": 0.5, "B": 1.0, "C": 2.0}, 0.1)
        self.assertFalse(ok)
        self.assertEqual([(g.detection.label, g.surface_class, g.size_mm, g.reject) for g in graded],
                         [("sink_mark", "A", 0.6, True), ("flash", "B", 1.2, True), ("scratch", "B", 0.8, False)])

    def test_accepts_within_limits_and_never_passes_unmeasured_defects(self):
        ok, graded = dec.grade_part([defect("scratch", 0.5, 0.75, 8)], ["scratch"], [FACE, EDGE], None, 0.1)
        self.assertTrue(ok)
        self.assertEqual(len(graded), 1)
        ok, _ = dec.grade_part([defect("scratch", 0.5, 0.75, 1)], ["scratch"], [FACE, EDGE], None, None)
        self.assertFalse(ok)                                   # no calibration: size unknown, rejected

    def test_overlap_takes_the_strictest_class_and_no_zones_means_class_a(self):
        c_all = {"id": "z-c", "kind": "inspection_roi", "surfaceClass": "C", "points": [[0, 0], [1, 0], [1, 1], [0, 1]]}
        self.assertEqual(dec.surface_class_at(0.5, 0.3, [c_all, FACE]), "A")
        self.assertEqual(dec.surface_class_at(0.5, 0.3, []), "A")
        self.assertIsNone(dec.surface_class_at(0.95, 0.95, [FACE]))


class Cognex(unittest.TestCase):
    def test_bitmap_reply_parsing(self):
        h = bmp().hex()
        self.assertEqual(sources.parse_cognex_bitmap("1\r\n70\r\n" + h[:80] + "\r\n" + h[80:] + "\r\n"), bmp())
        self.assertEqual(sources.parse_cognex_bitmap("1\r\n" + h + "\r\n"), bmp())
        self.assertIsNone(sources.parse_cognex_bitmap("1\r\n" + h[:40]))
        with self.assertRaisesRegex(sources.CaptureError, "Online"):
            sources.parse_cognex_bitmap("-2\r\n")

    def test_trigger_and_read_over_one_session(self):
        cam = CognexFake(length_line=False)
        cam.start()
        src = sources.CognexNative(f"admin:pw@127.0.0.1:{cam.port}")
        for _ in range(3):
            f = src.capture(timeout=2)
            self.assertEqual((f.data, f.mime), (bmp(), "image/bmp"))
        self.assertEqual((cam.logins, cam.commands), (1, ["SW8", "RB"] * 3))
        src.close()

    def test_errors_are_explained(self):
        cam = CognexFake(online=False)
        cam.start()
        with self.assertRaisesRegex(sources.CaptureError, "is the camera Online"):
            sources.CognexNative(f"admin:pw@127.0.0.1:{cam.port}").capture(timeout=2)
        with self.assertRaisesRegex(sources.CaptureError, "rejected the user name or password"):
            sources.CognexNative(f"admin:wrong@127.0.0.1:{cam.port}").capture(timeout=2)


class Adapters(unittest.TestCase):
    def test_http_snapshot_with_camera_login(self):
        class H(BaseHTTPRequestHandler):
            def do_GET(self):
                if self.headers.get("Authorization") != "Basic " + base64.b64encode(b"admin:p@ss").decode():
                    self.send_response(401)
                    self.send_header("WWW-Authenticate", 'Basic realm="IP Camera"')
                    self.end_headers()
                    return
                self.send_response(200)
                self.send_header("Content-Type", "image/jpeg")
                self.end_headers()
                self.wfile.write(b"\xff\xd8jpeg\xff\xd9")

            def log_message(self, *a):
                pass
        srv = HTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        src = sources.open_source({"name": "Hik", "sourceType": "http-snapshot",
                                   "sourceUrl": f"http://admin:p%40ss@127.0.0.1:{srv.server_port}/ISAPI/Streaming/channels/101/picture"})
        f = src.capture(timeout=2)
        self.assertEqual((f.data, f.mime), (b"\xff\xd8jpeg\xff\xd9", "image/jpeg"))
        srv.shutdown()

    def test_jpeg_stream_splitting(self):
        frames, rest = sources.split_jpegs(b"xx\xff\xd8a\xff\xd9\xff\xd8bb\xff\xd9\xff\xd8c")
        self.assertEqual((frames, rest), ([b"\xff\xd8a\xff\xd9", b"\xff\xd8bb\xff\xd9"], b"\xff\xd8c"))

    def test_folder_waits_for_the_image_after_the_trigger(self):
        d = tempfile.mkdtemp()
        old = os.path.join(d, "old.bmp")
        with open(old, "wb") as f:
            f.write(b"old")
        os.utime(old, (time.time() - 60, time.time() - 60))
        src = sources.FolderImage(d)
        t = time.time()
        threading.Timer(0.1, lambda: open(os.path.join(d, "part_0001.bmp"), "wb").write(bmp())).start()
        f = src.capture(after=t, timeout=2)
        self.assertEqual((f.data, f.mime), (bmp(), "image/bmp"))
        with self.assertRaises(sources.CaptureError):
            src.capture(after=time.time() + 10, timeout=0.05)

    def test_addresses(self):
        self.assertEqual(sources.split_address("admin:se%3Acret@10.0.0.5:23"), ("admin", "se:cret", "10.0.0.5", 23))
        self.assertEqual(sources.split_address("10.0.0.5", 23), (None, "", "10.0.0.5", 23))


class RecordingPlatform:
    def __init__(self):
        self.events = []

    def send_events(self, events):
        self.events += events

    def send_media(self, **kw):
        pass


class TriggerToResult(unittest.TestCase):
    """PLC part-present -> Cognex capture -> model -> grade -> NG/OK coil, inside the 500 ms budget of a 3 s cycle."""

    def setUp(self):
        self.plc, self.cam = PlcFake(), CognexFake()
        self.plc.start()
        self.cam.start()
        coil = lambda n: {"protocol": "modbus_tcp", "host": "127.0.0.1", "port": self.plc.port, "unitId": 1, "coil": n, "pulseMs": 30}
        cfg = {"preset": "automotive_plastic", "triggerMode": "plc", "cycleTimeS": 3, "resultBudgetMs": 500, "mmPerPixel": 0.1,
               "acceptance": {"A": 0.5, "B": 1.0, "C": 2.0}, "defects": ["sink_mark", "scratch", "flash", "short_shot"],
               "triggerInput": {"protocol": "modbus_tcp", "host": "127.0.0.1", "port": self.plc.port, "unitId": 1, "kind": "discrete_input", "address": 0},
               "okOutput": coil(10), "rejectOutput": coil(11)}
        self.camera = {"id": "vc-line", "name": "IMM-05", "sourceType": "cognex-native", "sourceUrl": f"admin:pw@127.0.0.1:{self.cam.port}",
                       "zones": [FACE, EDGE], "modules": [{"module": "quality", "config": cfg}]}
        self.platform = RecordingPlatform()
        self.dispatcher = Dispatcher(self.platform, Settings(platform_url="http://x", node_key="k", data_dir=tempfile.mkdtemp()), "s")
        self.rt = CameraRuntime(self.camera, self.dispatcher)
        self.parts = []
        self.insp = PartInspector(self.rt, lambda frame: self.parts.pop(0))

    def part(self, detections):
        self.parts.append(detections)
        self.plc.inputs[0] = False
        self.assertIsNone(self.insp.poll())
        self.plc.inputs[0] = True
        res = self.insp.poll()
        self.assertIsNone(self.insp.poll())                    # signal still high: same part, no second inspection
        return res

    def test_ng_then_ok(self):
        ng = self.part([defect("sink_mark", 0.5, 0.3, 7)])       # 0.7 mm on class A
        ok = self.part([defect("scratch", 0.5, 0.75, 8)])        # 0.8 mm on class B: within limit
        self.assertFalse(ng["ok"])
        self.assertTrue(ok["ok"])
        self.assertEqual([w for w in self.plc.writes if w[1]], [(11, True), (10, True)])
        self.dispatcher.flush_normal()
        e = self.platform.events[0]
        self.assertEqual((e["type"], e["detail"]["defect"], e["detail"]["surfaceClass"], e["detail"]["sizeMm"], e["detail"]["limitMm"]), ("defect", "sink_mark", "A", 0.7, 0.5))
        self.assertLess(e["edgeActions"]["inspectionMs"], 500)
        self.assertNotIn("overBudget", e["edgeActions"])
        stats = self.rt.drain_stats(time.time() + 120)[0]
        self.assertEqual((stats["inspected"], stats["passed"]), (2, 1))
        self.assertIsNotNone(self.rt.inspection_p95())

    def test_no_image_means_reject(self):
        self.cam.online = False
        res = self.part([])
        self.assertFalse(res["ok"])
        self.assertIn((11, True), self.plc.writes)
        self.dispatcher.flush_normal()
        self.assertEqual((self.platform.events[0]["module"], self.platform.events[0]["type"]), ("system", "camera_offline"))


class StartQuality(unittest.TestCase):
    def test_only_cameras_that_can_tell_parts_apart_are_started(self):
        plc = PlcFake()
        plc.start()
        trig = {"protocol": "modbus_tcp", "host": "127.0.0.1", "port": plc.port, "unitId": 1, "kind": "discrete_input", "address": 0}
        cam = lambda id_, src, url, **q: {"id": id_, "name": id_, "sourceType": src, "sourceUrl": url, "zones": [],
                                          "modules": [{"module": "quality", "config": {"preset": "automotive_plastic", **q}}]}
        config = {"configVersion": 1, "settings": {}, "cameras": [
            cam("cognex-plc", "cognex-native", "admin:pw@127.0.0.1:1", triggerMode="plc", triggerInput=trig),
            cam("hik-camera", "http-snapshot", "http://127.0.0.1:1/ISAPI/Streaming/channels/101/picture", triggerMode="camera"),
            cam("keyence-ftp", "folder", tempfile.mkdtemp(), triggerMode="camera"),
            cam("line-video", "rtsp", "rtsp://127.0.0.1/x", triggerMode="continuous")]}
        a = Agent(Settings(platform_url="http://x", node_key="k", data_dir=tempfile.mkdtemp()), RecordingPlatform())
        a.apply_config(config)
        started = a.start_quality(lambda camera: (lambda frame: []))
        self.assertEqual(sorted(i.rt.cam["id"] for i in started), ["cognex-plc", "keyence-ftp"])
        a.apply_config(config)                                 # a new configuration replaces the inspectors
        self.assertTrue(all(i.stop.is_set() for i in started))
        for i in a.inspectors:
            i.stop.set()


if __name__ == "__main__":
    unittest.main()
