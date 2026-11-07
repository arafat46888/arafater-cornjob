# ⚡ PulseKeep — Personal Keep-Alive & Uptime Pinger

A lightweight, production-ready **uptime pinger & keep-alive dashboard** built for
[Render's free tier](https://render.com) (works anywhere else too). It pings your
services on a schedule so they never spin down, and gives you a real-time
**dark glassmorphism** dashboard with live countdowns, latency meters, status
badges and an activity log drawer.

| Layer      | Tech                                                        |
|------------|-------------------------------------------------------------|
| Backend    | Node.js 18+, Express.js                                      |
| Storage    | MongoDB Atlas via Mongoose (`MONGO_URI`) — auto-falls back to a local JSON file (lowdb) when unset |
| Frontend   | Vanilla JS SPA, CSS3 glassmorphism, Lucide icons             |
| Scheduler  | In-memory tick loop + async bounded worker pool (slow pings never block other jobs) |
| Auth       | Master password → persistent signed JWT (10-year expiry), rate-limited login |

---

## Features

- **Self-Pinger** — hits its own `/api/healthz` every **10–13 minutes** (randomized) so Render never idles the instance. Configure with `APP_URL`.
- **Multi-target manager** — add / edit / pause-resume / delete targets; intervals `1m, 2m, 5m, 10m, 15m, 30m, 1h`; methods `HEAD` or `GET`.
- **Ping Now** — immediate manual test that does **not** reset the interval schedule.
- **Live dashboard** — per-target ticking countdown ("Next ping in: 00:43"), last ping time, HTTP status, latency meter, OK/Fail counters, global metrics (total targets, active pings, requests sent, average response time).
- **Status badges** — 🟢 Active (2xx/3xx) · 🟡 Degraded (>2.5 s) · 🔴 Down/Error/Timeout · ⚪ Paused.
- **Activity drawer** — collapsible panel with the last 50 ping logs (time, target, status, latency, error).
- **Never auto-logout** — token stored in `localStorage`, attached as `Authorization: Bearer <token>`; sessions survive refresh/browser restart and end **only** when you click Logout.
- **Brute-force protection** — max **5 failed logins / 15 min / IP** on `/api/login`.
- **Graceful failures** — DNS errors, refused connections, TLS issues and timeouts are recorded as failures and can never crash the server.

---

## Quick start (local)

```bash
npm install
cp .env.example .env     # optional — sensible defaults exist
npm start                # http://localhost:3000
```

Default master password: `ARAFAT168642` (override with `AUTH_MASTER_KEY`).

---

## Environment variables

| Variable         | Required | Default          | Purpose |
|------------------|----------|------------------|---------|
| `PORT`           | no (Render injects it) | `3000` | HTTP port |
| `APP_URL`        | **yes on Render** | – | Public URL of this app; enables the self-pinger (`APP_URL/api/healthz`) |
| `AUTH_MASTER_KEY`| recommended | `ARAFAT168642` | Single master password for login |
| `JWT_SECRET`     | recommended | derived from master key | Signing secret. Set it, otherwise tokens invalidate after each redeploy/restart |
| `MONGO_URI`      | recommended | – (uses `data/db.json`) | MongoDB Atlas connection string for durable storage |

---

## 🚀 Deploy to Render (free tier)

1. Push this repository to GitHub.
2. Render Dashboard → **New → Web Service** → connect the repo.
   - **Runtime:** Node
   - **Build command:** `npm install` (or leave empty — Render runs `npm ci` automatically when a lockfile exists)
   - **Start command:** `npm start`
3. Under **Environment**, add:

   | Key | Value |
   |-----|-------|
   | `AUTH_MASTER_KEY` | your strong password |
   | `JWT_SECRET` | any long random string (e.g. output of `openssl rand -hex 32`) |
   | `APP_URL` | `https://<your-service>.onrender.com` (the URL Render gives you) |
   | `MONGO_URI` | your MongoDB Atlas srv string *(optional but recommended)* |

4. **Deploy.** Once live, open the URL, log in with the master password, and add
   your services (including this app's own URL if you like double coverage).
5. The **self-pinger** keeps the instance warm by requesting
   `APP_URL/api/healthz` every 10–13 minutes — no external cron needed.

> 💡 Free-tier filesystems are ephemeral: without `MONGO_URI` your targets are
> re-created from scratch after each deploy/restart. A free MongoDB Atlas cluster
> makes all targets, stats and logs permanent.

---

## API reference

| Method & path | Auth | Description |
|---------------|------|-------------|
| `POST /api/login` | public (rate-limited 5 fails/15 min) | `{ "password": "..." }` → `{ token }` (10-year JWT) |
| `GET /api/healthz` | public | Liveness + engine health (used by self-pinger) |
| `GET /api/targets` | Bearer | All targets with live status, next-run times, global stats, last 50 logs |
| `POST /api/targets` | Bearer | Create `{ name, url, intervalSec, method }` and start scheduling |
| `PUT /api/targets/:id` | Bearer | Update fields and/or `{ paused: true/false }` — re-schedules instantly |
| `DELETE /api/targets/:id` | Bearer | Remove target and stop its job |
| `POST /api/targets/:id/ping` | Bearer | Immediate manual ping (schedule untouched) |

---

## Project structure

```
server.js          Express app, auth, rate limiting, REST API, static hosting
lib/pinger.js      Scheduler + async worker pool + self-pinger + HTTP probe
lib/store.js       Persistence (Mongoose ⇄ lowdb fallback, same interface)
public/index.html  SPA markup (login + dashboard)
public/style.css   Dark glassmorphism theme, responsive & touch-friendly
public/app.js      UI controller: polling, live countdowns, actions, session
data/db.json       Local storage (auto-created when MONGO_URI is unset)
.env.example       Environment variable template
```

## Notes & troubleshooting

- **Logged out after redeploy?** You set no `JWT_SECRET`, so tokens were derived
  from the master key and rotated at boot. Set a fixed `JWT_SECRET` on Render.
- **Targets vanished after restart?** Set `MONGO_URI` (Render's disk isn't persistent).
- **Login locked for 15 minutes?** That's the brute-force limiter working — wait, or check `RateLimit-*` response headers.
- **Pings show `ERR (EAI_AGAIN)`** — transient DNS hiccup on the host; recorded as a failure and retried on schedule.
