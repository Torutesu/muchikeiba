/**
 * 支部の定型チャット（REQ-QCHAT-*、contracts/protocol.md §52）: branch members talk only in fixed phrases (no free text —
 * safety by design, docs/planning/03). A phrase is a JA + EN pair from master data (`master/quick-chat.json`); its slots
 * (`{course}` `{horse}` `{race}` `{time}` `{cup}` `{player}`) take only values the server checked against the poster's
 * own state. The phrase id and the slot values are stored — never a text — and every viewer gets the phrase in their own
 * language. Player-sourced values (horse, cup and display names) are never translated.
 *
 * This module holds the catalog, its validation, the player-side slot checks, the options of the picker and the
 * rendering. The posts live in the §18 team feed (teamFeed.ts, item kind `qchat`): one feed, not a parallel one.
 */
import { AppError } from './errors.js';
import type { Master } from './master.js';
import type { PlayerState } from './player.js';
import { deletionScheduled } from './accountDeletion.js';
import { bettingWordsIn } from './bettingWords.js';
import { rivalTrackName } from './rival.js';
import { formatRaceTime } from './weeklyChallenge.js';
import { notePostedIn } from './teamFeed.js';
import { blockListOf } from './blocks.js';
import { catalogFor, enWordingProblems, ordinal, translateText } from '../i18n/catalog.js';
import type { Locale } from '../i18n/locale.js';
import quickChatJson from '../../master/quick-chat.json';

export const QCHAT_SLOTS = ['course', 'horse', 'race', 'time', 'cup', 'player'] as const;
export type QChatSlotName = typeof QCHAT_SLOTS[number];
export const QCHAT_CATEGORIES = ['greet', 'cheer', 'team', 'race', 'invite'] as const;
export type QChatCategory = typeof QCHAT_CATEGORIES[number];
export const QCHAT_ID_RE = /^[a-z0-9_]{1,32}$/;
/** A slot value as the client sends it (an id: track, horse, race, cup or player id). */
export const QCHAT_REF_RE = /^[A-Za-z0-9_:\-]{1,64}$/;
/** Japanese words a phrase may never contain (有利誤認・偽の急ぎ; betting words come from bettingWords.ts). */
export const QCHAT_BANNED_JA = ['倍', 'お得', '今だけ', '残りわずか', '通常価格'];
/** How an author who left the branch (or a named member who is gone) is shown (REQ-QCHAT-010). */
export const FORMER_MEMBER: Record<Locale, string> = { ja: '元メンバー', en: 'Former member' };
const MAX_SLOTS = 2;
const HORSE_OPTIONS = 20;
const RACE_OPTIONS = 10;

export interface QChatPhrase { id: string; category: QChatCategory; ja: string; en: string }
export interface QChatConfig {
  enabled: boolean;
  /** Minimum time between two posts of one member (ms). */
  postIntervalMs: number;
  /** Posts per member and game day. */
  postsPerDay: number;
  /** The same phrase with the same values may not follow itself within this window (ms; 0 = off). */
  repeatWindowMs: number;
  /** Mention phrases (`{player}`) per member and game day. */
  mentionsPerDay: number;
  /** quick chat items kept per branch (newest). */
  retainMax: number;
  /** Days a quick chat item is kept. */
  retainDays: number;
}
export interface QuickChatMaster { version: number; config: QChatConfig; phrases: QChatPhrase[] }

/**
 * A checked slot value as stored in the feed item. `text` = a snapshot of player-sourced text (horse / cup name; never
 * translated), `trackId` / `place` / `field` / `ms` = what a race or time-attack value shows. A `player` slot stores the
 * member id only (the name is read from the member list; empty after an account deletion → 元メンバー).
 */
export interface QSlot { name: QChatSlotName; ref: string; text?: string; trackId?: string; place?: number; field?: number; ms?: number }

export function quickChatOf(m: Master): QuickChatMaster {
  return (m as Master & { quickChat?: QuickChatMaster }).quickChat ?? (quickChatJson as unknown as QuickChatMaster);
}

/** The slot names of a phrase in the order they appear in the Japanese. */
export function phraseSlots(p: Pick<QChatPhrase, 'ja'>): QChatSlotName[] {
  return [...p.ja.matchAll(/\{(\w+)\}/g)].map((x) => x[1] as QChatSlotName);
}
const slotsOf = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((x) => x[1]!);
export const isMention = (p: Pick<QChatPhrase, 'ja'>) => phraseSlots(p).includes('player');

export function findPhrase(m: Master, id: string): QChatPhrase {
  const p = quickChatOf(m).phrases.find((x) => x.id === id);
  if (!p) throw new AppError('NOT_FOUND', `phrase ${id}`);
  return p;
}

/** REQ-QCHAT-002: the catalog is usable (boot and every remote config version). `feedSize` = §18's ring buffer. */
export function quickChatProblems(m: Master, feedSize = 100): string[] {
  const qc = quickChatOf(m);
  const p: string[] = [];
  if (!qc || typeof qc !== 'object' || !qc.config || !Array.isArray(qc.phrases)) return ['quickChat must have config and phrases'];
  const c = qc.config;
  const intIn = (v: unknown, lo: number, hi: number) => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;
  if (typeof c.enabled !== 'boolean') p.push('quickChat.config.enabled must be a boolean');
  if (!intIn(c.postIntervalMs, 3000, 3_600_000)) p.push('quickChat.config.postIntervalMs must be 3s..1h');
  if (!intIn(c.postsPerDay, 1, 200)) p.push('quickChat.config.postsPerDay must be 1..200');
  if (!intIn(c.repeatWindowMs, 0, 86_400_000)) p.push('quickChat.config.repeatWindowMs must be 0..1 day');
  if (!intIn(c.mentionsPerDay, 0, 100)) p.push('quickChat.config.mentionsPerDay must be 0..100');
  if (!intIn(c.retainMax, 10, feedSize)) p.push(`quickChat.config.retainMax must be 10..${feedSize} (the feed size)`);
  if (!intIn(c.retainDays, 1, 90)) p.push('quickChat.config.retainDays must be 1..90');
  const ids = new Set<string>();
  for (const ph of qc.phrases) {
    const at = `phrase ${ph?.id}`;
    if (!ph || typeof ph.id !== 'string' || !QCHAT_ID_RE.test(ph.id)) { p.push(`${at}: bad id`); continue; }
    if (ids.has(ph.id)) p.push(`${at}: duplicate`);
    ids.add(ph.id);
    if (!(QCHAT_CATEGORIES as readonly string[]).includes(ph.category)) p.push(`${at}: unknown category ${ph.category}`);
    if (typeof ph.ja !== 'string' || typeof ph.en !== 'string') { p.push(`${at}: ja and en are required`); continue; }
    const jl = [...ph.ja].length, el = [...ph.en].length;
    if (jl < 1 || jl > 30) p.push(`${at}: ja must be 1..30 characters`);
    if (el < 1 || el > 60) p.push(`${at}: en must be 1..60 characters`);
    const js = slotsOf(ph.ja), es = slotsOf(ph.en);
    for (const s of js) if (!(QCHAT_SLOTS as readonly string[]).includes(s)) p.push(`${at}: unknown slot {${s}}`);
    if (js.length > MAX_SLOTS) p.push(`${at}: at most ${MAX_SLOTS} slots`);
    if (new Set(js).size !== js.length) p.push(`${at}: a slot may appear once`);
    if ([...js].sort().join(',') !== [...es].sort().join(',')) p.push(`${at}: ja and en must have the same slots`);
    for (const w of bettingWordsIn(ph.ja)) p.push(`${at}: betting word in ja (${w})`);
    for (const w of bettingWordsIn(ph.en)) p.push(`${at}: betting word in en (${w})`);
    for (const w of QCHAT_BANNED_JA) if (ph.ja.includes(w)) p.push(`${at}: 「${w}」 is not allowed`);
    for (const w of enWordingProblems(ph.en)) p.push(`${at}: en ${w}`);
    if (/https?:|www\.|\.(com|net|jp)\b/i.test(ph.ja + ' ' + ph.en)) p.push(`${at}: no URLs`);
    if (/[　-ヿ㐀-䶿一-鿿＀-￯]/.test(ph.en)) p.push(`${at}: en contains Japanese`);
  }
  if (qc.phrases.length === 0) p.push('quickChat: at least one phrase');
  return p;
}

// ------------------------------------------------------------------------------------- rendering

/** A course name in the locale (the master track name; English from the §23 table). */
export function courseLabel(m: Master, trackId: string, locale: Locale): string {
  const ja = rivalTrackName(trackId);
  return locale === 'ja' ? ja : translateText(ja, catalogFor(m)) ?? ja;
}

/** One slot value as a viewer reads it. `names` = the branch's member list (id → current display name). */
export function slotValue(m: Master, s: QSlot, locale: Locale, names: Map<string, string>): string {
  switch (s.name) {
    case 'course': return courseLabel(m, s.ref, locale);
    case 'horse': return s.text ?? '';
    case 'cup': return s.text ?? '';
    case 'race': {
      const c = courseLabel(m, s.trackId ?? '', locale);
      return locale === 'ja' ? `${c}で${s.place ?? 0}着` : `${ordinal(s.place ?? 0)} at ${c}`;
    }
    case 'time': return `${courseLabel(m, s.trackId ?? s.ref, locale)} ${formatRaceTime(s.ms ?? 0)}`;
    case 'player': return (s.ref && names.get(s.ref)) || FORMER_MEMBER[locale];
  }
}

/** The phrase in the locale with its slots filled (a removed phrase shows nothing rather than an id). */
export function renderPhrase(m: Master, phraseId: string, slots: QSlot[], locale: Locale, names: Map<string, string>): string {
  const ph = quickChatOf(m).phrases.find((x) => x.id === phraseId);
  if (!ph) return '';
  const t = locale === 'ja' ? ph.ja : ph.en;
  return t.replace(/\{(\w+)\}/g, (_, k: string) => {
    const s = slots.find((x) => x.name === k);
    return s ? slotValue(m, s, locale, names) : '';
  });
}

// ------------------------------------------------------------------------------------- player side

export type QChatSlotInput = Partial<Record<QChatSlotName, string>>;

/**
 * REQ-QCHAT-003/004: the poster's side of a post — enabled, not deleting, a branch member, a known phrase, exactly its
 * slots, and every value checked against the player's own state. The `player` slot is checked here against the poster's
 * own block list (the branch object checks membership and the other direction). Records the team for the deletion.
 */
export function playerQchatCheck(m: Master, s: PlayerState, phraseId: string, input: QChatSlotInput, now: number) {
  const qc = quickChatOf(m);
  if (!qc.config.enabled) throw new AppError('NOT_FOUND', 'quick chat is not available');
  if (deletionScheduled(s)) throw new AppError('DELETION_PENDING', 'the account is scheduled for deletion');
  const teamId = s.team?.teamId ?? null;
  if (!teamId) throw new AppError('NOT_IN_TEAM');
  const ph = findPhrase(m, phraseId);
  const want = phraseSlots(ph);
  const got = Object.keys(input ?? {});
  if (got.length !== want.length || !want.every((k) => typeof input[k] === 'string')) throw new AppError('BAD_REQUEST', `phrase ${ph.id} takes the slots: ${want.join(', ') || 'none'}`);
  const muted = [...blockListOf(s)]; // the one block list (§47.1)
  const slots: QSlot[] = want.map((name) => {
    const ref = input[name]!;
    if (!QCHAT_REF_RE.test(ref)) throw new AppError('BAD_REQUEST', `bad ${name}`);
    const no = () => new AppError('NOT_ELIGIBLE', `this ${name} cannot be used`);
    switch (name) {
      case 'course':
        if (!m.tracks.some((t) => t.id === ref)) throw new AppError('BAD_REQUEST', 'unknown course');
        return { name, ref };
      case 'horse': {
        const h = s.horses.find((x) => x.id === ref);
        if (!h) throw no();
        return { name, ref, text: h.name };
      }
      case 'race': {
        const r = s.myReplays?.recent.find((x) => x.raceId === ref);
        if (!r || !m.tracks.some((t) => t.id === r.trackId)) throw no();
        return { name, ref, trackId: r.trackId, place: r.place, field: r.fieldSize };
      }
      case 'time': {
        const b = s.timeAttack?.allTimeBest[ref];
        if (!b || !m.tracks.some((t) => t.id === ref)) throw no();
        return { name, ref, trackId: ref, ms: b.timeMs };
      }
      case 'cup': {
        const c = (s.cups?.active ?? []).find((x) => x.cupId === ref && x.noted && x.until > now && !!x.cupName);
        if (!c) throw no();
        return { name, ref, text: c.cupName! };
      }
      case 'player':
        if (ref === s.id) throw new AppError('BAD_REQUEST', 'cannot name yourself');
        if (muted.includes(ref)) throw new AppError('NOT_ELIGIBLE', 'this member cannot be named');
        return { name, ref };
    }
  });
  notePostedIn(s, teamId);
  return { teamId, displayName: s.profile.displayName, muted, slots, mention: isMention(ph) };
}

export interface QChatOption { ref: string; qchatValue: string }

/** REQ-QCHAT-008: the poster's side of the picker — phrases in the locale and the values a post would accept. */
export function playerQchatOptions(m: Master, s: PlayerState, locale: Locale, now: number) {
  const qc = quickChatOf(m);
  const teamId = s.team?.teamId ?? null;
  const phrases = qc.phrases.map((p) => ({ id: p.id, category: p.category, slots: phraseSlots(p), mention: isMention(p), qchatTemplate: locale === 'ja' ? p.ja : p.en }));
  const empty = { course: [], horse: [], race: [], time: [], cup: [], player: [] } as Record<QChatSlotName, QChatOption[]>;
  const limits = { postIntervalMs: qc.config.postIntervalMs, postsPerDay: qc.config.postsPerDay, mentionsPerDay: qc.config.mentionsPerDay, repeatWindowMs: qc.config.repeatWindowMs };
  if (!qc.config.enabled || !teamId) return { enabled: qc.config.enabled, teamId, deleting: deletionScheduled(s), limits, phrases, options: empty, muted: [...blockListOf(s)] };
  const none = new Map<string, string>();
  const val = (x: QSlot) => slotValue(m, x, locale, none);
  const course = m.tracks.map((t) => ({ ref: t.id, qchatValue: courseLabel(m, t.id, locale) }));
  const horse = s.horses.filter((h) => h.status === 'active').sort((a, b) => b.bornAt - a.bornAt).slice(0, HORSE_OPTIONS).map((h) => ({ ref: h.id, qchatValue: h.name }));
  const race = [...(s.myReplays?.recent ?? [])].filter((r) => m.tracks.some((t) => t.id === r.trackId)).sort((a, b) => b.at - a.at).slice(0, RACE_OPTIONS)
    .map((r) => ({ ref: r.raceId, qchatValue: val({ name: 'race', ref: r.raceId, trackId: r.trackId, place: r.place, field: r.fieldSize }) }));
  const time = Object.entries(s.timeAttack?.allTimeBest ?? {}).filter(([id]) => m.tracks.some((t) => t.id === id))
    .map(([id, b]) => ({ ref: id, qchatValue: val({ name: 'time', ref: id, trackId: id, ms: b.timeMs }) }));
  const cup = (s.cups?.active ?? []).filter((x) => x.noted && x.until > now && !!x.cupName).map((x) => ({ ref: x.cupId, qchatValue: x.cupName! }));
  return { enabled: true, teamId, deleting: deletionScheduled(s), limits, phrases, options: { course, horse, race, time, cup, player: [] as QChatOption[] }, muted: [...blockListOf(s)] };
}
