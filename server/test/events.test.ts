import { describe, expect, it } from 'vitest';
import { MemoryPlayerRepo, PlayerService } from '../src/domain/service.js';
import { seededRng } from '../src/domain/rng.js';
import { AppError } from '../src/domain/errors.js';
import {
  applyEventResult, buildEventBoard, cancelEntry, closeEventForPlayer, enterEvent, EVENT_SETTLE_GRACE_MS, eventCronPlan, eventProblems,
  eventRuleset, STALE_ENTRY_MS, START_NOTICE_WINDOW_MS, type EventEntry,
} from '../src/domain/events.js';
import { EventsService, type EventPlayers } from '../src/domain/eventService.js';
import { EventPools } from '../src/domain/matchmaker.js';
import { createRace } from '../src/race/orchestrate.js';
import { DEFAULT_RULESET } from '../src/domain/ruleset.js';
import { grantFree, grantPaid } from '../src/domain/wallet.js';
import { createHorseFromTemplate } from '../src/domain/horses.js';
import { resolveBundle } from '../src/ops/config.js';
import { runScheduled, CRONS } from '../src/domain/scheduled.js';
import type { EventDef } from '../src/domain/master.js';
import type { PlayerState } from '../src/domain/player.js';
import type { RaceEntry } from '../src/http/app.js';
import { freshPlayer, m } from './helpers.js';

const NOW = Date.UTC(2026, 10, 5, 3); // inside sprint_cup_2026_11
const sprint = m.events.find((e) => e.id === 'sprint_cup_2026_11')!;
const noWhip = m.events.find((e) => e.id === 'no_whip_cup_2026_12')!;
const code = (f: () => unknown) => { try { f(); return 'ok'; } catch (e) { return (e as AppError).code; } };
const acode = async (p: Promise<unknown>) => { try { await p; return 'ok'; } catch (e) { return (e as AppError).code; } };

function withHorse(s: PlayerState, i = 0) {
  return createHorseFromTemplate(s, m.templates[i]!, NOW);
}

describe('event definitions (REQ-EVENT-001/003)', () => {
  it('master events are valid', () => {
    expect(eventProblems(m, m.events)).toEqual([]);
  });

  it('rejects bad tracks, protected/unknown ruleset keys, paid-coin fees and bad milestones', () => {
    const bad = (patch: Omit<Partial<EventDef>, 'rules'> & { rules?: Partial<EventDef['rules']> }) =>
      eventProblems(m, [{ ...sprint, ...patch, rules: { ...sprint.rules, ...(patch.rules ?? {}) } } as EventDef]).join(' | ');
    expect(bad({ trackIds: ['nope'] })).toMatch(/unknown track/);
    expect(bad({ rules: { rulesetOverrides: { rulesetVersion: 9 } as never } })).toMatch(/not allowed/);
    expect(bad({ rules: { rulesetOverrides: { notAKey: 1 } } })).toMatch(/unknown ruleset key/);
    expect(bad({ fee: { kind: 'paid', paidCoins: 10 } as never })).toMatch(/never paid coins/);
    expect(bad({ milestones: [{ points: 100, reward: {} }, { points: 50, reward: {} }] })).toMatch(/ascending/);
    expect(bad({ startAtMs: 10, endAtMs: 5 })).toMatch(/before/);
    expect(eventProblems(m, [sprint, sprint]).join()).toMatch(/duplicate/);
  });

  it('event ruleset keeps the key set and suffixes the version', () => {
    expect(eventRuleset(DEFAULT_RULESET, sprint)).toBe(DEFAULT_RULESET); // no overrides → same rules
    const r = eventRuleset(DEFAULT_RULESET, noWhip);
    expect(r.maxWhips).toBe(0);
    expect(r.rulesetVersion).toBe(`${DEFAULT_RULESET.rulesetVersion}+ev.no_whip_cup_2026_12`);
    expect(Object.keys(r).sort()).toEqual(Object.keys(DEFAULT_RULESET).sort());
  });

  it('remote config can replace events and validates them', () => {
    expect(resolveBundle(m, { events: [noWhip] as never }).master.events.map((e) => e.id)).toEqual(['no_whip_cup_2026_12']);
    expect(() => resolveBundle(m, { events: [{ ...sprint, trackIds: ['nope'] }] as never })).toThrow(/unknown track/);
  });
});

describe('entry and fees (REQ-EVENT-002/004)', () => {
  it('free-coin fees are taken from free coins only and held until the race', () => {
    const s = freshPlayer();
    const h = withHorse(s);
    grantPaid(s, 500, 800, NOW, 'buy', 'tx1');
    expect(code(() => enterEvent(sprint, s, h, 'e1', NOW))).toBe('INSUFFICIENT_COINS'); // paid coins never pay entry fees
    grantFree(s, 40, NOW, 'gift', 'g');
    const r = enterEvent(sprint, s, h, 'e1', NOW);
    expect(r.existing).toBe(false);
    expect(s.wallet).toMatchObject({ free: 10, paid: 500 });
    expect(enterEvent(sprint, s, h, 'e2', NOW).existing).toBe(true); // one held entry at a time
    expect(cancelEntry(s, sprint.id, 'e1', NOW).refunded).toBe(true);
    expect(s.wallet.free).toBe(40);
    expect(cancelEntry(s, sprint.id, 'e1', NOW).refunded).toBe(false);
  });

  it('a stale held fee is refunded before a new entry', () => {
    const s = freshPlayer();
    const h = withHorse(s);
    grantFree(s, 30, NOW, 'gift', 'g');
    enterEvent(sprint, s, h, 'e1', NOW);
    expect(s.wallet.free).toBe(0);
    const r = enterEvent(sprint, s, h, 'e2', NOW + STALE_ENTRY_MS);
    expect(r).toMatchObject({ entryId: 'e2', existing: false });
    expect(s.wallet.free).toBe(0); // refunded 30, charged 30 again
  });

  it('eligibility: period, class, ranked races, style; item fees', () => {
    const during = noWhip.startAtMs + 1000;
    const s = freshPlayer('p', during);
    const h = withHorse(s);
    expect(code(() => enterEvent(noWhip, s, h, 'e', NOW))).toBe('EVENT_CLOSED');
    expect(code(() => enterEvent(noWhip, s, h, 'e', during))).toBe('NOT_ELIGIBLE');
    s.season.classId = 'B';
    s.rating.rankedRaces = noWhip.entry.minRankedRaces;
    expect(code(() => enterEvent(noWhip, s, h, 'e', during))).toBe('INSUFFICIENT_ITEMS');
    s.items.event_ticket = 1;
    enterEvent(noWhip, s, h, 'e', during);
    expect(s.items.event_ticket).toBeUndefined();
    cancelEntry(s, noWhip.id, null, during);
    expect(s.items.event_ticket).toBe(1);
    const styled = { ...sprint, entry: { ...sprint.entry, styles: ['nige' as const] } };
    const h2 = { ...h, style: 'oikomi' as const };
    grantFree(s, 100, NOW, 'g', 'g');
    expect(code(() => enterEvent(styled, s, h2, 'e', NOW))).toBe('NOT_ELIGIBLE');
  });
});

describe('results and rewards (REQ-EVENT-005/008)', () => {
  it('points by place + participation, milestones paid once, void refunds', () => {
    const s = freshPlayer();
    const h = withHorse(s);
    grantFree(s, 300, NOW, 'g', 'g');
    enterEvent(sprint, s, h, 'e1', NOW);
    const r1 = applyEventResult(sprint, s, { raceId: 'r1', place: 1, void: false }, NOW);
    expect(r1.gained).toBe(sprint.points.byPlace[0]! + sprint.points.participation);
    expect(s.events![sprint.id]!.pending).toBeNull();
    for (let i = 0; i < 2; i++) applyEventResult(sprint, s, { raceId: `r${i + 2}`, place: 1, void: false }, NOW);
    expect(s.events![sprint.id]!.milestones).toEqual([300]);
    const free = s.wallet.free;
    applyEventResult(sprint, s, { raceId: 'r9', place: 1, void: false }, NOW);
    expect(s.wallet.free).toBe(free); // 300pt milestone not paid again
    enterEvent(sprint, s, h, 'e2', NOW);
    const v = applyEventResult(sprint, s, { raceId: 'rv', place: 0, void: true }, NOW);
    expect(v.refunded).toBe(true);
    expect(s.events![sprint.id]!.races).toBe(4);
  });

  it('final rank reward once; players who never raced get nothing; a held fee is returned', () => {
    const s = freshPlayer();
    grantFree(s, 30, NOW, 'g', 'g');
    enterEvent(sprint, s, withHorse(s), 'e', NOW);
    expect(closeEventForPlayer(sprint, s, null, sprint.endAtMs).reward).toBeNull();
    expect(s.wallet.free).toBe(30);
    const s2 = freshPlayer('p2');
    applyEventResult(sprint, s2, { raceId: 'r', place: 3, void: false }, NOW);
    expect(closeEventForPlayer(sprint, s2, 1, sprint.endAtMs).reward).toEqual(sprint.rankRewards[0]!.reward);
    expect(closeEventForPlayer(sprint, s2, 1, sprint.endAtMs).status).toBe('already');
  });

  it('board order: points, wins, earlier', () => {
    const e = (playerId: string, points: number, wins = 0, updatedAt = 1): EventEntry => ({ playerId, eventId: 'x', points, races: 1, wins, displayName: playerId, updatedAt });
    const b = buildEventBoard('x', [e('a', 100), e('b', 120), e('c', 100, 1), e('d', 100, 1, 0), { ...e('z', 0), races: 0 }], 9, 10);
    expect(b.file.entries.map((r) => r.playerId)).toEqual(['b', 'd', 'c', 'a']);
    expect(b.ranks.get('z')).toBeUndefined();
  });

  it('applyRace (mode event) is idempotent per race and reports the standing', async () => {
    const entries: EventEntry[] = [];
    const repo = new MemoryPlayerRepo();
    const svc = new PlayerService(repo, { master: m, rng: seededRng(3), clock: () => NOW, verifiers: {}, onEventEntry: (e) => { entries.push(e); } });
    await svc.bootstrap('p1');
    const res = { raceId: 'r1', mode: 'event' as const, eventId: sprint.id, place: 2, fieldSize: 12, newRating: null, void: false, humans: 2 };
    const a = await svc.applyRace('p1', res);
    const b = await svc.applyRace('p1', res);
    expect(a.event?.total).toBe(sprint.points.byPlace[1]! + sprint.points.participation);
    expect(b.event?.total).toBe(a.event?.total);
    expect(((await repo.get('p1')) as PlayerState).events![sprint.id]!.races).toBe(1);
    expect(entries.at(-1)).toMatchObject({ playerId: 'p1', eventId: sprint.id, races: 1 });
  });
});

describe('event service (REQ-EVENT-002/004)', () => {
  function setup(matchFails: string | null) {
    const repo = new MemoryPlayerRepo();
    const svc = new PlayerService(repo, { master: m, rng: seededRng(4), clock: () => NOW, verifiers: {} });
    const queued: string[] = [];
    const players: EventPlayers = {
      raceEntry: (u, h) => svc.raceEntry(u, h), enter: (u, e, h, k) => svc.eventEnter(u, e, h, k),
      cancel: (u, e, id) => svc.eventCancel(u, e, id), view: (u) => svc.eventsView(u),
    };
    const es = new EventsService(() => m, players, {
      enqueue: async (_e, u) => { if (matchFails) throw new AppError(matchFails as never); queued.push(u); return { state: 'queued' }; },
      cancel: async () => ({ state: 'none' }),
    }, { board: async () => ({}), rankOf: async () => null }, () => NOW);
    return { repo, svc, es, queued };
  }
  async function playerWithHorse(repo: MemoryPlayerRepo, svc: PlayerService) {
    await svc.bootstrap('p1');
    const s = (await repo.get('p1')) as PlayerState;
    const h = withHorse(s);
    grantFree(s, 100, NOW, 'g', 'g');
    repo.put(s);
    return h.id;
  }

  it('queues after taking the fee; a refused queue entry refunds it', async () => {
    const ok = setup(null);
    const hid = await playerWithHorse(ok.repo, ok.svc);
    const r = await ok.es.enqueue('p1', sprint.id, hid, 'c:k1');
    expect(r).toMatchObject({ state: 'queued', eventId: sprint.id });
    expect(((await ok.repo.get('p1')) as PlayerState).wallet.free).toBe(70);
    expect((await ok.es.cancel('p1', sprint.id)).refunded).toBe(true);
    expect(((await ok.repo.get('p1')) as PlayerState).wallet.free).toBe(100);

    const bad = setup('ALREADY_IN_RACE');
    const hid2 = await playerWithHorse(bad.repo, bad.svc);
    expect(await acode(bad.es.enqueue('p1', sprint.id, hid2, 'c:k1'))).toBe('ALREADY_IN_RACE');
    expect(((await bad.repo.get('p1')) as PlayerState).wallet.free).toBe(100);
    expect(((await bad.repo.get('p1')) as PlayerState).events![sprint.id]!.pending).toBeNull();
  });

  it('lists events with eligibility', async () => {
    const { svc } = setup(null);
    const list = (await svc.eventsView('p1')) as { id: string; status: string; eligible: boolean; notEligibleReasons: string[] }[];
    expect(list.find((e) => e.id === sprint.id)).toMatchObject({ status: 'open', eligible: true });
    expect(list.find((e) => e.id === noWhip.id)).toMatchObject({ status: 'upcoming', eligible: false });
  });
});

describe('event races (REQ-EVENT-003/006)', () => {
  it('createRace applies the event tracks, fixed stats to every entrant and the event ruleset', async () => {
    const s = freshPlayer();
    const horse = { id: 'h1', name: 'テスト', speed: 900, stamina: 900, burst: 900, guts: 900, temper: 900, style: 'sashi' as const, distMinM: 1600, distMaxM: 2400, surface: 'turf' as const };
    const entry = { playerId: s.id, horse, rating: { r: 1500, rd: 300, vol: 0.06 }, statCap: 3200, classId: 'C', beginner: false, moderation: 'ok' } as unknown as RaceEntry;
    const c = await createRace(m, { mode: 'event', event: noWhip, humans: [entry], cpuCount: 11, cpuLevel: 4, rng: seededRng(8), now: NOW, ticketSecret: 's', ruleset: DEFAULT_RULESET });
    expect(c.config.mode).toBe('event');
    expect(noWhip.trackIds).toContain(c.config.track.id);
    expect(c.config.ruleset.maxWhips).toBe(0);
    expect(c.config.ruleset.rulesetVersion).toContain('+ev.no_whip_cup_2026_12');
    for (const e of c.config.entrants) expect([e.horse.speed, e.horse.stamina, e.horse.burst, e.horse.guts, e.horse.temper]).toEqual([700, 700, 700, 700, 700]);
    const capped = await createRace(m, { mode: 'event', event: sprint, humans: [entry], cpuCount: 3, cpuLevel: 3, rng: seededRng(8), now: NOW, ticketSecret: 's' });
    const me = capped.config.entrants.find((e) => e.playerId === s.id)!;
    expect(me.horse.speed + me.horse.stamina + me.horse.burst + me.horse.guts + me.horse.temper).toBeLessThanOrEqual(sprint.rules.statCap!);
  });

  it('event pools are separate per event and dropped when the event is over', () => {
    const pools = new EventPools<string>();
    const q = (playerId: string, at = NOW) => ({ playerId, rating: 1500, beginner: false, enqueuedAt: at, payload: playerId });
    pools.enqueue(sprint, q('a'), NOW);
    expect(pools.enqueue(sprint, q('a'), NOW)).toBe('already'); // retry for the same event is idempotent
    const otherOpen = { ...noWhip, id: 'other_open', startAtMs: sprint.startAtMs, endAtMs: sprint.endAtMs };
    expect(code(() => pools.enqueue(otherOpen, q('a'), NOW))).toBe('ALREADY_QUEUED');
    expect(pools.cancel(sprint.id, 'nobody')).toBe(false);
    expect(() => pools.enqueue(noWhip, q('b'), NOW)).toThrow(/EVENT_CLOSED/);
    expect(pools.eventOf('a')).toBe(sprint.id);
    const matches = pools.tick(NOW + sprint.rules.cpuFillAfterMs, m.events);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.match.cpuCount).toBe(sprint.rules.maxPlayers - 1);
    pools.enqueue(sprint, q('c'), NOW);
    expect(pools.tick(sprint.endAtMs, m.events)).toEqual([]);
    expect(pools.size).toBe(0);
    const restored = EventPools.fromJSON<string>({ [sprint.id]: [q('d')] }, m.events);
    expect(restored.has('d')).toBe(true);
  });
});

describe('cron (REQ-EVENT-007..009, REQ-TEAM-008)', () => {
  it('plans snapshots during the event, one start window and closing after the grace period', () => {
    const at = (t: number) => eventCronPlan([sprint], t)[0];
    expect(at(sprint.startAtMs - 1)).toBeUndefined();
    expect(at(sprint.startAtMs)).toMatchObject({ snapshot: true, notifyStart: true, close: false });
    expect(at(sprint.startAtMs + START_NOTICE_WINDOW_MS)).toMatchObject({ snapshot: true, notifyStart: false });
    expect(at(sprint.endAtMs)).toMatchObject({ snapshot: true, close: false });
    expect(at(sprint.endAtMs + EVENT_SETTLE_GRACE_MS)).toMatchObject({ snapshot: false, close: true });
    expect(at(sprint.endAtMs + EVENT_SETTLE_GRACE_MS + 8 * 24 * 3600_000)).toBeUndefined();
  });

  it('the 5-minute cron also advances team rewards and events', async () => {
    const calls: string[] = [];
    const done = await runScheduled(CRONS.frequent, NOW, {
      snapshot: async () => { calls.push('snap'); }, rolloverStep: async () => ({ status: 'open' }), sweepReplays: async () => ({ deleted: 0 }),
      teamRolloverStep: async (s) => { calls.push(`team:${s}`); return { status: 'open' }; },
      eventsStep: async () => ['eventStart:x'],
    });
    expect(calls).toEqual(['snap', 'team:2026-10', 'team:2026-09', 'team:2026-08']);
    expect(done).toContain('eventStart:x');
  });
});
