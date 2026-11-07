import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { MemoryPlayerRepo, PlayerService } from '../src/domain/service.js';
import { FakeStoreVerifier } from '../src/domain/purchase.js';
import { seededRng } from '../src/domain/rng.js';
import type { AppError } from '../src/domain/errors.js';
import type { Master } from '../src/domain/master.js';
import type { KpiRecord } from '../src/domain/kpi.js';
import type { RaceDetails } from '../src/domain/stats.js';
import {
  COLLECTION_HARD_LIMITS, collectionOf, collectionProblems, collectionRewardProblems, gachaObtainable, generationsOf, validateCollection,
  type AchievementDef, type CollectionMaster,
} from '../src/domain/collection.js';
import { validateGacha } from '../src/domain/gacha.js';
import { resolveBundle } from '../src/ops/config.js';
import { settleRace } from '../src/race/orchestrate.js';
import { handle, type AppContext, type PlayerInvoker } from '../src/http/app.js';
import { MANIFEST_PATH } from '../scripts/gen-assets.js';
import { m, makeConfig } from './helpers.js';

const T0 = Date.UTC(2026, 10, 3, 3);
const cm = collectionOf(m);

function setup(master: Master = m) {
  let now = T0;
  const repo = new MemoryPlayerRepo();
  const kpi: KpiRecord[] = [];
  const svc = new PlayerService(repo, { master, rng: seededRng(7), clock: () => now, verifiers: { fake: new FakeStoreVerifier() }, onKpi: (_id, r) => { kpi.push(...r); } });
  let n = 0;
  const details = (over: Partial<RaceDetails> = {}): RaceDetails => ({ trackId: 'aoba_turf_1600', style: 'senko', finishTick: null, startReactionTicks: null, whips: 0, whipMashed: false, cpuAssisted: false, ...over });
  const race = (id: string, place = 5, over: Partial<RaceDetails> = {}, raceId = `r${++n}`) =>
    svc.applyRace(id, { raceId, mode: 'ranked', place, fieldSize: 12, newRating: null, void: false, humans: 2, details: details(over) });
  const k = () => `c:k${++n}`;
  return { svc, repo, kpi, race, k, advance: (ms: number) => { now += ms; } };
}
const code = async (p: Promise<unknown>) => { try { await p; return 'ok'; } catch (e) { return (e as AppError).code; } };
const withCollection = (achievements: unknown[], caps = cm.caps): Master => ({ ...m, collection: { ...cm, caps, achievements: achievements as AchievementDef[] } as CollectionMaster });
const tier = (target: number, freeCoins = 10, n = 1) => ({ tier: n, target, reward: { freeCoins } });

describe('REQ-ACH-007 master/collection.json', () => {
  it('is valid: free coins only, within the per-tier and total caps, titles point at real tiers', () => {
    expect(collectionProblems(m, cm, { strictRefs: true })).toEqual([]);
    expect(() => validateCollection(m)).not.toThrow();
    const total = cm.achievements.reduce((a, d) => a + d.tiers.reduce((b, t) => b + t.reward.freeCoins, 0), 0);
    expect(total).toBeLessThanOrEqual(cm.caps.maxTotalFreeCoins);
    expect(total).toBe(1235); // docs/spec/balance-targets.md 4.11 documents this lifetime total
    for (const d of cm.achievements) for (const t of d.tiers) {
      expect(Object.keys(t.reward)).toEqual(['freeCoins']);
      expect(t.reward.freeCoins).toBeLessThanOrEqual(COLLECTION_HARD_LIMITS.maxFreeCoinsPerTier);
      expect(t.reward.freeCoins * 1.6).toBeLessThanOrEqual(200); // 総付景品 floor at the worst pack price
    }
    expect(m.titles.filter((t) => t.condition.kind === 'achievement').length).toBeGreaterThanOrEqual(5);
    // every course has a wins-per-course achievement, and every lore entry names a real id
    for (const t of m.tracks) expect(cm.achievements.some((d) => d.metric === 'trackWins' && d.trackId === t.id)).toBe(true);
    for (const id of Object.keys(cm.lore.horses)) expect(m.templateById.has(id)).toBe(true);
    for (const t of m.templates) expect(cm.lore.horses[t.id]).toBeTruthy();
    for (const k of m.skills.skills) expect(cm.lore.skills[k.id]).toBeTruthy();
  });

  it('refuses metrics for spending money or gacha pulls, non-coin rewards and payouts over the caps', () => {
    for (const metric of ['gachaPulls', 'purchases', 'yenSpent', 'collectionPercent']) {
      expect(collectionProblems(withCollection([{ id: 'x', category: 'race', name: 'x', description: 'x', metric, tiers: [tier(1)] }])).join(';')).toMatch(/prohibited/);
    }
    const bad = (reward: unknown) => collectionProblems(withCollection([{ id: 'x', category: 'race', name: 'x', description: 'x', metric: 'races', tiers: [{ tier: 1, target: 1, reward }] }])).join(';');
    expect(bad({ freeCoins: 10, paidCoins: 10 })).toMatch(/reward/);
    expect(bad({ items: [{ itemId: 'gacha_ticket', qty: 1 }] })).toMatch(/reward/);
    expect(bad({ freeCoins: 101 })).toMatch(/reward\.freeCoins/);
    expect(bad({ freeCoins: 60 })).toMatch(/over caps\.maxFreeCoinsPerTier 50/);
    const many = Array.from({ length: 30 }, (_, i) => ({ id: `a${i}`, category: 'race', name: 'x', description: 'x', metric: 'races', tiers: [tier(1, 50), tier(2, 50, 2), tier(3, 50, 3)] }));
    expect(collectionProblems(withCollection(many)).join(';')).toMatch(/over caps\.maxTotalFreeCoins/);
    expect(collectionProblems(withCollection([{ id: 'x', category: 'race', name: 'x', description: 'x', metric: 'races', tiers: [tier(5), tier(3, 10, 2)] }])).join(';')).toMatch(/targets must increase/);
    const t = { ...m, titles: [...m.titles, { id: 'ghost', name: 'x', condition: { kind: 'achievement' as const, achievementId: 'nope', tier: 1 } }] };
    expect(collectionProblems(t).join(';')).toMatch(/titles\.ghost: unknown achievement nope/);
  });

  it('REQ-ACH-008 コンプガチャ: no reward for a set with even one gacha-obtainable horse or skill, nor for sold cosmetics', () => {
    const g = gachaObtainable(m);
    expect(g.templates.has('t_akatsuki')).toBe(true);
    const set = (section: string, ids?: string[]) => collectionRewardProblems(withCollection([{ id: 'set', category: 'race', name: 'x', description: 'x', metric: 'collect', section, ...(ids ? { ids } : {}), tiers: [tier(1)] }]));
    expect(set('horses').join(';')).toMatch(/comp gacha is prohibited/);
    expect(set('horses', ['t_partner', 't_akatsuki']).join(';')).toMatch(/1 gacha-obtainable horses/);
    expect(set('skills').join(';')).toMatch(/comp gacha is prohibited/);
    expect(set('cosmetics').join(';')).toMatch(/no reward for spending/);
    expect(set('courses')).toEqual([]);
    // a set of non-gacha horses is fine … until a remote banner puts one of them into a pool (checked with the banners)
    expect(g.templates.has('t_partner')).toBe(false);
    const mm = withCollection([{ id: 'set', category: 'race', name: 'x', description: 'x', metric: 'collect', section: 'horses', ids: ['t_partner'], tiers: [tier(1)] }]);
    expect(() => validateGacha(mm)).not.toThrow();
    const std = mm.gacha.banners.find((b) => b.id === 'standard')!;
    const pool = std.pool.map((e, i) => (i === std.pool.length - 1 ? { ...e, templateId: 't_partner' } : e));
    const withPool: Master = { ...mm, gacha: { ...mm.gacha, banners: mm.gacha.banners.map((b) => (b.id === 'standard' ? { ...b, pool } : b)) } };
    expect(() => validateGacha(withPool)).toThrow(/comp gacha is prohibited/);
  });

  it('QA R11: a horse only the sold SR+ ticket can draw still counts as gacha-obtainable (comp-gacha lint)', () => {
    // take an SR horse out of every banner pool: the SR+ guaranteed ticket (sold in the starter pack) still draws it
    const sr = m.templates.find((t) => t.rarity === 'SR' && !t.giftOnly && !t.seasonal)!.id;
    const strip = (pool: { templateId: string; ppm: number }[]) => {
      const out = pool.filter((e) => e.templateId !== sr);
      const lost = pool.filter((e) => e.templateId === sr).reduce((a, e) => a + e.ppm, 0);
      if (lost > 0 && out.length > 0) out[0] = { ...out[0]!, ppm: out[0]!.ppm + lost };
      return out;
    };
    const banners = m.gacha.banners.map((b) => ({ ...b, pool: strip(b.pool), ...(b.stepUp ? { stepUp: { ...b.stepUp, steps: b.stepUp.steps.map((st) => (st.finalSlotPool ? { ...st, finalSlotPool: strip(st.finalSlotPool) } : st)) } } : {}) }));
    const base: Master = { ...m, gacha: { ...m.gacha, banners } };
    expect(gachaObtainable(base).templates.has(sr)).toBe(true);
    const mm: Master = { ...base, collection: { ...cm, achievements: [{ id: 'set', category: 'race', name: 'x', description: 'x', metric: 'collect', section: 'horses', ids: [sr], tiers: [tier(1)] }] as AchievementDef[] } as CollectionMaster };
    expect(collectionRewardProblems(mm).join(';')).toMatch(/comp gacha is prohibited/);
  });

  it('every remote-config version runs the collection checks (the shipped data passes)', () => {
    expect(() => resolveBundle(m, {})).not.toThrow();
    expect(resolveBundle(m, {}).master.collection).toBe(m.collection);
  });

  it('asset keys: portrait / silhouette per template and a badge per tier are in the generated manifest (npm run gen:assets)', () => {
    const man = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as { keys: string[]; kinds: Record<string, unknown> };
    for (const t of m.templates) {
      expect(man.keys).toContain(`collection/portrait/${t.id}`);
      expect(man.keys).toContain(`collection/silhouette/${t.id}`);
    }
    for (const d of cm.achievements) for (const t of d.tiers) expect(man.keys).toContain(`badge/${d.id}_${t.tier}`);
    for (const k of ['collection/portrait', 'collection/silhouette', 'badge']) expect(man.kinds[k]).toBeDefined();
    const groups = readFileSync(MANIFEST_PATH.replace('assets.manifest.json', 'assets.groups.json'), 'utf8');
    expect(groups).toContain('"collection/**"');
    expect(groups).toContain('"badge/*"');
  });
});

describe('REQ-ACH-001..005 achievements: progress, unlock, claim', () => {
  it('unlocks a tier once when its target is reached (KPI achievement_unlock), then pays free coins once', async () => {
    const x = setup();
    await x.svc.bootstrap('p');
    for (let i = 0; i < 9; i++) await x.race('p');
    let v = await x.svc.achievements('p');
    let races = v.achievements.find((a) => a.id === 'races')!;
    expect(races.progress).toBe(9);
    expect(races.nextTarget).toBe(10);
    expect(races.tiers[0]!.unlocked).toBe(false);
    const r10 = await x.race('p');
    expect((r10 as { achievements?: unknown[] }).achievements).toEqual([{ achievementId: 'races', tier: 1, reward: { freeCoins: 5 } }]);
    expect(x.kpi.filter((k) => k.name === 'achievement_unlock')).toMatchObject([{ s1: 'races', s2: 'race', value: 1, count: 10 }]);
    await x.race('p');
    expect(x.kpi.filter((k) => k.name === 'achievement_unlock')).toHaveLength(1); // never twice
    v = await x.svc.achievements('p');
    races = v.achievements.find((a) => a.id === 'races')!;
    expect(races.tiers[0]).toMatchObject({ unlocked: true, claimable: true, claimed: false, badge: 'badge/races_1' });
    expect(v.totals.claimable).toBe(1);
    const free0 = (await x.svc.view('p')).wallet.free;
    const key = x.k();
    const c = await x.svc.claimAchievement('p', 'races', 1, key);
    expect(c.reward).toEqual({ freeCoins: 5 });
    expect((await x.svc.view('p')).wallet.free).toBe(free0 + 5);
    // the same key returns the stored result; a new key is refused
    expect(await x.svc.claimAchievement('p', 'races', 1, key)).toEqual(c);
    expect(await code(x.svc.claimAchievement('p', 'races', 1, x.k()))).toBe('ALREADY_CLAIMED');
    expect(await code(x.svc.claimAchievement('p', 'races', 2, x.k()))).toBe('NOT_ELIGIBLE');
    expect(await code(x.svc.claimAchievement('p', 'nope', 1, x.k()))).toBe('NOT_FOUND');
    expect(await code(x.svc.claimAchievement('p', 'races', 1, null))).toBe('IDEMPOTENCY_KEY_REQUIRED');
    expect((await x.svc.view('p')).wallet.free).toBe(free0 + 5);
    expect((await x.svc.state('p')).ledger.at(-1)).toMatchObject({ kind: 'grant', currency: 'free', delta: 5, reason: 'achievement races tier 1' });
    expect(x.kpi.filter((k) => k.name === 'achievement_claim')).toMatchObject([{ s1: 'races', value: 1, freeCoins: 5 }]);
  });

  it('a retried race result is applied once (no double progress)', async () => {
    const x = setup();
    await x.svc.bootstrap('p');
    for (let i = 0; i < 3; i++) await x.race('p', 1, {}, 'same');
    expect((await x.svc.state('p')).stats.wins).toBe(1);
    const v = await x.svc.achievements('p');
    expect(v.achievements.find((a) => a.id === 'wins')!.progress).toBe(1);
  });

  it('wins per course, courses raced, and claim-all', async () => {
    const x = setup();
    await x.svc.bootstrap('p');
    await x.race('p', 1, { trackId: 'kirameki_turf_2000' });
    await x.race('p', 3, { trackId: 'aoba_dirt_1400' });
    await x.race('p', 6, { trackId: 'minato_turf_2400' });
    const v = await x.svc.achievements('p');
    expect(v.achievements.find((a) => a.id === 'course_kirameki_turf_2000')!.tier).toBe(1);
    expect(v.achievements.find((a) => a.id === 'course_aoba_dirt_1400')!.tier).toBe(0);
    expect(v.achievements.find((a) => a.id === 'courses_all')!.progress).toBe(3);
    const all = await x.svc.claimAllAchievements('p', x.k());
    expect(all.claimed.map((c) => c.achievementId).sort()).toEqual(['course_kirameki_turf_2000', 'courses_all', 'wins']);
    expect(all.freeCoins).toBe(15);
    expect((await x.svc.claimAllAchievements('p', x.k())).claimed).toEqual([]);
  });

  it('skills fired (verified field data), breeding generations, tournaments, stable likes, team cheers', async () => {
    const x = setup();
    await x.svc.bootstrap('p');
    await x.race('p', 4, { skillFired: true });
    await x.race('p', 4, { skillFired: true, cpuAssisted: true }); // the CPU rode: not the player's skill
    await x.race('p', 4, { skillFired: false });
    let v = await x.svc.achievements('p');
    expect(v.achievements.find((a) => a.id === 'skills')!.progress).toBe(1);
    // tournament: once per tournament (a retried close does not count again)
    await x.svc.tournamentClose('p', 'tour1', 1, null, 'カップ');
    await x.svc.tournamentClose('p', 'tour1', 1, null, 'カップ');
    await x.svc.tournamentClose('p', 'tour2', 3, null, 'カップ');
    // team cheers: counted once per stored feed ref
    for (const ref of ['post:t1:1', 'post:t1:1', 'react:t1:7']) await x.svc.stampPosted('p', 'clap', ref.startsWith('post') ? 'post' : 'reaction', 't1', ref);
    // stable likes received
    for (const from of ['a', 'b', 'c', 'd', 'e']) await x.svc.stableLikeReceive('p', from, `like:${from}:2026-11-03:1`);
    v = await x.svc.achievements('p');
    const get = (id: string) => v.achievements.find((a) => a.id === id)!;
    expect(get('tournament_podium').progress).toBe(2);
    expect(get('tournament_win').progress).toBe(1);
    expect(get('tournament_win').titles[0]).toMatchObject({ id: 'ach_champion', unlocked: true });
    expect(get('team_cheers').progress).toBe(2);
    expect(get('stable_likes').progress).toBe(5);
    expect(get('stable_likes').tier).toBe(1);
    // the achievement title is part of the one title list and can be equipped
    const titles = await x.svc.titles('p');
    expect(titles.titles.find((t) => t.id === 'ach_champion')).toMatchObject({ unlocked: true, source: 'achievement', achievementId: 'tournament_win', tier: 1 });
    expect((await x.svc.equipTitle('p', 'ach_champion')).titleId).toBe('ach_champion');
    expect(await code(x.svc.equipTitle('p', 'ach_clockwork'))).toBe('NOT_ELIGIBLE');
  });

  it('breeding generations are computed from the stable (template horse 0, foal 1 + older parent)', () => {
    const base = { templateId: null, studSire: undefined } as const;
    const h = (id: string, sireId: string | null, damId: string | null) => ({ ...base, id, sireId, damId }) as never;
    const g = generationsOf([h('a', null, null), h('b', null, null), h('c', 'a', 'b'), h('d', 'c', 'b'), h('e', 'd', 'x_foreign')]);
    expect([g.get('a'), g.get('c'), g.get('d'), g.get('e')]).toEqual([0, 1, 2, 3]);
  });

  it('REQ-UXS-040: nothing unlocks or is claimed while the account is scheduled for deletion', async () => {
    const x = setup();
    await x.svc.bootstrap('p');
    for (let i = 0; i < 10; i++) await x.race('p', 1);
    const st = await x.svc.state('p');
    st.deletion = { status: 'scheduled', requestedAt: T0, scheduledAt: T0 + 1, steps: [] } as never;
    await x.repo.put(st);
    expect(await code(x.svc.claimAchievement('p', 'races', 1, x.k()))).toBe('DELETION_PENDING');
    expect(await code(x.svc.claimAllAchievements('p', x.k()))).toBe('DELETION_PENDING');
    const v = await x.svc.achievements('p');
    expect(v.blocked).toBe(true);
    expect(v.totals.claimable).toBe(0);
    const before = x.kpi.filter((k) => k.name === 'achievement_unlock').length;
    await x.svc.tournamentClose('p', 'tourX', 1, null, 'x');
    expect(x.kpi.filter((k) => k.name === 'achievement_unlock').length).toBe(before);
  });
});

describe('REQ-COL-001..005 図鑑', () => {
  it('lists every template, skill, course and cosmetic as obtained / seen / unknown with counts; completion pays nothing', async () => {
    const x = setup();
    await x.svc.bootstrap('p');
    await x.svc.grantPartner('p', 'アイボウ', x.k());
    let v = await x.svc.collection('p');
    expect(v.sections.horses.total).toBe(m.templates.length);
    expect(v.sections.skills.total).toBe(m.skills.skills.length);
    expect(v.sections.courses.total).toBe(m.tracks.length);
    expect(v.sections.cosmetics.total).toBe(m.items.cosmetics.length);
    expect(v.completionRewards).toBe(false);
    expect(v.notice).toMatch(/報酬はありません/);
    const partner = v.sections.horses.entries.find((e) => e.id === 't_partner')!;
    expect(partner).toMatchObject({ state: 'obtained', name: 'アイボウ', art: 'collection/portrait/t_partner' });
    expect(partner.stats).not.toBeNull();
    expect(partner.lore).toBeTruthy();
    const unknown = v.sections.horses.entries.find((e) => e.id === 't_kohaku')!;
    expect(unknown).toMatchObject({ state: 'unknown', name: null, stats: null, lore: null, rarity: 'SSR', art: 'collection/silhouette/t_kohaku' });
    expect(v.sections.skills.entries.find((e) => e.id === 'sk_sueashi')).toMatchObject({ state: 'obtained' });
    // a confirmed race shows the CPU field (templates + skills) as seen
    const cfg = makeConfig(1, 'ranked', 11);
    const pid = cfg.entrants.find((e) => e.kind === 'human')!.playerId!;
    const res = settleRace(cfg, { status: 'confirmed', order: cfg.entrants.map((e) => e.slot), hash: 'h', via: 'consensus', suspects: [], skillFired: [] }, {}, { v: 1, config: cfg, endTick: 10, inputs: [] });
    const r = res[pid]!;
    expect(r.seen!.templates.length).toBeGreaterThan(0);
    expect(r.details?.skillFired).toBe(false);
    await x.svc.applyRace('p', { ...r, raceId: 'seen1' });
    v = await x.svc.collection('p');
    const seenId = r.seen!.templates.find((t) => t !== 't_partner')!;
    const seen = v.sections.horses.entries.find((e) => e.id === seenId)!;
    expect(seen.state).toBe('seen');
    expect(seen.name).toBe(m.templateById.get(seenId)!.name);
    expect(seen.stats).toBeNull();
    expect(v.sections.horses.seen).toBeGreaterThan(0);
    expect(v.sections.courses.entries.find((c) => c.id === cfg.track.id)).toMatchObject({ state: 'obtained', races: 1, name: expect.stringContaining('競馬場') });
    expect(v.totals.completionPermille).toBe(Math.floor((v.totals.obtained * 1000) / v.totals.total));
  });

  it('HTTP: GET /v1/collection, GET /v1/achievements, claim (keyed) and claim-all', async () => {
    const x = setup();
    await x.svc.bootstrap('u1');
    for (let i = 0; i < 10; i++) await x.race('u1');
    const inv: PlayerInvoker = { invoke: (meth, ...args) => (x.svc as unknown as Record<string, (...a: unknown[]) => Promise<never>>)[meth]!(...args) };
    const ctx = { master: m, authenticate: async () => 'u1', player: () => inv, clock: () => T0 } as unknown as AppContext;
    const req = (method: string, path: string, key?: string) => handle(new Request(`https://x${path}`, { method, headers: { authorization: 'Bearer t', ...(key ? { 'idempotency-key': key } : {}), 'content-type': 'application/json' }, ...(method === 'POST' ? { body: '{}' } : {}) }), {}, ctx);
    const col = await req('GET', '/v1/collection');
    expect(col.status).toBe(200);
    expect(((await col.json()) as { sections: { horses: { total: number } } }).sections.horses.total).toBe(m.templates.length);
    const ach = await (await req('GET', '/v1/achievements')).json() as { totals: { claimable: number } };
    expect(ach.totals.claimable).toBe(1);
    expect((await req('POST', '/v1/achievements/races/tiers/9/claim', 'k1')).status).toBe(400);
    const c = await req('POST', '/v1/achievements/races/tiers/1/claim', 'k2');
    expect(c.status).toBe(200);
    expect(((await c.json()) as { reward: { freeCoins: number } }).reward.freeCoins).toBe(5);
    const all = await req('POST', '/v1/achievements/claim-all', 'k3');
    expect(((await all.json()) as { claimed: unknown[] }).claimed).toEqual([]);
  });
});
