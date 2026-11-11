/**
 * チュートリアルのやり直しとヒント集 (replay tutorials & tips library) — REQ-TUT-001..018, contracts/protocol.md §57.
 *
 *  - Short illustrated cards (master/tips.json, replaceable by remote config `tips`) in Japanese and English side by side,
 *    grouped by topic. A card opens with its §4.3 unlock key (onboarding.ts unlocksView — the same answer the home's locks
 *    use); a key the progression does not list is open from the start, like the home.
 *  - Numbers never live in a card: the help center's `{{tokens}}` (help.ts fillTokens / tokenProblems) are filled from data
 *    when the index is read, so the pity count and the rates come from the same computation as the rates screen.
 *  - Tips are short, help is long: a card links to a help article for depth, and the check refuses a card that repeats a
 *    sentence of any help article (no second copy of the same text).
 *  - Replays: the four race lessons (whip / position / stamina / reins) run on the device like practice (the FTUE tutorial
 *    race preset and its TutorialDirector for the whip; the offline practice race for the others) and the feature tours are
 *    pages of cards. Neither reaches the server: a replay never touches onboarding state, never counts as a race and never
 *    grants anything (the first-time rewards — the partner, the welcome 10-pull, beginner missions — stay one-time; tests
 *    prove it). KPI: tutorial_replay / tip_view / tip_context_open are client events (kpi.ts).
 *  - Seen cards are kept on the account (`tips.seen`, bounded by `seenMax`, only ids of open cards) so the "new" badges
 *    agree across devices. Nothing here moves coins or items.
 */
import tipsJson from '../../master/tips.json';
import { AppError } from './errors.js';
import type { Master } from './master.js';
import type { PlayerState } from './player.js';
import { UNLOCK_KEYS, unlocksView, type UnlockKey } from './onboarding.js';
import { digitsProblems, fillTokens, helpOf, pick, tokenProblems, tokensOf, wordingProblems, type Loc, type TokenEnv } from './help.js';
import type { Locale } from '../i18n/locale.js';

// ------------------------------------------------------------------------------------------------ master

export const TIP_TOPIC_IDS = ['race', 'horses', 'scout', 'shop', 'social'] as const;
export type TipTopicId = typeof TIP_TOPIC_IDS[number];
/** The card illustrations Codex draws (docs/handoff-codex-round19-tutorial-replay.md). */
export const TIP_ARTS = ['whip', 'slipstream', 'lanes', 'stamina', 'reins', 'breeding', 'stud', 'training', 'roster', 'scout', 'pity', 'coins', 'branch', 'cups', 'career'] as const;
/** REQ-TUT-008: screens with a "?" button that opens a card. */
export const TIP_CONTEXTS = ['gacha_odds', 'breeding', 'training', 'roster_bulk_retire'] as const;
export type TipContext = typeof TIP_CONTEXTS[number];
/** REQ-TUT-003: the race lessons (each exactly once). */
export const RACE_LESSONS = ['whip', 'position', 'stamina', 'reins'] as const;
export type RaceLesson = typeof RACE_LESSONS[number];
export const TUTORIAL_KINDS = ['race', 'tour'] as const;
/** Topics whose cards may not carry digits outside tokens (prices, rates and counts must be data). */
const STRICT_TOPICS: readonly TipTopicId[] = ['scout', 'shop'];

export interface TipDef { id: string; topic: TipTopicId; unlock: UnlockKey | null; art: string; help?: string; title: Loc; body: Loc }
export interface TutorialDef { id: string; kind: 'race' | 'tour'; lesson?: RaceLesson; unlock: UnlockKey | null; title: Loc; tips: string[] }
export interface TipsConfig { enabled: boolean; titleMaxChars: number; bodyMaxChars: number; seenMax: number; seenPerRequest: number }
export interface TipsMaster { version: number; config: TipsConfig; topics: { id: TipTopicId; title: Loc }[]; tips: TipDef[]; contexts: Record<string, string>; tutorials: TutorialDef[] }

export const BASE_TIPS = tipsJson as unknown as TipsMaster;
export const tipsOf = (m: Pick<Master, 'tips'>): TipsMaster => m.tips ?? BASE_TIPS;

export const TIPS_LIMITS = { titleMaxChars: [8, 40], bodyMaxChars: [40, 240], seenMax: [20, 500], seenPerRequest: [20, 50] } as const; // clients send batches of 20 (ApiClient.TipsSeenMaxPerRequest), so the per-request cap never goes below it
export const TIPS_MAX = 120;
export const TUTORIALS_MAX = 30;
export const TOUR_PAGES_MAX = 6;
/** A help sentence at least this long that a card repeats is duplicate text (REQ-TUT-012). */
const DUP_MIN_CHARS = 12;

// ------------------------------------------------------------------------------------------------ validation

const isLoc = (x: unknown): x is Loc => !!x && typeof x === 'object' && typeof (x as Loc).ja === 'string' && typeof (x as Loc).en === 'string';
const JP_RE = /[぀-ヿ㐀-鿿・]/;
const ID_RE = /^[a-z0-9_]{2,40}$/;
const TOKEN_STRIP = /\{\{[^}]*\}\}/g;

/** Sentences of a text (split at 。！？.!? and line breaks, bullets and spaces trimmed, tokens kept as written). */
function sentences(text: string): string[] {
  return text.split(/[。！？!?\n]|\.(?=\s|$)/).map((x) => x.replace(/^[\s・•]+/, '').trim()).filter((x) => x.length >= DUP_MIN_CHARS);
}

/** REQ-TUT-010..013: everything wrong with a tips master against the resolved master (empty = fine). */
export function tipsProblems(m: Master, t: TipsMaster = tipsOf(m), maxWhips = 6): string[] {
  const out: string[] = [];
  if (!t || typeof t !== 'object') return ['tips must be an object'];
  const c = t.config;
  if (!c || typeof c !== 'object') return ['tips.config is required'];
  if (typeof c.enabled !== 'boolean') out.push('tips.config.enabled must be a boolean');
  for (const k of ['titleMaxChars', 'bodyMaxChars', 'seenMax', 'seenPerRequest'] as const) {
    const [lo, hi] = TIPS_LIMITS[k];
    if (!Number.isInteger(c[k]) || c[k] < lo || c[k] > hi) out.push(`tips.config.${k} must be an integer ${lo}..${hi}`);
  }
  if (!Number.isInteger(t.version) || t.version < 1) out.push('tips.version must be a positive integer');
  // topics: all five, once each
  const topics = Array.isArray(t.topics) ? t.topics : [];
  const topicIds = topics.map((x) => x?.id);
  for (const id of TIP_TOPIC_IDS) if (!topicIds.includes(id)) out.push(`tips.topics: missing ${id}`);
  if (new Set(topicIds).size !== topicIds.length) out.push('tips.topics: duplicate id');
  topics.forEach((x, i) => {
    if (!(TIP_TOPIC_IDS as readonly string[]).includes(x?.id)) out.push(`tips.topics[${i}]: unknown id ${x?.id}`);
    if (!isLoc(x?.title) || !x.title.ja.trim() || !x.title.en.trim()) out.push(`tips.topics[${i}]: title needs ja and en`);
    else {
      if (JP_RE.test(x.title.en)) out.push(`tips.topics[${i}].title.en contains Japanese`);
      out.push(...wordingProblems(`tips.topics.${x.id}.title`, x.title.ja, x.title.en));
    }
  });
  // cards
  const tips = Array.isArray(t.tips) ? t.tips : [];
  if (tips.length === 0) out.push('tips.tips must not be empty');
  if (tips.length > TIPS_MAX) out.push(`tips.tips: at most ${TIPS_MAX}`);
  const help = helpOf(m);
  const helpIds = new Set((help?.articles ?? []).map((a) => a.id));
  const helpSentences = { ja: new Set<string>(), en: new Set<string>() };
  for (const a of help?.articles ?? []) for (const lang of ['ja', 'en'] as const) if (isLoc(a.body)) for (const s of sentences(a.body[lang])) helpSentences[lang].add(s);
  const env: TokenEnv = { m, maxWhips };
  const ids = new Set<string>();
  for (const [i, x] of tips.entries()) {
    const at = `tips.tips[${i}]${x?.id ? ` ${x.id}` : ''}`;
    if (typeof x?.id !== 'string' || !ID_RE.test(x.id)) { out.push(`${at}: bad id`); continue; }
    if (ids.has(x.id)) out.push(`${at}: duplicate id`);
    ids.add(x.id);
    if (!(TIP_TOPIC_IDS as readonly string[]).includes(x.topic)) out.push(`${at}: unknown topic ${x.topic}`);
    if (x.unlock !== null && !(UNLOCK_KEYS as readonly string[]).includes(x.unlock as string)) out.push(`${at}: unknown unlock key ${x.unlock}`);
    if (!(TIP_ARTS as readonly string[]).includes(x.art)) out.push(`${at}: unknown art ${x.art}`);
    if (x.help !== undefined && !helpIds.has(x.help)) out.push(`${at}: help article ${x.help} does not exist`);
    if (!isLoc(x.title) || !isLoc(x.body)) { out.push(`${at}: title and body need ja and en`); continue; }
    for (const lang of ['ja', 'en'] as const) {
      const ti = x.title[lang], b = x.body[lang];
      if (ti.trim().length < 1 || [...ti].length > c.titleMaxChars) out.push(`${at}.title.${lang}: 1..${c.titleMaxChars} characters`);
      if (b.trim().length < 1 || [...b].length > c.bodyMaxChars) out.push(`${at}.body.${lang}: 1..${c.bodyMaxChars} characters (a card is short; depth goes in the help article)`);
      if (/[\u0000-\u001f\u007f]/.test(ti + b)) out.push(`${at}.${lang}: control characters`);
      out.push(...digitsProblems(`${at}.${lang}`, `${ti}\n${b}`, STRICT_TOPICS.includes(x.topic), lang === 'en'));
      out.push(...tokenProblems(env, `${at}.${lang}`, `${ti}\n${b}`));
      for (const s of sentences(b)) if (helpSentences[lang].has(s)) out.push(`${at}.body.${lang}: repeats a help article sentence 「${s}」 (link the article instead)`);
    }
    if (JP_RE.test(x.title.en) || JP_RE.test(x.body.en)) out.push(`${at}.en contains Japanese`);
    if (tokensOf(x.body.ja + x.title.ja).join() !== tokensOf(x.body.en + x.title.en).join()) out.push(`${at}: ja and en carry different tokens`);
    out.push(...wordingProblems(at, `${x.title.ja}\n${x.body.ja}`, `${x.title.en}\n${x.body.en}`));
  }
  // contexts: every "?" screen points at a card
  const ctx = t.contexts && typeof t.contexts === 'object' ? t.contexts : {};
  for (const k of TIP_CONTEXTS) {
    if (!(k in ctx)) out.push(`tips.contexts: missing ${k}`);
    else if (!ids.has(ctx[k]!)) out.push(`tips.contexts.${k}: unknown tip ${ctx[k]}`);
  }
  for (const k of Object.keys(ctx)) if (!(TIP_CONTEXTS as readonly string[]).includes(k)) out.push(`tips.contexts: unknown context ${k}`);
  // replays
  const tuts = Array.isArray(t.tutorials) ? t.tutorials : [];
  if (tuts.length > TUTORIALS_MAX) out.push(`tips.tutorials: at most ${TUTORIALS_MAX}`);
  const tutIds = new Set<string>();
  const lessons: string[] = [];
  for (const [i, x] of tuts.entries()) {
    const at = `tips.tutorials[${i}]${x?.id ? ` ${x.id}` : ''}`;
    if (typeof x?.id !== 'string' || !ID_RE.test(x.id)) { out.push(`${at}: bad id`); continue; }
    if (tutIds.has(x.id) || ids.has(x.id)) out.push(`${at}: duplicate id`);
    tutIds.add(x.id);
    if (!(TUTORIAL_KINDS as readonly string[]).includes(x.kind)) out.push(`${at}: unknown kind ${x.kind}`);
    if (x.kind === 'race') {
      if (!(RACE_LESSONS as readonly string[]).includes(x.lesson as string)) out.push(`${at}: unknown lesson ${x.lesson}`);
      else lessons.push(x.lesson!);
      // the race lessons are the basics: open from the start, like the tutorial race itself
      if (x.unlock !== null) out.push(`${at}: a race lesson is open from the start (unlock null)`);
    } else if (x.lesson !== undefined) out.push(`${at}: only a race lesson has a lesson`);
    if (x.unlock !== null && !(UNLOCK_KEYS as readonly string[]).includes(x.unlock as string)) out.push(`${at}: unknown unlock key ${x.unlock}`);
    if (!isLoc(x.title) || !x.title.ja.trim() || !x.title.en.trim()) out.push(`${at}: title needs ja and en`);
    else {
      for (const lang of ['ja', 'en'] as const) if ([...x.title[lang]].length > c.titleMaxChars) out.push(`${at}.title.${lang}: 1..${c.titleMaxChars} characters`);
      if (JP_RE.test(x.title.en)) out.push(`${at}.title.en contains Japanese`);
      out.push(...wordingProblems(`${at}.title`, x.title.ja, x.title.en));
    }
    const pages = Array.isArray(x.tips) ? x.tips : [];
    if (pages.length < 1 || pages.length > TOUR_PAGES_MAX) out.push(`${at}: 1..${TOUR_PAGES_MAX} cards`);
    if (new Set(pages).size !== pages.length) out.push(`${at}: a card appears twice`);
    for (const p of pages) if (!ids.has(p)) out.push(`${at}: unknown tip ${p}`);
  }
  for (const l of RACE_LESSONS) if (lessons.filter((x) => x === l).length !== 1) out.push(`tips.tutorials: lesson ${l} must appear exactly once`);
  return out;
}

// ------------------------------------------------------------------------------------------------ player state

export interface TipsState { seen: string[] }

function ensureTips(s: PlayerState): TipsState {
  s.tips ??= { seen: [] };
  return s.tips;
}

/** Which unlock keys are open now (a key the progression does not list is open, like the home's tiles). */
function openKeys(m: Master, s: PlayerState, now: number): (k: UnlockKey | null) => boolean {
  const f = new Map(unlocksView(m, s, now).features.map((x) => [x.key, x.unlocked]));
  return (k) => k === null || (f.get(k) ?? true);
}

/** REQ-TUT-005/006: GET /v1/tips — topics, cards (open ones with their text, tokens filled), replays, the "?" contexts. */
export function tipsIndex(m: Master, s: PlayerState, now: number, lang: Locale, maxWhips = 6) {
  const t = tipsOf(m);
  const on = t.config.enabled;
  const open = openKeys(m, s, now);
  const seen = new Set(s.tips?.seen ?? []);
  const env: TokenEnv = { m, maxWhips };
  const help = helpOf(m);
  const tips = on ? t.tips.map((x) => {
    const unlocked = open(x.unlock);
    const art = help.articles.find((a) => a.id === x.help);
    return {
      id: x.id, topic: x.topic, art: x.art, unlock: x.unlock, unlocked, new: unlocked && !seen.has(x.id),
      title: fillTokens(env, pick(x.title, lang)),
      // a closed card shows its title and the key that opens it, never its text
      body: unlocked ? fillTokens(env, pick(x.body, lang)) : null,
      help: art && help.config.enabled ? { articleId: art.id, title: pick(art.title, lang) } : null,
    };
  }) : [];
  return {
    enabled: on, version: t.version, lang,
    newCount: tips.filter((x) => x.new).length,
    topics: on ? t.topics.map((x) => {
      const mine = tips.filter((y) => y.topic === x.id);
      return { id: x.id, title: pick(x.title, lang), count: mine.length, unlocked: mine.filter((y) => y.unlocked).length, newCount: mine.filter((y) => y.new).length };
    }) : [],
    tips,
    tutorials: on ? t.tutorials.map((x) => ({ id: x.id, kind: x.kind, lesson: x.lesson ?? null, unlock: x.unlock, unlocked: open(x.unlock), title: pick(x.title, lang), tips: [...x.tips] })) : [],
    contexts: on ? { ...t.contexts } : {},
  };
}

/** GET /v1/player `tips`: the settings badge (new cards). Zero while the library is off. */
export function tipsBadge(m: Master, s: PlayerState, now: number) {
  const t = tipsOf(m);
  if (!t.config.enabled) return { newCount: 0 };
  const open = openKeys(m, s, now);
  const seen = new Set(s.tips?.seen ?? []);
  return { newCount: t.tips.filter((x) => open(x.unlock) && !seen.has(x.id)).length };
}

/**
 * REQ-TUT-007: POST /v1/tips/seen — marks open cards seen (idempotent; a closed card is skipped, an unknown id is 404 and
 * nothing is marked). The list keeps only ids the master still has, newest last, at most `seenMax`.
 */
export function markTipsSeen(m: Master, s: PlayerState, ids: string[], now: number) {
  const t = tipsOf(m);
  if (!t.config.enabled) throw new AppError('NOT_FOUND', 'tips are not available');
  if (ids.length < 1 || ids.length > t.config.seenPerRequest) throw new AppError('BAD_REQUEST', `1..${t.config.seenPerRequest} ids`);
  const byId = new Map(t.tips.map((x) => [x.id, x]));
  for (const id of ids) if (!byId.has(id)) throw new AppError('NOT_FOUND', `tip ${id}`);
  const open = openKeys(m, s, now);
  const st = ensureTips(s);
  const marked: string[] = [];
  const skipped: string[] = [];
  for (const id of new Set(ids)) {
    if (!open(byId.get(id)!.unlock)) { skipped.push(id); continue; }
    if (!st.seen.includes(id)) { st.seen.push(id); marked.push(id); }
  }
  st.seen = st.seen.filter((id) => byId.has(id)).slice(-t.config.seenMax);
  return { marked, skipped, newCount: tipsBadge(m, s, now).newCount };
}
