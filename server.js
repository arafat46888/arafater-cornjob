/**
 * server.js — Keep-Alive & Uptime Pinger (Express API + static SPA)
 * ------------------------------------------------------------------
 * Run:  npm start        (Node >= 18)
 * Env:  PORT, APP_URL, AUTH_MASTER_KEY, JWT_SECRET, MONGO_URI  (see .env.example)
 */

'use strict';

// Tiny zero-dependency .env loader (so local dev works without dotenv).
require('fs')
  .existsSync(require('path').join(__dirname, '.env')) &&
  require('fs')
    .readFileSync(require('path').join(__dirname, '.env'), 'utf8')
    .split(/\r?\n/)
    .forEach((line) => {
      const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
      if (m && process.env[m[1]] === undefined) {
        let v = (m[2] || '').trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
        process.env[m[1]] = v;
      }
    });

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');

const { createStore } = require('./lib/store');
const { PingerEngine, ALLOWED_INTERVALS } = require('./lib/pinger');

/* ------------------------------ config ------------------------------ */

const PORT = process.env.PORT || 3000;
const MASTER_KEY = process.env.AUTH_MASTER_KEY || 'ARAFAT168642';
// Stable-ish secret: explicit JWT_SECRET > derived from master key.
// (Set JWT_SECRET on Render so tokens survive restarts.)
const JWT_SECRET = process.env.JWT_SECRET || crypto.createHash('sha256').update('keepalive::' + MASTER_KEY).digest('hex');

// ~10 years. Effectively "never expires" per product requirement.
const TOKEN_EXPIRES_IN = '3650d';

/* ------------------------------ app ------------------------------ */

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // Render sits behind a proxy; needed for rate-limit IPs
app.use(express.json({ limit: '64kb' }));

/* --------------------------- auth helpers --------------------------- */

function signToken() {
  return jwt.sign({ sub: 'master', role: 'owner' }, JWT_SECRET, { expiresIn: TOKEN_EXPIRES_IN });
}

function requireAuth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7).trim() : null;
  if (!token) return res.status(401).json({ error: 'Missing token' });
  try {
    jwt.verify(token, JWT_SECRET);
    return next();
  } catch (err) {
    const msg = err && err.name === 'TokenExpiredError' ? 'Session expired' : 'Invalid token';
    return res.status(401).json({ error: msg });
  }
}

/* ------------------------- constant-time compare ------------------------- */

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/* ------------------------------ routes ------------------------------ */

// PUBLIC — health endpoint used by the self-pinger & external uptime checks.
app.get('/api/healthz', (req, res) => {
  res.json({
    ok: true,
    service: 'keepalive-pinger',
    now: Date.now(),
    uptimeSec: Math.floor(process.uptime()),
    engine: engine ? engine.health() : null,
  });
});

// Rate limiter: max 5 failed login attempts / 15 min / IP.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true, // only FAILED attempts count toward the limit
  message: { error: 'Too many failed attempts. Try again in 15 minutes.' },
});

app.post('/api/login', loginLimiter, (req, res) => {
  const password = typeof req.body && typeof req.body.password === 'string' ? req.body.password : '';
  if (!password || !safeEqual(password, MASTER_KEY)) {
    return res.status(401).json({ error: 'Incorrect master password' });
  }
  return res.json({ token: signToken(), expiresIn: TOKEN_EXPIRES_IN });
});

// Everything below requires the persistent bearer token.
let store, engine; // initialized in boot(); route handlers close over these

const authed = express.Router();
authed.use(requireAuth);

/** Validate & normalize a target payload. Returns { error } or { data }. */
function validateTarget(body, partial) {
  const out = {};
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 80) : '';
  const rawUrl = typeof body.url === 'string' ? body.url.trim() : '';
  if (!partial || body.name !== undefined) {
    if (!name) return { error: 'Name is required' };
    out.name = name;
  }
  if (!partial || body.url !== undefined) {
    let u;
    try {
      u = new URL(rawUrl);
    } catch {
      return { error: 'Enter a valid URL including http(s)://' };
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return { error: 'Only http/https URLs are supported' };
    out.url = u.toString();
  }
  if (body.intervalSec !== undefined) {
    const iv = Number(body.intervalSec);
    if (!ALLOWED_INTERVALS.includes(iv)) return { error: 'Invalid interval' };
    out.intervalSec = iv;
  }
  if (body.method !== undefined) {
    const m = String(body.method).toUpperCase();
    if (m !== 'GET' && m !== 'HEAD') return { error: 'Method must be GET or HEAD' };
    out.method = m;
  }
  if (body.paused !== undefined) out.paused = !!body.paused;
  return { data: out };
}

/** Merge live runtime schedule into an API-facing target object. */
function withRuntime(t) {
  const rt = engine.getRuntime(t.id);
  // Runtime is authoritative: paused targets report nextRunAt = null so the
  // UI countdown never shows a stale scheduled time.
  return Object.assign({}, t, { nextRunAt: rt.nextRunAt, pinging: rt.inFlight });
}

// GET /api/targets — all targets + global counters + recent logs
authed.get('/targets', async (req, res, next) => {
  try {
    const [targets, counters, logs] = await Promise.all([
      store.listTargets(),
      store.getCounters(),
      store.getLogs(50),
    ]);
    const avg = counters.latencySamples > 0 ? Math.round(counters.totalLatency / counters.latencySamples) : 0;
    res.json({
      serverTime: Date.now(),
      targets: targets.map(withRuntime),
      stats: {
        total: targets.length,
        active: targets.filter((t) => !t.paused).length,
        paused: targets.filter((t) => t.paused).length,
        sent: counters.sent,
        success: counters.success,
        fail: counters.fail,
        avgLatencyMs: avg,
      },
      logs,
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/targets — create + schedule
authed.post('/targets', async (req, res, next) => {
  try {
    const v = validateTarget(req.body || {}, false);
    if (v.error) return res.status(400).json({ error: v.error });
    const doc = Object.assign(
      { method: 'HEAD', intervalSec: 300, paused: false, okCount: 0, failCount: 0 },
      v.data
    );
    const created = await store.createTarget(doc);
    engine.addSchedule(created.id, created.paused);
    res.status(201).json({ target: withRuntime(created) });
  } catch (err) {
    next(err);
  }
});

// PUT /api/targets/:id — update fields and/or pause/resume (re-schedules)
authed.put('/targets/:id', async (req, res, next) => {
  try {
    const existing = await store.getTarget(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Target not found' });
    const v = validateTarget(req.body || {}, true);
    if (v.error) return res.status(400).json({ error: v.error });
    const updated = await store.updateTarget(existing.id, v.data);
    if (!updated) return res.status(404).json({ error: 'Target not found' });
    engine.reschedule(updated.id, { intervalSec: updated.intervalSec, paused: updated.paused });
    res.json({ target: withRuntime(updated) });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/targets/:id
authed.delete('/targets/:id', async (req, res, next) => {
  try {
    const removed = await store.deleteTarget(req.params.id);
    engine.removeSchedule(req.params.id);
    if (!removed) return res.status(404).json({ error: 'Target not found' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/targets/:id/ping — immediate manual ping, schedule untouched
authed.post('/targets/:id/ping', async (req, res, next) => {
  try {
    const existing = await store.getTarget(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Target not found' });
    engine.pingNow(existing.id);
    res.json({ ok: true, queued: true });
  } catch (err) {
    next(err);
  }
});

app.use('/api', authed);

// Static SPA
app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html', maxAge: '1h' }));

// SPA fallback for any non-API GET
app.get(/^\/(?!api\/).*/, (req, res, next) => {
  if (req.method !== 'GET') return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 404 for unknown API routes
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// Centralized error handler — never leak stack, never crash.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[server] unhandled error:', err && err.message);
  if (res.headersSent) return;
  res.status(500).json({ error: 'Internal server error' });
});

/* ------------------------------ boot ------------------------------ */

async function boot() {
  store = await createStore();
  engine = new PingerEngine(store);
  await engine.start();
  const server = app.listen(PORT, () => {
    console.log(`[server] Keep-Alive Pinger listening on port ${PORT}`);
    if (!process.env.APP_URL) console.log('[server] Tip: set APP_URL to enable the self-pinger on Render.');
  });

  const shutdown = (sig) => {
    console.log(`[server] ${sig} received, shutting down gracefully...`);
    engine.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => console.error('[server] unhandledRejection:', reason));
  process.on('uncaughtException', (err) => console.error('[server] uncaughtException:', err && err.stack));
}

boot().catch((err) => {
  console.error('[server] fatal boot error:', err);
  process.exit(1);
});

module.exports = app;
