# AI models: choice, licensing and the path to the accuracy targets

The platform is model-agnostic: the edge node runs any ONNX model through TensorRT. This is the recommended starting set, given that you start from pretrained models and improve them with your own clips.

## Recommended models

| Module | Task | Starting model | Why |
| --- | --- | --- | --- |
| PPE | Detect people and helmet, vest, goggles, boots | **RT-DETR** (Apache-2.0) or **YOLOX** (Apache-2.0), fine-tuned on a PPE dataset | Real-time detectors with commercial-friendly licences; TensorRT INT8 export |
| Fire & smoke | Per-frame flame/smoke detection + temporal confirmation | Same detector family trained on D-Fire / FASDD, plus a small **3D-CNN (X3D-S)** over 16-frame clips | The temporal stage is what separates flames and smoke plumes from steam, dust and welding arcs |
| Intrusion | People and vehicles (forklifts, trucks) | Same detector (COCO person/vehicle classes) + NvDCF tracker | Zones, dwell time and approved machine motion are handled by the agent, not the model |
| Quality | Surface defects at 0.5 mm | **Anomaly detection (PatchCore, via anomalib, Apache-2.0)** to start, then a **segmentation model (SegFormer / U-Net)** per preset once defects are labelled | PatchCore needs only good parts (as in VisionForge); segmentation gives defect classes and sizes |

### Licensing: please check before production

- **Ultralytics YOLOv5/v8/11 are AGPL-3.0.** Using them in a commercial product requires releasing your source code or buying an Ultralytics Enterprise licence. RT-DETR and YOLOX (Apache-2.0) avoid this.
- **NVIDIA TAO pretrained models** (e.g. PeopleNet) are free to use with NVIDIA hardware under the NVIDIA model licence; read its terms for redistribution.
- Public datasets (SH17, Hard Hat Workers, D-Fire, FASDD) have their own licences; some are non-commercial. Your own labelled images are the cleanest basis.

## Reaching ≥ 99.8 % detection and < 0.5 % false alarms

These targets are achievable only with models trained and validated on **your** cameras, lighting and products. Plan:

1. **Baseline (week 1–2)**: deploy the pretrained models in shadow mode (incidents recorded, no beacons or rejects). Measure true and false positives per camera from the incident log.
2. **Collect**: every false alarm marked in the platform (**False alarm → send for retraining**) is kept with its clip and listed at `GET /api/vision/retraining`. Add missed detections from spot checks.
3. **Label and train**: 1,000–3,000 labelled frames per site for PPE; 300+ defect examples per class for quality (anomaly detection needs only 200+ good parts to start).
4. **Validate before release**: a held-out test set from different shifts and days; release only when the target metrics are met on it. Record the model name and version with every incident (add it to `detail.model` in the agent's events; the platform stores it with the incident).
5. **Roll out**: new TensorRT engines are copied to the node and loaded on restart; keep the previous engine for rollback.

Quality inspection at 99.8 % also depends on stable optics: fixed working distance, controlled lighting, and calibration with a target of known size (enter the resulting mm per pixel in the module settings).
