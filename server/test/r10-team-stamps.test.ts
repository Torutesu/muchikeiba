import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { m } from './helpers.js';
import { MANIFEST_PATH } from '../scripts/gen-assets.js';
import { MemoryPlayerRepo, PlayerService } from '../src/domain/service.js';
import { seededRng } from '../src/domain/rng.js';
import { AppError } from '../src/domain/errors.js';
import { MemoryTeams, TeamsService } from '../src/domain/teamService.js';
import { handle, teamPlayersFrom, type AppContext, type PlayerInvoker } from '../src/http/app.js';
import { grantFree } from '../src/domain/wallet.js';
import { runAccountDeletion, type DeletionPorts } from '../src/domain/accountDeletion.js';
import { stampsOf, stampsProblems } from '../src/domain/teamFeed.js';
import type { KpiRecord } from '../src/domain/kpi.js';
import type { PlayerState } from '../src/domain/player.js';
import type { Master } from '../src/domain/master.js';

const T0 = Date.UTC(2026, 10, 5, 3);
const DAY = 86_400_000;
const code = async (p: Promise<unknown>) => { try { await p; return 'ok'; } catch (e) { return (e as AppError).code; } };

function world(master: Master = m) {
  let t = T0;
  const clock = () => t;
  const repo = new MemoryPlayerRepo();
  const teams = new MemoryTeams(() => master, clock);
  const kpi: { id: string; r: KpiRecord }[] = [];
  const svc = new PlayerService(repo, {
    master, rng: seededRng(5), clock, verifiers: {},
    onTeamPoints: async (p) => { await teams.reportPoints(p.teamId, p.playerId, p.seasonId, p.points, p.displayName); },
    onTeamFeed: async (p) => { await teams.feedRace(p.teamId, p.playerId, p.race); },
    onKpi: (id, recs) => { for (const r of recs) kpi.push({ id, r }); },
  });
  const invoker: PlayerInvoker = { invoke: (async (method: string, ...args: unknown[]) => (svc as unknown as Record<string, (...a: unknown[]) => unknown>)[method]!.apply(svc, args)) as PlayerInvoker['invoke'] };
  const ts = new TeamsService(() => master, teams, teamPlayersFrom(() => invoker), teams, teams, seededRng(9), clock);
  const state = (u: string) => repo.get(u) as PlayerState;
  let race = 0;
  const raceResult = (u: string, place: number, mode: 'ranked' | 'tournament' | 'friend' = 'ranked') =>
    svc.applyRace(u, { raceId: `r${race++}`, mode, place, fieldSize: 12, newRating: null, void: false, humans: 2, details: { trackId: 'kirameki_turf_2000', style: 'sashi', finishTick: 2400, startReactionTicks: 3, whips: 3, whipMashed: false, cpuAssisted: false } } as never);
  return { svc, repo, teams, ts, kpi, state, raceResult, invoker, advance: (ms: number) => { t += ms; }, now: clock };
}

/** lead + members in one open team. */
async function team(w: ReturnType<typeof world>, ...ids: string[]) {
  for (const id of ['lead', ...ids]) await w.svc.bootstrap(id);
  const v = await w.ts.create('lead', 'あおばRC', 'open', '');
  for (const id of ids) await w.ts.join(id, v.teamId);
  return v.teamId;
}

describe('REQ-TEAMFEED-001/002 stamp master data and unlocks', () => {
  it('master/stamps.json is consistent, every stamp has a stamp/<id> key in the generated manifest', () => {
    expect(stampsProblems(m)).toEqual([]);
    const man = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as { keys: string[]; kinds: Record<string, unknown> };
    for (const s of stampsOf(m).stamps) expect(man.keys).toContain(`stamp/${s.id}`);
    expect(man.keys).toContain('stamp/default');
    expect(man.kinds.stamp).toBeDefined();
    const groups = readFileSync(MANIFEST_PATH.replace('assets.manifest.json', 'assets.groups.json'), 'utf8');
    expect(groups).toContain('"stamp/*"');
  });

  it('a broken pairing between stamps and stamp cosmetics is reported', () => {
    const bad: Master = { ...m, items: { ...m.items, cosmetics: m.items.cosmetics.map((c) => (c.id === 'stamp_carrot' ? { ...c, asset: 'stamp/other' } : c)) } };
    expect(stampsProblems(bad).join(';')).toMatch(/stamp_carrot must be kind "stamp" with asset stamp\/carrot/);
    const noFree: Master = { ...m, stamps: { ...stampsOf(m), stamps: stampsOf(m).stamps.filter((s) => s.unlock.kind !== 'default') } };
    expect(stampsProblems(noFree)).toContain('stamps: at least one stamp must be free (unlock default)');
  });

  it('unlocks by play (races), by a season pass and by a cosmetic bought directly for coins (no randomness)', async () => {
    const w = world();
    await w.svc.bootstrap('p');
    let cat = await w.svc.stampCatalog('p');
    const by = () => Object.fromEntries(cat.stamps.map((s) => [s.id, s])) as Record<string, (typeof cat.stamps)[number]>;
    expect(by().cheer!).toMatchObject({ unlocked: true, asset: 'stamp/cheer', unlockText: '最初から使える' });
    expect(by().whip!).toMatchObject({ unlocked: false, unlock: { kind: 'races', count: 10 } });
    expect(by().pass_crown!.unlocked).toBe(false);
    expect(by().carrot!).toMatchObject({ unlocked: false, unlock: { kind: 'cosmetic', itemId: 'stamp_carrot' } });
    expect(by().carrot!.unlockText).toContain('200コイン');
    expect(cat.limits).toEqual({ postIntervalMs: 10_000, postsPerDay: 50, feedSize: 100, pageMax: 50 });

    const s = w.state('p');
    s.stats.races = 10;
    s.purchases.push({ txId: 'T1', platform: 'fake', productId: 'season_pass', priceYen: 1000, at: T0, paidCoinsGranted: 0, bonusCoinsGranted: 0, lotId: null, refunded: false, limitBreach: false, passSeasonId: '2026-11' } as never);
    grantFree(s, 500, T0, 'test', 'test');
    w.repo.put(s);
    await w.svc.buyCosmetic('p', 'stamp_carrot', 'c:test:1');
    cat = await w.svc.stampCatalog('p');
    expect(by().whip!.unlocked).toBe(true);
    expect(by().pass_crown!.unlocked).toBe(true);
    expect(by().carrot!.unlocked).toBe(true);
    expect(by().horseshoe!.unlocked).toBe(false);
    // the stamp cosmetic is listed in the cosmetics shop and never shows as equipped
    const cos = (await w.svc.cosmetics('p')).items.find((x) => x.id === 'stamp_carrot')!;
    expect(cos).toMatchObject({ kind: 'stamp', asset: 'stamp/carrot', owned: true, equipped: false });
  });
});

describe('REQ-TEAMFEED-003 posting stamps', () => {
  it('members only, unlocked stamps only, 1 per 10 s and 50 per game day', async () => {
    const w = world();
    const teamId = await team(w, 'a');
    await w.svc.bootstrap('loner');
    expect(await code(w.ts.postStamp('loner', 'cheer'))).toBe('NOT_IN_TEAM');
    expect(await code(w.ts.postStamp('a', 'whip'))).toBe('STAMP_LOCKED');
    expect(await code(w.ts.postStamp('a', 'no_such'))).toBe('NOT_FOUND');
    const r = await w.ts.postStamp('a', 'cheer');
    expect(r).toMatchObject({ teamId, seq: 1, stampId: 'cheer' });
    expect(await code(w.ts.postStamp('a', 'nice'))).toBe('RATE_LIMITED');
    w.advance(9_999);
    expect(await code(w.ts.postStamp('a', 'nice'))).toBe('RATE_LIMITED');
    w.advance(1);
    await w.ts.postStamp('a', 'nice');
    for (let i = 2; i < 50; i++) { w.advance(10_000); await w.ts.postStamp('a', 'gg'); }
    w.advance(10_000);
    expect(await code(w.ts.postStamp('a', 'gg'))).toBe('RATE_LIMITED'); // 50 today
    expect(await code(w.ts.postStamp('lead', 'gg'))).toBe('ok'); // per member
    w.advance(DAY);
    expect(await code(w.ts.postStamp('a', 'gg'))).toBe('ok');
    // KPI stamp_post per stored post
    expect(w.kpi.filter((k) => k.r.name === 'stamp_post' && k.id === 'a')).toHaveLength(51);
    expect(w.kpi.find((k) => k.r.name === 'stamp_post')!.r).toMatchObject({ s1: 'cheer', s2: 'post', s3: teamId });
  });

  it('no posts while the account deletion is scheduled (DELETION_PENDING)', async () => {
    const w = world();
    await team(w, 'a');
    const t = (await w.svc.requestDeletion('a', null)) as { confirmToken: string };
    await w.svc.requestDeletion('a', t.confirmToken);
    expect(await code(w.ts.postStamp('a', 'cheer'))).toBe('DELETION_PENDING');
    expect(await code(w.ts.react('a', 1, 'cheer'))).toBe('DELETION_PENDING');
  });

  it('keeps the last 100 items (ring buffer) and pages newest first', async () => {
    const w = world();
    await team(w, 'a', 'b');
    for (let i = 0; i < 130; i++) { w.advance(10_000); await w.ts.postStamp(['a', 'b', 'lead'][i % 3]!, 'cheer'); }
    const first = await w.ts.feed('lead', null, null);
    expect(first.items).toHaveLength(20);
    expect(first.items[0]!.seq).toBe(130);
    expect(first.latestSeq).toBe(130);
    let before = first.nextBefore;
    const seen = first.items.map((x) => x.seq);
    while (before !== null) {
      const p = await w.ts.feed('lead', before, 50);
      seen.push(...p.items.map((x) => x.seq));
      before = p.nextBefore;
    }
    expect(seen).toEqual(Array.from({ length: 100 }, (_, i) => 130 - i)); // 31..130, nothing older
    expect(await code(w.ts.feed('lead', 5, 10))).toBe('ok');
    expect((await w.ts.feed('lead', 5, 10)).items).toEqual([]);
    // the first page of a visit is the team_feed_view KPI row (paging further is not)
    expect(w.kpi.filter((k) => k.r.name === 'team_feed_view' && k.id === 'lead')).toHaveLength(1);
  });
});

describe('REQ-TEAMFEED-004/005 race results and reactions', () => {
  it('a win or place in ranked or a tournament becomes a feed item once; friend races and 4th place do not', async () => {
    const w = world();
    await team(w, 'a');
    await w.raceResult('a', 1);
    await w.raceResult('a', 3, 'tournament');
    await w.raceResult('a', 4);
    await w.raceResult('a', 1, 'friend');
    const f = await w.ts.feed('lead', null, null);
    expect(f.items.map((x) => [x.kind, x.race?.mode, x.race?.place])).toEqual([['race', 'tournament', 3], ['race', 'ranked', 1]]);
    expect(f.items[1]!).toMatchObject({ playerId: 'a', displayName: w.state('a').profile.displayName, race: { fieldSize: 12, trackId: 'kirameki_turf_2000' } });
    // replayed result (the room retried): no second item
    await w.teams.feedRace((await w.svc.teamState('a')).teamId!, 'a', f.items[1]!.race!);
    expect((await w.ts.feed('lead', null, null)).items).toHaveLength(2);
  });

  it('teammates react with one stamp each (replace / remove); a new cheer on a race item pushes its owner unless muted', async () => {
    const w = world();
    await team(w, 'a', 'b');
    await w.svc.registerDevice('a', 'token-aaaa', 'ios');
    await w.raceResult('a', 1);
    const seq = (await w.ts.feed('lead', null, null)).items[0]!.seq;
    await w.ts.react('lead', seq, 'nice');
    await w.ts.react('b', seq, 'nice');
    w.advance(10_000);
    await w.ts.react('b', seq, 'clap'); // replaces b's reaction
    let item = (await w.ts.feed('a', null, null)).items[0]!;
    expect(item.reactions).toEqual([{ stampId: 'clap', count: 1, mine: false }, { stampId: 'nice', count: 1, mine: false }]);
    item = (await w.ts.feed('b', null, null)).items[0]!;
    expect(item.myReaction).toBe('clap');
    const outbox = () => (w.state('a') as PlayerState & { push: { outbox: { templateId: string; vars: Record<string, string> }[] } }).push.outbox.filter((x) => x.templateId === 'team_cheer');
    expect(outbox()).toHaveLength(2); // lead and b (b's replacement is not new)
    expect(outbox()[0]!.vars.name).toBe(w.state('lead').profile.displayName);
    // a muted member never notifies
    await w.ts.mute('a', 'lead', true);
    w.advance(10_000);
    await w.ts.react('lead', seq, null);
    w.advance(10_000);
    await w.ts.react('lead', seq, 'cheer');
    expect(outbox()).toHaveLength(2);
    expect(await code(w.ts.react('b', 9999, 'cheer'))).toBe('NOT_FOUND');
    expect(w.kpi.filter((k) => k.r.name === 'stamp_post' && k.r.s2 === 'reaction')).toHaveLength(3);
  });
});

describe('REQ-TEAMFEED-006/007 mute (block) and report', () => {
  it('a muted member\'s items and reactions disappear from my feed only; unmute brings them back', async () => {
    const w = world();
    await team(w, 'a', 'b');
    await w.ts.postStamp('a', 'cheer');
    await w.ts.postStamp('b', 'nice');
    w.advance(10_000);
    await w.ts.react('a', 2, 'gg');
    expect(await w.ts.mute('lead', 'a', true)).toEqual({ muted: ['a'] });
    const mine = await w.ts.feed('lead', null, null);
    expect(mine.items.map((x) => x.playerId)).toEqual(['b']);
    expect(mine.items[0]!.reactions).toEqual([]);
    expect(mine.muted).toEqual(['a']);
    expect((await w.ts.feed('b', null, null)).items).toHaveLength(2);
    expect(await code(w.ts.mute('lead', 'lead', true))).toBe('BAD_REQUEST');
    expect(await w.ts.mutes('lead')).toEqual({ muted: ['a'] });
    await w.ts.mute('lead', 'a', false);
    expect((await w.ts.feed('lead', null, null)).items).toHaveLength(2);
  });

  it('report hides the item for the reporter and flags its owner for support (once, rate limited)', async () => {
    const w = world();
    const teamId = await team(w, 'a', 'b');
    await w.ts.postStamp('a', 'cheer');
    expect(await w.ts.report('lead', 1, 'spam')).toEqual({ reported: true, seq: 1 });
    await w.ts.report('lead', 1, 'harassment');
    expect(w.state('a').supportFlags).toEqual([`team_feed_report:${teamId}:1:lead:spam`]);
    expect((await w.ts.feed('lead', null, null)).items).toEqual([]);
    expect((await w.ts.feed('b', null, null)).items).toHaveLength(1);
    expect(await code(w.ts.report('a', 1, 'spam'))).toBe('BAD_REQUEST'); // own item
    for (let i = 0; i < 12; i++) { w.advance(10_000); await w.ts.postStamp('a', 'gg'); }
    for (let s = 2; s <= 10; s++) await w.ts.report('b', s, 'other');
    expect(await code(w.ts.report('b', 11, 'other'))).toBe('ok'); // 10th of the day
    expect(await code(w.ts.report('b', 12, 'other'))).toBe('RATE_LIMITED');
  });
});

describe('REQ-TEAMFEED-008 account deletion', () => {
  it('removes the player\'s items and reactions from the current and former teams\' feeds', async () => {
    const w = world();
    const t1 = await team(w, 'gone', 'b');
    await w.ts.postStamp('gone', 'cheer');
    await w.ts.postStamp('b', 'nice');
    w.advance(10_000);
    await w.ts.react('gone', 2, 'gg');
    await w.raceResult('gone', 2);
    // gone leaves and joins another team (after the cooldown), posts there too
    await w.ts.leave('gone');
    w.advance(2 * DAY);
    await w.svc.bootstrap('lead2');
    const t2 = (await w.ts.create('lead2', 'みどりRC', 'open', '')).teamId;
    await w.ts.join('gone', t2);
    await w.ts.postStamp('gone', 'thanks');
    expect((await w.ts.feed('b', null, null)).items.some((x) => x.playerId === 'gone')).toBe(true);

    const tok = (await w.svc.requestDeletion('gone', null)) as { confirmToken: string };
    await w.svc.requestDeletion('gone', tok.confirmToken);
    w.advance(15 * DAY);
    const ports: DeletionPorts = {
      start: async (u) => { await w.svc.deletionStart(u); },
      snapshot: (u) => w.svc.deletionSnapshot(u),
      markStep: async (u, st) => { await w.svc.deletionMarkStep(u, st); },
      friends: { removeFriend: async () => undefined, dropOutgoing: async () => undefined, dropIncoming: async () => undefined },
      team: {
        members: async (tid, u) => (await w.teams.view(tid, u)).members,
        leave: (tid, u) => w.teams.leave(tid, u),
        transfer: (tid, u, to) => w.teams.transfer(tid, u, to),
        dropRequest: (tid, u) => w.teams.dropRequest(tid, u),
        forgetFeed: (tid, u) => w.teams.feedForget(tid, u),
      },
      directory: { forget: async () => undefined },
      leaderboards: { forget: async () => undefined, deleteGhosts: async () => undefined },
      finalize: (u) => w.svc.deletionFinalize(u),
      retain: async () => undefined,
      wipe: (u) => w.svc.wipe(u),
    };
    expect((await w.svc.deletionSnapshot('gone')).feedTeams?.sort()).toEqual([t1, t2].sort());
    await runAccountDeletion(ports, 'gone', w.now());
    const f1 = await w.ts.feed('b', null, null);
    expect(f1.items.map((x) => x.playerId)).toEqual(['b']);
    expect(f1.items[0]!.reactions).toEqual([]);
    expect((await w.ts.feed('lead2', null, null)).items).toEqual([]);
    // a report after the wipe does not recreate the account
    expect(await w.svc.feedReported('gone', t1, 1, 'b', 'spam')).toEqual({ flagged: false });
    expect(w.repo.get('gone')).toBeNull();
  });
});

describe('HTTP API: stamps and the team feed', () => {
  it('routes: catalog, post, feed paging, reaction, report, mutes; validation', async () => {
    const w = world();
    await team(w, 'a');
    const c = {
      master: m, clock: w.now, player: () => w.invoker, teams: w.ts,
      authenticate: async (req: Request) => { const u = req.headers.get('x-test-user'); if (!u) throw new AppError('UNAUTHORIZED'); return u; },
    } as unknown as AppContext;
    const call = async (method: string, path: string, user: string, body?: unknown) => {
      const res = await handle(new Request(`https://x${path}`, { method, headers: { 'content-type': 'application/json', 'x-test-user': user }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }), {}, c);
      return { status: res.status, body: (await res.json()) as any };
    };
    expect((await call('GET', '/v1/stamps', 'a')).body.stamps.length).toBe(stampsOf(m).stamps.length);
    expect((await call('POST', '/v1/teams/me/feed/stamps', 'a', { stampId: 'cheer' })).body).toMatchObject({ seq: 1, stampId: 'cheer' });
    expect((await call('POST', '/v1/teams/me/feed/stamps', 'a', { stampId: 'nice' })).status).toBe(429);
    expect((await call('POST', '/v1/teams/me/feed/stamps', 'a', { stampId: 'Bad Id' })).status).toBe(400);
    expect((await call('POST', '/v1/teams/me/feed/stamps', 'a', { stampId: 'cheer', text: 'free text' })).status).toBe(400); // no free text, ever
    expect((await call('PUT', '/v1/teams/me/feed/1/reaction', 'lead', { stampId: 'nice' })).body).toMatchObject({ seq: 1, myReaction: 'nice' });
    const feed = await call('GET', '/v1/teams/me/feed?limit=10', 'lead');
    expect(feed.body.items[0]).toMatchObject({ seq: 1, kind: 'stamp', stampId: 'cheer', stampAsset: 'stamp/cheer', myReaction: 'nice' });
    expect((await call('GET', '/v1/teams/me/feed?before=abc', 'lead')).status).toBe(400);
    expect((await call('GET', '/v1/teams/me/feed?limit=0', 'lead')).status).toBe(400);
    expect((await call('POST', '/v1/teams/me/feed/1/report', 'lead', { reason: 'rude words' })).status).toBe(400);
    expect((await call('POST', '/v1/teams/me/feed/1/report', 'lead', { reason: 'spam' })).body).toEqual({ reported: true, seq: 1 });
    expect((await call('PUT', '/v1/teams/me/feed/mutes', 'lead', { playerId: 'a', muted: true })).body).toEqual({ muted: ['a'] });
    expect((await call('GET', '/v1/teams/me/feed/mutes', 'lead')).body).toEqual({ muted: ['a'] });
    expect((await call('PUT', '/v1/teams/me/feed/0/reaction', 'lead', { stampId: 'nice' })).status).toBe(400);
    await w.svc.bootstrap('x');
    expect((await call('GET', '/v1/teams/me/feed', 'x')).body.error.code).toBe('NOT_IN_TEAM');
  });
});
