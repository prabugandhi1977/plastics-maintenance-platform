# MouldCare Monitor

Machine and condition monitoring for plastics plants, with machine learning that learns each machine's own normal and an AI assistant that explains what it finds. It is a separate application from the MouldCare maintenance platform in this repository: its own server, database, port and sign-in. It shares the look, the stack and the deployment style.

## What it does

- **Live machine health:** every machine with its state, a health score, its most important finding and a sparkline of the signal that matters most. It refreshes every 30 seconds.
- **Condition monitoring per signal:** hydraulic oil, vibration, barrel and die temperatures, pressures, cooling water, motor current, chiller, dryer and compressor signals, with recommended limits per machine type (vibration per ISO 20816). Charts show the readings, the learned normal band, the limits and the projected trend.
- **Findings, and people's decisions on them:** each finding can be acknowledged, confirmed as real, marked a false alarm (it then stays quiet for 24 hours) or marked fixed. Every decision is kept with the finding and in the audit log.
- **Machine and signal set-up under Settings, for the super user only:** the super user (the administrator role) adds, edits and deletes machines and signals, with their parameters, photos and documents (details below). Everyone else sees each machine's details, photo and documents on its page and can download them.
- **People and ticket allocation:** users and service providers with their skills, also managed by the super user under Settings. Each ticket draft gets an assignee: suggested when drafted, set automatically by the rules or by AI, or chosen while approving, and changeable afterwards (details below).
- **Hand-off to MouldCare:** an approved draft is sent to MouldCare as a breakdown ticket, with its reference shown on the draft. If MouldCare is down, the draft says so and is sent again later (details below).
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
- **Ask AI:** a chat that looks data up with tools (`list_machines`, `machine_status`, `signal_history`, `list_findings`, `search_manuals`) before answering, and shows what it looked at.

### AI that reads your manuals

The AI reads the documents the super user uploads for each machine and signal: manuals, data sheets and calibration certificates.

- **Reading the text:** after each upload, the server reads the text in the background (`server/manuals.js`). PDFs are read page by page with `unpdf`. Word (.docx) and Excel (.xlsx) files are unzipped with `fflate` and their XML read. Text and CSV files are read as they are. The upload never waits for this and never fails because of it.
- **State beside each document:** *Text read* (with the number of passages), *Reading text…*, *No text to read*, or *Text not read* with the reason.
- **No OCR:** images and scanned PDFs without a text layer have no text to read. They show *No text to read* and say why.
- **The index:** the text is split into passages of about 200 to 300 words, each with its page, and kept in a SQLite FTS5 table (migration `005_document_index.sql`). Deleting a file, its signal or its machine removes its passages too. Documents uploaded before this feature are read once at start-up.
- **Finding the right passages:** a search for one machine ranks passages by BM25. For a finding, the query is built from the signal's name, which way it moved, the kind of finding and the machine type. The machine's own documents and its signals' documents come first, with the finding's own signal counted a little higher. Documents of other machines of the same type fill any places left, marked with their tag.
- **Explain and Draft ticket:** the top passages go into the prompt. The answer lists the passages it used, and the app shows them as sources (document and page) under the explanation and on the ticket draft. Each source downloads the document.
- **Chat:** the tool `search_manuals(machine_tag, query)` returns passages with their document and page.
- **Ask the manuals:** each machine's page has a small box that answers a question from that machine's documents only, with the pages it used. Everyone signed in can use it. Without an API key it shows the matching passages instead.
- **Manual text is data:** passages are quoted as reference data, never as instructions. The system prompt says so, and a passage cannot close its own quote. The answer cites passages by number, so it can only cite passages it was given.
- **Without a key:** the standard explanation stays as it was, with no sources.

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
- **Connections & models:** the AI, gateway, MQTT and simulator status, and retraining the pattern models.

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
- **Documents:** PDF, Word (.docx), Excel (.xlsx), text, CSV or images, up to 15 MB. The AI reads their text (see *AI that reads your manuals*).
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

## Hand-off to MouldCare

An approved draft goes to MouldCare as a breakdown ticket, by itself.

**Set it up.**
1. In MouldCare, make a company integration key: `npm run integration:key -- "Your company" "MouldCare Monitor"` on the MouldCare server, or `POST /api/integration-keys` as the customer admin. It is shown once.
2. Here, set `MONITOR_MOULDCARE_URL` (MouldCare's address, e.g. `https://mouldcare.example.com`) and `MONITOR_MOULDCARE_KEY` (the key). Restart.
3. **Settings › Connections & models** shows whether it is on, how many tickets were sent, and the last error. The key is never shown, returned by the API or logged.

**What is sent.** The machine tag (it must match the asset tag in MouldCare), title, symptoms, failure category, priority, machine state, suggested actions and parts to check, the assignee's name if any, when the finding started, and the draft id as the reference.
- Failure categories keep their names, except *control*, which is *controls* in MouldCare.
- Machine states: *running* stays *running*, *running degraded* becomes *reduced output*, *stopped* stays *stopped*.
- Monitor does not judge safety, so `safetyIssue` is sent as `false`. Whoever handles the ticket in MouldCare can change that.
- The assignee is a person in Monitor, not a MouldCare user. MouldCare notes the name on the ticket, and dispatch assigns it there.

**When it is sent.**
- On approval. The approval never fails because of MouldCare: the outcome is kept on the draft.
- **Send to MouldCare** on an approved draft that has not gone yet (e.g. one approved before the connection was set up).
- **Retry** on a draft that failed. A background job also retries failed drafts every 5 minutes, up to 10 times, and sends drafts approved while the connection was not set up.
- Each send waits at most 10 seconds for MouldCare.
- Sending a draft twice is safe: MouldCare finds the ticket already raised by the draft id.

**On the draft card.** *In MouldCare* with the ticket reference (the first 8 characters of its id) and when it was sent; *Not sent* with MouldCare's reason and a **Retry** button; or *Not set up*.

## Connect real machines

Gateways (a PLC, an OPC UA bridge, or an edge PC) post readings with the `X-Ingest-Key` header:

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

## Connect over MQTT

Many plants and low-cost IIoT gateways publish to an MQTT broker. Monitor can subscribe to it. The readings go through the same checks as `POST /api/ingest`.

Set these on the server:

- `MONITOR_MQTT_URL`: the broker, as `mqtt://`, `mqtts://`, `ws://` or `wss://`. MQTT stays off while this is empty.
- `MONITOR_MQTT_USERNAME` and `MONITOR_MQTT_PASSWORD`: if the broker needs them. The password is never logged or shown.
- `MONITOR_MQTT_TOPIC`: the topic filter. The default is `mouldcare/#`.
- `MONITOR_MQTT_CLIENT_ID`: optional. With a fixed client ID the broker keeps the session, and holds QoS 1 messages while Monitor restarts.

Monitor understands two payload formats.

**1. JSON on any topic.** One reading, in the same shape as the HTTP intake, or several in `readings`. Without `at`, the time of receipt is used.

```text
topic:   mouldcare/hall-a/gateway-1
payload: { "device": "plc-imm-02", "at": "2026-10-19T08:15:00Z", "state": "running",
           "values": { "hydraulic_oil_temp": 47.2, "pump_vibration": 2.3 } }

payload: { "readings": [ { "device": "plc-imm-01", "values": { "hydraulic_oil_temp": 45.0 } },
                         { "device": "plc-ch-01", "values": { "supply_temp": 12.4 } } ] }
```

**2. One value per topic.** The last two topic levels are the device ID and the signal key. The payload is a plain number. A topic ending in `state` takes `running`, `idle`, `down` or `off`. The time of receipt is used.

```text
mouldcare/plc-imm-02/hydraulic_oil_temp   47.2
mouldcare/plc-imm-02/pump_vibration       2.3
mouldcare/plc-imm-02/state                running
```

How the MQTT intake works:

- **Batches:** messages are collected and stored every second, or as soon as 500 are waiting.
- **Rejections:** unknown devices, values that are not numbers, and broken JSON are rejected and counted, as on the HTTP intake.
- **Reconnects:** if the broker goes away, Monitor reconnects on its own. It waits a little longer after each failed try, up to a minute.
- **Status:** **Settings › Connections & models** shows whether Monitor is connected, the last message, how many readings were accepted and rejected, and the reasons for the last rejections.

## Tests

```powershell
cd monitor
npm test
```

There are 45 tests in nine files:

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
- `mouldcare.test.js`: the hand-off to MouldCare against a stand-in MouldCare server, covering:
  - approval posting the draft with the mapped fields and the assignee, and no second post once sent
  - a failed send recorded with the reason while the approval stands (MouldCare down, a rejected ticket, a wrong key, no answer within the timeout), then sent by the retry job, and the automatic retry limit
  - an unset connection recorded as `not_configured`, then sent once it is set up
  - the key never in an API reply or the database
- `mqtt.test.js`: a real MQTT broker inside the test. It publishes both payload formats and checks that readings and states are stored through the normal intake. It also covers rejected messages and their reasons, batching, the status in Settings without the password, and a reconnect after the broker drops the connection.
- `ai.test.js`: Claude requests against a stand-in client. It checks the model, the fallback, the structured output, grounding, caching, the refusal fallback, and the chat's tool loop with thinking blocks passed back unchanged.
- `manuals.test.js`: the AI reading the documents, with a stand-in client, covering:
  - text from a PDF made in the test (page by page), Word, Excel, text and CSV, and passages of a few hundred words
  - indexing after the upload, and removal with the file, its signal or its machine
  - *No text to read* for an image and a scanned PDF, a damaged PDF failing with a reason, and start-up indexing
  - BM25 ranking for a finding
  - passages quoted as data in the explanation and ticket prompts, and the cited sources in the output
  - the chat's `search_manuals` tool, and *Ask the manuals* with and without the AI

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

- **Protocol bridges:** an OPC UA bridge that posts to `/api/ingest`. MQTT is built in.
- **Scale:** several plants and companies (tenancy), and PostgreSQL for more than one instance.
- **Languages:** German and other languages for the dashboard.
