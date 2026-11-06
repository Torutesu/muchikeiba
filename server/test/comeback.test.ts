import { describe, expect, it } from 'vitest';
import { MemoryPlayerRepo, PlayerService } from '../src/domain/service.js';
import { FakeStoreVerifier } from '../src/domain/purchase.js';
import { seededRng } from '../src/domain/rng.js';
import type { AppError } from '../src/domain/errors.js';
import type { Master } from '../src/domain/master.js';
import type { KpiRecord } from '../src/domain/kpi.js';
import { comebackProblems, changelogProblems, rewardValue, type ComebackConfig } from '../src/domain/comeback.js';
import { uxProblems } from '../src/domain/onboarding.js';
import { collectItemIds } from '../src/domain/visuals.js';
import { resolveBundle } from '../src/ops/config.js';
import { handle, type AppContext, type PlayerInvoker } from '../src/http/app.js';
import { dayRule, gameDayStartMs } from '../src/domain/time.js';
import { jstHour } from '../src/domain/push.js';
import { m } from './helpers.js';

const T0 = Date.UTC(2026, 10, 3, 3); // 2026-11-03 12:00 JST (midnight rollover before 12-01)
const DAY = 86_400_000;
const cfg = m.progression.comeback!;

function setup(master: Master = m, start = T0) {
  let now = start;
  const repo = new MemoryPlayerRepo();
  const kpi: KpiRecord[] = [];
  const svc = new PlayerService(repo, { master, rng: seededRng(7), clock: () => now, verifiers: { fake: new FakeStoreVerifier() }, onKpi: (_id, r) => { kpi.push(...r); } });
  let n = 0;
  const race = (id: string, place = 5) => svc.applyRace(id, { raceId: `r${++n}`, mode: 'ranked', place, fieldSize: 12, newRating: null, void: false, humans: 2 });
  const k = () => `c:k${++n}`;
  return { svc, repo, kpi, race, k, set: (t: number) => { now = t; }, advance: (ms: number) => { now += ms; }, now: () => now };
}
const code = async (p: Promise<unknown>) => { try { await p; return 'ok'; } catch (e) { return (e as AppError).code; } };

/** A player who played 5 races on day 0. */
async function engaged(x: ReturnType<typeof setup>, id = 'p') {
  await x.svc.bootstrap(id);
  for (let i = 0; i < 5; i++) await x.race(id);
}

describe('REQ-CB-001..003 lapse detection and the comeback window', () => {
  it('a 7-game-day lapse starts one short-tier window on return (comeback_start), a 6-day one does not', async () => {
    const x = setup();
    await engaged(x);
    x.advance(6 * DAY);
    expect((await x.svc.comeback('p')).active).toBe(false);
    const y = setup();
    await engaged(y);
    y.advance(7 * DAY);
    await y.svc.bootstrap('p');
    const v = await y.svc.comeback('p');
    expect(v.active).toBe(true);
    expect(v.window).toMatchObject({ tier: 'short', lapseDays: 7, day: 1, days: 14, remainingDays: 14, showWelcome: true, completed: false });
    expect(v.window!.login).toMatchObject({ claimed: 0, total: 7, claimableToday: true });
    expect(v.window!.missions.map((d) => d.id)).toEqual(cfg.missions.map((d) => d.id));
    expect(y.kpi.filter((r) => r.name === 'comeback_start')).toEqual([expect.objectContaining({ s1: 'short', value: 7 })]);
  });

  it('tiers follow the lapse (14 → mid, 30 → long)', async () => {
    for (const [days, tier] of [[14, 'mid'], [30, 'long']] as const) {
      const x = setup();
      await engaged(x);
      x.advance(days * DAY);
      expect((await x.svc.comeback('p')).window).toMatchObject({ tier, lapseDays: days });
    }
  });

  it('server deliveries are not activity: a push alarm or a friend request does not hide a lapse', async () => {
    const x = setup();
    await engaged(x);
    x.advance(4 * DAY);
    await x.svc.runNudges('p');
    await x.svc.friendReceive('p', 'q', 'Q');
    x.advance(3 * DAY);
    expect((await x.svc.comeback('p')).window).toMatchObject({ lapseDays: 7 });
  });

  it('not for a player who never played (minRacesBefore), nor during a window, nor within the cooldown after the previous start', async () => {
    const idle = setup();
    await idle.svc.bootstrap('p');
    idle.advance(10 * DAY);
    expect((await idle.svc.comeback('p')).active).toBe(false);

    const x = setup();
    await engaged(x);
    x.advance(7 * DAY);
    const w1 = (await x.svc.comeback('p')).window!;
    // a lapse inside the window does not start another one
    x.advance(8 * DAY);
    expect((await x.svc.comeback('p')).window!.id).toBe(w1.id);
    // after the window, a fresh lapse inside the 60-day cooldown (from the first START) is ignored
    x.advance(20 * DAY); // day 35 since the start
    expect((await x.svc.comeback('p')).active).toBe(false);
    x.advance(32 * DAY); // day 67 since the first start (≥ 60), 32 days lapsed
    const w2 = (await x.svc.comeback('p')).window!;
    expect(w2.id).not.toBe(w1.id);
    expect(w2.tier).toBe('long');
    expect(x.kpi.filter((r) => r.name === 'comeback_start').length).toBe(2);
  });

  it('never while the account deletion is pending (REQ-UXS-040), and claims are blocked', async () => {
    const x = setup();
    await engaged(x);
    const tok = ((await x.svc.requestDeletion('p', null)) as { confirmToken: string }).confirmToken;
    await x.svc.requestDeletion('p', tok);
    x.advance(8 * DAY);
    expect((await x.svc.comeback('p')).active).toBe(false);

    const y = setup();
    await engaged(y);
    y.advance(7 * DAY);
    await y.svc.comeback('p');
    const t2 = ((await y.svc.requestDeletion('p', null)) as { confirmToken: string }).confirmToken;
    await y.svc.requestDeletion('p', t2);
    const v = await y.svc.comeback('p');
    expect(v.window).toMatchObject({ blocked: true, login: { claimableToday: false } });
    expect(await code(y.svc.comebackClaimLogin('p', y.k()))).toBe('DELETION_PENDING');
    expect(await code(y.svc.comebackClaimMission('p', 'cb_race', y.k()))).toBe('DELETION_PENDING');
    // cancelling the deletion gives the window back
    await y.svc.cancelDeletion('p');
    expect(await code(y.svc.comebackClaimLogin('p', y.k()))).toBe('ok');
  });
});

describe('REQ-CB-004/005 comeback login track and missions', () => {
  it('one login day per game day (cumulative), free coins and items only, comeback_day / comeback_complete', async () => {
    const x = setup();
    await engaged(x);
    x.advance(7 * DAY);
    await x.svc.comeback('p');
    const free0 = (await x.svc.view('p')).wallet.free;
    const d1 = await x.svc.comebackClaimLogin('p', x.k());
    expect(d1).toMatchObject({ day: 1, reward: { freeCoins: 100 } });
    expect((await x.svc.view('p')).wallet).toMatchObject({ free: free0 + 100, paid: 0 });
    expect(await code(x.svc.comebackClaimLogin('p', x.k()))).toBe('ALREADY_CLAIMED');
    x.advance(2 * DAY); // a missed day is not lost
    expect(await x.svc.comebackClaimLogin('p', x.k())).toMatchObject({ day: 2, reward: { items: [{ itemId: 'gacha_ticket', qty: 1 }] } });
    // missions count from the window start: day-0 races do not count
    let v = (await x.svc.comeback('p')).window!;
    expect(v.missions.find((d) => d.id === 'cb_race')).toMatchObject({ progress: 0, claimable: false });
    expect(await code(x.svc.comebackClaimMission('p', 'cb_race', x.k()))).toBe('NOT_ELIGIBLE');
    for (let i = 0; i < 3; i++) await x.race('p');
    await x.svc.useTicket('p', 'gacha_ticket', 'standard', x.k());
    const h = (await x.svc.state('p')).horses[0]!;
    await x.svc.care('p', h.id, 'fresh_water', x.k());
    await x.svc.stableSave('p', { decor: [], themeId: null } as never).catch(() => undefined);
    v = (await x.svc.comeback('p')).window!;
    for (const d of v.missions.filter((d) => d.claimable)) await x.svc.comebackClaimMission('p', d.id, x.k());
    expect(await code(x.svc.comebackClaimMission('p', 'cb_race', x.k()))).toBe('ALREADY_CLAIMED');
    expect(await code(x.svc.comebackClaimMission('p', 'nope', x.k()))).toBe('NOT_FOUND');
    // finish the track and the remaining missions
    for (let d = 3; d <= 7; d++) { x.advance(DAY); await x.svc.comebackClaimLogin('p', x.k()); }
    x.advance(DAY);
    expect(await code(x.svc.comebackClaimLogin('p', x.k()))).toBe('ALREADY_CLAIMED');
    const s = await x.svc.state('p');
    const w = s.comeback!.window!;
    const left = cfg.missions.filter((d) => !w.missionsClaimed.includes(d.id));
    if (left.some((d) => d.kind === 'stable')) { const { countOnboarding } = await import('../src/domain/onboarding.js'); countOnboarding(s, 'stable'); await x.repo.put(s); }
    for (const d of (await x.svc.comeback('p')).window!.missions.filter((d) => d.claimable)) await x.svc.comebackClaimMission('p', d.id, x.k());
    const done = (await x.svc.comeback('p')).window!;
    expect(done.completed).toBe(true);
    expect(x.kpi.filter((r) => r.name === 'comeback_day').map((r) => r.value)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(x.kpi.filter((r) => r.name === 'comeback_complete')).toHaveLength(1);
    // the ledger shows free grants only (never paid currency)
    expect((await x.svc.state('p')).ledger.filter((e) => /comeback/.test(e.reason)).every((e) => e.currency === 'free' && e.kind === 'grant')).toBe(true);
    // after the window nothing can be claimed
    x.advance(14 * DAY);
    expect(await code(x.svc.comebackClaimLogin('p', x.k()))).toBe('NOT_ELIGIBLE');
  });

  it('the welcome screen is shown once', async () => {
    const x = setup();
    await engaged(x);
    x.advance(7 * DAY);
    await x.svc.comeback('p');
    const a = await x.svc.comebackWelcomed('p');
    x.advance(1000);
    expect((await x.svc.comebackWelcomed('p')).welcomedAt).toBe(a.welcomedAt);
    expect((await x.svc.comeback('p')).window!.showWelcome).toBe(false);
  });
});

describe('REQ-CB-006 pass XP catch-up', () => {
  it('doubles race XP until the season median, capped by lapse days × perLapseDayXp and maxBonusXp', async () => {
    const x = setup(m, Date.UTC(2026, 10, 20, 3)); // 11-20
    await engaged(x);
    const xp0 = (await x.svc.state('p')).seasonPass.xp; // 5 races × 20
    x.advance(7 * DAY); // 11-27: median target 60 × 27 = 1620; cap min(1500, 7 × 100, 1620 − 100) = 700
    const w = (await x.svc.comeback('p')).window!;
    expect(w.catchUp).toMatchObject({ targetXp: 1620, capXp: 700, grantedXp: 0, bonusPerRace: 20, active: true });
    const r = await x.race('p');
    expect(r).toMatchObject({ comebackXp: 20 });
    expect((await x.svc.state('p')).seasonPass.xp).toBe(xp0 + 40);
    for (let i = 0; i < 60; i++) await x.race('p');
    const after = (await x.svc.comeback('p')).window!.catchUp;
    expect(after.grantedXp).toBe(700);
    expect(after.remainingXp).toBe(0);
    expect(xp0).toBe(100);
  });

  it('stops at the median target and in a new season', async () => {
    const x = setup(m, Date.UTC(2026, 10, 1, 3)); // 11-01
    await engaged(x);
    x.advance(7 * DAY); // 11-08: target 480, xp 100 → cap min(700, 380) = 380
    const w = (await x.svc.comeback('p')).window!;
    expect(w.catchUp).toMatchObject({ targetXp: 480, capXp: 380 });
    for (let i = 0; i < 30; i++) await x.race('p');
    // the race XP itself also moves toward the median: 9 races × (20 + 20) reach 460, the 10th race's own XP reaches 480
    expect((await x.svc.comeback('p')).window!.catchUp).toMatchObject({ grantedXp: 180, remainingXp: 0 });
    expect((await x.svc.state('p')).seasonPass.xp).toBe(100 + 30 * 20 + 180);
  });
});

describe('REQ-CB-007 lapse reminders (opt-in category, caps, quiet hours)', () => {
  it('day 3 and day 7 at 19:00 JST, only when opted in; the day-7 text only when a window would start', async () => {
    const x = setup();
    await engaged(x);
    await x.svc.registerDevice('p', 'tok-aaaaaaaa', 'ios');
    // opt-in default: off → no wake
    expect((await x.svc.pushPreferences('p')).categories.comeback).toBe(false);
    expect(await x.svc.nextWakeOf('p')).toBeNull();
    await x.svc.setPushPreferences('p', { categories: { comeback: true } });
    const rule = dayRule(m);
    const day3 = gameDayStartMs('2026-11-06', rule) + 19 * 3_600_000;
    expect(jstHour(day3)).toBe(19);
    expect(await x.svc.nextWakeOf('p')).toBe(day3);
    x.set(day3);
    await x.svc.runNudges('p');
    let out = (await x.svc.state('p')).push!.outbox;
    expect(out.at(-1)).toMatchObject({ templateId: 'lapse_3d', category: 'comeback' });
    const day7 = gameDayStartMs('2026-11-10', rule) + 19 * 3_600_000;
    expect(await x.svc.nextWakeOf('p')).toBe(day7);
    x.set(day7);
    await x.svc.runNudges('p');
    out = (await x.svc.state('p')).push!.outbox;
    expect(out.at(-1)).toMatchObject({ templateId: 'lapse_7d' });
    expect(await x.svc.nextWakeOf('p')).toBeNull();
    expect(m.push.templates.lapse_7d!.timeSensitive).toBe(false);
  });

  it('activity re-arms; no reminder while deletion is pending or for the day-7 text when not eligible', async () => {
    const x = setup();
    await x.svc.bootstrap('p'); // never raced: not eligible for a window
    await x.svc.registerDevice('p', 'tok-aaaaaaaa', 'ios');
    await x.svc.setPushPreferences('p', { categories: { comeback: true } });
    x.advance(2 * DAY);
    await x.svc.bootstrap('p');
    const rule = dayRule(m);
    expect(await x.svc.nextWakeOf('p')).toBe(gameDayStartMs('2026-11-08', rule) + 19 * 3_600_000);
    x.set(gameDayStartMs('2026-11-08', rule) + 19 * 3_600_000);
    await x.svc.runNudges('p');
    x.set(gameDayStartMs('2026-11-12', rule) + 19 * 3_600_000);
    await x.svc.runNudges('p');
    const ids = (await x.svc.state('p')).push!.outbox.map((o) => o.templateId);
    expect(ids).toEqual(['lapse_3d']); // day 7 skipped: returning would not start a window
    const y = setup();
    await engaged(y);
    await y.svc.registerDevice('p', 'tok-aaaaaaaa', 'ios');
    await y.svc.setPushPreferences('p', { categories: { comeback: true } });
    const tok = ((await y.svc.requestDeletion('p', null)) as { confirmToken: string }).confirmToken;
    const sched = await y.svc.requestDeletion('p', tok) as { deleteAt: number };
    expect(await y.svc.nextWakeOf('p')).toBe(sched.deleteAt);
  });

  it('uses the daily cap and quiet hours of push.json', async () => {
    const quiet = { ...m, progression: { ...m.progression, comeback: { ...cfg, pushHourJst: 23 } } };
    const x = setup(quiet);
    await engaged(x);
    await x.svc.registerDevice('p', 'tok-aaaaaaaa', 'ios');
    await x.svc.setPushPreferences('p', { categories: { comeback: true } });
    const at = (await x.svc.nextWakeOf('p'))!;
    expect(jstHour(at)).toBe(23);
    x.set(at);
    await x.svc.runNudges('p');
    const item = (await x.svc.state('p')).push!.outbox.at(-1)!;
    expect(jstHour(item.notBefore)).toBe(8); // delayed to the end of quiet hours
  });
});

describe('REQ-CB-008 what\'s new', () => {
  it('lists entries, banners and events that went live since the player last looked, newest first, once', async () => {
    const x = setup(m, Date.UTC(2026, 9, 25, 3)); // 10-25
    await engaged(x);
    expect((await x.svc.whatsNew('p')).showCard).toBe(false);
    x.set(Date.UTC(2026, 10, 7, 3)); // 11-07
    await x.svc.bootstrap('p');
    const wn = await x.svc.whatsNew('p');
    expect(wn.showCard).toBe(true);
    const ids = wn.items.map((i) => i.id);
    expect(ids).toEqual(expect.arrayContaining(['skills_v1', 'my_stable_v1', 'gacha_calendar_v1', 'banner_pickup_ginga', 'event_sprint_cup_2026_11']));
    expect(ids).not.toContain('day_rollover_4am'); // not live yet
    expect(wn.items.map((i) => i.at)).toEqual([...wn.items.map((i) => i.at)].sort((a, b) => b - a));
    expect(wn.items.find((i) => i.id === 'banner_pickup_ginga')).toMatchObject({ kind: 'banner', bannerId: 'pickup_ginga', feature: 'scout' });
    await x.svc.whatsNewSeen('p', wn.upTo);
    expect((await x.svc.whatsNew('p')).showCard).toBe(false);
    x.set(Date.UTC(2026, 11, 2, 3));
    expect((await x.svc.whatsNew('p')).items.map((i) => i.id)).toContain('day_rollover_4am');
  });

  it('a new player has no backlog; seen can not move into the future', async () => {
    const x = setup();
    await x.svc.bootstrap('p');
    expect((await x.svc.whatsNew('p')).items).toEqual([]);
    expect((await x.svc.whatsNewSeen('p', T0 + 10 * DAY)).seenUpTo).toBe(T0);
  });
});

describe('REQ-CB-011 comeback offer in the shop', () => {
  it('recommends this season\'s pass once, at its normal price and real season end, not twice with T3', async () => {
    const x = setup();
    await engaged(x);
    x.advance(7 * DAY);
    const w = (await x.svc.comeback('p')).window!;
    const o = await x.svc.shopOffers('p');
    const cb = o.offers.find((x) => x.touchpoint === 'comeback')!;
    expect(cb).toMatchObject({ id: `comeback_${w.id}`, productId: 'season_pass', showPopup: true, endsAt: Date.UTC(2026, 10, 30, 15) });
    expect(o.offers.filter((x) => x.touchpoint === 'T3' && x.showPopup)).toEqual([]);
    await x.svc.markOfferViewed('p', cb.id);
    expect((await x.svc.shopOffers('p')).offers.find((x) => x.touchpoint === 'comeback')!.showPopup).toBe(false);
    x.advance(14 * DAY);
    expect((await x.svc.shopOffers('p')).offers.some((x) => x.touchpoint === 'comeback')).toBe(false);
  });
});

describe('REQ-CB-009/010 config guard rails', () => {
  const known = new Set(collectItemIds(m));
  const withCfg = (c: unknown) => comebackProblems({ ...m, progression: { ...m.progression, comeback: c as ComebackConfig } });
  it('the shipped config is valid and each tier is worth less than a daily player earns in its lapse', () => {
    expect(uxProblems(m, known)).toEqual([]);
    const missions = cfg.missions.reduce((a, d) => a + rewardValue(d.reward), 0);
    for (const t of cfg.tiers) expect(t.loginTrack.reduce((a, r) => a + rewardValue(r), 0) + missions).toBeLessThanOrEqual(t.minLapseDays * cfg.valueCapPerLapseDay);
    expect(cfg.valueCapPerLapseDay).toBeLessThan(179); // the daily free player's coins per day (balance-targets §4)
  });
  it('rejects paid items, cosmetics, horses, pass XP, collect missions, oversized tracks and non-comeback push templates', () => {
    const bad = (patch: Partial<ComebackConfig>) => withCfg({ ...cfg, ...patch });
    expect(bad({ tiers: [{ id: 'short', minLapseDays: 7, loginTrack: [{ items: [{ itemId: 'decor_golden_horseshoe', qty: 1 }] }] }] }).join()).toMatch(/not allowed/);
    expect(bad({ tiers: [{ id: 'short', minLapseDays: 7, loginTrack: [{ horse: 't_partner' } as never] }] }).join()).toMatch(/horse/);
    expect(bad({ missions: [{ ...cfg.missions[0]!, reward: { passXp: 100 } as never }] }).join()).toMatch(/passXp/);
    expect(bad({ missions: [{ ...cfg.missions[0]!, kind: 'collect' as never }] }).join()).toMatch(/kind/);
    expect(bad({ tiers: [{ id: 'short', minLapseDays: 7, loginTrack: [{ items: [{ itemId: 'gacha_ticket_10', qty: 2 }] }] }] }).join()).toMatch(/valueCapPerLapseDay/);
    expect(bad({ pushes: [{ afterDays: 3, templateId: 'season_end' }] }).join()).toMatch(/comeback category/);
    expect(bad({ catchUp: { ...cfg.catchUp, perLapseDayXp: 500 } }).join()).toMatch(/perLapseDayXp/);
    expect(bad({ tiers: [cfg.tiers[1]!, cfg.tiers[0]!] }).join()).toMatch(/increase/);
  });
  it('remote config: progression.comeback and changelog are validated', () => {
    expect(() => resolveBundle(m, { progression: { comeback: { ...cfg, cooldownDays: 1 } } })).toThrow(/cooldownDays/);
    expect(() => resolveBundle(m, { changelog: [{ id: 'x', kind: 'feature', title: 't', body: 'b' }] })).toThrow(/exactly one of day/);
    const r = resolveBundle(m, { changelog: [{ id: 'x', kind: 'feature', title: 't', body: 'b', day: '2026-11-10' }] });
    expect(r.master.changelog).toHaveLength(1);
    expect(changelogProblems(m.changelog)).toEqual([]);
  });
});

describe('HTTP routes', () => {
  it('GET /v1/comeback, POST login / missions / welcome, GET /v1/whats-new, POST /v1/whats-new/seen', async () => {
    const x = setup();
    await engaged(x, 'u');
    x.advance(7 * DAY);
    const svc = x.svc;
    const invoker: PlayerInvoker = { invoke: (async (method: string, ...args: unknown[]) => (svc as unknown as Record<string, (...a: unknown[]) => unknown>)[method]!.apply(svc, args)) as PlayerInvoker['invoke'] };
    const c = { master: m, authenticate: async () => 'u', player: () => invoker, clock: x.now } as unknown as AppContext;
    const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
      const res = await handle(new Request(`https://x${path}`, { method, headers: { 'content-type': 'application/json', ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }), {}, c);
      return { status: res.status, body: (await res.json()) as any };
    };
    expect((await call('GET', '/v1/comeback')).body).toMatchObject({ active: true, window: { tier: 'short' }, push: { category: 'comeback', enabled: false } });
    expect((await call('POST', '/v1/comeback/login')).body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    const a = await call('POST', '/v1/comeback/login', undefined, { 'idempotency-key': 'k1' });
    expect(a.body).toMatchObject({ day: 1 });
    expect((await call('POST', '/v1/comeback/login', undefined, { 'idempotency-key': 'k1' })).body).toEqual(a.body); // retried
    expect((await call('POST', '/v1/comeback/missions/BAD!/claim', undefined, { 'idempotency-key': 'k2' })).status).toBe(400);
    expect((await call('POST', '/v1/comeback/missions/cb_race/claim', undefined, { 'idempotency-key': 'k3' })).body.error.code).toBe('NOT_ELIGIBLE');
    expect((await call('POST', '/v1/comeback/welcome')).body).toMatchObject({ welcomedAt: x.now() });
    const wn = (await call('GET', '/v1/whats-new')).body;
    expect(wn).toMatchObject({ upTo: x.now() });
    expect((await call('POST', '/v1/whats-new/seen', { upTo: wn.upTo })).body).toMatchObject({ seenUpTo: wn.upTo });
    expect((await call('POST', '/v1/whats-new/seen', { upTo: 'x' })).status).toBe(400);
  });
});
