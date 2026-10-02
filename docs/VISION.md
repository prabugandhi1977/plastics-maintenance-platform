# Vision AI: requirements and how they are met

The vision solution has two parts:

- **The platform** (this repository, cloud): licences, cameras, module routing, geofence drawing, incidents with evidence, dashboards for EHS, security and QA, alarms on web and phones, and the retraining set.
- **The edge node** (`edge/`, a GPU PC on the factory network): video decoding, AI models, decisions, and the time-critical actions (beacons, sirens, PLC rejects, factory-network alarm broadcast).

Anything that must happen in milliseconds, or must work without the internet, happens on the edge node. The cloud cannot meet a 15 ms PLC deadline or guarantee a 2-second broadcast on the factory subnet.

Status: **Built** means it is built and tested in this repository. **Reference** means the code is written and unit-tested, but it needs the GPU, cameras or PLC on site to run. **Site** means the work happens during commissioning.

## Personas

| Persona | What they get | Where |
| --- | --- | --- |
| EHS officer | PPE compliance rate and violations by missing item and camera; fire/smoke alarms; proof-of-violation log (CSV) with snapshot and clip kept permanently | Vision overview → *EHS*; Vision incidents; phone alarms |
| Security & facility admin | Restricted-area intrusions by zone, people vs vehicles, machine motion ignored; critical alarms on screen and phone | Vision overview → *Security*; zones drawn per camera |
| QA lead | Inspected, defect rate, defects by type, preset and camera; logistics damage profile; false-alarm review for retraining | Vision overview → *Quality inspection* |

Each person's **vision duties** (set by the company admin on the user) decide which alarms reach them and their default dashboard. Fire alarms reach everyone with a duty.

## Functional requirements

| Requirement | How it is met | Status |
| --- | --- | --- |
| Modular licensing; admins assign modules to cameras in a central UI | Licences per company and module (cameras, valid until), set by the platform admin; each enabled module on a camera uses one seat, enforced by the API and in the configuration sent to the edge | Built |
| 4.1 Real-time PPE compliance | Detector + tracker on every frame; per-person check that each required item sits on the right body part, in the PPE zone; per-minute people/compliant counters | Reference (edge), Built (platform) |
| 4.1 Helmets, vests, goggles, steel-toe boots | Required gear chosen per camera; detector classes listed in `edge/deepstream/detector_safety.txt` | Reference; model training at site |
| 4.1 Edge relay blinks the beacon at that doorway | `beaconOutput` per camera (Modbus TCP coil, EtherNet/IP tag, GPIO or HTTP relay) with pulse length; fired by the edge before reporting | Reference (Modbus tested at < 15 ms) |
| 4.2 Distinguish flame/smoke from steam, dust, welding | Temporal confirmation over 0.2–1.8 s with flicker/growth and a tiny-static filter, plus a 3D-CNN classifier stage; sensitivity per camera | Reference; model training at site |
| 4.2 Critical alarm across the factory subnet in < 2 s | Signed UDP multicast, 3 repeats, sent before anything else; measured time stored with the incident and shown as p95 | Reference (broadcast < 5 ms measured) |
| 4.3 Micro-defects ≥ 0.5 mm | Minimum defect size and calibration (mm/pixel) per camera; size computed per defect; camera sizing in `edge/README.md` | Reference; optics at site |
| 4.3 Presets: vehicle body, electronics, logistics containers | Three presets with their defect classes; one model per preset | Built (platform), Reference (edge) |
| 4.4 Draw exclusion lines and polygons | Geofence editor over the camera image: exclusion zones, tripwires, approved-motion areas, PPE zones, inspection areas | Built |
| 4.4 Human/vehicle intrusions vs approved machine motion | People/vehicles in exclusion zones raise events (severity per zone); detections inside approved-motion areas are ignored and counted | Reference (edge), Built (platform) |

## Feature matrix

| ID | Feature | How it is met | Status |
| --- | --- | --- | --- |
| FEAT-01 (Must) | 16 streams per edge node | `maxStreams` per node (default 16) enforced by the platform; DeepStream batch of 16 with NVDEC decoding; sizing in `edge/README.md` | Built (platform), Reference (edge) |
| FEAT-02 (Must) | Unified dashboard with overlays and live statistics | Vision overview: camera tiles with latest snapshot and bounding boxes, pass/fail/compliance per camera, open alarms, charts; refreshes every 15 s; alarm banner on every page | Built |
| FEAT-03 (Must) | Drag-and-drop module routing | Drag a licensed module card onto a camera (or use *Add module*), then set its options | Built |
| FEAT-04 (Must) | PLC outputs within 15 ms (Modbus TCP, EtherNet/IP) | Reject fires inline in the quality path before logging; Modbus on a persistent raw socket; EtherNet/IP via pycomm3 | Reference (Modbus measured < 15 ms on loopback); timing test on the real PLC at site |
| FEAT-05 (Should) | 10-second incident clips | Ring buffer of 2-s segments, clip from 5 s before to 5 s after, uploaded with the incident; playable in the incident view | Reference (edge), Built (platform) |
| FEAT-06 (Should) | Click-and-drag geofencing over live view | Points placed by clicking and moved by dragging, over the camera's latest frame | Built |
| FEAT-07 (Could) | Upload false alarms for retraining (OTA) | *False alarm → send for retraining* keeps the clip; `GET /api/vision/retraining` lists the training set | Built (collection); OTA model rollout is a next step |

## Technical and non-functional requirements

| Requirement | How it is met | Status |
| --- | --- | --- |
| 6.1 Quality < 25 ms per frame at 60 FPS | Separate quality pipeline (never waits for the safety batch), FP16 segmentation, batch ≤ 4; node reports inference p95, shown on the node page | Reference; verify on the chosen GPU |
| 6.1 TensorRT/DeepStream; YOLO-class, 3D-CNN and segmentation together | Two pipelines, three nvinfer stages (`edge/deepstream/`), GPU temperature reported and alerted | Reference |
| 6.2 Quality ≥ 99.8 % true positives, < 0.5 % false alarms | Measured from the incident log (false alarms marked by people); training and validation plan in `edge/MODELS.md` | Site (needs your data) |
| 6.2 Life-safety pre-emption | Edge: a dedicated thread for fire/smoke/intrusion that acts and uploads before logging and batching. Platform: critical events are processed first in a batch, raise alerts at once, and show on the alarm banner within 5 s | Built (platform), Reference (edge) |
| 6.3 IP67, fanless enclosures | Hardware guidance in `edge/README.md`; GPU temperature monitored, `node_overheat` alert | Site |
| 6.3 Auto-pruning at 90 % disk; locked clips never deleted | Edge pruning agent (oldest unlocked first, down to 85 %). Platform: closed, unlocked evidence older than the retention period (30 days) is deleted; life-safety and PPE evidence is locked automatically; locking and unlocking are audited | Built (platform), Reference (edge) |

## Security and privacy

- Each edge node has its own key (only a hash is stored; shown once; can be replaced). A node can report only for its own cameras.
- Camera passwords in stream URLs are shown masked to people and sent in full only to the node.
- Evidence is served only to users of the same company; exports and evidence locks are recorded in the audit trail.
- Video of people is personal data: inform employees, limit retention, and restrict access to EHS, security and administrators. Check your works council or local rules before go-live. Face recognition is deliberately not part of this solution.

## Open questions for the next round

1. Camera models and count per plant, and which PLCs and I/O modules (brand, Modbus or EtherNet/IP)?
2. The parts and products for quality inspection (size, speed, defect examples)?
3. Retention: how long to keep closed incidents and their clips (now 30 days; locked evidence permanently)?
4. Should vision alarms also go out by SMS, WhatsApp or phone call (needs a provider such as Twilio)?
