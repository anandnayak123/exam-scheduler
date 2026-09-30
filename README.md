# Exam Prep & Skill Scheduler

Node + Postgres backend (real login, saved progress, admin, Brevo email reminders) with the website in `public/`.
One Render web service serves both the API and the site.

## 1. Database (free Postgres)
Render's free Postgres has expired after 30 days at the time of writing, so use a free external one such as Neon or Supabase.
Create a database and copy its connection string. This is `DATABASE_URL`. Tables are created automatically.

## 2. Brevo (emails)
1. Brevo > Senders & IP > add and verify the email address you will send from. This is `BREVO_SENDER`.
2. Brevo > SMTP & API > API keys > create a key. This is `BREVO_API_KEY`.

## 3. GitHub
Create a private repo and upload this folder (without node_modules). `.gitignore` is included.

## 4. Render
New > Web Service > pick the repo.
- Build command: `npm install`
- Start command: `npm start`
- Environment: add every variable from `.env.example` (make JWT_SECRET and CRON_SECRET long random strings).
- Health check path: `/healthz`

Open the Render URL, create the first account. It becomes the admin. Optionally set `ADMIN_USERNAME` to pick a different admin name.

## 5. Daily email reminders
Free Render services sleep when idle, so an in-app timer would not fire. Use a free scheduler such as cron-job.org:
- URL: `https://YOUR-APP.onrender.com/api/cron/daily?key=YOUR_CRON_SECRET`
- Schedule: every day at 07:00 (the app's timezone is `TZ_NAME`, default Asia/Kolkata)

Each user gets one email a day listing topics to learn and the day 1/3/7/15/25/30 revisions that are due.
They also get an email with the revision dates when they mark a topic learned.
The "Email me today's plan" button on the Today page sends a test email at once.

## 6. Optional: host the pages on InfinityFree
Not required, since Render already serves the site. If you want it:
1. Upload everything inside `public/` to `htdocs`.
2. Edit `config.js`: `window.API_BASE='https://YOUR-APP.onrender.com';`
3. On Render set `FRONTEND_ORIGIN=https://your-site.infinityfreeapp.com`

## Run locally
`npm install`, set the variables from `.env.example` in your shell, then `npm start`.
