/**
 * Player presets stored on the server (REQ-ROOM-*):
 *  - course look: a cosmetic racecourse theme for the player's own screen (never sent in the hashed config);
 *  - private-room conditions: the host's chosen course / going / night / weather for friend rooms.
 *
 * Friend rooms honour the host's conditions in RaceStartConfig (track id, going, night). Rooms whose host has
 * no conditions set race exactly as before (daily ground, random course), so their configs are unchanged.
 * Weather, temperature and wind are scene-only (sent in start.visuals; the engine does not model them).
 */
import { AppError } from './errors.js';
import type { Master } from './master.js';
import type { PlayerState } from './player.js';
import { DIRT_GOINGS, TURF_GOINGS, goingsFor, type Going } from './schemas.js';
import { groundFor, type Ground } from './ground.js';
import { VISUALS, type VisualsMaster } from './visuals.js';

export interface RoomConditions {
  /** Course for the room (null = random course, as before). */
  trackId: string | null;
  /** Ground (null = the day's ground). Without a course, a turf name maps to the drawn course's surface. */
  going: Going | null;
  /** Night race (null = automatic: lit venues in the evening). Only lit venues can race at night. */
  night: boolean | null;
  /** Scene-only weather, temperature and wind (not simulated). */
  weather: string;
  temperatureC: number;
  windKmh: number;
}

export interface RoomsConfig { weather: string[]; temperaturesC: number[]; windsKmh: number[] }

export interface PresetsState { courseLook: string | null; room: RoomConditions | null }

export function ensurePresets(s: PlayerState): PresetsState {
  s.presets ??= { courseLook: null, room: null };
  return s.presets;
}

export function defaultRoomConditions(cfg: RoomsConfig): RoomConditions {
  return { trackId: null, going: null, night: null, weather: cfg.weather[0] ?? 'sunny', temperatureC: cfg.temperaturesC[1] ?? cfg.temperaturesC[0] ?? 18, windKmh: cfg.windsKmh[0] ?? 0 };
}

/** Course looks the player may equip: the default plus those whose unlock item is owned. */
export function ownedCourseLooks(s: PlayerState, v: VisualsMaster = VISUALS): string[] {
  return v.courseLooks.filter((l) => !l.unlockItem || (s.items[l.unlockItem] ?? 0) > 0).map((l) => l.id);
}

/** REQ-ROOM-001: equip a course look (null = default). */
export function setCourseLook(s: PlayerState, lookId: string | null, v: VisualsMaster = VISUALS) {
  const st = ensurePresets(s);
  if (lookId !== null) {
    const look = v.courseLooks.find((l) => l.id === lookId);
    if (!look) throw new AppError('NOT_FOUND', `course look ${lookId}`);
    if (look.unlockItem && (s.items[look.unlockItem] ?? 0) <= 0) throw new AppError('NOT_ELIGIBLE', `course look ${lookId} is not owned`);
  }
  st.courseLook = lookId;
  return presetsView(s, v);
}

/** REQ-ROOM-002: validate and store private-room conditions. */
export function setRoomConditions(m: Master, s: PlayerState, input: RoomConditions) {
  const cfg = m.progression.rooms;
  const c = { ...input };
  if (c.trackId !== null) {
    const t = m.tracks.find((x) => x.id === c.trackId);
    if (!t) throw new AppError('NOT_FOUND', `track ${c.trackId}`);
    if (c.going !== null && !(goingsFor(t.surface) as readonly string[]).includes(c.going)) throw new AppError('BAD_REQUEST', `going ${c.going} is not valid on ${t.surface}`);
    if (c.night === true && !m.litTracks.has(t.id)) throw new AppError('BAD_REQUEST', `${t.id} has no lights for night racing`);
  } else if (c.going !== null && !([...TURF_GOINGS, ...DIRT_GOINGS] as string[]).includes(c.going)) {
    throw new AppError('BAD_REQUEST', `unknown going ${c.going}`);
  }
  if (!cfg.weather.includes(c.weather)) throw new AppError('BAD_REQUEST', `weather must be one of ${cfg.weather.join(', ')}`);
  if (!cfg.temperaturesC.includes(c.temperatureC)) throw new AppError('BAD_REQUEST', `temperatureC must be one of ${cfg.temperaturesC.join(', ')}`);
  if (!cfg.windsKmh.includes(c.windKmh)) throw new AppError('BAD_REQUEST', `windKmh must be one of ${cfg.windsKmh.join(', ')}`);
  ensurePresets(s).room = c;
  return presetsView(s);
}

export function clearRoomConditions(s: PlayerState) {
  ensurePresets(s).room = null;
  return presetsView(s);
}

export function presetsView(s: PlayerState, v: VisualsMaster = VISUALS) {
  const st = s.presets ?? { courseLook: null, room: null };
  return {
    courseLook: st.courseLook,
    courseLookKey: v.courseLooks.find((l) => l.id === (st.courseLook ?? v.courseLooks.find((x) => x.default)?.id))?.key ?? null,
    ownedCourseLooks: ownedCourseLooks(s, v),
    room: st.room,
  };
}

/** Same wetness step on the other surface: firm↔fast, good↔good, yielding↔muddy, soft↔sloppy. */
export function goingForSurface(going: Going, surface: 'turf' | 'dirt'): Going {
  const turf = TURF_GOINGS as readonly Going[];
  const dirt = DIRT_GOINGS as readonly Going[];
  const target = surface === 'dirt' ? dirt : turf;
  if (target.includes(going)) return going;
  const i = (surface === 'dirt' ? turf : dirt).indexOf(going);
  return i >= 0 ? target[i]! : 'good';
}

/** REQ-ROOM-003: ground for a friend room race on `trackId`, honouring the host's conditions. */
export function roomGround(m: Master, c: RoomConditions, trackId: string, now: number): Ground {
  const t = m.tracks.find((x) => x.id === trackId);
  const daily = groundFor(m, trackId, 'friend', now) ?? { going: 'good' as Going, night: false };
  const going = c.going !== null && t ? goingForSurface(c.going, t.surface) : daily.going;
  const lit = m.litTracks.has(trackId);
  const night = c.night === null ? daily.night : c.night && lit;
  return { going, night };
}

/** Scene-only conditions sent with the race visuals. */
export function roomScene(c: RoomConditions) {
  return { weather: c.weather, temperatureC: c.temperatureC, windKmh: c.windKmh };
}

/** Problems in a rooms config (remote config validation). */
export function roomsProblems(cfg: unknown): string[] {
  const c = cfg as Partial<RoomsConfig> | undefined;
  if (!c || typeof c !== 'object') return ['rooms: missing'];
  const p: string[] = [];
  if (!Array.isArray(c.weather) || c.weather.length === 0 || c.weather.some((w) => typeof w !== 'string')) p.push('rooms.weather must be a non-empty string list');
  for (const k of ['temperaturesC', 'windsKmh'] as const) {
    const a = c[k];
    if (!Array.isArray(a) || a.length === 0 || a.some((n) => typeof n !== 'number' || !Number.isInteger(n))) p.push(`rooms.${k} must be a non-empty integer list`);
  }
  return p;
}
