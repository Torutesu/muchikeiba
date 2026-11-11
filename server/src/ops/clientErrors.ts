import { AppError } from '../domain/errors.js';
import { DAY_MS } from '../domain/time.js';
import {
  CLIENT_ERROR_CATEGORIES, contextOf, deviceField, fingerprintOf, scrubItem, titleOf,
  type ClientErrorBatch, type ClientErrorCategory, type ClientErrorPlatform, type ClientErrorsConfig,
} from '../domain/clientErrors.js';

/**
 * The client error store (REQ-CERR-005/007/010..019, contracts/protocol.md §60.5–60.9). Lives in the ClientErrorsDO
 * singleton (SQLite, wrangler migration v7) — its own object so a burst of reports never queues behind the remote config
 * or the admin audit log in OpsDO. Aggregates only: one row per fingerprint, day × version × platform counts and a few
 * newest samples per fingerprint. Player ids appear only on samples (and the hourly rate rows), never in aggregates.
 */
export const BATCH_KEEP_MS = 48 * 3600_000;
export const HOUR_MS = 3600_000;
const MINUTE_MS = 60_000;
/** Old rows purged per accepted batch (keeps the work per call small). */
const PURGE_BATCH = 50;
const VERSIONS_KEPT = 20;
export const DETAIL_DAYS = 14;

export interface ClientErrorAlert { at: number; appVersion: string; estimated: number }
export interface ClientErrorGroup {
  fingerprint: string; category: ClientErrorCategory; title: string;
  count: number; estimated: number; firstSeen: number; lastSeen: number;
  firstVersion: string; lastVersion: string;
  versions: Record<string, number>;
  platforms: Partial<Record<ClientErrorPlatform, number>>;
  alert: ClientErrorAlert | null;
}
export interface ClientErrorDay { fingerprint: string; day: string; appVersion: string; platform: ClientErrorPlatform; count: number }
export interface ClientErrorSample {
  id: number; fingerprint: string; at: number; platform: ClientErrorPlatform; appVersion: string; osVersion: string; deviceModel: string;
  playerId: string | null; message: string | null; stack: string | null; context: Record<string, unknown>;
}

export interface ClientErrorQuery { category?: ClientErrorCategory; platform?: ClientErrorPlatform; appVersion?: string; sort?: 'count' | 'last' | 'new'; limit: number }

export interface ClientErrorRepo {
  hasBatch(key: string): boolean;
  /** Records the batch key (kept BATCH_KEEP_MS). */
  claimBatch(key: string, now: number): void;
  /** Adds one to the counter of `key` in the window starting at `windowStart`; returns the new count. */
  bump(key: string, windowStart: number): number;
  /** The current count (no change). */
  peek(key: string, windowStart: number): number;
  group(fp: string): ClientErrorGroup | null;
  putGroup(g: ClientErrorGroup): void;
  groupCount(): number;
  addDay(fp: string, day: string, appVersion: string, platform: ClientErrorPlatform, n: number): void;
  days(fp: string, fromDay: string): ClientErrorDay[];
  addSample(s: Omit<ClientErrorSample, 'id'>, keep: number): void;
  samples(fp: string): ClientErrorSample[];
  list(q: ClientErrorQuery): ClientErrorGroup[];
  alerts(since: number, limit: number): ClientErrorGroup[];
  byCategory(): Record<string, number>;
  samplesOf(playerId: string): ClientErrorSample[];
  anonymise(playerId: string): number;
  forgetRates(prefix: string): number;
  /** Purges a few rows past retention (days before `beforeDay`, samples / groups last seen before `before`, old batch keys and rate rows). */
  purge(before: number, beforeDay: string, batchBefore: number, rateBefore: number, limit: number): void;
}

export interface IngestWho { playerId: string | null; installId: string }
export interface IngestResult { accepted: number; dropped: number; duplicate: boolean; alerts: ClientErrorGroup[] }

const dayOf = (t: number) => new Date(t).toISOString().slice(0, 10);
const overflowFp = (c: ClientErrorCategory) => `overflow:${c}`;

export class ClientErrorsCore {
  constructor(private readonly repo: ClientErrorRepo, private readonly onAlert?: (g: ClientErrorGroup) => void) {}

  /**
   * REQ-CERR-005/007/010..012/017: rate limits, the idempotent batch key, then the aggregates. The batch was validated
   * by the route (zod); every free-text field is scrubbed again here.
   */
  ingest(b: ClientErrorBatch, who: IngestWho, now: number, c: ClientErrorsConfig): IngestResult {
    if (b.items.length > c.maxItems) throw new AppError('BAD_REQUEST', `at most ${c.maxItems} items per batch`);
    const batchKey = `${b.installId}|${b.batchId}`;
    // a retry of a batch already stored answers duplicate even when the limits are used up (it costs nothing)
    const hour = Math.floor(now / HOUR_MS) * HOUR_MS;
    const minute = Math.floor(now / MINUTE_MS) * MINUTE_MS;
    const limits: [string, number, number][] = [[`d:${b.installId}`, hour, c.perDevicePerHour]];
    if (who.playerId) limits.push([`p:${who.playerId}`, hour, c.perPlayerPerHour]);
    else limits.push(['anon', minute, c.anonymousPerMinute]);
    if (this.repo.hasBatch(batchKey)) return { accepted: 0, dropped: 0, duplicate: true, alerts: [] };
    // a refused batch is not remembered: the device keeps it and sends it again with the same id later
    for (const [k, w, max] of limits) if (this.repo.peek(k, w) >= max) throw new AppError('RATE_LIMITED', 'too many error reports; try later');
    this.repo.claimBatch(batchKey, now);
    for (const [k, w] of limits) this.repo.bump(k, w);

    this.repo.purge(now - c.retentionDays * DAY_MS, dayOf(now - c.retentionDays * DAY_MS), now - BATCH_KEEP_MS, now - 2 * HOUR_MS, PURGE_BATCH);
    const appVersion = b.appVersion;
    const platform = b.platform;
    const osVersion = deviceField(b.osVersion);
    const deviceModel = deviceField(b.deviceModel);
    const playerId = who.playerId && b.attachPlayer ? who.playerId : null; // REQ-CERR-013
    const day = dayOf(now);
    const alerts: ClientErrorGroup[] = [];
    let accepted = 0;
    for (const item of b.items) {
      const s = scrubItem(item);
      let fp = fingerprintOf(s);
      let g = this.repo.group(fp);
      if (!g && this.repo.groupCount() >= c.maxGroups) { // REQ-CERR-011
        fp = overflowFp(s.category);
        g = this.repo.group(fp);
      }
      const est = Math.round((item.count * 1000) / item.sampleRate);
      if (!g) {
        g = {
          fingerprint: fp, category: s.category, title: fp.startsWith('overflow:') ? `other ${s.category} errors (store full)` : titleOf(s),
          count: 0, estimated: 0, firstSeen: now, lastSeen: now, firstVersion: appVersion, lastVersion: appVersion, versions: {}, platforms: {}, alert: null,
        };
      }
      g.count += item.count;
      g.estimated += est;
      g.lastSeen = now;
      g.lastVersion = appVersion;
      g.versions[appVersion] = (g.versions[appVersion] ?? 0) + item.count;
      const vs = Object.entries(g.versions).sort((a, b2) => b2[1] - a[1] || (a[0] < b2[0] ? -1 : 1));
      if (vs.length > VERSIONS_KEPT) g.versions = Object.fromEntries(vs.slice(0, VERSIONS_KEPT));
      g.platforms[platform] = (g.platforms[platform] ?? 0) + item.count;
      // REQ-CERR-017: a new fingerprint (first seen inside the window) reaching the threshold — once
      if (!g.alert && !fp.startsWith('overflow:') && now - g.firstSeen <= c.spikeWindowHours * HOUR_MS && g.estimated >= c.spikeMinCount) {
        g.alert = { at: now, appVersion, estimated: g.estimated };
        alerts.push({ ...g });
      }
      this.repo.putGroup(g);
      this.repo.addDay(fp, day, appVersion, platform, item.count);
      this.repo.addSample({
        fingerprint: fp, at: now, platform, appVersion, osVersion, deviceModel, playerId,
        message: s.category === 'exception' ? s.message : null, stack: s.category === 'exception' ? s.stack : null,
        context: { ...contextOf(s), deviceAt: item.at, count: item.count, sampleRate: item.sampleRate },
      }, c.samplesPerGroup);
      accepted += 1;
    }
    for (const a of alerts) {
      // the alert hook (§60.8): a structured log line Workers Logs / Logpush rules match on
      console.warn(JSON.stringify({ alert: 'client_error_spike', fingerprint: a.fingerprint, category: a.category, appVersion: a.alert!.appVersion, estimated: a.alert!.estimated, title: a.title }));
      this.onAlert?.(a);
    }
    return { accepted, dropped: b.items.length - accepted, duplicate: false, alerts };
  }

  /** REQ-CERR-014: the console list. */
  list(q: ClientErrorQuery, now: number, c: ClientErrorsConfig) {
    const groups = this.repo.list({ ...q, limit: Math.max(1, Math.min(500, q.limit)) }).map(groupView);
    const byCategory = Object.fromEntries(CLIENT_ERROR_CATEGORIES.map((k) => [k, 0])) as Record<ClientErrorCategory, number>;
    for (const [k, v] of Object.entries(this.repo.byCategory())) if (k in byCategory) byCategory[k as ClientErrorCategory] = v;
    return {
      groups,
      alerts: this.repo.alerts(now - 7 * DAY_MS, 20).map(groupView),
      totals: { groups: this.repo.groupCount(), byCategory },
      config: { retentionDays: c.retentionDays, maxGroups: c.maxGroups, spikeMinCount: c.spikeMinCount, spikeWindowHours: c.spikeWindowHours },
    };
  }

  /** REQ-CERR-015: one fingerprint with its last 14 days and its samples. */
  get(fp: string, now: number) {
    const g = this.repo.group(fp);
    if (!g) throw new AppError('NOT_FOUND', `client error ${fp}`);
    return { ...groupView(g), days: this.repo.days(fp, dayOf(now - (DETAIL_DAYS - 1) * DAY_MS)), samples: this.repo.samples(fp) };
  }

  /** REQ-CERR-019: the samples tied to the player, for their data export. */
  madeBy(playerId: string) {
    return this.repo.samplesOf(playerId).map((s) => {
      const g = this.repo.group(s.fingerprint);
      return { at: s.at, category: g?.category ?? null, title: g?.title ?? null, appVersion: s.appVersion, platform: s.platform, deviceModel: s.deviceModel, osVersion: s.osVersion };
    }).sort((a, b) => a.at - b.at);
  }

  /** REQ-CERR-018 (account deletion, idempotent): samples lose the player id; the player's rate row goes. */
  forgetPlayer(playerId: string) {
    return { anonymised: this.repo.anonymise(playerId), rates: this.repo.forgetRates(`p:${playerId}`) };
  }
}

const groupView = (g: ClientErrorGroup) => ({
  ...g,
  versions: Object.entries(g.versions).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([appVersion, count]) => ({ appVersion, count })),
});

// ------------------------------------------------------------------------------------------------ in memory (tests, prototype)

export class MemoryClientErrorRepo implements ClientErrorRepo {
  batches = new Map<string, number>();
  rates = new Map<string, { w: number; n: number }>();
  groups = new Map<string, ClientErrorGroup>();
  dayRows = new Map<string, ClientErrorDay>();
  sampleRows: ClientErrorSample[] = [];
  seq = 0;
  hasBatch(key: string) { return this.batches.has(key); }
  claimBatch(key: string, now: number) { this.batches.set(key, now); }
  bump(key: string, w: number) { const r = this.rates.get(key); const n = r && r.w === w ? r.n + 1 : 1; this.rates.set(key, { w, n }); return n; }
  peek(key: string, w: number) { const r = this.rates.get(key); return r && r.w === w ? r.n : 0; }
  group(fp: string) { const g = this.groups.get(fp); return g ? structuredClone(g) : null; }
  putGroup(g: ClientErrorGroup) { this.groups.set(g.fingerprint, structuredClone(g)); }
  groupCount() { return this.groups.size; }
  addDay(fp: string, day: string, v: string, p: ClientErrorPlatform, n: number) {
    const k = [fp, day, v, p].join('|');
    const r = this.dayRows.get(k);
    this.dayRows.set(k, { fingerprint: fp, day, appVersion: v, platform: p, count: (r?.count ?? 0) + n });
  }
  days(fp: string, from: string) { return [...this.dayRows.values()].filter((d) => d.fingerprint === fp && d.day >= from).sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0)).map((d) => ({ ...d })); }
  addSample(s: Omit<ClientErrorSample, 'id'>, keep: number) {
    this.sampleRows.push({ ...structuredClone(s), id: ++this.seq });
    const mine = this.sampleRows.filter((x) => x.fingerprint === s.fingerprint);
    if (mine.length > keep) { const drop = new Set(mine.slice(0, mine.length - keep).map((x) => x.id)); this.sampleRows = this.sampleRows.filter((x) => !drop.has(x.id)); }
  }
  samples(fp: string) { return this.sampleRows.filter((x) => x.fingerprint === fp).sort((a, b) => b.id - a.id).map((x) => structuredClone(x)); }
  list(q: ClientErrorQuery) {
    return [...this.groups.values()].filter((g) => (!q.category || g.category === q.category) && (!q.platform || (g.platforms[q.platform] ?? 0) > 0) && (!q.appVersion || (g.versions[q.appVersion] ?? 0) > 0))
      .sort(groupOrder(q.sort ?? 'count')).slice(0, q.limit).map((g) => structuredClone(g));
  }
  alerts(since: number, limit: number) { return [...this.groups.values()].filter((g) => g.alert && g.alert.at >= since).sort((a, b) => b.alert!.at - a.alert!.at).slice(0, limit).map((g) => structuredClone(g)); }
  byCategory() { const o: Record<string, number> = {}; for (const g of this.groups.values()) o[g.category] = (o[g.category] ?? 0) + 1; return o; }
  samplesOf(pid: string) { return this.sampleRows.filter((x) => x.playerId === pid).map((x) => structuredClone(x)); }
  anonymise(pid: string) { let n = 0; for (const s of this.sampleRows) if (s.playerId === pid) { s.playerId = null; n += 1; } return n; }
  forgetRates(key: string) { return this.rates.delete(key) ? 1 : 0; }
  purge(before: number, beforeDay: string, batchBefore: number, rateBefore: number, limit: number) {
    let n = 0;
    for (const [k, d] of this.dayRows) { if (n >= limit) break; if (d.day < beforeDay) { this.dayRows.delete(k); n += 1; } }
    for (const g of [...this.groups.values()].filter((x) => x.lastSeen < before).slice(0, limit)) {
      this.groups.delete(g.fingerprint);
      this.sampleRows = this.sampleRows.filter((s) => s.fingerprint !== g.fingerprint);
    }
    this.sampleRows = this.sampleRows.filter((s) => s.at >= before);
    for (const [k, t] of this.batches) if (t < batchBefore) this.batches.delete(k);
    for (const [k, r] of this.rates) if (r.w < rateBefore) this.rates.delete(k);
  }
}

export const groupOrder = (sort: 'count' | 'last' | 'new') => (a: ClientErrorGroup, b: ClientErrorGroup) =>
  sort === 'last' ? b.lastSeen - a.lastSeen || b.count - a.count
    : sort === 'new' ? b.firstSeen - a.firstSeen || b.count - a.count
      : b.count - a.count || b.lastSeen - a.lastSeen;
