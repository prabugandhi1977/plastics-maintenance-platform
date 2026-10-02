# MouldCare MVP — Plastics maintenance platform

> This folder is a standalone copy of the complete development, kept separate from `Project 1/mouldcare`, which is under development with Codex. It has its own database (`data/` in this folder) and runs on port **3100** by default, so both can run side by side.

MouldCare is a local, working demo of a multi-tenant maintenance platform for plastics processing equipment: injection moulding, blow moulding, extrusion, moulds, and auxiliary equipment. It has:

- one shared API
- a desktop web workspace for customers, dispatch, providers and admins
- an installable mobile field app for engineers that works offline

## Stack and rationale

- **Node.js 22.13+ HTTP API with no dependencies.** One runtime and one API serve both clients. Feature areas are separate route modules in `api/routes/`, and machine-data sources plug in through `api/iot/adapters/`.
- **SQLite for the local MVP.** It gives transactional migrations, foreign keys and a portable demo database. Node's built-in SQLite module is experimental in Node 22, so move to PostgreSQL before production; see [docs/ROADMAP.md](docs/ROADMAP.md).
- **Web app and installable mobile web app (PWA).** The field app caches its own code, assigned work and opened tickets on the device. It queues changes in IndexedDB, shows them straight away, and syncs them safely when the connection returns. A native app (Expo) can use the same API later if device features require it.

Security notes for the clients:

- The web app keeps its sign-in token only in memory.
- The field app keeps its token in session storage. Cached work and queued actions stay on the device until they are synced or the user signs out.
- Use managed devices and HTTPS for field rollout.

## Run the local demo

From this directory in PowerShell:

```powershell
node --version                 # 22.13 or newer
npm run seed
npm run iot:sync                # pull 6 h of mock machine data
$env:MOULDCARE_SECRET = 'replace-with-a-long-random-local-secret-32-chars-minimum'
$env:MOULDCARE_INTEGRATION_KEY = 'replace-with-a-separate-local-ingestion-key'
$env:IOT_SYNC_INTERVAL_SECONDS = '60'   # optional: keep polling the mock adapter
npm start
```

Open **http://localhost:3100/** for the web workspace and **http://localhost:3100/mobile/** for the field app. `localhost` works for desktop testing; to install the field app on a phone, serve it over HTTPS.

The database and uploads are stored under `data/`, which Git ignores. Both `npm run seed` and `npm run iot:sync` are safe to repeat: the seed skips data that already exists, and sync carries on from where it stopped without duplicating readings. Database migrations in `api/migrations/` run automatically, each in its own transaction, so an existing demo database upgrades in place. The richer demo history is only added to a new database: to start fresh, stop the server, delete `data/`, and run the two commands above again.

Demo password for all accounts: `DemoPass123!`.

| Role | Email | Notes |
| --- | --- | --- |
| Platform admin | `admin@demo.test` | |
| Dispatcher | `dispatch@demo.test` | |
| In-house engineer | `engineer@demo.test` | US Midwest, injection and moulds |
| Acme customer admin | `acme@demo.test` | Chicago, USD, English |
| Acme maintenance | `maint@demo.test` | |
| Nova customer admin | `nova@demo.test` | Cologne, EUR, **German UI** |
| Atlas provider admin | `atlas-admin@demo.test` | Manages Atlas engineers |
| Atlas provider engineer | `atlas@demo.test` | US Midwest, injection and moulds |
| EuroTech provider engineer | `euro@demo.test` | Northwest Germany, extrusion and blow moulding |

The seed sets up two customers and two approved providers:

- **Acme** has an injection moulding machine and a mould in Chicago, an annual contract with an 8-hour response target, an earlier completed repeat of the same hydraulic fault, and a quoted spare part.
- **Nova** has an extrusion line in Cologne and a contract due for renewal within 90 days.

## Smart factory

The platform now monitors production as well as maintaining machines, under the **Smart factory** menu:

- **Live floor:** every machine's state and this shift's OEE. It refreshes every 30 seconds.
- **OEE:** results by period, plant and machine, with a chart of where time was lost and a short guide to the calculation.
- **Alerts:** problems machines report. You can acknowledge them, resolve them, or turn them into a pre-filled maintenance ticket. A bell at the top of every page shows the open alerts.
- **Products:** ideal cycle times and cavities, so performance can be measured.
- **Condition:** each machine's health from sensor readings against warning and critical limits, with trend charts and a limits editor. A critical reading raises a maintenance ticket automatically.
- **Energy:** kWh, kWh per kg, wasted energy, CO₂ (supplier factor or national average) and cost (set the electricity price under *Organisation*).
- **Quality:** camera inspection results. Shows first-pass yield, rejects per million (PPM) and a defect Pareto by machine. A rising reject rate raises an alert.
- **Traceability:** material lots → batches → output. Each batch records its lots, machine, mould, operator and process settings. A batch's *genealogy* also shows the stops, alerts, maintenance and camera rejects on its machine while it ran. Quarantining a lot puts exactly the batches that used it on hold.
- **Safety:** events detected by cameras, wearables and sensors, and reported by people (also from the mobile app, offline). Each event is investigated and closed with a root cause and a corrective action. The page shows days without a lost-time injury and the near-miss count.
- **Asset tracking:** moulds, tools, gauges and trolleys located by zone from BLE beacons or RFID tags. Alerts for a guarded asset in a restricted or outside zone, a tag not heard for too long, and a low tag battery. Each asset has a 48-hour location history.
- **Shifts:** set under *Organisation → Plants → Shifts*.

Until real machines are connected, set `FACTORY_SIMULATOR=true` (local demos only) for realistic machine data. It covers camera results, safety-camera detections and tag sightings too. Real PLC, camera, wearable and BLE/RFID gateways send the same data to `POST /api/integrations/factory/events`; see *Smart factory* in `API.md`.

An existing demo database gets the stage 3–4 demo data (zones, tagged assets, lots, batches, safety history) the next time `node api/seed.js` runs. A database without the stage 1 demo products is left unchanged.

## Demo path

Every record has mandatory, industry-standard data (see *Mandatory master data* in `API.md`). Forms mark required fields with *, show units, and explain what is missing before anything is sent. Older records missing mandatory data are flagged **Incomplete** rather than rejected.

1. **Raise a ticket.** Sign in as Acme. The overview shows repeat faults, downtime and response targets. Inspect equipment and its QR label, then raise a breakdown ticket.
2. **Assign it.** Sign in as the dispatcher and open the ticket. It shows contract coverage and the response deadline. Choose **Assign**: the form lists eligible engineers and providers, and explains why EuroTech is not eligible.
3. **Do the job on the phone.** Open `/mobile/` as Atlas or the engineer and accept the job; the standard injection moulding checklist appears. Tap items to tick them, log work, and attach a photo.
   - Switch the browser offline in DevTools and keep working. Changes show immediately with a "queued" count, and sync when you go back online.
   - Complete the job, then use **Customer sign-off** to capture the customer's signature on the screen.
4. **Spare parts.** As Acme, request a part. As the dispatcher, quote it in euros or dollars. Acme approves or rejects it. The dispatcher then marks it ordered, shipped and fulfilled, with PO and tracking references.
5. **Contracts.** Add a visit in plant-local time, or change the renewal date and response target.
6. **Language and time zones.** Sign in as Nova to see the German interface and times in Cologne time (MESZ). Switch language from the sidebar; the choice is saved per user.
7. **Isolation.** Sign in as Nova or EuroTech to confirm they cannot see Acme's records.
8. **Users.** As Acme, deactivate and reactivate Lee Maintenance on the **Organisation** page. A deactivated user is signed out on their next request.
9. **Machine data.** As admin, open **Equipment → Coperion ZSK 58**. Its data is stale, with a critical alarm. Then open **IoT integration** for sync runs and the quarantined records.

## Deploy

The platform ships as a single Docker container: the API, the web workspace and the field app together. The database and uploads live on the `/data` volume.

```powershell
cd "Project 1\Plastics maintenance platform"
copy .env.example .env      # then fill in the secrets, and the first admin's email and password
docker compose up -d --build
docker compose ps           # wait for "healthy", then open http://localhost:3100/
```

What happens on start, and how to configure it:

- **Migrations** run automatically on every start.
- **First admin:** `MOULDCARE_ADMIN_EMAIL` and `MOULDCARE_ADMIN_PASSWORD` create the first platform admin. That admin then creates customer companies, providers and users.
- **Demo data:** `MOULDCARE_SEED_DEMO=true` loads the demo accounts. Use it only on a private machine, because every demo account shares the password `DemoPass123!`.
- **Secret:** the container runs with `NODE_ENV=production`, so it refuses to start without a `MOULDCARE_SECRET` of at least 32 characters.
- **Data:** stays in the `platform-data` volume across restarts and rebuilds. Back the volume up regularly.

**To put it online, follow [docs/DEPLOY-RENDER.md](docs/DEPLOY-RENDER.md).** It walks through Render step by step, using the ready-made `render.yaml` in this repository.

**Any cloud host that runs a Docker image works**, such as Azure Container Apps, AWS, Render, Railway or Fly.io. Build from this folder's `Dockerfile` and:

- mount persistent storage at `/data`
- set the environment variables from `.env.example` as the host's secrets
- serve over HTTPS
- use `/api/health` as the health check

Run a single instance: SQLite and the sign-in lockout counter are per instance. Scaling out needs the PostgreSQL step in `docs/ROADMAP.md`.

Behind a hosting proxy, the sign-in lockout effectively applies per email address, because every request arrives from the proxy's address.

## Tests

```powershell
npm test
```

There are 47 tests in seven files. Each file uses its own temporary database and tests with two customers and two providers. Shared, complete request bodies live in `api/tests/fixtures.js`.

**`workflows.test.js`**
- isolation between customers and between providers
- assignment checks on service area and skills
- references to another company's records are rejected
- who can complete visits
- offline actions replayed without duplication
- completing work, sign-off, quote approval, and protected file downloads

**`iot.test.js`**
- the standard record format and its validation
- mock sync, quarantine of bad records, and replay without duplicates
- freshness per asset and per metric
- batch uploads, quality flags, and alarm raise and clear
- device-mapping permissions, and telemetry isolation between tenants and providers
- plant-local visit times, quote replacement, and upload file-type checks

**`condition-energy.test.js`**
- how readings are judged against limits
- the limits editor's rules and permissions
- the full chain: warning → critical → exactly one automatic ticket → alert closes itself
- stale data, trends and tenant isolation
- energy figures against a worked example (0.42 kWh/kg, CO₂, cost)
- simulated signals

**`trace-safety-assets.test.js`**
- lots and batches limited to each tenant; a batch needs its mould (injection), released lots and every process setting
- quarantining a lot holds exactly the batches that used it and blocks their release; genealogy and search
- vision intake validation, reject-rate alerts (warning → critical → clears), FPY, PPM and Pareto
- safety events: who may report, device detections stored once, investigate and close, days since lost-time injury
- asset sightings, zone/missing/battery alerts, out-of-order sightings, history, zones and assets
- simulator: camera rejects equal counted scrap; safety detections; tag sightings
- offline safety reports from the field app stored once on replay

**`factory.test.js`**
- shift calendar and custom shifts
- the OEE arithmetic against a hand-worked example (75.5%)
- factory data limited to each tenant and closed to providers
- product ideal rates
- the machine-data intake path
- alerts: one per fault, auto-resolve, acknowledge, raise a ticket, email outbox
- the deterministic simulator

**`masterdata.test.js`**
- the catalogue and every mandatory parameter set, including machine-type parameters, value ranges and duplicate asset tags
- ISO 14224 breakdown reporting and close-out; safety issues forced to critical; automatic downtime
- contract, spare-part, quote-validity and purchase-order rules
- service areas, field-engineer contacts, and provider approval needing valid insurance
- default response targets, editable standard checklists, and the MTTR/MTBF/availability KPIs

**`platform.test.js`**
- login lockout and security headers
- user deactivation, password change, and language preference
- equipment edits staying within the owning company
- assignment candidates with reasons, and provider decline (including offline replay)
- standard checklists applied on acceptance, and ticking items offline
- note required for escalation
- on-site signature sign-off and who can download the signature file
- contract coverage and response-target breaches
- adding visits and renewals within the contract period
- parts fulfilment stages
- dashboard figures limited to each tenant's own data

## Structure

```text
api/server.js        HTTP entry: static files with security headers, router, offline replay, IoT poller
api/http.js          Router, JSON replies, body parsing
api/access.js        Tenant-scoped lookups and permission helpers shared by all routes
api/catalog.js       Master-data catalogue: mandatory parameter sets and ISO 14224 code lists
api/factory/         Smart factory: shifts, OEE, alerts and email, condition, energy, quality, traceability, safety, asset tracking, simulator
api/routes/          auth, org, equipment, iot, contracts, tickets, parts, dashboard, settings, factory, factory-ops
api/files.js         Private file storage with file-type checks
api/security.js      Passwords, signed access tokens, role checks
api/validate.js      Input validation, time-zone conversion
api/iot/             Standard record format, ingest/freshness, sync runner, adapters (mock)
api/migrations/      Versioned SQL migrations (001 base … 008 traceability, quality, safety, assets)
api/tests/           API workflow, IoT and platform tests
web/                 Desktop web workspace
web/mobile/          Installable field app with offline queue and signature capture
web/ops.js           Smart factory pages: traceability, quality, safety, asset tracking
web/ui.js            Shared UI: filterable tables, catalogue-driven forms, dialogs, confirmations, toasts
web/charts.js        Dashboard charts and KPI tiles (data-visualisation method: validated colour, table view, tooltips)
web/shared/          Translations and formatting, signature pad (used by both clients)
API.md               Endpoints, workflow rules, IoT interface
docs/ROADMAP.md      Production hardening and later phases (IoT alerts, video, AI, predictive, AR)
```

## Globalisation

- **Times:** stored in UTC. Ticket, visit and telemetry times are shown in the plant's local time, with the zone name.
- **Plant-local input:** visit times entered without a time zone are read as plant-local time.
- **Money:** amounts are stored in minor units and shown in each currency's own format. Quotes are entered in major units.
- **Units:** temperatures follow the company's metric or imperial setting.
- **Languages:** English and German so far. The German translation is a first draft, to be reviewed by a native speaker. Adding a language means adding a catalogue in `web/shared/i18n.js`.

## Before live customers

This is a local MVP, not a hosted production release. [docs/ROADMAP.md](docs/ROADMAP.md) lists the production-hardening work:

- PostgreSQL with row-level security
- a managed identity provider, with token revocation
- object storage for files, with malware scanning
- HTTPS and rate limits
- backups
- secured field devices
- penetration testing

The API never exposes integration keys to either client. `MOULDCARE_SECRET` is mandatory and checked for length when `NODE_ENV=production`.

## Integration information needed next

The mock adapter and the integration interface are ready; see *IoT integration interface* in `API.md`. To connect live machine data, please provide:

- the API documentation
- sample reading and alarm payloads
- the authentication method
- rate limits and paging
- the device ID format
- units
- how timestamps and time zones are sent
- whether counters can reset

No live connection has been attempted.
