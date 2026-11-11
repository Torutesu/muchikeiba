/**
 * REQ-REV-001..016 (contracts/protocol.md §59): レビュー依頼のタイミング. The rules (validation, Google Play's no-pre-question
 * rule, no reward keys), the pure decision in its order, the service (record only a yes, idempotent, once per session,
 * the year cap and the cool-down survive a reinstall), the answers (soft → store / help inquiry), the KPI, that nothing is
 * ever granted, the data export class, the maintenance group, the HTTP routes, and the shared vectors with C#.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MemoryPlayerRepo, PlayerService } from '../src/domain/service.js';
import { seededRng } from '../src/domain/rng.js';
import { AppError } from '../src/domain/errors.js';
import {
  REVIEW_MOMENTS, REVIEW_REASONS, REVIEW_RULES_OFF, decideReviewPrompt, reviewPromptProblems, reviewRulesOf,
  type ReviewCheckInput, type ReviewPromptRules, type ReviewPromptSummary,
} from '../src/domain/reviewPrompt.js';
import { classifyKey } from '../src/domain/dataExport.js';
import { endpointGroup } from '../src/domain/maintenance.js';
import { handle, makeFriendsService, type AppContext, type PlayerInvoker } from '../src/http/app.js';
import { uxProblems } from '../src/domain/onboarding.js';
import { collectItemIds } from '../src/domain/visuals.js';
import { resolveBundle } from '../src/ops/config.js';
import { MemoryDirectory } from '../src/domain/friends.js';
import type { KpiRecord } from '../src/domain/kpi.js';
import type { Master } from '../src/domain/master.js';
import type { PlayerState } from '../src/domain/player.js';
import { m } from './helpers.js';

const NOW = Date.UTC(2026, 10, 10, 3);
const DAY = 86_400_000;
const VECTORS_PATH = join(__dirname, '..', '..', 'contracts', 'review-prompt.vectors.json');
const RULES = reviewRulesOf(m);

function world(master: Master = m) {
  const clock = { now: NOW };
  const kpi: KpiRecord[] = [];
  const svc = new PlayerService(new MemoryPlayerRepo(), {
    master, rng: seededRng(5), clock: () => clock.now, verifiers: {}, onKpi: (_id, recs) => { kpi.push(...recs); },
  });
  return { svc, clock, kpi };
}
type W = ReturnType<typeof world>;
const withRules = (o: Partial<ReviewPromptRules>): Master => ({ ...m, progression: { ...m.progression, reviewPrompt: { ...RULES, ...o } } });

/** A settled player: installed 10 days ago, 12 races, FTUE done. */
async function settled(w: W, id: string, o: (s: PlayerState) => void = () => {}) {
  await w.svc.tx(id, null, (s) => { s.createdAt = NOW - 10 * DAY; s.stats.races = 12; s.flags.tutorialGachaUsed = true; o(s); });
}
const facts = { inFtue: false, minutesSinceLoss: null, minutesSinceError: null, minutesSinceMaintenanceNotice: null };
const input = (o: Partial<ReviewCheckInput> = {}): ReviewCheckInput => ({ moment: 'first_win', platform: 'ios', sessionId: 'sess_0001', client: facts, ...o });
let k = 0;
const key = () => `c:/v1/review-prompt/check:k${++k}`;
const st = async (w: W, id: string) => (await w.svc.state(id)) as PlayerState;
const code = async (p: Promise<unknown>) => { try { await p; return 'ok'; } catch (e) { return (e as AppError).code; } };
const revKpi = (w: W) => w.kpi.filter((r) => r.name.startsWith('review_')).map((r) => [r.name, r.s1, r.s2, r.s3]);

const base = (o: Partial<ReviewPromptSummary> = {}): ReviewPromptSummary => ({
  platform: 'ios', moment: 'first_win', now: NOW, installedAt: NOW - 10 * DAY, racesPlayed: 12, inFtue: false, accountClosing: false,
  sessionPrompted: false, maintenanceVisible: false, coinDebt: false,
  minutesSince: { loss: null, purchase: null, refund: null, error: null, maintenanceNotice: null }, history: [], ...o,
});

describe('レビュー依頼: the rules (REQ-REV-002/008/009)', () => {
  it('the shipped rules pass; soft pre-question is off on both platforms; at most 3 a year', () => {
    expect(reviewPromptProblems(m)).toEqual([]);
    expect(uxProblems(m, new Set(collectItemIds(m)))).toEqual([]);
    expect(RULES.enabled).toBe(true);
    expect(RULES.softAsk).toEqual({ ios: false, android: false });
    expect(RULES.maxPerYear).toBeLessThanOrEqual(3);
    expect([...RULES.moments].sort()).toEqual([...REVIEW_MOMENTS].sort());
  });
  it('android soft pre-question, more than 3 a year, short cool-down, unknown moment, missing quiet key all fail', () => {
    const bad = (o: Record<string, unknown>) => reviewPromptProblems({ progression: { ...m.progression, reviewPrompt: { ...RULES, ...o } } } as Master);
    expect(bad({ softAsk: { ios: false, android: true } }).join()).toMatch(/android must stay false/);
    expect(bad({ softAsk: { ios: true, android: false } })).toEqual([]);
    expect(bad({ maxPerYear: 4 }).join()).toMatch(/1\.\.3/);
    expect(bad({ coolDownDays: 7 }).join()).toMatch(/coolDownDays/);
    expect(bad({ moments: ['first_win', 'rate_us'] }).join()).toMatch(/unknown moment rate_us/);
    expect(bad({ moments: [] }).join()).toMatch(/at least one/);
    expect(bad({ quietMinutes: { loss: 30, purchase: 1, refund: 1, error: 1 } }).join()).toMatch(/maintenanceNotice/);
    expect(bad({ extra: 1 }).join()).toMatch(/not a known key/);
  });
  it('a reward can never be configured (Apple 5.6.1 / Google Play: no incentivised reviews)', () => {
    for (const k of ['reward', 'rewards', 'coins', 'freeCoins', 'items', 'grantXp']) {
      const p = reviewPromptProblems({ progression: { ...m.progression, reviewPrompt: { ...RULES, [k]: 100 } } } as Master);
      expect(p.join(), k).toMatch(/never rewarded/);
    }
  });
  it('remote config: progression.reviewPrompt is validated too', () => {
    const err = (() => { try { resolveBundle(m, { progression: { reviewPrompt: { ...RULES, softAsk: { ios: false, android: true } } } } as never); return ''; } catch (e) { return (e as Error).message; } })();
    expect(err).toMatch(/android must stay false/);
    const ok = resolveBundle(m, { progression: { reviewPrompt: { ...RULES, enabled: false } } } as never);
    expect(reviewRulesOf(ok.master).enabled).toBe(false);
  });
  it('absent rules never ask', () => {
    const { reviewPrompt: _x, ...prog } = m.progression as typeof m.progression & { reviewPrompt?: unknown };
    void _x;
    expect(reviewRulesOf({ progression: prog } as Master)).toEqual(REVIEW_RULES_OFF);
    expect(decideReviewPrompt(REVIEW_RULES_OFF, base()).reason).toBe('disabled');
  });
});

describe('レビュー依頼: the decision (REQ-REV-003)', () => {
  it('a settled player at a happy moment: native, or soft when the platform has it on', () => {
    expect(decideReviewPrompt(RULES, base())).toEqual({ show: true, reason: null, style: 'native' });
    const soft = { ...RULES, softAsk: { ios: true, android: false } };
    expect(decideReviewPrompt(soft, base()).style).toBe('soft');
    expect(decideReviewPrompt(soft, base({ platform: 'editor' })).style).toBe('soft');
    expect(decideReviewPrompt(soft, base({ platform: 'android' })).style).toBe('native');
  });
  it('each reason in order (the first that applies wins)', () => {
    const cases: [string, Partial<ReviewPromptSummary>, ReviewPromptRules?][] = [
      ['disabled', {}, { ...RULES, enabled: false }],
      ['moment', { moment: 'purchase_done' }],
      ['account_closing', { accountClosing: true, inFtue: true }],
      ['ftue', { inFtue: true, sessionPrompted: true }],
      ['session', { sessionPrompted: true, maintenanceVisible: true }],
      ['maintenance', { maintenanceVisible: true, coinDebt: true }],
      ['maintenance', { minutesSince: { ...base().minutesSince, maintenanceNotice: 59 } }],
      ['refund', { coinDebt: true }],
      ['refund', { minutesSince: { ...base().minutesSince, refund: 60 * 24 * 29, purchase: 1 } }],
      ['purchase', { minutesSince: { ...base().minutesSince, purchase: 1439, error: 0 } }],
      ['error', { minutesSince: { ...base().minutesSince, error: 29, loss: 0 } }],
      ['loss', { minutesSince: { ...base().minutesSince, loss: 0 }, installedAt: NOW }],
      ['too_new', { installedAt: NOW - 3 * DAY + 1, racesPlayed: 0 }],
      ['too_few_races', { racesPlayed: 9, history: [NOW - DAY, NOW - 2 * DAY, NOW - 3 * DAY] }],
      ['year_cap', { history: [NOW - 130 * DAY, NOW - 260 * DAY, NOW - 364 * DAY] }],
      ['cool_down', { history: [NOW - 119 * DAY] }],
    ];
    for (const [reason, o, r] of cases) expect(decideReviewPrompt(r ?? RULES, base(o)), reason).toEqual({ show: false, reason, style: null });
    const seen = new Set(cases.map((c) => c[0]));
    expect([...REVIEW_REASONS].filter((x) => !seen.has(x))).toEqual([]);
  });
  it('boundaries: quiet minutes are exclusive, a year is 365 days, 3 full days since install', () => {
    expect(decideReviewPrompt(RULES, base({ minutesSince: { ...base().minutesSince, loss: 30, error: 30, purchase: 1440, refund: 43200, maintenanceNotice: 60 } })).show).toBe(true);
    expect(decideReviewPrompt(RULES, base({ installedAt: NOW - 3 * DAY })).show).toBe(true);
    expect(decideReviewPrompt(RULES, base({ history: [NOW - 120 * DAY, NOW - 365 * DAY, NOW - 400 * DAY] })).show).toBe(true);
    expect(decideReviewPrompt(RULES, base({ racesPlayed: 10 })).show).toBe(true);
  });
});

describe('レビュー依頼: the service (REQ-REV-004..007)', () => {
  it('yes is recorded once (idempotent key), KPI eligible, and nothing else in the state moves', async () => {
    const w = world();
    await settled(w, 'p');
    const before = await st(w, 'p');
    const kk = key();
    const r = await w.svc.reviewPromptCheck('p', input(), kk);
    expect(r).toEqual({ v: 1, show: true, style: 'native', reason: null, promptId: 'rp_1' });
    expect(await w.svc.reviewPromptCheck('p', input(), kk)).toEqual(r);
    const after = await st(w, 'p');
    expect(after.reviewPrompt!.history).toHaveLength(1);
    expect(after.reviewPrompt!.history[0]).toMatchObject({ id: 'rp_1', at: NOW, moment: 'first_win', platform: 'ios', style: 'native', answer: null, nativeAt: null });
    expect(revKpi(w)).toEqual([['review_prompt_eligible', 'first_win', 'ios', 'native']]);
    // REQ-REV-009: no reward path — wallet, ledger, items, materials, missions, pass, titles unchanged
    for (const k of ['wallet', 'ledger', 'items', 'materials', 'missions', 'seasonPass', 'titles', 'stats', 'horses'] as const) expect(after[k], k).toEqual(before[k]);
    expect(JSON.stringify(r)).not.toMatch(/reward|coin|item/i);
  });
  it('once per session; a reinstall (new session) still meets the cool-down; the year cap holds', async () => {
    const w = world();
    await settled(w, 'p');
    expect((await w.svc.reviewPromptCheck('p', input(), key())).show).toBe(true);
    expect(await w.svc.reviewPromptCheck('p', input({ moment: 'hall_induction' }), key())).toMatchObject({ show: false, reason: 'session' });
    expect(await w.svc.reviewPromptCheck('p', input({ sessionId: 'reinstalled_01' }), key())).toMatchObject({ show: false, reason: 'cool_down' });
    w.clock.now += 121 * DAY;
    expect((await w.svc.reviewPromptCheck('p', input({ sessionId: 's2_xxxxxx' }), key())).show).toBe(true);
    w.clock.now += 121 * DAY;
    expect((await w.svc.reviewPromptCheck('p', input({ sessionId: 's3_xxxxxx' }), key())).show).toBe(true);
    w.clock.now += 121 * DAY; // the first is now 363 days old: three inside the year
    expect(await w.svc.reviewPromptCheck('p', input({ sessionId: 's4_xxxxxx' }), key())).toMatchObject({ show: false, reason: 'year_cap' });
    expect((await st(w, 'p')).reviewPrompt!.history).toHaveLength(3);
    expect(revKpi(w).filter((x) => x[0] === 'review_prompt_eligible')).toHaveLength(3);
  });
  it('a no changes nothing (no history, no KPI)', async () => {
    const w = world();
    await settled(w, 'p');
    expect(await w.svc.reviewPromptCheck('p', input({ client: { ...facts, minutesSinceLoss: 2 } }), key())).toMatchObject({ show: false, reason: 'loss' });
    expect(await w.svc.reviewPromptCheck('p', input({ client: { ...facts, minutesSinceError: 0 } }), key())).toMatchObject({ show: false, reason: 'error' });
    expect(await w.svc.reviewPromptCheck('p', input({ client: { ...facts, inFtue: true } }), key())).toMatchObject({ show: false, reason: 'ftue' });
    expect(await w.svc.reviewPromptCheck('p', input({ moment: 'gacha_pull' }), key())).toMatchObject({ show: false, reason: 'moment' });
    expect((await st(w, 'p')).reviewPrompt).toBeUndefined();
    expect(revKpi(w)).toEqual([]);
  });
  it('server facts: FTUE (welcome pulls not drawn), too new, few races, a purchase, a refund debt, a refund row, deletion, maintenance', async () => {
    const w = world();
    const reason = async (id: string, o: (s: PlayerState) => void) => { await settled(w, id, o); return (await w.svc.reviewPromptCheck(id, input(), key())).reason; };
    expect(await reason('a', (s) => { s.flags.tutorialGachaUsed = false; })).toBe('ftue');
    expect(await reason('b', (s) => { s.createdAt = NOW - DAY; })).toBe('too_new');
    expect(await reason('c', (s) => { s.stats.races = 3; })).toBe('too_few_races');
    expect(await reason('d', (s) => { s.purchases.push({ txId: 't1', platform: 'apple', productId: 'coins_s', priceYen: 120, at: NOW - 60_000, paidCoinsGranted: 1, bonusCoinsGranted: 0, lotId: null, refunded: false, limitBreach: false }); })).toBe('purchase');
    expect(await reason('e', (s) => { s.wallet.debt = 50; })).toBe('refund');
    expect(await reason('f', (s) => { s.ledger.push({ seq: 99, at: NOW - 10 * 60_000, kind: 'refund', currency: 'paid', delta: -10, balanceAfter: 0, reason: 'refund', ref: 't1' }); })).toBe('refund');
    expect(await reason('g', (s) => { s.deletion = { status: 'scheduled', requestedAt: NOW, deleteAt: NOW + 30 * DAY } as PlayerState['deletion']; })).toBe('account_closing');
    expect(await reason('h', () => {})).toBe(null);
    const mm: Master = { ...m, maintenance: { windows: [{ id: 'w1', startAtMs: NOW + 3600_000, endAtMs: NOW + 7200_000, scope: 'all', message: { ja: 'メンテナンス', en: 'Maintenance' } }],
      clientVersions: { ios: { min: '0.0.0', recommended: '0.0.0', storeUrl: null }, android: { min: '0.0.0', recommended: '0.0.0', storeUrl: null } }, minEngineLevel: 1 } };
    const w2 = world(mm);
    await settled(w2, 'p');
    expect((await w2.svc.reviewPromptCheck('p', input(), key())).reason).toBe('maintenance');
    expect((await w2.svc.reviewPrompt('p')).serverSummary.maintenanceVisible).toBe(true);
  });
  it('GET: rules and the server half of the summary (a read)', async () => {
    const w = world();
    await settled(w, 'p');
    await w.svc.reviewPromptCheck('p', input(), key());
    const g = await w.svc.reviewPrompt('p');
    expect(g).toMatchObject({ v: 1, rules: { enabled: true, maxPerYear: 3 }, history: { count365: 1, lastAt: NOW }, serverSummary: { racesPlayed: 12, inFtue: false, lastSessionId: 'sess_0001', history: [NOW] } });
    expect(Object.keys(g.rules)).not.toContain('_note');
  });
  it('native answer: shown once; soft answers are refused for a native prompt; unknown prompt 404', async () => {
    const w = world();
    await settled(w, 'p');
    await w.svc.reviewPromptCheck('p', input(), key());
    expect(await w.svc.reviewPromptAnswer('p', 'rp_1', 'native_requested')).toEqual({ promptId: 'rp_1', next: 'none', helpCategory: null });
    await w.svc.reviewPromptAnswer('p', 'rp_1', 'native_requested');
    expect(revKpi(w).filter((x) => x[0] === 'review_prompt_shown')).toEqual([['review_prompt_shown', 'first_win', 'ios', 'native']]);
    expect((await st(w, 'p')).reviewPrompt!.history[0]!.nativeAt).toBe(NOW);
    expect(await code(w.svc.reviewPromptAnswer('p', 'rp_1', 'soft_yes'))).toBe('NOT_ELIGIBLE');
    expect(await code(w.svc.reviewPromptAnswer('p', 'rp_9', 'native_requested'))).toBe('NOT_FOUND');
  });
  it('soft (iOS, ops on): yes → the store; not really → the help inquiry form, never the store; answers are written once', async () => {
    const w = world(withRules({ softAsk: { ios: true, android: false } }));
    await settled(w, 'p');
    expect(await w.svc.reviewPromptCheck('p', input(), key())).toMatchObject({ show: true, style: 'soft', promptId: 'rp_1' });
    expect(await code(w.svc.reviewPromptAnswer('p', 'rp_1', 'native_requested'))).toBe('NOT_ELIGIBLE'); // not before yes
    expect(await w.svc.reviewPromptAnswer('p', 'rp_1', 'soft_no')).toEqual({ promptId: 'rp_1', next: 'help_inquiry', helpCategory: 'other' });
    expect(await w.svc.reviewPromptAnswer('p', 'rp_1', 'soft_no')).toMatchObject({ next: 'help_inquiry' }); // retry
    expect(await code(w.svc.reviewPromptAnswer('p', 'rp_1', 'soft_yes'))).toBe('CONFLICT');
    expect(await code(w.svc.reviewPromptAnswer('p', 'rp_1', 'native_requested'))).toBe('NOT_ELIGIBLE'); // never the store after "not really"
    w.clock.now += 200 * DAY;
    const r2 = await w.svc.reviewPromptCheck('p', input({ sessionId: 'later_session' }), key());
    expect(await w.svc.reviewPromptAnswer('p', r2.promptId!, 'soft_yes')).toEqual({ promptId: 'rp_2', next: 'store_review', helpCategory: null });
    await w.svc.reviewPromptAnswer('p', 'rp_2', 'native_requested');
    expect(revKpi(w)).toEqual([
      ['review_prompt_eligible', 'first_win', 'ios', 'soft'], ['review_soft_answer', 'not_really', 'first_win', 'ios'],
      ['review_prompt_eligible', 'first_win', 'ios', 'soft'], ['review_soft_answer', 'yes', 'first_win', 'ios'], ['review_prompt_shown', 'first_win', 'ios', 'soft'],
    ]);
    // Android never gets the pre-question even with iOS on
    const w3 = world(withRules({ softAsk: { ios: true, android: false } }));
    await settled(w3, 'p');
    expect((await w3.svc.reviewPromptCheck('p', input({ platform: 'android' }), key())).style).toBe('native');
  });
  it('history keeps the latest 10 within 400 days', async () => {
    const w = world(withRules({ coolDownDays: 30, maxPerYear: 3 }));
    await settled(w, 'p');
    for (let i = 0; i < 14; i++) { w.clock.now += 130 * DAY; await w.svc.reviewPromptCheck('p', input({ sessionId: `sess_${1000 + i}` }), key()); }
    const h = (await st(w, 'p')).reviewPrompt!.history;
    expect(h.length).toBeLessThanOrEqual(10);
    expect(h.every((x) => w.clock.now - x.at < 400 * DAY)).toBe(true);
  });
  it('the data export classifies it (analytics)', async () => {
    expect(classifyKey('reviewPrompt')).toEqual({ section: 'analytics' });
  });
  it('maintenance group: core (REQ-REV-013)', () => {
    for (const p of ['/v1/review-prompt', '/v1/review-prompt/check', '/v1/review-prompt/rp_1/answer']) expect(endpointGroup(p), p).toBe('core');
  });
});

describe('レビュー依頼: HTTP (§59.4)', () => {
  function ctx() {
    const w = world();
    const invoker: PlayerInvoker = { invoke: (async (method: string, ...args: unknown[]) => (w.svc as unknown as Record<string, (...a: unknown[]) => unknown>)[method]!.apply(w.svc, args)) as PlayerInvoker['invoke'] };
    const c = {
      master: m, authenticate: async (req: Request) => { const u = req.headers.get('x-test-user'); if (!u) throw new AppError('UNAUTHORIZED'); return u; },
      player: () => invoker, friends: makeFriendsService(() => invoker, new MemoryDirectory()), clock: () => NOW,
      paidBalance: async () => ({}), adminToken: 'x', parseStoreNotification: async () => null,
    } as unknown as AppContext;
    return { c, w };
  }
  const req = (method: string, path: string, body?: unknown, idem?: string) => new Request(`https://x${path}`, {
    method, headers: { 'x-test-user': 'u', ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(idem ? { 'idempotency-key': idem } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  it('check needs a key and a strict body; answer validates the id and the step', async () => {
    const { c, w } = ctx();
    await settled(w, 'u');
    const b = input();
    expect((await handle(req('POST', '/v1/review-prompt/check', b), {}, c)).status).toBe(400);
    expect((await handle(req('POST', '/v1/review-prompt/check', { ...b, reward: 1 }, 'a1'), {}, c)).status).toBe(400);
    expect((await handle(req('POST', '/v1/review-prompt/check', { ...b, sessionId: 'x' }, 'a1'), {}, c)).status).toBe(400);
    expect((await handle(req('POST', '/v1/review-prompt/check', { ...b, client: { ...facts, minutesSinceLoss: -1 } }, 'a1'), {}, c)).status).toBe(400);
    const ok = await handle(req('POST', '/v1/review-prompt/check', b, 'a1'), {}, c);
    expect(await ok.json()).toEqual({ v: 1, show: true, style: 'native', reason: null, promptId: 'rp_1' });
    expect((await handle(req('POST', '/v1/review-prompt/bad/answer', { step: 'native_requested' }), {}, c)).status).toBe(404);
    expect((await handle(req('POST', '/v1/review-prompt/rp_1/answer', { step: 'five_stars' }), {}, c)).status).toBe(400);
    expect(await (await handle(req('POST', '/v1/review-prompt/rp_1/answer', { step: 'native_requested' }), {}, c)).json()).toEqual({ promptId: 'rp_1', next: 'none', helpCategory: null });
    expect(await (await handle(req('GET', '/v1/review-prompt'), {}, c)).json()).toMatchObject({ v: 1, history: { count365: 1 } });
  });
});

describe('レビュー依頼: shared vectors (TS ↔ C# ReviewPromptPolicy)', () => {
  it('matches contracts/review-prompt.vectors.json', () => {
    const v = vectors();
    if (process.env.UPDATE_VECTORS === '1') writeFileSync(VECTORS_PATH, JSON.stringify(v, null, 2) + '\n');
    const file = JSON.parse(readFileSync(VECTORS_PATH, 'utf8')) as ReturnType<typeof vectors>;
    expect(file).toEqual(v);
  });
});

function vectors() {
  const soft: ReviewPromptRules = { ...RULES, softAsk: { ios: true, android: false } };
  const ms = base().minutesSince;
  const rows: [string, ReviewPromptRules, Partial<ReviewPromptSummary>][] = [
    ['eligible native', RULES, {}],
    ['eligible soft (ios on)', soft, {}],
    ['soft rules, android → native', soft, { platform: 'android' }],
    ['soft rules, editor follows ios', soft, { platform: 'editor' }],
    ['disabled', { ...RULES, enabled: false }, {}],
    ['moment not listed', { ...RULES, moments: ['first_win'] }, { moment: 'hall_induction' }],
    ['unknown moment', RULES, { moment: 'shop_visit' }],
    ['account closing beats ftue', RULES, { accountClosing: true, inFtue: true }],
    ['ftue beats session', RULES, { inFtue: true, sessionPrompted: true }],
    ['session', RULES, { sessionPrompted: true }],
    ['maintenance visible', RULES, { maintenanceVisible: true }],
    ['maintenance notice 59 min ago', RULES, { minutesSince: { ...ms, maintenanceNotice: 59 } }],
    ['maintenance notice 60 min ago (ok)', RULES, { minutesSince: { ...ms, maintenanceNotice: 60 } }],
    ['coin debt', RULES, { coinDebt: true }],
    ['refund 29 days ago', RULES, { minutesSince: { ...ms, refund: 41760 } }],
    ['refund 30 days ago (ok)', RULES, { minutesSince: { ...ms, refund: 43200 } }],
    ['purchase 10 min ago', RULES, { minutesSince: { ...ms, purchase: 10 } }],
    ['purchase a day ago (ok)', RULES, { minutesSince: { ...ms, purchase: 1440 } }],
    ['error just now', RULES, { minutesSince: { ...ms, error: 0 } }],
    ['loss 29 min ago', RULES, { minutesSince: { ...ms, loss: 29 } }],
    ['loss 30 min ago (ok)', RULES, { minutesSince: { ...ms, loss: 30 } }],
    ['installed 2 days 23 h ago', RULES, { installedAt: NOW - 3 * DAY + 3600_000 }],
    ['installed exactly 3 days ago (ok)', RULES, { installedAt: NOW - 3 * DAY }],
    ['9 races', RULES, { racesPlayed: 9 }],
    ['3 in the year', RULES, { history: [NOW - 125 * DAY, NOW - 250 * DAY, NOW - 360 * DAY] }],
    ['3 but one is 365 days old (ok)', RULES, { history: [NOW - 125 * DAY, NOW - 250 * DAY, NOW - 365 * DAY] }],
    ['cool-down 119 days', RULES, { history: [NOW - 119 * DAY] }],
    ['cool-down 120 days (ok)', RULES, { history: [NOW - 120 * DAY] }],
    ['max 1 a year', { ...RULES, maxPerYear: 1 }, { history: [NOW - 200 * DAY] }],
    ['zero quiet minutes', { ...RULES, quietMinutes: { loss: 0, purchase: 0, refund: 0, error: 0, maintenanceNotice: 0 } }, { minutesSince: { loss: 0, purchase: 0, refund: 0, error: 0, maintenanceNotice: 0 } }],
    ['history unsorted', RULES, { history: [NOW - 300 * DAY, NOW - 10 * DAY, NOW - 200 * DAY] }],
  ];
  return {
    _note: 'REQ-REV-003 (contracts/protocol.md §59.3): server/src/domain/reviewPrompt.ts decideReviewPrompt and C# Muchi.Client ReviewPromptPolicy.Decide must agree. Regenerate with UPDATE_VECTORS=1 npx vitest run test/review-prompt.test.ts.',
    v: 1,
    cases: rows.map(([name, rules, o]) => { const summary = base(o); return { name, rules, summary, expect: decideReviewPrompt(rules, summary) }; }),
  };
}
