# MouldCare API

Base URL: `http://localhost:3100/api`. All request and response bodies are JSON. Protected endpoints require `Authorization: Bearer <token>`, obtained from `POST /auth/login`.

- **Errors** are `{ "error": "message" }`, with HTTP status 400, 401, 403, 404, 405, 409, 413, or 429.
- **IDs** are opaque strings.
- **Timestamps** are stored and returned in UTC, ISO 8601. Company and plant time zones are IANA identifiers, used for display and scheduling.
- **Dates and times in requests:** a date-only value (`2026-01-01`) means UTC midnight. A date-time must carry a UTC offset (`Z` or `+05:30`) and is rejected without one. The one exception is a contract visit's `dueAt`: a time with no offset, such as `2026-11-15T08:00`, is read in the asset's plant time zone.
- **Money** is stored in minor units (`amountMinor`) with an ISO 4217 currency code.

Route handlers live in `api/routes/`, one module per area. `api/access.js` holds the tenant-scoped lookups that every module uses.

## Access model

| Role | Scope |
| --- | --- |
| Platform admin | All tenants; company/provider creation and approval; integration status |
| Dispatcher | All service work; assignment, quotations, parts fulfilment, contracts and visits; in-house staff directory |
| In-house engineer | Only tickets assigned directly to that user; machine data for those assets while the ticket is open |
| Customer admin | Own company setup, assets, contracts, tickets, quotes, devices, audit; manages own plant managers and maintenance staff |
| Plant manager / maintenance | Own company work; plant manager can approve quotes |
| Provider admin / engineer | Only tickets assigned to their provider, and that asset's machine data while the ticket is open; provider admin manages own engineers |

Data scoping and auditing:

- Every ticket, asset, contract, part request, quote, file, and reading is scoped server-side.
- Assignment re-checks the provider's approval, service area, and machine skills.
- IDs from another tenant inside a request are rejected.
- Every change writes an audit event.
- A deactivated user is refused on their next request, even with a token that hasn't expired.
- Changing or resetting a password signs that user out on every device. Each token carries the user's session version, and the change increases it.
- New accounts, admin password resets and the first admin from the environment are marked `mustChangePassword`. The web app sends those users to **Account** to choose their own password.

**Sign-in protection.** After five failed sign-ins for the same email from the same address, that combination is locked for 15 minutes (HTTP 429 with `Retry-After`). An unknown email takes as long to reject as a wrong password. The failure counter is kept in memory on each server instance; use a shared store when running several instances.

## Routes

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Liveness |
| `POST` | `/auth/login` | Email and password → 8-hour signed token, plus profile and preferences |
| `GET, PATCH` | `/me` | Profile with `preferences` (locale, timezone, currency, units). PATCH `{locale}` with `en` or `de` |
| `POST` | `/me/password` | `{currentPassword, newPassword}`; at least 12 characters. Signs out other sessions and returns a fresh `token` for this one |
| `GET` | `/dashboard` | Work and service metrics (see below) |
| `GET, POST` | `/companies`, `/providers`, `/users`, `/plants`, `/equipment`, `/contracts`, `/tickets` | List visible records, or create one (role checks apply) |
| `PATCH` | `/users/:id` | Activate/deactivate, rename; service areas and skills for engineers |
| `POST` | `/users/:id/password` | Admin reset to a temporary password `{newPassword}`: signs the user out everywhere, clears sign-in lockouts, requires a new password at next sign-in. Same permissions as managing the user; not for your own account |
| `PATCH` | `/companies/:id` | Platform admin or the company's customer admin: name, time zone, currency, units, language. Applies from now on; existing quotes keep their currency |
| `PATCH` | `/plants/:id` | Same permissions: name, address, country, service area code, time zone. A new service area affects future assignments only |
| `PATCH` | `/providers/:id` | Platform admin: edit contacts, insurance expiry, certifications, service areas, skills |
| `PATCH` | `/providers/:id/approval` | Approve or suspend a provider (approval needs contacts and valid insurance) |
| `GET, PATCH` | `/equipment/:id` | Asset detail with files, telemetry and recent tickets. PATCH edits make, model, serial or location, or moves the asset between the company's plants |
| `GET` | `/equipment/lookup?code=...` | Resolve a scan (QR label payload or RFID tag UID/EPC; `?qr=` still works) to the machine, with `scannedVia`, `ticketIds` and `openTicketIds`. Within the company or visible work |
| `GET` | `/equipment/:id/readings?limit=100&before=<ISO>` | Freshness, last value per metric, active alarms, reading history |
| `GET` | `/equipment/:id/alarms?state=active\|all` | Alarm history (raised and cleared times) |
| `GET, POST` | `/devices` | List or create device-to-asset mappings |
| `PATCH` | `/devices/:id` | Activate/deactivate, set the stale threshold, or remap within the same company |
| `GET` | `/integrations/status` | Platform admin: adapter, cursor, sync runs, quarantined records |
| `POST` | `/integrations/sync` | Platform admin: run one pull sync now |
| `PATCH` | `/contracts/:id` | Renewal date, status (`active`, `expired` or `cancelled`), response target, commitments, exclusions |
| `POST` | `/contracts/:id/visits` | Add a scheduled visit for a covered asset, within the contract period |
| `PATCH` | `/visits/:id` | Update visit status or notes |
| `GET` | `/tickets/:id` | Ticket with contract coverage, response target, events, checklist, work, parts, sign-off and evidence |
| `GET` | `/tickets/:id/candidates` | Dispatcher/admin: every engineer and provider, with eligibility reasons and open workload |
| `POST` | `/tickets/:id/assign` | Assign an eligible engineer or approved provider |
| `POST` | `/tickets` | Raise a breakdown; needs a scan of the machine (see *Scan at the machine*). Works offline |
| `POST` | `/tickets/:id/status` | Accept, decline, start, escalate or complete; completing needs a scan of the machine (works offline) |
| `POST` | `/tickets/:id/checklist` | Add a checklist item (works offline) |
| `PATCH, POST` | `/checklist/:id` | Tick, untick or annotate a checklist item (POST works offline) |
| `POST` | `/tickets/:id/work-logs` | Log work time and parts used (works offline) |
| `POST` | `/tickets/:id/signoff` | Sign-off after completion: by the customer in the portal, or on site with a signature (works offline) |
| `GET` | `/parts` | Visible parts requests, with ticket title and latest quote |
| `POST` | `/tickets/:id/parts` | Request a part (works offline) |
| `POST` | `/parts/:id/quote` | Create a quote. Only for requested, quoted or rejected requests; replaces any pending quote |
| `GET` | `/parts/:id/quotes` | View quotes |
| `POST` | `/quotes/:id/decision` | Customer admin or plant manager approves or rejects a quote |
| `POST` | `/parts/:id/fulfilment` | `{status: ordered\|shipped\|fulfilled, reference}`; the reference is a PO, tracking number or delivery note |
| `POST` | `/parts/:id/fulfil` | Shortcut: mark fulfilled |
| `POST` | `/attachments` | Upload a PDF or image as base64, max 5 MB (works offline) |
| `GET` | `/attachments/:id` | Download a file the caller is allowed to see |
| `GET` | `/audit` | Recent audit trail |
| `GET` | `/catalog` | Master-data catalogue: machine parameter sets and ISO 14224 code lists |
| `GET, POST` | `/service-areas` | Managed service-area list (create: platform admin) |
| `PATCH` | `/service-areas/:code` | Rename a service area (the code stays fixed) |
| `GET, PATCH` | `/settings/scan-policy` | `{raise, close}`, each `required` or `optional` (read: everyone, also in `/catalog` as `scanPolicy`; change: platform admin) |
| `GET, PATCH` | `/settings/response-targets` | Default response hours by priority (read: internal staff; change: platform admin) |
| `GET` | `/settings/checklists` | Standard checklist per machine type |
| `PATCH` | `/settings/checklists/:type` | Platform admin: replace a machine type's checklist `{items:[...]}` |

`GET /dashboard` returns:

- open, unassigned and escalated ticket counts
- mean response time, overall and by priority
- missed response targets
- downtime by asset
- repeat faults over the last 90 days
- upcoming and overdue visits
- contract renewals due within 90 days
- machine-data health

## Workflow rules

**Ticket status**
- The normal path is `open → assigned → accepted → in_progress → completed`.
- `escalated` can be reached from any active status, and returns to `in_progress`.
- A ticket can't be completed without at least one work log.
- Escalating or declining requires a note.

**Scan at the machine (QR label or RFID tag)**
- Every machine has a QR label (`qr_code`, `MC:…`, fixed). It can also carry an RFID/NFC tag (`rfidTag` on create or PATCH; `null` removes it). Tag UIDs are stored as upper-case letters and digits, so `04:a2:3b…` and `04A23B…` match, and are unique across the platform.
- **Raising:** send `scanCode` with the scanned QR payload or tag UID. It must belong to `equipmentId`; `equipmentId` may be left out, and the scan then identifies the machine. Tickets raised from an alert (`alertId`) need no scan.
- **Closing:** `status: completed` needs `scanCode` for the ticket's machine.
- **Without a scan:** with the policy at `required`, only a dispatcher or platform admin can proceed, and only with `scanOverrideReason`. With `optional`, anyone can.
- Each ticket records `raised_via` and `closed_via` (`qr`, `rfid`, `alert`, `auto`, `override` or `manual`), the scan times `raised_scan_at` and `closed_scan_at`, and any `scan_override_reason`. A `scan` event is added to the ticket's activity. Tickets from before this feature have `null`.
- The field app checks a closing scan against the ticket's machine on the device, so it works offline; the server checks again when the action syncs. A breakdown reported offline is queued with just the scanned code.

**Declining a ticket**
- Only the assigned engineer or provider can decline, and only before accepting.
- The ticket returns to `open` and unassigned, and the reason is added to its activity.
- The decliner loses access to the ticket, so the reply is `{id, status: "open", declined: true}` instead of the ticket.

**Checklists**
- When a ticket is accepted and its checklist is empty, it is filled from the standard checklist for the asset's machine type (`checklist_templates`).
- Standard checklists are seeded for injection moulding, blow moulding, extrusion, moulds and auxiliary equipment.
- Engineers can add their own items.

**Contract coverage and response targets**
- A ticket is covered by the contract that was active for its asset when the ticket was raised.
- If the contract sets `responseHours`, then `responseDueAt` is the time the ticket was raised plus that target.
- `responseBreached` is true if the ticket was first accepted after `responseDueAt`, or is still unaccepted once it has passed.

**Sign-off**
- Each ticket has one sign-off, given after completion.
- Customers sign in the portal (`method: portal`).
- An assigned engineer or dispatcher can collect it on site by sending `signatureBase64` (a PNG). The signature is stored as a private `signature` attachment, with `method: on_site` and `collected_by`.

**Parts**
- A request moves through `requested → quoted → approved` (or `rejected`).
- After approval it moves through `ordered → shipped → fulfilled`. Steps can be skipped but never reversed.

Examples:

```json
POST /tickets
{"scanCode":"E28011606000020840A1B204","title":"Pressure drops","priority":"high","symptoms":"Drops after warm-up","errorCodes":"E-204","productionImpact":"Line stopped","failureCategory":"hydraulic","machineState":"stopped","safetyIssue":false,"occurredAt":"2026-10-02T08:00"}

POST /tickets/{id}/status
{"status":"completed","failureMode":"external_leakage","rootCause":"wear_and_ageing","actionTaken":"replace","scanCode":"MC:eq-a"}

POST /tickets/{id}/assign
{"assigneeType":"provider","assigneeId":"p-atlas"}

POST /tickets/{id}/status
{"status":"declined","note":"No hydraulic specialist available this week"}

POST /tickets/{id}/signoff
{"signerName":"Lee Maintenance","signatureBase64":"iVBORw0KGgo..."}

POST /contracts
{"companyId":"c-acme","title":"Annual care","startsAt":"2026-01-01","renewsAt":"2027-01-01","responseHours":8,"commitments":"Four visits; eight-hour response","exclusions":"Consumables","equipmentIds":["eq-a","eq-b"],"visits":[{"equipmentId":"eq-a","dueAt":"2026-11-15T08:00","notes":"Quarterly inspection (plant local time)"}]}

POST /parts/{id}/fulfilment
{"status":"shipped","reference":"UPS 1Z999AA10123456784"}
```

## Mandatory master data

Each record type has a mandatory set of parameters, based on industry practice:
- **ISO 14224** (collecting equipment reliability and maintenance data) for failure reporting and close-out.
- **EN 13306 / EN 15341** (maintenance terms and key performance indicators) for KPI definitions.
- **Machine-builder data sheets** for machine parameters.

The catalogue in `api/catalog.js` is the single source: the API validates against it, and `GET /catalog` gives the same lists and parameter sets to both apps, so they build their forms from it.

Records created before a field became mandatory are still accepted. They come back with a `missing` list and are flagged "Incomplete" in the apps, so they can be completed rather than blocking work.

| Record | Mandatory (in addition to existing fields) |
| --- | --- |
| Company | `country` (ISO 3166 two-letter code), `contactName`, `contactEmail`, `contactPhone` (international format). Optional: `taxId` |
| Plant | `address`, `serviceArea` (from the managed list), `operatingPattern` (`24x7`, `24x5`, `16x5` or `8x5`) |
| User | Field engineers (`engineer`, `provider_engineer`): `phone`, at least one service area, at least one machine skill. Optional for all: `jobTitle` |
| Provider | `country`, `contactName`, `contactEmail`, `contactPhone`, service areas, skills. **Approval** also needs `insuranceExpiry` in the future. Optional: `certifications` |
| Equipment | `assetTag` (unique per company), `criticality` (`A` = production-critical or safety-relevant, `B` = important with a workaround, `C` = low impact), `yearBuilt`, `status` (`in_service`, `standby`, `out_of_service` or `decommissioned`), and the **type parameter set** below. Optional: `commissionedAt`, `warrantyUntil` |
| Breakdown ticket | `failureCategory`, `machineState` (`stopped`, `reduced_output`, `quality_issue` or `running`), `safetyIssue` (true/false; true forces priority `critical`), and `occurredAt` (local plant time accepted, within the last 90 days, not in the future) |
| Ticket completion | Close-out: `failureMode`, `rootCause`, `actionTaken`. If the machine was stopped and no downtime was entered, downtime is calculated from `occurredAt` |
| Contract | `contractNumber` (unique per company), `coverageHours` (`8x5`, `12x5`, `16x6` or `24x7`), `responseHours`, `visitsPerYear`, `noticeDays`. Optional: `restoreHours` (not shorter than the response target) |
| Spare part | `partNumber`, `unit` (`pcs`, `set`, `m`, `kg` or `l`), `urgency` (`normal`, `urgent` or `breakdown`). Optional: `manufacturer` |
| Quote | `validUntil` (today to one year ahead). An expired quote cannot be approved |
| Fulfilment | A reference is required for `ordered` (purchase order number) and `shipped` (tracking number or delivery note) |

**Machine parameter sets.** These are sent as `specs`, in metric units. Fields marked \* are mandatory.

| Type | Parameters |
| --- | --- |
| Injection moulding | clamp force (kN)\*, shot volume (cm³)\*, screw diameter (mm)\*, drive type (hydraulic / electric / hybrid)\*, control system |
| Blow moulding | process (EBM / IBM / ISBM)\*, cavities\*, max container volume (L)\*, clamp force (kN) |
| Extrusion | line type\*, screw configuration (single / twin)\*, screw diameter (mm)\*, L/D ratio\*, rated output (kg/h)\* |
| Mould | mould number\*, cavities\*, hot runner (yes / no)\*, hot runner zones, current shot count\*, preventive maintenance interval (shots)\*, steel grade |
| Auxiliary | equipment type (dryer, chiller, TCU, loader, granulator, robot, conveyor, dosing / blender, other)\*, capacity, the machine it serves (same company) |

**Response targets.** A ticket uses its covering contract's response target. Without a contract, it uses the platform default for its priority, which a platform admin sets in Settings (by default: critical 4 h, high 8 h, medium 24 h, low 72 h). Ticket detail returns `responseHours`, `responseSource` (`contract` or `default`), `responseDueAt` and `responseBreached`. When the contract sets a restore target, it also returns `restoreDueAt` and `restoreBreached`.

**KPIs** (`GET /dashboard` → `kpi`, last 90 days):
- **MTTR:** mean time from failure start to completion.
- **MTBF:** (asset-hours − downtime) ÷ breakdowns.
- **Availability:** 1 − downtime ÷ asset-hours.

All three use calendar hours. The dashboard also returns `weekly`, breakdowns per week for the last 12 weeks, and `incompleteAssets`.

## Smart factory: production monitoring (OEE) and alerts

The monitoring modules live in the same platform as maintenance, so a problem a machine reports can become a ticket for the right engineer. All factory data belongs to the customer: their own staff, platform admins and dispatchers can see it; service providers cannot.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/factory/floor?plantId=` | Every production machine: current state and reason, time in that state, current product, this shift's OEE (A/P/Q), good output and scrap, open alerts |
| `GET` | `/factory/oee?from&to&plantId&equipmentId` | OEE for a period (up to 92 days; default the last 7). Returns totals, a row per machine, OEE per local day, and losses sorted largest first |
| `GET, PATCH` | `/plants/:id/shifts` | A plant's shifts. PATCH `{shifts:[{name,start:'06:00',end:'14:00',days:[1..7]}]}`; an empty list returns the plant to the defaults for its operating pattern |
| `GET, POST, PATCH` | `/products`, `/products/:id` | Products and their ideal rate. Parts: `idealCycleS` and `cavities`, rate = 3600 ÷ cycle × cavities. Continuous output: `unit` `kg` or `m` plus `idealRatePerHour` |
| `GET` | `/alerts?status=active\|all` | Alerts from every module |
| `GET` | `/alerts/summary` | Open alerts by severity (for the alert bell) |
| `POST` | `/alerts/:id/acknowledge`, `/alerts/:id/resolve` | Work an alert. Raising a ticket with `alertId` links the two and acknowledges the alert |
| `GET` | `/alerts/emails` | Platform admin: the email outbox |
| `POST` | `/integrations/factory/events` | Machine-data intake (server-to-server, `X-Integration-Key`) |
| `GET, POST` | `/factory/simulator`, `/factory/simulator/run` | Platform admin: simulator status and a manual run |

**How OEE is calculated** (`api/factory/production.js`). Everything is measured only inside planned shift time:
- **Planned time** = shift time − planned stops − time with no data.
- **Availability** = running time ÷ planned time.
- **Performance** = ideal time for the output made ÷ running time, where ideal time = output ÷ ideal rate.
- **Quality** = good output ÷ total output.
- **OEE** = A × P × Q. Combining machines is weighted by time, not averaged: plant OEE = Σ(ideal time × quality) ÷ Σ planned time.

**Shifts.** Plants without their own shifts use the defaults for their operating pattern:
- 24×7: three shifts (06–14, 14–22, 22–06) every day
- 24×5: the same three shifts, Monday to Friday
- 16×5: 06–14 and 14–22, Monday to Friday
- 8×5: 08–16, Monday to Friday

**Machine states and downtime reasons** (`GET /catalog` → `liveStates`, `downtimeReasons`):

| State | Reasons |
| --- | --- |
| `down` | breakdown, mould fault, auxiliary fault, quality stop, power failure |
| `setup` | mould change, material change, colour change, start-up |
| `idle` | waiting for material, waiting for operator, waiting for quality approval, minor stop |
| `planned_stop` | break, no production planned, planned maintenance, trial run |

`offline` means no data. When a machine goes `down` for a breakdown, mould fault, auxiliary fault or power failure, one alert is raised; it resolves itself when the machine runs again.

**Intake format.** Devices are mapped to machines under *IoT integration → Device mappings*. Up to 1,000 events per request, each accepted, unchanged, duplicate or rejected (with a reason):

```json
{ "events": [
  { "type": "state", "deviceId": "plc-imm-04", "at": "2026-10-02T08:15:00Z", "state": "down", "reason": "breakdown" },
  { "type": "count", "deviceId": "plc-imm-04", "periodStart": "2026-10-02T08:00:00Z", "periodMinutes": 15, "totalQty": 4300, "scrapQty": 40, "partNumber": "CAP-28-PCO" }
] }
```

Counts are idempotent per machine and period start. Without `partNumber`, the product assigned to the machine is used, or else a rate taken from the machine's data sheet.

**Alerts and email.**
- An alert has a dedupe key, so a long fault produces one alert, not one per reading.
- Critical alerts are emailed to the customer's admins, plant managers and maintenance staff (anyone who hasn't opted out), and to dispatchers.
- The lowest emailed severity is the `alert_email_min_severity` setting; the default is `critical`.
- Sending uses an email API: set `EMAIL_PROVIDER` (`brevo`, `sendgrid` or `resend`), `EMAIL_API_KEY` and `EMAIL_FROM`. Until those are set, messages stay in the outbox as `not_configured`.

**Simulator** (`api/factory/simulator.js`).
- Produces realistic 15-minute machine states and output for every in-service production machine, through the same `recordState`/`recordCount` path as real data.
- Each machine has a stable "character" (reliability, speed, scrap rate).
- On first start it fills in 7 days of history, then keeps up every minute.
- It's on only with `FACTORY_SIMULATOR=true`. Keep it off on any site with real customer data.

## Smart factory: condition monitoring and energy

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/factory/condition?plantId=` | Each machine's health (`ok`, `warning`, `critical` or `unknown`), and every monitored parameter's latest value, limits and status |
| `GET` | `/factory/condition/:id/trend?parameter&hours=24\|168` | Readings for a chart: raw for 24 h, hourly averages for 7 days, with the limits |
| `GET, PATCH` | `/equipment/:id/limits` | Limits per parameter: `{limits:[{parameter,warnLow,warnHigh,critLow,critHigh,autoTicket}]}`. This replaces all limits; a parameter left without any bound is not monitored. Customer admins, plant managers, platform admins and dispatchers can change them |
| `GET` | `/factory/energy?from&to&plantId&equipmentId` | kWh, kWh per kg, wasted energy, peak power, CO₂ and cost: totals, a row per machine, and kWh per day |

**Parameters and recommended limits** (`GET /catalog` → `conditionParameters`):

| Parameter | Machines | Unit | Warning | Critical |
| --- | --- | --- | --- | --- |
| Hydraulic oil temperature | injection, blow | °C | ≥ 55 | ≥ 65 |
| Pump / motor vibration | all | mm/s | ≥ 4.5 | ≥ 7.1 |
| Cooling water supply | all | °C | ≥ 22 | ≥ 28 |
| Gearbox oil temperature | extrusion | °C | ≥ 70 | ≥ 85 |
| Melt pressure | extrusion | bar | ≥ 300 | ≥ 350 |
| Compressed air pressure | blow | bar | ≤ 6 | ≤ 5 |

The vibration limits follow the ISO 10816 / ISO 20816 zones for medium machines. Tune the rest per machine.

**How a reading is judged** (`api/factory/condition.js`). Each reading is compared with its machine's limit for that parameter:
- **Normal:** resolves any open alert for that machine and parameter.
- **Warning:** raises one alert.
- **Critical:** upgrades the alert to critical, which emails it.
- When the limit has `autoTicket` on, a critical reading also **raises one maintenance ticket**. It's high priority, created by "Automatic monitoring", and its failure category comes from the parameter. A continuing problem reuses the same open ticket instead of creating another.

A machine's health is its worst parameter. A parameter with no reading in the last hour is `stale`.

**Energy** (`api/factory/energy.js`):
- **SEC** (specific energy consumption) = kWh ÷ kg produced. Parts are converted with the product's part weight; metres are left out.
- **Wasted energy** = kWh used in intervals when the machine wasn't running.
- **CO₂** = kWh × the company's grid emission factor (`gridCo2KgPerKwh`), or its country's average if none is set.
- **Cost** = kWh × `energyPricePerKwh`, shown when all selected machines share one currency.
- Both energy settings are edited with `PATCH /companies/:id`.

**Intake event types**, added to `state` and `count`:

```json
{ "type": "condition", "deviceId": "plc-imm-04", "at": "2026-10-02T08:15:00Z", "parameter": "hydraulic_oil_temp", "value": 58.4 }
{ "type": "energy", "deviceId": "meter-imm-04", "periodStart": "2026-10-02T08:00:00Z", "periodMinutes": 15, "kwh": 11.2, "peakKw": 52 }
```

Readings and energy intervals are idempotent per machine and timestamp.

**Simulator.** It now also produces energy use per state, sized from each machine's data sheet, plus condition signals with daily variation. Some machines have one slowly failing part that drifts over a repeating 10-day cycle, so the demo shows the whole chain: warning → critical → automatic ticket.

## Smart factory: traceability, vision quality, safety and asset tracking

Same access as the other factory data: the customer's own staff and the platform team see it, and providers do not. Records are created by customer staff (or the platform admin). Customer admins and plant managers make the decisions: quarantine and release, hold and release batches, close safety events, and edit zones and assets.

| Method | Path | Purpose |
|---|---|---|
| `GET`/`POST` | `/trace/lots` | Material lots: `lotNumber`, `material`, `supplier`, `receivedAt`, `quantityKg` (all required), `certificate` |
| `GET` | `/trace/lots/:id` | Lot with every batch that used it (forward traceability) |
| `POST` | `/trace/lots/:id/quarantine` | `{reason}`: the lot is blocked, and every running, completed or released batch that used it goes on hold. Raises a quality alert |
| `POST` | `/trace/lots/:id/release` | Lift a quarantine. Held batches stay on hold until each is released |
| `GET`/`POST` | `/trace/batches` | Start a batch: `productId`, `equipmentId`, `mouldId` (required for injection), `batchNumber`, `operatorName`, `plannedQty`, `lots:[{lotId,quantityKg?}]` (released lots only), `processParams` (every setting for the machine type; see `processParams` in `/catalog`). One running batch per machine |
| `GET` | `/trace/batches/:id` | Genealogy: lots, process settings, output, OEE, camera FPY, unplanned stops, alerts and maintenance tickets on the machine and mould while it ran |
| `POST` | `/trace/batches/:id/complete` | `{goodQty?, scrapQty?}`. Without quantities, the machine's own counts are used |
| `POST` | `/trace/batches/:id/status` | `{status: released\|on_hold\|scrapped, reason}`. Hold and scrap need a reason. A batch with a quarantined lot cannot be released |
| `GET` | `/trace/search?q=` | Lots and batches by number |
| `GET` | `/factory/quality?from&to&plantId&equipmentId` | Inspected, rejected, first-pass yield, PPM, a defect Pareto, a row per machine, and FPY per day |
| `GET` | `/safety?from&to&plantId` | Events, counts by type and severity, open events, near misses, days since the last lost-time injury |
| `POST` | `/safety/events` | Report: `plantId`, `eventType` (see `safetyEvents` in `/catalog`), `description`, optional `zoneId`, `equipmentId`, `occurredAt`, `lostTime` (injuries only). Open to the plant's staff, the platform team, and engineers or providers with current work there. Supports offline replay |
| `POST` | `/safety/events/:id/investigate` | Mark as under investigation |
| `POST` | `/safety/events/:id/close` | `{rootCause, correctiveAction}` (both required). Resolves the event's alert |
| `GET`/`POST`/`PATCH` | `/zones`, `/zones/:id` | Zones: `plantId`, `name`, `kind` (production, storage, tool_room, maintenance, dock, restricted, outside), `readerId` (unique: the BLE gateway or RFID reader covering it) |
| `GET`/`POST`/`PATCH` | `/assets`, `/assets/:id` | Tracked assets: `plantId`, `name`, `kind`, `tagId` (unique), `tagType` (ble, rfid, uwb), `homeZoneId`, `equipmentId`, `missingAfterHours`. The list includes the current zone and the missing and away-from-home flags |
| `GET` | `/assets/:id/history?hours=48` | Stays per zone, newest first |

**Rules** (`api/factory/quality.js`, `safety.js`, `assets.js`, `trace.js`):
- **Reject rate** over at least 50 inspected parts: a warning at 3 %, critical (emailed) at 8 %, cleared below 1.5 %. One alert per machine and station.
- **Safety:** warning and critical events raise an alert. Critical types are guard bypassed, injury, man down, and fire or smoke.
- **Assets:** a mould, tool, gauge or fixture seen in a restricted or outside zone raises a warning. A tag not heard for `missingAfterHours` is marked missing; this is checked every 5 minutes and when the list is opened. A battery below 15 % raises an info alert. Each alert clears once its cause is gone. A late, out-of-order sighting is kept in the history but does not move the asset.

**Intake event types**, added to the four above:

```json
{ "type": "vision", "deviceId": "cam-imm-04", "station": "Camera 1", "periodStart": "2026-10-02T08:00:00Z", "periodMinutes": 15, "inspected": 2880, "rejected": 41, "defects": { "short_shot": 25, "flash": 16 } }
{ "type": "safety", "readerId": "GW-ACME-01", "eventType": "ppe_missing", "source": "camera", "at": "2026-10-02T08:12:30Z", "description": "No safety glasses at IMM-04" }
{ "type": "safety", "deviceId": "plc-imm-04", "eventType": "guard_bypassed", "source": "sensor", "at": "2026-10-02T08:13:00Z" }
{ "type": "sighting", "tagId": "BLE-0001", "readerId": "GW-ACME-02", "at": "2026-10-02T08:15:00Z", "rssi": -67, "batteryPct": 82 }
```

- **Defect codes** depend on the machine type; see `defectTypes` in `/catalog`.
- **Safety events** are located either by a zone's reader or by a mapped machine.
- **Sightings** are identified by tag and reader, so they need no device mapping.
- **Duplicates:** vision intervals, sightings, and device safety events (same type, place, source and time) are each stored once.

**Simulator.** For each running interval it produces:
- camera results, with rejects equal to the counted scrap and spread over two or three defects typical of the machine
- occasional safety-camera detections; older ones are already closed
- tag sightings every 30 minutes from 2 days back: assets move between the zones their kind uses, trolleys sometimes go outside, and one gauge goes silent to show the "missing" alert

## Offline actions

The routes marked "works offline" above accept an `X-Client-Action-Id: <UUID>` header.

- The server stores the first result in the same transaction as the change. A replay by the same user returns that stored result without repeating the change.
- Reusing an ID for a different request returns 409.
- The field app queues actions in IndexedDB, shows them on its cached copy of the ticket straight away, and syncs them in order when back online.
- An action rejected by validation stays in the queue for the engineer to review; it is never silently dropped.

## IoT integration interface

Machine data enters through one pipeline, whichever way it arrives:

```text
external API ──pull──▶ adapter.fetchBatch ─▶ adapter.toCanonical ─┐
                                                                  ├─▶ validate ─▶ device→asset mapping ─▶ dedupe ─▶ quality flags ─▶ readings + alarms
external system ──push──▶ POST /integrations/iot/records ─────────┘                  (fail closed)          (device+time)
                                  rejected at any step ─▶ iot_rejections (quarantine, platform-admin review)
```

Code lives in `api/iot/`: `contract.js` (canonical record and validation), `ingest.js` (mapping, dedupe, flags, alarms, freshness queries), `sync.js` (pull runner, cursors, run history), `adapters/` (adapter interface, `mock.js`).

### Canonical record

```json
{
  "deviceId": "demo-device-a",
  "observedAt": "2026-10-01T09:30:00Z",
  "runningHours": 4120.5,
  "cycleCount": 124820,
  "temperatureC": 38.2,
  "alarms": [{ "code": "E-204", "state": "active", "severity": "warning", "message": "Hydraulic pressure below setpoint" }]
}
```

| Field | Rule |
| --- | --- |
| `deviceId` | Required, 1-100 chars. Must be mapped to an asset and active, or the record is rejected. The mapping, never the payload, decides the company and asset. |
| `observedAt` | Required ISO 8601 **with offset**; stored as UTC. Rejected if more than 5 minutes in the future. |
| `runningHours` | Optional, 0-1,000,000. |
| `cycleCount` | Optional non-negative integer. |
| `temperatureC` / `temperatureF` | Optional, one or the other; °F is converted to °C at ingest. Plausible range -50 to 600 °C. |
| `alarms[]` | Optional, up to 50. `state` is `active` or `cleared`; `severity` is `info`, `warning` (default), or `critical`. `alarmCode: "X"` is accepted as shorthand for one active warning. |

A record needs at least one metric or alarm. Omitted metrics are stored as null, never as zero.

### Outcomes and data quality

Every record is `accepted`, `duplicate`, or `rejected`:

- **Rejected**: structurally invalid, unmapped device, or inactive mapping. Stored in `iot_rejections` with reasons and the raw payload (truncated to 4 KB), and never attached to an asset.
- **Duplicate**: same `deviceId` + `observedAt` as a stored reading; ignored. This makes pull retries and push replays safe.
- **Accepted, with flags**: plausible-but-suspicious data is kept and flagged in `quality_flags` rather than dropped. Flags: `out_of_order`, `late_arrival` (arrived after the device's stale threshold), `device_clock_ahead`, `cycle_count_regression` / `running_hours_regression` (a counter went backwards, e.g. a controller reset or replacement).

Alarms have a lifecycle: the first `active` opens an alarm at `observedAt`; repeated `active` states are no-ops; `cleared` closes it. No maintenance ticket or alert is generated automatically. That belongs to a later phase, after the source data has been validated.

### Freshness (missing and stale readings)

`GET /equipment/:id/readings` returns an overall `status`:

| Status | Meaning |
| --- | --- |
| `unmapped` | No device is mapped to the asset. |
| `inactive` | Mapping exists but is deactivated. |
| `missing` | Mapped, but no reading has ever arrived. |
| `stale` | Latest reading is older than the mapping's `staleAfterMinutes` (default 30, per device). |
| `current` | Latest reading is within the threshold. |

It also returns `metrics.<name>` = `{ value, observedAt, status }` for each metric, where status is `current`, `stale`, or `missing`. A device can keep reporting while one sensor drops out, so each metric's age is shown separately; the UI never presents an old value as current.

### Access

- Readings and alarms are visible to the owning company, to platform admins and dispatchers, and to an in-house engineer or provider **only while they hold an open ticket on that asset**.
- Device mappings are managed by platform admins, dispatchers, and the owning customer admin. Remapping is allowed only within the same company.
- Sync status and quarantine are platform-admin only.

### Push endpoint (server-to-server)

`POST /integrations/iot/records` with header `X-Integration-Key: <MOULDCARE_INTEGRATION_KEY>` and body `{ "records": [ ...1-500 canonical records ] }`. The response is always 200 with per-record outcomes:

```json
{ "accepted": 1, "duplicates": 1, "rejected": 1,
  "results": [ { "index": 0, "status": "accepted", "id": "…", "equipmentId": "eq-a", "flags": [] },
               { "index": 1, "status": "duplicate", "id": "…", "equipmentId": "eq-a" },
               { "index": 2, "status": "rejected", "errors": ["observedAt must be an ISO 8601 timestamp with a UTC offset"] } ] }
```

`POST /integrations/mock/readings` (one canonical record; 201 accepted, 200 duplicate, 400 rejected) is kept for compatibility. The integration key is compared in constant time and never sent to web or mobile clients.

### Pull adapters

An adapter implements `{ name, fetchBatch(cursor) → { records, nextCursor, hasMore }, toCanonical(raw) }`; the full contract is in `api/iot/adapters/index.js`. The runner ingests each batch and stores `nextCursor` in the same transaction, so delivery is at-least-once and deduplication makes it idempotent. If `toCanonical` throws for one record, that record is quarantined and the rest of the batch continues. Each run is recorded in `integration_runs` with its counts and any error.

- Run once: `npm run iot:sync`, or **Run sync now** on the web IoT integration page.
- Poll continuously: start the server with `IOT_SYNC_INTERVAL_SECONDS=60` (minimum 15).
- Select an adapter: `IOT_SYNC_ADAPTER` (default `mock`).

The **mock adapter** emits a vendor-style payload (`device.id`, `ts`, `metrics.run_hours`, …), so the mapping step is exercised. Its scenarios: `demo-device-a` reports every 5 minutes, with alarm E-204 raising and clearing; `demo-device-n` went silent 2 hours ago (stale), has no cycle counter (missing metric), and holds critical alarm T-302; the first batch also contains an unmapped device and an out-of-range temperature, and both are quarantined.

### Connecting the real API

Add `api/iot/adapters/http.js` exporting `(env) => adapter`, register it in `adapters/index.js`, and put credentials in server environment variables only. To build it I need: API documentation, sample reading and alarm payloads (including error and empty responses), the authentication method and token lifetime, rate limits and pagination/cursor semantics, the device identifier format, units per field, timestamp and time-zone behaviour, and whether counters can reset.
