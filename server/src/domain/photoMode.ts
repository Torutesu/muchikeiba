/**
 * フォトモード（REQ-PHOTO-*, contracts/protocol.md §38）.
 *
 * The client pauses a solo race (or stops a finished race / a replay), re-simulates it to the chosen tick and takes a
 * picture with a free camera, a look (filter), a frame, stamps and a caption. The server only holds:
 * - the catalog of looks / frames / stamps and how each unlocks (`master/photo.json`): free, an achievement tier
 *   (§24, earned by playing) or a fixed-price cosmetic sold through the existing cosmetics shop (items.json `kind:
 *   "photo"`, REQ-ITEM-005 — no randomness);
 * - up to `maxSaved` small photo records (source race + tick + camera + overlays + caption), never the image itself.
 *
 * Nothing here moves coins or items (no E number) and nothing touches a race: the record is a pointer for re-rendering.
 * Captions are player text: the display-name rules (NFKC, no control characters / URLs, NG list) plus the shop wording
 * rules and no betting words; never translated (i18n/catalog.ts PLAYER_TEXT_KEYS).
 */
import { z } from 'zod';
import photoJson from '../../master/photo.json';
import { AppError } from './errors.js';
import { foldForCompare } from './horses.js';
import type { Master } from './master.js';
import type { PlayerState } from './player.js';
import type { Emit } from './service.js';
import { collectionOf, tierReached } from './collection.js';
import { ASSET_KEY_RE } from './visuals.js';

export type PhotoUnlock =
  | { kind: 'default' }
  | { kind: 'achievement'; achievementId: string; tier: number }
  | { kind: 'cosmetic'; itemId: string };
export interface PhotoItemDef { id: string; name: string; unlock: PhotoUnlock }
export type Range = [number, number];
export interface PhotoCameraLimits { orbitDeg: Range; distanceDm: Range; heightDm: Range; fovDeg: Range; dof: Range }
export interface PhotoConfig { enabled: boolean; maxSaved: number; captionMaxChars: number; stampsMax: number; camera: PhotoCameraLimits }
export interface PhotoMaster { version: number; config: PhotoConfig; looks: PhotoItemDef[]; frames: PhotoItemDef[]; stamps: PhotoItemDef[] }
export type PhotoCategory = 'looks' | 'frames' | 'stamps';
export const PHOTO_CATEGORIES: PhotoCategory[] = ['looks', 'frames', 'stamps'];
const ASSET_KIND: Record<PhotoCategory, string> = { looks: 'photo/look', frames: 'photo/frame', stamps: 'photo/stamp' };
export const photoAsset = (cat: PhotoCategory, id: string) => `${ASSET_KIND[cat]}/${id}`;

export const PHOTO_ID_RE = /^[a-z0-9_]{1,32}$/;
/** Lower bound of the camera height: the camera never goes below the course surface (Y = 0). */
export const PHOTO_MIN_HEIGHT_DM = 3;
/** Hard limits a remote config may not exceed. */
export const PHOTO_HARD_LIMITS = { maxSaved: 100, captionMaxChars: 40, stampsMax: 5, orbitDeg: [-180, 180] as Range, distanceDm: [10, 500] as Range, heightDm: [PHOTO_MIN_HEIGHT_DM, 300] as Range, fovDeg: [10, 90] as Range, dof: [0, 5] as Range, maxTick: 72_000 };
/** 景表法 / shop wording rules (docs/planning/03, same list as the shop and ad lints) plus words that suggest betting. */
export const PHOTO_BANNED_WORDS = ['倍', 'お得', '今だけ', '残りわずか', '通常価格', '馬券', '賭け', '賭博', 'ベット', 'オッズ', '配当', '払戻', '払い戻し', '的中', '予想'];
/** Modes raced together with other people: never paused live (REQ-PHOTO-001). */
export const SHARED_RACE_MODES = ['ranked', 'friend', 'event', 'tournament'] as const;
export const PHOTO_MODES = ['ranked', 'friend', 'tutorial', 'time_attack', 'event', 'tournament', 'challenge', 'practice'] as const;
export const PHOTO_SOURCES = ['paused', 'result', 'replay'] as const;
export const PHOTO_NOTICE = 'フォトモードの見た目は写真だけに使われ、レースの能力には影響しません。';

export function photoOf(m: Pick<Master, 'photo'>): PhotoMaster {
  return m.photo ?? (photoJson as unknown as PhotoMaster);
}

// --------------------------------------------------------------------------------------------- validation

const intIn = (v: unknown, lo: number, hi: number) => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;
const rangeIn = (r: unknown, hard: Range) => Array.isArray(r) && r.length === 2 && intIn(r[0], hard[0], hard[1]) && intIn(r[1], hard[0], hard[1]) && (r[0] as number) < (r[1] as number);
const bannedIn = (t: string) => PHOTO_BANNED_WORDS.filter((w) => t.includes(w));

/** REQ-PHOTO-013: consistency of master/photo.json against the achievements and the cosmetics (boot, tests, remote config). */
export function photoProblems(m: Master): string[] {
  const pm = photoOf(m);
  const p: string[] = [];
  const c = pm.config;
  const H = PHOTO_HARD_LIMITS;
  if (!Number.isInteger(pm.version) || pm.version < 1) p.push('photo.version must be an integer >= 1');
  if (typeof c?.enabled !== 'boolean') p.push('photo.config.enabled must be a boolean');
  if (!intIn(c?.maxSaved, 1, H.maxSaved)) p.push(`photo.config.maxSaved must be 1..${H.maxSaved}`);
  if (!intIn(c?.captionMaxChars, 1, H.captionMaxChars)) p.push(`photo.config.captionMaxChars must be 1..${H.captionMaxChars}`);
  if (!intIn(c?.stampsMax, 0, H.stampsMax)) p.push(`photo.config.stampsMax must be 0..${H.stampsMax}`);
  for (const k of ['orbitDeg', 'distanceDm', 'heightDm', 'fovDeg', 'dof'] as const) {
    if (!rangeIn(c?.camera?.[k], H[k])) p.push(`photo.config.camera.${k} must be [lo, hi] inside ${JSON.stringify(H[k])}`);
  }
  const achievements = new Map(collectionOf(m).achievements.map((a) => [a.id, a]));
  const photoCosmetics = m.items.cosmetics.filter((x) => x.kind === 'photo');
  const unlockedBy = new Map<string, number>();
  for (const cat of PHOTO_CATEGORIES) {
    const list = pm[cat];
    if (!Array.isArray(list) || list.length === 0) { p.push(`photo.${cat}: at least one item`); continue; }
    const ids = new Set<string>();
    for (const d of list) {
      const at = `photo.${cat}.${d.id}`;
      if (!PHOTO_ID_RE.test(d.id)) p.push(`${at}: bad id`);
      if (ids.has(d.id)) p.push(`${at}: duplicate`);
      ids.add(d.id);
      if (!ASSET_KEY_RE.test(photoAsset(cat, d.id))) p.push(`${at}: bad asset key`);
      const len = [...(d.name ?? '')].length;
      if (len < 1 || len > 16) p.push(`${at}: name must be 1..16 characters`);
      for (const w of bannedIn(d.name ?? '')) p.push(`${at}: name uses 「${w}」`);
      const u = d.unlock;
      if (cat === 'looks' && u?.kind !== 'default') p.push(`${at}: every look is free (unlock default)`); // REQ-PHOTO-004
      if (u?.kind === 'achievement') {
        const a = achievements.get(u.achievementId);
        if (!a) p.push(`${at}: unknown achievement ${u.achievementId}`);
        else if (!a.tiers.some((t) => t.tier === u.tier)) p.push(`${at}: achievement ${u.achievementId} has no tier ${u.tier}`);
      } else if (u?.kind === 'cosmetic') {
        const cos = m.items.cosmetics.find((x) => x.id === u.itemId);
        if (!cos) p.push(`${at}: unknown cosmetic ${u.itemId}`);
        else if (cos.kind !== 'photo' || cos.asset !== photoAsset(cat, d.id)) p.push(`${at}: cosmetic ${u.itemId} must be kind "photo" with asset ${photoAsset(cat, d.id)}`);
        else if (cos.notForSale) p.push(`${at}: cosmetic ${u.itemId} must be sold directly`);
        unlockedBy.set(u.itemId, (unlockedBy.get(u.itemId) ?? 0) + 1);
      } else if (u?.kind !== 'default') p.push(`${at}: unknown unlock kind`);
    }
    if (cat !== 'looks' && !list.some((d) => d.unlock?.kind === 'default')) p.push(`photo.${cat}: at least one free item (unlock default)`);
  }
  for (const cos of photoCosmetics) {
    const n = unlockedBy.get(cos.id) ?? 0;
    if (n !== 1) p.push(`cosmetic ${cos.id}: unlocks ${n} photo items (expected 1)`);
  }
  for (const w of bannedIn(PHOTO_NOTICE)) p.push(`photo notice uses 「${w}」`);
  return p;
}

// --------------------------------------------------------------------------------------------- catalog

export function photoItemUnlocked(s: PlayerState, d: PhotoItemDef): boolean {
  const u = d.unlock;
  switch (u.kind) {
    case 'default': return true;
    case 'achievement': return tierReached(s, u.achievementId, u.tier);
    case 'cosmetic': return (s.items[u.itemId] ?? 0) > 0;
  }
}

export function photoUnlockText(m: Master, d: PhotoItemDef): string {
  const u = d.unlock;
  switch (u.kind) {
    case 'default': return '最初から使える';
    case 'achievement': {
      const a = collectionOf(m).achievements.find((x) => x.id === u.achievementId);
      return a ? `実績「${a.name}」の${u.tier}段目で解放` : '実績で解放';
    }
    case 'cosmetic': {
      const c = m.items.cosmetics.find((x) => x.id === u.itemId);
      return c ? `見た目ショップで購入（${c.price}コイン${c.currency === 'paidOnly' ? '・有償限定' : ''}）` : '見た目ショップで購入';
    }
  }
}

const limitsOf = (c: PhotoConfig) => ({ maxSaved: c.maxSaved, captionMaxChars: c.captionMaxChars, stampsMax: c.stampsMax, camera: c.camera });

/** REQ-PHOTO-006: GET /v1/photo/catalog — every look / frame / stamp with this player's unlocks. */
export function photoCatalog(m: Master, s: PlayerState) {
  const pm = photoOf(m);
  if (!pm.config.enabled) return { enabled: false as const };
  const item = (cat: PhotoCategory) => (d: PhotoItemDef) => {
    const u = d.unlock;
    const cos = u.kind === 'cosmetic' ? m.items.cosmetics.find((x) => x.id === u.itemId) : undefined;
    return {
      id: d.id, name: d.name, asset: photoAsset(cat, d.id), unlock: { ...u },
      ...(cos ? { price: cos.price, currency: cos.currency } : {}),
      unlockText: photoUnlockText(m, d), unlocked: photoItemUnlocked(s, d),
    };
  };
  return {
    enabled: true as const, version: pm.version, limits: limitsOf(pm.config),
    looks: pm.looks.map(item('looks')), frames: pm.frames.map(item('frames')), stamps: pm.stamps.map(item('stamps')),
    notice: PHOTO_NOTICE,
  };
}

// --------------------------------------------------------------------------------------------- caption

/** REQ-PHOTO-007: a caption (null / empty = none). Display-name rules + shop wording + no betting words. */
export function validateCaption(m: Master, raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const max = photoOf(m).config.captionMaxChars;
  const t = raw.normalize('NFKC').trim().replace(/\s+/g, ' ');
  if (t.length === 0) return null;
  if ([...t].length > max) throw new AppError('INVALID_NAME', `0〜${max}文字`);
  if (/[\p{C}]/u.test(t)) throw new AppError('INVALID_NAME', 'control characters');
  if (/https?:|www\.|\.(com|net|jp)\b/i.test(t)) throw new AppError('INVALID_NAME', 'no URLs');
  if (bannedIn(t).length) throw new AppError('NG_NAME', 'wording not allowed in a caption');
  const f = foldForCompare(t);
  if (m.ng.exact.some((n) => foldForCompare(n) === f)) throw new AppError('NG_NAME');
  if (m.ng.contains.some((n) => f.includes(foldForCompare(n)))) throw new AppError('NG_NAME');
  return t;
}

// --------------------------------------------------------------------------------------------- records

export interface PhotoStampPlacement { id: string; xPermille: number; yPermille: number; scalePermille: number; rotDeg: number }
export interface PhotoInput {
  source: { kind: typeof PHOTO_SOURCES[number]; mode: typeof PHOTO_MODES[number]; raceId: string; tick: number };
  camera: { focusSlot: number; orbitDeg: number; distanceDm: number; heightDm: number; fovDeg: number; dof: number };
  lookId: string; frameId: string | null; stamps: PhotoStampPlacement[];
  caption: string | null; names: 'masked' | 'hidden'; hideUi: boolean;
}
export interface PhotoRecord extends PhotoInput { id: string; createdAt: number }
export interface PhotoState { seq: number; records: PhotoRecord[] }

const int = z.number().int();
/** The request body (http/app.ts). Ranges that come from the master are checked in savePhoto. */
export const photoInputSchema = z.object({
  source: z.object({
    kind: z.enum(PHOTO_SOURCES), mode: z.enum(PHOTO_MODES),
    raceId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_:.-]+$/), tick: int.min(0).max(PHOTO_HARD_LIMITS.maxTick),
  }).strict(),
  camera: z.object({ focusSlot: int.min(0).max(17), orbitDeg: int, distanceDm: int, heightDm: int, fovDeg: int, dof: int }).strict(),
  lookId: z.string().regex(PHOTO_ID_RE),
  frameId: z.string().regex(PHOTO_ID_RE).nullable(),
  stamps: z.array(z.object({
    id: z.string().regex(PHOTO_ID_RE), xPermille: int.min(0).max(1000), yPermille: int.min(0).max(1000), scalePermille: int.min(250).max(2000), rotDeg: int.min(-180).max(180),
  }).strict()).max(PHOTO_HARD_LIMITS.stampsMax),
  caption: z.string().max(200).nullable(),
  names: z.enum(['masked', 'hidden']),
  hideUi: z.boolean(),
}).strict();

export function ensurePhotos(s: PlayerState): PhotoState {
  s.photos ??= { seq: 0, records: [] };
  return s.photos;
}

const enabledOrThrow = (m: Master) => { if (!photoOf(m).config.enabled) throw new AppError('NOT_FOUND', 'photo mode is not available'); };
const listView = (m: Master, s: PlayerState) => {
  const recs = s.photos?.records ?? [];
  return { photos: [...recs].reverse(), count: recs.length, max: photoOf(m).config.maxSaved };
};

export function photosView(m: Master, s: PlayerState) {
  enabledOrThrow(m);
  return listView(m, s);
}

function findItem(m: Master, cat: PhotoCategory, id: string): PhotoItemDef {
  const d = photoOf(m)[cat].find((x) => x.id === id);
  if (!d) throw new AppError('BAD_REQUEST', `unknown ${cat.slice(0, -1)} ${id}`);
  return d;
}

/** REQ-PHOTO-010/011: store a photo record (keyed by the client's idempotency key in the service). */
export function savePhoto(m: Master, s: PlayerState, input: PhotoInput, now: number, emit: Emit | null) {
  enabledOrThrow(m);
  const pm = photoOf(m);
  const c = pm.config;
  // REQ-PHOTO-001: a race run together with other people is never paused live
  if (input.source.kind === 'paused' && (SHARED_RACE_MODES as readonly string[]).includes(input.source.mode)) {
    throw new AppError('PHOTO_SOURCE_INVALID', `a ${input.source.mode} race cannot be paused; take the photo from the result or the replay`);
  }
  const cam = input.camera;
  for (const k of ['orbitDeg', 'distanceDm', 'heightDm', 'fovDeg', 'dof'] as const) {
    const [lo, hi] = c.camera[k];
    if (!intIn(cam[k], lo, hi)) throw new AppError('BAD_REQUEST', `camera.${k} must be ${lo}..${hi}`);
  }
  if (cam.heightDm < PHOTO_MIN_HEIGHT_DM) throw new AppError('BAD_REQUEST', 'camera below the course');
  if (input.stamps.length > c.stampsMax) throw new AppError('BAD_REQUEST', `at most ${c.stampsMax} stamps`);
  const used: [PhotoCategory, string][] = [['looks', input.lookId], ...(input.frameId ? [['frames', input.frameId] as [PhotoCategory, string]] : []), ...input.stamps.map((x) => ['stamps', x.id] as [PhotoCategory, string])];
  for (const [cat, id] of used) {
    if (!photoItemUnlocked(s, findItem(m, cat, id))) throw new AppError('PHOTO_LOCKED', `${cat.slice(0, -1)} ${id} is not unlocked`);
  }
  const caption = validateCaption(m, input.caption);
  const st = ensurePhotos(s);
  if (st.records.length >= c.maxSaved) throw new AppError('PHOTO_LIMIT', `at most ${c.maxSaved} photos; delete one first`);
  st.seq += 1;
  const rec: PhotoRecord = {
    id: `ph_${st.seq}`, createdAt: now,
    source: { ...input.source }, camera: { ...cam }, lookId: input.lookId, frameId: input.frameId,
    stamps: input.stamps.map((x) => ({ ...x })), caption, names: input.names, hideUi: input.hideUi,
  };
  st.records.push(rec);
  emit?.({ name: 'photo_save', s1: rec.source.kind, s2: rec.source.mode, count: st.records.length });
  return { photo: rec, count: st.records.length, max: c.maxSaved };
}

export function deletePhoto(m: Master, s: PlayerState, photoId: string) {
  enabledOrThrow(m);
  const st = s.photos;
  const i = st ? st.records.findIndex((r) => r.id === photoId) : -1;
  if (!st || i < 0) throw new AppError('NOT_FOUND', 'no such photo');
  st.records.splice(i, 1);
  return { deleted: true as const, count: st.records.length, max: photoOf(m).config.maxSaved };
}
