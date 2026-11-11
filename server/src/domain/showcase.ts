/**
 * プロフィールのショーケース（トレーナーカード） — REQ-SHOW-*, contracts/protocol.md §62.
 *
 * Each player's public profile (REQ-SOCIAL-004) gets a card: a favourite horse (silks §35 + appearance), up to `pinsMax`
 * pinned things the player actually earned (titles / achievements §24, cup trophies §42, Hall of Fame inductees §34,
 * horse goal ribbons §53, tournament podiums), best records (time-attack bests on chosen courses, this season's ranked
 * class), one fixed JA+EN phrase (no free text, like §52 quick chat) and a background unlocked by achievement tiers.
 * It grants nothing and sells nothing (no E number).
 *
 * - The selection lives in the owner's state (`showcase`) and is validated strictly on save (PUT /v1/showcase).
 * - What others see is a language-neutral copy derived from the owner's state and published inside the public profile
 *   (PublicProfile.showcase → DirectoryDO, the REQ-SOCIAL-004 push). The copy is re-derived on every transaction of the
 *   owner (PlayerService.tx compares it), and every item is re-checked while deriving: a retired horse, a horse that left
 *   the roster, a revoked title, a pruned cup result… quietly drops off. A banned account or a running deletion has no copy.
 * - Reading another player's card (GET /v1/showcase/:playerId) re-checks again against the current master (an item or
 *   course ops removed drops off, an unknown background falls back to the default) and renders the text in the VIEWER's
 *   language. A block either way, a deleted account (no profile) or a banned one gives a neutral card (§47, REQ-ACT-012).
 * - Under-13 owners (registered age < `minAgeFreeText`): no player-typed text other than the display name is published
 *   (horse names, cup names) — the card then shows neutral labels; the phrase is fixed text anyway.
 */
import { AppError } from './errors.js';
import type { Master } from './master.js';
import { moderationOf, type HorseInstance, type PlayerState } from './player.js';
import type { PublicProfile } from './stats.js';
import { deletionScheduled } from './accountDeletion.js';
import { appearanceOf, assetKeys, type Appearance } from './visuals.js';
import { collectionOf, tierReached, achievementBadges } from './collection.js';
import { chainCompleteOf } from './horseGoals.js';
import { rivalTrackName } from './rival.js';
import { formatRaceTime } from './weeklyChallenge.js';
import { bettingWordsIn } from './bettingWords.js';
import { enWordingProblems } from '../i18n/catalog.js';
import { ageAt } from './time.js';
import { seasonIdFor } from './season.js';
import type { KpiEvent } from './kpi.js';
import type { Locale } from '../i18n/locale.js';
import showcaseJson from '../../master/showcase.json';

// ------------------------------------------------------------------------------------------------ master

export const SHOWCASE_PIN_KINDS = ['title', 'achievement', 'cup_trophy', 'hall', 'goal_ribbon', 'tournament'] as const;
export type ShowcasePinKind = typeof SHOWCASE_PIN_KINDS[number];
export const SHOWCASE_ID_RE = /^[a-z0-9_]{1,32}$/;
/** A pin's id as the client sends it (title / achievement / cup / horse / tournament id). */
export const SHOWCASE_REF_RE = /^[A-Za-z0-9_:\-]{1,64}$/;
/** Japanese words a phrase / background name may never contain (有利誤認・偽の急ぎ; betting words from bettingWords.ts). */
export const SHOWCASE_BANNED_JA = ['倍', 'お得', '今だけ', '残りわずか', '通常価格'];
/** Legal / layout guard: a remote config can never raise these (the card has room for 3 pins, protocol §62.1). */
export const SHOWCASE_HARD_LIMITS = { pinsMax: 3, taMax: 3, phrases: 60, backgrounds: 40 };
/** The name a neutral card shows (blocked, deleted, banned — REQ-ACT-012's neutral name, in the viewer's language). */
export const SHOWCASE_NEUTRAL_NAME: Record<Locale, string> = { ja: 'プレイヤー', en: 'Player' };

export type ShowcaseUnlock = { kind: 'default' } | { kind: 'achievement'; achievementId: string; tier: number };
export interface ShowcasePhrase { id: string; ja: string; en: string }
export interface ShowcaseBackground { id: string; ja: string; en: string; unlock: ShowcaseUnlock }
export interface ShowcaseConfig {
  enabled: boolean;
  pinsMax: number;
  taMax: number;
  /** Owners registered younger than this publish no player-typed text but their display name. */
  minAgeFreeText: number;
}
export interface ShowcaseMaster { version: number; config: ShowcaseConfig; phrases: ShowcasePhrase[]; backgrounds: ShowcaseBackground[] }

export function showcaseOf(m: Master): ShowcaseMaster {
  return (m as Master & { showcase?: ShowcaseMaster }).showcase ?? (showcaseJson as unknown as ShowcaseMaster);
}
/** null = the feature is off (GET/PUT answer 404 NOT_FOUND, profiles carry no card). */
export const showcaseConfig = (m: Master): ShowcaseConfig | null => {
  const c = showcaseOf(m).config;
  return c?.enabled ? c : null;
};
export const showcaseBgKey = (id: string) => assetKeys.showcaseBg(id);
const defaultBackground = (sm: ShowcaseMaster) => sm.backgrounds.find((b) => b.unlock.kind === 'default') ?? sm.backgrounds[0]!;

const wordProblems = (at: string, ja: string, en: string): string[] => {
  const p: string[] = [];
  for (const w of bettingWordsIn(ja)) p.push(`${at}: betting word in ja (${w})`);
  for (const w of bettingWordsIn(en)) p.push(`${at}: betting word in en (${w})`);
  for (const w of SHOWCASE_BANNED_JA) if (ja.includes(w)) p.push(`${at}: 「${w}」 is not allowed`);
  for (const w of enWordingProblems(en)) p.push(`${at}: en ${w}`);
  if (/https?:|www\.|\.(com|net|jp)\b/i.test(`${ja} ${en}`)) p.push(`${at}: no URLs`);
  if (/[{}]/.test(ja + en)) p.push(`${at}: no slots (the phrase is fixed text)`);
  if (/[　-ヿ㐀-䶿一-鿿＀-￯]/.test(en)) p.push(`${at}: en contains Japanese`);
  return p;
};

/** REQ-SHOW-002: the catalog is usable (boot and every remote config version). */
export function showcaseProblems(m: Master): string[] {
  const sm = showcaseOf(m);
  const p: string[] = [];
  if (!sm || typeof sm !== 'object' || !sm.config || !Array.isArray(sm.phrases) || !Array.isArray(sm.backgrounds)) return ['showcase must have config, phrases and backgrounds'];
  const c = sm.config;
  const H = SHOWCASE_HARD_LIMITS;
  const intIn = (v: unknown, lo: number, hi: number) => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;
  if (typeof c.enabled !== 'boolean') p.push('showcase.config.enabled must be a boolean');
  if (!intIn(c.pinsMax, 0, H.pinsMax)) p.push(`showcase.config.pinsMax must be 0..${H.pinsMax}`);
  if (!intIn(c.taMax, 0, H.taMax)) p.push(`showcase.config.taMax must be 0..${H.taMax}`);
  if (!intIn(c.minAgeFreeText, 13, 18)) p.push('showcase.config.minAgeFreeText must be 13..18');
  if (sm.phrases.length < 1 || sm.phrases.length > H.phrases) p.push(`showcase.phrases must have 1..${H.phrases} entries`);
  if (sm.backgrounds.length < 1 || sm.backgrounds.length > H.backgrounds) p.push(`showcase.backgrounds must have 1..${H.backgrounds} entries`);
  const ids = new Set<string>();
  for (const ph of sm.phrases) {
    const at = `showcase phrase ${ph?.id}`;
    if (!ph || typeof ph.id !== 'string' || !SHOWCASE_ID_RE.test(ph.id)) { p.push(`${at}: bad id`); continue; }
    if (ids.has(ph.id)) p.push(`${at}: duplicate`);
    ids.add(ph.id);
    if (typeof ph.ja !== 'string' || typeof ph.en !== 'string') { p.push(`${at}: ja and en are required`); continue; }
    if ([...ph.ja].length < 1 || [...ph.ja].length > 20) p.push(`${at}: ja must be 1..20 characters`);
    if ([...ph.en].length < 1 || [...ph.en].length > 40) p.push(`${at}: en must be 1..40 characters`);
    p.push(...wordProblems(at, ph.ja, ph.en));
  }
  const bids = new Set<string>();
  const achievements = new Map(collectionOf(m).achievements.map((a) => [a.id, a]));
  for (const b of sm.backgrounds) {
    const at = `showcase background ${b?.id}`;
    if (!b || typeof b.id !== 'string' || !SHOWCASE_ID_RE.test(b.id) || b.id === 'default') { p.push(`${at}: bad id`); continue; }
    if (bids.has(b.id)) p.push(`${at}: duplicate`);
    bids.add(b.id);
    if (typeof b.ja !== 'string' || typeof b.en !== 'string' || [...b.ja].length < 1 || [...b.ja].length > 12 || [...b.en].length < 1 || [...b.en].length > 24) p.push(`${at}: ja 1..12 and en 1..24 characters`);
    else p.push(...wordProblems(at, b.ja, b.en));
    const u = b.unlock;
    if (u?.kind === 'achievement') {
      const a = achievements.get(u.achievementId);
      if (!a) p.push(`${at}: unknown achievement ${u.achievementId}`);
      else if (!a.tiers.some((t) => t.tier === u.tier)) p.push(`${at}: achievement ${u.achievementId} has no tier ${u.tier}`);
    } else if (u?.kind !== 'default') p.push(`${at}: unlock must be default or achievement (backgrounds are never sold)`);
  }
  if (sm.backgrounds.filter((b) => b?.unlock?.kind === 'default').length !== 1) p.push('showcase.backgrounds: exactly one default background');
  return p;
}

// ------------------------------------------------------------------------------------------------ state

export interface ShowcasePinRef { kind: ShowcasePinKind; id: string }
/** The owner's selection (PlayerState.showcase). Validated on save, re-checked whenever the card is derived. */
export interface ShowcaseState {
  horseId: string | null;
  pins: ShowcasePinRef[];
  taTrackIds: string[];
  phraseId: string | null;
  backgroundId: string;
  updatedAt: number;
}
const peek = (s: PlayerState): ShowcaseState | undefined => s.showcase;

/** REQ-SHOW-018: account deletion — the selection goes with the state wipe; this is the explicit step (idempotent). */
export function forgetShowcase(s: PlayerState) {
  const had = !!s.showcase;
  delete s.showcase;
  return { removed: had };
}

function ageOf(s: PlayerState, now: number): number | null {
  return s.age ? ageAt(s.age.birthYear, s.age.birthMonth, now) : null;
}
/** REQ-SHOW-012: a registered under-`minAgeFreeText` owner publishes no player-typed text but the display name. */
export function showcaseYoung(m: Master, s: PlayerState, now: number): boolean {
  const a = ageOf(s, now);
  return a !== null && a < (showcaseOf(m).config.minAgeFreeText ?? 13);
}

// ------------------------------------------------------------------------------------------------ eligibility

export function backgroundUnlocked(s: PlayerState, b: ShowcaseBackground): boolean {
  return b.unlock.kind === 'default' || tierReached(s, b.unlock.achievementId, b.unlock.tier);
}

/** 貸し出し中 (the roster's on_loan, REQ-ORG-009): listed as a stud or held by a stud reservation. */
export function horseOnLoan(s: PlayerState, horseId: string): boolean {
  const st = s.stud;
  return !!st && (st.listings.some((l) => l.horseId === horseId) || Object.values(st.reservations).some((r) => r.horseId === horseId));
}
/** A horse that may be featured: owned, active and not on loan (retired / gone / lent → not). */
export function favouriteEligible(s: PlayerState, horseId: string): HorseInstance | null {
  const h = s.horses.find((x) => x.id === horseId);
  return h && h.status === 'active' && !horseOnLoan(s, horseId) ? h : null;
}

/** Highest reached tier of an achievement (0 = none). */
function topTier(m: Master, s: PlayerState, achievementId: string): number {
  const a = collectionOf(m).achievements.find((x) => x.id === achievementId);
  if (!a) return 0;
  return [...a.tiers].reverse().find((t) => tierReached(s, achievementId, t.tier))?.tier ?? 0;
}

/**
 * What the copy stores per pin (language-neutral). `name` = player- or ops-typed text (cup / horse / tournament name;
 * null for an under-13 owner's player-typed names). `tier` (achievement), `trophy` (cup), `rank` (tournament).
 */
export interface ShowcasePinCopy { kind: ShowcasePinKind; id: string; name?: string | null; tier?: number; trophy?: 'gold' | 'silver' | 'bronze'; rank?: number; at?: number }

/** REQ-SHOW-004: the pin as the owner earned it right now, or null when it is not (any more) earned. */
export function resolvePin(m: Master, s: PlayerState, ref: ShowcasePinRef, young: boolean): ShowcasePinCopy | null {
  switch (ref.kind) {
    case 'title':
      return s.titles.includes(ref.id) && m.titles.some((t) => t.id === ref.id) ? { kind: 'title', id: ref.id } : null;
    case 'achievement': {
      const tier = topTier(m, s, ref.id);
      return tier > 0 ? { kind: 'achievement', id: ref.id, tier } : null;
    }
    case 'cup_trophy': {
      const r = (s.cups?.history ?? []).find((x) => x.cupId === ref.id && x.status === 'finished' && x.trophy);
      return r ? { kind: 'cup_trophy', id: ref.id, name: young ? null : r.cupName, trophy: r.trophy!, at: r.at } : null;
    }
    case 'hall': {
      const e = (s.hall?.entries ?? []).find((x) => x.horseId === ref.id);
      return e ? { kind: 'hall', id: ref.id, name: young ? null : e.horseName, at: e.inductedAt } : null;
    }
    case 'goal_ribbon': {
      const h = s.horses.find((x) => x.id === ref.id);
      return h && chainCompleteOf(m, s, ref.id) ? { kind: 'goal_ribbon', id: ref.id, name: young ? null : h.name } : null;
    }
    case 'tournament': {
      const t = s.tournaments?.[ref.id];
      return t && t.rank >= 1 && t.rank <= 3 ? { kind: 'tournament', id: ref.id, name: t.name, rank: t.rank, at: t.at } : null;
    }
  }
}

/** Every pin the owner may choose now (the editor's list; best first within each kind). */
export function pinnableRefs(m: Master, s: PlayerState): ShowcasePinRef[] {
  const out: ShowcasePinRef[] = [];
  for (const t of m.titles) if (s.titles.includes(t.id)) out.push({ kind: 'title', id: t.id });
  for (const b of achievementBadges(m, s, 50)) out.push({ kind: 'achievement', id: b.achievementId });
  const trophyRank = { gold: 0, silver: 1, bronze: 2 } as const;
  for (const r of [...(s.cups?.history ?? [])].filter((x) => x.status === 'finished' && x.trophy).sort((a, b) => trophyRank[a.trophy!] - trophyRank[b.trophy!] || b.at - a.at)) out.push({ kind: 'cup_trophy', id: r.cupId });
  for (const e of [...(s.hall?.entries ?? [])].sort((a, b) => b.inductedAt - a.inductedAt)) out.push({ kind: 'hall', id: e.horseId });
  for (const h of s.horses) if (chainCompleteOf(m, s, h.id)) out.push({ kind: 'goal_ribbon', id: h.id });
  for (const [id, t] of Object.entries(s.tournaments ?? {}).filter(([, t]) => t.rank >= 1 && t.rank <= 3).sort(([, a], [, b]) => a.rank - b.rank || b.at - a.at)) { void t; out.push({ kind: 'tournament', id }); }
  return out;
}

const trackExists = (m: Master, id: string) => m.tracks.some((t) => t.id === id);

// ------------------------------------------------------------------------------------------------ save

export interface ShowcaseInput { horseId: string | null; pins: ShowcasePinRef[]; taTrackIds: string[]; phraseId: string | null; backgroundId: string }

const requireConfig = (m: Master) => {
  const c = showcaseConfig(m);
  if (!c) throw new AppError('NOT_FOUND', 'the showcase is not available');
  return c;
};

/** REQ-SHOW-003: validate and store the selection. Everything must be owned / earned now; a replace, so idempotent. */
export function setShowcase(m: Master, s: PlayerState, input: ShowcaseInput, now: number, emit?: (e: KpiEvent) => void): ShowcaseState {
  const c = requireConfig(m);
  if (moderationOf(s, now) === 'banned') throw new AppError('BANNED', 'this account cannot edit its showcase');
  if (deletionScheduled(s)) throw new AppError('DELETION_PENDING', 'the account is scheduled for deletion');
  const sm = showcaseOf(m);
  if (input.horseId !== null) {
    const h = s.horses.find((x) => x.id === input.horseId);
    if (!h) throw new AppError('HORSE_NOT_FOUND', input.horseId);
    if (h.status !== 'active') throw new AppError('HORSE_NOT_ACTIVE', `${input.horseId} is retired`);
    if (horseOnLoan(s, h.id)) throw new AppError('NOT_ELIGIBLE', `${input.horseId} is on loan as a stud`);
  }
  if (input.pins.length > c.pinsMax) throw new AppError('BAD_REQUEST', `at most ${c.pinsMax} pins`);
  const seen = new Set<string>();
  const young = showcaseYoung(m, s, now);
  for (const p of input.pins) {
    const k = `${p.kind}:${p.id}`;
    if (seen.has(k)) throw new AppError('BAD_REQUEST', `${k} is pinned twice`);
    seen.add(k);
    if (!resolvePin(m, s, p, young)) throw new AppError('NOT_ELIGIBLE', `${k} is not earned`);
  }
  if (input.taTrackIds.length > c.taMax) throw new AppError('BAD_REQUEST', `at most ${c.taMax} courses`);
  if (new Set(input.taTrackIds).size !== input.taTrackIds.length) throw new AppError('BAD_REQUEST', 'a course is chosen twice');
  for (const t of input.taTrackIds) {
    if (!trackExists(m, t)) throw new AppError('NOT_FOUND', `course ${t}`);
    if (!s.timeAttack?.allTimeBest[t]) throw new AppError('NOT_ELIGIBLE', `no time-attack record at ${t}`);
  }
  if (input.phraseId !== null && !sm.phrases.some((x) => x.id === input.phraseId)) throw new AppError('NOT_FOUND', `phrase ${input.phraseId}`);
  const bg = sm.backgrounds.find((x) => x.id === input.backgroundId);
  if (!bg) throw new AppError('NOT_FOUND', `background ${input.backgroundId}`);
  if (!backgroundUnlocked(s, bg)) throw new AppError('NOT_ELIGIBLE', `background ${bg.id} is locked`);
  const before = s.showcase ? JSON.stringify({ ...s.showcase, updatedAt: 0 }) : '';
  const next: ShowcaseState = { horseId: input.horseId, pins: input.pins.map((p) => ({ kind: p.kind, id: p.id })), taTrackIds: [...input.taTrackIds], phraseId: input.phraseId, backgroundId: bg.id, updatedAt: now };
  // the same selection again changes nothing (no KPI, no new updatedAt: the public copy stays the same)
  if (before === JSON.stringify({ ...next, updatedAt: 0 })) return s.showcase!;
  s.showcase = next;
  emit?.({ name: 'showcase_save', s1: bg.id, s2: input.horseId ? 'horse' : 'none', s3: input.phraseId ? 'phrase' : 'none', count: input.pins.length, value: input.taTrackIds.length });
  return next;
}

// ------------------------------------------------------------------------------------------------ the public copy

export interface ShowcaseHorseCopy { horseId: string; name: string | null; rarity: HorseInstance['rarity']; sex: HorseInstance['sex']; appearance: Appearance }
/** What PublicProfile.showcase carries (language-neutral; rendered in the viewer's language on read). Never ids of other players. */
export interface ShowcaseCopy {
  v: 1;
  backgroundId: string;
  phraseId: string | null;
  horse: ShowcaseHorseCopy | null;
  pins: ShowcasePinCopy[];
  ta: { trackId: string; timeMs: number; horseName: string | null }[];
  /** This season's ranked class (only after a ranked race this season). */
  season: { seasonId: string; classId: string } | null;
  /** The owner is under minAgeFreeText: player-typed names were left out. */
  young?: true;
  updatedAt: number;
}

/**
 * REQ-SHOW-005: the copy others see, re-checking every item against the owner's state now; null = nothing to publish
 * (feature off, never saved, banned, deletion scheduled or running).
 */
export function showcaseCopy(m: Master, s: PlayerState, now: number): ShowcaseCopy | null {
  const c = showcaseConfig(m);
  const sel = peek(s);
  if (!c || !sel) return null;
  if (moderationOf(s, now) === 'banned' || deletionScheduled(s)) return null;
  const sm = showcaseOf(m);
  const young = showcaseYoung(m, s, now);
  const bg = sm.backgrounds.find((b) => b.id === sel.backgroundId);
  const h = sel.horseId ? favouriteEligible(s, sel.horseId) : null;
  const pins = sel.pins.slice(0, c.pinsMax).map((p) => resolvePin(m, s, p, young)).filter((x): x is ShowcasePinCopy => !!x);
  const ta = sel.taTrackIds.slice(0, c.taMax).flatMap((t) => {
    const b = trackExists(m, t) ? s.timeAttack?.allTimeBest[t] : undefined;
    return b ? [{ trackId: t, timeMs: b.timeMs, horseName: young ? null : b.horseName }] : [];
  });
  return {
    v: 1,
    backgroundId: bg && backgroundUnlocked(s, bg) ? bg.id : defaultBackground(sm).id,
    phraseId: sel.phraseId && sm.phrases.some((x) => x.id === sel.phraseId) ? sel.phraseId : null,
    horse: h ? { horseId: h.id, name: young ? null : h.name, rarity: h.rarity, sex: h.sex, appearance: appearanceOf(h, s.id) } : null,
    pins, ta,
    // only the current season (a state not rolled over yet must not show last month's class)
    season: s.season.races > 0 && s.season.id === seasonIdFor(now) ? { seasonId: s.season.id, classId: s.season.classId } : null,
    ...(young ? { young: true as const } : {}),
    updatedAt: sel.updatedAt,
  };
}
/** Change detector part of PlayerService's profile key ('' = no copy). */
export const showcaseCopyKey = (m: Master, s: PlayerState, now: number) => {
  const x = showcaseCopy(m, s, now);
  return x ? JSON.stringify(x) : '';
};

// ------------------------------------------------------------------------------------------------ rendering

const TROPHY_TEXT = { gold: '金トロフィー', silver: '銀トロフィー', bronze: '銅トロフィー' } as const;

export interface ShowcasePinView { kind: ShowcasePinKind; id: string; label: string; sub: string; icon: string | null; horseName?: string; cupName?: string }
export interface ShowcaseTaView { trackId: string; course: string; time: string; timeMs: number; horseName: string | null }
export type ShowcaseRelation = 'self' | 'friend' | 'other';

/** `icon`: an asset key for titles (`title/<id>`) and achievements (`badge/<id>_<tier>`); null = the client draws the kind's own mark. */
/** GET /v1/showcase/:playerId (and the editor's preview). Texts are Japanese except the pre-localized ones; the boundary translates. */
export interface ShowcaseCardView {
  playerId: string;
  /** `neutral`: blocked either way, deleted or banned — only the neutral name (no other content, nothing to open or report). */
  state: 'ok' | 'neutral';
  displayName: string;
  titleId: string | null; titleName: string | null; classId: string | null; rating: number | null;
  stats: { races: number; wins: number; top3: number } | null; lastSeenAt: number | null;
  silks: PublicProfile['silks'] | null;
  background: { id: string; key: string; backgroundName: string };
  phrase: { id: string; phraseText: string } | null;
  horse: (Omit<ShowcaseHorseCopy, 'name'> & { horseName: string | null }) | null;
  pins: ShowcasePinView[];
  timeAttack: ShowcaseTaView[];
  seasonClass: { seasonId: string; classId: string; label: string } | null;
  cupTrophies: { gold: number; silver: number; bronze: number } | null;
  relation: ShowcaseRelation;
  /** The §47 report entry from the card (source `profile`): another player's card that is not neutral. */
  reportable: boolean;
  /** The favourite horse's name can be reported (content `horse_name`) — only when a name is shown. */
  reportableHorseId: string | null;
  young: boolean;
}

function pinView(m: Master, p: ShowcasePinCopy): ShowcasePinView | null {
  switch (p.kind) {
    case 'title': {
      const t = m.titles.find((x) => x.id === p.id);
      return t ? { kind: p.kind, id: p.id, label: t.name, sub: '称号', icon: assetKeys.title(t.id) } : null;
    }
    case 'achievement': {
      const a = collectionOf(m).achievements.find((x) => x.id === p.id);
      return a && p.tier ? { kind: p.kind, id: p.id, label: a.name, sub: `実績 {tier}段目`.replace('{tier}', String(p.tier)), icon: assetKeys.badge(a.id, p.tier) } : null;
    }
    case 'cup_trophy':
      return p.trophy ? { kind: p.kind, id: p.id, label: 'プレイヤー主催カップ', sub: TROPHY_TEXT[p.trophy], icon: null, ...(p.name ? { cupName: p.name } : {}) } : null;
    case 'hall':
      return { kind: p.kind, id: p.id, label: '殿堂入りの馬', sub: '殿堂入りの銘板', icon: null, ...(p.name ? { horseName: p.name } : {}) };
    case 'goal_ribbon':
      return { kind: p.kind, id: p.id, label: '目標を達成した馬', sub: '目標達成のリボン', icon: null, ...(p.name ? { horseName: p.name } : {}) };
    case 'tournament':
      return p.rank ? { kind: p.kind, id: p.id, label: p.name ?? '大会の記録', sub: p.rank === 1 ? '大会優勝' : `大会 {n}位`.replace('{n}', String(p.rank)), icon: null } : null;
  }
}

export function seasonClassLabel(classId: string) { return `今シーズン {cls}クラス`.replace('{cls}', classId); }

/** REQ-SHOW-007: renders a profile + copy for a viewer, re-checking against the current master (removed things drop off). */
export function renderShowcase(m: Master, p: PublicProfile, copy: ShowcaseCopy | null, locale: Locale, relation: ShowcaseRelation, seasonId?: string): ShowcaseCardView {
  const sm = showcaseOf(m);
  const bg = (copy && sm.backgrounds.find((b) => b.id === copy.backgroundId)) || defaultBackground(sm);
  const phrase = copy?.phraseId ? sm.phrases.find((x) => x.id === copy.phraseId) ?? null : null;
  const title = p.titleId ? m.titles.find((t) => t.id === p.titleId) ?? null : null;
  const c = showcaseOf(m).config;
  const horse = copy?.horse ? (({ name, ...rest }) => ({ ...rest, horseName: name }))(copy.horse) : null;
  const young = !!copy?.young;
  return {
    playerId: p.playerId, state: 'ok', displayName: p.displayName,
    titleId: title ? title.id : null, titleName: title ? title.name : null, classId: p.classId, rating: p.rating,
    stats: { ...p.stats }, lastSeenAt: p.lastSeenAt, silks: p.silks ?? null,
    background: { id: bg.id, key: showcaseBgKey(bg.id), backgroundName: bg[locale] },
    phrase: phrase ? { id: phrase.id, phraseText: phrase[locale] } : null,
    horse,
    pins: (copy?.pins ?? []).slice(0, c.pinsMax).map((x) => pinView(m, x)).filter((x): x is ShowcasePinView => !!x),
    timeAttack: (copy?.ta ?? []).slice(0, c.taMax).filter((t) => trackExists(m, t.trackId)).map((t) => ({ trackId: t.trackId, course: rivalTrackName(t.trackId), time: formatRaceTime(t.timeMs), timeMs: t.timeMs, horseName: t.horseName })),
    // a copy written last season (the owner has not played since the rollover) shows no season class
    seasonClass: copy?.season && (seasonId === undefined || copy.season.seasonId === seasonId) ? { ...copy.season, label: seasonClassLabel(copy.season.classId) } : null,
    cupTrophies: p.cupTrophies ? { ...p.cupTrophies } : null,
    relation,
    reportable: relation !== 'self',
    reportableHorseId: relation !== 'self' && horse?.horseName ? horse.horseId : null,
    young,
  };
}

/** REQ-SHOW-009/010: the neutral card (blocked either way, deleted, banned, unknown) — never says which. */
export function neutralShowcase(m: Master, playerId: string, locale: Locale): ShowcaseCardView {
  const bg = defaultBackground(showcaseOf(m));
  return {
    playerId, state: 'neutral', displayName: SHOWCASE_NEUTRAL_NAME[locale],
    titleId: null, titleName: null, classId: null, rating: null, stats: null, lastSeenAt: null, silks: null,
    background: { id: bg.id, key: showcaseBgKey(bg.id), backgroundName: bg[locale] },
    phrase: null, horse: null, pins: [], timeAttack: [], seasonClass: null, cupTrophies: null,
    relation: 'other', reportable: false, reportableHorseId: null, young: false,
  };
}

// ------------------------------------------------------------------------------------------------ the editor

export const SHOWCASE_NOTICE = 'カードに出せるのは自分で手に入れたものだけです。引退した馬や手元にないものは自動で外れます。一言は決まった文から選びます。';

function unlockText(m: Master, b: ShowcaseBackground): string {
  if (b.unlock.kind === 'default') return '最初から使える';
  const u = b.unlock;
  const a = collectionOf(m).achievements.find((x) => x.id === u.achievementId);
  return a ? `実績「${a.name}」の${u.tier}段目で解放` : '実績で解放';
}

/** REQ-SHOW-003: GET /v1/showcase — the owner's selection, every choice with eligibility, and the preview. */
export function showcaseMine(m: Master, s: PlayerState, now: number, locale: Locale) {
  const c = requireConfig(m);
  const sm = showcaseOf(m);
  const young = showcaseYoung(m, s, now);
  const sel = peek(s) ?? null;
  const preview = renderShowcase(m, ownProfile(s), showcaseCopy(m, s, now) ?? (sel ? null : defaultCopy(m, s, now)), locale, 'self', seasonIdFor(now));
  return {
    saved: !!sel,
    selection: sel ? { horseId: sel.horseId, pins: sel.pins, taTrackIds: sel.taTrackIds, phraseId: sel.phraseId, backgroundId: sel.backgroundId } : { horseId: null, pins: [], taTrackIds: [], phraseId: null, backgroundId: defaultBackground(sm).id },
    limits: { pinsMax: c.pinsMax, taMax: c.taMax },
    horses: s.horses.filter((h) => favouriteEligible(s, h.id)).map((h) => ({ horseId: h.id, horseName: h.name, rarity: h.rarity, sex: h.sex, appearance: appearanceOf(h, s.id) })),
    pins: pinnableRefs(m, s).map((r) => resolvePin(m, s, r, false)).filter((x): x is ShowcasePinCopy => !!x).map((x) => pinView(m, x)).filter((x): x is ShowcasePinView => !!x),
    courses: Object.entries(s.timeAttack?.allTimeBest ?? {}).filter(([t]) => trackExists(m, t)).sort(([a], [b]) => a.localeCompare(b))
      .map(([t, b]) => ({ trackId: t, course: rivalTrackName(t), time: formatRaceTime(b.timeMs), timeMs: b.timeMs, horseName: b.horseName })),
    phrases: sm.phrases.map((p) => ({ id: p.id, phraseText: p[locale] })),
    backgrounds: sm.backgrounds.map((b) => ({ id: b.id, key: showcaseBgKey(b.id), backgroundName: b[locale], unlocked: backgroundUnlocked(s, b), unlockText: unlockText(m, b) })),
    young,
    preview,
    notice: SHOWCASE_NOTICE,
  };
}

/** Before the first save the preview shows the default card (default background, no picks) — nothing is published. */
function defaultCopy(m: Master, s: PlayerState, now: number): ShowcaseCopy {
  return { v: 1, backgroundId: defaultBackground(showcaseOf(m)).id, phraseId: null, horse: null, pins: [], ta: [], season: s.season.races > 0 && s.season.id === seasonIdFor(now) ? { seasonId: s.season.id, classId: s.season.classId } : null, updatedAt: now };
}
function ownProfile(s: PlayerState): PublicProfile {
  return {
    playerId: s.id, displayName: s.profile.displayName, titleId: s.profile.titleId, classId: s.season.classId, rating: Math.round(s.rating.r),
    stats: { races: s.stats.races, wins: s.stats.wins, top3: s.stats.top3 }, lastSeenAt: s.profile.lastSeenAt, silks: s.profile.silks,
    ...(s.cups && s.cups.trophies.gold + s.cups.trophies.silver + s.cups.trophies.bronze > 0 ? { cupTrophies: { ...s.cups.trophies } } : {}),
  };
}

// ------------------------------------------------------------------------------------------------ orchestration

/** The ports GET /v1/showcase/:playerId needs (PlayerDO RPC + DirectoryDO in production, PlayerService + MemoryDirectory in tests). */
export interface ShowcasePorts {
  /** Current public profiles (the directory copy; a deleted account has none). */
  profiles(ids: string[]): Promise<PublicProfile[]>;
  /** The viewer's friends and block list (one call on the viewer's object). */
  viewer(u: string): Promise<{ friendIds: string[]; blocked: string[] }>;
  /** A player's block list (§47.1, the one list). */
  blocks(u: string): Promise<string[]>;
  /** The owner's editor view (self card from the live state). */
  mine(u: string, locale: Locale): Promise<ReturnType<typeof showcaseMine>>;
}

export class ShowcaseService {
  constructor(private readonly p: ShowcasePorts, private readonly master: () => Master, private readonly clock: () => number = Date.now) {}

  /** GET /v1/showcase/:playerId — never touches the target's state except its block list (like the stable visit). */
  async card(u: string, target: string, locale: Locale): Promise<ShowcaseCardView> {
    const m = this.master();
    if (!showcaseConfig(m)) throw new AppError('NOT_FOUND', 'the showcase is not available');
    if (target === u) return (await this.p.mine(u, locale)).preview;
    const [profile] = await this.p.profiles([target]);
    if (!profile || profile.playerId !== target || profile.banned) return neutralShowcase(m, target, locale);
    const [v, theirs] = await Promise.all([this.p.viewer(u), this.p.blocks(target)]);
    if (v.blocked.includes(target) || theirs.includes(u)) return neutralShowcase(m, target, locale);
    return renderShowcase(m, profile, profile.showcase ?? null, locale, v.friendIds.includes(target) ? 'friend' : 'other', seasonIdFor(this.clock()));
  }
}
