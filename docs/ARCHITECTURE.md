# Architecture

One Node.js process serves the desktop web workspace, the offline field app and a JSON API. Records live in PostgreSQL; uploaded files live on one persistent volume (`/data`). Machines, cameras, the optional ML service and the AI assistant connect at the edges. The machine-monitoring app in `monitor/` is a separate application with its own server and database (see [its README](../monitor/README.md)).

| | |
| --- | --- |
| Runtime | Node.js 22.13+, built-in `node:http` (no web framework) |
| Dependencies | Two npm packages: `@anthropic-ai/sdk` and `pg` |
| Database | PostgreSQL 16, through a connection pool (`DB_POOL_MAX`, default 10) |
| Schema | 63 tables. `backend/migrations/000_baseline_postgres.sql` holds the schema and reference data; `001`–`002` add SQLite-compatible functions and insertion order; the 17 earlier SQLite migrations are kept in `migrations/sqlite-legacy/` for history |
| Files | `/data/uploads` (photos, manuals, signatures, vision evidence) |
| Port | 3100 |

## System map

```text
 Web workspace (/)     Field app PWA (/mobile/)     Vision edge node (Python)     Machine gateways
 desktop SPA           offline queue, SW cache      /api/edge/v1/*  (node key)    /api/integrations/*  (x-integration-key)
        \                     |                              |                          /
         '------------------- HTTPS · JSON · Bearer token ---------------------------'
                                             |
 ┌──────────────── Docker container · node:22-alpine · runs as user "node" ─────────────────┐
 │  backend/server.js                                                                         │
 │    GET /*    static files from frontend/ with CSP and security headers                     │
 │    /api/*    router → parse body (≤ 8 MB) → authenticate → transaction or snapshot → audit  │
 │                                                                                            │
 │  backend/services/   core · iot · factory · traceability · vision · assistant · ml         │
 │  background jobs     missing tags 5 min · predictive + scrap scan 10 min · edge-node health │
 │                      1 min · vision AI review 1 min · evidence pruning 6 h ·               │
 │                      IoT sync and factory simulator (optional)                             │
 │  /data volume        uploads/                                                              │
 └──────────────────────────────────────┬─────────────────────────────────────────────────────┘
                                        │ pg pool (DATABASE_URL)
                              ┌─────────┴─────────┐
                              │  PostgreSQL 16    │  every record: 63 tables
                              └───────────────────┘
        outbound, only when configured
        ├── Anthropic API       ANTHROPIC_API_KEY   assistant, repair guides, Explain with AI, vision second opinion
        ├── ML service (ml/)    ML_SERVICE_URL      trained breakdown-risk, scrap and anomaly models
        └── Email API           EMAIL_PROVIDER      alert emails from notification_outbox
```

## Services

Each folder in `backend/services/` exports route modules that `server.js` registers in a fixed order (the router uses the first matching pattern). Shared code is in `backend/common/`.

| Service | What it does | Main tables |
| --- | --- | --- |
| `core` | Sign-in, companies, plants, users, equipment, contracts and visits, breakdown tickets, spare parts and quotes, dashboard, settings, CSV bulk import of equipment, products and plants | `companies` `plants` `users` `providers` `equipment` `contracts` `visits` `tickets` `ticket_events` `work_logs` `parts_requests` `quotations` `signoffs` `attachments` `settings` `audit_events` |
| `iot` | Standard machine-data records, adapter sync, quarantine, device mappings | `readings` `iot_alarms` `iot_rejections` `device_mappings` `integration_runs` `integration_cursors` |
| `factory` | Live floor, OEE, alerts and email, condition limits, energy, quality, safety, asset tracking, shifts, simulator | `machine_states` `production_counts` `products` `shifts` `alerts` `notification_outbox` `sensor_limits` `energy_readings` `safety_events` `zones` `tracked_assets` `asset_sightings` |
| `traceability` | Trace search, lots, batches, process windows, quality gates, labels, dispatch, field returns | `material_lots` `batches` `batch_materials` `batch_checks` `process_readings` `process_deviations` `trace_units` `shipments` `field_returns` |
| `vision` | Cameras, AI modules, incidents, evidence, licences, edge API, false-alarm analytics, AI second opinion | `vision_nodes` `vision_cameras` `vision_zones` `vision_assignments` `vision_events` `vision_media` `vision_results` `vision_stats` `vision_licences` `vision_reviews` |
| `assistant` | Breakdown chat with photos, AI repair guide | `ticket_assistant_messages` `ticket_guides` |
| `ml` | Learned baselines per signal, predictive and scrap insights, OEE drivers, shift forecast, Explain with AI, ML service client | reads factory data; raises rows in `alerts` |

## Where data is stored

**PostgreSQL** holds every record. `backend/common/db.js` keeps a small API (`one`, `all`, `run`, `transaction`, `readOnly`), all async; queries keep `?` placeholders, rewritten to `$1…$n` once per statement. Migrations in `backend/migrations/` run on start. Timestamps are ISO-8601 text. Details and the rules for new code: [MIGRATION-POSTGRES.md](MIGRATION-POSTGRES.md).

**Files** stay outside the database, under `MOULDCARE_DATA_DIR/uploads` (`/data/uploads` in the container). `backend/common/files.js` accepts PDF, PNG, JPEG and WebP up to 5 MB, checks the file's first bytes against its type, stores it under a random 40-character name and records the original name in `attachments`. Files are only downloaded through authorised API routes.

**Browser**

- Web workspace: sign-in token in session storage, or local storage when *Keep me signed in on this device* is ticked; theme and language in local storage.
- Field app: token in session storage; queued changes in IndexedDB (`mouldcare-field`, store `actions`); app shell and opened work in the service-worker cache.
- Both clear their data on sign-out. The field app refuses to sign out while changes are still queued.

## Request lifecycle

Example: `PATCH /api/contracts/contract-a`.

1. **Route match.** `router.match()` in `common/http.js` finds the first pattern for the method and path: 404 for an unknown path, 405 for a known path with the wrong method.
2. **Body.** JSON read in chunks; above 8 MB the request is refused with 413.
3. **Authenticate.** `common/security.js` checks the bearer token `payload.signature` (HMAC-SHA256 with `MOULDCARE_SECRET`), its 8-hour expiry, that the user is active, and that the token's session version matches the user's. A password change bumps the version and signs out every session.
4. **Database scope.** The server picks how the handler meets the database:

   | Request | Runs in | Why |
   | --- | --- | --- |
   | POST, PUT, PATCH, DELETE | `transaction()`: one connection, one transaction, a global writer lock (advisory lock) | The request applies whole or not at all, and writers never interleave, as the code expects |
   | GET | `readOnly()`: a read-only, repeatable-read snapshot | Consistent data, and reads run in parallel |
   | Routes marked `{external:true}` | no wrapper; each statement commits on its own | They wait on AI or remote services and must not hold the writer lock |
   | Offline-replay routes | `transaction()` plus the replay record | See below |

5. **Tenant check.** Helpers in `common/access.js` load each record named in the request and refuse one from another company with 403. Customers see their company; engineers and providers see work assigned to them; platform admins and dispatchers see everything.
6. **Validate and write.** The handler validates input and business rules, then writes.
7. **Audit.** An `audit_events` row records who changed what.
8. **Reply.** JSON with `cache-control: no-store`. A duplicate unique key becomes 409; anything unexpected is logged and returned as 500.

## Offline sync (field app)

1. A change is saved in the IndexedDB queue with a random action ID and shown at once as queued.
2. When online, queued changes are sent in order with the header `X-Client-Action-Id`.
3. The server stores the first result in `offline_actions` with a SHA-256 hash of the request, in the same transaction as the change. A replay returns the stored result; reusing an ID for a different request is refused with 409.
4. The phone removes the action from the queue only after the server confirms it.

## Machine and camera data

| Entry point | Authentication | Purpose |
| --- | --- | --- |
| `POST /api/integrations/iot/records` | `x-integration-key` | Running hours, cycle counts, temperatures and alarms in one standard format; invalid records go to `iot_rejections`, replays are skipped |
| `POST /api/integrations/factory/events` | `x-integration-key` | Machine states, counts, energy, condition and process values, quality results, safety events, tag sightings |
| `/api/edge/v1/heartbeat`, `config`, `events`, `media` | per-node edge key | Vision detections (critical first, each with an external ID so resending is harmless), snapshots and clips |

The edge agent keeps a disk outbox, so detections survive a lost uplink. Life-safety evidence is locked and never pruned.

## Security

| Area | How it is handled |
| --- | --- |
| Passwords | scrypt with a random 16-byte salt; compared in constant time |
| Tokens | HMAC-signed, 8-hour expiry, revoked by bumping the session version; production refuses to start without a secret of 32+ characters or without `DATABASE_URL` |
| Tenant isolation | Every ID from a request goes through `access.js` before handler logic runs |
| Browser | Strict Content-Security-Policy (scripts from self only), no framing, no referrer, camera allowed for scanning only |
| Uploads | Type checked by content, random storage names, authorised downloads only |
| AI | Off without `ANTHROPIC_API_KEY`; the vision second opinion is opt-in per company, advice only, and never applied to fire or critical incidents automatically |
| Container | Starts as root only to fix `/data` ownership, then runs as `node` |

## Deployment

1. **Build.** `Dockerfile` (`node:22-alpine`) installs the production dependencies and copies `backend/` and `frontend/`; tests and build scripts are removed.
2. **Start.** `docker-entrypoint.sh` fixes volume ownership, loads demo data only when `MOULDCARE_SEED_DEMO=true`, creates the first admin from `MOULDCARE_ADMIN_EMAIL` and `MOULDCARE_ADMIN_PASSWORD`, and starts the server. Migrations run on start.
3. **Host.**
   - `docker-compose.yml` runs PostgreSQL 16 (volume `db-data`) and the platform (volume `platform-data` for uploads), with `POSTGRES_PASSWORD` from `.env`.
   - `render.yaml` defines a managed PostgreSQL database (`platform-db`), one web service with a 1 GB disk at `/data` for uploads, a health check on `/api/health`, and auto-deploy on push.
   - An existing SQLite deployment moves across with `npm run db:import-sqlite` ([MIGRATION-POSTGRES.md](MIGRATION-POSTGRES.md)).

**Run one instance for now.** The database can serve several, but the sign-in lockout counter is still held in each server's memory; move it into PostgreSQL before scaling out. Back up the database and the `/data` volume.
