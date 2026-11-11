// REQ-ACT-001..016: アクティビティ (contracts/protocol.md §40).
import { describe, expect, it } from 'vitest';
import { handle, makeFriendsService, type AppContext, type PlayerInvoker } from '../src/http/app.js';
import { MemoryDirectory } from '../src/domain/friends.js';
import { MemoryPlayerRepo, PlayerService } from '../src/domain/service.js';
import { seededRng } from '../src/domain/rng.js';
import { AppError } from '../src/domain/errors.js';
import { catalogFor, enWordingProblems, localize, untranslated } from '../src/i18n/catalog.js';
import {
  ACTIVITY_DEFAULTS, ACTIVITY_KINDS, ACTIVITY_META, ACTIVITY_SOURCE_KEEP, ACTIVITY_TEXT, NEUTRAL_NAME, activityBadge, activityPage, activityProblems,
  activityText, markActivityRead, recordActivity, renderActivityItems, type ActivityKind,
} from '../src/domain/activity.js';
import { ACTIVITY_KIND_NAMES, ACTIVITY_SCREEN_NAMES, clientBatchSchema, clientToKpi } from '../src/domain/kpi.js';
import { ensureFeed } from '../src/domain/teamFeed.js';
import { PUSH_CATEGORIES, type Master } from '../src/domain/master.js';
import { rivalTrackName } from '../src/domain/rival.js';
import { freshPlayer, m } from './helpers.js';

const NOW = Date.UTC(2026, 10, 9, 3);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

async function setup(master: Master = m) {
  let now = NOW;
  const repo = new MemoryPlayerRepo();
  const dir = new MemoryDirectory();
  const svc = new PlayerService(repo, { master, rng: seededRng(5), clock: () => now, verifiers: {}, onProfile: (p) => dir.putProfile(p) });
  const invoker: PlayerInvoker = { invoke: (async (method: string, ...args: unknown[]) => (svc as unknown as Record<string, (...a: unknown[]) => unknown>)[method]!.apply(svc, args)) as PlayerInvoker['invoke'] };
  const friends = makeFriendsService(() => invoker, dir);
  const c: AppContext = {
    master,
    authenticate: async (req) => { const u = req.headers.get('x-test-user'); if (!u) throw new AppError('UNAUTHORIZED'); return u; },
    player: () => invoker,
    match: {} as AppContext['match'],
    friends,
    leaderboard: { board: async () => ({ entries: [], total: 0 }), myRank: async () => ({}) },
    timeAttack: {} as AppContext['timeAttack'],
    clock: () => now,
    race: { websocket: async () => new Response(null), report: async () => ({}), replay: async (id) => ({ raceId: id }) },
    paidBalance: async () => ({}),
    adminToken: undefined,
    parseStoreNotification: async () => null,
  };
  const call = async (user: string, path: string, init: { method?: string; body?: unknown; lang?: string } = {}) => {
    const res = await handle(new Request(`https://x${path}`, {
      method: init.method ?? 'GET', headers: { 'x-test-user': user, 'content-type': 'application/json', 'idempotency-key': `c:${path}:${Math.random()}`, ...(init.lang ? { 'accept-language': init.lang } : {}) },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    }), {}, c);
    return { status: res.status, body: (await res.json()) as any };
  };
  // every player touches the server once so their public profile is in the directory (as in production)
  const join = async (id: string, name: string) => { await svc.setDisplayName(id, name); };
  return { svc, repo, dir, friends, call, join, setNow: (t: number) => { now = t; }, now: () => now };
}

describe('recordActivity (REQ-ACT-002/006/010/011/013)', () => {
  it('writes once per source event id, newest first, with the push category and deep link', () => {
    const s = freshPlayer('me', NOW);
    expect(recordActivity(m, s, { kind: 'friend_request', source: 'fr:a:1', actor: { id: 'a', name: 'アオ' } }, NOW)).toBe('recorded');
    expect(recordActivity(m, s, { kind: 'friend_request', source: 'fr:a:1', actor: { id: 'a', name: 'アオ' } }, NOW + 1)).toBe('duplicate');
    expect(recordActivity(m, s, { kind: 'tournament_result', source: 'tournament:t1', vars: { tournament: '秋の大会', n: '3' }, linkId: 't1' }, NOW + 2)).toBe('recorded');
    const p = activityPage(m, s, NOW + 3, null, 20);
    expect(p.items.map((x) => x.kind)).toEqual(['tournament_result', 'friend_request']);
    expect(p.items[0]).toMatchObject({ category: 'events', link: { screen: 'tournaments', id: 't1' }, unread: true });
    expect(p.items[1]).toMatchObject({ category: 'friends', link: { screen: 'friends', id: null } });
    expect(p.unread).toBe(2);
  });

  it('every kind maps to a push category and a known screen', () => {
    for (const k of ACTIVITY_KINDS) {
      // §48.8: a support reply and (Round 18, §51) the data export are the non-push categories (no push is sent for them)
      if (ACTIVITY_META[k].category === 'account') expect(k).toBe('data_export_ready');
      else expect([...PUSH_CATEGORIES, ...(k === 'inquiry_answered' ? ['support'] : [])]).toContain(ACTIVITY_META[k].category);
      expect(ACTIVITY_SCREEN_NAMES).toContain(ACTIVITY_META[k].screen);
    }
    expect([...ACTIVITY_KIND_NAMES]).toEqual([...ACTIVITY_KINDS]);
  });

  it('collapses likes while unread and within collapseHours (12 likes → one entry), a read entry starts a new one', () => {
    const s = freshPlayer('me', NOW);
    for (let i = 0; i < 12; i++) recordActivity(m, s, { kind: 'stable_like', source: `like:${i}`, actor: { id: `p${i % 4}` } }, NOW + i * 1000);
    let p = activityPage(m, s, NOW + HOUR, null, 20);
    expect(p.items).toHaveLength(1);
    expect(p.items[0]!.count).toBe(12);
    expect(p.items[0]!.actors[0]!.playerId).toBe('p3'); // newest sender first
    const rendered = renderActivityItems(p.items, null);
    expect(rendered[0]!.text).toBe('マイ厩舎に12件のいいねが届きました');
    markActivityRead(m, s, null, NOW + HOUR);
    recordActivity(m, s, { kind: 'stable_like', source: 'like:x', actor: { id: 'p9' } }, NOW + 2 * HOUR);
    p = activityPage(m, s, NOW + 2 * HOUR, null, 20);
    expect(p.items.map((x) => x.count)).toEqual([1, 12]);
    expect(p.unread).toBe(1);
    // past collapseHours: a new entry even while unread
    recordActivity(m, s, { kind: 'stable_like', source: 'like:y', actor: { id: 'p9' } }, NOW + 2 * HOUR + ACTIVITY_DEFAULTS.collapseHours * HOUR);
    expect(activityPage(m, s, NOW + 3 * DAY, null, 20).items.map((x) => x.count)).toEqual([1, 1, 12]);
  });

  it('a collapsed entry moves to the top with a new id (unread again) and other kinds never merge', () => {
    const s = freshPlayer('me', NOW);
    recordActivity(m, s, { kind: 'team_cheer', source: 'c1', actor: { id: 'a' } }, NOW);
    recordActivity(m, s, { kind: 'friend_accepted', source: 'f1', actor: { id: 'b' } }, NOW + 1);
    recordActivity(m, s, { kind: 'team_cheer', source: 'c2', actor: { id: 'c' } }, NOW + 2);
    const p = activityPage(m, s, NOW + 3, null, 20);
    expect(p.items.map((x) => [x.kind, x.count])).toEqual([['team_cheer', 2], ['friend_accepted', 1]]);
    expect(Number(p.items[0]!.id)).toBeGreaterThan(Number(p.items[1]!.id));
    recordActivity(m, s, { kind: 'friend_request', source: 'r1', actor: { id: 'd' } }, NOW + 4);
    recordActivity(m, s, { kind: 'friend_request', source: 'r2', actor: { id: 'e' } }, NOW + 5);
    expect(activityPage(m, s, NOW + 6, null, 20).items.filter((x) => x.kind === 'friend_request')).toHaveLength(2);
  });

  it('keeps at most maxEntries and maxDays; source ids are bounded', () => {
    const s = freshPlayer('me', NOW);
    for (let i = 0; i < 130; i++) recordActivity(m, s, { kind: 'friend_accepted', source: `f${i}`, actor: { id: `x${i}` } }, NOW + i);
    expect(s.activity!.entries).toHaveLength(ACTIVITY_DEFAULTS.maxEntries);
    expect(s.activity!.entries[0]!.actors[0]!.id).toBe('x30');
    recordActivity(m, s, { kind: 'friend_accepted', source: 'late', actor: { id: 'late' } }, NOW + 31 * DAY);
    expect(s.activity!.entries.map((e) => e.actors[0]!.id)).toEqual(['late']);
    for (let i = 0; i < ACTIVITY_SOURCE_KEEP + 50; i++) recordActivity(m, s, { kind: 'gift_arrived', source: `g${i}` }, NOW + 31 * DAY + i);
    expect(s.activity!.sources.length).toBe(ACTIVITY_SOURCE_KEEP);
    // entries older than maxDays are not shown even before the next write prunes them
    expect(activityPage(m, s, NOW + 62 * DAY, null, 20).items).toHaveLength(0);
  });

  it('blocked (muted) senders never produce entries; a later block hides their part; self and a deleting account write nothing', () => {
    const s = freshPlayer('me', NOW);
    ensureFeed(s).muted.push('troll');
    expect(recordActivity(m, s, { kind: 'friend_request', source: 'r:troll', actor: { id: 'troll' } }, NOW)).toBe('blocked');
    expect(recordActivity(m, s, { kind: 'friend_request', source: 'r:me', actor: { id: 'me' } }, NOW)).toBe('skipped');
    recordActivity(m, s, { kind: 'stable_like', source: 'l1', actor: { id: 'a' } }, NOW);
    recordActivity(m, s, { kind: 'stable_like', source: 'l2', actor: { id: 'b' } }, NOW + 1);
    recordActivity(m, s, { kind: 'stable_like', source: 'l3', actor: { id: 'b' } }, NOW + 2);
    recordActivity(m, s, { kind: 'friend_accepted', source: 'fa', actor: { id: 'b' } }, NOW + 3);
    expect(activityBadge(m, s, NOW).unread).toBe(2);
    ensureFeed(s).muted.push('b');
    const p = activityPage(m, s, NOW + 4, null, 20);
    expect(p.items.map((x) => [x.kind, x.count, x.actors.map((a) => a.playerId)])).toEqual([['stable_like', 1, ['a']]]);
    expect(p.unread).toBe(1);
    s.deletion = { status: 'deleting', steps: [], attempts: 0 } as unknown as typeof s.deletion;
    expect(recordActivity(m, s, { kind: 'gift_arrived', source: 'gx' }, NOW)).toBe('skipped');
  });

  it('mark read is idempotent, never goes back and never past the newest id', () => {
    const s = freshPlayer('me', NOW);
    for (let i = 0; i < 5; i++) recordActivity(m, s, { kind: 'friend_accepted', source: `f${i}`, actor: { id: `x${i}` } }, NOW + i);
    expect(markActivityRead(m, s, 3, NOW)).toEqual({ readUpTo: '3', unread: 2 });
    expect(markActivityRead(m, s, 3, NOW)).toEqual({ readUpTo: '3', unread: 2 });
    expect(markActivityRead(m, s, 1, NOW)).toEqual({ readUpTo: '3', unread: 2 });
    expect(markActivityRead(m, s, 999, NOW)).toEqual({ readUpTo: '5', unread: 0 });
  });

  it('pages with a cursor (no gaps, no repeats)', () => {
    const s = freshPlayer('me', NOW);
    for (let i = 0; i < 45; i++) recordActivity(m, s, { kind: 'friend_accepted', source: `f${i}`, actor: { id: `x${i}` } }, NOW + i);
    const seen: string[] = [];
    let cursor: number | null = null;
    for (let guard = 0; guard < 10; guard++) {
      const p = activityPage(m, s, NOW + 100, cursor, 20);
      seen.push(...p.items.map((x) => x.id));
      if (!p.nextCursor) break;
      cursor = Number(p.nextCursor);
    }
    expect(seen).toHaveLength(45);
    expect(new Set(seen).size).toBe(45);
    expect(seen[0]).toBe('45');
  });
});

describe('progression.activity validation (REQ-ACT-010)', () => {
  const withA = (a: unknown) => ({ progression: { ...m.progression, activity: a } } as unknown as Master);
  it('accepts the shipped values and rejects out-of-range ones', () => {
    expect(activityProblems(m)).toEqual([]);
    expect(activityProblems({ progression: { ...m.progression, activity: undefined } } as unknown as Master)).toEqual([]);
    expect(activityProblems(withA({ maxEntries: 5 }))).toEqual(['progression.activity.maxEntries must be an integer 10..500']);
    expect(activityProblems(withA({ maxDays: 0 }))).toHaveLength(1);
    expect(activityProblems(withA({ collapseHours: 200 }))).toHaveLength(1);
    expect(activityProblems(withA({ pageSize: 60, pageMax: 50 }))).toHaveLength(1);
    expect(activityProblems(withA({ badgeMax: 1.5 }))).toHaveLength(1);
    expect(activityProblems(withA({ bogus: 1 }))).toEqual(['progression.activity.bogus is unknown']);
    expect(activityProblems(withA(7))).toHaveLength(1);
  });
});

describe('texts (REQ-ACT-012/014)', () => {
  it('every template has English, no banned wording, and the player name stays as written', () => {
    const cat = catalogFor(m);
    const samples: string[] = [];
    const kinds: [ActivityKind, number, Record<string, string>][] = [
      ['friend_request', 1, {}], ['friend_accepted', 1, {}], ['rival_week', 1, { outcome: 'win' }], ['rival_week', 1, { outcome: 'lose' }],
      ['rival_week', 1, { outcome: 'draw' }], ['rival_week', 1, { outcome: 'no_contest' }], ['rival_week', 1, { outcome: 'not_enough' }],
      ['rival_record', 1, { course: rivalTrackName('aoba_turf_1600') }], ['stable_like', 1, {}], ['stable_like', 12, {}], ['team_cheer', 1, {}], ['team_cheer', 3, {}],
      ['gift_arrived', 1, {}], ['gift_arrived', 4, {}], ['team_goal_tier', 1, { n: '2' }], ['team_goal_week', 1, { n: '3' }], ['team_goal_week', 1, { n: '0' }],
      ['replay_share', 1, {}],
    ];
    for (const [k, n, v] of kinds) samples.push(activityText(k, n, v, 'Hayate'));
    samples.push(activityText('tournament_result', 1, { tournament: 'Autumn Cup', n: '3' }, ''), NEUTRAL_NAME);
    const en = localize(samples, 'en', cat) as string[];
    expect(untranslated(en)).toEqual([]);
    for (const t of en) expect(enWordingProblems(t)).toEqual([]);
    expect(en).toContain('You finished 3rd in “Autumn Cup”');
    // a player name is never translated (kept as written inside the English)
    expect(localize([activityText('stable_like', 1, {}, 'ハヤテ')], 'en', cat)).toEqual(['ハヤテ liked My Stable']);
  });
});

describe('HTTP (REQ-ACT-001/003/004/007/008/009/012)', () => {
  it('a friend request and its accept write entries with the sender name; English at the boundary; badge in GET /v1/player', async () => {
    const x = await setup();
    await x.join('me', 'ミナト');
    await x.join('ao', 'アオ');
    const code = (await x.call('me', '/v1/friends/code')).body.code;
    await x.friends.request('ao', code);
    let r = await x.call('me', '/v1/activity');
    expect(r.status).toBe(200);
    expect(r.body.items).toHaveLength(1);
    expect(r.body.items[0]).toMatchObject({ kind: 'friend_request', text: 'アオさんからフレンド申請が届きました', actors: [{ playerId: 'ao', name: 'アオ' }], link: { screen: 'friends', id: null }, unread: true });
    expect((await x.call('me', '/v1/player')).body.activity).toEqual({ unread: 1 });
    await x.friends.accept('me', 'ao');
    r = await x.call('ao', '/v1/activity', { lang: 'en' });
    expect(r.body.items[0]).toMatchObject({ kind: 'friend_accepted', text: 'You and ミナト are now friends' });
    // retrying the receiver step never writes twice (REQ-ACT-002)
    await x.svc.friendReceive('me', 'ao', 'アオ');
    expect((await x.call('me', '/v1/activity')).body.items).toHaveLength(1);
  });

  it('mark read over HTTP is idempotent; bad cursor / limit / body are 400', async () => {
    const x = await setup();
    for (let i = 0; i < 3; i++) await x.svc.friendAccepted('me', `f${i}`, `F${i}`);
    expect((await x.call('me', '/v1/activity')).body.unread).toBe(3);
    expect((await x.call('me', '/v1/activity/read', { method: 'POST', body: { upTo: '2' } })).body).toEqual({ readUpTo: '2', unread: 1 });
    expect((await x.call('me', '/v1/activity/read', { method: 'POST', body: { upTo: '2' } })).body).toEqual({ readUpTo: '2', unread: 1 });
    expect((await x.call('me', '/v1/activity/read', { method: 'POST', body: {} })).body).toEqual({ readUpTo: '3', unread: 0 });
    expect((await x.call('me', '/v1/activity?cursor=abc')).status).toBe(400);
    expect((await x.call('me', '/v1/activity?limit=0')).status).toBe(400);
    expect((await x.call('me', '/v1/activity?limit=51')).status).toBe(400);
    expect((await x.call('me', '/v1/activity/read', { method: 'POST', body: { upTo: 'x' } })).status).toBe(400);
    expect((await x.call('me', '/v1/activity/read', { method: 'POST', body: { all: true } })).status).toBe(400);
    const p = (await x.call('me', '/v1/activity?limit=2')).body;
    expect(p.items).toHaveLength(2);
    expect((await x.call('me', `/v1/activity?limit=2&cursor=${p.nextCursor}`)).body.items.map((i: any) => i.id)).toEqual(['1']);
  });

  it('a deleted or banned sender shows a neutral name (REQ-ACT-012)', async () => {
    const x = await setup();
    await x.join('gone', 'キエル');
    await x.join('bad', 'ワルイ');
    await x.svc.friendReceive('me', 'gone', 'キエル');
    await x.svc.stableLikeReceive('me', 'bad', 'bad:2026-11-09:0').catch(() => undefined);
    await x.svc.friendAccepted('me', 'bad', 'ワルイ');
    (x.dir as unknown as { prof: Map<string, unknown> }).prof.delete('gone'); // the deletion removed the profile
    await x.svc.setModeration('bad', 'banned', null, 'test');
    const r = await x.call('me', '/v1/activity');
    const names = r.body.items.map((i: any) => i.actors[0]?.name);
    expect(names).not.toContain('キエル');
    expect(names).not.toContain('ワルイ');
    expect(r.body.items.find((i: any) => i.kind === 'friend_request').text).toBe(`${NEUTRAL_NAME}さんからフレンド申請が届きました`);
    const en = await x.call('me', '/v1/activity', { lang: 'en' });
    expect(en.body.items.find((i: any) => i.kind === 'friend_request').text).toBe('Player sent you a friend request');
    // the moderation mark never reaches the friends list
    const fl = await x.friends.list('me');
    expect(fl.friends.find((f) => f.playerId === 'bad')).not.toHaveProperty('banned');
  });

  it('gift arrivals link to the box (no claim), collapse; tournament and team goal prizes write their own entry only (REQ-ACT-003/004)', async () => {
    const x = await setup();
    await x.svc.adminGrant('me', { freeCoins: 10 }, 'outage', 'ops', 'g1');
    await x.svc.adminGrant('me', { freeCoins: 10 }, 'outage', 'ops', 'g2');
    await x.svc.tournamentClose('me', 't1', 2, { freeCoins: 30 }, 'Autumn Cup');
    await x.svc.tournamentClose('me', 't1', 2, { freeCoins: 30 }, 'Autumn Cup'); // retried payout
    await x.svc.teamGoalReward('me', '2026-W45', 'team1', 2, 9);
    const r = (await x.call('me', '/v1/activity')).body;
    expect(r.items.map((i: any) => [i.kind, i.count])).toEqual([['team_goal_week', 1], ['tournament_result', 1], ['gift_arrived', 2]]);
    const gift = r.items.find((i: any) => i.kind === 'gift_arrived');
    expect(gift).toMatchObject({ link: { screen: 'gift_box', id: null }, category: 'gifts', text: 'プレゼントボックスに2件のプレゼントが届きました' });
    expect(Object.keys(gift).sort()).toEqual(['actors', 'at', 'category', 'count', 'id', 'kind', 'link', 'text', 'unread']); // nothing to claim here
    expect(r.items[1]).toMatchObject({ link: { screen: 'tournaments', id: 't1' }, text: '「Autumn Cup」の最終順位は2位でした' });
    expect(r.items[0].text).toBe('先週の支部の共同目標は2段目まで届きました');
    const en = (await x.call('me', '/v1/activity', { lang: 'en' })).body;
    expect(en.items[1].text).toBe('You finished 2nd in “Autumn Cup”');
  });

  it('team goal milestone, rival record, cheers (muted sender skipped) and likes write entries at the push points', async () => {
    const x = await setup();
    await x.join('a', 'エー');
    await x.join('b', 'ビー');
    await x.join('me', 'ミー');
    await x.svc.teamGoalMilestone('me', 'team1', 1);
    await x.svc.teamGoalMilestone('me', 'team1', 1); // a retried notification
    await x.svc.rivalPush('me', 'エー', rivalTrackName('aoba_turf_1600'), 'a');
    await x.svc.feedMute('me', 'b', true);
    await x.svc.cheerPush('me', 'b', 'ビー', 'react:team1:5');
    await x.svc.cheerPush('me', 'a', 'エー', 'react:team1:6');
    await x.svc.cheerPush('me', 'a', 'エー', 'react:team1:6'); // retried
    await x.svc.stableLikeReceive('me', 'a', 'a:2026-11-09:0');
    const r = (await x.call('me', '/v1/activity')).body;
    expect(r.items.map((i: any) => [i.kind, i.count])).toEqual([['stable_like', 1], ['team_cheer', 1], ['rival_record', 1], ['team_goal_tier', 1]]);
    expect(r.items[1].text).toBe('エーさんがあなたのレースに応援スタンプを送りました');
    expect(r.items[3].text).toBe('支部の共同目標が1段目に到達しました');
  });

  it('push preferences never hide the list; the list shows the what\'s-new count as a link only (REQ-ACT-004/005)', async () => {
    const x = await setup();
    await x.svc.setPushPreferences('me', { categories: { friends: false, gifts: false } });
    await x.svc.friendAccepted('me', 'a', 'エー');
    const r = (await x.call('me', '/v1/activity')).body;
    expect(r.items).toHaveLength(1);
    expect(typeof r.links.whatsNew).toBe('number');
  });

  it('account deletion clears the list (the state is wiped)', async () => {
    const x = await setup();
    await x.svc.friendAccepted('me', 'a', 'エー');
    await x.svc.wipe('me');
    expect((await x.call('me', '/v1/activity')).body.items).toEqual([]);
  });
});

describe('KPI (REQ-ACT-015)', () => {
  it('activity_open and activity_tap are accepted client events', () => {
    const b = clientBatchSchema.parse({ platform: 'ios', appVersion: '1.0.0', events: [
      { name: 'activity_open', at: NOW, props: { unread: 3 } },
      { name: 'activity_tap', at: NOW, props: { kind: 'stable_like', screen: 'stable' } },
    ] });
    expect(b.events.map(clientToKpi)).toEqual([{ name: 'activity_open', value: 3 }, { name: 'activity_tap', s1: 'stable_like', s2: 'stable' }]);
    expect(() => clientBatchSchema.parse({ platform: 'ios', appVersion: '1.0.0', events: [{ name: 'activity_tap', at: NOW, props: { kind: 'claim', screen: 'stable' } }] })).toThrow();
  });
});
