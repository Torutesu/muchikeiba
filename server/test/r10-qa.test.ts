// Round 10 QA (fix/r10-qa): regressions found reviewing claude/round10 on top of round 9.
import { describe, expect, it } from 'vitest';
import { m } from './helpers.js';
import { MemoryPlayerRepo, PlayerService } from '../src/domain/service.js';
import { seededRng } from '../src/domain/rng.js';
import { AppError } from '../src/domain/errors.js';
import { MemoryDirectory } from '../src/domain/friends.js';
import { MemoryTeams, TeamsService } from '../src/domain/teamService.js';
import { hashInstallId, InviteService, MemoryInviteDirectory } from '../src/domain/invite.js';
import { handle, invitePlayersFrom, makeFriendsService, rawQuery, teamPlayersFrom, type AppContext, type PlayerInvoker } from '../src/http/app.js';
import { runAccountDeletion, type DeletionPorts } from '../src/domain/accountDeletion.js';
import { RemoteKeySource, signAdMobQuery, StaticKeySource } from '../src/ads/ssv.js';
import type { AdCallback } from '../src/domain/ads.js';
import type { PlayerState } from '../src/domain/player.js';

const DAY = 86_400_000;

function world() {
  let t = Date.UTC(2026, 11, 10, 3);
  const clock = () => t;
  const repo = new MemoryPlayerRepo();
  const teams = new MemoryTeams(() => m, clock);
  const svc = new PlayerService(repo, {
    master: m, rng: seededRng(7), clock, verifiers: {},
    onTeamPoints: async (p) => { await teams.reportPoints(p.teamId, p.playerId, p.seasonId, p.points, p.displayName); },
    onTeamFeed: async (p) => { await teams.feedRace(p.teamId, p.playerId, p.race); },
  });
  const invoker: PlayerInvoker = { invoke: (async (method: string, ...args: unknown[]) => (svc as unknown as Record<string, (...a: unknown[]) => unknown>)[method]!.apply(svc, args)) as PlayerInvoker['invoke'] };
  const ts = new TeamsService(() => m, teams, teamPlayersFrom(() => invoker), teams, teams, seededRng(9), clock);
  let race = 0;
  const ranked = (u: string, place = 5) => svc.applyRace(u, { raceId: `r${race++}`, mode: 'ranked', place, fieldSize: 12, newRating: null, void: false, humans: 2 } as never);
  return { svc, repo, teams, ts, invoker, ranked, now: clock, advance: (ms: number) => { t += ms; } };
}

describe('r10 QA: an SSV callback never creates (or resurrects) a player', () => {
  const cb = (userId: string): AdCallback => ({ network: 'admob', transactionId: 'tx-ghost', userId, customData: 'ad_00000000deadbeef', adUnit: 'u', timestamp: Date.UTC(2026, 11, 10, 3), rewardAmount: 1, rewardItem: 'r' });
  it('unknown player id: rejected, no state written', async () => {
    const w = world();
    expect(await w.svc.adReward('nobody', cb('nobody'))).toMatchObject({ status: 'rejected', reason: 'unknown_session' });
    expect(w.repo.get('nobody')).toBeNull();
  });
  it('a wiped (deleted) player stays wiped, so a later race result is still a no-op (tombstone)', async () => {
    const w = world();
    await w.svc.bootstrap('gone');
    await w.svc.wipe('gone');
    expect(await w.svc.adReward('gone', cb('gone'))).toMatchObject({ status: 'rejected' });
    expect(w.repo.get('gone')).toBeNull();
    expect(await w.ranked('gone')).toMatchObject({ skipped: 'deleted' });
  });
});

describe('r10 QA: the SSV route rate-limits failed callbacks per IP, not the ad network\'s valid ones', () => {
  it('valid callbacks from one IP are never counted against that IP', async () => {
    const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
    const w = world();
    const admitted: string[] = [];
    const c = {
      master: m, authenticate: async () => { throw new AppError('UNAUTHORIZED'); }, player: () => w.invoker,
      friends: makeFriendsService(() => w.invoker, new MemoryDirectory()), clock: w.now, paidBalance: async () => ({}),
      ads: { keys: StaticKeySource.fromCryptoKeys({ '1': kp.publicKey }), admit: (k: string) => { admitted.push(k); } },
    } as unknown as AppContext;
    await w.svc.bootstrap('u');
    const q = await signAdMobQuery({ adUnit: 'x', customData: 'ad_0000000000000000', timestamp: w.now(), transactionId: 'T1', userId: 'u', keyId: '1' }, kp.privateKey);
    const res = await handle(new Request('https://x/v1/ads/ssv/admob?' + q, { headers: { 'cf-connecting-ip': '203.0.113.9' } }), {}, c);
    expect(res.status).toBe(200);
    expect(admitted.filter((k) => k.startsWith('ip:'))).toEqual([]);
    expect(admitted).toEqual(['u:u']);
    const bad = await handle(new Request('https://x/v1/ads/ssv/admob?' + q.replace('user_id=u', 'user_id=v'), { headers: { 'cf-connecting-ip': '203.0.113.9' } }), {}, c);
    expect(bad.status).toBe(401);
    expect(admitted).toContain('ip:203.0.113.9');
  });
});

describe('r10 QA: team feed race items leave former teams on deletion', () => {
  it('a member with only a race item (no stamp) in a former team is removed from that feed too', async () => {
    const w = world();
    for (const id of ['lead', 'gone', 'b', 'lead2']) await w.svc.bootstrap(id);
    const t1 = (await w.ts.create('lead', 'あおばRC', 'open', '')).teamId;
    await w.ts.join('gone', t1);
    await w.ts.join('b', t1);
    await w.ranked('gone', 1); // automatic race item, no stamp posted
    expect((await w.ts.feed('b', null, null)).items.map((x) => x.playerId)).toEqual(['gone']);
    await w.ts.leave('gone');
    w.advance(2 * DAY);
    const t2 = (await w.ts.create('lead2', 'みどりRC', 'open', '')).teamId;
    await w.ts.join('gone', t2);
    expect((await w.svc.deletionSnapshot('gone')).feedTeams?.sort()).toEqual([t1, t2].sort());
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
        leave: (tid, u) => w.teams.leave(tid, u), transfer: (tid, u, to) => w.teams.transfer(tid, u, to),
        dropRequest: (tid, u) => w.teams.dropRequest(tid, u), forgetFeed: (tid, u) => w.teams.feedForget(tid, u),
      },
      directory: { forget: async () => undefined },
      leaderboards: { forget: async () => undefined, deleteGhosts: async () => undefined },
      finalize: (u) => w.svc.deletionFinalize(u), retain: async () => undefined, wipe: (u) => w.svc.wipe(u),
    };
    await runAccountDeletion(ports, 'gone', w.now());
    expect((await w.ts.feed('b', null, null)).items).toEqual([]);
  });
});

describe('r10 QA: a failed concurrent redemption never frees the device claim of a successful one', () => {
  it('two codes entered at once on one device: one succeeds, the device stays claimed', async () => {
    const w = world();
    const dir = new MemoryDirectory();
    const codes = new MemoryInviteDirectory(seededRng(3));
    // the two requests interleave like two Durable Object RPC chains: both pass the attempt and the inviter step
    // before either invitee commit runs
    const ports = invitePlayersFrom(() => w.invoker);
    let accepted = 0;
    let bothAccepted!: () => void;
    const gate = new Promise<void>((ok) => { bothAccepted = ok; });
    let chain: Promise<unknown> = Promise.resolve();
    const inv = new InviteService({
      ...ports,
      accept: async (...a) => { const r = await ports.accept(...a); if (++accepted === 2) bothAccepted(); return r; },
      // one player object runs one call at a time (the Durable Object's input gate)
      commit: async (...a) => { await gate; const p = chain.then(() => ports.commit(...a)); chain = p.catch(() => undefined); return p; },
    }, codes, dir, () => m);
    let k = 0;
    for (const id of ['a1', 'a2', 'n', 'n2']) {
      await w.svc.bootstrap(id);
      await w.svc.grantPartner(id, 'アオゾラ', `c:p:${k++}`);
    }
    const [c1, c2] = [(await inv.view('a1', null)).code, (await inv.view('a2', null)).code];
    const r = await Promise.allSettled([inv.redeem('n', c1, 'inst-race-0001'), inv.redeem('n', c2, 'inst-race-0001')]);
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    const h = await hashInstallId('inst-race-0001');
    expect(await codes.claimInstall(h, 'n2')).toBe('n'); // still n's: a second account on the device is refused
    expect((w.repo.get('n') as PlayerState).referral?.invitedBy).toBeTruthy();
  });
});

describe('r10 QA: the SSV callback re-checks eligibility at reward time (REQ-AD-001/006)', () => {
  /** A veteran with an open session on the home placement; `change` runs between the start and the callback. */
  async function midAd(change: (w: ReturnType<typeof world>) => Promise<unknown>) {
    const w = world();
    await w.svc.bootstrap('p');
    for (let i = 0; i < 3; i++) await w.ranked('p');
    w.advance(DAY);
    const st = await w.svc.adStart('p', 'daily_coins', 'c:ad:1');
    await change(w);
    const free = (w.repo.get('p') as PlayerState).wallet.free;
    const out = await w.svc.adReward('p', { network: 'admob', transactionId: 'T-mid', userId: 'p', customData: st.customData, adUnit: 'u', timestamp: w.now(), rewardAmount: 1, rewardItem: 'r' });
    return { out, gained: (w.repo.get('p') as PlayerState).wallet.free - free };
  }
  it('opted out mid-ad (pref off): rejected, nothing granted', async () => {
    const r = await midAd((w) => w.svc.setAdPref('p', 'off'));
    expect(r.out).toMatchObject({ status: 'rejected', reason: 'opted_out' });
    expect(r.gained).toBe(0);
  });
  it('registered an age under 13 mid-ad: rejected', async () => {
    const r = await midAd((w) => w.svc.setAge('p', 2016, 1, true));
    expect(r.out).toMatchObject({ status: 'rejected', reason: 'age' });
    expect(r.gained).toBe(0);
  });
  it('banned mid-ad: rejected', async () => {
    const r = await midAd((w) => w.svc.setModeration('p', 'banned', null, 'cheat'));
    expect(r.out).toMatchObject({ status: 'rejected', reason: 'moderation' });
    expect(r.gained).toBe(0);
  });
  it('deletion scheduled mid-ad: rejected', async () => {
    const r = await midAd(async (w) => { const t = (await w.svc.requestDeletion('p', null)) as { confirmToken: string }; await w.svc.requestDeletion('p', t.confirmToken); });
    expect(r.out).toMatchObject({ status: 'rejected', reason: 'deleting' });
    expect(r.gained).toBe(0);
  });
  it('control: nothing changed → rewarded', async () => {
    const r = await midAd(async () => undefined);
    expect(r.out).toMatchObject({ status: 'rewarded' });
    expect(r.gained).toBe(10);
  });
});

describe('r10 QA: a failed key refresh after the cache expired falls back to the last good set (bounded)', () => {
  it('serves the stale set up to maxStaleMs, reports it, then fails; recovers when the URL answers', async () => {
    const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
    const spki = new Uint8Array(await crypto.subtle.exportKey('spki', kp.publicKey) as ArrayBuffer);
    const pem = `-----BEGIN PUBLIC KEY-----\n${btoa(String.fromCharCode(...spki))}\n-----END PUBLIC KEY-----`;
    let now = 0, up = true;
    const stale: number[] = [];
    const src = new RemoteKeySource({
      url: 'https://keys.example.invalid/k.json', clock: () => now, maxStaleMs: 7 * DAY, onStale: (ageMs) => { stale.push(ageMs); },
      fetch: async () => { if (!up) throw new Error('network down'); return { ok: true, json: async () => ({ keys: [{ keyId: 7, pem }] }) }; },
    });
    expect(await src.get('7')).not.toBeNull();
    up = false;
    now = 2 * DAY; // past the 24 h cache lifetime; the refresh fails
    expect(await src.get('7')).not.toBeNull();
    expect(stale[0]).toBe(2 * DAY);
    now = 8 * DAY; // older than maxStaleMs: no longer trusted
    await expect(src.get('7')).rejects.toThrow();
    up = true;
    now += 61_000;
    expect(await src.get('7')).not.toBeNull();
  });
});

describe('r10 QA: the SSV route verifies the raw query string', () => {
  it('takes the query exactly as received (no URL re-serialisation)', () => {
    expect(rawQuery("https://x/v1/ads/ssv/admob?a=1&b=%7E&c='x'&signature=s&key_id=1")).toBe("a=1&b=%7E&c='x'&signature=s&key_id=1");
    expect(new URL("https://x/p?c='x'").search).not.toBe("?c='x'"); // what URL normalisation would have changed
    expect(rawQuery('https://x/p')).toBe('');
    expect(rawQuery('https://x/p?a=1#frag')).toBe('a=1');
  });
});
