/**
 * REQ-BREED-010..016: stud lending (種牡馬の貸し借り), the per-player half.
 *
 * An owner lists a retired stallion for friends or for everyone. A borrower breeds one of their own
 * retired mares with it; the owner keeps the horse. The fee is FREE coins only (never paid coins: there is
 * no path that moves purchased value between players — docs/planning/03-legal-risk.md), capped per fee,
 * per horse per day, and per owner per day.
 *
 * The cross-player transaction (studService.ts) runs as idempotent steps keyed by one opId:
 *   1. owner   reserve  — checks listing, visibility and the daily limit; returns a snapshot of the sire
 *   2. borrower apply   — charges the fee, breeds, records the opId and an outbox entry (one transaction)
 *   3. owner   settle   — pays the fee (capped), records history; a failed step 2 releases instead
 *   4. borrower acked   — drops the outbox entry
 * A crash between steps leaves either a reservation (expires; nobody was charged) or an outbox entry
 * (retried from the borrower's alarm until the owner acknowledges). Every step is safe to repeat.
 */
import { AppError, assert } from './errors.js';
import type { Master, StudConfig } from './master.js';
import type { HorseInstance, PlayerState, StudHistoryEntry, StudState } from './player.js';
import { breedingAllowance, breedWith, checkDam, effectiveStats, getHorse, parentTraits, previewFor, studKey, type GrandTrait } from './horses.js';
import type { Rng } from './rng.js';
import { appearanceOf, type Appearance } from './visuals.js';
import { grantFree, spendFree } from './wallet.js';
import { gameDayKey } from './time.js';

export type StudVisibility = 'friends' | 'public';

/** Public listing as stored in the directory and shown when browsing. The owner's object stays the source of truth. */
export interface StudEntry {
  ownerId: string; ownerName: string; horseId: string; name: string; rarity: HorseInstance['rarity'];
  line: string; style: HorseInstance['style']; distMinM: number; distMaxM: number; surface: HorseInstance['surface'];
  goingAptitude: string; statTotal: number; awakening: number; appearance: Appearance;
  visibility: StudVisibility; fee: number; dailyLimit: number; listedAt: number;
}

/** What the borrower's object needs to breed with the stallion: the horse as the owner has it, plus its parents' traits. */
export interface StudSnapshot { ownerId: string; horseId: string; horse: HorseInstance; grand: GrandTrait[]; fee: number }

/** Hard limits a remote config can never exceed (legal/economy guard: player-to-player value stays small). */
export const STUD_HARD_LIMITS = { feeMax: 500, dailyEarnCap: 1500, dailyLimitMax: 10, borrowPerDay: 5, atavismPermille: 150 };

export function studConfigProblems(p: { stud?: StudConfig; atavismPermille?: number }): string[] {
  const out: string[] = [];
  const intIn = (v: unknown, lo: number, hi: number) => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;
  if (p.atavismPermille !== undefined && !intIn(p.atavismPermille, 0, STUD_HARD_LIMITS.atavismPermille)) out.push(`progression.atavismPermille must be 0..${STUD_HARD_LIMITS.atavismPermille}`);
  const c = p.stud;
  if (!c) return out;
  if (!intIn(c.feeMax, 0, STUD_HARD_LIMITS.feeMax)) out.push(`progression.stud.feeMax must be 0..${STUD_HARD_LIMITS.feeMax}`);
  if (!intIn(c.dailyEarnCap, 0, STUD_HARD_LIMITS.dailyEarnCap)) out.push(`progression.stud.dailyEarnCap must be 0..${STUD_HARD_LIMITS.dailyEarnCap}`);
  if (!intIn(c.dailyLimitMax, 1, STUD_HARD_LIMITS.dailyLimitMax)) out.push(`progression.stud.dailyLimitMax must be 1..${STUD_HARD_LIMITS.dailyLimitMax}`);
  if (!intIn(c.borrowPerDay, 0, STUD_HARD_LIMITS.borrowPerDay)) out.push(`progression.stud.borrowPerDay must be 0..${STUD_HARD_LIMITS.borrowPerDay}`);
  if (!intIn(c.maxListings, 0, 20)) out.push('progression.stud.maxListings must be 0..20');
  if (!intIn(c.reserveTtlMs, 10_000, 3_600_000)) out.push('progression.stud.reserveTtlMs must be 10s..1h');
  if (!intIn(c.retryMs, 1000, 3_600_000)) out.push('progression.stud.retryMs must be 1s..1h');
  if (!intIn(c.historyKeep, 1, 500) || !intIn(c.browseLimit, 1, 200)) out.push('progression.stud.historyKeep/browseLimit');
  return out;
}

export function studConfig(m: Master): StudConfig {
  const c = m.progression.stud;
  if (!c) throw new AppError('NOT_FOUND', 'stud lending is not available');
  return c;
}

export function ensureStud(s: PlayerState): StudState {
  s.stud ??= { listings: [], reservations: {}, settled: {}, lends: { date: '', byHorse: {}, earned: 0 }, applied: {}, outbox: [], borrows: { date: '', count: 0 }, history: [] };
  return s.stud;
}

const SETTLED_KEEP_MS = 30 * 86_400_000;
/** Older stored settlements were a bare settled-at number (no horse/borrower recorded). */
const settledAt = (v: StudState['settled'][string]) => (typeof v === 'number' ? v : v.at);
const APPLIED_KEEP_MS = 30 * 86_400_000;

/** Drops expired reservations and old idempotency records; rolls the daily counters. */
export function pruneStud(m: Master, st: StudState, now: number) {
  const c = studConfig(m);
  const today = gameDayKey(now);
  if (st.lends.date !== today) st.lends = { date: today, byHorse: {}, earned: 0 };
  if (st.borrows.date !== today) st.borrows = { date: today, count: 0 };
  for (const [k, r] of Object.entries(st.reservations)) if (now - r.at > c.reserveTtlMs) delete st.reservations[k];
  for (const [k, v] of Object.entries(st.settled)) if (now - settledAt(v) > SETTLED_KEEP_MS) delete st.settled[k];
  for (const [k, a] of Object.entries(st.applied)) if (now - a.at > APPLIED_KEEP_MS) delete st.applied[k];
}

function lendsToday(st: StudState, horseId: string, today: string) {
  const settled = st.lends.date === today ? st.lends.byHorse[horseId] ?? 0 : 0;
  const pending = Object.values(st.reservations).filter((r) => r.horseId === horseId && r.date === today).length;
  return settled + pending;
}

export function studEntry(m: Master, s: PlayerState, l: { horseId: string; visibility: StudVisibility; fee: number; dailyLimit: number; listedAt: number }): StudEntry {
  const h = getHorse(s, l.horseId);
  const st = effectiveStats(m, h);
  return {
    ownerId: s.id, ownerName: s.profile.displayName, horseId: h.id, name: h.name, rarity: h.rarity, line: h.line, style: h.style,
    distMinM: h.distMinM, distMaxM: h.distMaxM, surface: h.surface, goingAptitude: h.goingAptitude ?? 'any',
    statTotal: Object.values(st).reduce((a, b) => a + b, 0), awakening: h.awakening, appearance: appearanceOf(h, s.id),
    visibility: l.visibility, fee: l.fee, dailyLimit: l.dailyLimit, listedAt: l.listedAt,
  };
}

/** REQ-BREED-010: list (or update) a retired stallion. Returns the directory entry. */
export function studList(m: Master, s: PlayerState, horseId: string, visibility: StudVisibility, fee: number, dailyLimit: number, now: number): StudEntry {
  const c = studConfig(m);
  const h = getHorse(s, horseId);
  if (h.status !== 'retired') throw new AppError('HORSE_NOT_RETIRED');
  if (h.sex !== 'male') throw new AppError('BREEDING_INVALID_PAIR', 'only stallions can be listed');
  if (!Number.isInteger(fee) || fee < 0 || fee > c.feeMax) throw new AppError('BAD_REQUEST', `fee must be 0..${c.feeMax} free coins`);
  if (!Number.isInteger(dailyLimit) || dailyLimit < 1 || dailyLimit > c.dailyLimitMax) throw new AppError('BAD_REQUEST', `dailyLimit must be 1..${c.dailyLimitMax}`);
  const st = ensureStud(s);
  const cur = st.listings.find((x) => x.horseId === horseId);
  if (!cur && st.listings.length >= c.maxListings) throw new AppError('NOT_ELIGIBLE', `at most ${c.maxListings} listings`);
  const l = { horseId, visibility, fee, dailyLimit, listedAt: cur?.listedAt ?? now };
  if (cur) Object.assign(cur, l);
  else st.listings.push(l);
  return studEntry(m, s, l);
}

export function studUnlist(s: PlayerState, horseId: string) {
  const st = ensureStud(s);
  const i = st.listings.findIndex((x) => x.horseId === horseId);
  if (i < 0) throw new AppError('NOT_FOUND', 'not listed');
  st.listings.splice(i, 1);
  return { horseId, listed: false };
}

function offered(st: StudState, s: PlayerState, borrowerId: string, horseId: string) {
  const l = st.listings.find((x) => x.horseId === horseId);
  if (!l) throw new AppError('NOT_FOUND', 'this stallion is not offered');
  if (borrowerId === s.id) throw new AppError('NOT_ELIGIBLE', 'breed your own stallion from the normal breeding screen');
  if (l.visibility === 'friends' && !s.friends.ids.includes(borrowerId)) throw new AppError('FORBIDDEN', 'offered to friends only');
  return l;
}

const snapshotOf = (s: PlayerState, h: HorseInstance, fee: number): StudSnapshot =>
  ({ ownerId: s.id, horseId: h.id, horse: { ...structuredClone(h), appearance: appearanceOf(h, s.id) }, grand: parentTraits(s, h), fee });

/** Owner, read-only: the snapshot a preview needs, and how many lends are left today. Reserves nothing. */
export function studPeek(m: Master, s: PlayerState, borrowerId: string, horseId: string, now: number) {
  const st = ensureStud(s);
  pruneStud(m, st, now);
  const l = offered(st, s, borrowerId, horseId);
  return { ...snapshotOf(s, getHorse(s, horseId), l.fee), remainingToday: Math.max(0, l.dailyLimit - lendsToday(st, horseId, gameDayKey(now))) };
}

/**
 * Step 1 (owner): reserve one lend. Idempotent per opId: a repeated reserve (held or already paid) returns
 * the snapshot again without taking another slot.
 */
export function studReserve(m: Master, s: PlayerState, opId: string, borrowerId: string, horseId: string, now: number, expectedFee?: number): StudSnapshot {
  // QA r7 #9: the borrower confirmed a fee on screen; refuse if the owner changed it since (clear code, nothing reserved)
  const feeCheck = (fee: number) => {
    if (expectedFee !== undefined && expectedFee !== fee) throw new AppError('FEE_CHANGED', `the stud fee is now ${fee} free coins`);
  };
  const st = ensureStud(s);
  pruneStud(m, st, now);
  // a retried op resumes: held or already paid → the snapshot of the horse the op was reserved for, even if
  // the listing changed since (the borrower's apply returns its first result for a finished op). The same key
  // can never switch stallion or borrower: that would breed with an unlisted/hidden horse at another's fee (QA r7 #1).
  const held = st.reservations[opId];
  if (held) {
    if (held.horseId !== horseId || held.borrowerId !== borrowerId) throw new AppError('CONFLICT', 'this idempotency key was used for another stud breeding');
    feeCheck(held.fee);
    return snapshotOf(s, getHorse(s, held.horseId), held.fee);
  }
  const done = st.settled[opId];
  if (done !== undefined) {
    if (typeof done !== 'number') {
      if (done.horseId !== horseId || done.borrowerId !== borrowerId) throw new AppError('CONFLICT', 'this idempotency key was used for another stud breeding');
      return snapshotOf(s, getHorse(s, done.horseId), done.fee);
    }
    // legacy record without the horse: only answer for a stallion this borrower may see right now
    const l = offered(st, s, borrowerId, horseId);
    return snapshotOf(s, getHorse(s, horseId), l.fee);
  }
  const l = offered(st, s, borrowerId, horseId);
  feeCheck(l.fee);
  const today = gameDayKey(now);
  if (lendsToday(st, horseId, today) >= l.dailyLimit) throw new AppError('BREEDING_DAILY_LIMIT', 'this stallion is fully booked today');
  st.reservations[opId] = { horseId, borrowerId, fee: l.fee, at: now, date: today };
  return snapshotOf(s, getHorse(s, horseId), l.fee);
}

/**
 * Step 3 (owner): settle. ok=true pays the fee (up to today's earn cap) and records the lend; ok=false
 * releases the reservation. Idempotent per opId; a payout happens at most once. A settlement may arrive
 * after the reservation expired (the borrower was charged, so the owner is still paid).
 */
export function studSettle(m: Master, s: PlayerState, opId: string, ok: boolean, info: { borrowerId: string; horseId: string; fee: number; foalId: string | null }, now: number) {
  const c = studConfig(m);
  const st = ensureStud(s);
  pruneStud(m, st, now);
  if (st.settled[opId] !== undefined) return { opId, status: 'already' as const, paid: 0 };
  const held = st.reservations[opId];
  delete st.reservations[opId];
  if (!ok) {
    // released: nobody was charged. Not recorded in `settled`, so a later retry of the same op can reserve again.
    return { opId, status: 'released' as const, paid: 0 };
  }
  const fee = Math.max(0, Math.min(info.fee, c.feeMax));
  const paid = Math.max(0, Math.min(fee, c.dailyEarnCap - st.lends.earned));
  if (paid > 0) grantFree(s, paid, now, 'stud fee', opId);
  st.lends.earned += paid;
  st.lends.byHorse[info.horseId] = (st.lends.byHorse[info.horseId] ?? 0) + 1;
  const borrowerId = held?.borrowerId ?? info.borrowerId;
  st.settled[opId] = { at: now, horseId: info.horseId, borrowerId, fee };
  const h = s.horses.find((x) => x.id === info.horseId);
  pushHistory(m, st, { opId, role: 'lent', at: now, ownerId: s.id, borrowerId, horseId: info.horseId, horseName: h?.name ?? '', fee, paid, foalId: info.foalId });
  return { opId, status: 'paid' as const, paid };
}

export function pushHistory(m: Master, st: StudState, e: StudHistoryEntry) {
  st.history.push(e);
  const keep = studConfig(m).historyKeep;
  if (st.history.length > keep) st.history.splice(0, st.history.length - keep);
}

/** Step 4 (borrower): the owner acknowledged the payment. */
export function studAcked(s: PlayerState, opId: string) {
  const st = ensureStud(s);
  const before = st.outbox.length;
  st.outbox = st.outbox.filter((o) => o.opId !== opId);
  return { opId, removed: before !== st.outbox.length };
}

/** Borrower: outbox entries due for a retry, and when the next one is due. */
export function dueStudOutbox(s: PlayerState, now: number) {
  const ob = s.stud?.outbox ?? [];
  return { due: ob.filter((o) => o.nextAt <= now), nextAt: ob.length ? Math.min(...ob.map((o) => o.nextAt)) : null };
}

/** Borrower: a retry failed; back off (1, 2, 4 … × retryMs, at most an hour). */
export function studRetryLater(m: Master, s: PlayerState, opId: string, now: number) {
  const o = s.stud?.outbox.find((x) => x.opId === opId);
  if (!o) return null;
  o.attempts += 1;
  o.nextAt = now + Math.min(3_600_000, studConfig(m).retryMs * 2 ** Math.min(6, o.attempts));
  return o.nextAt;
}

export function nextStudWake(s: PlayerState): number | null {
  const ob = s.stud?.outbox ?? [];
  return ob.length ? Math.min(...ob.map((o) => o.nextAt)) : null;
}

/** REQ-BREED-015: my listings, today's counters and history (both roles). */
export function studView(m: Master, s: PlayerState, now: number) {
  const c = studConfig(m);
  const st = ensureStud(s);
  pruneStud(m, st, now);
  const today = gameDayKey(now);
  return {
    listings: st.listings.filter((l) => s.horses.some((h) => h.id === l.horseId)).map((l): StudEntry & { lentToday: number } => ({ ...studEntry(m, s, l), lentToday: lendsToday(st, l.horseId, today) })),
    today: { earned: st.lends.earned, earnCap: c.dailyEarnCap, borrowed: st.borrows.count, borrowPerDay: c.borrowPerDay },
    limits: { feeMax: c.feeMax, dailyLimitMax: c.dailyLimitMax, maxListings: c.maxListings },
    pendingPayments: st.outbox.length,
    history: [...st.history].reverse(),
  };
}

/** Rebuilds a stallion view for the borrower's breeding core from the owner's snapshot. */
export function studSireView(snap: StudSnapshot): HorseInstance {
  const h = snap.horse;
  assert(h.sex === 'male' && h.status === 'retired', 'BREEDING_INVALID_PAIR');
  return { ...structuredClone(h), id: studKey(snap.ownerId, snap.horseId), sireId: null, damId: null };
}

/** Borrower: preview with a borrowed stallion, from the same functions as the real breeding (REQ-BREED-016). */
export function studPreview(m: Master, s: PlayerState, snap: StudSnapshot & { remainingToday?: number }, damId: string, now: number) {
  const c = studConfig(m);
  const dam = checkDam(s, damId);
  const sire = studSireView(snap);
  const st = ensureStud(s);
  pruneStud(m, st, now);
  return {
    ...previewFor(m, s, sire, dam, [...snap.grand, ...parentTraits(s, dam)]),
    today: breedingAllowance(m, s, now),
    stud: {
      ownerId: snap.ownerId, horseId: snap.horseId, name: snap.horse.name, fee: snap.fee, feeCurrency: 'free' as const,
      remainingToday: snap.remainingToday ?? null, borrowed: st.borrows.count, borrowPerDay: c.borrowPerDay,
      canPay: s.wallet.free - studHeldFree(s, now) >= snap.fee && s.wallet.debt === 0,
      heldFree: studHeldFree(s, now),
    },
  };
}

/** QA r7 #10: how long free coins credited by a purchase stay out of stud fees (store refunds/chargebacks claw them back). */
export const STUD_PURCHASE_HOLD_DAYS = 90;

/**
 * QA r7 #10: free coins that a store purchase credited (the first-purchase bonus, sandbox credits) and that a
 * refund within the hold period would claw back. They may not leave the account as a stud fee — the
 * borrower must keep at least this much free after paying — so a refund can never have moved them to
 * another player first. Other uses (gacha, shop) stay allowed (a refund then becomes debt as before).
 */
export function studHeldFree(s: PlayerState, now: number): number {
  const since = now - STUD_PURCHASE_HOLD_DAYS * 86_400_000;
  let held = 0;
  for (const p of s.purchases) {
    if (p.refunded || p.at < since) continue;
    if (!p.bonusLotId) held += p.bonusCoinsGranted; // a bonus granted as paid coins can never pay a stud fee anyway
    held += p.sandboxFreeGranted ?? 0;
    held += p.linkedFree ?? 0; // REQ-UXS-018/021: daily-pack coins and pass rewards a refund would take back
  }
  return held;
}

export interface StudApplyResult {
  opId: string; ownerId: string; horseId: string; fee: number;
  foal: HorseInstance; nick: boolean; inbreedingCount: number; usedMaterial: boolean; atavism: HorseInstance['atavism'] | null;
}

/**
 * Step 2 (borrower): charge the fee in free coins, breed, remember the op and queue the owner's payment —
 * all in one transaction. Idempotent per opId: a repeat returns the first result and charges nothing.
 */
export function studApply(m: Master, s: PlayerState, opId: string, snap: StudSnapshot, damId: string, rng: Rng, now: number, useMaterial: boolean): StudApplyResult {
  const c = studConfig(m);
  const st = ensureStud(s);
  pruneStud(m, st, now);
  const done = st.applied[opId];
  if (done) return done.result as StudApplyResult;
  if (snap.ownerId === s.id) throw new AppError('NOT_ELIGIBLE');
  if (st.borrows.count >= c.borrowPerDay) throw new AppError('BREEDING_DAILY_LIMIT', 'stud breedings for today are used up');
  const dam = checkDam(s, damId);
  const sire = studSireView(snap);
  const fee = Math.max(0, Math.min(snap.fee, c.feeMax));
  if (fee > 0) {
    if (s.wallet.free < fee) throw new AppError('INSUFFICIENT_COINS', `stud fee is ${fee} free coins (paid coins cannot be used)`);
    const held = studHeldFree(s, now);
    if (s.wallet.free - fee < held) throw new AppError('INSUFFICIENT_COINS', `${held} free coins from a recent purchase (first-purchase bonus) cannot pay stud fees for ${STUD_PURCHASE_HOLD_DAYS} days`);
    spendFree(s, fee, now, 'stud fee', opId);
  }
  const r = breedWith(m, s, sire, dam, [...snap.grand, ...parentTraits(s, dam)], rng, now, {
    useMaterial, ref: opId, stud: { ownerId: snap.ownerId, horseId: snap.horseId, sireName: snap.horse.sireName, damName: snap.horse.damName },
  });
  st.borrows.count += 1;
  st.outbox.push({ opId, ownerId: snap.ownerId, horseId: snap.horseId, fee, foalId: r.foal.id, at: now, nextAt: now + c.retryMs, attempts: 0 });
  pushHistory(m, st, { opId, role: 'borrowed', at: now, ownerId: snap.ownerId, borrowerId: s.id, horseId: snap.horseId, horseName: snap.horse.name, fee, paid: fee, foalId: r.foal.id });
  const result: StudApplyResult = { opId, ownerId: snap.ownerId, horseId: snap.horseId, fee, foal: r.foal, nick: r.nick, inbreedingCount: r.inbreedingCount, usedMaterial: r.usedMaterial, atavism: r.atavism };
  st.applied[opId] = { at: now, result: JSON.parse(JSON.stringify(result)) };
  return result;
}
