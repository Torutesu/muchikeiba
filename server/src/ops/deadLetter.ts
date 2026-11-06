import { AppError } from '../domain/errors.js';
import type { RolloverState } from '../domain/leaderboard.js';
import type { SettleMeta } from '../race/settlement.js';

/**
 * REQ-OPS-036/041: dead letters — work items that failed past their automatic retry budget and were set aside
 * so everything after them could proceed:
 *
 *  - season   : a player's season close (LeaderboardDO `lb:<seasonId>`, rollover cursor)
 *  - team     : a team's season payout   (LeaderboardDO `lb:<seasonId>`, team rollover)
 *  - event    : a player's event rank reward (EventDO `ev:<eventId>`)
 *  - settlement: a player's race result   (RaceRoomDO `<raceId>`, settle meta)
 *  - moderation: a quarantine/ban push to a player (IntegrityDO outbox, still retried automatically)
 *  - tournament: a player's tournament prize (TournamentDO `tour:<id>`, payouts)
 *
 * The owning object stays the source of truth; a registry in OpsDO indexes them so ops can list everything in
 * one place. Ops can retry an item (the underlying operation is idempotent: closeSeason / eventClose /
 * teamSeasonReward are marked per season or event on the player, applyRace is keyed by the race id) or dismiss
 * it with a note (handled by hand, e.g. with a compensation grant).
 */
export const DEAD_LETTER_SOURCES = ['season', 'team', 'event', 'settlement', 'moderation', 'tournament'] as const;
export type DeadLetterSource = (typeof DEAD_LETTER_SOURCES)[number];
export type DeadLetterStatus = 'open' | 'resolved' | 'dismissed';

export interface DeadLetterItem { itemId: string; error: string; attempts: number }
export interface DeadLetterRecord extends DeadLetterItem {
  source: DeadLetterSource; scope: string; status: DeadLetterStatus;
  firstSeenAt: number; updatedAt: number; resolvedBy?: string; note?: string;
}
/** Moderation items are keyed by player only: one registry row per player whatever scope string a caller used (QA r6 #6). */
export const normalizeDlScope = (source: DeadLetterSource, scope: string) => (source === 'moderation' ? 'global' : scope);

/**
 * How a producer's report changes the registry row (QA r6 #6): new → insert; open → refresh (keep firstSeenAt);
 * resolved/dismissed → reopen only when the report is newer than the resolution (a later, real failure),
 * never for a stale re-report of the same failure. Returns null when the row should stay as it is.
 */
export function mergeDeadLetter(prev: DeadLetterRecord | null, r: DeadLetterRecord): DeadLetterRecord | null {
  const rec = { ...r, scope: normalizeDlScope(r.source, r.scope) };
  if (!prev) return rec;
  if (prev.status === 'open') return { ...rec, firstSeenAt: prev.firstSeenAt };
  if (rec.updatedAt > prev.updatedAt) {
    const { resolvedBy: _rb, note: _n, ...rest } = rec;
    return { ...rest, status: 'open' };
  }
  return null;
}

export interface Dismissed { id: string; error: string; by: string; note: string; at: number }
export interface RetryOutcome { ok: boolean; error?: string }

/** What an owning object exposes for one scope (season id, event id, race id, `global`). */
export interface DeadLetterOwner {
  list(scope: string): Promise<DeadLetterItem[]>;
  retry(scope: string, itemId: string): Promise<RetryOutcome>;
  dismiss(scope: string, itemId: string, by: string, note: string, now: number): Promise<void>;
}

export interface DeadLetterRegistry {
  upsert(r: DeadLetterRecord): Promise<void>;
  get(source: DeadLetterSource, scope: string, itemId: string): Promise<DeadLetterRecord | null>;
  list(q: { status?: DeadLetterStatus; source?: DeadLetterSource; limit: number }): Promise<DeadLetterRecord[]>;
}

/** Admin-facing API (in-memory for tests, Durable Objects in production). */
export interface DeadLetterApi {
  list(q: { status?: DeadLetterStatus; source?: DeadLetterSource; limit: number }): Promise<DeadLetterRecord[]>;
  inspect(source: DeadLetterSource, scope: string, now: number): Promise<DeadLetterRecord[]>;
  retry(source: DeadLetterSource, scope: string, itemId: string, by: string, now: number): Promise<DeadLetterRecord>;
  dismiss(source: DeadLetterSource, scope: string, itemId: string, by: string, note: string, now: number): Promise<DeadLetterRecord>;
}

export class DeadLetterService implements DeadLetterApi {
  constructor(private readonly registry: DeadLetterRegistry, private readonly owners: Partial<Record<DeadLetterSource, DeadLetterOwner>>) {}

  private owner(source: DeadLetterSource): DeadLetterOwner {
    const o = this.owners[source];
    if (!o) throw new AppError('NOT_FOUND', `no dead-letter owner for ${source}`);
    return o;
  }

  list(q: { status?: DeadLetterStatus; source?: DeadLetterSource; limit: number }) { return this.registry.list(q); }

  /** Reads the owner's current dead letters (the truth) and refreshes the registry from them. */
  async inspect(source: DeadLetterSource, scope: string, now: number): Promise<DeadLetterRecord[]> {
    const items = await this.owner(source).list(scope);
    const out: DeadLetterRecord[] = [];
    for (const it of items) {
      const prev = await this.registry.get(source, scope, it.itemId);
      const rec: DeadLetterRecord = { ...it, source, scope, status: 'open', firstSeenAt: prev?.firstSeenAt ?? now, updatedAt: now };
      await this.registry.upsert(rec);
      out.push(rec);
    }
    return out;
  }

  async retry(source: DeadLetterSource, scope: string, itemId: string, by: string, now: number): Promise<DeadLetterRecord> {
    const items = await this.owner(source).list(scope);
    const cur = items.find((x) => x.itemId === itemId);
    const prev = await this.registry.get(source, scope, itemId);
    if (!cur) {
      if (prev && prev.status !== 'open') return prev; // retried or dismissed already: idempotent
      throw new AppError('NOT_FOUND', `dead letter ${source}/${scope}/${itemId}`);
    }
    const r = await this.owner(source).retry(scope, itemId);
    const rec: DeadLetterRecord = r.ok
      ? { ...cur, source, scope, status: 'resolved', firstSeenAt: prev?.firstSeenAt ?? now, updatedAt: now, resolvedBy: by }
      : { ...cur, source, scope, status: 'open', error: r.error ?? cur.error, attempts: cur.attempts + 1, firstSeenAt: prev?.firstSeenAt ?? now, updatedAt: now };
    await this.registry.upsert(rec);
    return rec;
  }

  async dismiss(source: DeadLetterSource, scope: string, itemId: string, by: string, note: string, now: number): Promise<DeadLetterRecord> {
    const items = await this.owner(source).list(scope);
    const cur = items.find((x) => x.itemId === itemId);
    const prev = await this.registry.get(source, scope, itemId);
    if (!cur) {
      if (prev && prev.status !== 'open') return prev;
      throw new AppError('NOT_FOUND', `dead letter ${source}/${scope}/${itemId}`);
    }
    await this.owner(source).dismiss(scope, itemId, by, note, now);
    const rec: DeadLetterRecord = { ...cur, source, scope, status: 'dismissed', firstSeenAt: prev?.firstSeenAt ?? now, updatedAt: now, resolvedBy: by, note };
    await this.registry.upsert(rec);
    return rec;
  }
}

// ---- owner-side helpers (pure state changes; the owning DO persists them) ----

export type RolloverWithLog = RolloverState & { dismissed?: Dismissed[] };

export const rolloverDeadLetters = (st: RolloverState | null): DeadLetterItem[] =>
  (st?.deadLetter ?? []).map((d) => ({ itemId: d.id, error: d.error, attempts: d.attempts }));

/** Runs `run` for a dead-lettered rollover item; success removes it, failure records the error. */
/**
 * Retries one dead-lettered item. `reload` re-reads the owner's state AFTER the awaited call: a Durable
 * Object keeps serving requests while it awaits an outgoing call, so the rollover cron may have moved the
 * cursor or dead-lettered other items meanwhile (QA r6 #4). Only this one item is changed on the fresh state.
 */
export async function retryRolloverItem(st: RolloverWithLog, itemId: string, run: () => Promise<void>, reload?: () => RolloverWithLog | null): Promise<{ st: RolloverWithLog; outcome: RetryOutcome }> {
  const d = (st.deadLetter ?? []).find((x) => x.id === itemId);
  if (!d) throw new AppError('NOT_FOUND', `dead letter ${itemId}`);
  let outcome: RetryOutcome;
  try {
    await run();
    outcome = { ok: true };
  } catch (e) {
    outcome = { ok: false, error: (e as Error).message };
  }
  const cur = (reload ? reload() : null) ?? st;
  const next: RolloverWithLog = outcome.ok
    ? { ...cur, deadLetter: (cur.deadLetter ?? []).filter((x) => x.id !== itemId) }
    : { ...cur, deadLetter: (cur.deadLetter ?? []).map((x) => (x.id === itemId ? { ...x, error: outcome.error ?? 'failed', attempts: x.attempts + 1 } : x)) };
  return { st: next, outcome };
}

export function dismissRolloverItem(st: RolloverWithLog, itemId: string, by: string, note: string, now: number): RolloverWithLog {
  const d = (st.deadLetter ?? []).find((x) => x.id === itemId);
  if (!d) throw new AppError('NOT_FOUND', `dead letter ${itemId}`);
  return { ...st, deadLetter: (st.deadLetter ?? []).filter((x) => x.id !== itemId), dismissed: [...(st.dismissed ?? []), { id: itemId, error: d.error, by, note, at: now }].slice(-500) };
}

export type SettleMetaWithLog = SettleMeta;

export const settlementDeadLetters = (meta: SettleMetaWithLog | null): DeadLetterItem[] =>
  (meta?.deadLetter ?? []).map((pid) => ({ itemId: pid, error: meta?.deadLetterErrors?.[pid]?.error ?? 'applyRace failed', attempts: meta?.deadLetterErrors?.[pid]?.attempts ?? meta?.settleAttempts ?? 0 }));

/** Re-applies a dead-lettered player's race result (applyRace is idempotent on the race id). */
export async function retrySettlementItem(meta: SettleMetaWithLog, playerId: string, apply: (pid: string, r: NonNullable<SettleMeta['results']>[string]) => Promise<void>): Promise<RetryOutcome> {
  if (!(meta.deadLetter ?? []).includes(playerId)) throw new AppError('NOT_FOUND', `dead letter ${playerId}`);
  const res = meta.results?.[playerId];
  if (!res) throw new AppError('NOT_FOUND', `no result kept for ${playerId}`);
  try {
    await apply(playerId, res);
    meta.deadLetter = (meta.deadLetter ?? []).filter((x) => x !== playerId);
    if (meta.deadLetterErrors) delete meta.deadLetterErrors[playerId];
    return { ok: true };
  } catch (e) {
    const error = (e as Error).message;
    const prev = meta.deadLetterErrors?.[playerId];
    meta.deadLetterErrors = { ...(meta.deadLetterErrors ?? {}), [playerId]: { error, attempts: (prev?.attempts ?? meta.settleAttempts) + 1 } };
    return { ok: false, error };
  }
}

export function dismissSettlementItem(meta: SettleMetaWithLog, playerId: string, by: string, note: string, now: number) {
  if (!(meta.deadLetter ?? []).includes(playerId)) throw new AppError('NOT_FOUND', `dead letter ${playerId}`);
  const error = meta.deadLetterErrors?.[playerId]?.error ?? 'applyRace failed';
  meta.deadLetter = (meta.deadLetter ?? []).filter((x) => x !== playerId);
  meta.dismissed = [...(meta.dismissed ?? []), { id: playerId, error, by, note, at: now }];
}

/** In-memory registry (tests, local tooling). */
export class MemoryDeadLetterRegistry implements DeadLetterRegistry {
  rows = new Map<string, DeadLetterRecord>();
  private k = (s: string, sc: string, i: string) => `${s}|${sc}|${i}`;
  async upsert(r: DeadLetterRecord) { this.rows.set(this.k(r.source, r.scope, r.itemId), { ...r }); }
  async get(s: DeadLetterSource, sc: string, i: string) { return this.rows.get(this.k(s, sc, i)) ?? null; }
  async list(q: { status?: DeadLetterStatus; source?: DeadLetterSource; limit: number }) {
    return [...this.rows.values()].filter((r) => (!q.status || r.status === q.status) && (!q.source || r.source === q.source)).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, q.limit);
  }
}

// ---- moderation outbox (items keep retrying on their own; "dead" = failed MODERATION_DEAD_AFTER times) ----

export const MODERATION_DEAD_AFTER = 3;
