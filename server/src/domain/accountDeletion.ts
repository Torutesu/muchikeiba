/**
 * REQ-UXS-040: in-app account deletion (App Store 5.1.1(v), Google Play data deletion).
 *
 *   1. DELETE /v1/player            → a confirmation token (short-lived) and what will be given up
 *   2. DELETE /v1/player + token    → deletion scheduled `cancelWindowDays` (14) later; the account keeps working
 *   3. POST /v1/player/deletion/cancel within the window → nothing happens
 *   4. at the scheduled time the player's object alarm runs runAccountDeletion(): the player is taken out of
 *      friends, teams (and their team feeds), stud listings, leaderboards, event boards and tournaments; the purchase records and coin
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
import { allowanceRemaining, forfeitAllowances } from './shop.js';
import { forfeitPass, passRemaining } from './pass.js';
import { inviteDeletionSnapshot } from './invite.js';
import { forfeitGiftBox } from './giftBox.js';

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
  /**
   * Revision: 0 when built, +1 each time it is rebuilt because something was credited after the balances were given
   * up (a store purchase is always granted, even while the deletion runs). AccountingDO keeps the latest one.
   */
  rev: number;
  /** The player's ledger sequence the record covers (rebuilt when the state moved past it). */
  ledgerSeq: number;
  deletedAt: number;
  retainUntil: number;
  /** Install month only (no exact date). */
  cohortMonth: string;
  purchases: Pick<PurchaseRecord, 'txId' | 'platform' | 'productId' | 'priceYen' | 'at' | 'paidCoinsGranted' | 'bonusCoinsGranted' | 'refunded' | 'sandbox'>[];
  ledger: LedgerEntry[];
  monthlySpendYen: Record<string, number>;
  /**
   * Store refunds that arrived after the wipe (the store transaction points to `anonId`, AccountingDO applies them
   * with applyRetainedRefund). The coins of the purchase were already given up, so nothing is left to take back:
   * the refund is recorded here, the purchase is marked refunded and a `refund` ledger row (delta 0) is added.
   */
  refundsAfterDeletion?: { txId: string; at: number; priceYen: number; paidCoins: number; bonusCoins: number }[];
  /**
   * Balances given up. `allowance`: unclaimed days (and their free coins) of running or queued 厩舎手当 packs.
   * `pass`: this season's pass (premium = bought and running) and the levels not paid out.
   */
  forfeited: {
    paidCoins: number; freeCoins: number; paidYen: number;
    allowance: { days: number; freeCoins: number };
    pass: { seasonId: string; premium: boolean; level: number; unclaimedFree: number; unclaimedPremium: number };
    /** REQ-BOX-009: unclaimed gift box entries given up (absent on records made before the box existed). */
    gifts?: { entries: number; freeCoins: number };
  };
}

export const DELETION_STEPS = ['friends', 'invites', 'team', 'stud', 'stable', 'leaderboards', 'events', 'tournaments', 'rival', 'finalize', 'retain', 'wipe'] as const;
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
      forfeit: {
        paidCoins: s.wallet.paid, freeCoins: s.wallet.free, horses: s.horses.length, items: Object.values(s.items).reduce((a, n) => a + n, 0),
        // REQ-UXS-018/020: unclaimed 厩舎手当 days and the season pass go too
        allowanceDays: allowanceRemaining(m, s, now).days, seasonPass: passRemaining(m, s, now).premium,
        // REQ-BOX-009: unclaimed gift box entries are cleared with the account
        gifts: s.giftBox?.box.length ?? 0,
      },
      notice: `削除を確定すると${cfg.cancelWindowDays}日後にアカウントと全てのデータが削除されます。期間内は取り消せます。有償コイン・無償コイン・馬・アイテム・厩舎手当の残りの日数・シーズンパスは全て失われ、払い戻しはありません。購入の記録は法令に基づき、個人を特定できない形で保存します。`,
    };
  }
  if (!d || d.token !== confirmToken || (d.tokenExpiresAt ?? 0) <= now) throw new AppError('DELETION_CONFIRM_INVALID', 'request a new confirmation token');
  s.deletion = { status: 'scheduled', requestedAt: now, deleteAt: now + cfg.cancelWindowDays * DAY_MS, steps: [], attempts: 0 };
  return deletionView(s);
}

export function cancelDeletion(s: PlayerState) {
  const d = s.deletion;
  if (!d || d.status === 'confirming') { delete s.deletion; throw new AppError('NOT_FOUND', 'no deletion is scheduled'); }
  // the run is irreversible once started (friends, boards and the directory are already being cleared)
  if (d.status === 'deleting') throw new AppError('DELETION_IN_PROGRESS', 'the account deletion has already started and cannot be cancelled');
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
  /** REQ-TEAMFEED-008: teams whose feed holds this player's stamps, race items or reactions (current team included). */
  feedTeams?: string[];
  studHorseIds: string[];
  eventIds: string[];
  /** R2 keys of this player's ghosts. */
  ghostKeys: string[];
  /** REQ-INV-010: who invited the player, whom they invited, and the install claim of their redemption. Absent on older snapshots. */
  invite?: { inviterId: string | null; invitees: string[]; installHash: string | null };
  steps: string[];
}

export function deletionSnapshot(s: PlayerState): DeletionSnapshot {
  return {
    friends: [...s.friends.ids], incoming: s.friends.incoming.map((x) => x.from), outgoing: s.friends.outgoing.map((x) => x.to),
    teamId: s.team?.teamId ?? null, teamRequests: (s.team?.outgoing ?? []).map((o) => o.teamId),
    feedTeams: [...new Set([...((s as PlayerState & { teamFeed?: { postedIn: string[] } }).teamFeed?.postedIn ?? []), ...(s.team?.teamId ? [s.team.teamId] : [])])],
    studHorseIds: (s.stud?.listings ?? []).map((l) => l.horseId),
    eventIds: Object.keys(s.events ?? {}),
    ghostKeys: Object.keys(s.timeAttack?.seasonBest ?? {}).map((k) => { const [season, track] = k.split(':'); return `ghosts/${season}/${track}/${s.id}.json`; }),
    steps: [...(s.deletion?.steps ?? [])],
    invite: inviteDeletionSnapshot(s),
  };
}

/** The run starts: from now on it cannot be cancelled. NOT_FOUND when the deletion was cancelled meanwhile. */
export function startDeletion(s: PlayerState) {
  const d = s.deletion;
  if (!d || d.status === 'confirming') throw new AppError('NOT_FOUND', 'no deletion is scheduled');
  d.status = 'deleting';
  return { steps: [...d.steps] };
}

/** REQ-UXS-040: once the run has started, the player's own state-changing calls (friends, entries, likes) are refused. */
export function notWhileDeleting(s: PlayerState) {
  if (s.deletion?.status === 'deleting') throw new AppError('DELETION_PENDING', 'the account is being deleted');
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
  const prev = d.record;
  // The account keeps working until the wipe and a completed store payment is always credited: anything that
  // reached the state after the record was built (a purchase, a refund, a reward) is given up too and the record is
  // rebuilt under the same anonymous id, so the retained purchases and ledger are complete (資金決済法・帳簿).
  if (prev && !recordStale(s, prev)) return prev;
  const anonId = prev?.anonId ?? randomId('anon', rng);
  const add = { ...forfeitAll(s, now, `delete:${anonId}`), allowance: forfeitAllowances(m, s, now), pass: forfeitPass(m, s, now), gifts: forfeitGiftBox(s) };
  const forfeited = prev ? mergeForfeited(prev.forfeited, add) : add;
  const record: RetainedRecord = {
    anonId, rev: prev ? prev.rev + 1 : 0, ledgerSeq: s.ledgerSeq,
    deletedAt: prev?.deletedAt ?? now, retainUntil: prev?.retainUntil ?? now + deletionConfig(m).ledgerRetentionDays * DAY_MS,
    cohortMonth: jstMonthKey(s.createdAt),
    purchases: s.purchases.map((p) => ({ txId: p.txId, platform: p.platform, productId: p.productId, priceYen: p.priceYen, at: p.at, paidCoinsGranted: p.paidCoinsGranted, bonusCoinsGranted: p.bonusCoinsGranted, refunded: p.refunded, ...(p.sandbox ? { sandbox: true } : {}) })),
    ledger: s.ledger.map((e) => ({ ...e })),
    monthlySpendYen: { ...s.monthlySpendYen },
    forfeited,
  };
  d.record = record;
  return record;
}

/** Something was credited, refunded or bought after the record was built. */
function recordStale(s: PlayerState, r: RetainedRecord): boolean {
  if (s.ledgerSeq !== (r.ledgerSeq ?? s.ledgerSeq)) return true;
  if (s.purchases.length !== r.purchases.length) return true;
  if (s.purchases.some((p, i) => p.refunded !== r.purchases[i]?.refunded)) return true;
  if (s.wallet.paid > 0 || s.wallet.free > 0) return true;
  if ((s.giftBox?.box.length ?? 0) > 0) return true; // REQ-BOX-009: a gift arrived after the record was built
  return false;
}

function mergeForfeited(a: RetainedRecord['forfeited'], b: RetainedRecord['forfeited']): RetainedRecord['forfeited'] {
  return {
    paidCoins: a.paidCoins + b.paidCoins, freeCoins: a.freeCoins + b.freeCoins, paidYen: a.paidYen + b.paidYen,
    allowance: { days: a.allowance.days + b.allowance.days, freeCoins: a.allowance.freeCoins + b.allowance.freeCoins },
    pass: { ...a.pass, premium: a.pass.premium || b.pass.premium },
    gifts: { entries: (a.gifts?.entries ?? 0) + (b.gifts?.entries ?? 0), freeCoins: (a.gifts?.freeCoins ?? 0) + (b.gifts?.freeCoins ?? 0) },
  };
}

/**
 * REQ-UXS-040 × REQ-PUR-006: a store refund for a purchase of a deleted account (AccountingDO, legal retention).
 * Idempotent per transaction. Throws NOT_FOUND when the record holds no such purchase.
 */
export function applyRetainedRefund(r: RetainedRecord, txId: string, now: number) {
  const i = r.purchases.findIndex((x) => x.txId === txId);
  if (i < 0) throw new AppError('NOT_FOUND', `purchase ${txId} is not in retained record ${r.anonId}`);
  const p = r.purchases[i]!;
  const base = { retained: true as const, anonId: r.anonId, transactionId: txId, priceYen: p.priceYen, paidCoins: p.paidCoinsGranted, bonusCoins: p.bonusCoinsGranted };
  if (p.refunded) return { record: r, result: { ...base, alreadyRefunded: true } };
  const record: RetainedRecord = structuredClone(r);
  record.purchases[i] = { ...p, refunded: true };
  (record.refundsAfterDeletion ??= []).push({ txId, at: now, priceYen: p.priceYen, paidCoins: p.paidCoinsGranted, bonusCoins: p.bonusCoinsGranted });
  const seq = record.ledger.reduce((a, e) => Math.max(a, e.seq), 0) + 1;
  record.ledger.push({
    seq, at: now, kind: 'refund', currency: 'paid', delta: 0, balanceAfter: 0,
    reason: `store refund after account deletion (${p.paidCoinsGranted} paid + ${p.bonusCoinsGranted} bonus coins already forfeited)`, ref: txId,
  });
  record.rev = (record.rev ?? 0) + 1;
  return { record, result: { ...base, alreadyRefunded: false } };
}

/** Team succession when the leader leaves: the earliest officer, else the earliest member. */
export function pickSuccessor(members: { playerId: string; role: string; joinedAt: number }[], leaving: string): string | null {
  const others = members.filter((x) => x.playerId !== leaving).sort((a, b) => a.joinedAt - b.joinedAt);
  return (others.find((x) => x.role === 'officer') ?? others[0])?.playerId ?? null;
}

/** Everything outside the player's own object that the deletion touches (Durable Object RPC in production). */
export interface DeletionPorts {
  /** Marks the run started (no cancel from now on); fails with NOT_FOUND when it was cancelled. Called first. */
  start?(uid: string): Promise<unknown>;
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
  /**
   * REQ-INV-010: the invite code is retired, the install claim keeps only its hash, both sides' records are anonymised
   * and the player's undelivered milestone rewards are forfeited.
   */
  invites?: {
    forfeitOwn(uid: string): Promise<unknown>;
    retireCode(uid: string): Promise<void>;
    anonymizeInstall(installHash: string): Promise<void>;
    forgetInvitee(inviterId: string, uid: string): Promise<unknown>;
    forgetInviter(inviteeId: string, uid: string): Promise<unknown>;
  };
  team?: {
    members(teamId: string, uid: string): Promise<{ playerId: string; role: string; joinedAt: number }[]>;
    leave(teamId: string, uid: string): Promise<unknown>;
    transfer(teamId: string, uid: string, to: string): Promise<unknown>;
    dropRequest(teamId: string, uid: string): Promise<unknown>;
    /** REQ-TEAMFEED-008: remove the player's feed items and reactions from a team's feed. */
    forgetFeed?(teamId: string, uid: string): Promise<unknown>;
  };
  /** Friend code, public profile and stud listings in the directory. */
  directory: { forget(uid: string): Promise<void> };
  /** Season / time attack boards: removed from the current season, renamed in closed ones; ghosts deleted. */
  leaderboards: { forget(uid: string, now: number): Promise<void>; deleteGhosts(keys: string[]): Promise<void> };
  /** マイ厩舎 (feat/my-stable): removes the public stable copy (DirectoryDO row only; safe before or after the wipe). */
  stable?: { removeStable(uid: string): Promise<void> };
  events?: { forget(eventId: string, uid: string): Promise<void> };
  tournaments?: { forget(uid: string, now: number): Promise<void> };
  /** REQ-RIVAL-011: this and last week's rival registries — candidate entry, pair (dissolved for the rival), card, times. */
  rival?: { forget(uid: string, now: number): Promise<void> };
  finalize(uid: string): Promise<RetainedRecord>;
  retain(uid: string, record: RetainedRecord): Promise<void>;
  wipe(uid: string): Promise<void>;
}

/** Runs (or resumes) a due deletion. Throws on the first failing step; the caller retries later. */
export async function runAccountDeletion(p: DeletionPorts, uid: string, now: number): Promise<{ done: DeletionStep[] }> {
  // first: no cancel can half-stop the run after this point, and a cancel that came earlier stops it here
  if (p.start) await p.start(uid);
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
  await step('invites', async () => {
    const iv = p.invites;
    if (!iv) return;
    await iv.forfeitOwn(uid);
    await iv.retireCode(uid);
    const x = snap.invite;
    if (!x) return;
    if (x.installHash) await iv.anonymizeInstall(x.installHash);
    if (x.inviterId) await tolerant(() => iv.forgetInvitee(x.inviterId!, uid));
    for (const o of x.invitees) await tolerant(() => iv.forgetInviter(o, uid));
  });
  await step('team', async () => {
    const t = p.team;
    if (!t) return;
    for (const tid of snap.teamRequests) await tolerant(() => t.dropRequest(tid, uid));
    // REQ-TEAMFEED-008: the player's stamps, race items and reactions leave every feed they were posted to
    if (t.forgetFeed) for (const tid of snap.feedTeams ?? []) await tolerant(() => t.forgetFeed!(tid, uid));
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
  await step('rival', async () => { await p.rival?.forget(uid, now); });
  await step('finalize', () => p.finalize(uid));
  // finalize again right before storing: a purchase granted since then is given up and included (same anonId)
  let retainedRev: number | null = null;
  await step('retain', async () => { const r = await p.finalize(uid); await p.retain(uid, r); retainedRev = r.rev; });
  await step('wipe', async () => {
    // the record may have changed while it travelled to the store (or the retain step ran in an earlier attempt):
    // store the latest one, and wipe only once nothing changed since it was stored
    for (let i = 0; ; i++) {
      const r = await p.finalize(uid);
      if (r.rev === retainedRev) break;
      if (i >= 5) throw new AppError('CONFLICT', 'the account keeps changing while it is deleted; retry later');
      await p.retain(uid, r);
      retainedRev = r.rev;
    }
    await p.wipe(uid);
  });
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
