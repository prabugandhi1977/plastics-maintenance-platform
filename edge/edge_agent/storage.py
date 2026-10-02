"""Evidence on the node's NVMe: a continuous ring buffer of short video segments per camera, 10-second incident
clips cut from it, and the pruning agent that keeps the disk below its limit.

Recording: ffmpeg copies each RTSP stream (no re-encoding, near-zero CPU) into 2-second MP4 segments. When an
incident happens, the segments from `pre` seconds before to `post` seconds after are joined into one clip
(stream copy again), so the clip shows what led up to the event.

Pruning: when disk use reaches the limit (90 %), the oldest unlocked files are deleted until it is back under
the target (85 %). Incident clips are written as *.locked.mp4 and are never deleted automatically.
"""
import os
import shutil
import subprocess
import time

SEGMENT_SECONDS = 2


def record_command(rtsp_url, out_dir, segment_seconds=SEGMENT_SECONDS):
    """ffmpeg command that keeps writing <epoch>.mp4 segments for one camera."""
    return ["ffmpeg", "-nostdin", "-loglevel", "error", "-rtsp_transport", "tcp", "-i", rtsp_url, "-c", "copy", "-an",
            "-f", "segment", "-segment_time", str(segment_seconds), "-reset_timestamps", "1", "-strftime", "1",
            os.path.join(out_dir, "%s.mp4")]


def segments_between(seg_dir, start, end, segment_seconds=SEGMENT_SECONDS):
    """Segment files (named by their start epoch) that overlap [start, end], oldest first."""
    out = []
    for name in os.listdir(seg_dir):
        stem = name[:-4] if name.endswith(".mp4") else None
        if stem and stem.isdigit():
            t = int(stem)
            if t + segment_seconds > start and t < end:
                out.append((t, os.path.join(seg_dir, name)))
    return [p for _, p in sorted(out)]


def clip_command(segment_paths, list_file, out_path):
    with open(list_file, "w") as f:
        f.writelines(f"file '{p}'\n" for p in segment_paths)
    return ["ffmpeg", "-nostdin", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", list_file,
            "-c", "copy", "-movflags", "+faststart", out_path]


def make_clip(seg_dir, event_time, out_path, pre=5, post=5, wait=True):
    """Waits until the post-event segments exist, then joins the clip. Returns the clip path or None."""
    if wait:
        time.sleep(max(0, event_time + post + SEGMENT_SECONDS - time.time()))
    parts = segments_between(seg_dir, event_time - pre, event_time + post)
    if not parts:
        return None
    subprocess.run(clip_command(parts, out_path + ".txt", out_path), check=True, timeout=30)
    os.remove(out_path + ".txt")
    return out_path


def disk_percent(path):
    u = shutil.disk_usage(path)
    return 100 * u.used / u.total


def prune(root, limit_pct=90, target_pct=85, usage=disk_percent):
    """Deletes the oldest unlocked files under root once usage >= limit_pct, until usage < target_pct.
    Files with '.locked.' in their name (incident clips) are never deleted. Returns the deleted paths."""
    if usage(root) < limit_pct:
        return []
    files = []
    for dirpath, _, names in os.walk(root):
        for n in names:
            if ".locked." in n or n.endswith(".tmp"):
                continue
            p = os.path.join(dirpath, n)
            try:
                files.append((os.path.getmtime(p), p))
            except OSError:
                pass
    deleted = []
    for _, p in sorted(files):
        if usage(root) < target_pct:
            break
        try:
            os.remove(p)
            deleted.append(p)
        except OSError:
            pass
    return deleted
