import bannedJson from '../../master/banned-silks.json';
import editorJson from '../../master/silks-editor.json';
import { z } from 'zod';
import type { Silks, VisualsMaster } from './visuals.js';

/**
 * REQ-ASSET-010 / REQ-OPS-040: real registered silks that players (and our defaults / remote config) must
 * never reproduce. The list lives in master/banned-silks.json (documented source + format) and can be
 * replaced by an admin import, which stages a remote-config version (validated + audited like any config).
 *
 * Matching is on a normalised signature: pattern aliases ("襷" → sash), colour aliases ("青" → blue) and
 * colour families (navy ≈ blue, maroon ≈ red, …) so a near-identical shade cannot slip past an exact match.
 */
/**
 * REQ-SILK-009: `sleeve` / `capColors` are optional extra conditions for the 勝負服エディタ result. When absent the entry
 * matches whatever the sleeves and cap colours are, so changing only the sleeves or the cap never escapes a reserved body.
 */
export interface BannedSilksEntry { id: string; source: string; description?: string; pattern: string; colors: string[]; cap?: string; sleeve?: string; capColors?: string[] }
export interface BannedSilksList {
  format: 1;
  patternAliases: Record<string, string>;
  colorAliases: Record<string, string>;
  colorFamilies: Record<string, string[]>;
  /**
   * QA r6 #7: two-colour patterns that look the same with the colours swapped (e.g. quartered blue/white vs
   * white/blue). For these, a banned entry also matches the reversed colour order.
   */
  symmetricPatterns?: string[];
  entries: BannedSilksEntry[];
}

/** Default when a list does not declare its own. */
export const DEFAULT_SYMMETRIC_PATTERNS = ['quartered', 'halves', 'hoops', 'stripes'];

export const bannedSilksEntrySchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/),
  source: z.string().trim().min(3).max(200),
  description: z.string().max(200).optional(),
  pattern: z.string().min(1).max(32),
  colors: z.array(z.string().min(1).max(16)).min(2).max(3),
  cap: z.string().min(1).max(32).optional(),
  sleeve: z.string().min(1).max(32).optional(),
  capColors: z.array(z.string().min(1).max(16)).length(2).optional(),
}).strict();
export const bannedSilksListSchema = z.object({
  format: z.literal(1),
  patternAliases: z.record(z.string(), z.string()).default({}),
  colorAliases: z.record(z.string(), z.string()).default({}),
  colorFamilies: z.record(z.string(), z.array(z.string())).default({}),
  symmetricPatterns: z.array(z.string()).optional(),
  entries: z.array(bannedSilksEntrySchema).max(5000),
});

const raw = bannedJson as unknown as Record<string, unknown>;
export const BASE_BANNED_SILKS: BannedSilksList = bannedSilksListSchema.parse({
  format: raw.format, patternAliases: raw.patternAliases, colorAliases: raw.colorAliases, colorFamilies: raw.colorFamilies, symmetricPatterns: raw.symmetricPatterns, entries: raw.entries,
}) as BannedSilksList;

const familyIndex = (l: BannedSilksList) => {
  const m = new Map<string, string>();
  for (const [fam, ids] of Object.entries(l.colorFamilies)) for (const id of ids) m.set(id, fam);
  return m;
};
const normPattern = (l: BannedSilksList, p: string) => l.patternAliases[p] ?? p;
const normColor = (l: BannedSilksList, c: string) => l.colorAliases[c] ?? c;

/** Family-level signature of silks: what "looks the same" on a racecourse. Cap is matched separately. */
export function silksSignature(l: BannedSilksList, pattern: string, colors: string[]): string {
  const fam = familyIndex(l);
  return `${normPattern(l, pattern)}|${colors.map((c) => { const id = normColor(l, c); return fam.get(id) ?? id; }).join(',')}`;
}

/** Entry that `s` collides with, or null. */
export function bannedMatch(l: BannedSilksList, s: Silks): BannedSilksEntry | null {
  const sig = silksSignature(l, s.pattern, s.colors);
  const symmetric = new Set((l.symmetricPatterns ?? DEFAULT_SYMMETRIC_PATTERNS).map((p) => normPattern(l, p)));
  for (const e of l.entries) {
    const sigs = [silksSignature(l, e.pattern, e.colors)];
    if (e.colors.length === 2 && symmetric.has(normPattern(l, e.pattern))) sigs.push(silksSignature(l, e.pattern, [e.colors[1]!, e.colors[0]!]));
    if (!sigs.includes(sig)) continue;
    if (e.cap !== undefined && e.cap !== s.cap) continue;
    // REQ-SILK-009: editor silks carry sleeve / capColors (legacy silks: sleeves like the body, cap in body colours 1 and 2)
    if (e.sleeve !== undefined && e.sleeve !== (s.sleeve ?? 'match')) continue;
    if (e.capColors !== undefined && silksSignature(l, '', e.capColors) !== silksSignature(l, '', s.capColors ?? [s.colors[0] ?? '', s.colors[1] ?? ''])) continue;
    return e;
  }
  return null;
}

/** Validation of a (base or imported) list against the visuals catalogue. */
export function bannedSilksProblems(l: BannedSilksList, v: VisualsMaster, editor: { caps: { id: string }[]; sleeves: { id: string }[] } = editorJson): string[] {
  const p: string[] = [];
  const patterns = new Map(v.silks.patterns.map((x) => [x.id, x]));
  const palette = new Set(v.palette.map((x) => x.id));
  const caps = new Set(v.silks.caps.map((x) => x.id));
  const editorCaps = new Set(editor.caps.map((x) => x.id));
  const editorSleeves = new Set(editor.sleeves.map((x) => x.id));
  for (const [k, to] of Object.entries(l.patternAliases)) if (!patterns.has(to)) p.push(`patternAliases.${k}: unknown pattern ${to}`);
  for (const [k, to] of Object.entries(l.colorAliases)) if (!palette.has(to)) p.push(`colorAliases.${k}: unknown colour ${to}`);
  for (const sp of l.symmetricPatterns ?? []) if (!patterns.has(normPattern(l, sp))) p.push(`symmetricPatterns: unknown pattern ${sp}`);
  const seenInFamily = new Set<string>();
  for (const [fam, ids] of Object.entries(l.colorFamilies)) for (const id of ids) {
    if (!palette.has(id)) p.push(`colorFamilies.${fam}: unknown colour ${id}`);
    if (seenInFamily.has(id)) p.push(`colorFamilies: ${id} is in more than one family`);
    seenInFamily.add(id);
  }
  const ids = new Set<string>();
  for (const e of l.entries) {
    if (ids.has(e.id)) p.push(`entries: duplicate id ${e.id}`);
    ids.add(e.id);
    const pat = patterns.get(normPattern(l, e.pattern));
    if (!pat) p.push(`entry ${e.id}: unknown pattern ${e.pattern}`);
    else if (pat.colors !== e.colors.length) p.push(`entry ${e.id}: pattern ${pat.id} takes ${pat.colors} colours`);
    for (const c of e.colors) if (!palette.has(normColor(l, c))) p.push(`entry ${e.id}: unknown colour ${c}`);
    if (e.cap !== undefined && !caps.has(e.cap) && !editorCaps.has(e.cap)) p.push(`entry ${e.id}: unknown cap ${e.cap}`);
    if (e.sleeve !== undefined && !editorSleeves.has(e.sleeve)) p.push(`entry ${e.id}: unknown sleeve ${e.sleeve}`);
    for (const c of e.capColors ?? []) if (!palette.has(normColor(l, c))) p.push(`entry ${e.id}: unknown cap colour ${c}`);
  }
  // our own guaranteed fallback for default silks must never be reserved
  if (bannedMatch(l, { pattern: 'plain', colors: ['white', 'navy'], cap: 'plain' })) p.push('the default fallback silks (plain white/navy) is on the banned list');
  return p;
}

/** Visuals' own static list (silks.banned) folded into the same shape, so one matcher covers both. */
export function combinedBanned(l: BannedSilksList, v: VisualsMaster): BannedSilksList {
  if (v.silks.banned.length === 0) return l;
  return { ...l, entries: [...l.entries, ...v.silks.banned.map((b, i) => ({ id: `visuals-${i}`, source: 'visuals.json silks.banned', pattern: b.pattern, colors: b.colors, ...(b.cap ? { cap: b.cap } : {}) }))] };
}
