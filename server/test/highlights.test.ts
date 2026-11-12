// REQ-HL-001..020: レースの見どころ (contracts/protocol.md §72). Detection is C# (engine/Muchi.Engine/Highlights.cs, tested on the
// golden replays and the shared vectors in engine/Muchi.Engine.Tests/HighlightsTests.cs); the server's part is the §63 replay
// link's optional start tick, the client KPI rows and their §58 class, the help article and tip, and storing nothing.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { handle, makeFriendsService, REPLAY_LINK_MAX_START_TICK, type AppContext, type PlayerInvoker } from '../src/http/app.js';
import { MemoryDirectory } from '../src/domain/friends.js';
import { MemoryPlayerRepo, PlayerService } from '../src/domain/service.js';
import { FakeStoreVerifier } from '../src/domain/purchase.js';
import { seededRng } from '../src/domain/rng.js';
import { AppError } from '../src/domain/errors.js';
import { DEFAULT_RULESET } from '../src/domain/ruleset.js';
import { linksConfig } from '../src/domain/deepLinks.js';
import { LinkService, MemoryLinkDirectory } from '../src/domain/linkService.js';
import { maintenanceOf, endpointGroup } from '../src/domain/maintenance.js';
import { dayRule } from '../src/domain/time.js';
import { HIGHLIGHT_KINDS, HIGHLIGHT_SURFACES, clientBatchSchema, clientToKpi } from '../src/domain/kpi.js';
import { kpiClassOf } from '../src/domain/kpiConsent.js';
import { helpArticle, helpProblems } from '../src/domain/help.js';
import { tipsIndex, tipsProblems } from '../src/domain/tips.js';
import { newPlayer } from '../src/domain/player.js';
import { classifyKey } from '../src/domain/dataExport.js';
import type { MyReplaysService } from '../src/domain/myReplaysService.js';
import { m } from './helpers.js';

const NOW = Date.UTC(2026, 10, 12, 3);
const root = join(import.meta.dirname, '..', '..');

function setup() {
  const repo = new MemoryPlayerRepo();
  const svc = new PlayerService(repo, { master: m, rng: seededRng(23), clock: () => NOW, verifiers: { fake: new FakeStoreVerifier() } });
  const invoker: PlayerInvoker = { invoke: (async (method: string, ...args: unknown[]) => (svc as unknown as Record<string, (...a: unknown[]) => unknown>)[method]!.apply(svc, args)) as PlayerInvoker['invoke'] };
  const replays = { saved: [{ raceId: 'r-1', public: true, replayTitle: null as string | null }, { raceId: 'r-2', public: false, replayTitle: null as string | null }] };
  const links = new LinkService({
    party: (u) => svc.linkParty(u), checkCreate: (u) => svc.linkCheckCreate(u), note: (u, n, s1, s2, count) => svc.linkNote(u, n, s1, s2, count),
  }, new MemoryLinkDirectory(), () => linksConfig(m), { clock: () => NOW, limitSalt: 's', maintenance: () => maintenanceOf(m), dayRule: () => dayRule(m) });
  const friendDir = new MemoryDirectory();
  const c: AppContext = {
    master: m,
    authenticate: async (req) => { const u = req.headers.get('x-test-user'); if (!u) throw new AppError('UNAUTHORIZED'); return u; },
    player: () => invoker,
    match: {} as AppContext['match'],
    friends: makeFriendsService(() => invoker, friendDir),
    myReplays: { view: async () => replays, friendList: async () => ({ replays: replays.saved.filter((x) => x.public) }) } as unknown as MyReplaysService,
    leaderboard: { board: async () => ({ entries: [], total: 0 }), myRank: async () => ({}) },
    timeAttack: {} as AppContext['timeAttack'],
    clock: () => NOW,
    race: { websocket: async () => new Response(null), report: async () => ({}), replay: async (id) => ({ raceId: id }) },
    paidBalance: async () => ({}),
    adminToken: undefined,
    parseStoreNotification: async () => null,
    configInfo: async () => ({ versionId: 'base', hash: 'base', rulesetVersion: DEFAULT_RULESET.rulesetVersion, activatedAt: null }),
    links,
  };
  const call = async (user: string, path: string, init: { method?: string; body?: unknown } = {}) => {
    const res = await handle(new Request(`https://x${path}`, {
      method: init.method ?? 'GET', headers: { 'x-test-user': user, 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.9' },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    }), {}, c);
    return { status: res.status, body: await res.json() as any };
  };
  const create = (u: string, target: unknown) => call(u, '/v1/links', { method: 'POST', body: { type: 'replay', target } });
  const resolve = (u: string, token: string) => call(u, '/v1/links/resolve', { method: 'POST', body: { token } });
  const befriend = async () => {
    const code = (await call('host', '/v1/friends/code')).body.code;
    await call('guest', '/v1/friends/requests', { method: 'POST', body: { code } });
    await call('host', '/v1/friends/requests/guest/accept', { method: 'POST' });
  };
  return { call, create, resolve, befriend, replays };
}

describe('the replay link opens at the top highlight (REQ-HL-013)', () => {
  it('a start tick travels with the link to a friend; the URL is only the token', async () => {
    const w = setup();
    await w.befriend();
    const a = await w.create('host', { raceId: 'r-1', startTick: 1825 });
    expect(a.status).toBe(200);
    expect(a.body.url).not.toContain('1825');
    expect(a.body.url).not.toContain('host');
    expect(a.body.shareText).not.toContain('1825');
    const r = await w.resolve('guest', a.body.token);
    expect(r.body).toMatchObject({ state: 'ok', type: 'replay', screen: 'friend_replay', target: { ownerId: 'host', raceId: 'r-1', startTick: 1825 } });
    // without a tick: the plain §63 answer (no startTick key)
    const plain = await w.create('host', { raceId: 'r-1' });
    expect(plain.body.token).not.toBe(a.body.token);
    expect((await w.resolve('guest', plain.body.token)).body.target).toEqual({ ownerId: 'host', raceId: 'r-1', replayTitle: null });
  });

  it('a different tick is a different target; the same tick is the same link', async () => {
    const w = setup();
    const a = await w.create('host', { raceId: 'r-1', startTick: 100 });
    const again = await w.create('host', { raceId: 'r-1', startTick: 100 });
    expect(again.body).toMatchObject({ token: a.body.token, created: false });
    const b = await w.create('host', { raceId: 'r-1', startTick: 0 });
    expect(b.body.created).toBe(true);
    expect(b.body.token).not.toBe(a.body.token);
    expect((await w.resolve('host', b.body.token)).body.target.startTick).toBe(0); // the owner may open it too
  });

  it('only an own public saved replay; visibility, friendship and privacy stay §63\'s', async () => {
    const w = setup();
    expect((await w.create('host', { raceId: 'r-2', startTick: 10 })).body.error.code).toBe('NOT_FOUND'); // private
    expect((await w.create('host', { raceId: 'r-9', startTick: 10 })).body.error.code).toBe('NOT_FOUND'); // not saved
    const a = await w.create('host', { raceId: 'r-1', startTick: 10 });
    expect((await w.resolve('guest', a.body.token)).body).toEqual({ state: 'friends_only', type: 'replay' }); // no tick leaks to a non-friend
    await w.befriend();
    w.replays.saved[0]!.public = false;
    expect((await w.resolve('guest', a.body.token)).body).toEqual({ state: 'unavailable' });
  });

  it('a bad start tick is 400', async () => {
    const w = setup();
    for (const startTick of [-1, REPLAY_LINK_MAX_START_TICK + 1, 1.5, '100', true]) {
      const r = await w.create('host', { raceId: 'r-1', startTick });
      expect(r.status, String(startTick)).toBe(400);
    }
    expect((await w.create('host', { raceId: 'r-1', startTick: REPLAY_LINK_MAX_START_TICK })).status).toBe(200);
    expect((await w.create('host', { raceId: 'r-1', startTick: null })).status).toBe(200);
  });
});

describe('KPI (REQ-HL-015), storage (REQ-HL-016), gate (REQ-HL-017)', () => {
  const kpi = (name: string, props: Record<string, unknown>) => clientBatchSchema.parse({ platform: 'ios', appVersion: '1.0.0', events: [{ name, at: NOW, props }] }).events.map(clientToKpi)[0];
  it('highlight_view / highlight_share are optional client events with no race, player or tick', () => {
    expect(kpi('highlight_view', { surface: 'result', top: 'photo_finish', moments: 3 })).toEqual({ name: 'highlight_view', s1: 'result', s2: 'photo_finish', value: 3 });
    expect(kpi('highlight_share', { surface: 'my_replays', via: 'link' })).toEqual({ name: 'highlight_share', s1: 'my_replays', s2: 'link' });
    expect(() => kpi('highlight_view', { surface: 'result', top: 'finish', moments: 4 })).toThrow();
    expect(() => kpi('highlight_view', { surface: 'result', top: 'finish', moments: 1, raceId: 'r-1' })).toThrow();
    expect(() => kpi('highlight_share', { surface: 'home', via: 'card' })).toThrow();
    expect(() => kpi('highlight_share', { surface: 'link', via: 'card', startTick: 5 })).toThrow();
    expect(kpiClassOf('highlight_view')).toBe('optional');
    expect(kpiClassOf('highlight_share')).toBe('optional');
  });

  it('the kinds and surfaces equal the C# ones (Muchi.Engine HighlightKinds, AnalyticsEvent.HighlightSurfaces)', () => {
    const engine = readFileSync(join(root, 'engine', 'Muchi.Engine', 'Highlights.cs'), 'utf8');
    const consts = Object.fromEntries([...engine.matchAll(/(\w+) = "([a-z_]+)"/g)].map((x) => [x[1], x[2]]));
    const order = engine.match(/Order = \{([^}]*)\}/)![1]!.split(',').map((s) => consts[s.trim()]);
    expect(order).toEqual([...HIGHLIGHT_KINDS]);
    const client = readFileSync(join(root, 'engine', 'Muchi.Client', 'Highlights.cs'), 'utf8');
    const surf = client.match(/HighlightSurfaces = \{([^}]*)\}/)![1]!.match(/"([a-z_]+)"/g)!.map((s) => s.slice(1, -1));
    expect(surf).toEqual([...HIGHLIGHT_SURFACES]);
  });

  it('nothing is stored: no new PlayerState key, the vectors file is the verifier\'s', () => {
    const s = newPlayer('p1', 'ハヤテ', NOW) as unknown as Record<string, unknown>;
    expect(Object.keys(s).filter((k) => /highlight/i.test(k))).toEqual([]);
    for (const k of Object.keys(s)) expect(classifyKey(k), k).toBeTruthy(); // every key still classified (§51), none added here
    const vec = JSON.parse(readFileSync(join(root, 'contracts', 'highlights.vectors.json'), 'utf8'));
    expect(vec.version).toBe(1);
    expect(vec.cases.length).toBeGreaterThanOrEqual(10);
    for (const c of vec.cases) {
      expect(c.expected.moments.length).toBeGreaterThanOrEqual(1);
      expect(c.expected.moments.length).toBeLessThanOrEqual(3);
      expect(JSON.stringify(c.expected)).not.toMatch(/playerId|displayName/);
    }
  });

  it('no new route: replays stay core, links stay social', () => {
    expect(endpointGroup('/v1/replays/r-1/data')).toBe('core');
    expect(endpointGroup('/v1/links')).toBe('social');
    expect(endpointGroup('/v1/friends/u1/replays/r-1/data')).toBe('social');
  });
});

describe('help and tip (REQ-HL-018)', () => {
  it('the article reads in both languages and the tip links to it', () => {
    expect(helpProblems(m)).toEqual([]);
    expect(tipsProblems(m)).toEqual([]);
    const ja = helpArticle(m, 'race_highlights', 'ja') as unknown as { title: string; body: string; category: string };
    const en = helpArticle(m, 'race_highlights', 'en') as unknown as { title: string; body: string };
    expect(ja.title).toBe('レースの見どころ');
    expect(en.title).toBe('Race highlights');
    expect(en.body).not.toMatch(/[ぁ-んァ-ヶ一-龯]/);
    for (const t of [ja.body, en.body]) expect(t).not.toMatch(/倍|今だけ|残りわずか|お得|通常価格|limited time|hurry/i);
    const tips = tipsIndex(m, newPlayer('p1', 'ハヤテ', NOW), NOW, 'ja') as unknown as { tips: { id: string; unlocked: boolean; help: { articleId: string } | null }[] };
    const tip = tips.tips.find((t) => t.id === 'highlights_tip')!;
    expect(tip.unlocked).toBe(true);
    expect(tip.help?.articleId).toBe('race_highlights');
  });
});
