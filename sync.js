// Push local changes (upsert on id), then pull server rows. The conflict rule
// (later updated_at wins, loser to proto_revisions) runs in a database trigger.
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';
import { getAll, get, put } from './db.js';
import { accessToken, AuthError } from './auth.js';

const COLUMNS = ['id', 'label', 'payload', 'created_at', 'updated_at', 'device_id'];
const toRow = (r) => Object.fromEntries(COLUMNS.map((c) => [c, r[c]]));
const sameTime = (a, b) => Date.parse(a) === Date.parse(b);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rest(path, { method = 'GET', body, prefer } = {}) {
  const token = await accessToken();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      method,
      signal: ctrl.signal,
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(prefer && { Prefer: prefer }),
      },
      body: body && JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`), { status: res.status });
    return text ? JSON.parse(text) : null;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Request timed out after 15 s');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// Retries network errors and 5xx inside one sync attempt. Auth and 4xx errors fail at once.
let retriesThisSync = 0;
async function withRetry(fn, attempts = 3) {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      const retryable = !(e instanceof AuthError) && !(e.status >= 400 && e.status < 500);
      if (!retryable || i >= attempts) throw Object.assign(e, { attempts: i });
      retriesThisSync++;
      await sleep(2000 * i);
    }
  }
}

export async function log(entry) {
  await put('log', { time: new Date().toISOString(), ...entry });
}

let running = null;
let retryTimer = null;
let retryDelay = 30_000;

export function sync(trigger) {
  running ??= doSync(trigger).finally(() => { running = null; });
  return running;
}

async function doSync(trigger) {
  clearTimeout(retryTimer);
  retriesThisSync = 0;
  try {
    if (!navigator.onLine) throw new Error('Browser reports offline');
    const pending = (await getAll('records')).filter((r) => r.sync_state !== 'Synced');
    let conflictsLost = 0;

    if (pending.length) {
      const returned = await withRetry(() => rest('proto_records?on_conflict=id', {
        method: 'POST',
        body: pending.map(toRow),
        prefer: 'resolution=merge-duplicates,return=representation',
      }));
      const sent = new Map(pending.map((r) => [r.id, r]));
      for (const row of returned) {
        const local = await get('records', row.id);
        // Edited again while the request was in flight: leave it pending for next time.
        if (!local || !sameTime(local.updated_at, sent.get(row.id).updated_at)) continue;
        const lost = !sameTime(row.updated_at, local.updated_at) || row.label !== local.label;
        if (lost) conflictsLost++;
        await put('records', { ...local, ...(lost ? row : {}), sync_state: 'Synced' });
      }
    }

    const server = await withRetry(() => rest('proto_records?select=*&order=created_at'));
    let pulled = 0;
    for (const row of server) {
      const local = await get('records', row.id);
      if (!local || (local.sync_state === 'Synced' && Date.parse(row.updated_at) > Date.parse(local.updated_at))) {
        await put('records', { ...row, sync_state: 'Synced' });
        pulled++;
      }
    }

    retryDelay = 30_000;
    const detail = `uploaded ${pending.length}, server kept its newer version for ${conflictsLost}, pulled ${pulled}, server rows ${server.length}`
      + (retriesThisSync ? `, after ${retriesThisSync} retried request(s)` : '');
    await log({ trigger, result: 'ok', detail });
    return { ok: true, detail };
  } catch (e) {
    const error = `${e.message}${e.attempts > 1 ? ` (after ${e.attempts} attempts)` : ''}`;
    // Retry later while the app is open. Offline waits for the 'online' event instead,
    // and auth problems wait for the user.
    const delay = retryDelay;
    const willRetry = navigator.onLine && !(e instanceof AuthError);
    if (willRetry) {
      retryTimer = setTimeout(() => sync('auto-retry'), delay);
      retryDelay = Math.min(delay * 2, 5 * 60_000);
    }
    await log({ trigger, result: 'error', error, detail: willRetry ? `next retry in ${delay / 1000} s` : '' });
    return { ok: false, error };
  }
}
