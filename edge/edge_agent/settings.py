"""Agent settings from the environment. Only PLATFORM_URL and NODE_KEY are required."""
import os
from dataclasses import dataclass, field


@dataclass
class Settings:
    platform_url: str
    node_key: str
    data_dir: str = "/data/vision"            # NVMe: ring-buffer segments, clips, outbox
    heartbeat_seconds: float = 30.0
    batch_seconds: float = 2.0               # non-critical events are batched; critical ones go at once
    request_timeout: float = 10.0
    clip_seconds: int = 10
    pre_event_seconds: int = 5
    disk_prune_pct: float = 90.0
    disk_target_pct: float = 85.0
    broadcast_group: str = "239.10.10.10"
    broadcast_port: int = 5005
    extra: dict = field(default_factory=dict)

    @classmethod
    def from_env(cls, env=os.environ):
        missing = [k for k in ("PLATFORM_URL", "NODE_KEY") if not env.get(k)]
        if missing:
            raise SystemExit(f"Set {' and '.join(missing)} (see edge/README.md)")
        num = lambda k, d: float(env.get(k, d))
        return cls(platform_url=env["PLATFORM_URL"].rstrip("/"), node_key=env["NODE_KEY"],
                   data_dir=env.get("DATA_DIR", "/data/vision"), heartbeat_seconds=num("HEARTBEAT_SECONDS", 30),
                   batch_seconds=num("BATCH_SECONDS", 2), disk_prune_pct=num("DISK_PRUNE_PCT", 90),
                   disk_target_pct=num("DISK_TARGET_PCT", 85))
