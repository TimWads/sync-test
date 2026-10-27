// Supabase Auth over plain fetch, so it is clear exactly what happens offline.
// The session lives in IndexedDB (meta 'session') and is only removed on explicit sign-out.
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';
import { get, put, del } from './db.js';

export class AuthError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

async function tokenRequest(grant, body) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=${grant}`, {
    method: 'POST',
    headers: { apikey: SUPABASE_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new AuthError(json.error_description || json.msg || json.message || `HTTP ${res.status}`, res.status);
  const session = {
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    expires_at: json.expires_at * 1000,
    email: json.user?.email,
    refreshed_at: Date.now(),
  };
  await put('meta', session, 'session');
  return session;
}

export const signIn = (email, password) => tokenRequest('password', { email, password });
export const signOut = () => del('meta', 'session');
export const getSession = () => get('meta', 'session');

// One of: 'none', 'valid', 'expired' (token out of date; refreshes when online), 'rejected' (must sign in again).
export async function sessionStatus() {
  const s = await getSession();
  if (!s) return 'none';
  if (s.rejected) return 'rejected';
  return s.expires_at > Date.now() + 60_000 ? 'valid' : 'expired';
}

// Returns a usable access token, refreshing it if needed. Network errors pass through (retryable).
export async function accessToken() {
  const s = await getSession();
  if (!s) throw new AuthError('Not signed in. Sign in to sync.');
  if (s.rejected) throw new AuthError('Session expired. Sign in again to sync.');
  if (s.expires_at > Date.now() + 60_000) return s.access_token;
  if (!navigator.onLine) throw new AuthError('Session token expired and there is no signal. Local data is safe; it will refresh when online.');
  try {
    return (await tokenRequest('refresh_token', { refresh_token: s.refresh_token })).access_token;
  } catch (e) {
    // 4xx means the refresh token itself was refused; 5xx is a server hiccup worth retrying.
    if (e instanceof AuthError && e.status >= 400 && e.status < 500) await put('meta', { ...s, rejected: true, rejected_reason: e.message }, 'session');
    throw e;
  }
}
