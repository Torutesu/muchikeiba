/**
 * 調教 (training) — a short daily loop that grows the player's own horses (REQ-TRAIN-001..014, contracts/protocol.md §22).
 *
 * Shape: a few training slots per game day for the whole account (not per horse, so owning more horses never means more
 * growth), a menu per session (坂路 / ウッド / プール / 併せ馬), and an optional timing mini-game that improves the result a
 * little. Everything is deterministic: the outcome is a pure function of the horse's state at the start (fatigue, bond,
 * what it has already grown), the menu, and the mini-game score, which the server recomputes from the submitted taps
 * against the beat schedule it issued (scoreTiming). The server RNG only picks the beat schedule and breaks ties in the
 * stat split — it never decides how much a horse grows.
 *
 * Ranked fairness (docs/planning/06 §1.3, REQ-RATE-003) — the decisions:
 * - Growth is a small permanent stat gain stored on the horse (`HorseInstance.trained`), bounded by the horse's potential
 *   (`potentialByRarity`: R > SR > SSR, so the horses a free player starts with have the most room) and a per-stat cap.
 *   It feeds races through toRaceHorse like awakening, so ranked, tournaments and time attack still go through the class
 *   normalisation (raceConfig.ts normalizeStats): a horse at the class cap gains nothing in ranked. Growth therefore only
 *   closes the distance to the cap, which is where a free player's horses are — it can narrow the paid/free gap, never
 *   widen it (economy E14, docs/spec/balance-targets.md 4.11).
 * - Nothing paid touches growth: no extra slots for sale, no paid item, no paid pass reward. The one training item
 *   (fatigue relief) comes from a daily mission only; trainingProblems refuses a config that puts a growth-affecting item in
 *   a product, the coin shop, the premium pass track, an event reward or a gacha banner. (The pass free track is not a
 *   source either: Pass+ sells pass levels, so a free-track item would become purchasable.)
 * - Fatigue / condition is a training-only resource: it lowers training efficiency and makes the horse rest, and NO race
 *   (ranked, friend, event, tournament, time attack) ever reads it. Fixed-stat events ignore growth entirely.
 * - Growth is the horse's own and is not inherited: breeding uses effectiveStats (base + awakening) only, so training
 *   never compounds over generations.
 * - Golden races and replays are unaffected: stats are config inputs, the ruleset and the engine do not change.
 *
 * Animal welfare (03-legal-risk.md 動物福祉): no injury, no pain; a tired horse simply rests (「休ませましょう」).
 */
import { z } from 'zod';
import { AppError } from './errors.js';
import { STAT_KEYS, type Master, type Rarity, type Stats } from './master.js';
import type { HorseInstance, PlayerState } from './player.js';
import { effectiveStats, getHorse } from './horses.js';
import { horseBondLevel } from './bond.js';
import { consumeItem } from './items.js';
import { seededRng, randInt, type Rng } from './rng.js';
import { dayRule, gameDayIndex, gameDayKey, sameGameDay } from './time.js';
import type { KpiEvent } from './kpi.js';

type Emit = (e: KpiEvent) => void;
type StatKey = keyof Stats;

export interface TrainingMenu {
  id: string;
  name: string;
  /** Whole stat points of one session before multipliers. */
  baseGain: number;
  /** Fatigue added (negative = recovery, プール). */
  fatigue: number;
  /** How the gain splits over the stats (integer weights). */
  weights: Partial<Record<StatKey, number>>;
  /** Multiplies the bond bonus (併せ馬 = 2: a horse you know well works with its partner). Default 1. */
  bondMultiplier?: number;
}
export interface TrainingTiming {
  beats: number;
  durationMs: number;
  /** No beat before this (time to get ready). */
  leadMs: number;
  /** No beat in the last tailMs. */
  tailMs: number;
  perfectMs: number;
  goodMs: number;
  perfectPoints: number;
  goodPoints: number;
  /** Points lost per tap that hit no beat (mashing does not pay). */
  strayPenalty: number;
  /** Gain bonus per point, in permille (max = beats × perfectPoints × this). */
  permillePerPoint: number;
  maxTaps: number;
  minTapGapMs: number;
}
export interface TrainingItemDef { itemId: string; name: string; fatigueRelief: number; affectsGrowth: boolean }
export interface TrainingConfig {
  enabled: boolean;
  /** Training sessions per game day for the account (any horse). */
  slotsPerDay: number;
  /** Sessions per horse per game day. */
  perHorsePerDay: number;
  /** How long a started session accepts its finish; later it is settled as skipped (score 0). */
  sessionTtlMs: number;
  /** Total stat points a horse can gain from training, by rarity. */
  potentialByRarity: Record<Rarity, number>;
  /** One stat may take at most this share (permille) of the potential. */
  perStatCapPermille: number;
  /** Growth slows as the horse fills its potential, down to this floor (permille). */
  softFloorPermille: number;
  fatigue: { max: number; recoveryPerDay: number; restAt: number; penaltyPermillePerPoint: number; minEfficiencyPermille: number };
  bond: { permillePerLevel: number; maxPermille: number };
  menus: TrainingMenu[];
  timing: TrainingTiming;
  items: TrainingItemDef[];
  /** Entries kept in a horse's training log (調教日誌). */
  logKeep: number;
}

export interface TrainingSession {
  id: string; horseId: string; menuId: string; seed: number; startedAt: number; expiresAt: number;
  fatigueBefore: number; bondLevel: number; beats: number[];
}
export interface HorseTrainingLog { at: number; menuId: string; grade: TrainingGrade; gain: number; score: number }
export interface HorseTraining {
  fatigue: number; fatigueDay: number; day: string; dayCount: number; sessions: number;
  /** Milli-points carried to the next session (deterministic rounding, no growth is lost to floors). */
  carry: number; log: HorseTrainingLog[];
}
export interface TrainingState { day: string; used: number; open: TrainingSession | null; horses: Record<string, HorseTraining>; total: number }
export type TrainingGrade = 'great' | 'good' | 'normal';

/** Code-side ceilings: a remote config can lower values but never go past these (economy E14). */
export const TRAINING_HARD_LIMITS = {
  slotsPerDay: 5, perHorsePerDay: 3, baseGain: 15, potential: 400, timingMaxPermille: 150, bondMaxPermille: 120, fatigueRelief: 50,
} as const;

const statWeights = z.object({ speed: z.number().int().min(0), stamina: z.number().int().min(0), burst: z.number().int().min(0), guts: z.number().int().min(0), temper: z.number().int().min(0) }).partial().strict();
export const trainingConfigSchema = z.object({
  _note: z.string().optional(),
  enabled: z.boolean(),
  slotsPerDay: z.number().int().min(1),
  perHorsePerDay: z.number().int().min(1),
  sessionTtlMs: z.number().int().min(60_000).max(3_600_000),
  potentialByRarity: z.object({ R: z.number().int().min(0), SR: z.number().int().min(0), SSR: z.number().int().min(0) }).strict(),
  perStatCapPermille: z.number().int().min(200).max(1000),
  softFloorPermille: z.number().int().min(0).max(1000),
  fatigue: z.object({
    max: z.number().int().min(1).max(1000), recoveryPerDay: z.number().int().min(1), restAt: z.number().int().min(1),
    penaltyPermillePerPoint: z.number().int().min(0).max(20), minEfficiencyPermille: z.number().int().min(100).max(1000),
  }).strict(),
  bond: z.object({ permillePerLevel: z.number().int().min(0), maxPermille: z.number().int().min(0) }).strict(),
  menus: z.array(z.object({
    id: z.string().regex(/^[a-z0-9_]{1,24}$/), name: z.string().min(1).max(16), baseGain: z.number().int().min(1),
    fatigue: z.number().int().min(-100).max(100), weights: statWeights, bondMultiplier: z.number().int().min(1).max(3).optional(),
  }).strict()).min(1).max(8),
  timing: z.object({
    beats: z.number().int().min(1).max(10), durationMs: z.number().int().min(2000).max(15_000), leadMs: z.number().int().min(300),
    tailMs: z.number().int().min(0), perfectMs: z.number().int().min(20), goodMs: z.number().int().min(40).max(400),
    perfectPoints: z.number().int().min(1), goodPoints: z.number().int().min(0), strayPenalty: z.number().int().min(0),
    permillePerPoint: z.number().int().min(0), maxTaps: z.number().int().min(1).max(40), minTapGapMs: z.number().int().min(30),
  }).strict(),
  items: z.array(z.object({ itemId: z.string().regex(/^[a-z0-9_]{1,40}$/), name: z.string().min(1).max(24), fatigueRelief: z.number().int().min(1), affectsGrowth: z.boolean() }).strict()).max(8),
  logKeep: z.number().int().min(0).max(30),
}).strict();

const maxScore = (t: TrainingTiming) => t.beats * t.perfectPoints;

/**
 * REQ-TRAIN-012: validation (boot and every remote-config version carrying progression.training). Besides the shape and
 * the ceilings, it checks where growth-affecting items may come from: never a purchase, the coin shop, the premium pass
 * track, an event reward or a gacha banner (ranked fairness: no paid boost).
 */
export function trainingProblems(m: Pick<Master, 'progression' | 'products' | 'items' | 'events' | 'gacha'>, path = 'progression.training'): string[] {
  const raw = (m.progression as { training?: unknown }).training;
  if (raw === undefined) return [];
  const r = trainingConfigSchema.safeParse(raw);
  if (!r.success) return r.error.issues.map((i) => `${path}.${i.path.join('.')}: ${i.message}`);
  const c = r.data as TrainingConfig;
  const H = TRAINING_HARD_LIMITS;
  const out: string[] = [];
  if (c.slotsPerDay > H.slotsPerDay) out.push(`${path}.slotsPerDay: at most ${H.slotsPerDay}`);
  if (c.perHorsePerDay > H.perHorsePerDay) out.push(`${path}.perHorsePerDay: at most ${H.perHorsePerDay}`);
  if (c.perHorsePerDay > c.slotsPerDay) out.push(`${path}.perHorsePerDay: must be ≤ slotsPerDay`);
  for (const [k, v] of Object.entries(c.potentialByRarity)) if (v > H.potential) out.push(`${path}.potentialByRarity.${k}: at most ${H.potential}`);
  // the free player's horses must never have less room than the payer's: R ≥ SR ≥ SSR
  if (!(c.potentialByRarity.R >= c.potentialByRarity.SR && c.potentialByRarity.SR >= c.potentialByRarity.SSR)) out.push(`${path}.potentialByRarity: must be R ≥ SR ≥ SSR (rarer horses never grow more)`);
  if (c.fatigue.restAt > c.fatigue.max) out.push(`${path}.fatigue.restAt: must be ≤ max`);
  if (c.bond.maxPermille > H.bondMaxPermille) out.push(`${path}.bond.maxPermille: at most ${H.bondMaxPermille}`);
  const ids = new Set<string>();
  for (const mn of c.menus) {
    if (ids.has(mn.id)) out.push(`${path}.menus: duplicate id ${mn.id}`);
    ids.add(mn.id);
    if (mn.baseGain > H.baseGain) out.push(`${path}.menus.${mn.id}.baseGain: at most ${H.baseGain}`);
    if (Object.values(mn.weights).reduce((a, n) => a + (n ?? 0), 0) <= 0) out.push(`${path}.menus.${mn.id}.weights: need at least one positive weight`);
  }
  const t = c.timing;
  if (maxScore(t) * t.permillePerPoint > H.timingMaxPermille) out.push(`${path}.timing: the mini-game bonus may be at most ${H.timingMaxPermille}‰ (slight improvement only)`);
  if (t.perfectMs >= t.goodMs) out.push(`${path}.timing.perfectMs: must be < goodMs`);
  if (t.goodPoints > t.perfectPoints) out.push(`${path}.timing.goodPoints: must be ≤ perfectPoints`);
  if (t.leadMs + t.tailMs >= t.durationMs) out.push(`${path}.timing: leadMs + tailMs must leave room for the beats`);
  if ((t.durationMs - t.leadMs - t.tailMs) / t.beats < 2 * t.goodMs) out.push(`${path}.timing: beats are too close to tell apart (segment < 2 × goodMs)`);
  if (t.maxTaps < t.beats) out.push(`${path}.timing.maxTaps: must be ≥ beats`);
  const itemIds = new Set<string>();
  for (const it of c.items) {
    if (itemIds.has(it.itemId)) out.push(`${path}.items: duplicate ${it.itemId}`);
    itemIds.add(it.itemId);
    if (it.fatigueRelief > H.fatigueRelief) out.push(`${path}.items.${it.itemId}.fatigueRelief: at most ${H.fatigueRelief}`);
    if (m.items.tickets[it.itemId] || m.items.breedingMaterial.itemId === it.itemId || m.items.cosmetics.some((x) => x.id === it.itemId)) out.push(`${path}.items.${it.itemId}: id collides with a ticket/material/cosmetic`);
  }
  // REQ-TRAIN-010: paid / random sources of growth-affecting items are refused
  const growth = new Set(c.items.filter((x) => x.affectsGrowth).map((x) => x.itemId));
  const mentions = (x: unknown): string[] => {
    const found: string[] = [];
    const walk = (v: unknown) => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') for (const [k, val] of Object.entries(v)) { if (k === 'itemId' && typeof val === 'string' && growth.has(val)) found.push(val); else walk(val); }
    };
    walk(x);
    return found;
  };
  for (const p of m.products) for (const id of mentions(p)) out.push(`${path}: ${id} affects growth and cannot be sold (product ${p.id})`);
  for (const id of mentions(m.progression.passRewards?.premium)) out.push(`${path}: ${id} affects growth and cannot be a premium pass reward`);
  for (const id of mentions(m.progression.passRewards?.free)) out.push(`${path}: ${id} affects growth and cannot be a pass reward (Pass+ sells levels)`);
  for (const id of mentions(m.events)) out.push(`${path}: ${id} affects growth and cannot be an event reward`);
  for (const id of mentions(m.gacha)) out.push(`${path}: ${id} affects growth and cannot come from a gacha`);
  for (const id of growth) if (m.items.cosmetics.some((x) => x.id === id)) out.push(`${path}: ${id} affects growth and cannot be sold in the shop`);
  return out;
}

export function trainingConfig(m: Master): TrainingConfig | null {
  const c = m.progression.training;
  return c && c.enabled ? c : null;
}
function requireConfig(m: Master): TrainingConfig {
  const c = trainingConfig(m);
  if (!c) throw new AppError('NOT_FOUND', 'training is not available');
  return c;
}

export function ensureTraining(s: PlayerState): TrainingState {
  s.training ??= { day: '', used: 0, open: null, horses: {}, total: 0 };
  return s.training;
}

const zeroStats = (): Stats => ({ speed: 0, stamina: 0, burst: 0, guts: 0, temper: 0 });
export const trainedTotal = (h: Pick<HorseInstance, 'trained'>) => (h.trained ? STAT_KEYS.reduce((a, k) => a + (h.trained![k] ?? 0), 0) : 0);
export const potentialOf = (c: TrainingConfig, h: Pick<HorseInstance, 'rarity'>) => c.potentialByRarity[h.rarity] ?? 0;
export const perStatCap = (c: TrainingConfig, h: Pick<HorseInstance, 'rarity'>) => Math.floor((potentialOf(c, h) * c.perStatCapPermille) / 1000);

/**
 * REQ-TRAIN-003: the stats a horse races with = base + awakening (effectiveStats) + training growth, each ≤ 1000. Ranked,
 * tournaments and time attack then normalise the total to the class cap (raceConfig.ts), exactly as before.
 */
export function raceStats(m: Master, h: HorseInstance): Stats {
  const e = effectiveStats(m, h);
  if (!h.trained) return e;
  const out = {} as Stats;
  for (const k of STAT_KEYS) out[k] = Math.min(1000, e[k] + Math.max(0, h.trained[k] ?? 0));
  return out;
}

function horseRec(t: TrainingState, horseId: string): HorseTraining {
  return (t.horses[horseId] ??= { fatigue: 0, fatigueDay: 0, day: '', dayCount: 0, sessions: 0, carry: 0, log: [] });
}

/** Fatigue now: what was stored minus the recovery of every game day since (lazy, no alarm needed). */
export function fatigueNow(m: Master, c: TrainingConfig, rec: HorseTraining | undefined, now: number): number {
  if (!rec) return 0;
  const days = Math.max(0, gameDayIndex(now, dayRule(m)) - rec.fatigueDay);
  return Math.max(0, rec.fatigue - days * c.fatigue.recoveryPerDay);
}
function setFatigue(m: Master, c: TrainingConfig, rec: HorseTraining, value: number, now: number) {
  rec.fatigue = Math.max(0, Math.min(c.fatigue.max, value));
  rec.fatigueDay = gameDayIndex(now, dayRule(m));
}

export type Condition = 'fresh' | 'normal' | 'tired';
export function conditionOf(c: TrainingConfig, fatigue: number): Condition {
  return fatigue >= c.fatigue.restAt ? 'tired' : fatigue >= Math.floor(c.fatigue.restAt / 2) ? 'normal' : 'fresh';
}

/** REQ-TRAIN-005: the beat schedule of a session (ms after the mini-game starts), from its seed. One beat per segment. */
export function beatSchedule(t: TrainingTiming, seed: number): number[] {
  const rng = seededRng(seed);
  const seg = Math.floor((t.durationMs - t.leadMs - t.tailMs) / t.beats);
  const jitter = Math.max(1, Math.floor(seg / 2));
  return Array.from({ length: t.beats }, (_, i) => t.leadMs + i * seg + randInt(rng, jitter));
}

export interface TimingScore { perfect: number; good: number; miss: number; stray: number; score: number; bonusPermille: number }

/**
 * REQ-TRAIN-006: the deterministic scorer (the client's TrainingModel runs the same steps for its preview). Beats in order;
 * each takes the closest unused tap within goodMs (ties → the earlier tap). Taps that hit no beat cost `strayPenalty`.
 */
export function scoreTiming(t: TrainingTiming, beats: number[], taps: number[]): TimingScore {
  const used = new Array<boolean>(taps.length).fill(false);
  let perfect = 0, good = 0, miss = 0;
  for (const b of beats) {
    let best = -1, bestD = Infinity;
    for (let j = 0; j < taps.length; j++) {
      if (used[j]) continue;
      const d = Math.abs(taps[j]! - b);
      if (d <= t.goodMs && d < bestD) { best = j; bestD = d; }
    }
    if (best < 0) { miss++; continue; }
    used[best] = true;
    if (bestD <= t.perfectMs) perfect++; else good++;
  }
  const stray = taps.length - perfect - good;
  const score = Math.max(0, Math.min(maxScore(t), perfect * t.perfectPoints + good * t.goodPoints - stray * t.strayPenalty));
  return { perfect, good, miss, stray, score, bonusPermille: score * t.permillePerPoint };
}

/** REQ-TRAIN-007: bounds on submitted taps. `elapsedMs` = server time since the session started. */
export function validateTaps(t: TrainingTiming, beats: number[], taps: unknown, elapsedMs: number): number[] {
  if (!Array.isArray(taps)) throw new AppError('BAD_REQUEST', 'taps must be an array');
  if (taps.length > t.maxTaps) throw new AppError('TRAINING_INPUT_INVALID', `at most ${t.maxTaps} taps`);
  let prev = -Infinity;
  for (const x of taps) {
    if (typeof x !== 'number' || !Number.isInteger(x) || x < 0 || x > t.durationMs) throw new AppError('TRAINING_INPUT_INVALID', 'tap times are integers within the mini-game');
    if (x - prev < t.minTapGapMs) throw new AppError('TRAINING_INPUT_INVALID', `taps must increase by at least ${t.minTapGapMs} ms`);
    prev = x;
  }
  // a tap cannot be later than the time that has really passed since the session started (no instant perfect runs),
  // and a scoring run cannot end before its last beat could be hit
  if (taps.length > 0) {
    const last = taps[taps.length - 1] as number;
    if (elapsedMs < last) throw new AppError('TRAINING_INPUT_INVALID', 'finished faster than the taps say');
    if (elapsedMs < beats[beats.length - 1]! - t.goodMs) throw new AppError('TRAINING_INPUT_INVALID', 'finished before the last beat');
  }
  return taps as number[];
}

export interface GainBreakdown {
  efficiencyPermille: number; bondPermille: number; timingPermille: number; softPermille: number;
  milli: number; whole: number; carry: number; stats: Stats; capped: boolean;
}

/** REQ-TRAIN-004: how much a session gives (pure; the preview and the real finish call the same function). */
export function computeGain(c: TrainingConfig, h: Pick<HorseInstance, 'rarity' | 'trained'>, base: Stats, menu: TrainingMenu,
  input: { fatigueBefore: number; bondLevel: number; timingPermille: number; carry: number; seed: number }): GainBreakdown {
  const pot = potentialOf(c, h);
  const done = trainedTotal(h);
  const room = Math.max(0, pot - done);
  const efficiencyPermille = Math.max(c.fatigue.minEfficiencyPermille, 1000 - input.fatigueBefore * c.fatigue.penaltyPermillePerPoint);
  const mul = menu.bondMultiplier ?? 1;
  const bondPermille = Math.min(c.bond.maxPermille * mul, Math.max(0, input.bondLevel - 1) * c.bond.permillePerLevel * mul);
  const softPermille = pot > 0 ? Math.max(c.softFloorPermille, Math.floor((1000 * room) / pot)) : 0;
  const milli = room > 0 ? Math.floor((menu.baseGain * (efficiencyPermille + bondPermille + input.timingPermille) * softPermille) / 1000) : 0;
  let whole = Math.floor((input.carry + milli) / 1000);
  let carry = (input.carry + milli) % 1000;
  let capped = false;
  if (whole >= room) { whole = room; carry = 0; capped = room > 0; }
  const stats = splitGain(c, h, base, menu, whole, input.seed);
  const given = STAT_KEYS.reduce((a, k) => a + stats[k], 0);
  if (given < whole) { whole = given; carry = 0; capped = true; } // every target stat is full
  return { efficiencyPermille, bondPermille, timingPermille: input.timingPermille, softPermille, milli, whole, carry, stats, capped };
}

/** Largest-remainder split over the menu weights; ties broken by the session seed; per-stat cap and the 1000 ceiling respected. */
function splitGain(c: TrainingConfig, h: Pick<HorseInstance, 'rarity' | 'trained'>, base: Stats, menu: TrainingMenu, whole: number, seed: number): Stats {
  const out = zeroStats();
  if (whole <= 0) return out;
  const keys = STAT_KEYS.filter((k) => (menu.weights[k] ?? 0) > 0);
  const W = keys.reduce((a, k) => a + menu.weights[k]!, 0);
  const rng: Rng = seededRng(seed ^ 0x5bd1e995);
  const order = keys.map((k) => ({ k, share: whole * menu.weights[k]!, tie: rng.nextU32() }));
  for (const o of order) out[o.k] = Math.floor(o.share / W);
  let left = whole - keys.reduce((a, k) => a + out[k], 0);
  order.sort((a, b) => (b.share % W) - (a.share % W) || b.tie - a.tie);
  for (let i = 0; left > 0 && i < order.length; i++, left--) out[order[i]!.k] += 1;
  // caps: what a stat cannot take moves to the next stat of the menu that has room; else it is not given
  const cap = perStatCap(c, h);
  const room = (k: StatKey) => Math.max(0, Math.min(cap - (h.trained?.[k] ?? 0), 1000 - base[k] - (h.trained?.[k] ?? 0)));
  let overflow = 0;
  for (const k of keys) { const r = room(k); if (out[k] > r) { overflow += out[k] - r; out[k] = r; } }
  for (const o of order) {
    if (overflow <= 0) break;
    const add = Math.min(overflow, room(o.k) - out[o.k]);
    if (add > 0) { out[o.k] += add; overflow -= add; }
  }
  return out;
}

export function gradeOf(c: TrainingConfig, score: number, skipped: boolean): TrainingGrade {
  if (skipped) return 'normal';
  const max = maxScore(c.timing);
  return score * 10 >= max * 9 ? 'great' : score * 2 >= max ? 'good' : 'normal';
}

function slotsToday(m: Master, t: TrainingState, now: number) {
  const today = gameDayKey(now, dayRule(m));
  if (!sameGameDay(t.day, today)) { t.day = today; t.used = 0; }
  return today;
}

/** Why a horse cannot start this menu now (null = it can). */
function blockReason(m: Master, c: TrainingConfig, s: PlayerState, h: HorseInstance, menu: TrainingMenu | null, now: number): string | null {
  const t = s.training;
  const today = gameDayKey(now, dayRule(m));
  const used = t && sameGameDay(t.day, today) ? t.used : 0;
  if (h.status !== 'active') return 'retired';
  if (used >= c.slotsPerDay) return 'no_slots';
  const rec = t?.horses[h.id];
  if (rec && sameGameDay(rec.day, today) && rec.dayCount >= c.perHorsePerDay) return 'horse_daily_limit';
  if (trainedTotal(h) >= potentialOf(c, h)) return 'potential_full';
  if (menu && menu.fatigue > 0 && fatigueNow(m, c, rec, now) >= c.fatigue.restAt) return 'tired';
  return null;
}

/** REQ-TRAIN-002: expired open session → settled as skipped (score 0). Returns the settled result, if any. */
function settleExpired(m: Master, s: PlayerState, now: number, emit: Emit) {
  const t = s.training;
  if (!t?.open || now <= t.open.expiresAt) return null;
  return settle(m, requireConfig(m), s, t.open, [], 'expired', now, emit);
}

/** GET /v1/training: everything the screen needs (config, every active horse, the open session, the rules). */
export function trainingView(m: Master, s: PlayerState, now: number) {
  const c = trainingConfig(m);
  if (!c) return { enabled: false as const };
  return {
    ...trainingCounts(m, c, s, now),
    menus: c.menus.map((x) => ({ id: x.id, name: x.name, baseGain: x.baseGain, fatigue: x.fatigue, weights: x.weights, bondMultiplier: x.bondMultiplier ?? 1 })),
    timing: { ...c.timing, maxScore: maxScore(c.timing) },
    fatigue: { max: c.fatigue.max, restAt: c.fatigue.restAt, recoveryPerDay: c.fatigue.recoveryPerDay },
    partial: false,
    horses: s.horses.filter((h) => h.status === 'active').map((h) => horseView(m, c, s, h, now)),
    // REQ-TRAIN-003/009: stated so the UI can say it plainly
    rules: { rankedNormalized: true, fatigueAffectsRaces: false, inherited: false, paidBoosts: false },
  };
}

/**
 * The `training` of the start / finish / item responses: what an action changes (counts, items, the open session) and the
 * one horse concerned, with `partial: true`. The client merges it into the full view it has. Kept small on purpose: the
 * response is also stored as the idempotency record in the player's state.
 */
export function trainingDelta(m: Master, s: PlayerState, now: number, horseId: string) {
  const c = requireConfig(m);
  const h = s.horses.find((x) => x.id === horseId);
  return { ...trainingCounts(m, c, s, now), partial: true, horses: h && h.status === 'active' ? [horseView(m, c, s, h, now, false)] : [] };
}

function trainingCounts(m: Master, c: TrainingConfig, s: PlayerState, now: number) {
  const t = s.training;
  const today = gameDayKey(now, dayRule(m));
  const used = t && sameGameDay(t.day, today) ? t.used : 0;
  return {
    enabled: true as const,
    slotsPerDay: c.slotsPerDay, usedToday: used, slotsLeft: Math.max(0, c.slotsPerDay - used), perHorsePerDay: c.perHorsePerDay,
    items: c.items.map((x) => ({ itemId: x.itemId, name: x.name, fatigueRelief: x.fatigueRelief, owned: s.items[x.itemId] ?? 0 })),
    open: t?.open && now <= t.open.expiresAt ? sessionView(c, t.open) : null,
  };
}

function horseView(m: Master, c: TrainingConfig, s: PlayerState, h: HorseInstance, now: number, withLog = true) {
  const today = gameDayKey(now, dayRule(m));
  const rec = s.training?.horses[h.id];
  const fatigue = fatigueNow(m, c, rec, now);
  return {
    horseId: h.id, name: h.name, rarity: h.rarity,
    trained: { ...zeroStats(), ...(h.trained ?? {}) }, trainedTotal: trainedTotal(h), potential: potentialOf(c, h), perStatCap: perStatCap(c, h),
    fatigue, condition: conditionOf(c, fatigue), bondLevel: horseBondLevel(m, s, h.id),
    todayCount: rec && sameGameDay(rec.day, today) ? rec.dayCount : 0, sessions: rec?.sessions ?? 0, ...(withLog ? { log: rec?.log ?? [] } : {}),
    blocked: blockReason(m, c, s, h, null, now),
    menus: c.menus.map((x) => ({ id: x.id, blocked: blockReason(m, c, s, h, x, now) })),
  };
}

function sessionView(c: TrainingConfig, x: TrainingSession) {
  return { sessionId: x.id, horseId: x.horseId, menuId: x.menuId, startedAt: x.startedAt, expiresAt: x.expiresAt, beats: x.beats, durationMs: c.timing.durationMs };
}

/** REQ-TRAIN-002: start a session (uses a slot, adds the menu's fatigue). The gain is decided at finish from the start state. */
export function startTraining(m: Master, s: PlayerState, horseId: string, menuId: string, rng: Rng, now: number, emit: Emit) {
  const c = requireConfig(m);
  const t = ensureTraining(s);
  // an older session still open is settled as skipped first (a crashed app never locks training)
  if (t.open) settle(m, c, s, t.open, [], now > t.open.expiresAt ? 'expired' : 'skipped', now, emit);
  const h = getHorse(s, horseId);
  const menu = c.menus.find((x) => x.id === menuId);
  if (!menu) throw new AppError('NOT_FOUND', `training menu ${menuId}`);
  const why = blockReason(m, c, s, h, menu, now);
  if (why === 'retired') throw new AppError('HORSE_NOT_ACTIVE');
  if (why === 'no_slots' || why === 'horse_daily_limit') throw new AppError('TRAINING_LIMIT', why);
  if (why === 'potential_full') throw new AppError('TRAINING_POTENTIAL_FULL');
  if (why === 'tired') throw new AppError('TRAINING_TIRED', 'let the horse rest (プール or a day off)');
  const today = slotsToday(m, t, now);
  const rec = horseRec(t, h.id);
  if (!sameGameDay(rec.day, today)) { rec.day = today; rec.dayCount = 0; }
  const fatigueBefore = fatigueNow(m, c, rec, now);
  const seed = rng.nextU32();
  const session: TrainingSession = {
    id: `tr_${now.toString(36)}_${seed.toString(36)}`, horseId: h.id, menuId: menu.id, seed, startedAt: now, expiresAt: now + c.sessionTtlMs,
    fatigueBefore, bondLevel: horseBondLevel(m, s, h.id), beats: beatSchedule(c.timing, seed),
  };
  t.used += 1;
  rec.dayCount += 1;
  setFatigue(m, c, rec, fatigueBefore + menu.fatigue, now);
  t.open = session;
  emit({ name: 'training_start', s1: menu.id, s2: h.rarity, value: fatigueBefore, count: t.used });
  const base = effectiveStats(m, h);
  const preview = (timingPermille: number) => computeGain(c, h, base, menu, { fatigueBefore, bondLevel: session.bondLevel, timingPermille, carry: rec.carry, seed });
  const lo = preview(0), hi = preview(maxScore(c.timing) * c.timing.permillePerPoint);
  // whole points given now, and this session's growth in thousandths of a point (the rest carries to the next session)
  return { session: sessionView(c, session), preview: { min: lo.whole, max: hi.whole, minMilli: lo.milli, maxMilli: hi.milli }, slotsLeft: c.slotsPerDay - t.used };
}

/** REQ-TRAIN-006: finish with the mini-game taps (empty + skipped = no mini-game). */
export function finishTraining(m: Master, s: PlayerState, sessionId: string, input: { taps: unknown; skipped?: boolean }, now: number, emit: Emit) {
  const c = requireConfig(m);
  const t = ensureTraining(s);
  const x = t.open;
  if (!x || x.id !== sessionId) throw new AppError('TRAINING_SESSION_USED', 'no open session with this id');
  if (now > x.expiresAt) throw new AppError('TRAINING_SESSION_EXPIRED', 'settled as skipped on the next training call');
  const skipped = input.skipped === true;
  const taps = skipped ? [] : validateTaps(c.timing, x.beats, input.taps, now - x.startedAt);
  return settle(m, c, s, x, taps, skipped ? 'skipped' : 'done', now, emit);
}

type SettleReason = 'done' | 'skipped' | 'expired';
function settle(m: Master, c: TrainingConfig, s: PlayerState, x: TrainingSession, taps: number[], reason: SettleReason, now: number, emit: Emit) {
  const skipped = reason !== 'done';
  const t = ensureTraining(s);
  t.open = null;
  const h = s.horses.find((y) => y.id === x.horseId);
  const menu = c.menus.find((y) => y.id === x.menuId);
  const rec = horseRec(t, x.horseId);
  const timing = scoreTiming(c.timing, x.beats, taps);
  const grade = gradeOf(c, timing.score, skipped);
  if (!h || !menu) return { sessionId: x.id, horseId: x.horseId, menuId: x.menuId, grade, timing, gain: zeroStats(), total: 0, settled: reason, void: true };
  const g = computeGain(c, h, effectiveStats(m, h), menu, { fatigueBefore: x.fatigueBefore, bondLevel: x.bondLevel, timingPermille: skipped ? 0 : timing.bonusPermille, carry: rec.carry, seed: x.seed });
  const trained = { ...zeroStats(), ...(h.trained ?? {}) };
  for (const k of STAT_KEYS) trained[k] += g.stats[k];
  h.trained = trained;
  rec.carry = g.carry;
  rec.sessions += 1;
  t.total += 1;
  if (c.logKeep > 0) {
    rec.log.unshift({ at: now, menuId: menu.id, grade, gain: g.whole, score: timing.score });
    rec.log.splice(c.logKeep);
  }
  // REQ-TRAIN-011: daily mission progress (the mission's reward is the training item)
  noteTrainingMission(m, s, now);
  emit({ name: 'training_done', s1: menu.id, s2: grade, s3: reason, value: g.whole, count: timing.score, isFirst: t.total === 1 });
  return {
    sessionId: x.id, horseId: h.id, menuId: menu.id, grade, timing, gain: g.stats, total: g.whole, capped: g.capped,
    breakdown: { efficiencyPermille: g.efficiencyPermille, bondPermille: g.bondPermille, timingPermille: g.timingPermille, softPermille: g.softPermille },
    trained, trainedTotal: trainedTotal(h), potential: potentialOf(c, h), fatigue: fatigueNow(m, c, rec, now),
    settled: reason, void: false,
  };
}

function noteTrainingMission(m: Master, s: PlayerState, now: number) {
  const today = gameDayKey(now, dayRule(m));
  if (!sameGameDay(s.missions.date, today)) s.missions = { date: today, progress: {}, claimed: [] };
  for (const d of m.progression.dailyMissions) if (d.kind === 'training') s.missions.progress[d.id] = (s.missions.progress[d.id] ?? 0) + 1;
}

/** REQ-TRAIN-008: a training item (fatigue relief) on one horse. */
export function useTrainingItem(m: Master, s: PlayerState, itemId: string, horseId: string, now: number, ref: string) {
  const c = requireConfig(m);
  const def = c.items.find((x) => x.itemId === itemId);
  if (!def) throw new AppError('NOT_FOUND', `training item ${itemId}`);
  const h = getHorse(s, horseId);
  if (h.status !== 'active') throw new AppError('HORSE_NOT_ACTIVE');
  const t = ensureTraining(s);
  const rec = horseRec(t, h.id);
  const before = fatigueNow(m, c, rec, now);
  if (before <= 0) throw new AppError('NOT_ELIGIBLE', 'the horse is not tired');
  consumeItem(s, itemId, 1, now, 'training item', ref);
  setFatigue(m, c, rec, before - def.fatigueRelief, now);
  return { itemId, horseId: h.id, fatigueBefore: before, fatigue: fatigueNow(m, c, rec, now), remaining: s.items[itemId] ?? 0 };
}

/** Expired sessions are settled on every read that goes through a transaction (GET /v1/training). */
export function trainingTick(m: Master, s: PlayerState, now: number, emit: Emit) {
  if (!trainingConfig(m)) return;
  settleExpired(m, s, now, emit);
}
