/**
 * 実況パック (commentary packs, REQ-CMT-001..014, contracts/protocol.md §36).
 *
 * A pack only changes how the race commentary is worded (and voiced). The commentary is produced on the client
 * (C# `Muchi.Client.Commentator` + `CommentaryTemplates.WithPack`), so nothing here touches a race config, result,
 * hash or replay, and nothing sold here can change a ranked win rate (REQ-CMT-004).
 *
 * The server keeps: the catalog (server/master/commentary-packs.json, also copied to the client by
 * `npm run gen:client-locale`), which packs a player owns, the equipped pack, and the coin purchase (the same
 * `wallet.spend` as the cosmetics shop: paid coins first, paid-only packs use paid coins only).
 *
 * Legal (docs/planning/03): packs are acquired only by default / one fixed achievement tier / a fixed coin price —
 * no random draw, no time limit, no reward for completing a set. Pack texts never use betting words of 公営競技
 * (馬券, オッズ, 配当 …), the shop wording rules (倍, お得, 今だけ …) or real horse / race names (ng-names.json);
 * checked at boot (validateCommentaryPacks) and in tests.
 */
import packsJson from '../../master/commentary-packs.json';
import { AppError } from './errors.js';
import type { Master } from './master.js';
import type { PlayerState } from './player.js';
import type { Emit } from './service.js';
import { spend, type SpendResult } from './wallet.js';
import { collectionOf, metricValue, tierReached } from './collection.js';
import { EN_BANNED, enWordingProblems } from '../i18n/catalog.js';
import { hasJapanese } from '../i18n/locale.js';
import { BETTING_WORDS_EN, BETTING_WORDS_JA } from './bettingWords.js';

export interface PackVariant { id: string; text: string }
export type PackPhrases = Record<string, { variants: PackVariant[] }>;
export type PackAcquire =
  | { kind: 'default' }
  | { kind: 'achievement'; achievementId: string; tier: number }
  | { kind: 'coins'; price: number; currency: 'any' | 'paidOnly' };
export interface CommentaryPackDef {
  id: string;
  name: string;
  description: string;
  order: number;
  acquire: PackAcquire;
  /** Standard base kinds this pack speaks with the standard lines: exact kinds or `prefix*`. */
  fallback?: string[];
  phrases?: { ja?: PackPhrases; en?: PackPhrases };
}
export interface PackSampleEntrant {
  templateId: string; name: string; style: string; surface: string; distMinM: number; distMaxM: number;
  stats: { speed: number; stamina: number; burst: number; guts: number; temper: number };
}
export interface PackSample {
  seed: number;
  seconds: number;
  track: { id: string; surface: string; distanceM: number; segments: { kind: string; lengthM: number; radiusM?: number }[] };
  entrants: PackSampleEntrant[];
}
export interface CommentaryPacksMaster { version: number; standardPackId: string; sample: PackSample; packs: CommentaryPackDef[] }

export const COMMENTARY_PACKS: CommentaryPacksMaster = packsJson as unknown as CommentaryPacksMaster;
export const STANDARD_PACK_ID = 'standard';
export const EQUIP_SOURCES = ['settings', 'shop'] as const;
export type EquipSource = typeof EQUIP_SOURCES[number];
/** Placeholders the commentary templates know (same as Muchi.Client CommentaryTemplates.Split). */
export const PLACEHOLDERS = ['name', 'name2', 'name3', 'place', 'skill'] as const;
/** Upper bound on a coin price (a typo guard, not a business rule). */
export const MAX_PACK_PRICE = 5000;

/** Shop wording rules (docs/planning/03, 06 §5.5) — commentary never says them either. */
export const PACK_LEGAL_WORDS_JA = ['倍', 'お得', '今だけ', '残りわずか', '通常価格'];
/** Betting words of 公営競技: one shared list (bettingWords.ts), also read by the pre-race advice lint (§39). */
export { BETTING_WORDS_EN, BETTING_WORDS_JA } from './bettingWords.js';

/** The client copy (engine/Muchi.Client/Resources/Muchi/commentary-packs.json): the master file, byte for byte in content. */
export const commentaryPacksClientJson = () => JSON.stringify(COMMENTARY_PACKS, null, 1) + '\n';

export const commentaryPacksOf = (m: Pick<Master, 'commentaryPacks'>): CommentaryPacksMaster => m.commentaryPacks ?? COMMENTARY_PACKS;

export function findPack(m: Pick<Master, 'commentaryPacks'>, id: string): CommentaryPackDef {
  const p = commentaryPacksOf(m).packs.find((x) => x.id === id);
  if (!p) throw new AppError('NOT_FOUND', `commentary pack ${id}`);
  return p;
}

/** `{name}` … in order of appearance (the template splitter's rules). */
export function placeholdersOf(text: string): string[] {
  return [...text.matchAll(/\{([^{}]*)\}/g)].map((x) => x[1]!);
}

/** Wording problems of one commentary text (both the standard templates and every pack go through this). */
export function commentaryTextProblems(text: string, lang: 'ja' | 'en', ng?: Master['ng']): string[] {
  const out: string[] = [];
  if (text.trim() === '') return ['empty text'];
  if ((text.match(/\{/g) ?? []).length !== (text.match(/\}/g) ?? []).length) out.push('unbalanced braces');
  for (const ph of placeholdersOf(text)) if (!(PLACEHOLDERS as readonly string[]).includes(ph)) out.push(`unknown placeholder {${ph}}`);
  const plain = text.replace(/\{[^{}]*\}/g, '');
  if (lang === 'ja') {
    for (const w of PACK_LEGAL_WORDS_JA) if (plain.includes(w)) out.push(`must not contain 「${w}」`);
    for (const w of BETTING_WORDS_JA) if (plain.includes(w)) out.push(`betting word 「${w}」`);
  } else {
    if (hasJapanese(plain)) out.push('English text contains Japanese');
    for (const p of enWordingProblems(plain, EN_BANNED)) out.push(p);
    for (const re of BETTING_WORDS_EN) if (re.test(plain)) out.push(`betting word ${re.source}`);
  }
  if (ng) {
    for (const w of ng.exact) if (w && plain.includes(w)) out.push(`real name 「${w}」`);
    for (const w of ng.contains) if (w && plain.includes(w)) out.push(`real name 「${w}」`);
  }
  return out;
}

/** The standard templates (commentary-ja.json / commentary-en.json), only what the lint needs. */
export interface StandardCommentary { phrases: Record<string, { mustSay?: boolean; variants: PackVariant[] }> }

const baseKind = (key: string) => (key.includes('@') ? key.slice(0, key.indexOf('@')) : key);
export const coveredByFallback = (fallback: readonly string[] | undefined, kind: string) =>
  (fallback ?? []).some((f) => (f.endsWith('*') ? kind.startsWith(f.slice(0, -1)) : f === kind));

/**
 * REQ-CMT-005: problems of the pack catalog. Always: ids, the one default pack, prices, achievements, variant ids,
 * placeholders and the wording / betting / real-name lint. With `standard` (tests and the client at load): every
 * standard base kind is in the pack's Japanese phrases or its explicit `fallback`, and a pack's placeholders for a key
 * are a subset of what the standard uses for that key, per language.
 */
export function commentaryPacksProblems(m: Master, c: CommentaryPacksMaster = commentaryPacksOf(m), standard?: { ja: StandardCommentary; en?: StandardCommentary }): string[] {
  const out: string[] = [];
  if (!c || !Array.isArray(c.packs)) return ['commentaryPacks: packs must be a list'];
  if (c.standardPackId !== STANDARD_PACK_ID) out.push(`commentaryPacks: standardPackId must be ${STANDARD_PACK_ID}`);
  const ids = new Set<string>();
  const variantIds = new Set<string>();
  for (const p of Object.values(standard?.ja.phrases ?? {})) for (const v of p.variants) variantIds.add(v.id);
  let defaults = 0;
  const achievements = collectionOf(m).achievements;
  for (const p of c.packs) {
    const at = `commentaryPacks.${p.id}`;
    if (!/^[a-z][a-z0-9]*$/.test(p.id ?? '')) out.push(`${at}: id must be lower-case letters and digits`);
    if (ids.has(p.id)) out.push(`${at}: duplicate pack`);
    ids.add(p.id);
    if (typeof p.name !== 'string' || !hasJapanese(p.name)) out.push(`${at}: name must be Japanese`);
    if (typeof p.description !== 'string' || !hasJapanese(p.description)) out.push(`${at}: description must be Japanese`);
    for (const t of [p.name, p.description]) for (const x of commentaryTextProblems(t ?? '', 'ja', m.ng)) out.push(`${at}: 「${t}」: ${x}`);
    if (!Number.isInteger(p.order)) out.push(`${at}: order must be an integer`);
    const a = p.acquire as PackAcquire | undefined;
    if (!a) { out.push(`${at}: acquire missing`); continue; }
    if (a.kind === 'default') {
      defaults++;
      if (p.id !== STANDARD_PACK_ID) out.push(`${at}: only ${STANDARD_PACK_ID} is the default pack`);
      if (p.phrases || p.fallback) out.push(`${at}: the standard pack is commentary-ja.json / commentary-en.json itself (no phrases)`);
      continue;
    }
    if (a.kind === 'achievement') {
      // REQ-CMT-007: a fixed tier of a play achievement; never sold (so it is never a reward with a coin value)
      const d = achievements.find((x) => x.id === a.achievementId);
      if (!d) out.push(`${at}: unknown achievement ${a.achievementId}`);
      else if (!d.tiers.some((t) => t.tier === a.tier)) out.push(`${at}: achievement ${a.achievementId} has no tier ${a.tier}`);
      if ('price' in a) out.push(`${at}: an achievement pack is not sold`);
    } else if (a.kind === 'coins') {
      if (!Number.isInteger(a.price) || a.price < 1 || a.price > MAX_PACK_PRICE) out.push(`${at}: price must be an integer 1..${MAX_PACK_PRICE}`);
      if (a.currency !== 'any' && a.currency !== 'paidOnly') out.push(`${at}: currency must be any | paidOnly`);
    } else out.push(`${at}: acquire.kind must be default | achievement | coins`);
    const ja = p.phrases?.ja;
    if (!ja || Object.keys(ja).length === 0) { out.push(`${at}: phrases.ja is required`); continue; }
    for (const lang of ['ja', 'en'] as const) {
      const ph = p.phrases?.[lang];
      if (!ph) continue;
      for (const [key, def] of Object.entries(ph)) {
        const kat = `${at}.${lang}.${key}`;
        if (!/^[a-z0-9_]+(@[a-z0-9_]+)?$/.test(key)) out.push(`${kat}: bad phrase key`);
        if (lang === 'en' && !ja[key]) out.push(`${kat}: English for a key the Japanese does not have`);
        if (!def?.variants?.length) { out.push(`${kat}: no variants`); continue; }
        const stdKey = standard?.[lang]?.phrases[key] ?? (key.includes('@') ? standard?.[lang]?.phrases[baseKind(key)] : undefined);
        if (standard && !standard[lang]?.phrases[baseKind(key)] && lang === 'ja') out.push(`${kat}: the standard has no kind ${baseKind(key)}`);
        const allowed = stdKey ? new Set(stdKey.variants.flatMap((v) => placeholdersOf(v.text))) : null;
        for (const v of def.variants) {
          if (!v.id?.startsWith(`${p.id}_`) || !/^[a-z0-9_]+$/.test(v.id)) out.push(`${kat}: variant id ${v.id} must be ${p.id}_<lower-case>`);
          if (lang === 'ja') {
            if (variantIds.has(v.id)) out.push(`${kat}: duplicate variant id ${v.id}`);
            variantIds.add(v.id);
          } else if (!ja[key]!.variants.some((x) => x.id === v.id)) out.push(`${kat}: English variant ${v.id} has no Japanese variant`);
          for (const x of commentaryTextProblems(v.text ?? '', lang, m.ng)) out.push(`${kat}.${v.id}: ${x}`);
          if (allowed) for (const ph2 of placeholdersOf(v.text ?? '')) if (!allowed.has(ph2)) out.push(`${kat}.${v.id}: placeholder {${ph2}} is not used by the standard ${key}`);
        }
      }
    }
    for (const f of p.fallback ?? []) if (!/^[a-z0-9_]+\*?$/.test(f)) out.push(`${at}: bad fallback entry ${f}`);
    if (standard) {
      // REQ-CMT-002: explicit fallback — every standard base kind is spoken by the pack or listed
      for (const key of Object.keys(standard.ja.phrases)) {
        if (key.includes('@')) continue;
        if (!ja[key] && !coveredByFallback(p.fallback, key)) out.push(`${at}: kind ${key} is neither in phrases.ja nor in fallback`);
      }
      for (const f of p.fallback ?? []) {
        const hits = Object.keys(standard.ja.phrases).filter((k) => !k.includes('@') && coveredByFallback([f], k));
        if (hits.length === 0) out.push(`${at}: fallback ${f} matches no standard kind`);
        if (hits.some((k) => ja[k])) out.push(`${at}: fallback ${f} lists a kind the pack speaks itself`);
      }
    }
  }
  if (defaults !== 1) out.push(`commentaryPacks: exactly one default pack (found ${defaults})`);
  if (!c.sample || !Number.isInteger(c.sample.seed) || !(c.sample.seconds >= 3 && c.sample.seconds <= 20)) out.push('commentaryPacks.sample: seed and seconds (3..20) required');
  else {
    if ((c.sample.entrants ?? []).length < 3 || c.sample.entrants.length > 12) out.push('commentaryPacks.sample: 3..12 entrants');
    for (const e of c.sample.entrants ?? []) {
      const t = m.templateById.get(e.templateId);
      if (!t) out.push(`commentaryPacks.sample: unknown template ${e.templateId}`);
      else if (t.name !== e.name) out.push(`commentaryPacks.sample: ${e.templateId} name must be ${t.name} (its voice clip)`);
    }
    const tr = m.tracks.find((t) => t.id === c.sample.track?.id);
    if (!tr) out.push(`commentaryPacks.sample: unknown track ${c.sample.track?.id}`);
    else if (tr.distanceM !== c.sample.track.distanceM || JSON.stringify(tr.segments) !== JSON.stringify(c.sample.track.segments)) out.push(`commentaryPacks.sample: track ${tr.id} differs from master/tracks.json`);
  }
  return out;
}

/** Boot check of the shipped catalog (index.ts). */
export function validateCommentaryPacks(m: Master): void {
  const p = commentaryPacksProblems(m);
  if (p.length) throw new AppError('CONFIG_INVALID', 'master/commentary-packs.json: ' + p.join('; '));
}

// ------------------------------------------------------------------------------------------------ player state

export interface CommentaryPackState {
  equipped: string;
  /** Owned packs other than the standard: how and when (a bought pack keeps its ledger ref). */
  owned: Record<string, { at: number; via: 'buy' | 'achievement' | 'exchange'; ref?: string }>;
  updatedAt: number | null;
  /** A pack other than the standard was ever equipped (commentary_pack_equip isFirst). */
  everEquipped?: boolean;
}

function ensureState(s: PlayerState): CommentaryPackState {
  s.commentaryPack ??= { equipped: STANDARD_PACK_ID, owned: {}, updatedAt: null };
  return s.commentaryPack;
}

/** Round 14 integration (§30 × §36): a pack taken from an event exchange line (the exchange checks ownership first). */
export function grantPackOwnership(s: PlayerState, packId: string, now: number, ref: string) {
  const st = ensureState(s);
  if (!st.owned[packId]) st.owned[packId] = { at: now, via: 'exchange', ref };
}

/** Owned now: the standard always, a recorded pack, or an achievement pack whose tier is reached. */
export function ownsPack(s: PlayerState, p: CommentaryPackDef): boolean {
  if (p.acquire.kind === 'default') return true;
  if (s.commentaryPack?.owned[p.id]) return true;
  return p.acquire.kind === 'achievement' && tierReached(s, p.acquire.achievementId, p.acquire.tier);
}

/** The equipped pack actually used: the stored one when it still exists and is owned, else the standard. */
export function equippedPackId(m: Pick<Master, 'commentaryPacks'>, s: PlayerState): string {
  const id = s.commentaryPack?.equipped ?? STANDARD_PACK_ID;
  const p = commentaryPacksOf(m).packs.find((x) => x.id === id);
  return p && ownsPack(s, p) ? id : STANDARD_PACK_ID;
}

export const PACK_NOTICE = '実況の話し方だけが変わります。レースの結果・能力には影響しません。';
export const PACK_EN_STANDARD_NOTE = '英語では標準の実況で話します';

/** GET /v1/commentary/packs (REQ-CMT-011). Read-only: never creates state. */
export function packsView(m: Master, s: PlayerState) {
  const c = commentaryPacksOf(m);
  const equipped = equippedPackId(m, s);
  const achievements = collectionOf(m).achievements;
  return {
    equipped,
    standardPackId: c.standardPackId,
    sample: { seed: c.sample.seed, seconds: c.sample.seconds, trackId: c.sample.track.id, fieldSize: c.sample.entrants.length },
    notice: PACK_NOTICE,
    packs: [...c.packs].sort((a, b) => a.order - b.order).map((p) => {
      const a = p.acquire;
      let unlock: { achievementId: string; tier: number; label: string; progress: number; target: number } | null = null;
      if (a.kind === 'achievement') {
        const d = achievements.find((x) => x.id === a.achievementId);
        const t = d?.tiers.find((x) => x.tier === a.tier);
        const progress = d ? metricValue(m, s, d) : 0;
        unlock = { achievementId: a.achievementId, tier: a.tier, label: `実績「${d?.name ?? a.achievementId}」${a.tier}段目で入手`, progress: Math.min(progress, t?.target ?? progress), target: t?.target ?? 0 };
      }
      const hasEn = a.kind === 'default' || Object.keys(p.phrases?.en ?? {}).length > 0;
      return {
        id: p.id, name: p.name, description: p.description,
        acquire: a.kind,
        price: a.kind === 'coins' ? a.price : null,
        currency: a.kind === 'coins' ? a.currency : null,
        forSale: a.kind === 'coins',
        owned: ownsPack(s, p),
        equipped: p.id === equipped,
        unlock,
        // REQ-CMT-002: English is optional per pack (the standard English lines otherwise)
        english: hasEn ? 'own' : 'standard',
        englishNote: hasEn ? null : PACK_EN_STANDARD_NOTE,
      };
    }),
  };
}

/** `commentaryPack` in GET /v1/player (bootstrap): only what a race needs. */
export const commentaryPackBadge = (m: Master, s: PlayerState) => ({ equipped: equippedPackId(m, s) });

/** PUT /v1/commentary/equipped (REQ-CMT-009). Idempotent: equipping the current pack again changes and emits nothing. */
export function equipPack(m: Master, s: PlayerState, packId: string, source: EquipSource | 'buy', now: number, emit: Emit) {
  const p = findPack(m, packId);
  if (!ownsPack(s, p)) throw new AppError('NOT_ELIGIBLE', `commentary pack ${packId} is not owned`);
  const before = equippedPackId(m, s);
  const st = s.commentaryPack;
  // an achievement pack becomes a recorded possession the first time it is equipped (it stays if the master changes)
  if (p.acquire.kind === 'achievement' && !st?.owned[p.id]) ensureState(s).owned[p.id] = { at: now, via: 'achievement' };
  if (before !== packId || (st && st.equipped !== packId)) {
    const x = ensureState(s);
    x.equipped = packId;
    x.updatedAt = now;
    if (before !== packId) {
      const first = packId !== STANDARD_PACK_ID && !x.everEquipped;
      if (packId !== STANDARD_PACK_ID) x.everEquipped = true;
      emit({ name: 'commentary_pack_equip', s1: packId, s2: before, s3: source, isFirst: first });
    }
  }
  return packsView(m, s);
}

/** POST /v1/commentary/packs/:packId/buy (REQ-CMT-010). The caller runs it in an idempotent transaction. */
export function buyPack(m: Master, s: PlayerState, packId: string, equip: boolean, now: number, ref: string, emit: Emit): { packId: string; spent: SpendResult } {
  const p = findPack(m, packId);
  if (p.acquire.kind !== 'coins') throw new AppError('NOT_ELIGIBLE', `commentary pack ${packId} is not sold for coins`);
  if (ownsPack(s, p)) throw new AppError('ALREADY_PURCHASED', `commentary pack ${packId} is already owned`);
  if (s.deletion?.status === 'scheduled' || s.deletion?.status === 'deleting') throw new AppError('DELETION_PENDING', 'the account is scheduled for deletion');
  const spent = spend(s, p.acquire.price, { paidOnly: p.acquire.currency === 'paidOnly' }, now, `commentary pack ${p.id}`, ref);
  ensureState(s).owned[p.id] = { at: now, via: 'buy', ref };
  emit({ name: 'commentary_pack_buy', s1: p.id, s2: p.acquire.currency, paidCoins: spent.paid, freeCoins: spent.free, value: p.acquire.price });
  if (equip) equipPack(m, s, p.id, 'buy', now, emit);
  return { packId: p.id, spent };
}
