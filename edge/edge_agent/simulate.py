"""Edge simulator: drives the real agent logic with synthetic detections, so the whole chain (decisions,
dispatcher, uplink, platform alerts and dashboards) can be demonstrated without cameras or a GPU.

  python3 -m edge_agent.simulate --platform http://localhost:3100 --key vn_demo-chicago-edge-node-key-0001 --minutes 2

The demo database's edge node accepts the key above. Physical outputs and the network broadcast are off.
"""
import argparse
import random
import time

from .agent import Agent
from .decisions import Detection
from .platform import Platform
from .settings import Settings

# Defects that occur most on moulded parts are drawn more often (weights).
COMMON = {"short_shot": 3, "flash": 4, "sink_mark": 5, "black_spot": 4, "scratch": 4, "splay": 2, "weld_line": 2, "burn_mark": 1}


def part_for(rt, rnd, defect_rate=0.05):
    """One moulded part: usually clean; sometimes a defect inside one of the inspection areas, 0.2-1.6 mm."""
    defects = rt.modules["quality"].get("defects") or ["scratch", "crack"]
    if rnd.random() > defect_rate:
        return []
    label = rnd.choices(defects, [COMMON.get(d, 1) for d in defects])[0]
    rois = [z for z in rt.zones if z["kind"] == "inspection_roi"] or [{"points": [[0.2, 0.2], [0.8, 0.2], [0.8, 0.8], [0.2, 0.8]]}]
    pts = rnd.choice(rois)["points"]
    xs, ys = [p[0] for p in pts], [p[1] for p in pts]
    cx, cy = rnd.uniform(min(xs) + 0.02, max(xs) - 0.02), rnd.uniform(min(ys) + 0.02, max(ys) - 0.02)
    mmpp = rt.modules["quality"].get("mmPerPixel") or 0.1
    size_px = rnd.uniform(0.2, 1.6) / mmpp
    w = size_px / rt.image_width_px
    return [Detection(label, round(rnd.uniform(0.8, 0.99), 2), {"x": cx - w / 2, "y": cy - 0.01, "w": w, "h": 0.02}, attributes={"size_px": size_px})]


def person(track, x, gear, conf=0.92, y=0.25, h=0.5):
    """A worker and the gear they wear, each item centred where it sits on the body (head, torso, feet)."""
    dets = [Detection("person", conf, {"x": x, "y": y, "w": 0.1, "h": h}, track)]
    centre = {"helmet": 0.06, "goggles": 0.14, "vest": 0.45, "boots": 0.9}
    for g in gear:
        dets.append(Detection(g, 0.85, {"x": x + 0.02, "y": y + centre[g] * h - 0.02, "w": 0.06, "h": 0.04}))
    return dets


def frame_for(rt, t, rnd):
    dets = []
    mods = rt.modules
    if "ppe" in mods:
        req = mods["ppe"].get("requiredGear", ["helmet", "vest"])
        for track in range(rnd.randint(1, 3)):
            gear = list(req) if rnd.random() > 0.04 else [g for g in req if rnd.random() > 0.6]
            dets += person(track + int(t // 20) * 10, 0.2 + track * 0.25, gear)
    if "intrusion" in mods and rnd.random() < 0.02:
        excl = next((z for z in rt.zones if z["kind"] == "exclusion"), None)
        if excl:
            xs = [p[0] for p in excl["points"]]
            ys = [p[1] for p in excl["points"]]
            cx, by = sum(xs) / len(xs), max(ys) - 0.02
            dets.append(Detection("person", 0.9, {"x": cx - 0.04, "y": by - 0.4, "w": 0.08, "h": 0.4}, 900 + int(t)))
    if "fire_smoke" in mods and rnd.random() < 0.001:
        rt._fire_burst = t
    if getattr(rt, "_fire_burst", None) and t - rt._fire_burst < 2.5:
        area = 0.05 + (t - rt._fire_burst) * 0.02
        dets.append(Detection("fire", 0.9, {"x": 0.4, "y": 0.4, "w": area ** 0.5, "h": area ** 0.5}))
    return dets


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--platform", required=True)
    ap.add_argument("--key", required=True)
    ap.add_argument("--minutes", type=float, default=2)
    ap.add_argument("--fps", type=float, default=10, help="analysed frames per second per camera")
    ap.add_argument("--seed", type=int, default=1)
    a = ap.parse_args()
    s = Settings(platform_url=a.platform.rstrip("/"), node_key=a.key, data_dir="/tmp/edge-sim", heartbeat_seconds=15)
    agent = Agent(s, Platform(s.platform_url, s.node_key))
    agent.dispatcher.act = False          # no physical outputs, no broadcast in a simulation
    agent.heartbeat()
    print(f"Connected. Config v{agent.version}: {len(agent.cameras)} cameras")
    rnd, t0, last_hb = random.Random(a.seed), time.time(), time.time()
    agent.dispatcher.start()
    while time.time() - t0 < a.minutes * 60:
        t = time.time()
        for rt in agent.cameras.values():
            q = rt.modules.get("quality")
            if q and t - getattr(rt, "_last_part", 0) >= q.get("cycleTimeS", 3):
                rt._last_part = t                     # one part per machine cycle, as the PLC trigger would give
                rt.on_part(part_for(rt, rnd), t, started=time.perf_counter() - rnd.uniform(0.12, 0.25))
            if any(m in rt.modules for m in ("ppe", "intrusion", "fire_smoke")):
                rt.on_frame(frame_for(rt, t, rnd), t)
        if t - last_hb >= s.heartbeat_seconds:
            agent.heartbeat()
            last_hb = t
            print(f"{time.strftime('%H:%M:%S')} heartbeat · events sent: {sum(len(b) for _, b in agent.dispatcher.sent)}")
        time.sleep(1 / a.fps)
    agent.dispatcher.flush_normal()
    agent.heartbeat()
    print(f"Done. Events sent: {sum(len(b) for _, b in agent.dispatcher.sent)}")


if __name__ == "__main__":
    main()
