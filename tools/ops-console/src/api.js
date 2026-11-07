/**
 * Admin API client. The bearer token lives only in sessionStorage (gone when the tab closes), is sent only in the
 * Authorization header (never in a URL, never as a cookie), and only to the configured API origin.
 */
const KEY = 'muchi-ops-session';
const cfg = window.OPS_CONSOLE_CONFIG ?? { apiBase: '', envLabel: 'local', docsBase: '' };

export class ApiError extends Error {
  constructor(status, code, message) { super(message || code); this.status = status; this.code = code; }
}

let session = null;
try { session = JSON.parse(sessionStorage.getItem(KEY) ?? 'null'); } catch { session = null; }

export const config = cfg;
export const getSession = () => session;
export function setSession(s) {
  session = s;
  try { if (s) sessionStorage.setItem(KEY, JSON.stringify(s)); else sessionStorage.removeItem(KEY); } catch { /* private mode: memory only */ }
}

const ROLE_RANK = { viewer: 1, operator: 2, admin: 3 };
/** UI hint only — the server checks the role on every call. */
export const can = (need) => !!session && ROLE_RANK[session.role] >= ROLE_RANK[need];

export async function api(method, path, body, { token, base } = {}) {
  const t = token ?? session?.token;
  if (!t) throw new ApiError(401, 'UNAUTHORIZED', 'not signed in');
  const res = await fetch(`${base ?? session?.apiBase ?? cfg.apiBase}${path}`, {
    method,
    headers: { authorization: `Bearer ${t}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer',
  });
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  if (!res.ok) {
    if (res.status === 401 && !token) { setSession(null); window.dispatchEvent(new Event('ops:signed-out')); }
    throw new ApiError(res.status, data?.error?.code ?? `HTTP_${res.status}`, data?.error?.message ?? res.statusText);
  }
  return data;
}

export const get = (path) => api('GET', path);
export const post = (path, body) => api('POST', path, body ?? {});
export const put = (path, body) => api('PUT', path, body ?? {});

/** An idempotency key for one operator intent (opKeySchema: [A-Za-z0-9_.:-]{4,100}). */
export function newOpKey(prefix) {
  const r = crypto.getRandomValues(new Uint8Array(8));
  return `${prefix}-${new Date().toISOString().slice(0, 10)}-${[...r].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}
