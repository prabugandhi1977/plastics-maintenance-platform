"""Train per-company models from the table exported by `npm run ml:export`.

  python -m ml_service.train --data ml-features.json --models models

Tables carry a `task`. Per company, each saved as a new version:
  failure  - probability of a breakdown within the horizon (logistic regression, class-balanced). It is only put in
             use if it clears the quality bar on a time-ordered hold-out (the latest part of the data); otherwise
             nothing is saved as current and the report says why.
  scrap    - probability that scrap in the next few hours exceeds 1.5x the machine's normal (same method and quality bar
             as `failure`; trained from `npm run ml:export -- --task scrap`).
  anomaly  - one Isolation Forest per machine on its own healthy history (or all its history if it never has a clean period): how unusual is today's combination of
             signals, even when no single one is far off.
"""
import argparse
import hashlib
import json
import sys
from datetime import datetime, timezone

import numpy as np
from sklearn.ensemble import IsolationForest
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import average_precision_score, roc_auc_score
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

from .registry import Registry

MIN_POSITIVES = 10        # rows before a breakdown needed before a failure model is trusted at all
MIN_TEST_POSITIVES = 3    # ... and in the hold-out, or the score means nothing
MIN_AUC = 0.70
MIN_ANOMALY_ROWS = 100
TEST_SHARE = 0.3


def parse_time(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def load_table(path):
    with open(path, encoding="utf-8") as f:
        t = json.load(f)
    return t["featureNames"], t["rows"], t.get("horizonDays", 7), t.get("task", "failure")


def matrix(rows, names):
    return np.array([[float(r["features"].get(n, 0.0)) for n in names] for r in rows], dtype=float)


def version_for(rows):
    digest = hashlib.sha256(json.dumps([(r["equipmentId"], r["at"], r["label"]) for r in rows]).encode()).hexdigest()[:8]
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + digest


# The simple signal a model must beat to be worth having: how unusual things already look right now.
BASELINE_FEATURE = {"failure-logreg": "max_abs_z", "scrap-logreg": "scrap_z"}

MODEL_NAMES = {"failure": "failure-logreg", "scrap": "scrap-logreg"}


def train_failure(rows, names, horizon, name="failure-logreg"):
    """Returns (model or None, meta). A model is returned only when it is good enough to use."""
    lab = sorted((r for r in rows if r["label"] is not None), key=lambda r: r["at"])
    pos = int(sum(r["label"] for r in lab))
    meta = {"name": name, "horizonDays": horizon, "featureNames": names, "rows": len(lab), "positives": pos}
    if pos < MIN_POSITIVES or len(lab) - pos < MIN_POSITIVES:
        return None, {**meta, "status": "insufficient_data",
                      "reason": f"needs at least {MIN_POSITIVES} rows before a breakdown and {MIN_POSITIVES} without; has {pos} and {len(lab) - pos}"}
    # Time-ordered split with a gap of one horizon, so no training label looks into the test period.
    cut_time = lab[int(len(lab) * (1 - TEST_SHARE))]["at"]
    cut = parse_time(cut_time)
    train = [r for r in lab if (cut - parse_time(r["at"])).total_seconds() > horizon * 86400]
    test = [r for r in lab if r["at"] >= cut_time]
    ytr, yte = np.array([r["label"] for r in train]), np.array([r["label"] for r in test])
    if len(set(ytr.tolist())) < 2 or yte.sum() < MIN_TEST_POSITIVES or yte.sum() == len(yte):
        return None, {**meta, "status": "insufficient_data",
                      "reason": "the hold-out period has too few breakdowns (or only breakdowns) to measure quality"}
    model = make_pipeline(StandardScaler(), LogisticRegression(class_weight="balanced", max_iter=1000, C=0.5))
    model.fit(matrix(train, names), ytr)
    p = model.predict_proba(matrix(test, names))[:, 1]
    auc, ap = float(roc_auc_score(yte, p)), float(average_precision_score(yte, p))
    meta.update(trainRows=len(train), testRows=len(test), testPositives=int(yte.sum()), auc=round(auc, 3),
                averagePrecision=round(ap, 3), baseRate=round(float(yte.mean()), 3))
    base = BASELINE_FEATURE.get(name)
    if base in names:
        col = names.index(base)
        meta.update(baselineFeature=base, baselineAuc=round(float(roc_auc_score(yte, np.abs(matrix(test, names)[:, col]))), 3))
    if auc < MIN_AUC:
        return None, {**meta, "status": "below_quality_bar", "reason": f"hold-out AUC {auc:.2f} is below {MIN_AUC}"}
    # Refit on everything now that quality is known, so the deployed model has seen the latest data.
    model.fit(matrix(lab, names), np.array([r["label"] for r in lab]))
    return model, {**meta, "status": "ok"}


def train_anomaly(rows, names):
    """One Isolation Forest per machine, fitted on its healthy behaviour."""
    out = {}
    for eq in sorted({r["equipmentId"] for r in rows}):
        mine = [r for r in rows if r["equipmentId"] == eq]
        healthy = [r for r in mine if r["label"] != 1]
        mixed = False
        if len(healthy) < MIN_ANOMALY_ROWS:
            # A machine that is always about to break down has no clean history: learn its typical pattern from
            # everything, and say so (an Isolation Forest tolerates some contamination).
            healthy, mixed = mine, True
        if len(healthy) < MIN_ANOMALY_ROWS:
            out[eq] = (None, {"name": "anomaly-isolation-forest", "status": "insufficient_data", "rows": len(healthy),
                              "reason": f"needs {MIN_ANOMALY_ROWS} healthy rows"})
            continue
        X = matrix(healthy, names)
        model = IsolationForest(n_estimators=200, contamination="auto", random_state=0).fit(X)
        scores = -model.score_samples(X)  # higher = more unusual
        out[eq] = (model, {"name": "anomaly-isolation-forest", "status": "ok", "featureNames": names, "rows": len(healthy),
                           "p99": float(np.percentile(scores, 99)), "median": float(np.median(scores)), "equipmentId": eq,
                           "includesPreBreakdown": mixed})
    return out


def run(data, models_dir, only_company=None):
    names, rows, horizon, task = load_table(data)
    reg, report = Registry(models_dir), {}
    for company in sorted({r["companyId"] for r in rows}):
        if only_company and company != only_company:
            continue
        mine = [r for r in rows if r["companyId"] == company]
        version = version_for(mine)
        trained_at = datetime.now(timezone.utc).isoformat()
        model, meta = train_failure(mine, names, horizon, MODEL_NAMES[task])
        meta["trainedAt"] = trained_at
        if model is not None:
            reg.save(company, task, version, model, meta)
        report[company] = {"version": version, "task": task, "failure": meta, "anomaly": {}}
        for eq, (am, ameta) in (train_anomaly(mine, names).items() if task == "failure" else []):
            ameta["trainedAt"] = trained_at
            if am is not None:
                reg.save(company, f"anomaly-{eq}", version, am, ameta)
            report[company]["anomaly"][eq] = ameta
    return report


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", required=True, help="feature table from `npm run ml:export`")
    ap.add_argument("--models", default="models", help="model registry directory")
    ap.add_argument("--company", help="train only this company")
    a = ap.parse_args(argv)
    report = run(a.data, a.models, a.company)
    for company, r in report.items():
        f = r["failure"]
        detail = f"AUC {f['auc']} (just using {f.get('baselineFeature')}: {f.get('baselineAuc')}), {f['positives']} positive rows" if f["status"] == "ok" else f.get("reason", "")
        print(f"{company}: {r['task']} model {f['status']} - {detail}")
        for eq, m in r["anomaly"].items():
            print(f"  {eq}: anomaly model {m['status']}" + (f" - {m['reason']}" if m.get("reason") else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
