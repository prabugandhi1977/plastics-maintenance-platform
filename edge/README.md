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
| `edge_agent/outputs.py` | Modbus TCP write coil / read coils and discrete inputs on a raw socket (no library), EtherNet/IP tag read and write via `pycomm3` over one open session per PLC, GPIO via `gpioset`, HTTP relays; pulse and release | ✓ Modbus against a simulated PLC: < 15 ms |
| `edge_agent/sources.py` | Image capture per part: Cognex In-Sight Native Mode (SW8 trigger + RB image, one logged-in session), Hikvision ISAPI snapshot (digest/basic login), RTSP kept open by ffmpeg (newest frame after the trigger), Keyence/Hikrobot FTP folder (first image after the trigger) | ✓ against simulated cameras |
| `edge_agent/quality.py` | Triggered inspection: PLC part-present rising edge → capture → model → grade by surface class A/B/C → NG or OK output → report; a part without an image is rejected | ✓ trigger to result against a simulated PLC and Cognex |
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

## Quality inspection on moulding lines (Hikvision, Keyence, Cognex; EtherNet/IP, Modbus)

One inspection per part, driven by the machine:

```
PLC part-present ↑ ──▶ capture ──▶ model (GPU) ──▶ grade A/B/C ──▶ NG or OK to the PLC ──▶ report
        (≤ 5 ms poll)   50–250 ms     20–60 ms        < 1 ms          < 15 ms                 async
```

**Cycle time.** The shortest machine cycle is 3 s. The OK/NG result is due within the **result budget** (default 500 ms, at most half the cycle; set per camera), leaving the robot and the PLC the rest of the cycle. Each result reports `inspectionMs` (trigger to output); the camera tile shows it, and a part over budget is flagged. **Program the PLC to treat a missing result within its own timeout as NG.** A part the camera could not capture is rejected and a `camera_offline` event is raised.

**Grading.** Inspection areas drawn on the camera image carry a surface class (VDA 16): **A** visible surfaces, **B** partly visible, **C** hidden. A defect is placed by its centre (where areas overlap, the stricter class wins) and rejects the part when its size reaches the class limit (defaults A 0.5 mm, B 1.0 mm, C 2.0 mm; use the limits agreed with your customer). Defects outside every area are ignored. Without calibration (mm per pixel), sizes are unknown and every defect rejects the part.

**Cameras.**

| Make | Connection to choose | Address | Notes |
| --- | --- | --- | --- |
| Cognex In-Sight | Cognex In-Sight Native Mode | `admin:password@192.168.0.50:23` | The job must accept software triggers (Spreadsheet: AcquireImage trigger = External/Network) and the camera must be Online. The agent triggers with `SW8` and reads the image with `RB`. If the PLC triggers the camera directly (*Camera hardware trigger*), let the job write each image by FTP to the edge PC and choose *Image folder* instead. |
| Hikvision IP camera | HTTP snapshot | `http://user:pass@192.168.0.64/ISAPI/Streaming/channels/101/picture` | Digest login (Hikvision default). Use a fixed exposure and a fixed focus. |
| Hikvision / any IP camera | RTSP | `rtsp://user:pass@192.168.0.64:554/Streaming/Channels/101` | ffmpeg keeps the stream open; the first frame after the trigger is used. Adds the stream latency (~100–200 ms). |
| Keyence CV-X / XG-X / IV, Hikrobot smart cameras | Image folder | `/data/vision/ftp/imm05` | Set the camera's image output to FTP on the edge PC (e.g. vsftpd). The agent takes the first image written after the trigger. |
| Hikrobot / Keyence GigE Vision area-scan cameras | — | — | Use the maker's SDK (Hikrobot MVS, Keyence) or GenICam (Aravis/harvesters) behind a small adapter with the same `capture()`; not included yet. |

**PLC.** In the quality module set the trigger input and the OK and NG outputs:

| Protocol | Trigger input | OK / NG outputs |
| --- | --- | --- |
| EtherNet/IP (Rockwell/Omron CIP) | BOOL tag, e.g. `Cell5_PartPresent` | BOOL tags, e.g. `Cell5_VisionOK`, `Cell5_VisionNG` (pulsed) |
| Modbus TCP | Discrete input or coil address | Coil addresses (pulsed) |

The agent polls the trigger every 5 ms on a persistent connection and acts on the rising edge only (a signal held high is one part). With *Camera hardware trigger* there is no PLC input to read: use the image-folder connection, where each new image is one part.

**Model.** Start the agent with `QUALITY_MODEL=package.module:factory`: `factory(camera)` returns `model(frame) -> [Detection]` (your TensorRT segmentation or PatchCore engine; see `MODELS.md`). Continuous quality cameras (*Continuous video* trigger) run in the DeepStream pipeline instead.

## Connecting VisionForge stations

Quality stations running VisionForge (the browser inspection console with recipes, approval and PatchCore anomaly detection) can report through the same edge API: add the station as a camera of source type **VisionForge inspection station**, assign **Quality inspection**, and post each FAIL as a `defect` event plus per-minute `inspected`/`passed` counters in the heartbeat. Camera definitions use the same types as the VisionForge camera gateway (`rtsp`, `http-snapshot`, `cognex-native`, `folder`).

## Not done yet (needs your site)

- Training and validating the models on your own images (see `MODELS.md`); accuracy targets cannot be met with generic public models.
- Commissioning: camera placement and lighting, calibration targets for quality cameras, PLC tags/addresses and the trigger-to-result timing test on the real line (the PLC's NG-on-timeout), the multicast group on your switches (IGMP snooping).
- A GigE Vision (GenICam) capture adapter for Hikrobot or Keyence area-scan cameras without FTP output.
- A signed, versioned container image and over-the-air model updates driven from the platform (the retraining set is already collected).
