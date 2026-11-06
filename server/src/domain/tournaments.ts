import { z } from 'zod';
import { AppError } from './errors.js';
import type { Master, Reward } from './master.js';
import type { DeadLetterItem } from '../ops/deadLetter.js';

/**
 * REQ-TOUR-*: scheduled tournaments. Players register in a window; at the close the field is seeded into
 * heats (snake seeding by rating); every heat is a lockstep race (mode `tournament`, verified like ranked);
 * the best `advancePerHeat` humans of each heat go on, until one heat — the final — is left. Players who
 * never connect run as CPU and are eliminated. Standings, prizes (paid once per tournament on the player)
 * and history are kept here; everything is a pure function of the state so the Durable Object is a thin
 * driver (alarms) and tests run in memory.
 */

export const TOURNAMENT_ID_RE = /^[a-z0-9][a-z0-9_-]{2,39}$/;
/** Heats are created this long before their start (clients get the ticket in /me and match status). */
export const HEAT_CREATE_LEAD_MS = 30_000;
/** A heat without a definitive result this long after its start is treated as void. */
export const HEAT_TIMEOUT_MS = 20 * 60_000;
/** Polling interval for running heats. */
export const HEAT_POLL_MS = 5_000;
/** Prize payment: retries per player before the item is dead-lettered (REQ-OPS-041). */
export const PAYOUT_MAX_ATTEMPTS = 5;
export const PAYOUT_RETRY_MS = 30_000;
/** Finished tournaments stay listed this long. */
export const TOURNAMENT_LIST_KEEP_MS = 14 * 86_400_000;

const rewardSchema = z.object({
  freeCoins: z.number().int().min(0).max(100_000).optional(),
  items: z.array(z.object({ itemId: z.string().min(1).max(64), qty: z.number().int().min(1).max(1000) })).max(8).optional(),
}).strict();

export const tournamentDefSchema = z.object({
  id: z.string().regex(TOURNAMENT_ID_RE),
  name: z.string().min(1).max(40),
  description: z.string().max(400).default(''),
  trackIds: z.array(z.string().min(1)).min(1).max(8),
  registrationOpensAtMs: z.number().int().nonnegative(),
  registrationClosesAtMs: z.number().int().nonnegative(),
  startsAtMs: z.number().int().nonnegative(),
  /** Humans per heat (at most). */
  heatSize: z.number().int().min(2).max(12),
  /** Runners per heat, CPU fill included. */
  fieldSize: z.number().int().min(2).max(12),
  advancePerHeat: z.number().int().min(1).max(11),
  maxEntrants: z.number().int().min(2).max(4096),
  minEntrants: z.number().int().min(2).max(4096).default(2),
  entry: z.object({
    classIds: z.array(z.string().min(1)).nullable().default(null),
    minRankedRaces: z.number().int().min(0).max(10_000).default(0),
    styles: z.array(z.string().min(1)).nullable().default(null),
  }).strict().default({ classIds: null, minRankedRaces: 0, styles: null }),
  /** REQ-TOUR-003: stat cap for every runner (null = none). */
  statCap: z.number().int().min(100).max(10_000).nullable().default(null),
  cpuLevel: z.number().int().min(1).max(5).default(3),
  /** Pause between the end of a round and the start of the next. */
  roundGapMs: z.number().int().min(30_000).max(3_600_000).default(180_000),
  /** REQ-TOUR-008: "your heat starts in N minutes" push, this long before each round. */
  notifyBeforeMs: z.number().int().min(0).max(3_600_000).default(300_000),
  /** Rank brackets (first match wins); maxRank null = everyone else who raced. */
  prizes: z.array(z.object({ maxRank: z.number().int().min(1).nullable(), reward: rewardSchema })).max(16).default([]),
}).strict().superRefine((d, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
  if (d.registrationOpensAtMs >= d.registrationClosesAtMs) issue('registration must open before it closes');
  if (d.registrationClosesAtMs > d.startsAtMs - HEAT_CREATE_LEAD_MS) issue(`registration must close at least ${HEAT_CREATE_LEAD_MS / 1000}s before the start`);
  if (d.fieldSize < d.heatSize) issue('fieldSize must be >= heatSize');
  if (d.advancePerHeat >= d.heatSize) issue('advancePerHeat must be < heatSize');
  if (d.minEntrants > d.maxEntrants) issue('minEntrants must be <= maxEntrants');
});
export type TournamentDef = z.infer<typeof tournamentDefSchema>;
export type TournamentDefInput = z.input<typeof tournamentDefSchema>;

/** Master-dependent checks (tracks, classes, items) — run on create. */
export function tournamentProblems(m: Pick<Master, 'tracks' | 'progression' | 'items'>, d: TournamentDef): string[] {
  const p: string[] = [];
  for (const t of d.trackIds) if (!m.tracks.some((x) => x.id === t)) p.push(`unknown track ${t}`);
  for (const c of d.entry.classIds ?? []) if (!m.progression.classes.some((x) => x.id === c)) p.push(`unknown class ${c}`);
  const knownItems = new Set([...Object.keys(m.items.tickets), m.items.breedingMaterial.itemId]);
  for (const pr of d.prizes) for (const it of pr.reward.items ?? []) if (!knownItems.has(it.itemId)) p.push(`unknown item ${it.itemId}`);
  return p;
}

export type TournamentStatus = 'scheduled' | 'registration' | 'running' | 'paying' | 'finished' | 'cancelled';

/** What a registration keeps (the race entry is refreshed when the heat is created). */
export interface Registrant<E = unknown> { playerId: string; displayName: string; horseId: string; rating: number; registeredAt: number; entry: E }

export interface HeatPlayerResult { playerId: string; place: number | null; noShow: boolean; advanced: boolean }
export interface Heat {
  id: string; round: number; index: number; playerIds: string[];
  raceId: string | null; startAtMs: number; trackId: string;
  status: 'planned' | 'created' | 'finished' | 'void';
  createAttempts: number;
  results: HeatPlayerResult[] | null;
  /** Race tickets per player (only ever shown to that player; never in the public view). */
  assignments?: Record<string, HeatAssignment>;
}
export interface HeatAssignment { raceId: string; slot: number; ticket: string; startAtMs: number; wsPath: string }
export interface Round { index: number; final: boolean; startAtMs: number; notified: boolean; heats: Heat[]; done: boolean }
export interface Standing { playerId: string; displayName: string; rank: number; reachedRound: number; final: boolean; place: number | null; noShow: boolean }
export interface Payout { playerId: string; rank: number; reward: Reward | null; done: boolean; attempts: number; error: string | null; retryAt: number; dead: boolean; dismissed?: { by: string; note: string; at: number } }

export interface TournamentState<E = unknown> {
  def: TournamentDef;
  status: TournamentStatus;
  createdAt: number; updatedAt: number;
  createdBy: string;
  registrants: Record<string, Registrant<E>>;
  rounds: Round[];
  standings: Standing[] | null;
  payouts: Record<string, Payout>;
  cancelReason: string | null;
  finishedAt: number | null;
}

export function newTournament<E>(def: TournamentDef, by: string, now: number): TournamentState<E> {
  return { def, status: 'scheduled', createdAt: now, updatedAt: now, createdBy: by, registrants: {}, rounds: [], standings: null, payouts: {}, cancelReason: null, finishedAt: null };
}

/** The status as of `now` (scheduled → registration is time-driven; the rest is set by step()). */
export function effectiveStatus(t: TournamentState<unknown>, now: number): TournamentStatus {
  if (t.status === 'scheduled' && now >= t.def.registrationOpensAtMs) return 'registration';
  return t.status;
}

// ------------------------------------------------------------------------------------------ registration

export interface EligibilityInfo { classId: string; rankedRaces: number; style: string; horseActive: boolean; moderation: 'ok' | 'quarantined' | 'banned' }

/** REQ-TOUR-003: reasons this player (with this horse) may not enter; empty = eligible. */
export function eligibilityProblems(d: TournamentDef, e: EligibilityInfo): string[] {
  const p: string[] = [];
  if (e.moderation !== 'ok') p.push('moderation');
  if (!e.horseActive) p.push('horse_not_active');
  if (d.entry.classIds && !d.entry.classIds.includes(e.classId)) p.push('class');
  if (e.rankedRaces < d.entry.minRankedRaces) p.push('ranked_races');
  if (d.entry.styles && !d.entry.styles.includes(e.style)) p.push('style');
  return p;
}

export function register<E>(t: TournamentState<E>, r: Registrant<E>, info: EligibilityInfo, now: number): { registered: boolean; existing: boolean } {
  if (effectiveStatus(t, now) !== 'registration' || now >= t.def.registrationClosesAtMs) throw new AppError('EVENT_CLOSED', 'registration is closed');
  const problems = eligibilityProblems(t.def, info);
  if (problems.length) throw new AppError('NOT_ELIGIBLE', problems.join(','));
  const existing = t.registrants[r.playerId];
  if (!existing && Object.keys(t.registrants).length >= t.def.maxEntrants) throw new AppError('ROOM_FULL', 'the tournament is full');
  t.status = 'registration';
  t.registrants[r.playerId] = existing ? { ...r, registeredAt: existing.registeredAt } : r; // re-register = change horse
  t.updatedAt = now;
  return { registered: true, existing: !!existing };
}

export function unregister(t: TournamentState<unknown>, playerId: string, now: number): boolean {
  if (effectiveStatus(t, now) !== 'registration' || now >= t.def.registrationClosesAtMs) throw new AppError('EVENT_CLOSED', 'registration is closed');
  if (!t.registrants[playerId]) return false;
  delete t.registrants[playerId];
  t.updatedAt = now;
  return true;
}

// ---------------------------------------------------------------------------------------------- brackets

/** Seed order: rating desc, then earlier registration, then id (deterministic). */
export function seedOrder(t: TournamentState<unknown>, ids: string[]): string[] {
  return ids.slice().sort((a, b) => {
    const ra = t.registrants[a], rb = t.registrants[b];
    return (rb?.rating ?? 0) - (ra?.rating ?? 0) || (ra?.registeredAt ?? 0) - (rb?.registeredAt ?? 0) || (a < b ? -1 : a > b ? 1 : 0);
  });
}

/** REQ-TOUR-004: balanced heats with snake seeding (1..k, k..1, ...): every heat gets a similar strength. */
export function planHeats(seeded: string[], heatSize: number): string[][] {
  if (seeded.length === 0) return [];
  const k = Math.ceil(seeded.length / heatSize);
  const heats: string[][] = Array.from({ length: k }, () => []);
  seeded.forEach((p, i) => {
    const lap = Math.floor(i / k), pos = i % k;
    heats[lap % 2 === 0 ? pos : k - 1 - pos]!.push(p);
  });
  return heats;
}

function planRound(t: TournamentState<unknown>, players: string[], startAtMs: number) {
  const index = t.rounds.length;
  const groups = planHeats(seedOrder(t, players), t.def.heatSize);
  const trackId = t.def.trackIds[index % t.def.trackIds.length]!;
  t.rounds.push({
    index, final: groups.length === 1, startAtMs, notified: false, done: false,
    heats: groups.map((g, i) => ({ id: `${index}-${i}`, round: index, index: i, playerIds: g, raceId: null, startAtMs, trackId, status: 'planned', createAttempts: 0, results: null })),
  });
}

/**
 * How many humans of a heat advance: never everyone in a heat of two or more (each such heat eliminates at
 * least one player); a lone player in a heat (odd field) races the CPUs and goes on if they show up.
 */
export const advanceCount = (d: TournamentDef, heatPlayers: number) => (heatPlayers <= 1 ? Math.min(d.advancePerHeat, heatPlayers) : Math.min(d.advancePerHeat, heatPlayers - 1));

export interface HeatOutcome {
  phase: string;
  final: { status: 'confirmed' | 'void' | 'verifying'; order: number[] } | null;
  slots: { slot: number; playerId: string }[];
  noShows: number[];
}

/**
 * REQ-TOUR-006: humans in finish order; no-shows never advance. A void heat (or a lost room) advances the
 * players who showed up, by seed (nobody is eliminated by a server failure beyond the heat's quota).
 */
export function heatResults(t: TournamentState<unknown>, heat: Heat, o: HeatOutcome | null): HeatPlayerResult[] {
  const noShow = new Set(o ? o.slots.filter((s) => o.noShows.includes(s.slot)).map((s) => s.playerId) : []);
  const quota = advanceCount(t.def, heat.playerIds.length);
  const confirmed = o?.final?.status === 'confirmed';
  let ordered: { playerId: string; place: number | null }[];
  if (confirmed) {
    const slotOf = new Map(o!.slots.map((s) => [s.playerId, s.slot]));
    const placeOfSlot = new Map(o!.final!.order.map((slot, i) => [slot, i + 1]));
    ordered = heat.playerIds
      .map((p) => ({ playerId: p, place: slotOf.has(p) ? placeOfSlot.get(slotOf.get(p)!) ?? null : null }))
      .sort((a, b) => (a.place ?? 99) - (b.place ?? 99) || (a.playerId < b.playerId ? -1 : 1));
  } else {
    ordered = seedOrder(t, heat.playerIds).map((p) => ({ playerId: p, place: null }));
  }
  let left = quota;
  return ordered.map((r) => {
    const ns = noShow.has(r.playerId);
    const advanced = !ns && left > 0;
    if (advanced) left--;
    return { playerId: r.playerId, place: r.place, noShow: ns, advanced };
  });
}

/**
 * REQ-TOUR-007: final ranking. Finalists by place in the final; then everyone else by the round they reached
 * (later first) and their place in their heat. Players with the same round and heat place share a rank
 * (competition ranking 1-2-2-4); no-shows rank after everyone who raced in their round.
 */
export function computeStandings(t: TournamentState<unknown>): Standing[] {
  const rows: (Standing & { key: [number, number, number] })[] = [];
  const seen = new Set<string>();
  for (let ri = t.rounds.length - 1; ri >= 0; ri--) {
    const r = t.rounds[ri]!;
    for (const h of r.heats) {
      for (const res of h.results ?? h.playerIds.map((p) => ({ playerId: p, place: null, noShow: false, advanced: false }))) {
        if (seen.has(res.playerId)) continue;
        const last = ri === t.rounds.length - 1;
        if (!r.final && res.advanced && !last) continue; // ranked in a later round
        seen.add(res.playerId);
        // the final (or a lone survivor of the last round) decides exact places; earlier rounds rank by
        // (round reached desc, no-show last, place in heat) and share ranks on equal keys
        const final = r.final || (res.advanced && last);
        rows.push({
          playerId: res.playerId, displayName: t.registrants[res.playerId]?.displayName ?? '', rank: 0, reachedRound: ri, final, place: res.place, noShow: res.noShow,
          key: [-(ri * 2 + (final ? 1 : 0)), res.noShow ? 1 : 0, final ? (res.place ?? 99) * 100 + (h.results?.findIndex((x) => x.playerId === res.playerId) ?? 0) : res.place ?? 99],
        });
      }
    }
  }
  rows.sort((a, b) => a.key[0] - b.key[0] || a.key[1] - b.key[1] || a.key[2] - b.key[2] || seedCmp(t, a.playerId, b.playerId));
  let rank = 0;
  rows.forEach((r, i) => {
    const prev = rows[i - 1];
    const tie = prev && !r.final && prev.key[0] === r.key[0] && prev.key[1] === r.key[1] && prev.key[2] === r.key[2];
    rank = tie ? rank : i + 1;
    r.rank = rank;
  });
  return rows.map(({ key: _k, ...s }) => s);
}
const seedCmp = (t: TournamentState<unknown>, a: string, b: string) => {
  const o = seedOrder(t, [a, b]);
  return o[0] === a ? -1 : 1;
};

export function prizeFor(d: TournamentDef, rank: number): Reward | null {
  for (const p of d.prizes) if (p.maxRank === null || rank <= p.maxRank) return p.reward;
  return null;
}

// --------------------------------------------------------------------------------------------- the driver

export interface HeatSpec { tournamentId: string; tournamentName: string; heat: Heat; final: boolean; entries: unknown[]; cpuCount: number; cpuLevel: number; statCap: number | null }

export interface TournamentPorts<E> {
  /** Fresh race entry (current horse stats, look, rating); null = keep the registration snapshot. */
  refreshEntry(r: Registrant<E>): Promise<E | null>;
  /** Creates the race room for a heat (and registers it as live + assigns its players). */
  createHeat(spec: HeatSpec): Promise<{ raceId: string; assignments: Record<string, HeatAssignment> }>;
  heatResult(raceId: string): Promise<HeatOutcome | null>;
  notify(playerId: string, templateId: string, vars: Record<string, string>): Promise<void>;
  /** Records the result on the player (once per tournament) and grants the prize. */
  award(playerId: string, tournamentId: string, rank: number, reward: Reward | null, name: string): Promise<void>;
}

export interface StepResult { changed: boolean; wakeAt: number | null; newlyDead: DeadLetterItem[]; log: string[] }

/** One idempotent pass: advance as far as `now` allows. Resumable at every await (the caller persists after). */
export async function stepTournament<E>(t: TournamentState<E>, now: number, ports: TournamentPorts<E>, persist: () => Promise<void>): Promise<StepResult> {
  const log: string[] = [];
  const dead: DeadLetterItem[] = [];
  let changed = false;
  const mark = async () => { changed = true; t.updatedAt = now; await persist(); };
  const wake: number[] = [];

  if (t.status === 'cancelled' || t.status === 'finished') return { changed, wakeAt: null, newlyDead: dead, log };
  if (t.status === 'scheduled') {
    if (now < t.def.registrationOpensAtMs) return { changed, wakeAt: t.def.registrationOpensAtMs, newlyDead: dead, log };
    t.status = 'registration';
    await mark();
  }

  if (t.status === 'registration') {
    const ids = Object.keys(t.registrants);
    // REQ-TOUR-008: first-round reminder goes to everyone registered (the heats are planned at the close)
    if (now < t.def.registrationClosesAtMs) return { changed, wakeAt: t.def.registrationClosesAtMs, newlyDead: dead, log };
    if (ids.length < t.def.minEntrants) {
      t.status = 'cancelled';
      t.cancelReason = 'not_enough_entrants';
      t.finishedAt = now;
      await mark();
      log.push('cancelled:not_enough_entrants');
      return { changed, wakeAt: null, newlyDead: dead, log };
    }
    planRound(t, ids, t.def.startsAtMs);
    t.status = 'running';
    await mark();
    log.push(`planned:0:${t.rounds[0]!.heats.length}`);
  }

  if (t.status === 'running') {
    for (;;) {
      const r = t.rounds.find((x) => !x.done);
      if (!r) break;
      // reminder
      if (!r.notified) {
        const at = r.startAtMs - t.def.notifyBeforeMs;
        if (now >= at) {
          const minutes = String(Math.max(1, Math.round((r.startAtMs - now) / 60_000)));
          for (const h of r.heats) for (const p of h.playerIds) {
            try { await ports.notify(p, 'tournament_heat_soon', { tournament: t.def.name, minutes, round: r.final ? '決勝' : `${r.index + 1}回戦` }); } catch (e) { log.push(`notifyFailed:${p}`); console.error('tournament notify failed', t.def.id, p, (e as Error).message); }
          }
          r.notified = true;
          await mark();
          log.push(`notified:${r.index}`);
        } else wake.push(at);
      }
      // create heats
      if (now < r.startAtMs - HEAT_CREATE_LEAD_MS) { wake.push(r.startAtMs - HEAT_CREATE_LEAD_MS); break; }
      for (const h of r.heats) {
        if (h.status !== 'planned') continue;
        if (now >= h.startAtMs + HEAT_TIMEOUT_MS / 4) {
          // could not create the room in time: the heat is void (players advance by seed)
          h.status = 'void';
          h.results = heatResults(t, h, null);
          await mark();
          log.push(`heatVoid:${h.id}:create`);
          continue;
        }
        try {
          const entries: unknown[] = [];
          for (const p of h.playerIds) {
            const reg = t.registrants[p]!;
            let e: E | null = null;
            try { e = await ports.refreshEntry(reg); } catch { e = null; }
            entries.push(e ?? reg.entry);
          }
          h.createAttempts++;
          h.startAtMs = Math.max(h.startAtMs, now + 6_000);
          const created = await ports.createHeat({
            tournamentId: t.def.id, tournamentName: t.def.name, heat: h, final: r.final, entries,
            cpuCount: Math.max(0, t.def.fieldSize - h.playerIds.length), cpuLevel: t.def.cpuLevel, statCap: t.def.statCap,
          });
          h.raceId = created.raceId;
          h.assignments = created.assignments;
          h.status = 'created';
          await mark();
          log.push(`heatCreated:${h.id}:${h.raceId}`);
        } catch (e) {
          await mark();
          log.push(`heatCreateFailed:${h.id}`);
          console.error('tournament heat creation failed', t.def.id, h.id, (e as Error).message);
          wake.push(now + HEAT_POLL_MS);
        }
      }
      // poll running heats
      for (const h of r.heats) {
        if (h.status !== 'created') continue;
        if (now < h.startAtMs) { wake.push(h.startAtMs + HEAT_POLL_MS); continue; }
        let o: HeatOutcome | null = null;
        try { o = await ports.heatResult(h.raceId!); } catch { o = null; }
        const definitive = o?.final && (o.final.status === 'confirmed' || o.final.status === 'void') && o.phase === 'final';
        if (definitive || now >= h.startAtMs + HEAT_TIMEOUT_MS) {
          h.results = heatResults(t, h, definitive ? o : o ? { ...o, final: null } : null);
          h.status = definitive && o!.final!.status === 'confirmed' ? 'finished' : 'void';
          await mark();
          log.push(`heat${h.status === 'finished' ? 'Finished' : 'Void'}:${h.id}`);
        } else wake.push(now + HEAT_POLL_MS);
      }
      if (!r.heats.every((h) => h.status === 'finished' || h.status === 'void')) break;
      r.done = true;
      const advancing = r.final ? [] : r.heats.flatMap((h) => (h.results ?? []).filter((x) => x.advanced).map((x) => x.playerId));
      if (!r.final && advancing.length >= 2) {
        planRound(t, advancing, now + t.def.roundGapMs);
        log.push(`planned:${r.index + 1}:${t.rounds[t.rounds.length - 1]!.heats.length}`);
      }
      // fewer than two survivors: the tournament is decided without a final (a lone survivor wins)
      await mark();
      if (r.final || advancing.length < 2) {
        t.standings = computeStandings(t);
        for (const s of t.standings) t.payouts[s.playerId] = { playerId: s.playerId, rank: s.rank, reward: prizeFor(t.def, s.rank), done: false, attempts: 0, error: null, retryAt: 0, dead: false };
        t.status = 'paying';
        await mark();
        log.push('standings');
        break;
      }
    }
  }

  if (t.status === 'paying') {
    for (const p of Object.values(t.payouts)) {
      if (p.done || p.dead) continue;
      if (now < p.retryAt) { wake.push(p.retryAt); continue; }
      try {
        await ports.award(p.playerId, t.def.id, p.rank, p.reward, t.def.name);
        p.done = true;
        p.error = null;
      } catch (e) {
        p.attempts++;
        p.error = (e as Error).message || 'award failed';
        p.retryAt = now + PAYOUT_RETRY_MS * p.attempts;
        if (p.attempts >= PAYOUT_MAX_ATTEMPTS) { p.dead = true; dead.push({ itemId: p.playerId, error: p.error, attempts: p.attempts }); }
        else wake.push(p.retryAt);
      }
      await mark();
    }
    if (Object.values(t.payouts).every((p) => p.done || p.dead)) {
      t.status = 'finished';
      t.finishedAt = now;
      await mark();
      log.push('finished');
    }
  }
  const st = t.status as TournamentStatus;
  const wakeAt = st === 'finished' || st === 'cancelled' || wake.length === 0 ? null : Math.max(now + 1_000, Math.min(...wake));
  return { changed, wakeAt, newlyDead: dead, log };
}

/** REQ-TOUR-010: admin cancel before the end (no prizes; heats already running finish without effect). */
export function cancelTournament(t: TournamentState<unknown>, reason: string, now: number) {
  if (t.status === 'finished' || t.status === 'paying') throw new AppError('CONFLICT', 'the tournament has already finished');
  if (t.status === 'cancelled') return false;
  t.status = 'cancelled';
  t.cancelReason = reason;
  t.finishedAt = now;
  t.updatedAt = now;
  return true;
}

// ---- dead letters (REQ-OPS-041) ----
export const tournamentDeadLetters = (t: TournamentState<unknown> | null): DeadLetterItem[] =>
  Object.values(t?.payouts ?? {}).filter((p) => p.dead && !p.dismissed).map((p) => ({ itemId: p.playerId, error: p.error ?? 'award failed', attempts: p.attempts }));

export async function retryPayout<E>(t: TournamentState<E>, playerId: string, award: TournamentPorts<E>['award'], now: number) {
  const p = t.payouts[playerId];
  if (!p) return { ok: false, error: 'no such payout' };
  if (p.done) return { ok: true };
  try {
    await award(p.playerId, t.def.id, p.rank, p.reward, t.def.name);
    p.done = true; p.dead = false; p.error = null;
    if (t.status === 'paying' && Object.values(t.payouts).every((x) => x.done || x.dead)) { t.status = 'finished'; t.finishedAt = now; }
    return { ok: true };
  } catch (e) {
    p.attempts++;
    p.error = (e as Error).message || 'award failed';
    return { ok: false, error: p.error };
  }
}

export function dismissPayout(t: TournamentState<unknown>, playerId: string, by: string, note: string, now: number) {
  const p = t.payouts[playerId];
  if (!p || p.done) return false;
  p.dismissed = { by, note, at: now };
  p.dead = true;
  return true;
}

// ------------------------------------------------------------------------------------------------- views

export interface TournamentSummary {
  id: string; name: string; status: TournamentStatus; registrationOpensAtMs: number; registrationClosesAtMs: number; startsAtMs: number;
  entrants: number; maxEntrants: number; heatSize: number; finishedAt: number | null; updatedAt: number;
}

export function summaryOf(t: TournamentState<unknown>, now: number): TournamentSummary {
  const d = t.def;
  return {
    id: d.id, name: d.name, status: effectiveStatus(t, now), registrationOpensAtMs: d.registrationOpensAtMs, registrationClosesAtMs: d.registrationClosesAtMs,
    startsAtMs: d.startsAtMs, entrants: Object.keys(t.registrants).length, maxEntrants: d.maxEntrants, heatSize: d.heatSize, finishedAt: t.finishedAt, updatedAt: t.updatedAt,
  };
}

/** Public detail (also published to R2 as history): rules, bracket, standings — no tickets, no race entries. */
export function publicView(t: TournamentState<unknown>, now: number) {
  const d = t.def;
  const name = (p: string) => t.registrants[p]?.displayName ?? '';
  return {
    ...summaryOf(t, now),
    description: d.description, trackIds: d.trackIds, fieldSize: d.fieldSize, advancePerHeat: d.advancePerHeat, minEntrants: d.minEntrants,
    entry: d.entry, statCap: d.statCap, prizes: d.prizes, cancelReason: t.cancelReason,
    rounds: t.rounds.map((r) => ({
      index: r.index, final: r.final, startAtMs: r.startAtMs, done: r.done,
      heats: r.heats.map((h) => ({
        id: h.id, raceId: h.raceId, status: h.status, startAtMs: h.startAtMs, trackId: h.trackId,
        players: h.playerIds.map((p) => ({ playerId: p, displayName: name(p) })),
        results: h.results?.map((x) => ({ ...x, displayName: name(x.playerId) })) ?? null,
      })),
    })),
    standings: t.standings,
  };
}

/** REQ-TOUR-009: the player's own view: registration, current heat (with its live race), result. */
export function playerView(t: TournamentState<unknown>, playerId: string, now: number) {
  const reg = t.registrants[playerId] ?? null;
  let heat: { round: number; final: boolean; heatId: string; raceId: string | null; startAtMs: number; status: Heat['status']; trackId: string; assignment: HeatAssignment | null; place: number | null; advanced: boolean | null } | null = null;
  let eliminated = false;
  for (const r of t.rounds) {
    const h = r.heats.find((x) => x.playerIds.includes(playerId));
    if (!h) continue;
    const res = h.results?.find((x) => x.playerId === playerId);
    heat = {
      round: r.index, final: r.final, heatId: h.id, raceId: h.raceId, startAtMs: h.startAtMs, status: h.status, trackId: h.trackId,
      // the ticket only while the heat is running (REQ-TOUR-009)
      assignment: h.status === 'created' ? h.assignments?.[playerId] ?? null : null,
      place: res?.place ?? null, advanced: res ? res.advanced : null,
    };
    eliminated = !!res && !res.advanced && !r.final;
  }
  const standing = t.standings?.find((s) => s.playerId === playerId) ?? null;
  const payout = t.payouts[playerId];
  return {
    tournamentId: t.def.id, status: effectiveStatus(t, now), registered: !!reg, horseId: reg?.horseId ?? null,
    heat, eliminated, standing, prize: payout?.reward ?? null, prizePaid: payout?.done ?? false,
  };
}
