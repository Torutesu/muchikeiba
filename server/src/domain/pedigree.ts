/**
 * 血統図と系統 (pedigree viewer & bloodlines, REQ-PED-001..020, contracts/protocol.md §71).
 *
 * Read-only. Every number shown comes from the existing breeding rules (previewFor, inbreedingCount, BREED, nicks.json):
 * no new randomness and no new mechanic. Nothing is granted or sold, and the bloodline list ties nothing to how many lines a
 * stable holds (no コンプガチャ).
 *
 * - Ancestors are read live from the stable first (horses never leave it), then from the foal's birth snapshot `lineage`
 *   (REQ-PED-001, written once by breedWith), then as a bare name (template parents, older borrowed stallions) → 「記録なし」.
 * - Ancestor keys are the ones horses.ts `pedigree()` / `inbreedingCount` use, so the shared-ancestor highlight always agrees
 *   with the breeding computation. Stud keys (`stud:<owner>:<horse>`) are replaced with `stud:<n>` on the way out: no
 *   other player's id leaves the server.
 * - Another player's horse: only while it is shown publicly (their stable copy or their trainer card's featured horse), with
 *   both block lists checked by the orchestrator (PedigreeService) → 404 otherwise. Under-13 owners (§62 showcaseYoung): no
 *   owner-typed names.
 */
import { AppError } from './errors.js';
import { STAT_KEYS, type Master, type Stats, type Style } from './master.js';
import { moderationOf, type HorseInstance, type LineageSnap, type PlayerState } from './player.js';
import { BREED, getHorse, inbreedingCount, isNick, parentTraits, previewFor, studKey } from './horses.js';
import { appearanceOf, assetKeys, fnv1a64Hex, type Appearance } from './visuals.js';
import { horseSkillId } from './skills.js';
import { deletionScheduled } from './accountDeletion.js';
import { showcaseCopy, showcaseYoung } from './showcase.js';
import { stableSnapshot } from './stable.js';
import { bettingWordsIn } from './bettingWords.js';
import { catalogFor, enWordingProblems, textIn } from '../i18n/catalog.js';
import type { Locale } from '../i18n/locale.js';
import type { GoingAptitude } from './schemas.js';
import bloodlinesJson from '../../master/bloodlines.json';

// ------------------------------------------------------------------------------------------------ master

export interface Loc { ja: string; en: string }
export interface BloodlineDef { id: string; ja: string; en: string; founder: Loc; note: Loc }
export interface BloodlinesMaster { version: number; lines: BloodlineDef[] }

export const bloodlinesOf = (m: Master): BloodlinesMaster => m.bloodlines ?? (bloodlinesJson as unknown as BloodlinesMaster);
const pick = (l: Loc, locale: Locale) => (locale === 'en' ? l.en : l.ja);
export const PED_BANNED_JA = ['倍', 'お得', '今だけ', '残りわずか', '通常価格'];
const LINE_ID_RE = /^[a-z][a-z0-9_]{0,31}$/;

/** REQ-PED-011: the bloodline names are usable (checked at boot). */
export function bloodlineProblems(m: Master): string[] {
  const bm = bloodlinesOf(m);
  const p: string[] = [];
  if (!bm || !Array.isArray(bm.lines) || bm.lines.length === 0) return ['bloodlines.lines must not be empty'];
  const seen = new Set<string>();
  const text = (at: string, l: Loc | undefined, maxJa: number, maxEn: number) => {
    if (!l || typeof l.ja !== 'string' || typeof l.en !== 'string' || !l.ja || !l.en) { p.push(`${at}: ja and en are required`); return; }
    if (l.ja.length > maxJa || l.en.length > maxEn) p.push(`${at}: too long`);
    for (const w of bettingWordsIn(l.ja)) p.push(`${at}: betting word in ja (${w})`);
    for (const w of bettingWordsIn(l.en)) p.push(`${at}: betting word in en (${w})`);
    for (const w of PED_BANNED_JA) if (l.ja.includes(w)) p.push(`${at}: 「${w}」 is not allowed`);
    for (const w of enWordingProblems(l.en)) p.push(`${at}: en ${w}`);
    if (/[　-ヿ㐀-䶿一-鿿＀-￯]/.test(l.en)) p.push(`${at}: en contains Japanese`);
  };
  for (const [i, x] of bm.lines.entries()) {
    const at = `bloodlines.lines[${x?.id ?? i}]`;
    if (!x || !LINE_ID_RE.test(x.id)) { p.push(`${at}: bad id`); continue; }
    if (seen.has(x.id)) p.push(`${at}: duplicate id`);
    seen.add(x.id);
    text(`${at}.name`, { ja: x.ja, en: x.en }, 12, 32);
    text(`${at}.founder`, x.founder, 12, 32);
    text(`${at}.note`, x.note, 60, 120);
  }
  for (const t of m.templates) if (!seen.has(t.line)) p.push(`bloodlines: template ${t.id} line ${t.line} has no entry`);
  for (const [a, b] of m.nicks.pairs) for (const l of [a, b]) if (!seen.has(l)) p.push(`bloodlines: nick line ${l} has no entry`);
  return p;
}

export function lineNameOf(m: Master, id: string, locale: Locale): string {
  const d = bloodlinesOf(m).lines.find((x) => x.id === id);
  return d ? pick({ ja: d.ja, en: d.en }, locale) : id;
}

// ------------------------------------------------------------------------------------------------ texts

const T = {
  noRecord: '記録なし',
  hiddenName: '名前は非公開',
  otherTrainer: '他のトレーナーの馬',
  friendStud: 'フレンドの種牡馬',
  myStud: 'あなたの種牡馬',
  noRaces: '出走なし',
  notice: '系統の数で報酬はありません。',
  pairNotice: '確率と数は配合の規則のとおりです。',
};
const STAT_LABEL: Record<keyof Stats, Loc> = {
  speed: { ja: 'スピード', en: 'Speed' }, stamina: { ja: 'スタミナ', en: 'Stamina' }, burst: { ja: '瞬発力', en: 'Burst' },
  guts: { ja: '根性', en: 'Guts' }, temper: { ja: '気性', en: 'Temper' },
};
const STYLE_LABEL: Record<Style, Loc> = {
  nige: { ja: '逃げ', en: 'Front-runner' }, senko: { ja: '先行', en: 'Stalker' }, sashi: { ja: '差し', en: 'Closer' }, oikomi: { ja: '追込', en: 'Deep closer' },
};
const GOING_LABEL: Record<GoingAptitude, Loc> = {
  fast: { ja: '良馬場が得意', en: 'Good on firm ground' }, heavy: { ja: '重馬場が得意', en: 'Good on soft ground' }, any: { ja: '馬場を問わない', en: 'Any ground' },
};
const fmtPct = (permille: number) => `${Math.round(permille) / 10}%`.replace(/\.0%$/, '%');
const fill = (s: string, v: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_, k: string) => String(v[k] ?? ''));
/** Hint wording in both languages (built in the viewer's language: `hintText` is pre-localized, never translated twice). */
const HINT: Record<string, Loc> = {
  line: { ja: '仔の系統は父と同じ「{line}」', en: 'The foal takes its sire\'s line: {line}' },
  nick: { ja: 'ニックス（相性の良い系統）：能力の基準 +{n}', en: 'Nick (a good line match): base stats +{n}' },
  stat: { ja: '{stat}が受け継がれやすい（{min}〜{max}）', en: '{stat} tends to carry over ({min}-{max})' },
  style: { ja: '脚質「{style}」になる確率 {p}', en: 'Chance of {style}: {p}' },
  going: { ja: '「{going}」になる確率 {p}', en: 'Chance of "{going}": {p}' },
  skill: { ja: '固有スキル「{skill}」を受け継ぐ確率 {p}', en: 'Chance to inherit the unique skill {skill}: {p}' },
  atavism: { ja: '隔世遺伝：{from}の「{value}」 {p}', en: 'Throwback: {value} from {from}, {p}' },
  inbreeding: { ja: '近親：共通の祖先{n}頭（能力の基準 −{p}）', en: 'Inbreeding: {n} shared ancestor(s) (base stats -{p})' },
};

// ------------------------------------------------------------------------------------------------ tree

export interface PedRecord {
  source: 'live' | 'snapshot';
  rarity: string; sex: string; style: Style; goingAptitude: GoingAptitude; surface: string; line: string; lineName: string;
  appearance: Appearance; thumbKey: string | null; skill: { id: string; name: string } | null; status: 'active' | 'retired' | null;
  statTotal: number; stats?: Stats;
  best: { races: number; wins: number; places: number; tournamentWins: number } | null; bestText: string | null;
}
export interface PedNode {
  key: string; name: string; horseId: string | null; sire: PedNode | null; dam: PedNode | null;
  gen: number; rec: PedRecord | null; recordText: string | null; shared: boolean; founder: boolean;
  lent?: { ownerName: string | null; label: string };
  nameHidden?: true;
  /** Internal (a borrowed stallion's owner id): read and removed by finishPedigree / finishBreedingPedigree, never returned. */
  _owner?: string;
}

interface Ctx {
  m: Master; s: PlayerState; locale: Locale; self: boolean; young: boolean;
  masterNames: Set<string>; founders: Set<string>;
  /** stud raw key → owner id (resolved to a name by the orchestrator, never returned). */
  studOwners: Map<string, string>;
}

function ctxFor(m: Master, s: PlayerState, locale: Locale, self: boolean, now: number): Ctx {
  const masterNames = new Set<string>();
  for (const t of m.templates) { masterNames.add(t.name); if (t.sireName) masterNames.add(t.sireName); if (t.damName) masterNames.add(t.damName); }
  masterNames.add('ミメイ');
  const founders = new Set(bloodlinesOf(m).lines.map((l) => l.founder.ja));
  return { m, s, locale, self, young: !self && showcaseYoung(m, s, now), masterNames, founders, studOwners: new Map() };
}

const statSum = (x: Stats) => STAT_KEYS.reduce((a, k) => a + (x[k] ?? 0), 0);

function bestOf(c: Ctx, horseId: string) {
  const r = c.s.hall?.careers[horseId];
  const best = r ? { races: r.races, wins: r.wins, places: r.places, tournamentWins: r.tournamentWins } : { races: 0, wins: 0, places: 0, tournamentWins: 0 };
  const parts = best.races === 0 ? [T.noRaces] : [`${best.races}戦${best.wins}勝`];
  if (best.tournamentWins > 0) parts.push(`大会優勝${best.tournamentWins}回`);
  return { best, bestText: parts.join('・') };
}

function skillOf(c: Ctx, id: string | null | undefined) {
  const d = id ? c.m.skills.byId.get(id) : undefined;
  return d ? { id: d.id, name: d.name } : null;
}

function recLive(c: Ctx, h: HorseInstance): PedRecord {
  const stats = h.base;
  const { best, bestText } = bestOf(c, h.id);
  return {
    source: 'live', rarity: h.rarity, sex: h.sex, style: h.style, goingAptitude: h.goingAptitude ?? 'any', surface: h.surface,
    line: h.line, lineName: lineNameOf(c.m, h.line, c.locale), appearance: appearanceOf(h, c.s.id),
    thumbKey: h.templateId ? assetKeys.collectionPortrait(h.templateId) : null, skill: skillOf(c, horseSkillId(c.m, h)),
    status: h.status, statTotal: statSum(stats), ...(c.self ? { stats: { ...stats } } : {}), best, bestText,
  };
}

function recSnap(c: Ctx, x: LineageSnap): PedRecord {
  return {
    source: 'snapshot', rarity: x.rarity, sex: x.sex, style: x.style, goingAptitude: x.goingAptitude ?? 'any', surface: x.surface,
    line: x.line, lineName: lineNameOf(c.m, x.line, c.locale), appearance: x.appearance,
    thumbKey: x.templateId ? assetKeys.collectionPortrait(x.templateId) : null, skill: skillOf(c, x.skillId),
    status: null, statTotal: statSum(x.stats), ...(c.self ? { stats: { ...x.stats } } : {}), best: null, bestText: null,
  };
}

/** Owner-typed names are hidden from others when the owner is under 13 (REQ-PED-007). */
function nameOut(c: Ctx, name: string, ownerTyped: boolean): { name: string; nameHidden?: true } {
  return c.young && ownerTyped ? { name: T.hiddenName, nameHidden: true } : { name };
}

function bare(c: Ctx, name: string | null, gen: number): PedNode | null {
  if (!name) return null;
  return { key: `name:${name}`, ...nameOut(c, name, !c.masterNames.has(name)), horseId: null, sire: null, dam: null, gen, rec: null, recordText: T.noRecord, shared: false, founder: c.founders.has(name) };
}

function snapNode(c: Ctx, key: string, x: LineageSnap, gen: number, max: number): PedNode {
  const n: PedNode = { key, ...nameOut(c, x.name, !!x.named), horseId: null, sire: null, dam: null, gen, rec: recSnap(c, x), recordText: null, shared: false, founder: false };
  if (gen < max) { n.sire = bare(c, x.sireName, gen + 1); n.dam = bare(c, x.damName, gen + 1); }
  return n;
}

function liveNode(c: Ctx, h: HorseInstance, gen: number, max: number): PedNode {
  const n: PedNode = {
    key: h.id, ...nameOut(c, h.name, h.named), horseId: c.self || gen === 0 ? h.id : null, sire: null, dam: null, gen,
    rec: recLive(c, h), recordText: null, shared: false, founder: false,
  };
  if (gen >= max) return n;
  const live = (id: string | null) => (id ? c.s.horses.find((x) => x.id === id) : undefined);
  // sire: own horse → borrowed stallion (REQ-BREED-014) → birth snapshot → bare name (the same order as horses.ts nodeFor)
  const ls = live(h.sireId);
  if (ls) n.sire = liveNode(c, ls, gen + 1, max);
  else if (!h.sireId && h.studSire) {
    const st = h.studSire;
    const key = studKey(st.ownerId, st.horseId);
    c.studOwners.set(key, st.ownerId);
    const snap = h.lineage?.sire;
    const name = h.sireName ?? snap?.name ?? '';
    n.sire = {
      key, ...nameOut(c, name, snap ? !!snap.named : !c.masterNames.has(name)), horseId: null, gen: gen + 1,
      rec: snap ? recSnap(c, snap) : null, recordText: snap ? null : T.noRecord, shared: false, founder: false,
      sire: gen + 1 < max ? bare(c, st.sireName, gen + 2) : null, dam: gen + 1 < max ? bare(c, st.damName, gen + 2) : null,
      lent: { ownerName: null, label: T.otherTrainer }, _owner: st.ownerId,
    };
  } else if (h.lineage?.sire && h.sireName) n.sire = snapNode(c, h.sireId ?? `name:${h.sireName}`, h.lineage.sire, gen + 1, max);
  else n.sire = bare(c, h.sireName, gen + 1);
  const ld = live(h.damId);
  if (ld) n.dam = liveNode(c, ld, gen + 1, max);
  else if (h.lineage?.dam && h.damName) n.dam = snapNode(c, h.damId ?? `name:${h.damName}`, h.lineage.dam, gen + 1, max);
  else n.dam = bare(c, h.damName, gen + 1);
  return n;
}

/** Keys of a subtree down to `depth` more generations (the same walk as horses.ts ancestorKeys). */
function keysOf(n: PedNode | null, depth: number, out: Set<string>) {
  if (!n || depth < 0) return out;
  out.add(n.key);
  keysOf(n.sire, depth - 1, out);
  keysOf(n.dam, depth - 1, out);
  return out;
}
/** Ancestors in both subtrees within 3 generations of the foal (= horses.ts inbreedingCount for the same pair). */
function sharedBetween(sire: PedNode | null, dam: PedNode | null): string[] {
  const a = keysOf(sire, 2, new Set());
  const b = keysOf(dam, 2, new Set());
  return [...a].filter((k) => b.has(k));
}
function markShared(n: PedNode | null, shared: Set<string>, maxGen: number) {
  if (!n || n.gen > maxGen) return;
  if (shared.has(n.key)) n.shared = true;
  markShared(n.sire, shared, maxGen);
  markShared(n.dam, shared, maxGen);
}
function walk(n: PedNode | null, f: (n: PedNode) => void) {
  if (!n) return;
  f(n);
  walk(n.sire, f);
  walk(n.dam, f);
}

/** Replaces `stud:<owner>:<horse>` keys with `stud:<n>` (same stallion → same n) so no other player's id leaves the server. */
function anonymize(keyMap: Map<string, string>, raw: string): string {
  if (!raw.startsWith('stud:')) return raw;
  let k = keyMap.get(raw);
  if (!k) { k = `stud:${keyMap.size + 1}`; keyMap.set(raw, k); }
  return k;
}

/** What the orchestrator fills in: names of stud owners the viewer may see (owner id → display name or 'self'). */
export type OwnerNames = Record<string, { name: string; self: boolean } | null>;

export interface PedigreeDraft {
  tree: PedNode;
  relation: 'self' | 'friend' | 'other';
  generations: number;
  sharedKeys: string[];
  young: boolean;
  /** owner ids of borrowed stallions in the tree (internal: removed by finishPedigree). */
  owners: string[];
}

export const PED_SELF_GENERATIONS = 5;
export const PED_OTHER_GENERATIONS = 3;
export const PED_VIEW_GENERATIONS = 3;

function draftFor(m: Master, s: PlayerState, h: HorseInstance, locale: Locale, relation: 'self' | 'friend' | 'other', now: number): PedigreeDraft {
  const self = relation === 'self';
  const c = ctxFor(m, s, locale, self, now);
  const generations = self ? PED_SELF_GENERATIONS : PED_OTHER_GENERATIONS;
  const tree = liveNode(c, h, 0, generations);
  const shared = sharedBetween(tree.sire, tree.dam);
  markShared(tree, new Set(shared), PED_VIEW_GENERATIONS);
  return { tree, relation, generations, sharedKeys: shared, young: c.young, owners: [...new Set(c.studOwners.values())] };
}

/** REQ-PED-003: my horse's tree (the owner's own state). */
export function pedigreeMine(m: Master, s: PlayerState, horseId: string, locale: Locale, now: number): PedigreeDraft {
  return draftFor(m, s, getHorse(s, horseId), locale, 'self', now);
}

/** Horse ids this player shows publicly right now: the stable copy's stalls and the trainer card's featured horse (REQ-PED-006). */
export function publicHorseIds(m: Master, s: PlayerState, now: number): string[] {
  if (moderationOf(s, now) === 'banned' || deletionScheduled(s)) return [];
  const ids = new Set<string>();
  for (const x of stableSnapshot(m, s, now)?.horses ?? []) ids.add(x.horseId);
  const fav = showcaseCopy(m, s, now)?.horse?.horseId;
  if (fav) ids.add(fav);
  return [...ids];
}

/** REQ-PED-006: another player's horse, only while it is shown publicly (run in the owner's object). */
export function pedigreePublic(m: Master, s: PlayerState, horseId: string, locale: Locale, relation: 'friend' | 'other', now: number): PedigreeDraft {
  if (!publicHorseIds(m, s, now).includes(horseId)) throw new AppError('NOT_FOUND', 'this horse is not shown');
  const h = s.horses.find((x) => x.id === horseId);
  if (!h) throw new AppError('NOT_FOUND', 'this horse is not shown');
  return draftFor(m, s, h, locale, relation, now);
}

/** Owner names on borrowed stallions (or 「他のトレーナーの馬」), internal owner ids dropped, stud keys anonymized. */
function applyOwners(n: PedNode | null, owners: OwnerNames, keyMap: Map<string, string>) {
  walk(n, (x) => {
    if (x.lent) {
      const o = (x._owner ? owners[x._owner] : null) ?? null;
      x.lent = o ? { ownerName: o.name, label: o.self ? T.myStud : T.friendStud } : { ownerName: null, label: T.otherTrainer };
    }
    delete x._owner;
    x.key = anonymize(keyMap, x.key);
  });
}

/**
 * The response body: stud owner names applied (REQ-PED-005), stud keys anonymized, the inbreeding rule (REQ-PED-004) and the
 * content hash `rev` (REQ-PED-008). Owner ids never reach the body.
 */
export function finishPedigree(m: Master, d: PedigreeDraft, owners: OwnerNames, locale: Locale) {
  const keyMap = new Map<string, string>();
  const sharedRaw = [...d.sharedKeys];
  applyOwners(d.tree, owners, keyMap);
  const sharedKeys = sharedRaw.map((k) => anonymize(keyMap, k));
  const h = d.tree;
  const line = h.rec?.line ?? '';
  const body = {
    ...h,
    v: 2 as const,
    relation: d.relation,
    generations: d.generations,
    line, lineName: line ? lineNameOf(m, line, locale) : '',
    sharedKeys,
    inbreeding: { count: sharedKeys.length, penaltyPerAncestor: BREED.inbreedingPenalty, statPenalty: sharedKeys.length * BREED.inbreedingPenalty },
    young: d.young,
  };
  return { ...body, rev: fnv1a64Hex(JSON.stringify(body)) };
}

// ------------------------------------------------------------------------------------------------ breeding pair

function topStats(range: Record<keyof Stats, { min: number; max: number }>) {
  return [...STAT_KEYS].sort((a, b) => (range[b].min + range[b].max) - (range[a].min + range[a].max) || STAT_KEYS.indexOf(a) - STAT_KEYS.indexOf(b)).slice(0, 2);
}

/** REQ-PED-009/010: both trees, the shared ancestors (= inbreedingCount), nick and the inheritance hints from previewFor. */
export function breedingPedigree(m: Master, s: PlayerState, sireId: string, damId: string, locale: Locale, now: number) {
  const sire = getHorse(s, sireId);
  const dam = getHorse(s, damId);
  if (sire.status !== 'retired' || dam.status !== 'retired') throw new AppError('HORSE_NOT_RETIRED');
  if (sire.sex !== 'male' || dam.sex !== 'female' || sire.id === dam.id) throw new AppError('BREEDING_INVALID_PAIR');
  const c = ctxFor(m, s, locale, true, now);
  const sireTree = liveNode(c, sire, 1, PED_VIEW_GENERATIONS);
  const damTree = liveNode(c, dam, 1, PED_VIEW_GENERATIONS);
  const shared = sharedBetween(sireTree, damTree);
  const set = new Set(shared);
  markShared(sireTree, set, PED_VIEW_GENERATIONS);
  markShared(damTree, set, PED_VIEW_GENERATIONS);
  const count = inbreedingCount(s, sire, dam);
  const pv = previewFor(m, s, sire, dam, [...parentTraits(s, sire), ...parentTraits(s, dam)]);
  const nick = isNick(m, sire, dam);
  const cat = catalogFor(m);
  const L = (l: Loc) => pick(l, locale);
  const hints: { kind: string; hintText: string; permille?: number; value?: number }[] = [];
  const lineName = lineNameOf(m, sire.line, locale);
  hints.push({ kind: 'line', hintText: fill(L(HINT.line!), { line: lineName }) });
  if (nick) hints.push({ kind: 'nick', hintText: fill(L(HINT.nick!), { n: m.nicks.bonus }), value: m.nicks.bonus });
  for (const k of topStats(pv.stats)) hints.push({ kind: 'stat', hintText: fill(L(HINT.stat!), { stat: L(STAT_LABEL[k]), min: pv.stats[k].min, max: pv.stats[k].max }), value: pv.stats[k].max });
  // style odds are percentages in the preview (45 + 45 + 2.5 × 4): shown as they are, highest first
  const styles = (Object.entries(pv.styles) as [Style, number][]).filter(([, p]) => p >= 10).sort((a, b) => b[1] - a[1]);
  for (const [st, p] of styles) hints.push({ kind: 'style', hintText: fill(L(HINT.style!), { style: L(STYLE_LABEL[st]), p: fmtPct(p * 10) }), permille: p * 10 });
  for (const g of ['fast', 'heavy'] as const) if (pv.goingAptitude[g] > 0) hints.push({ kind: 'going', hintText: fill(L(HINT.going!), { going: L(GOING_LABEL[g]), p: fmtPct(pv.goingAptitude[g]) }), permille: pv.goingAptitude[g] });
  for (const sk of pv.skill.candidates) hints.push({ kind: 'skill', hintText: fill(L(HINT.skill!), { skill: textIn(locale, sk.name, cat), p: fmtPct(sk.permille) }), permille: sk.permille });
  for (const a of pv.atavism.candidates) {
    const value = a.trait === 'style' ? L(STYLE_LABEL[a.value as Style] ?? { ja: a.value, en: a.value }) : L(GOING_LABEL[a.value as GoingAptitude] ?? { ja: a.value, en: a.value });
    hints.push({ kind: 'atavism', hintText: fill(L(HINT.atavism!), { from: textIn(locale, a.from, cat), value, p: fmtPct(a.permille) }), permille: a.permille });
  }
  if (count > 0) hints.push({ kind: 'inbreeding', hintText: fill(L(HINT.inbreeding!), { n: count, p: count * BREED.inbreedingPenalty }), value: count });
  const named = new Map<string, string>();
  walk(sireTree, (n) => { if (set.has(n.key)) named.set(n.key, n.name); });
  walk(damTree, (n) => { if (set.has(n.key)) named.set(n.key, n.name); });
  return {
    sire: sireTree, dam: damTree,
    sharedKeys: shared,
    shared: shared.map((k) => ({ key: k, name: named.get(k) ?? '' })),
    inbreeding: { count, penaltyPerAncestor: BREED.inbreedingPenalty, statPenalty: count * BREED.inbreedingPenalty },
    nick: { on: nick, bonus: nick ? m.nicks.bonus : 0 },
    hints,
    line: { id: sire.line, lineName },
    notice: T.pairNotice,
    /** owner ids of borrowed stallions in the trees (internal: removed by finishBreedingPedigree). */
    owners: [...new Set(c.studOwners.values())],
  };
}
export type BreedingPedigreeDraft = ReturnType<typeof breedingPedigree>;

/** The pair body: stud owner names applied (own stallions and friends only, REQ-PED-005), owner ids dropped, keys anonymized. */
export function finishBreedingPedigree(d: BreedingPedigreeDraft, owners: OwnerNames) {
  const keyMap = new Map<string, string>();
  const { owners: _ids, ...body } = d;
  void _ids;
  applyOwners(body.sire, owners, keyMap);
  applyOwners(body.dam, owners, keyMap);
  return {
    ...body,
    sharedKeys: body.sharedKeys.map((k) => anonymize(keyMap, k)),
    shared: body.shared.map((x) => ({ key: anonymize(keyMap, x.key), name: x.name })),
  };
}

// ------------------------------------------------------------------------------------------------ bloodlines

export const BLOODLINE_HORSES_MAX = 50;

/** REQ-PED-011..013: per-line counts in my stable, nick partners and the rules. No reward, no "complete" state. */
export function bloodlinesView(m: Master, s: PlayerState, locale: Locale) {
  const bm = bloodlinesOf(m);
  const known = new Set(bm.lines.map((l) => l.id));
  const lines = bm.lines.map((l) => {
    const hs = s.horses.filter((h) => h.line === l.id);
    const nickWith = [
      ...m.nicks.pairs.filter(([a]) => a === l.id).map(([, b]) => ({ id: b, lineName: lineNameOf(m, b, locale), role: 'dam' as const, bonus: m.nicks.bonus })),
      ...m.nicks.pairs.filter(([, b]) => b === l.id).map(([a]) => ({ id: a, lineName: lineNameOf(m, a, locale), role: 'sire' as const, bonus: m.nicks.bonus })),
    ];
    return {
      id: l.id, lineName: pick({ ja: l.ja, en: l.en }, locale), founderName: pick(l.founder, locale), note: pick(l.note, locale),
      count: hs.length, active: hs.filter((h) => h.status === 'active').length, retired: hs.filter((h) => h.status === 'retired').length,
      nickWith,
      horses: hs.slice(0, BLOODLINE_HORSES_MAX).map((h) => ({ horseId: h.id, name: h.name, sex: h.sex, status: h.status, rarity: h.rarity })),
    };
  });
  return {
    lines,
    total: s.horses.length,
    /** horses whose line is not in the master (a remote config removed it): counted, never hidden. */
    unlisted: s.horses.filter((h) => !known.has(h.line)).length,
    rules: { lineFromSire: true, nickBonus: m.nicks.bonus, inbreedingPenalty: BREED.inbreedingPenalty, generations: PED_VIEW_GENERATIONS },
    notice: T.notice,
  };
}

// ------------------------------------------------------------------------------------------------ orchestration

/** What PedigreeService needs from the rest of the server (PlayerDO RPC + the directory in production, PlayerService in tests). */
export interface PedigreePorts {
  mine(u: string, horseId: string, locale: Locale): Promise<PedigreeDraft>;
  /** Run in the owner's object (pedigreePublic): NOT_FOUND unless the horse is shown publicly now. */
  publicOf(owner: string, horseId: string, locale: Locale, relation: 'friend' | 'other'): Promise<PedigreeDraft>;
  pair(u: string, sireId: string, damId: string, locale: Locale): Promise<BreedingPedigreeDraft>;
  viewer(u: string): Promise<{ friendIds: string[]; blocked: string[] }>;
  blocks(u: string): Promise<string[]>;
  profiles(ids: string[]): Promise<{ playerId: string; displayName: string; banned?: boolean }[]>;
}

export class PedigreeService {
  constructor(private readonly p: PedigreePorts, private readonly master: () => Master) {}

  /**
   * REQ-PED-005: a borrowed stallion's owner is named only for the viewer themself or a friend the viewer has not blocked, with
   * a public profile that is not banned. Everyone else → null (「他のトレーナーの馬」).
   */
  private async ownerNames(u: string, ids: string[], viewer?: { friendIds: string[]; blocked: string[] }): Promise<OwnerNames> {
    const out: OwnerNames = {};
    if (ids.length === 0) return out;
    const v = viewer ?? await this.p.viewer(u);
    const allowed = ids.filter((id) => id === u || (v.friendIds.includes(id) && !v.blocked.includes(id)));
    const profiles = allowed.length ? await this.p.profiles(allowed) : [];
    for (const id of ids) {
      const pr = profiles.find((x) => x.playerId === id);
      out[id] = pr && !pr.banned ? { name: pr.displayName, self: id === u } : null;
    }
    return out;
  }

  /** GET /v1/horses/:horseId/pedigree[?playerId] (REQ-PED-003..008). */
  async horse(u: string, horseId: string, target: string | null, locale: Locale) {
    const m = this.master();
    if (!target || target === u) {
      const d = await this.p.mine(u, horseId, locale);
      return finishPedigree(m, d, await this.ownerNames(u, d.owners), locale);
    }
    const hidden = () => new AppError('NOT_FOUND', 'this horse is not shown');
    const [profile] = await this.p.profiles([target]);
    if (!profile || profile.playerId !== target || profile.banned) throw hidden();
    const [v, theirs] = await Promise.all([this.p.viewer(u), this.p.blocks(target)]);
    if (v.blocked.includes(target) || theirs.includes(u)) throw hidden();
    const d = await this.p.publicOf(target, horseId, locale, v.friendIds.includes(target) ? 'friend' : 'other');
    return finishPedigree(m, d, await this.ownerNames(u, d.owners, v), locale);
  }

  /** GET /v1/breeding/pedigree (REQ-PED-009/010). */
  async pair(u: string, sireId: string, damId: string, locale: Locale) {
    const d = await this.p.pair(u, sireId, damId, locale);
    return finishBreedingPedigree(d, await this.ownerNames(u, d.owners));
  }
}
