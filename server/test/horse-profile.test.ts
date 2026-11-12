// Quality pass (raising & breeding, docs/quality/raising-breeding.md): 馬カード, the training outlook and the foal rarity odds.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { m, freshPlayer } from './helpers.js';
import { MemoryPlayerRepo, PlayerService } from '../src/domain/service.js';
import { seededRng, randRange } from '../src/domain/rng.js';
import { STAT_KEYS, type Stats } from '../src/domain/master.js';
import { BREED, breed, breedingPreview, createHorseFromTemplate, foalRarityOdds, rarityForTotal, retire } from '../src/domain/horses.js';
import { generationOf, growthStage, horseProfile } from '../src/domain/horseProfile.js';
import { normalizeStats } from '../src/domain/season.js';
import { raceStats, type TrainingConfig } from '../src/domain/training.js';

const JST = 9 * 3600_000;
const T0 = Date.UTC(2026, 11, 10, 12) - JST;
const cfg = m.progression.training as TrainingConfig;
const vectors = JSON.parse(readFileSync(join(__dirname, '..', '..', 'contracts', 'horse-profile.vectors.json'), 'utf8'));

function world() {
  let now = T0;
  const svc = new PlayerService(new MemoryPlayerRepo(), { master: m, rng: seededRng(5), clock: () => now, verifiers: {} });
  let n = 0;
  const k = () => `c:hp:${n++}`;
  const player = async (id = 'p') => { await svc.bootstrap(id); await svc.grantPartner(id, 'アイボウ', k()); return (await svc.state(id)).horses[0]!.id; };
  const train = async (id: string, horseId: string, menu: string) => {
    const s = await svc.trainingStart(id, horseId, menu, k());
    now += cfg.timing.durationMs + 500;
    return svc.trainingFinish(id, s.session.sessionId, { taps: s.session.beats.map((b) => b + 20) }, k());
  };
  return { svc, k, player, train, advanceDays: (d: number) => { now += d * 86_400_000; } };
}

describe('growth stage (shared with C# GrowthStages.Of)', () => {
  it('matches contracts/horse-profile.vectors.json', () => {
    for (const c of vectors.cases) expect(growthStage(c.trained, c.potential), JSON.stringify(c)).toEqual({ index: c.index, key: c.key, nextAt: c.nextAt });
  });
  it('only the whole potential is complete, and every stage is reachable in order', () => {
    expect(growthStage(239, 240).key).toBe('peak');
    expect(growthStage(240, 240).key).toBe('complete');
    let last = 0;
    for (let t = 0; t <= 300; t++) { const g = growthStage(t, 300); expect(g.index).toBeGreaterThanOrEqual(last); expect(g.index - last).toBeLessThanOrEqual(1); last = g.index; }
    expect(last).toBe(4);
  });
});

describe('馬カード (GET /v1/horses/:horseId/profile)', () => {
  it('layers add up to the race stats; ranked keeps the proportions; nothing is written', async () => {
    const w = world();
    const h = await w.player();
    for (let i = 0; i < 2; i++) await w.train('p', h, 'hill');
    const before = JSON.stringify(await w.svc.state('p'));
    const p = await w.svc.horseProfile('p', h);
    expect(JSON.stringify(await w.svc.state('p'))).toBe(before); // read-only
    const s = await w.svc.state('p');
    const horse = s.horses.find((x) => x.id === h)!;
    const race = raceStats(m, horse);
    for (const st of p.stats) {
      expect(st.base + st.awakening + st.trained).toBe(st.race);
      expect(st.race).toBe(race[st.key]);
      expect(st.trained).toBe(horse.trained?.[st.key] ?? 0);
    }
    const ranked = normalizeStats(race, p.totals.cap);
    for (const st of p.stats) expect(st.ranked).toBe(ranked[st.key]);
    expect(p.totals.race).toBe(STAT_KEYS.reduce((a, k) => a + race[k], 0));
    expect(p.totals.ranked).toBeLessThanOrEqual(p.totals.cap);
    expect(p.growth!.trainedTotal).toBeGreaterThan(0);
    expect(p.growth!.potential).toBe(cfg.potentialByRarity[horse.rarity]);
    expect(p.growth!.stageKey).toBe(growthStage(p.growth!.trainedTotal, p.growth!.potential).key);
    // the hill menu leans burst (weight 2): the horse's burst share grows
    expect(p.leaning!.stat).toBe('burst');
    expect(p.leaning!.sharePermilleNow).toBeGreaterThanOrEqual(p.leaning!.sharePermilleBefore);
    expect(p.recentTraining.length).toBe(2);
    expect(p.lineage.generation).toBe(1);
    expect(p.lineage.bred).toBe(false);
  });
  it('an untrained horse has no leaning, stage 新馬', async () => {
    const w = world();
    const h = await w.player();
    const p = await w.svc.horseProfile('p', h);
    expect(p.leaning).toBeNull();
    expect(p.growth!.stageKey).toBe('debut');
    expect(p.career.races).toBe(0);
  });
  it('lineage: generations count up through the stable, skill origin and 隔世遺伝 are carried', () => {
    const s = freshPlayer();
    const t0 = m.templates.find((t) => t.sex === 'male' && t.skillId)!;
    const t1 = m.templates.find((t) => t.sex === 'female')!;
    const sire = createHorseFromTemplate(s, t0, 0); const dam = createHorseFromTemplate(s, t1, 0);
    retire(s, sire.id); retire(s, dam.id);
    let foal = breed(m, s, sire.id, dam.id, seededRng(9), T0).foal;
    expect(generationOf(s, foal)).toBe(2);
    // breed the foal (any sex) back with a parent of the other sex, a day later
    retire(s, foal.id);
    const [a, b] = foal.sex === 'male' ? [foal, dam] : [sire, foal];
    const g3 = breed(m, s, a.id, b.id, seededRng(11), T0 + 86_400_000).foal;
    expect(generationOf(s, g3)).toBe(3);
    const p = horseProfile(m, s, foal.id);
    expect(p.lineage.bred).toBe(true);
    expect(p.lineage.sireName).toBe(sire.name);
    if (foal.skillId) expect(['sire', 'dam']).toContain(p.lineage.skillFrom);
    else expect(p.lineage.skillFrom).toBeNull();
    foal = s.horses.find((x) => x.id === g3.id)!;
    expect(horseProfile(m, s, foal.id).lineage.generation).toBe(3);
  });
  it('is a GET route for the signed-in player', async () => {
    const { routes } = await import('../src/http/app.js');
    const r = routes.find((x) => x.path === '/v1/horses/:horseId/profile');
    expect(r).toMatchObject({ method: 'GET', auth: 'player' });
  });
});

describe('training outlook per menu (the same computeGain finish uses)', () => {
  it('equals the start preview for every menu, and drops when the horse is tired', async () => {
    const w = world();
    const h = await w.player();
    const v = await w.svc.training('p');
    const hv = v.enabled ? v.horses.find((x) => x.horseId === h)! : null;
    const hill = hv!.menus.find((x) => x.id === 'hill')!;
    const st = await w.svc.trainingStart('p', h, 'hill', w.k());
    expect(hill.outlook).toMatchObject({ min: st.preview.min, max: st.preview.max, efficiencyPermille: 1000 });
    await w.svc.trainingFinish('p', st.session.sessionId, { taps: [], skipped: true }, w.k());
    const st2 = await w.svc.trainingStart('p', h, 'wood', w.k()); // fatigue 30 now: efficiency 850‰
    const v2 = await w.svc.training('p');
    const wood = v2.enabled ? v2.horses.find((x) => x.horseId === h)!.menus.find((x) => x.id === 'wood')! : null;
    expect(st2.preview.max).toBeGreaterThan(0);
    expect(wood!.outlook.efficiencyPermille).toBeLessThan(1000); // fatigue is now 55 (shown before choosing next time)
  });
});

describe('foal rarity odds (exact, from the breeding rules)', () => {
  const flat = (v: number): Stats => ({ speed: v, stamina: v, burst: v, guts: v, temper: v });
  it('adds up to one million and is certain far from a threshold', () => {
    expect(foalRarityOdds(flat(900))).toEqual({ R: 0, SR: 0, SSR: 1_000_000 });
    expect(foalRarityOdds(flat(500))).toEqual({ R: 1_000_000, SR: 0, SSR: 0 });
    const o = foalRarityOdds({ speed: 700, stamina: 650, burst: 720, guts: 690, temper: 660 });
    expect(o.R + o.SR + o.SSR).toBe(1_000_000);
  });
  it('a baseline exactly on the SSR line is a little over half (ties count as SSR)', () => {
    // sum of five independent uniforms on −60..60 is symmetric: P(sum ≥ 0) = (1 + P(sum = 0)) / 2
    let dist = new Map<number, number>([[0, 1]]);
    for (let i = 0; i < 5; i++) {
      const next = new Map<number, number>();
      for (const [s, p] of dist) for (let d = -60; d <= 60; d++) next.set(s + d, (next.get(s + d) ?? 0) + p / 121);
      dist = next;
    }
    const expected = Math.round(((1 + dist.get(0)!) / 2) * 1e6);
    expect(foalRarityOdds(flat(740)).SSR).toBe(expected);
  });
  it('agrees with drawing the same rule many times (randRange, clamp, rarityForTotal)', () => {
    const base = { speed: 720, stamina: 700, burst: 760, guts: 690, temper: 660 };
    const rng = seededRng(77);
    const n = 40_000;
    const c = { R: 0, SR: 0, SSR: 0 };
    for (let i = 0; i < n; i++) {
      let t = 0;
      for (const k of STAT_KEYS) t += Math.max(0, Math.min(1000, base[k] + randRange(rng, -BREED.variation, BREED.variation)));
      c[rarityForTotal(t)] += 1;
    }
    const o = foalRarityOdds(base);
    for (const r of ['R', 'SR', 'SSR'] as const) expect(Math.abs(c[r] / n - o[r] / 1e6)).toBeLessThan(0.012);
  });
  it('is in the breeding preview, from the same baseline (nick and inbreeding included)', () => {
    const s = freshPlayer();
    const sire = createHorseFromTemplate(s, m.templates.find((t) => t.sex === 'male')!, 0);
    const dam = createHorseFromTemplate(s, m.templates.find((t) => t.sex === 'female')!, 0);
    retire(s, sire.id); retire(s, dam.id);
    const p = breedingPreview(m, s, sire.id, dam.id);
    const mid = {} as Stats;
    for (const k of STAT_KEYS) mid[k] = (p.stats[k].min + p.stats[k].max) / 2;
    // away from the 0/1000 clamps the range midpoint is the baseline
    expect(p.rarity).toEqual(foalRarityOdds(mid));
  });
});
