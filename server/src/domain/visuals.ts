/**
 * Visual contract with the Unity client (contracts/assets.md, REQ-ASSET-*).
 *
 * The server never ships art. It sends small descriptors (coat, markings, silks…) and the client turns
 * them into asset keys with the same rules (Muchi.Client AssetKeys). Every key that master data can
 * produce is listed in contracts/assets.manifest.json (npm run gen:assets) so Codex can check coverage.
 * Nothing here takes part in the race simulation or the result hash.
 */
import visualsJson from '../../master/visuals.json';
import { BASE_BANNED_SILKS, bannedMatch, combinedBanned, type BannedSilksList } from './bannedSilks.js';
import { AppError } from './errors.js';
import type { Master } from './master.js';
import { randInt, type Rng } from './rng.js';
import type { RaceStartConfig } from './schemas.js';

export interface WeightedId { id: string; weight: number }
export type Legs = [string, string, string, string];
/** Horse look. legs = [left fore, right fore, left hind, right hind]. */
export interface Appearance { coat: string; face: string; legs: Legs; mane: string; build: string }
/** Jockey silks: pattern + palette colour ids (count fixed per pattern) + cap pattern. */
export interface Silks { pattern: string; colors: string[]; cap: string }
/** Team emblem built from a fixed parts set: shape + symbol + 2 palette colours. */
export interface Emblem { shape: string; symbol: string; colors: [string, string] }

export interface VisualsMaster {
  version: number;
  palette: { id: string; hex: string }[];
  horse: {
    coats: WeightedId[]; faces: WeightedId[]; legs: WeightedId[]; manes: WeightedId[]; builds: WeightedId[];
    templates: Record<string, Appearance>;
    inheritance: { mutationPermille: number; grayFromGrayParentPermille: number };
  };
  silks: { patterns: { id: string; colors: number; unlockItem?: string }[]; caps: { id: string }[]; banned: { pattern: string; colors: string[]; cap?: string }[] };
  gateBrackets: { bracket: number; cloth: string; number: string }[];
  venues: Record<string, { name: string; direction: 'left' | 'right' }>;
  tracks: Record<string, { venue: string }>;
  emblem: { shapes: string[]; symbols: string[] };
  sfx: { race: string[]; ui: string[] };
  /** REQ-ROOM-001: cosmetic racecourse themes (one is the default; others need their unlock item). */
  courseLooks: { id: string; key: string; default?: boolean; unlockItem?: string }[];
  /** REQ-ROOM-002: scene-only weather for private rooms. */
  weather: string[];
}

export const VISUALS = visualsJson as unknown as VisualsMaster;

// ------------------------------------------------------------------------------------- asset keys

/** lowercase `kind/name` segments; optional `@vN` variant suffix (contracts/assets.md §1). */
export const ASSET_KEY_RE = /^[a-z0-9_]+(\/[a-z0-9_]+)+(@v[0-9]+)?$/;
export const VOICE_LANG = 'ja';

/** FNV-1a 64 over UTF-8, 16 lowercase hex (same as Muchi.Engine.Fnv1a64). Used for per-name voice clips. */
export function fnv1a64Hex(s: string): string {
  let h = 0xcbf29ce484222325n;
  for (const b of new TextEncoder().encode(s)) h = ((h ^ BigInt(b)) * 0x100000001b3n) & 0xffffffffffffffffn;
  return h.toString(16).padStart(16, '0');
}

export const assetKeys = {
  coat: (id: string) => `horse/coat/${id}`,
  face: (id: string) => `horse/face/${id}`,
  leg: (id: string) => `horse/leg/${id}`,
  mane: (id: string) => `horse/mane/${id}`,
  build: (id: string) => `horse/build/${id}`,
  silksPattern: (id: string) => `silks/pattern/${id}`,
  silksCap: (id: string) => `silks/cap/${id}`,
  /** REQ-ITEM-006: tack and stable decor keys come from master/items.json (`asset`). */
  tack: (name: string) => `tack/${name}`,
  decor: (name: string) => `decor/${name}`,
  /** REQ-TEAMFEED-001: team cheer stamp (master/stamps.json `stamps[].id`). */
  stamp: (id: string) => `stamp/${id}`,
  /** REQ-STABLE-*: マイ厩舎 room theme (walls/floor), master/stable.json `themes[].id`. */
  stableTheme: (id: string) => `stable/theme/${id}`,
  gate: (bracket: number) => `ui/gate/${bracket}`,
  item: (id: string) => `item/${id}`,
  gachaBanner: (id: string) => `banner/gacha/${id}`,
  eventBanner: (id: string) => `banner/event/${id}`,
  title: (id: string) => `title/${id}`,
  /** REQ-COL-003: 図鑑 art per horse template — the portrait once obtained or seen, the silhouette while unknown. */
  collectionPortrait: (templateId: string) => `collection/portrait/${templateId}`,
  collectionSilhouette: (templateId: string) => `collection/silhouette/${templateId}`,
  /** REQ-ACH-004: achievement badge per tier (master/collection.json `achievements[].id`, tier 1..5). */
  badge: (achievementId: string, tier: number) => `badge/${achievementId}_${tier}`,
  emblemShape: (id: string) => `emblem/shape/${id}`,
  emblemSymbol: (id: string) => `emblem/symbol/${id}`,
  venue: (venue: string) => `scene/venue/${venue}`,
  surface: (venue: string, surface: string) => `scene/surface/${venue}_${surface}`,
  night: (venue: string) => `scene/night/${venue}`,
  going: (going: string) => `fx/going/${going}`,
  courseLook: (id: string) => `scene/look/${id}`,
  weather: (id: string) => `fx/weather/${id}`,
  sfxRace: (id: string) => `sfx/race/${id}`,
  sfxUi: (id: string) => `sfx/ui/${id}`,
  /** Commentary clip id "gate_open_1#0" → voice/ja/phrase/gate_open_1_p0 */
  voicePhrase: (clipId: string) => `voice/${VOICE_LANG}/phrase/${clipId.replace('#', '_p')}`,
  voiceNum: (n: number) => `voice/${VOICE_LANG}/num/${n}`,
  /** Horse names are spoken per name text (not per horse id, which repeats across players). */
  voiceName: (name: string) => `voice/${VOICE_LANG}/name/n${fnv1a64Hex(name.normalize('NFC'))}`,
};

/** Every key kind the client resolves; fallback = `<kind>/default` (shipped in the base bundle). */
export const ASSET_KINDS: Record<string, { description: string; dynamic?: boolean }> = {
  'horse/coat': { description: '毛色（体のテクスチャ・マテリアル）' },
  'horse/face': { description: '顔の白斑' },
  'horse/leg': { description: '脚の白斑（1本ごと）' },
  'horse/mane': { description: 'たてがみ・尾の色' },
  'horse/build': { description: '体型（メッシュのバリエーション）' },
  'silks/pattern': { description: '勝負服の模様（色はパレットで着色）' },
  'silks/cap': { description: '帽子の模様（色は勝負服の1色目・2色目）' },
  'ui/gate': { description: '枠番（1〜8）のゼッケン・UI色' },
  tack: { description: '馬具（頭絡・ゼッケン布）。馬のモデルに重ねる見た目（REQ-ITEM-006）' },
  decor: { description: '厩舎の飾り（REQ-ITEM-006）' },
  stamp: { description: '支部の応援スタンプ（REQ-TEAMFEED-001。定型の絵とラベルだけ）' },
  'stable/theme': { description: 'マイ厩舎の部屋のテーマ（壁・床。REQ-STABLE-001）' },
  item: { description: 'アイテムのアイコン' },
  'banner/gacha': { description: 'ガチャのバナー' },
  'banner/event': { description: 'イベントのバナー' },
  title: { description: '称号のアイコン' },
  'collection/portrait': { description: '図鑑の馬の絵（入手・出会った馬。REQ-COL-003）' },
  'collection/silhouette': { description: '図鑑の未発見の馬のシルエット（REQ-COL-003）' },
  badge: { description: '実績のバッジ（実績×段。REQ-ACH-004）' },
  'emblem/shape': { description: '支部エンブレムの形' },
  'emblem/symbol': { description: '支部エンブレムの図柄' },
  'scene/venue': { description: '競馬場のシーン（地形・スタンド）' },
  'scene/surface': { description: '競馬場ごとの馬場面（芝・ダート）' },
  'scene/night': { description: 'ナイター照明のバリエーション' },
  'fx/going': { description: '馬場状態の見た目（濡れ・水しぶき・土煙）' },
  'scene/look': { description: 'コースの見た目テーマ（自分の画面だけに適用する装飾）' },
  'fx/weather': { description: 'フレンド部屋の天気演出（晴れ・曇り・雨・霧。シミュレーションには影響しない）' },
  'sfx/race': { description: 'レース中の効果音' },
  'sfx/ui': { description: 'UIの効果音' },
  [`voice/${VOICE_LANG}/phrase`]: { description: '実況の定型フレーズ（Resources/Muchi/commentary-ja.json の各断片）' },
  [`voice/${VOICE_LANG}/num`]: { description: '実況の数字（着順など）' },
  [`voice/${VOICE_LANG}/name`]: { description: '実況の馬名。命名時に生成するため動的（テンプレート馬の名前と固有スキル名だけ列挙）', dynamic: true },
};
export const fallbackKey = (kind: string) => `${kind}/default`;
/** The kind of a key: everything before the last segment (variant suffix ignored). */
export const kindOf = (key: string) => key.replace(/@v[0-9]+$/, '').split('/').slice(0, -1).join('/');

// ------------------------------------------------------------------------------------- deterministic picks

function h32(s: string): number {
  let h = 0x811c9dc5;
  for (const b of new TextEncoder().encode(s)) h = Math.imul(h ^ b, 0x01000193) >>> 0;
  return h >>> 0;
}
function pickBy(list: WeightedId[], r: number): string {
  const total = list.reduce((a, x) => a + x.weight, 0);
  let x = r % total;
  for (const e of list) {
    if (x < e.weight) return e.id;
    x -= e.weight;
  }
  return list[list.length - 1]!.id;
}
const pickHash = (list: WeightedId[], seed: string) => pickBy(list, h32(seed));
const pickRng = (list: WeightedId[], rng: Rng) => pickBy(list, randInt(rng, list.reduce((a, x) => a + x.weight, 0)));

/** Look for a horse without a stored appearance (older saves, CPU horses outside templates). Stable per seed. */
export function deriveAppearance(seed: string, v: VisualsMaster = VISUALS): Appearance {
  const hz = v.horse;
  return {
    coat: pickHash(hz.coats, `${seed}|coat`), face: pickHash(hz.faces, `${seed}|face`),
    legs: [0, 1, 2, 3].map((i) => pickHash(hz.legs, `${seed}|leg${i}`)) as Legs,
    mane: pickHash(hz.manes, `${seed}|mane`), build: pickHash(hz.builds, `${seed}|build`),
  };
}

export function templateAppearance(templateId: string, v: VisualsMaster = VISUALS): Appearance | null {
  const a = v.horse.templates[templateId];
  return a ? { ...a, legs: [...a.legs] as Legs } : null;
}

/** Appearance of a stored horse: stored → its template's → derived from owner + horse id. */
export function appearanceOf(h: { id: string; templateId: string | null; appearance?: Appearance }, ownerId: string): Appearance {
  return h.appearance ?? (h.templateId ? templateAppearance(h.templateId) : null) ?? deriveAppearance(`${ownerId}:${h.id}`);
}

/**
 * REQ-ASSET-004: a foal takes each trait from the sire or the dam, with a small mutation chance.
 * Gray is dominant-ish: a gray parent passes gray with grayFromGrayParentPermille. Uses the breeding RNG
 * (server crypto in production, seeded in tests), drawn after every other breeding roll.
 */
export function inheritAppearance(sire: Appearance, dam: Appearance, rng: Rng, v: VisualsMaster = VISUALS): Appearance {
  const hz = v.horse;
  const mut = () => randInt(rng, 1000) < hz.inheritance.mutationPermille;
  const either = <T>(a: T, b: T): T => (randInt(rng, 2) === 0 ? a : b);
  let coat: string;
  const grayParent = sire.coat === 'gray' || dam.coat === 'gray';
  if (grayParent && randInt(rng, 1000) < hz.inheritance.grayFromGrayParentPermille) coat = 'gray';
  else if (grayParent) coat = sire.coat === 'gray' ? (dam.coat === 'gray' ? 'gray' : dam.coat) : sire.coat;
  else coat = either(sire.coat, dam.coat);
  if (mut()) coat = pickRng(hz.coats, rng);
  let face = either(sire.face, dam.face);
  if (mut()) face = pickRng(hz.faces, rng);
  const legs = [0, 1, 2, 3].map((i) => {
    let l = either(sire.legs[i]!, dam.legs[i]!);
    if (mut()) l = pickRng(hz.legs, rng);
    return l;
  }) as Legs;
  let mane = either(sire.mane, dam.mane);
  if (mut()) mane = pickRng(hz.manes, rng);
  let build = either(sire.build, dam.build);
  if (mut()) build = pickRng(hz.builds, rng);
  return { coat, face, legs, mane, build };
}

// ------------------------------------------------------------------------------------- silks & emblem

const paletteIds = (v: VisualsMaster) => v.palette.map((p) => p.id);
const twoColorsFrom = (seed: string, v: VisualsMaster): [string, string] => {
  const ids = paletteIds(v);
  const a = h32(`${seed}|c0`) % ids.length;
  let b = h32(`${seed}|c1`) % (ids.length - 1);
  if (b >= a) b += 1;
  return [ids[a]!, ids[b]!];
};

/** Default silks for players who never chose (and for CPU riders): free patterns only, never banned. */
export function defaultSilks(seed: string, v: VisualsMaster = VISUALS, list: BannedSilksList = BASE_BANNED_SILKS): Silks {
  const free = v.silks.patterns.filter((p) => !p.unlockItem);
  for (let attempt = 0; attempt < 16; attempt++) {
    const s = `${seed}|${attempt}`;
    const p = free[h32(`${s}|pattern`) % free.length]!;
    const [c0, c1] = twoColorsFrom(s, v);
    const ids = paletteIds(v);
    const colors = p.colors === 3 ? [c0, c1, ids.find((x) => x !== c0 && x !== c1)!] : [c0, c1];
    const silks: Silks = { pattern: p.id, colors, cap: v.silks.caps[h32(`${s}|cap`) % v.silks.caps.length]!.id };
    if (!isBannedSilks(silks, v, list)) return silks;
  }
  return { pattern: 'plain', colors: ['white', 'navy'], cap: 'plain' };
}

/**
 * QA r6 #5: the silks to show for a player under the ACTIVE banned list (base + remote-config import).
 * Stored silks (chosen, or a default generated before an import) that are now reserved are replaced by a
 * fresh default that respects the list, so a real registered design is never shown after it is banned.
 */
export function effectiveSilks(stored: Silks | undefined | null, seed: string, list: BannedSilksList = BASE_BANNED_SILKS, v: VisualsMaster = VISUALS): Silks {
  if (stored && !isBannedSilks(stored, v, list)) return stored;
  return defaultSilks(seed, v, list);
}

/**
 * REQ-ASSET-010: real registered silks are reserved. `list` is the active banned list (master/banned-silks.json
 * or a remote-config import); visuals.json's own silks.banned is always included. Matching is on the
 * normalised colour-family signature (see bannedSilks.ts), so near-identical shades are caught too.
 */
export function isBannedSilks(s: Silks, v: VisualsMaster = VISUALS, list: BannedSilksList = BASE_BANNED_SILKS): boolean {
  return bannedMatch(combinedBanned(list, v), s) !== null;
}

/**
 * REQ-ASSET-005: player-chosen silks. Pattern must exist (and be unlocked by owning its costume item),
 * colours must be palette ids in the pattern's count with at least two different colours, cap must exist,
 * and the combination must not be on the banned (real registered silks) list.
 */
export function validateSilks(input: Silks, ownedItems: Record<string, number>, v: VisualsMaster = VISUALS, banned: BannedSilksList = BASE_BANNED_SILKS): Silks {
  const p = v.silks.patterns.find((x) => x.id === input.pattern);
  if (!p) throw new AppError('BAD_REQUEST', `unknown silks pattern ${input.pattern}`);
  if (p.unlockItem && !((ownedItems[p.unlockItem] ?? 0) > 0)) throw new AppError('NOT_ELIGIBLE', `pattern ${p.id} needs item ${p.unlockItem}`);
  if (!Array.isArray(input.colors) || input.colors.length !== p.colors) throw new AppError('BAD_REQUEST', `pattern ${p.id} takes ${p.colors} colours`);
  const ids = new Set(paletteIds(v));
  for (const c of input.colors) if (!ids.has(c)) throw new AppError('BAD_REQUEST', `unknown colour ${c}`);
  if (new Set(input.colors).size < 2) throw new AppError('BAD_REQUEST', 'use at least two different colours');
  if (!v.silks.caps.some((c) => c.id === input.cap)) throw new AppError('BAD_REQUEST', `unknown cap ${input.cap}`);
  const s: Silks = { pattern: p.id, colors: [...input.colors], cap: input.cap };
  if (isBannedSilks(s, v, banned)) throw new AppError('BAD_REQUEST', 'this combination is reserved');
  return s;
}

export function defaultEmblem(seed: string, v: VisualsMaster = VISUALS): Emblem {
  return {
    shape: v.emblem.shapes[h32(`${seed}|shape`) % v.emblem.shapes.length]!,
    symbol: v.emblem.symbols[h32(`${seed}|symbol`) % v.emblem.symbols.length]!,
    colors: twoColorsFrom(`${seed}|emblem`, v),
  };
}

export function validateEmblem(input: Emblem, v: VisualsMaster = VISUALS): Emblem {
  if (!v.emblem.shapes.includes(input.shape)) throw new AppError('BAD_REQUEST', `unknown emblem shape ${input.shape}`);
  if (!v.emblem.symbols.includes(input.symbol)) throw new AppError('BAD_REQUEST', `unknown emblem symbol ${input.symbol}`);
  const ids = new Set(paletteIds(v));
  if (!Array.isArray(input.colors) || input.colors.length !== 2 || !input.colors.every((c) => ids.has(c))) throw new AppError('BAD_REQUEST', 'emblem takes two palette colours');
  if (input.colors[0] === input.colors[1]) throw new AppError('BAD_REQUEST', 'use two different colours');
  return { shape: input.shape, symbol: input.symbol, colors: [input.colors[0], input.colors[1]] };
}

// ------------------------------------------------------------------------------------- race visuals

/** Saddle-cloth bracket (枠番) for a gate in a field of `runners` (contracts/assets.md §4). */
export function bracketOf(gate: number, runners: number): number {
  if (runners <= 8) return gate;
  const single = 16 - runners; // brackets that hold one horse; the rest hold two (up to 16 runners)
  if (gate <= single) return gate;
  return single + Math.ceil((gate - single) / 2);
}

export interface TrackVisual {
  trackId: string; venue: string; direction: 'left' | 'right'; surface: string; going: string | null; night: boolean;
  keys: { venue: string; surface: string; night: string | null; going: string | null };
}

export function trackVisual(track: { id: string; surface: string; going?: string; night?: boolean }, v: VisualsMaster = VISUALS): TrackVisual {
  const venue = v.tracks[track.id]?.venue ?? track.id.split('_')[0] ?? 'unknown';
  const direction = v.venues[venue]?.direction ?? 'left';
  const going = track.going ?? null;
  const night = track.night === true;
  return {
    trackId: track.id, venue, direction, surface: track.surface, going, night,
    keys: { venue: assetKeys.venue(venue), surface: assetKeys.surface(venue, track.surface), night: night ? assetKeys.night(venue) : null, going: going && going !== 'good' ? assetKeys.going(going) : null },
  };
}

/** Per-player look sent with race entries (not part of the hashed race config). */
export interface EntrantVisual { appearance: Appearance; silks: Silks; displayName: string | null; titleId: string | null; bondLevel?: number }

export interface StartVisuals {
  v: 1;
  track: TrackVisual;
  /** REQ-ROOM-004: friend room scene conditions chosen by the host (absent = server default scene). */
  scene?: { weather: string; temperatureC: number; windKmh: number; keys: { weather: string } };
  entrants: ({ slot: number; gate: number; bracket: number; voiceName: string } & EntrantVisual)[];
}

/**
 * REQ-ASSET-006: everything a client needs to draw the other runners, sent next to the config in the
 * `start` message. CPU horses use their template's look; CPU riders get silks derived from the race id.
 */
export function startVisuals(config: RaceStartConfig, humans: Record<string, EntrantVisual | undefined>, v: VisualsMaster = VISUALS, list: BannedSilksList = BASE_BANNED_SILKS): StartVisuals {
  const n = config.entrants.length;
  return {
    v: 1,
    track: trackVisual(config.track, v),
    entrants: config.entrants.map((e) => {
      const hv = e.playerId ? humans[e.playerId] : undefined;
      const tplId = e.horse.id.startsWith('cpu_') ? e.horse.id.slice(4) : null;
      const appearance = hv?.appearance ?? (tplId ? templateAppearance(tplId, v) : null) ?? deriveAppearance(`${config.raceId}:${e.slot}`, v);
      const silks = effectiveSilks(hv?.silks, e.playerId ? `p:${e.playerId}` : `${config.raceId}:cpu:${e.slot}`, list, v);
      return {
        slot: e.slot, gate: e.slot + 1, bracket: bracketOf(e.slot + 1, n), voiceName: assetKeys.voiceName(e.horse.name),
        appearance, silks, displayName: hv?.displayName ?? null, titleId: hv?.titleId ?? null,
        ...(hv?.bondLevel !== undefined ? { bondLevel: hv.bondLevel } : {}),
      };
    }),
  };
}

// ------------------------------------------------------------------------------------- catalog & checks

/** Public catalog for GET /v1/visuals (the client caches it by `version`). */
export function visualsCatalog(m: Master, v: VisualsMaster = VISUALS) {
  return {
    version: v.version,
    palette: v.palette,
    horse: { coats: v.horse.coats.map((x) => x.id), faces: v.horse.faces.map((x) => x.id), legs: v.horse.legs.map((x) => x.id), manes: v.horse.manes.map((x) => x.id), builds: v.horse.builds.map((x) => x.id) },
    silks: { patterns: v.silks.patterns.map((p) => ({ id: p.id, colors: p.colors, unlockItem: p.unlockItem ?? null })), caps: v.silks.caps.map((c) => c.id) },
    gateBrackets: v.gateBrackets,
    venues: v.venues,
    tracks: m.tracks.map((t) => trackVisual(t, v)),
    emblem: v.emblem,
    sfx: v.sfx,
    templates: Object.fromEntries(m.templates.map((t) => [t.id, { appearance: templateAppearance(t.id, v), voiceName: assetKeys.voiceName(t.name) }])),
    items: Object.fromEntries(collectItemIds(m).map((id) => [id, { icon: assetKeys.item(id) }])),
    banners: Object.fromEntries(m.gacha.banners.map((b) => [b.id, assetKeys.gachaBanner(b.id)])),
    events: Object.fromEntries(m.events.map((e) => [e.id, assetKeys.eventBanner(e.id)])),
    titles: Object.fromEntries(m.titles.map((t) => [t.id, assetKeys.title(t.id)])),
    cosmetics: Object.fromEntries((m.items?.cosmetics ?? []).map((c) => [c.id, { kind: c.kind, icon: assetKeys.item(c.id), asset: c.kind === 'silks' ? assetKeys.silksPattern(c.pattern) : c.asset }])),
  };
}

/** Every item id that master data can grant, charge or unlock. */
export function collectItemIds(m: Master, v: VisualsMaster = VISUALS): string[] {
  const ids = new Set<string>();
  const walk = (x: unknown) => {
    if (Array.isArray(x)) x.forEach(walk);
    else if (x && typeof x === 'object') {
      for (const [k, val] of Object.entries(x)) {
        if ((k === 'itemId' || k === 'unlockItem') && typeof val === 'string') ids.add(val);
        else walk(val);
      }
    }
  };
  walk(m.products); walk(m.progression); walk(m.events); walk(v.silks.patterns); walk(v.courseLooks ?? []);
  // REQ-ITEM-*: tickets, the breeding material and every cosmetic sold in the shop
  if (m.items) {
    Object.keys(m.items.tickets).forEach((id) => ids.add(id));
    ids.add(m.items.breedingMaterial.itemId);
    m.items.cosmetics.forEach((c) => ids.add(c.id));
  }
  return [...ids].sort();
}

/** Consistency of master/visuals.json against the rest of the master data (checked at test time). */
export function visualsProblems(m: Master, v: VisualsMaster = VISUALS): string[] {
  const p: string[] = [];
  const uniq = (xs: string[], what: string) => { if (new Set(xs).size !== xs.length) p.push(`duplicate ${what}`); };
  uniq(v.palette.map((x) => x.id), 'palette ids');
  for (const c of v.palette) if (!/^#[0-9A-F]{6}$/.test(c.hex)) p.push(`palette ${c.id}: hex must be #RRGGBB (upper case)`);
  const hz = v.horse;
  const sets = { coat: hz.coats, face: hz.faces, leg: hz.legs, mane: hz.manes, build: hz.builds } as const;
  for (const [k, list] of Object.entries(sets)) {
    uniq(list.map((x) => x.id), `${k} ids`);
    if ((k === 'leg' || k === 'face') && !list.some((x) => x.id === 'none')) p.push(`${k}: needs a "none" entry`);
    for (const x of list) if (!(Number.isInteger(x.weight) && x.weight > 0)) p.push(`${k} ${x.id}: weight must be a positive integer`);
  }
  const has = (list: WeightedId[], id: string) => list.some((x) => x.id === id);
  for (const t of m.templates) {
    const a = hz.templates[t.id];
    if (!a) { p.push(`template ${t.id}: no appearance in visuals.json`); continue; }
    if (!has(hz.coats, a.coat)) p.push(`template ${t.id}: unknown coat ${a.coat}`);
    if (!has(hz.faces, a.face)) p.push(`template ${t.id}: unknown face ${a.face}`);
    if (!Array.isArray(a.legs) || a.legs.length !== 4 || !a.legs.every((l) => has(hz.legs, l))) p.push(`template ${t.id}: legs must be 4 known ids`);
    if (!has(hz.manes, a.mane)) p.push(`template ${t.id}: unknown mane ${a.mane}`);
    if (!has(hz.builds, a.build)) p.push(`template ${t.id}: unknown build ${a.build}`);
  }
  for (const id of Object.keys(hz.templates)) if (!m.templateById.has(id)) p.push(`visuals.json: appearance for unknown template ${id}`);
  uniq(v.silks.patterns.map((x) => x.id), 'silks patterns');
  for (const sp of v.silks.patterns) if (sp.colors !== 2 && sp.colors !== 3) p.push(`silks ${sp.id}: colors must be 2 or 3`);
  if (!v.silks.patterns.some((x) => !x.unlockItem)) p.push('silks: at least one free pattern');
  const palette = new Set(v.palette.map((x) => x.id));
  for (const b of v.silks.banned) if (!b.colors.every((c) => palette.has(c))) p.push(`silks.banned: unknown colour in ${JSON.stringify(b)}`);
  const brackets = v.gateBrackets.map((b) => b.bracket).sort((a, b) => a - b);
  if (brackets.join() !== '1,2,3,4,5,6,7,8') p.push('gateBrackets must define brackets 1..8');
  for (const g of v.gateBrackets) if (!palette.has(g.cloth) || !palette.has(g.number)) p.push(`gate bracket ${g.bracket}: colours must be palette ids`);
  for (const t of m.tracks) {
    const tv = v.tracks[t.id];
    if (!tv) p.push(`track ${t.id}: no venue in visuals.json`);
    else if (!v.venues[tv.venue]) p.push(`track ${t.id}: unknown venue ${tv.venue}`);
  }
  for (const [id, ven] of Object.entries(v.venues)) if (ven.direction !== 'left' && ven.direction !== 'right') p.push(`venue ${id}: direction must be left|right`);
  uniq(v.emblem.shapes, 'emblem shapes'); uniq(v.emblem.symbols, 'emblem symbols');
  return p;
}
