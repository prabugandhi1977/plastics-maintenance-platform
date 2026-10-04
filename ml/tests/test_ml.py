"""Tests on synthetic feature tables (no platform needed): python -m unittest discover -s tests  (from the ml folder)."""
import json
import os
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

import numpy as np

from ml_service import serve, train
from ml_service.registry import Registry

NAMES = ["a_z", "a_slope", "b_z", "down_hours_24h"]
START = datetime(2026, 1, 1, tzinfo=timezone.utc)


def table(company="c1", machines=("m1", "m2"), days=60, signal=True, seed=1):
    """Every 6 h per machine. Before each synthetic breakdown, signal a_z drifts up (when `signal`), else noise only."""
    rng = np.random.default_rng(seed)
    rows = []
    for m in machines:
        breakdowns = [START + timedelta(days=d) for d in (12, 25, 38, 50)]
        for i in range(days * 4):
            t = START + timedelta(hours=6 * i)
            ahead = [(b - t).total_seconds() / 86400 for b in breakdowns if b > t]
            near = bool(ahead) and ahead[0] <= 7
            label = 1 if near else 0
            if t + timedelta(days=7) > START + timedelta(days=days):
                label = None
            drift = (7 - ahead[0]) / 7 * 6 if (near and signal) else 0
            rows.append({"companyId": company, "equipmentId": m, "at": t.isoformat().replace("+00:00", "Z"), "label": label,
                         "features": {"a_z": float(rng.normal(0, 1) + drift), "a_slope": float(rng.normal(0, 0.5) + drift / 4),
                                      "b_z": float(rng.normal(0, 1)), "down_hours_24h": float(abs(rng.normal(0, 0.3)))}})
    return {"version": 1, "horizonDays": 7, "featureNames": NAMES, "rows": rows}


def write(tmp, t):
    p = os.path.join(tmp, "f.json")
    with open(p, "w", encoding="utf-8") as f:
        json.dump(t, f)
    return p


class RegistryTest(unittest.TestCase):
    def test_versions_current_and_rollback(self):
        with tempfile.TemporaryDirectory() as d:
            r = Registry(d)
            r.save("c1", "failure", "v1", {"x": 1}, {"name": "m"})
            r.save("c1", "failure", "v2", {"x": 2}, {"name": "m"})
            self.assertEqual(r.current_version("c1", "failure"), "v2")
            self.assertEqual(r.load("c1", "failure")[0], {"x": 2})
            r.set_current("c1", "failure", "v1")
            self.assertEqual(r.load("c1", "failure")[1]["version"], "v1")
            self.assertEqual(r.versions("c1", "failure"), ["v1", "v2"])
            with self.assertRaises(FileExistsError):
                r.save("c1", "failure", "v1", {}, {})
            with self.assertRaises(ValueError):
                r.save("../evil", "failure", "v1", {}, {})
            self.assertIsNone(r.load("c2", "failure"))


class TrainTest(unittest.TestCase):
    def test_learns_a_real_signal_and_records_quality(self):
        with tempfile.TemporaryDirectory() as d:
            rep = train.run(write(d, table()), os.path.join(d, "models"))
            f = rep["c1"]["failure"]
            self.assertEqual(f["status"], "ok", f)
            self.assertGreater(f["auc"], 0.85)
            meta = Registry(os.path.join(d, "models")).meta("c1", "failure")
            self.assertEqual(meta["featureNames"], NAMES)
            self.assertIn("trainedAt", meta)
            self.assertEqual(rep["c1"]["anomaly"]["m1"]["status"], "ok")

    def test_noise_does_not_become_a_model(self):
        with tempfile.TemporaryDirectory() as d:
            rep = train.run(write(d, table(signal=False)), os.path.join(d, "models"))
            f = rep["c1"]["failure"]
            self.assertIn(f["status"], ("below_quality_bar", "insufficient_data"), f)
            self.assertIsNone(Registry(os.path.join(d, "models")).current_version("c1", "failure"), "a weak model is never put in use")

    def test_too_few_breakdowns(self):
        with tempfile.TemporaryDirectory() as d:
            t = table(days=10, machines=("m1",))
            rep = train.run(write(d, t), os.path.join(d, "models"))
            self.assertEqual(rep["c1"]["failure"]["status"], "insufficient_data")
            self.assertIn("needs", rep["c1"]["failure"]["reason"])

    def test_companies_are_trained_separately(self):
        with tempfile.TemporaryDirectory() as d:
            t = table("c1")
            t["rows"] += table("c2", seed=2)["rows"]
            rep = train.run(write(d, t), os.path.join(d, "models"))
            self.assertEqual(sorted(rep), ["c1", "c2"])
            r = Registry(os.path.join(d, "models"))
            self.assertEqual(r.companies(), ["c1", "c2"])
            self.assertNotEqual(r.current_version("c1", "failure"), None)

    def test_training_does_not_use_labels_that_look_into_the_test_period(self):
        names, rows, h = NAMES, table()["rows"], 7
        lab = sorted((r for r in rows if r["label"] is not None), key=lambda r: r["at"])
        cut = train.parse_time(lab[int(len(lab) * 0.7)]["at"])
        gap = [r for r in lab if 0 <= (cut - train.parse_time(r["at"])).total_seconds() <= h * 86400]
        self.assertTrue(gap)
        model, meta = train.train_failure(rows, names, h)
        self.assertLess(meta["trainRows"], len(lab) - meta["testRows"], "the horizon before the hold-out is left out of training")


class ScrapTaskTest(unittest.TestCase):
    def test_scrap_task_trains_and_serves_separately(self):
        with tempfile.TemporaryDirectory() as d:
            t = table()
            t["task"], t["horizonDays"] = "scrap", 4 / 24
            rep = train.run(write(d, t), os.path.join(d, "models"))
            self.assertEqual(rep["c1"]["task"], "scrap")
            self.assertEqual(rep["c1"]["anomaly"], {}, "scrap tables do not train anomaly models")
            reg = Registry(os.path.join(d, "models"))
            if rep["c1"]["failure"]["status"] == "ok":
                self.assertEqual(reg.meta("c1", "scrap")["name"], "scrap-logreg")
                self.assertIsNone(reg.current_version("c1", "failure"))
                out = serve.Scorer(reg).score("c1", "m1", {"a_z": 6, "a_slope": 2}, task="scrap")
                self.assertEqual(out["scrap"]["horizonHours"], 4.0)
                self.assertEqual(serve.Scorer(reg).score("c1", "m1", {}, task="failure"), {"failure": None, "anomaly": None})
            else:
                self.fail(rep["c1"]["failure"])


class AnomalyFallbackTest(unittest.TestCase):
    def test_machine_that_always_fails_still_gets_a_flagged_model(self):
        t = table(days=40, machines=("m1",))
        for r in t["rows"]:
            if r["label"] is not None:
                r["label"] = 1
        out = train.train_anomaly(t["rows"], NAMES)
        self.assertEqual(out["m1"][1]["status"], "ok")
        self.assertTrue(out["m1"][1]["includesPreBreakdown"])


class ServeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        d = cls.tmp.name
        train.run(write(d, table()), os.path.join(d, "models"))
        cls.server = serve.serve(os.path.join(d, "models"), 0, "secret")
        cls.base = f"http://127.0.0.1:{cls.server.server_address[1]}"
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.tmp.cleanup()

    def call(self, path, body=None, key="secret"):
        req = urllib.request.Request(self.base + path, data=None if body is None else json.dumps(body).encode(),
                                     headers={"x-ml-key": key, "content-type": "application/json"})
        try:
            with urllib.request.urlopen(req) as r:
                return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read())

    def test_scores_with_model_version(self):
        status, risky = self.call("/score", {"companyId": "c1", "equipmentId": "m1", "features": {"a_z": 6, "a_slope": 2, "b_z": 0, "down_hours_24h": 0}})
        self.assertEqual(status, 200)
        _, calm = self.call("/score", {"companyId": "c1", "equipmentId": "m1", "features": {"a_z": 0, "a_slope": 0, "b_z": 0, "down_hours_24h": 0}})
        self.assertGreater(risky["failure"]["probability"], calm["failure"]["probability"])
        self.assertGreater(risky["failure"]["probability"], 0.5)
        self.assertTrue(risky["failure"]["model"]["version"])
        self.assertEqual(risky["failure"]["horizonDays"], 7)
        self.assertEqual(risky["anomaly"]["level"], "unusual")
        self.assertEqual(calm["anomaly"]["level"], "normal")

    def test_unknown_company_or_machine_gets_null_not_a_guess(self):
        _, other = self.call("/score", {"companyId": "nobody", "equipmentId": "m1", "features": {}})
        self.assertEqual(other, {"failure": None, "anomaly": None})
        _, nomachine = self.call("/score", {"companyId": "c1", "equipmentId": "zz", "features": {}})
        self.assertIsNone(nomachine["anomaly"])
        self.assertIsNotNone(nomachine["failure"])

    def test_auth_and_validation(self):
        self.assertEqual(self.call("/score", {"companyId": "c1", "equipmentId": "m1", "features": {}}, key="wrong")[0], 401)
        self.assertEqual(self.call("/score", {"companyId": "c1"})[0], 400)
        self.assertEqual(self.call("/score", {"companyId": "../x", "equipmentId": "m1", "features": {}})[0], 400)
        self.assertEqual(self.call("/health", key="")[0], 200)
        self.assertEqual(self.call("/models")[1]["c1"]["failure"]["name"], "failure-logreg")

    def test_rollback_takes_effect_without_restart(self):
        d = self.tmp.name
        reg = Registry(os.path.join(d, "models"))
        first = reg.current_version("c1", "failure")
        model, meta = reg.load("c1", "failure")
        reg.save("c1", "failure", "zz-later", model, {**meta}, make_current=True)
        _, out = self.call("/score", {"companyId": "c1", "equipmentId": "m1", "features": {}})
        self.assertEqual(out["failure"]["model"]["version"], "zz-later")
        reg.set_current("c1", "failure", first)
        _, out = self.call("/score", {"companyId": "c1", "equipmentId": "m1", "features": {}})
        self.assertEqual(out["failure"]["model"]["version"], first)


if __name__ == "__main__":
    unittest.main()
