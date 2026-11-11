/**
 * 騎手の道 (single-player career) — REQ-CAREER-001..024, contracts/protocol.md §66.
 *
 * Chapters (master/career.json, checked at boot by careerProblems) of 3–5 races against CPU on fixed conditions (course,
 * going, night, field size, CPU level / strength / running styles), each with a short story line before and after (Japanese
 * and English side by side, ムチ一閃 tone, no betting words), a clear objective (star 1, unlocks the next race) and up to two
 * optional objectives (stars 2 and 3). Objectives are the ones the verified result decides deterministically: a finishing
 * place, a whip count, a race time (evaluateChallenge, the weekly challenge rules §31.7 — the same C# ChallengeEvaluator).
 *
 * The race path is the weekly challenge's (§31 / time attack §8.1): the server issues the config (mode `challenge`, no
 * unique skills, the day's form off, every entrant normalised to the chapter's `statCap`), the device races the CPUs offline
 * and submits only its inputs, the C# verifier re-simulates the issued config, and the player's object evaluates the
 * objectives itself. A client claim alone never clears a race.
 *
 * Fairness: the player's own horse, normalised to the chapter cap (never above the free partner's stat total, so the
 * partner always reaches it — paying cannot trivialise a chapter). Career races never reach applyRace: no rating, class
 * points, season points, leaderboards, stats, missions, pass XP, rival / team / exchange points (structural).
 *
 * Rewards (economy E20): the first clear of a race and each star, once ever per account (the `granted` marks — not the
 * session — make a replayed or doubled submission unable to pay twice), free coins / breeding material / training apples
 * only, ≤ ¥200 a grant at the worst pack price, inside code ceilings for the whole career. Never paid coins, never a random
 * item, nothing for completing a set. Retries are free and unlimited: no stamina, no paid continue, no paid skip
 * (`startsPerDay` is a hidden anti-abuse ceiling far above a day of play, not an energy meter).
 */
import { z } from 'zod';
import careerJson from '../../master/career.json';
import { AppError } from './errors.js';
import { STAT_KEYS, trackById, type Master, type Reward, type Style } from './master.js';
import type { PlayerState } from './player.js';
import { getHorse } from './horses.js';
import { grantReward } from './items.js';
import { buildRaceConfig, toRaceHorse } from './raceConfig.js';
import { timeAttackRuleset, type Ruleset } from './ruleset.js';
import type { Rng } from './rng.js';
import { goingSchema, goingsFor, styleSchema, type Going, type RaceStartConfig, type ReplayLog, type VerifierOutput } from './schemas.js';
import { dayRule, gameDayKey, sameGameDay } from './time.js';
import { jsonEqual } from './timeAttack.js';
import { conditionLabels, evaluateChallenge, validateChallengeInputs, type ChallengeEvaluation } from './weeklyChallenge.js';
import { worstYenPerCoin } from './invite.js';
import { pick, wordingProblems, type Loc } from './help.js';
import type { Locale } from '../i18n/locale.js';
import type { KpiEvent } from './kpi.js';

type Emit = (e: KpiEvent) => void;

// ------------------------------------------------------------------------------------------------ master

export interface CareerObjective { maxPlace?: number; maxWhips?: number; maxTimeMs?: number }
export interface CareerStarDef { objective: CareerObjective; reward?: Reward }
export interface CareerRaceDef {
  id: string; title: Loc; trackId: string; going?: Going; night?: boolean;
  cpuCount: number; cpuLevel: number; cpuStatPermille?: number; cpuStyles?: Style[];
  story: { before: Loc; after: Loc };
  /** Star 1: clears the race and unlocks the next one. Always a finishing place. */
  clear: CareerObjective;
  /** First-clear reward (once ever). */
  reward: Reward;
  /** Stars 2 and 3 (0–2 entries): each needs the clear in the same run. */
  stars: CareerStarDef[];
}
export interface CareerChapterDef { id: string; art: string; statCap: number; title: Loc; subtitle: Loc; races: CareerRaceDef[] }
export interface CareerConfig { enabled: boolean; sessionTtlMs: number; maxInputs: number; startsPerDay: number; keepSessions: number }
export interface CareerMaster { version: number; config: CareerConfig; chapters: CareerChapterDef[] }

export const BASE_CAREER = careerJson as unknown as CareerMaster;
export const careerOf = (m: Pick<Master, 'career'>): CareerMaster => m.career ?? BASE_CAREER;

/** The chapter illustrations Codex draws (docs/handoff-codex-round22-career.md). */
export const CAREER_ARTS = ['dawn', 'rain', 'night', 'north', 'summit', 'coast', 'snow', 'derby'] as const;
/** Items a career reward may carry (no tickets, no random items, nothing sold for paid coins). */
export const CAREER_REWARD_ITEMS = ['breeding_material', 'training_apple'] as const;

/**
 * Code ceilings no master can exceed (景表法: ≤ ¥200 a grant; economy E20: the whole career's lifetime grants). E1 is
 * tight (docs/spec/balance-targets.md 4.20): coins here move the free player's pulls, items do not.
 */
export const CAREER_HARD_LIMITS = {
  chapters: 10, racesMin: 3, racesMax: 5, starsPerRace: 3,
  freeCoinsPerGrant: 100, itemQtyPerGrant: 2, maxRewardYen: 200,
  lifetimeFreeCoins: 300, lifetimeMaterial: 40, lifetimeApples: 60,
  startsPerDay: 500, keepSessions: 50, maxInputs: 4000,
  titleJa: 16, titleEn: 32, storyJa: 80, storyEn: 200,
} as const;

const int = z.number().int();
const idRe = /^[a-z0-9_]{2,40}$/;
const loc = z.object({ ja: z.string(), en: z.string() }).strict();
const objectiveSchema = z.object({
  maxPlace: int.min(1).max(12).optional(), maxWhips: int.min(0).max(20).optional(), maxTimeMs: int.min(10_000).max(600_000).optional(),
}).strict();
const rewardSchema = z.object({
  freeCoins: int.min(0).max(CAREER_HARD_LIMITS.freeCoinsPerGrant).optional(),
  items: z.array(z.object({ itemId: z.enum(CAREER_REWARD_ITEMS), qty: int.min(1).max(CAREER_HARD_LIMITS.itemQtyPerGrant) }).strict()).max(2).optional(),
}).strict();
const raceSchema = z.object({
  id: z.string().regex(idRe), title: loc, trackId: z.string().regex(idRe), going: goingSchema.optional(), night: z.boolean().optional(),
  cpuCount: int.min(1).max(11), cpuLevel: int.min(1).max(5), cpuStatPermille: int.min(500).max(1200).optional(),
  cpuStyles: z.array(styleSchema).min(1).max(4).optional(),
  story: z.object({ before: loc, after: loc }).strict(),
  clear: objectiveSchema, reward: rewardSchema,
  stars: z.array(z.object({ objective: objectiveSchema, reward: rewardSchema.optional() }).strict()).max(CAREER_HARD_LIMITS.starsPerRace - 1),
}).strict();
export const careerMasterSchema = z.object({
  _note: z.string().optional(),
  version: int.min(1),
  config: z.object({
    enabled: z.boolean(), sessionTtlMs: int.min(60_000).max(3_600_000), maxInputs: int.min(50).max(CAREER_HARD_LIMITS.maxInputs),
    startsPerDay: int.min(20).max(CAREER_HARD_LIMITS.startsPerDay), keepSessions: int.min(1).max(CAREER_HARD_LIMITS.keepSessions),
  }).strict(),
  chapters: z.array(z.object({
    id: z.string().regex(idRe), art: z.enum(CAREER_ARTS), statCap: int.min(500).max(10_000), title: loc, subtitle: loc,
    races: z.array(raceSchema).min(CAREER_HARD_LIMITS.racesMin).max(CAREER_HARD_LIMITS.racesMax),
  }).strict()).min(1).max(CAREER_HARD_LIMITS.chapters),
}).strict();

const JP_RE = /[぀-ヿ㐀-鿿・]/;
const hasCond = (o: CareerObjective) => o.maxPlace !== undefined || o.maxWhips !== undefined || o.maxTimeMs !== undefined;

/** The partner template every player is given (progression.partner) — the reference horse of the fairness rule. */
function partnerTemplate(m: Pick<Master, 'progression' | 'templateById'>) {
  const id = (m.progression as { partner?: { templateId?: string } }).partner?.templateId;
  return id ? m.templateById.get(id) ?? null : null;
}

/** Lifetime totals of a career master (E20). */
export function careerTotals(c: CareerMaster) {
  const t = { races: 0, stars: 0, freeCoins: 0, material: 0, apples: 0, grants: 0 };
  const add = (r: Reward | undefined) => {
    if (!r) return;
    t.grants++;
    t.freeCoins += r.freeCoins ?? 0;
    for (const it of r.items ?? []) { if (it.itemId === 'breeding_material') t.material += it.qty; if (it.itemId === 'training_apple') t.apples += it.qty; }
  };
  for (const ch of c.chapters) for (const r of ch.races) { t.races++; t.stars += 1 + r.stars.length; add(r.reward); for (const st of r.stars) add(st.reward); }
  return t;
}

/**
 * REQ-CAREER-002/010/011: everything wrong with a career master against the resolved master (empty = fine). Shape, unique
 * ids, courses that exist with a going of their surface and night only at lit venues, a field the partner fits (surface and
 * distance, so every player owns a horse for every race), chapter caps no higher than the partner's stat total, a CPU style
 * pool large enough for the field, objectives that mean something inside the field, texts in both languages within their
 * lengths with no shop / betting words, and rewards inside the per-grant (¥200) and lifetime (E20) ceilings.
 */
export function careerProblems(m: Pick<Master, 'progression' | 'tracks' | 'templateById' | 'templates' | 'litTracks' | 'products'>, c: unknown = careerOf(m as Master)): string[] {
  const r = careerMasterSchema.safeParse(c);
  if (!r.success) return r.error.issues.map((i) => `career.${i.path.join('.')}: ${i.message}`);
  const cm = r.data as CareerMaster;
  const H = CAREER_HARD_LIMITS;
  const out: string[] = [];
  const partner = partnerTemplate(m);
  if (!partner) out.push('career: the partner template (progression.partner) is missing');
  const partnerTotal = partner ? STAT_KEYS.reduce((a, k) => a + partner.stats[k], 0) : 0;
  const yen = worstYenPerCoin(m);
  const ids = new Set<string>();
  const text = (at: string, l: Loc, jaMax: number, enMax: number) => {
    if (!l.ja.trim() || [...l.ja].length > jaMax) out.push(`${at}.ja: 1..${jaMax} characters`);
    if (!l.en.trim() || [...l.en].length > enMax) out.push(`${at}.en: 1..${enMax} characters`);
    if (JP_RE.test(l.en)) out.push(`${at}.en contains Japanese`);
    if (/[\u0000-\u001f\u007f]/.test(l.ja + l.en)) out.push(`${at}: control characters`);
    out.push(...wordingProblems(at, l.ja, l.en));
  };
  const reward = (at: string, rw: Reward) => {
    const coins = rw.freeCoins ?? 0;
    if (Math.round(coins * yen) > H.maxRewardYen) out.push(`${at}.freeCoins: ${coins} coins ≈ ¥${Math.round(coins * yen)} exceeds the ¥${H.maxRewardYen} premium ceiling`);
    if (!coins && !(rw.items ?? []).length) out.push(`${at}: needs free coins or an item`);
    const seen = new Set<string>();
    for (const it of rw.items ?? []) { if (seen.has(it.itemId)) out.push(`${at}.items: ${it.itemId} twice`); seen.add(it.itemId); }
  };
  const objective = (at: string, o: CareerObjective, field: number) => {
    if (!hasCond(o)) out.push(`${at}: needs at least one condition`);
    if (o.maxPlace !== undefined && o.maxPlace >= field) out.push(`${at}.maxPlace: must be smaller than the field (${field} runners), or it only means finishing`);
  };
  for (const ch of cm.chapters) {
    const cp = `career.${ch.id}`;
    if (ids.has(ch.id)) out.push(`${cp}: duplicate id`);
    ids.add(ch.id);
    text(`${cp}.title`, ch.title, H.titleJa, H.titleEn);
    text(`${cp}.subtitle`, ch.subtitle, H.titleJa * 2, H.titleEn * 2);
    if (partner && ch.statCap > partnerTotal) out.push(`${cp}.statCap: ${ch.statCap} is above the partner's stat total ${partnerTotal} (the free partner must reach every chapter's cap)`);
    for (const race of ch.races) {
      const rp = `${cp}.${race.id}`;
      if (ids.has(race.id)) out.push(`${rp}: duplicate id`);
      ids.add(race.id);
      text(`${rp}.title`, race.title, H.titleJa, H.titleEn);
      text(`${rp}.story.before`, race.story.before, H.storyJa, H.storyEn);
      text(`${rp}.story.after`, race.story.after, H.storyJa, H.storyEn);
      const track = m.tracks.find((t) => t.id === race.trackId);
      if (!track) { out.push(`${rp}.trackId: unknown course ${race.trackId}`); continue; }
      if (race.going && !(goingsFor(track.surface) as readonly string[]).includes(race.going)) out.push(`${rp}.going: ${race.going} is not a ${track.surface} going`);
      if (race.night && !m.litTracks.has(track.id)) out.push(`${rp}.night: ${track.id} has no floodlights`);
      if (partner && !((partner.surface === 'both' || partner.surface === track.surface) && partner.distMinM <= track.distanceM && track.distanceM <= partner.distMaxM)) {
        out.push(`${rp}.trackId: the partner horse does not fit ${track.id} (every player must own a horse for every race)`);
      }
      const pool = m.templates.filter((t) => !t.seasonal && !t.giftOnly && (!race.cpuStyles || race.cpuStyles.includes(t.style)));
      // +1: a CPU never carries the player's horse's name, so one template of the pool may drop out
      if (pool.length < race.cpuCount + 1) out.push(`${rp}.cpuStyles: only ${pool.length} CPU horses of ${race.cpuStyles?.join('/') ?? 'any style'} for ${race.cpuCount} places`);
      const field = race.cpuCount + 1;
      if (race.clear.maxPlace === undefined) out.push(`${rp}.clear: the clear objective is a finishing place (maxPlace)`);
      objective(`${rp}.clear`, race.clear, field);
      race.stars.forEach((st, i) => objective(`${rp}.stars[${i}]`, st.objective, field));
      reward(`${rp}.reward`, race.reward);
      race.stars.forEach((st, i) => { if (st.reward) reward(`${rp}.stars[${i}].reward`, st.reward); });
    }
  }
  const t = careerTotals(cm);
  if (t.freeCoins > H.lifetimeFreeCoins) out.push(`career: ${t.freeCoins} free coins over the whole career, at most ${H.lifetimeFreeCoins} (economy E20)`);
  if (t.material > H.lifetimeMaterial) out.push(`career: ${t.material} breeding material over the whole career, at most ${H.lifetimeMaterial} (economy E20)`);
  if (t.apples > H.lifetimeApples) out.push(`career: ${t.apples} training apples over the whole career, at most ${H.lifetimeApples} (economy E20)`);
  return out;
}

// ------------------------------------------------------------------------------------------------ state

export type CareerSessionStatus = 'issued' | 'submitted' | 'verified' | 'rejected';
export interface CareerSnapshot { clear: CareerObjective; reward: Reward; stars: CareerStarDef[] }
export interface CareerSession {
  id: string; raceId: string; chapterId: string; horseId: string; playerSlot: number;
  config: RaceStartConfig; issuedAt: number; expiresAt: number; status: CareerSessionStatus; result: CareerResult | null;
  /** The objectives and rewards shown at the start (a master edited mid-session never changes this run's rules). */
  snapshot: CareerSnapshot;
  /** The validated inputs while the run is being verified (prepare → record). */
  inputs?: [number, number, number][];
}
export interface CareerRaceProgress {
  attempts: number;
  clearedAt: number | null;
  /** Earned stars (1..3, ascending), kept across runs. */
  stars: number[];
  bestPlace: number | null;
  bestTimeMs: number | null;
  /** Rewards already paid: 'clear', 'star2', 'star3' (once ever, whatever the sessions). */
  granted: string[];
}
export interface CareerState { races: Record<string, CareerRaceProgress>; sessions: CareerSession[]; daily: { date: string; count: number } }

export const newCareerState = (): CareerState => ({ races: {}, sessions: [], daily: { date: '', count: 0 } });
export function careerState(s: PlayerState): CareerState {
  s.career ??= newCareerState();
  return s.career;
}
const newProgress = (): CareerRaceProgress => ({ attempts: 0, clearedAt: null, stars: [], bestPlace: null, bestTimeMs: null, granted: [] });

/** Races in play order with their chapter. */
function flat(cm: CareerMaster) {
  const out: { chapter: CareerChapterDef; race: CareerRaceDef; index: number }[] = [];
  for (const chapter of cm.chapters) for (const race of chapter.races) out.push({ chapter, race, index: out.length });
  return out;
}

/** REQ-CAREER-005: a race is open when it is the first, when the race before it is cleared, or when it was cleared itself. */
function unlockedAt(list: ReturnType<typeof flat>, st: CareerState | undefined, i: number): boolean {
  if (i === 0) return true;
  if (st?.races[list[i]!.race.id]?.clearedAt) return true;
  return !!st?.races[list[i - 1]!.race.id]?.clearedAt;
}

// ------------------------------------------------------------------------------------------------ view

/** The objective lines (Japanese; the response boundary translates them like the weekly challenge's, §23). */
const objectiveLabels = (o: CareerObjective) => conditionLabels(o);

function goingOf(m: Master, race: CareerRaceDef): Going {
  return race.going ?? (trackById(m, race.trackId).surface === 'dirt' ? 'fast' : 'good');
}

function raceCard(m: Master, chapter: CareerChapterDef, race: CareerRaceDef, lang: Locale) {
  const track = trackById(m, race.trackId);
  return {
    id: race.id, chapterId: chapter.id, title: pick(race.title, lang),
    story: { before: pick(race.story.before, lang), after: pick(race.story.after, lang) },
    trackId: track.id, surface: track.surface, distanceM: track.distanceM, going: goingOf(m, race), night: race.night ?? false,
    fieldSize: race.cpuCount + 1, cpuCount: race.cpuCount, cpuLevel: race.cpuLevel, cpuStatPermille: race.cpuStatPermille ?? 1000, cpuStyles: race.cpuStyles ?? null,
    statCap: chapter.statCap,
    objectives: [
      { star: 1, objective: race.clear, labels: objectiveLabels(race.clear), reward: race.reward },
      ...race.stars.map((st, i) => ({ star: i + 2, objective: st.objective, labels: objectiveLabels(st.objective), reward: st.reward ?? null })),
    ],
  };
}

/** REQ-CAREER-003: GET /v1/career — every chapter and race with its story, objectives, rewards and my progress. */
export function careerView(m: Master, s: PlayerState, now: number, lang: Locale = 'ja') {
  const cm = careerOf(m);
  if (!cm.config.enabled) return { enabled: false as const };
  const st = s.career;
  const list = flat(cm);
  let totalStars = 0, maxStars = 0, clearedRaces = 0;
  const today = gameDayKey(now, dayRule(m));
  const used = st && sameGameDay(st.daily.date, today) ? st.daily.count : 0;
  let next: string | null = null;
  const chapters = cm.chapters.map((chapter) => {
    let chStars = 0, chMax = 0, chCleared = 0;
    const races = chapter.races.map((race) => {
      const i = list.findIndex((x) => x.race.id === race.id);
      const p = st?.races[race.id] ?? newProgress();
      const unlocked = unlockedAt(list, st, i);
      const stars = p.stars.filter((x) => x <= 1 + race.stars.length);
      chStars += stars.length; chMax += 1 + race.stars.length;
      if (p.clearedAt) chCleared++;
      if (unlocked && !p.clearedAt && next === null) next = race.id;
      return {
        ...raceCard(m, chapter, race, lang),
        progress: {
          unlocked, cleared: !!p.clearedAt, clearedAt: p.clearedAt, stars, attempts: p.attempts, bestPlace: p.bestPlace, bestTimeMs: p.bestTimeMs,
          rewarded: { clear: p.granted.includes('clear'), star2: p.granted.includes('star2'), star3: p.granted.includes('star3') },
        },
      };
    });
    totalStars += chStars; maxStars += chMax; clearedRaces += chCleared;
    return {
      id: chapter.id, art: chapter.art, title: pick(chapter.title, lang), subtitle: pick(chapter.subtitle, lang), statCap: chapter.statCap,
      unlocked: races[0]!.progress.unlocked, cleared: chCleared === races.length, stars: chStars, maxStars: chMax, clearedRaces: chCleared, races,
    };
  });
  return {
    enabled: true as const, version: cm.version,
    chapters, totalStars, maxStars, clearedRaces, totalRaces: list.length,
    /** The first open race not yet cleared (the map's "next" marker), null when everything is cleared. */
    nextRaceId: next,
    startsLeftToday: Math.max(0, cm.config.startsPerDay - used),
    rules: { skills: false, normalized: true, ranked: false, leaderboards: false, missions: false, energy: false, paidContinue: false, paidSkip: false, rewardOnce: true },
  };
}

// ------------------------------------------------------------------------------------------------ start / submit

function enabledOrThrow(m: Master): CareerMaster {
  const cm = careerOf(m);
  if (!cm.config.enabled) throw new AppError('NOT_FOUND', '騎手の道 is not available');
  return cm;
}

/** REQ-CAREER-004/005/006: issue a session for an open race (config fixed by the server). */
export function startCareerRace(m: Master, s: PlayerState, raceId: string, horseId: string, sessionId: string, rng: Rng, now: number, emit: Emit, baseRuleset?: Ruleset, lang: Locale = 'ja') {
  const cm = enabledOrThrow(m);
  const list = flat(cm);
  const i = list.findIndex((x) => x.race.id === raceId);
  if (i < 0) throw new AppError('NOT_FOUND', `career race ${raceId}`);
  const { chapter, race } = list[i]!;
  const st = careerState(s);
  if (!unlockedAt(list, st, i)) throw new AppError('CAREER_LOCKED', 'clear the previous race first');
  const h = getHorse(s, horseId);
  if (h.status !== 'active') throw new AppError('HORSE_NOT_ACTIVE');
  const today = gameDayKey(now, dayRule(m));
  if (!sameGameDay(st.daily.date, today)) st.daily = { date: today, count: 0 };
  if (st.daily.count >= cm.config.startsPerDay) throw new AppError('CAREER_LIMIT_REACHED', `${cm.config.startsPerDay}/day`);
  st.daily.count++;
  const config = buildRaceConfig(m, {
    raceId: `car_${sessionId}`, mode: 'challenge', trackId: race.trackId, cpuCount: race.cpuCount, cpuLevel: race.cpuLevel, statCap: chapter.statCap, rng,
    cpuStatPermille: race.cpuStatPermille, ...(race.cpuStyles ? { cpuStyles: race.cpuStyles } : {}),
    ground: race.going !== undefined || race.night ? { going: goingOf(m, race), night: race.night ?? false } : null,
    // the active ruleset with the day's form off, embedded in the session (a ruleset change mid-session never affects it)
    rulesetOverrides: timeAttackRuleset(baseRuleset),
    humans: [{ playerId: s.id, horse: toRaceHorse(m, h) }],
  });
  const playerSlot = config.entrants.findIndex((e) => e.kind === 'human');
  const p = (st.races[race.id] ??= newProgress());
  p.attempts++;
  const session: CareerSession = {
    id: sessionId, raceId: race.id, chapterId: chapter.id, horseId, playerSlot, config, issuedAt: now, expiresAt: now + cm.config.sessionTtlMs,
    status: 'issued', result: null, snapshot: { clear: race.clear, reward: race.reward, stars: race.stars },
  };
  st.sessions.push(session);
  if (st.sessions.length > cm.config.keepSessions) st.sessions.splice(0, st.sessions.length - cm.config.keepSessions);
  emit({ name: 'career_start', s1: race.id, s2: chapter.id, count: p.attempts });
  return {
    sessionId, raceId: race.id, chapterId: chapter.id, playerSlot, config, expiresAt: session.expiresAt,
    startsLeftToday: cm.config.startsPerDay - st.daily.count, race: raceCard(m, chapter, race, lang),
    /** The clear objective in the weekly challenge shape (C# ChallengeRun / the HUD). */
    conditions: race.clear,
  };
}

function findSession(s: PlayerState, sessionId: string): CareerSession {
  const x = s.career?.sessions.find((q) => q.id === sessionId);
  if (!x) throw new AppError('NOT_FOUND', `session ${sessionId}`);
  return x;
}

export type CareerPrepare = { kind: 'verify'; log: ReplayLog } | { kind: 'done'; result: CareerResult };

/** REQ-CAREER-007: one submission per session; the replay log is built from the ISSUED config. A retry returns the stored result. */
export function prepareCareerSubmit(m: Master, s: PlayerState, sessionId: string, inputs: unknown, resultHash: string, echoedConfig: unknown, now: number): CareerPrepare {
  const cm = careerOf(m);
  const x = findSession(s, sessionId);
  if (x.status === 'verified' && x.result && x.result.resultHash === resultHash) return { kind: 'done', result: x.result };
  if (x.status !== 'issued') throw new AppError('CAREER_SESSION_USED');
  if (now > x.expiresAt) throw new AppError('CAREER_SESSION_EXPIRED');
  if (echoedConfig !== undefined && echoedConfig !== null && !jsonEqual(echoedConfig, x.config)) throw new AppError('TA_CONFIG_MISMATCH', 'the config differs from the issued one');
  const ins = validateChallengeInputs(x.config, x.playerSlot, inputs, cm.config.maxInputs);
  x.status = 'submitted';
  x.inputs = ins; // what the verifier re-simulates is what the whip objectives count
  return { kind: 'verify', log: { v: 1, config: x.config, endTick: -1, inputs: ins } };
}

/** The verifier could not be reached: the run may be submitted again (until the session expires). */
export function abortCareerSubmit(s: PlayerState, sessionId: string) {
  const x = findSession(s, sessionId);
  if (x.status === 'submitted') x.status = 'issued';
  return { sessionId, status: x.status };
}

export interface CareerStarResult { star: number; ok: boolean; newly: boolean; evaluation: ChallengeEvaluation }
export interface CareerGrant { kind: 'clear' | 'star2' | 'star3'; reward: Reward }
export interface CareerResult {
  sessionId: string; raceId: string; chapterId: string; resultHash: string;
  /** The clear objective's evaluation (place / time / whips of the run). */
  evaluation: ChallengeEvaluation;
  cleared: boolean; firstClear: boolean;
  /** One entry per objective of the race (star 1 = the clear). */
  objectives: CareerStarResult[];
  /** Stars of the race after this run (kept across runs). */
  stars: number[];
  newStars: number[];
  /** Rewards paid by this run (first clear and new stars, once ever). */
  rewards: CareerGrant[];
  /** The race this first clear opened (null when none). */
  unlockedRaceId: string | null;
  /** True when this first clear finished the chapter. */
  chapterCleared: boolean;
  totalStars: number;
}

/**
 * REQ-CAREER-007/008/009: apply the verifier's re-simulation. A hash that differs from the client's is rejected (nothing
 * recorded). The objectives are evaluated here from the verified result and the validated inputs; the first clear and each
 * new star pay their reward once ever (the `granted` marks). The objectives and rewards are the session's snapshot.
 */
export function recordCareerResult(m: Master, s: PlayerState, sessionId: string, out: VerifierOutput, claimedHash: string, now: number, emit: Emit): CareerResult | { rejected: true; sessionId: string } {
  const cm = careerOf(m);
  const x = findSession(s, sessionId);
  if (x.status === 'verified' && x.result) return x.result;
  if (x.status !== 'submitted') throw new AppError('CAREER_SESSION_USED');
  if (out.resultHash !== claimedHash) { x.status = 'rejected'; delete x.inputs; return { rejected: true, sessionId }; }
  const st = careerState(s);
  const inputs = x.inputs ?? [];
  delete x.inputs;
  const snap = x.snapshot;
  const evaluation = evaluateChallenge(snap.clear, x.config, x.playerSlot, inputs, out);
  const cleared = evaluation.cleared;
  const objectives: CareerStarResult[] = [{ star: 1, ok: cleared, newly: false, evaluation }];
  snap.stars.forEach((sd, i) => {
    const ev = evaluateChallenge(sd.objective, x.config, x.playerSlot, inputs, out);
    objectives.push({ star: i + 2, ok: cleared && ev.cleared, newly: false, evaluation: ev });
  });
  const p = (st.races[x.raceId] ??= newProgress());
  if (evaluation.finished && (p.bestPlace === null || evaluation.place! < p.bestPlace || (evaluation.place === p.bestPlace && evaluation.timeMs! < (p.bestTimeMs ?? Infinity)))) {
    p.bestPlace = evaluation.place; p.bestTimeMs = evaluation.timeMs;
  }
  const firstClear = cleared && !p.clearedAt;
  if (firstClear) p.clearedAt = now;
  const newStars: number[] = [];
  for (const o of objectives) if (o.ok && !p.stars.includes(o.star)) { p.stars.push(o.star); o.newly = true; newStars.push(o.star); }
  p.stars.sort((a, b) => a - b);
  const rewards: CareerGrant[] = [];
  const pay = (kind: CareerGrant['kind'], rw: Reward | undefined) => {
    if (!rw || p.granted.includes(kind)) return;
    p.granted.push(kind);
    grantReward(s, rw, now, `騎手の道 ${x.raceId} ${kind}`, `career:${x.raceId}:${kind}`);
    rewards.push({ kind, reward: rw });
  };
  if (cleared) pay('clear', snap.reward);
  for (const o of objectives) if (o.ok && o.star >= 2) pay(o.star === 2 ? 'star2' : 'star3', snap.stars[o.star - 2]?.reward);
  const list = flat(cm);
  const i = list.findIndex((q) => q.race.id === x.raceId);
  const unlockedRaceId = firstClear && i >= 0 && i + 1 < list.length ? list[i + 1]!.race.id : null;
  const chapterCleared = firstClear && i >= 0 && list[i]!.chapter.races.every((r) => !!st.races[r.id]?.clearedAt);
  const totalStars = Object.values(st.races).reduce((a, q) => a + q.stars.length, 0);
  const freeCoins = rewards.reduce((a, g) => a + (g.reward.freeCoins ?? 0), 0);
  if (cleared) {
    emit({ name: 'career_clear', s1: x.raceId, s2: x.chapterId, place: evaluation.place ?? 0, durationMs: evaluation.timeMs ?? 0, isFirst: firstClear, count: p.stars.length, value: chapterCleared ? 1 : 0, freeCoins });
  }
  for (const star of newStars) emit({ name: 'career_star', s1: x.raceId, s2: x.chapterId, value: star, count: totalStars });
  const result: CareerResult = {
    sessionId, raceId: x.raceId, chapterId: x.chapterId, resultHash: out.resultHash, evaluation, cleared, firstClear, objectives,
    stars: [...p.stars], newStars, rewards, unlockedRaceId, chapterCleared, totalStars,
  };
  x.status = 'verified';
  x.result = result;
  return result;
}
