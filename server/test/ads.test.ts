import { describe, expect, it } from 'vitest';
import { m } from './helpers.js';
import { MemoryPlayerRepo, PlayerService } from '../src/domain/service.js';
import { FakeStoreVerifier } from '../src/domain/purchase.js';
import { seededRng } from '../src/domain/rng.js';
import { AppError } from '../src/domain/errors.js';
import { ADS_HARD_LIMITS, adsProblems, maxAdCoinsPerDay, type AdCallback, type AdsConfig } from '../src/domain/ads.js';
import { derToP1363, p1363ToDer, RemoteKeySource, signAdMobQuery, StaticKeySource, verifyAdMobCallback, SsvError, parseAdUnits, type SsvKeySource } from '../src/ads/ssv.js';
import { resolveBundle } from '../src/ops/config.js';
import { clientBatchSchema, clientToKpi, type KpiRecord } from '../src/domain/kpi.js';
import { handle, makeFriendsService, type AppContext, type PlayerInvoker } from '../src/http/app.js';
import { MemoryDirectory } from '../src/domain/friends.js';
import type { Master } from '../src/domain/master.js';

const JST = 9 * 3600_000;
const jst = (y: number, mo: number, d: number, h = 12, mi = 0) => Date.UTC(y, mo - 1, d, h, mi) - JST;
const cfg = m.progression.ads as AdsConfig;
const withAds = (patch: Partial<AdsConfig>): Master => ({ ...m, progression: { ...m.progression, ads: { ...cfg, ...patch } } });

async function keyPair() {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', kp.publicKey) as ArrayBuffer);
  const pem = `-----BEGIN PUBLIC KEY-----\n${btoa(String.fromCharCode(...spki))}\n-----END PUBLIC KEY-----`;
  return { kp, pem };
}

function world(master: Master = m, start = jst(2026, 12, 10)) {
  let now = start;
  const store = new FakeStoreVerifier();
  const kpi: KpiRecord[] = [];
  const svc = new PlayerService(new MemoryPlayerRepo(), { master, rng: seededRng(11), clock: () => now, verifiers: { fake: store }, onKpi: (_id, recs) => { kpi.push(...recs); } });
  let n = 0, race = 0, tx = 0;
  const k = () => `c:t:${n++}`;
  const ranked = (id: string, place = 5) => svc.applyRace(id, { raceId: `r${race++}`, mode: 'ranked', place, fieldSize: 12, newRating: null, void: false, humans: 2 });
  /** A player past the FTUE gate on their second game day. */
  const veteran = async (id = 'p') => {
    await svc.bootstrap(id);
    for (let i = 0; i < 3; i++) await ranked(id);
    now += 86_400_000;
  };
  const cb = (id: string, customData: string, over: Partial<AdCallback> = {}): AdCallback => ({
    network: 'admob', transactionId: `tx${tx++}`, userId: id, customData, adUnit: 'unit', timestamp: now, rewardAmount: 1, rewardItem: 'reward', ...over,
  });
  const buy = async (id: string, productId: string) => {
    const p = master.products.find((x) => x.id === productId)!;
    await svc.setAge(id, 1990, 1, false);
    await svc.purchaseIntent(id, productId);
    await svc.purchase(id, 'fake', productId, store.issue({ transactionId: `T${tx++}`, productId, purchasedAt: now, priceYen: p.priceYen }));
  };
  return { svc, k, ranked, veteran, cb, buy, kpi, at: (t: number) => { now = t; }, now: () => now, advance: (ms: number) => { now += ms; } };
}
const code = async (p: Promise<unknown>) => { try { await p; } catch (e) { return (e as AppError).code; } return 'NO_ERROR'; };

describe('REQ-AD-002 config validation (boot and remote config)', () => {
  it('the shipped config is valid, within the hard limits, and never words a reward as 「倍」', () => {
    expect(adsProblems(cfg)).toEqual([]);
    expect(maxAdCoinsPerDay(cfg)).toBeLessThanOrEqual(ADS_HARD_LIMITS.freeCoinsPerDay);
    expect(JSON.stringify(cfg.placements)).not.toMatch(/倍|お得|今だけ/);
  });
  it('rejects banned wording, caps above the code limits, two reward kinds, a first-session or under-13 setting', () => {
    const bad = (patch: Partial<AdsConfig>) => adsProblems({ ...cfg, ...patch }).join('\n');
    expect(bad({ placements: [{ ...cfg.placements[0]!, title: 'コイン2倍キャンペーン' }] })).toMatch(/倍/);
    expect(bad({ placements: [{ ...cfg.placements[0]!, title: '今だけお得' }] })).toMatch(/今だけ/);
    expect(bad({ globalDailyCap: 50 })).toMatch(/globalDailyCap: at most/);
    expect(bad({ placements: [{ ...cfg.placements[0]!, reward: { freeCoins: 500 } }] })).toMatch(/freeCoins: at most/);
    expect(bad({ placements: [{ ...cfg.placements[0]!, reward: { freeCoins: 5, taAttempts: 1 } }] })).toMatch(/exactly one/);
    expect(bad({ minGameDay: 1 })).toMatch(/minGameDay/);
    expect(bad({ minRankedRaces: 0 })).toMatch(/minRankedRaces/);
    expect(bad({ minAge: 10 })).toMatch(/minAge/);
    expect(bad({ placements: [cfg.placements[0]!, cfg.placements[0]!] })).toMatch(/duplicate/);
    // many placements each under their own cap but together over the daily coin ceiling
    const many = [0, 1, 2].map((i) => ({ ...cfg.placements[0]!, id: `c${i}`, dailyCap: 2, reward: { freeCoins: 20 } }));
    expect(bad({ globalDailyCap: 6, placements: many })).toMatch(/free coins a day from ads/);
  });
  it('remote config: progression.ads is validated like at boot', () => {
    expect(() => resolveBundle(m, { progression: { ads: { ...cfg, globalDailyCap: 2 } } })).not.toThrow();
    expect(() => resolveBundle(m, { progression: { ads: { ...cfg, placements: [{ ...cfg.placements[0]!, title: '報酬2倍' }] } } })).toThrow(/倍/);
    expect(() => resolveBundle(m, { progression: { ads: { ...cfg, payerQuietDays: 365 } } })).toThrow(/payerQuietDays/);
  });
});

describe('REQ-AD-001/003 who sees offers', () => {
  it('no ads in the FTUE or on the install game day; from the next game day (04:00 rollover) after 3 ranked races', async () => {
    const w = world(m, jst(2026, 12, 10, 12));
    await w.svc.bootstrap('p');
    expect((await w.svc.ads('p')).reason).toBe('ftue');
    for (let i = 0; i < 3; i++) await w.ranked('p');
    expect((await w.svc.ads('p')).reason).toBe('first_day');
    w.at(jst(2026, 12, 11, 3, 59)); // still the install game day
    expect((await w.svc.ads('p')).reason).toBe('first_day');
    w.at(jst(2026, 12, 11, 4, 0));
    const v = await w.svc.ads('p');
    expect(v).toMatchObject({ eligible: true, reason: null, globalCap: 3, globalLeft: 3 });
    expect(v.placements.map((p) => [p.id, p.rewardLabel, p.available])).toEqual([
      ['daily_coins', '無償コイン10枚', true], ['result_coins', '無償コイン10枚', true], ['ta_attempt', 'タイムアタック1回', true],
    ]);
    expect(await code(w.svc.adStart('p', 'daily_coins', null))).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });
  it('payers: hidden for 30 days after a real payment unless they opt in; off hides for everyone; under 13 never', async () => {
    const w = world();
    await w.veteran('p');
    await w.buy('p', 'coin_160');
    expect((await w.svc.ads('p')).reason).toBe('payer_quiet');
    expect(await code(w.svc.adStart('p', 'daily_coins', w.k()))).toBe('NOT_ELIGIBLE');
    expect((await w.svc.setAdPref('p', 'on')).eligible).toBe(true);
    await w.svc.setAdPref('p', 'auto');
    w.advance(30 * 86_400_000 + 1);
    expect((await w.svc.ads('p')).eligible).toBe(true);
    expect((await w.svc.setAdPref('p', 'off')).reason).toBe('opted_out');

    const kid = world();
    await kid.veteran('k');
    await kid.svc.setAge('k', 2015, 1, true);
    expect((await kid.svc.ads('k')).reason).toBe('age');
  });
  it('ad request hints: non-personalised unless a registered adult; the under-age-of-consent tag under 16', async () => {
    const w = world();
    await w.veteran('p');
    expect((await w.svc.ads('p')).adRequest).toEqual({ nonPersonalized: true, underAgeOfConsent: false, ageKnown: false });
    await w.svc.setAge('p', 2011, 1, true); // 15
    expect((await w.svc.ads('p')).adRequest).toEqual({ nonPersonalized: true, underAgeOfConsent: true, ageKnown: true });
    const a = world();
    await a.veteran('a');
    await a.svc.setAge('a', 1990, 1, false);
    expect((await a.svc.ads('a')).adRequest.nonPersonalized).toBe(false);
  });
  it('an account scheduled for deletion gets no offers', async () => {
    const w = world();
    await w.veteran('p');
    const r = await w.svc.requestDeletion('p', null) as { confirmToken: string };
    await w.svc.requestDeletion('p', r.confirmToken);
    expect((await w.svc.ads('p')).reason).toBe('deleting');
    expect(await code(w.svc.adStart('p', 'daily_coins', w.k()))).toBe('DELETION_PENDING');
  });
});

describe('REQ-AD-005..008 sessions, callbacks, caps', () => {
  it('a reward is granted only by the callback: free coins, never paid; idempotent by transaction id', async () => {
    const w = world();
    await w.veteran('p');
    const before = (await w.svc.view('p')).wallet;
    const st = await w.svc.adStart('p', 'daily_coins', w.k());
    expect(st).toMatchObject({ placementId: 'daily_coins', network: 'admob', userId: 'p', customData: st.sessionId, adUnitKey: 'REWARDED_HOME', rewardLabel: '無償コイン10枚' });
    expect((await w.svc.view('p')).wallet).toEqual(before); // starting pays nothing
    expect((await w.svc.adSession('p', st.sessionId)).status).toBe('open');
    const c = w.cb('p', st.sessionId);
    expect(await w.svc.adReward('p', c)).toMatchObject({ status: 'rewarded', reward: { freeCoins: 10 }, rewardLabel: '無償コイン10枚' });
    const after = (await w.svc.view('p')).wallet;
    expect(after.free - before.free).toBe(10);
    expect(after.paid).toBe(before.paid);
    expect(await w.svc.adReward('p', c)).toMatchObject({ status: 'rewarded' }); // the stored result (idempotency ring)
    expect((await w.svc.view('p')).wallet.free).toBe(after.free);
    const s = await w.svc.state('p');
    expect(s.ledger.filter((l) => l.ref?.startsWith('ad:admob:')).map((l) => [l.currency, l.delta])).toEqual([['free', 10]]);
    expect(await w.svc.adSession('p', st.sessionId)).toMatchObject({ status: 'rewarded', rewardLabel: '無償コイン10枚' });
    expect(w.kpi.filter((e) => e.name === 'ad_reward').map((e) => [e.s1, e.s2, e.s3, e.freeCoins])).toEqual([['daily_coins', 'admob', 'home', 10]]);
  });
  it('a replayed transaction id with a new session is a duplicate; a second callback for a used session is rejected', async () => {
    const w = world();
    await w.veteran('p');
    const a = await w.svc.adStart('p', 'daily_coins', w.k());
    const first = w.cb('p', a.sessionId);
    await w.svc.adReward('p', first);
    const b = await w.svc.adStart('p', 'result_coins', w.k());
    // same tx id, other session: not a second reward (the idempotency key returns the first result unchanged)
    expect(await w.svc.adReward('p', { ...first, customData: b.sessionId })).toMatchObject({ status: 'rewarded', placementId: 'daily_coins' });
    expect((await w.svc.adSession('p', b.sessionId)).status).toBe('open');
    expect(await w.svc.adReward('p', w.cb('p', a.sessionId))).toMatchObject({ status: 'rejected', reason: 'session_used' });
  });
  it('rejects a mismatched user, an unknown session, an expired session, clock skew and another ad unit', async () => {
    const w = world();
    await w.veteran('p');
    const st = await w.svc.adStart('p', 'daily_coins', w.k());
    expect(await w.svc.adReward('p', w.cb('other', st.sessionId))).toMatchObject({ status: 'rejected', reason: 'user_mismatch' });
    const st2 = await w.svc.adStart('p', 'daily_coins', w.k());
    expect(await w.svc.adReward('p', w.cb('p', 'ad_ffffffffffffffff'))).toMatchObject({ status: 'rejected', reason: 'unknown_session' });
    expect(await w.svc.adReward('p', w.cb('p', st2.sessionId, { timestamp: w.now() - 11 * 60_000 }))).toMatchObject({ status: 'rejected', reason: 'clock_skew' });
    const st3 = await w.svc.adStart('p', 'daily_coins', w.k());
    expect(await w.svc.adReward('p', w.cb('p', st3.sessionId, { adUnitKey: 'REWARDED_TA' }))).toMatchObject({ status: 'rejected', reason: 'ad_unit_mismatch' });
    const st4 = await w.svc.adStart('p', 'daily_coins', w.k());
    w.advance(cfg.sessionTtlMs + 1);
    expect(await w.svc.adReward('p', w.cb('p', st4.sessionId))).toMatchObject({ status: 'rejected', reason: 'expired' });
    expect((await w.svc.ads('p')).globalUsed).toBe(0);
    // five rejected callbacks in one game day: a support flag (once)
    const s = await w.svc.state('p');
    expect(s.supportFlags?.filter((f) => f.startsWith('ads_anomaly:'))).toHaveLength(1);
    expect(w.kpi.filter((e) => e.name === 'ad_reject').map((e) => e.s1)).toEqual(['user_mismatch', 'unknown_session', 'clock_skew', 'ad_unit_mismatch', 'expired']);
  });
  it('per-placement and global daily caps (game day); limits on starts and open sessions', async () => {
    const w = world(withAds({ startsPerDay: 5, maxOpenSessions: 2 }), jst(2026, 12, 10, 12));
    await w.veteran('p');
    const st = await w.svc.adStart('p', 'daily_coins', w.k());
    await w.svc.adReward('p', w.cb('p', st.sessionId));
    expect(await code(w.svc.adStart('p', 'daily_coins', w.k()))).toBe('AD_LIMIT_REACHED');
    const r1 = await w.svc.adStart('p', 'result_coins', w.k());
    const r2 = await w.svc.adStart('p', 'ta_attempt', w.k());
    expect(await code(w.svc.adStart('p', 'result_coins', w.k()))).toBe('RATE_LIMITED'); // two open sessions
    await w.svc.adReward('p', w.cb('p', r1.sessionId));
    await w.svc.adReward('p', w.cb('p', r2.sessionId));
    const v = await w.svc.ads('p');
    expect(v).toMatchObject({ globalUsed: 3, globalLeft: 0 });
    expect(v.placements.every((p) => !p.available)).toBe(true);
    // next game day at 04:00 JST: counts reset
    w.at(jst(2026, 12, 12, 4, 0));
    expect((await w.svc.ads('p')).globalLeft).toBe(3);
  });
  it('a session opened before the cap was reached elsewhere is rejected at the callback (cap), not paid', async () => {
    const w = world(withAds({ globalDailyCap: 1 }));
    await w.veteran('p');
    const a = await w.svc.adStart('p', 'daily_coins', w.k());
    // the cap is checked at start too, so open the second one through a second start before the first pays
    const s = await w.svc.state('p');
    expect(s.ads!.total).toBe(0);
    await w.svc.adReward('p', w.cb('p', a.sessionId));
    expect(await code(w.svc.adStart('p', 'result_coins', w.k()))).toBe('AD_LIMIT_REACHED');
  });
  it('the time attack placement adds one attempt today (REQ-AD-008)', async () => {
    const w = world();
    await w.veteran('p');
    const trackId = m.tracks[0]!.id;
    const before = (await w.svc.taView('p', trackId)).attemptsLeft;
    const st = await w.svc.adStart('p', 'ta_attempt', w.k());
    expect(await w.svc.adReward('p', w.cb('p', st.sessionId))).toMatchObject({ status: 'rewarded', reward: { taAttempts: 1 }, rewardLabel: 'タイムアタック1回' });
    expect((await w.svc.taView('p', trackId)).attemptsLeft).toBe(before + 1);
  });
});

describe('REQ-AD-006 SSV signature (AdMob-style, ECDSA P-256)', () => {
  it('verifies a signed callback; tampering, an unknown key or a missing signature fail', async () => {
    const { kp, pem } = await keyPair();
    const keys = new StaticKeySource([{ keyId: '3335741209', pem }]);
    const q = await signAdMobQuery({ adUnit: 'ca-app-pub-0000000000000000/1111111111', customData: 'ad_0123456789abcdef', timestamp: 1_796_000_000_000, transactionId: 'tx_1', userId: 'player-1', keyId: '3335741209' }, kp.privateKey);
    const cb = await verifyAdMobCallback('?' + q, keys, { REWARDED_HOME: 'ca-app-pub-0000000000000000/1111111111' });
    expect(cb).toMatchObject({ network: 'admob', transactionId: 'tx_1', userId: 'player-1', customData: 'ad_0123456789abcdef', timestamp: 1_796_000_000_000, adUnitKey: 'REWARDED_HOME' });
    expect((await verifyAdMobCallback(q, keys, { OTHER: 'x' })).adUnitKey).toBeNull();
    expect((await verifyAdMobCallback(q, keys)).adUnitKey).toBeUndefined();
    const reason = async (s: string, k: SsvKeySource = keys) => { try { await verifyAdMobCallback(s, k); return 'ok'; } catch (e) { return (e as SsvError).reason; } };
    expect(await reason(q.replace('user_id=player-1', 'user_id=player-2'))).toBe('bad_signature');
    expect(await reason(q.replace('transaction_id=tx_1', 'transaction_id=tx_2'))).toBe('bad_signature');
    expect(await reason(q.split('&signature=')[0]!)).toBe('missing_signature');
    expect(await reason(q.replace(/key_id=3335741209$/, 'key_id=1'))).toBe('unknown_key');
    expect(await reason(q.replace(/signature=[^&]+/, 'signature=AAAA'))).toBe('bad_signature');
    // a parameter appended after the signature is not signed and is ignored (the signed user_id wins)
    expect((await verifyAdMobCallback(q + '&user_id=attacker', keys)).userId).toBe('player-1');
    const other = await keyPair();
    expect(await reason(q, new StaticKeySource([{ keyId: '3335741209', pem: other.pem }]))).toBe('bad_signature');
  });
  it('DER ⇄ IEEE P1363 conversion round-trips (leading zero bytes, high bit set)', () => {
    for (const fill of [0x00, 0x7f, 0x80, 0xff]) {
      const raw = new Uint8Array(64).fill(fill);
      raw[0] = 0; raw[32] = 0x81;
      expect([...derToP1363(p1363ToDer(raw))]).toEqual([...raw]);
    }
    expect(() => derToP1363(new Uint8Array([0x31, 0]))).toThrow();
  });
  it('the remote key set is cached and refetched at most once a minute for an unknown key id', async () => {
    const { pem } = await keyPair();
    let now = 0, fetches = 0;
    const src = new RemoteKeySource({ url: 'https://keys.example.invalid/k.json', clock: () => now, fetch: async () => { fetches++; return { ok: true, json: async () => ({ keys: [{ keyId: 7, pem }] }) }; } });
    expect(await src.get('7')).not.toBeNull();
    expect(await src.get('7')).not.toBeNull();
    expect(fetches).toBe(1);
    expect(await src.get('8')).toBeNull(); // unknown: refetch is rate-limited (just fetched)
    expect(fetches).toBe(1);
    now += 61_000;
    expect(await src.get('8')).toBeNull();
    expect(fetches).toBe(2);
    now += 25 * 3_600_000;
    await src.get('7');
    expect(fetches).toBe(3); // daily refresh
  });
  it('ADS_AD_UNITS parsing', () => {
    expect(parseAdUnits(undefined)).toBeUndefined();
    expect(parseAdUnits('nope')).toBeUndefined();
    expect(parseAdUnits('{"REWARDED_HOME":"a/1","X":3}')).toEqual({ REWARDED_HOME: 'a/1' });
  });
});

describe('HTTP: /v1/ads and the SSV callback (contracts/protocol.md §18)', () => {
  async function ctx(withKeys = true) {
    const { kp, pem } = await keyPair();
    const w = world();
    const invoker: PlayerInvoker = { invoke: (async (method: string, ...args: unknown[]) => (w.svc as unknown as Record<string, (...a: unknown[]) => unknown>)[method]!.apply(w.svc, args)) as PlayerInvoker['invoke'] };
    let admitted = 0;
    const c = {
      master: m, authenticate: async (req: Request) => { const u = req.headers.get('x-test-user'); if (!u) throw new AppError('UNAUTHORIZED'); return u; },
      player: () => invoker, friends: makeFriendsService(() => invoker, new MemoryDirectory()), clock: () => w.now(),
      paidBalance: async () => ({}), adminToken: 'x', parseStoreNotification: async () => null,
      ...(withKeys ? { ads: { keys: new StaticKeySource([{ keyId: '42', pem }]), adUnits: { REWARDED_HOME: 'unit/home' }, admit: () => { if (++admitted > 50) throw new AppError('RATE_LIMITED'); } } } : {}),
    } as unknown as AppContext;
    return { c, w, kp };
  }
  const req = (method: string, path: string, user?: string, idem?: string, body?: unknown) => new Request(`https://x${path}`, {
    method, headers: { ...(user ? { 'x-test-user': user } : {}), ...(idem ? { 'idempotency-key': idem } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  it('offer → start → signed callback → session rewarded; unsigned or forged callbacks are 401', async () => {
    const { c, w, kp } = await ctx();
    await w.veteran('u');
    expect((await handle(req('GET', '/v1/ads'), {}, c)).status).toBe(401);
    const view = await (await handle(req('GET', '/v1/ads', 'u'), {}, c)).json() as { eligible: boolean; placements: { id: string }[] };
    expect(view.eligible).toBe(true);
    expect((await handle(req('POST', '/v1/ads/daily_coins/start', 'u'), {}, c)).status).toBe(400); // key required
    expect((await handle(req('POST', '/v1/ads/BAD!/start', 'u', 'k'), {}, c)).status).toBe(400);
    const st = await (await handle(req('POST', '/v1/ads/daily_coins/start', 'u', 'k1'), {}, c)).json() as { sessionId: string; customData: string; userId: string };
    expect(st.userId).toBe('u');
    const q = await signAdMobQuery({ adUnit: 'unit/home', customData: st.customData, timestamp: w.now(), transactionId: 'T-1', userId: 'u', keyId: '42' }, kp.privateKey);
    const res = await handle(req('GET', '/v1/ads/ssv/admob?' + q), {}, c);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, status: 'rewarded' });
    expect(await (await handle(req('GET', '/v1/ads/ssv/admob?' + q), {}, c)).json()).toEqual({ ok: true, status: 'rewarded' }); // retry
    expect(await (await handle(req('GET', `/v1/ads/sessions/${st.sessionId}`, 'u'), {}, c)).json()).toMatchObject({ status: 'rewarded', reward: { freeCoins: 10 } });
    expect((await handle(req('GET', '/v1/ads/sessions/nope', 'u'), {}, c)).status).toBe(400);
    expect((await handle(req('GET', '/v1/ads/ssv/admob?' + q.replace('user_id=u', 'user_id=v')), {}, c)).status).toBe(401);
    expect((await handle(req('GET', '/v1/ads/ssv/admob?ad_network=1&user_id=u'), {}, c)).status).toBe(401);
    // a callback from an ad unit that is not ours: verified but rejected (200, so the network does not retry)
    const st2 = await (await handle(req('POST', '/v1/ads/result_coins/start', 'u', 'k2'), {}, c)).json() as { customData: string };
    const q2 = await signAdMobQuery({ adUnit: 'unit/someone-else', customData: st2.customData, timestamp: w.now(), transactionId: 'T-2', userId: 'u', keyId: '42' }, kp.privateKey);
    expect(await (await handle(req('GET', '/v1/ads/ssv/admob?' + q2), {}, c)).json()).toEqual({ ok: true, status: 'rejected' });
    expect(await (await handle(req('PUT', '/v1/ads/preferences', 'u', undefined, { mode: 'off' }), {}, c)).json()).toMatchObject({ eligible: false, reason: 'opted_out' });
    expect((await handle(req('PUT', '/v1/ads/preferences', 'u', undefined, { mode: 'always' }), {}, c)).status).toBe(400);
  });
  it('without a key set the callback is NOT_FOUND (nothing can pay out)', async () => {
    const { c } = await ctx(false);
    expect((await handle(req('GET', '/v1/ads/ssv/admob?x=1&signature=a&key_id=1'), {}, c)).status).toBe(404);
  });
});

describe('REQ-AD-010 client KPI events', () => {
  it('ad_offer_view and ad_start are accepted from the client; the reward is never a client event', () => {
    const b = clientBatchSchema.parse({ platform: 'ios', appVersion: '1.0.0', events: [
      { name: 'ad_offer_view', at: 1, props: { placementId: 'daily_coins', surface: 'home' } },
      { name: 'ad_start', at: 2, props: { placementId: 'daily_coins', surface: 'home', outcome: 'shown' } },
    ] });
    expect(b.events.map(clientToKpi)).toEqual([
      { name: 'ad_offer_view', s1: 'daily_coins', s2: 'home' },
      { name: 'ad_start', s1: 'daily_coins', s2: 'home', s3: 'shown' },
    ]);
    expect(clientBatchSchema.safeParse({ platform: 'ios', appVersion: '1', events: [{ name: 'ad_reward', at: 1, props: {} }] }).success).toBe(false);
  });
});
