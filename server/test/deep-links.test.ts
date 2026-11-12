// REQ-LINK-001..024: ディープリンク・招待リンクと再戦 (contracts/protocol.md §63).
import { describe, expect, it } from 'vitest';
import { handle, makeFriendsService, makeInviteService, type AppContext, type PlayerInvoker, type RematchResult } from '../src/http/app.js';
import { MemoryDirectory, shardOf } from '../src/domain/friends.js';
import { MemoryInviteDirectory } from '../src/domain/invite.js';
import { MemoryPlayerRepo, PlayerService } from '../src/domain/service.js';
import { FakeStoreVerifier } from '../src/domain/purchase.js';
import { seededRng } from '../src/domain/rng.js';
import { AppError } from '../src/domain/errors.js';
import { DEFAULT_RULESET } from '../src/domain/ruleset.js';
import { catalogFor, translateText, untranslated } from '../src/i18n/catalog.js';
import { DEFAULT_MAINTENANCE, EXEMPT_ROUTES, endpointGroup, gateRequest, maintenanceOf } from '../src/domain/maintenance.js';
import { dayRule } from '../src/domain/time.js';
import {
  androidAssetLinks, appleAssociation, DEFAULT_LINKS, fallbackPage, formatToken, LINK_TYPES, linksConfig, linksProblems, makeToken, normalizeToken,
  parseLink, SHARE_TEXT, TOKEN_ALPHABET, TOKEN_LENGTH, tokenShard,
} from '../src/domain/deepLinks.js';
import { LinkService, linkLimitStep, MemoryLinkDirectory } from '../src/domain/linkService.js';
import { Rematches } from '../src/domain/rematch.js';
import { FriendRooms } from '../src/domain/matchmaker.js';
import { BLOCK_EFFECTS } from '../src/domain/blocks.js';
import { classifyKey } from '../src/domain/dataExport.js';
import type { KpiRecord } from '../src/domain/kpi.js';
import type { Master } from '../src/domain/master.js';
import type { MyReplaysService } from '../src/domain/myReplaysService.js';
import { m } from './helpers.js';

const NOW = Date.UTC(2026, 10, 11, 3); // 12:00 JST
const MIN = 60_000;

function setup(opts: { master?: Master; rooms?: Set<string>; members?: Record<string, string[]> } = {}) {
  let now = NOW;
  const master = opts.master ?? m;
  const repo = new MemoryPlayerRepo();
  const kpi: { id: string; rec: KpiRecord }[] = [];
  const svc = new PlayerService(repo, { master, rng: seededRng(21), clock: () => now, verifiers: { fake: new FakeStoreVerifier() }, onKpi: (id, recs) => { for (const rec of recs) kpi.push({ id, rec }); } });
  const invoker: PlayerInvoker = { invoke: (async (method: string, ...args: unknown[]) => (svc as unknown as Record<string, (...a: unknown[]) => unknown>)[method]!.apply(svc, args)) as PlayerInvoker['invoke'] };
  const dir = new MemoryLinkDirectory();
  const friendDir = new MemoryDirectory();
  const rooms = opts.rooms ?? new Set(['123456']);
  const members = opts.members ?? { '123456': ['host', 'mate'] };
  const replays = { saved: [{ raceId: 'r-1', public: true, replayTitle: '差し切った日' }, { raceId: 'r-2', public: false, replayTitle: null }] };
  const links = new LinkService({
    party: (u) => svc.linkParty(u), checkCreate: (u) => svc.linkCheckCreate(u), note: (u, n, s1, s2, count) => svc.linkNote(u, n, s1, s2, count),
  }, dir, () => linksConfig(master), { clock: () => now, limitSalt: 'salt', maintenance: () => maintenanceOf(master), dayRule: () => dayRule(master) });
  const session = (req: Request) => {
    const u = req.headers.get('x-test-user');
    if (!u) throw new AppError('UNAUTHORIZED');
    return u;
  };
  const c: AppContext = {
    master,
    authenticate: async (req) => session(req),
    player: () => invoker,
    match: {
      friendMember: async (pass: string, p: string) => rooms.has(pass) && (members[pass] ?? []).includes(p),
      friendRoomOpen: async (pass: string) => rooms.has(pass),
    } as unknown as AppContext['match'],
    friends: makeFriendsService(() => invoker, friendDir),
    invite: makeInviteService(() => invoker, new MemoryInviteDirectory(), friendDir, () => master),
    myReplays: {
      view: async () => replays,
      friendList: async () => ({ replays: replays.saved.filter((x) => x.public) }),
    } as unknown as MyReplaysService,
    leaderboard: { board: async () => ({ entries: [], total: 0 }), myRank: async () => ({}) },
    timeAttack: {} as AppContext['timeAttack'],
    clock: () => now,
    race: { websocket: async () => new Response(null), report: async () => ({}), replay: async (id) => ({ raceId: id }) },
    paidBalance: async () => ({}),
    adminToken: undefined,
    parseStoreNotification: async () => null,
    configInfo: async () => ({ versionId: 'base', hash: 'base', rulesetVersion: DEFAULT_RULESET.rulesetVersion, activatedAt: null }),
    links,
  };
  const call = async (user: string, path: string, init: { method?: string; body?: unknown; lang?: string; ip?: string; platform?: string; version?: string } = {}) => {
    const headers: Record<string, string> = { 'x-test-user': user, 'content-type': 'application/json', 'cf-connecting-ip': init.ip ?? '203.0.113.7' };
    if (init.lang) headers['accept-language'] = init.lang;
    if (init.platform) headers['x-client-platform'] = init.platform;
    if (init.version) headers['x-client-version'] = init.version;
    const res = await handle(new Request(`https://x${path}`, { method: init.method ?? 'GET', headers, ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}) }), {}, c);
    const text = await res.text();
    let body: any = text;
    try { body = JSON.parse(text); } catch { /* html */ }
    return { status: res.status, headers: res.headers, body };
  };
  const create = (u: string, type: string, target: unknown = {}, init: Parameters<typeof call>[2] = {}) => call(u, '/v1/links', { method: 'POST', body: { type, target }, ...init });
  const resolve = (u: string, token: string, init: Parameters<typeof call>[2] = {}) => call(u, '/v1/links/resolve', { method: 'POST', body: { token }, ...init });
  return { svc, repo, dir, kpi, c, call, create, resolve, rooms, members, replays, tick: (ms: number) => { now += ms; }, now: () => now };
}

describe('the one link format (REQ-LINK-001/002)', () => {
  it('tokens are 22 readable characters, random, and carry the owner directory shard', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const owner = `p${i}`;
      const t = makeToken(owner);
      expect(t).toHaveLength(TOKEN_LENGTH);
      for (const ch of t) expect(TOKEN_ALPHABET).toContain(ch);
      expect(tokenShard(t)).toBe(shardOf(owner));
      seen.add(t);
    }
    expect(seen.size).toBe(200);
    expect(TOKEN_ALPHABET).not.toMatch(/[01oil]/);
    expect(21 * Math.log2(TOKEN_ALPHABET.length)).toBeGreaterThan(100);
  });

  it('parses https links of any host, the app scheme and typed tokens (full-width, dashes, upper case) to the same token', () => {
    const t = makeToken('alice');
    for (const raw of [`https://link.muchi-issen.example/l/${t}`, `https://other.example/l/${t}?utm=x#y`, `muchi://l/${t}`, `MUCHI://l/${t}/`, t.toUpperCase(), formatToken(t),
      ` ${formatToken(t).replace(/-/g, 'ー')} `, t.replace(/[a-z0-9]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 0xfee0))]) {
      expect(parseLink(raw)).toBe(t);
    }
    for (const bad of ['', 'https://x/l/short', 'https://x/p/' + t, 'muchi://room/123456', t + 'a', t.slice(0, 21) + '0', 'javascript:alert(1)']) expect(parseLink(bad)).toBeNull();
    expect(normalizeToken('abc')).toBeNull();
  });

  it('config is validated at boot and in remote config (REQ-LINK-022)', () => {
    const with_ = (links: unknown) => linksProblems({ ...m, progression: { ...m.progression, links } as Master['progression'] });
    expect(with_(undefined)).toEqual([]);
    expect(with_(DEFAULT_LINKS)).toEqual([]);
    expect(with_({ ...DEFAULT_LINKS, baseUrl: 'http://x.example' }).join()).toMatch(/baseUrl/);
    expect(with_({ ...DEFAULT_LINKS, baseUrl: 'https://x.example/path' }).join()).toMatch(/baseUrl/);
    expect(with_({ ...DEFAULT_LINKS, rematchWindowSec: 2 }).join()).toMatch(/rematchWindowSec/);
    expect(with_({ ...DEFAULT_LINKS, failuresPerHour: 90, resolvesPerHour: 60 }).join()).toMatch(/failuresPerHour/);
    expect(with_({ ...DEFAULT_LINKS, minClientVersion: { room: '1.2' } }).join()).toMatch(/minClientVersion/);
    expect(with_({ ...DEFAULT_LINKS, minClientVersion: { nope: '1.2.0' } }).join()).toMatch(/minClientVersion/);
    expect(with_({ ...DEFAULT_LINKS, apple: { appIds: ['TEAMID1234.com.example.muchi'] }, android: { packageName: 'com.example.muchi', sha256CertFingerprints: [Array(32).fill('AB').join(':')] } })).toEqual([]);
  });
});

describe('create, resolve, revoke over HTTP (REQ-LINK-003..007/013)', () => {
  it('a room member shares the room; a friend opens it with the passphrase; the URL carries no id or passphrase', async () => {
    const w = setup();
    const r = await w.create('host', 'room', { passphrase: '123456' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ type: 'room', created: true, expiresAt: NOW + 30 * MIN });
    expect(r.body.url).toBe(`https://link.muchi-issen.example/l/${r.body.token}`);
    expect(r.body.appUrl).toBe(`muchi://l/${r.body.token}`);
    expect(r.body.url).not.toMatch(/host|123456/);
    expect(r.body.shareText).toBe(`${SHARE_TEXT.room}\n${r.body.url}`);
    const o = await w.resolve('guest', r.body.url);
    expect(o.body).toEqual({ state: 'ok', type: 'room', screen: 'friend_room_join', target: { passphrase: '123456' }, expiresAt: NOW + 30 * MIN });
    expect(JSON.stringify(o.body)).not.toContain('host');
    // the same link for the same room (idempotent, not counted again)
    const again = await w.create('host', 'room', { passphrase: '123456' });
    expect(again.body).toMatchObject({ token: r.body.token, created: false });
    expect((await w.call('host', '/v1/links')).body).toMatchObject({ enabled: true, createsToday: 1, createsPerDay: 30, links: [{ token: r.body.token, type: 'room' }] });
  });

  it('only what the player may share: a room they are not in, a private replay, a missing article → 404; bad targets → 400', async () => {
    const w = setup();
    expect((await w.create('guest', 'room', { passphrase: '123456' })).body.error.code).toBe('NOT_FOUND');
    expect((await w.create('host', 'room', { passphrase: 'abc' })).body.error.code).toBe('BAD_REQUEST');
    expect((await w.create('host', 'replay', { raceId: 'r-2' })).body.error.code).toBe('NOT_FOUND');
    expect((await w.create('host', 'help', { articleId: 'no_such_article' })).body.error.code).toBe('NOT_FOUND');
    expect((await w.create('host', 'nope')).body.error.code).toBe('BAD_REQUEST');
    expect((await w.create('host', 'team')).body.error.code).toBe('NOT_FOUND'); // no teams service / no team
  });

  it('one neutral answer for unknown, malformed, expired, revoked, a closed room and a deleted owner (no oracle)', async () => {
    const w = setup();
    const room = await w.create('host', 'room', { passphrase: '123456' });
    const help = await w.create('host', 'help', { articleId: 'data_transfer' });
    const answers = [
      await w.resolve('guest', makeToken('host')),
      await w.resolve('guest', 'not a link'),
      await w.call('guest', '/v1/links/resolve', { method: 'POST', body: { url: 'https://evil.example/x' } }),
    ];
    w.rooms.delete('123456');
    answers.push(await w.resolve('guest', room.body.token));
    w.rooms.add('123456');
    expect((await w.call('host', `/v1/links/${room.body.token}`, { method: 'DELETE' })).body).toEqual({ revoked: true });
    expect((await w.call('host', `/v1/links/${room.body.token}`, { method: 'DELETE' })).body).toEqual({ revoked: false });
    expect((await w.call('guest', `/v1/links/${help.body.token}`, { method: 'DELETE' })).body).toEqual({ revoked: false }); // not theirs
    answers.push(await w.resolve('guest', room.body.token));
    w.tick(31 * MIN);
    const room2 = await w.create('host', 'room', { passphrase: '123456' }); // the expired one is not reused
    expect(room2.body.created).toBe(true);
    expect(room2.body.token).not.toBe(room.body.token);
    // the account is wiped: its links go with it
    w.repo.delete('host');
    w.dir.forget('host');
    answers.push(await w.resolve('guest', help.body.token));
    for (const a of answers) {
      expect(a.status).toBe(200);
      expect(a.body).toEqual({ state: 'unavailable' });
    }
    expect([...w.dir.links.values()].some((x) => x.ownerId === 'host')).toBe(false);
  });

  it('blocks either way, a banned owner and a banned viewer (help still opens) → unavailable', async () => {
    const w = setup();
    const friend = await w.create('host', 'friend');
    const help = await w.create('host', 'help', { articleId: 'data_transfer' });
    expect((await w.resolve('guest', friend.body.token)).body).toMatchObject({ state: 'ok', type: 'friend', target: { self: false } });
    await w.svc.blockSet('host', 'guest', true, 'blocks');
    expect((await w.resolve('guest', friend.body.token)).body).toEqual({ state: 'unavailable' });
    await w.svc.blockSet('host', 'guest', false, 'blocks');
    await w.svc.blockSet('guest', 'host', true, 'blocks');
    expect((await w.resolve('guest', friend.body.token)).body).toEqual({ state: 'unavailable' });
    await w.svc.blockSet('guest', 'host', false, 'blocks');
    await w.svc.setModeration('guest', 'banned', null, 'cheat');
    expect((await w.resolve('guest', friend.body.token)).body).toEqual({ state: 'unavailable' });
    expect((await w.resolve('guest', help.body.token)).body).toMatchObject({ state: 'ok', type: 'help', target: { articleId: 'data_transfer' } });
    await w.svc.setModeration('guest', 'ok', null, 'appeal');
    await w.svc.setModeration('host', 'banned', null, 'cheat');
    expect((await w.resolve('guest', help.body.token)).body).toEqual({ state: 'unavailable' });
    expect((await w.create('host', 'friend')).body.error.code).toBe('BANNED');
  });

  it('friend, invite, help and replay links open what the client needs; a replay is for friends only', async () => {
    const w = setup();
    await w.svc.setDisplayName('host', 'ハヤテ').catch(() => undefined);
    const friend = await w.create('host', 'friend');
    const code = (await w.call('host', '/v1/friends/code')).body.code;
    expect((await w.resolve('guest', friend.body.token)).body.target).toMatchObject({ friendCode: code, self: false });
    expect((await w.resolve('host', friend.body.token)).body.target.self).toBe(true);
    const inv = await w.create('host', 'invite');
    const invCode = (await w.call('host', '/v1/invite')).body.code;
    expect((await w.resolve('guest', inv.body.token)).body).toMatchObject({ state: 'ok', type: 'invite', screen: 'invite_redeem', target: { code: invCode } });
    const rep = await w.create('host', 'replay', { raceId: 'r-1' });
    expect((await w.resolve('guest', rep.body.token)).body).toEqual({ state: 'friends_only', type: 'replay' });
    await w.call('guest', '/v1/friends/requests', { method: 'POST', body: { code } });
    await w.call('host', '/v1/friends/requests/guest/accept', { method: 'POST' });
    expect((await w.resolve('guest', rep.body.token)).body).toMatchObject({ state: 'ok', screen: 'friend_replay', target: { ownerId: 'host', raceId: 'r-1', replayTitle: '差し切った日' } });
    w.replays.saved[0]!.public = false; // made private again
    expect((await w.resolve('guest', rep.body.token)).body).toEqual({ state: 'unavailable' });
  });

  it('creating is limited per game day (429 LINK_LIMIT) and refused while the deletion is scheduled', async () => {
    const lim = { ...m, progression: { ...m.progression, links: { ...DEFAULT_LINKS, createsPerDay: 2 } } as Master['progression'] };
    const w = setup({ master: lim });
    expect((await w.create('host', 'friend')).status).toBe(200);
    expect((await w.create('host', 'help', { articleId: 'data_transfer' })).status).toBe(200);
    expect((await w.create('host', 'friend')).body.created).toBe(false); // the same target again is free
    const r = await w.create('host', 'invite');
    expect(r.status).toBe(429);
    expect(r.body.error.code).toBe('LINK_LIMIT');
    w.tick(24 * 3600_000); // next game day
    expect((await w.create('host', 'invite')).status).toBe(200);
    const tok = await w.call('del', '/v1/player', { method: 'DELETE' });
    await w.call('del', '/v1/player', { method: 'DELETE', body: { confirmToken: tok.body.confirmToken } });
    expect((await w.create('del', 'friend')).body.error.code).toBe('DELETION_PENDING');
  });
});

describe('limits, maintenance and app versions (REQ-LINK-008/009)', () => {
  it('lookups per viewer and per IP are limited (429 RATE_LIMITED with Retry-After); failures lock sooner', async () => {
    const w = setup();
    for (let i = 0; i < 9; i++) expect((await w.resolve('guest', makeToken('x'))).status).toBe(200);
    const tenth = await w.resolve('guest', makeToken('x')); // the 10th failure still answers, then locks
    expect(tenth.body).toEqual({ state: 'unavailable' });
    const locked = await w.resolve('guest', makeToken('x'), { ip: '198.51.100.9' });
    expect(locked.status).toBe(429);
    expect(locked.body.error.code).toBe('RATE_LIMITED');
    expect(Number(locked.headers.get('retry-after'))).toBeGreaterThan(0);
    // another viewer on the locked IP is locked too; another viewer and IP is not
    expect((await w.resolve('other', makeToken('x'))).status).toBe(429);
    expect((await w.resolve('other', makeToken('x'), { ip: '192.0.2.1' })).status).toBe(200);
    w.tick(31 * MIN);
    expect((await w.resolve('guest', makeToken('x'), { ip: '198.51.100.10' })).status).toBe(200);
    // the step: lookups and failures in a rolling hour
    const rules = { lookupsPerHour: 3, failuresPerHour: 2, lockMs: 1000 };
    const a = linkLimitStep(null, 0, false, rules);
    const b = linkLimitStep(a, 1, false, rules);
    expect(linkLimitStep(b, 2, false, rules).lockedUntil).toBe(1002);
    expect(linkLimitStep(linkLimitStep(null, 0, true, rules), 1, true, rules).lockedUntil).toBe(1001);
    expect(linkLimitStep(b, 3_600_000, false, rules)).toMatchObject({ lookups: 1, lockedUntil: 0 });
  });

  it('resolve is never gated by §46: it answers maintenance for the target group and update_required for old apps', async () => {
    expect(EXEMPT_ROUTES).toContain('POST /v1/links/resolve');
    expect(endpointGroup('/v1/links')).toBe('social');
    const windowed: Master = {
      ...m,
      maintenance: { ...DEFAULT_MAINTENANCE, windows: [{ id: 'm1', startAtMs: NOW - 1000, endAtMs: NOW + 3600_000, scope: ['ranked'], message: { ja: 'レースのメンテナンス', en: 'Race maintenance' } }],
        clientVersions: { ...DEFAULT_MAINTENANCE.clientVersions, ios: { min: '1.0.0', recommended: '1.0.0', storeUrl: 'https://apps.apple.com/jp/app/id0' } } },
      progression: { ...m.progression, links: { ...DEFAULT_LINKS, minClientVersion: { team: '2.0.0', help: '2.0.0' } } } as Master['progression'],
    };
    const w = setup({ master: windowed });
    const room = await w.create('host', 'room', { passphrase: '123456' });
    const help = await w.create('host', 'help', { articleId: 'data_transfer' });
    expect((await w.resolve('guest', room.body.token)).body).toMatchObject({ state: 'maintenance', type: 'room', endAt: NOW + 3600_000, message: 'レースのメンテナンス' });
    expect((await w.resolve('guest', help.body.token, { platform: 'ios', version: '1.5.0' })).body).toEqual({ state: 'update_required', type: 'help', minVersion: '2.0.0', storeUrl: 'https://apps.apple.com/jp/app/id0' });
    expect((await w.resolve('guest', help.body.token)).body.state).toBe('ok'); // no version header: never gated
    expect((await w.resolve('guest', help.body.token, { platform: 'ios', version: '2.0.0' })).body.state).toBe('ok');
    const all = { ...DEFAULT_MAINTENANCE, windows: [{ id: 'm2', startAtMs: NOW - 1000, endAtMs: NOW + 3600_000, scope: 'all' as const, message: { ja: 'メンテナンス', en: 'Maintenance' } }] };
    const h = { platform: 'ios', version: '0.1.0', engine: 1 };
    expect(gateRequest(all, 'POST', '/v1/links/resolve', h, NOW)).toBeNull();
    expect(gateRequest(all, 'POST', '/v1/links', h, NOW)?.code).toBe('MAINTENANCE');
  });
});

describe('without the app, KPI, deletion, English (REQ-LINK-010..012/020/021)', () => {
  it('the web page never looks the token up: the same page for real and made-up tokens, no personal data; referrer for Android', async () => {
    const w = setup();
    const real = await w.create('host', 'friend');
    const fake = makeToken('nobody');
    const a = await w.call('x', `/l/${real.body.token}`);
    const b = await w.call('x', `/l/${fake}`);
    expect(a.status).toBe(200);
    expect(a.headers.get('content-type')).toMatch(/text\/html/);
    expect(a.headers.get('x-robots-tag')).toBe('noindex');
    expect(a.body.replaceAll(real.body.token, 'T').replaceAll(formatToken(real.body.token), 'F')).toBe(b.body.replaceAll(fake, 'T').replaceAll(formatToken(fake), 'F'));
    expect(a.body).not.toMatch(/host|ハヤテ/);
    const page = fallbackPage(DEFAULT_LINKS, real.body.token, { ios: 'https://apps.apple.com/app/id0', android: 'https://play.google.com/store/apps/details?id=com.example' });
    expect(page).toContain(`referrer=${encodeURIComponent(`link=${real.body.token}`)}`);
    expect(page).toContain(`muchi://l/${real.body.token}`);
    expect(fallbackPage(DEFAULT_LINKS, '<script>', { ios: null, android: null })).not.toContain('<script>');
    expect((await w.call('x', '/.well-known/apple-app-site-association')).status).toBe(404);
    const cfg = { ...DEFAULT_LINKS, apple: { appIds: ['TEAMID1234.com.example.muchi'] }, android: { packageName: 'com.example.muchi', sha256CertFingerprints: ['AA'] } };
    expect(appleAssociation(cfg)!.applinks.details[0]).toMatchObject({ appID: 'TEAMID1234.com.example.muchi', paths: ['/l/*'] });
    expect(androidAssetLinks(cfg)![0]!.target.package_name).toBe('com.example.muchi');
  });

  it('KPI rows carry only types and outcomes; no new PlayerState key; account deletion forgets the links', async () => {
    const w = setup();
    const r = await w.create('host', 'room', { passphrase: '123456' });
    await w.create('host', 'room', { passphrase: '123456' });
    await w.resolve('guest', r.body.token);
    await w.resolve('guest', makeToken('x'));
    await w.call('host', `/v1/links/${r.body.token}`, { method: 'DELETE' });
    const rows = w.kpi.map((k) => [k.rec.name, k.rec.s1, k.rec.s2 ?? null]);
    expect(rows).toEqual(expect.arrayContaining([['link_create', 'room', 'new'], ['link_create', 'room', 'existing'], ['link_resolve', 'room', 'ok'], ['link_resolve', 'none', 'unavailable'], ['link_revoke', 'room', null]]));
    expect(JSON.stringify(w.kpi)).not.toContain(r.body.token);
    expect(JSON.stringify(w.kpi)).not.toContain('123456');
    for (const id of ['host', 'guest']) {
      const s = await w.repo.get(id);
      if (s) for (const k of Object.keys(s)) expect(classifyKey(k)).not.toBeNull();
      expect(s && 'links' in s).toBeFalsy();
    }
  });

  it('English: share texts and the block line are translated, nothing Japanese is left', async () => {
    const w = setup();
    const r = await w.create('host', 'room', { passphrase: '123456' }, { lang: 'en' });
    expect(r.body.shareText).toBe(`Join my friend room in Muchi Issen\n${r.body.url}`);
    expect(untranslated((await w.call('host', '/v1/blocks', { lang: 'en' })).body)).toEqual([]);
    const cat = catalogFor(m);
    for (const t of LINK_TYPES) expect(translateText(`${SHARE_TEXT[t]}\nhttps://x.example/l/abc`, cat)).not.toMatch(/[ぁ-んァ-ン一-龯]/);
    expect(BLOCK_EFFECTS.links).toBeTruthy();
    expect(untranslated((await w.create('host', 'friend', {}, { lang: 'en' })).body)).toEqual([]);
  });
});

// ------------------------------------------------------------------------------------------------ rematch

const RULES = { windowSec: 20, offerMinutes: 15 };
const free = { isFree: () => true, mayHost: () => true };
const cond = { trackId: 'aoba_turf_1600', going: 'good' } as never;

describe('rematch (REQ-LINK-014..018)', () => {
  it('everyone who presses within the window goes into a new room on the same conditions; all pressed → settles at once', () => {
    const r = new Rematches<string>();
    r.offer('r1', 'a', ['a', 'b', 'c'], cond, NOW);
    expect(() => r.press('r1', 'x', 'e', [], NOW, RULES)).toThrow(AppError); // not a racer
    expect(() => r.press('nope', 'a', 'e', [], NOW, RULES)).toThrow(AppError);
    expect(r.press('r1', 'b', 'eb', [], NOW + 1000, RULES)).toBe(false);
    expect(r.view('r1', 'b', NOW + 1000, RULES)).toMatchObject({ state: 'waiting', you: 'pressed', pressed: 1, eligible: 3, deadlineAt: NOW + 21_000 });
    expect(r.view('r1', 'c', NOW + 1000, RULES).you).toBe('none');
    expect(r.press('r1', 'b', 'eb2', [], NOW + 2000, RULES)).toBe(false); // double press: same entry slot, horse chosen again
    expect(r.offers.get('r1')!.presses).toHaveLength(1);
    expect(r.press('r1', 'a', 'ea', [], NOW + 3000, RULES)).toBe(false);
    expect(r.press('r1', 'c', 'ec', [], NOW + 4000, RULES)).toBe(true); // everyone in
    const plan = r.plan('r1', free)!;
    expect(plan.hostId).toBe('a'); // the previous host
    expect(plan.members.map((x) => [x.playerId, x.entry])).toEqual([['a', 'ea'], ['b', 'eb2'], ['c', 'ec']]);
    r.settle('r1', NOW + 4000, { passphrase: '654321', hostId: 'a', members: ['a', 'b', 'c'] });
    expect(r.view('r1', 'c', NOW + 4000, RULES)).toMatchObject({ state: 'opened', room: { passphrase: '654321', members: 3, host: false } });
    expect(r.view('r1', 'a', NOW + 4000, RULES).room!.host).toBe(true);
    expect(r.offers.get('r1')!.conditions).toEqual(cond);
  });

  it('the window closes after N seconds: late presses are out; fewer than two → too_few', () => {
    const r = new Rematches<string>();
    r.offer('r1', 'a', ['a', 'b', 'c'], null, NOW);
    r.press('r1', 'a', 'ea', [], NOW, RULES);
    expect(r.dueIds(NOW + 19_999)).toEqual([]);
    expect(r.nextWake()).toBe(NOW + 20_000);
    expect(r.press('r1', 'b', 'eb', [], NOW + 20_000, RULES)).toBe(true); // too late: does not count, but the offer is due
    expect(r.offers.get('r1')!.presses.map((p) => p.playerId)).toEqual(['a']);
    expect(r.plan('r1', free)).toBeNull();
    r.settle('r1', NOW + 20_000, null);
    expect(r.view('r1', 'a', NOW + 20_000, RULES)).toMatchObject({ state: 'closed', reason: 'too_few', room: null });
    expect(r.view('r1', 'b', NOW + 20_000, RULES)).toMatchObject({ state: 'closed', reason: 'too_few' });
    expect(r.press('r1', 'c', 'ec', [], NOW + 21_000, RULES)).toBe(false); // after the outcome: nothing changes
    expect(r.view('r1', 'c', NOW + 21_000, RULES).state).toBe('closed');
  });

  it('blocks (either way, press order), busy players, decline; the host falls back to the first one in who may host', () => {
    const r = new Rematches<string>();
    r.offer('r1', 'a', ['a', 'b', 'c', 'd', 'e', 'f'], null, NOW); // f never presses
    r.press('r1', 'b', 'eb', [], NOW, RULES);
    r.press('r1', 'c', 'ec', ['b'], NOW + 1, RULES); // c blocks b: c is out (b pressed first)
    r.press('r1', 'd', 'ed', [], NOW + 2, RULES);
    r.press('r1', 'e', 'ee', [], NOW + 3, RULES);
    r.press('r1', 'a', 'ea', [], NOW + 4, RULES);
    expect(r.decline('r1', 'e', NOW + 5)).toBe(false);
    expect(r.view('r1', 'e', NOW + 5, RULES)).toMatchObject({ you: 'declined', eligible: 5 });
    const plan = r.plan('r1', { isFree: (p) => p !== 'd', mayHost: (p) => p !== 'a' })!; // d is racing elsewhere, a already hosts a room
    expect(plan.hostId).toBe('b');
    expect(plan.members.map((x) => x.playerId)).toEqual(['b', 'a']);
    r.settle('r1', NOW + 30_000, { passphrase: '111111', hostId: 'b', members: ['b', 'a'] });
    for (const p of ['c', 'd']) expect(r.view('r1', p, NOW + 30_000, RULES)).toMatchObject({ state: 'closed', reason: 'not_included' });
    expect(JSON.stringify(r.toJSON())).not.toContain('"ea"'); // entries are dropped once settled
  });

  it('an offer nobody pressed expires; old offers are pruned; offers survive the matchmaker restart (rows)', () => {
    const r = new Rematches<string>();
    r.offer('r1', 'a', ['a', 'b'], null, NOW);
    r.offer('r1', 'z', ['z'], null, NOW); // a second offer for the same race is ignored
    expect(r.offers.get('r1')!.hostId).toBe('a');
    expect(r.view('r1', 'a', NOW + 15 * MIN, RULES)).toMatchObject({ state: 'closed', reason: 'expired' });
    expect(r.press('r1', 'a', 'ea', [], NOW + 15 * MIN, RULES)).toBe(false);
    const back = Rematches.fromJSON<string>(JSON.parse(JSON.stringify(r.toJSON())));
    expect(back.view('r1', 'b', NOW, RULES).state).toBe('waiting');
    back.prune(NOW + 15 * MIN, RULES);
    expect(back.offers.size).toBe(0);
  });

  it('the rematch room: members already in, the snapshot conditions, one open room per host, the usual lifetime and start rules', () => {
    const f = new FriendRooms<string>();
    const rng = seededRng(7);
    const room = f.createWith('a', [{ playerId: 'a', payload: 'ea' }, { playerId: 'b', payload: 'eb' }], cond, 'r1', NOW, rng);
    expect(room).toMatchObject({ hostId: 'a', conditions: cond, rematchOf: 'r1' });
    expect(room.passphrase).toMatch(/^\d{6}$/);
    expect(f.isOpen(room.passphrase, NOW)).toBe(true);
    expect(() => f.createWith('a', [{ playerId: 'a', payload: 'ea' }], null, 'r2', NOW, rng)).toThrow(AppError);
    expect(f.start(room.passphrase, 'a', NOW).members.map((x) => x.playerId)).toEqual(['a', 'b']);
    const r2 = f.createWith('c', [{ playerId: 'c', payload: 'ec' }, { playerId: 'd', payload: 'ed' }], null, 'r3', NOW, rng);
    expect(f.isOpen(r2.passphrase, NOW + 31 * MIN)).toBe(false); // 30 minutes like any friend room
  });

  it('over HTTP: the rematch routes are in group ranked, press passes the race entry and the block list, KPI rows; absent → 404', async () => {
    const w = setup();
    const seen: unknown[] = [];
    const result = (state: 'waiting' | 'opened', settled: RematchResult['settled']): RematchResult => ({
      view: { raceId: 'r-9', state, reason: null, you: 'pressed', pressed: 2, eligible: 2, windowSec: 20, deadlineAt: NOW + 20_000, room: state === 'opened' ? { passphrase: '222222', members: 2, host: true } : null }, settled,
    });
    expect((await w.call('host', '/v1/friend-rooms/rematch/r-9')).body.error.code).toBe('NOT_FOUND');
    (w.c.match as unknown as Record<string, unknown>).rematchPress = async (...a: unknown[]) => { seen.push(a); return result('opened', { opened: true, members: 2 }); };
    (w.c.match as unknown as Record<string, unknown>).rematchStatus = async () => result('waiting', null);
    (w.c.match as unknown as Record<string, unknown>).rematchDecline = async () => result('waiting', null);
    expect(endpointGroup('/v1/friend-rooms/rematch/r-9')).toBe('ranked');
    await w.svc.bootstrap('host'); await w.svc.grantPartner('host', 'アイボウ', 'c:rm');
    const horseId = (await w.svc.view('host') as { horses?: { id: string }[] }).horses?.[0]?.id;
    expect(horseId).toBeTruthy();
    if (horseId) {
      await w.svc.blockSet('host', 'troll', true, 'blocks');
      const p = await w.call('host', '/v1/friend-rooms/rematch/r-9', { method: 'POST', body: { horseId } });
      expect(p.body).toMatchObject({ state: 'opened', room: { passphrase: '222222' } });
      expect((seen[0] as unknown[])[0]).toBe('r-9');
      expect((seen[0] as unknown[])[3]).toEqual(['troll']);
      expect(w.kpi.filter((k) => k.rec.name === 'rematch').map((k) => [k.rec.s1, k.rec.count ?? 0])).toEqual([['press', 0], ['opened', 2]]);
    }
    expect((await w.call('host', '/v1/friend-rooms/rematch/r-9')).body.state).toBe('waiting');
    expect((await w.call('host', '/v1/friend-rooms/rematch/r-9', { method: 'DELETE' })).status).toBe(200);
    expect((await w.call('host', '/v1/friend-rooms/rematch/bad%20id')).body.error.code).toBe('NOT_FOUND');
  });
});
