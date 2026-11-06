/**
 * Server-side verification (SSV) of rewarded-ad callbacks (REQ-AD-006, contracts/protocol.md §18.4).
 *
 * AdMob-style callback: the network calls `GET <callback>?ad_network=…&ad_unit=…&custom_data=…&reward_amount=…
 * &reward_item=…&timestamp=…&transaction_id=…&user_id=…&signature=…&key_id=…`. The signed message is the raw query string
 * up to (not including) `&signature=`; the signature is ECDSA P-256 / SHA-256, DER-encoded, base64url; `key_id` names
 * the public key in the network's published key set (JSON `{ "keys": [ { "keyId": 123, "pem": "-----BEGIN PUBLIC KEY-----…" } ] }`).
 *
 * The key set is pluggable (`SsvKeySource`): a static set (tests, the web prototype, a pinned set) or the network's key
 * URL fetched and cached (`RemoteKeySource`, env ADS_SSV_KEYS_URL; refetched at most once a minute for an unknown key id).
 * No key, ad unit id or app id is stored in the repository: they come from env (placeholders in wrangler.toml).
 *
 * This layer only proves the callback came from the network. Whether it may be rewarded (session, player, caps, replay,
 * clock skew) is decided in the player's object (domain/ads.ts applyAdCallback).
 */
import type { AdCallback } from '../domain/ads.js';

export interface SsvKeySource {
  /** The public key for `keyId`, or null when the set does not have it. */
  get(keyId: string): Promise<CryptoKey | null>;
}

export interface PemKey { keyId: string | number; pem: string }

const b64ToBytes = (b64: string): Uint8Array => {
  const s = b64.replace(/-/g, '+').replace(/_/g, '/');
  const pad = s.length % 4 === 0 ? s : s + '='.repeat(4 - (s.length % 4));
  const bin = atob(pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};
export const bytesToB64Url = (b: Uint8Array): string => {
  let bin = '';
  for (const x of b) bin += String.fromCharCode(x);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

/** SPKI PEM → CryptoKey (ECDSA P-256, verify). */
export async function importPemKey(pem: string): Promise<CryptoKey> {
  const body = pem.replace(/-----(BEGIN|END) PUBLIC KEY-----/g, '').replace(/\s+/g, '');
  return crypto.subtle.importKey('spki', b64ToBytes(body), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
}

/** A fixed key set (tests, prototype, or a pinned production set). */
export class StaticKeySource implements SsvKeySource {
  private readonly keys = new Map<string, Promise<CryptoKey>>();
  constructor(keys: PemKey[]) { for (const k of keys) this.keys.set(String(k.keyId), importPemKey(k.pem)); }
  static fromCryptoKeys(keys: Record<string, CryptoKey>): SsvKeySource {
    return { get: async (id) => keys[id] ?? null };
  }
  async get(keyId: string) { return (await this.keys.get(keyId)) ?? null; }
}

export interface RemoteKeySourceOptions {
  url: string;
  fetch?: (url: string) => Promise<{ ok: boolean; json(): Promise<unknown> }>;
  clock?: () => number;
  /** Cache lifetime of a fetched set (default 24 h). */
  ttlMs?: number;
  /** Least time between fetches caused by an unknown key id (default 60 s; stops key-id spraying from hammering the URL). */
  minRefetchMs?: number;
}

/** The network's published key set, fetched and cached per isolate. */
export class RemoteKeySource implements SsvKeySource {
  private cache: { at: number; keys: Map<string, CryptoKey> } | null = null;
  private lastFetch = -Infinity;
  private inflight: Promise<void> | null = null;
  constructor(private readonly o: RemoteKeySourceOptions) {}
  private now() { return (this.o.clock ?? Date.now)(); }
  private async refresh() {
    this.lastFetch = this.now();
    const f = this.o.fetch ?? ((u: string) => fetch(u));
    const res = await f(this.o.url);
    if (!res.ok) throw new Error('ssv key fetch failed');
    const body = (await res.json()) as { keys?: PemKey[] };
    const keys = new Map<string, CryptoKey>();
    for (const k of body.keys ?? []) {
      try { keys.set(String(k.keyId), await importPemKey(k.pem)); } catch { /* skip a malformed key */ }
    }
    this.cache = { at: this.now(), keys };
  }
  private async load(force: boolean) {
    const stale = !this.cache || this.now() - this.cache.at > (this.o.ttlMs ?? 86_400_000);
    if (!stale && !(force && this.now() - this.lastFetch >= (this.o.minRefetchMs ?? 60_000))) return;
    this.inflight ??= this.refresh().finally(() => { this.inflight = null; });
    await this.inflight;
  }
  async get(keyId: string) {
    await this.load(false);
    if (!this.cache?.keys.has(keyId)) await this.load(true); // rotated keys: refetch (rate-limited)
    return this.cache?.keys.get(keyId) ?? null;
  }
}

/** DER ECDSA signature → IEEE P1363 r‖s (what WebCrypto verifies). Throws on malformed input. */
export function derToP1363(der: Uint8Array, size = 32): Uint8Array {
  let i = 0;
  const fail = () => { throw new Error('bad DER signature'); };
  if (der[i++] !== 0x30) fail();
  let len = der[i++]!;
  if (len & 0x80) { const n = len & 0x7f; len = 0; for (let k = 0; k < n; k++) len = (len << 8) | der[i++]!; }
  if (len !== der.length - i) fail();
  const int = () => {
    if (der[i++] !== 0x02) fail();
    const l = der[i++]!;
    if (l === undefined || l > size + 1 || i + l > der.length) fail();
    let v = der.slice(i, i + l);
    i += l;
    while (v.length > size && v[0] === 0) v = v.slice(1);
    if (v.length > size) fail();
    const out = new Uint8Array(size);
    out.set(v, size - v.length);
    return out;
  };
  const r = int(), s = int();
  if (i !== der.length) fail();
  const out = new Uint8Array(size * 2);
  out.set(r, 0); out.set(s, size);
  return out;
}

/** IEEE P1363 r‖s → DER (used by tests and the prototype's simulated network to sign like AdMob). */
export function p1363ToDer(sig: Uint8Array): Uint8Array {
  const half = sig.length / 2;
  const enc = (v: Uint8Array) => {
    let x = v;
    while (x.length > 1 && x[0] === 0 && !(x[1]! & 0x80)) x = x.slice(1);
    if (x[0]! & 0x80) { const y = new Uint8Array(x.length + 1); y.set(x, 1); x = y; }
    return [0x02, x.length, ...x];
  };
  const body = [...enc(sig.slice(0, half)), ...enc(sig.slice(half))];
  return new Uint8Array([0x30, body.length, ...body]);
}

export type SsvFailure = 'missing_signature' | 'missing_param' | 'unknown_key' | 'bad_signature' | 'bad_param';
export class SsvError extends Error { constructor(readonly reason: SsvFailure) { super(`ssv: ${reason}`); } }

const REQUIRED = ['ad_network', 'ad_unit', 'custom_data', 'reward_amount', 'reward_item', 'timestamp', 'transaction_id', 'user_id'] as const;
const PARAM_RE = /^[\w\-.:]{1,128}$/;

/**
 * Verifies one AdMob-style callback URL (`rawQuery` = everything after `?`, exactly as received) and returns the
 * parsed callback. Throws SsvError when the signature or the parameters are not acceptable.
 * `adUnits` (env ADS_AD_UNITS, key → ad unit id) resolves `adUnitKey`; without a map it stays undefined (dev).
 */
export async function verifyAdMobCallback(rawQuery: string, keys: SsvKeySource, adUnits?: Record<string, string>): Promise<AdCallback> {
  const q = rawQuery.startsWith('?') ? rawQuery.slice(1) : rawQuery;
  const at = q.indexOf('&signature=');
  if (at < 0) throw new SsvError('missing_signature');
  const message = q.slice(0, at);
  const params = new URLSearchParams(q);
  const signature = params.get('signature');
  const keyId = params.get('key_id');
  if (!signature || !keyId) throw new SsvError('missing_signature');
  // the parameters that are read must all be inside the signed part (nothing appended after the signature counts)
  const signed = new URLSearchParams(message);
  for (const k of REQUIRED) if (!signed.get(k) && k !== 'custom_data') throw new SsvError('missing_param');
  const key = await keys.get(keyId);
  if (!key) throw new SsvError('unknown_key');
  let raw: Uint8Array;
  try { raw = derToP1363(b64ToBytes(signature)); } catch { throw new SsvError('bad_signature'); }
  const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, raw, new TextEncoder().encode(message));
  if (!ok) throw new SsvError('bad_signature');
  const g = (k: typeof REQUIRED[number]) => signed.get(k) ?? '';
  const ts = Number(g('timestamp'));
  const amount = Number(g('reward_amount'));
  if (!Number.isFinite(ts) || !Number.isInteger(amount) || amount < 0) throw new SsvError('bad_param');
  for (const k of ['transaction_id', 'user_id'] as const) if (!PARAM_RE.test(g(k))) throw new SsvError('bad_param');
  if (g('custom_data') !== '' && !PARAM_RE.test(g('custom_data'))) throw new SsvError('bad_param');
  const adUnit = g('ad_unit');
  const cb: AdCallback = {
    network: 'admob', transactionId: g('transaction_id'), userId: g('user_id'), customData: g('custom_data'), adUnit,
    timestamp: ts, rewardAmount: amount, rewardItem: g('reward_item').slice(0, 64),
  };
  if (adUnits) cb.adUnitKey = Object.entries(adUnits).find(([, v]) => v === adUnit)?.[0] ?? null;
  return cb;
}

/**
 * Builds a signed AdMob-style query (tests, scripts/integration and the web prototype's simulated ad network).
 * `sign` signs bytes with the private key and returns P1363 r‖s (WebCrypto's ECDSA output).
 */
export async function signAdMobQuery(p: {
  adNetwork?: string; adUnit: string; customData: string; rewardAmount?: number; rewardItem?: string; timestamp: number;
  transactionId: string; userId: string; keyId: string;
}, privateKey: CryptoKey): Promise<string> {
  const e = encodeURIComponent;
  const message = `ad_network=${e(p.adNetwork ?? '5450213213286189855')}&ad_unit=${e(p.adUnit)}&custom_data=${e(p.customData)}`
    + `&reward_amount=${p.rewardAmount ?? 1}&reward_item=${e(p.rewardItem ?? 'reward')}&timestamp=${p.timestamp}&transaction_id=${e(p.transactionId)}&user_id=${e(p.userId)}`;
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, new TextEncoder().encode(message)));
  return `${message}&signature=${bytesToB64Url(p1363ToDer(sig))}&key_id=${e(p.keyId)}`;
}

/** ADS_AD_UNITS env (`{"REWARDED_HOME":"ca-app-pub-…/…"}`) → map; empty / invalid → undefined. */
export function parseAdUnits(raw: string | undefined): Record<string, string> | undefined {
  if (!raw) return undefined;
  try {
    const o = JSON.parse(raw) as unknown;
    if (!o || typeof o !== 'object' || Array.isArray(o)) return undefined;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(o)) if (typeof v === 'string' && v) out[k] = v;
    return Object.keys(out).length ? out : undefined;
  } catch { return undefined; }
}
