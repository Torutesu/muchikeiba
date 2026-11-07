import { AppError, assert } from './errors.js';
import { STAT_KEYS } from '../../../contracts/master-values.js';
import type { HorseTemplate, Master, Rarity, Sex, Stats, Style } from './master.js';
import type { HorseInstance, PlayerState } from './player.js';
import type { GoingAptitude } from './schemas.js';
import { randInt, randRange, type Rng } from './rng.js';
import { jstDateKey } from './time.js';
import { appearanceOf, deriveAppearance, inheritAppearance, templateAppearance } from './visuals.js';

export function createHorseFromTemplate(s: PlayerState, t: HorseTemplate, now: number): HorseInstance {
  s.counters.horseSeq += 1;
  const h: HorseInstance = {
    id: `h${s.counters.horseSeq}`, templateId: t.id, name: t.name, rarity: t.rarity, sex: t.sex, style: t.style,
    distMinM: t.distMinM, distMaxM: t.distMaxM, surface: t.surface, line: t.line, base: { ...t.stats }, awakening: 0,
    bornAt: now, status: 'active', sireId: null, damId: null, sireName: t.sireName, damName: t.damName, named: false,
  };
  if (t.goingAptitude && t.goingAptitude !== 'any') h.goingAptitude = t.goingAptitude;
  h.appearance = templateAppearance(t.id) ?? deriveAppearance(`${s.id}:${h.id}`); // REQ-ASSET-003
  s.horses.push(h);
  return h;
}

export function getHorse(s: PlayerState, id: string): HorseInstance {
  const h = s.horses.find((x) => x.id === id);
  if (!h) throw new AppError('HORSE_NOT_FOUND', id);
  return h;
}

const clampStat = (n: number) => Math.max(0, Math.min(1000, Math.trunc(n)));

/** Awakening raises stats by a permille per level, capped at 1000 (REQ-HORSE-002). */
export function effectiveStats(m: Master, h: HorseInstance): Stats {
  const k = 1000 + h.awakening * m.progression.awakeningStatPermillePerLevel;
  const out = {} as Stats;
  for (const key of STAT_KEYS) out[key] = clampStat(Math.floor((h.base[key] * k) / 1000));
  return out;
}

export function awaken(m: Master, s: PlayerState, horseId: string) {
  const h = getHorse(s, horseId);
  const costs = m.progression.awakeningCost;
  if (h.awakening >= costs.length) throw new AppError('AWAKENING_MAX');
  const cost = costs[h.awakening]!;
  if (s.materials.awakening < cost) throw new AppError('INSUFFICIENT_COINS', `need ${cost} awakening material`);
  s.materials.awakening -= cost;
  h.awakening += 1;
  return h;
}

export function retire(s: PlayerState, horseId: string) {
  const h = getHorse(s, horseId);
  if (h.status !== 'active') throw new AppError('HORSE_NOT_ACTIVE');
  h.status = 'retired';
  return h;
}

// ---------- Naming (REQ-HORSE-003) ----------
const SMALL: Record<string, string> = { ァ: 'ア', ィ: 'イ', ゥ: 'ウ', ェ: 'エ', ォ: 'オ', ッ: 'ツ', ャ: 'ヤ', ュ: 'ユ', ョ: 'ヨ', ヮ: 'ワ', ヵ: 'カ', ヶ: 'ケ' };

/** NFKC → hiragana to katakana → unify long-vowel marks. This is the stored display form. */
export function normalizeName(raw: string): string {
  let s = raw.normalize('NFKC').replace(/\s+/g, '');
  s = s.replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));
  s = s.replace(/[-‐‑‒–—―−ｰ～〜]/g, 'ー');
  return s;
}

/** Folded form used only for NG comparison: small kana → large, long vowels removed, ヴ → ブ. */
export function foldForCompare(name: string): string {
  return normalizeName(name).replace(/[ァィゥェォッャュョヮヵヶ]/g, (c) => SMALL[c]!).replace(/ー/g, '').replace(/ヴ/g, 'ブ');
}

export function validateName(m: Master, raw: string): string {
  const name = normalizeName(raw);
  if (!/^[ァ-ヴー]{2,9}$/.test(name) || name.startsWith('ー')) throw new AppError('INVALID_NAME', 'カタカナ2〜9文字');
  const f = foldForCompare(name);
  if (m.ng.exact.some((n) => foldForCompare(n) === f)) throw new AppError('NG_NAME');
  if (m.ng.contains.some((n) => f.includes(foldForCompare(n)))) throw new AppError('NG_NAME');
  return name;
}

export function nameHorse(m: Master, s: PlayerState, horseId: string, raw: string) {
  const h = getHorse(s, horseId);
  h.name = validateName(m, raw);
  h.named = true;
  return h;
}

// ---------- Pedigree (REQ-HORSE-007) ----------
export interface PedigreeNode { key: string; name: string; horseId: string | null; sire: PedigreeNode | null; dam: PedigreeNode | null }

function nodeFor(s: PlayerState, h: HorseInstance, depth: number): PedigreeNode {
  const node: PedigreeNode = { key: h.id, name: h.name, horseId: h.id, sire: null, dam: null };
  if (depth <= 0) return node;
  const parent = (id: string | null, name: string | null): PedigreeNode | null => {
    if (id) {
      const p = s.horses.find((x) => x.id === id);
      if (p) return nodeFor(s, p, depth - 1);
    }
    return name ? { key: `name:${name}`, name, horseId: null, sire: null, dam: null } : null;
  };
  node.sire = parent(h.sireId, h.sireName);
  node.dam = parent(h.damId, h.damName);
  return node;
}

/** 5 generations above the horse. */
export function pedigree(s: PlayerState, horseId: string, generations = 5): PedigreeNode {
  return nodeFor(s, getHorse(s, horseId), generations);
}

function ancestorKeys(n: PedigreeNode | null, depth: number, out: Set<string>) {
  if (!n || depth < 0) return;
  out.add(n.key);
  ancestorKeys(n.sire, depth - 1, out);
  ancestorKeys(n.dam, depth - 1, out);
}

/** Number of shared ancestors within 3 generations of the foal (parents + grandparents + great-grandparents). */
export function inbreedingCount(s: PlayerState, sire: HorseInstance, dam: HorseInstance): number {
  const a = new Set<string>();
  const b = new Set<string>();
  ancestorKeys(nodeFor(s, sire, 2), 2, a);
  ancestorKeys(nodeFor(s, dam, 2), 2, b);
  let n = 0;
  for (const k of a) if (b.has(k)) n++;
  return n;
}

// ---------- Breeding (REQ-HORSE-005..008) ----------
export const BREED = { variation: 60, potentialPermillePerAwakening: 10, basePermille: 950, inbreedingPenalty: 50, distJitterSteps: 2, distStepM: 100 };
const STYLES: Style[] = ['nige', 'senko', 'sashi', 'oikomi'];

export function isNick(m: Master, sire: HorseInstance, dam: HorseInstance) {
  return m.nicks.pairs.some(([a, b]) => a === sire.line && b === dam.line);
}

function checkPair(s: PlayerState, sireId: string, damId: string) {
  const sire = getHorse(s, sireId);
  const dam = getHorse(s, damId);
  if (sire.status !== 'retired' || dam.status !== 'retired') throw new AppError('HORSE_NOT_RETIRED');
  if (sire.sex !== 'male' || dam.sex !== 'female' || sire.id === dam.id) throw new AppError('BREEDING_INVALID_PAIR');
  return { sire, dam };
}

/** Deterministic base (before random variation). Shared by the real computation and the preview. */
function baseline(m: Master, s: PlayerState, sire: HorseInstance, dam: HorseInstance) {
  const ss = effectiveStats(m, sire);
  const ds = effectiveStats(m, dam);
  const permille = BREED.basePermille + (sire.awakening + dam.awakening) * BREED.potentialPermillePerAwakening;
  const nick = isNick(m, sire, dam) ? m.nicks.bonus : 0;
  const inbreed = inbreedingCount(s, sire, dam);
  const stats = {} as Stats;
  for (const k of STAT_KEYS) stats[k] = Math.floor((((ss[k] + ds[k]) / 2) * permille) / 1000) + nick - inbreed * BREED.inbreedingPenalty;
  const distMin = Math.round((sire.distMinM + dam.distMinM) / 2 / BREED.distStepM) * BREED.distStepM;
  const distMax = Math.round((sire.distMaxM + dam.distMaxM) / 2 / BREED.distStepM) * BREED.distStepM;
  return { stats, nick: nick > 0, inbreed, distMin, distMax };
}

export function rarityForTotal(total: number): Rarity {
  return total >= 3700 ? 'SSR' : total >= 3200 ? 'SR' : 'R';
}

/**
 * Ground preference inheritance (REQ-RACE-035), in permille per aptitude. Used by both breed() and the
 * preview so the shown odds are the real ones. A parent without a preference counts as "any".
 */
export function goingAptitudeOdds(sire: Pick<HorseInstance, 'goingAptitude'>, dam: Pick<HorseInstance, 'goingAptitude'>): Record<GoingAptitude, number> {
  const a = sire.goingAptitude ?? 'any';
  const b = dam.goingAptitude ?? 'any';
  if (a === b) return a === 'any' ? { any: 1000, fast: 0, heavy: 0 } : { any: 200, fast: a === 'fast' ? 800 : 0, heavy: a === 'heavy' ? 800 : 0 };
  if (a === 'any' || b === 'any') {
    const x = a === 'any' ? b : a;
    return { any: 500, fast: x === 'fast' ? 500 : 0, heavy: x === 'heavy' ? 500 : 0 };
  }
  return { any: 200, fast: 400, heavy: 400 }; // fast × heavy
}

function rollGoingAptitude(odds: Record<GoingAptitude, number>, rng: Rng): GoingAptitude {
  if (odds.any === 1000) return 'any'; // no draw: keeps RNG use unchanged for parents without preferences
  let r = randInt(rng, 1000);
  for (const k of ['fast', 'heavy', 'any'] as const) {
    if (r < odds[k]) return k;
    r -= odds[k];
  }
  return 'any';
}

/** Breeding preview from the same baseline function (REQ-HORSE-008). */
export function breedingPreview(m: Master, s: PlayerState, sireId: string, damId: string) {
  const { sire, dam } = checkPair(s, sireId, damId);
  const b = baseline(m, s, sire, dam);
  const range = {} as Record<keyof Stats, { min: number; max: number }>;
  for (const k of STAT_KEYS) range[k] = { min: clampStat(b.stats[k] - BREED.variation), max: clampStat(b.stats[k] + BREED.variation) };
  const jitter = BREED.distJitterSteps * BREED.distStepM;
  const styleOdds: Partial<Record<Style, number>> = {};
  styleOdds[sire.style] = (styleOdds[sire.style] ?? 0) + 45;
  styleOdds[dam.style] = (styleOdds[dam.style] ?? 0) + 45;
  for (const st of STYLES) styleOdds[st] = (styleOdds[st] ?? 0) + 2.5;
  return {
    stats: range, nick: b.nick, inbreedingCount: b.inbreed,
    styles: styleOdds,
    distance: { minM: Math.max(1000, b.distMin - jitter), maxM: b.distMax + jitter },
    surface: sire.surface === dam.surface ? sire.surface : 'both or a parent\'s',
    goingAptitude: goingAptitudeOdds(sire, dam),
  };
}

/** Real breeding (server RNG). Daily limit by JST date. */
export function breed(m: Master, s: PlayerState, sireId: string, damId: string, rng: Rng, now: number) {
  const { sire, dam } = checkPair(s, sireId, damId);
  const today = jstDateKey(now);
  if (s.breeding.date !== today) s.breeding = { date: today, count: 0 };
  if (s.breeding.count >= m.progression.breedingPerDay) throw new AppError('BREEDING_DAILY_LIMIT');
  const b = baseline(m, s, sire, dam);
  const stats = {} as Stats;
  for (const k of STAT_KEYS) stats[k] = clampStat(b.stats[k] + randRange(rng, -BREED.variation, BREED.variation));
  const roll = randInt(rng, 1000);
  const style: Style = roll < 450 ? sire.style : roll < 900 ? dam.style : STYLES[randInt(rng, 4)]!;
  const j = () => randRange(rng, -BREED.distJitterSteps, BREED.distJitterSteps) * BREED.distStepM;
  let distMinM = Math.max(1000, b.distMin + j());
  let distMaxM = b.distMax + j();
  if (distMaxM < distMinM + 200) distMaxM = distMinM + 200;
  const surface = sire.surface === dam.surface ? sire.surface : randInt(rng, 5) === 0 ? 'both' : randInt(rng, 2) === 0 ? sire.surface : dam.surface;
  const sex: Sex = randInt(rng, 2) === 0 ? 'male' : 'female';
  const total = STAT_KEYS.reduce((a, k) => a + stats[k], 0);
  s.counters.horseSeq += 1;
  const foal: HorseInstance = {
    id: `h${s.counters.horseSeq}`, templateId: null, name: 'ミメイ', rarity: rarityForTotal(total), sex, style,
    distMinM, distMaxM, surface, line: sire.line, base: stats, awakening: 0, bornAt: now, status: 'active',
    sireId: sire.id, damId: dam.id, sireName: sire.name, damName: dam.name, named: false,
  };
  const apt = rollGoingAptitude(goingAptitudeOdds(sire, dam), rng);
  if (apt !== 'any') foal.goingAptitude = apt;
  // REQ-ASSET-004: drawn after every other roll so stats/aptitude outcomes are unchanged
  foal.appearance = inheritAppearance(appearanceOf(sire, s.id), appearanceOf(dam, s.id), rng);
  s.horses.push(foal);
  s.breeding.count += 1;
  assert(foal.distMinM <= foal.distMaxM, 'CONFIG_INVALID');
  return { foal, nick: b.nick, inbreedingCount: b.inbreed };
}
