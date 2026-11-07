# Retire the old `mouldcare-demo` service

`mouldcare-demo` was deployed from the first version of MouldCare (repository `mouldcare`: `api/` and `web/`, SQLite, about 320 lines of server code). This repository is the same application, much further on (PostgreSQL, the full API and web workspace, field app, vision, traceability, energy audit and more). Keeping the old service means paying for a web service and a disk that show an out-of-date product. This note retires it safely.

Nothing in this repository deploys `mouldcare-demo`: its Blueprint is the `render.yaml` in the old repository. Do the steps below in the Render dashboard, not by editing files. Do not delete the service by removing it from a synced Blueprint without reading step 4.

## Before you delete anything (5 minutes)

1. **Confirm nothing real is in it.** The old repository states that it holds synthetic data only. Open the service and look at its users and tickets. If anything there is real, copy it first: the data is in `/data/mouldcare.sqlite` on its disk, and `backend/scripts/import-sqlite.js` in this repository copies SQLite data into PostgreSQL (see `docs/MIGRATION-POSTGRES.md`). It was written for the later SQLite versions of the platform and has not been tried on the first demo's database, so test it on a copy before relying on it.
2. **Find what points at it.** In Render, open the `mouldcare-monitor` service, then **Environment**, and check that `MONITOR_MOULDCARE_URL` points at `plastics-maintenance-platform`, not at the demo. Also check bookmarks, customer links, a custom domain, and any edge node or gateway configured with the demo's address.
3. **Write down its settings** if you may want to recreate it (plan, region, the environment variable names). You can read them from its `render.yaml` in the old repository.

## Retire it

1. **Suspend** the service (**Settings**, then **Suspend Service**). A suspended service does not run or bill for compute, but its disk is kept and still bills for a few cents a month. Nothing is lost.
2. **Wait about a week.** If nobody complains and nothing breaks, go on.
3. **Delete the service**, then **delete its disk** (`mouldcare-data`). Deleting a disk cannot be undone.
4. **Old repository.** If the old `render.yaml` is attached to a Render Blueprint, disconnect the Blueprint first (or delete the service from the dashboard), so a later sync does not recreate it or remove other services. Then add one line to the old README saying the repository is superseded by `plastics-maintenance-platform`, or archive the repository on GitHub.

## Showing the product without a hosted demo

The current application is the demo. It needs PostgreSQL, which `docker compose` provides:

```
cp .env.example .env
# set POSTGRES_PASSWORD and MOULDCARE_SECRET; set MOULDCARE_SEED_DEMO=true (private machine only)
docker compose up -d --build
```

Open <http://localhost:3100/> and sign in with the demo accounts listed in the README (password `DemoPass123!`). The demo seed runs only when `MOULDCARE_SEED_DEMO=true` and must never be turned on in the production service, because the demo accounts share a published password.

If you need a demo on the internet for a customer meeting, create it for that week as a separate Render service and database from this repository's Blueprint, with `MOULDCARE_SEED_DEMO=true`, and delete it afterwards. Do not leave it running.
