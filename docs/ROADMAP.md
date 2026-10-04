# MouldCare roadmap: production readiness and later phases

The MVP covers the core service workflows. This document plans what comes next and where it plugs into the existing code. Each phase is gated by data quality and human review, not just a delivery date.

## Extension points already in the code

| Need | Where it plugs in |
| --- | --- |
| New feature area (API) | Add `backend/services/<area>/routes/<area>.js` exporting `register(router)`, export it from that service's `index.js`, and list it in `backend/server.js`. Handlers receive `{u, body, params, query}` and use `backend/common/access.js` for tenant-scoped lookups. |
| New machine-data source | Add `backend/services/iot/adapters/<name>.js` implementing `fetchBatch` and `toCanonical`, then register it in `adapters/index.js`. Ingest, deduplication, quarantine and freshness are shared. |
| Work-order history | `ticket_events` is the ticket timeline. Remote sessions, AI suggestions and alerts add event types to it, so every feature shares one history. |
| Evidence and documents | `attachments` already holds private manuals, photos, evidence and signatures, all checked by file type. AI retrieval reads only from approved documents here. |
| Field use with poor connectivity | Field-app actions use `{offline:true}` routes with idempotent replay. |
| Languages | Add a catalogue to `frontend/shared/i18n.js` and its code to `LOCALES` in `backend/services/core/routes/auth.js`. |

## Phase 0: production hardening (before the first live customer)

- **Database:**
  - Move to PostgreSQL with tenant row-level security as a second line of defence behind `access.js`.
  - Keep migration files numbered and run in order.
  - Set up nightly backups and run a restore test.
- **Identity:**
  - Move to a managed identity provider (OIDC) with MFA for admin and dispatch roles.
  - Use short-lived access tokens with refresh. A password change or reset already signs a user out everywhere; add "sign out all devices" and session lists to the identity provider setup.
  - Move the login throttle to a shared store such as Redis.
- **Files:** use private object storage with malware scanning, signed short-lived download URLs, and retention rules.
- **Operations:**
  - Serve over HTTPS only, behind a reverse proxy with request size and rate limits.
  - Add structured logs and request IDs, plus uptime and error alerting.
- **Field devices:** use managed devices, encrypted offline storage where available, remote wipe, and a session timeout.
- **Testing and compliance:** run a load test with realistic fleet sizes and an external penetration test. Prepare a GDPR and data-processing agreement for EU customers.
- **Translations:** have native speakers review the German catalogue. Move remaining English-only screen text into the catalogue.

## Phase 1: live IoT monitoring and alerts

Trigger: the real machine-data API documentation and sample payloads are available.

1. Build the HTTP adapter, with authentication refresh, rate limiting, retry with backoff, and pagination via the cursor.
2. Run it alongside the mock adapter on a pilot plant for 2–4 weeks. Measure:
   - how complete the data is per device
   - how late readings arrive
   - how often each quality flag fires
   - what lands in the quarantine
3. Only then add **alert rules**, starting simple and explainable:
   - alarm code X raised
   - temperature above a limit for N minutes
   - no data for longer than the staleness threshold
   - cycle count stopped while the machine is scheduled to run
4. Alerts create *suggested* tickets that a person confirms, with the triggering readings attached as evidence. They never dispatch automatically.
5. Each rule records whether its alerts were later confirmed, so noisy rules can be tuned or retired.

## Phase 2: remote video consultation

- Integrate a video provider through an adapter, keeping it replaceable. Candidates include managed WebRTC platforms with recording and EU data residency.
- A session is started from a ticket. Its participants, consent, start and end times, and a recording reference (if consented) are stored as `ticket_events`.
- Customers explicitly consent to recording each time, and recordings follow the retention policy.
- Success measures: share of tickets resolved remotely, avoided travel, and time to resolution.

## Phase 3: AI-assisted troubleshooting (always human-reviewed)

**Sources.** The assistant uses only *approved* content:
- OEM manuals attached to assets and marked approved by an admin
- completed tickets: symptoms, error codes, work logs, parts used
- approved service bulletins

It never uses unreviewed internet content, or another customer's records unless sharing has been agreed and the data anonymised.

**Retrieval.** Results are filtered by tenant and equipment make, model and machine type *before* ranking, so one customer's data can never be retrieved for another.

**Output.** For a ticket, the assistant shows:
- ranked likely causes and checks
- for each one, the **exact supporting passages** with source, page or ticket link, and date
- a confidence level, and an explicit "insufficient evidence" answer when nothing relevant is found

**Human review.**
- A suggestion is advice only. An engineer must accept, edit or reject it before it can become a checklist item or action.
- The decision, the engineer and the cited evidence are recorded in `ticket_events`.
- No maintenance action is ever taken automatically.

**Evaluation.**
- Before release: a held-out set of historical tickets, with each answer scored by senior engineers.
- After release: track the acceptance rate and whether the problem recurred.

**Safety.** Suggestions involving lock-out/tag-out, pressure, heat or electrical isolation always repeat the OEM safety steps, and never override the asset's standard checklist.

## Phase 4: predictive maintenance (after data validation)

Prerequisites, all measured from Phase 1 data:
- at least 6–12 months of validated telemetry per machine family
- consistent failure labels from closed tickets
- a known baseline false-alarm rate

Approach:
1. Start with interpretable models: wear trends from running hours and cycle counts against service intervals, and drift in temperature or pressure against each asset's own baseline.
2. Back-test them against historical failures.
3. Predictions surface as "inspection recommended" with the trend chart as evidence. They feed scheduled visits and are never automatic interventions.
4. Monitor precision and recall per machine family. Turn off any family where performance degrades.

## Phase 5: AR/VR remote support

- Integrate an established remote-assist platform (smart-glasses or tablet AR with annotation) through a session adapter, as in Phase 2.
- Tickets stay the system of record: session links, annotated snapshots and outcomes are attached as evidence, and core workflows never depend on the AR vendor.
- Pilot first with one provider and one machine family, then decide whether to roll it out more widely.

## Decisions needed from the business (none block current work)

- Video and AR vendor preference, and data-residency requirements per region.
- Which documents count as "approved" for AI, and who approves them.
- The policy for sharing anonymised service history across customers, if any.
- Target languages after German, and who reviews translations.
