/**
 * 出走前アドバイス (pre-race coach), contracts/protocol.md §39, REQ-ADV-001..016.
 *
 * `computeRaceAdvice` is a PURE function of plain data (no clock, no random, no master lookups): the course(s), the
 * candidate horses as the player can see them, what is known of the field, and the ruleset values that decide what
 * matters (aptitude penalty, going specialist, drain per going, spurt zone, whip window, skill keys). The C# client
 * mirrors it line for line (engine/Muchi.Client/RaceAdvice.cs) and both are checked against
 * contracts/race-advice.vectors.json, so the device and the server always say the same thing.
 *
 * Honesty rules (REQ-ADV-003/004): every statement comes from these numbers; nothing is drawn at random; no win
 * probability, odds or betting marks; nothing points to a purchase. `adviceTextProblems` is the lint (tests run it
 * over every generated line in Japanese and English).
 */
import type { Going, GoingAptitude, Track } from './schemas.js';

export const ADVICE_VERSION = 1;
/** Fit bonus (‰) of a unique skill that can fire on this course. Small: a skill is a reason, never the deciding factor. */
export const ADVICE_SKILL_BONUS = 3;
/** Fit (‰) for stamina on a course/going that drains more than good ground (share of the stat total). */
export const ADVICE_STAMINA_BONUS = 2;
/** Stamina share (‰ of the stat total) above / below which the stamina check is plus / minus. Uniform = 200. */
export const ADVICE_STAMINA_HIGH = 220, ADVICE_STAMINA_LOW = 180;
/** Temper below this: the horse pulls (掛かり) more often (kakari chance ∝ 1000 − temper), so the rein tip is shown. */
export const ADVICE_TEMPER_LOW = 400;
/** Whip tip: start no earlier than this many metres out (balance-targets R4d: "from 400 m" beats no whip). */
export const ADVICE_WHIP_START_MAX_M = 400;
/** Drain relative to good ground (‰) at or above which the going line says the ground eats stamina. */
export const ADVICE_HEAVY_DRAIN = 1015, ADVICE_LIGHT_DRAIN = 985;
export const ADVICE_MAX_HORSES = 30;
export const ADVICE_MAX_COURSES = 16;

export type AdviceStyle = 'nige' | 'senko' | 'sashi' | 'oikomi';
export type AdviceMode = 'ranked' | 'friend' | 'event' | 'tournament' | 'challenge' | 'timeattack' | 'tutorial';
export const ADVICE_MODES: readonly AdviceMode[] = ['ranked', 'friend', 'event', 'tournament', 'challenge', 'timeattack', 'tutorial'];
const STYLES: readonly AdviceStyle[] = ['nige', 'senko', 'sashi', 'oikomi'];

export interface AdviceCourse {
  trackId: string; surface: 'turf' | 'dirt'; distanceM: number; going: Going; night: boolean;
  /** Number of corner segments (0 = a straight course: a corner-rail skill never fires). */
  corners: number;
  /** Length of the last segment when it is a straight, else 0 (a final-straight skill needs one). */
  finalStraightM: number;
}
export interface AdviceHorse {
  id: string; name: string; style: AdviceStyle; distMinM: number; distMaxM: number; surface: 'turf' | 'dirt' | 'both';
  goingAptitude: GoingAptitude; speed: number; stamina: number; burst: number; guts: number; temper: number;
  skill: { id: string; name: string; trigger: string } | null;
}
/** What is known of the other runners before the race (friend room members, a challenge's CPU count). */
export interface AdviceField { nige: number; senko: number; sashi: number; oikomi: number; unknown: number }
export interface AdviceRules {
  aptitudeOutPenaltyPermille: number;
  goingSpecialistPermille: number;
  maxWhips: number;
  whipDiminishWindowTicks: number;
  tickHz: number;
  spurtDistanceM: number;
  /** 0 = the ruleset has no distance keys (1.1.x and older: nothing scales with distance). */
  distanceRefM: number; distanceRefDirtM: number; spurtDistanceScalePermille: number;
  /** Drain per going, turf [firm, good, yielding, soft] and dirt [fast, good, muddy, sloppy]; all 1000 without ground keys. */
  drainTurf: number[]; drainDirt: number[];
  /** CPU target position per style (‰ of the field), the same numbers the CPU riders aim for. */
  targetRank: Record<AdviceStyle, number>;
  /** The ruleset has the skill keys (1.3+); without them the engine ignores skills. */
  skills: boolean;
}
export interface AdviceInput {
  v: number;
  mode: AdviceMode;
  /** One course = it is known. Several = the race draws one of them (ranked: every course, today's going). */
  courses: AdviceCourse[];
  horses: AdviceHorse[];
  field: AdviceField | null;
  rules: AdviceRules;
  /** The race normalises stats to this total (ranked class cap, challenge, time attack); null = raw stats. */
  statCap: number | null;
  /** Every runner races with the same stats (events with fixed stats): stats and skills do not matter. */
  fixedStats: boolean;
  /** The horse the tips are about (the one selected on screen); default = the suggested horse. */
  focusHorseId: string | null;
}

export type CheckKind = 'distance' | 'surface' | 'going' | 'skill' | 'stamina' | 'pool';
export type CheckMark = 'plus' | 'ok' | 'minus' | 'off';
export interface AdviceCheck { kind: CheckKind; mark: CheckMark; text: string }
export interface AdviceHorseResult {
  horseId: string; name: string; rank: number; fitPermille: number; grade: 'good' | 'ok' | 'poor';
  /** Courses (of `courseCount`) where neither the distance nor the surface is outside the horse's aptitude. */
  fits: number;
  checks: AdviceCheck[];
}
export type LineKind = 'pick' | 'going' | 'night' | 'style' | 'whip' | 'rein' | 'skill' | 'field' | 'rules';
export interface AdviceLine { kind: LineKind; text: string }
export interface AdviceWhipTip { startRemainingM: number; spurtM: number; intervalTicks: number; count: number }
export interface AdviceOutput {
  v: number; mode: AdviceMode; tutorial: boolean; courseCount: number;
  horses: AdviceHorseResult[];
  suggestedHorseId: string | null;
  suggestReason: 'aptitude' | 'stats' | 'only' | 'even' | null;
  focusHorseId: string | null;
  lines: AdviceLine[];
  whip: AdviceWhipTip | null;
  field: (AdviceField & { size: number }) | null;
}

// ------------------------------------------------------------------------------------------------ words

export const GOING_JA: Record<Going, string> = { firm: '良（硬め）', good: '良', yielding: '稍重', soft: '重', fast: '良', muddy: '稍重', sloppy: '不良' };
export const STYLE_JA: Record<AdviceStyle, string> = { nige: '逃げ', senko: '先行', sashi: '差し', oikomi: '追込' };

/** Going index within its surface (0 firm/fast, 1 good, 2 yielding/muddy, 3 soft/sloppy), as the engine's Going enum. */
export function goingIndex(g: Going): number {
  switch (g) {
    case 'firm': case 'fast': return 0;
    case 'yielding': case 'muddy': return 2;
    case 'soft': case 'sloppy': return 3;
    default: return 1;
  }
}

/** The engine's GoingSpecialistPermille (RaceSim.cs), integer division truncating toward zero like C#. */
export function goingSpecialistPermille(apt: GoingAptitude, going: Going, maxPermille: number): number {
  if (apt === 'any' || maxPermille === 0) return 0;
  const gi = goingIndex(going);
  const wet = gi === 0 ? -2 : gi === 2 ? 1 : gi === 3 ? 2 : 0;
  const sign = apt === 'heavy' ? 1 : -1;
  return Math.trunc((sign * wet * maxPermille) / 2);
}

/** RulesetParams.DistanceFactorPermille. */
export function distanceFactorPermille(r: AdviceRules, distanceM: number, dirt: boolean, scalePermille: number): number {
  const ref = dirt ? r.distanceRefDirtM : r.distanceRefM;
  if (ref <= 0 || scalePermille === 0) return 1000;
  const f = 1000 + Math.trunc((scalePermille * (distanceM - ref)) / ref);
  return Math.max(200, Math.min(5000, f));
}

const statTotal = (h: AdviceHorse) => h.speed + h.stamina + h.burst + h.guts + h.temper;

/** A skill's trigger can be met on this course (a corner-rail skill needs a corner, a final-straight one a final straight). */
export function skillFiresOn(trigger: string, c: AdviceCourse): boolean {
  if (trigger === 'cornerRail') return c.corners > 0;
  if (trigger === 'finalStraight') return c.finalStraightM > 0;
  return true;
}

export function skillsApply(input: Pick<AdviceInput, 'mode' | 'rules' | 'fixedStats'>): boolean {
  return input.rules.skills && !input.fixedStats && input.mode !== 'timeattack' && input.mode !== 'challenge' && input.mode !== 'tutorial';
}

function drainRel(r: AdviceRules, c: AdviceCourse): number {
  const t = c.surface === 'dirt' ? r.drainDirt : r.drainTurf;
  const good = t[1] ?? 1000;
  const v = t[goingIndex(c.going)] ?? good;
  return good > 0 ? Math.trunc((v * 1000) / good) : 1000;
}

/** The course asks for stamina: the going drains more than good ground, or (no distance keys) the race is long. */
function staminaDemand(r: AdviceRules, c: AdviceCourse): boolean {
  if (drainRel(r, c) >= ADVICE_HEAVY_DRAIN) return true;
  if (r.distanceRefM <= 0) return c.distanceM >= (c.surface === 'dirt' ? 2000 : 2400);
  return false;
}

interface CourseScore { apt: number; spec: number; skill: number; stam: number; fit: number; distOut: boolean; surfOut: boolean; skillMark: CheckMark; stamMark: CheckMark }

function scoreOn(input: AdviceInput, h: AdviceHorse, c: AdviceCourse, skillsOn: boolean): CourseScore {
  const r = input.rules;
  const distOut = c.distanceM < h.distMinM || c.distanceM > h.distMaxM;
  const surfOut = h.surface !== 'both' && h.surface !== c.surface;
  const apt = -(distOut ? r.aptitudeOutPenaltyPermille : 0) - (surfOut ? r.aptitudeOutPenaltyPermille : 0);
  const spec = goingSpecialistPermille(h.goingAptitude, c.going, r.goingSpecialistPermille);
  let skill = 0;
  let skillMark: CheckMark = 'off';
  if (h.skill && skillsOn) {
    if (skillFiresOn(h.skill.trigger, c)) { skill = ADVICE_SKILL_BONUS; skillMark = 'plus'; } else skillMark = 'minus';
  }
  let stam = 0;
  let stamMark: CheckMark = 'ok';
  if (!input.fixedStats && staminaDemand(r, c)) {
    const total = statTotal(h);
    const share = total > 0 ? Math.trunc((h.stamina * 1000) / total) : 200;
    if (share >= ADVICE_STAMINA_HIGH) { stam = ADVICE_STAMINA_BONUS; stamMark = 'plus'; } else if (share < ADVICE_STAMINA_LOW) { stam = -ADVICE_STAMINA_BONUS; stamMark = 'minus'; }
  }
  return { apt, spec, skill, stam, fit: apt + spec + skill + stam, distOut, surfOut, skillMark, stamMark };
}

const fmt = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

function courseChecks(input: AdviceInput, h: AdviceHorse, c: AdviceCourse, s: CourseScore, skillsOn: boolean): AdviceCheck[] {
  const out: AdviceCheck[] = [];
  out.push(s.distOut
    ? { kind: 'distance', mark: 'minus', text: `距離${fmt(c.distanceM)}mは適性外（${fmt(h.distMinM)}〜${fmt(h.distMaxM)}m）：速さとスタミナが少し落ちる` }
    : { kind: 'distance', mark: 'ok', text: `距離${fmt(c.distanceM)}mは適性内（${fmt(h.distMinM)}〜${fmt(h.distMaxM)}m）` });
  out.push(s.surfOut
    ? { kind: 'surface', mark: 'minus', text: c.surface === 'dirt' ? 'ダートは苦手：速さとスタミナが少し落ちる' : '芝は苦手：速さとスタミナが少し落ちる' }
    : { kind: 'surface', mark: 'ok', text: c.surface === 'dirt' ? 'ダートを走れる' : '芝を走れる' });
  if (s.spec > 0) out.push({ kind: 'going', mark: 'plus', text: `${GOING_JA[c.going]}の馬場が得意` });
  else if (s.spec < 0) out.push({ kind: 'going', mark: 'minus', text: `${GOING_JA[c.going]}の馬場は苦手` });
  if (h.skill) {
    if (!skillsOn) out.push({ kind: 'skill', mark: 'off', text: 'このレースでは固有スキルは使われない' });
    else if (s.skillMark === 'plus') out.push({ kind: 'skill', mark: 'plus', text: `固有スキル「${h.skill.name}」はこのコースで出せる` });
    else out.push({ kind: 'skill', mark: 'minus', text: h.skill.trigger === 'cornerRail' ? `「${h.skill.name}」はこのコースでは出ない（コーナーがない）` : `「${h.skill.name}」はこのコースでは出ない（最後の直線がない）` });
  }
  if (s.stamMark === 'plus') out.push({ kind: 'stamina', mark: 'plus', text: 'スタミナが多く、脚の減る馬場に向く' });
  else if (s.stamMark === 'minus') out.push({ kind: 'stamina', mark: 'minus', text: 'スタミナが少なめ：手綱で脚をためたい' });
  return out;
}

/** REQ-ADV-001..008: the advice. Deterministic: the same input always gives the same output. */
export function computeRaceAdvice(input: AdviceInput): AdviceOutput {
  if (input.mode === 'tutorial') return tutorialAdvice();
  const skillsOn = skillsApply(input);
  const multi = input.courses.length > 1;
  const cap = input.statCap;
  const eff = (h: AdviceHorse) => (input.fixedStats ? 0 : cap !== null ? Math.min(statTotal(h), cap) : statTotal(h));
  const scored = input.horses.map((h) => {
    const per = input.courses.map((c) => scoreOn(input, h, c, skillsOn));
    const fit = per.reduce((a, s) => a + s.fit, 0);
    const fits = per.filter((s) => s.apt === 0).length;
    return { h, per, fit, fits, eff: eff(h) };
  });
  scored.sort((a, b) => b.fit - a.fit || b.eff - a.eff || (a.h.id < b.h.id ? -1 : a.h.id > b.h.id ? 1 : 0));
  const n = input.courses.length;
  const horses: AdviceHorseResult[] = scored.map((x, i) => {
    let grade: AdviceHorseResult['grade'];
    if (multi) grade = x.fits === n ? 'good' : x.fits * 2 < n ? 'poor' : 'ok';
    else grade = x.per[0]!.apt < 0 || x.fit < 0 ? 'poor' : x.fit > 0 ? 'good' : 'ok';
    const checks = multi
      ? [{ kind: 'pool' as const, mark: (x.fits === n ? 'ok' : x.fits * 2 < n ? 'minus' : 'ok') as CheckMark, text: `今日の${n}コースのうち${x.fits}コースで距離と芝・ダートが合う` }]
      : courseChecks(input, x.h, input.courses[0]!, x.per[0]!, skillsOn);
    return { horseId: x.h.id, name: x.h.name, rank: i + 1, fitPermille: x.fit, grade, fits: x.fits, checks };
  });

  let suggested: string | null = null;
  let reason: AdviceOutput['suggestReason'] = null;
  if (scored.length === 1) { suggested = scored[0]!.h.id; reason = 'only'; }
  else if (scored.length > 1) {
    const [a, b] = [scored[0]!, scored[1]!];
    if (a.fit > b.fit) { suggested = a.h.id; reason = 'aptitude'; }
    else if (a.eff > b.eff) { suggested = a.h.id; reason = 'stats'; }
    else reason = 'even';
  }
  const focus = scored.find((x) => x.h.id === input.focusHorseId) ?? scored.find((x) => x.h.id === suggested) ?? scored[0] ?? null;
  const lines: AdviceLine[] = [];
  const top = scored[0];
  if (reason === 'only') lines.push({ kind: 'pick', text: `出走できる馬は${top!.h.name}だけ` });
  else if (reason === 'aptitude') lines.push({ kind: 'pick', text: multi ? `おすすめは${top!.h.name}。今日の${n}コースのうち${top!.fits}コースで距離と芝・ダートが合う` : `おすすめは${top!.h.name}。距離・芝ダート・馬場の条件がいちばん合う` });
  else if (reason === 'stats') lines.push({ kind: 'pick', text: `おすすめは${top!.h.name}。条件は互角で、能力の合計が上` });
  else if (reason === 'even') lines.push({ kind: 'pick', text: 'どの馬も条件は互角。乗り方で差がつく' });

  const r = input.rules;
  const course = multi ? null : input.courses[0] ?? null;
  if (course) {
    const rel = drainRel(r, course);
    if (rel >= ADVICE_HEAVY_DRAIN) lines.push({ kind: 'going', text: `${GOING_JA[course.going]}の馬場：脚が減りやすい。手綱で脚をためる` });
    else if (rel <= ADVICE_LIGHT_DRAIN) lines.push({ kind: 'going', text: `${GOING_JA[course.going]}の馬場：脚が残りやすい` });
    if (course.night) lines.push({ kind: 'night', text: 'ナイター：走りは昼と同じ（見た目だけ）' });
  }

  // field (only what is known before the race)
  let field: AdviceOutput['field'] = null;
  if (input.field) {
    const f = input.field;
    const known = f.nige + f.senko + f.sashi + f.oikomi;
    field = { nige: f.nige, senko: f.senko, sashi: f.sashi, oikomi: f.oikomi, unknown: f.unknown, size: 1 + known + f.unknown };
    if (known > 0) lines.push({ kind: 'field', text: `${field.size}頭立て。相手は逃げ${f.nige}・先行${f.senko}・差し${f.sashi}・追込${f.oikomi}` });
    else lines.push({ kind: 'field', text: `${field.size}頭立て` });
    if (f.unknown > 0) lines.push({ kind: 'field', text: known > 0 ? `ほかの${f.unknown}頭の脚質は出走時に決まる` : '相手の脚質は出走時に決まる' });
  } else lines.push({ kind: 'field', text: '最大12頭。相手は出走時に決まる' });

  if (focus) {
    const h = focus.h;
    if (r.distanceRefM > 0) lines.push({ kind: 'style', text: course ? 'この距離で脚質の有利不利はない' : 'どの距離でも脚質の有利不利はない' });
    else if (course) {
      const ref = course.surface === 'dirt' ? 1800 : 2000;
      if (course.distanceM <= ref - 400) lines.push({ kind: 'style', text: '短い距離：前の馬が残りやすい' });
      else if (course.distanceM >= ref + 400) lines.push({ kind: 'style', text: '長い距離：後ろの馬が伸びやすい' });
    }
    // where the CPU riders of this style aim to be (cpuTargetRank*, ‰ of the field); nothing to say when racing alone
    const size = field ? field.size : 12;
    if (h.style === 'nige') lines.push({ kind: 'style', text: `${STYLE_JA[h.style]}：スタートを決めて先頭で運ぶ` });
    else if (size > 1) {
      const pos = Math.max(2, 1 + Math.trunc(((size - 1) * (r.targetRank[h.style] ?? 0)) / 1000));
      lines.push({ kind: 'style', text: `${STYLE_JA[h.style]}：${pos}番手あたりで運ぶ` });
    }
    if (field && h.style === 'nige') {
      if (field.nige >= 2) lines.push({ kind: 'style', text: '逃げが多い：無理に競らず2番手からでもいい' });
      else if (field.nige === 0 && field.unknown === 0) lines.push({ kind: 'style', text: 'ほかに逃げはいない：楽に先頭に立てる形' });
    }
    if (h.temper < ADVICE_TEMPER_LOW) lines.push({ kind: 'rein', text: '気性が荒い：かかったら手綱を長押し' });
    if (h.skill && skillsOn && course && skillFiresOn(h.skill.trigger, course) && h.skill.trigger === 'goodStart') lines.push({ kind: 'skill', text: `「${h.skill.name}」：ゲートが開いた瞬間にスタート` });
  }

  let whip: AdviceWhipTip | null = null;
  if (course) {
    const f = distanceFactorPermille(r, course.distanceM, course.surface === 'dirt', r.spurtDistanceScalePermille);
    const spurtM = Math.trunc((r.spurtDistanceM * f) / 1000);
    const start = Math.trunc(Math.min(ADVICE_WHIP_START_MAX_M, spurtM) / 50) * 50;
    whip = { startRemainingM: start, spurtM, intervalTicks: r.whipDiminishWindowTicks, count: r.maxWhips };
    const sec = Math.max(1, Math.ceil(r.whipDiminishWindowTicks / Math.max(1, r.tickHz)));
    lines.push({ kind: 'whip', text: `ムチは残り${fmt(start)}mから、${sec}秒以上あけて${r.maxWhips}発まで` });
    lines.push({ kind: 'whip', text: `スパートは残り${fmt(spurtM)}mから。それより前のムチはほとんど効かない` });
  } else {
    lines.push({ kind: 'whip', text: 'ムチは最後の直線で、間隔をあけて' });
  }
  if (cap !== null && !input.fixedStats) lines.push({ kind: 'rules', text: `能力は合計${fmt(cap)}までにそろえて走る` });
  if (input.fixedStats) lines.push({ kind: 'rules', text: '全員が同じ能力で走る' });
  if (!skillsOn && input.horses.some((h) => h.skill)) lines.push({ kind: 'rules', text: 'このレースでは固有スキルは使われない' });

  return {
    v: ADVICE_VERSION, mode: input.mode, tutorial: false, courseCount: n,
    horses, suggestedHorseId: suggested, suggestReason: reason, focusHorseId: focus?.h.id ?? null,
    lines, whip, field,
  };
}

/** REQ-ADV-010: the tutorial's fixed, simple version (the first race has one control, the whip). */
export function tutorialAdvice(): AdviceOutput {
  return {
    v: ADVICE_VERSION, mode: 'tutorial', tutorial: true, courseCount: 1, horses: [], suggestedHorseId: null, suggestReason: null, focusHorseId: null,
    lines: [
      { kind: 'whip', text: '合図が出たら、ムチ' },
      { kind: 'whip', text: 'ムチは間隔をあけて打つと伸びる' },
    ],
    whip: null, field: null,
  };
}

// ------------------------------------------------------------------------------------------------ building the input

/** The ruleset values the advice reads (contracts/ruleset-params.default.json; absent optional groups → neutral). */
export function adviceRules(rs: Record<string, unknown>): AdviceRules {
  const n = (k: string, d = 0) => (typeof rs[k] === 'number' ? (rs[k] as number) : d);
  const hasGround = typeof rs.goingTurfGoodDrainPermille === 'number';
  const hasDistance = typeof rs.distanceRefM === 'number';
  return {
    aptitudeOutPenaltyPermille: n('aptitudeOutPenaltyPermille'),
    goingSpecialistPermille: hasGround ? n('goingSpecialistPermille') : 0,
    maxWhips: n('maxWhips'), whipDiminishWindowTicks: n('whipDiminishWindowTicks'), tickHz: 20,
    spurtDistanceM: n('spurtDistanceM'),
    distanceRefM: hasDistance ? n('distanceRefM') : 0, distanceRefDirtM: hasDistance ? n('distanceRefDirtM') : 0,
    spurtDistanceScalePermille: hasDistance ? n('spurtDistanceScalePermille') : 0,
    drainTurf: hasGround ? ['Firm', 'Good', 'Yielding', 'Soft'].map((g) => n(`goingTurf${g}DrainPermille`, 1000)) : [1000, 1000, 1000, 1000],
    drainDirt: hasGround ? ['Fast', 'Good', 'Muddy', 'Sloppy'].map((g) => n(`goingDirt${g}DrainPermille`, 1000)) : [1000, 1000, 1000, 1000],
    targetRank: { nige: n('cpuTargetRankNigePermille'), senko: n('cpuTargetRankSenkoPermille'), sashi: n('cpuTargetRankSashiPermille'), oikomi: n('cpuTargetRankOikomiPermille') },
    skills: typeof rs.skillMaxSpeedPermille === 'number',
  };
}

export function adviceCourse(t: Pick<Track, 'id' | 'surface' | 'distanceM' | 'segments'>, going: Going, night: boolean): AdviceCourse {
  const last = t.segments[t.segments.length - 1];
  return {
    trackId: t.id, surface: t.surface, distanceM: t.distanceM, going, night,
    corners: t.segments.filter((s) => s.kind === 'corner').length,
    finalStraightM: last && last.kind === 'straight' ? last.lengthM : 0,
  };
}

/** Field counts from the styles of the known opponents plus the runners still unknown. */
export function adviceField(styles: readonly string[], unknown: number): AdviceField {
  const f: AdviceField = { nige: 0, senko: 0, sashi: 0, oikomi: 0, unknown: Math.max(0, unknown) };
  for (const s of styles) if ((STYLES as readonly string[]).includes(s)) f[s as AdviceStyle]++;
  return f;
}

// ------------------------------------------------------------------------------------------------ lint (REQ-ADV-004)

/** Words the advice must never use: win probability, odds, betting marks, purchases, urgency (Japanese). */
export const ADVICE_BANNED_JA: readonly RegExp[] = [
  /勝率/, /確率/, /オッズ/, /本命/, /対抗/, /大穴/, /穴馬/, /単勝/, /複勝/, /馬券/, /予想/, /必勝/, /勝てる/, /絶対/, /確実/, /[%％]/, /倍/,
  /買/, /購入/, /課金/, /ガチャ/, /スカウト/, /ショップ/, /有償/, /今だけ/, /残りわずか/, /お得/, /通常価格/, /[◎○▲△☆]/,
];
/** The same in English (the catalog's translations are linted too). */
export const ADVICE_BANNED_EN: readonly RegExp[] = [
  /odds/i, /win rate/i, /chance/i, /probab/i, /favou?rite/i, /long ?shot/i, /\bbet(s|ting|tor)?\b/i, /\bbuy/i, /purchas/i, /\bshop/i, /scout/i, /gacha/i,
  /guarantee/i, /sure win/i, /%/, /\bdouble\b/i, /\bx2\b/i, /limited time/i, /\bpaid\b/i,
];

/** Problems in one advice text (empty = clean). */
export function adviceTextProblems(text: string): string[] {
  return [...ADVICE_BANNED_JA, ...ADVICE_BANNED_EN].filter((re) => re.test(text)).map((re) => `banned in advice: ${re.source} in "${text}"`);
}

/** Every text of an advice result (lines and per-horse checks). */
export function adviceTexts(a: AdviceOutput): string[] {
  return [...a.lines.map((l) => l.text), ...a.horses.flatMap((h) => h.checks.map((c) => c.text))];
}
