"""Start the agent: PLATFORM_URL=https://… NODE_KEY=vn_… python3 -m edge_agent

On the edge PC the GPU pipelines start for the cameras the platform assigns to this node. Without DeepStream
(e.g. on a laptop) the agent still connects, syncs its configuration and sends heartbeats, so the platform
side can be set up first; use edge_agent.simulate to generate demo detections.
"""
import importlib
import os

from .agent import Agent
from .platform import Platform
from .settings import Settings


def gpu_pipelines(agent):
    from . import pipeline
    cams = list(agent.config["cameras"])
    safety = [c for c in cams if any(m["module"] in ("ppe", "fire_smoke", "intrusion") for m in c["modules"]) and c["sourceType"] in ("rtsp", "csi")]
    by_index = {i: c["id"] for i, c in enumerate(safety)}

    def on_frame(index, detections, t):
        import time
        rt = agent.cameras.get(by_index.get(index))
        if rt:
            rt.on_frame(detections, t or time.time())
    pipeline.run_pipeline(pipeline.build_pipeline(safety, kind="safety"), on_frame)


def main():
    s = Settings.from_env()
    agent = Agent(s, Platform(s.platform_url, s.node_key, s.request_timeout, s.data_dir))
    try:
        import pyds  # noqa: F401
        runner = gpu_pipelines
    except ImportError:
        print("DeepStream (pyds) not found: running without video pipelines (heartbeat and configuration only).")
        runner = None
    # Triggered quality cameras (Cognex, Hikvision, Keyence): QUALITY_MODEL=package.module:factory, where
    # factory(camera) returns model(frame) -> [Detection] (e.g. a TensorRT segmentation or PatchCore engine).
    if os.environ.get("QUALITY_MODEL"):
        mod, _, fn = os.environ["QUALITY_MODEL"].partition(":")
        factory = getattr(importlib.import_module(mod), fn or "load")
        inner = runner

        def runner(a):  # noqa: E306 - starts quality inspection once the configuration is known
            a.start_quality(factory)
            if inner:
                inner(a)
            else:
                import time
                while True:
                    time.sleep(3600)
    agent.run_forever(runner)


if __name__ == "__main__":
    main()
