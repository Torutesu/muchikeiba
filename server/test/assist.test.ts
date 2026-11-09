import { describe, expect, it } from 'vitest';
import { m, makeConfig } from './helpers.js';
import { MemoryPlayerRepo, PlayerService } from '../src/domain/service.js';
import { seededRng } from '../src/domain/rng.js';
import { AppError } from '../src/domain/errors.js';
import { ASSIST_PROMPT_STREAK } from '../src/domain/assist.js';
import { clientBatchSchema, clientToKpi, type KpiRecord } from '../src/domain/kpi.js';
import { RaceRoomCore, CMD } from '../src/domain/raceRoom.js';
import { clientMessageSchema } from '../src/domain/schemas.js';
import { settleRace } from '../src/race/orchestrate.js';
import { handle, makeFriendsService, type AppContext, type PlayerInvoker } from '../src/http/app.js';
import { MemoryDirectory } from '../src/domain/friends.js';
import type { RaceResultForPlayer } from '../src/domain/rewards.js';

function world() {
  let now = Date.UTC(2026, 11, 10, 3);
  const kpi: KpiRecord[] = [];
  const svc = new PlayerService(new MemoryPlayerRepo(), { master: m, rng: seededRng(3), clock: () => now, verifiers: {}, onKpi: (_id, recs) => { kpi.push(...recs); } });
  let race = 0;
  const raceAt = (id: string, place: number, over: Partial<RaceResultForPlayer> = {}) =>
    svc.applyRace(id, { raceId: `r${race++}`, mode: 'ranked', place, fieldSize: 12, newRating: null, void: false, humans: 2, ...over });
  return { svc, kpi, raceAt, advance: (ms: number) => { now += ms; } };
}
const names = (k: KpiRecord[]) => k.map((x) => x.name);

describe('REQ-ASSIST-008 setting (default off, persisted on the server)', () => {
  it('defaults to off, is part of GET /v1/player, and stores whip / full / off', async () => {
    const w = world();
    await w.svc.bootstrap('p');
    expect(await w.svc.assist('p')).toMatchObject({ level: 'off', promptDue: false, lastPlaceStreak: 0, levels: ['off', 'whip', 'full'], rules: { ranked: 'allowed', shownToOpponents: false, tutorial: 'off' } });
    expect((await w.svc.view('p')).assist).toMatchObject({ level: 'off' });
    expect((await w.svc.setAssist('p', 'whip', 'settings')).level).toBe('whip');
    expect((await w.svc.view('p')).assist.level).toBe('whip');
    expect((await w.svc.setAssist('p', 'full', 'settings')).level).toBe('full');
    expect((await w.svc.setAssist('p', 'off', 'settings')).level).toBe('off');
    expect(names(w.kpi).filter((n) => n.startsWith('assist_'))).toEqual(['assist_enable', 'assist_enable', 'assist_disable']);
    const en = w.kpi.filter((k) => k.name === 'assist_enable');
    expect(en[0]).toMatchObject({ s1: 'whip', s2: 'settings', s3: 'off', isFirst: true });
    expect(en[1]).toMatchObject({ s1: 'full', s3: 'whip', isFirst: false });
  });
  it('setting the same level again changes nothing and emits nothing (idempotent retries)', async () => {
    const w = world();
    await w.svc.bootstrap('p');
    await w.svc.setAssist('p', 'full', 'settings');
    const before = w.kpi.length;
    await w.svc.setAssist('p', 'full', 'settings');
    await w.svc.setAssist('p', 'full', 'settings');
    expect(w.kpi.length).toBe(before);
  });
  it('reading it never creates player state for an unknown id', async () => {
    const w = world();
    await expect(w.svc.assist('ghost')).resolves.toMatchObject({ level: 'off' });
  });
});

describe('REQ-ASSIST-010 one-time suggestion after 3 last places in a row', () => {
  it('due after the 3rd consecutive last place; any other place resets the streak', async () => {
    const w = world();
    await w.svc.bootstrap('p');
    await w.raceAt('p', 12); await w.raceAt('p', 12);
    expect((await w.svc.assist('p')).lastPlaceStreak).toBe(2);
    await w.raceAt('p', 11); // not last → reset
    expect((await w.svc.assist('p')).lastPlaceStreak).toBe(0);
    for (let i = 0; i < ASSIST_PROMPT_STREAK - 1; i++) await w.raceAt('p', 12);
    expect((await w.svc.assist('p')).promptDue).toBe(false);
    await w.raceAt('p', 12);
    expect(await w.svc.assist('p')).toMatchObject({ promptDue: true, lastPlaceStreak: 3 });
    // stays due (the app may be closed) until it is shown, even after a better race
    await w.raceAt('p', 1);
    expect((await w.svc.assist('p')).promptDue).toBe(true);
  });
  it('void races, the tutorial, time attack, a solo field and a duplicate race do not count', async () => {
    const w = world();
    await w.svc.bootstrap('p');
    await w.raceAt('p', 0, { void: true });
    await w.raceAt('p', 8, { mode: 'tutorial', fieldSize: 8 });
    await w.raceAt('p', 1, { mode: 'friend', fieldSize: 1 });
    expect((await w.svc.assist('p')).lastPlaceStreak).toBe(0);
    await w.svc.applyRace('p', { raceId: 'dup', mode: 'friend', place: 6, fieldSize: 6, newRating: null, void: false, humans: 2 });
    await w.svc.applyRace('p', { raceId: 'dup', mode: 'friend', place: 6, fieldSize: 6, newRating: null, void: false, humans: 2 }); // settlement retry
    expect((await w.svc.assist('p')).lastPlaceStreak).toBe(1);
  });
  it('shown once: prompt-seen emits assist_prompt_view once, then the streak never prompts again', async () => {
    const w = world();
    await w.svc.bootstrap('p');
    // before it is due, prompt-seen is a no-op (a buggy client cannot burn the suggestion early)
    await w.svc.assistPromptSeen('p');
    expect((await w.svc.assist('p')).promptShown).toBe(false);
    for (let i = 0; i < 3; i++) await w.raceAt('p', 12);
    expect((await w.svc.assistPromptSeen('p'))).toMatchObject({ promptDue: false, promptShown: true });
    await w.svc.assistPromptSeen('p');
    expect(names(w.kpi).filter((n) => n === 'assist_prompt_view')).toHaveLength(1);
    for (let i = 0; i < 6; i++) await w.raceAt('p', 12);
    expect((await w.svc.assist('p')).promptDue).toBe(false);
  });
  it('never due when the assist is already on; choosing from the sheet marks it shown and is tagged as prompt', async () => {
    const w = world();
    await w.svc.bootstrap('p');
    await w.svc.setAssist('p', 'whip', 'settings');
    for (let i = 0; i < 3; i++) await w.raceAt('p', 12);
    expect((await w.svc.assist('p')).promptDue).toBe(false);
    const w2 = world();
    await w2.svc.bootstrap('q');
    for (let i = 0; i < 3; i++) await w2.raceAt('q', 12);
    expect((await w2.svc.setAssist('q', 'full', 'prompt'))).toMatchObject({ level: 'full', promptDue: false, promptShown: true });
    expect(w2.kpi.find((k) => k.name === 'assist_enable')).toMatchObject({ s1: 'full', s2: 'prompt', value: 3 });
  });
  it('no suggestion while an account deletion is scheduled', async () => {
    const w = world();
    await w.svc.bootstrap('p');
    for (let i = 0; i < 3; i++) await w.raceAt('p', 12);
    const t = await w.svc.requestDeletion('p', null) as { confirmToken: string };
    await w.svc.requestDeletion('p', t.confirmToken);
    expect((await w.svc.assist('p')).promptDue).toBe(false);
  });
});

describe('REQ-ASSIST-007 the room records the rider\'s own assist level (KPI only, never relayed)', () => {
  const H = (c: string) => c.repeat(64);
  function room() {
    const cfg = makeConfig(2, 'ranked');
    const r = new RaceRoomCore(cfg, 0, { verifySampleRate: 0, resultWaitMs: 1, rng: seededRng(1) });
    const at = (t: number) => (t + 1) * 50;
    for (const s of r.humanSlots) r.hello(s, -1, 0);
    for (let t = 0; t <= r.minResultTick + 20; t += 20) {
      for (const s of r.humanSlots) r.message(s, { t: 'ping', c: 0 }, at(t));
      r.advance(at(t));
      if (t === 60) r.message(r.humanSlots[0]!, { t: 'in', tick: 62, cmd: CMD.START }, at(t));
    }
    return { cfg, r, at };
  }
  it('res.assist is accepted, kept per reporter slot, and absent from every message the room sends', () => {
    const { cfg, r, at } = room();
    const [a, b] = r.humanSlots as [number, number];
    const out1 = r.message(a, { t: 'res', h: H('a'), order: [0, 1], assist: 'full' }, at(r.minResultTick + 20));
    const out2 = r.message(b, { t: 'res', h: H('a'), order: [0, 1] }, at(r.minResultTick + 20));
    expect(r.final).toMatchObject({ status: 'confirmed', assisted: [[a, 'full']] });
    for (const o of [...out1, ...out2]) expect(JSON.stringify(o.msg)).not.toMatch(/assist/);
    const res = settleRace(cfg, r.final!, {}, r.replayLog());
    const pa = cfg.entrants[a]!.playerId!, pb = cfg.entrants[b]!.playerId!;
    expect(res[pa]!.details!.assist).toBe('full');
    expect(res[pb]!.details!.assist).toBeUndefined();
  });
  it('the wire schema accepts whip / full only', () => {
    const base = { t: 'res', h: H('a'), order: [0] };
    expect(clientMessageSchema.safeParse({ ...base, assist: 'whip' }).success).toBe(true);
    expect(clientMessageSchema.safeParse({ ...base, assist: 'full' }).success).toBe(true);
    expect(clientMessageSchema.safeParse({ ...base, assist: 'off' }).success).toBe(false);
    expect(clientMessageSchema.safeParse({ ...base, assist: 'turbo' }).success).toBe(false);
  });
  it('an assisted race emits race_assisted; rewards and places are the same as unassisted', async () => {
    const w = world();
    await w.svc.bootstrap('p'); await w.svc.bootstrap('q');
    const details = { trackId: 'kirameki_turf_2000', style: 'sashi' as const, finishTick: 1900, startReactionTicks: 4, whips: 6, whipMashed: false, cpuAssisted: false };
    const a = await w.raceAt('p', 2, { details: { ...details, assist: 'whip' } }) as { coins: number; seasonPoints: number };
    const b = await w.raceAt('q', 2, { details }) as { coins: number; seasonPoints: number };
    expect(a.coins).toBe(b.coins);
    expect(a.seasonPoints).toBe(b.seasonPoints);
    expect(w.kpi.filter((k) => k.name === 'race_assisted')).toEqual([expect.objectContaining({ s1: 'whip', s2: 'ranked', place: 2, count: 12 })]);
  });
});

describe('REQ-ASSIST-011 client race_start carries the level', () => {
  it('maps assist into s2 (off and absent leave it empty)', () => {
    const b = clientBatchSchema.parse({ platform: 'ios', appVersion: '1', events: [
      { name: 'race_start', at: 1, props: { mode: 'ranked', assist: 'full' } },
      { name: 'race_start', at: 1, props: { mode: 'offline', assist: 'off' } },
      { name: 'race_start', at: 1, props: { mode: 'tutorial' } },
    ] });
    expect(b.events.map(clientToKpi)).toEqual([{ name: 'client_race_start', s1: 'ranked', s2: 'full' }, { name: 'client_race_start', s1: 'offline' }, { name: 'client_race_start', s1: 'tutorial' }]);
    expect(clientBatchSchema.safeParse({ platform: 'ios', appVersion: '1', events: [{ name: 'race_start', at: 1, props: { mode: 'ranked', assist: 'turbo' } }] }).success).toBe(false);
  });
});

describe('HTTP /v1/player/assist (contracts/protocol.md §27)', () => {
  function ctx() {
    const w = world();
    const invoker: PlayerInvoker = { invoke: (async (method: string, ...args: unknown[]) => (w.svc as unknown as Record<string, (...a: unknown[]) => unknown>)[method]!.apply(w.svc, args)) as PlayerInvoker['invoke'] };
    const c = {
      master: m, authenticate: async (req: Request) => { const u = req.headers.get('x-test-user'); if (!u) throw new AppError('UNAUTHORIZED'); return u; },
      player: () => invoker, friends: makeFriendsService(() => invoker, new MemoryDirectory()), clock: () => Date.now(),
      paidBalance: async () => ({}), adminToken: 'x', parseStoreNotification: async () => null,
    } as unknown as AppContext;
    return { c, w };
  }
  const req = (method: string, path: string, user?: string, body?: unknown) => new Request(`https://x${path}`, {
    method, headers: { ...(user ? { 'x-test-user': user } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  it('GET / PUT / prompt-seen; bad bodies are 400; auth required', async () => {
    const { c, w } = ctx();
    await w.svc.bootstrap('u');
    expect((await handle(req('GET', '/v1/player/assist'), {}, c)).status).toBe(401);
    expect(await (await handle(req('GET', '/v1/player/assist', 'u'), {}, c)).json()).toMatchObject({ level: 'off' });
    expect(await (await handle(req('PUT', '/v1/player/assist', 'u', { level: 'whip' }), {}, c)).json()).toMatchObject({ level: 'whip' });
    expect(await (await handle(req('PUT', '/v1/player/assist', 'u', { level: 'full', source: 'prompt' }), {}, c)).json()).toMatchObject({ level: 'full', promptShown: true });
    expect((await handle(req('PUT', '/v1/player/assist', 'u', { level: 'turbo' }), {}, c)).status).toBe(400);
    expect((await handle(req('PUT', '/v1/player/assist', 'u', { level: 'off', extra: 1 }), {}, c)).status).toBe(400);
    expect((await handle(req('PUT', '/v1/player/assist', 'u', { level: 'off', source: 'ad' }), {}, c)).status).toBe(400);
    expect((await handle(req('POST', '/v1/player/assist/prompt-seen', 'u'), {}, c)).status).toBe(200);
    expect(await (await handle(req('GET', '/v1/player', 'u'), {}, c)).json()).toMatchObject({ assist: { level: 'full' } });
  });
});
