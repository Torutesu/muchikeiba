/**
 * イベントカレンダー（予定表） — REQ-CAL-001..020, contracts/protocol.md §65.
 *
 * One read-only calendar of everything the player can take part in. Nothing is copied: every row is built when it is
 * read from the one place that owns it —
 *   events and the exchange window (master.events, exchange.ts exchangeClosesAt), the weekly challenge week
 *   (weeklyChallenge.ts weekAt), the branch goal week (teamGoal.ts weekKeyOf), the branch league season and the ranked
 *   season (calendar months: league.ts seasonStartMs, season.ts seasonIdFor), the month the season pass can be bought
 *   (the same month pass.ts passPurchaseInfo sells), announced / open scout banners (gacha.ts bannerStatus), tournaments
 *   (TournamentSummary from the tournament index), the player's hosted cups (the cup objects, read like GET /v1/cups),
 *   maintenance windows players can see (maintenance.ts visibleWindows) and the player's own comeback window (§20).
 * The only state is the player's marks (`calendar.marks`, bounded): a reminder is device-local once §61 lands; the server
 * never pushes for a mark. Paid things (the pass, banners) are dates only — no price, no buy link. No countdowns.
 */
import { AppError } from './errors.js';
import type { Master } from './master.js';
import type { PlayerState } from './player.js';
import type { Emit } from './service.js';
import { unlocksView, type UnlockKey } from './onboarding.js';
import { addJstDays, dayRule, gameDayKey, gameDayStartMs, jstDateKey, jstMonthEndMs, jstMonthKey } from './time.js';
import { exchangeClosesAt } from './exchange.js';
import { weekAt, weeklyChallengeConfig } from './weeklyChallenge.js';
import { teamGoalConfig, weekEndMs, weekKeyOf, weekStartMs } from './teamGoal.js';
import { seasonStartMs } from './league.js';
import { bannerStatus } from './gacha.js';
import { passPurchasesFor } from './pass.js';
import { maintenanceOf, msToJst, shortJst, visibleWindows, adminWindowView, type MaintenanceGroup } from './maintenance.js';
import { windowActive } from './comeback.js';
import { bettingWordsIn } from './bettingWords.js';
import type { TournamentSummary } from './tournaments.js';

// ------------------------------------------------------------------------------------------------ kinds & limits

export const CALENDAR_KINDS = [
  'event', 'event_exchange', 'weekly_challenge', 'team_goal', 'league_season', 'season', 'season_pass', 'banner',
  'tournament_registration', 'tournament', 'cup', 'maintenance', 'comeback',
] as const;
export type CalendarKind = typeof CALENDAR_KINDS[number];
/** The id prefix of each kind (`<prefix>:<id of the source>`). */
export const CALENDAR_ID_PREFIX: Record<CalendarKind, string> = {
  event: 'event', event_exchange: 'exch', weekly_challenge: 'wch', team_goal: 'tgoal', league_season: 'league', season: 'season',
  season_pass: 'pass', banner: 'banner', tournament_registration: 'treg', tournament: 'tour', cup: 'cup', maintenance: 'mnt', comeback: 'comeback',
};
export const CALENDAR_ENTRY_ID_RE = /^[a-z]{3,8}:[A-Za-z0-9_-]{1,64}$/;
export const CALENDAR_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export const CALENDAR_LIMITS = {
  /** Days one request may cover (from and to included). */
  maxRangeDays: 35,
  /** `from` may start at most this many days before today. */
  pastDays: 35,
  /** `to` may end at most this many days after today. */
  futureDays: 90,
  maxEntries: 200,
  /** Marks kept per player (each drops off by itself once its row has ended). */
  marksMax: 30,
} as const;

/** How a row's days are counted: game days (04:00 rollover, REQ-DAY-001), calendar months (0:00, REQ-DAY-004) or exact ms. */
export type CalendarRule = 'game_day' | 'calendar_month' | 'exact';

/** The label of each kind (Japanese; English at the response boundary from i18n/en.ts). */
export const CALENDAR_TITLES: Record<CalendarKind, string> = {
  event: 'イベントレース', event_exchange: 'イベント交換所', weekly_challenge: '週替わりチャレンジ', team_goal: '支部の共同目標',
  league_season: '支部対抗シーズン', season: 'ランク戦のシーズン', season_pass: 'シーズンパスを買える期間', banner: 'スカウト',
  tournament_registration: '大会の受付', tournament: '大会の開始', cup: '主催カップ', maintenance: 'メンテナンス', comeback: '復帰キャンペーン',
};
export const CALENDAR_TIME_ZONE = '日本時間';
/** REQ-CAL-008: shop / urgency words never used in the calendar (same list as maintenance LEGAL_WORDS_JA, docs/planning/03). */
const BANNED_JA = ['倍', 'お得', '今だけ', '残りわずか', '通常価格'];

/** The §4.3 unlock key(s) a kind needs (any of them); null = no unlock key (membership / ownership decides). */
const KIND_UNLOCK: Record<CalendarKind, UnlockKey[] | null> = {
  event: ['events'], event_exchange: ['events'], weekly_challenge: ['weekly_challenge'], team_goal: ['teams'], league_season: ['teams'],
  season: ['season'], season_pass: ['season_pass'], banner: ['scout'], tournament_registration: ['tournaments'], tournament: ['tournaments', 'spectate'],
  cup: null, maintenance: null, comeback: null,
};

/** The maintenance group that closes each kind (§46; ops overlap check, §65.3). */
export const KIND_GROUP: Partial<Record<CalendarKind, MaintenanceGroup>> = {
  event: 'events', event_exchange: 'events', tournament_registration: 'tournaments', tournament: 'tournaments', banner: 'gacha',
  weekly_challenge: 'time_attack', team_goal: 'teams', league_season: 'teams', season_pass: 'shop', cup: 'cups',
};

export interface CalendarLink { screen: string; id: string | null }
export interface CalendarEntry {
  id: string; kind: CalendarKind; title: string; name: string | null; cupName?: string;
  startAt: number; endAt: number; startJst: string; endJst: string; firstDay: string; lastDay: string; rule: CalendarRule;
  status: 'upcoming' | 'open' | 'ended'; paid: boolean; link: CalendarLink | null; spectate: boolean; groups: string[] | null;
  markable: boolean; marked: boolean;
  /** Ops view only: a banner / window players cannot see yet. */
  announced?: boolean;
}

/** What other objects hold (read by the HTTP layer; null = could not be read → `partial`). */
export interface CalendarCup { cupId: string; cupName: string; opensAt: number; closesAt: number; status: string }
export interface CalendarExternal {
  tournaments: Pick<TournamentSummary, 'id' | 'name' | 'status' | 'registrationOpensAtMs' | 'registrationClosesAtMs' | 'startsAtMs'>[] | null;
  cups: CalendarCup[] | null;
}

export interface CalendarMark { id: string; kind: CalendarKind; until: number }
export interface CalendarState { marks: CalendarMark[] }

// ------------------------------------------------------------------------------------------------ range

export interface CalendarRange { from: string; to: string; startMs: number; endMs: number; today: string }

/** REQ-CAL-004: `from` / `to` (game days, both included); defaults to 35 days from today. */
export function calendarRange(m: Pick<Master, 'progression'>, q: { from?: string | null; to?: string | null }, now: number): CalendarRange {
  const rule = dayRule(m);
  const today = gameDayKey(now, rule);
  const bad = (msg: string) => new AppError('BAD_REQUEST', msg);
  const valid = (d: string) => CALENDAR_DAY_RE.test(d) && addJstDays(d, 0) === d;
  const from = q.from ?? today;
  if (!valid(from)) throw bad('from: expected YYYY-MM-DD');
  const to = q.to ?? addJstDays(from, CALENDAR_LIMITS.maxRangeDays - 1);
  if (!valid(to)) throw bad('to: expected YYYY-MM-DD');
  if (to < from) throw bad('to is before from');
  if (addJstDays(from, CALENDAR_LIMITS.maxRangeDays - 1) < to) throw bad(`at most ${CALENDAR_LIMITS.maxRangeDays} days`);
  if (from < addJstDays(today, -CALENDAR_LIMITS.pastDays)) throw bad(`from may be at most ${CALENDAR_LIMITS.pastDays} days ago`);
  if (to > addJstDays(today, CALENDAR_LIMITS.futureDays)) throw bad(`to may be at most ${CALENDAR_LIMITS.futureDays} days ahead`);
  return { from, to, today, startMs: gameDayStartMs(from, rule), endMs: gameDayStartMs(addJstDays(to, 1), rule) };
}

/** JST months ("YYYY-MM") touched by [startMs, endMs). */
function monthsIn(startMs: number, endMs: number): string[] {
  const out: string[] = [];
  let k = jstMonthKey(startMs);
  while (seasonStartMs(k) < endMs) { out.push(k); k = jstMonthKey(jstMonthEndMs(k)); }
  return out;
}

// ------------------------------------------------------------------------------------------------ building rows

interface Draft { kind: CalendarKind; sourceId: string; name: string | null; cupName?: string; startAt: number; endAt: number; rule: CalendarRule; paid?: boolean; link: CalendarLink | null; spectate?: boolean; groups?: string[] | null; announced?: boolean }

function finish(m: Pick<Master, 'progression'>, d: Draft, now: number, marked: ReadonlySet<string>): CalendarEntry {
  const rule = dayRule(m);
  const dayOf = (ms: number) => (d.rule === 'calendar_month' ? jstDateKey(ms) : gameDayKey(ms, rule));
  const point = d.endAt <= d.startAt;
  const last = point ? d.startAt : d.endAt - 1;
  const id = `${CALENDAR_ID_PREFIX[d.kind]}:${d.sourceId}`;
  const status = point ? (now < d.startAt ? 'upcoming' : 'ended') : now < d.startAt ? 'upcoming' : now < d.endAt ? 'open' : 'ended';
  return {
    id, kind: d.kind, title: CALENDAR_TITLES[d.kind], name: d.name, ...(d.cupName !== undefined ? { cupName: d.cupName } : {}),
    startAt: d.startAt, endAt: point ? d.startAt : d.endAt, startJst: shortJst(d.startAt), endJst: shortJst(point ? d.startAt : d.endAt),
    firstDay: dayOf(d.startAt), lastDay: dayOf(last), rule: d.rule, status, paid: d.paid ?? false, link: d.link,
    spectate: d.spectate ?? false, groups: d.groups ?? null, markable: status !== 'ended', marked: marked.has(id),
    ...(d.announced !== undefined ? { announced: d.announced } : {}),
  };
}

const seasonName = (monthKey: string) => { const [y, mo] = monthKey.split('-'); return `${Number(y)}年${Number(mo)}月シーズン`; };

/**
 * The rows the master and remote config own (events, exchange, weeks, months, banners, maintenance).
 * `audience` player: only what players can see; ops: also unannounced banners and scheduled windows (flagged `announced: false`).
 */
function masterDrafts(m: Master, range: Pick<CalendarRange, 'startMs' | 'endMs'>, now: number, audience: 'player' | 'ops', team: boolean): Draft[] {
  const rule = dayRule(m);
  const out: Draft[] = [];
  for (const ev of m.events) {
    out.push({ kind: 'event', sourceId: ev.id, name: ev.name, startAt: ev.startAtMs, endAt: ev.endAtMs, rule: 'exact', link: { screen: 'event', id: ev.id } });
    if (ev.exchange) out.push({ kind: 'event_exchange', sourceId: ev.id, name: ev.name, startAt: ev.startAtMs, endAt: exchangeClosesAt(ev, ev.exchange, rule), rule: 'game_day', link: { screen: 'event_exchange', id: ev.id } });
  }
  const wc = weeklyChallengeConfig(m);
  if (wc?.enabled) {
    // the week ids come from the same weekAt the challenge screen uses; contents are named only once announced (this week, next when previewed)
    const nowWeek = weekAt(m, wc, now).weekId;
    for (let off = 0; off <= 20; off++) {
      const w = weekAt(m, wc, range.startMs, off);
      if (w.startsAt >= range.endMs) break;
      const named = w.weekId <= nowWeek || (wc.previewNext && w.weekId === weekAt(m, wc, now, 1).weekId);
      out.push({ kind: 'weekly_challenge', sourceId: w.weekId, name: named ? w.def.badge.name : null, startAt: w.startsAt, endAt: w.endsAt, rule: 'game_day', link: { screen: 'weekly_challenge', id: null } });
    }
  }
  if (team && teamGoalConfig(m)) {
    for (let wk = weekKeyOf(range.startMs, rule); weekStartMs(wk, rule) < range.endMs; wk = addJstDays(wk, 7)) {
      out.push({ kind: 'team_goal', sourceId: wk, name: null, startAt: weekStartMs(wk, rule), endAt: weekEndMs(wk, rule), rule: 'game_day', link: { screen: 'team_goal', id: null } });
    }
  }
  const passOnSale = m.products.some((p) => p.kind === 'season_pass' && p.storeType !== 'auto_renewing');
  for (const mk of monthsIn(range.startMs, range.endMs)) {
    const startAt = seasonStartMs(mk), endAt = jstMonthEndMs(mk);
    out.push({ kind: 'season', sourceId: mk, name: seasonName(mk), startAt, endAt, rule: 'calendar_month', link: { screen: 'season', id: null } });
    if (team && m.progression.league) out.push({ kind: 'league_season', sourceId: mk, name: seasonName(mk), startAt, endAt, rule: 'calendar_month', link: { screen: 'league', id: null } });
    // REQ-CAL-007: dates only — no price, no link to the purchase screen
    if (passOnSale) out.push({ kind: 'season_pass', sourceId: mk, name: seasonName(mk), startAt, endAt, rule: 'calendar_month', paid: true, link: null });
  }
  for (const b of m.gacha.banners) {
    if (b.startAtMs === undefined || b.endAtMs === undefined) continue; // permanent banners have no dates
    const st = bannerStatus(b, now);
    const announced = st === 'active' || st === 'upcoming';
    if (audience === 'player' && !announced) continue; // REQ-CAL-005: never an unannounced banner
    out.push({ kind: 'banner', sourceId: b.id, name: b.name, startAt: b.startAtMs, endAt: b.endAtMs, rule: 'exact', paid: true, link: { screen: 'gacha_rates', id: b.id }, ...(audience === 'ops' ? { announced: announced || st === 'ended' } : {}) });
  }
  const mc = maintenanceOf(m);
  if (audience === 'player') {
    for (const w of visibleWindows(mc, now)) {
      const src = mc.windows.find((x) => x.id === w.id)!;
      out.push({ kind: 'maintenance', sourceId: w.id, name: src.message.ja, startAt: w.startAt, endAt: w.endAt, rule: 'exact', link: { screen: 'maintenance', id: null }, groups: Array.isArray(w.scope) ? [...w.scope] : ['all'] });
    }
  } else {
    for (const w of mc.windows) {
      const v = adminWindowView(w, now);
      if (v.status === 'cancelled') continue;
      out.push({ kind: 'maintenance', sourceId: w.id, name: w.message.ja, startAt: w.startAtMs, endAt: v.effectiveEndAt, rule: 'exact', link: null, groups: Array.isArray(w.scope) ? [...w.scope] : ['all'], announced: v.status !== 'scheduled' });
    }
  }
  return out;
}

function externalDrafts(ext: CalendarExternal, spectate: boolean): Draft[] {
  const out: Draft[] = [];
  for (const t of ext.tournaments ?? []) {
    if (t.status === 'cancelled') continue;
    out.push({ kind: 'tournament_registration', sourceId: t.id, name: t.name, startAt: t.registrationOpensAtMs, endAt: t.registrationClosesAtMs, rule: 'exact', link: { screen: 'tournament', id: t.id } });
    out.push({ kind: 'tournament', sourceId: t.id, name: t.name, startAt: t.startsAtMs, endAt: t.startsAtMs, rule: 'exact', link: { screen: 'tournament', id: t.id }, spectate });
  }
  for (const c of ext.cups ?? []) {
    if (c.status === 'finished' || c.status === 'cancelled') continue;
    out.push({ kind: 'cup', sourceId: c.cupId, name: null, cupName: c.cupName, startAt: c.opensAt, endAt: c.closesAt, rule: 'exact', link: { screen: 'cup', id: c.cupId } });
  }
  return out;
}

const KIND_ORDER = new Map(CALENDAR_KINDS.map((k, i) => [k, i]));
const inRange = (d: Pick<Draft, 'startAt' | 'endAt'>, r: Pick<CalendarRange, 'startMs' | 'endMs'>) =>
  d.endAt <= d.startAt ? d.startAt >= r.startMs && d.startAt < r.endMs : d.endAt > r.startMs && d.startAt < r.endMs;
const sortDrafts = (a: Draft, b: Draft) => a.startAt - b.startAt || KIND_ORDER.get(a.kind)! - KIND_ORDER.get(b.kind)! || (a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0);

/** REQ-CAL-005: kinds this player can see (the §4.3 unlocks; a key the progression does not list is open, like the home). */
function openKinds(m: Master, s: PlayerState, now: number): (k: CalendarKind) => boolean {
  const f = new Map(unlocksView(m, s, now).features.map((x) => [x.key, x.unlocked]));
  const open = (key: UnlockKey) => f.get(key) ?? true;
  return (k) => { const keys = KIND_UNLOCK[k]; return keys === null || keys.some(open); };
}
const isTeamMember = (s: PlayerState) => !!s.team?.teamId;

/** The player's rows in a range (marks applied), at most `limit` of them. */
export function playerCalendarEntries(m: Master, s: PlayerState, range: Pick<CalendarRange, 'startMs' | 'endMs'>, now: number, ext: CalendarExternal, limit: number = CALENDAR_LIMITS.maxEntries): CalendarEntry[] {
  const open = openKinds(m, s, now);
  const unlocked = new Map(unlocksView(m, s, now).features.map((x) => [x.key, x.unlocked]));
  const drafts = [...masterDrafts(m, range, now, 'player', isTeamMember(s)), ...externalDrafts(ext, unlocked.get('spectate') ?? true)];
  // REQ-CAL-001 (§20): the comeback window only while it runs for this player
  const w = s.comeback?.window;
  if (m.progression.comeback && windowActive(m, w, now)) drafts.push({ kind: 'comeback', sourceId: w.id, name: null, startAt: w.startedAt, endAt: w.endsAt, rule: 'game_day', link: { screen: 'comeback', id: null } });
  const marked = new Set(liveMarks(s, now).map((x) => x.id));
  // a month whose pass this player already bought is not a purchase period for them any more (dates only either way)
  const owned = (d: Draft) => d.kind === 'season_pass' && passPurchasesFor(s, d.sourceId).length > 0;
  return drafts.filter((d) => open(d.kind) && inRange(d, range) && !owned(d)).sort(sortDrafts).slice(0, limit).map((d) => finish(m, d, now, marked));
}

/** GET /v1/calendar (REQ-CAL-004..009). */
export function calendarView(m: Master, s: PlayerState, q: { from?: string | null; to?: string | null }, now: number, ext: CalendarExternal) {
  const range = calendarRange(m, q, now);
  const entries = playerCalendarEntries(m, s, range, now, ext);
  const partial = [...(ext.tournaments === null ? ['tournaments'] : []), ...(ext.cups === null ? ['cups'] : [])];
  return {
    from: range.from, to: range.to, today: range.today, serverNow: now, timeZone: CALENDAR_TIME_ZONE, partial,
    marks: { count: liveMarks(s, now).length, max: CALENDAR_LIMITS.marksMax }, entries,
  };
}

// ------------------------------------------------------------------------------------------------ marks (REQ-CAL-010/011)

export function ensureCalendar(s: PlayerState): CalendarState {
  s.calendar ??= { marks: [] };
  return s.calendar;
}
/** Marks whose rows have not ended yet. */
export const liveMarks = (s: PlayerState, now: number): CalendarMark[] => (s.calendar?.marks ?? []).filter((x) => x.until > now);

/**
 * PUT / DELETE /v1/calendar/marks/:entryId. A mark is set only on a row this player can see from today on (as far ahead as
 * GET reaches) that has not ended (the same build as GET). Idempotent both ways. Only the flag is stored — no push is ever sent for it (§61 note).
 */
export function markCalendar(m: Master, s: PlayerState, entryId: string, on: boolean, now: number, ext: CalendarExternal, emit?: Emit) {
  if (!CALENDAR_ENTRY_ID_RE.test(entryId)) throw new AppError('NOT_FOUND', 'no such calendar entry');
  const st = ensureCalendar(s);
  st.marks = st.marks.filter((x) => x.until > now);
  const had = st.marks.find((x) => x.id === entryId);
  if (!on) {
    if (had) {
      st.marks = st.marks.filter((x) => x.id !== entryId);
      emit?.({ name: 'calendar_mark', s1: had.kind, s2: 'off' });
    }
    return { marked: false, id: entryId, count: st.marks.length, max: CALENDAR_LIMITS.marksMax };
  }
  // every row GET can show from today on (up to CALENDAR_LIMITS.futureDays ahead), uncapped: what the list offers to mark
  const rule = dayRule(m);
  const today = gameDayKey(now, rule);
  const range = { startMs: gameDayStartMs(today, rule), endMs: gameDayStartMs(addJstDays(today, CALENDAR_LIMITS.futureDays + 1), rule) };
  const e = playerCalendarEntries(m, s, range, now, ext, Number.MAX_SAFE_INTEGER).find((x) => x.id === entryId);
  if (!e) throw new AppError('NOT_FOUND', 'no such calendar entry');
  if (!e.markable) throw new AppError('CONFLICT', 'the entry has ended', undefined, { reason: 'ended' });
  if (!had) {
    if (st.marks.length >= CALENDAR_LIMITS.marksMax) throw new AppError('CONFLICT', `at most ${CALENDAR_LIMITS.marksMax} marks`, undefined, { reason: 'limit' });
    st.marks.push({ id: e.id, kind: e.kind, until: e.endAt > e.startAt ? e.endAt : e.startAt });
    emit?.({ name: 'calendar_mark', s1: e.kind, s2: 'on' });
  }
  return { marked: true, id: entryId, count: st.marks.length, max: CALENDAR_LIMITS.marksMax };
}

// ------------------------------------------------------------------------------------------------ ops (REQ-CAL-012)

export interface CalendarOverlap { a: string; b: string; kind: 'maintenance_closes' | 'same_kind'; from: number; to: number; fromJst: string; toJst: string }
const SAME_KIND_CHECK: readonly CalendarKind[] = ['event', 'banner', 'tournament_registration'];

/** The whole calendar of a config version (no player: team rows shown, cups / comeback left out) and its overlaps. */
export function opsCalendar(m: Master, q: { from?: string | null; to?: string | null }, now: number, tournaments: CalendarExternal['tournaments']) {
  const range = calendarRange(m, q, now);
  const drafts = [...masterDrafts(m, range, now, 'ops', true), ...externalDrafts({ tournaments, cups: [] }, true)].filter((d) => inRange(d, range)).sort(sortDrafts);
  const entries = drafts.slice(0, CALENDAR_LIMITS.maxEntries).map((d) => finish(m, d, now, new Set()));
  const overlaps: CalendarOverlap[] = [];
  const span = (e: CalendarEntry) => [e.startAt, Math.max(e.endAt, e.startAt + 1)] as const;
  const push = (a: CalendarEntry, b: CalendarEntry, kind: CalendarOverlap['kind']) => {
    const [as, ae] = span(a), [bs, be] = span(b);
    const from = Math.max(as, bs), to = Math.min(ae, be);
    if (from < to) overlaps.push({ a: a.id, b: b.id, kind, from, to, fromJst: msToJst(from), toJst: msToJst(to) });
  };
  for (const w of entries.filter((e) => e.kind === 'maintenance')) {
    for (const e of entries) {
      const g = KIND_GROUP[e.kind];
      if (!g || e.kind === 'maintenance') continue;
      if (w.groups!.includes('all') || w.groups!.includes(g)) push(w, e, 'maintenance_closes');
    }
  }
  for (const k of SAME_KIND_CHECK) {
    const xs = entries.filter((e) => e.kind === k);
    for (let i = 0; i < xs.length; i++) for (let j = i + 1; j < xs.length; j++) push(xs[i]!, xs[j]!, 'same_kind');
  }
  return { from: range.from, to: range.to, today: range.today, serverNow: now, entries, overlaps };
}

// ------------------------------------------------------------------------------------------------ wording (REQ-CAL-008)

/** Problems in the calendar's own texts (titles, time zone label) and the given names. Empty = clean. */
export function calendarWordingProblems(texts: string[] = [...Object.values(CALENDAR_TITLES), CALENDAR_TIME_ZONE]): string[] {
  const out: string[] = [];
  for (const t of texts) {
    for (const w of BANNED_JA) if (t.includes(w)) out.push(`「${t}」: shop word 「${w}」`);
    for (const w of bettingWordsIn(t)) out.push(`「${t}」: betting word ${w}`);
  }
  return out;
}
