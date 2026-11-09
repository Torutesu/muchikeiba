/**
 * Onboarding and the first week (docs/planning/06-ux-experience-spec.md §2–§4, §8): terms consent (REQ-UXS-001),
 * the first partner horse (REQ-UXS-002), feature unlocks (REQ-UXS-014), beginner missions (REQ-UXS-015),
 * season missions (REQ-UXS-016) and A/B bucket assignment (REQ-UXS-032). Pure per-player logic; the master
 * values live in `progression` (remote config can change them; onboardingProblems validates every change).
 */
import { adsProblems } from './ads.js';
import { trainingProblems } from './training.js';
import { giftBoxProblems } from './giftBox.js';
import { rivalProblems } from './rival.js';
import { weeklyChallengeProblems } from './weeklyChallenge.js';
import { z } from 'zod';
import { AppError } from './errors.js';
import { createHorseFromTemplate, validateName } from './horses.js';
import { grantReward } from './items.js';
import type { Master, Progression, Reward } from './master.js';
import type { PlayerState } from './player.js';
import { dayRolloverProblems, dayRule, gameDayIndex, type DayRule } from './time.js';
import { fnv1a32 } from './ground.js';
import { classDef } from './season.js';
import { nudgeProblems } from './nudges.js';
import { accountDeletionProblems } from './accountDeletion.js';
import { inviteProblems } from './invite.js';
import { changelogProblems, comebackProblems } from './comeback.js';

// ------------------------------------------------------------------------------------------------ config types

export interface ConsentConfig { termsVersion: string; privacyVersion: string }
export interface PartnerConfig { templateId: string }
export interface BeginnerMatchConfig {
  /** CPU fill wait for a player's first ranked race (the queue default is 15 s). */
  firstRaceCpuFillAfterMs: number;
  /** CPU level in beginner matches (REQ-MM-003). */
  cpuLevel: number;
  /** CPU stats in beginner matches, permille of their normalized stats (balance target R10). */
  cpuStatPermille: number;
  /** Course of the first ranked race; null = random like every ranked race (A/B key firstRankedTrackId). */
  firstRaceTrackId: string | null;
}
/** §4.3: a feature opens when ANY of the given conditions is met (none given = from the start). Display-only gating. */
export interface UnlockDef { key: UnlockKey; races?: number | null; days?: number | null; rankedRaces?: number | null; breedings?: number | null }
export type BeginnerMissionKind = 'gacha' | 'silks' | 'care' | 'ranked_top3' | 'breed' | 'friends' | 'team' | 'ta_finish' | 'ranked_races' | 'races' | 'collect';
export interface BeginnerMissionDef { id: string; kind: BeginnerMissionKind; target: number; reward: Reward; templateIds?: string[] }
export type SeasonMissionKind = 'ranked_races' | 'wins' | 'top3' | 'points' | 'promotion_line' | 'collect';
export interface SeasonMissionDef { id: string; kind: SeasonMissionKind; target: number; reward: Reward; templateIds?: string[] }
export type AbValue = string | number | boolean | null;
export interface ExperimentDef { id: string; active: boolean; buckets: { id: string; weight: number; values: Record<string, AbValue> }[] }

/** §4.3 feature keys (the client maps each to a home tile / screen). */
export const UNLOCK_KEYS = [
  'race', 'partner', 'scout', 'stable', 'missions', 'login_bonus', 'shop', 'season_pass', 'bond', 'season',
  'breeding', 'friends', 'friend_rooms', 'teams', 'spectate', 'time_attack', 'events', 'tournaments', 'my_stable', 'stud', 'training', 'rival',
] as const;
export type UnlockKey = typeof UNLOCK_KEYS[number];

/**
 * REQ-UXS-032: the only values an experiment may switch. Triggers, order and wording only — never a price,
 * a pack's content or a reward amount (§8.2), so there is deliberately no key for those.
 */
export const AB_KEYS = {
  /** A/B #1: length of the on-device first race. */
  tutorialDistanceM: z.number().int().min(200).max(1000),
  /** A/B #2: course of the first ranked race (applied by the matchmaker). */
  firstRankedTrackId: z.string().min(1).max(64).nullable(),
  /** A/B #3: when the app asks for notification permission. */
  pushPermissionTiming: z.enum(['race2_top3', 'day2_launch']),
  /** A/B #4: what shows the starter pack offer (T2). */
  starterOfferTrigger: z.enum(['first_bottom_half', 'fifth_race']),
  /** A/B #5: the home screen's main button. */
  homePrimaryButton: z.enum(['race', 'ranked_promotion']),
  /** A/B #6: first-win-of-the-day bonus shown (the bonus itself is REQ-UXS-010). */
  firstWinBonus: z.boolean(),
} as const;
export type AbKey = keyof typeof AB_KEYS;

// ------------------------------------------------------------------------------------------------ validation

const int = z.number().int();
const rewardSchema = z.object({
  freeCoins: int.min(0).max(100_000).optional(),
  items: z.array(z.object({ itemId: z.string().min(1).max(64), qty: int.min(1).max(1000) }).strict()).max(10).optional(),
  horse: z.string().min(1).max(64).optional(),
  broodmare: z.string().min(1).max(64).optional(),
  passXp: int.min(0).max(10_000).optional(),
}).strict();
const id = z.string().regex(/^[a-z0-9_]{1,40}$/);
const bmKinds = ['gacha', 'silks', 'care', 'ranked_top3', 'breed', 'friends', 'team', 'ta_finish', 'ranked_races', 'races', 'collect'] as const;
const smKinds = ['ranked_races', 'wins', 'top3', 'points', 'promotion_line', 'collect'] as const;
const optCount = int.min(0).max(10_000).nullable().optional();

export const onboardingSchemas = {
  consent: z.object({ termsVersion: z.string().min(1).max(32), privacyVersion: z.string().min(1).max(32) }).strict(),
  partner: z.object({ templateId: z.string().min(1).max(64) }).strict(),
  beginnerMatch: z.object({
    firstRaceCpuFillAfterMs: int.min(1000).max(60_000), cpuLevel: int.min(1).max(5), cpuStatPermille: int.min(500).max(1000),
    firstRaceTrackId: z.string().min(1).max(64).nullable(),
  }).strict(),
  beginnerLoginBonus: z.array(rewardSchema.extend({ day: int.min(1).max(31) }).strict()).min(1).max(14),
  unlocks: z.array(z.object({ key: z.enum(UNLOCK_KEYS), races: optCount, days: optCount, rankedRaces: optCount, breedings: optCount }).strict()).max(40),
  beginnerMissions: z.array(z.object({ id, kind: z.enum(bmKinds), target: int.min(1).max(10_000), reward: rewardSchema, templateIds: z.array(z.string()).max(20).optional() }).strict()).max(20),
  seasonMissions: z.array(z.object({ id, kind: z.enum(smKinds), target: int.min(0).max(100_000), reward: rewardSchema, templateIds: z.array(z.string()).max(20).optional() }).strict()).max(20),
  experiments: z.array(z.object({
    id, active: z.boolean(),
    buckets: z.array(z.object({ id, weight: int.min(1).max(1_000_000), values: z.record(z.string(), z.unknown()) }).strict()).min(2).max(10),
  }).strict()).max(20),
};

/** Shape and meaning of the onboarding config (boot and every remote-config version, REQ-OPS-003). */
export function onboardingProblems(p: Progression, m: Pick<Master, 'templateById' | 'tracks' | 'items'>, knownItems: Set<string>): string[] {
  const out: string[] = [];
  const check = <T>(key: keyof typeof onboardingSchemas, v: unknown): T | null => {
    if (v === undefined) return null;
    const r = onboardingSchemas[key].safeParse(v);
    if (!r.success) { out.push(...r.error.issues.map((i) => `progression.${key}.${i.path.join('.')}: ${i.message}`)); return null; }
    return r.data as T;
  };
  const rewardRefs = (path: string, r: Reward) => {
    for (const it of r.items ?? []) if (!knownItems.has(it.itemId)) out.push(`${path}: unknown item ${it.itemId}`);
    for (const k of ['horse', 'broodmare'] as const) {
      const tid = r[k];
      if (!tid) continue;
      const t = m.templateById.get(tid);
      if (!t) out.push(`${path}: unknown template ${tid}`);
      else if (k === 'broodmare' && t.sex !== 'female') out.push(`${path}: broodmare ${tid} must be female`);
      else if (k === 'broodmare' && !t.giftOnly) out.push(`${path}: broodmare ${tid} must be gift-only`);
    }
  };
  check('consent', p.consent);
  const partner = check<PartnerConfig>('partner', p.partner);
  if (partner) {
    const t = m.templateById.get(partner.templateId);
    if (!t) out.push(`progression.partner: unknown template ${partner.templateId}`);
    else if (!t.giftOnly) out.push(`progression.partner: ${partner.templateId} must be gift-only (never in gacha or CPU fields)`);
  }
  const bm = check<BeginnerMatchConfig>('beginnerMatch', p.beginnerMatch);
  if (bm?.firstRaceTrackId && !m.tracks.some((t) => t.id === bm.firstRaceTrackId)) out.push(`progression.beginnerMatch: unknown track ${bm.firstRaceTrackId}`);
  const blb = check<({ day: number } & Reward)[]>('beginnerLoginBonus', p.beginnerLoginBonus);
  blb?.forEach((d, i) => {
    if (d.day !== i + 1) out.push(`progression.beginnerLoginBonus[${i}]: days must be 1..n in order`);
    if (d.passXp) out.push(`progression.beginnerLoginBonus[${i}]: passXp is for season missions only`);
    rewardRefs(`progression.beginnerLoginBonus[${i}]`, d);
  });
  const ul = check<UnlockDef[]>('unlocks', p.unlocks);
  if (ul && new Set(ul.map((u) => u.key)).size !== ul.length) out.push('progression.unlocks: duplicate key');
  const missionIds = new Set<string>([...(p.dailyMissions ?? []).map((d) => d.id)]);
  for (const key of ['beginnerMissions', 'seasonMissions'] as const) {
    const list = check<(BeginnerMissionDef | SeasonMissionDef)[]>(key, p[key]);
    list?.forEach((d, i) => {
      if (missionIds.has(d.id)) out.push(`progression.${key}[${i}]: mission id ${d.id} is already used`);
      missionIds.add(d.id);
      if (d.kind === 'collect' && !(d.templateIds && d.templateIds.length)) out.push(`progression.${key}[${i}]: collect needs templateIds`);
      if (key === 'beginnerMissions' && d.reward.passXp) out.push(`progression.${key}[${i}]: passXp is for season missions only`);
      if (key === 'seasonMissions' && !d.reward.passXp) out.push(`progression.${key}[${i}]: a season mission gives pass XP`);
      if (d.reward.horse || d.reward.broodmare) out.push(`progression.${key}[${i}]: missions cannot reward horses`);
      rewardRefs(`progression.${key}[${i}]`, d.reward);
    });
  }
  const ex = check<ExperimentDef[]>('experiments', p.experiments);
  if (ex) {
    if (new Set(ex.map((e) => e.id)).size !== ex.length) out.push('progression.experiments: duplicate id');
    for (const e of ex) {
      if (new Set(e.buckets.map((b) => b.id)).size !== e.buckets.length) out.push(`experiment ${e.id}: duplicate bucket id`);
      const keys = new Set<string>();
      for (const b of e.buckets) {
        for (const [k, v] of Object.entries(b.values)) {
          const s = (AB_KEYS as Record<string, z.ZodType>)[k];
          // REQ-UXS-032: prices, contents and amounts are never experiment values (§8.2)
          if (!s) { out.push(`experiment ${e.id}/${b.id}: ${k} is not an A/B key (allowed: ${Object.keys(AB_KEYS).join(', ')}; never prices)`); continue; }
          const r = s.safeParse(v);
          if (!r.success) out.push(`experiment ${e.id}/${b.id}: ${k} ${r.error.issues[0]?.message ?? 'invalid'}`);
          if (k === 'firstRankedTrackId' && typeof v === 'string' && !m.tracks.some((t) => t.id === v)) out.push(`experiment ${e.id}/${b.id}: unknown track ${v}`);
          keys.add(k);
        }
      }
      // every bucket of one experiment switches the same keys (otherwise a bucket silently inherits another experiment's value)
      for (const b of e.buckets) for (const k of keys) if (!(k in b.values)) out.push(`experiment ${e.id}/${b.id}: missing value for ${k}`);
    }
    const active = ex.filter((e) => e.active);
    const owners = new Map<string, string>();
    for (const e of active) for (const k of Object.keys(e.buckets[0]?.values ?? {})) {
      if (owners.has(k)) out.push(`experiments ${owners.get(k)} and ${e.id} both switch ${k}`);
      owners.set(k, e.id);
    }
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ player state

export interface OnboardingState {
  /** Applied, non-void races of any mode except the tutorial. */
  races: number;
  /** Breedings made (own pair or a borrowed stallion). */
  breedings: number;
  /** Beginner mission counters (cumulative since install). */
  counts: Record<string, number>;
  /** Beginner missions claimed, in order. */
  claimed: string[];
}

export function ensureOnboarding(s: PlayerState): OnboardingState {
  // players stored before this existed start from their recorded races (stats count ranked + 2-human friend races)
  s.onboarding ??= { races: s.stats?.races ?? 0, breedings: 0, counts: {}, claimed: [] };
  return s.onboarding;
}

/** Counts a beginner-mission event (scout, silks, care, …). Never fails the caller's flow. */
export function countOnboarding(s: PlayerState, kind: string, n = 1) {
  const o = ensureOnboarding(s);
  o.counts[kind] = (o.counts[kind] ?? 0) + n;
}

/** REQ-UXS-014 / -015: race counters (rewards.applyRaceResult calls this for every non-void race). */
export function onRaceApplied(m: Master, s: PlayerState, mode: string, place: number, rewarded: boolean) {
  if (mode === 'tutorial') return;
  const o = ensureOnboarding(s);
  o.races += 1;
  if (mode === 'ranked' && place <= 3) o.counts.ranked_top3 = (o.counts.ranked_top3 ?? 0) + 1;
  if (mode === 'ranked' && rewarded) {
    const sm = ensureSeasonMissions(s);
    if (place === 1) sm.progress.wins = (sm.progress.wins ?? 0) + 1;
    if (place <= 3) sm.progress.top3 = (sm.progress.top3 ?? 0) + 1;
  }
  void m;
}

// ------------------------------------------------------------------------------------------------ consent (REQ-UXS-001)

export interface ConsentState { termsVersion: string; privacyVersion: string; at: number; history: { termsVersion: string; privacyVersion: string; at: number }[] }
const CONSENT_HISTORY_KEEP = 20;

function consentConfig(m: Master): ConsentConfig {
  const c = m.progression.consent;
  if (!c) throw new AppError('NOT_FOUND', 'consent is not configured');
  return c;
}

export function consentView(m: Master, s: PlayerState) {
  const cur = m.progression.consent ?? null;
  const c = s.consent ?? null;
  return {
    termsVersion: c?.termsVersion ?? null, privacyVersion: c?.privacyVersion ?? null, consentedAt: c?.at ?? null,
    current: cur,
    // REQ-UXS-001: a version bump asks again
    required: cur !== null && (!c || c.termsVersion !== cur.termsVersion || c.privacyVersion !== cur.privacyVersion),
  };
}

/** Records consent to the CURRENT versions only (a stale client gets CONSENT_VERSION_MISMATCH and refetches). */
export function recordConsent(m: Master, s: PlayerState, termsVersion: string, privacyVersion: string, now: number) {
  const cur = consentConfig(m);
  if (termsVersion !== cur.termsVersion || privacyVersion !== cur.privacyVersion) {
    throw new AppError('CONSENT_VERSION_MISMATCH', `current versions are terms ${cur.termsVersion} / privacy ${cur.privacyVersion}`);
  }
  const prev = s.consent;
  if (!prev || prev.termsVersion !== termsVersion || prev.privacyVersion !== privacyVersion) {
    const history = [...(prev?.history ?? []), { termsVersion, privacyVersion, at: now }].slice(-CONSENT_HISTORY_KEEP);
    s.consent = { termsVersion, privacyVersion, at: now, history };
  }
  return consentView(m, s);
}

// ------------------------------------------------------------------------------------------------ partner (REQ-UXS-002)

/** The horse ridden in the tutorial, granted once and named (separate from the free 10-pull, REQ-GACHA-010). */
export function grantPartner(m: Master, s: PlayerState, rawName: string, now: number) {
  const cfg = m.progression.partner;
  if (!cfg) throw new AppError('NOT_FOUND', 'partner is not configured');
  if (s.flags.partnerHorseId) throw new AppError('PARTNER_ALREADY_GRANTED');
  const t = m.templateById.get(cfg.templateId);
  if (!t || !t.giftOnly) throw new AppError('CONFIG_INVALID', `partner template ${cfg.templateId}`);
  const name = validateName(m, rawName); // INVALID_NAME / NG_NAME before anything is granted
  const h = createHorseFromTemplate(s, t, now);
  h.name = name;
  h.named = true;
  s.flags.partnerHorseId = h.id;
  return { horse: h };
}

// ------------------------------------------------------------------------------------------------ unlocks (REQ-UXS-014)

/** 1 on the install day (game day, REQ-UXS-011), 2 the next game day, … */
export const playerDay = (s: PlayerState, now: number, day: DayRule) => Math.max(1, gameDayIndex(now, day) - gameDayIndex(s.createdAt, day) + 1);

export function unlocksView(m: Master, s: PlayerState, now: number) {
  const o = s.onboarding ?? { races: s.stats?.races ?? 0, breedings: 0 };
  const progress = { day: playerDay(s, now, dayRule(m)), races: o.races, rankedRaces: s.rating.rankedRaces, breedings: o.breedings };
  const features = (m.progression.unlocks ?? []).map((u) => {
    const tests: [string, number | null | undefined, number][] = [['races', u.races, progress.races], ['days', u.days, progress.day], ['rankedRaces', u.rankedRaces, progress.rankedRaces], ['breedings', u.breedings, progress.breedings]];
    const given = tests.filter(([, need]) => need !== null && need !== undefined);
    const by = given.length === 0 ? 'always' : given.find(([, need, have]) => have >= need!)?.[0] ?? null;
    return { key: u.key, unlocked: by !== null, by, races: u.races ?? null, days: u.days ?? null, rankedRaces: u.rankedRaces ?? null, breedings: u.breedings ?? null };
  });
  return { ...progress, features };
}

// ------------------------------------------------------------------------------------------------ beginner missions (REQ-UXS-015)

function beginnerProgress(s: PlayerState, d: BeginnerMissionDef): number {
  const o = ensureOnboarding(s);
  switch (d.kind) {
    case 'friends': return s.friends.ids.length;
    case 'team': return Math.max(o.counts.team ?? 0, s.team?.teamId ? 1 : 0);
    case 'ranked_races': return s.rating.rankedRaces;
    case 'races': return o.races;
    case 'collect': return (d.templateIds ?? []).filter((t) => s.horses.some((h) => h.templateId === t)).length;
    default: return o.counts[d.kind] ?? 0;
  }
}

export function beginnerMissionsView(m: Master, s: PlayerState) {
  const defs = m.progression.beginnerMissions ?? [];
  const o = ensureOnboarding(s);
  const next = defs.findIndex((d) => !o.claimed.includes(d.id));
  return {
    completed: defs.length > 0 && next === -1,
    steps: defs.map((d, i) => {
      const progress = Math.min(d.target, beginnerProgress(s, d));
      const claimed = o.claimed.includes(d.id);
      return { id: d.id, step: i + 1, kind: d.kind, target: d.target, progress, reward: d.reward, claimed, locked: !claimed && i > next && next !== -1, claimable: !claimed && i === next && progress >= d.target };
    }),
  };
}

/** One step at a time: step n can be claimed once steps 1..n-1 are claimed and its target is reached. */
export function claimBeginnerMission(m: Master, s: PlayerState, missionId: string, now: number): Reward {
  const defs = m.progression.beginnerMissions ?? [];
  const i = defs.findIndex((d) => d.id === missionId);
  if (i < 0) throw new AppError('NOT_FOUND', `mission ${missionId}`);
  const o = ensureOnboarding(s);
  if (o.claimed.includes(missionId)) throw new AppError('ALREADY_CLAIMED');
  if (defs.slice(0, i).some((d) => !o.claimed.includes(d.id))) throw new AppError('NOT_ELIGIBLE', 'complete the previous step first');
  const d = defs[i]!;
  if (beginnerProgress(s, d) < d.target) throw new AppError('NOT_ELIGIBLE');
  o.claimed.push(d.id);
  grantReward(s, d.reward, now, `beginner mission ${d.id}`, `bm:${d.id}`, m);
  return d.reward;
}

// ------------------------------------------------------------------------------------------------ season missions (REQ-UXS-016)

export interface SeasonMissionState { seasonId: string; progress: Record<string, number>; claimed: string[] }

export function ensureSeasonMissions(s: PlayerState): SeasonMissionState {
  if (!s.seasonMissions || s.seasonMissions.seasonId !== s.season.id) s.seasonMissions = { seasonId: s.season.id, progress: {}, claimed: [] };
  return s.seasonMissions;
}

function seasonTarget(m: Master, s: PlayerState, d: SeasonMissionDef): number | null {
  if (d.kind !== 'promotion_line') return d.target;
  return classDef(m, s.season.classId).promotePoints; // null in the top class: nothing to reach
}

function seasonProgress(s: PlayerState, d: SeasonMissionDef): number {
  const sm = ensureSeasonMissions(s);
  switch (d.kind) {
    case 'ranked_races': return s.season.races;
    case 'points': case 'promotion_line': return s.season.points;
    case 'collect': return (d.templateIds ?? []).filter((t) => s.horses.some((h) => h.templateId === t)).length;
    default: return sm.progress[d.kind] ?? 0;
  }
}

export function seasonMissionsView(m: Master, s: PlayerState) {
  const sm = ensureSeasonMissions(s);
  return {
    seasonId: sm.seasonId,
    missions: (m.progression.seasonMissions ?? []).map((d) => {
      const target = seasonTarget(m, s, d);
      const progress = target === null ? 0 : Math.min(target, seasonProgress(s, d));
      const claimed = sm.claimed.includes(d.id);
      return { id: d.id, kind: d.kind, target, progress, reward: d.reward, claimed, available: target !== null, claimable: !claimed && target !== null && progress >= target };
    }),
  };
}

export function claimSeasonMission(m: Master, s: PlayerState, missionId: string, now: number): Reward {
  const d = (m.progression.seasonMissions ?? []).find((x) => x.id === missionId);
  if (!d) throw new AppError('NOT_FOUND', `mission ${missionId}`);
  const sm = ensureSeasonMissions(s);
  if (sm.claimed.includes(d.id)) throw new AppError('ALREADY_CLAIMED');
  const target = seasonTarget(m, s, d);
  if (target === null || seasonProgress(s, d) < target) throw new AppError('NOT_ELIGIBLE');
  sm.claimed.push(d.id);
  grantReward(s, d.reward, now, `season mission ${d.id}`, `sm:${sm.seasonId}:${d.id}`, m);
  return d.reward;
}

/** Which mission table an id belongs to (ids are unique across tables, validated). */
export function missionTable(m: Master, missionId: string): 'daily' | 'beginner' | 'season' | null {
  if (m.progression.dailyMissions.some((d) => d.id === missionId)) return 'daily';
  if ((m.progression.beginnerMissions ?? []).some((d) => d.id === missionId)) return 'beginner';
  if ((m.progression.seasonMissions ?? []).some((d) => d.id === missionId)) return 'season';
  return null;
}

// ------------------------------------------------------------------------------------------------ A/B (REQ-UXS-032)

/** Deterministic bucket from the player id (no state): the same player always lands in the same bucket. */
export function bucketOf(e: ExperimentDef, playerId: string): string {
  const total = e.buckets.reduce((a, b) => a + b.weight, 0);
  let r = fnv1a32(`ab|${e.id}|${playerId}`) % total;
  for (const b of e.buckets) {
    if (r < b.weight) return b.id;
    r -= b.weight;
  }
  return e.buckets[e.buckets.length - 1]!.id;
}

export function experimentsView(m: Master, playerId: string) {
  const assignments: Record<string, string> = {};
  const values: Partial<Record<AbKey, AbValue>> = {};
  for (const e of m.progression.experiments ?? []) {
    if (!e.active) continue;
    const b = bucketOf(e, playerId);
    assignments[e.id] = b;
    Object.assign(values, e.buckets.find((x) => x.id === b)!.values);
  }
  return { assignments, values };
}

/** REQ-UXS-003: what the matchmaker needs for a player's first ranked race (fill wait, course). Null after it. */
export function firstRaceOf(m: Master, s: PlayerState): { cpuFillAfterMs: number; trackId: string | null } | null {
  const bm = m.progression.beginnerMatch;
  if (!bm || s.rating.rankedRaces > 0) return null;
  const ab = experimentsView(m, s.id).values;
  const trackId = 'firstRankedTrackId' in ab ? (ab.firstRankedTrackId as string | null) : bm.firstRaceTrackId;
  return { cpuFillAfterMs: bm.firstRaceCpuFillAfterMs, trackId: trackId && m.tracks.some((t) => t.id === trackId) ? trackId : null };
}

/** Every onboarding-related check on a master (boot: index.ts; remote config: ops/config.ts). */
export function uxProblems(m: Master, knownItems: Set<string>): string[] {
  return [...onboardingProblems(m.progression, m, knownItems), ...nudgeProblems(m.progression.nudges), ...accountDeletionProblems(m.progression.accountDeletion), ...dayRolloverProblems(m.progression.dayRollover),
    ...inviteProblems(m), ...comebackProblems(m), ...changelogProblems(m.changelog), ...adsProblems(m.progression.ads), ...trainingProblems(m), ...giftBoxProblems(m), ...rivalProblems(m),
    ...weeklyChallengeProblems(m)]; // REQ-INV-*, REQ-CB-*, REQ-AD-002, REQ-TRAIN-012, REQ-BOX-012, REQ-RIVAL-012
}

export function validateUx(m: Master, knownItems: Set<string>): void {
  const p = uxProblems(m, knownItems);
  if (p.length) throw new AppError('CONFIG_INVALID', p.join('; '));
}
