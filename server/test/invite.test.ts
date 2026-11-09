import { describe, expect, it } from 'vitest';
import { handle, makeFriendsService, makeInviteService, type AppContext, type PlayerInvoker } from '../src/http/app.js';
import { MemoryDirectory, DIRECTORY_SHARDS } from '../src/domain/friends.js';
import { MemoryPlayerRepo, PlayerService } from '../src/domain/service.js';
import { seededRng } from '../src/domain/rng.js';
import { AppError } from '../src/domain/errors.js';
import { runAccountDeletion, type DeletionPorts } from '../src/domain/accountDeletion.js';
import {
  INVITE_ALPHABET, INVITE_BLOCKLIST, INVITE_HARD_LIMITS, MemoryInviteDirectory, deliverInviteOutbox, displayInviteCode, hashInstallId, inviteProblems,
  inviteRewardYen, inviteShardOf, makeInviteCode, normalizeInviteCode, worstYenPerCoin,
} from '../src/domain/invite.js';
import { clientBatchSchema } from '../src/domain/kpi.js';
import type { KpiRecord } from '../src/domain/kpi.js';
import type { PlayerState } from '../src/domain/player.js';
import { m } from './helpers.js';

const DAY = 86_400_000;

function world() {
  let t = Date.UTC(2026, 10, 5, 3);
  const repo = new MemoryPlayerRepo();
  const kpi: { id: string; r: KpiRecord }[] = [];
  const svc = new PlayerService(repo, { master: m, rng: seededRng(5), clock: () => t, verifiers: {}, onKpi: (id, recs) => { for (const r of recs) kpi.push({ id, r }); } });
  const invoker: PlayerInvoker = { invoke: (async (method: string, ...args: unknown[]) => (svc as unknown as Record<string, (...a: unknown[]) => unknown>)[method]!.apply(svc, args)) as PlayerInvoker['invoke'] };
  const dir = new MemoryDirectory();
  const codes = new MemoryInviteDirectory(seededRng(9));
  const invite = makeInviteService(() => invoker, codes, dir, () => m);
  const ctx = {
    master: m,
    authenticate: async (req: Request) => {
      const u = req.headers.get('x-test-user');
      if (!u) throw new AppError('UNAUTHORIZED');
      return u;
    },
    player: () => invoker,
    friends: makeFriendsService(() => invoker, dir),
    invite,
    clock: () => t,
  } as unknown as AppContext;
  const call = async (method: string, path: string, o: { user?: string; body?: unknown; install?: string } = {}) => {
    const res = await handle(new Request(`https://x${path}`, {
      method, headers: { 'content-type': 'application/json', ...(o.user ? { 'x-test-user': o.user } : {}), ...(o.install ? { 'x-install-id': o.install } : {}) },
      ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}),
    }), {}, ctx);
    return { status: res.status, body: (await res.json()) as any };
  };
  let k = 0;
  /** A player through the FTUE (bootstrap + partner horse) with a public profile. */
  const newbie = async (id: string) => {
    await svc.bootstrap(id);
    await svc.grantPartner(id, 'アオゾラ', `c:p:${k++}`);
    await dir.putProfile({ playerId: id, displayName: `name_${id}` } as never);
  };
  const state = (id: string) => JSON.parse(repo.data.get(id)!) as PlayerState;
  const put = (s: PlayerState) => repo.data.set(s.id, JSON.stringify(s));
  const deliver = (id: string) => deliverInviteOutbox({
    due: (u) => svc.inviteDue(u),
    deliver: (o, i, ms, name) => svc.inviteMilestone(o, i, ms, name),
    acked: (u, x) => svc.inviteAcked(u, x),
    later: (u, x) => svc.inviteRetryLater(u, x),
  }, id);
  return { svc, repo, dir, codes, invite, call, newbie, state, put, deliver, kpi, advance: (ms: number) => { t += ms; }, now: () => t };
}

describe('invite codes (REQ-INV-001)', () => {
  it('8 symbols from the vowel-free alphabet, shard first, check symbol last, no blocked runs, unique', async () => {
    expect(INVITE_ALPHABET).not.toMatch(/[AEIOUY01L]/);
    const rng = seededRng(1);
    const seen = new Set<string>();
    let blocked = 0;
    for (let i = 0; i < 20_000; i++) {
      const shard = i % DIRECTORY_SHARDS;
      const c = makeInviteCode(shard, rng);
      if (!c) { blocked++; continue; }
      expect(c).toMatch(new RegExp(`^[${INVITE_ALPHABET}]{8}$`));
      expect(inviteShardOf(c)).toBe(shard);
      expect(normalizeInviteCode(c)).toBe(c);
      for (const w of INVITE_BLOCKLIST) expect(c.includes(w)).toBe(false);
      seen.add(c);
    }
    expect(blocked).toBeLessThan(4000); // the blocklist costs well under a fifth of the space
    expect(seen.size).toBeGreaterThan(20_000 - blocked - 3); // 27^6 per shard: collisions are rare (and retried by the directory)
  });

  it('normalises input and catches typos with the check symbol', () => {
    const c = makeInviteCode(3, seededRng(2)) ?? makeInviteCode(3, seededRng(3))!;
    expect(normalizeInviteCode(displayInviteCode(c).toLowerCase())).toBe(c);
    expect(normalizeInviteCode(` ${c.slice(0, 4)} ${c.slice(4)} `)).toBe(c);
    const typo = c.slice(0, 3) + (c[3] === 'B' ? 'C' : 'B') + c.slice(4);
    expect(normalizeInviteCode(typo)).toBeNull();
    expect(normalizeInviteCode('ABCDEFGH')).toBeNull();
    expect(normalizeInviteCode(c.slice(0, 7))).toBeNull();
  });

  it('the directory hands out one stable code per player and retires it on deletion (never reused)', async () => {
    const d = new MemoryInviteDirectory(seededRng(4));
    const a = await d.codeOf('alice');
    expect(await d.codeOf('alice')).toBe(a);
    expect(await d.lookup(a)).toBe('alice');
    await d.retire('alice');
    expect(await d.lookup(a)).toBeNull();
    expect(d.codes.get(a)).toEqual({ playerId: null, retired: true });
    expect(await d.codeOf('alice')).not.toBe(a);
  });

  it('install ids are stored only as a hash', async () => {
    const h = await hashInstallId('install-123456');
    expect(h).toMatch(/^[0-9a-f]{32}$/);
    expect(h).not.toContain('123456');
  });
});

describe('legal ceiling of invite rewards (景品表示法 総付景品, REQ-INV-009)', () => {
  it('every configured reward is free and worth at most ¥200 at the worst coin price', () => {
    const c = m.progression.invite!;
    expect(inviteProblems(m)).toEqual([]);
    expect(worstYenPerCoin(m)).toBeCloseTo(1.6, 5); // coin_160: ¥160 / 100 coins
    for (const r of [c.welcomeGift, ...c.milestones.map((d) => d.reward)]) {
      const yen = inviteRewardYen(m, r)!;
      expect(yen).not.toBeNull();
      expect(yen).toBeLessThanOrEqual(INVITE_HARD_LIMITS.maxRewardYen);
      expect(JSON.stringify(r)).not.toMatch(/paid/i);
    }
    // the inviter's lifetime maximum (documented in docs/planning/03-legal-risk.md)
    const perInvitee = c.milestones.reduce((a, d) => a + inviteRewardYen(m, d.reward)!, 0);
    expect(perInvitee * c.maxCountedInvitees).toBe(2560);
  });

  it('remote config cannot raise a reward above the ceiling, give horses or SR+ tickets, or lift the cap past the hard limit', () => {
    const base = m.progression.invite!;
    const with_ = (inv: unknown) => inviteProblems({ ...m, progression: { ...m.progression, invite: inv as never } });
    expect(with_({ ...base, welcomeGift: { freeCoins: 150 } }).join()).toMatch(/above the ¥200/);
    expect(with_({ ...base, welcomeGift: { freeCoins: 125 } })).toEqual([]);
    expect(with_({ ...base, welcomeGift: { items: [{ itemId: 'gacha_ticket_10', qty: 1 }] } }).join()).toMatch(/above the ¥200/);
    expect(with_({ ...base, welcomeGift: { items: [{ itemId: 'ticket_sr_plus', qty: 1 }] } }).join()).toMatch(/only free coins/);
    expect(with_({ ...base, welcomeGift: { horse: 'x' } }).join()).toMatch(/welcomeGift/);
    expect(with_({ ...base, maxCountedInvitees: 21 }).join()).toMatch(/maxCountedInvitees/);
    expect(with_({ ...base, milestones: [{ id: 'x', kind: 'class', classId: 'C', reward: { freeCoins: 10 } }] }).join()).toMatch(/starting class/);
    expect(with_({ ...base, milestones: [{ id: 'x', kind: 'purchase', reward: { freeCoins: 10 } }] }).join()).toMatch(/kind/);
  });
});

describe('redeeming a code (REQ-INV-002..006)', () => {
  it('after the FTUE: welcome gift, both become friends, both sides recorded, KPI rows, share links', async () => {
    const w = world();
    await w.newbie('alice');
    const mine = (await w.call('GET', '/v1/invite', { user: 'alice', install: 'inst-alice-0001' })).body;
    expect(mine.code).toMatch(/^[2-9B-Z]{8}$/);
    expect(mine.displayCode).toBe(`${mine.code.slice(0, 4)}-${mine.code.slice(4)}`);
    expect(mine.share.deepLink).toBe(`muchi://invite/${mine.code}`);
    expect(mine.share.url).toBe(`https://invite.muchi-issen.example/i/${mine.code}`);
    expect(mine.share.text).toContain(mine.displayCode);
    expect(mine.share.text).not.toMatch(/コイン|無料|¥|円/); // no reward amounts in the share text
    expect(mine).toMatchObject({ counted: 0, cap: 10, termsKey: 'terms.invite', invitees: [] });
    expect(mine.milestones.map((x: { id: string }) => x.id)).toEqual(['im_graduate', 'im_class_a', 'im_class_s']);

    await w.newbie('bob');
    const tickets = w.state('bob').items.gacha_ticket ?? 0;
    const aliceBefore = w.state('alice');
    const r = await w.call('POST', '/v1/invite/redeem', { user: 'bob', body: { code: mine.displayCode.toLowerCase(), installId: 'inst-bob-0001' } });
    expect(r.body).toEqual({ status: 'redeemed', inviter: { playerId: 'alice', displayName: 'name_alice' }, welcomeGift: { items: [{ itemId: 'gacha_ticket', qty: 1 }] }, friended: true });
    expect(w.state('bob').items.gacha_ticket).toBe(tickets + 1);
    expect(w.state('bob').friends.ids).toEqual(['alice']);
    expect(w.state('alice').friends.ids).toEqual(['bob']);
    expect(w.state('alice').wallet).toEqual(aliceBefore.wallet); // nothing paid to the inviter for an install
    expect(w.state('alice').items).toEqual(aliceBefore.items);
    expect(w.state('alice').ledger.filter((e) => e.reason.startsWith('invite'))).toEqual([]);
    const after = (await w.call('GET', '/v1/invite', { user: 'alice' })).body;
    expect(after.invitees).toMatchObject([{ playerId: 'bob', displayName: 'name_bob', counted: true, milestones: [] }]);
    expect(after.counted).toBe(1);
    const bobView = (await w.call('GET', '/v1/invite', { user: 'bob' })).body;
    expect(bobView.redeem).toMatchObject({ eligible: false, reason: 'already_redeemed', invitedBy: { playerId: 'alice', displayName: 'name_alice' } });
    const rows = w.kpi.filter((x) => x.r.name === 'invite_redeem');
    expect(rows.map((x) => [x.id, x.r.s2])).toEqual([['alice', 'inviter'], ['bob', 'invitee']]);
    // the same request again is refused (one code per account)
    expect((await w.call('POST', '/v1/invite/redeem', { user: 'bob', body: { code: mine.code, installId: 'inst-bob-0001' } })).body.error.code).toBe('INVITE_ALREADY_REDEEMED');
  });

  it('refuses before the FTUE, after the window, own code, malformed and unknown codes', async () => {
    const w = world();
    await w.newbie('alice');
    const code = (await w.invite.view('alice', null)).code;
    await w.svc.bootstrap('fresh');
    const red = (u: string, c = code, inst = `inst-${u}-xxxx`) => w.call('POST', '/v1/invite/redeem', { user: u, body: { code: c, installId: inst } });
    expect((await red('fresh')).body.error.code).toBe('NOT_ELIGIBLE'); // no partner horse yet
    expect((await red('alice')).body.error.code).toBe('INVITE_SELF');
    await w.newbie('carol');
    expect((await red('carol', 'nope')).body.error.code).toBe('INVITE_CODE_INVALID');
    expect((await red('carol', 'nope')).status).toBe(400);
    const other = makeInviteCode(0, seededRng(77)) ?? makeInviteCode(0, seededRng(78))!;
    expect((await red('carol', other)).body.error.code).toBe('NOT_FOUND');
    w.advance(7 * DAY); // install day = game day 1; day 8 is outside the 7-day window
    expect((await red('carol')).body.error.code).toBe('INVITE_WINDOW_CLOSED');
    expect((await w.invite.view('carol', null)).redeem).toMatchObject({ eligible: false, reason: 'window_closed', daysLeft: 0 });
    expect((await w.call('POST', '/v1/invite/redeem', { user: 'carol', body: { code } })).status).toBe(400); // installId required
  });

  it('rate-limits code entry (5 per hour, 10 per day) and flags it for support', async () => {
    const w = world();
    await w.newbie('mallory');
    const red = (c: string) => w.call('POST', '/v1/invite/redeem', { user: 'mallory', body: { code: c, installId: 'inst-mal-0001' } });
    for (let i = 0; i < 5; i++) expect((await red(`BADCODE${i}`)).body.error.code).toBe('INVITE_CODE_INVALID');
    expect((await red('BADCODE9')).body.error.code).toBe('RATE_LIMITED');
    expect(w.state('mallory').supportFlags?.some((f) => f.startsWith('invite_rate_limited:'))).toBe(true);
    w.advance(3_600_000);
    for (let i = 0; i < 5; i++) await red(`BADCODE${i}`);
    expect((await red('BADCODE9')).body.error.code).toBe('RATE_LIMITED'); // daily 10 reached
    w.advance(DAY);
    expect((await red('BADCODE9')).body.error.code).toBe('INVITE_CODE_INVALID');
  });

  it('anti-abuse: the inviter\'s own device, one redemption per install, loops, an inviter being deleted', async () => {
    const w = world();
    await w.newbie('alice');
    const code = (await w.invite.view('alice', 'inst-shared-01')).code; // alice opened her code on this device
    await w.newbie('sock');
    const r1 = await w.call('POST', '/v1/invite/redeem', { user: 'sock', body: { code, installId: 'inst-shared-01' } });
    expect(r1.body.error.code).toBe('INVITE_REFUSED');
    expect(w.state('alice').supportFlags).toContain('invite_same_device:sock');
    expect(w.state('sock').supportFlags).toContain('invite_same_device:alice');
    expect(w.state('sock').referral?.invitedBy).toBeUndefined();
    expect(await w.codes.claimInstall(await hashInstallId('inst-shared-01'), 'probe')).toBe('probe'); // claim was released

    // one redemption per install: a second account on the same device is refused
    await w.newbie('bob');
    expect((await w.call('POST', '/v1/invite/redeem', { user: 'bob', body: { code, installId: 'inst-phone-02' } })).body.status).toBe('redeemed');
    await w.newbie('bob2');
    const r2 = await w.call('POST', '/v1/invite/redeem', { user: 'bob2', body: { code, installId: 'inst-phone-02' } });
    expect(r2.body.error.code).toBe('INVITE_REFUSED');
    expect(w.state('bob2').supportFlags?.some((f) => f.startsWith('invite_install_reuse:'))).toBe(true);

    // a loop: bob invited by alice; dave redeems bob's code, then bob cannot redeem dave's (already redeemed) and
    // eve (invited by nobody yet) cannot redeem the code of someone she invited
    await w.newbie('eve');
    await w.newbie('frank');
    const eveCode = (await w.invite.view('eve', null)).code;
    const frankCode = (await w.invite.view('frank', null)).code;
    expect((await w.call('POST', '/v1/invite/redeem', { user: 'frank', body: { code: eveCode, installId: 'inst-frank-1' } })).body.status).toBe('redeemed');
    const loop = await w.call('POST', '/v1/invite/redeem', { user: 'eve', body: { code: frankCode, installId: 'inst-eve-0001' } });
    expect(loop.body.error.code).toBe('INVITE_REFUSED');
    expect(w.state('eve').referral?.invitedBy).toBeUndefined();

    // an inviter whose account deletion is scheduled cannot be used
    const t = ((await w.svc.requestDeletion('alice', null)) as { confirmToken: string }).confirmToken;
    await w.svc.requestDeletion('alice', t);
    await w.newbie('gina');
    expect((await w.call('POST', '/v1/invite/redeem', { user: 'gina', body: { code, installId: 'inst-gina-01' } })).body.error.code).toBe('INVITE_REFUSED');
  });

  it('respects friend caps (the invite still counts) and flags bursts on one inviter', async () => {
    const w = world();
    await w.newbie('star');
    const s = w.state('star');
    s.friends.ids = Array.from({ length: m.progression.social.maxFriends }, (_, i) => `f${i}`);
    w.put(s);
    const code = (await w.invite.view('star', null)).code;
    for (let i = 0; i < 6; i++) {
      await w.newbie(`fan${i}`);
      const r = await w.call('POST', '/v1/invite/redeem', { user: `fan${i}`, body: { code, installId: `inst-fan-${i}-x` } });
      expect(r.body).toMatchObject({ status: 'redeemed', friended: false });
      expect(w.state(`fan${i}`).friends.ids).toEqual([]);
    }
    expect(w.state('star').friends.ids).toHaveLength(m.progression.social.maxFriends);
    expect(w.state('star').referral!.invitees).toHaveLength(6);
    expect(w.state('star').supportFlags?.some((f) => f.startsWith('invite_burst:'))).toBe(true);
  });
});

describe('milestones (REQ-INV-007/008)', () => {
  async function invited(w: ReturnType<typeof world>, inviter: string, invitee: string) {
    const code = (await w.invite.view(inviter, null)).code;
    await w.newbie(invitee);
    const r = await w.invite.redeem(invitee, code, `inst-${invitee}-zz`);
    expect(r.status).toBe('redeemed');
  }
  const graduate = (w: ReturnType<typeof world>, id: string) => {
    const s = w.state(id);
    s.onboarding = { ...(s.onboarding ?? { races: 0, breedings: 0, counts: {} }), claimed: (m.progression.beginnerMissions ?? []).map((d) => d.id) } as never;
    w.put(s);
  };

  it('the inviter is paid when the invitee really plays (beginner missions, class A, class S), once each, never for the install', async () => {
    const w = world();
    await w.newbie('alice');
    await invited(w, 'alice', 'bob');
    const coins0 = w.state('alice').wallet.free;
    const tickets0 = w.state('alice').items.gacha_ticket ?? 0;
    await w.deliver('bob');
    expect(w.state('alice').wallet.free).toBe(coins0);
    graduate(w, 'bob');
    await w.svc.missionsAll('bob'); // any transaction notices the milestone
    expect(w.state('bob').referral!.outbox.map((o) => o.milestoneId)).toEqual(['im_graduate']);
    expect(await w.svc.inviteDue('bob')).toMatchObject({ nextAt: w.now() });
    expect(await w.deliver('bob')).toEqual({ attempted: 1, delivered: 1, failed: 0 });
    // REQ-BOX-001: the inviter's bonus waits in the gift box until alice opens it
    expect(w.state('alice').wallet.free).toBe(coins0);
    expect(w.state('alice').giftBox!.box[0]).toMatchObject({ source: 'invite', ref: 'invite:bob:im_graduate', contents: { freeCoins: 20 } });
    await w.svc.giftClaimAll('alice', 'c:box-1');
    expect(w.state('alice').wallet.free).toBe(coins0 + 20);
    expect(w.state('alice').ledger.at(-1)).toMatchObject({ kind: 'grant', currency: 'free', delta: 20, reason: 'invite milestone im_graduate' });
    // a retried delivery does not pay twice
    expect(await w.svc.inviteMilestone('alice', 'bob', 'im_graduate', 'b')).toEqual({ status: 'already' });
    await w.svc.missionsAll('bob');
    expect(w.state('bob').referral!.outbox).toEqual([]);
    // class B is no milestone any more (r10 merge: E2); class A pays coins, class S a ticket (promotion at the season
    // change, or already in the season history)
    const s = w.state('bob'); s.season.classId = 'B'; w.put(s);
    await w.svc.missionsAll('bob');
    expect(w.state('bob').referral!.outbox).toEqual([]);
    const s2 = w.state('bob'); s2.season.classId = 'A'; w.put(s2);
    await w.svc.missionsAll('bob');
    await w.deliver('bob');
    await w.svc.giftClaimAll('alice', 'c:box-2');
    expect(w.state('alice').wallet.free).toBe(coins0 + 20 + 40);
    const s3 = w.state('bob'); s3.season.classId = 'S'; w.put(s3);
    await w.svc.missionsAll('bob');
    await w.deliver('bob');
    await w.svc.giftClaimAll('alice', 'c:box-3');
    expect(w.state('alice').items.gacha_ticket).toBe(tickets0 + 1);
    expect(w.state('alice').wallet.paid).toBe(0);
    const view = await w.invite.view('alice', null);
    expect(view.invitees[0]!.milestones.map((x) => [x.id, x.rewarded])).toEqual([['im_graduate', true], ['im_class_a', true], ['im_class_s', true]]);
    const rows = w.kpi.filter((x) => x.r.name === 'invite_milestone').map((x) => [x.id, x.r.s1, x.r.s2]);
    expect(rows).toEqual([['bob', 'im_graduate', 'invitee'], ['alice', 'im_graduate', 'inviter'], ['bob', 'im_class_a', 'invitee'], ['alice', 'im_class_a', 'inviter'], ['bob', 'im_class_s', 'invitee'], ['alice', 'im_class_s', 'inviter']]);
  });

  it('only the first 10 invitees pay; milestones after the window do not count; failed deliveries back off', async () => {
    const w = world();
    await w.newbie('alice');
    for (let i = 0; i < 11; i++) { await invited(w, 'alice', `p${i}`); w.advance(3_600_000 * 5); }
    const st = w.state('alice').referral!;
    expect(st.invitees.filter((x) => x.counted)).toHaveLength(10);
    expect(st.invitees[10]).toMatchObject({ playerId: 'p10', counted: false });
    const coins0 = w.state('alice').wallet.free;
    graduate(w, 'p10');
    await w.svc.missionsAll('p10');
    await w.deliver('p10');
    expect(w.state('alice').wallet.free).toBe(coins0);
    expect(w.state('alice').referral!.invitees[10]!.milestones).toMatchObject([{ id: 'im_graduate', rewarded: false }]);
    // a failing inviter object: the entry stays and backs off
    graduate(w, 'p0');
    await w.svc.missionsAll('p0');
    const r = await deliverInviteOutbox({
      due: (u) => w.svc.inviteDue(u), deliver: async () => { throw new Error('down'); }, acked: (u, x) => w.svc.inviteAcked(u, x), later: (u, x) => w.svc.inviteRetryLater(u, x),
    }, 'p0');
    expect(r).toEqual({ attempted: 1, delivered: 0, failed: 1 });
    expect(w.state('p0').referral!.outbox[0]!.nextAt).toBe(w.now() + 120_000);
    // window: 90 days after the redemption
    w.advance(91 * DAY);
    const s = w.state('p1'); s.season.classId = 'B'; w.put(s);
    await w.svc.missionsAll('p1');
    expect(w.state('p1').referral!.outbox).toEqual([]);
  });
});

describe('account deletion (REQ-INV-010 × REQ-UXS-040)', () => {
  function ports(w: ReturnType<typeof world>): DeletionPorts {
    return {
      snapshot: (u) => w.svc.deletionSnapshot(u),
      markStep: async (u, st) => { await w.svc.deletionMarkStep(u, st); },
      friends: { removeFriend: (o, u) => w.svc.friendRemove(o, u), dropOutgoing: (f, u) => w.svc.friendCancel(f, u), dropIncoming: (to, u) => w.svc.friendDecline(to, u) },
      invites: {
        forfeitOwn: (u) => w.svc.inviteForfeit(u),
        retireCode: (u) => w.codes.retire(u),
        anonymizeInstall: (h) => w.codes.anonymizeInstall(h),
        forgetInvitee: (o, u) => w.svc.inviteForgetInvitee(o, u),
        forgetInviter: (o, u) => w.svc.inviteForgetInviter(o, u),
      },
      directory: { forget: async () => undefined },
      leaderboards: { forget: async () => undefined, deleteGhosts: async () => undefined },
      finalize: (u) => w.svc.deletionFinalize(u),
      retain: async () => undefined,
      wipe: (u) => w.svc.wipe(u),
    };
  }
  async function deleteNow(w: ReturnType<typeof world>, id: string) {
    const t = ((await w.svc.requestDeletion(id, null)) as { confirmToken: string }).confirmToken;
    await w.svc.requestDeletion(id, t);
    w.advance(14 * DAY);
    await runAccountDeletion(ports(w), id, w.now());
  }

  it('a deleted invitee: pending milestone rewards forfeited, the inviter keeps an anonymous record (slot stays used), the device stays used', async () => {
    const w = world();
    await w.newbie('alice');
    const code = (await w.invite.view('alice', null)).code;
    await w.newbie('bob');
    await w.invite.redeem('bob', code, 'inst-bob-0009');
    const s = w.state('bob');
    s.onboarding = { ...(s.onboarding ?? { races: 0, breedings: 0, counts: {} }), claimed: (m.progression.beginnerMissions ?? []).map((d) => d.id) } as never;
    w.put(s);
    await w.svc.missionsAll('bob'); // queued, not delivered
    const coins0 = w.state('alice').wallet.free;
    await deleteNow(w, 'bob');
    expect(w.repo.data.has('bob')).toBe(false);
    const a = w.state('alice');
    expect(a.wallet.free).toBe(coins0); // forfeited
    expect(a.referral!.invitees).toMatchObject([{ playerId: 'deleted:1', deleted: true, counted: true }]);
    expect(JSON.stringify(a.referral)).not.toContain('bob');
    expect(a.friends.ids).toEqual([]);
    expect(w.codes.installs.get(await hashInstallId('inst-bob-0009'))).toBeNull(); // hash kept, player gone
    expect(await w.codes.claimInstall(await hashInstallId('inst-bob-0009'), 'bob_again')).toBe('__deleted__');
    const v = await w.invite.view('alice', null);
    expect(v.invitees[0]).toMatchObject({ displayName: null, deleted: true });
    expect(v.counted).toBe(1);
  });

  it('a deleted inviter: code retired, invitees keep playing without milestone deliveries', async () => {
    const w = world();
    await w.newbie('alice');
    const code = (await w.invite.view('alice', null)).code;
    await w.newbie('bob');
    await w.invite.redeem('bob', code, 'inst-bob-0010');
    await deleteNow(w, 'alice');
    expect(await w.codes.lookup(code)).toBeNull();
    expect(w.state('bob').referral!.invitedBy).toMatchObject({ playerId: null });
    const s = w.state('bob'); s.season.classId = 'B'; w.put(s);
    await w.svc.missionsAll('bob');
    expect(w.state('bob').referral!.outbox).toEqual([]);
    expect(await w.svc.inviteMilestone('alice', 'bob', 'im_class_s', 'b')).toEqual({ status: 'gone' }); // a late delivery never recreates alice
    expect(w.repo.data.has('alice')).toBe(false);
    await w.newbie('carol');
    await expect(w.invite.redeem('carol', code, 'inst-carol-01')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('KPI (REQ-INV-011)', () => {
  it('accepts the client invite_share event', () => {
    const ok = clientBatchSchema.safeParse({ platform: 'ios', appVersion: '1.0.0', events: [{ name: 'invite_share', at: 1, props: { channel: 'os_share' } }] });
    expect(ok.success).toBe(true);
    expect(clientBatchSchema.safeParse({ platform: 'ios', appVersion: '1.0.0', events: [{ name: 'invite_share', at: 1, props: { channel: 'sms' } }] }).success).toBe(false);
  });
});
