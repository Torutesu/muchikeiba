// REQ-CAL-001..020: イベントカレンダー（予定表） (contracts/protocol.md §65).
import { describe, expect, it } from 'vitest';
import { handle, makeFriendsService, type AppContext, type PlayerInvoker } from '../src/http/app.js';
import { MemoryDirectory } from '../src/domain/friends.js';
import { MemoryPlayerRepo, PlayerService } from '../src/domain/service.js';
import { FakeStoreVerifier } from '../src/domain/purchase.js';
import { seededRng } from '../src/domain/rng.js';
import { AppError } from '../src/domain/errors.js';
import { DEFAULT_RULESET } from '../src/domain/ruleset.js';
import {
  CALENDAR_KINDS, CALENDAR_LIMITS, CALENDAR_TITLES, CALENDAR_ID_PREFIX, calendarRange, calendarView, calendarWordingProblems, markCalendar,
  opsCalendar, type CalendarEntry, type CalendarExternal,
} from '../src/domain/calendar.js';
import { CALENDAR_KPI_KINDS, clientBatchSchema, clientToKpi, type KpiEvent, type KpiRecord } from '../src/domain/kpi.js';
import { DEFAULT_MAINTENANCE, endpointGroup, gateRequest, isExempt, type MaintenanceConfig } from '../src/domain/maintenance.js';
import { exchangeClosesAt } from '../src/domain/exchange.js';
import { addJstDays, dayRule, gameDayKey, gameDayStartMs } from '../src/domain/time.js';
import { ensureTeam } from '../src/domain/teams.js';
import { newPlayer, type PlayerState } from '../src/domain/player.js';
import { seasonIdFor } from '../src/domain/season.js';
import { classifyKey, buildExportDocument } from '../src/domain/dataExport.js';
import { BASE_HELP, helpArticle, helpProblems } from '../src/domain/help.js';
import { tipsProblems } from '../src/domain/tips.js';
import { catalogFor, translateText } from '../src/i18n/catalog.js';
import { CODE_EN } from '../src/i18n/en.js';
import { bettingWordsIn } from '../src/domain/bettingWords.js';
import type { Master } from '../src/domain/master.js';
import type { TournamentsService } from '../src/domain/tournamentService.js';
import { m } from './helpers.js';

const H = 3_600_000;
const DAY = 86_400_000;
/** 2026-11-11 12:00 JST */
const NOW = Date.UTC(2026, 10, 11, 3);
const JP = /[぀-ヿ㐀-鿿]/;
const NO_EXT: CalendarExternal = { tournaments: [], cups: [] };

/** A player with every §4.3 feature open. */
function veteran(now = NOW): PlayerState {
  const s = newPlayer('p1', now - 60 * DAY, seasonIdFor(now));
  s.onboarding = { races: 200, breedings: 9, counts: {}, claimed: [] };
  s.rating.rankedRaces = 80;
  return s;
}
const fresh = (now = NOW) => newPlayer('p2', now, seasonIdFor(now));
const ids = (es: CalendarEntry[]) => es.map((e) => e.id);
const byId = (es: CalendarEntry[], id: string) => es.find((e) => e.id === id);
const withMaint = (windows: MaintenanceConfig['windows'], base: Master = m): Master => ({ ...base, maintenance: { ...structuredClone(DEFAULT_MAINTENANCE), windows } });
const code = (f: () => unknown) => { try { f(); return 'ok'; } catch (e) { return (e as AppError).code; } };

describe('range (REQ-CAL-004)', () => {
  it('defaults to 35 game days from today; bounded to 35 days, 35 days back and 90 ahead', () => {
    const r = calendarRange(m, {}, NOW);
    expect(r).toMatchObject({ from: '2026-11-11', to: '2026-12-15', today: '2026-11-11' });
    expect(r.startMs).toBe(gameDayStartMs('2026-11-11', dayRule(m)));
    expect(r.endMs).toBe(gameDayStartMs('2026-12-16', dayRule(m)));
    expect(calendarRange(m, { from: '2026-11-20', to: '2026-12-24' }, NOW).to).toBe('2026-12-24');
    for (const q of [{ from: '2026-11-20', to: '2026-12-25' }, { from: '2026-11-20', to: '2026-11-19' }, { from: '2026-13-01' }, { from: '2026-02-30' },
      { from: '20261111' }, { from: '2026-10-06' }, { from: '2027-02-01', to: '2027-02-10' }]) expect(code(() => calendarRange(m, q, NOW)), JSON.stringify(q)).toBe('BAD_REQUEST');
    expect(calendarRange(m, { from: '2026-10-07' }, NOW).from).toBe('2026-10-07');
    expect(calendarRange(m, { from: '2027-02-01', to: '2027-02-09' }, NOW).to).toBe('2027-02-09');
  });
  it('before 04:00 JST "today" is still the previous game day once the 04:00 rollover is in effect (REQ-DAY-001)', () => {
    const at = Date.UTC(2026, 11, 9, 18, 30); // 12/10 03:30 JST
    expect(calendarRange(m, {}, at).today).toBe('2026-12-09');
    expect(calendarRange(m, {}, at).startMs).toBe(Date.UTC(2026, 11, 8, 19)); // 12/09 04:00 JST
  });
});

describe('sources (REQ-CAL-001/002/003)', () => {
  it('events, banners, seasons, the pass and weekly challenge weeks, each from its own source', () => {
    const v = calendarView(m, veteran(), {}, NOW, NO_EXT);
    const ev = byId(v.entries, 'event:sprint_cup_2026_11')!;
    const def = m.events.find((e) => e.id === 'sprint_cup_2026_11')!;
    expect(ev).toMatchObject({ kind: 'event', title: 'イベントレース', name: def.name, startAt: def.startAtMs, endAt: def.endAtMs, rule: 'exact', status: 'open', paid: false, link: { screen: 'event', id: def.id } });
    expect(byId(v.entries, 'event:no_whip_cup_2026_12')?.status).toBe('upcoming');
    expect(ids(v.entries)).not.toContain('event:newyear_cup_2027_01'); // outside the range
    // a banner players can see now, with its dates only (no price) and a link to the rates page
    const b = byId(v.entries, 'banner:pickup_ginga')!;
    expect(b).toMatchObject({ paid: true, link: { screen: 'gacha_rates', id: 'pickup_ginga' }, status: 'open' });
    for (const e of v.entries) expect(Object.keys(e).some((k) => /price|coin|cost/i.test(k)), e.id).toBe(false);
    // seasons and the pass follow calendar months (00:00 JST, REQ-DAY-004): the day is the calendar date
    const nov = byId(v.entries, 'season:2026-11')!;
    expect(nov).toMatchObject({ rule: 'calendar_month', firstDay: '2026-11-01', lastDay: '2026-11-30', name: '2026年11月シーズン', startAt: Date.UTC(2026, 9, 31, 15), endAt: Date.UTC(2026, 10, 30, 15) });
    expect(byId(v.entries, 'season:2026-12')?.firstDay).toBe('2026-12-01');
    const pass = byId(v.entries, 'pass:2026-12')!;
    expect(pass).toMatchObject({ kind: 'season_pass', paid: true, link: null, rule: 'calendar_month' });
    // weekly challenge weeks start on Monday at the game-day rollover (04:00 JST once the switch is in effect)
    const wk = byId(v.entries, 'wch:2026-12-07')!;
    expect(wk).toMatchObject({ rule: 'game_day', startAt: Date.UTC(2026, 11, 6, 19), endAt: Date.UTC(2026, 11, 13, 19), firstDay: '2026-12-07', lastDay: '2026-12-13', name: null });
    expect(byId(v.entries, 'wch:2026-11-09')?.name).toBeTruthy(); // this week's badge is announced
    // sorted by start then kind; no team rows without a team; cups / tournaments only from their objects
    expect(v.entries.map((e) => e.startAt)).toEqual([...v.entries.map((e) => e.startAt)].sort((a, c) => a - c));
    expect(v.entries.some((e) => e.kind === 'team_goal' || e.kind === 'league_season' || e.kind === 'cup' || e.kind === 'tournament')).toBe(false);
    expect(v).toMatchObject({ timeZone: '日本時間', partial: [], marks: { count: 0, max: CALENDAR_LIMITS.marksMax } });
  });
  it('the exchange window closes at the game-day rollover graceDays after the event (§30), not at the event end', () => {
    const v = calendarView(m, veteran(), { from: '2026-12-25', to: '2027-01-25' }, NOW, NO_EXT);
    const def = m.events.find((e) => e.id === 'newyear_cup_2027_01')!;
    const ex = byId(v.entries, 'exch:newyear_cup_2027_01')!;
    expect(ex).toMatchObject({ kind: 'event_exchange', rule: 'game_day', startAt: def.startAtMs, endAt: exchangeClosesAt(def, def.exchange!, dayRule(m)) });
    expect(ex.endAt).toBeGreaterThan(def.endAtMs);
    expect(ex.endAt % H).toBe(19 * H % H); // a whole hour: 04:00 JST
    expect(ex.lastDay).toBe(gameDayKey(ex.endAt - 1, dayRule(m)));
  });
  it('an unannounced banner never shows; it appears once announced (REQ-CAL-005)', () => {
    const before = calendarView(m, veteran(), { from: '2026-11-20', to: '2026-12-20' }, NOW, NO_EXT);
    expect(ids(before.entries)).not.toContain('banner:winter_2026');
    const at = Date.UTC(2026, 11, 5, 3);
    const after = calendarView(m, veteran(at), { from: '2026-12-05', to: '2027-01-08' }, at, NO_EXT);
    expect(byId(after.entries, 'banner:winter_2026')).toMatchObject({ status: 'upcoming', paid: true });
  });
  it('unlock keys (§4.3): a new player sees only what is open to them', () => {
    const v = calendarView(m, fresh(), {}, NOW, { tournaments: [{ id: 'tour_a', name: '秋のミニ大会', status: 'registration', registrationOpensAtMs: NOW - H, registrationClosesAtMs: NOW + 2 * DAY, startsAtMs: NOW + 3 * DAY }], cups: [] });
    const kinds = new Set(v.entries.map((e) => e.kind));
    expect(kinds.has('banner')).toBe(true); // scout is open from the start
    for (const k of ['event', 'weekly_challenge', 'season', 'season_pass', 'tournament', 'tournament_registration'] as const) expect(kinds.has(k), k).toBe(false);
  });
  it('branch rows only for branch members (REQ-CAL-005)', () => {
    const s = veteran();
    expect(calendarView(m, s, {}, NOW, NO_EXT).entries.some((e) => e.kind === 'team_goal')).toBe(false);
    ensureTeam(s).teamId = 'team_1';
    const v = calendarView(m, s, {}, NOW, NO_EXT);
    expect(byId(v.entries, 'tgoal:2026-11-09')).toMatchObject({ rule: 'game_day', link: { screen: 'team_goal', id: null } });
    expect(byId(v.entries, 'league:2026-11')).toMatchObject({ rule: 'calendar_month', firstDay: '2026-11-01' });
  });
  it('tournaments (registration and start, spectate flag) and the player\'s own open cups, from their objects (REQ-CAL-006)', () => {
    const ext: CalendarExternal = {
      tournaments: [
        { id: 'tour_a', name: '秋のミニ大会', status: 'registration', registrationOpensAtMs: NOW - H, registrationClosesAtMs: NOW + 2 * DAY, startsAtMs: NOW + 3 * DAY },
        { id: 'tour_x', name: '中止の大会', status: 'cancelled', registrationOpensAtMs: NOW, registrationClosesAtMs: NOW + DAY, startsAtMs: NOW + 2 * DAY },
      ],
      cups: [
        { cupId: 'cup_aaaaaaaaaaaaaaaa', cupName: 'ミドリの週末杯', opensAt: NOW + H, closesAt: NOW + 5 * H, status: 'open' },
        { cupId: 'cup_bbbbbbbbbbbbbbbb', cupName: '終わった杯', opensAt: NOW - 5 * H, closesAt: NOW - H, status: 'finished' },
      ],
    };
    const v = calendarView(m, veteran(), {}, NOW, ext);
    expect(byId(v.entries, 'treg:tour_a')).toMatchObject({ name: '秋のミニ大会', status: 'open', link: { screen: 'tournament', id: 'tour_a' } });
    expect(byId(v.entries, 'tour:tour_a')).toMatchObject({ startAt: NOW + 3 * DAY, endAt: NOW + 3 * DAY, spectate: true, status: 'upcoming' });
    expect(ids(v.entries).filter((x) => x.includes('tour_x'))).toEqual([]);
    expect(byId(v.entries, 'cup:cup_aaaaaaaaaaaaaaaa')).toMatchObject({ name: null, cupName: 'ミドリの週末杯', link: { screen: 'cup', id: 'cup_aaaaaaaaaaaaaaaa' } });
    expect(ids(v.entries)).not.toContain('cup:cup_bbbbbbbbbbbbbbbb');
    expect(calendarView(m, veteran(), {}, NOW, { tournaments: null, cups: null }).partial).toEqual(['tournaments', 'cups']);
  });
  it('maintenance players can see (announced / running, scope groups); never unannounced or cancelled windows (§46)', () => {
    const msg = { ja: 'サーバーの点検を行います', en: 'Server check' };
    const mm = withMaint([
      { id: 'mnt_soon', startAtMs: NOW + 10 * H, endAtMs: NOW + 12 * H, scope: ['gacha', 'events'], message: msg },
      { id: 'mnt_later', startAtMs: NOW + 10 * DAY, endAtMs: NOW + 10 * DAY + 2 * H, scope: 'all', message: msg },
      { id: 'mnt_cancel', startAtMs: NOW + 5 * H, endAtMs: NOW + 6 * H, scope: 'all', message: msg, cancelledAtMs: NOW - H },
    ]);
    const v = calendarView(mm, fresh(), {}, NOW, NO_EXT);
    expect(byId(v.entries, 'mnt:mnt_soon')).toMatchObject({ kind: 'maintenance', name: msg.ja, groups: ['gacha', 'events'], status: 'upcoming' });
    expect(ids(v.entries)).not.toContain('mnt:mnt_later'); // announced 24 h before by default
    expect(ids(v.entries)).not.toContain('mnt:mnt_cancel');
  });
  it('the comeback campaign only while the player has a running window (§20)', () => {
    const s = veteran();
    expect(calendarView(m, s, {}, NOW, NO_EXT).entries.some((e) => e.kind === 'comeback')).toBe(false);
    const today = gameDayKey(NOW, dayRule(m));
    const endDay = addJstDays(today, 6);
    s.comeback = {
      lastActiveAt: NOW, lastActiveDay: today, seenUpTo: NOW, lastStartDay: today, count: 1, remind: { at: null, step: 0 },
      window: { id: 'cb_1', tier: 't1', lapseDays: 30, startDay: today, endDay, startedAt: NOW - H, endsAt: gameDayStartMs(addJstDays(endDay, 1), dayRule(m)), login: { claimed: 0, lastDay: null }, baseline: {}, missionsClaimed: [], catchUp: { seasonId: '2026-11', targetXp: 0, capXp: 0, grantedXp: 0 } },
    };
    expect(byId(calendarView(m, s, {}, NOW, NO_EXT).entries, 'comeback:cb_1')).toMatchObject({ rule: 'game_day', lastDay: endDay, link: { screen: 'comeback', id: null } });
    expect(calendarView(m, s, { from: addJstDays(endDay, 1) }, NOW + 8 * DAY, NO_EXT).entries.some((e) => e.kind === 'comeback')).toBe(false);
  });
  it('at most 200 rows', () => {
    const many = { ...m, events: Array.from({ length: 260 }, (_, i) => ({ ...m.events[0]!, id: `ev_${i}`, startAtMs: NOW + i * H, endAtMs: NOW + i * H + DAY })) };
    expect(calendarView(many, veteran(), {}, NOW, NO_EXT).entries).toHaveLength(CALENDAR_LIMITS.maxEntries);
  });
});

describe('wording and paid items (REQ-CAL-007/008/009)', () => {
  it('no shop / urgency / betting words in Japanese or English; every title has English', () => {
    expect(calendarWordingProblems()).toEqual([]);
    expect(calendarWordingProblems(['今だけ開催', '残りわずか'])).toHaveLength(2);
    const cat = catalogFor(m);
    for (const t of [...Object.values(CALENDAR_TITLES), '日本時間']) {
      const en = translateText(t, cat);
      expect(en, t).toBeTruthy();
      expect(JP.test(en!), t).toBe(false);
      expect(bettingWordsIn(en!), t).toEqual([]);
      expect(/\b(hurry|limited[- ]time|ends soon|last chance|only today)\b/i.test(en!), t).toBe(false);
    }
    expect(CODE_EN['日本時間']).toBe('JST');
    expect(Object.keys(CALENDAR_TITLES).sort()).toEqual([...CALENDAR_KINDS].sort());
    expect(Object.keys(CALENDAR_ID_PREFIX).sort()).toEqual([...CALENDAR_KINDS].sort());
  });
  it('no countdown fields: rows carry dates only', () => {
    const v = calendarView(m, veteran(), {}, NOW, NO_EXT);
    for (const e of v.entries) expect(Object.keys(e).filter((k) => /left|remaining|countdown|urgent/i.test(k)), e.id).toEqual([]);
  });
});

describe('marks (REQ-CAL-010/011)', () => {
  it('idempotent on / off, KPI only on a change, no push queued', () => {
    const s = veteran();
    const kpi: KpiEvent[] = [];
    const emit = (e: KpiEvent) => { kpi.push(e); };
    const outboxBefore = JSON.stringify(s.push ?? null);
    expect(markCalendar(m, s, 'event:sprint_cup_2026_11', true, NOW, NO_EXT, emit)).toEqual({ marked: true, id: 'event:sprint_cup_2026_11', count: 1, max: 30 });
    expect(markCalendar(m, s, 'event:sprint_cup_2026_11', true, NOW, NO_EXT, emit).count).toBe(1);
    expect(s.calendar!.marks).toEqual([{ id: 'event:sprint_cup_2026_11', kind: 'event', until: m.events[0]!.endAtMs }]);
    expect(calendarView(m, s, {}, NOW, NO_EXT).entries.find((e) => e.marked)?.id).toBe('event:sprint_cup_2026_11');
    expect(markCalendar(m, s, 'event:sprint_cup_2026_11', false, NOW, NO_EXT, emit)).toMatchObject({ marked: false, count: 0 });
    expect(markCalendar(m, s, 'event:sprint_cup_2026_11', false, NOW, NO_EXT, emit)).toMatchObject({ marked: false, count: 0 });
    expect(kpi).toEqual([{ name: 'calendar_mark', s1: 'event', s2: 'on' }, { name: 'calendar_mark', s1: 'event', s2: 'off' }]);
    expect(JSON.stringify(s.push ?? null)).toBe(outboxBefore);
  });
  it('unknown / invisible rows are 404, ended rows 409 ended, the 31st mark 409 limit; ended marks drop off', () => {
    const s = veteran();
    expect(code(() => markCalendar(m, s, 'event:nope', true, NOW, NO_EXT))).toBe('NOT_FOUND');
    expect(code(() => markCalendar(m, s, 'bad id', true, NOW, NO_EXT))).toBe('NOT_FOUND');
    expect(code(() => markCalendar(m, fresh(), 'event:sprint_cup_2026_11', true, NOW, NO_EXT))).toBe('NOT_FOUND'); // events not open yet
    expect(code(() => markCalendar(m, s, 'banner:winter_2026', true, NOW, NO_EXT))).toBe('NOT_FOUND'); // not announced
    const ended: CalendarExternal = { tournaments: [{ id: 'tour_e', name: '受付終了', status: 'scheduled', registrationOpensAtMs: NOW - 5 * H, registrationClosesAtMs: NOW - H, startsAtMs: NOW + DAY }], cups: [] };
    try { markCalendar(m, s, 'treg:tour_e', true, NOW, ended); throw new Error('no'); } catch (e) { expect((e as AppError).code).toBe('CONFLICT'); expect((e as AppError).details).toEqual({ reason: 'ended' }); }
    const cups = Array.from({ length: 31 }, (_, i) => ({ cupId: `cup_${String(i).padStart(16, 'a')}`, cupName: `杯${i}`, opensAt: NOW + H, closesAt: NOW + (i + 2) * H, status: 'open' }));
    for (let i = 0; i < 30; i++) markCalendar(m, s, `cup:${cups[i]!.cupId}`, true, NOW, { tournaments: [], cups });
    try { markCalendar(m, s, `cup:${cups[30]!.cupId}`, true, NOW, { tournaments: [], cups }); throw new Error('no'); } catch (e) { expect((e as AppError).details).toEqual({ reason: 'limit' }); }
    // three hours later the first cup windows have closed: their marks drop off and there is room again
    markCalendar(m, s, `cup:${cups[30]!.cupId}`, true, NOW + 3.5 * H, { tournaments: [], cups });
    expect(s.calendar!.marks.length).toBeLessThan(30);
    expect(s.calendar!.marks.every((x) => x.until > NOW + 3.5 * H)).toBe(true);
  });
});

describe('ops console (REQ-CAL-012)', () => {
  it('the whole calendar incl. unannounced banners and scheduled windows, and their overlaps', () => {
    const mm = withMaint([{ id: 'mnt_ev', startAtMs: Date.UTC(2026, 11, 10, 17), endAtMs: Date.UTC(2026, 11, 10, 19), scope: ['events'], message: { ja: '点検', en: 'Check' } }]);
    const v = opsCalendar(mm, { from: '2026-12-01', to: '2026-12-20' }, NOW, [{ id: 'tour_a', name: '冬の大会', status: 'scheduled', registrationOpensAtMs: Date.UTC(2026, 11, 2), registrationClosesAtMs: Date.UTC(2026, 11, 3), startsAtMs: Date.UTC(2026, 11, 4) }]);
    expect(byId(v.entries, 'banner:winter_2026')).toMatchObject({ announced: false });
    expect(byId(v.entries, 'mnt:mnt_ev')).toMatchObject({ announced: false, groups: ['events'] });
    expect(byId(v.entries, 'tgoal:2026-11-30')).toBeTruthy(); // team rows shown in the ops view
    expect(v.entries.some((e) => e.kind === 'cup' || e.kind === 'comeback')).toBe(false);
    expect(v.overlaps).toEqual(expect.arrayContaining([expect.objectContaining({ a: 'mnt:mnt_ev', b: 'event:no_whip_cup_2026_12', kind: 'maintenance_closes' })]));
    expect(v.overlaps.some((o) => o.a === 'mnt:mnt_ev' && o.b.startsWith('banner:'))).toBe(false); // gacha is not in scope
    expect(v.overlaps.some((o) => o.kind === 'same_kind')).toBe(false); // the shipped events and banners do not overlap
    const two = { ...mm, events: [...mm.events, { ...mm.events[1]!, id: 'second_cup', startAtMs: mm.events[1]!.startAtMs + DAY }] };
    expect(opsCalendar(two, { from: '2026-12-01', to: '2026-12-20' }, NOW, []).overlaps).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'same_kind', a: 'event:no_whip_cup_2026_12', b: 'event:second_cup' })]));
  });
});

describe('KPI (REQ-CAL-015) and the gate group (REQ-CAL-013)', () => {
  const kpi = (name: string, props: Record<string, unknown>) => clientBatchSchema.parse({ platform: 'ios', appVersion: '1.0.0', events: [{ name, at: NOW, props }] }).events.map(clientToKpi)[0];
  it('calendar_view / calendar_entry_open are client events; kinds equal the calendar\'s', () => {
    expect([...CALENDAR_KPI_KINDS]).toEqual([...CALENDAR_KINDS]);
    expect(kpi('calendar_view', { view: 'month', entries: 12 })).toEqual({ name: 'calendar_view', s1: 'month', value: 12 });
    expect(kpi('calendar_entry_open', { kind: 'banner' })).toEqual({ name: 'calendar_entry_open', s1: 'banner' });
    expect(() => kpi('calendar_view', { view: 'year', entries: 1 })).toThrow();
    expect(() => kpi('calendar_view', { view: 'week', entries: 201 })).toThrow();
    expect(() => kpi('calendar_entry_open', { kind: 'shop' })).toThrow();
  });
  it('/v1/calendar* is in group core: a scoped window leaves it open, `all` closes it', () => {
    for (const p of ['/v1/calendar', '/v1/calendar/marks/event:x']) expect(endpointGroup(p)).toBe('core');
    expect(isExempt('GET', '/v1/calendar')).toBe(false);
    const START = NOW + H;
    const cfg = (scope: MaintenanceConfig['windows'][number]['scope']): MaintenanceConfig => ({ ...structuredClone(DEFAULT_MAINTENANCE), windows: [{ id: 'm1', startAtMs: START, endAtMs: START + 4 * H, scope, message: { ja: 'メンテナンス中です', en: 'Under maintenance' } }] });
    const h = { platform: null, version: null, engine: null };
    expect(gateRequest(cfg(['gacha', 'events', 'tournaments', 'teams', 'cups']), 'GET', '/v1/calendar', h, START + 1)).toBeNull();
    expect(gateRequest(cfg('all'), 'GET', '/v1/calendar', h, START + 1)?.code).toBe('MAINTENANCE');
  });
});

describe('help, tips, data export, deletion (REQ-CAL-016/017)', () => {
  it('the help article and the tips card pass their checks; the tokens come from data', () => {
    expect(helpProblems(m, undefined, 6), helpProblems(m, undefined, 6).join('; ')).toEqual([]);
    expect(tipsProblems(m, undefined, 6), tipsProblems(m, undefined, 6).join('; ')).toEqual([]);
    expect(BASE_HELP.contexts.calendar).toBe('calendar');
    const a = helpArticle(m, 'calendar', 'ja', 6) as { body: string };
    expect(a.body).toContain(`${CALENDAR_LIMITS.maxRangeDays}日分`);
    expect(a.body).toContain(`${dayRule(m).hourJst}時に切り替わります`);
  });
  it('`calendar` is classified play and exported; the account wipe removes it', async () => {
    expect(classifyKey('calendar')).toEqual({ section: 'play' });
    const s = veteran();
    markCalendar(m, s, 'event:sprint_cup_2026_11', true, NOW, NO_EXT);
    const doc = buildExportDocument(m, s, { ledger: s.ledger, gacha: [], names: {}, reportsMade: [], kpiEvents: null }, 'dex_x', 'ja', NOW);
    expect(doc.unclassified).toEqual([]);
    expect((doc.play as Record<string, unknown>).calendar).toEqual({ marks: [{ id: 'event:sprint_cup_2026_11', kind: 'event', until: m.events[0]!.endAtMs }] });
    const repo = new MemoryPlayerRepo();
    const svc = new PlayerService(repo, { master: m, rng: seededRng(21), clock: () => NOW, verifiers: { fake: new FakeStoreVerifier() } });
    repo.put({ ...s, id: 'gone' });
    expect((await svc.state('gone')).calendar?.marks).toHaveLength(1);
    await svc.wipe('gone');
    expect(repo.get('gone')).toBeNull();
  });
});

describe('HTTP (REQ-CAL-004/006/009/010)', () => {
  function setup(opts: { tournaments?: 'ok' | 'fail' } = {}) {
    let now = NOW;
    const repo = new MemoryPlayerRepo();
    const kpi: KpiRecord[] = [];
    const svc = new PlayerService(repo, { master: m, rng: seededRng(21), clock: () => now, verifiers: { fake: new FakeStoreVerifier() }, onKpi: (_id, r) => { kpi.push(...r); } });
    const invoker: PlayerInvoker = { invoke: (async (method: string, ...args: unknown[]) => (svc as unknown as Record<string, (...a: unknown[]) => unknown>)[method]!.apply(svc, args)) as PlayerInvoker['invoke'] };
    const tournaments = opts.tournaments ? ({
      list: async () => { if (opts.tournaments === 'fail') throw new Error('down'); return { tournaments: [{ id: 'tour_a', name: '秋のミニ大会', status: 'registration', registrationOpensAtMs: NOW - H, registrationClosesAtMs: NOW + 2 * DAY, startsAtMs: NOW + 3 * DAY, entrants: 1, maxEntrants: 8, heatSize: 4, finishedAt: null, updatedAt: NOW }], generatedAt: NOW }; },
    } as unknown as TournamentsService) : undefined;
    const c: AppContext = {
      master: m,
      authenticate: async (req) => { const u = req.headers.get('x-test-user'); if (!u) throw new AppError('UNAUTHORIZED'); return u; },
      player: () => invoker,
      match: {} as AppContext['match'],
      friends: makeFriendsService(() => invoker, new MemoryDirectory()),
      leaderboard: { board: async () => ({ entries: [], total: 0 }), myRank: async () => ({}) },
      timeAttack: {} as AppContext['timeAttack'],
      clock: () => now,
      race: { websocket: async () => new Response(null), report: async () => ({}), replay: async (id) => ({ raceId: id }) },
      paidBalance: async () => ({}),
      adminToken: undefined,
      parseStoreNotification: async () => null,
      configInfo: async () => ({ versionId: 'base', hash: 'base', rulesetVersion: DEFAULT_RULESET.rulesetVersion, activatedAt: null }),
      ...(tournaments ? { tournaments } : {}),
    };
    const call = async (user: string, path: string, init: { method?: string } = {}) => {
      const res = await handle(new Request(`https://x${path}`, { method: init.method ?? 'GET', headers: { 'x-test-user': user, 'content-type': 'application/json' } }), {}, c);
      return { status: res.status, body: (await res.json()) as any };
    };
    const veteranize = async (u: string) => { await svc.bootstrap(u); const s = repo.get(u)!; s.createdAt = NOW - 60 * DAY; s.onboarding = { races: 200, breedings: 9, counts: {}, claimed: [] }; s.rating.rankedRaces = 80; repo.put(s); };
    return { call, repo, kpi, veteranize, setNow: (t: number) => { now = t; } };
  }

  it('GET /v1/calendar in Japanese and English (JST kept and labelled, no Japanese left but names), bad ranges 400', async () => {
    const x = setup({ tournaments: 'ok' });
    await x.veteranize('u1');
    const ja = await x.call('u1', '/v1/calendar');
    expect(ja.status).toBe(200);
    expect(ja.body).toMatchObject({ from: '2026-11-11', to: '2026-12-15', timeZone: '日本時間', partial: [] });
    expect(ja.body.entries.find((e: CalendarEntry) => e.id === 'treg:tour_a')).toBeTruthy();
    const en = await x.call('u1', '/v1/calendar?lang=en');
    expect(en.body.timeZone).toBe('JST');
    const ev = en.body.entries.find((e: CalendarEntry) => e.id === 'event:sprint_cup_2026_11');
    expect(ev.title).toBe('Event race');
    expect(ev.startJst).toBe(ja.body.entries.find((e: CalendarEntry) => e.id === 'event:sprint_cup_2026_11').startJst);
    const leftovers = en.body.entries.filter((e: CalendarEntry) => e.kind !== 'tournament' && e.kind !== 'tournament_registration' && JP.test(JSON.stringify(e)));
    expect(leftovers.map((e: CalendarEntry) => e.id)).toEqual([]);
    expect(en.body.entries.find((e: CalendarEntry) => e.id === 'season:2026-11').name).toBe('Season 11/2026');
    for (const q of ['?from=2026-11-11&to=2026-12-31', '?from=xx', '?to=2026-11-01']) expect((await x.call('u1', `/v1/calendar${q}`)).status, q).toBe(400);
  });
  it('a failing tournament index only leaves tournaments out (partial)', async () => {
    const x = setup({ tournaments: 'fail' });
    await x.veteranize('u1');
    const r = await x.call('u1', '/v1/calendar');
    expect(r.status).toBe(200);
    expect(r.body.partial).toEqual(['tournaments']);
  });
  it('PUT / DELETE /v1/calendar/marks/:entryId; the server KPI calendar_mark', async () => {
    const x = setup({ tournaments: 'ok' });
    await x.veteranize('u1');
    const put = await x.call('u1', '/v1/calendar/marks/treg:tour_a', { method: 'PUT' });
    expect(put.status).toBe(200);
    expect(put.body).toEqual({ marked: true, id: 'treg:tour_a', count: 1, max: 30 });
    expect((await x.call('u1', '/v1/calendar')).body.entries.find((e: CalendarEntry) => e.id === 'treg:tour_a').marked).toBe(true);
    expect((await x.call('u1', '/v1/calendar/marks/event:nope', { method: 'PUT' })).status).toBe(404);
    expect((await x.call('u1', '/v1/calendar/marks/Bad%20Id', { method: 'PUT' })).status).toBe(404);
    expect((await x.call('u1', '/v1/calendar/marks/treg:tour_a', { method: 'DELETE' })).body).toMatchObject({ marked: false, count: 0 });
    expect(x.kpi.filter((k) => k.name === 'calendar_mark').map((k) => k.s2)).toEqual(['on', 'off']);
  });
});
