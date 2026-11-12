/**
 * 練習レース（practice races, REQ-PRAC-001..018, contracts/protocol.md §50).
 *
 * Practice races run ONLY on the device (C# PracticeSession over the real engine). The server's part is tiny and
 * read-only: the catalog the device builds its races from (field size, CPU strengths taken from the existing CPU
 * definitions, every course with its goings / lights / today's ground, the CPU horse pool, the player's own active
 * horses, the active ruleset). There is NO endpoint that accepts a practice result: practice never reaches applyRace,
 * so it cannot grant coins, items, missions, pass XP, season points, rating, stats, hall career, recap records, rival
 * points, team goal progress, exchange points, collection sightings or bond — by construction (no E number).
 */
import practiceJson from '../../master/practice.json';
import tracksJson from '../../master/tracks.json';
import { STAT_KEYS, type Master } from './master.js';
import type { PlayerState } from './player.js';
import { cpuLevelFor } from './matchmaker.js';
import { toRaceHorse, DEFAULT_NET } from './raceConfig.js';
import { groundFor } from './ground.js';
import { capSkill, rulesetSkillCaps, templateSkill, toRaceSkill } from './skills.js';
import { DEFAULT_RULESET, TACTICS_ENGINE_LEVEL, rulesetForMode, type Ruleset } from './ruleset.js';
import { goingsFor, type Going, type RaceHorse } from './schemas.js';
import { PRACTICE_ID_RE } from './practiceKinds.js';

export type PracticeStrengthDef =
  | { id: string; name: string; note: string; from: 'beginnerMatch' }
  | { id: string; name: string; note: string; from: 'rating'; rating: number };
export interface PracticeMaster {
  version: number;
  enabled: boolean;
  fieldSize: { min: number; max: number; default: number };
  defaultStrength: string;
  strengths: PracticeStrengthDef[];
}
export interface PracticeStrength { id: string; name: string; note: string; cpuLevel: number; cpuStatPermille: number }
export interface PracticeCourse {
  trackId: string; name: string; surface: 'turf' | 'dirt'; distanceM: number;
  segments: { kind: 'straight' | 'corner'; lengthM: number; radiusM?: number }[];
  lights: boolean; goings: Going[]; today: { going: Going; night: boolean };
}
export interface PracticeCatalog {
  v: 1;
  enabled: boolean;
  rulesetVersion: string;
  fieldSize: { min: number; max: number; default: number };
  strengths: PracticeStrength[];
  defaultStrength: string;
  courses: PracticeCourse[];
  cpuHorses: RaceHorse[];
  horses: (RaceHorse & { partner: boolean })[];
  ruleset: Ruleset;
  net: typeof DEFAULT_NET;
}

export const PRACTICE_VERSION = 1;
/** The engine's entrant limit (RaceConfig.Validate: 1..12) — a practice field is the player plus 1..11 CPUs. */
export const PRACTICE_FIELD_HARD = { min: 2, max: 12 } as const;
/** Most own horses listed (the same cap as the advice's candidate list). */
export const PRACTICE_MAX_HORSES = 30;
export { PRACTICE_ID_RE, PRACTICE_RESTARTS } from './practiceKinds.js';
/** Shop / urgency / betting words never used in practice texts (docs/planning/03). */
const BANNED = ['倍', 'お得', '今だけ', '残りわずか', '通常価格', '報酬', 'コイン', '馬券', 'オッズ', '予想', '勝率'];

export function practiceOf(m: Pick<Master, 'practice'>): PracticeMaster {
  return m.practice ?? (practiceJson as unknown as PracticeMaster);
}

/** REQ-PRAC-003: a strength's CPU values, resolved from the existing definitions (never numbers of its own). */
export function resolveStrength(m: Master, d: PracticeStrengthDef): PracticeStrength {
  if (d.from === 'beginnerMatch') {
    const bm = m.progression.beginnerMatch;
    return { id: d.id, name: d.name, note: d.note, cpuLevel: bm?.cpuLevel ?? 1, cpuStatPermille: Math.min(1000, bm?.cpuStatPermille ?? 1000) };
  }
  return { id: d.id, name: d.name, note: d.note, cpuLevel: cpuLevelFor(d.rating, false), cpuStatPermille: 1000 };
}

/** REQ-PRAC-003: boot / remote-config check of master/practice.json. */
export function practiceProblems(m: Master): string[] {
  const pm = practiceOf(m);
  const p: string[] = [];
  const int = (v: unknown, lo: number, hi: number) => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;
  if (!int(pm.version, 1, 1000)) p.push('practice.version must be an integer >= 1');
  if (typeof pm.enabled !== 'boolean') p.push('practice.enabled must be a boolean');
  const f = pm.fieldSize;
  if (!f || !int(f.min, PRACTICE_FIELD_HARD.min, PRACTICE_FIELD_HARD.max) || !int(f.max, PRACTICE_FIELD_HARD.min, PRACTICE_FIELD_HARD.max) || f.min > f.max || !int(f.default, f.min, f.max)) {
    p.push(`practice.fieldSize must be min <= default <= max inside ${PRACTICE_FIELD_HARD.min}..${PRACTICE_FIELD_HARD.max}`);
  }
  if (!Array.isArray(pm.strengths) || pm.strengths.length < 1 || pm.strengths.length > 8) { p.push('practice.strengths: 1..8 entries'); return p; }
  const ids = new Set<string>();
  for (const d of pm.strengths) {
    const at = `practice.strengths.${d.id}`;
    if (!PRACTICE_ID_RE.test(d.id ?? '')) p.push(`${at}: bad id`);
    if (ids.has(d.id)) p.push(`${at}: duplicate`);
    ids.add(d.id);
    for (const [k, t] of [['name', d.name], ['note', d.note]] as const) {
      const len = [...(t ?? '')].length;
      if (len < 1 || len > (k === 'name' ? 10 : 30)) p.push(`${at}: ${k} length`);
      for (const w of BANNED) if ((t ?? '').includes(w)) p.push(`${at}: ${k} uses 「${w}」`);
    }
    if (d.from !== 'beginnerMatch' && d.from !== 'rating') p.push(`${at}: from must be beginnerMatch | rating`);
    if (d.from === 'rating' && !int(d.rating, 0, 4000)) p.push(`${at}: rating 0..4000`);
    if (d.from === 'beginnerMatch' || d.from === 'rating') {
      const r = resolveStrength(m, d);
      if (!int(r.cpuLevel, 1, 5)) p.push(`${at}: cpuLevel must be 1..5`);
      if (!int(r.cpuStatPermille, 500, 1000)) p.push(`${at}: cpuStatPermille must be 500..1000`);
    }
  }
  if (!ids.has(pm.defaultStrength)) p.push(`practice.defaultStrength ${pm.defaultStrength} is not a strength`);
  return p;
}

const skillCapped = (h: RaceHorse, ruleset: Ruleset): RaceHorse => {
  const caps = rulesetSkillCaps(ruleset);
  const { skill, ...rest } = h;
  return skill && caps ? { ...rest, skill: capSkill(skill, caps) } : rest;
};

/**
 * REQ-PRAC-002: GET /v1/practice/catalog. Read-only; the same for every player except their own horses (the same
 * information the advice and the stable already show). `base` = the active (remote config) ruleset.
 */
export function practiceCatalog(m: Master, s: PlayerState, now: number, active: Ruleset = DEFAULT_RULESET, engineLevel: number | null = TACTICS_ENGINE_LEVEL): PracticeCatalog {
  const pm = practiceOf(m);
  // ruleset 1.4 rollout: practice is the first place the tactics go (progression.raceTactics.modes.practice), and only for an
  // app whose engine knows 1.4 (x-engine-level ≥ 2; an app that sends none is older: it keeps the active ruleset)
  const base = engineLevel !== null && engineLevel >= TACTICS_ENGINE_LEVEL ? rulesetForMode(active, 'practice', m.progression.raceTactics) : active;
  const courses: PracticeCourse[] = m.tracks.map((t) => {
    const lights = m.litTracks.has(t.id);
    const g = groundFor(m, t.id, 'friend', now); // REQ-RACE-037: the day's ground, as a friend room would have it
    const going = (g?.going ?? (t.surface === 'dirt' ? 'fast' : 'good')) as Going;
    return {
      trackId: t.id, name: trackName(t.id), surface: t.surface, distanceM: t.distanceM,
      segments: t.segments.map((x) => (x.kind === 'corner' ? { kind: 'corner' as const, lengthM: x.lengthM, radiusM: x.radiusM! } : { kind: 'straight' as const, lengthM: x.lengthM })),
      lights, goings: [...goingsFor(t.surface)], today: { going, night: lights && (g?.night ?? false) },
    };
  });
  // the CPU pool of buildRaceConfig: no limited (REQ-BREED-020) or gift-only (REQ-UXS-002) horses
  const cpuHorses: RaceHorse[] = m.templates.filter((t) => !t.seasonal && !t.giftOnly).map((t) => {
    const sk = templateSkill(m, t);
    const h: RaceHorse = {
      id: `cpu_${t.id}`, name: t.name, ...t.stats, style: t.style, distMinM: t.distMinM, distMaxM: t.distMaxM, surface: t.surface,
      ...(t.goingAptitude && t.goingAptitude !== 'any' ? { goingAptitude: t.goingAptitude } : {}), ...(sk ? { skill: toRaceSkill(sk) } : {}),
    };
    return skillCapped(h, base);
  });
  const partner = s.flags?.partnerHorseId ?? null;
  const horses = s.horses.filter((h) => h.status === 'active').slice(0, PRACTICE_MAX_HORSES)
    .map((h) => ({ ...skillCapped(clampStats(toRaceHorse(m, h)), base), partner: h.id === partner }));
  return {
    v: PRACTICE_VERSION, enabled: pm.enabled, rulesetVersion: String(base.rulesetVersion ?? ''),
    fieldSize: { ...pm.fieldSize }, strengths: pm.strengths.map((d) => resolveStrength(m, d)), defaultStrength: pm.defaultStrength,
    courses, cpuHorses, horses, ruleset: base, net: { ...DEFAULT_NET },
  };
}

/** Race stats are 0..1000 in the engine (RaceConfig.Validate). */
function clampStats(h: RaceHorse): RaceHorse {
  const out = { ...h };
  for (const k of STAT_KEYS) out[k] = Math.max(0, Math.min(1000, out[k]));
  return out;
}

const TRACK_NAMES = new Map((tracksJson as { tracks: { id: string; name?: string }[] }).tracks.map((t) => [t.id, t.name ?? t.id]));
const trackName = (id: string) => TRACK_NAMES.get(id) ?? id;
