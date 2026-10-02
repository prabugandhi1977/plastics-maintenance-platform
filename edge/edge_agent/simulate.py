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

PRESETS = {"vehicle_body": ["scratch", "dent", "crack", "stain"], "electronics": ["scratch", "crack", "solder_bridge", "missing_component"],
           "logistics_container": ["dent", "hole", "rust", "deformation"]}


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
            if "quality" in rt.modules:
                preset = rt.modules["quality"].get("preset", "electronics")
                defects = [Detection(rnd.choice(PRESETS[preset]), 0.95, {"x": rnd.random() * 0.8, "y": rnd.random() * 0.8, "w": 0.05, "h": 0.03})] if rnd.random() < 0.01 else []
                rt.on_part(defects, t, PRESETS[preset])
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
