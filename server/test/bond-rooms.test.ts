import { describe, expect, it } from 'vitest';
import { handle, makeFriendsService, type AppContext, type PlayerInvoker } from '../src/http/app.js';
import { MemoryDirectory } from '../src/domain/friends.js';
import { MemoryPlayerRepo, PlayerService } from '../src/domain/service.js';
import { seededRng } from '../src/domain/rng.js';
import { AppError } from '../src/domain/errors.js';
import { createRace } from '../src/race/orchestrate.js';
import { bondLevelOf, bondProblems, friendRoomBondPermille } from '../src/domain/bond.js';
import { goingForSurface, roomsProblems, type RoomConditions } from '../src/domain/presets.js';
import type { Master } from '../src/domain/master.js';
import { m } from './helpers.js';

const H = 3600_000;
const T0 = Date.UTC(2026, 10, 5, 3); // 12:00 JST

function setup(master: Master = m) {
  let now = T0;
  const svc = new PlayerService(new MemoryPlayerRepo(), { master, rng: seededRng(7), clock: () => now, verifiers: {} });
  return { svc, at: (t: number) => { now = t; }, now: () => now };
}

async function horseOf(svc: PlayerService, id = 'p1') {
  await svc.bootstrap(id);
  const d = await svc.tutorialDraw(id, 'c:/t:tut');
  return d.results.find((r: { horseId: string | null }) => r.horseId)!.horseId as string;
}

describe('bond / stable care (REQ-BOND-*)', () => {
  it('levels from points; config validation', () => {
    const cfg = m.progression.bond;
    expect(bondLevelOf(cfg, 0)).toBe(1);
    expect(bondLevelOf(cfg, cfg.levels[1]!)).toBe(2);
    expect(bondLevelOf(cfg, 999_999)).toBe(cfg.levels.length);
    expect(bondProblems(cfg)).toEqual([]);
    expect(bondProblems({ ...cfg, levels: [5, 1] })).not.toEqual([]);
    expect(bondProblems({ ...cfg, friendRoomEffect: { enabled: true, permillePerLevel: 1, maxPermille: 500 } })).not.toEqual([]);
    expect(roomsProblems(m.progression.rooms)).toEqual([]);
  });

  it('care: cooldown per action, daily cap per horse, points and view', async () => {
    const { svc, at } = setup();
    const h = await horseOf(svc);
    const r1 = await svc.care('p1', h, 'grain_apple', 'c:/care:1');
    expect(r1.gained).toBe(m.progression.bond.actions.grain_apple!.points);
    expect(r1.bond.focus).toBe('balanced');
    await expect(svc.care('p1', h, 'grain_apple', 'c:/care:2')).rejects.toMatchObject({ code: 'COOLDOWN' });
    await expect(svc.care('p1', h, 'nope', 'c:/care:3')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    // same idempotency key returns the stored result without caring twice
    const again = await svc.care('p1', h, 'grain_apple', 'c:/care:1');
    expect(again.bond.points).toBe(r1.bond.points);
    // daily cap: 4 actions per horse per JST day
    await svc.care('p1', h, 'hay_carrot', 'c:/care:4');
    await svc.care('p1', h, 'fresh_water', 'c:/care:5');
    at(T0 + 3 * H + 1);
    await svc.care('p1', h, 'fresh_water', 'c:/care:6');
    at(T0 + 6 * H + 1);
    await expect(svc.care('p1', h, 'grain_apple', 'c:/care:7')).rejects.toMatchObject({ code: 'COOLDOWN', message: expect.stringMatching(/daily/) });
    // next JST day resets the cap
    at(T0 + 24 * H);
    const next = await svc.care('p1', h, 'grain_apple', 'c:/care:8');
    expect(next.bond.todayActions).toBe(1);
    const v = await svc.bond('p1', h);
    expect(v.affectsRankedStats).toBe(false);
    expect(v.actions.map((a) => a.id).sort()).toEqual(Object.keys(m.progression.bond.actions).sort());
  });

  it('level rewards are paid once per player (not per horse), titles unlock', async () => {
    const { svc, at } = setup();
    const h = await horseOf(svc);
    const st0 = await svc.state('p1');
    const other = st0.horses.find((x) => x.id !== h)!.id;
    let t = T0;
    let k = 0;
    const careUntil = async (horse: string, level: number) => {
      for (;;) {
        const v = await svc.bond('p1', horse);
        if (v.level >= level) return;
        const a = v.actions.find((x) => x.ready);
        if (a) { await svc.care('p1', horse, a.id, `c:/care:${k++}`); continue; }
        t += H; at(t);
      }
    };
    const free0 = (await svc.state('p1')).wallet.free;
    await careUntil(h, 3);
    const s1 = await svc.state('p1');
    const lv2 = m.progression.bond.levelRewards.find((r) => r.level === 2)!.reward.freeCoins!;
    expect(s1.wallet.free - free0).toBe(lv2);
    expect(s1.titles).toContain('bond_first');
    // a second horse reaching the same levels pays nothing more
    await careUntil(other, 3);
    expect((await svc.state('p1')).wallet.free).toBe(s1.wallet.free);
  });

  it('bond never changes race stats in ranked / event / time attack configs (REQ-BOND-005)', async () => {
    const { svc, at } = setup();
    const h = await horseOf(svc);
    const before = await svc.raceEntry('p1', h);
    let t = T0;
    for (let i = 0; i < 40; i++) {
      const v = await svc.bond('p1', h);
      const a = v.actions.find((x) => x.ready);
      if (a) await svc.care('p1', h, a.id, `c:/care:s${i}`);
      t += 4 * H; at(t);
    }
    const after = await svc.raceEntry('p1', h);
    expect((await svc.bond('p1', h)).level).toBeGreaterThan(1);
    expect(after.horse).toEqual(before.horse);
    for (const mode of ['ranked', 'event', 'tutorial'] as const) {
      const a = await createRace(m, { mode, humans: [before], cpuCount: 3, cpuLevel: 3, rng: seededRng(5), now: T0, ticketSecret: 's' });
      const b = await createRace(m, { mode, humans: [after], cpuCount: 3, cpuLevel: 3, rng: seededRng(5), now: T0, ticketSecret: 's' });
      expect(b.config).toEqual(a.config);
    }
    // friend room: identical while the effect is off (default)
    const fa = await createRace(m, { mode: 'friend', humans: [before], cpuCount: 0, cpuLevel: 3, rng: seededRng(6), now: T0, ticketSecret: 's' });
    const fb = await createRace(m, { mode: 'friend', humans: [after], cpuCount: 0, cpuLevel: 3, rng: seededRng(6), now: T0, ticketSecret: 's' });
    expect(fb.config).toEqual(fa.config);
    expect(fb.visuals.entrants[0]!.bondLevel).toBeGreaterThan(1);
    // friend room with the effect explicitly enabled: tiny, capped bump; ranked still unaffected
    const on: Master = { ...m, progression: { ...m.progression, bond: { ...m.progression.bond, friendRoomEffect: { enabled: true, permillePerLevel: 1, maxPermille: 5 } } } };
    const pm = friendRoomBondPermille(on.progression.bond, after.visual!.bondLevel!);
    expect(pm).toBeGreaterThan(0);
    expect(pm).toBeLessThanOrEqual(5);
    const fe = await createRace(on, { mode: 'friend', humans: [after], cpuCount: 0, cpuLevel: 3, rng: seededRng(6), now: T0, ticketSecret: 's' });
    expect(fe.config.entrants[0]!.horse.speed).toBe(Math.min(1000, Math.floor((after.horse.speed * (1000 + pm)) / 1000)));
    const re = await createRace(on, { mode: 'ranked', humans: [after], cpuCount: 3, cpuLevel: 3, rng: seededRng(5), now: T0, ticketSecret: 's' });
    const ra = await createRace(m, { mode: 'ranked', humans: [before], cpuCount: 3, cpuLevel: 3, rng: seededRng(5), now: T0, ticketSecret: 's' });
    expect(re.config).toEqual(ra.config);
  });
});

describe('presets: course look and private-room conditions (REQ-ROOM-*)', () => {
  const base: RoomConditions = { trackId: null, going: null, night: null, weather: 'sunny', temperatureC: 18, windKmh: 0 };

  it('course looks: default always, others need their unlock item', async () => {
    const { svc } = setup();
    await svc.bootstrap('p1');
    expect((await svc.presets('p1')).ownedCourseLooks).toEqual(['greenfield']);
    await expect(svc.setCourseLook('p1', 'spring_meadow')).rejects.toMatchObject({ code: 'NOT_ELIGIBLE' });
    await expect(svc.setCourseLook('p1', 'nope')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const v = await svc.setCourseLook('p1', 'greenfield');
    expect(v).toMatchObject({ courseLook: 'greenfield', courseLookKey: 'scene/look/greenfield' });
    // owning the unlock item makes it equippable
    await svc.tx('p1', null, (s) => { s.items.course_spring_meadow = 1; });
    expect((await svc.setCourseLook('p1', 'spring_meadow')).courseLookKey).toBe('scene/look/spring_meadow');
    expect((await svc.setCourseLook('p1', null)).courseLook).toBeNull();
  });

  it('room conditions are validated per surface, lights and option lists', async () => {
    const { svc } = setup();
    await svc.bootstrap('p1');
    await expect(svc.setRoomConditions('p1', { ...base, trackId: 'aoba_dirt_1400', going: 'soft' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(svc.setRoomConditions('p1', { ...base, trackId: 'nope' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const unlit = m.tracks.find((t) => !m.litTracks.has(t.id))!;
    await expect(svc.setRoomConditions('p1', { ...base, trackId: unlit.id, night: true })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(svc.setRoomConditions('p1', { ...base, weather: 'snow' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(svc.setRoomConditions('p1', { ...base, temperatureC: 99 })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    const ok = await svc.setRoomConditions('p1', { ...base, trackId: 'aoba_dirt_1400', going: 'sloppy', weather: 'rain', windKmh: 10 });
    expect(ok.room).toMatchObject({ trackId: 'aoba_dirt_1400', going: 'sloppy', weather: 'rain' });
    expect((await svc.setRoomConditions('p1', null)).room).toBeNull();
    expect(goingForSurface('soft', 'dirt')).toBe('sloppy');
    expect(goingForSurface('muddy', 'turf')).toBe('yielding');
    expect(goingForSurface('good', 'dirt')).toBe('good');
  });

  it('friend rooms honour the host conditions; rooms without conditions are unchanged', async () => {
    const { svc } = setup();
    const h = await horseOf(svc);
    const plain = await svc.raceEntry('p1', h);
    expect(plain.roomPreset).toBeNull();
    const a = await createRace(m, { mode: 'friend', humans: [plain], cpuCount: 0, cpuLevel: 3, rng: seededRng(9), now: T0, ticketSecret: 's' });
    const b = await createRace(m, { mode: 'friend', humans: [plain], cpuCount: 0, cpuLevel: 3, rng: seededRng(9), now: T0, ticketSecret: 's', roomPreset: null });
    expect(b.config).toEqual(a.config); // identical config (and therefore result hash) without conditions
    expect(a.visuals.scene).toBeUndefined();
    const lit = [...m.litTracks][0]!;
    const litTrack = m.tracks.find((t) => t.id === lit)!;
    await svc.setRoomConditions('p1', { ...base, trackId: lit, going: litTrack.surface === 'dirt' ? 'muddy' : 'yielding', night: true, weather: 'fog', temperatureC: 14, windKmh: 15 });
    const hosted = await svc.raceEntry('p1', h);
    const c = await createRace(m, { mode: 'friend', humans: [hosted], cpuCount: 0, cpuLevel: 3, rng: seededRng(9), now: T0, ticketSecret: 's', roomPreset: hosted.roomPreset });
    expect(c.config.track.id).toBe(lit);
    expect(c.config.track.going).toBe(litTrack.surface === 'dirt' ? 'muddy' : 'yielding');
    expect(c.config.track.night).toBe(true);
    expect(c.visuals.scene).toEqual({ weather: 'fog', temperatureC: 14, windKmh: 15, keys: { weather: 'fx/weather/fog' } });
    // a going chosen without a course maps to the drawn course's surface
    await svc.setRoomConditions('p1', { ...base, going: 'soft' });
    const any = await svc.raceEntry('p1', h);
    for (let seed = 1; seed < 12; seed++) {
      const r = await createRace(m, { mode: 'friend', humans: [any], cpuCount: 0, cpuLevel: 3, rng: seededRng(seed), now: T0, ticketSecret: 's', roomPreset: any.roomPreset });
      expect(r.config.track.going).toBe(r.config.track.surface === 'dirt' ? 'sloppy' : 'soft');
    }
    // ranked ignores the preset entirely
    const rk = await createRace(m, { mode: 'ranked', humans: [hosted], cpuCount: 3, cpuLevel: 3, rng: seededRng(5), now: T0, ticketSecret: 's', roomPreset: hosted.roomPreset });
    const rk0 = await createRace(m, { mode: 'ranked', humans: [plain], cpuCount: 3, cpuLevel: 3, rng: seededRng(5), now: T0, ticketSecret: 's' });
    expect(rk.config).toEqual(rk0.config);
  });
});

describe('HTTP routes for bond and presets', () => {
  function ctx() {
    const svc = new PlayerService(new MemoryPlayerRepo(), { master: m, rng: seededRng(3), clock: () => T0, verifiers: {} });
    const invoker: PlayerInvoker = { invoke: (async (method: string, ...args: unknown[]) => (svc as unknown as Record<string, (...a: unknown[]) => unknown>)[method]!.apply(svc, args)) as PlayerInvoker['invoke'] };
    const c: AppContext = {
      master: m,
      authenticate: async (req) => { const u = req.headers.get('x-test-user'); if (!u) throw new AppError('UNAUTHORIZED'); return u; },
      player: () => invoker,
      match: {} as AppContext['match'],
      friends: makeFriendsService(() => invoker, new MemoryDirectory()),
      leaderboard: {} as AppContext['leaderboard'],
      timeAttack: {} as AppContext['timeAttack'],
      clock: () => T0,
      race: {} as AppContext['race'],
      paidBalance: async () => ({}),
      adminToken: undefined,
      parseStoreNotification: async () => null,
    };
    return { c, svc };
  }
  const req = (method: string, path: string, body?: unknown, idem?: string) => new Request(`https://x${path}`, {
    method, headers: { 'content-type': 'application/json', 'x-test-user': 'u1', ...(idem ? { 'idempotency-key': idem } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  it('care, bond, presets end to end', async () => {
    const { c, svc } = ctx();
    const h = await horseOf(svc, 'u1');
    const care = await handle(req('POST', `/v1/horses/${h}/care`, { action: 'hay_carrot' }, 'k1'), {}, c);
    expect(care.status).toBe(200);
    expect((await care.json() as { bond: { focus: string } }).bond.focus).toBe('endurance');
    expect((await handle(req('POST', `/v1/horses/${h}/care`, { action: 'hay_carrot' }), {}, c)).status).toBe(400); // idempotency key required
    const cd = await handle(req('POST', `/v1/horses/${h}/care`, { action: 'hay_carrot' }, 'k2'), {}, c);
    expect(cd.status).toBe(409);
    expect(await cd.json()).toMatchObject({ error: { code: 'COOLDOWN' } });
    expect(await (await handle(req('GET', `/v1/horses/${h}/bond`), {}, c)).json()).toMatchObject({ horseId: h, affectsRankedStats: false });
    expect(((await (await handle(req('GET', '/v1/bond'), {}, c)).json()) as { levels: Record<string, number> }).levels[h]).toBe(1);
    const room = await handle(req('PUT', '/v1/presets/room', { trackId: null, going: 'firm', night: null, weather: 'cloudy', temperatureC: 22, windKmh: 5 }), {}, c);
    expect(room.status).toBe(200);
    expect((await handle(req('PUT', '/v1/presets/room', { trackId: null, going: 'swamp', night: null, weather: 'cloudy', temperatureC: 22, windKmh: 5 }), {}, c)).status).toBe(400);
    expect(await (await handle(req('PUT', '/v1/presets/course-look', { lookId: 'greenfield' }), {}, c)).json()).toMatchObject({ courseLook: 'greenfield' });
    expect(await (await handle(req('GET', '/v1/presets'), {}, c)).json()).toMatchObject({ courseLook: 'greenfield', room: { going: 'firm', weather: 'cloudy' } });
    expect(await (await handle(req('DELETE', '/v1/presets/room'), {}, c)).json()).toMatchObject({ room: null });
  });
});
