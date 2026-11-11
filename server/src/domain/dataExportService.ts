/**
 * 個人データの開示・ダウンロード orchestration (REQ-DEX-*, contracts/protocol.md §51).
 *
 *  - runDataExportJob: the player's object alarm builds a due export (state + SQL history + directory names + reports +
 *    analytics rows), writes the JSON and the summary to R2 under DEX_PREFIX, then marks it ready (activity entry, KPI).
 *  - sweepDataExports: deletes expired / replaced files (the alarm; an R2 lifecycle rule on the prefix is the backstop).
 *  - DataExportService: the HTTP side — status with short-lived signed links, and the download behind a link.
 *
 * Signed links (REQ-DEX-010): `GET /v1/data-export/file?p=<playerId>&r=<requestId>&f=json|summary&e=<expiresAtMs>&s=<sig>`,
 * sig = base64url(HMAC-SHA256(key, "dex1|p|r|f|e")), key = the ticket secret with a purpose suffix. A link names one
 * player, one request and one file, works for linkTtlMinutes and only while that request is the current ready one.
 */
import { AppError } from './errors.js';
import type { Master } from './master.js';
import type { PlayerInvoker } from '../http/app.js';
import { catalogFor, localize } from '../i18n/catalog.js';
import {
  buildExportDocument, dataExportConfig, dexKey, renderSummary, serializeExport, summaryLines, DEX_FILES,
  type DexExternal, type DexFile, type DexLang, type DexReadyInfo,
} from './dataExport.js';
import type { PlayerReportMade } from './dataExport.js';
import type { GachaLogEntry } from './history.js';
import type { LedgerEntry, PlayerState } from './player.js';

/** The part of R2 the feature needs (tests use a map). */
export interface ExportStore {
  put(key: string, body: string, contentType: string): Promise<void>;
  get(key: string): Promise<ReadableStream | string | null>;
  delete(keys: string[]): Promise<void>;
}
export class MemoryExportStore implements ExportStore {
  readonly files = new Map<string, { body: string; contentType: string }>();
  async put(key: string, body: string, contentType: string) { this.files.set(key, { body, contentType }); }
  async get(key: string) { return this.files.get(key)?.body ?? null; }
  async delete(keys: string[]) { for (const k of keys) this.files.delete(k); }
}

export interface DataExportJobPorts {
  master(): Master;
  take(uid: string): Promise<{ requestId: string; lang: DexLang; attempt: number } | null>;
  collect(uid: string): Promise<{ state: PlayerState; ledger: LedgerEntry[]; gacha: GachaLogEntry[]; now: number }>;
  /** Current public names (directory). Optional; a failure leaves names null (the export still completes). */
  profiles?(ids: string[]): Promise<{ playerId: string; displayName: string }[]>;
  /** Race reports this player made (IntegrityDO). Optional. */
  reportsMade?(uid: string): Promise<{ raceId: string; at: number; status: string }[]>;
  /** §47 player reports this player made (ops queue, Round 18 integration). Optional. */
  playerReportsMade?(uid: string): Promise<PlayerReportMade[]>;
  /** Analytics rows tied to the player's pseudonymous id. Optional; null = not configured. */
  kpiEvents?(uid: string): Promise<{ rows: Record<string, unknown>[]; windowDays: number } | null>;
  store: ExportStore;
  ready(uid: string, requestId: string, info: DexReadyInfo): Promise<unknown>;
  failed(uid: string, requestId: string, reason: string): Promise<unknown>;
}

async function sha256Hex(s: string) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
const soft = async <T>(f: (() => Promise<T>) | undefined): Promise<T | null> => {
  if (!f) return null;
  try { return await f(); } catch (e) { console.error('data export: optional source failed', (e as Error).message); return null; }
};

/** Builds one due export. Returns what happened (the alarm logs it). Never throws for a build failure (it is recorded). */
export async function runDataExportJob(p: DataExportJobPorts, uid: string): Promise<{ status: 'idle' | 'ready' | 'failed'; requestId?: string; bytes?: number }> {
  const t = await p.take(uid);
  if (!t) return { status: 'idle' };
  try {
    const m = p.master();
    const c = dataExportConfig(m);
    if (!c) throw new Error('disabled');
    const src = await p.collect(uid);
    const s = src.state;
    const feed = (s as PlayerState & { teamFeed?: { muted?: string[] } }).teamFeed;
    const ids = [...new Set([...s.friends.ids, ...s.friends.outgoing.map((o) => o.to), ...(feed?.muted ?? []), ...(s.friendSuggest?.dismissed ?? []).map((d) => d.id)])];
    const profiles = ids.length ? await soft(p.profiles ? () => p.profiles!(ids) : undefined) : [];
    const ext: DexExternal = {
      ledger: src.ledger, gacha: src.gacha,
      names: profiles === null ? null : Object.fromEntries(profiles.map((x) => [x.playerId, x.displayName])),
      reportsMade: await soft(p.reportsMade ? () => p.reportsMade!(uid) : undefined),
      playerReportsMade: p.playerReportsMade ? await soft(() => p.playerReportsMade!(uid)) : [],
      kpiEvents: await soft(p.kpiEvents ? () => p.kpiEvents!(uid) : undefined),
    };
    let doc = buildExportDocument(m, s, ext, t.requestId, t.lang, src.now);
    if (t.lang === 'en') {
      // the player's language for the readable parts (history titles, statuses, notices); stored values stay as they are
      const cat = catalogFor(m);
      doc = { ...doc, wallet: localize(doc.wallet, 'en', cat), coinHistory: localize(doc.coinHistory, 'en', cat), purchases: localize(doc.purchases, 'en', cat), gacha: localize(doc.gacha, 'en', cat), activity: localize(doc.activity, 'en', cat) };
    }
    const out = serializeExport(doc, c.maxBytes);
    let lines = summaryLines(doc);
    if (t.lang === 'en') { const cat = catalogFor(m); lines = lines.map((l) => ({ label: localize(l.label, 'en', cat), value: l.value })); }
    const summary = renderSummary(lines);
    await p.store.put(dexKey(uid, t.requestId, 'json'), out.body, 'application/json; charset=utf-8');
    await p.store.put(dexKey(uid, t.requestId, 'summary'), summary, 'text/plain; charset=utf-8');
    const info: DexReadyInfo = { sizeBytes: out.bytes, summaryBytes: new TextEncoder().encode(summary).length, sha256: await sha256Hex(out.body), truncated: out.truncated };
    await p.ready(uid, t.requestId, info);
    return { status: 'ready', requestId: t.requestId, bytes: out.bytes };
  } catch (e) {
    const reason = e instanceof AppError ? e.code : (e as Error).message || 'error';
    console.error('data export build failed', uid, reason);
    await p.failed(uid, t.requestId, reason).catch((err) => console.error('data export: could not record the failure', uid, (err as Error).message));
    return { status: 'failed', requestId: t.requestId };
  }
}

/** Deletes expired / replaced export files. Failures stay pending (retried with the next alarm). */
export async function sweepDataExports(p: { expiring(uid: string): Promise<string[]>; deleted(uid: string, keys: string[]): Promise<unknown>; store: ExportStore }, uid: string) {
  const keys = await p.expiring(uid);
  if (keys.length === 0) return 0;
  await p.store.delete(keys);
  await p.deleted(uid, keys);
  return keys.length;
}

// ------------------------------------------------------------------------------------------------ signed links

const b64url = (b: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
async function hmac(secret: string, msg: string) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(`${secret}|data-export`), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg)));
}
const safeEq = (a: string, b: string) => {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
};
const msgOf = (p: string, r: string, f: DexFile, e: number) => `dex1|${p}|${r}|${f}|${e}`;
export const DEX_FILE_PATH = '/v1/data-export/file';

export async function signDexLink(secret: string, playerId: string, requestId: string, f: DexFile, expiresAt: number): Promise<string> {
  const q = new URLSearchParams({ p: playerId, r: requestId, f, e: String(expiresAt), s: await hmac(secret, msgOf(playerId, requestId, f, expiresAt)) });
  return `${DEX_FILE_PATH}?${q.toString()}`;
}
/** REQ-DEX-010: a link's fields when the signature holds and it has not expired. */
export async function verifyDexLink(secret: string, q: URLSearchParams, now: number): Promise<{ playerId: string; requestId: string; f: DexFile }> {
  const p = q.get('p') ?? '', r = q.get('r') ?? '', f = q.get('f') ?? '', e = q.get('e') ?? '', s = q.get('s') ?? '';
  if (!/^[A-Za-z0-9_:.-]{1,128}$/.test(p) || !/^dex_[a-z0-9]{1,40}$/.test(r) || !(DEX_FILES as readonly string[]).includes(f) || !/^[0-9]{1,15}$/.test(e) || !/^[A-Za-z0-9_-]{43}$/.test(s)) {
    throw new AppError('LINK_INVALID', 'this download link is not valid');
  }
  if (!safeEq(await hmac(secret, msgOf(p, r, f as DexFile, Number(e))), s)) throw new AppError('LINK_INVALID', 'this download link is not valid');
  if (Number(e) <= now) throw new AppError('LINK_EXPIRED', 'this download link has expired; open the privacy screen for a new one');
  return { playerId: p, requestId: r, f: f as DexFile };
}

// ------------------------------------------------------------------------------------------------ HTTP side

export class DataExportService {
  constructor(private readonly master: () => Master, private readonly player: (uid: string) => PlayerInvoker, private readonly store: ExportStore,
    private readonly secret: string, private readonly clock: () => number = Date.now) {}

  private async withLinks<T extends { status: string; requestId: string | null; expiresAt: number | null }>(uid: string, v: T) {
    const c = dataExportConfig(this.master());
    if (v.status !== 'ready' || !v.requestId || !c) return { ...v, download: null };
    // a link never outlives the export itself
    const exp = Math.min(this.clock() + c.linkTtlMinutes * 60_000, v.expiresAt ?? 0);
    const [json, summary] = await Promise.all([signDexLink(this.secret, uid, v.requestId, 'json', exp), signDexLink(this.secret, uid, v.requestId, 'summary', exp)]);
    return { ...v, download: { json: { url: json }, summary: { url: summary }, linkExpiresAt: exp } };
  }
  /** GET /v1/player/data-export (only the caller's own; the route passes the authenticated id). */
  async view(uid: string) { return this.withLinks(uid, await this.player(uid).invoke('dataExportView', uid)); }
  /** POST /v1/player/data-export. */
  async request(uid: string, lang: DexLang, idemKey: string) { return this.withLinks(uid, await this.player(uid).invoke('dataExportRequest', uid, lang, idemKey)); }

  /** GET /v1/data-export/file: the signature is the authorisation (opened by the OS browser / download manager). */
  async download(q: URLSearchParams): Promise<Response> {
    const link = await verifyDexLink(this.secret, q, this.clock());
    const p = this.player(link.playerId);
    const file = await p.invoke('dataExportFile', link.playerId, link.requestId, link.f);
    const body = await this.store.get(file.key);
    if (body === null) throw new AppError('NOT_FOUND', 'this download is no longer available');
    // audit + KPI; a failure here never blocks the download
    await p.invoke('dataExportDownloaded', link.playerId, link.requestId, link.f).catch((e: unknown) => console.error('data export download note failed', (e as Error).message));
    return new Response(body, {
      status: 200,
      headers: {
        'content-type': file.contentType, 'content-disposition': `attachment; filename="${file.filename}"`,
        'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
        ...(file.sha256 ? { 'x-content-sha256': file.sha256 } : {}),
      },
    });
  }
}
