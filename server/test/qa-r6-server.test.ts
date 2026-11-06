// Regression tests for the Round 6 server QA findings (#1–#8). Each would fail on the pre-fix code.
import { describe, expect, it } from 'vitest';
import gachaJson from '../master/gacha.json';
import { resolveBundle } from '../src/ops/config.js';
import { useTicket } from '../src/domain/itemShop.js';
import { addItems } from '../src/domain/items.js';
import { seededRng } from '../src/domain/rng.js';
import { holdPolicyProblems, replaysToDelete } from '../src/domain/retention.js';
import { MemoryPlayerRepo, PlayerService } from '../src/domain/service.js';
import { retryRolloverItem, mergeDeadLetter, normalizeDlScope, type DeadLetterRecord } from '../src/ops/deadLetter.js';
import { defaultSilks, effectiveSilks, isBannedSilks } from '../src/domain/visuals.js';
import { BASE_BANNED_SILKS, bannedMatch, type BannedSilksList } from '../src/domain/bannedSilks.js';
import { playerView } from '../src/domain/player.js';
import { publicProfile } from '../src/domain/stats.js';
import { roomsProblems } from '../src/domain/presets.js';
import { bondProblems } from '../src/domain/bond.js';
import type { PlayerState } from '../src/domain/player.js';
import type { AppError } from '../src/domain/errors.js';
import { freshPlayer, m } from './helpers.js';

const NOW = Date.UTC(2026, 10, 5, 3);
const DAY = 86_400_000;
const code = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as AppError).code; } return 'NO_ERROR'; };
type RawB = { id: string; currency: string };
const rawBanners = () => structuredClone((gachaJson as unknown as { banners: RawB[] }).banners);

describe('QA r6 #1 tickets never reach a paid-only banner', () => {
  it('remote config that makes a ticket banner paid-only is rejected', () => {
    const b = rawBanners();
    b.find((x) => x.id === 'pickup_akatsuki')!.currency = 'paidOnly';
    expect(() => resolveBundle(m, { gacha: { banners: b as never } })).toThrow(/paid-only banner pickup_akatsuki/);
  });
  it('runtime backstop: a ticket draw on a paid-only banner is refused even if the master slipped through', () => {
    const bad = { ...m, gacha: { ...m.gacha, banners: m.gacha.banners.map((x) => (x.id === 'pickup_akatsuki' ? { ...x, currency: 'paidOnly' as const } : x)) } };
    const s = freshPlayer();
    addItems(s, [{ itemId: 'gacha_ticket', qty: 1 }]);
    expect(code(() => useTicket(bad, s, 'gacha_ticket', 'pickup_akatsuki', seededRng(1), NOW, 'k'))).toBe('NOT_ELIGIBLE');
    expect(s.items.gacha_ticket).toBe(1); // nothing consumed
  });
});

describe('QA r6 #2 replay holds', () => {
  it('manual holds must stay null; expiring holds need ≥ 1 day', () => {
    expect(holdPolicyProblems({ reported: 0, desync: 0, void: 0, disputed: 0, verified: 0 }).length).toBe(5);
    expect(holdPolicyProblems({ verified: 90, reported: null })).toEqual([]);
    expect(() => resolveBundle(m, { progression: { replayHoldDays: { reported: 0, verified: 90 } } as never })).toThrow(/replayHoldDays.reported/);
  });
  it('manual holds are never auto-deleted and a held replay never goes earlier than retention', () => {
    const old = NOW - 200 * DAY;
    const objs = ['reported', 'desync', 'void', 'disputed'].map((h) => ({ key: `replays/${h}.json`, uploaded: old, hold: h }));
    expect(replaysToDelete(objs, NOW, 30, { reported: 0, desync: 0, void: 0, disputed: 0 } as never)).toEqual([]);
    const verified = { key: 'replays/v.json', uploaded: NOW - 120 * DAY, hold: 'verified' };
    expect(replaysToDelete([verified], NOW, 180, { verified: 90 })).toEqual([]); // retention 180 > hold 90
    expect(replaysToDelete([verified], NOW, 30, { verified: 90 })).toEqual(['replays/v.json']);
  });
});

describe('QA r6 #3 a race result is never applied twice', () => {
  const res = { raceId: 'r_dl', mode: 'ranked' as const, place: 1, fieldSize: 12, newRating: null, void: false, humans: 2 };
  it('re-applying after the idempotency ring evicted the race key is a no-op', async () => {
    const repo = new MemoryPlayerRepo();
    const svc = new PlayerService(repo, { master: m, rng: seededRng(3), clock: () => NOW, verifiers: {} });
    await svc.bootstrap('p1');
    await svc.applyRace('p1', res);
    const after1 = structuredClone((await repo.get('p1')) as PlayerState);
    const s = (await repo.get('p1')) as PlayerState;
    s.idem = []; // simulate ≥ 200 later keyed calls pushing race:r_dl out of the ring
    await repo.put(s);
    const again = await svc.applyRace('p1', res);
    expect(again).toMatchObject({ duplicate: true });
    const after2 = (await repo.get('p1')) as PlayerState;
    expect(after2.wallet.free).toBe(after1.wallet.free);
    expect(after2.season.points).toBe(after1.season.points);
    expect(after2.season.races).toBe(after1.season.races);
  });
  it('an event board outage does not fail an applied result; the update is re-sent with the next race', async () => {
    const sprint = m.events.find((e) => e.id === 'sprint_cup_2026_11')!;
    const sent: string[] = [];
    let down = true;
    const repo = new MemoryPlayerRepo();
    const svc = new PlayerService(repo, {
      master: m, rng: seededRng(3), clock: () => NOW, verifiers: {},
      onEventEntry: (e) => { if (down) throw new Error('EventDO down'); sent.push(`${e.eventId}:${e.races}`); },
    });
    await svc.bootstrap('p1');
    const ev = { raceId: 'r_ev1', mode: 'event' as const, eventId: sprint.id, place: 2, fieldSize: 12, newRating: null, void: false, humans: 2 };
    await expect(svc.applyRace('p1', ev)).resolves.toBeTruthy();
    expect(((await repo.get('p1')) as PlayerState).pendingEventPushes?.[sprint.id]).toBeTruthy();
    down = false;
    await svc.applyRace('p1', { ...ev, raceId: 'r_ev2' });
    expect(sent).toContain(`${sprint.id}:1`);
    expect(((await repo.get('p1')) as PlayerState).pendingEventPushes?.[sprint.id]).toBeUndefined();
  });
});

describe('QA r6 #4 dead-letter retry keeps concurrent rollover progress', () => {
  it('re-reads the owner state after the awaited call and changes only the retried item', async () => {
    const before = { cursor: 'p100', deadLetter: [{ id: 'pA', error: 'x', attempts: 5 }] } as never;
    let stored: Record<string, unknown> = before;
    const out = await retryRolloverItem(before, 'pA', async () => {
      // the cron advanced and dead-lettered pB while we were awaiting
      stored = { cursor: 'p900', deadLetter: [{ id: 'pA', error: 'x', attempts: 5 }, { id: 'pB', error: 'y', attempts: 5 }] };
    }, () => stored as never);
    expect(out.outcome.ok).toBe(true);
    expect((out.st as unknown as { cursor: string }).cursor).toBe('p900');
    expect(out.st.deadLetter!.map((d) => d.id)).toEqual(['pB']);
  });
});

describe('QA r6 #5 generated silks respect the active banned list', () => {
  it('defaults, player view and public profile avoid an imported banned design', () => {
    const s = freshPlayer('victim');
    const def = defaultSilks(`p:${s.id}`);
    const list: BannedSilksList = { ...BASE_BANNED_SILKS, entries: [{ id: 'real1', source: 'test', pattern: def.pattern, colors: def.colors }] };
    expect(isBannedSilks(def, undefined, list)).toBe(true);
    expect(isBannedSilks(defaultSilks(`p:${s.id}`, undefined, list), undefined, list)).toBe(false);
    s.profile.silks = def; // stored before the import
    expect(isBannedSilks(playerView(s, list).profile.silks!, undefined, list)).toBe(false);
    expect(isBannedSilks(publicProfile(s, list).silks!, undefined, list)).toBe(false);
    expect(effectiveSilks(def, 'x')).toEqual(def); // unchanged when not banned
  });
});

describe('QA r6 #6 moderation dead letters in the ops index', () => {
  const rec = (over: Partial<DeadLetterRecord> = {}): DeadLetterRecord => ({ itemId: 'p1', error: 'push failed', attempts: 5, source: 'moderation', scope: 'whatever', status: 'open', firstSeenAt: 1, updatedAt: 1, ...over });
  it('moderation rows are always scoped global', () => {
    expect(normalizeDlScope('moderation', 'x')).toBe('global');
    expect(normalizeDlScope('season', '2026-10')).toBe('2026-10');
    expect(mergeDeadLetter(null, rec())!.scope).toBe('global');
  });
  it('a newer failure reopens a resolved/dismissed row; a stale re-report does not', () => {
    const resolved = { ...rec({ scope: 'global' }), status: 'dismissed' as const, updatedAt: 100, resolvedBy: 'ops' };
    expect(mergeDeadLetter(resolved, rec({ updatedAt: 50 }))).toBeNull();
    const re = mergeDeadLetter(resolved, rec({ updatedAt: 200 }))!;
    expect(re.status).toBe('open');
    expect(re.resolvedBy).toBeUndefined();
  });
});

describe('QA r6 #7 symmetric silks patterns match both colour orders', () => {
  it('quartered navy/white is caught by an entry quartered white/navy; sash stays order-sensitive', () => {
    const list: BannedSilksList = { ...BASE_BANNED_SILKS, entries: [{ id: 'q', source: 'test', pattern: 'quartered', colors: ['white', 'navy'] }] };
    expect(bannedMatch(list, { pattern: 'quartered', colors: ['navy', 'white'], cap: 'plain' })).not.toBeNull();
    const sash: BannedSilksList = { ...BASE_BANNED_SILKS, entries: [{ id: 's', source: 'test', pattern: 'sash', colors: ['white', 'navy'] }] };
    expect(bannedMatch(sash, { pattern: 'sash', colors: ['navy', 'white'], cap: 'plain' })).toBeNull();
  });
});

describe('QA r6 #8 rooms weather and bond rewards are validated', () => {
  it('unknown weather is rejected', () => {
    const rooms = structuredClone(m.progression.rooms);
    rooms.weather = [...rooms.weather, 'snow'];
    expect(roomsProblems(rooms).join()).toMatch(/unknown weather snow/);
  });
  it('a paid-only cosmetic or unknown item cannot be a free bond reward', () => {
    const paidOnly = m.items.cosmetics.find((c) => c.currency === 'paidOnly')!;
    const bond = structuredClone(m.progression.bond);
    bond.levelRewards = [{ level: 2, reward: { items: [{ itemId: paidOnly.id, qty: 1 }, { itemId: 'nope_item', qty: 1 }] } }];
    expect(() => resolveBundle(m, { progression: { bond } as never })).toThrow(new RegExp(`${paidOnly.id} is paid-only`));
    expect(bondProblems(bond, new Set(['x']), new Set([paidOnly.id])).join()).toMatch(/unknown item nope_item/);
  });
});
