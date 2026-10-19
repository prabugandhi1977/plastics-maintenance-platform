# Put the platform online with Render

This takes about 10 minutes. Render builds the app from this GitHub repository, gives it a secure `https://` web address, runs a managed PostgreSQL database for it, and keeps uploaded files on a storage disk that survives restarts.

**Cost:** the *Starter* web plan, a 1 GB disk, and the smallest paid PostgreSQL plan. Check current prices at <https://render.com/pricing>. The free plans can't be used, because they don't keep data.

The screen wording on Render may differ slightly from these steps.

## Before you start

Decide the **email and password for your admin account**. The password needs at least 12 characters; make it strong, because this account controls everything.

## Steps

1. **Sign up.** Go to <https://render.com> and choose **Get Started**, then **GitHub**, and sign in as `prabugandhi1977`.
2. **Start a Blueprint.** In the Render dashboard, click **New +**, then **Blueprint**.
3. **Give Render access to the repository.**
   - If Render asks to connect GitHub, choose **Only select repositories**, pick `plastics-maintenance-platform`, then **Install**/**Save**.
   - Back in Render, select `plastics-maintenance-platform` and click **Connect**.
4. **Check the plan.** Render reads the settings file (`render.yaml`) in this repository and shows one web service, `plastics-maintenance-platform`, on the **Starter** plan with a 1 GB disk, and one PostgreSQL database, `platform-db`, both in Singapore. The database address is passed to the web service automatically as `DATABASE_URL`.
5. **Fill in the two empty values:**
   - `MOULDCARE_ADMIN_EMAIL`: your admin email
   - `MOULDCARE_ADMIN_PASSWORD`: your admin password

   Leave everything else as it is. The security keys are generated automatically, and the demo accounts stay switched off.
6. **Deploy.** Click **Apply** (or **Deploy Blueprint**). If asked, add a payment card.
7. **Wait for "Live".** The first build takes about 3–6 minutes. Open the service to watch its **Logs**; it's done when you see `Created platform admin ...` and `MouldCare listening on port ...`, and the status shows **Live**.
8. **Open your site.** The web address is at the top of the service page, something like `https://plastics-maintenance-platform.onrender.com`.
   - Web workspace: `https://…onrender.com/`
   - Field app for phones: `https://…onrender.com/mobile/` (open it on a phone and use **Add to Home screen**)
9. **Sign in** with your admin email and password. You are taken to **Account** to choose your own password.
   - Tick **Keep me signed in on this device** to stay signed in after closing the browser.
   - Otherwise you stay signed in until you close the tab, and refreshing the page keeps you signed in either way.
10. **Optional tidy-up.** In Render, go to **Environment** and delete `MOULDCARE_ADMIN_PASSWORD`, so the starting password isn't kept there. Your account stays as it is.

## After it's live

- **Add real data.** As admin, go to **Companies, plants & users** and add customer companies, plants and users. Then add service providers, equipment, and contracts.
- **Updates are automatic.** Every change pushed to the repository's `main` branch is rebuilt and published automatically.
- **Backups.** The data is in the PostgreSQL database: open `platform-db` in Render to see its backup and recovery options, and also keep your own copy now and then (`pg_dump` with the database's external connection string). Uploaded files are on the disk, which Render snapshots daily (open the service, then **Disks**).
- **Only one instance, for now.** The database can serve several, but the sign-in lockout counter is still kept in each server's memory. Keep a single instance until it moves into the database (listed in `docs/ROADMAP.md`).

## Already running the SQLite version?

Your data is in `/data/mouldcare.sqlite` on the service's disk, and uploaded files are in `/data/uploads` on the same disk, so only the database needs moving. Plan about 15 minutes when nobody is using the app.

1. **Deploy the PostgreSQL version.** Merge it into `main`. In Render, open **Blueprints**, select this blueprint and click **Sync** (or **Manual sync**) so it creates `platform-db` and adds `DATABASE_URL` to the web service. Wait for **Live**. The app now starts on the new, empty database, so your data seems missing until step 2.
2. **Copy the data.** Open the web service, then **Shell**, and run:

   ```
   node backend/scripts/import-sqlite.js /data/mouldcare.sqlite
   ```

   The admin account created on the first start is replaced by the accounts from your old data. Only if the script says the database *already has companies* (for example, someone added one in step 1) add `--force`, which replaces whatever is there. The copy runs in one transaction and finishes with `Imported N rows across 63 tables; counts match.` If anything fails, nothing is written and you can simply run it again.
3. **Restart.** Click **Manual Deploy**, then **Restart service**, and sign in with your usual accounts.
4. **Keep the old file** for a few weeks as a fallback. It is not used any more and can be deleted later.

## If something goes wrong

| What you see | What to do |
| --- | --- |
| Logs say `MOULDCARE_SECRET must be at least 32 characters` | In **Environment**, make sure `MOULDCARE_SECRET` exists. It should be generated automatically; if it's missing, add a long random value. |
| Logs say `MOULDCARE_ADMIN_PASSWORD must have at least 12 characters` | Set a longer password in **Environment**; Render redeploys automatically. |
| "Email or password is incorrect" | Check the email matches `MOULDCARE_ADMIN_EMAIL` (capitals and spaces don't matter). The message warns when 2 tries are left. |
| "Too many wrong passwords for this account" | Sign-in for that email is paused for 15 minutes after 5 wrong passwords. Wait, or ask an admin to use **Reset password**, which lifts the pause immediately. |
| Forgot the only admin password | In Render, open **Environment**. Set `MOULDCARE_ADMIN_PASSWORD` to a new temporary password, and add `MOULDCARE_ADMIN_RESET_PASSWORD` = `true`, then save. Render restarts the service, and the logs show `Reset password for platform admin`. Sign in with that password, choose your own, then **delete** `MOULDCARE_ADMIN_RESET_PASSWORD` and save again. |
| Logs say `DATABASE_URL is required in production` | The web service is not linked to the database. Sync the Blueprint (step 1 above), or add `DATABASE_URL` in **Environment** using the database's *Internal Database URL*. |
| After moving from SQLite, logs say `MOULDCARE_ADMIN_PASSWORD must have at least 12 characters` | `MOULDCARE_ADMIN_EMAIL` names an account that isn't in your old data, so the start tries to create it. Set it to your existing admin email, or delete `MOULDCARE_ADMIN_EMAIL`, then save. |
| The site shows an error page right after deploying | Wait until the status is **Live**; the first start takes a minute. |
