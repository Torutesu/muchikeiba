import { describe, expect, it } from 'vitest';
import { friendCode, FriendsService, MemoryDirectory, shardOf, shardOfCode, DIRECTORY_SHARDS, type FriendPlayers } from '../src/domain/friends.js';
import { MemoryPlayerRepo, PlayerService } from '../src/domain/service.js';
import { seededRng } from '../src/domain/rng.js';
import { AppError } from '../src/domain/errors.js';
import { applyStats, evaluateTitles, equipTitle, raceDetailsFor, validateDisplayName, type RaceDetails } from '../src/domain/stats.js';
import { CMD } from '../src/domain/raceRoom.js';
import type { PublicProfile } from '../src/domain/stats.js';
import { freshPlayer, m, makeConfig } from './helpers.js';

const code = async (p: Promise<unknown>) => { try { await p; return 'ok'; } catch (e) { return (e as AppError).code; } };

function world(now = Date.UTC(2026, 10, 5, 3)) {
  let t = now;
  const profiles: PublicProfile[] = [];
  const svc = new PlayerService(new MemoryPlayerRepo(), { master: m, rng: seededRng(9), clock: () => t, verifiers: {}, onProfile: (p) => { profiles.push(p); } });
  const dir = new MemoryDirectory();
  const ports: FriendPlayers = {
    send: (u, x) => svc.friendSend(u, x), receive: (u, x) => svc.friendReceive(u, x), accept: (u, x) => svc.friendAccept(u, x),
    accepted: (u, x) => svc.friendAccepted(u, x), decline: (u, x) => svc.friendDecline(u, x), cancel: (u, x) => svc.friendCancel(u, x),
    remove: (u, x) => svc.friendRemove(u, x), invite: (u, f, p) => svc.friendInvite(u, f, p), friendsState: (u) => svc.friendsState(u),
  };
  const fs = new FriendsService(ports, dir);
  return { svc, dir, fs, profiles, advance: (ms: number) => { t += ms; }, now: () => t };
}

describe('friend codes (REQ-SOCIAL-001)', () => {
  it('are 9 digits, carry their shard, and never collide within a shard', () => {
    const seen = new Set<string>();
    for (let seq = 0; seq < 20000; seq++) {
      const c = friendCode(7, seq);
      expect(c).toMatch(/^07\d{7}$/);
      expect(seen.has(c)).toBe(false);
      seen.add(c);
    }
    expect(shardOfCode(friendCode(15, 3))).toBe(15);
    expect(shardOfCode('16xxxxxxx')).toBeNull();
    expect(shardOfCode('990000000')).toBeNull();
    expect(friendCode(0, 0)).not.toBe('000000000'); // sequence order is not visible in the code
  });
  it('shards player ids stably across the whole range', () => {
    const counts = new Array(DIRECTORY_SHARDS).fill(0);
    for (let i = 0; i < 4000; i++) counts[shardOf(`player_${i}`)]++;
    expect(Math.min(...counts)).toBeGreaterThan(150);
    expect(shardOf('abc')).toBe(shardOf('abc'));
  });
  it('the directory assigns a code once and resolves it back', async () => {
    const d = new MemoryDirectory();
    const c = await d.codeOf('u1');
    expect(await d.codeOf('u1')).toBe(c);
    expect(await d.lookup(c)).toBe('u1');
    expect(await d.lookup('000000001')).toBeNull();
  });
});

describe('friend requests (REQ-SOCIAL-002/003)', () => {
  it('request → accept makes both sides friends; list shows profiles', async () => {
    const w = world();
    await w.svc.bootstrap('alice');
    await w.svc.bootstrap('bob');
    for (const p of w.profiles) await w.dir.putProfile(p);
    const bobCode = (await w.fs.myCode('bob')).code;
    expect(await w.fs.request('alice', bobCode)).toEqual({ status: 'requested', playerId: 'bob' });
    expect((await w.svc.friendsState('bob')).incoming.map((x) => x.from)).toEqual(['alice']);
    expect((await w.svc.friendsState('alice')).outgoing.map((x) => x.to)).toEqual(['bob']);
    await w.fs.accept('bob', 'alice');
    expect((await w.svc.friendsState('alice')).ids).toEqual(['bob']);
    expect((await w.svc.friendsState('bob')).ids).toEqual(['alice']);
    expect((await w.svc.friendsState('alice')).outgoing).toEqual([]);
    const list = await w.fs.list('alice');
    expect(list.friends[0]).toMatchObject({ playerId: 'bob', displayName: expect.stringMatching(/^騎手/), classId: 'C' });
  });

  it('mutual requests become friends without an accept; duplicates are harmless', async () => {
    const w = world();
    const a = (await w.fs.myCode('alice')).code;
    const b = (await w.fs.myCode('bob')).code;
    await w.fs.request('alice', b);
    await w.fs.request('alice', b);
    expect(await w.fs.request('bob', a)).toEqual({ status: 'friends', playerId: 'alice' });
    expect((await w.svc.friendsState('alice')).ids).toEqual(['bob']);
    expect((await w.svc.friendsState('bob')).ids).toEqual(['alice']);
    expect((await w.svc.friendsState('bob')).incoming).toEqual([]);
  });

  it('decline, cancel and remove clean both sides', async () => {
    const w = world();
    const b = (await w.fs.myCode('bob')).code;
    await w.fs.request('alice', b);
    await w.fs.decline('bob', 'alice');
    expect((await w.svc.friendsState('alice')).outgoing).toEqual([]);
    expect((await w.svc.friendsState('bob')).incoming).toEqual([]);
    await w.fs.request('alice', b);
    await w.fs.cancel('alice', 'bob');
    expect((await w.svc.friendsState('bob')).incoming).toEqual([]);
    await w.fs.request('alice', b);
    await w.fs.accept('bob', 'alice');
    await w.fs.remove('bob', 'alice');
    expect((await w.svc.friendsState('alice')).ids).toEqual([]);
    expect((await w.svc.friendsState('bob')).ids).toEqual([]);
  });

  it('rejects self requests, unknown codes and accepting a request that does not exist', async () => {
    const w = world();
    const a = (await w.fs.myCode('alice')).code;
    expect(await code(w.fs.request('alice', a))).toBe('BAD_REQUEST');
    expect(await code(w.fs.request('alice', '001234567'))).toBe('NOT_FOUND');
    expect(await code(w.fs.accept('alice', 'bob'))).toBe('NOT_FOUND');
  });

  it('enforces limits: outgoing requests reserve slots; a full inbox rolls back the sender', async () => {
    const w = world();
    const { maxOutgoing, maxIncoming } = m.progression.social;
    const target = (await w.fs.myCode('popular')).code;
    for (let i = 0; i < maxIncoming; i++) await w.fs.request(`fan${i}`, target);
    expect(await code(w.fs.request('late', target))).toBe('FRIEND_LIMIT');
    expect((await w.svc.friendsState('late')).outgoing).toEqual([]); // compensated
    for (let i = 0; i < maxOutgoing; i++) await w.fs.request('eager', (await w.fs.myCode(`t${i}`)).code);
    expect(await code(w.fs.request('eager', (await w.fs.myCode('one_more')).code))).toBe('FRIEND_LIMIT');
  });

  it('friend room invites need friendship and expire', async () => {
    const w = world();
    const b = (await w.fs.myCode('bob')).code;
    expect(await code(w.fs.invite('alice', 'bob', '123456'))).toBe('NOT_ELIGIBLE');
    await w.fs.request('alice', b);
    await w.fs.accept('bob', 'alice');
    await w.fs.invite('alice', 'bob', '123456');
    expect((await w.svc.friendsState('bob')).invites).toMatchObject([{ from: 'alice', passphrase: '123456' }]);
    w.advance(m.progression.social.inviteTtlMs);
    expect((await w.svc.friendsState('bob')).invites).toEqual([]);
  });
});

describe('profile push throttling (REQ-SOCIAL-004)', () => {
  it('pushes on first touch and on change, otherwise at most every profilePushIntervalMs', async () => {
    const w = world();
    await w.svc.bootstrap('p');
    expect(w.profiles).toHaveLength(1);
    await w.svc.bootstrap('p');
    expect(w.profiles).toHaveLength(1);
    await w.svc.setDisplayName('p', 'はやての騎手');
    expect(w.profiles).toHaveLength(2);
    expect(w.profiles[1]).toMatchObject({ displayName: 'はやての騎手' });
    w.advance(m.progression.social.profilePushIntervalMs);
    await w.svc.bootstrap('p');
    expect(w.profiles).toHaveLength(3);
    expect(w.profiles[2]!.lastSeenAt).toBe(w.now());
  });
});

describe('display names (REQ-SOCIAL-006)', () => {
  it('accepts 1–12 characters of any script, rejects NG words, URLs and control characters', () => {
    expect(validateDisplayName(m, '  ＡＢＣ騎手 ')).toBe('ABC騎手');
    expect(validateDisplayName(m, 'Rider 01')).toBe('Rider 01');
    expect(() => validateDisplayName(m, '')).toThrow(AppError);
    expect(() => validateDisplayName(m, 'あ'.repeat(13))).toThrow(AppError);
    expect(() => validateDisplayName(m, 'ばか')).toThrow(/NG_NAME/);
    expect(() => validateDisplayName(m, 'だーびー王')).toThrow(/NG_NAME/);
    expect(() => validateDisplayName(m, 'see www.x.com')).toThrow(AppError);
    expect(() => validateDisplayName(m, 'a\u0007b')).toThrow(AppError);
  });
});

describe('race details from the input log (REQ-STAT-002)', () => {
  const cfg = makeConfig(2, 'ranked');
  const gate = cfg.ruleset.gateOpenTick as number;
  const win = cfg.ruleset.whipDiminishWindowTicks as number;
  const log = (inputs: [number, number, number][]) => ({ v: 1 as const, config: cfg, endTick: 2000, inputs });

  it('derives start reaction, whips, mashing and CPU assistance', () => {
    const s = cfg.entrants[0]!.slot;
    const d = raceDetailsFor(cfg, log([[gate - 5, s, CMD.START], [gate + 1, s, CMD.START], [1500, s, CMD.WHIP], [1500 + win, s, CMD.WHIP], [1500 + win + 1, s, CMD.WHIP], [1990, s, CMD.WHIP]]), s, 1900);
    expect(d).toMatchObject({ trackId: cfg.track.id, startReactionTicks: 1, whips: 3, whipMashed: true, cpuAssisted: false, finishTick: 1900 });
    const d2 = raceDetailsFor(cfg, log([[gate, s, CMD.START], [100, s, CMD.CPU_TAKEOVER]]), s, null);
    expect(d2).toMatchObject({ startReactionTicks: 0, whips: 0, cpuAssisted: true, finishTick: null });
  });
});

describe('statistics and titles (REQ-STAT-001, REQ-TITLE-*)', () => {
  const det = (o: Partial<RaceDetails> = {}): RaceDetails => ({ trackId: 'kirameki_turf_2000', style: 'sashi', finishTick: 1830, startReactionTicks: 0, whips: 4, whipMashed: false, cpuAssisted: false, ...o });

  it('accumulates stats and unlocks titles idempotently', () => {
    const s = freshPlayer();
    applyStats(s, 1, det());
    expect(evaluateTitles(m, s).sort()).toEqual(['debut', 'first_win', 'kirameki_record', 'lightning_start'].sort());
    expect(evaluateTitles(m, s)).toEqual([]);
    expect(s.stats).toMatchObject({ races: 1, wins: 1, top3: 1, whipPerfectWins: 1, perfectStarts: 1, bestStartReactionTicks: 0 });
    expect(s.stats.byTrack.kirameki_turf_2000).toEqual({ races: 1, wins: 1, bestFinishTick: 1830 });
    expect(s.stats.byStyle.sashi).toEqual({ races: 1, wins: 1 });
    for (let i = 0; i < 9; i++) applyStats(s, 1, det({ whipMashed: i % 2 === 0, startReactionTicks: 5 }));
    expect(evaluateTitles(m, s)).toEqual(expect.arrayContaining(['ten_wins', 'sashi_master', 'whip_artist']));
    expect(s.stats.whipPerfectWins).toBe(5);
    expect(s.stats.bestStartReactionTicks).toBe(0);
  });

  it('does not credit skill records for CPU-assisted rides', () => {
    const s = freshPlayer();
    applyStats(s, 1, det({ cpuAssisted: true }));
    expect(s.stats).toMatchObject({ wins: 1, whipPerfectWins: 0, perfectStarts: 0, bestStartReactionTicks: null });
    expect(s.stats.byTrack.kirameki_turf_2000!.bestFinishTick).toBeNull();
  });

  it('class titles count promotions recorded in the season history', () => {
    const s = freshPlayer();
    s.seasonHistory.push({ seasonId: '2026-10', classId: 'B', points: 500, races: 20, nextClassId: 'A', rank: 3, rewarded: true });
    expect(evaluateTitles(m, s)).toContain('class_a');
    expect(s.titles).not.toContain('class_s');
  });

  it('only unlocked titles can be equipped', async () => {
    const s = freshPlayer();
    expect(() => equipTitle(m, s, 'first_win')).toThrow(expect.objectContaining({ code: 'NOT_ELIGIBLE' }));
    expect(() => equipTitle(m, s, 'nope')).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
    s.titles.push('first_win');
    expect(equipTitle(m, s, 'first_win')).toEqual({ titleId: 'first_win' });
    expect(equipTitle(m, s, null)).toEqual({ titleId: null });
  });
});
