# Put the platform online with Render

This takes about 10 minutes. Render builds the app from this GitHub repository, gives it a secure `https://` web address, and keeps the database on a storage disk that survives restarts.

**Cost:** about US$7–8 per month, for the *Starter* plan plus a 1 GB disk. The free plan can't be used, because it doesn't keep data.

The screen wording on Render may differ slightly from these steps.

## Before you start

Decide the **email and password for your admin account**. The password needs at least 12 characters; make it strong, because this account controls everything.

## Steps

1. **Sign up.** Go to <https://render.com> and choose **Get Started**, then **GitHub**, and sign in as `prabugandhi1977`.
2. **Start a Blueprint.** In the Render dashboard, click **New +**, then **Blueprint**.
3. **Give Render access to the repository.**
   - If Render asks to connect GitHub, choose **Only select repositories**, pick `plastics-maintenance-platform`, then **Install**/**Save**.
   - Back in Render, select `plastics-maintenance-platform` and click **Connect**.
4. **Check the plan.** Render reads the settings file (`render.yaml`) in this repository and shows one web service, `plastics-maintenance-platform`, on the **Starter** plan with a 1 GB disk, in Singapore.
5. **Fill in the two empty values:**
   - `MOULDCARE_ADMIN_EMAIL`: your admin email
   - `MOULDCARE_ADMIN_PASSWORD`: your admin password

   Leave everything else as it is. The security keys are generated automatically, and the demo accounts stay switched off.
6. **Deploy.** Click **Apply** (or **Deploy Blueprint**). If asked, add a payment card.
7. **Wait for "Live".** The first build takes about 3–6 minutes. Open the service to watch its **Logs**; it's done when you see `Created platform admin ...` and `MouldCare listening on port ...`, and the status shows **Live**.
8. **Open your site.** The web address is at the top of the service page, something like `https://plastics-maintenance-platform.onrender.com`.
   - Web workspace: `https://…onrender.com/`
   - Field app for phones: `https://…onrender.com/mobile/` (open it on a phone and use **Add to Home screen**)
9. **Sign in** with your admin email and password, then go to **Account** and change the password.
10. **Optional tidy-up.** In Render, go to **Environment** and delete `MOULDCARE_ADMIN_PASSWORD`, so the starting password isn't kept there. Your account stays as it is.

## After it's live

- **Add real data.** As admin, go to **Organisation** and add customer companies, plants and users. Then add providers, equipment, and contracts.
- **Updates are automatic.** Every change pushed to the repository's `main` branch is rebuilt and published automatically.
- **Backups.** Render takes daily snapshots of the disk. To restore one, open the service, then **Disks**.
- **Only one instance.** Keep the service on a single instance: the database file can't be shared between servers. Moving to PostgreSQL, described in `docs/ROADMAP.md`, removes this limit.

## If something goes wrong

| What you see | What to do |
| --- | --- |
| Logs say `MOULDCARE_SECRET must be at least 32 characters` | In **Environment**, make sure `MOULDCARE_SECRET` exists. It should be generated automatically; if it's missing, add a long random value. |
| Logs say `MOULDCARE_ADMIN_PASSWORD must have at least 12 characters` | Set a longer password in **Environment**; Render redeploys automatically. |
| "Invalid credentials" when signing in | Check the email matches `MOULDCARE_ADMIN_EMAIL` exactly. After five wrong tries, sign-in for that email is blocked for 15 minutes. |
| The site shows an error page right after deploying | Wait until the status is **Live**; the first start takes a minute. |
