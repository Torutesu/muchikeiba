/**
 * GET /v1/races/advice (contracts/protocol.md §39.4, REQ-ADV-005..009): builds the pure advice input from what the player
 * can already see (their own active horses, the course and the day's going, a weekly challenge's card, an event's courses,
 * the styles of the friend-room members the client passes) and runs `computeRaceAdvice`. Read-only: no state changes, no
 * cost, the same for every player (ranked fairness, REQ-ADV-006).
 */
import { AppError } from './errors.js';
import { trackById, type Master } from './master.js';
import type { HorseInstance, PlayerState } from './player.js';
import { raceStats } from './training.js';
import { horseSkill } from './skills.js';
import { classDef } from './season.js';
import { groundFor } from './ground.js';
import { firstRaceOf } from './onboarding.js';
import { DEFAULT_RULESET, type Ruleset } from './ruleset.js';
import { eventRuleset, findEvent } from './events.js';
import { loanRaceHorse, weekAt, weeklyChallengeConfig } from './weeklyChallenge.js';
import { goingsFor, type Going, type RaceHorse } from './schemas.js';
import {
  ADVICE_MAX_HORSES, ADVICE_VERSION, adviceCourse, adviceField, adviceRules, computeRaceAdvice, tutorialAdvice,
  type AdviceCourse, type AdviceHorse, type AdviceInput, type AdviceMode, type AdviceOutput,
} from './raceAdvice.js';

export type AdviceContext = 'ranked' | 'friend' | 'event' | 'challenge' | 'timeattack' | 'tutorial';
export const ADVICE_CONTEXTS: readonly AdviceContext[] = ['ranked', 'friend', 'event', 'challenge', 'timeattack', 'tutorial'];

export interface AdviceQuery {
  context: AdviceContext;
  trackId?: string; going?: Going; night?: boolean;
  challengeId?: string; eventId?: string;
  /** The horse selected on screen (the tips are about it). */
  horseId?: string;
  /** Friend rooms: the running styles of the other members as the room shows them (max 11). */
  field?: string[];
}

export function adviceHorse(m: Master, h: HorseInstance): AdviceHorse {
  const st = raceStats(m, h);
  const sk = horseSkill(m, h);
  return {
    id: h.id, name: h.name, style: h.style, distMinM: h.distMinM, distMaxM: h.distMaxM, surface: h.surface,
    goingAptitude: h.goingAptitude ?? 'any', ...st, skill: sk ? { id: sk.id, name: sk.name, trigger: sk.trigger } : null,
  };
}

function fromRaceHorse(h: RaceHorse): AdviceHorse {
  return {
    id: h.id, name: h.name, style: h.style, distMinM: h.distMinM, distMaxM: h.distMaxM, surface: h.surface, goingAptitude: h.goingAptitude ?? 'any',
    speed: h.speed, stamina: h.stamina, burst: h.burst, guts: h.guts, temper: h.temper, skill: h.skill ? { id: h.skill.id, name: h.skill.name, trigger: h.skill.trigger } : null,
  };
}

const defaultGoing = (surface: 'turf' | 'dirt'): Going => (surface === 'dirt' ? 'fast' : 'good');

/** One known course: the query's going/night when valid for it, else the day's ground for the mode (REQ-RACE-037). */
function knownCourse(m: Master, trackId: string, mode: AdviceMode, q: AdviceQuery, now: number): AdviceCourse {
  const t = trackById(m, trackId);
  if (q.going !== undefined && !(goingsFor(t.surface) as readonly string[]).includes(q.going)) throw new AppError('BAD_REQUEST', `going ${q.going} does not match ${t.surface}`);
  const g = mode === 'timeattack' ? null : groundFor(m, trackId, mode === 'tutorial' ? 'ranked' : mode, now);
  const going = q.going ?? g?.going ?? defaultGoing(t.surface);
  const night = q.night !== undefined ? q.night && m.litTracks.has(trackId) : g?.night ?? false;
  return adviceCourse(t, going, night);
}

/** Every course with its day's ground (the race draws one of them). */
function pool(m: Master, trackIds: readonly string[], mode: AdviceMode, now: number): AdviceCourse[] {
  return trackIds.map((id) => {
    const t = trackById(m, id);
    const g = groundFor(m, id, mode, now);
    return adviceCourse(t, g?.going ?? defaultGoing(t.surface), g?.night ?? false);
  });
}

const activeHorses = (m: Master, s: PlayerState) => s.horses.filter((h) => h.status === 'active').slice(0, ADVICE_MAX_HORSES).map((h) => adviceHorse(m, h));

/** REQ-ADV-005: the advice for this player and race context. */
export function raceAdviceFor(m: Master, s: PlayerState, q: AdviceQuery, now: number, base: Ruleset = DEFAULT_RULESET): AdviceOutput & { context: AdviceContext; input: AdviceInput | null } {
  if (q.context === 'tutorial') return { ...tutorialAdvice(), context: 'tutorial', input: null };
  if (q.field && q.field.length > 11) throw new AppError('BAD_REQUEST', 'field: at most 11 runners');
  let mode: AdviceMode = q.context;
  let courses: AdviceCourse[];
  let horses = activeHorses(m, s);
  let statCap: number | null = null;
  let fixedStats = false;
  let ruleset: Ruleset = base;
  let field = q.field ? adviceField(q.field, 0) : null;
  switch (q.context) {
    case 'ranked': {
      statCap = classDef(m, s.season.classId).statCap;
      // the first ranked race may have a fixed course (REQ-UXS-003); otherwise the course is drawn at the start
      const first = firstRaceOf(m, s)?.trackId ?? null;
      courses = first ? [knownCourse(m, first, 'ranked', {} as AdviceQuery, now)] : pool(m, m.tracks.map((t) => t.id), 'ranked', now);
      field = null;
      break;
    }
    case 'friend':
      courses = q.trackId ? [knownCourse(m, q.trackId, 'friend', q, now)] : pool(m, m.tracks.map((t) => t.id), 'friend', now);
      break;
    case 'timeattack':
      if (!q.trackId) throw new AppError('BAD_REQUEST', 'trackId is required');
      courses = [knownCourse(m, q.trackId, 'timeattack', { context: 'timeattack' }, now)];
      statCap = m.progression.timeAttack.statCap;
      field = adviceField([], 0);
      break;
    case 'challenge': {
      const c = weeklyChallengeConfig(m);
      if (!c || !c.enabled || !q.challengeId) throw new AppError('NOT_FOUND', 'challenge');
      const ch = weekAt(m, c, now).def.challenges.find((x) => x.id === q.challengeId);
      if (!ch) throw new AppError('NOT_FOUND', `challenge ${q.challengeId} is not in this week's set`);
      const t = trackById(m, ch.trackId);
      courses = [adviceCourse(t, ch.going ?? defaultGoing(t.surface), ch.night ?? false)];
      statCap = c.statCap;
      // the loan horse first among equals; own horses only when their style meets the condition (REQ-WCH-003)
      const own = horses.filter((h) => !ch.conditions.style || h.style === ch.conditions.style);
      horses = [fromRaceHorse(loanRaceHorse(m, c, ch)), ...own];
      field = adviceField([], ch.cpuCount);
      break;
    }
    case 'event': {
      if (!q.eventId) throw new AppError('BAD_REQUEST', 'eventId is required');
      const ev = findEvent(m, q.eventId);
      ruleset = eventRuleset(base, ev);
      statCap = ev.rules.statCap;
      fixedStats = ev.rules.fixedStats !== null;
      if (ev.entry.styles) horses = horses.filter((h) => ev.entry.styles!.includes(h.style));
      courses = q.trackId && ev.trackIds.includes(q.trackId) ? [knownCourse(m, q.trackId, 'event', q, now)] : pool(m, ev.trackIds, 'event', now);
      field = null;
      break;
    }
    default:
      throw new AppError('BAD_REQUEST', `unknown context ${String(q.context)}`);
  }
  mode = q.context;
  const input: AdviceInput = {
    v: ADVICE_VERSION, mode, courses, horses, field, rules: adviceRules(ruleset), statCap, fixedStats,
    focusHorseId: q.horseId ?? null,
  };
  // `input` lets the device recompute the tips for another selected horse without a round trip (RaceAdvice.Compute)
  return { ...computeRaceAdvice(input), context: q.context, input };
}
