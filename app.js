import { getAll, get, put } from './db.js';
import { signIn, signOut, getSession, sessionStatus } from './auth.js';
import { sync } from './sync.js';

const $ = (id) => document.getElementById(id);
const STATES = ['Created', 'Pending Sync', 'Synced'];
const fmt = (iso) => (iso ? new Date(iso).toLocaleString() : '—');
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
let deviceId, previousOpen, swVersion = 'no service worker yet', persistResult = 'not called yet';

async function start() {
  previousOpen = await get('meta', 'last_open');
  await put('meta', new Date().toISOString(), 'last_open');
  deviceId = await get('meta', 'device_id');
  if (!deviceId) await put('meta', (deviceId = crypto.randomUUID()), 'device_id');

  registerServiceWorker();
  bindUi();
  await route();

  addEventListener('online', () => { render(); runSync('back online'); });
  addEventListener('offline', render);
  if ((await sessionStatus()) !== 'none') runSync('app open');
}

async function route() {
  const showLogin = (await sessionStatus()) === 'none' && !(await get('meta', 'skipped_login'));
  $('login').hidden = !showLogin;
  $('main').hidden = showLogin;
  await render();
}

// ---------- records ----------

const randomPayload = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('');

async function newRecord() {
  const n = ((await get('meta', 'counter')) ?? 0) + 1;
  await put('meta', n, 'counter');
  const now = new Date().toISOString();
  await put('records', {
    id: crypto.randomUUID(), label: `TEST ${n}`, payload: randomPayload(),
    created_at: now, updated_at: now, device_id: deviceId, sync_state: 'Created',
  });
  render();
}

async function editLabel(id) {
  const r = await get('records', id);
  const label = prompt('New label (TEST data only)', r.label);
  if (label === null || label === r.label) return;
  // A record never uploaded stays Created; one already on the server becomes Pending Sync.
  const sync_state = r.sync_state === 'Created' ? 'Created' : 'Pending Sync';
  await put('records', { ...r, label, updated_at: new Date().toISOString(), device_id: deviceId, sync_state });
  render();
}

// ---------- sync ----------

async function runSync(trigger) {
  $('sync-now').disabled = true;
  const result = await sync(trigger);
  $('sync-now').disabled = false;
  if (result.ok) toast(`Sync confirmed by server: ${result.detail}`, true);
  else if (trigger === 'manual') toast(`Sync failed: ${result.error}`, false);
  render();
}

function toast(text, ok) {
  const t = $('toast');
  t.textContent = text;
  t.className = `banner ${ok ? 'ok' : ''}`;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, 6000);
}

// ---------- render ----------

async function render() {
  const records = (await getAll('records')).sort((a, b) => a.created_at.localeCompare(b.created_at));
  const counts = Object.fromEntries(STATES.map((s) => [s, records.filter((r) => r.sync_state === s).length]));
  $('counts').textContent = `${records.length} records · ${STATES.map((s) => `${s}: ${counts[s]}`).join(' · ')}`;
  $('records').innerHTML = records.map((r) => `
    <li>
      <div>${esc(r.label)}<small>${r.id}<br>updated ${fmt(r.updated_at)}</small></div>
      <div><span class="state ${r.sync_state}">${r.sync_state}</span>
      <button class="secondary" data-edit="${r.id}">Edit</button></div>
    </li>`).join('');

  const status = await sessionStatus();
  const session = await getSession();
  const banner = $('session-banner');
  banner.hidden = status === 'valid' || status === 'none';
  if (status === 'expired') banner.textContent = navigator.onLine
    ? 'Session token expired. It will refresh on the next sync.'
    : 'Session token expired and there is no signal. Local records are safe; sync will resume when online.';
  if (status === 'rejected') banner.textContent = `Session expired: the server refused it (${session.rejected_reason}). Sign in again to sync. Local records are safe.`;
  $('sign-in-again').hidden = status === 'valid' || status === 'expired';
  $('sign-out').hidden = status === 'none';

  await renderDiagnostics(session, status);
  const log = await getAll('log');
  $('log').innerHTML = log.reverse().map((e) => `
    <li class="${e.result === 'error' ? 'error' : ''}">${fmt(e.time)} · ${esc(e.trigger)} · ${e.result}
    ${e.error ? `· ${esc(e.error)}` : ''} ${e.detail ? `· ${esc(e.detail)}` : ''}</li>`).join('') || '<li>No sync attempts yet.</li>';
}

async function renderDiagnostics(session, status) {
  let est = {};
  try { est = await navigator.storage.estimate(); } catch (e) { est = { error: e.message }; }
  const mb = (b) => (b == null ? '—' : `${(b / 1048576).toFixed(2)} MB`);
  const rows = {
    'App version': swVersion,
    'storage.persisted()': String(await navigator.storage.persisted().catch((e) => e.message)),
    'storage.persist()': persistResult,
    'Storage usage': est.error ?? mb(est.usage),
    'Storage quota': est.error ?? mb(est.quota),
    'Standalone (Home Screen)': String(matchMedia('(display-mode: standalone)').matches || navigator.standalone === true),
    'Online (browser says)': String(navigator.onLine),
    'Last open before this one': fmt(previousOpen),
    'Session': `${status}${session?.email ? ` (${session.email})` : ''}`,
    'Token expires': session ? fmt(new Date(session.expires_at).toISOString()) : '—',
    'Device id': deviceId,
  };
  $('diagnostics').innerHTML = Object.entries(rows).map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('');
}

// ---------- UI wiring ----------

function bindUi() {
  $('new-record').onclick = newRecord;
  $('sync-now').onclick = () => runSync('manual');
  $('records').onclick = (e) => e.target.dataset.edit && editLabel(e.target.dataset.edit);
  $('persist').onclick = async () => {
    persistResult = String(await navigator.storage.persist().catch((e) => e.message));
    render();
  };
  $('skip-login').onclick = async () => { await put('meta', true, 'skipped_login'); route(); };
  $('sign-in-again').onclick = () => { $('login').hidden = false; $('main').hidden = true; };
  $('sign-out').onclick = async () => { await signOut(); render(); };
  $('login-form').onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    $('login-error').textContent = '';
    try {
      await signIn(f.get('email'), f.get('password'));
      e.target.reset();
      $('login').hidden = true;
      $('main').hidden = false;
      runSync('after sign-in');
    } catch (err) {
      $('login-error').textContent = navigator.onLine ? err.message : 'No signal: signing in needs a connection.';
    }
  };
}

// ---------- service worker and update banner ----------

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  const sw = navigator.serviceWorker;
  // Reload only when an update replaces a running worker, not on the very first install.
  let reloading = !sw.controller;
  sw.addEventListener('message', (e) => { if (e.data?.version) { swVersion = `v${e.data.version}`; $('version').textContent = swVersion; render(); } });
  sw.ready.then((r) => r.active.postMessage('version'));

  const reg = await sw.register('sw.js');
  const showBanner = (worker) => {
    const b = $('update-banner');
    b.hidden = false;
    b.onclick = () => { b.textContent = 'Updating…'; worker.postMessage('skipWaiting'); };
  };
  if (reg.waiting && sw.controller) showBanner(reg.waiting);
  reg.addEventListener('updatefound', () => {
    const w = reg.installing;
    w.addEventListener('statechange', () => { if (w.state === 'installed' && sw.controller) showBanner(w); });
  });
  sw.addEventListener('controllerchange', () => { if (!reloading) { reloading = true; location.reload(); } });
  // iOS rarely checks for a new service worker on its own; check on open and when brought back.
  reg.update().catch(() => {});
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && reg.update().catch(() => {}));
}

start();
