# MouldCare Monitor

Machine and condition monitoring for plastics plants, with machine learning that learns each machine's own normal and an AI assistant that explains what it finds. It is a separate application from the MouldCare maintenance platform in this repository: its own server, database, port and sign-in. It shares the look, the stack and the deployment style.

## What it does

- **Live machine health:** every machine with its state, a health score, its most important finding and a sparkline of the signal that matters most. It refreshes every 30 seconds.
- **Condition monitoring per signal:** hydraulic oil, vibration, barrel and die temperatures, pressures, cooling water, motor current, chiller, dryer and compressor signals, with recommended limits per machine type (vibration per ISO 20816). Charts show the readings, the learned normal band, the limits and the projected trend.
- **Findings, and people's decisions on them:** each finding can be acknowledged, confirmed as real, marked a false alarm (it then stays quiet for 24 hours) or marked fixed. Every decision is kept with the finding and in the audit log.
- **AI features:** an explanation for each finding, maintenance-ticket drafts, shift and weekly health reports, and a chat about the machines (details below).

## How the machine learning works

The models live in `server/ml/`, need no labelled failures and no Python, and each result carries the numbers behind it.

| Finding | How it is found |
| --- | --- |
| **Limit** | The median of the last 10 minutes is past a warning or critical limit. |
| **Unusual** | The last 12 hours sit 4 or more spreads away from the signal's own normal: the median and MAD of the past week, while the machine was running. A sudden jump is recognised as a *step* rather than a trend. |
| **Degrading** | Hourly medians over 48 hours follow a clear straight line (R² ≥ 0.5) that reaches the critical limit within 7 days. The finding gives the hours left before each limit, and becomes critical when fewer than 48 hours are left. |
| **Pattern** | All of a machine's signals together, in 15-minute windows, scored against two models trained on its own history (7 days back to 1 day ago) and retrained every 6 hours. The **relationship distance** (Mahalanobis) catches signals that normally move together and have stopped doing so. The **extended isolation forest** catches operating states never seen before. A pattern driven mostly by one signal that already has its own finding is reported once, not twice. |

The **health score** starts at 100 and loses points for each open finding: up to 55 for a critical limit breach, 25 to 40 for a degrading trend, and 15 for an unusual signal or pattern. A machine with any open finding is at least *Watch*. A machine with a critical finding, or a score under 50, is *At risk*.

## AI features (Claude)

With `ANTHROPIC_API_KEY` set, the app uses Claude (`claude-opus-5-5` by default) through the Anthropic SDK:

- **Explain:** likely causes ranked by evidence, what to check first, safety notes and how urgent it is. The answer is a structured JSON response grounded in the machine's data and the plant's knowledge base (`server/catalog.js`).
- **Draft ticket:** a maintenance ticket draft with title, symptoms, failure category, priority, actions and parts. A person approves or discards it, then copies it into MouldCare.
- **Reports:** a shift report (last 8 hours) or a weekly report, in Markdown.
- **Ask AI:** a chat that looks data up with tools (`list_machines`, `machine_status`, `signal_history`, `list_findings`) before answering, and shows what it looked at.

Requests use the API's server-side fallback (`fallbacks: "default"`). If a safety classifier declines a request, the API re-runs it on its recommended fallback model.

Without a key, explanations, ticket drafts and reports are built from the knowledge base, so the app is fully usable. Only the chat needs the key.

## Run it locally

```powershell
cd monitor
npm install
$env:MONITOR_SEED_DEMO = 'true'; $env:MONITOR_SIMULATOR = 'true'; $env:MONITOR_INGEST_KEY = 'local-ingest-key'
npm start
```

Open **http://localhost:3300/**. Demo accounts (password `MonitorDemo123!`):

- `admin@monitor.test`: everything, including limits and retraining
- `engineer@monitor.test`: acts on findings, drafts tickets, writes reports, asks the AI
- `viewer@monitor.test`: read only

**What the simulator does:** it fills a week of readings for six machines on first start, then keeps them live. It plants three developing faults for the analysis to find:

- IMM-02: oil cooler fouling, with oil temperature rising about 2.6 °C a day (*degrading*)
- BM-01: pump bearing wear, with vibration stepping up but staying under its limit (*unusual*)
- CH-01: a 90-minute chilled-water excursion over its limit (*limit*)

The three other machines stay healthy.

## Connect real machines

Gateways (a PLC, an OPC UA or MQTT bridge, or an edge PC) post readings with the `X-Ingest-Key` header:

```http
POST /api/ingest
{ "readings": [
  { "device": "plc-imm-02", "at": "2026-10-19T08:15:00Z", "state": "running",
    "values": { "hydraulic_oil_temp": 47.2, "pump_vibration": 2.3 } }
] }
```

How the intake handles a request:

- **Batch size:** up to 2,000 readings per request.
- **Timestamps:** rounded to the minute, and resending the same minute replaces the earlier value.
- **Machine state:** `state` is `running`, `idle`, `down` or `off`. Only running time counts towards a machine's normal.
- **Errors:** each reading comes back accepted or rejected with a reason: an unknown device, a time in the future or more than 30 days old, or a value that is not a number. Unknown signal names are skipped and listed.

Machines and their device IDs are listed under **Settings**, where an administrator also edits the limits.

## Tests

```powershell
cd monitor
npm test
```

There are 20 tests in four files:

- `ml.test.js`: the statistics, steps against trends, limits, both pattern models, and an end-to-end relationship break.
- `api.test.js`: the whole app on a fresh database. It covers sign-in, roles and lockout, finding all three planted faults with nothing on the healthy machines, the intake's validation, false alarms staying quiet, the standard AI fallbacks, limits, and security headers.
- `seed.test.js`: demo machines without demo accounts, and the first admin from the environment.
- `ai.test.js`: Claude requests against a stand-in client. It checks the model, the fallback, the structured output, grounding, caching, the refusal fallback, and the chat's tool loop with thinking blocks passed back unchanged.

## Deploy

`Dockerfile` builds a single container. To run it:

- Mount persistent storage at `/data`, which holds the database.
- Set the variables from `.env.example`.
- Serve it over HTTPS.
- Use `/api/health` as the health check.

`NODE_ENV=production` refuses to start without a 32-character `MONITOR_SECRET`. Run one instance: SQLite and the sign-in lockout live in one process.

**On Render.** The repository's `render.yaml` defines the service `mouldcare-monitor`:
- It is built from this folder, with a 1 GB disk at `/data`, and redeploys only when `monitor/` changes.
- It shows the demo machines with simulated readings but no demo accounts (`MONITOR_DEMO_ACCOUNTS=false`), because their password is published.
- You sign in with `MONITOR_ADMIN_EMAIL` and `MONITOR_ADMIN_PASSWORD`, which Render asks for when it applies the Blueprint.
- To monitor real machines, set `MONITOR_SEED_DEMO` and `MONITOR_SIMULATOR` to `false` on a fresh disk.

## Next steps

- **Ticket hand-off to MouldCare:** MouldCare's integration API takes machine data but cannot create breakdown tickets. An approved draft could be sent straight to MouldCare once it has a ticket intake endpoint for trusted systems.
- **Protocol bridges:** OPC UA and MQTT bridges that post to `/api/ingest`.
- **Scale:** several plants and companies (tenancy), and PostgreSQL for more than one instance.
- **Languages:** German and other languages for the dashboard.
