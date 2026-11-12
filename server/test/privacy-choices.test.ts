// 広告・分析の同意管理 (REQ-CNS-001..015, contracts/protocol.md §58).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { m } from './helpers.js';
import { MemoryPlayerRepo, PlayerService } from '../src/domain/service.js';
import { FakeStoreVerifier } from '../src/domain/purchase.js';
import { seededRng } from '../src/domain/rng.js';
import { AppError } from '../src/domain/errors.js';
import { clientEventSchema, clientToKpi, type ClientEvent, type KpiRecord } from '../src/domain/kpi.js';
import { KPI_ESSENTIAL, KPI_EVENT_CLASS, KPI_OPTIONAL, filterKpi, kpiClassOf } from '../src/domain/kpiConsent.js';
import { PRIVACY_HISTORY_KEEP } from '../src/domain/privacyChoices.js';
import { isExempt } from '../src/domain/maintenance.js';
import { buildExportDocument, classifyKey } from '../src/domain/dataExport.js';
import type { AdCallback } from '../src/domain/ads.js';
import type { Master } from '../src/domain/master.js';
import { handle, makeFriendsService, type AppContext, type PlayerInvoker } from '../src/http/app.js';
import { MemoryDirectory } from '../src/domain/friends.js';

const JST = 9 * 3600_000;
const jst = (y: number, mo: number, d: number, h = 12) => Date.UTC(y, mo - 1, d, h) - JST;
const V = m.progression.consent!.privacyVersion;
const withPolicy = (privacyVersion: string): Master => ({ ...m, progression: { ...m.progression, consent: { ...m.progression.consent!, privacyVersion } } });

function world(master: Master = m, repo = new MemoryPlayerRepo()) {
  let now = jst(2026, 12, 10);
  const kpi: KpiRecord[] = [];
  const store = new FakeStoreVerifier();
  const mk = (ms: Master) => new PlayerService(repo, { master: ms, rng: seededRng(5), clock: () => now, verifiers: { fake: store }, onKpi: (_id, recs) => { kpi.push(...recs); } });
  const svc = mk(master);
  let race = 0, tx = 0;
  const ranked = (id: string) => svc.applyRace(id, { raceId: `r${race++}`, mode: 'ranked', place: 5, fieldSize: 12, newRating: null, void: false, humans: 2 });
  /** Past the FTUE: 3 ranked races, then the second game day. */
  const veteran = async (id = 'p') => { await svc.bootstrap(id); for (let i = 0; i < 3; i++) await ranked(id); now += 86_400_000; };
  const cb = (id: string, customData: string): AdCallback => ({ network: 'admob', transactionId: `tx${tx++}`, userId: id, customData, adUnit: 'unit', timestamp: now, rewardAmount: 1, rewardItem: 'reward' });
  const buy = async (id: string, productId: string) => {
    const p = master.products.find((x) => x.id === productId)!;
    await svc.purchaseIntent(id, productId);
    await svc.purchase(id, 'fake', productId, store.issue({ transactionId: `T${tx++}`, productId, purchasedAt: now, priceYen: p.priceYen }));
  };
  return { svc, mk, kpi, ranked, veteran, cb, buy, repo, advance: (ms: number) => { now += ms; }, now: () => now };
}
const code = async (p: Promise<unknown>) => { try { await p; } catch (e) { return (e as AppError).code; } return 'NO_ERROR'; };
const changes = (k: KpiRecord[]) => k.filter((x) => x.name === 'consent_change').map((x) => [x.s1, x.s2, x.s3]);

describe('REQ-CNS-001..004 defaults, GET, bootstrap', () => {
  it('never chosen: personalised ads off (opt-in), analytics on, decision required; reading writes nothing', async () => {
    const w = world();
    await expect(w.svc.privacyChoices('ghost')).resolves.toMatchObject({ required: true, rev: 0 });
    const boot = await w.svc.bootstrap('p');
    expect(boot.privacyChoices).toMatchObject({ required: true, prompt: null, policyVersion: V, personalizedAds: { value: false, effective: false }, analytics: { value: true, effective: true } });
    const v = await w.svc.privacyChoices('p');
    expect(v).toMatchObject({ policyVersion: V, decidedVersion: null, minor: false, platform: null, adRequest: { npa: 1, nonPersonalized: true, extras: { npa: '1' } }, kpi: { optional: true } });
    expect((await w.svc.state('p')).privacyChoices).toBeUndefined();
    expect((await w.svc.view('p')).privacyChoices.required).toBe(true);
  });
  it('locks, strongest first: age_unknown → under18 → (adult) att on iOS → cmp in the EEA → none', async () => {
    const w = world();
    await w.svc.bootstrap('p');
    let v = await w.svc.setPrivacyChoices('p', { privacyVersion: V, source: 'settings', personalizedAds: true });
    expect(v.personalizedAds).toEqual({ value: true, effective: false, locked: 'age_unknown' });
    await w.svc.setAge('p', 2010, 1, true); // 16
    expect((await w.svc.privacyChoices('p')).personalizedAds.locked).toBe('under18');
    await w.svc.adminCorrectAge('p', 1990, 1, false, 'qa');
    expect((await w.svc.privacyChoices('p')).personalizedAds).toEqual({ value: true, effective: true, locked: null });
    v = await w.svc.setPrivacyPlatform('p', { os: 'ios', att: 'denied' });
    expect(v.personalizedAds.locked).toBe('att');
    expect(v.adRequest).toMatchObject({ npa: 1, nonPersonalized: true });
    v = await w.svc.setPrivacyPlatform('p', { os: 'ios', att: 'authorized' });
    expect(v.personalizedAds.effective).toBe(true);
    expect(v.adRequest).toMatchObject({ npa: 0, nonPersonalized: false, extras: {} });
    v = await w.svc.setPrivacyPlatform('p', { os: 'android', gdprApplies: true, cmp: 'required' });
    expect(v.personalizedAds.locked).toBe('cmp');
    expect(v.platform).toMatchObject({ os: 'android', att: null, gdprApplies: true, cmp: 'required' });
    v = await w.svc.setPrivacyPlatform('p', { os: 'android', cmp: 'obtained' });
    expect(v.personalizedAds).toEqual({ value: true, effective: true, locked: null });
  });
  it('the EEA (gdprApplies) defaults analytics to off until the player chooses', async () => {
    const w = world();
    await w.svc.bootstrap('p');
    const v = await w.svc.setPrivacyPlatform('p', { os: 'android', gdprApplies: true, cmp: 'required' });
    expect(v.analytics).toEqual({ value: false, effective: false, locked: null });
    expect((await w.svc.setPrivacyChoices('p', { privacyVersion: V, source: 'prompt', analytics: true })).analytics.effective).toBe(true);
  });
});

describe('REQ-CNS-005 PUT /v1/privacy/choices', () => {
  it('records the decision under the current version; keys left out keep the value in effect; idempotent by content', async () => {
    const w = world();
    await w.svc.bootstrap('p');
    const v = await w.svc.setPrivacyChoices('p', { privacyVersion: V, source: 'prompt', personalizedAds: false });
    expect(v).toMatchObject({ decidedVersion: V, decidedAt: w.now(), rev: 1, required: false, analytics: { value: true } });
    // the default became the decision: personalised ads were already off and analytics on → stored, no consent_change rows
    expect((await w.svc.state('p')).privacyChoices).toMatchObject({ personalizedAds: false, analytics: true });
    expect(changes(w.kpi)).toEqual([['personalized_ads', 'off', 'prompt'], ['analytics', 'on', 'prompt']]);
    w.advance(1000);
    const again = await w.svc.setPrivacyChoices('p', { privacyVersion: V, source: 'settings', personalizedAds: false, analytics: true });
    expect(again.rev).toBe(1);
    expect(changes(w.kpi)).toHaveLength(2);
    await w.svc.setPrivacyChoices('p', { privacyVersion: V, source: 'settings', analytics: false });
    expect(changes(w.kpi).slice(2)).toEqual([['analytics', 'off', 'settings']]);
    expect((await w.svc.privacyChoices('p')).rev).toBe(2);
  });
  it('a stale version is CONSENT_VERSION_MISMATCH; a deleting account is DELETION_PENDING; a scheduled one may still change', async () => {
    const w = world();
    await w.svc.bootstrap('p');
    expect(await code(w.svc.setPrivacyChoices('p', { privacyVersion: 'old', source: 'settings', analytics: false }))).toBe('CONSENT_VERSION_MISMATCH');
    expect(await code(w.svc.notePrivacyPromptShown('p', 'old'))).toBe('CONSENT_VERSION_MISMATCH');
    const r = await w.svc.requestDeletion('p', null) as { confirmToken: string };
    await w.svc.requestDeletion('p', r.confirmToken);
    expect(await code(w.svc.setPrivacyChoices('p', { privacyVersion: V, source: 'settings', analytics: false }))).toBe('NO_ERROR');
    const s = await w.svc.state('p');
    s.deletion!.status = 'deleting';
    await w.repo.put(s);
    expect(await code(w.svc.setPrivacyChoices('p', { privacyVersion: V, source: 'settings', analytics: true }))).toBe('DELETION_PENDING');
    expect(await code(w.svc.setPrivacyPlatform('p', { os: 'ios', att: 'denied' }))).toBe('DELETION_PENDING');
  });
  it('history keeps the newest rows only', async () => {
    const w = world();
    await w.svc.bootstrap('p');
    for (let i = 0; i < PRIVACY_HISTORY_KEEP + 10; i++) await w.svc.setPrivacyChoices('p', { privacyVersion: V, source: 'settings', analytics: i % 2 === 0 });
    const h = (await w.svc.state('p')).privacyChoices!.history;
    expect(h).toHaveLength(PRIVACY_HISTORY_KEEP);
    expect(h.at(-1)).toMatchObject({ key: 'analytics', source: 'settings', version: V });
  });
  it('ATT / CMP reports: one consent_change per changed field (source platform); the same report again changes nothing', async () => {
    const w = world();
    await w.svc.bootstrap('p');
    await w.svc.setPrivacyPlatform('p', { os: 'ios', att: 'not_determined' });
    await w.svc.setPrivacyPlatform('p', { os: 'ios', att: 'not_determined' });
    await w.svc.setPrivacyPlatform('p', { os: 'ios', att: 'authorized' });
    expect(changes(w.kpi)).toEqual([['att', 'not_determined', 'platform'], ['att', 'authorized', 'platform']]);
    expect((await w.svc.privacyChoices('p')).rev).toBe(2);
  });
});

describe('REQ-CNS-006 children', () => {
  it('under 13: personalised ads locked off, analytics off by default and only with a guardian', async () => {
    const w = world();
    await w.svc.bootstrap('k');
    await w.svc.setAge('k', 2015, 1, false); // 11
    let v = await w.svc.privacyChoices('k');
    expect(v).toMatchObject({ minor: true, personalizedAds: { effective: false, locked: 'minor' }, analytics: { value: false, effective: false, locked: 'minor' }, kpi: { optional: false } });
    expect(v.adRequest).toMatchObject({ npa: 1, tagForChildDirected: true, underAgeOfConsent: true });
    expect(await code(w.svc.setPrivacyChoices('k', { privacyVersion: V, source: 'settings', analytics: true }))).toBe('NOT_ELIGIBLE');
    expect(await code(w.svc.setPrivacyChoices('k', { privacyVersion: V, source: 'settings', personalizedAds: true }))).toBe('NOT_ELIGIBLE');
    await w.svc.setAge('k', 2015, 1, true); // the guardian agreed
    v = await w.svc.setPrivacyChoices('k', { privacyVersion: V, source: 'settings', analytics: true });
    expect(v.analytics).toEqual({ value: true, effective: true, locked: null });
    expect(v.personalizedAds.locked).toBe('minor');
  });
  it('13–15 is a child only where the EEA rules apply; an analytics "on" chosen before the age registration stops applying', async () => {
    const w = world();
    await w.svc.bootstrap('t');
    await w.svc.setPrivacyChoices('t', { privacyVersion: V, source: 'prompt', analytics: true });
    await w.svc.setAge('t', 2012, 1, false); // 14
    expect((await w.svc.privacyChoices('t')).minor).toBe(false);
    const v = await w.svc.setPrivacyPlatform('t', { os: 'android', gdprApplies: true, cmp: 'obtained' });
    expect(v).toMatchObject({ minor: true, analytics: { value: true, effective: false, locked: 'minor' } });
  });
});

describe('REQ-CNS-007/008 when the pre-prompt is shown', () => {
  it('never during the FTUE; first time right before the first rewarded ad offer; once per version', async () => {
    const w = world();
    await w.svc.bootstrap('p');
    expect((await w.svc.privacyChoices('p')).prompt).toBeNull(); // install day, no ranked races
    for (let i = 0; i < 3; i++) await w.ranked('p');
    expect((await w.svc.privacyChoices('p')).prompt).toBeNull(); // still the install game day
    w.advance(86_400_000);
    expect((await w.svc.ads('p')).eligible).toBe(true);
    expect((await w.svc.privacyChoices('p')).prompt).toBe('ad_offer');
    expect((await w.svc.bootstrap('p')).privacyChoices.prompt).toBe('ad_offer');
    await w.svc.notePrivacyPromptShown('p', V);
    await w.svc.notePrivacyPromptShown('p', V);
    const v = await w.svc.privacyChoices('p');
    expect(v).toMatchObject({ prompt: null, required: true });
    expect((await w.svc.state('p')).privacyChoices!.history.filter((h) => h.value === 'shown')).toHaveLength(1);
  });
  it('a player who never sees ads gets it on the home instead', async () => {
    const w = world();
    await w.veteran('p');
    await w.svc.setAdPref('p', 'off');
    expect((await w.svc.privacyChoices('p')).prompt).toBe('next_home');
  });
  it('a new privacy policy version asks again on the home; the earlier choices keep applying meanwhile', async () => {
    const w = world();
    await w.veteran('p');
    await w.svc.setPrivacyChoices('p', { privacyVersion: V, source: 'prompt', analytics: false });
    expect((await w.svc.privacyChoices('p')).required).toBe(false);
    const next = w.mk(withPolicy('2027-01-01'));
    let v = await next.privacyChoices('p');
    expect(v).toMatchObject({ required: true, prompt: 'next_home', policyVersion: '2027-01-01', decidedVersion: V, analytics: { value: false, effective: false } });
    expect(await code(next.setPrivacyChoices('p', { privacyVersion: V, source: 'prompt', analytics: false }))).toBe('CONSENT_VERSION_MISMATCH');
    v = await next.setPrivacyChoices('p', { privacyVersion: '2027-01-01', source: 'prompt' });
    expect(v).toMatchObject({ required: false, prompt: null, decidedVersion: '2027-01-01', analytics: { value: false } });
  });
});

describe('REQ-CNS-010/011 rewarded ads (§21)', () => {
  it('adRequest follows the effective choice; the session keeps its npa; a non-personalised view earns the same reward', async () => {
    const run = async (personalised: boolean) => {
      const w = world();
      await w.veteran('a');
      await w.svc.setAge('a', 1990, 1, false);
      await w.svc.setPrivacyChoices('a', { privacyVersion: V, source: 'prompt', personalizedAds: personalised });
      const ads = await w.svc.ads('a');
      const placement = ads.placements.find((p) => p.available)!;
      const st = await w.svc.adStart('a', placement.id, `c:k:${personalised}`);
      const before = (await w.svc.state('a')).wallet.free;
      const r = await w.svc.adReward('a', w.cb('a', st.sessionId));
      const after = (await w.svc.state('a')).wallet.free;
      return { ads, st, r, gained: after - before, session: await w.svc.adSession('a', st.sessionId) };
    };
    const npa = await run(false), pa = await run(true);
    expect(npa.ads.adRequest).toMatchObject({ npa: 1, nonPersonalized: true, extras: { npa: '1' } });
    expect(pa.ads.adRequest).toMatchObject({ npa: 0, nonPersonalized: false });
    expect(npa.st.adRequest.npa).toBe(1);
    expect(npa.session).toMatchObject({ npa: 1, status: 'rewarded' });
    expect(pa.session).toMatchObject({ npa: 0, status: 'rewarded' });
    expect(npa.r).toMatchObject({ status: 'rewarded' });
    expect(npa.gained).toBe(pa.gained);
    expect(npa.gained).toBeGreaterThan(0);
  });
  it('withdrawing consent after the start does not block the reward of that view', async () => {
    const w = world();
    await w.veteran('a');
    await w.svc.setAge('a', 1990, 1, false);
    await w.svc.setPrivacyChoices('a', { privacyVersion: V, source: 'prompt', personalizedAds: true });
    const p = (await w.svc.ads('a')).placements.find((x) => x.available)!;
    const st = await w.svc.adStart('a', p.id, 'c:k1');
    await w.svc.setPrivacyChoices('a', { privacyVersion: V, source: 'settings', personalizedAds: false, analytics: false });
    expect(await w.svc.adReward('a', w.cb('a', st.sessionId))).toMatchObject({ status: 'rewarded' });
    expect((await w.svc.ads('a')).adRequest.npa).toBe(1);
  });
});

describe('REQ-CNS-012 every KPI event is classified', () => {
  const SRC = join(__dirname, '..', 'src');
  const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : []; });
  /** `name: '…'` literals that are not KPI events (quick chat slot values, admin name resets). */
  const NOT_KPI = new Set(['display', 'horse', 'stable', 'player', 'race', 'time']);
  it('server emits: every literal event name has a class', () => {
    const names = new Set<string>();
    for (const f of files(SRC)) {
      const t = readFileSync(f, 'utf8');
      for (const mm of t.matchAll(/name: '([a-z][a-z0-9_]*)'/g)) if (!NOT_KPI.has(mm[1]!)) names.add(mm[1]!);
      for (const mm of t.matchAll(/emit\(\{ name: [^'{}]*\? '([a-z0-9_]+)' : '([a-z0-9_]+)'/g)) { names.add(mm[1]!); names.add(mm[2]!); }
      // R21 integration: names passed through a typed parameter (e.g. linkService's `LinkKpi` union → service.linkNote)
      for (const mm of t.matchAll(/type \w*Kpi = ((?:'[a-z0-9_]+'(?: \| )?)+);/g)) for (const x of mm[1]!.matchAll(/'([a-z0-9_]+)'/g)) names.add(x[1]!);
    }
    expect(names.size).toBeGreaterThan(80);
    const missing = [...names].filter((n) => !(n in KPI_EVENT_CLASS));
    expect(missing).toEqual([]);
    for (const n of ['purchase', 'refund', 'consent_change', 'consent', 'account_delete', 'ad_reward', 'gacha_draw']) expect(kpiClassOf(n), n).toBe('essential');
    for (const n of ['race_finish', 'login_bonus', 'session_start', 'a11y_setting_change']) expect(kpiClassOf(n), n).toBe('optional');
    for (const n of ['link_resolve', 'link_revoke', 'rematch']) expect(names.has(n), n).toBe(true); // collected from the LinkKpi union
    expect(kpiClassOf('something_new')).toBe('optional');
  });
  it('client events: every accepted name (after clientToKpi) has a class, and none is essential', () => {
    const sample: Record<string, Record<string, unknown>> = {};
    for (const opt of clientEventSchema.options) {
      const name = opt.shape.name.value as string;
      sample[name] = {};
    }
    const mapped = Object.keys(sample).map((n) => (n === 'race_start' ? 'client_race_start' : n));
    expect(mapped.filter((n) => !(n in KPI_EVENT_CLASS))).toEqual([]);
    expect(mapped.filter((n) => kpiClassOf(n) === 'essential')).toEqual([]);
    expect(clientToKpi({ name: 'race_start', at: 1, props: { mode: 'ranked' } } as ClientEvent).name).toBe('client_race_start');
  });
  it('the two lists do not overlap', () => {
    expect(KPI_OPTIONAL.filter((n) => n in KPI_ESSENTIAL)).toEqual([]);
    expect(new Set(KPI_OPTIONAL).size).toBe(KPI_OPTIONAL.length);
    expect(filterKpi([{ name: 'purchase' }, { name: 'race_finish' }], false)).toEqual({ kept: [{ name: 'purchase' }], withheld: 1 });
  });
});

describe('REQ-CNS-013/014 the server enforces the analytics choice', () => {
  const batch = (at: number) => ({ platform: 'ios' as const, appVersion: '1.0.0', events: [{ name: 'session_start' as const, at }, { name: 'screen_view' as const, at, props: { screen: 'home' } }] });
  it('client batches: written with analytics on; withheld (but counted) with analytics off', async () => {
    const w = world();
    await w.svc.bootstrap('p');
    w.kpi.length = 0;
    expect(await w.svc.kpiIngest('p', batch(w.now()))).toEqual({ accepted: 2, dropped: 0, withheld: 0 });
    expect(w.kpi.map((k) => k.name)).toEqual(['session_start', 'screen_view']);
    await w.svc.setPrivacyChoices('p', { privacyVersion: V, source: 'settings', analytics: false });
    w.kpi.length = 0;
    expect(await w.svc.kpiIngest('p', batch(w.now()))).toEqual({ accepted: 2, dropped: 0, withheld: 2 });
    expect(w.kpi).toEqual([]);
    expect((await w.svc.state('p') as unknown as { kpi: { events: number } }).kpi.events).toBe(4);
  });
  it('server events: optional ones (race_finish, login…) are not written; essential ones (purchase, consent_change) are', async () => {
    const w = world();
    await w.svc.bootstrap('p');
    await w.svc.setPrivacyChoices('p', { privacyVersion: V, source: 'settings', analytics: false });
    w.kpi.length = 0;
    await w.ranked('p');
    expect(w.kpi.filter((k) => k.name === 'race_finish')).toEqual([]);
    await w.svc.setAge('p', 1990, 1, false);
    await w.buy('p', 'coin_160');
    expect(w.kpi.map((k) => k.name)).toContain('purchase');
    await w.svc.setPrivacyChoices('p', { privacyVersion: V, source: 'settings', analytics: true });
    expect(changes(w.kpi).at(-1)).toEqual(['analytics', 'on', 'settings']);
    await w.ranked('p');
    expect(w.kpi.filter((k) => k.name === 'race_finish')).toHaveLength(1);
    // reads that emit (stable visit) go through the same gate
    await w.svc.setPrivacyChoices('p', { privacyVersion: V, source: 'settings', analytics: false });
    w.kpi.length = 0;
    await w.svc.stableVisit('p', 'someone');
    expect(w.kpi).toEqual([]);
  });
  it('a child without a guardian: optional events withheld by default', async () => {
    const w = world();
    await w.svc.bootstrap('k');
    await w.svc.setAge('k', 2016, 1, false);
    w.kpi.length = 0;
    expect((await w.svc.kpiIngest('k', batch(w.now()))).withheld).toBe(2);
  });
});

describe('REQ-CNS-015 / §51 / HTTP', () => {
  it('the routes are never gated (maintenance or version)', () => {
    for (const [mth, p] of [['GET', '/v1/privacy/choices'], ['PUT', '/v1/privacy/choices'], ['PUT', '/v1/privacy/platform'], ['POST', '/v1/privacy/prompt-shown']] as const) expect(isExempt(mth, p), p).toBe(true);
  });
  it('the data export classifies the key under account and carries the whole record', async () => {
    const w = world();
    await w.svc.bootstrap('p');
    await w.svc.setPrivacyPlatform('p', { os: 'ios', att: 'denied' });
    await w.svc.setPrivacyChoices('p', { privacyVersion: V, source: 'prompt', analytics: false });
    expect(classifyKey('privacyChoices')).toEqual({ section: 'account' });
    const s = await w.svc.state('p');
    const doc = buildExportDocument(m, s, { ledger: s.ledger, gacha: [], names: {}, reportsMade: [], kpiEvents: null }, 'dex_1', 'ja', w.now()) as unknown as { account: { privacyChoices: unknown }; unclassified: string[] };
    expect(doc.unclassified).toEqual([]);
    expect(doc.account.privacyChoices).toMatchObject({ analytics: false, decidedVersion: V, platform: { os: 'ios', att: 'denied' } });
  });
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
  it('GET / PUT / platform / prompt-shown; 401 without auth; 400 for extra or bad fields; 409 for a stale version', async () => {
    const { c, w } = ctx();
    await w.svc.bootstrap('u');
    expect((await handle(req('GET', '/v1/privacy/choices'), {}, c)).status).toBe(401);
    expect(await (await handle(req('GET', '/v1/privacy/choices', 'u'), {}, c)).json()).toMatchObject({ required: true, policyVersion: V });
    const put = await handle(req('PUT', '/v1/privacy/choices', 'u', { privacyVersion: V, source: 'settings', analytics: false }), {}, c);
    expect(put.status).toBe(200);
    expect(await put.json()).toMatchObject({ analytics: { effective: false }, required: false });
    expect((await handle(req('PUT', '/v1/privacy/choices', 'u', { privacyVersion: V, source: 'settings', extra: 1 }), {}, c)).status).toBe(400);
    expect((await handle(req('PUT', '/v1/privacy/choices', 'u', { privacyVersion: V, source: 'nowhere' }), {}, c)).status).toBe(400);
    expect((await handle(req('PUT', '/v1/privacy/choices', 'u', { privacyVersion: 'x', source: 'settings' }), {}, c)).status).toBe(409);
    expect((await handle(req('PUT', '/v1/privacy/platform', 'u', { os: 'ios', att: 'maybe' }), {}, c)).status).toBe(400);
    expect(await (await handle(req('PUT', '/v1/privacy/platform', 'u', { os: 'ios', att: 'denied' }), {}, c)).json()).toMatchObject({ platform: { att: 'denied' } });
    expect((await handle(req('POST', '/v1/privacy/prompt-shown', 'u', { privacyVersion: V }), {}, c)).status).toBe(200);
    expect(await (await handle(req('GET', '/v1/player', 'u'), {}, c)).json()).toMatchObject({ privacyChoices: { required: false, analytics: { effective: false } } });
  });
});
