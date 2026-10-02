"""Client for the platform's edge API, with a disk outbox so nothing is lost while the uplink is down.

  POST /api/edge/v1/heartbeat   health and counters; the reply carries the configuration when it changed
  POST /api/edge/v1/events      detections (critical first; replays are harmless: each has an externalId)
  POST /api/edge/v1/media       snapshot / 10-second clip for an event, or a camera frame for zone drawing
"""
import base64
import json
import os
import threading
import urllib.error
import urllib.request


class PlatformError(Exception):
    def __init__(self, status, message):
        super().__init__(f"{status}: {message}")
        self.status = status


class Platform:
    def __init__(self, url, key, timeout=10, outbox_dir=None):
        self.url, self.key, self.timeout = url.rstrip("/"), key, timeout
        self.outbox = os.path.join(outbox_dir, "outbox") if outbox_dir else None
        if self.outbox:
            os.makedirs(self.outbox, exist_ok=True)
        self.lock = threading.Lock()

    def _post(self, path, body):
        req = urllib.request.Request(f"{self.url}/api/edge/v1/{path}", data=json.dumps(body).encode(), method="POST",
                                     headers={"content-type": "application/json", "authorization": f"Bearer {self.key}"})
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as r:
                return json.loads(r.read() or b"{}")
        except urllib.error.HTTPError as e:
            try:
                message = json.loads(e.read()).get("error", e.reason)
            except ValueError:
                message = e.reason
            raise PlatformError(e.code, message) from None

    def heartbeat(self, body):
        return self._post("heartbeat", body)

    def send_events(self, events):
        """Sends events; on a network failure they go to the outbox and are retried by flush()."""
        try:
            return self._post("events", {"events": events})
        except (urllib.error.URLError, TimeoutError, OSError, PlatformError) as e:
            if isinstance(e, PlatformError) and e.status < 500 and e.status != 429:
                raise  # a rejected request will not succeed later; surface it
            self._spool("events", {"events": events})
            return None

    def send_media(self, *, kind, mime, data, event_id=None, camera_id=None):
        body = {"kind": kind, "mime": mime, "base64": base64.b64encode(data).decode()}
        if event_id:
            body["eventId"] = event_id
        if camera_id:
            body["cameraId"] = camera_id
        try:
            return self._post("media", body)
        except (urllib.error.URLError, TimeoutError, OSError):
            self._spool("media", body)
            return None

    # Outbox: one JSON file per request, sent oldest first when the platform is reachable again.
    def _spool(self, path, body):
        if not self.outbox:
            return
        with self.lock:
            name = f"{len(os.listdir(self.outbox)):08d}-{os.getpid()}-{threading.get_ident()}-{path}.json"
            tmp = os.path.join(self.outbox, name + ".tmp")
            with open(tmp, "w") as f:
                json.dump({"path": path, "body": body}, f)
            os.replace(tmp, os.path.join(self.outbox, name))

    def flush(self, limit=50):
        if not self.outbox:
            return 0
        sent = 0
        for name in sorted(n for n in os.listdir(self.outbox) if n.endswith(".json"))[:limit]:
            full = os.path.join(self.outbox, name)
            with open(full) as f:
                item = json.load(f)
            try:
                self._post(item["path"], item["body"])
            except PlatformError as e:
                if e.status >= 500 or e.status == 429:
                    break
            except (urllib.error.URLError, TimeoutError, OSError):
                break
            os.remove(full)
            sent += 1
        return sent
