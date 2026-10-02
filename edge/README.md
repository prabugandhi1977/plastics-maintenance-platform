# Vision edge node: reference agent

The edge node is an industrial PC with an NVIDIA GPU, installed on the factory network next to the cameras. It does everything that must be fast or must work without the internet: it decodes the camera streams, runs the AI models, decides, and acts on the spot (beacons, sirens, PLC rejects, factory-network alarm broadcast). It then reports each incident to the platform with a snapshot and a 10-second clip, and fetches its configuration (cameras, modules, zones, settings) from the platform every 30 seconds.

```
 IP / CSI cameras ──RTSP──▶ EDGE NODE (GPU PC, factory LAN) ──HTTPS──▶ PLATFORM (cloud)
                            ├ decode ×16 on NVDEC                       ├ licences, cameras, module routing
                            ├ TensorRT models (DeepStream)              ├ geofence drawing
                            ├ decisions (this package)                  ├ incidents, evidence, proof logs
                            ├ beacons / sirens / PLC  (≤ 15 ms)         ├ dashboards (EHS, security, QA)
                            ├ UDP multicast alarm      (< 2 s)          └ alarms to web and phones
                            └ ring-buffer video, clips, pruning
```

## What is in this folder

| Path | What it does | Tested here |
| --- | --- | --- |
| `edge_agent/decisions.py` | PPE check per person (gear on the right body part, zone, confidence, cooldown); fire/smoke temporal confirmation (flicker/growth, rejects welding arcs, confirms within 1.8 s); intrusion in exclusion zones minus approved machine motion, with dwell time and tripwires; quality defect size from calibration and minimum size | ✓ |
| `edge_agent/alarms.py` | Two lanes: life-safety events pre-empt everything (local actions first, immediate upload); other events are batched | ✓ |
| `edge_agent/outputs.py` | Modbus TCP Write Single Coil on a raw socket (no library), EtherNet/IP via `pycomm3`, GPIO via `gpioset`, HTTP relays; pulse and release | ✓ Modbus against a simulated PLC: < 15 ms |
| `edge_agent/broadcast.py` | Signed UDP multicast alarm on the factory subnet, sent 3×; example receiver for screens, PA and fire panels | ✓ |
| `edge_agent/storage.py` | ffmpeg ring buffer (2-s segments, stream copy), 10-second clips from 5 s before to 5 s after, pruning agent (90 % → 85 %, locked clips never deleted) | ✓ |
| `edge_agent/platform.py` | Edge API client with a disk outbox: nothing is lost while the uplink is down | ✓ |
| `edge_agent/pipeline.py` + `deepstream/` | DeepStream pipelines (safety: detector + tracker + temporal fire/smoke classifier; quality: segmentation at full resolution) and the frame probe | pipeline text ✓; running needs the GPU |
| `edge_agent/agent.py` | Configuration sync, per-camera module runtime, per-minute counters, heartbeat, housekeeping | ✓ |
| `edge_agent/simulate.py` | Drives the real logic with synthetic detections against a platform | ✓ |

Run the tests (Python 3.10+, no packages needed): `python3 -m unittest discover -s edge/tests`

## Try it without hardware

```bash
# 1. A platform with demo data (from the repository root)
npm run seed && npm start
# 2. In another terminal: an edge node that sends realistic detections for two minutes
cd edge && python3 -m edge_agent.simulate --platform http://localhost:3100 --key vn_demo-chicago-edge-node-key-0001 --minutes 2
```

Open **Vision overview** in the web workspace: counters, incidents and alarms appear as they arrive. The demo key works only on demo databases.

## Install on the edge PC

1. **Hardware** (see sizing below): industrial PC, NVIDIA RTX A4000/A5000 or L4, NVMe SSD, two network ports (camera VLAN and factory LAN). For IP67 sites use a fanless, sealed enclosure with a conduction-cooled GPU module; keep the GPU under 80 °C (the node reports its temperature in every heartbeat, and the platform alerts on `node_overheat`).
2. **Software**: Ubuntu 22.04, NVIDIA driver, Docker with the NVIDIA Container Toolkit, and the DeepStream 7 container (`nvcr.io/nvidia/deepstream:7.1-triton-multiarch`), which includes TensorRT, GStreamer and the Python bindings (`pyds`).
3. **Models**: put the ONNX models in `/models` and let DeepStream build the TensorRT engines on first start (see `MODELS.md`).
4. **Register the node**: in the platform, **Edge nodes & licences → Add edge node**. Copy the key shown once.
5. **Start the agent** (inside the DeepStream container, with this folder mounted):

```bash
docker run -d --name vision-edge --gpus all --restart unless-stopped --network host \
  -e PLATFORM_URL=https://plastics-maintenance-platform.onrender.com -e NODE_KEY=vn_… \
  -v /opt/vision/edge:/app -v /opt/vision/models:/models -v /data/vision:/data/vision \
  nvcr.io/nvidia/deepstream:7.1-triton-multiarch \
  bash -c "pip install pycomm3 && cd /app && python3 -m edge_agent"
```

6. **Cameras**: add them in **Cameras & AI modules**, choose this node, drag modules onto them and draw zones. The node picks up changes within 30 seconds.

`--network host` lets the agent send the multicast alarm on the factory subnet and reach the PLCs directly. Keep the edge PC on a network segment that the internet cannot reach; it needs outbound HTTPS to the platform only.

## Sizing

| Load | GPU | Notes |
| --- | --- | --- |
| 16 safety streams, 1080p/25 fps decoded, analysed at 10–15 fps | RTX A4000 (16 GB) | Detector INT8 at batch 16 ≈ 10–15 ms per batch; tracker on GPU |
| + 2 quality cameras at 60 fps | RTX A5000 / L4 (24 GB) | Run quality as a separate pipeline so it never waits for the safety batch; budget < 25 ms per frame |
| > 16 streams | add a node | `maxStreams` per node is enforced by the platform |

**0.5 mm defects** need about 0.17 mm per pixel (3 pixels across the defect): a 20-megapixel camera (5472 px) covers a field of view of about 900 mm. Larger parts need several cameras or a line-scan camera. Lighting (diffuse dome or low-angle for scratches and dents) matters more than the model.

## Latency budget (life safety)

| Step | Budget |
| --- | --- |
| Capture → decoded frame | ≤ 150 ms (RTSP latency 100 ms) |
| Detector + tracker | ≤ 50 ms |
| Temporal confirmation (fire/smoke) | ≤ 1,500 ms (configurable 0.2–1.8 s) |
| Factory-network broadcast | < 5 ms (measured locally) |
| **Total to alarm on the floor** | **< 2,000 ms** |
| Upload to the platform and phones | typically < 1 s more; reported per incident as "received after …" |

The platform shows the measured p95 of the broadcast and actuator times from the incidents' `edgeActions`.

## Connecting VisionForge stations

Quality stations running VisionForge (the browser inspection console with recipes, approval and PatchCore anomaly detection) can report through the same edge API: add the station as a camera of source type **VisionForge inspection station**, assign **Quality inspection**, and post each FAIL as a `defect` event plus per-minute `inspected`/`passed` counters in the heartbeat. Camera definitions use the same types as the VisionForge camera gateway (`rtsp`, `http-snapshot`, `cognex-native`, `folder`).

## Not done yet (needs your site)

- Training and validating the models on your own images (see `MODELS.md`); accuracy targets cannot be met with generic public models.
- Commissioning: camera placement and lighting, calibration targets for quality cameras, PLC addresses and timing tests on the real line, the multicast group on your switches (IGMP snooping).
- A signed, versioned container image and over-the-air model updates driven from the platform (the retraining set is already collected).
