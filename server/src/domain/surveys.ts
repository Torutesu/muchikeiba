/**
 * REQ-SURVEY-001..024: ゲーム内アンケート (ops-run in-app surveys, contracts/protocol.md §69).
 *
 * The live-ops team asks players a few short questions (1–5: single choice, multiple choice, a 1–5 scale, an optional short
 * free text). Ops write the definitions in the console (src/ops/surveys.ts keeps them in OpsDO tables); this module holds
 * the pure parts every side shares: the definition rules (incl. the wording lint), the config, the targeting, the offer
 * decision, the answer validation and the free-text scrub, and the player's own state (`surveys`).
 *
 * NOTHING is granted for answering (incentive bias, 景表法): no route here touches the wallet, items, missions, titles or XP,
 * and a definition or config carrying a reward-like key fails validation. Skipping is one tap and that survey never comes
 * back. Never during the FTUE; the device shows it through the §58.11 one-prompt-per-session gate with the lowest priority.
 */
import { AppError } from './errors.js';
import type { Master } from './master.js';
import type { PlayerState } from './player.js';
import type { KpiEvent } from './kpi.js';
import { deletionScheduled } from './accountDeletion.js';
import { bettingWordsIn } from './bettingWords.js';
import { HELP_BANNED_JA } from './help.js';
import { foldForCompare } from './horses.js';
import { compareVersions, parseVersion } from './maintenance.js';
import { FREE_TEXT_SCRUB_RULES, fnv1a64 } from './clientErrors.js';

// ------------------------------------------------------------------------------------------------ vocabulary

export const SURVEY_KINDS = ['single', 'multi', 'scale', 'text'] as const;
export type SurveyKind = (typeof SURVEY_KINDS)[number];
/**
 * R22 integration (the user's change): surveys never appear in a prominent place and never interrupt. The one place is a
 * quiet row inside お知らせ (`inbox`) the player opens on purpose — no home card, no sheet after a race result, not in the
 * §58.11 prompt table, at most a small unread dot on that screen and never a badge on the home screen.
 */
export const SURVEY_PLACEMENTS = ['inbox'] as const;
export type SurveyPlacement = (typeof SURVEY_PLACEMENTS)[number];
export const SURVEY_PLATFORMS = ['ios', 'android', 'editor'] as const;
export type SurveyPlatform = (typeof SURVEY_PLATFORMS)[number];
/** Offer decision order (protocol §69.4): the first reason that applies wins. */
export const SURVEY_REASONS = ['disabled', 'account_closing', 'ftue', 'cool_down', 'none'] as const;
export type SurveyReason = (typeof SURVEY_REASONS)[number];
export const SURVEY_ID_RE = /^sv_[a-z0-9_]{2,40}$/;
export const QUESTION_ID_RE = /^[a-z][a-z0-9_]{0,23}$/;
export const OPTION_ID_RE = /^[a-z0-9_]{1,24}$/;
export const SURVEY_LIMITS = { questions: 5, options: 6, minOptions: 2, title: 40, intro: 120, question: 120, option: 40, label: 20, textMax: 200, windowDays: 90 } as const;
/** Keys that would make an answer pay (never allowed anywhere in a definition or the config). */
const REWARD_KEY = /^(rewards?|coins?|items?|grants?|gifts?|bonus(es)?|incentives?|xp|prizes?)$/i;

export interface LocalText { ja: string; en: string }
export interface SurveyOption { id: string; text: LocalText }
export interface SurveyQuestion {
  id: string; kind: SurveyKind; required: boolean; text: LocalText;
  options?: SurveyOption[]; maxChoices?: number; labels?: { low: LocalText; high: LocalText }; maxLength?: number;
}
export interface SurveyTargeting {
  minRankedRaces?: number; minDaysSinceInstall?: number; maxDaysSinceInstall?: number; platforms?: SurveyPlatform[];
  appVersion?: { min?: string; max?: string }; classes?: string[]; samplePercent?: number;
}
export interface SurveyDef {
  id: string; title: LocalText; intro?: LocalText; targeting: SurveyTargeting; questions: SurveyQuestion[];
}
/** A definition as the player routes see it: live, with its window and edit revision. */
export interface LiveSurvey { def: SurveyDef; rev: number; startAt: number; endAt: number }

// ------------------------------------------------------------------------------------------------ config (REQ-SURVEY-004)

export interface SurveysConfig { enabled: boolean; coolDownHours: number; maxShowsPerSurvey: number; maxLive: number; textMax: number }
export const SURVEYS_DEFAULTS: SurveysConfig = { enabled: true, coolDownHours: 72, maxShowsPerSurvey: 2, maxLive: 5, textMax: 200 };
const CONFIG_KEYS = ['enabled', 'coolDownHours', 'maxShowsPerSurvey', 'maxLive', 'textMax', '_note'];

export function surveysConfig(m: Pick<Master, 'progression'>): SurveysConfig {
  const c = (m.progression as { surveys?: Record<string, unknown> }).surveys ?? {};
  const known = Object.fromEntries(Object.entries(c).filter(([k]) => !k.startsWith('_'))) as Partial<SurveysConfig>; // `_note`
  return { ...SURVEYS_DEFAULTS, ...known };
}

const isInt = (v: unknown, lo: number, hi: number) => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** REQ-SURVEY-004: boot and every remote-config version. */
export function surveysProblems(m: Pick<Master, 'progression'>, path = 'progression.surveys'): string[] {
  const raw = (m.progression as { surveys?: unknown }).surveys;
  if (raw === undefined) return [];
  if (!isObj(raw)) return [`${path} must be an object`];
  const p: string[] = [];
  for (const k of Object.keys(raw)) {
    if (CONFIG_KEYS.includes(k)) continue;
    p.push(REWARD_KEY.test(k) ? `${path}.${k}: survey answers are never rewarded (incentive bias, 景表法)` : `${path}.${k} is not a known key`);
  }
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') p.push(`${path}.enabled must be a boolean`);
  if (raw.coolDownHours !== undefined && !isInt(raw.coolDownHours, 0, 2160)) p.push(`${path}.coolDownHours must be an integer 0..2160`);
  if (raw.maxShowsPerSurvey !== undefined && !isInt(raw.maxShowsPerSurvey, 1, 5)) p.push(`${path}.maxShowsPerSurvey must be an integer 1..5`);
  if (raw.maxLive !== undefined && !isInt(raw.maxLive, 1, 20)) p.push(`${path}.maxLive must be an integer 1..20`);
  if (raw.textMax !== undefined && !isInt(raw.textMax, 20, SURVEY_LIMITS.textMax)) p.push(`${path}.textMax must be an integer 20..${SURVEY_LIMITS.textMax}`);
  return p;
}

// ------------------------------------------------------------------------------------------------ definitions (REQ-SURVEY-001/002)

/** Words a survey text may not use: the shared betting words, the shop's pressure words, the real-name NG list. */
export function surveyWordingProblems(m: Pick<Master, 'ng'>, text: string, at: string): string[] {
  const out: string[] = [];
  const bet = bettingWordsIn(text);
  if (bet.length) out.push(`${at}: betting words are not allowed (${bet.join(', ')})`);
  const pressure = HELP_BANNED_JA.filter((w) => text.includes(w));
  if (pressure.length) out.push(`${at}: pressure wording is not allowed (${pressure.join(', ')})`);
  const f = foldForCompare(text.normalize('NFKC').toLowerCase());
  const ng = [...m.ng.exact.filter((n) => foldForCompare(n) === f), ...m.ng.contains.filter((n) => f.includes(foldForCompare(n)))];
  if (ng.length) out.push(`${at}: names on the NG list are not allowed (${ng.join(', ')})`);
  return out;
}

function unknownKeys(o: Record<string, unknown>, known: readonly string[], at: string): string[] {
  return Object.keys(o).filter((k) => !known.includes(k)).map((k) => (REWARD_KEY.test(k)
    ? `${at}.${k}: survey answers are never rewarded (incentive bias, 景表法)`
    : `${at}.${k} is not a known key`));
}

function textProblems(m: Pick<Master, 'ng'>, v: unknown, max: number, at: string): string[] {
  if (!isObj(v)) return [`${at} must be { ja, en }`];
  const p = unknownKeys(v, ['ja', 'en'], at);
  for (const lang of ['ja', 'en'] as const) {
    const s = v[lang];
    if (typeof s !== 'string' || s.trim() === '') { p.push(`${at}.${lang} is required (Japanese and English)`); continue; }
    if ([...s].length > max) p.push(`${at}.${lang} is longer than ${max} characters`);
    if (/[\u0000-\u001f]/.test(s)) p.push(`${at}.${lang} has control characters`);
    p.push(...surveyWordingProblems(m, s, `${at}.${lang}`));
  }
  return p;
}

const Q_KEYS = ['id', 'kind', 'required', 'text', 'options', 'maxChoices', 'labels', 'maxLength'];
const T_KEYS = ['minRankedRaces', 'minDaysSinceInstall', 'maxDaysSinceInstall', 'platforms', 'appVersion', 'classes', 'samplePercent'];

/** REQ-SURVEY-001/002: every problem of a definition (empty = valid). `classIds` = the master's class ids. */
export function surveyDefProblems(m: Pick<Master, 'ng' | 'progression'>, raw: unknown, cfg: SurveysConfig = surveysConfig(m)): string[] {
  if (!isObj(raw)) return ['the survey must be an object'];
  // R22 integration: no `placements` key any more (one quiet place, お知らせ); an old definition naming one is refused
  const p = unknownKeys(raw, ['id', 'title', 'intro', 'targeting', 'questions'], 'survey');
  if (typeof raw.id !== 'string' || !SURVEY_ID_RE.test(raw.id)) p.push('survey.id must be sv_ + 2..40 of a-z, 0-9, _');
  p.push(...textProblems(m, raw.title, SURVEY_LIMITS.title, 'survey.title'));
  if (raw.intro !== undefined) p.push(...textProblems(m, raw.intro, SURVEY_LIMITS.intro, 'survey.intro'));
  const t = raw.targeting ?? {};
  if (!isObj(t)) p.push('survey.targeting must be an object');
  else {
    p.push(...unknownKeys(t, T_KEYS, 'survey.targeting'));
    if (t.minRankedRaces !== undefined && !isInt(t.minRankedRaces, 0, 100_000)) p.push('survey.targeting.minRankedRaces must be an integer 0..100000');
    for (const k of ['minDaysSinceInstall', 'maxDaysSinceInstall'] as const) if (t[k] !== undefined && !isInt(t[k], 0, 3650)) p.push(`survey.targeting.${k} must be an integer 0..3650`);
    if (isInt(t.minDaysSinceInstall, 0, 3650) && isInt(t.maxDaysSinceInstall, 0, 3650) && (t.minDaysSinceInstall as number) > (t.maxDaysSinceInstall as number)) p.push('survey.targeting: minDaysSinceInstall > maxDaysSinceInstall');
    if (t.platforms !== undefined) {
      if (!Array.isArray(t.platforms) || t.platforms.length === 0) p.push('survey.targeting.platforms must be a non-empty list');
      else for (const x of t.platforms) if (!(SURVEY_PLATFORMS as readonly unknown[]).includes(x)) p.push(`survey.targeting.platforms: unknown platform ${String(x)}`);
    }
    if (t.appVersion !== undefined) {
      const v = t.appVersion;
      if (!isObj(v)) p.push('survey.targeting.appVersion must be { min?, max? }');
      else {
        p.push(...unknownKeys(v, ['min', 'max'], 'survey.targeting.appVersion'));
        for (const k of ['min', 'max'] as const) if (v[k] !== undefined && (typeof v[k] !== 'string' || !parseVersion(v[k] as string))) p.push(`survey.targeting.appVersion.${k} must be x.y.z`);
        if (typeof v.min === 'string' && typeof v.max === 'string' && parseVersion(v.min) && parseVersion(v.max) && compareVersions(v.min, v.max) > 0) p.push('survey.targeting.appVersion: min > max');
      }
    }
    if (t.classes !== undefined) {
      const ids = (m.progression.classes ?? []).map((c) => c.id);
      if (!Array.isArray(t.classes) || t.classes.length === 0) p.push('survey.targeting.classes must be a non-empty list');
      else for (const x of t.classes) if (!ids.includes(x as string)) p.push(`survey.targeting.classes: unknown class ${String(x)}`);
    }
    if (t.samplePercent !== undefined && !isInt(t.samplePercent, 1, 100)) p.push('survey.targeting.samplePercent must be an integer 1..100');
  }
  const qs = raw.questions;
  if (!Array.isArray(qs) || qs.length < 1 || qs.length > SURVEY_LIMITS.questions) p.push(`survey.questions must have 1..${SURVEY_LIMITS.questions} questions`);
  else {
    const seen = new Set<string>();
    qs.forEach((q, i) => {
      const at = `survey.questions[${i}]`;
      if (!isObj(q)) { p.push(`${at} must be an object`); return; }
      p.push(...unknownKeys(q, Q_KEYS, at));
      if (typeof q.id !== 'string' || !QUESTION_ID_RE.test(q.id)) p.push(`${at}.id must start with a-z (1..24 of a-z, 0-9, _)`);
      else if (seen.has(q.id)) p.push(`${at}.id ${q.id} is used twice`);
      else seen.add(q.id);
      if (!(SURVEY_KINDS as readonly unknown[]).includes(q.kind)) { p.push(`${at}.kind must be one of ${SURVEY_KINDS.join(', ')}`); return; }
      if (typeof q.required !== 'boolean') p.push(`${at}.required must be a boolean`);
      p.push(...textProblems(m, q.text, SURVEY_LIMITS.question, `${at}.text`));
      const kind = q.kind as SurveyKind;
      const allow = { options: kind === 'single' || kind === 'multi', maxChoices: kind === 'multi', labels: kind === 'scale', maxLength: kind === 'text' };
      for (const k of Object.keys(allow) as (keyof typeof allow)[]) if (!allow[k] && q[k] !== undefined) p.push(`${at}.${k} is not used by a ${kind} question`);
      if (allow.options) {
        const os = q.options;
        if (!Array.isArray(os) || os.length < SURVEY_LIMITS.minOptions || os.length > SURVEY_LIMITS.options) p.push(`${at}.options must have ${SURVEY_LIMITS.minOptions}..${SURVEY_LIMITS.options} choices`);
        else {
          const ids = new Set<string>();
          os.forEach((o, j) => {
            const oa = `${at}.options[${j}]`;
            if (!isObj(o)) { p.push(`${oa} must be an object`); return; }
            p.push(...unknownKeys(o, ['id', 'text'], oa));
            if (typeof o.id !== 'string' || !OPTION_ID_RE.test(o.id)) p.push(`${oa}.id must be 1..24 of a-z, 0-9, _`);
            else if (ids.has(o.id)) p.push(`${oa}.id ${o.id} is used twice`);
            else ids.add(o.id);
            p.push(...textProblems(m, o.text, SURVEY_LIMITS.option, `${oa}.text`));
          });
          if (kind === 'multi' && q.maxChoices !== undefined && !isInt(q.maxChoices, 1, os.length)) p.push(`${at}.maxChoices must be an integer 1..${os.length}`);
        }
      }
      if (allow.labels) {
        const l = q.labels;
        if (!isObj(l)) p.push(`${at}.labels must be { low, high }`);
        else {
          p.push(...unknownKeys(l, ['low', 'high'], `${at}.labels`));
          p.push(...textProblems(m, l.low, SURVEY_LIMITS.label, `${at}.labels.low`), ...textProblems(m, l.high, SURVEY_LIMITS.label, `${at}.labels.high`));
        }
      }
      if (allow.maxLength) {
        if (q.required === true) p.push(`${at}: a free-text question is always optional (required: false)`);
        if (!isInt(q.maxLength, 1, cfg.textMax)) p.push(`${at}.maxLength must be an integer 1..${cfg.textMax}`);
      }
    });
  }
  return p;
}

/** A definition that passed surveyDefProblems (a copy with defaults filled in: maxChoices, targeting). */
export function normalizeSurveyDef(raw: SurveyDef): SurveyDef {
  const d = JSON.parse(JSON.stringify(raw)) as SurveyDef;
  d.targeting ??= {};
  for (const q of d.questions) if (q.kind === 'multi' && q.maxChoices === undefined) q.maxChoices = q.options!.length;
  return d;
}

/** REQ-SURVEY-003: the publish window. */
export function surveyWindowProblems(startAt: unknown, endAt: unknown, now: number): string[] {
  const p: string[] = [];
  if (!Number.isInteger(startAt) || !Number.isInteger(endAt)) return ['startAt and endAt must be epoch milliseconds'];
  if ((startAt as number) >= (endAt as number)) p.push('startAt must be before endAt');
  if ((endAt as number) <= now) p.push('endAt must be in the future');
  if ((endAt as number) - (startAt as number) > SURVEY_LIMITS.windowDays * 86_400_000) p.push(`a survey runs ${SURVEY_LIMITS.windowDays} days at most`);
  return p;
}

// ------------------------------------------------------------------------------------------------ targeting (REQ-SURVEY-001)

/** What the player routes know about the request (headers) and the player (state). */
export interface SurveyFacts { platform: string | null; appVersion: string | null; inFtue?: boolean }

const DAY_MS = 86_400_000;
/** The stable sample bucket 0..99 of a player for a survey (fnv1a64 of "<surveyId>:<playerId>" mod 100). */
export const sampleBucket = (surveyId: string, playerId: string) => Number(BigInt(`0x${fnv1a64(`${surveyId}:${playerId}`)}`) % 100n);

export function targets(t: SurveyTargeting, surveyId: string, s: PlayerState, f: SurveyFacts, now: number): boolean {
  if (t.minRankedRaces !== undefined && s.rating.rankedRaces < t.minRankedRaces) return false;
  const days = Math.floor((now - s.createdAt) / DAY_MS);
  if (t.minDaysSinceInstall !== undefined && days < t.minDaysSinceInstall) return false;
  if (t.maxDaysSinceInstall !== undefined && days > t.maxDaysSinceInstall) return false;
  if (t.platforms && !(f.platform && (t.platforms as string[]).includes(f.platform))) return false;
  if (t.appVersion && (t.appVersion.min || t.appVersion.max)) {
    if (!f.appVersion || !parseVersion(f.appVersion)) return false;
    if (t.appVersion.min && compareVersions(f.appVersion, t.appVersion.min) < 0) return false;
    if (t.appVersion.max && compareVersions(f.appVersion, t.appVersion.max) > 0) return false;
  }
  if (t.classes && !t.classes.includes(s.season.classId)) return false;
  if (t.samplePercent !== undefined && sampleBucket(surveyId, s.id) >= t.samplePercent) return false;
  return true;
}

// ------------------------------------------------------------------------------------------------ state

export type SurveyAnswerValue = string | string[] | number;
export type SurveyAnswers = Record<string, SurveyAnswerValue>;
export interface SurveyDone {
  at: number; outcome: 'answered' | 'skipped'; placement: SurveyPlacement; title: LocalText;
  answers?: SurveyAnswers; rev?: number;
  /** The OpsDO row was written (answered only). */
  synced?: boolean;
  /** The analytics segment sent with the row (null = analytics off at the time). */
  segment?: SurveySegment | null;
}
export interface SurveysState {
  v: 1;
  shows: Record<string, { n: number; firstAt: number; lastAt: number }>;
  done: Record<string, SurveyDone>;
  /** The survey shown and not yet answered or skipped (one at a time). */
  current: string | null;
  lastDoneAt: number | null;
}
export const SURVEYS_KEEP = 100;

export function ensureSurveys(s: PlayerState): SurveysState {
  s.surveys ??= { v: 1, shows: {}, done: {}, current: null, lastDoneAt: null };
  return s.surveys;
}
/** Keep the newest SURVEYS_KEEP finished surveys (and the shows of unfinished ones only). */
function prune(st: SurveysState) {
  const ids = Object.keys(st.done).sort((a, b) => st.done[b]!.at - st.done[a]!.at);
  for (const id of ids.slice(SURVEYS_KEEP)) delete st.done[id];
  for (const id of Object.keys(st.shows)) if (st.done[id]) delete st.shows[id];
  const open = Object.keys(st.shows).sort((a, b) => st.shows[b]!.lastAt - st.shows[a]!.lastAt);
  for (const id of open.slice(SURVEYS_KEEP)) delete st.shows[id];
}

/** The answer's analytics segment (REQ-SURVEY-013): coarse bands only, never the id; null while analytics is off. */
export interface SurveySegment { platform: string; classId: string; rankedBand: '0-9' | '10-49' | '50+'; installBand: '<7d' | '7-29d' | '30d+' }
export function segmentOf(s: PlayerState, f: SurveyFacts, now: number): SurveySegment {
  const r = s.rating.rankedRaces, days = Math.floor((now - s.createdAt) / DAY_MS);
  return {
    platform: f.platform && (SURVEY_PLATFORMS as readonly string[]).includes(f.platform) ? f.platform : 'unknown',
    classId: s.season.classId, rankedBand: r < 10 ? '0-9' : r < 50 ? '10-49' : '50+', installBand: days < 7 ? '<7d' : days < 30 ? '7-29d' : '30d+',
  };
}

// ------------------------------------------------------------------------------------------------ the offer (REQ-SURVEY-005)

export type SurveyLang = 'ja' | 'en';
const pick = (t: LocalText, lang: SurveyLang) => t[lang];

/** What the device draws: the texts of one language only. */
export function surveyView(l: LiveSurvey, lang: SurveyLang, placement: SurveyPlacement) {
  const d = l.def;
  return {
    id: d.id, rev: l.rev, placement, endAt: l.endAt, title: pick(d.title, lang), intro: d.intro ? pick(d.intro, lang) : null,
    questions: d.questions.map((q) => ({
      id: q.id, kind: q.kind, required: q.required, text: pick(q.text, lang),
      options: q.options ? q.options.map((o) => ({ id: o.id, text: pick(o.text, lang) })) : null,
      maxChoices: q.kind === 'multi' ? (q.maxChoices ?? q.options!.length) : null,
      labels: q.labels ? { low: pick(q.labels.low, lang), high: pick(q.labels.high, lang) } : null,
      maxLength: q.kind === 'text' ? q.maxLength ?? SURVEY_LIMITS.textMax : null,
    })),
  };
}
export type SurveyView = ReturnType<typeof surveyView>;

/** `unread`: the survey was never opened yet (the お知らせ row may show a small dot; nothing on the home screen). */
export interface SurveyOfferResult { survey: SurveyView | null; reason: SurveyReason | null; unread: boolean }

export const inFtue = (s: PlayerState) => !s.flags.tutorialGachaUsed;

/** REQ-SURVEY-005: which survey (at most one) to show at this placement. Pure; the state is only read. */
export function decideSurveyOffer(cfg: SurveysConfig, live: LiveSurvey[], s: PlayerState, f: SurveyFacts, placement: SurveyPlacement, lang: SurveyLang, now: number): SurveyOfferResult {
  const no = (reason: SurveyReason): SurveyOfferResult => ({ survey: null, reason, unread: false });
  const yes = (l: LiveSurvey): SurveyOfferResult => ({ survey: surveyView(l, lang, placement), reason: null, unread: (s.surveys?.shows[l.def.id]?.n ?? 0) === 0 });
  if (!cfg.enabled) return no('disabled');
  if (deletionScheduled(s)) return no('account_closing');
  if (inFtue(s) || f.inFtue) return no('ftue');
  const st = s.surveys;
  const open = (l: LiveSurvey) => l.startAt <= now && now < l.endAt && !st?.done[l.def.id]
    && (st?.shows[l.def.id]?.n ?? 0) < cfg.maxShowsPerSurvey && targets(l.def.targeting, l.def.id, s, f, now);
  const cur = st?.current ? live.find((l) => l.def.id === st.current) : undefined;
  if (cur && open(cur)) return yes(cur);
  if (st?.lastDoneAt != null && now - st.lastDoneAt < cfg.coolDownHours * 3_600_000) return no('cool_down');
  const order = [...live].sort((a, b) => a.endAt - b.endAt || (a.def.id < b.def.id ? -1 : 1));
  const next = order.find(open);
  return next ? yes(next) : no('none');
}

// ------------------------------------------------------------------------------------------------ answers (REQ-SURVEY-009/012)

const PHONE = /(?<![0-9])[0-9]{2,4}[- ][0-9]{2,4}[- ][0-9]{3,4}(?![0-9])/g;

/** REQ-SURVEY-012: the §60.3 PII rules for free text (emails, tokens, URLs, long ids, long numbers, phone numbers). */
export function scrubFreeText(raw: string, max: number): string {
  let s = raw.normalize('NFKC').replace(/[\u0000-\u001f\u007f]+/g, ' ');
  for (const [re, to] of FREE_TEXT_SCRUB_RULES) s = s.replace(re, to);
  s = s.replace(PHONE, '<n>').replace(/[ \t]+/g, ' ').trim();
  const cps = [...s];
  return cps.length <= max ? s : cps.slice(0, max).join('');
}

/**
 * REQ-SURVEY-009: the strict answer check (400 BAD_REQUEST with every problem). Returns the cleaned answers: only answered
 * questions, free text scrubbed and capped; whitespace-only text counts as no answer.
 */
export function validateSurveyAnswers(def: SurveyDef, raw: unknown, cfg: SurveysConfig): SurveyAnswers {
  if (!isObj(raw)) throw new AppError('BAD_REQUEST', 'answers must be an object keyed by question id');
  const p: string[] = [];
  const out: SurveyAnswers = {};
  const byId = new Map(def.questions.map((q) => [q.id, q]));
  for (const k of Object.keys(raw)) if (!byId.has(k)) p.push(`unknown question ${k}`);
  for (const q of def.questions) {
    const v = raw[q.id];
    if (v === undefined || v === null) { if (q.required) p.push(`${q.id} is required`); continue; }
    const optIds = (q.options ?? []).map((o) => o.id);
    switch (q.kind) {
      case 'single':
        if (typeof v !== 'string' || !optIds.includes(v)) p.push(`${q.id}: one of ${optIds.join(', ')}`);
        else out[q.id] = v;
        break;
      case 'multi': {
        const max = q.maxChoices ?? optIds.length;
        if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || !optIds.includes(x))) p.push(`${q.id}: a list of ${optIds.join(', ')}`);
        else if (new Set(v).size !== v.length) p.push(`${q.id}: duplicates`);
        else if (v.length === 0) { if (q.required) p.push(`${q.id} is required`); }
        else if (v.length > max) p.push(`${q.id}: at most ${max} choices`);
        else out[q.id] = optIds.filter((o) => v.includes(o)); // the definition's order
        break;
      }
      case 'scale':
        if (!Number.isInteger(v) || (v as number) < 1 || (v as number) > 5) p.push(`${q.id}: an integer 1..5`);
        else out[q.id] = v as number;
        break;
      case 'text': {
        const max = Math.min(q.maxLength ?? cfg.textMax, cfg.textMax);
        if (typeof v !== 'string') { p.push(`${q.id}: text`); break; }
        if ([...v].length > max) { p.push(`${q.id}: at most ${max} characters`); break; }
        const clean = scrubFreeText(v, max);
        if (clean !== '') out[q.id] = clean;
        break;
      }
    }
  }
  if (p.length) throw new AppError('BAD_REQUEST', `invalid answers: ${p.join('; ')}`, undefined, { problems: p });
  return out;
}

// ------------------------------------------------------------------------------------------------ player actions (REQ-SURVEY-007..010)

const closed = () => new AppError('SURVEY_CLOSED', 'this survey has ended');
function requireLive(l: LiveSurvey | null, now: number): LiveSurvey {
  if (!l || now < l.startAt) throw new AppError('NOT_FOUND', 'unknown survey');
  if (now >= l.endAt) throw closed();
  return l;
}

/** POST /v1/surveys/:id/shown — counts the show and makes it the current one. */
export function noteSurveyShown(cfg: SurveysConfig, s: PlayerState, live: LiveSurvey | null, placement: SurveyPlacement, now: number, emit?: (e: KpiEvent) => void) {
  if (!cfg.enabled) throw closed();
  const l = requireLive(live, now);
  const st = ensureSurveys(s);
  const id = l.def.id;
  if (st.done[id]) return { surveyId: id, shows: st.shows[id]?.n ?? 0, done: st.done[id]!.outcome };
  const e = (st.shows[id] ??= { n: 0, firstAt: now, lastAt: now });
  e.n += 1; e.lastAt = now;
  st.current = id;
  prune(st);
  emit?.({ name: 'survey_shown', s1: id, s2: placement, count: e.n });
  return { surveyId: id, shows: e.n, done: null };
}

/** POST /v1/surveys/:id/skip — one tap; that survey never comes back. Idempotent. */
export function skipSurvey(s: PlayerState, live: LiveSurvey | null, placement: SurveyPlacement, now: number, emit?: (e: KpiEvent) => void) {
  // a skip of a survey that just ended still ends it for the player (nothing to lose); only an unknown one is refused
  if (!live || now < live.startAt) throw new AppError('NOT_FOUND', 'unknown survey');
  const st = ensureSurveys(s);
  const id = live.def.id;
  const d = st.done[id];
  if (d?.outcome === 'answered') throw new AppError('CONFLICT', 'already answered');
  if (!d) {
    st.done[id] = { at: now, outcome: 'skipped', placement, title: { ...live.def.title } };
    st.lastDoneAt = now;
    if (st.current === id) st.current = null;
    prune(st);
    emit?.({ name: 'survey_skip', s1: id, s2: placement });
  }
  return { surveyId: id, outcome: 'skipped' as const, at: st.done[id]!.at };
}

export interface SurveyAnswerInput { placement: SurveyPlacement; answers: SurveyAnswers; facts: SurveyFacts; analytics: boolean }

/** POST /v1/surveys/:id/answers — once per player (the idempotency key is checked by the transaction). Grants nothing. */
export function answerSurvey(cfg: SurveysConfig, s: PlayerState, live: LiveSurvey | null, i: SurveyAnswerInput, now: number, emit?: (e: KpiEvent) => void) {
  if (!cfg.enabled) throw closed();
  const l = requireLive(live, now);
  if (deletionScheduled(s)) throw new AppError('NOT_ELIGIBLE', 'the account is being closed');
  const st = ensureSurveys(s);
  const id = l.def.id;
  const d = st.done[id];
  if (d?.outcome === 'answered') throw new AppError('CONFLICT', 'already answered');
  if (d?.outcome === 'skipped') throw new AppError('CONFLICT', 'this survey was skipped');
  if (!targets(l.def.targeting, id, s, i.facts, now)) throw new AppError('NOT_ELIGIBLE', 'this survey is for other players');
  const segment = i.analytics ? segmentOf(s, i.facts, now) : null;
  st.done[id] = { at: now, outcome: 'answered', placement: i.placement, title: { ...l.def.title }, answers: JSON.parse(JSON.stringify(i.answers)), rev: l.rev, synced: false, segment };
  st.lastDoneAt = now;
  if (st.current === id) st.current = null;
  prune(st);
  emit?.({ name: 'survey_answer', s1: id, s2: i.placement, count: Object.keys(i.answers).length });
  return { surveyId: id, outcome: 'answered' as const, at: now };
}

/** An answer the OpsDO table has not confirmed yet (re-sent by the Worker, REQ-SURVEY-011). */
export interface PendingSurveyAnswer { surveyId: string; rev: number; at: number; answers: SurveyAnswers; segment: SurveySegment | null }
export function pendingSurveyAnswers(s: PlayerState): PendingSurveyAnswer[] {
  if (deletionScheduled(s)) return [];
  return Object.entries(s.surveys?.done ?? {})
    .filter(([, d]) => d.outcome === 'answered' && d.synced === false)
    .map(([surveyId, d]) => ({ surveyId, rev: d.rev ?? 1, at: d.at, answers: d.answers ?? {}, segment: d.segment ?? null }));
}
export function markSurveySynced(s: PlayerState, surveyIds: string[]) {
  for (const id of surveyIds) { const d = s.surveys?.done[id]; if (d && d.outcome === 'answered') d.synced = true; }
  return { synced: surveyIds.length };
}

/** §51 export rows (REQ-SURVEY-014): the player's own surveys and answers (scrubbed as stored). */
export function surveysExport(s: PlayerState) {
  return Object.entries(s.surveys?.done ?? {}).sort(([, a], [, b]) => a.at - b.at).map(([surveyId, d]) => ({
    surveyId, title: d.title.ja, titleEn: d.title.en, outcome: d.outcome, at: d.at, placement: d.placement, answers: d.answers ? JSON.parse(JSON.stringify(d.answers)) as SurveyAnswers : null,
  }));
}
