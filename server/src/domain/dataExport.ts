/**
 * 個人データの開示・ダウンロード (personal data export / disclosure request) — REQ-DEX-001..020, contracts/protocol.md §51.
 *
 * 保有個人データの開示請求 (APPI art. 33) and the GDPR-style "download your data" expectation of overseas players:
 *
 *   1. POST /v1/player/data-export   → a request is queued on the player's state (idempotent; once per cooldownDays)
 *   2. the player's object alarm builds the export (runDataExportJob in dataExportService.ts): a machine-readable JSON
 *      document and a human-readable summary, written to R2 under the private prefix `private/data-export/<playerId>/`
 *   3. GET /v1/player/data-export     → status; when ready, short-lived signed links (linkTtlMinutes) to both files, and
 *      one activity entry (§40) says it is ready
 *   4. after keepDays the files are deleted (alarm; an R2 lifecycle rule on the prefix is the backstop)
 *
 * This module is pure state logic plus the document builder (no I/O). What every top-level PlayerState key becomes in
 * the export is decided in DEX_CLASSIFICATION — a test fails when a new key is added without a decision.
 */
import { AppError } from './errors.js';
import type { Master } from './master.js';
import type { HorseInstance, LedgerEntry, PlayerState } from './player.js';
import { DAY_MS } from './time.js';
import { coinRow, gachaRow, HISTORY_LIMITS, purchaseRef, purchaseRow, type GachaLogEntry } from './history.js';
import { deletionConfig } from './accountDeletion.js';
import { activityText, type ActivityState } from './activity.js';
import { randomId, type Rng } from './rng.js';
import type { HelpState } from './help.js';
import type { ReporterState } from './reports.js';

// ------------------------------------------------------------------------------------------------ config (REQ-DEX-016)

export interface DataExportConfig {
  enabled: boolean;
  /** A new request is accepted this many days after the last request that became ready (failed ones do not count). */
  cooldownDays: number;
  /** Days the files stay downloadable before they are deleted. */
  keepDays: number;
  /** Lifetime of one signed download link. */
  linkTtlMinutes: number;
  /** Size cap of the JSON file (bytes). Larger exports drop the oldest coin history rows first (`truncated`). */
  maxBytes: number;
  /** Build attempts before the request is marked failed (the player may then ask again at once). */
  maxAttempts: number;
  /** Audit rows kept on the state (newest last). */
  auditKeep: number;
}
export const DATA_EXPORT_DEFAULTS: DataExportConfig = { enabled: true, cooldownDays: 7, keepDays: 7, linkTtlMinutes: 10, maxBytes: 20_000_000, maxAttempts: 5, auditKeep: 50 };
export const DATA_EXPORT_LIMITS = {
  cooldownDays: [1, 30], keepDays: [1, 30], linkTtlMinutes: [1, 60], maxBytes: [1_000_000, 50_000_000], maxAttempts: [1, 10], auditKeep: [10, 200],
} as const;
/** The R2 prefix (private bucket REPLAYS; never public, never under the swept `replays/` prefix). */
export const DEX_PREFIX = 'private/data-export/';
/** A build that has not reported back after this long is taken again (the alarm died mid-way). */
export const DEX_LEASE_MS = 5 * 60_000;
const RETRY_MS = [60_000, 600_000, 3_600_000, 6 * 3_600_000];

export function dataExportConfig(m: Pick<Master, 'progression'>): DataExportConfig | null {
  const raw = m.progression.dataExport;
  if (!raw || !raw.enabled) return null;
  return { ...DATA_EXPORT_DEFAULTS, ...raw };
}

/** REQ-DEX-016: boot and remote-config validation. */
export function dataExportProblems(m: Pick<Master, 'progression'>, path = 'progression.dataExport'): string[] {
  const raw = m.progression.dataExport as unknown;
  if (raw === undefined) return [];
  if (!raw || typeof raw !== 'object') return [`${path} must be an object`];
  const out: string[] = [];
  const known = Object.keys(DATA_EXPORT_DEFAULTS);
  for (const k of Object.keys(raw)) if (!known.includes(k) && !k.startsWith('_')) out.push(`${path}.${k} is unknown`);
  const c = { ...DATA_EXPORT_DEFAULTS, ...(raw as Partial<DataExportConfig>) };
  if (typeof c.enabled !== 'boolean') out.push(`${path}.enabled must be a boolean`);
  for (const [k, [lo, hi]] of Object.entries(DATA_EXPORT_LIMITS)) {
    const v = c[k as keyof DataExportConfig];
    if (!Number.isInteger(v) || (v as number) < lo || (v as number) > hi) out.push(`${path}.${k} must be an integer ${lo}..${hi}`);
  }
  // a file must never outlive the window in which the next request is refused (one export at a time)
  if (Number.isInteger(c.keepDays) && Number.isInteger(c.cooldownDays) && c.keepDays > c.cooldownDays) out.push(`${path}.keepDays must be at most cooldownDays`);
  return out;
}

// ------------------------------------------------------------------------------------------------ state (REQ-DEX-002/003)

export type DexStatus = 'queued' | 'building' | 'ready' | 'failed' | 'expired';
export type DexLang = 'ja' | 'en';
export type DexFile = 'json' | 'summary';
export const DEX_FILES: readonly DexFile[] = ['json', 'summary'];
export interface DexRequest {
  requestId: string;
  status: DexStatus;
  lang: DexLang;
  requestedAt: number;
  /** queued: when the build may start; building: the lease end; failed / ready / expired: null. */
  nextAt: number | null;
  attempts: number;
  readyAt?: number;
  expiresAt?: number;
  sizeBytes?: number;
  summaryBytes?: number;
  sha256?: string;
  /** Short machine reason of the last failure (never shown raw to the player). */
  failReason?: string;
  downloads: number;
  /** The files were deleted from R2 (expired or replaced). */
  filesDeleted?: boolean;
}
export type DexAuditEvent = 'requested' | 'building' | 'ready' | 'retry' | 'failed' | 'downloaded' | 'expired' | 'files_deleted';
export interface DexAudit { at: number; event: DexAuditEvent; requestId: string; detail?: string }
export interface DataExportState {
  current: DexRequest | null;
  /** requestedAt of the last request that became ready (the cooldown starts there). */
  lastReadyRequestAt: number | null;
  audit: DexAudit[];
  /** R2 keys whose deletion failed or is still due (retried by the alarm and by the account deletion). */
  pendingDeletes: string[];
  /** When the alarm last tried to delete them (the next try waits DEX_DELETE_RETRY_MS). */
  deletesTriedAt?: number;
}
export const DEX_DELETE_RETRY_MS = 10 * 60_000;

export const dexKey = (playerId: string, requestId: string, f: DexFile) => `${DEX_PREFIX}${playerId}/${requestId}.${f === 'json' ? 'json' : 'txt'}`;
export const dexKeys = (playerId: string, requestId: string) => DEX_FILES.map((f) => dexKey(playerId, requestId, f));

const peek = (s: PlayerState) => s.dataExport;
function ensure(s: PlayerState): DataExportState {
  s.dataExport ??= { current: null, lastReadyRequestAt: null, audit: [], pendingDeletes: [] };
  return s.dataExport;
}
function audit(c: DataExportConfig | null, st: DataExportState, e: DexAudit) {
  st.audit.push(e);
  const keep = c?.auditKeep ?? DATA_EXPORT_DEFAULTS.auditKeep;
  if (st.audit.length > keep) st.audit.splice(0, st.audit.length - keep);
}

/** The status the player sees now (a ready export past its expiry reads as expired before the alarm deletes it). */
function statusOf(r: DexRequest | null, now: number): DexStatus | 'none' {
  if (!r) return 'none';
  if (r.status === 'ready' && (r.expiresAt ?? 0) <= now) return 'expired';
  return r.status;
}
const active = (r: DexRequest | null, now: number) => {
  const st = statusOf(r, now);
  return st === 'queued' || st === 'building' || st === 'ready';
};

/** When the next request is accepted (null = now). */
export function nextAvailableAt(m: Pick<Master, 'progression'>, s: PlayerState, now: number): number | null {
  const c = dataExportConfig(m);
  const st = peek(s);
  if (!c || !st) return null;
  if (active(st.current, now)) return null; // asking again returns the running one (not a new request)
  if (st.lastReadyRequestAt === null) return null;
  const at = st.lastReadyRequestAt + c.cooldownDays * DAY_MS;
  return at > now ? at : null;
}

export const DEX_NOTICE = 'アカウントに保存されているあなたのデータ（プロフィール・設定・馬・コインと購入の履歴・フレンドなど）をまとめてダウンロードできます。準備ができるとお知らせに届きます。ファイルは{days}日後に削除されます。';
export const DEX_STATUS_TEXT: Record<DexStatus | 'none', string> = {
  none: 'まだリクエストしていません',
  queued: '準備しています',
  building: '準備しています',
  ready: 'ダウンロードできます',
  failed: '準備できませんでした。もう一度リクエストしてください',
  expired: 'ダウンロードの期限が過ぎました',
};
export const DEX_LINK_NOTE = 'ダウンロードのリンクは{minutes}分で切れます。リンクを他の人に送らないでください。';
export const DEX_DELETION_NOTE = 'アカウントの削除を予定しています。削除が終わるまではダウンロードできます。';

/** The parts of GET /v1/player/data-export the domain knows (the HTTP layer adds the signed links). */
export function dataExportView(m: Pick<Master, 'progression'>, s: PlayerState, now: number) {
  const c = dataExportConfig(m);
  if (!c) return { enabled: false as const, status: 'none' as const, statusText: DEX_STATUS_TEXT.none, requestId: null, requestedAt: null, readyAt: null, expiresAt: null, sizeBytes: null, canRequest: false, nextAvailableAt: null, keepDays: DATA_EXPORT_DEFAULTS.keepDays, deletionScheduled: false, deletionNote: null, linkNote: null, notice: null };
  const r = peek(s)?.current ?? null;
  const status = statusOf(r, now);
  const next = nextAvailableAt(m, s, now);
  const deleting = s.deletion?.status === 'deleting';
  const scheduled = s.deletion?.status === 'scheduled' || deleting;
  return {
    enabled: true as const, status, statusText: DEX_STATUS_TEXT[status],
    requestId: r?.requestId ?? null, requestedAt: r?.requestedAt ?? null,
    readyAt: status === 'ready' ? r!.readyAt ?? null : null, expiresAt: status === 'ready' ? r!.expiresAt ?? null : null,
    sizeBytes: status === 'ready' ? r!.sizeBytes ?? null : null,
    canRequest: !deleting && !active(r, now) && next === null, nextAvailableAt: next, keepDays: c.keepDays,
    deletionScheduled: scheduled, deletionNote: scheduled ? DEX_DELETION_NOTE : null,
    linkNote: status === 'ready' ? DEX_LINK_NOTE.replace('{minutes}', String(c.linkTtlMinutes)) : null,
    notice: DEX_NOTICE.replace('{days}', String(c.keepDays)),
  };
}
export type DataExportView = ReturnType<typeof dataExportView>;

/**
 * REQ-DEX-002/004/005: a new request, or the running one again (idempotent). Refused while the account deletion is
 * running (the data is being removed) and inside the cooldown after a ready export. Returns whether a request was made.
 */
export function requestDataExport(m: Pick<Master, 'progression'>, s: PlayerState, lang: DexLang, rng: Rng, now: number): { created: boolean } {
  const c = dataExportConfig(m);
  if (!c) throw new AppError('NOT_FOUND', 'data export is not available');
  if (s.deletion?.status === 'deleting') throw new AppError('DELETION_PENDING', 'the account is being deleted');
  const st = ensure(s);
  if (active(st.current, now)) return { created: false };
  const next = nextAvailableAt(m, s, now);
  if (next !== null) throw new AppError('DATA_EXPORT_COOLDOWN', `a new export can be requested from ${new Date(next).toISOString()}`, 429, { availableAt: next });
  const prev = st.current;
  // an expired export whose files are not deleted yet: delete them with the next sweep (one export at a time)
  if (prev && !prev.filesDeleted && (prev.status === 'ready' || prev.status === 'expired')) pushDeletes(st, dexKeys(s.id, prev.requestId));
  const requestId = randomId('dex', rng);
  st.current = { requestId, status: 'queued', lang, requestedAt: now, nextAt: now, attempts: 0, downloads: 0 };
  audit(c, st, { at: now, event: 'requested', requestId });
  return { created: true };
}
function pushDeletes(st: DataExportState, keys: string[]) {
  for (const k of keys) if (!st.pendingDeletes.includes(k)) st.pendingDeletes.push(k);
}

/** When the object's alarm must run for the export (build due, lease over, expiry, pending deletions). */
export function nextDataExportWake(s: PlayerState): number | null {
  const st = peek(s);
  if (!st) return null;
  const at: number[] = [];
  const r = st.current;
  if (r && (r.status === 'queued' || r.status === 'building') && r.nextAt !== null) at.push(r.nextAt);
  if (r && r.status === 'ready' && r.expiresAt !== undefined) at.push(r.expiresAt);
  if (st.pendingDeletes.length > 0) at.push(st.deletesTriedAt === undefined ? 0 : st.deletesTriedAt + DEX_DELETE_RETRY_MS);
  return at.length ? Math.min(...at) : null;
}

/** The build may start (queued and due, or a lease that ran out). Marks it building with a fresh lease. */
export function takeDataExport(m: Pick<Master, 'progression'>, s: PlayerState, now: number): { requestId: string; lang: DexLang; attempt: number } | null {
  const c = dataExportConfig(m);
  const st = peek(s);
  const r = st?.current;
  if (!c || !st || !r) return null;
  if (r.status !== 'queued' && r.status !== 'building') return null;
  if (r.nextAt !== null && r.nextAt > now) return null;
  if (s.deletion?.status === 'deleting') return null; // the deletion wipes everything; nothing is built any more
  // a build that keeps dying without reporting (lease ran out maxAttempts times) is given up, never retried forever
  if (r.status === 'building' && r.attempts >= c.maxAttempts) {
    r.status = 'failed'; r.nextAt = null; r.failReason = 'lease expired';
    pushDeletes(st, dexKeys(s.id, r.requestId));
    audit(c, st, { at: now, event: 'failed', requestId: r.requestId, detail: r.failReason });
    return null;
  }
  r.status = 'building';
  r.attempts += 1;
  r.nextAt = now + DEX_LEASE_MS;
  audit(c, st, { at: now, event: 'building', requestId: r.requestId, detail: `attempt ${r.attempts}` });
  return { requestId: r.requestId, lang: r.lang, attempt: r.attempts };
}

export interface DexReadyInfo { sizeBytes: number; summaryBytes: number; sha256: string; truncated: number }
/** The files are in R2. A late report for a request that is no longer current deletes its files (returns false). */
export function markDataExportReady(m: Pick<Master, 'progression'>, s: PlayerState, requestId: string, info: DexReadyInfo, now: number): boolean {
  const c = dataExportConfig(m) ?? DATA_EXPORT_DEFAULTS;
  const st = ensure(s);
  const r = st.current;
  if (!r || r.requestId !== requestId || (r.status !== 'building' && r.status !== 'queued')) {
    if (!(r && r.requestId === requestId && r.status === 'ready')) pushDeletes(st, dexKeys(s.id, requestId));
    return false;
  }
  Object.assign(r, { status: 'ready', nextAt: null, readyAt: now, expiresAt: now + c.keepDays * DAY_MS, sizeBytes: info.sizeBytes, summaryBytes: info.summaryBytes, sha256: info.sha256 });
  delete r.failReason;
  st.lastReadyRequestAt = r.requestedAt;
  audit(c, st, { at: now, event: 'ready', requestId, detail: `${info.sizeBytes} bytes${info.truncated ? `, ${info.truncated} rows truncated` : ''}` });
  return true;
}

/** A build failed: back off, or give up after maxAttempts (the player may ask again at once: no cooldown). */
export function markDataExportFailed(m: Pick<Master, 'progression'>, s: PlayerState, requestId: string, reason: string, now: number): DexStatus | null {
  const c = dataExportConfig(m) ?? DATA_EXPORT_DEFAULTS;
  const st = peek(s);
  const r = st?.current;
  if (!st || !r || r.requestId !== requestId || r.status !== 'building') return null;
  r.failReason = reason.slice(0, 120);
  pushDeletes(st, dexKeys(s.id, requestId)); // a half-written file never stays behind
  if (r.attempts >= c.maxAttempts) {
    r.status = 'failed';
    r.nextAt = null;
    audit(c, st, { at: now, event: 'failed', requestId, detail: r.failReason });
  } else {
    r.status = 'queued';
    r.nextAt = now + RETRY_MS[Math.min(r.attempts - 1, RETRY_MS.length - 1)]!;
    audit(c, st, { at: now, event: 'retry', requestId, detail: r.failReason });
  }
  return r.status;
}

/** REQ-DEX-010: the stored file behind a signed link (only the current, ready, unexpired request). */
export function dataExportFile(s: PlayerState, requestId: string, f: DexFile, now: number) {
  const r = peek(s)?.current;
  if (!r || r.requestId !== requestId || statusOf(r, now) !== 'ready') throw new AppError('NOT_FOUND', 'this download is no longer available');
  const day = new Date(r.readyAt! + 9 * 3_600_000).toISOString().slice(0, 10);
  return {
    key: dexKey(s.id, requestId, f),
    contentType: f === 'json' ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    filename: f === 'json' ? `muchi-issen-data-${day}.json` : `muchi-issen-data-${day}-summary.txt`,
    sha256: f === 'json' ? r.sha256 ?? null : null,
  };
}
/** A download happened (audit; first per file kind only counts once in KPI). */
export function noteDataExportDownload(m: Pick<Master, 'progression'>, s: PlayerState, requestId: string, f: DexFile, now: number): boolean {
  const st = peek(s);
  const r = st?.current;
  if (!st || !r || r.requestId !== requestId) return false;
  r.downloads += 1;
  audit(dataExportConfig(m), st, { at: now, event: 'downloaded', requestId, detail: f });
  return true;
}

/** REQ-DEX-011: keys to delete now (an expired export, pending deletions). Marks the request expired. */
export function takeExpiredDataExport(m: Pick<Master, 'progression'>, s: PlayerState, now: number): string[] {
  const st = peek(s);
  if (!st) return [];
  const r = st.current;
  if (r && r.status === 'ready' && (r.expiresAt ?? 0) <= now) {
    r.status = 'expired';
    audit(dataExportConfig(m), st, { at: now, event: 'expired', requestId: r.requestId });
    pushDeletes(st, dexKeys(s.id, r.requestId));
  }
  if (st.pendingDeletes.length > 0) st.deletesTriedAt = now;
  return [...st.pendingDeletes];
}
/** The keys are gone from R2. */
export function dataExportDeleted(m: Pick<Master, 'progression'>, s: PlayerState, keys: string[], now: number) {
  const st = peek(s);
  if (!st || keys.length === 0) return;
  st.pendingDeletes = st.pendingDeletes.filter((k) => !keys.includes(k));
  if (st.pendingDeletes.length === 0) delete st.deletesTriedAt;
  const r = st.current;
  if (r && (r.status === 'expired' || r.status === 'failed') && dexKeys(s.id, r.requestId).every((k) => keys.includes(k))) r.filesDeleted = true;
  const ids = [...new Set(keys.map((k) => k.slice(k.lastIndexOf('/') + 1).replace(/\.(json|txt)$/, '')))];
  for (const id of ids) audit(dataExportConfig(m), st, { at: now, event: 'files_deleted', requestId: id });
}

/** REQ-UXS-040 × REQ-DEX-013: every export file key the account deletion must remove. */
export function dataExportDeletionKeys(s: PlayerState): string[] {
  const st = peek(s);
  if (!st) return [];
  const keys = new Set(st.pendingDeletes);
  if (st.current && !st.current.filesDeleted) for (const k of dexKeys(s.id, st.current.requestId)) keys.add(k);
  return [...keys];
}

/** REQ-DEX-014: what ops may see — status, times, sizes, the audit log. Never the contents, a link or a file key. */
export function dataExportAdminView(m: Pick<Master, 'progression'>, s: PlayerState, now: number) {
  const st = peek(s);
  const r = st?.current ?? null;
  return {
    enabled: dataExportConfig(m) !== null,
    status: statusOf(r, now), requestId: r?.requestId ?? null, requestedAt: r?.requestedAt ?? null, readyAt: r?.readyAt ?? null,
    expiresAt: r?.expiresAt ?? null, sizeBytes: r?.sizeBytes ?? null, attempts: r?.attempts ?? 0, failReason: r?.failReason ?? null,
    downloads: r?.downloads ?? 0, nextAvailableAt: nextAvailableAt(m, s, now), pendingDeletes: st?.pendingDeletes.length ?? 0,
    audit: [...(st?.audit ?? [])].reverse(),
  };
}

// ------------------------------------------------------------------------------------------------ classification (REQ-DEX-006)

/**
 * Why a key is not in the export (stable codes, listed in the document's `notIncluded` and in protocol §51.5):
 *  - internal_idempotency: replay guards of requests / races (copies of results that are exported elsewhere)
 *  - internal_counter: id counters and format versions
 *  - internal_queue: delivery / retry queues (their outcome is exported where it landed)
 *  - operator_notes: support notes and operator records; may name other players (e.g. who reported whom)
 *  - export_meta: the export's own bookkeeping
 */
export type DexExcludeReason = 'internal_idempotency' | 'internal_counter' | 'internal_queue' | 'operator_notes' | 'export_meta';
export type DexClass = { section: DexSection } | { exclude: DexExcludeReason };
export const DEX_SECTIONS = [
  'account', 'profile', 'settings', 'horses', 'items', 'wallet', 'coinHistory', 'purchases', 'gacha', 'giftBox', 'social',
  'reportsMade', 'activity', 'replays', 'photos', 'cups', 'recaps', 'play', 'devices', 'analytics', 'helpInquiries',
] as const;
export type DexSection = typeof DEX_SECTIONS[number];

const x = (section: DexSection): DexClass => ({ section });
const no = (exclude: DexExcludeReason): DexClass => ({ exclude });

/**
 * Every top-level key of PlayerState (and the keys modules add through `PlayerState & { … }`), with its decision.
 * `Record<keyof PlayerState, …>` makes the typecheck fail for a new declared key; test/data-export.test.ts also parses
 * the interface and the module extensions, and checks a populated state, so an undeclared key fails too.
 */
export const DEX_CLASSIFICATION: Record<keyof PlayerState | DexExtensionKey, DexClass> = {
  v: no('internal_counter'), id: x('account'), createdAt: x('account'),
  wallet: x('wallet'), ledger: x('coinHistory'), ledgerSeq: no('internal_counter'), idem: no('internal_idempotency'),
  appliedRaces: no('internal_idempotency'), pendingEventPushes: no('internal_queue'),
  horses: x('horses'), items: x('items'), materials: x('items'), pity: x('gacha'), stepUp: x('gacha'),
  purchases: x('purchases'), firstPurchased: x('purchases'), monthlySpendYen: x('purchases'), age: x('account'), flags: x('account'),
  seasonPass: x('play'), loginBonus: x('play'), missions: x('play'), breeding: x('play'), rating: x('profile'), season: x('profile'),
  counters: no('internal_counter'), itemDebt: x('items'), supportFlags: no('operator_notes'), supportGrants: no('operator_notes'),
  storeSubscriptions: x('purchases'), profile: x('profile'), stats: x('profile'), titles: x('profile'), friends: x('social'),
  seasonHistory: x('profile'), friendRewards: x('play'), timeAttack: x('play'), push: x('devices'), kpi: x('analytics'),
  team: x('social'), events: x('play'), tournaments: x('play'), moderation: x('account'), bond: x('horses'), presets: x('settings'),
  adminOps: no('operator_notes'), equipment: x('settings'), itemLog: x('items'), breedingExtra: x('play'), stud: x('play'),
  shop: x('purchases'), passHistory: x('play'), dailyWins: x('play'), consent: x('account'), onboarding: x('play'),
  seasonMissions: x('play'), nudges: x('play'), deletion: x('account'), referral: x('social'), comeback: x('play'), ads: x('settings'),
  training: x('horses'), giftBox: x('giftBox'), assist: x('settings'), commentaryPack: x('settings'), accessibility: x('settings'),
  rival: x('play'), photos: x('photos'), gachaLog: x('gacha'), activity: x('activity'), weeklyChallenge: x('play'), hall: x('play'),
  myReplays: x('replays'), roster: x('settings'), nextAction: x('play'), seasonRecap: x('recaps'), cups: x('cups'),
  dataExport: no('export_meta'),
  // Round 20 (§58): the ad / analytics choices, versions, ATT / CMP status and their history are consent records
  privacyChoices: x('account'),
  // Round 18 integration: Round 17 / 18 keys (§49 suggestion settings and dismissals, §53 goals and the pin)
  friendSuggest: x('social'), horseGoals: x('horses'),
  // §59 (Round 20): when the store review was asked, the moment, the pre-question answer (nothing is ever granted for it)
  reviewPrompt: x('analytics'),
  // keys added by modules through `PlayerState & { … }`
  collection: x('play'), silksEditor: x('profile'), stable: x('social'), teamFeed: x('social'), teamGoal: x('play'),
  // Round 18 integration: §48 inquiries (text, replies, votes) and §47 the reporter's daily counter (its target ids are not exported)
  help: x('helpInquiries'), reports: x('reportsMade'),
  // Round 19 integration: §57 tip cards read (ids) and §54 transfer code history / expiry (never the code id or password hash)
  tips: x('play'), transfer: x('account'),
  // Round 22 (§66): 騎手の道 progress (stars, first clears, rewards paid) and recent runs — the player's own play record
  career: x('play'),
};
/** Keys some modules add to the state without declaring them on PlayerState (see the test). */
export const DEX_EXTENSION_KEYS = ['collection', 'silksEditor', 'stable', 'teamFeed', 'teamGoal', 'help', 'reports'] as const;
export type DexExtensionKey = typeof DEX_EXTENSION_KEYS[number];

/** `null` = a key nobody classified (the builder lists it under `unclassified` and the test fails). */
export const classifyKey = (k: string): DexClass | null => (DEX_CLASSIFICATION as Record<string, DexClass>)[k] ?? null;

// ------------------------------------------------------------------------------------------------ the document (REQ-DEX-007/008)

export const DEX_FORMAT = 'muchi-issen/personal-data-export';
export const DEX_VERSION = 1;

/** One §47 report as its reporter sees it in the export (ops/playerReports.ts madeBy). */
export interface PlayerReportMade { at: number; category: string; source: string; contentKind: string; note: string | null; status: string }

/** What the job gathers outside the state. Each part is optional: missing = `available: false` in its section. */
export interface DexExternal {
  /** Ledger rows inside the legal retention window (the Durable Object's SQL table, else the state). */
  ledger: LedgerEntry[];
  /** Gacha records inside the 90-day window. */
  gacha: GachaLogEntry[];
  /** Current public display names (directory) of friends, blocked players and sent requests; null = directory unreachable. */
  names: Record<string, string> | null;
  /** Race reports this player made (IntegrityDO). null = could not be read. */
  reportsMade: { raceId: string; at: number; status: string }[] | null;
  /**
   * §47 player reports this player made (ops queue; Round 18 integration). Never the reported player's id or the operator's
   * decision note. Absent / null = could not be read (the race reports above still show).
   */
  playerReportsMade?: PlayerReportMade[] | null;
  /** KPI rows tied to the player's pseudonymous analytics id. null = not configured / unreachable. */
  kpiEvents: { rows: Record<string, unknown>[]; windowDays: number } | null;
  /** REQ-CERR-019 (§60.9): client error samples that carry this player's id. Absent = none; null = could not be read. */
  clientErrors?: DexClientErrorRow[] | null;
}
/** One client error sample as its player sees it in the export (ops/clientErrors.ts madeBy). */
export interface DexClientErrorRow { at: number; category: string | null; title: string | null; appVersion: string; platform: string; deviceModel: string; osVersion: string }

const clone = <T>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)) as T);
const omit = <T extends object, K extends keyof T>(o: T | undefined | null, ...keys: K[]) => {
  if (!o) return null;
  const c = { ...(clone(o) as T) };
  for (const k of keys) delete c[k];
  return c as Omit<T, K>;
};
const maskToken = (t: string) => (t.length <= 6 ? '…' : `…${t.slice(-6)}`);

function horseOut(h: HorseInstance) {
  const c = clone(h) as HorseInstance & { studSire?: unknown };
  // another player's stallion: the lineage keeps its names, never that player's id
  if (h.studSire) c.studSire = { horseId: h.studSire.horseId, sireName: h.studSire.sireName, damName: h.studSire.damName } as never;
  return c;
}

/** REQ-DEX-007: the whole document (the serializer orders the sections and applies the size cap). */
export function buildExportDocument(m: Master, s: PlayerState, ext: DexExternal, requestId: string, lang: DexLang, now: number) {
  const name = (id: string) => ext.names?.[id] ?? null;
  const st = s as PlayerState & Record<DexExtensionKey, unknown>;
  const feed = st.teamFeed as { muted?: string[]; postedIn?: string[] } | undefined;
  const stable = st.stable as { layout?: unknown; likes?: number } | undefined;
  const coinSince = now - deletionConfig(m).ledgerRetentionDays * DAY_MS;
  const ledger = ext.ledger.filter((e) => e.at > coinSince).sort((a, b) => a.seq - b.seq);
  const purchaseSince = coinSince;
  const unclassified = Object.keys(s).filter((k) => classifyKey(k) === null);
  const notIncluded: { key: string; reason: string }[] = Object.keys(s).flatMap((k) => { const c = classifyKey(k); return c && 'exclude' in c ? [{ key: k, reason: c.exclude as string }] : []; });
  // fields dropped inside exported sections because they are about other players (protocol §51.5)
  notIncluded.push({ key: 'otherPlayersData', reason: 'third_party' });
  const act = s.activity as ActivityState | undefined;
  const rival = s.rival;
  const stud = s.stud;
  const ref = s.referral;
  const push = s.push;
  const help = (st as unknown as { help?: HelpState }).help;
  const reportsToday = (st as unknown as { reports?: ReporterState }).reports;
  const doc = {
    format: DEX_FORMAT, version: DEX_VERSION, requestId, playerId: s.id, generatedAt: now, language: lang,
    timeUnit: 'unix_ms_utc',
    sections: [...DEX_SECTIONS] as string[],
    truncated: [] as { section: string; omitted: number }[],
    notIncluded,
    unclassified,
    account: {
      playerId: s.id, createdAt: s.createdAt, lastSeenAt: s.profile.lastSeenAt,
      age: s.age ? clone(s.age) : null, consent: clone(s.consent) ?? null, flags: clone(s.flags),
      // §58 (Round 20): personalised ads / analytics choices, the policy version they were made under, ATT / CMP, history
      privacyChoices: clone(s.privacyChoices) ?? null,
      deletion: s.deletion && s.deletion.status !== 'confirming' ? { status: s.deletion.status, requestedAt: s.deletion.requestedAt ?? null, deleteAt: s.deletion.deleteAt ?? null } : null,
      // anti-cheat: the status and dates; the detection reason is an operator note (protocol §51.5)
      moderation: s.moderation ? { status: s.moderation.status, until: s.moderation.until, at: s.moderation.at } : null,
      // §54 (Round 19 integration): 引き継ぎコード — the code's mode and expiry, today's issues, the old-device cut-off and the
      // issue / revoke / redeem history. Never the code id (half of the credential), the password, its hash or salt (those
      // live only in the directory), nor the redeem replay guard (it names the account signed into)
      transfer: s.transfer ? {
        code: s.transfer.code ? { mode: s.transfer.code.mode, issuedAt: s.transfer.code.issuedAt, expiresAt: s.transfer.code.expiresAt, expired: now >= s.transfer.code.expiresAt } : null,
        issuesToday: clone(s.transfer.issues), lastTransferredAt: s.transfer.lastRedeemedAt, oldDeviceCutoffAt: s.transfer.cutoffAt,
        history: clone(s.transfer.history),
      } : null,
    },
    profile: {
      displayName: s.profile.displayName, titleId: s.profile.titleId, titles: [...s.titles], silks: clone(s.profile.silks) ?? null,
      silksEditor: clone(st.silksEditor) ?? null,
      stats: clone(s.stats), rating: { r: Math.round(s.rating.r), rd: Math.round(s.rating.rd), rankedRaces: s.rating.rankedRaces },
      season: clone(s.season), seasonHistory: clone(s.seasonHistory),
    },
    settings: {
      accessibility: clone(s.accessibility) ?? null, assist: clone(s.assist) ?? null, commentaryPack: clone(s.commentaryPack) ?? null,
      presets: clone(s.presets) ?? null, equipment: clone(s.equipment) ?? null, roster: clone(s.roster) ?? null,
      pushPreferences: clone(push?.prefs) ?? null,
      ads: s.ads ? { pref: s.ads.pref, day: s.ads.day, counts: clone(s.ads.counts), total: s.ads.total,
        sessions: s.ads.sessions.map((a) => ({ placementId: a.placementId, createdAt: a.createdAt, status: a.status, at: a.at ?? null, reward: clone(a.reward) ?? null })) } : null,
      hallVisibility: s.hall?.visibility ?? null, rivalOptOut: rival?.optOut ?? null,
    },
    horses: {
      items: s.horses.map(horseOut), bond: clone(s.bond) ?? null, training: clone(s.training) ?? null,
      // §53 (Round 18 integration): goal completion times per horse and the horse pinned to the home
      goals: s.horseGoals ? { done: clone(s.horseGoals.done), pinned: s.horseGoals.pinned } : null,
    },
    items: { items: clone(s.items), materials: clone(s.materials), itemDebt: clone(s.itemDebt) ?? {}, itemLog: clone(s.itemLog) ?? [] },
    // 資金決済法: paid and free are never mixed
    wallet: {
      paid: s.wallet.paid, free: s.wallet.free, debt: s.wallet.debt,
      paidLots: s.wallet.lots.map((l) => ({ granted: l.granted, remaining: l.remaining, at: l.at, purchaseRef: purchaseRef(l.txId) })),
      notice: '有償コインに有効期限はありません。使うときは有償コインから先に使われます。無償コインはゲーム内で受け取ったコインです。',
    },
    coinHistory: {
      windowDays: deletionConfig(m).ledgerRetentionDays,
      paid: ledger.filter((e) => e.currency === 'paid').map((e) => coinRow(m, s, e)),
      free: ledger.filter((e) => e.currency === 'free').map((e) => coinRow(m, s, e)),
    },
    purchases: {
      items: s.purchases.filter((p) => p.at > purchaseSince).map((p) => ({ ...purchaseRow(m, s, p), storeTransactionId: p.txId })),
      monthlySpendYen: clone(s.monthlySpendYen), firstPurchased: [...s.firstPurchased],
      subscriptions: Object.entries(s.storeSubscriptions ?? {}).map(([k, v]) => ({ purchaseRef: purchaseRef(k), ...clone(v) })),
      allowances: (s.shop?.allowances ?? []).map((a) => ({ purchaseRef: purchaseRef(a.txId), productId: a.productId, startDate: a.startDate, days: a.days, dailyFreeCoins: a.dailyFreeCoins, claimed: [...a.claimed], refunded: !!a.refunded, forfeitedAt: a.forfeitedAt ?? null })),
      offers: clone(s.shop?.offers) ?? {},
    },
    gacha: {
      windowDays: HISTORY_LIMITS.gachaDays,
      items: ext.gacha.filter((e) => e.at > now - HISTORY_LIMITS.gachaDays * DAY_MS).sort((a, b) => a.seq - b.seq).map((e) => gachaRow(m, e)),
      pity: clone(s.pity), stepUp: clone(s.stepUp) ?? {},
    },
    giftBox: s.giftBox ? { unclaimed: s.giftBox.box.map((g) => omit(g, 'note')), history: s.giftBox.history.map((g) => omit(g, 'note')) } : { unclaimed: [], history: [] },
    social: {
      // ids and current public names of the player's own friends only — never anything else about them
      friends: s.friends.ids.map((id) => ({ playerId: id, name: name(id) })),
      friendRequestsSent: s.friends.outgoing.map((o) => ({ playerId: o.to, name: name(o.to), at: o.at })),
      friendRequestsReceived: s.friends.incoming.length,
      roomInvitesReceived: s.friends.invites.length,
      blocks: (feed?.muted ?? []).map((id) => ({ playerId: id, name: name(id) })),
      // §49 (Round 18 integration): the opt-out and the players this player dismissed (current public name, like blocks);
      // the recent opponents are other players' presence in races — only their number
      friendSuggest: s.friendSuggest ? {
        hidden: s.friendSuggest.hidden,
        dismissed: s.friendSuggest.dismissed.map((d) => ({ playerId: d.id, name: name(d.id), at: d.at, why: d.why })),
        recentOpponents: s.friendSuggest.opponents.length,
      } : null,
      team: s.team ? { teamId: s.team.teamId, joinedAt: s.team.joinedAt, cooldownUntil: s.team.cooldownUntil, joinRequests: s.team.outgoing.map((o) => ({ teamId: o.teamId, at: o.at })) } : null,
      teamFeedTeams: [...(feed?.postedIn ?? [])],
      stable: stable ? { layout: clone(stable.layout) ?? null, likesReceived: stable.likes ?? 0 } : null,
      invite: ref ? {
        redeemedCode: ref.invitedBy?.code ?? null, redeemedAt: ref.invitedBy?.at ?? null, milestones: [...(ref.invitedBy?.milestones ?? [])],
        installHashes: [...ref.installs],
        invitees: ref.invitees.map((i) => ({ at: i.at, counted: i.counted, deleted: !!i.deleted, milestones: i.milestones.map((x) => ({ id: x.id, at: x.at, rewarded: x.rewarded })) })),
      } : null,
      namesAvailable: ext.names !== null,
    },
    reportsMade: {
      available: ext.reportsMade !== null && ext.playerReportsMade !== null,
      items: [
        ...(ext.reportsMade ?? []).map((r) => ({ kind: 'race', raceId: r.raceId, at: r.at, status: r.status })),
        // §47 (Round 18 integration): what was reported and why, with the reporter's own note — the target is not named
        ...(ext.playerReportsMade ?? []).map((r) => ({ kind: 'player', at: r.at, category: r.category, source: r.source, content: r.contentKind, note: r.note, status: r.status })),
      ] as Record<string, unknown>[],
      today: reportsToday ? { day: reportsToday.day, count: reportsToday.count } : null,
    },
    activity: (act?.entries ?? []).map((e) => ({ at: e.at, kind: e.kind, count: e.count, text: activityText(e.kind, e.count, e.vars, e.actors[0]?.name ?? 'プレイヤー') })),
    replays: {
      saved: (s.myReplays?.saved ?? []).map((r) => clone(r)),
      recent: (s.myReplays?.recent ?? []).map((r) => clone(r)),
    },
    photos: clone(s.photos?.records) ?? [],
    cups: s.cups ? {
      active: clone(s.cups.active), history: clone(s.cups.history), trophies: clone(s.cups.trophies),
      invitesReceived: s.cups.invites.map((i) => ({ cupId: i.cupId, cupName: i.cupName, at: i.at, until: i.until })),
    } : null,
    recaps: clone(s.seasonRecap?.recaps) ?? [],
    play: {
      // §57 (Round 19 integration): the tip cards this player has read (ids only)
      tips: s.tips ? { seen: [...s.tips.seen] } : null,
      seasonPass: clone(s.seasonPass), passHistory: clone(s.passHistory) ?? [], loginBonus: clone(s.loginBonus), missions: clone(s.missions),
      seasonMissions: clone(s.seasonMissions) ?? null, onboarding: clone(s.onboarding) ?? null, breeding: clone(s.breeding),
      breedingExtra: clone(s.breedingExtra) ?? null, dailyWins: clone(s.dailyWins) ?? null, friendRewards: clone(s.friendRewards),
      timeAttack: s.timeAttack ? { seasonBest: clone(s.timeAttack.seasonBest), allTimeBest: clone(s.timeAttack.allTimeBest), milestones: [...s.timeAttack.milestones], daily: clone(s.timeAttack.daily),
        runs: s.timeAttack.sessions.map((x) => ({ trackId: x.trackId, horseId: x.horseId, seasonId: x.seasonId, issuedAt: x.issuedAt, status: x.status, result: clone(x.result) })) } : null,
      // §66 (Round 22): 騎手の道 — per-race progress and the recent runs (results only; the issued configs are not personal data)
      career: s.career ? { races: clone(s.career.races), daily: clone(s.career.daily),
        runs: s.career.sessions.map((x) => ({ raceId: x.raceId, chapterId: x.chapterId, horseId: x.horseId, issuedAt: x.issuedAt, status: x.status, result: clone(x.result) })) } : null,
      weeklyChallenge: s.weeklyChallenge ? { weeks: clone(s.weeklyChallenge.weeks), badges: clone(s.weeklyChallenge.badges), daily: clone(s.weeklyChallenge.daily),
        runs: s.weeklyChallenge.sessions.map((x) => ({ weekId: x.weekId, challengeId: x.challengeId, horseId: x.horseId, issuedAt: x.issuedAt, status: x.status, result: clone(x.result) })) } : null,
      events: clone(s.events) ?? {}, tournaments: clone(s.tournaments) ?? {},
      rival: rival ? {
        weeksWon: rival.weeksWon, weeksPlayed: rival.weeksPlayed,
        // outcomes only: the rival is another player (no id, no name)
        results: rival.results.map((r) => ({ weekId: r.weekId, outcome: r.outcome, kind: r.kind, me: r.me, them: r.them, freeCoins: r.freeCoins, settledAt: r.settledAt, newTitles: [...r.newTitles] })),
        currentWeeks: rival.weeks.map((w) => ({ weekId: w.weekId, me: w.me, them: w.them, rankedRaces: w.rankedRaces, ta: clone(w.ta) })),
      } : null,
      stud: stud ? {
        listings: clone(stud.listings), lends: clone(stud.lends), borrows: clone(stud.borrows),
        history: stud.history.map((h) => ({ role: h.role, at: h.at, horseId: h.horseId, horseName: h.horseName, fee: h.fee, paid: h.paid, foalId: h.foalId })),
      } : null,
      hall: clone(s.hall) ?? null, collection: omit(st.collection as { cheerRefs?: unknown } | undefined, 'cheerRefs'), teamGoal: omit(st.teamGoal as { pending?: unknown } | undefined, 'pending'),
      comeback: clone(s.comeback) ?? null, nextAction: clone(s.nextAction) ?? null, nudges: clone(s.nudges) ?? null,
    },
    devices: (push?.devices ?? []).map((d) => ({ platform: d.platform, addedAt: d.addedAt, lastSeenAt: d.lastSeenAt, locale: d.locale ?? null, pushTokenEnd: maskToken(d.token) })),
    analytics: {
      kpiState: clone(s.kpi) ?? null,
      // §59: the store review prompts (time, moment, platform, style, the pre-question answer); the session id is internal
      reviewPrompts: (s.reviewPrompt?.history ?? []).map((h) => ({ at: h.at, moment: h.moment, platform: h.platform, style: h.style, answer: h.answer, storeReviewAskedAt: h.nativeAt })),
      events: ext.kpiEvents === null ? { available: false, windowDays: null, rows: [] as Record<string, unknown>[] } : { available: true, windowDays: ext.kpiEvents.windowDays, rows: ext.kpiEvents.rows },
      // §60.9 (REQ-CERR-019): the error reports this device sent with the player's id (scrubbed; no stack, no free text)
      clientErrors: ext.clientErrors === null ? { available: false, rows: [] as DexClientErrorRow[] } : { available: true, rows: (ext.clientErrors ?? []).map((r) => ({ ...r })) },
    },
    // §48 (Round 18 integration): the player's inquiries — what they wrote, what they attached, the replies (without the
    // operator's id: an operator note) — and their article votes
    helpInquiries: {
      available: true,
      items: (help?.tickets ?? []).map((t) => ({
        ticketId: t.id, category: t.category, status: t.status, language: t.lang, createdAt: t.createdAt, updatedAt: t.updatedAt, firstReplyAt: t.firstReplyAt,
        description: t.description, redactedParts: t.redacted,
        attachments: t.attachments.map((a) => ({ kind: a.kind, ref: a.ref, at: a.at, title: a.title, detail: a.detail })),
        diagnostics: clone(t.diagnostics),
        messages: t.messages.map((x) => ({ from: x.from, content: x.content, at: x.at })),
      })) as unknown[],
      articleVotes: Object.entries(help?.votes ?? {}).map(([articleId, v]) => ({ articleId, helpful: v.helpful, at: v.at })),
    },
  };
  return doc;
}
export type ExportDocument = ReturnType<typeof buildExportDocument>;

// ------------------------------------------------------------------------------------------------ serializer (REQ-DEX-009)

/**
 * Streaming-friendly JSON: the header first, then one section per top-level key in DEX_SECTIONS order, with every
 * element of a large list on its own line (line-oriented tools and streaming parsers can read it without loading it
 * whole). Over `maxBytes`, the oldest coin history rows are dropped (free first, then paid) and listed in `truncated`.
 */
export function serializeExport(doc: ExportDocument, maxBytes: number): { body: string; bytes: number; truncated: number } {
  const enc = new TextEncoder();
  const render = () => {
    const parts: string[] = [];
    const head = ['format', 'version', 'requestId', 'playerId', 'generatedAt', 'language', 'timeUnit', 'sections', 'truncated', 'notIncluded', 'unclassified'] as const;
    for (const k of head) parts.push(`${JSON.stringify(k)}:${JSON.stringify(doc[k])}`);
    for (const sec of DEX_SECTIONS) parts.push(`${JSON.stringify(sec)}:${renderValue(doc[sec], 1)}`);
    return `{\n${parts.join(',\n')}\n}\n`;
  };
  let body = render();
  let bytes = enc.encode(body).length;
  let dropped = 0;
  const lists = [doc.coinHistory.free, doc.coinHistory.paid];
  while (bytes > maxBytes && lists.some((l) => l.length > 0)) {
    const l = lists.find((x) => x.length > 0)!;
    // drop about the share that is over (at least one row)
    const over = bytes - maxBytes;
    const per = Math.max(1, Math.ceil(bytes / Math.max(1, l.length + 1)));
    const n = Math.min(l.length, Math.max(1, Math.ceil(over / per)));
    l.splice(0, n);
    dropped += n;
    doc.truncated = [{ section: 'coinHistory', omitted: dropped }];
    body = render();
    bytes = enc.encode(body).length;
  }
  if (bytes > maxBytes) throw new AppError('CONFLICT', 'export too large');
  return { body, bytes, truncated: dropped };
}
function renderValue(v: unknown, depth: number): string {
  if (Array.isArray(v)) return v.length === 0 ? '[]' : `[\n${v.map((e) => JSON.stringify(e)).join(',\n')}\n]`;
  if (v && typeof v === 'object' && depth > 0) {
    const entries = Object.entries(v as Record<string, unknown>);
    if (entries.length === 0) return '{}';
    return `{\n${entries.map(([k, x]) => `${JSON.stringify(k)}:${renderValue(x, depth - 1)}`).join(',\n')}\n}`;
  }
  return JSON.stringify(v ?? null);
}

// ------------------------------------------------------------------------------------------------ summary (REQ-DEX-008)

/** Labels of the human-readable summary (Japanese; English through the catalog, values are never translated). */
export const DEX_SUMMARY = {
  title: 'ムチ一閃 保存されているデータの概要',
  intro: 'このファイルは、あなたのアカウントに保存されているデータの概要です。すべての項目は同じリクエストの JSON ファイルにあります。',
  generatedAt: '作成日時（UTC）',
  playerId: 'プレイヤーID',
  displayName: '表示名',
  createdAt: 'アカウント作成日（UTC）',
  paid: '有償コインの残高',
  free: '無償コインの残高',
  horses: '馬の数',
  purchases: '購入の記録',
  coinRows: 'コインの履歴（行）',
  gachaRows: 'スカウトの記録（90日以内）',
  friends: 'フレンド',
  blocks: 'ブロック',
  reports: 'あなたが送った通報',
  activity: 'お知らせ',
  replays: '保存したリプレイ',
  photos: '保存した写真',
  recaps: '振り返り',
  devices: '登録した端末',
  analytics: '分析イベント',
  unavailable: '取得できませんでした',
  truncated: 'ファイルの大きさの上限のため、古いコインの履歴を{n}行省略しました。全件はお問い合わせからご請求いただけます。',
  notIncluded: '含めていないもの：重複や処理用の内部記録、運営のメモ、他のプレイヤーの情報。',
  contact: 'ご不明な点はゲーム内のお問い合わせからご連絡ください。',
} as const;

export function summaryLines(doc: ExportDocument): { label: string; value: string | null }[] {
  const L = DEX_SUMMARY;
  const iso = (ms: number) => new Date(ms).toISOString().replace('.000Z', 'Z');
  const n = (v: number) => String(v);
  const lines: { label: string; value: string | null }[] = [
    { label: L.title, value: null }, { label: L.intro, value: null },
    { label: L.generatedAt, value: iso(doc.generatedAt) }, { label: L.playerId, value: doc.playerId },
    { label: L.displayName, value: doc.profile.displayName }, { label: L.createdAt, value: iso(doc.account.createdAt) },
    { label: L.paid, value: n(doc.wallet.paid) }, { label: L.free, value: n(doc.wallet.free) },
    { label: L.horses, value: n(doc.horses.items.length) }, { label: L.purchases, value: n(doc.purchases.items.length) },
    { label: L.coinRows, value: n(doc.coinHistory.paid.length + doc.coinHistory.free.length) }, { label: L.gachaRows, value: n(doc.gacha.items.length) },
    { label: L.friends, value: n(doc.social.friends.length) }, { label: L.blocks, value: n(doc.social.blocks.length) },
    { label: L.reports, value: doc.reportsMade.available ? n(doc.reportsMade.items.length) : L.unavailable },
    { label: L.activity, value: n(doc.activity.length) }, { label: L.replays, value: n(doc.replays.saved.length) },
    { label: L.photos, value: n(doc.photos.length) }, { label: L.recaps, value: n(doc.recaps.length) },
    { label: L.devices, value: n(doc.devices.length) },
    { label: L.analytics, value: doc.analytics.events.available ? n(doc.analytics.events.rows.length) : L.unavailable },
  ];
  const t = doc.truncated[0];
  if (t) lines.push({ label: L.truncated.replace('{n}', String(t.omitted)), value: null });
  lines.push({ label: L.notIncluded, value: null }, { label: L.contact, value: null });
  return lines;
}
export const renderSummary = (lines: { label: string; value: string | null }[]) =>
  `${lines.map((l) => (l.value === null ? l.label : `${l.label}: ${l.value}`)).join('\n')}\n`;
