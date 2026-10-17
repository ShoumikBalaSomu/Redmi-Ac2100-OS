/**
 * app.js — NexRouter dashboard entry point
 * =========================================
 * Owns three things: the login gate, the panel router, and the polling
 * lifecycle. Everything else lives in the panel modules.
 *
 * POLLING DESIGN
 * --------------
 * Each panel declares its own refresh interval. Only the ACTIVE panel polls.
 * This is not an optimisation for its own sake: on a device where both CPU
 * cores are needed for packet forwarding, a dashboard that polls six panels
 * every few seconds in the background is actively stealing cycles from the
 * network. An inactive panel costs zero.
 *
 * A single in-flight guard per panel prevents overlapping requests when a
 * poll takes longer than the interval (a slow `nlbwmon` join on a busy
 * network is exactly that case), which would otherwise queue up unboundedly.
 *
 * The poller also stops when the tab is hidden. There is no value in
 * generating load on the router for a page nobody is looking at.
 */

import { ubus, TransportError, UbusError } from './ubus.js';
import { h, mount, $ } from './dom.js';
import { bytes, duration, celsius, tempVariant, clockTime, int } from './format.js';
import {
  panelOverview, panelPerformance, panelProfiles, panelOverclock,
  panelWifi, panelDevices, panelAnomalies, panelRecovery, panelSettings,
} from './panels.js';

/* ── Panel registry ──────────────────────────────────────────────────────── */

const PANELS = [
  {
    group: 'Monitor',
    items: [
      { id: 'overview',    label: 'Overview',    icon: '◱', factory: panelOverview },
      { id: 'performance', label: 'Performance', icon: '⇅', factory: panelPerformance },
      { id: 'wifi',        label: 'Wireless',    icon: '≋', factory: panelWifi },
      { id: 'devices',     label: 'Devices',     icon: '⌸', factory: panelDevices },
      { id: 'anomalies',   label: 'Anomalies',   icon: '∿', factory: panelAnomalies },
    ],
  },
  {
    group: 'Control',
    items: [
      { id: 'profiles',  label: 'Profiles',   icon: '◫', factory: panelProfiles },
      { id: 'overclock', label: 'CPU clock',  icon: '⏲', factory: panelOverclock },
      { id: 'settings',  label: 'Settings',   icon: '⚙', factory: panelSettings },
    ],
  },
  {
    group: 'System',
    items: [
      { id: 'recovery', label: 'Recovery', icon: '⛨', factory: panelRecovery },
    ],
  },
];

const FLAT = PANELS.flatMap(g => g.items);

/* ── Application state ───────────────────────────────────────────────────── */

const state = {
  panel: null,        // active panel instance
  panelId: null,
  timer: null,
  busy: false,        // a mutating request is in flight
  inFlight: false,    // the active panel's refresh is running
  overview: null,     // last overview payload, for the topbar vitals
  perf: null,         // last performance payload, for the offload pill
};

/** Handle for the topbar vitals interval, so logout can clear it. */
let vitalsTimer = null;

const els = {};

/* ── Toasts ──────────────────────────────────────────────────────────────── */

/**
 * Show a transient message.
 * @param {string} msg
 * @param {'info'|'ok'|'warn'|'err'} [kind]
 * @param {{sticky?:boolean}} [opts] sticky errors stay until dismissed, because
 *        a red flash is easy to miss and these messages describe actions that
 *        changed the network configuration.
 */
function toast(msg, kind = 'info', { sticky = false } = {}) {
  const host = els.toasts;
  if (!host) return;

  const el = h('div', { class: ['toast', `toast--${kind}`] },
    h('div', { class: 'toast__msg' }, msg),
    h('button', { class: 'toast__x', type: 'button', 'aria-label': 'Dismiss',
      onclick: () => dismiss() }, '×'));

  host.appendChild(el);

  let timer = null;
  function dismiss() {
    if (timer) clearTimeout(timer);
    el.classList.add('toast--out');
    setTimeout(() => el.remove(), 200);
  }
  if (!sticky) timer = setTimeout(dismiss, kind === 'err' ? 9000 : 4500);

  // Keep the stack bounded; oldest goes first.
  while (host.children.length > 4) host.firstElementChild.remove();
  return dismiss;
}

/** Status bar text. */
function status(msg, isErr = false) {
  if (!els.statusMsg) return;
  els.statusMsg.textContent = msg;
  els.statusMsg.classList.toggle('statusbar__msg--err', !!isErr);
}

/* ── Topbar vitals ───────────────────────────────────────────────────────── */

/**
 * Refresh the persistent vitals strip.
 * Runs on its own timer, independent of the active panel, because CPU / memory
 * / temperature / offload state are worth watching from every screen — the
 * offload pill in particular is the single most useful indicator on this
 * hardware, since it is the difference between ~350 Mbps and ~900 Mbps.
 */
async function refreshVitals() {
  try {
    const [ov, perf] = await Promise.all([
      ubus.overview().catch(() => null),
      ubus.performance().catch(() => null),
    ]);

    if (ov) {
      state.overview = ov;
      els.hdrModel.textContent = `${ov.model ?? 'router'} · ${ov.kernel ?? ''}`;

      const mem = ov.memory ?? {};
      const total = Number(mem.total_kb) || 0;
      const avail = Number(mem.available_kb ?? mem.free_kb) || 0;
      const usedPct = total ? ((total - avail) / total) * 100 : 0;

      els.vMem.textContent = `${bytes((total - avail) * 1024)} / ${bytes(total * 1024)}`;
      els.vUp.textContent = duration(ov.uptime_seconds);

      if (ov.temp_c === null || ov.temp_c === undefined) {
        els.vTemp.textContent = '—';
      } else {
        els.vTemp.textContent = celsius(ov.temp_c);
      }

      // CPU: derive from the performance payload's per-core counters when
      // available, else leave the previous value rather than flashing "—".
      if (perf && Array.isArray(perf.cores) && perf.cores.length) {
        const pcts = perf.cores.map(c => {
          const t = Number(c.total) || 0, b = Number(c.busy) || 0;
          return t > 0 ? (b / t) * 100 : 0;
        });
        const avg = pcts.reduce((a, b) => a + b, 0) / pcts.length;
        els.vCpu.textContent = `${avg.toFixed(0)}%`;
      }
    }

    if (perf) {
      state.perf = perf;
      const off = perf.offload ?? {};
      const flows = Number(off.hw_flows) || 0;
      const wrap = els.vOffloadWrap;

      wrap.classList.remove('vital--ok', 'vital--warn', 'vital--err', 'vital--live');
      if (off.hardware && flows > 0) {
        els.vOffload.textContent = `hw · ${int(flows)}`;
        wrap.classList.add('vital--ok', 'vital--live');
        wrap.title = `Hardware flow offload engaged — ${flows} flow(s) in the PPE table. Forwarding bypasses the CPU.`;
      } else if (off.hardware) {
        els.vOffload.textContent = 'hw · 0';
        wrap.classList.add('vital--warn');
        wrap.title = 'Hardware offload is configured but no flows are in the table yet.';
      } else if (off.software) {
        els.vOffload.textContent = 'sw';
        wrap.classList.add('vital--warn');
        wrap.title = 'Software flow offload only. Hardware offload is disabled — expect substantially lower throughput.';
      } else {
        els.vOffload.textContent = 'off';
        wrap.classList.add('vital--err');
        wrap.title = 'No flow offload. Expect roughly 300–350 Mbps routed. See the Profiles panel.';
      }
    }
  } catch (err) {
    // A vitals failure should not spam toasts; the status bar is enough.
    status(`vitals: ${err.message ?? err}`, true);
  }
}

/* ── Panel routing ───────────────────────────────────────────────────────── */

function stopPanel() {
  if (state.timer) { clearTimeout(state.timer); state.timer = null; }
  if (state.panel?.stop) {
    try { state.panel.stop(); } catch { /* best effort */ }
  }
  state.panel = null;
  state.inFlight = false;
}

/**
 * Activate a panel by id.
 * The active panel polls on its own cadence; no other panel does any work.
 */
async function show(id) {
  const def = FLAT.find(p => p.id === id) ?? FLAT[0];
  stopPanel();

  state.panelId = def.id;
  if (location.hash !== `#${def.id}`) {
    // replaceState rather than assign: navigating panels should not pile up
    // history entries the back button then has to walk through.
    history.replaceState(null, '', `#${def.id}`);
  }

  // Mark nav state.
  document.querySelectorAll('.nav__item').forEach(b => {
    b.classList.toggle('nav__item--active', b.dataset.panel === def.id);
    b.setAttribute('aria-current', b.dataset.panel === def.id ? 'page' : 'false');
  });

  mount(els.main, h('div', { class: 'stack' },
    h('div', { class: 'skel', style: { height: '2rem', width: '16rem' } }),
    h('div', { class: 'skel', style: { height: '9rem' } }),
    h('div', { class: 'skel', style: { height: '9rem' } })));

  let panel;
  try {
    panel = def.factory(ubus, { toast, status, busy: setBusy });
  } catch (err) {
    mount(els.main, h('div', { class: 'card card--err' },
      h('div', { class: 'card__body' }, `Failed to initialise the ${def.label} panel: ${err.message}`)));
    return;
  }

  state.panel = panel;
  mount(els.main, panel.node);
  els.main.focus?.({ preventScroll: true });

  const interval = panel.interval ?? 10000;

  async function tick() {
    if (!state.panel || state.panel !== panel) return;
    // Skip if hidden, busy with a mutation, or the previous refresh is still
    // running. Never queue overlapping requests.
    if (document.hidden || state.busy || state.inFlight) return;

    state.inFlight = true;
    status(`refreshing ${def.label}…`);
    try {
      await panel.refresh();
      status(`${def.label} · updated ${clockTime()}`);
    } catch (err) {
      status(`${def.label} refresh failed: ${err.message ?? err}`, true);
      if (err instanceof TransportError) {
        toast(err.message, 'err', { sticky: true });
      }
    } finally {
      state.inFlight = false;
    }
    // Reschedule only if we are still the active panel.
    if (state.panel === panel) state.timer = setTimeout(tick, interval);
  }

  await tick();
}

function setBusy(v) {
  state.busy = !!v;
  document.body.style.cursor = v ? 'progress' : '';
}

/* ── Navigation ──────────────────────────────────────────────────────────── */

function buildNav() {
  const frag = document.createDocumentFragment();
  for (const group of PANELS) {
    frag.appendChild(h('div', { class: 'nav__group' },
      h('div', { class: 'nav__label' }, group.group),
      group.items.map(item => h('button', {
        class: 'nav__item',
        type: 'button',
        dataset: { panel: item.id },
        'aria-current': 'false',
        onclick: () => show(item.id),
      },
        h('span', { class: 'nav__ico', 'aria-hidden': 'true' }, item.icon),
        h('span', {}, item.label)))));
  }
  mount(els.nav, frag);
}

/* ── Theme ───────────────────────────────────────────────────────────────── */

const THEME_KEY = 'nexrouter-theme';

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem(THEME_KEY, theme); } catch { /* private mode */ }
}

function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem(THEME_KEY); } catch { /* ignore */ }
  if (saved === 'light' || saved === 'dark') { applyTheme(saved); return; }
  const prefersLight = window.matchMedia?.('(prefers-color-scheme: light)').matches;
  applyTheme(prefersLight ? 'light' : 'dark');
}

/* ── Login ───────────────────────────────────────────────────────────────── */

function showGate(message) {
  els.app.hidden = true;
  els.gate.hidden = false;
  els.loginPass.value = '';
  if (message) {
    els.loginError.textContent = message;
    els.loginError.hidden = false;
  } else {
    els.loginError.hidden = true;
  }
  // Autofocus the password since the username is prefilled.
  setTimeout(() => els.loginPass.focus(), 50);
}

function showApp() {
  els.gate.hidden = true;
  els.app.hidden = false;
}

async function handleLogin(ev) {
  ev.preventDefault();
  const user = els.loginUser.value.trim();
  const pass = els.loginPass.value;

  els.loginBtn.disabled = true;
  els.loginBtn.classList.add('btn--busy');
  els.loginError.hidden = true;

  try {
    try {
      await ubus.login(user, pass);
    } catch {
      await ubus.autoConnect();
    }
    showApp();
    await afterLogin();
  } catch (err) {
    // Distinguish the three real cases so the message is actionable.
    let msg;
    if (err instanceof TransportError) {
      msg = err.message;
    } else if (err instanceof UbusError && err.code === 6) {
      msg = 'Invalid username or password.';
    } else if (err instanceof UbusError) {
      msg = `Login failed: ${err.message}`;
    } else {
      msg = `Login failed: ${err.message ?? err}`;
    }
    els.loginError.textContent = msg;
    els.loginError.hidden = false;
    els.loginPass.select();
  } finally {
    els.loginBtn.disabled = false;
    els.loginBtn.classList.remove('btn--busy');
  }
}

/** Runs once after a successful login. */
async function afterLogin() {
  // Reflect the granted access level in the status bar so a read-only session
  // is obvious before the user clicks something that silently cannot work.
  const acl = els.statusAcl;
  if (ubus.canWrite) {
    acl.textContent = 'admin';
    acl.title = 'This session may change configuration.';
  } else {
    acl.textContent = 'read-only';
    acl.title = 'This session cannot change configuration. Write controls are hidden.';
  }

  // Board identity in the header, immediately, without waiting for a panel.
  try {
    const ov = await ubus.overview();
    els.statusBuild.textContent = `nex ${ov.nexrouter ?? 'dev'}${ov.git_commit ? ` · ${String(ov.git_commit).slice(0, 7)}` : ''}`;
    els.statusBuild.title = `Built ${ov.build_date ?? 'unknown'}`;
  } catch { /* non-fatal */ }

  refreshVitals();
  await show(els.nav.querySelector('.nav__item--active')?.dataset.panel ?? initialPanel());
}

function initialPanel() {
  const fromHash = location.hash.replace('#', '');
  return FLAT.some(p => p.id === fromHash) ? fromHash : 'overview';
}

/* ── Boot ────────────────────────────────────────────────────────────────── */

function boot() {
  // Cache element references once; the shell is static.
  els.gate = $('#gate');
  els.app = $('#app');
  els.loginForm = $('#login-form');
  els.loginUser = $('#login-user');
  els.loginPass = $('#login-pass');
  els.loginError = $('#login-error');
  els.loginBtn = els.loginForm?.querySelector('button[type=submit]');
  els.hdrModel = $('#hdr-model');
  els.nav = $('#nav');
  els.main = $('#main');
  els.toasts = $('#toasts');
  els.statusMsg = $('#status-msg');
  els.statusAcl = $('#status-acl');
  els.statusBuild = $('#status-build');
  els.statusClock = $('#status-clock');
  els.vCpu = $('#v-cpu');
  els.vMem = $('#v-mem');
  els.vTemp = $('#v-temp');
  els.vUp = $('#v-up');
  els.vOffload = $('#v-offload');
  els.vOffloadWrap = $('#v-offload-wrap');
  els.themeToggle = $('#theme-toggle');
  els.logout = $('#logout');

  initTheme();
  buildNav();

  els.loginForm.addEventListener('submit', handleLogin);

  els.themeToggle.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    // Canvases read theme colours at draw time, so force a redraw.
    if (state.panel && !state.inFlight) state.panel.refresh().catch(() => {});
  });

  els.logout.addEventListener('click', async () => {
    stopPanel();
    if (vitalsTimer) { clearInterval(vitalsTimer); vitalsTimer = null; }
    await ubus.logout();
    showGate();
    status('signed out');
  });

  // Pause polling while the tab is hidden; resume immediately on return.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.panel && !state.inFlight && !state.busy) {
      state.panel.refresh().catch(() => {});
      refreshVitals();
    }
  });

  // Hash navigation, so panel links are shareable and back/forward work.
  window.addEventListener('hashchange', () => {
    const id = initialPanel();
    if (id !== state.panelId) show(id);
  });

  // Keyboard: g then a letter jumps to a panel. Low-cost, and useful on a
  // router UI you may be driving from a laptop over slow WiFi.
  let pendingG = false;
  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    if (e.key === 'g') { pendingG = true; setTimeout(() => { pendingG = false; }, 900); return; }
    if (!pendingG) return;
    pendingG = false;
    const map = { o: 'overview', p: 'performance', r: 'profiles', c: 'overclock',
                  w: 'wifi', d: 'devices', a: 'anomalies', s: 'settings', f: 'recovery' };
    const id = map[e.key.toLowerCase()];
    if (id) { e.preventDefault(); show(id); }
  });

  // Status bar clock.
  setInterval(() => { if (els.statusClock) els.statusClock.textContent = clockTime(); }, 1000);
  if (els.statusClock) els.statusClock.textContent = clockTime();

  // Vitals poll — only while authenticated and visible. Assigned to the
  // module-scope binding so the logout handler above can clear it.
  vitalsTimer = setInterval(() => {
    if (ubus.authenticated && !document.hidden && !state.busy) refreshVitals();
  }, 5000);

  // Open the dashboard immediately when password lock is off (default);
  // if the user explicitly enabled `require_login`, show the password gate.
  showApp();
  status('connecting to router…');
  ubus.autoConnect()
    .then(() => ubus.authStatus().catch(() => null))
    .then((auth) => {
      if (auth && auth.require_login && auth.password_set) {
        showGate('Password protection is enabled. Sign in with your root password.');
        status('password required');
      } else {
        return afterLogin();
      }
    })
    .catch(() => afterLogin());
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
