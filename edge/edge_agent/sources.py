"""Image capture for triggered quality inspection, one adapter per camera connection.

| Connection (platform)  | Cameras                                        | How the image is taken                      |
| ---------------------- | ---------------------------------------------- | ------------------------------------------- |
| `cognex-native`        | Cognex In-Sight                                | Native Mode over TCP: SW8 trigger, RB image |
| `http-snapshot`        | Hikvision (ISAPI), Keyence/others with HTTP    | One HTTP request (digest or basic auth)     |
| `rtsp`                 | Hikvision and any IP camera                    | ffmpeg keeps the stream open; newest frame  |
| `folder`               | Keyence CV-X/XG-X/IV, Hikrobot smart cameras   | Newest image the camera writes by FTP       |

Every adapter has `capture(after, timeout)`: returns a Frame taken at or after `after` (wall-clock seconds), or
raises CaptureError. Adapters keep their connection open between parts so a capture costs one round trip.
Ported from the VisionForge camera gateway (camera-gateway/gateway.js) so both use the same camera definitions.
"""
import os
import socket
import subprocess
import threading
import time
import urllib.parse
import urllib.request
from dataclasses import dataclass

IMAGE_TYPES = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".bmp": "image/bmp"}


class CaptureError(Exception):
    pass


@dataclass
class Frame:
    data: bytes
    mime: str
    t: float                 # wall-clock time the image was taken (or received)


def split_address(address, default_port=None):
    """'user:password@host:port' (or a URL) -> (user, password, host, port)."""
    u = urllib.parse.urlsplit(address if "//" in address else "//" + address)
    return (urllib.parse.unquote(u.username or "") or None, urllib.parse.unquote(u.password or ""), u.hostname, u.port or default_port)


# ---------- Cognex In-Sight Native Mode ----------

COGNEX_STATUS = {"1": "ok", "0": "unrecognised command", "-1": "invalid argument", "-2": "command failed (is the camera Online?)",
                 "-3": "user has no write access"}


def parse_cognex_bitmap(text):
    """Parses an RB reply (after the command): status line, optional decimal length line, then the bitmap as
    hexadecimal text. Returns the BMP bytes, None while incomplete; raises CaptureError on an error status."""
    lines = text.replace("\r", "").split("\n")
    if len(lines) < 2:
        return None
    status = lines[0].strip()
    if status != "1":
        raise CaptureError(f"Cognex RB: {COGNEX_STATUS.get(status, 'status ' + status)}")
    rest = lines[1:]
    if len(rest) > 1 and rest[0].strip().isdigit() and len(rest[0].strip()) <= 9:
        rest = rest[1:]                  # some firmware sends the length first
    hexa = "".join(c for c in "".join(rest) if c in "0123456789abcdefABCDEF")
    if len(hexa) < 12:
        return None
    head = bytes.fromhex(hexa[:12])
    if head[:2] != b"BM":
        raise CaptureError("Cognex RB: reply is not a bitmap")
    size = int.from_bytes(head[2:6], "little")
    return bytes.fromhex(hexa[:size * 2]) if len(hexa) >= size * 2 else None


class CognexNative:
    """One logged-in Native Mode session (default port 23), reused for every part."""

    def __init__(self, address, timeout=2.0):
        self.user, self.password, self.host, self.port = split_address(address, 23)
        self.user = self.user or "admin"
        self.timeout, self.sock, self.buf = timeout, None, ""
        self.lock = threading.Lock()

    def _read_until(self, test, deadline):
        while True:
            hit = test(self.buf)
            if hit is not None:
                return hit
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise CaptureError(f"Cognex {self.host} did not respond")
            self.sock.settimeout(remaining)
            chunk = self.sock.recv(65536)
            if not chunk:
                raise CaptureError(f"Cognex {self.host} closed the connection")
            self.buf += chunk.decode("latin1")

    def _send(self, line):
        self.buf = ""
        self.sock.sendall(f"{line}\r\n".encode("latin1"))

    def _login(self, deadline):
        try:
            self.sock = socket.create_connection((self.host, self.port), timeout=self.timeout)
        except OSError as e:
            raise CaptureError(f"Cannot reach Cognex {self.host}:{self.port} ({e})")
        self.sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        self._read_until(lambda t: True if t.rstrip().lower().endswith("user:") else None, deadline)
        self._send(self.user)
        self._read_until(lambda t: True if t.rstrip().lower().endswith("password:") else None, deadline)
        self._send(self.password)
        ok = self._read_until(lambda t: True if "user logged in" in t.lower() else False if any(w in t.lower() for w in ("invalid", "failed")) else None, deadline)
        if not ok:
            raise CaptureError("Cognex rejected the user name or password")

    def _status(self, deadline):
        return self._read_until(lambda t: t.split("\n", 1)[0].strip() if "\n" in t else None, deadline)

    def capture(self, after=None, timeout=1.0, trigger=True):
        deadline = time.monotonic() + timeout
        with self.lock:
            for attempt in range(2):
                try:
                    if self.sock is None:
                        self._login(deadline)
                    if trigger:
                        self._send("SW8")
                        status = self._status(deadline)
                        if status != "1":
                            raise CaptureError(f"Cognex trigger (SW8): {COGNEX_STATUS.get(status, 'status ' + status)}")
                    taken = time.time()
                    self._send("RB")
                    data = self._read_until(parse_cognex_bitmap, deadline)
                    return Frame(data, "image/bmp", taken)
                except (OSError, CaptureError) as e:
                    self.close()
                    if attempt or isinstance(e, CaptureError) and "rejected" in str(e) or time.monotonic() >= deadline:
                        raise CaptureError(str(e)) from e

    def close(self):
        if self.sock:
            try:
                self.sock.close()
            except OSError:
                pass
        self.sock, self.buf = None, ""


# ---------- HTTP snapshot (Hikvision ISAPI and others) ----------

class HttpSnapshot:
    """e.g. http://user:password@192.168.0.64/ISAPI/Streaming/channels/101/picture (Hikvision, digest auth)."""

    def __init__(self, url):
        u = urllib.parse.urlsplit(url)
        user, password = urllib.parse.unquote(u.username or ""), urllib.parse.unquote(u.password or "")
        netloc = u.hostname + (f":{u.port}" if u.port else "")
        self.url = urllib.parse.urlunsplit((u.scheme, netloc, u.path, u.query, ""))
        handlers = []
        if user:
            mgr = urllib.request.HTTPPasswordMgrWithDefaultRealm()
            mgr.add_password(None, self.url, user, password)
            handlers = [urllib.request.HTTPDigestAuthHandler(mgr), urllib.request.HTTPBasicAuthHandler(mgr)]
        self.opener = urllib.request.build_opener(*handlers)

    def capture(self, after=None, timeout=1.0):
        try:
            with self.opener.open(self.url, timeout=timeout) as r:
                data, mime = r.read(), r.headers.get_content_type()
        except Exception as e:
            raise CaptureError(f"Snapshot {self.url}: {e}") from e
        return Frame(data, mime if mime.startswith("image/") else "image/jpeg", time.time())


# ---------- RTSP: newest frame from a stream kept open ----------

def split_jpegs(buf):
    """Complete JPEG images in a byte stream (SOI ... EOI) and the unfinished remainder."""
    out = []
    while True:
        s = buf.find(b"\xff\xd8")
        if s < 0:
            return out, b""
        e = buf.find(b"\xff\xd9", s + 2)
        if e < 0:
            return out, buf[s:]
        out.append(buf[s:e + 2])
        buf = buf[e + 2:]


class RtspLatest:
    """ffmpeg decodes the stream continuously; capture returns the first frame received after the trigger.
    Opening RTSP per part would cost 0.3–1 s, too slow for a 500 ms result budget."""

    def __init__(self, url, fps=15, ffmpeg="ffmpeg"):
        self.url, self.fps, self.ffmpeg = url, fps, ffmpeg
        self.latest, self.cond, self.proc = None, threading.Condition(), None

    def _start(self):
        self.proc = subprocess.Popen([self.ffmpeg, "-loglevel", "error", "-rtsp_transport", "tcp", "-i", self.url, "-vf", f"fps={self.fps}",
                                      "-f", "image2pipe", "-vcodec", "mjpeg", "-q:v", "3", "pipe:1"], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        threading.Thread(target=self._reader, args=(self.proc,), daemon=True).start()

    def _reader(self, proc):
        buf = b""
        while True:
            chunk = proc.stdout.read(65536)
            if not chunk:
                return
            frames, buf = split_jpegs(buf + chunk)
            if frames:
                with self.cond:
                    self.latest = Frame(frames[-1], "image/jpeg", time.time())
                    self.cond.notify_all()

    def capture(self, after=None, timeout=1.0):
        if self.proc is None or self.proc.poll() is not None:
            try:
                self._start()
            except OSError as e:
                raise CaptureError("ffmpeg is not installed (needed for RTSP cameras)") from e
        after = after or time.time()
        with self.cond:
            if not self.cond.wait_for(lambda: self.latest and self.latest.t >= after, timeout):
                raise CaptureError(f"No frame from {self.url} within {timeout:.1f} s")
            return self.latest

    def close(self):
        if self.proc:
            self.proc.kill()


# ---------- Folder: images the camera writes by FTP ----------

class FolderImage:
    """Keyence CV-X/XG-X/IV and Hikrobot smart cameras can write each image to an FTP server on the edge PC
    (e.g. vsftpd into /data/vision/ftp/<camera>). capture waits for the first image written after the trigger."""

    def __init__(self, path, poll_s=0.01):
        self.path, self.poll_s = path, poll_s

    def newest(self, after=0):
        best = None
        try:
            with os.scandir(self.path) as it:
                for e in it:
                    ext = os.path.splitext(e.name)[1].lower()
                    if ext in IMAGE_TYPES and e.is_file():
                        m = e.stat().st_mtime
                        if m >= after and (best is None or m > best[0]):
                            best = (m, e.path, IMAGE_TYPES[ext])
        except FileNotFoundError as e:
            raise CaptureError(f"Folder not found: {self.path}") from e
        return best

    def capture(self, after=None, timeout=1.0):
        after = after if after is not None else 0
        deadline = time.monotonic() + timeout
        while True:
            hit = self.newest(after)
            if hit:
                m, path, mime = hit
                time.sleep(self.poll_s)          # let the FTP server finish writing the file
                with open(path, "rb") as f:
                    return Frame(f.read(), mime, m)
            if time.monotonic() >= deadline:
                raise CaptureError(f"No new image in {self.path} within {timeout:.1f} s")
            time.sleep(self.poll_s)


def open_source(camera):
    """The capture adapter for a camera from the platform configuration."""
    t, url = camera["sourceType"], camera.get("sourceUrl") or ""
    if t == "cognex-native":
        return CognexNative(url)
    if t == "http-snapshot":
        return HttpSnapshot(url)
    if t == "rtsp":
        return RtspLatest(url, fps=min(camera.get("fps") or 15, 30))
    if t == "folder":
        return FolderImage(url)
    raise CaptureError(f"{camera['name']}: {t} cameras are not captured per part")


def to_jpeg(frame, ffmpeg="ffmpeg"):
    """The platform stores JPEG/PNG/WebP evidence; BMP from Cognex or Keyence is converted with ffmpeg."""
    if frame.mime in ("image/jpeg", "image/png", "image/webp"):
        return frame.data, frame.mime
    try:
        out = subprocess.run([ffmpeg, "-loglevel", "error", "-i", "pipe:0", "-frames:v", "1", "-f", "image2", "-vcodec", "mjpeg", "-q:v", "4", "pipe:1"],
                             input=frame.data, capture_output=True, timeout=5)
        if out.returncode == 0 and out.stdout:
            return out.stdout, "image/jpeg"
    except (OSError, subprocess.TimeoutExpired):
        pass
    return None, None
