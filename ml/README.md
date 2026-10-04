# ML service: trained models for breakdown risk and unusual patterns

The platform already learns each signal's normal range with plain statistics (`backend/services/ml/`). This service adds **trained models** on top, using scikit-learn. It is optional: when `ML_SERVICE_URL` is not set, or the service is down, the platform carries on without it.

| Model | Question it answers | Trained on | Used when |
| --- | --- | --- | --- |
| `failure-logreg` | How likely is a breakdown in the next 7 days? | Per company: feature rows labelled by whether a breakdown (breakdown, mould fault, auxiliary fault) followed within 7 days | Only if it scores AUC ≥ 0.70 on a hold-out of the latest 30 % of the data, with at least 3 breakdowns in it |
| `scrap-logreg` | Will scrap in the next 4 hours exceed 1.5x this machine's normal? | Per company: running machines, labelled by the scrap that followed (`--task scrap`) | Same quality bar as above. The report also shows the AUC of the simple "how unusual is it already" signal, which the model must beat to add value |
| `anomaly-isolation-forest` | Is today's *combination* of signals unusual, even if no single one is far off? | Per machine: its own healthy history | At least 100 healthy rows |

A model that is not good enough is **not put in use**; the training report says why (for example "needs at least 10 rows before a breakdown"). Real breakdown history is the limit: the simulator breaks machines down about daily, so every row is "a breakdown follows within 7 days" and the failure model correctly refuses to train; the anomaly models do train. The simulator also makes a machine with a failing part scrap more as the part drifts (so the scrap model has something real to find): on that data the scrap model reached hold-out AUC 0.98 against 0.89 for the simple signal. That gain comes from the simulator's own rule, so it shows the pipeline works, not how well it will do on your plant. Verified end to end that way (export, train, serve, score through the platform).

## Setup (Python 3.10+)

```powershell
cd ml
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt
.venv\Scripts\python -m unittest discover -s tests      # synthetic-data tests, no platform needed
```

### Or in Docker (no Python on the PC; also the way around Windows application-control policies that block scikit-learn's DLLs)

```powershell
cd ml
docker run --rm -v "${PWD}:/work" -w /work python:3.12-slim sh -c "pip install -q -r requirements.txt && python -m unittest discover -s tests"
```

Use the same pattern for the train command below. To serve, run it detached with `-p 3200:3200 -e ML_SERVICE_KEY=... ` and `--host 0.0.0.0`.

## Train, serve, connect

```powershell
# 1. Export the feature table from the platform database (from the repository root; add FACTORY_BACKFILL_DAYS=60 to the
#    simulator on a fresh database for a longer demo history)
npm run ml:export -- --out ml/ml-features.json --days 60

# 1b. The scrap table (separate model)
npm run ml:export -- --task scrap --out ml/ml-scrap.json --days 60

# 2. Train (writes ml/models/<company>/<kind>/<version>/)
cd ml; .venv\Scripts\python -m ml_service.train --data ml-features.json --models models

# 3. Serve scores (set ML_SERVICE_KEY; required when not listening on 127.0.0.1)
$env:ML_SERVICE_KEY='a-long-random-key'; .venv\Scripts\python -m ml_service.serve --models models --port 3200

# 4. Point the platform at it, then restart it
$env:ML_SERVICE_URL='http://127.0.0.1:3200'; $env:ML_SERVICE_KEY='a-long-random-key'
```

The Condition page then shows **Breakdown risk (next 7 days)** and **Overall pattern** per machine; hover for the model name, version and hold-out quality.

## Design

- **One feature definition.** `backend/services/ml/features.js` builds the features (how far each signal is from its learned normal, its trend, recent stops) for both export and live scoring. This service only reads feature *names* from the model, so the two sides cannot drift apart.
- **Per company.** Models never mix customers' data.
- **Versioned and reversible.** Every training run saves a new version; nothing is overwritten. Roll back by calling `Registry.set_current(company, kind, version)`; the service picks it up without a restart.
- **Retrain regularly** (for example weekly, with the same three commands). Compare AUC between versions before relying on a new one.
- **Not for safety decisions.** A prediction is a prompt to inspect, not an instruction to stop a machine.
