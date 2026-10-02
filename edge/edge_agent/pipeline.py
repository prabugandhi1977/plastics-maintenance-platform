"""NVIDIA DeepStream pipeline: decode up to 16 camera streams on the GPU, batch them, run the models with
TensorRT, track objects, and hand each frame's detections to the module decisions.

Two pipelines run side by side so a slow model never delays a fast one:

  safety   (PPE, fire & smoke, intrusion)  RTSP x N -> nvv4l2decoder -> nvstreammux (batch N, 1280x720)
           -> nvinfer  detector  (people, vehicles, helmet, vest, goggles, boots, fire, smoke)  YOLO-class, INT8/FP16
           -> nvtracker (NvDCF, ids across frames: cooldowns, dwell, tripwires)
           -> nvinfer  temporal fire/smoke classifier on flagged regions (3D-CNN over a 16-frame clip)
           -> probe -> decisions.py -> alarms.Dispatcher
  quality  (inspection cameras, 60 fps)     -> nvstreammux (full sensor resolution)
           -> nvinfer  segmentation (surface defects per preset)  -> probe -> defect_findings -> PLC reject inline

Requires DeepStream 7.x with its Python bindings (pyds) and GStreamer (gi). The pipeline text and probe logic
are plain Python and are tested without a GPU; run_pipeline() needs the hardware.
"""
import os

HERE = os.path.dirname(os.path.abspath(__file__))
DS_CONFIG = os.path.join(os.path.dirname(HERE), "deepstream")


def source_uri(camera):
    t = camera["sourceType"]
    if t == "rtsp":
        return camera["sourceUrl"]
    if t == "csi":
        return None  # nvarguscamerasrc on Jetson / v4l2src on an IPC with a CSI bridge
    raise ValueError(f"{camera['name']}: {t} cameras are read by the snapshot poller, not the video pipeline")


def build_pipeline(cameras, *, kind="safety", width=1280, height=720, batch_timeout_us=40000):
    """gst-launch style description of one pipeline for the given cameras (each a config entry from the
    platform). Safety cameras share a detector; quality cameras run the segmentation model at full speed."""
    if not cameras:
        return None
    if len(cameras) > 16:
        raise ValueError("One edge node handles up to 16 streams per pipeline; add a node or split the cameras")
    w, h = (width, height) if kind == "safety" else (1920, 1200)
    mux = (f"nvstreammux name=mux batch-size={len(cameras)} width={w} height={h} live-source=1 "
           f"batched-push-timeout={batch_timeout_us} nvbuf-memory-type=0")
    sources = []
    for i, c in enumerate(cameras):
        uri = source_uri(c)
        if uri is None:
            src = f"nvarguscamerasrc sensor-id={i} ! video/x-raw(memory:NVMM),framerate={c.get('fps', 30)}/1"
        else:
            src = f"rtspsrc location=\"{uri}\" latency=100 protocols=tcp drop-on-latency=true ! rtph264depay ! h264parse ! nvv4l2decoder"
        sources.append(f"{src} ! queue leaky=downstream max-size-buffers=4 ! mux.sink_{i}")
    if kind == "safety":
        infer = (f"nvinfer name=detector config-file-path={DS_CONFIG}/detector_safety.txt batch-size={len(cameras)} ! "
                 f"nvtracker ll-lib-file=/opt/nvidia/deepstream/deepstream/lib/libnvds_nvmultiobjecttracker.so "
                 f"ll-config-file={DS_CONFIG}/tracker_nvdcf.yml ! "
                 f"nvinfer name=firesmoke config-file-path={DS_CONFIG}/classifier_firesmoke.txt")
    else:
        infer = f"nvinfer name=inspector config-file-path={DS_CONFIG}/segmenter_quality.txt batch-size={len(cameras)}"
    return " ".join([mux, "!", infer, "! identity name=probe silent=true ! fakesink sync=false async=false"] + [" " + s for s in sources])


# Class ids of detector_safety.txt (labels file order).
SAFETY_LABELS = ["person", "vehicle", "helmet", "vest", "goggles", "boots", "fire", "smoke"]


def frame_detections(frame_meta, pyds, labels=SAFETY_LABELS):
    """Converts one DeepStream frame's object metadata to decisions.Detection objects (normalised boxes)."""
    from .decisions import Detection
    out = []
    w, h = frame_meta.source_frame_width, frame_meta.source_frame_height
    item = frame_meta.obj_meta_list
    while item is not None:
        obj = pyds.NvDsObjectMeta.cast(item.data)
        r = obj.rect_params
        label = labels[obj.class_id] if obj.class_id < len(labels) else str(obj.class_id)
        out.append(Detection(label, obj.confidence, {"x": r.left / w, "y": r.top / h, "w": r.width / w, "h": r.height / h},
                             track_id=obj.object_id if obj.object_id != 0xFFFFFFFFFFFFFFFF else None,
                             attributes={"size_px": max(r.width, r.height)}))
        item = item.next
    return out


def run_pipeline(description, on_frame):
    """Starts a pipeline and calls on_frame(source_index, detections, timestamp) for every frame."""
    import gi  # noqa: deferred: only on the edge PC
    gi.require_version("Gst", "1.0")
    from gi.repository import Gst, GLib
    import pyds
    Gst.init(None)
    pipeline = Gst.parse_launch(description)

    def probe(pad, info):
        batch = pyds.gst_buffer_get_nvds_batch_meta(hash(info.get_buffer()))
        item = batch.frame_meta_list
        while item is not None:
            fm = pyds.NvDsFrameMeta.cast(item.data)
            on_frame(fm.pad_index, frame_detections(fm, pyds), fm.ntp_timestamp / 1e9 or None)
            item = item.next
        return Gst.PadProbeReturn.OK

    pipeline.get_by_name("probe").get_static_pad("src").add_probe(Gst.PadProbeType.BUFFER, probe)
    pipeline.set_state(Gst.State.PLAYING)
    loop = GLib.MainLoop()
    try:
        loop.run()
    finally:
        pipeline.set_state(Gst.State.NULL)
