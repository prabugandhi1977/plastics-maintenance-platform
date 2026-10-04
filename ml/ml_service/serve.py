"""HTTP scoring service (standard library only).

  ML_SERVICE_KEY=... python -m ml_service.serve --models models --port 3200

  GET  /health   -> {"ok": true}
  GET  /models   -> models in use per company (needs the key)
  POST /score    {"companyId", "equipmentId", "task": "failure" (default) | "scrap", "features": {name: value}}
                 -> {"failure": {"probability", "horizonDays", "model": {...}} | null,
                     "anomaly": {"score", "level", "model": {...}} | null}
                 or, for task "scrap": {"scrap": {"probability", "horizonHours", "model": {...}} | null}

A missing model is reported as null, never guessed. Missing features count as 0 and extra ones are ignored; each
model carries the feature names it was trained on. Models load on first use and reload when a new version is made
current, so a retrain or rollback needs no restart.
"""
import argparse
import hmac
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np

from .registry import Registry


class Scorer:
    def __init__(self, registry):
        self.reg, self.cache = registry, {}

    def _model(self, company, kind):
        version = self.reg.current_version(company, kind)
        if not version:
            return None
        key = (company, kind)
        if self.cache.get(key, (None,))[0] != version:
            model, meta = self.reg.load(company, kind, version)
            self.cache[key] = (version, model, meta)
        return self.cache[key]

    @staticmethod
    def _vector(meta, features):
        return np.array([[float(features.get(n, 0.0)) for n in meta["featureNames"]]])

    @staticmethod
    def _tag(meta):
        return {"name": meta["name"], "version": meta["version"], "trainedAt": meta.get("trainedAt")}

    def score(self, company, equipment, features, task="failure"):
        if task == "scrap":
            m = self._model(company, "scrap")
            if not m:
                return {"scrap": None}
            _, model, meta = m
            p = float(model.predict_proba(self._vector(meta, features))[:, 1][0])
            return {"scrap": {"probability": round(p, 3), "horizonHours": round(meta["horizonDays"] * 24, 1),
                            "quality": {"auc": meta.get("auc"), "baseRate": meta.get("baseRate")}, "model": self._tag(meta)}}
        out = {"failure": None, "anomaly": None}
        m = self._model(company, "failure")
        if m:
            _, model, meta = m
            p = float(model.predict_proba(self._vector(meta, features))[:, 1][0])
            out["failure"] = {"probability": round(p, 3), "horizonDays": meta["horizonDays"],
                              "quality": {"auc": meta.get("auc"), "baseRate": meta.get("baseRate")}, "model": self._tag(meta)}
        a = self._model(company, f"anomaly-{equipment}")
        if a:
            _, model, meta = a
            s = float(-model.score_samples(self._vector(meta, features))[0])
            out["anomaly"] = {"score": round(s, 3), "level": "unusual" if s > meta["p99"] else "normal",
                              "normalScore": round(meta["median"], 3), "limit": round(meta["p99"], 3), "model": self._tag(meta)}
        return out

    def listing(self):
        out = {}
        for c in self.reg.companies():
            out[c] = {k: self.reg.meta(c, k) for k in self.reg.kinds(c) if self.reg.current_version(c, k)}
        return out


def make_handler(scorer, key):
    class Handler(BaseHTTPRequestHandler):
        def _send(self, status, body):
            data = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def _authorised(self):
            return not key or hmac.compare_digest(self.headers.get("x-ml-key", ""), key)

        def do_GET(self):
            if self.path == "/health":
                return self._send(200, {"ok": True})
            if not self._authorised():
                return self._send(401, {"error": "unauthorised"})
            if self.path == "/models":
                return self._send(200, scorer.listing())
            self._send(404, {"error": "not found"})

        def do_POST(self):
            if not self._authorised():
                return self._send(401, {"error": "unauthorised"})
            if self.path != "/score":
                return self._send(404, {"error": "not found"})
            try:
                n = int(self.headers.get("content-length", 0))
                if n > 1_000_000:
                    return self._send(413, {"error": "too large"})
                body = json.loads(self.rfile.read(n))
                features = body["features"]
                if not isinstance(features, dict):
                    raise ValueError("features must be an object")
                task = body.get("task", "failure")
                if task not in ("failure", "scrap"):
                    raise ValueError("task must be failure or scrap")
                self._send(200, scorer.score(str(body["companyId"]), str(body["equipmentId"]), features, task))
            except (KeyError, ValueError, TypeError) as e:
                self._send(400, {"error": f"bad request: {e}"})

        def log_message(self, *args):
            pass

    return Handler


def serve(models, port, key, host="127.0.0.1"):
    return ThreadingHTTPServer((host, port), make_handler(Scorer(Registry(models)), key))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--models", default="models")
    ap.add_argument("--port", type=int, default=3200)
    ap.add_argument("--host", default="127.0.0.1")
    a = ap.parse_args()
    key = os.environ.get("ML_SERVICE_KEY", "")
    if not key and a.host != "127.0.0.1":
        raise SystemExit("Set ML_SERVICE_KEY when listening on anything but 127.0.0.1")
    s = serve(a.models, a.port, key, a.host)
    print(f"ML service on {a.host}:{a.port}, models in {a.models}")
    s.serve_forever()


if __name__ == "__main__":
    main()
