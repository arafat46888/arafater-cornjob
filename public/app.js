/* ==================================================================
   PulseKeep — vanilla JS SPA controller
   ------------------------------------------------------------------
   * Token lives in localStorage; session NEVER auto-expires.
   * Polls /api/targets every 5s; countdowns tick locally every 1s
     using server-provided nextRunAt + a computed clock offset.
   ================================================================== */

'use strict';

const TOKEN_KEY = 'pulsekeep_token';

/* ------------------------------ state ------------------------------ */

let token = localStorage.getItem(TOKEN_KEY) || null;
let targets = [];
let stats = { total: 0, active: 0, sent: 0, avgLatencyMs: 0 };
let clockOffset = 0;          // serverTime - Date.now()
let lastLogsJson = '';
let pollTimer = null;
let uiTimer = null;
let connected = false;

const INTERVALS = [60, 120, 300, 600, 900, 1800, 3600];
const DEGRADED_MS = 2500;

/* ------------------------------ dom ------------------------------ */

const $ = (id) => document.getElementById(id);
const loginView = $('login-view');
const dashView = $('dash-view');

/* ---------------------------- helpers ----------------------------- */

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function fmtCountdown(ms) {
  if (ms <= 0) return '00:00';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

function fmtAgo(ts) {
  if (!ts) return 'never';
  const d = Math.max(0, serverNow() - ts);
  const s = Math.floor(d / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function fmtClock(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour12: false });
}

function serverNow() {
  return Date.now() + clockOffset;
}

function statusClass(t) {
  if (t.paused) return 'paused';
  if (t.lastStatus == null) return 'pending';
  const okRange = t.lastStatus >= 200 && t.lastStatus < 400;
  if (!okRange) return 'down';
  if (t.lastLatencyMs != null && t.lastLatencyMs > DEGRADED_MS) return 'degraded';
  return 'up';
}

function badgeFor(t) {
  const sc = statusClass(t);
  switch (sc) {
    case 'paused': return { cls: 'b-paused', label: 'Paused' };
    case 'down': return { cls: 'b-down', label: t.lastStatus === 0 ? 'Timeout' : `Down · ${t.lastStatus}` };
    case 'degraded': return { cls: 'b-degraded', label: `Degraded · ${t.lastStatus}` };
    case 'pending': return { cls: 'b-paused', label: 'Pending' };
    default: return { cls: 'b-active', label: `Active · ${t.lastStatus}` };
  }
}

function accentColor(t) {
  const sc = statusClass(t);
  return { up: '#34d399', degraded: '#fbbf24', down: '#f87171', paused: '#6b7280', pending: '#6b7280' }[sc];
}

function latColor(ms) {
  if (ms == null) return 'var(--gray)';
  if (ms < 800) return 'var(--green)';
  if (ms <= DEGRADED_MS) return 'var(--yellow)';
  return 'var(--red)';
}

function iconsRefresh() {
  try { if (window.lucide && lucide.createIcons) lucide.createIcons(); } catch (_) {}
}

/* ------------------------------ api ------------------------------ */

async function api(path, opts = {}) {
  const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch('/api' + path, Object.assign({}, opts, { headers }));
  let body = {};
  try { body = await res.json(); } catch (_) {}
  if (res.status === 401) {
    // Only explicit logout clears the token; a 401 means invalid token.
    handleAuthFailure(body.error);
    throw new Error(body.error || 'Unauthorized');
  }
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

function handleAuthFailure(msg) {
  stopTimers();
  localStorage.removeItem(TOKEN_KEY);
  token = null;
  showLogin(msg || 'Session invalid — please log in again.');
}

/* --------------------------- view switching ------------------------ */

function showLogin(errMsg) {
  dashView.classList.add('hidden');
  loginView.classList.remove('hidden');
  const el = $('login-error');
  if (errMsg) { el.textContent = errMsg; el.classList.remove('hidden'); }
  else el.classList.add('hidden');
  setTimeout(() => $('password').focus(), 50);
  iconsRefresh();
}

function showDash() {
  loginView.classList.add('hidden');
  dashView.classList.remove('hidden');
  iconsRefresh();
  refresh().then(() => {
    startTimers();
  });
}

function startTimers() {
  stopTimers();
  pollTimer = setInterval(refresh, 5000);
  uiTimer = setInterval(tickUI, 1000);
}

function stopTimers() {
  if (pollTimer) clearInterval(pollTimer);
  if (uiTimer) clearInterval(uiTimer);
  pollTimer = uiTimer = null;
}

/* ------------------------------ data ----------------------------- */

async function refresh() {
  try {
    const data = await api('/targets');
    connected = true;
    clockOffset = data.serverTime - Date.now();
    targets = data.targets || [];
    stats = data.stats || stats;
    renderMetrics();
    renderTargets();
    renderLogs(data.logs || []);
    setConn(true);
  } catch (err) {
    if (String(err.message).match(/Unauthorized|invalid|expired/i)) return; // handled
    connected = false;
    setConn(false);
  }
}

function setConn(okFlag) {
  const dot = $('conn-dot'), lbl = $('conn-label');
  dot.className = 'dot ' + (okFlag ? 'dot-green' : 'dot-red');
  lbl.textContent = okFlag ? 'Live' : 'Reconnecting…';
}

/* ------------------------------ render ---------------------------- */

function renderMetrics() {
  $('m-total').textContent = stats.total;
  $('m-active').textContent = stats.active;
  $('m-sent').textContent = stats.sent.toLocaleString();
  $('m-avg').textContent = stats.avgLatencyMs ? `${stats.avgLatencyMs} ms` : '–';
  $('hdr-pings').textContent = stats.sent.toLocaleString();
}

function cardHtml(t) {
  const b = badgeFor(t);
  const ivLabel = t.intervalSec >= 3600 ? '1 h' : `${t.intervalSec / 60} m`;
  const latPct = t.lastLatencyMs == null ? 0 : Math.min(100, Math.round((t.lastLatencyMs / 5000) * 100));
  const errLine = t.lastError && !t.paused ? `<p class="err-msg">⚠ ${esc(t.lastError)}</p>` : '';
  return `
  <article class="target-card glass" data-id="${esc(t.id)}" style="--accent:${accentColor(t)}">
    <div class="tc-head">
      <div>
        <div class="tc-title">${esc(t.name)}</div>
        <a class="tc-url" href="${esc(t.url)}" target="_blank" rel="noopener noreferrer">${esc(t.url)}</a>
      </div>
      <span class="badge ${b.cls}" data-role="badge"><span class="dot"></span>${esc(b.label)}</span>
    </div>
    ${errLine}
    <div class="tc-countdown">
      <div>
        <div class="cd-label">Next ping in</div>
        <div class="cd-time mono" data-role="countdown">--:--</div>
      </div>
      <div style="text-align:right">
        <div class="cd-label">Every</div>
        <div class="tiny mono">${ivLabel} · ${esc(t.method)}</div>
        <div class="cd-label" style="margin-top:4px">Last ping</div>
        <div class="tiny mono" data-role="lastping">${fmtAgo(t.lastPingAt)}</div>
      </div>
    </div>
    <div class="tc-stats">
      <div class="stat"><b class="mono" data-role="status">${t.lastStatus == null ? '–' : (t.lastStatus === 0 ? 'TO' : t.lastStatus)}</b><span>Status</span></div>
      <div class="stat"><b class="mono" data-role="latency" style="color:${latColor(t.lastLatencyMs)}">${t.lastLatencyMs == null ? '–' : t.lastLatencyMs + 'ms'}</b><span>Latency</span></div>
      <div class="stat"><b class="mono ok-val">${t.okCount}</b><span>OK</span></div>
      <div class="stat"><b class="mono fail-val">${t.failCount}</b><span>Fail</span></div>
    </div>
    <div class="lat-meter"><div class="lat-fill" data-role="latbar" style="width:${latPct}%;background:${latColor(t.lastLatencyMs)}"></div></div>
    <div class="tc-actions">
      <button class="btn btn-icon" data-action="pause" title="${t.paused ? 'Resume' : 'Pause'}">
        <i data-lucide="${t.paused ? 'play' : 'pause'}"></i>
      </button>
      <button class="btn btn-icon" data-action="pingnow" title="Ping Now">
        <i data-lucide="send"></i>
      </button>
      <button class="btn btn-icon" data-action="edit" title="Edit">
        <i data-lucide="pencil"></i>
      </button>
      <span class="spacer"></span>
      <button class="btn btn-icon btn-danger" data-action="delete" title="Delete">
        <i data-lucide="trash-2"></i>
      </button>
    </div>
  </article>`;
}

function renderTargets() {
  const grid = $('targets-grid');
  const empty = $('empty-state');
  if (!targets.length) {
    grid.innerHTML = '';
    empty.classList.remove('hidden');
    iconsRefresh();
    return;
  }
  empty.classList.add('hidden');
  // Re-render fully only when the id-set changes; otherwise patch in place.
  const domIds = Array.from(grid.querySelectorAll('.target-card')).map((c) => c.dataset.id).join(',');
  const dataIds = targets.map((t) => t.id).join(',');
  if (domIds !== dataIds) {
    grid.innerHTML = targets.map(cardHtml).join('');
    iconsRefresh();
  } else {
    // Update dynamic bits that don't need full rebuild (badge, stats after poll).
    for (const t of targets) {
      const card = grid.querySelector(`.target-card[data-id="${t.id}"]`);
      if (!card) continue;
      const b = badgeFor(t);
      const badge = card.querySelector('[data-role="badge"]');
      if (badge) { badge.className = 'badge ' + b.cls; badge.innerHTML = `<span class="dot"></span>${esc(b.label)}`; }
      card.style.setProperty('--accent', accentColor(t));
      const st = card.querySelector('[data-role="status"]');
      if (st) st.textContent = t.lastStatus == null ? '–' : (t.lastStatus === 0 ? 'TO' : String(t.lastStatus));
      const lat = card.querySelector('[data-role="latency"]');
      if (lat) { lat.textContent = t.lastLatencyMs == null ? '–' : t.lastLatencyMs + 'ms'; lat.style.color = latColor(t.lastLatencyMs); }
      const bar = card.querySelector('[data-role="latbar"]');
      if (bar) {
        bar.style.width = (t.lastLatencyMs == null ? 0 : Math.min(100, Math.round((t.lastLatencyMs / 5000) * 100))) + '%';
        bar.style.background = latColor(t.lastLatencyMs);
      }
      const pauseBtn = card.querySelector('[data-action="pause"]');
      if (pauseBtn) pauseBtn.title = t.paused ? 'Resume' : 'Pause';
    }
  }
  tickUI();
}

/* Live per-second countdown without hitting the API. */
function tickUI() {
  const now = serverNow();
  $('server-clock').textContent = fmtClock(now);
  for (const t of targets) {
    const card = document.querySelector(`.target-card[data-id="${t.id}"]`);
    if (!card) continue;
    const cd = card.querySelector('[data-role="countdown"]');
    const lp = card.querySelector('[data-role="lastping"]');
    if (!cd) continue;
    if (t.paused) {
      cd.textContent = 'PAUSED';
      cd.className = 'cd-time mono paused';
    } else if (t.pinging) {
      cd.textContent = 'PINGING…';
      cd.className = 'cd-time mono pinging';
    } else if (t.nextRunAt) {
      cd.textContent = fmtCountdown(t.nextRunAt - now);
      cd.className = 'cd-time mono';
    } else {
      cd.textContent = '--:--';
      cd.className = 'cd-time mono paused';
    }
    if (lp) lp.textContent = fmtAgo(t.lastPingAt);
  }
}

function renderLogs(logs) {
  const json = JSON.stringify(logs.slice(0, 50));
  if (json === lastLogsJson) return;
  lastLogsJson = json;
  const list = $('logs-list');
  const emptyMsg = $('logs-empty');
  if (!logs.length) {
    list.innerHTML = '';
    emptyMsg.classList.remove('hidden');
    return;
  }
  emptyMsg.classList.add('hidden');
  list.innerHTML = logs.slice(0, 50).map((l) => {
    const code = l.status;
    const isNum = typeof code === 'number';
    const ok = isNum && code >= 200 && code < 400;
    const cls = ok ? 'ls-ok' : (isNum && code < 500 && code >= 400 ? 'ls-warn' : 'ls-err');
    const label = isNum ? String(code) : 'ERR';
    return `<li class="log-item">
      <span class="log-time mono">${new Date(l.ts).toLocaleTimeString([], { hour12: false })}</span>
      <span class="log-name" title="${esc(l.targetName)}">${l.manual ? '👆 ' : ''}${esc(l.targetName || '?')} ${l.error ? '· ' + esc(l.error) : ''}</span>
      <span class="log-status mono ${cls}">${label}</span>
      <span class="log-lat mono">${l.latencyMs == null ? '–' : l.latencyMs + 'ms'}</span>
    </li>`;
  }).join('');
}

/* ---------------------------- actions ----------------------------- */

async function doAction(fn, btn) {
  if (btn) { btn.disabled = true; try { await fn(); } finally { setTimeout(() => { btn.disabled = false; }, 400); } }
  else await fn();
}

$('targets-grid').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const card = btn.closest('.target-card');
  const id = card && card.dataset.id;
  if (!id) return;
  const t = targets.find((x) => x.id === id);
  const action = btn.dataset.action;

  try {
    if (action === 'pause') {
      await doAction(async () => { await api(`/targets/${id}`, { method: 'PUT', body: JSON.stringify({ paused: !t.paused }) }); await refresh(); }, btn);
    } else if (action === 'pingnow') {
      await doAction(async () => {
        await api(`/targets/${id}/ping`, { method: 'POST' });
        // optimistic UI, then quick re-poll to pick up the result
        const cd = card.querySelector('[data-role="countdown"]');
        if (cd && !t.paused) { cd.textContent = 'PINGING…'; cd.className = 'cd-time mono pinging'; }
        setTimeout(refresh, 1500);
      }, btn);
    } else if (action === 'edit') {
      openEditModal(t);
    } else if (action === 'delete') {
      if (!confirm(`Delete "${t.name}" and stop its schedule?`)) return;
      await doAction(async () => { await api(`/targets/${id}`, { method: 'DELETE' }); await refresh(); }, btn);
    }
  } catch (err) {
    alert(err.message || 'Action failed');
  }
});

/* Add target */
$('add-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const urlEl = $('add-url'), nameEl = $('add-name');
  const errEl = $('add-error');
  errEl.classList.add('hidden');
  const payload = {
    url: urlEl.value.trim(),
    name: nameEl.value.trim() || new URL(urlEl.value.trim()).hostname,
    intervalSec: Number($('add-interval').value),
    method: $('add-method').value,
  };
  const btn = $('add-btn');
  btn.disabled = true;
  try {
    await api('/targets', { method: 'POST', body: JSON.stringify(payload) });
    urlEl.value = ''; nameEl.value = '';
    await refresh();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
  } finally {
    btn.disabled = false;
  }
});

/* Edit modal */
function openEditModal(t) {
  $('edit-id').value = t.id;
  $('edit-name').value = t.name;
  $('edit-url').value = t.url;
  $('edit-interval').value = String(t.intervalSec);
  $('edit-method').value = t.method;
  $('edit-error').classList.add('hidden');
  $('modal-overlay').classList.remove('hidden');
  iconsRefresh();
}
function closeEditModal() { $('modal-overlay').classList.add('hidden'); }

$('edit-cancel').addEventListener('click', closeEditModal);
$('modal-overlay').addEventListener('click', (e) => { if (e.target.id === 'modal-overlay') closeEditModal(); });

$('edit-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = $('edit-id').value;
  const errEl = $('edit-error');
  errEl.classList.add('hidden');
  try {
    await api(`/targets/${id}`, {
      method: 'PUT',
      body: JSON.stringify({
        name: $('edit-name').value.trim(),
        url: $('edit-url').value.trim(),
        intervalSec: Number($('edit-interval').value),
        method: $('edit-method').value,
      }),
    });
    closeEditModal();
    await refresh();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
  }
});

/* Logs drawer */
$('logs-toggle').addEventListener('click', () => {
  const d = $('logs-drawer');
  const open = d.classList.toggle('open');
  $('logs-toggle').setAttribute('aria-expanded', String(open));
});

/* Login / logout */
$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('login-btn');
  const errEl = $('login-error');
  errEl.classList.add('hidden');
  btn.disabled = true;
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: $('password').value }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.token) {
      throw new Error(body.error || 'Login failed');
    }
    token = body.token;
    localStorage.setItem(TOKEN_KEY, token);   // persists across refresh/close
    $('password').value = '';
    showDash();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
  } finally {
    btn.disabled = false;
  }
});

$('logout-btn').addEventListener('click', () => {
  // Explicit logout ONLY — never automatic.
  localStorage.removeItem(TOKEN_KEY);
  token = null;
  stopTimers();
  showLogin();
});

/* Keep the clock ticking even while polling pauses on background tabs. */
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && token) refresh();
});

/* ------------------------------ boot ------------------------------ */

(function init() {
  iconsRefresh();
  if (token) {
    showDash();          // persistent session: straight to dashboard
  } else {
    showLogin();
  }
})();
