"""Versioned model store on disk. Layout:

  models/<company>/<kind>/<version>/model.joblib   the fitted model
                                    meta.json      what it was trained on and how well it did
  models/<company>/<kind>/current.json             {"version": ...}: the version in use

Versions are never overwritten. Rolling back is `set_current(...)` to an older version. Models are kept per
company so one customer's data never shapes another's predictions.
"""
import json
import os
import re

import joblib

_SAFE = re.compile(r"^[A-Za-z0-9._-]{1,80}$")


def _safe(part):
    if not _SAFE.match(str(part)) or part in (".", ".."):
        raise ValueError(f"unsafe path component: {part!r}")
    return part


class Registry:
    def __init__(self, root):
        self.root = root

    def _dir(self, company, kind, version=None):
        parts = [self.root, _safe(company), _safe(kind)] + ([_safe(version)] if version else [])
        return os.path.join(*parts)

    def save(self, company, kind, version, model, meta, make_current=True):
        d = self._dir(company, kind, version)
        if os.path.exists(d):
            raise FileExistsError(f"{kind} version {version} already exists for {company}")
        os.makedirs(d)
        joblib.dump(model, os.path.join(d, "model.joblib"))
        with open(os.path.join(d, "meta.json"), "w", encoding="utf-8") as f:
            json.dump({**meta, "kind": kind, "version": version}, f, indent=2)
        if make_current:
            self.set_current(company, kind, version)

    def set_current(self, company, kind, version):
        if not os.path.isdir(self._dir(company, kind, version)):
            raise FileNotFoundError(f"no {kind} version {version} for {company}")
        with open(os.path.join(self._dir(company, kind), "current.json"), "w", encoding="utf-8") as f:
            json.dump({"version": version}, f)

    def current_version(self, company, kind):
        try:
            with open(os.path.join(self._dir(company, kind), "current.json"), encoding="utf-8") as f:
                return json.load(f)["version"]
        except (FileNotFoundError, KeyError):
            return None

    def meta(self, company, kind, version=None):
        version = version or self.current_version(company, kind)
        if not version:
            return None
        with open(os.path.join(self._dir(company, kind, version), "meta.json"), encoding="utf-8") as f:
            return json.load(f)

    def load(self, company, kind, version=None):
        """(model, meta) of the current (or given) version, or None."""
        version = version or self.current_version(company, kind)
        if not version:
            return None
        d = self._dir(company, kind, version)
        return joblib.load(os.path.join(d, "model.joblib")), self.meta(company, kind, version)

    def versions(self, company, kind):
        d = self._dir(company, kind)
        return sorted(v for v in os.listdir(d) if os.path.isdir(os.path.join(d, v))) if os.path.isdir(d) else []

    def kinds(self, company):
        d = os.path.join(self.root, _safe(company))
        return sorted(k for k in os.listdir(d) if os.path.isdir(os.path.join(d, k))) if os.path.isdir(d) else []

    def companies(self):
        return sorted(c for c in os.listdir(self.root) if os.path.isdir(os.path.join(self.root, c))) if os.path.isdir(self.root) else []
