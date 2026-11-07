/**
 * かんたん操作 (easy controls, REQ-ASSIST-001..012, contracts/protocol.md §27).
 *
 * The assist itself runs on the client (C# `Muchi.Client.InputAssistant`): it only produces the normal input bytes a
 * player would send, so nothing here touches a race result. The server keeps the player's setting (default off), the
 * one-time suggestion after three last-place finishes in a row, and the KPI marks. The level a race was ridden with
 * comes from the rider's own `res.assist` (race room) and is used for KPI only — never shown to opponents.
 */
import type { PlayerState } from './player.js';
import type { RaceResultForPlayer } from './rewards.js';
import type { Emit } from './service.js';

export const ASSIST_LEVELS = ['off', 'whip', 'full'] as const;
export type AssistLevel = typeof ASSIST_LEVELS[number];
/** Where the player turned it on: the Settings row, or the one-time suggestion sheet. */
export const ASSIST_SOURCES = ['settings', 'prompt'] as const;
export type AssistSource = typeof ASSIST_SOURCES[number];

/** REQ-ASSIST-010: the suggestion shows after this many last-place finishes in a row. */
export const ASSIST_PROMPT_STREAK = 3;
/** Race modes whose results count for the streak (human races settled by a room; never the tutorial or time attack). */
const STREAK_MODES = new Set(['ranked', 'friend', 'event', 'tournament']);

export interface AssistState {
  level: AssistLevel;
  /** Consecutive last-place finishes (reset by any other place). Stops counting once the suggestion was shown. */
  lastPlaceStreak: number;
  /** When the streak reached ASSIST_PROMPT_STREAK (the suggestion is due from then on until it is shown). */
  promptDueAt: number | null;
  /** When the client showed the suggestion (it never shows again). */
  promptShownAt: number | null;
  updatedAt: number | null;
  /** It was ever on (assist_enable isFirst). */
  everEnabled?: boolean;
}

export function ensureAssist(s: PlayerState): AssistState {
  s.assist ??= { level: 'off', lastPlaceStreak: 0, promptDueAt: null, promptShownAt: null, updatedAt: null };
  return s.assist;
}

/** GET /v1/player/assist (and `assist` in GET /v1/player). Read-only: never creates the state. */
export function assistView(s: PlayerState) {
  const a = s.assist;
  const level = a?.level ?? 'off';
  return {
    level,
    // REQ-ASSIST-010: one time only, never while it is already on, never during an account deletion
    promptDue: !!a && a.promptDueAt !== null && a.promptShownAt === null && level === 'off' && !s.deletion,
    lastPlaceStreak: a?.lastPlaceStreak ?? 0,
    promptShown: a?.promptShownAt != null,
    levels: [...ASSIST_LEVELS],
    // REQ-ASSIST-005/006: what the Settings row and the sheet say (fixed: the policy is in the spec, not remote config)
    rules: { ranked: 'allowed', cappedBelowSkilled: true, shownToOpponents: false, tutorial: 'off' },
  };
}

/** PUT /v1/player/assist. Idempotent: setting the current level again changes nothing and emits nothing. */
export function setAssist(s: PlayerState, level: AssistLevel, source: AssistSource, now: number, emit: Emit) {
  const a = ensureAssist(s);
  const before = a.level;
  if (before !== level) {
    a.level = level;
    a.updatedAt = now;
    // REQ-ASSIST-011: assist_enable when it goes from off to on (or changes level while on), assist_disable when off
    if (level === 'off') emit({ name: 'assist_disable', s1: before, s2: source });
    else emit({ name: 'assist_enable', s1: level, s2: source, s3: before, isFirst: !a.everEnabled, value: a.lastPlaceStreak });
    if (level !== 'off') a.everEnabled = true;
  }
  // a choice made from the sheet also counts as the sheet having been shown (an app that skipped prompt-seen)
  if (source === 'prompt' && a.promptShownAt === null) a.promptShownAt = now;
  return assistView(s);
}

/** POST /v1/player/assist/prompt-seen: the suggestion sheet was shown. Once only; later calls change nothing. */
export function markAssistPromptSeen(s: PlayerState, now: number, emit: Emit) {
  const a = ensureAssist(s);
  if (a.promptShownAt === null && a.promptDueAt !== null) {
    a.promptShownAt = now;
    emit({ name: 'assist_prompt_view', value: a.lastPlaceStreak });
  }
  return assistView(s);
}

/**
 * REQ-ASSIST-010: called once per applied race (applyRace's per-race guard). Last place = place === fieldSize in a
 * field of at least two. Void races, the tutorial and time attack do not count.
 */
export function noteRaceForAssist(s: PlayerState, r: RaceResultForPlayer, now: number, emit: Emit) {
  // REQ-ASSIST-011: which level rode (the rider's own report), KPI only
  if (!r.void && r.details?.assist) emit({ name: 'race_assisted', s1: r.details.assist, s2: r.mode, place: r.place, count: r.fieldSize });
  if (r.void || !STREAK_MODES.has(r.mode) || r.fieldSize < 2 || r.place < 1) return;
  const last = r.place >= r.fieldSize;
  const a = s.assist;
  if (!last) { if (a && a.lastPlaceStreak !== 0) a.lastPlaceStreak = 0; return; }
  const st = ensureAssist(s);
  if (st.promptShownAt !== null) return; // shown once: nothing more to count for
  st.lastPlaceStreak += 1;
  if (st.lastPlaceStreak >= ASSIST_PROMPT_STREAK && st.promptDueAt === null && st.level === 'off') st.promptDueAt = now;
}
