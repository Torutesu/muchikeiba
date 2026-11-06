import type { Master, WeatherConfig } from './master.js';
import { goingsFor, type Going, type RaceMode, type Track } from './schemas.js';
import { gameDayKey } from './time.js';

/** Ground and lighting for one race (REQ-RACE-034/036/037). */
export interface Ground { going: Going; night: boolean }

const JST_OFFSET_MS = 9 * 3600 * 1000;

/** FNV-1a 32-bit over UTF-16 code units (deterministic, synchronous; not security relevant). */
export function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function jstHour(ms: number): number {
  return new Date(ms + JST_OFFSET_MS).getUTCHours();
}

/** True when `hour` falls in [from, to), wrapping past midnight when from > to. */
export function inNightWindow(hour: number, from: number, to: number): boolean {
  if (from === to) return false;
  return from < to ? hour >= from && hour < to : hour >= from || hour < to;
}

/**
 * The day's going for a course: the same for everyone on a given JST date (a "daily weather seed"), so
 * players can plan around it. Weighted pick from the master weights; unknown names are ignored.
 */
export function dailyGoing(w: WeatherConfig, track: Pick<Track, 'id' | 'surface'>, nowMs: number): Going {
  const names = goingsFor(track.surface);
  const own = w.byTrack?.[track.id];
  const weights = (own && typeof own === 'object' ? own : track.surface === 'dirt' ? w.dirt : w.turf) as Partial<Record<Going, number>>;
  const entries = names.map((n) => [n, Math.max(0, Math.floor(weights[n] ?? 0))] as const).filter(([, wt]) => wt > 0);
  const total = entries.reduce((a, [, wt]) => a + wt, 0);
  if (total === 0) return 'good';
  let roll = fnv1a32(`${w.salt}|${gameDayKey(nowMs)}|${track.id}`) % total;
  for (const [n, wt] of entries) {
    if (roll < wt) return n;
    roll -= wt;
  }
  return 'good';
}

/**
 * Ground for a race being created now, or null when the mode races without weather (tutorial and
 * time attack: no fields are sent, which the engine treats as good ground by day).
 * Order: an operator override covering `nowMs` (course-specific beats global) → the daily going.
 * Night: lit venues inside the JST night window (an override may force day/night).
 */
export function groundFor(m: Master, trackId: string, mode: RaceMode, nowMs: number): Ground | null {
  const w = m.progression.weather;
  if (!w || !w.modes.includes(mode)) return null;
  const track = m.tracks.find((t) => t.id === trackId);
  if (!track) return null;
  const active = w.overrides.filter((o) => nowMs >= o.fromMs && nowMs < o.toMs && (o.trackId === undefined || o.trackId === trackId));
  const ov = active.find((o) => o.trackId === trackId) ?? active.find((o) => o.trackId === undefined);
  const valid = (g: Going) => (goingsFor(track.surface) as readonly string[]).includes(g);
  const going = ov && valid(ov.going) ? ov.going : dailyGoing(w, track, nowMs);
  const lit = m.litTracks.has(trackId);
  const night = lit && (ov?.night ?? inNightWindow(jstHour(nowMs), w.nightFromHourJst, w.nightToHourJst));
  return { going, night };
}

/** Problems in a weather config (remote config validation, REQ-OPS-003). `tracks` checks per-course tables. */
export function weatherProblems(w: unknown, tracks?: readonly Pick<Track, 'id' | 'surface'>[]): string[] {
  const p: string[] = [];
  const x = w as Partial<WeatherConfig> | undefined;
  if (!x || typeof x !== 'object') return ['weather: missing'];
  if (typeof x.salt !== 'string' || x.salt.length === 0) p.push('weather.salt must be a non-empty string');
  for (const [surface, names] of [['turf', goingsFor('turf')], ['dirt', goingsFor('dirt')]] as const) {
    const ws = (x as Record<string, unknown>)[surface] as Record<string, unknown> | undefined;
    if (!ws || typeof ws !== 'object') { p.push(`weather.${surface} missing`); continue; }
    let total = 0;
    for (const [k, v] of Object.entries(ws)) {
      if (!(names as readonly string[]).includes(k)) p.push(`weather.${surface}: unknown going ${k}`);
      else if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) p.push(`weather.${surface}.${k} must be a non-negative integer`);
      else total += v;
    }
    if (total === 0) p.push(`weather.${surface}: weights must not all be zero`);
  }
  const byTrack = (x as Record<string, unknown>).byTrack;
  if (byTrack !== undefined) {
    if (!byTrack || typeof byTrack !== 'object' || Array.isArray(byTrack)) p.push('weather.byTrack must be an object');
    else for (const [tid, ws] of Object.entries(byTrack as Record<string, unknown>)) {
      if (tid.startsWith('_')) continue; // notes
      const track = tracks?.find((t) => t.id === tid);
      if (tracks && !track) { p.push(`weather.byTrack: unknown track ${tid}`); continue; }
      if (!ws || typeof ws !== 'object') { p.push(`weather.byTrack.${tid} must be an object`); continue; }
      const names = (track ? goingsFor(track.surface) : [...goingsFor('turf'), ...goingsFor('dirt')]) as readonly string[];
      let total = 0;
      for (const [k, v] of Object.entries(ws as Record<string, unknown>)) {
        if (!names.includes(k)) p.push(`weather.byTrack.${tid}: unknown going ${k}`);
        else if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) p.push(`weather.byTrack.${tid}.${k} must be a non-negative integer`);
        else total += v;
      }
      if (total === 0) p.push(`weather.byTrack.${tid}: weights must not all be zero`);
    }
  }
  for (const k of ['nightFromHourJst', 'nightToHourJst'] as const) {
    const v = x[k];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 23) p.push(`weather.${k} must be 0..23`);
  }
  if (!Array.isArray(x.modes)) p.push('weather.modes must be an array');
  if (!Array.isArray(x.overrides)) p.push('weather.overrides must be an array');
  else x.overrides.forEach((o, i) => {
    if (typeof o.fromMs !== 'number' || typeof o.toMs !== 'number' || o.fromMs >= o.toMs) p.push(`weather.overrides[${i}]: fromMs < toMs required`);
    const allNames = [...goingsFor('turf'), ...goingsFor('dirt')] as string[];
    if (!allNames.includes(o.going)) p.push(`weather.overrides[${i}]: unknown going ${o.going}`);
  });
  return p;
}
