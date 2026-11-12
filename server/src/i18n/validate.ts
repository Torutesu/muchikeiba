/**
 * REQ-L10N-004/005: every Japanese text of the player-facing master data has an English counterpart in the string
 * table — checked at boot (index.ts) and on every remote config version (ops/config.ts resolveBundle).
 */
import type { Master } from '../domain/master.js';
import { VISUALS, type VisualsMaster } from '../domain/visuals.js';
import { stableConfig } from '../domain/stable.js';
import { commentaryPacksOf } from '../domain/commentaryPacks.js';
import { CODE_EN } from './en.js';
import { EN_AD_BANNED, enWordingProblems, tableProblems } from './catalog.js';
import { hasJapanese } from './locale.js';

/**
 * Master sections that are not shown to players (internal word lists, the asset catalog, settings notes), and the
 * derived lookups. Keys starting with `_` are notes and are skipped everywhere.
 */
const INTERNAL_SECTIONS = new Set(['ng', 'bannedSilks', 'assetCatalog', 'nicks', 'ageLimits', 'templateById', 'litTracks', 'locale',
  // REQ-HELP-001: the help articles carry their own English side by side (checked by help.ts helpProblems)
  'help',
  // REQ-QCHAT-001: quick chat phrases are JA + EN pairs of their own (checked by quickChat.ts quickChatProblems)
  'quickChat',
  // REQ-TUT-010: the tip cards carry their own English side by side (checked by tips.ts tipsProblems)
  'tips',
  // REQ-SHOW-002 (§62): the showcase phrases and background names are JA + EN pairs of their own (checked by showcase.ts showcaseProblems)
  'showcase',
  // REQ-NEW-002: the release notes carry their own English side by side (checked by releaseNotes.ts releaseNotesProblems)
  'releaseNotes',
  // REQ-CAREER-010: 騎手の道 titles and story lines carry their own English side by side (checked by career.ts careerProblems)
  'career']);

/** Every Japanese text of the player-facing master data, with where it is. */
export function masterTexts(m: Master, v: VisualsMaster = VISUALS): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  const walk = (x: unknown, path: string) => {
    if (typeof x === 'string') { if (hasJapanese(x)) out.push({ path, text: x }); return; }
    if (Array.isArray(x)) { x.forEach((y, i) => walk(y, `${path}[${(y as { id?: string })?.id ?? i}]`)); return; }
    if (x && typeof x === 'object' && !(x instanceof Map) && !(x instanceof Set)) {
      for (const [k, y] of Object.entries(x)) if (!k.startsWith('_')) walk(y, `${path}.${k}`);
    }
  };
  for (const [k, x] of Object.entries(m)) if (!INTERNAL_SECTIONS.has(k)) walk(x, k);
  if (!m.stable) walk(stableConfig(m), 'stable'); // the shipped マイ厩舎 themes (master/stable.json)
  for (const [id, venue] of Object.entries(v.venues)) walk(venue.name, `visuals.venues.${id}.name`);
  // REQ-CMT-011: pack names and descriptions (the pack phrases are commentary, with their own English in the pack)
  for (const p of commentaryPacksOf(m).packs) { walk(p.name, `commentaryPacks.${p.id}.name`); walk(p.description, `commentaryPacks.${p.id}.description`); }
  return out;
}

/**
 * Problems of the master's English: a missing translation for any player-facing Japanese text, and table problems
 * (Japanese left in the English, placeholders that differ, the wording lint). A hand-built master without a table
 * (unit tests) is not checked.
 */
export function localeProblems(m: Master, v: VisualsMaster = VISUALS): string[] {
  if (!m.locale) return [];
  const table = m.locale.en ?? {};
  const out = tableProblems(table, 'locale.en');
  const missing = new Map<string, string>();
  for (const { path, text } of masterTexts(m, v)) if (table[text] === undefined && CODE_EN[text] === undefined && !missing.has(text)) missing.set(text, path);
  for (const [text, path] of missing) out.push(`locale.en: no English for ${path}「${text}」`);
  // REQ-AD-004 in English: an ad offer never says bonus / deal / guaranteed (stricter than the general lint)
  for (const p of m.progression.ads?.placements ?? []) {
    const e = table[p.title];
    if (e) for (const x of enWordingProblems(e, EN_AD_BANNED)) out.push(`locale.en: ad ${p.id} title「${e}」: ${x}`);
  }
  return out;
}

export function validateLocale(m: Master): void {
  const p = [...localeProblems(m), ...tableProblems(CODE_EN, 'i18n/en.ts')];
  if (p.length) throw new Error('localization: ' + p.join('; '));
}
