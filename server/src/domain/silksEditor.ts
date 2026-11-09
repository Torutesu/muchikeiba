/**
 * 勝負服エディタ (REQ-SILK-001..016, contracts/protocol.md §35).
 *
 * Silks are composed from parts: body pattern, body colours, sleeve pattern, cap pattern and cap colours. Parts are
 * free, earned by a fixed play condition (achievement tier, race count), unlocked by an item (sold directly as a
 * `silks_part` cosmetic, or granted by a product / pass / exchange) — never drawn at random. Everything here is looks
 * only: nothing reaches the race simulation, the hashed race config or the result hash.
 *
 * A design travels as a compact deterministic code (`1` + eight base-36 pairs, see encodeSilksCode) built from fixed
 * per-part numbers, so every client draws the same silks; legacy `{ pattern, colors, cap }` silks read as a design too.
 */
import editorJson from '../../master/silks-editor.json';
import { BASE_BANNED_SILKS, bannedMatch, combinedBanned, type BannedSilksList } from './bannedSilks.js';
import { collectionOf, tierReached } from './collection.js';
import { AppError } from './errors.js';
import type { CosmeticDef, Master } from './master.js';
import type { PlayerState } from './player.js';
import { assetKeys, defaultSilks, VISUALS, type Silks, type VisualsMaster } from './visuals.js';

// ------------------------------------------------------------------------------------------------ master

export type SilksPartType = 'pattern' | 'color' | 'sleeve' | 'cap';
export const SILKS_PART_TYPES: SilksPartType[] = ['pattern', 'color', 'sleeve', 'cap'];
export type SilksPartSource =
  | { kind: 'free' }
  | { kind: 'item'; itemId: string }
  | { kind: 'achievement'; achievementId: string; tier: number }
  | { kind: 'races'; count: number };
export interface SilksPartDef { id: string; code: number; name: string; source?: SilksPartSource }
export interface SilksColorDef extends SilksPartDef { hex?: string; base?: string }
export interface SilksEditorMaster {
  version: number;
  codeVersion: 1;
  presets: { max: number; nameMax: number };
  contrast: { minDeltaE: number };
  patterns: SilksPartDef[];
  colors: SilksColorDef[];
  sleeves: SilksPartDef[];
  caps: SilksPartDef[];
}

export const silksEditorOf = (m: Pick<Master, 'silksEditor'>): SilksEditorMaster => m.silksEditor ?? (editorJson as unknown as SilksEditorMaster);

/** Largest number a two-digit base-36 field holds; `zz` (1295) is reserved for "no third colour". */
export const SILKS_CODE_MAX = 36 * 36 - 2;
const NONE = 36 * 36 - 1;
export const SILKS_CODE_RE = /^1[0-9a-z]{16}$/;

// ------------------------------------------------------------------------------------------------ code (shared with C# SilksCode)

/** Eight numbers → `1` + eight two-digit base-36 fields (null third colour → `zz`). Throws on out-of-range numbers. */
export function encodeSilksCode(n: (number | null)[]): string {
  if (n.length !== 8) throw new AppError('BAD_REQUEST', 'a silks code has 8 fields');
  return '1' + n.map((x, i) => {
    if (x === null) { if (i !== 3) throw new AppError('BAD_REQUEST', 'only the third body colour may be empty'); return 'zz'; }
    if (!Number.isInteger(x) || x < 0 || x > SILKS_CODE_MAX) throw new AppError('BAD_REQUEST', `silks code field ${i} out of range`);
    return x.toString(36).padStart(2, '0');
  }).join('');
}

/** The eight numbers of a code (third colour null when `zz`), or null when the text is not a version-1 code. */
export function decodeSilksCode(code: string): (number | null)[] | null {
  if (typeof code !== 'string' || !SILKS_CODE_RE.test(code)) return null;
  const out: (number | null)[] = [];
  for (let i = 0; i < 8; i++) {
    const v = parseInt(code.slice(1 + i * 2, 3 + i * 2), 36);
    if (v === NONE) { if (i !== 3) return null; out.push(null); } else out.push(v);
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ design

export interface SilksDesign { pattern: string; colors: string[]; sleeve: string; cap: string; capColors: [string, string] }
export interface SilksPartRef { type: SilksPartType; id: string }

interface Tables {
  byId: Record<SilksPartType, Map<string, SilksColorDef>>;
  byCode: Record<SilksPartType, Map<number, SilksColorDef>>;
  hex: Map<string, string>;
  base: Map<string, string>;
  patternColors: Map<string, number>;
  lowContrast: [string, string][];
  lowContrastSet: Set<string>;
}
const tableCache = new WeakMap<object, Tables>();
const listOf = (e: SilksEditorMaster, t: SilksPartType): SilksColorDef[] => (t === 'pattern' ? e.patterns : t === 'color' ? e.colors : t === 'sleeve' ? e.sleeves : e.caps);

function tables(e: SilksEditorMaster, v: VisualsMaster = VISUALS): Tables {
  const hit = tableCache.get(e);
  if (hit) return hit;
  const byId = {} as Tables['byId'];
  const byCode = {} as Tables['byCode'];
  for (const t of SILKS_PART_TYPES) {
    byId[t] = new Map(listOf(e, t).map((p) => [p.id, p]));
    byCode[t] = new Map(listOf(e, t).map((p) => [p.code, p]));
  }
  const palette = new Map(v.palette.map((p) => [p.id, p.hex]));
  const hex = new Map<string, string>();
  const base = new Map<string, string>();
  for (const c of e.colors) {
    hex.set(c.id, c.hex ?? palette.get(c.id) ?? '#000000');
    base.set(c.id, c.base ?? c.id);
  }
  const patternColors = new Map(v.silks.patterns.map((p) => [p.id, p.colors]));
  const lowContrast: [string, string][] = [];
  const ids = e.colors.map((c) => c.id);
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
    if (deltaE76(hex.get(ids[i]!)!, hex.get(ids[j]!)!) < e.contrast.minDeltaE) lowContrast.push([ids[i]!, ids[j]!]);
  }
  const t: Tables = { byId, byCode, hex, base, patternColors, lowContrast, lowContrastSet: new Set(lowContrast.flatMap(([a, b]) => [`${a}|${b}`, `${b}|${a}`])) };
  tableCache.set(e, t);
  return t;
}

/** CIE76 ΔE between two #RRGGBB colours (sRGB → XYZ D65 → L*a*b*). Server only: clients get `lowContrastPairs`. */
export function deltaE76(a: string, b: string): number {
  const lab = (h: string) => {
    const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    const [r, g, bl] = [1, 3, 5].map((i) => lin(parseInt(h.slice(i, i + 2), 16) / 255)) as [number, number, number];
    const x = (r * 0.4124 + g * 0.3576 + bl * 0.1805) / 0.95047;
    const y = r * 0.2126 + g * 0.7152 + bl * 0.0722;
    const z = (r * 0.0193 + g * 0.1192 + bl * 0.9505) / 1.08883;
    const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
    return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))] as const;
  };
  const p = lab(a), q = lab(b);
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}

/** REQ-SILK-001: legacy silks as a design (sleeves like the body, cap in body colours 1 and 2). */
export function legacyToDesign(s: Silks): SilksDesign {
  return {
    pattern: s.pattern, colors: [...s.colors], sleeve: s.sleeve ?? 'match', cap: s.cap,
    capColors: s.capColors ? [s.capColors[0], s.capColors[1]] : [s.colors[0] ?? 'white', s.colors[1] ?? 'navy'],
  };
}

/** Shape check (REQ-SILK-007): known parts, colour count of the pattern, not one colour only. Returns a clean copy. */
export function checkDesign(m: Pick<Master, 'silksEditor'>, d: SilksDesign, v: VisualsMaster = VISUALS): SilksDesign {
  const e = silksEditorOf(m);
  const t = tables(e, v);
  if (!d || typeof d !== 'object') throw new AppError('BAD_REQUEST', 'design is required');
  if (!t.byId.pattern.has(d.pattern)) throw new AppError('BAD_REQUEST', `unknown silks pattern ${d.pattern}`);
  const need = t.patternColors.get(d.pattern) ?? 2;
  if (!Array.isArray(d.colors) || d.colors.length !== need) throw new AppError('BAD_REQUEST', `pattern ${d.pattern} takes ${need} colours`);
  for (const c of d.colors) if (!t.byId.color.has(c)) throw new AppError('BAD_REQUEST', `unknown colour ${c}`);
  if (new Set(d.colors).size < 2) throw new AppError('BAD_REQUEST', 'use at least two different colours');
  if (!t.byId.sleeve.has(d.sleeve)) throw new AppError('BAD_REQUEST', `unknown sleeve ${d.sleeve}`);
  if (!t.byId.cap.has(d.cap)) throw new AppError('BAD_REQUEST', `unknown cap ${d.cap}`);
  if (!Array.isArray(d.capColors) || d.capColors.length !== 2 || !d.capColors.every((c) => t.byId.color.has(c))) throw new AppError('BAD_REQUEST', 'the cap takes two known colours');
  return { pattern: d.pattern, colors: [...d.colors], sleeve: d.sleeve, cap: d.cap, capColors: [d.capColors[0], d.capColors[1]] };
}

/** REQ-SILK-002: design → code (fixed per-part numbers). The design must pass checkDesign. */
export function designToCode(m: Pick<Master, 'silksEditor'>, d: SilksDesign): string {
  const t = tables(silksEditorOf(m));
  const n = (type: SilksPartType, id: string) => t.byId[type].get(id)!.code;
  return encodeSilksCode([n('pattern', d.pattern), n('color', d.colors[0]!), n('color', d.colors[1]!), d.colors[2] === undefined ? null : n('color', d.colors[2]),
    n('sleeve', d.sleeve), n('cap', d.cap), n('color', d.capColors[0]), n('color', d.capColors[1])]);
}

/** REQ-SILK-002: code → design (400 on a malformed code or an unknown part number). */
export function codeToDesign(m: Pick<Master, 'silksEditor'>, code: string, v: VisualsMaster = VISUALS): SilksDesign {
  const n = decodeSilksCode(code);
  if (!n) throw new AppError('BAD_REQUEST', 'malformed silks code');
  const t = tables(silksEditorOf(m), v);
  const id = (type: SilksPartType, x: number | null) => {
    const p = x === null ? undefined : t.byCode[type].get(x);
    if (!p) throw new AppError('BAD_REQUEST', `unknown ${type} in silks code`);
    return p.id;
  };
  const pattern = id('pattern', n[0]!);
  const colors = [id('color', n[1]!), id('color', n[2]!)];
  if ((t.patternColors.get(pattern) ?? 2) === 3) colors.push(id('color', n[3]!));
  else if (n[3] !== null) throw new AppError('BAD_REQUEST', `pattern ${pattern} takes 2 colours`);
  return checkDesign(m, { pattern, colors, sleeve: id('sleeve', n[4]!), cap: id('cap', n[5]!), capColors: [id('color', n[6]!), id('color', n[7]!)] }, v);
}

/** The design a stored Silks stands for: its code when it has one that still decodes, else the legacy reading. */
export function designOfSilks(m: Pick<Master, 'silksEditor'>, s: Silks): SilksDesign {
  if (s.code) { try { return codeToDesign(m, s.code); } catch { /* master changed: fall back to the legacy keys */ } }
  return legacyToDesign(s);
}

/** REQ-SILK-002: the code of any silks (legacy silks get one too). Null only if a legacy id is unknown to the editor. */
export function silksCodeOf(m: Pick<Master, 'silksEditor'>, s: Silks): string | null {
  if (s.code && decodeSilksCode(s.code)) return s.code;
  try { return designToCode(m, checkDesign(m, legacyToDesign(s))); } catch { return null; }
}

/**
 * REQ-SILK-003: what the player stores and others receive. Legacy keys stay a close match for older clients (special
 * colours as their base colour); `code` carries the full design.
 */
export function silksOfDesign(m: Pick<Master, 'silksEditor'>, d: SilksDesign): Silks {
  const t = tables(silksEditorOf(m));
  const b = (c: string) => t.base.get(c) ?? c;
  return { pattern: d.pattern, colors: d.colors.map(b), cap: d.cap, sleeve: d.sleeve, capColors: [b(d.capColors[0]), b(d.capColors[1])], code: designToCode(m, d) };
}

export const partsOfDesign = (d: SilksDesign): SilksPartRef[] => {
  const out: SilksPartRef[] = [{ type: 'pattern', id: d.pattern }];
  for (const c of new Set([...d.colors, ...d.capColors])) out.push({ type: 'color', id: c });
  out.push({ type: 'sleeve', id: d.sleeve }, { type: 'cap', id: d.cap });
  return out;
};

/** For the shop's `equipped` flag (itemShop.cosmeticsCatalog). */
export function designUsesPart(m: Master, s: Silks | undefined, type: SilksPartType, id: string): boolean {
  if (!s) return false;
  const d = designOfSilks(m, s);
  return partsOfDesign(d).some((p) => p.type === type && p.id === id);
}

// ------------------------------------------------------------------------------------------------ ownership

/** Where a part comes from. Body patterns: visuals.json unlockItem; other parts: silks-editor.json `source`. */
export function sourceOf(m: Pick<Master, 'silksEditor'>, type: SilksPartType, id: string, v: VisualsMaster = VISUALS): SilksPartSource {
  if (type === 'pattern') {
    const u = v.silks.patterns.find((p) => p.id === id)?.unlockItem;
    return u ? { kind: 'item', itemId: u } : { kind: 'free' };
  }
  return tables(silksEditorOf(m), v).byId[type].get(id)?.source ?? { kind: 'free' };
}

/** REQ-SILK-004: owned = free, or the item is held, or the achievement tier was reached, or enough races. */
export function ownsPart(m: Pick<Master, 'silksEditor'>, s: PlayerState, type: SilksPartType, id: string): boolean {
  const src = sourceOf(m, type, id);
  switch (src.kind) {
    case 'free': return true;
    case 'item': return (s.items[src.itemId] ?? 0) > 0;
    case 'achievement': return tierReached(s, src.achievementId, src.tier);
    case 'races': return s.stats.races >= src.count;
  }
}

export const lockedParts = (m: Pick<Master, 'silksEditor'>, s: PlayerState, d: SilksDesign) => partsOfDesign(d).filter((p) => !ownsPart(m, s, p.type, p.id));

// ------------------------------------------------------------------------------------------------ readability & reserved silks

export type SilksProblem = 'LOW_CONTRAST' | 'RESERVED';
export const PROBLEM_TEXT: Record<SilksProblem, string> = {
  LOW_CONTRAST: '色が近すぎて見分けにくい組み合わせです（胴の1色目と2色目、帽子の2色）',
  RESERVED: '実在の勝負服と同じ（または紛らわしい）組み合わせのため使えません',
};

/** REQ-SILK-008: body colours 1/2 and the two cap colours must be at least `contrast.minDeltaE` apart. */
export function lowContrast(m: Pick<Master, 'silksEditor'>, d: SilksDesign): boolean {
  const t = tables(silksEditorOf(m));
  return t.lowContrastSet.has(`${d.colors[0]}|${d.colors[1]}`) || t.lowContrastSet.has(`${d.capColors[0]}|${d.capColors[1]}`);
}

/** REQ-SILK-009: the composed result against the active banned list (special colours by their base colour). */
export function reservedDesign(m: Pick<Master, 'silksEditor' | 'bannedSilks'>, d: SilksDesign, v: VisualsMaster = VISUALS): boolean {
  const list: BannedSilksList = m.bannedSilks ?? BASE_BANNED_SILKS;
  return bannedMatch(combinedBanned(list, v), silksOfDesign(m, d)) !== null;
}

export function designProblems(m: Pick<Master, 'silksEditor' | 'bannedSilks'>, d: SilksDesign): SilksProblem[] {
  const out: SilksProblem[] = [];
  if (lowContrast(m, d)) out.push('LOW_CONTRAST');
  if (reservedDesign(m, d)) out.push('RESERVED');
  return out;
}

/** The full check before anything is saved or equipped (REQ-SILK-007..009). Returns the clean design. */
export function validateDesign(m: Master, s: PlayerState, input: SilksDesign): SilksDesign {
  const d = checkDesign(m, input);
  const locked = lockedParts(m, s, d);
  if (locked.length) throw new AppError('NOT_ELIGIBLE', `parts not owned: ${locked.map((p) => `${p.type}:${p.id}`).join(', ')}`, undefined, { locked });
  const problems = designProblems(m, d);
  if (problems.length) throw new AppError('BAD_REQUEST', problems[0] === 'LOW_CONTRAST' ? 'colours too close to tell apart' : 'this combination is reserved', undefined, { problem: problems[0] });
  return d;
}

// ------------------------------------------------------------------------------------------------ state

export interface SilksPresetState { slot: number; name: string; code: string; savedAt: number }
export interface SilksEditorState { presets: SilksPresetState[]; resetNotice: { at: number; reason: 'refund' } | null }

const peek = (s: PlayerState): SilksEditorState | undefined => (s as PlayerState & { silksEditor?: SilksEditorState }).silksEditor;
function ensure(s: PlayerState): SilksEditorState {
  const x = s as PlayerState & { silksEditor?: SilksEditorState };
  x.silksEditor ??= { presets: [], resetNotice: null };
  return x.silksEditor;
}

/** Input of PUT /v1/silks and the preset writes: exactly one of a design or a code. */
export type DesignInput = { design: SilksDesign } | { code: string };
export function designFromInput(m: Master, input: DesignInput): SilksDesign {
  if ('code' in input && typeof input.code === 'string') return codeToDesign(m, input.code);
  if ('design' in input && input.design) return checkDesign(m, input.design);
  throw new AppError('BAD_REQUEST', 'send a design or a code');
}

const currentSilks = (s: PlayerState): Silks => s.profile.silks ?? defaultSilks(`p:${s.id}`);

/** REQ-SILK-012 PUT /v1/silks (and preset apply): equip. Returns whether the equipped code changed (for the KPI). */
export function equipDesign(m: Master, s: PlayerState, input: SilksDesign): { design: SilksDesign; code: string; silks: Silks; changed: boolean } {
  const d = validateDesign(m, s, input);
  const silks = silksOfDesign(m, d);
  const changed = silksCodeOf(m, currentSilks(s)) !== silks.code;
  s.profile.silks = silks;
  return { design: d, code: silks.code!, silks, changed };
}

export const nonFreeParts = (m: Master, d: SilksDesign) => partsOfDesign(d).filter((p) => sourceOf(m, p.type, p.id).kind !== 'free').length;

/** REQ-SILK-011: private preset names — trimmed, 1..nameMax characters, no control characters. Empty → "プリセット{n}". */
const PRESET_NAME_BAD = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u2028-\\u202e\\u2066-\\u2069]');
function presetName(m: Master, raw: string | undefined, slot: number): string {
  const max = silksEditorOf(m).presets.nameMax;
  const name = (raw ?? '').normalize('NFC').trim();
  if (name === '') return `プリセット${slot + 1}`;
  // control, zero-width, bidi-override and line/paragraph separator characters
  if (PRESET_NAME_BAD.test(name)) throw new AppError('BAD_REQUEST', 'preset name has control characters');
  if ([...name].length > max) throw new AppError('BAD_REQUEST', `preset name is at most ${max} characters`);
  return name;
}

export function createPreset(m: Master, s: PlayerState, name: string | undefined, input: SilksDesign, now: number) {
  const d = validateDesign(m, s, input);
  const st = ensure(s);
  const max = silksEditorOf(m).presets.max;
  let slot = -1;
  for (let i = 0; i < max; i++) if (!st.presets.some((p) => p.slot === i)) { slot = i; break; }
  if (slot < 0) throw new AppError('CONFLICT', `all ${max} preset slots are used`);
  st.presets.push({ slot, name: presetName(m, name, slot), code: designToCode(m, d), savedAt: now });
  st.presets.sort((a, b) => a.slot - b.slot);
  return slot;
}

function findPreset(s: PlayerState, slot: number): SilksPresetState {
  const p = peek(s)?.presets.find((x) => x.slot === slot);
  if (!p) throw new AppError('NOT_FOUND', `preset ${slot}`);
  return p;
}

export function updatePreset(m: Master, s: PlayerState, slot: number, name: string | undefined, input: SilksDesign | null, now: number) {
  const p = findPreset(s, slot);
  if (input) p.code = designToCode(m, validateDesign(m, s, input));
  if (name !== undefined) p.name = presetName(m, name, slot);
  p.savedAt = now;
}

export function deletePreset(s: PlayerState, slot: number) {
  findPreset(s, slot);
  const st = ensure(s);
  st.presets = st.presets.filter((x) => x.slot !== slot);
}

export function presetDesign(m: Master, s: PlayerState, slot: number): SilksDesign {
  return codeToDesign(m, findPreset(s, slot).code);
}

export function clearResetNotice(s: PlayerState) {
  const st = peek(s);
  if (st?.resetNotice) st.resetNotice = null;
}

/**
 * REQ-SILK-010: after a store refund took items back. If the equipped silks use a part the player no longer has, they
 * go back to the player's default silks (with a one-time notice). Presets stay; the view marks them unusable.
 */
export function revalidateEquippedSilks(m: Master, s: PlayerState, now: number): boolean {
  const cur = s.profile.silks;
  if (!cur) return false;
  let d: SilksDesign;
  try { d = checkDesign(m, designOfSilks(m, cur)); } catch { return false; }
  if (lockedParts(m, s, d).length === 0) return false;
  s.profile.silks = defaultSilks(`p:${s.id}`, VISUALS, m.bannedSilks ?? BASE_BANNED_SILKS);
  ensure(s).resetNotice = { at: now, reason: 'refund' };
  return true;
}

// ------------------------------------------------------------------------------------------------ views

const fmt = (n: number) => n.toLocaleString('en-US');

function cosmeticFor(m: Master, itemId: string): CosmeticDef | undefined {
  return m.items.cosmetics.find((c) => c.id === itemId);
}

/** Server-made line for how a part is obtained (REQ-SILK-004; English via CODE_EN). */
export function sourceLabel(m: Master, src: SilksPartSource): string {
  switch (src.kind) {
    case 'free': return '最初から使える';
    case 'item': {
      const c = cosmeticFor(m, src.itemId);
      if (!c || c.notForSale) return '商品・報酬で入手';
      return c.currency === 'paidOnly' ? `有償コイン${fmt(c.price)}で購入` : `コイン${fmt(c.price)}で購入`;
    }
    case 'achievement': {
      const a = collectionOf(m).achievements.find((x) => x.id === src.achievementId);
      return `実績「${a?.name ?? src.achievementId}」の${src.tier}段目で解放`;
    }
    case 'races': return `レースを${fmt(src.count)}回走ると解放`;
  }
}

function shopOf(m: Master, src: SilksPartSource) {
  if (src.kind !== 'item') return null;
  const c = cosmeticFor(m, src.itemId);
  if (!c) return null;
  return { itemId: c.id, price: c.price, currency: c.currency, forSale: !c.notForSale };
}

function partView(m: Master, s: PlayerState, type: SilksPartType, p: SilksColorDef) {
  const t = tables(silksEditorOf(m));
  const src = sourceOf(m, type, p.id);
  const shop = shopOf(m, src);
  return {
    id: p.id, code: p.code, name: p.name,
    ...(type === 'pattern' ? { colors: t.patternColors.get(p.id) ?? 2, asset: assetKeys.silksPattern(p.id) } : {}),
    ...(type === 'color' ? { hex: t.hex.get(p.id)!, base: t.base.get(p.id)! } : {}),
    ...(type === 'sleeve' ? { asset: assetKeys.silksSleeve(p.id) } : {}),
    ...(type === 'cap' ? { asset: assetKeys.silksCap(p.id) } : {}),
    owned: ownsPart(m, s, type, p.id), source: src, sourceLabel: sourceLabel(m, src),
    ...(shop ? { shop } : {}),
  };
}

function lockedView(m: Master, s: PlayerState, d: SilksDesign) {
  const t = tables(silksEditorOf(m));
  return lockedParts(m, s, d).map((p) => {
    const src = sourceOf(m, p.type, p.id);
    const shop = shopOf(m, src);
    return { type: p.type, id: p.id, name: t.byId[p.type].get(p.id)!.name, sourceLabel: sourceLabel(m, src), ...(shop ? { shop } : {}) };
  });
}

export const EDITOR_NOTICE = '見た目のみ。ランク戦の能力には影響しません。パーツは抽選ではありません（固定の価格・条件）。';
export const RESET_NOTICE_TEXT = '返金によりパーツが取り消されたため、勝負服を初期の柄に戻しました';

function presetsView(m: Master, s: PlayerState) {
  return (peek(s)?.presets ?? []).map((p) => {
    let design: SilksDesign | null = null;
    try { design = codeToDesign(m, p.code); } catch { /* a part left the master */ }
    const missing = design ? lockedView(m, s, design) : [];
    return { slot: p.slot, name: p.name, code: p.code, design, savedAt: p.savedAt, usable: !!design && missing.length === 0, missing };
  });
}

/** REQ-SILK-012 GET /v1/silks/editor. */
export function silksEditorView(m: Master, s: PlayerState) {
  const e = silksEditorOf(m);
  const t = tables(e);
  const cur = currentSilks(s);
  let design = designOfSilks(m, cur);
  let code: string | null;
  try { design = checkDesign(m, design); code = designToCode(m, design); } catch { code = null; }
  const notice = peek(s)?.resetNotice ?? null;
  return {
    version: e.version, codeVersion: e.codeVersion, notice: EDITOR_NOTICE,
    contrast: { minDeltaE: e.contrast.minDeltaE }, lowContrastPairs: t.lowContrast,
    parts: {
      patterns: e.patterns.map((p) => partView(m, s, 'pattern', p)),
      colors: e.colors.map((p) => partView(m, s, 'color', p)),
      sleeves: e.sleeves.map((p) => partView(m, s, 'sleeve', p)),
      caps: e.caps.map((p) => partView(m, s, 'cap', p)),
    },
    current: { design, code, silks: cur, resetNotice: notice ? { ...notice, message: RESET_NOTICE_TEXT } : null },
    presets: presetsView(m, s), maxPresets: e.presets.max, presetNameMax: e.presets.nameMax,
    wallet: { free: s.wallet.free, paid: s.wallet.paid },
  };
}

/** REQ-SILK-006 POST /v1/silks/preview: try before buying (no state change; parts need not be owned). */
export function previewDesign(m: Master, s: PlayerState, input: SilksDesign) {
  const d = checkDesign(m, input);
  const locked = lockedView(m, s, d);
  const totalPrice = { any: 0, paidOnly: 0 };
  for (const l of locked) if (l.shop?.forSale) totalPrice[l.shop.currency] += l.shop.price;
  const problems = designProblems(m, d).map((p) => ({ problem: p, message: PROBLEM_TEXT[p] }));
  return { design: d, code: designToCode(m, d), silks: silksOfDesign(m, d), owned: locked.length === 0, locked, totalPrice, problems, savable: locked.length === 0 && problems.length === 0 };
}

/** The part a `silks_part` / `silks` cosmetic unlocks (REQ-SILK-005), or null for other cosmetics. */
export function partOfCosmetic(c: CosmeticDef): SilksPartRef | null {
  if (c.kind === 'silks_part') return { type: c.part, id: c.ref };
  if (c.kind === 'silks') return { type: 'pattern', id: c.pattern };
  return null;
}

// ------------------------------------------------------------------------------------------------ master checks

/** REQ-SILK-013: consistency of master/silks-editor.json (boot, tests and remote config). */
export function silksEditorProblems(m: Master, e: SilksEditorMaster = silksEditorOf(m), v: VisualsMaster = VISUALS): string[] {
  const p: string[] = [];
  if (e.codeVersion !== 1) p.push('silksEditor.codeVersion must be 1');
  if (!Number.isInteger(e.presets?.max) || e.presets.max < 1 || e.presets.max > 10) p.push('silksEditor.presets.max must be 1..10');
  if (!Number.isInteger(e.presets?.nameMax) || e.presets.nameMax < 1 || e.presets.nameMax > 24) p.push('silksEditor.presets.nameMax must be 1..24');
  if (!(typeof e.contrast?.minDeltaE === 'number' && e.contrast.minDeltaE >= 0 && e.contrast.minDeltaE <= 60)) p.push('silksEditor.contrast.minDeltaE must be 0..60');
  const palette = new Map(v.palette.map((x) => [x.id, x.hex]));
  const ach = new Map(collectionOf(m).achievements.map((a) => [a.id, a]));
  const sold = new Map(m.items.cosmetics.map((c) => [c.id, c]));
  for (const t of SILKS_PART_TYPES) {
    const list = listOf(e, t);
    const ids = new Set<string>(); const codes = new Set<number>();
    for (const x of list) {
      if (!/^[a-z0-9_]{1,32}$/.test(x.id)) p.push(`${t} ${x.id}: bad id`);
      if (ids.has(x.id)) p.push(`${t} ${x.id}: duplicate id`);
      ids.add(x.id);
      if (!Number.isInteger(x.code) || x.code < 0 || x.code > SILKS_CODE_MAX) p.push(`${t} ${x.id}: code must be 0..${SILKS_CODE_MAX}`);
      if (codes.has(x.code)) p.push(`${t} ${x.id}: duplicate code ${x.code}`);
      codes.add(x.code);
      if (typeof x.name !== 'string' || x.name.length < 1 || x.name.length > 16) p.push(`${t} ${x.id}: name must be 1..16 characters`);
      const src = x.source;
      if (t === 'pattern' && src) p.push(`pattern ${x.id}: body patterns unlock through visuals.json unlockItem, not source`);
      if (src?.kind === 'item') {
        const c = sold.get(src.itemId);
        if (c && (c.kind !== 'silks_part' || c.part !== t || c.ref !== x.id)) p.push(`${t} ${x.id}: cosmetic ${src.itemId} must be a silks_part for ${t}/${x.id}`);
      } else if (src?.kind === 'achievement') {
        const a = ach.get(src.achievementId);
        if (!a) p.push(`${t} ${x.id}: unknown achievement ${src.achievementId}`);
        else if (!a.tiers.some((y) => y.tier === src.tier)) p.push(`${t} ${x.id}: achievement ${src.achievementId} has no tier ${src.tier}`);
      } else if (src?.kind === 'races') {
        if (!Number.isInteger(src.count) || src.count < 1 || src.count > 100_000) p.push(`${t} ${x.id}: races.count must be 1..100000`);
      } else if (src && src.kind !== 'free') p.push(`${t} ${x.id}: unknown source kind`);
    }
  }
  // body patterns are exactly the visuals patterns (a pattern the editor cannot encode could not be shown to others)
  const vp = v.silks.patterns.map((x) => x.id).sort().join();
  if (e.patterns.map((x) => x.id).sort().join() !== vp) p.push('silksEditor.patterns must list exactly the visuals.json silks patterns');
  for (const c of e.colors) {
    if (palette.has(c.id)) {
      if (c.hex !== undefined && c.hex !== palette.get(c.id)) p.push(`color ${c.id}: hex differs from the palette`);
      if (c.base !== undefined && c.base !== c.id) p.push(`color ${c.id}: a palette colour is its own base`);
    } else {
      if (!c.hex || !/^#[0-9A-F]{6}$/.test(c.hex)) p.push(`color ${c.id}: a special colour needs hex #RRGGBB (upper case)`);
      if (!c.base || !palette.has(c.base)) p.push(`color ${c.id}: base must be a palette colour`);
    }
  }
  for (const id of palette.keys()) if (!e.colors.some((c) => c.id === id)) p.push(`palette colour ${id} is missing from the editor colours`);
  for (const id of v.silks.caps.map((x) => x.id)) if (!e.caps.some((c) => c.id === id)) p.push(`visuals cap ${id} is missing from the editor caps`);
  if (!e.sleeves.some((x) => x.id === 'match' && (x.source ?? { kind: 'free' }).kind === 'free')) p.push('silksEditor.sleeves needs a free "match"');
  // every silks_part cosmetic unlocks exactly one editor part that names it
  for (const c of m.items.cosmetics) {
    if (c.kind !== 'silks_part') continue;
    const part = listOf(e, c.part)?.find((x) => x.id === c.ref);
    if (!part) p.push(`cosmetic ${c.id}: unknown ${c.part} ${c.ref}`);
    else if (part.source?.kind !== 'item' || part.source.itemId !== c.id) p.push(`cosmetic ${c.id}: ${c.part} ${c.ref} must have source item ${c.id}`);
  }
  return p;
}
