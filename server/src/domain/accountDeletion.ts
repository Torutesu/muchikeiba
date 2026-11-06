/**
 * REQ-UXS-040: in-app account deletion (App Store 5.1.1(v), Google Play data deletion).
 *
 *   1. DELETE /v1/player            → a confirmation token (short-lived) and what will be given up
 *   2. DELETE /v1/player + token    → deletion scheduled `cancelWindowDays` (14) later; the account keeps working
 *   3. POST /v1/player/deletion/cancel within the window → nothing happens
 *   4. at the scheduled time the player's object alarm runs runAccountDeletion(): the player is taken out of
 *      friends, teams, stud listings, leaderboards, event boards and tournaments; the purchase records and coin
 *      ledger required by law (資金決済法・特商法・帳簿) are anonymised and kept `ledgerRetentionDays` under a
 *      random id that is not linked to the account; then every piece of the player's own data is deleted.
 *
 * Each step is idempotent and recorded on the player state, so a failed run resumes where it stopped.
 */
import { AppError } from './errors.js';
import type { Master } from './master.js';
import type { LedgerEntry, PlayerState, PurchaseRecord } from './player.js';
import { randomId, type Rng } from './rng.js';
import { DAY_MS, jstMonthKey } from './time.js';
import { forfeitAll } from './wallet.js';

export interface AccountDeletionConfig {
  /** Days between the confirmed request and the deletion (the request can be cancelled meanwhile). */
  cancelWindowDays: number;
  /** Lifetime of the confirmation token from step 1. */
  confirmTtlMs: number;
  /** How long the anonymised purchase records and ledger are kept (legal retention). */
  ledgerRetentionDays: number;
}

export interface DeletionState {
  status: 'confirming' | 'scheduled' | 'deleting';
  /** Step-1 token (only while confirming). */
  token?: string;
  tokenExpiresAt?: number;
  requestedAt?: number;
  deleteAt?: number;
  /** Orchestration steps already done (see DELETION_STEPS). */
  steps: string[];
  attempts: number;
  /** Next retry after a failed run. */
  retryAt?: number;
  /** The anonymised record, built once (a resumed run re-sends the same one). */
  record?: RetainedRecord;
}

/** What is kept after deletion: no name, no device, no friend, no horse — only what the law requires. */
export interface RetainedRecord {
  anonId: string;
  deletedAt: number;
  retainUntil: number;
  /** Install month only (no exact date). */
  cohortMonth: string;
  purchases: Pick<PurchaseRecord, 'txId' | 'platform' | 'productId' | 'priceYen' | 'at' | 'paidCoinsGranted' | 'bonusCoinsGranted' | 'refunded' | 'sandbox'>[];
  ledger: LedgerEntry[];
  monthlySpendYen: Record<string, number>;
  forfeited: { paidCoins: number; freeCoins: number; paidYen: number };
}

export const DELETION_STEPS = ['friends', 'team', 'stud', 'stable', 'leaderboards', 'events', 'tournaments', 'finalize', 'retain', 'wipe'] as const;
export type DeletionStep = typeof DELETION_STEPS[number];
export const DELETED_PLAYER_NAME = '退会したプレイヤー';
const RETRY_MS = [60_000, 600_000, 3_600_000, 6 * 3_600_000];

export function deletionConfig(m: Master): AccountDeletionConfig {
  return m.progression.accountDeletion ?? { cancelWindowDays: 14, confirmTtlMs: 600_000, ledgerRetentionDays: 2557 };
}

export function deletionView(s: PlayerState) {
  const d = s.deletion;
  if (!d || d.status === 'confirming') return { status: 'none' as const, requestedAt: null, deleteAt: null };
  return { status: 'scheduled' as const, requestedAt: d.requestedAt ?? null, deleteAt: d.deleteAt ?? null };
}

/**
 * Step 1 (no token): issue a token and say what will be lost. Step 2 (token): schedule the deletion.
 * Asking again while scheduled returns the schedule (idempotent).
 */
export function requestDeletion(m: Master, s: PlayerState, confirmToken: string | null, rng: Rng, now: number) {
  const cfg = deletionConfig(m);
  const d = s.deletion;
  if (d && d.status !== 'confirming') return deletionView(s);
  if (!confirmToken) {
    const token = randomId('del', rng);
    s.deletion = { status: 'confirming', token, tokenExpiresAt: now + cfg.confirmTtlMs, steps: [], attempts: 0 };
    return {
      status: 'confirm_required' as const, confirmToken: token, expiresAt: now + cfg.confirmTtlMs, cancelWindowDays: cfg.cancelWindowDays,
      // §9.4: the player sees what is given up before confirming (paid coins are not refunded)
      forfeit: { paidCoins: s.wallet.paid, freeCoins: s.wallet.free, horses: s.horses.length, items: Object.values(s.items).reduce((a, n) => a + n, 0) },
      notice: `削除を確定すると${cfg.cancelWindowDays}日後にアカウントと全てのデータが削除されます。期間内は取り消せます。有償コイン・無償コイン・馬・アイテムは全て失われ、払い戻しはありません。購入の記録は法令に基づき、個人を特定できない形で保存します。`,
    };
  }
  if (!d || d.token !== confirmToken || (d.tokenExpiresAt ?? 0) <= now) throw new AppError('DELETION_CONFIRM_INVALID', 'request a new confirmation token');
  s.deletion = { status: 'scheduled', requestedAt: now, deleteAt: now + cfg.cancelWindowDays * DAY_MS, steps: [], attempts: 0 };
  return deletionView(s);
}

export function cancelDeletion(s: PlayerState) {
  const d = s.deletion;
  if (!d || d.status === 'confirming') { delete s.deletion; throw new AppError('NOT_FOUND', 'no deletion is scheduled'); }
  if (d.status === 'deleting') throw new AppError('CONFLICT', 'the deletion has already started');
  delete s.deletion;
  return deletionView(s);
}

export const deletionScheduled = (s: PlayerState) => s.deletion?.status === 'scheduled' || s.deletion?.status === 'deleting';

/** When the player's alarm must run the deletion (or retry it). */
export function nextDeletionWake(s: PlayerState): number | null {
  const d = s.deletion;
  if (!d || d.status === 'confirming') return null;
  return Math.max(d.deleteAt ?? 0, d.retryAt ?? 0);
}

export const deletionDue = (s: PlayerState, now: number) => {
  const at = nextDeletionWake(s);
  return at !== null && now >= at;
};

/** What the orchestration needs to know about the player (read before anything is removed). */
export interface DeletionSnapshot {
  friends: string[]; incoming: string[]; outgoing: string[];
  teamId: string | null; teamRequests: string[];
  studHorseIds: string[];
  eventIds: string[];
  /** R2 keys of this player's ghosts. */
  ghostKeys: string[];
  steps: string[];
}

export function deletionSnapshot(s: PlayerState): DeletionSnapshot {
  return {
    friends: [...s.friends.ids], incoming: s.friends.incoming.map((x) => x.from), outgoing: s.friends.outgoing.map((x) => x.to),
    teamId: s.team?.teamId ?? null, teamRequests: (s.team?.outgoing ?? []).map((o) => o.teamId),
    studHorseIds: (s.stud?.listings ?? []).map((l) => l.horseId),
    eventIds: Object.keys(s.events ?? {}),
    ghostKeys: Object.keys(s.timeAttack?.seasonBest ?? {}).map((k) => { const [season, track] = k.split(':'); return `ghosts/${season}/${track}/${s.id}.json`; }),
    steps: [...(s.deletion?.steps ?? [])],
  };
}

export function markDeletionStep(s: PlayerState, step: DeletionStep) {
  const d = s.deletion;
  if (!d) throw new AppError('NOT_FOUND', 'no deletion is scheduled');
  d.status = 'deleting';
  if (!d.steps.includes(step)) d.steps.push(step);
}

/** A run failed: back off (1 min, 10 min, 1 h, then every 6 h). */
export function deletionRetryLater(s: PlayerState, now: number) {
  const d = s.deletion;
  if (!d) return null;
  d.attempts += 1;
  d.retryAt = now + RETRY_MS[Math.min(d.attempts - 1, RETRY_MS.length - 1)]!;
  return d.retryAt;
}

/**
 * Gives up every balance, builds the anonymised record and keeps it on the state until it is stored
 * elsewhere (the next step). Called once; a resumed run gets the same record back.
 */
export function finalizeDeletion(m: Master, s: PlayerState, rng: Rng, now: number): RetainedRecord {
  const d = s.deletion;
  if (!d || (d.status !== 'scheduled' && d.status !== 'deleting')) throw new AppError('NOT_FOUND', 'no deletion is scheduled');
  if (d.record) return d.record;
  const anonId = randomId('anon', rng);
  const forfeited = forfeitAll(s, now, `delete:${anonId}`);
  const record: RetainedRecord = {
    anonId, deletedAt: now, retainUntil: now + deletionConfig(m).ledgerRetentionDays * DAY_MS,
    cohortMonth: jstMonthKey(s.createdAt),
    purchases: s.purchases.map((p) => ({ txId: p.txId, platform: p.platform, productId: p.productId, priceYen: p.priceYen, at: p.at, paidCoinsGranted: p.paidCoinsGranted, bonusCoinsGranted: p.bonusCoinsGranted, refunded: p.refunded, ...(p.sandbox ? { sandbox: true } : {}) })),
    ledger: s.ledger.map((e) => ({ ...e })),
    monthlySpendYen: { ...s.monthlySpendYen },
    forfeited,
  };
  d.record = record;
  return record;
}

/** Team succession when the leader leaves: the earliest officer, else the earliest member. */
export function pickSuccessor(members: { playerId: string; role: string; joinedAt: number }[], leaving: string): string | null {
  const others = members.filter((x) => x.playerId !== leaving).sort((a, b) => a.joinedAt - b.joinedAt);
  return (others.find((x) => x.role === 'officer') ?? others[0])?.playerId ?? null;
}

/** Everything outside the player's own object that the deletion touches (Durable Object RPC in production). */
export interface DeletionPorts {
  snapshot(uid: string): Promise<DeletionSnapshot>;
  markStep(uid: string, step: DeletionStep): Promise<void>;
  /** Other players' sides of the friendship (the deleting player's own state is wiped at the end). */
  friends: {
    removeFriend(other: string, uid: string): Promise<unknown>;
    /** `from` had sent uid a request: drop it from from's outgoing list. */
    dropOutgoing(from: string, uid: string): Promise<unknown>;
    /** uid had sent `to` a request: drop it from to's incoming list. */
    dropIncoming(to: string, uid: string): Promise<unknown>;
  };
  team?: {
    members(teamId: string, uid: string): Promise<{ playerId: string; role: string; joinedAt: number }[]>;
    leave(teamId: string, uid: string): Promise<unknown>;
    transfer(teamId: string, uid: string, to: string): Promise<unknown>;
    dropRequest(teamId: string, uid: string): Promise<unknown>;
  };
  /** Friend code, public profile and stud listings in the directory. */
  directory: { forget(uid: string): Promise<void> };
  /** Season / time attack boards: removed from the current season, renamed in closed ones; ghosts deleted. */
  leaderboards: { forget(uid: string, now: number): Promise<void>; deleteGhosts(keys: string[]): Promise<void> };
  /** マイ厩舎 (feat/my-stable): removes the public stable copy (DirectoryDO row only; safe before or after the wipe). */
  stable?: { removeStable(uid: string): Promise<void> };
  events?: { forget(eventId: string, uid: string): Promise<void> };
  tournaments?: { forget(uid: string, now: number): Promise<void> };
  finalize(uid: string): Promise<RetainedRecord>;
  retain(uid: string, record: RetainedRecord): Promise<void>;
  wipe(uid: string): Promise<void>;
}

/** Runs (or resumes) a due deletion. Throws on the first failing step; the caller retries later. */
export async function runAccountDeletion(p: DeletionPorts, uid: string, now: number): Promise<{ done: DeletionStep[] }> {
  const snap = await p.snapshot(uid);
  const done: DeletionStep[] = [];
  const step = async (name: DeletionStep, f: () => Promise<unknown>) => {
    if (snap.steps.includes(name)) return;
    await f();
    if (name !== 'wipe') await p.markStep(uid, name);
    done.push(name);
  };
  const tolerant = async (f: () => Promise<unknown>) => {
    // the other side may already be gone (deleted player, removed request): NOT_FOUND / NOT_IN_TEAM are fine
    try { await f(); } catch (e) { if (!(e instanceof AppError) || !['NOT_FOUND', 'NOT_IN_TEAM', 'HORSE_NOT_FOUND'].includes(e.code)) throw e; }
  };
  await step('friends', async () => {
    for (const o of snap.friends) await tolerant(() => p.friends.removeFriend(o, uid));
    for (const f of snap.incoming) await tolerant(() => p.friends.dropOutgoing(f, uid));
    for (const t of snap.outgoing) await tolerant(() => p.friends.dropIncoming(t, uid));
  });
  await step('team', async () => {
    const t = p.team;
    if (!t) return;
    for (const tid of snap.teamRequests) await tolerant(() => t.dropRequest(tid, uid));
    const teamId = snap.teamId;
    if (!teamId) return;
    try {
      await t.leave(teamId, uid);
    } catch (e) {
      if (!(e instanceof AppError)) throw e;
      if (e.code === 'NOT_IN_TEAM' || e.code === 'NOT_FOUND') return;
      if (e.code !== 'TEAM_LEADER_MUST_TRANSFER') throw e;
      const next = pickSuccessor(await t.members(teamId, uid), uid);
      if (!next) throw e;
      await t.transfer(teamId, uid, next);
      await t.leave(teamId, uid);
    }
  });
  await step('stud', () => p.directory.forget(uid)); // listings, friend code and public profile
  await step('stable', async () => { await p.stable?.removeStable(uid); });
  await step('leaderboards', async () => {
    await p.leaderboards.forget(uid, now);
    if (snap.ghostKeys.length) await p.leaderboards.deleteGhosts(snap.ghostKeys);
  });
  await step('events', async () => { for (const e of snap.eventIds) await p.events?.forget(e, uid); });
  await step('tournaments', async () => { await p.tournaments?.forget(uid, now); });
  let record: RetainedRecord | null = null;
  await step('finalize', async () => { record = await p.finalize(uid); });
  await step('retain', async () => { await p.retain(uid, record ?? (await p.finalize(uid))); });
  await step('wipe', () => p.wipe(uid));
  return { done };
}

/** Validation of progression.accountDeletion (boot and remote config). The retention floor is the legal one. */
export const MIN_LEDGER_RETENTION_DAYS = 2557; // 7 years (帳簿の保存期間)
export function accountDeletionProblems(c: AccountDeletionConfig | undefined): string[] {
  if (!c) return [];
  const out: string[] = [];
  const intIn = (v: unknown, lo: number, hi: number) => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;
  if (!intIn(c.cancelWindowDays, 1, 30)) out.push('progression.accountDeletion.cancelWindowDays must be 1..30');
  if (!intIn(c.confirmTtlMs, 60_000, 3_600_000)) out.push('progression.accountDeletion.confirmTtlMs must be 1min..1h');
  if (!intIn(c.ledgerRetentionDays, MIN_LEDGER_RETENTION_DAYS, 4000)) out.push(`progression.accountDeletion.ledgerRetentionDays must be ${MIN_LEDGER_RETENTION_DAYS}..4000`);
  return out;
}
