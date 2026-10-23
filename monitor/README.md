# MouldCare Monitor

Machine and condition monitoring for plastics plants, with machine learning that learns each machine's own normal and an AI assistant that explains what it finds. It is a separate application from the MouldCare maintenance platform in this repository: its own server, database, port and sign-in. It shares the look, the stack and the deployment style.

## What it does

- **Live machine health:** every machine with its state, a health score, its most important finding and a sparkline of the signal that matters most. It refreshes every 30 seconds.
- **Condition monitoring per signal:** hydraulic oil, vibration, barrel and die temperatures, pressures, cooling water, motor current, chiller, dryer and compressor signals, with recommended limits per machine type (vibration per ISO 20816). Charts show the readings, the learned normal band, the limits and the projected trend.
- **Findings, and people's decisions on them:** each finding can be acknowledged, confirmed as real, marked a false alarm (it then stays quiet for 24 hours) or marked fixed. Every decision is kept with the finding and in the audit log.
- **Machine and signal set-up under Settings, for the super user only:** the super user (the administrator role) adds, edits and deletes machines and signals, with their parameters, photos and documents (details below). Everyone else sees each machine's details, photo and documents on its page and can download them.
- **People and ticket allocation:** users and service providers with their skills, also managed by the super user under Settings. Each ticket draft gets an assignee: suggested when drafted, set automatically by the rules or by AI, or chosen while approving, and changeable afterwards (details below).
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

- `admin@monitor.test`: the super user. Everything, including machine and signal set-up, limits and retraining
- `engineer@monitor.test`: acts on findings, drafts, assigns and approves tickets, writes reports, asks the AI. Skills: hydraulic and mechanical, injection and blow moulding
- `tech@monitor.test`: an engineer with electrical, heating and control skills, for allocation
- `viewer@monitor.test`: read only

**What the simulator does:** it fills a week of readings for six machines on first start, then keeps them live. It plants three developing faults for the analysis to find:

- IMM-02: oil cooler fouling, with oil temperature rising about 2.6 °C a day (*degrading*)
- BM-01: pump bearing wear, with vibration stepping up but staying under its limit (*unusual*)
- CH-01: a 90-minute chilled-water excursion over its limit (*limit*)

The three other machines stay healthy.

## Machines and signals

Set-up lives under **Settings**, which only the super user sees. The server refuses set-up changes from any other role. Settings has five tabs:

- **Machines:** every machine with its photo. Open one to edit it, delete it, add its photo and documents, and set up its signals.
- **Signals:** pick a machine, then add, edit or delete its signals.
- **Users** and **Service providers:** see *People and ticket allocation* below.
- **Connections & models:** the AI, gateway and simulator status, and retraining the pattern models.

**Add a machine** (Settings › Machines):

- **Basic data:** tag, name, type, device ID (what the gateway sends), make, model, serial number, year built, line and notes.
- **Parameters for its type:**
  - injection moulding: clamp force, shot volume, screw diameter, drive, motor power, controller
  - extruder: screw diameter, L/D ratio, configuration, output, motor power, controller
  - blow moulding: process, cavities, largest container, clamp force, motor power
  - chiller: cooling capacity, refrigerant, compressor, set point
  - dryer: type, hopper capacity, air flow, throughput
  - compressor: type, free air delivery, maximum pressure, motor power
- **Standard signals:** a new machine gets the standard signals for its type, with recommended limits, unless you untick that.
- **Fixed once added:** the type. The tag and device ID can change but must stay unique.

**Signals** (Settings › Signals, or under the machine in Settings › Machines):

- **Each signal has:**
  - a key (what the gateway sends, fixed once added), name and unit
  - sensor type and make, measuring range
  - source address (PLC tag, OPC UA node ID or MQTT topic)
  - warning and critical limits, and notes
- **Adding:** start from a standard signal or make a custom one. A new signal is accepted from the gateway at once, and the machine's pattern model retrains.

**Photos and documents** (the super user adds and removes them; everyone can view and download):

- **What can be attached:** one photo and any number of documents, for each machine and for each signal (sensor data sheets, calibration certificates).
- **Photos:** JPEG, PNG or WebP, up to 5 MB. A new photo replaces the old one.
- **Documents:** PDF, Word (.docx), Excel (.xlsx), text, CSV or images, up to 15 MB.
- **Checks:** the file type is read from the file's content, not its name. Files are served so they can never run script in the browser.
- **Storage:** files are kept in the database, so a backup of `monitor.sqlite` holds them too.

**Deleting:**

- **A machine:** confirm with its tag. It is removed with all its readings, findings, models, ticket drafts and files.
- **A signal:** it is removed with its readings, findings and files.
- **Audit trail:** every change is recorded.

## People and ticket allocation

**Users** (Settings › Users):

- **Details:** name, email, role, job title, phone, the provider they work for (if any), and their skills.
- **Skills:** disciplines (hydraulic, mechanical, electrical, heating, cooling, pneumatic, control, material) and machine types.
- **Who is offered for tickets:** active engineers, plus anyone with skills recorded.
- **Account actions:**
  - *Password* sets a new password and signs the user out everywhere.
  - *Deactivate* stops sign-in at once and removes the user from allocation; their history stays.
  - *Delete* is only for accounts with no history; the rest are deactivated instead.
- **Protections:** you cannot remove your own super-user access, and at least one active super user always remains.

**Service providers** (Settings › Service providers):

- **Details:** company, contact person, email, phone, skills, contracted response time and notes.
- **Their technicians:** added as users and linked to the provider.
- **Deactivate or delete:** a provider that has been given tickets is deactivated rather than deleted.

**How candidates are ranked.** Every active technician and provider is scored for a ticket:

| Factor | Points |
| --- | --- |
| Has the discipline the fault needs (the draft's failure category) | +40 |
| Knows the machine type | +30 |
| Each open ticket in the last 14 days | −8 |
| No open tickets | +5 |
| Handled findings on this machine in the last 90 days | +5 each, up to 3 |
| An outside provider | −5 |
| A high or critical ticket and a provider that responds within 4 hours | +10 |

Each candidate's reasons are shown with its score.

**When a ticket is allocated:**

- **When drafted:** the mode (Settings › Users › *Ticket allocation*) decides.
  - *Suggest only* (the default): the best candidate is shown on the draft, with its reason and a one-click **Assign**.
  - *Assign automatically by the rules*: the best candidate is assigned at once.
  - *Assign automatically with AI*: Claude chooses among the ranked candidates and gives its reason. Its choice must be one of them; otherwise the rules' first choice is used.
- **During approval:** **Approve…** opens the ranked list with the current assignee or the suggestion preselected. Approving and assigning happen in one step, or the draft can be approved unassigned.
- **After approval:** **Reassign** or unassign at any time. **Ask AI to choose** gets Claude's pick on demand.

**Who can see and change it:**

- **Ticket drafts filters:** *My tasks* shows what is assigned to you; *Unassigned* shows what still needs someone.
- **Assignments:** each assignment records who made it, when, how (manual, rules or AI) and why, and is written to the audit log.
- **Roles:** engineers and the super user assign and approve; viewers only see.

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

Machines, their device IDs and signal limits are set up under **Settings** by the super user.

## Tests

```powershell
cd monitor
npm test
```

There are 30 tests in six files:

- `ml.test.js`: the statistics, steps against trends, limits, both pattern models, and an end-to-end relationship break.
- `api.test.js`: the whole app on a fresh database. It covers sign-in, roles and lockout, finding all three planted faults with nothing on the healthy machines, the intake's validation, false alarms staying quiet, the standard AI fallbacks, limits, and security headers.
- `seed.test.js`: demo machines without demo accounts, and the first admin from the environment.
- `setup.test.js`: adding, editing and deleting machines and signals, covering:
  - the parameter and limit checks, unique tags and device IDs, and who may do what
  - photos and documents checked by their content, served safely, and the photo replaced
  - deleting a machine with everything that belongs to it
- `people.test.js`: users and service providers managed by the super user, and ticket allocation, covering:
  - users: password rules, deactivation and password resets signing users out, the self and last-super-user protections, and delete versus deactivate
  - providers: adding, deactivating and deleting
  - candidates ranked by skills
  - automatic allocation by the rules and by AI (a stand-in client), including an AI answer outside the candidates
  - approval with an assignee, reassignment, and *My tasks*
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
