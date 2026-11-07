/**
 * pinger.js — Dynamic in-memory scheduling + async ping worker
 * ------------------------------------------------------------------
 * Design goals:
 *  - One lightweight "tick" loop (1s) decides which jobs are due; it never
 *    performs network I/O itself, so a slow/hanging ping can NEVER block
 *    other scheduled jobs. Due jobs are dispatched into an async queue with
 *    bounded concurrency.
 *  - Every HTTP request has a hard timeout and full error handling
 *    (DNS failure, refused connection, TLS errors, timeouts => recorded as
 *    failures, server keeps running).
 *  - Manual "Ping Now" runs immediately without resetting the schedule.
 */

'use strict';

const http = require('http');
const https = require('https');
const { URL } = require('url');

const PING_TIMEOUT_MS = 15000;      // hard per-request timeout
const MAX_CONCURRENT_PINGS = 6;     // bounded worker pool
const DEGRADED_LATENCY_MS = 2500;   // above this => yellow "degraded" badge
const ALLOWED_INTERVALS = [60, 120, 300, 600, 900, 1800, 3600];

class PingerEngine {
  /**
   * @param {object} store  persistence instance from lib/store.js
   */
  constructor(store) {
    this.store = store;
    /** runtime state per target id: { nextRunAt, inFlight } */
    this.jobs = new Map();
    this.queue = [];
    this.running = 0;
    this.tickTimer = null;
    this.selfPingerTimer = null;
    this.startedAt = Date.now();
    this.totalSelfPings = 0;
  }

  /* ------------------------- lifecycle ------------------------- */

  async start() {
    // Hydrate schedules from persisted targets.
    const targets = await this.store.listTargets();
    for (const t of targets) {
      if (!t.paused) {
        // Stagger first run a few seconds after boot to avoid a thundering herd.
        this.jobs.set(t.id, { nextRunAt: Date.now() + 3000 + Math.floor(Math.random() * 4000) });
      } else {
        this.jobs.set(t.id, { nextRunAt: null });
      }
    }
    this.tickTimer = setInterval(() => this._tick(), 1000);
    this._startSelfPinger();
    console.log(`[pinger] Engine started with ${targets.length} target(s).`);
  }

  stop() {
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.selfPingerTimer) clearTimeout(this.selfPingerTimer);
    this.tickTimer = null;
    this.selfPingerTimer = null;
  }

  /** Register a newly created target's schedule (first ping fires soon). */
  addSchedule(id, paused) {
    this.jobs.set(id, { nextRunAt: paused ? null : Date.now() + 2000 });
    this._persistNextRun(id, paused ? null : Date.now() + 2000);
  }

  /** Called after interval change or pause/resume. */
  reschedule(id, { intervalSec, paused }) {
    const job = this.jobs.get(id) || {};
    // Refresh the cached interval so the tick loop advances with the new cadence.
    this._intervalCache = this._intervalCache || {};
    this._intervalCache[id] = { intervalSec };
    if (paused) {
      // Stop firing and clear the schedule everywhere (API + DB).
      job.nextRunAt = null;
      this.jobs.set(id, job);
      this._persistNextRun(id, null);
    } else {
      const iv = ALLOWED_INTERVALS.includes(intervalSec) ? intervalSec : 300;
      job.nextRunAt = Date.now() + iv * 1000;
      this.jobs.set(id, job);
      this._persistNextRun(id, job.nextRunAt);
    }
  }

  removeSchedule(id) {
    this.jobs.delete(id);
    if (this._intervalCache) delete this._intervalCache[id];
  }

  _persistNextRun(id, nextRunAt) {
    this.store.updateTarget(id, { nextRunAt: nextRunAt || null }).catch(() => {});
  }

  /* ------------------------- tick / queue ------------------------- */

  _tick() {
    const now = Date.now();
    for (const [id, job] of this.jobs) {
      if (job.nextRunAt && now >= job.nextRunAt && !job.inFlight) {
        // Advance the schedule FIRST so a slow ping doesn't delay accounting
        // and manual pings never reset the cadence.
        const target = this._intervalCache && this._intervalCache[id];
        const iv = (target && target.intervalSec) || 300;
        job.nextRunAt = now + iv * 1000;
        this._persistNextRun(id, job.nextRunAt);
        this._enqueue(id, false);
      }
    }
    this._drain();
  }

  _enqueue(id, manual) {
    this.queue.push({ id, manual });
    this._drain();
  }

  _drain() {
    while (this.running < MAX_CONCURRENT_PINGS && this.queue.length > 0) {
      const item = this.queue.shift();
      this.running += 1;
      this._runPing(item.id, item.manual)
        .catch((err) => console.error('[pinger] unexpected worker error:', err && err.message))
        .finally(() => {
          this.running -= 1;
          this._drain();
        });
    }
  }

  /** Manual ping: fires immediately, does NOT touch nextRunAt. */
  pingNow(id) {
    this._enqueue(id, true);
  }

  /* ------------------------- core ping ------------------------- */

  async _runPing(id, manual) {
    const target = await this.store.getTarget(id);
    if (!target) return; // deleted while queued
    if (target.paused && !manual) return;

    // Cache interval for the tick loop's schedule advance.
    this._intervalCache = this._intervalCache || {};
    this._intervalCache[id] = { intervalSec: target.intervalSec };

    const job = this.jobs.get(id) || {};
    job.inFlight = true;
    this.jobs.set(id, job);

    let status = null;
    let latencyMs = null;
    let error = null;
    const started = Date.now();

    try {
      status = await this._httpRequest(target.url, target.method || 'HEAD', PING_TIMEOUT_MS);
      latencyMs = Date.now() - started;
      if (status < 200 || status >= 400) error = `HTTP ${status}`;
    } catch (err) {
      latencyMs = Date.now() - started;
      status = err && err.name === 'TimeoutError' ? 0 : null;
      error = (err && err.message) || 'Request failed';
      if (latencyMs >= PING_TIMEOUT_MS - 100) status = 0; // treat as timeout
    } finally {
      job.inFlight = false;
    }

    const ok = status !== null && status >= 200 && status < 400;

    // Persist stats (best-effort; must not crash engine on DB hiccup).
    try {
      await this.store.updateTarget(id, {
        lastPingAt: Date.now(),
        lastStatus: status == null ? null : status,
        lastLatencyMs: latencyMs,
        lastError: ok ? null : error,
        okCount: target.okCount + (ok ? 1 : 0),
        failCount: target.failCount + (ok ? 0 : 1),
      });
      await this.store.bumpCounters({
        sent: 1,
        success: ok ? 1 : 0,
        fail: ok ? 0 : 1,
        totalLatency: latencyMs,
      });
      await this.store.addLog({
        targetId: id,
        targetName: target.name,
        status: status == null ? 'ERR' : status,
        latencyMs,
        error: ok ? null : error,
        manual: !!manual,
      });
    } catch (dbErr) {
      console.error('[pinger] persist failed:', dbErr.message);
    }
  }

  /**
   * Minimal dependency-free HTTP(S) probe using Node core modules.
   * Resolves with the status code; rejects on network/timeout errors.
   */
  _httpRequest(rawUrl, method, timeoutMs) {
    return new Promise((resolve, reject) => {
      let u;
      try {
        u = new URL(rawUrl);
      } catch {
        return reject(new Error('Invalid URL'));
      }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        return reject(new Error('Unsupported protocol'));
      }
      const lib = u.protocol === 'https:' ? https : http;
      const req = lib.request(
        {
          method: method === 'GET' ? 'GET' : 'HEAD',
          hostname: u.hostname,
          port: u.port || (u.protocol === 'https:' ? 443 : 80),
          path: u.pathname + u.search,
          headers: {
            'User-Agent': 'KeepAlivePinger/1.0 (+uptime monitor)',
            Accept: '*/*',
          },
          timeout: timeoutMs,
          servername: u.hostname, // SNI for IP-less vhosts
        },
        (res) => {
          // Drain a tiny bit of the body so sockets recycle cleanly.
          res.on('data', () => {});
          res.on('end', () => {});
          resolve(res.statusCode);
        }
      );
      req.on('timeout', () => {
        req.destroy(Object.assign(new Error('Timeout'), { name: 'TimeoutError' }));
      });
      req.on('error', (err) => {
        if (err && err.name === 'TimeoutError') return reject(err);
        reject(new Error(normalizeNetError(err)));
      });
      req.end();
    });
  }

  /* ------------------------- self-pinger ------------------------- */

  _startSelfPinger() {
    const appUrl = (process.env.APP_URL || '').trim().replace(/\/+$/, '');
    if (!appUrl) {
      console.log('[pinger] APP_URL not set — self-pinger disabled (fine for local dev).');
      return;
    }
    const scheduleNext = () => {
      // Random 10–13 minutes to look organic and dodge fixed-cadence issues.
      const delay = (10 + Math.random() * 3) * 60 * 1000;
      this.selfPingerTimer = setTimeout(async () => {
        try {
          const code = await this._httpRequest(appUrl + '/api/healthz', 'GET', 15000);
          this.totalSelfPings += 1;
          console.log(`[pinger] self-ping -> ${code}`);
        } catch (err) {
          console.warn('[pinger] self-ping failed:', err.message);
        } finally {
          scheduleNext();
        }
      }, delay);
      if (this.selfPingerTimer.unref) this.selfPingerTimer.unref();
    };
    scheduleNext();
    console.log(`[pinger] Self-pinger active for ${appUrl}/api/healthz every 10-13 min.`);
  }

  /* ------------------------- helpers for API ------------------------- */

  /** Snapshot of live schedule info merged over stored target docs. */
  getRuntime(id) {
    const job = this.jobs.get(id);
    return { nextRunAt: job && job.nextRunAt ? job.nextRunAt : null, inFlight: !!(job && job.inFlight) };
  }

  health() {
    return {
      uptimeSec: Math.floor((Date.now() - this.startedAt) / 1000),
      scheduledJobs: this.jobs.size,
      inQueue: this.queue.length,
      runningWorkers: this.running,
      selfPings: this.totalSelfPings,
    };
  }
}

function normalizeNetError(err) {
  const code = err && err.code;
  switch (code) {
    case 'ENOTFOUND':
      return 'DNS lookup failed (ENOTFOUND)';
    case 'ECONNREFUSED':
      return 'Connection refused (ECONNREFUSED)';
    case 'ECONNRESET':
      return 'Connection reset (ECONNRESET)';
    case 'ETIMEDOUT':
      return 'Connection timed out (ETIMEDOUT)';
    case 'EAI_AGAIN':
      return 'Temporary DNS failure (EAI_AGAIN)';
    default:
      if (code && /TLS|SSL|CERT/i.test(String(code))) return `TLS error (${code})`;
      return (err && err.message) || 'Network error';
  }
}

module.exports = { PingerEngine, ALLOWED_INTERVALS, DEGRADED_LATENCY_MS, PING_TIMEOUT_MS };
