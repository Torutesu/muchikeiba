/**
 * 図鑑 (collection book, REQ-COL-*) and 実績 (achievements, REQ-ACH-*); contracts/protocol.md "図鑑・実績・称号".
 *
 *   図鑑        every horse template, unique skill, course and cosmetic in the master, each obtained / seen / unknown,
 *               with lore (master/collection.json) and stats. "Seen" = raced against it (CPU runners and the skills in
 *               the field of a confirmed race) — the race config tells the server, never the client. Counts and a
 *               completion percentage are shown; completing the book or any part of it pays NOTHING.
 *   実績        tiered goals for PLAY only: races, wins, wins per course, courses raced, unique skills fired, breeding
 *               generations, time-attack medals, tournament podiums / wins, stable likes received, team cheers sent.
 *               A tier unlocks when its target is reached (set semantics, never revoked) and is claimed for free coins
 *               (value-capped); titles hang off tiers through titles.json (`condition.kind: "achievement"`), so there is
 *               ONE title system (REQ-TITLE-*): equipped on the profile and shown on the stable (stable.ts).
 *   progress    event-based and idempotent: every counter is either derived from state the existing flows already
 *               keep (stats, time-attack milestones, stable likes, horses) or bumped inside the transaction of the
 *               flow that produced it (race results are applied once per raceId, a tournament result once per
 *               tournament, a cheer once per feed ref). `syncCollection` runs at the end of every PlayerService
 *               transaction and unlocks whatever is due (KPI `achievement_unlock`).
 *
 * Legal guard rails (docs/planning/03 「図鑑・実績（REQ-COL / REQ-ACH）でコンプガチャを作らない理由」):
 *   - no reward for completing a set that contains anything a paid random draw can give (カード合わせ, 景品表示法):
 *     the only set metric is `collect`, and `collectionRewardProblems` rejects a set with a horse or a skill a gacha
 *     pool can produce, or with a cosmetic that is sold (a reward for spending). Runs at boot and on every
 *     remote-config version (a banner change can turn a harmless set into a gacha set).
 *   - no metric counts purchases, coins spent or gacha pulls (`FORBIDDEN_METRICS` is refused with its own message).
 *   - rewards are free coins only (schema: `{ freeCoins }`), ≤ COLLECTION_HARD_LIMITS.maxFreeCoinsPerTier per tier
 *     (¥160 at the worst pack price, under the ¥200 総付景品 floor) and ≤ maxTotalFreeCoins over all tiers.
 *   - nothing is claimed or unlocked while the account is scheduled for deletion (REQ-UXS-040).
 */
import { z } from 'zod';
import { AppError } from './errors.js';
import { grantReward } from './items.js';
import type { HorseInstance, PlayerState } from './player.js';
import type { Master } from './master.js';
import type { RaceResultForPlayer } from './rewards.js';
import type { RaceStartConfig } from './schemas.js';
import { deletionScheduled } from './accountDeletion.js';
import { conditionText, effectText } from './skills.js';
import { assetKeys } from './visuals.js';
import type { Emit } from './service.js';
import collectionJson from '../../master/collection.json';
import tracksJson from '../../master/tracks.json';

/** Course names live only in master/tracks.json (splitMasterTrack drops them from the race config). */
const TRACK_NAMES: Record<string, string> = Object.fromEntries((tracksJson as { tracks: { id: string; name?: string }[] }).tracks.map((t) => [t.id, t.name ?? t.id]));

// ------------------------------------------------------------------------------------------------ config

export type AchievementMetric =
  | 'races' | 'wins' | 'top3' | 'trackWins' | 'collect' | 'skillsActivated' | 'breedingGeneration'
  | 'taMedals' | 'tournamentPodiums' | 'tournamentWins' | 'stableLikes' | 'teamCheers';
export const ACHIEVEMENT_METRICS: AchievementMetric[] = [
  'races', 'wins', 'top3', 'trackWins', 'collect', 'skillsActivated', 'breedingGeneration', 'taMedals', 'tournamentPodiums', 'tournamentWins', 'stableLikes', 'teamCheers',
];
/** Never a metric: rewards for spending money or for drawing (docs/planning/03). Named so the refusal says why. */
export const FORBIDDEN_METRICS = ['purchases', 'yenSpent', 'paidCoinsSpent', 'coinsSpent', 'gachaPulls', 'gachaDraws', 'pulls', 'ssrCount', 'collectionPercent', 'collectionComplete'];
export type CollectionSection = 'horses' | 'skills' | 'courses' | 'cosmetics';
export const COLLECTION_SECTIONS: CollectionSection[] = ['horses', 'skills', 'courses', 'cosmetics'];
export type AchievementCategory = 'race' | 'course' | 'skill' | 'breeding' | 'time_attack' | 'tournament' | 'stable' | 'team';
export type TaMedal = 'bronze' | 'silver' | 'gold';

export interface AchievementTier { tier: number; target: number; reward: { freeCoins: number } }
export interface AchievementDef {
  id: string; category: AchievementCategory; name: string; description: string; metric: AchievementMetric;
  /** trackWins */
  trackId?: string;
  /** taMedals: time-attack milestones whose id ends in `_<medal>` (progression.timeAttack.milestones). */
  medal?: TaMedal;
  /** collect: the section and (optional) ids; absent ids = the whole section. */
  section?: CollectionSection; ids?: string[];
  tiers: AchievementTier[];
}
export interface CollectionMaster {
  _note?: string;
  caps: { maxFreeCoinsPerTier: number; maxTotalFreeCoins: number };
  lore: { horses: Record<string, string>; skills: Record<string, string>; courses: Record<string, string>; cosmetics?: Record<string, string> };
  achievements: AchievementDef[];
}

/** Code ceilings no master or remote config can exceed. 100 coins × ¥1.6 (worst pack) = ¥160 ≤ ¥200 (総付景品). */
export const COLLECTION_HARD_LIMITS = { maxFreeCoinsPerTier: 100, maxTotalFreeCoins: 5000, maxTiers: 5, maxAchievements: 64 };

export const collectionOf = (m: Pick<Master, 'collection'>): CollectionMaster => m.collection ?? (collectionJson as unknown as CollectionMaster);

const int = z.number().int();
const idRe = /^[a-z0-9_]{1,40}$/;
const achievementSchema = z.object({
  id: z.string().regex(idRe),
  category: z.enum(['race', 'course', 'skill', 'breeding', 'time_attack', 'tournament', 'stable', 'team']),
  name: z.string().min(1).max(40), description: z.string().min(1).max(120),
  metric: z.string(),
  trackId: z.string().min(1).max(64).optional(),
  medal: z.enum(['bronze', 'silver', 'gold']).optional(),
  section: z.enum(['horses', 'skills', 'courses', 'cosmetics']).optional(),
  ids: z.array(z.string().min(1).max(64)).min(1).max(64).optional(),
  tiers: z.array(z.object({
    tier: int.min(1).max(COLLECTION_HARD_LIMITS.maxTiers), target: int.min(1).max(1_000_000),
    // free coins only: no paid coins, items, horses, pass XP or anything else (strict)
    reward: z.object({ freeCoins: int.min(1).max(COLLECTION_HARD_LIMITS.maxFreeCoinsPerTier) }).strict(),
  }).strict()).min(1).max(COLLECTION_HARD_LIMITS.maxTiers),
}).strict();
const collectionSchema = z.object({
  _note: z.string().optional(),
  caps: z.object({ maxFreeCoinsPerTier: int.min(1).max(COLLECTION_HARD_LIMITS.maxFreeCoinsPerTier), maxTotalFreeCoins: int.min(1).max(COLLECTION_HARD_LIMITS.maxTotalFreeCoins) }).strict(),
  lore: z.object({
    horses: z.record(z.string(), z.string().min(1).max(120)), skills: z.record(z.string(), z.string().min(1).max(120)),
    courses: z.record(z.string(), z.string().min(1).max(120)), cosmetics: z.record(z.string(), z.string().min(1).max(120)).optional(),
  }).strict(),
  achievements: z.array(z.unknown()).max(COLLECTION_HARD_LIMITS.maxAchievements),
}).strict();

/** What a paid random draw can give: every template in a banner pool (all banners take paid coins) and its skill. */
export function gachaObtainable(m: Pick<Master, 'gacha' | 'templateById' | 'skills'>): { templates: Set<string>; skills: Set<string> } {
  const templates = new Set<string>();
  for (const b of m.gacha.banners) {
    for (const e of b.pool) templates.add(e.templateId);
    for (const st of b.stepUp?.steps ?? []) for (const e of st.finalSlotPool ?? []) templates.add(e.templateId);
  }
  const skills = new Set<string>();
  for (const t of templates) {
    const sid = m.templateById.get(t)?.skillId;
    if (sid) skills.add(sid);
  }
  return { templates, skills };
}

/** Ids a `collect` achievement counts (absent ids = the whole section). */
export function collectIds(m: Master, d: Pick<AchievementDef, 'section' | 'ids'>): string[] {
  if (d.ids) return d.ids;
  switch (d.section) {
    case 'horses': return m.templates.map((t) => t.id);
    case 'skills': return m.skills.skills.map((k) => k.id);
    case 'courses': return m.tracks.map((t) => t.id);
    case 'cosmetics': return m.items.cosmetics.map((c) => c.id);
    default: return [];
  }
}

/**
 * REQ-ACH-008 / REQ-GACHA-008 (コンプガチャ防止): a reward for completing a set may not involve anything a paid random
 * draw can give — not even ONE such item (stricter than the 2+ rule of compGachaProblems: a set where all but the gacha
 * item come free is still a 揃え). Cosmetics are sold for coins, so a set of them would reward spending (refused too).
 * Courses are the only collectable set today (no gacha, no price).
 */
export function collectionRewardProblems(m: Master, c: CollectionMaster = collectionOf(m)): string[] {
  const out: string[] = [];
  const g = gachaObtainable(m);
  const sold = new Set(m.items.cosmetics.map((x) => x.id));
  for (const d of c.achievements) {
    if (d.metric !== 'collect') continue;
    const ids = collectIds(m, d);
    const at = `collection.achievements.${d.id}`;
    if (d.section === 'horses' || d.section === 'skills') {
      const pool = d.section === 'horses' ? g.templates : g.skills;
      const hits = ids.filter((x) => pool.has(x));
      if (hits.length > 0) out.push(`${at}: rewards collecting ${hits.length} gacha-obtainable ${d.section} (${hits.slice(0, 3).join(', ')}${hits.length > 3 ? ', …' : ''}) — comp gacha is prohibited`);
    }
    if (d.section === 'cosmetics') {
      const hits = ids.filter((x) => sold.has(x));
      if (hits.length > 0) out.push(`${at}: rewards collecting ${hits.length} cosmetics that are sold for coins — no reward for spending`);
    }
  }
  return out;
}

/** REQ-ACH-007: master/collection.json (boot) and the same checks on every remote-config version (ops/config.ts). */
export function collectionProblems(m: Master, cfg: unknown = collectionOf(m), opts: { strictRefs?: boolean; skipSets?: boolean } = {}): string[] {
  const r = collectionSchema.safeParse(cfg);
  if (!r.success) return r.error.issues.map((i) => `collection.${i.path.join('.')}: ${i.message}`);
  const c = r.data as CollectionMaster;
  const out: string[] = [];
  const ids = new Set<string>();
  let total = 0;
  const trackIds = new Set(m.tracks.map((t) => t.id));
  c.achievements.forEach((raw, i) => {
    const at = `collection.achievements[${i}]`;
    const metric = (raw as { metric?: unknown })?.metric;
    if (typeof metric === 'string' && FORBIDDEN_METRICS.includes(metric)) {
      out.push(`${at}: metric ${metric} is prohibited — achievements reward play only, never spending money or gacha pulls`);
      return;
    }
    const p = achievementSchema.safeParse(raw);
    if (!p.success) { out.push(...p.error.issues.map((x) => `${at}.${x.path.join('.')}: ${x.message}`)); return; }
    const d = p.data as AchievementDef;
    if (!ACHIEVEMENT_METRICS.includes(d.metric)) { out.push(`${at}: unknown metric ${d.metric}`); return; }
    if (ids.has(d.id)) out.push(`${at}: duplicate id ${d.id}`);
    ids.add(d.id);
    if (d.metric === 'trackWins' && !d.trackId) out.push(`${at}: trackWins needs trackId`);
    if (d.metric === 'trackWins' && d.trackId && opts.strictRefs && !trackIds.has(d.trackId)) out.push(`${at}: unknown track ${d.trackId}`);
    if (d.metric !== 'trackWins' && d.trackId) out.push(`${at}: trackId is only for trackWins`);
    if (d.metric === 'taMedals' && !d.medal) out.push(`${at}: taMedals needs medal`);
    if (d.metric !== 'taMedals' && d.medal) out.push(`${at}: medal is only for taMedals`);
    if (d.metric === 'collect' && !d.section) out.push(`${at}: collect needs section`);
    if (d.metric !== 'collect' && (d.section || d.ids)) out.push(`${at}: section/ids are only for collect`);
    if (d.metric === 'collect' && d.section) {
      const known = new Set(collectIds(m, { section: d.section }));
      for (const x of d.ids ?? []) if (!known.has(x)) out.push(`${at}: unknown ${d.section} id ${x}`);
      const n = collectIds(m, d).length;
      if (opts.strictRefs && d.tiers.some((t) => t.target > n)) out.push(`${at}: a tier target is larger than the set (${n})`);
    }
    let prevTarget = 0;
    d.tiers.forEach((t, k) => {
      if (t.tier !== k + 1) out.push(`${at}.tiers[${k}]: tiers must be numbered 1, 2, 3, …`);
      if (t.target <= prevTarget) out.push(`${at}.tiers[${k}]: targets must increase`);
      prevTarget = t.target;
      if (t.reward.freeCoins > c.caps.maxFreeCoinsPerTier) out.push(`${at}.tiers[${k}]: ${t.reward.freeCoins} free coins is over caps.maxFreeCoinsPerTier ${c.caps.maxFreeCoinsPerTier}`);
      total += t.reward.freeCoins;
    });
  });
  if (total > c.caps.maxTotalFreeCoins) out.push(`collection: achievements pay ${total} free coins in all, over caps.maxTotalFreeCoins ${c.caps.maxTotalFreeCoins}`);
  // titles that hang off an achievement tier must point at a real one (REQ-ACH-006)
  const byId = new Map(c.achievements.map((a) => [(a as AchievementDef).id, a as AchievementDef]));
  for (const t of m.titles) {
    if (t.condition.kind !== 'achievement') continue;
    const a = byId.get(t.condition.achievementId);
    if (!a) out.push(`titles.${t.id}: unknown achievement ${t.condition.achievementId}`);
    else if (!a.tiers?.some((x) => x.tier === (t.condition as { tier: number }).tier)) out.push(`titles.${t.id}: achievement ${a.id} has no tier ${t.condition.tier}`);
  }
  if (out.length === 0 && !opts.skipSets) out.push(...collectionRewardProblems(m, c));
  return out;
}

export function validateCollection(m: Master): void {
  const p = collectionProblems(m, collectionOf(m), { strictRefs: true });
  if (p.length) throw new AppError('CONFIG_INVALID', p.join('; '));
}

// ------------------------------------------------------------------------------------------------ state

export interface CollectionState {
  /** Template / skill ids the player has ever owned (horses are never deleted, but kept here so the book never loses one). */
  owned: { templates: string[]; skills: string[] };
  /** Raced against in a confirmed race (CPU runners and skills in the field). */
  seen: { templates: string[]; skills: string[] };
  counters: { skillsActivated: number; maxGeneration: number; teamCheers: number; tournamentPodiums: number; tournamentWins: number };
  /** Unlocked tiers by `${achievementId}:${tier}`: when, and when claimed (null = not yet). */
  tiers: Record<string, { at: number; claimedAt: number | null }>;
  /** Recent cheer refs already counted (a retried post or reaction never counts twice). */
  cheerRefs: string[];
}
const CHEER_REFS_KEEP = 300;

const peek = (s: PlayerState): CollectionState | undefined => (s as PlayerState & { collection?: CollectionState }).collection;
export function ensureCollection(s: PlayerState): CollectionState {
  const x = s as PlayerState & { collection?: CollectionState };
  x.collection ??= { owned: { templates: [], skills: [] }, seen: { templates: [], skills: [] }, counters: { skillsActivated: 0, maxGeneration: 0, teamCheers: 0, tournamentPodiums: 0, tournamentWins: 0 }, tiers: {}, cheerRefs: [] };
  return x.collection;
}

const addAll = (list: string[], xs: Iterable<string>) => {
  let changed = false;
  for (const x of xs) if (!list.includes(x)) { list.push(x); changed = true; }
  if (changed) list.sort();
  return changed;
};

const tierKey = (id: string, tier: number) => `${id}:${tier}`;

// ------------------------------------------------------------------------------------------------ events

/**
 * What one confirmed race tells the 図鑑 (computed by settleRace from the race config, never from a client): CPU runners'
 * templates and the skills in the field, and whether the player's own skill fired (agreeing client reports / verifier).
 */
export interface RaceCollectionInfo { templates: string[]; skills: string[] }

/** REQ-COL-002: the other runners of a race — CPU horses carry their template id (`cpu_<templateId>`), every horse its skill. */
export function raceFieldSeen(config: RaceStartConfig, slot: number): RaceCollectionInfo {
  const others = config.entrants.filter((e) => e.slot !== slot);
  return {
    templates: [...new Set(others.filter((e) => e.kind === 'cpu' && e.horse.id.startsWith('cpu_')).map((e) => e.horse.id.slice(4)))].sort(),
    skills: [...new Set(others.map((e) => e.horse.skill?.id).filter((x): x is string => !!x))].sort(),
  };
}

/** REQ-COL-002 / REQ-ACH-002: called inside applyRace's transaction (once per raceId). */
export function noteRaceCollection(m: Master, s: PlayerState, r: RaceResultForPlayer) {
  if (r.void || r.mode === 'tutorial') return;
  const seen = r.seen;
  const fired = r.details?.skillFired === true && !r.details.cpuAssisted;
  if (!fired && !(seen && (seen.templates.length || seen.skills.length))) return;
  const c = ensureCollection(s);
  if (seen) {
    addAll(c.seen.templates, seen.templates.filter((t) => m.templateById.has(t)));
    addAll(c.seen.skills, seen.skills.filter((k) => m.skills.byId.has(k)));
  }
  if (fired) c.counters.skillsActivated++;
}

/** REQ-ACH-002: a tournament's final rank (tournamentClose pays once per tournament; this rides the same guard). */
export function noteTournamentResult(s: PlayerState, rank: number) {
  if (rank < 1 || rank > 3) return;
  const c = ensureCollection(s);
  c.counters.tournamentPodiums++;
  if (rank === 1) c.counters.tournamentWins++;
}

/** REQ-ACH-002: a cheer stamp the team stored (post or new reaction), counted once per `ref`. */
export function noteCheer(s: PlayerState, ref: string | null): boolean {
  const c = ensureCollection(s);
  if (ref) {
    if (c.cheerRefs.includes(ref)) return false;
    c.cheerRefs.push(ref);
    if (c.cheerRefs.length > CHEER_REFS_KEEP) c.cheerRefs.splice(0, c.cheerRefs.length - CHEER_REFS_KEEP);
  }
  c.counters.teamCheers++;
  return true;
}

/** Generation of a horse bred in this stable: 0 for a template horse, 1 + the older parent's generation for a foal. */
export function generationsOf(horses: HorseInstance[]): Map<string, number> {
  const byId = new Map(horses.map((h) => [h.id, h]));
  const memo = new Map<string, number>();
  const gen = (id: string | null, depth: number): number => {
    if (!id || depth > 64) return 0;
    const hit = memo.get(id);
    if (hit !== undefined) return hit;
    const h = byId.get(id);
    if (!h) return 0; // another player's stallion (stud) or unknown
    const bred = h.sireId !== null || h.damId !== null || h.studSire !== undefined;
    const g = bred ? 1 + Math.max(gen(h.sireId, depth + 1), gen(h.damId, depth + 1)) : 0;
    memo.set(id, g);
    return g;
  };
  for (const h of horses) gen(h.id, 0);
  return memo;
}

// ------------------------------------------------------------------------------------------------ progress

function taMedals(s: PlayerState, medal: TaMedal): number {
  return (s.timeAttack?.milestones ?? []).filter((id) => id.endsWith(`_${medal}`)).length;
}
const stableLikes = (s: PlayerState) => (s as PlayerState & { stable?: { likes?: number } }).stable?.likes ?? 0;

/** Courses the player has run (a counted race or a finished time attack). */
export function racedCourses(m: Master, s: PlayerState): Set<string> {
  const out = new Set<string>();
  for (const t of m.tracks) {
    if ((s.stats.byTrack[t.id]?.races ?? 0) > 0 || s.timeAttack?.allTimeBest[t.id]) out.add(t.id);
  }
  return out;
}

function obtainedSet(m: Master, s: PlayerState, section: CollectionSection): Set<string> {
  const c = peek(s);
  switch (section) {
    case 'horses': return new Set([...(c?.owned.templates ?? []), ...s.horses.map((h) => h.templateId).filter((x): x is string => !!x)]);
    case 'skills': return new Set([...(c?.owned.skills ?? []), ...s.horses.map((h) => h.skillId).filter((x): x is string => !!x)]);
    case 'courses': return racedCourses(m, s);
    case 'cosmetics': return new Set(m.items.cosmetics.filter((x) => (s.items[x.id] ?? 0) > 0).map((x) => x.id));
  }
}

export function metricValue(m: Master, s: PlayerState, d: AchievementDef): number {
  const c = peek(s);
  const st = s.stats;
  const tours = Object.values(s.tournaments ?? {});
  switch (d.metric) {
    case 'races': return st.races;
    case 'wins': return st.wins;
    case 'top3': return st.top3;
    case 'trackWins': return st.byTrack[d.trackId ?? '']?.wins ?? 0;
    case 'collect': { const got = obtainedSet(m, s, d.section!); return collectIds(m, d).filter((x) => got.has(x)).length; }
    case 'skillsActivated': return c?.counters.skillsActivated ?? 0;
    case 'breedingGeneration': return Math.max(c?.counters.maxGeneration ?? 0, ...generationsOf(s.horses).values());
    case 'taMedals': return taMedals(s, d.medal ?? 'gold');
    // the tournament history keeps the newest results only; the counters keep the totals (whichever is larger)
    case 'tournamentPodiums': return Math.max(c?.counters.tournamentPodiums ?? 0, tours.filter((t) => t.rank >= 1 && t.rank <= 3).length);
    case 'tournamentWins': return Math.max(c?.counters.tournamentWins ?? 0, tours.filter((t) => t.rank === 1).length);
    case 'stableLikes': return stableLikes(s);
    case 'teamCheers': return c?.counters.teamCheers ?? 0;
  }
}

export interface UnlockedTier { achievementId: string; tier: number; reward: { freeCoins: number } }

/**
 * REQ-ACH-003: end-of-transaction step — remembers owned templates/skills and the deepest generation, then unlocks
 * every tier whose target is reached (once; KPI `achievement_unlock`). Nothing unlocks while the account is scheduled
 * for deletion (REQ-UXS-040). Idempotent: running it twice changes nothing the second time.
 */
export function syncCollection(m: Master, s: PlayerState, now: number, emit: Emit | null): UnlockedTier[] {
  if (deletionScheduled(s)) return [];
  const cm = collectionOf(m);
  let c = peek(s);
  const templates = s.horses.map((h) => h.templateId).filter((x): x is string => !!x);
  const skills = s.horses.map((h) => h.skillId).filter((x): x is string => !!x);
  if (!c && templates.length === 0 && skills.length === 0 && s.stats.races === 0 && !s.timeAttack) return [];
  c ??= ensureCollection(s);
  addAll(c.owned.templates, templates);
  addAll(c.owned.skills, skills);
  const gen = Math.max(0, ...generationsOf(s.horses).values());
  if (gen > c.counters.maxGeneration) c.counters.maxGeneration = gen;
  const out: UnlockedTier[] = [];
  for (const d of cm.achievements) {
    const v = metricValue(m, s, d);
    for (const t of d.tiers) {
      if (v < t.target) break;
      const k = tierKey(d.id, t.tier);
      if (c.tiers[k]) continue;
      c.tiers[k] = { at: now, claimedAt: null };
      out.push({ achievementId: d.id, tier: t.tier, reward: { ...t.reward } });
      emit?.({ name: 'achievement_unlock', s1: d.id, s2: d.category, s3: d.metric, value: t.tier, count: v });
    }
  }
  return out;
}

/** REQ-ACH-006: title condition `achievement` (stats.ts conditionMet). */
export const tierReached = (s: PlayerState, achievementId: string, tier: number) => !!peek(s)?.tiers[tierKey(achievementId, tier)];

// ------------------------------------------------------------------------------------------------ views

export type EntryState = 'obtained' | 'seen' | 'unknown';
const pm = (n: number, total: number) => (total > 0 ? Math.floor((n * 1000) / total) : 0);
const counts = (states: EntryState[]) => {
  const obtained = states.filter((x) => x === 'obtained').length;
  const seen = states.filter((x) => x === 'seen').length;
  return { total: states.length, obtained, seen, unknown: states.length - obtained - seen, completionPermille: pm(obtained, states.length) };
};

/** REQ-COL-001..005: GET /v1/collection. */
export function collectionView(m: Master, s: PlayerState) {
  const cm = collectionOf(m);
  const c = peek(s);
  const ownedT = obtainedSet(m, s, 'horses');
  const ownedS = obtainedSet(m, s, 'skills');
  const seenT = new Set(c?.seen.templates ?? []);
  const seenS = new Set(c?.seen.skills ?? []);
  const horses = m.templates.map((t) => {
    const state: EntryState = ownedT.has(t.id) ? 'obtained' : seenT.has(t.id) ? 'seen' : 'unknown';
    const known = state !== 'unknown';
    return {
      id: t.id, state, rarity: t.rarity,
      // unknown entries keep their place (rarity) but not their name: the silhouette is all the book shows
      name: known ? t.name : null, style: known ? t.style : null, surface: known ? t.surface : null,
      distance: known ? { minM: t.distMinM, maxM: t.distMaxM } : null,
      skillId: known ? t.skillId ?? null : null,
      lore: known ? cm.lore.horses[t.id] ?? null : null,
      stats: state === 'obtained' ? { ...t.stats } : null,
      seasonal: t.seasonal ? { label: t.seasonal.label } : null,
      art: known ? assetKeys.collectionPortrait(t.id) : assetKeys.collectionSilhouette(t.id),
    };
  });
  const skills = m.skills.skills.map((k) => {
    const state: EntryState = ownedS.has(k.id) ? 'obtained' : seenS.has(k.id) ? 'seen' : 'unknown';
    const known = state !== 'unknown';
    return {
      id: k.id, state, rarity: k.rarity, name: known ? k.name : null, styles: known ? [...k.styles] : null,
      condition: known ? conditionText(k) : null, effect: state === 'obtained' ? effectText(k) : null,
      lore: known ? cm.lore.skills[k.id] ?? null : null,
    };
  });
  const raced = racedCourses(m, s);
  const courses = m.tracks.map((t) => {
    const bt = s.stats.byTrack[t.id];
    const state: EntryState = raced.has(t.id) ? 'obtained' : 'unknown';
    return {
      id: t.id, state, name: TRACK_NAMES[t.id] ?? t.id,
      surface: t.surface, distanceM: t.distanceM, lore: cm.lore.courses[t.id] ?? null,
      races: bt?.races ?? 0, wins: bt?.wins ?? 0, bestFinishTick: bt?.bestFinishTick ?? null,
      timeAttackBestMs: s.timeAttack?.allTimeBest[t.id]?.timeMs ?? null,
    };
  });
  const cosmetics = m.items.cosmetics.map((x) => {
    const state: EntryState = (s.items[x.id] ?? 0) > 0 ? 'obtained' : 'unknown';
    return { id: x.id, state, kind: x.kind, name: x.name, lore: cm.lore.cosmetics?.[x.id] ?? null, icon: assetKeys.item(x.id) };
  });
  const sections = {
    horses: { ...counts(horses.map((x) => x.state)), entries: horses },
    skills: { ...counts(skills.map((x) => x.state)), entries: skills },
    courses: { ...counts(courses.map((x) => x.state)), entries: courses },
    cosmetics: { ...counts(cosmetics.map((x) => x.state)), entries: cosmetics },
  };
  const all = [...horses, ...skills, ...courses, ...cosmetics].map((x) => x.state);
  return {
    sections,
    totals: counts(all),
    // REQ-COL-005 / 03: completing the book pays nothing — the percentage is a display only
    completionRewards: false as const,
    notice: '図鑑の達成率は記録の表示だけです。そろえても報酬はありません。',
  };
}

function titlesFor(m: Master, s: PlayerState, achievementId: string) {
  return m.titles.filter((t) => t.condition.kind === 'achievement' && t.condition.achievementId === achievementId)
    .map((t) => ({ id: t.id, name: t.name, tier: (t.condition as { tier: number }).tier, unlocked: s.titles.includes(t.id), icon: assetKeys.title(t.id) }));
}

/** REQ-ACH-004: GET /v1/achievements. */
export function achievementsView(m: Master, s: PlayerState) {
  const cm = collectionOf(m);
  const c = peek(s);
  const blocked = deletionScheduled(s);
  let tiers = 0, unlocked = 0, claimed = 0, claimable = 0, claimableCoins = 0, earnedCoins = 0, totalCoins = 0;
  const achievements = cm.achievements.map((d) => {
    const progress = metricValue(m, s, d);
    const ts = d.tiers.map((t) => {
      const rec = c?.tiers[tierKey(d.id, t.tier)];
      const isClaimable = !!rec && rec.claimedAt === null && !blocked;
      tiers++; totalCoins += t.reward.freeCoins;
      if (rec) unlocked++;
      if (rec?.claimedAt != null) { claimed++; earnedCoins += t.reward.freeCoins; }
      if (isClaimable) { claimable++; claimableCoins += t.reward.freeCoins; }
      return { tier: t.tier, target: t.target, reward: { ...t.reward }, unlocked: !!rec, unlockedAt: rec?.at ?? null, claimed: rec?.claimedAt != null, claimable: isClaimable, badge: assetKeys.badge(d.id, t.tier) };
    });
    const next = d.tiers.find((t) => progress < t.target) ?? null;
    const top = [...ts].reverse().find((t) => t.unlocked) ?? null;
    return {
      id: d.id, category: d.category, name: d.name, description: d.description, metric: d.metric,
      ...(d.trackId ? { trackId: d.trackId } : {}), ...(d.medal ? { medal: d.medal } : {}), ...(d.section ? { section: d.section } : {}),
      progress, nextTarget: next?.target ?? null, tier: top?.tier ?? 0, maxTier: d.tiers.length,
      badge: top ? top.badge : null, tiers: ts, titles: titlesFor(m, s, d.id),
    };
  });
  return {
    achievements, blocked,
    totals: { tiers, unlocked, claimed, claimable, claimableCoins, earnedCoins, totalCoins },
    notice: '実績はレースや育成などのプレイで達成します。課金やガチャの回数では達成しません。報酬は無償コインです。',
  };
}

/** Showcase on the stable and profile (stable.ts trophies): the highest tier of each achievement, best first. */
export function achievementBadges(m: Master, s: PlayerState, limit = 6): { achievementId: string; tier: number; badge: string }[] {
  const c = peek(s);
  if (!c) return [];
  const out: { achievementId: string; tier: number; badge: string; at: number }[] = [];
  for (const d of collectionOf(m).achievements) {
    const top = [...d.tiers].reverse().find((t) => c.tiers[tierKey(d.id, t.tier)]);
    if (top) out.push({ achievementId: d.id, tier: top.tier, badge: assetKeys.badge(d.id, top.tier), at: c.tiers[tierKey(d.id, top.tier)]!.at });
  }
  return out.sort((a, b) => b.tier - a.tier || b.at - a.at || a.achievementId.localeCompare(b.achievementId)).slice(0, limit).map(({ at: _at, ...x }) => x);
}

// ------------------------------------------------------------------------------------------------ claims

/** REQ-ACH-005: claim one unlocked tier (free coins). Keyed by the caller (PlayerService.tx). */
export function claimAchievement(m: Master, s: PlayerState, achievementId: string, tier: number, now: number, emit: Emit | null) {
  if (deletionScheduled(s)) throw new AppError('DELETION_PENDING', 'the account is scheduled for deletion');
  const d = collectionOf(m).achievements.find((a) => a.id === achievementId);
  const t = d?.tiers.find((x) => x.tier === tier);
  if (!d || !t) throw new AppError('NOT_FOUND', `achievement ${achievementId} tier ${tier}`);
  const rec = peek(s)?.tiers[tierKey(d.id, t.tier)];
  if (!rec) throw new AppError('NOT_ELIGIBLE', 'tier not reached');
  if (rec.claimedAt !== null) throw new AppError('ALREADY_CLAIMED', `${d.id} tier ${t.tier}`);
  rec.claimedAt = now;
  grantReward(s, t.reward, now, `achievement ${d.id} tier ${t.tier}`, `ach:${d.id}:${t.tier}`);
  emit?.({ name: 'achievement_claim', s1: d.id, s2: d.category, value: t.tier, freeCoins: t.reward.freeCoins });
  return { achievementId: d.id, tier: t.tier, reward: { ...t.reward } };
}

/** REQ-ACH-005: claim every claimable tier at once (in master order). */
export function claimAllAchievements(m: Master, s: PlayerState, now: number, emit: Emit | null) {
  if (deletionScheduled(s)) throw new AppError('DELETION_PENDING', 'the account is scheduled for deletion');
  const c = peek(s);
  const claimed: { achievementId: string; tier: number; reward: { freeCoins: number } }[] = [];
  if (c) {
    for (const d of collectionOf(m).achievements) {
      for (const t of d.tiers) {
        const rec = c.tiers[tierKey(d.id, t.tier)];
        if (rec && rec.claimedAt === null) claimed.push(claimAchievement(m, s, d.id, t.tier, now, emit));
      }
    }
  }
  return { claimed, freeCoins: claimed.reduce((a, x) => a + x.reward.freeCoins, 0) };
}
