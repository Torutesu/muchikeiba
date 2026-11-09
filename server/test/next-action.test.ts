import { describe, expect, it } from 'vitest';
import { m } from './helpers.js';
import { MemoryPlayerRepo, PlayerService } from '../src/domain/service.js';
import { seededRng } from '../src/domain/rng.js';
import type { AppError } from '../src/domain/errors.js';
import type { KpiRecord } from '../src/domain/kpi.js';
import { clientBatchSchema } from '../src/domain/kpi.js';
import type { Master } from '../src/domain/master.js';
import {
  CHIP_ONLY, computeNextActions, FORBIDDEN_FEATURES, KIND_SCREEN, NEXT_KINDS, nextActionProblems, nextActionSummary, nextActionsView,
  type NextActionConfig, type NextSummary,
} from '../src/domain/nextAction.js';
import { deliverGift } from '../src/domain/giftBox.js';
import { handle, type AppContext, type PlayerInvoker } from '../src/http/app.js';
import { uxProblems } from '../src/domain/onboarding.js';
import { dayRule, gameDayKey, gameDayStartMs, addJstDays } from '../src/domain/time.js';

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 11, 8, 3); // 2026-12-08 12:00 JST (after the 04:00 rollover took effect)
const cfg = m.progression.nextActions as NextActionConfig;
const withCfg = (patch: Partial<NextActionConfig>): Master => ({ ...m, progression: { ...m.progression, nextActions: { ...cfg, ...patch } } as Master['progression'] });
const code = async (p: Promise<unknown>) => { try { await p; } catch (e) { return (e as AppError).code; } return 'NO_ERROR'; };

function world(master: Master = m) {
  let now = T0;
  const kpi: KpiRecord[] = [];
  const svc = new PlayerService(new MemoryPlayerRepo(), { master, rng: seededRng(5), clock: () => now, verifiers: {}, onKpi: (_id, recs) => { kpi.push(...recs); } });
  let n = 0;
  /** A player past onboarding: partner named, `races` confirmed ranked races. */
  const player = async (id: string, races = 2) => {
    await svc.bootstrap(id);
    await svc.grantPartner(id, 'アイボウ', `c:partner-${id}`);
    for (let i = 0; i < races; i++) await svc.applyRace(id, { raceId: `r_${id}_${n++}`, mode: 'ranked', place: 5, fieldSize: 12, newRating: null, void: false, humans: 2 });
  };
  return { svc, kpi, player, now: () => now, advance: (ms: number) => { now += ms; } };
}

/** A summary with nothing to do (every field off). */
const quiet = (o: Partial<NextSummary> = {}): NextSummary => ({
  now: T0, deleting: false, onboarding: false, unlocked: ['race', 'partner', 'scout', 'stable', 'missions', 'login_bonus', 'season_pass', 'training', 'rival', 'weekly_challenge', 'teams', 'events'],
  newFeatures: [], loginBonusClaimable: false, missions: [], passClaimable: 0, giftExpiries: [], trainingOpenExpiresAt: null, trainingSlotsLeft: 0,
  exchanges: [], rival: null, weeklyChallenge: null, teamGoal: null, firstWin: null, scoutTickets: 0, ...o,
});

describe('§45 config (REQ-NEXT-011)', () => {
  it('the master config is valid and part of the boot / remote-config checks', () => {
    expect(nextActionProblems(m)).toEqual([]);
    expect(uxProblems(m, new Set(Object.keys(m.items?.tickets ?? {}))).filter((p) => p.includes('nextActions'))).toEqual([]);
    expect(nextActionProblems({ progression: { ...m.progression, nextActions: undefined } } as Master)).toEqual([]);
  });
  it('rejects duplicates, a missing race card, wrong thresholds, purchase features and more than 2 chips', () => {
    const p = (patch: Partial<NextActionConfig>) => nextActionProblems(withCfg(patch)).join('\n');
    expect(p({ maxChips: 3 })).toMatch(/maxChips/);
    expect(p({ rules: [...cfg.rules, { kind: 'login_bonus', priority: 1 }] })).toMatch(/duplicate kind login_bonus/);
    expect(p({ rules: cfg.rules.map((r) => (r.kind === 'race' ? { ...r, priority: 900 } : r)) })).toMatch(/priority 900 is already used/);
    expect(p({ rules: cfg.rules.filter((r) => r.kind !== 'race') })).toMatch(/race is required/);
    expect(p({ rules: [...cfg.rules, { kind: 'first_race', priority: 1 }] })).toMatch(/first_race is decided/);
    expect(p({ rules: cfg.rules.map((r) => (r.kind === 'race' ? { ...r, threshold: 2 } : r)) })).toMatch(/race takes no threshold/);
    expect(p({ rules: cfg.rules.map((r) => (r.kind === 'gift_expiring' ? { kind: r.kind, priority: r.priority } : r)) })).toMatch(/needs a threshold/);
    expect(p({ rules: cfg.rules.map((r) => (r.kind === 'gift_expiring' ? { ...r, threshold: 30 } : r)) })).toMatch(/threshold must be 1..14/);
    for (const f of FORBIDDEN_FEATURES) {
      expect(p({ rules: cfg.rules.map((r) => (r.kind === 'feature_unlocked' ? { ...r, features: [f as 'shop'] } : r)) })).toMatch(/cannot be announced/);
    }
    expect(p({ rules: cfg.rules.map((r) => (r.kind === 'race' ? { ...r, features: ['rival'] } : r)) })).toMatch(/only feature_unlocked lists features/);
    expect(p({ rules: [...cfg.rules, { kind: 'shop' as 'race', priority: 3 }] })).toMatch(/kind/);
  });
});

describe('§45 the choice (REQ-NEXT-002/003/006)', () => {
  it('is pure: the same summary gives the same result; priorities decide the order', () => {
    const x = quiet({ loginBonusClaimable: true, missions: [{ left: 0, claimable: true }, { left: 1, claimable: false }], scoutTickets: 2 });
    const a = computeNextActions(cfg, x), b = computeNextActions(cfg, structuredClone(x));
    expect(a).toEqual(b);
    expect(a.primary?.kind).toBe('login_bonus');
    expect(a.chips.map((c) => c.kind)).toEqual(['missions_claim', 'missions_close']);
    // reversed priorities reverse the result: the order comes from data
    const flipped = { ...cfg, rules: cfg.rules.map((r) => ({ ...r, priority: r.kind === 'race' ? 0 : 1000 - r.priority })) };
    expect(computeNextActions(flipped, x).primary?.kind).toBe('missions_close');
  });
  it('never makes scout_ticket the primary card, never shows race as a chip, at most maxChips chips', () => {
    const r = computeNextActions(cfg, quiet({ scoutTickets: 3 }));
    expect(r.primary?.kind).toBe('race');
    expect(r.chips.map((c) => c.kind)).toEqual(['scout_ticket']);
    expect([...CHIP_ONLY]).toEqual(['scout_ticket']);
    const many = quiet({ loginBonusClaimable: true, passClaimable: 2, missions: [{ left: 0, claimable: true }], scoutTickets: 1, trainingSlotsLeft: 3 });
    expect(computeNextActions(cfg, many).chips).toHaveLength(2);
    expect(computeNextActions({ ...cfg, maxChips: 0 }, many).chips).toHaveLength(0);
    expect(computeNextActions(cfg, quiet()).chips).toEqual([]);
  });
  it('no kind opens a purchase screen (legal guard)', () => {
    const screens = Object.values(KIND_SCREEN);
    for (const bad of ['shop', 'store', 'purchase', 'gacha_paid', 'pass_purchase']) expect(screens).not.toContain(bad);
    expect(Object.keys(KIND_SCREEN).sort()).toEqual([...NEXT_KINDS].sort());
  });
  it('deadlines are real times from data; thresholds come from the config', () => {
    const exp = T0 + 2 * DAY;
    const r = computeNextActions(cfg, quiet({ giftExpiries: [exp, T0 + 2.5 * DAY, T0 + 20 * DAY] }));
    expect(r.primary).toMatchObject({ kind: 'gift_expiring', screen: 'gift_box', count: 2, deadlineAt: exp, dismissible: true });
    expect(computeNextActions(cfg, quiet({ giftExpiries: [T0 + 4 * DAY] })).primary?.kind).toBe('race'); // threshold 3 days
    const ex = computeNextActions(cfg, quiet({ exchanges: [{ eventId: 'ev_b', points: 40, closesAtMs: T0 + DAY }, { eventId: 'ev_a', points: 10, closesAtMs: T0 + 5 * DAY }] }));
    expect(ex.primary).toMatchObject({ kind: 'exchange_closing', refId: 'ev_b', count: 40, deadlineAt: T0 + DAY, screen: 'event_exchange' });
    expect(computeNextActions(cfg, quiet({ rival: { weekEndsAt: T0 + 3 * DAY, rankedRaces: 0 } })).primary).toMatchObject({ kind: 'rival_week', deadlineAt: T0 + 3 * DAY });
    expect(computeNextActions(cfg, quiet({ rival: { weekEndsAt: T0 + 3 * DAY, rankedRaces: 1 } })).primary?.kind).toBe('race');
    // daily things carry no deadline (no pressure from the daily reset)
    expect(computeNextActions(cfg, quiet({ loginBonusClaimable: true })).primary?.deadlineAt).toBeNull();
  });
  it('locked features never show; team goal only when close to the next tier', () => {
    const x = quiet({ unlocked: ['race'], loginBonusClaimable: true, rival: { weekEndsAt: T0 + DAY, rankedRaces: 0 }, scoutTickets: 2 });
    expect(computeNextActions(cfg, x)).toEqual({ primary: expect.objectContaining({ kind: 'race' }), chips: [] });
    const goal = (left: number) => computeNextActions(cfg, quiet({ teamGoal: { endsAt: T0 + 4 * DAY, unitsLeft: left } })).primary?.kind;
    expect(goal(3)).toBe('team_goal_near');
    expect(goal(6)).toBe('race');
    expect(goal(0)).toBe('race');
  });
  it('dismissed kinds are skipped; onboarding and deletion show a single card', () => {
    const x = quiet({ loginBonusClaimable: true, passClaimable: 1 });
    expect(computeNextActions(cfg, x, ['login_bonus']).primary?.kind).toBe('pass_claim');
    expect(computeNextActions(cfg, { ...x, onboarding: true })).toEqual({ primary: expect.objectContaining({ kind: 'first_race', screen: 'race', dismissible: false }), chips: [] });
    expect(computeNextActions(cfg, { ...x, deleting: true })).toEqual({ primary: expect.objectContaining({ kind: 'race', dismissible: false }), chips: [] });
  });
});

describe('§45 on the real state (REQ-NEXT-004/005/007/008/009/010)', () => {
  it('a new player sees only first_race until the partner and 2 races (FTUE)', async () => {
    const w = world();
    const b = await w.svc.bootstrap('p');
    expect((b as { nextActions: unknown }).nextActions).toMatchObject({ enabled: true, onboarding: true, primary: { kind: 'first_race' }, chips: [] });
    await w.svc.grantPartner('p', 'アイボウ', 'c:k1');
    expect((await w.svc.nextActions('p')).primary?.kind).toBe('first_race');
    await w.svc.applyRace('p', { raceId: 'r1', mode: 'ranked', place: 4, fieldSize: 12, newRating: null, void: false, humans: 2 });
    expect((await w.svc.nextActions('p')).onboarding).toBe(true);
    expect(await code(w.svc.dismissNextAction('p', 'first_race'))).toBe('NOT_ELIGIBLE');
    await w.svc.applyRace('p', { raceId: 'r2', mode: 'ranked', place: 4, fieldSize: 12, newRating: null, void: false, humans: 2 });
    const v = await w.svc.nextActions('p');
    expect(v.onboarding).toBe(false);
    // login bonus opens at 2 races and is unclaimed today; the daily missions just opened → a feature card as a chip
    expect(v.primary?.kind).toBe('login_bonus');
    expect(v.chips.map((c) => c.kind)).toContain('feature_unlocked');
    expect(v.chips.find((c) => c.kind === 'feature_unlocked')?.featureKey).toBe('missions');
  });

  it('dismiss closes a kind for the game day only (04:00 JST), idempotently, with one KPI row', async () => {
    const w = world();
    await w.player('p');
    expect((await w.svc.nextActions('p')).primary?.kind).toBe('login_bonus');
    const after = await w.svc.dismissNextAction('p', 'login_bonus');
    expect(after.primary?.kind).not.toBe('login_bonus');
    expect(after.dismissed).toEqual(['login_bonus']);
    await w.svc.dismissNextAction('p', 'login_bonus');
    expect(w.kpi.filter((k) => k.name === 'next_card_dismiss')).toHaveLength(1);
    expect(w.kpi.find((k) => k.name === 'next_card_dismiss')?.s1).toBe('login_bonus');
    expect(await code(w.svc.dismissNextAction('p', 'race'))).toBe('NOT_ELIGIBLE');
    expect(await code(w.svc.dismissNextAction('p', 'shop'))).toBe('BAD_REQUEST');
    // until just before the next 04:00 JST it stays closed; after it, it comes back
    const rule = dayRule(m);
    const next = gameDayStartMs(addJstDays(gameDayKey(w.now(), rule), 1), rule);
    expect(after.nextDayAt).toBe(next);
    w.advance(next - 1 - w.now());
    expect((await w.svc.nextActions('p')).dismissed).toEqual(['login_bonus']);
    w.advance(1);
    const v = await w.svc.nextActions('p');
    expect(v.dismissed).toEqual([]);
    expect(v.primary?.kind).toBe('login_bonus');
  });

  it('claiming removes the card (no stale claim prompts)', async () => {
    const w = world();
    await w.player('p');
    await w.svc.claimLogin('p', 'c:lb1');
    expect((await w.svc.nextActions('p')).primary?.kind).not.toBe('login_bonus');
  });

  it('gift box: an expiring gift is a link to the box with its real expiry', async () => {
    const w = world();
    await w.player('p');
    await w.svc.claimLogin('p', 'c:lb1');
    let exp = 0;
    await w.svc.tx('p', null, (s, now) => {
      deliverGift(m, s, { source: 'ops_grant', ref: 'g1', reward: { freeCoins: 10 }, note: 'grant', expiryDays: 2 }, now);
      exp = s.giftBox!.box[0]!.expiresAt!;
    });
    const all = await w.svc.nextActions('p');
    const card = [all.primary, ...all.chips].find((c) => c?.kind === 'gift_expiring');
    expect(card).toMatchObject({ screen: 'gift_box', count: 1, deadlineAt: exp });
  });

  it('feature_unlocked: shown the game day a listed feature opens, not for features open before, gone the next day', async () => {
    const w = world();
    await w.player('p', 19);
    await w.svc.claimLogin('p', 'c:lb1');
    // old features were recorded when first seen: no feature card today besides those opened today
    const v0 = await w.svc.nextActions('p');
    const f0 = [v0.primary, ...v0.chips].filter((c) => c?.kind === 'feature_unlocked').map((c) => c!.featureKey);
    expect(f0).not.toContain('weekly_challenge');
    // the 20th race opens time attack + weekly challenge (§4.3)
    await w.svc.applyRace('p', { raceId: 'r20', mode: 'ranked', place: 5, fieldSize: 12, newRating: null, void: false, humans: 2 });
    const s1 = await w.svc.nextActions('p');
    expect(nextActionSummary(m, await w.svc.state('p'), w.now()).newFeatures).toEqual(expect.arrayContaining(['time_attack', 'weekly_challenge']));
    expect([s1.primary, ...s1.chips].some((c) => c?.kind === 'feature_unlocked')).toBe(true);
    // the weekly challenge summary reads the same week and counters as GET /v1/challenges/weekly
    const wv = await w.svc.wchView('p');
    const ws = nextActionSummary(m, await w.svc.state('p'), w.now()).weeklyChallenge;
    if (wv.enabled) expect(ws).toEqual({ endsAt: wv.endsAt, uncleared: wv.challenges.length - wv.clearedCount, startsLeftToday: wv.startsLeftToday });
    w.advance(DAY);
    const s2 = await w.svc.nextActions('p');
    expect(nextActionSummary(m, await w.svc.state('p'), w.now()).newFeatures).toEqual([]);
    expect([s2.primary, ...s2.chips].some((c) => c?.kind === 'feature_unlocked')).toBe(false);
  });

  it('a player stored before the guide is not told every feature is new', async () => {
    const w = world();
    await w.player('p', 25);
    await w.svc.tx('p', null, (s) => { delete s.nextAction; });
    expect(nextActionSummary(m, await w.svc.state('p'), w.now()).newFeatures).toEqual([]); // GET /v1/player (not saved)
    await w.svc.bootstrap('p');
    const st = await w.svc.state('p');
    expect(Object.values(st.nextAction!.features).every((d) => d === '')).toBe(true);
    expect(nextActionSummary(m, st, w.now()).newFeatures).toEqual([]);
  });

  it('scheduled deletion: only the race card', async () => {
    const w = world();
    await w.player('p');
    await w.svc.tx('p', null, (s) => { s.deletion = { status: 'scheduled' } as typeof s.deletion; });
    const v = await w.svc.nextActions('p');
    expect(v.primary?.kind).toBe('race');
    expect(v.chips).toEqual([]);
  });

  it('disabled config: no card; GET /v1/player is not saved and has the same view', async () => {
    const off = world(withCfg({ enabled: false }));
    await off.player('p');
    expect(await off.svc.nextActions('p')).toMatchObject({ enabled: false, primary: null, chips: [] });
    expect(await code(off.svc.dismissNextAction('p', 'login_bonus'))).toBe('NOT_FOUND');
    const w = world();
    await w.player('q');
    const view = (await w.svc.view('q')) as unknown as { nextActions: ReturnType<typeof nextActionsView> };
    expect(view.nextActions).toEqual(await w.svc.nextActions('q'));
  });

  it('team goal from the route: close to the next tier → team_goal_near', async () => {
    const w = world();
    await w.player('p', 15); // 支部 opens at 15 races (§4.3)
    await w.svc.claimLogin('p', 'c:lb1');
    const brief = { endsAt: T0 + 3 * DAY, progress: 18, milestones: [{ target: 10, reached: true }, { target: 20, reached: false }] };
    expect(nextActionSummary(m, await w.svc.state('p'), w.now(), brief).teamGoal).toEqual({ endsAt: T0 + 3 * DAY, unitsLeft: 2 });
    // close what ranks above it today (a feature that just opened, missions…) to see the team card itself
    for (const k of ['feature_unlocked', 'missions_close', 'missions_claim', 'rival_week', 'weekly_challenge', 'pass_claim', 'gift_expiring']) await w.svc.dismissNextAction('p', k);
    const v = await w.svc.nextActions('p', brief);
    const card = [v.primary, ...v.chips].find((c) => c?.kind === 'team_goal_near');
    expect(card).toMatchObject({ count: 2, deadlineAt: T0 + 3 * DAY, screen: 'team_goal' });
  });
});

describe('§45 KPI and HTTP (REQ-NEXT-010/012)', () => {
  it('client events next_card_view / next_card_tap with kind and slot', () => {
    const ok = (e: unknown) => clientBatchSchema.safeParse({ platform: 'ios', appVersion: '1', events: [e] }).success;
    expect(ok({ name: 'next_card_view', at: 1, props: { kind: 'gift_expiring', slot: 'primary' } })).toBe(true);
    expect(ok({ name: 'next_card_tap', at: 1, props: { kind: 'scout_ticket', slot: 'chip' } })).toBe(true);
    expect(ok({ name: 'next_card_tap', at: 1, props: { kind: 'shop', slot: 'chip' } })).toBe(false);
    expect(ok({ name: 'next_card_dismiss', at: 1, props: { kind: 'race' } })).toBe(false); // a server event
  });
  it('routes', async () => {
    const w = world();
    await w.player('u');
    const svc = w.svc;
    const invoker: PlayerInvoker = { invoke: (async (method: string, ...args: unknown[]) => (svc as unknown as Record<string, (...a: unknown[]) => unknown>)[method]!.apply(svc, args)) as PlayerInvoker['invoke'] };
    const c = { master: m, authenticate: async () => 'u', player: () => invoker, clock: w.now } as unknown as AppContext;
    const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
      const res = await handle(new Request(`https://x${path}`, { method, headers: { 'content-type': 'application/json', ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }), {}, c);
      return { status: res.status, body: (await res.json()) as any };
    };
    const g = await call('GET', '/v1/home/next', undefined, { 'accept-language': 'en' });
    expect(g.status).toBe(200);
    expect(g.body.primary.kind).toBe('login_bonus');
    const d = await call('POST', '/v1/home/next/dismiss', { kind: 'login_bonus' });
    expect(d.body.dismissed).toEqual(['login_bonus']);
    expect((await call('POST', '/v1/home/next/dismiss', { kind: 'race' })).status).toBe(409);
    expect((await call('POST', '/v1/home/next/dismiss', {})).status).toBe(400);
    // a teams service that fails only drops the team card
    const broken = { ...c, teams: { goal: async () => { throw new Error('down'); } } } as unknown as AppContext;
    expect((await handle(new Request('https://x/v1/home/next'), {}, broken)).status).toBe(200);
  });
});
