/**
 * 週替わりチャレンジ (weekly challenge) — REQ-WCH-001..016, contracts/protocol.md §31.
 *
 * Every game week (gameWeekId: Monday at the game-day rollover, progression.dayRollover) the rotation table in
 * `progression.weeklyChallenge` picks a set of 3 single-player races against CPU on fixed conditions built from the
 * existing race config (course, distance, ground, night, field strength) plus a constraint (「逃げ馬で勝つ」「ムチ3回以内で
 * 3着以内」「雨の重馬場で X 以内に完走」). The device runs the race offline (OfflineRace / ChallengeRun) and submits only its
 * inputs; the server re-simulates the config it issued with the C# verifier (the time attack path, §8) and evaluates the
 * constraint itself from the verified result (evaluateChallenge). A client claim alone is never trusted: the result hash
 * must match, and the conditions are recomputed from the verifier output and the validated inputs.
 *
 * Fairness (ranked rule, docs/planning/06 §1.3): every entrant is normalised to `statCap` like ranked, no unique skills
 * (a pure riding test like time attack), the ruleset's day-to-day form is off, and each challenge offers a fixed loan horse
 * (`loanTemplateId`) whose stats are lifted to exactly the cap and whose aptitude fits the course and the constraint — so a
 * free player always has a horse at least as strong (in stat total) as the best purchasable horse after normalisation.
 *
 * Rewards: small and fixed, once per challenge per week (free coins ≤ WCH_HARD_LIMITS.freeCoinsPerChallenge ≈ ¥160 at the
 * worst pack price, under the ¥200 総付景品 ceiling; breeding material), never paid coins, never a random item. Clearing all
 * 3 in one week adds a cosmetic badge (no stats, not sold, the same for everyone): no random item is involved anywhere, so
 * collecting the three clears is not コンプガチャ (that is a reward for completing a set of items drawn at random).
 */
import { z } from 'zod';
import { AppError } from './errors.js';
import { STAT_KEYS, trackById, type HorseTemplate, type Master, type Reward, type Stats, type Style } from './master.js';
import type { PlayerState } from './player.js';
import { getHorse } from './horses.js';
import { grantReward } from './items.js';
import { buildRaceConfig, toRaceHorse } from './raceConfig.js';
import { timeAttackRuleset, type Ruleset } from './ruleset.js';
import type { Rng } from './rng.js';
import { goingSchema, goingsFor, styleSchema, type Going, type RaceHorse, type RaceStartConfig, type ReplayLog, type VerifierOutput } from './schemas.js';
import { dayRule, gameDayKey, gameWeekEndMs, gameWeekId, gameWeeksBetween, gameWeekStartMs, sameGameDay, addJstDays } from './time.js';
import { jsonEqual, raceTimeMs } from './timeAttack.js';
import { worstYenPerCoin } from './invite.js';
import type { KpiEvent } from './kpi.js';

type Emit = (e: KpiEvent) => void;

// ------------------------------------------------------------------------------------------------ config

export interface ChallengeConditions {
  /** Finish in the top N (1 = win). */
  maxPlace?: number;
  /** Ride a horse of this running style (checked at start and in the evaluation). */
  style?: Style;
  /** At most N whip inputs (input records with the WHIP bit; the same count on the device and the server). */
  maxWhips?: number;
  /** Finish within this race time (ms from the gate opening, the time attack formula). */
  maxTimeMs?: number;
}
export interface ChallengeDef {
  id: string;
  title: string;
  trackId: string;
  /** Fixed going (must match the course surface); absent = good / fast. */
  going?: Going;
  /** Night race (lit venues only). */
  night?: boolean;
  cpuCount: number;
  cpuLevel: number;
  /** CPU stat scale (‰, after normalisation): field strength. Absent = 1000. */
  cpuStatPermille?: number;
  conditions: ChallengeConditions;
  /** The fixed loan horse anyone may ride (stats lifted to `statCap`). */
  loanTemplateId: string;
  reward: Reward;
}
export interface ChallengeWeekDef { id: string; badge: { id: string; name: string }; challenges: ChallengeDef[] }
export interface WeeklyChallengeConfig {
  enabled: boolean;
  /** Weekday the week starts on (0 = Sunday … 6 = Saturday) at the game-day rollover. */
  weekStartsOn: number;
  /** The week id (its first game day) that shows rotation[0]; later weeks cycle through the table. */
  anchorWeekId: string;
  /** Stat total every entrant is normalised to (ranked class B); the loan horse is lifted to exactly this. */
  statCap: number;
  sessionTtlMs: number;
  maxInputs: number;
  /** Challenge races a player may start per game day (anti-abuse; retries are otherwise free). */
  startsPerDay: number;
  keepSessions: number;
  /** Show next week's set (conditions only) on the list. */
  previewNext: boolean;
  rotation: ChallengeWeekDef[];
}

/** Code ceilings no master or remote config can exceed (景表法 / economy E18). */
export const WCH_HARD_LIMITS = {
  challengesPerWeek: 3, freeCoinsPerChallenge: 100, freeCoinsPerWeek: 150, materialPerChallenge: 2, maxRewardYen: 200,
  startsPerDay: 50, rotationWeeks: 52, keepSessions: 50, badgesKept: 520,
} as const;

const int = z.number().int();
const idRe = /^[a-z0-9_]{1,40}$/;
const dayKeyRe = /^\d{4}-\d{2}-\d{2}$/;
const rewardSchema = z.object({
  freeCoins: int.min(0).max(WCH_HARD_LIMITS.freeCoinsPerChallenge).optional(),
  items: z.array(z.object({ itemId: z.string().regex(idRe), qty: int.min(1).max(WCH_HARD_LIMITS.materialPerChallenge) }).strict()).max(1).optional(),
}).strict();
const challengeSchema = z.object({
  id: z.string().regex(idRe), title: z.string().min(1).max(24), trackId: z.string().regex(idRe),
  going: goingSchema.optional(), night: z.boolean().optional(),
  cpuCount: int.min(0).max(11), cpuLevel: int.min(1).max(5), cpuStatPermille: int.min(500).max(1200).optional(),
  conditions: z.object({
    maxPlace: int.min(1).max(12).optional(), style: styleSchema.optional(),
    maxWhips: int.min(0).max(20).optional(), maxTimeMs: int.min(10_000).max(600_000).optional(),
  }).strict(),
  loanTemplateId: z.string().min(1).max(40),
  reward: rewardSchema,
}).strict();
export const weeklyChallengeConfigSchema = z.object({
  _note: z.string().optional(),
  enabled: z.boolean(), weekStartsOn: int.min(0).max(6), anchorWeekId: z.string().regex(dayKeyRe),
  statCap: int.min(500).max(10_000), sessionTtlMs: int.min(60_000).max(3_600_000), maxInputs: int.min(50).max(4000),
  startsPerDay: int.min(1).max(WCH_HARD_LIMITS.startsPerDay), keepSessions: int.min(1).max(WCH_HARD_LIMITS.keepSessions), previewNext: z.boolean(),
  rotation: z.array(z.object({
    id: z.string().regex(idRe),
    badge: z.object({ id: z.string().regex(idRe), name: z.string().min(1).max(24) }).strict(),
    challenges: z.array(challengeSchema).length(WCH_HARD_LIMITS.challengesPerWeek),
  }).strict()).min(1).max(WCH_HARD_LIMITS.rotationWeeks),
}).strict();

export function weeklyChallengeConfig(m: Pick<Master, 'progression'>): WeeklyChallengeConfig | null {
  return (m.progression as { weeklyChallenge?: WeeklyChallengeConfig }).weeklyChallenge ?? null;
}
function cfgOrThrow(m: Master): WeeklyChallengeConfig {
  const c = weeklyChallengeConfig(m);
  if (!c || !c.enabled) throw new AppError('NOT_FOUND', 'weekly challenges are not available');
  return c;
}

/** True when the template fits the course: surface (or both) and the distance inside its range. */
export const loanFits = (t: Pick<HorseTemplate, 'surface' | 'distMinM' | 'distMaxM'>, track: { surface: 'turf' | 'dirt'; distanceM: number }) =>
  (t.surface === 'both' || t.surface === track.surface) && t.distMinM <= track.distanceM && track.distanceM <= t.distMaxM;

/**
 * REQ-WCH-012: validation of `progression.weeklyChallenge` (boot and every remote-config version). Shape, unique ids,
 * courses that exist with a going of their surface and night only at lit venues, conditions that mean something
 * (top-N inside the field), the loan horse (exists, not seasonal, fits the course and the style constraint), rewards
 * (free coins and breeding material only, ≤ ¥200 a grant at the worst pack price, ≤ the weekly coin ceiling) and a badge
 * that is only a badge (cosmetic, no reward attached).
 */
export function weeklyChallengeProblems(m: Pick<Master, 'progression' | 'tracks' | 'templateById' | 'litTracks' | 'items' | 'products'>, path = 'progression.weeklyChallenge'): string[] {
  const raw = (m.progression as { weeklyChallenge?: unknown }).weeklyChallenge;
  if (raw === undefined) return [];
  const r = weeklyChallengeConfigSchema.safeParse(raw);
  if (!r.success) return r.error.issues.map((i) => `${path}.${i.path.join('.')}: ${i.message}`);
  const c = r.data as WeeklyChallengeConfig;
  const H = WCH_HARD_LIMITS;
  const out: string[] = [];
  const anchor = new Date(`${c.anchorWeekId}T00:00:00Z`);
  if (Number.isNaN(anchor.getTime()) || anchor.toISOString().slice(0, 10) !== c.anchorWeekId) out.push(`${path}.anchorWeekId: not a date`);
  else if (anchor.getUTCDay() !== c.weekStartsOn) out.push(`${path}.anchorWeekId: must be a ${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][c.weekStartsOn]} (weekStartsOn)`);
  const weekIds = new Set<string>();
  const challengeIds = new Set<string>();
  const badgeIds = new Set<string>();
  const yen = worstYenPerCoin(m);
  const material = m.items.breedingMaterial.itemId;
  for (const w of c.rotation) {
    const wp = `${path}.rotation.${w.id}`;
    if (weekIds.has(w.id)) out.push(`${path}.rotation: duplicate week id ${w.id}`);
    weekIds.add(w.id);
    if (badgeIds.has(w.badge.id)) out.push(`${wp}.badge.id: duplicate badge ${w.badge.id}`);
    badgeIds.add(w.badge.id);
    if (m.items.cosmetics.some((x) => x.id === w.badge.id) || m.items.tickets[w.badge.id]) out.push(`${wp}.badge.id: collides with a sold item (the badge is never sold)`);
    let weekCoins = 0;
    for (const ch of w.challenges) {
      const cp = `${wp}.${ch.id}`;
      if (challengeIds.has(ch.id)) out.push(`${path}: duplicate challenge id ${ch.id}`);
      challengeIds.add(ch.id);
      const track = m.tracks.find((t) => t.id === ch.trackId);
      if (!track) { out.push(`${cp}.trackId: unknown course ${ch.trackId}`); continue; }
      if (ch.going && !(goingsFor(track.surface) as readonly string[]).includes(ch.going)) out.push(`${cp}.going: ${ch.going} is not a ${track.surface} going`);
      if (ch.night && !m.litTracks.has(track.id)) out.push(`${cp}.night: ${track.id} has no floodlights`);
      const cond = ch.conditions;
      if (cond.maxPlace === undefined && cond.style === undefined && cond.maxWhips === undefined && cond.maxTimeMs === undefined) out.push(`${cp}.conditions: needs at least one condition`);
      if (cond.maxPlace !== undefined && cond.maxPlace >= ch.cpuCount + 1) out.push(`${cp}.conditions.maxPlace: must be smaller than the field (${ch.cpuCount + 1} runners), or it only means finishing`);
      if (cond.maxPlace === undefined && cond.maxTimeMs === undefined && cond.maxWhips === undefined) out.push(`${cp}.conditions: a style alone is not a challenge (add a place, whip or time condition)`);
      const t = m.templateById.get(ch.loanTemplateId);
      if (!t) out.push(`${cp}.loanTemplateId: unknown horse ${ch.loanTemplateId}`);
      else {
        if (t.seasonal) out.push(`${cp}.loanTemplateId: a seasonal (limited) horse cannot be the loan horse`);
        if (!loanFits(t, track)) out.push(`${cp}.loanTemplateId: ${t.id} does not fit ${track.id} (surface / distance)`);
        if (cond.style && t.style !== cond.style) out.push(`${cp}.loanTemplateId: the loan horse must have the required style ${cond.style}`);
      }
      const rw = ch.reward;
      const coins = rw.freeCoins ?? 0;
      weekCoins += coins;
      if (Math.round(coins * yen) > H.maxRewardYen) out.push(`${cp}.reward.freeCoins: ${coins} coins ≈ ¥${Math.round(coins * yen)} exceeds the ¥${H.maxRewardYen} premium ceiling`);
      for (const it of rw.items ?? []) if (it.itemId !== material) out.push(`${cp}.reward.items: only ${material} (no tickets, no random items, nothing paid)`);
      if (!coins && !(rw.items ?? []).length) out.push(`${cp}.reward: needs free coins or material`);
    }
    if (weekCoins > H.freeCoinsPerWeek) out.push(`${wp}: ${weekCoins} free coins a week, at most ${H.freeCoinsPerWeek} (economy E18)`);
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ week

/** REQ-WCH-001: the current week id and its rotation entry. */
export function weekAt(m: Master, c: WeeklyChallengeConfig, now: number, offset = 0) {
  const rule = dayRule(m);
  const weekId = addJstDays(gameWeekId(now, rule, c.weekStartsOn), 7 * offset);
  const n = c.rotation.length;
  const idx = ((gameWeeksBetween(c.anchorWeekId, weekId) % n) + n) % n;
  return { weekId, def: c.rotation[idx]!, startsAt: gameWeekStartMs(weekId, rule), endsAt: gameWeekEndMs(weekId, rule) };
}

// ------------------------------------------------------------------------------------------------ state

export type WchSessionStatus = 'issued' | 'submitted' | 'verified' | 'rejected';
export interface WchSession {
  id: string; weekId: string; challengeId: string; horseId: string | null; loan: boolean; playerSlot: number;
  config: RaceStartConfig; issuedAt: number; expiresAt: number; status: WchSessionStatus; result: WchResult | null;
  /** The validated inputs while the run is being verified (prepare → record). */
  inputs?: [number, number, number][];
  /** The conditions and reward shown at the start (a rotation edited mid-session never changes this run's rules). */
  conditions?: ChallengeConditions;
  reward?: Reward;
}
export interface WchClear { at: number; sessionId: string; place: number; timeMs: number; whips: number }
export interface WchWeek { cleared: Record<string, WchClear>; attempts: Record<string, number>; best: Record<string, { place: number | null; timeMs: number | null }>; badgeAt: number | null }
export interface WeeklyChallengeState {
  daily: { date: string; count: number };
  weeks: Record<string, WchWeek>;
  sessions: WchSession[];
  badges: { weekId: string; badgeId: string; at: number }[];
}

export const newWchState = (): WeeklyChallengeState => ({ daily: { date: '', count: 0 }, weeks: {}, sessions: [], badges: [] });
export function wchState(s: PlayerState): WeeklyChallengeState {
  s.weeklyChallenge ??= newWchState();
  return s.weeklyChallenge;
}
const newWeek = (): WchWeek => ({ cleared: {}, attempts: {}, best: {}, badgeAt: null });
function weekState(st: WeeklyChallengeState, weekId: string, currentWeekId: string): WchWeek {
  // keep only this week and the previous one (a session started before the rollover still credits its own week)
  const prev = addJstDays(currentWeekId, -7);
  for (const k of Object.keys(st.weeks)) if (k !== currentWeekId && k !== prev && k !== weekId) delete st.weeks[k];
  return (st.weeks[weekId] ??= newWeek());
}

// ------------------------------------------------------------------------------------------------ evaluation

export const CMD_WHIP = 1 << 5;
export type CheckKind = 'finish' | 'place' | 'style' | 'whips' | 'time';
export interface ChallengeCheck { kind: CheckKind; target: number | string | null; actual: number | string | null; ok: boolean }
export interface ChallengeEvaluation {
  finished: boolean; place: number | null; timeMs: number | null; whips: number; style: Style; cleared: boolean; checks: ChallengeCheck[];
}

/**
 * REQ-WCH-005: the deterministic evaluation of a challenge run from the verified result. The same rules live in C#
 * (Muchi.Client ChallengeEvaluator) so the device shows the same verdict; the server's is the one that counts.
 * - place: 1-based finishing place of `playerSlot` (null = did not finish within maxTicks)
 * - time: raceTimeMs (the time attack formula, from the gate opening, with the Q16.16 fraction of the finish tick)
 * - whips: input records of the player's slot with the WHIP bit (pressed whips, the same on both sides)
 * - style: the running style of the player's horse in the issued config
 * Every challenge also requires finishing.
 */
export function evaluateChallenge(cond: ChallengeConditions, config: RaceStartConfig, playerSlot: number, inputs: readonly (readonly [number, number, number])[], out: Pick<VerifierOutput, 'order' | 'finishTicks' | 'finishFracs'>): ChallengeEvaluation {
  const idx = out.order.indexOf(playerSlot);
  const tick = idx >= 0 ? out.finishTicks[idx]! : -1;
  const finished = tick >= 0;
  const frac = finished && out.finishFracs ? Math.max(0, out.finishFracs[idx]!) : 0;
  const place = finished ? idx + 1 : null;
  const timeMs = finished ? raceTimeMs(config, tick, frac) : null;
  const whips = inputs.filter(([, slot, cmd]) => slot === playerSlot && (cmd & CMD_WHIP) !== 0).length;
  const style = config.entrants[playerSlot]!.horse.style as Style;
  const checks: ChallengeCheck[] = [{ kind: 'finish', target: null, actual: finished ? 1 : 0, ok: finished }];
  if (cond.maxPlace !== undefined) checks.push({ kind: 'place', target: cond.maxPlace, actual: place, ok: place !== null && place <= cond.maxPlace });
  if (cond.style !== undefined) checks.push({ kind: 'style', target: cond.style, actual: style, ok: style === cond.style });
  if (cond.maxWhips !== undefined) checks.push({ kind: 'whips', target: cond.maxWhips, actual: whips, ok: whips <= cond.maxWhips });
  if (cond.maxTimeMs !== undefined) checks.push({ kind: 'time', target: cond.maxTimeMs, actual: timeMs, ok: timeMs !== null && timeMs <= cond.maxTimeMs });
  return { finished, place, timeMs, whips, style, cleared: checks.every((x) => x.ok), checks };
}

/** "1:12.3" (minutes:seconds.tenths, the HUD format) for a race time in ms. */
export function formatRaceTime(ms: number): string {
  const tenths = Math.floor(ms / 100);
  const m = Math.floor(tenths / 600);
  const s = Math.floor((tenths % 600) / 10);
  return `${m}:${String(s).padStart(2, '0')}.${tenths % 10}`;
}
const STYLE_JA: Record<Style, string> = { nige: '逃げ', senko: '先行', sashi: '差し', oikomi: '追込' };

/** REQ-WCH-004: one short Japanese line per condition (English: i18n/en.ts templates). */
export function conditionLabels(cond: ChallengeConditions): { kind: CheckKind; text: string }[] {
  const out: { kind: CheckKind; text: string }[] = [];
  if (cond.style !== undefined) out.push({ kind: 'style', text: `${STYLE_JA[cond.style]}の馬で出走` });
  if (cond.maxPlace !== undefined) out.push({ kind: 'place', text: cond.maxPlace === 1 ? '1着でゴール' : `${cond.maxPlace}着以内でゴール` });
  if (cond.maxWhips !== undefined) out.push({ kind: 'whips', text: cond.maxWhips === 0 ? 'ムチを使わない' : `ムチ${cond.maxWhips}回以内` });
  if (cond.maxTimeMs !== undefined) out.push({ kind: 'time', text: `${formatRaceTime(cond.maxTimeMs)}以内で完走` });
  if (cond.maxPlace === undefined && cond.maxTimeMs === undefined) out.push({ kind: 'finish', text: '完走する' });
  return out;
}

// ------------------------------------------------------------------------------------------------ view

const loanHorse = (t: HorseTemplate, cap: number): RaceHorse => {
  // REQ-WCH-007: lifted to exactly the cap (largest remainder keeps the template's shape), the same aptitudes, no skill
  const total = STAT_KEYS.reduce((a, k) => a + t.stats[k], 0);
  const st = {} as Stats;
  const rems: { k: keyof Stats; r: number }[] = [];
  let sum = 0;
  for (const k of STAT_KEYS) { const v = t.stats[k] * cap; st[k] = Math.floor(v / total); sum += st[k]; rems.push({ k, r: v % total }); }
  rems.sort((a, b) => b.r - a.r || STAT_KEYS.indexOf(a.k) - STAT_KEYS.indexOf(b.k));
  for (let i = 0; i < cap - sum; i++) st[rems[i % rems.length]!.k] += 1;
  return { id: `loan_${t.id}`, name: t.name, ...st, style: t.style, distMinM: t.distMinM, distMaxM: t.distMaxM, surface: t.surface, ...(t.goingAptitude && t.goingAptitude !== 'any' ? { goingAptitude: t.goingAptitude } : {}) };
};
export function loanRaceHorse(m: Master, c: WeeklyChallengeConfig, ch: ChallengeDef): RaceHorse {
  const t = m.templateById.get(ch.loanTemplateId);
  if (!t) throw new AppError('CONFIG_INVALID', `loan horse ${ch.loanTemplateId}`);
  return loanHorse(t, c.statCap);
}

function challengeCard(m: Master, c: WeeklyChallengeConfig, ch: ChallengeDef) {
  const track = trackById(m, ch.trackId);
  const t = m.templateById.get(ch.loanTemplateId);
  return {
    id: ch.id, title: ch.title, trackId: track.id, surface: track.surface, distanceM: track.distanceM,
    going: ch.going ?? (track.surface === 'dirt' ? 'fast' : 'good'), night: ch.night ?? false,
    cpuCount: ch.cpuCount, cpuLevel: ch.cpuLevel, cpuStatPermille: ch.cpuStatPermille ?? 1000,
    conditions: ch.conditions, labels: conditionLabels(ch.conditions), reward: ch.reward,
    loan: t ? { templateId: t.id, name: t.name, style: t.style, statTotal: c.statCap } : null,
  };
}

/** REQ-WCH-002: GET /v1/challenges/weekly — this week's set with my progress, the badge, and next week's conditions. */
export function weeklyChallengeView(m: Master, s: PlayerState, now: number) {
  const c = weeklyChallengeConfig(m);
  if (!c || !c.enabled) return { enabled: false as const };
  const st = s.weeklyChallenge ?? newWchState();
  const cur = weekAt(m, c, now);
  const wk = st.weeks[cur.weekId] ?? newWeek();
  const today = gameDayKey(now, dayRule(m));
  const usedToday = sameGameDay(st.daily.date, today) ? st.daily.count : 0;
  const cleared = cur.def.challenges.filter((ch) => wk.cleared[ch.id]).length;
  const next = c.previewNext ? weekAt(m, c, now, 1) : null;
  return {
    enabled: true as const,
    weekId: cur.weekId, startsAt: cur.startsAt, endsAt: cur.endsAt, serverNow: now,
    challenges: cur.def.challenges.map((ch) => ({
      ...challengeCard(m, c, ch),
      progress: {
        cleared: !!wk.cleared[ch.id], clearedAt: wk.cleared[ch.id]?.at ?? null, attempts: wk.attempts[ch.id] ?? 0,
        bestPlace: wk.best[ch.id]?.place ?? null, bestTimeMs: wk.best[ch.id]?.timeMs ?? null,
      },
    })),
    clearedCount: cleared,
    badge: { id: cur.def.badge.id, name: cur.def.badge.name, earned: wk.badgeAt !== null, earnedAt: wk.badgeAt },
    startsLeftToday: Math.max(0, c.startsPerDay - usedToday),
    next: next ? { weekId: next.weekId, startsAt: next.startsAt, badge: { id: next.def.badge.id, name: next.def.badge.name }, challenges: next.def.challenges.map((ch) => challengeCard(m, c, ch)) } : null,
    badges: [...st.badges].reverse().slice(0, 20),
    badgeCount: st.badges.length,
    rules: { statCap: c.statCap, normalized: true, skills: false, loanAtCap: true, paidBoosts: false, rewardOncePerWeek: true },
  };
}

// ------------------------------------------------------------------------------------------------ start / submit

export interface WchStartInput { horseId?: string; loan?: boolean }

/** REQ-WCH-003/007: issue a session for one of this week's challenges (config fixed by the server). */
export function startChallenge(m: Master, s: PlayerState, challengeId: string, input: WchStartInput, sessionId: string, rng: Rng, now: number, emit: Emit, baseRuleset?: Ruleset) {
  const c = cfgOrThrow(m);
  const cur = weekAt(m, c, now);
  const ch = cur.def.challenges.find((x) => x.id === challengeId);
  if (!ch) throw new AppError('NOT_FOUND', `challenge ${challengeId} is not in this week's set`);
  if ((input.loan ?? false) === (input.horseId !== undefined)) throw new AppError('BAD_REQUEST', 'give either horseId or loan: true');
  let horse: RaceHorse;
  if (input.loan) horse = loanRaceHorse(m, c, ch);
  else {
    const h = getHorse(s, input.horseId!);
    if (h.status !== 'active') throw new AppError('HORSE_NOT_ACTIVE');
    horse = toRaceHorse(m, h);
  }
  if (ch.conditions.style && horse.style !== ch.conditions.style) throw new AppError('CHALLENGE_HORSE_INELIGIBLE', `this challenge needs a ${ch.conditions.style} horse (the loan horse is one)`);
  const st = wchState(s);
  const today = gameDayKey(now, dayRule(m));
  if (!sameGameDay(st.daily.date, today)) st.daily = { date: today, count: 0 };
  if (st.daily.count >= c.startsPerDay) throw new AppError('CHALLENGE_LIMIT_REACHED', `${c.startsPerDay}/day`);
  st.daily.count++;
  const config = buildRaceConfig(m, {
    raceId: `wch_${sessionId}`, mode: 'challenge', trackId: ch.trackId, cpuCount: ch.cpuCount, cpuLevel: ch.cpuLevel, statCap: c.statCap, rng,
    cpuStatPermille: ch.cpuStatPermille,
    ground: ch.going !== undefined || ch.night ? { going: ch.going ?? (trackById(m, ch.trackId).surface === 'dirt' ? 'fast' : 'good'), night: ch.night ?? false } : null,
    // the active ruleset with the day's form off, embedded in the session (a ruleset change mid-session never affects it)
    rulesetOverrides: timeAttackRuleset(baseRuleset),
    humans: [{ playerId: s.id, horse }],
  });
  const playerSlot = config.entrants.findIndex((e) => e.kind === 'human');
  const wk = weekState(st, cur.weekId, cur.weekId);
  wk.attempts[ch.id] = (wk.attempts[ch.id] ?? 0) + 1;
  const session: WchSession = { id: sessionId, weekId: cur.weekId, challengeId: ch.id, horseId: input.loan ? null : input.horseId!, loan: !!input.loan, playerSlot, config, issuedAt: now, expiresAt: now + c.sessionTtlMs, status: 'issued', result: null, conditions: ch.conditions, reward: ch.reward };
  st.sessions.push(session);
  if (st.sessions.length > c.keepSessions) st.sessions.splice(0, st.sessions.length - c.keepSessions);
  emit({ name: 'challenge_start', s1: ch.id, s2: cur.weekId, s3: input.loan ? 'loan' : 'own', count: wk.attempts[ch.id] });
  return { sessionId, weekId: cur.weekId, challengeId: ch.id, playerSlot, config, expiresAt: session.expiresAt, startsLeftToday: c.startsPerDay - st.daily.count, challenge: challengeCard(m, c, ch) };
}

function findSession(s: PlayerState, sessionId: string): WchSession {
  const x = s.weeklyChallenge?.sessions.find((q) => q.id === sessionId);
  if (!x) throw new AppError('NOT_FOUND', `session ${sessionId}`);
  return x;
}

/** Inputs of the player's slot only, client command bits, increasing ticks inside the race, bounded length. */
export function validateChallengeInputs(config: RaceStartConfig, playerSlot: number, inputs: unknown, maxInputs: number): [number, number, number][] {
  if (!Array.isArray(inputs)) throw new AppError('BAD_REQUEST', 'inputs must be an array');
  if (inputs.length > maxInputs) throw new AppError('BAD_REQUEST', `too many inputs (max ${maxInputs})`);
  const maxTicks = Number(config.ruleset.maxTicks);
  const out: [number, number, number][] = [];
  let prev = -1;
  for (const raw of inputs) {
    if (!Array.isArray(raw) || raw.length !== 3 || !raw.every((v) => Number.isInteger(v) && v >= 0)) throw new AppError('BAD_REQUEST', 'malformed input');
    const [tick, slot, cmd] = raw as [number, number, number];
    if (slot !== playerSlot) throw new AppError('BAD_REQUEST', `inputs must be for your slot (${playerSlot})`);
    if (cmd & ~0x3f || cmd === 0) throw new AppError('BAD_REQUEST', 'invalid command bits');
    if (tick >= maxTicks) throw new AppError('BAD_REQUEST', 'input after maxTicks');
    if (tick <= prev) throw new AppError('BAD_REQUEST', 'inputs must have strictly increasing ticks');
    prev = tick;
    out.push([tick, slot, cmd]);
  }
  return out;
}

export type WchPrepare = { kind: 'verify'; log: ReplayLog } | { kind: 'done'; result: WchResult };

/** REQ-WCH-008: one submission per session; the replay log is built from the ISSUED config. A retry returns the stored result. */
export function prepareChallengeSubmit(m: Master, s: PlayerState, sessionId: string, inputs: unknown, resultHash: string, echoedConfig: unknown, now: number): WchPrepare {
  const c = weeklyChallengeConfig(m);
  if (!c) throw new AppError('NOT_FOUND', 'weekly challenges are not available');
  const x = findSession(s, sessionId);
  if (x.status === 'verified' && x.result && x.result.resultHash === resultHash) return { kind: 'done', result: x.result };
  if (x.status !== 'issued') throw new AppError('CHALLENGE_SESSION_USED');
  if (now > x.expiresAt) throw new AppError('CHALLENGE_SESSION_EXPIRED');
  if (echoedConfig !== undefined && echoedConfig !== null && !jsonEqual(echoedConfig, x.config)) throw new AppError('TA_CONFIG_MISMATCH', 'the config differs from the issued one');
  const ins = validateChallengeInputs(x.config, x.playerSlot, inputs, c.maxInputs);
  x.status = 'submitted';
  x.inputs = ins; // what the verifier re-simulates is what the whip condition counts
  return { kind: 'verify', log: { v: 1, config: x.config, endTick: -1, inputs: ins } };
}

/** The verifier could not be reached: the run may be submitted again (until the session expires). */
export function abortChallengeSubmit(s: PlayerState, sessionId: string) {
  const x = findSession(s, sessionId);
  if (x.status === 'submitted') x.status = 'issued';
  return { sessionId, status: x.status };
}

export interface WchResult {
  sessionId: string; weekId: string; challengeId: string; resultHash: string;
  evaluation: ChallengeEvaluation; cleared: boolean; firstClear: boolean; reward: Reward | null;
  clearedCount: number; badge: { id: string; name: string; earned: boolean; newlyEarned: boolean };
  /** False when the session's week is no longer kept (cannot happen within the session lifetime; defensive). */
  credited: boolean;
}

/**
 * REQ-WCH-005/006/009: apply the verifier's re-simulation. A hash that differs from the client's is rejected (nothing
 * recorded). The conditions are evaluated here from the verified result and the validated inputs; the reward is granted
 * once per challenge per week, and the week's cosmetic badge when all 3 are cleared. The clear counts for the week the
 * session was issued in (a run started before the weekly rollover still counts for its own week).
 */
export function recordChallengeResult(m: Master, s: PlayerState, sessionId: string, out: VerifierOutput, claimedHash: string, now: number, emit: Emit): WchResult | { rejected: true; sessionId: string } {
  const c = weeklyChallengeConfig(m);
  if (!c) throw new AppError('NOT_FOUND', 'weekly challenges are not available');
  const x = findSession(s, sessionId);
  if (x.status === 'verified' && x.result) return x.result;
  if (x.status !== 'submitted') throw new AppError('CHALLENGE_SESSION_USED');
  if (out.resultHash !== claimedHash) { x.status = 'rejected'; return { rejected: true, sessionId }; }
  const st = wchState(s);
  const inputs = x.inputs ?? [];
  delete x.inputs; // only kept between prepare and record (the whip count stays in the evaluation)
  const sessionWeek = weekAt(m, c, gameWeekStartMs(x.weekId, dayRule(m)));
  const def = sessionWeek.def.challenges.find((q) => q.id === x.challengeId);
  // the rotation may have been edited since the start: the session's own config and the conditions shown at start win
  const cond = x.conditions ?? def?.conditions ?? {};
  const sessionReward = x.reward ?? def?.reward ?? null;
  const evaluation = evaluateChallenge(cond, x.config, x.playerSlot, inputs, out);
  const curWeek = weekAt(m, c, now).weekId;
  const credited = x.weekId === curWeek || x.weekId === addJstDays(curWeek, -7);
  const wk = weekState(st, x.weekId, curWeek);
  const prevBest = wk.best[x.challengeId];
  if (evaluation.finished && (!prevBest || prevBest.place === null || (evaluation.place! < prevBest.place) || (evaluation.place === prevBest.place && evaluation.timeMs! < (prevBest.timeMs ?? Infinity)))) {
    wk.best[x.challengeId] = { place: evaluation.place, timeMs: evaluation.timeMs };
  } else if (!prevBest) wk.best[x.challengeId] = { place: null, timeMs: null };
  const firstClear = credited && evaluation.cleared && !wk.cleared[x.challengeId];
  let reward: Reward | null = null;
  if (firstClear) {
    wk.cleared[x.challengeId] = { at: now, sessionId, place: evaluation.place!, timeMs: evaluation.timeMs!, whips: evaluation.whips };
    if (sessionReward) {
      reward = sessionReward;
      grantReward(s, sessionReward, now, `weekly challenge ${x.weekId} ${x.challengeId}`, `wch:${sessionId}`);
    }
  }
  const clearedCount = sessionWeek.def.challenges.filter((q) => wk.cleared[q.id]).length;
  let newlyEarned = false;
  if (credited && clearedCount === sessionWeek.def.challenges.length && wk.badgeAt === null) {
    wk.badgeAt = now;
    newlyEarned = true;
    if (!st.badges.some((b) => b.weekId === x.weekId)) st.badges.push({ weekId: x.weekId, badgeId: sessionWeek.def.badge.id, at: now });
    if (st.badges.length > WCH_HARD_LIMITS.badgesKept) st.badges.splice(0, st.badges.length - WCH_HARD_LIMITS.badgesKept);
  }
  if (evaluation.cleared) {
    emit({ name: 'challenge_clear', s1: x.challengeId, s2: x.weekId, s3: x.loan ? 'loan' : 'own', place: evaluation.place ?? 0, durationMs: evaluation.timeMs ?? 0, count: clearedCount, isFirst: firstClear, value: newlyEarned ? 1 : 0, freeCoins: reward?.freeCoins ?? 0 });
  }
  const result: WchResult = {
    sessionId, weekId: x.weekId, challengeId: x.challengeId, resultHash: out.resultHash, evaluation, cleared: evaluation.cleared, firstClear, reward,
    clearedCount, badge: { id: sessionWeek.def.badge.id, name: sessionWeek.def.badge.name, earned: wk.badgeAt !== null, newlyEarned }, credited,
  };
  x.status = 'verified';
  x.result = result;
  return result;
}
