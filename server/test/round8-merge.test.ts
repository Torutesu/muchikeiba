// Round 8 merge of feat/my-stable × feat/ux-monetization × feat/ux-onboarding: the places where the features meet.
import { describe, expect, it } from 'vitest';
import { MemoryPlayerRepo, PlayerService } from '../src/domain/service.js';
import { FakeStoreVerifier } from '../src/domain/purchase.js';
import { seededRng } from '../src/domain/rng.js';
import { AppError } from '../src/domain/errors.js';
import { createHorseFromTemplate } from '../src/domain/horses.js';
import { runAccountDeletion, type DeletionPorts, type RetainedRecord } from '../src/domain/accountDeletion.js';
import { MemoryStableDirectory, StableService, stableConfig, stableDeletionPort, type StableSnapshot } from '../src/domain/stable.js';
import { stablePlayersFrom } from '../src/http/stablePorts.js';
import { handle, type AppContext, type PlayerInvoker } from '../src/http/app.js';
import { gameDaysUntil, gameDayKey } from '../src/domain/time.js';
import { buildRaceConfig, toRaceHorse } from '../src/domain/raceConfig.js';
import { m } from './helpers.js';

const T0 = Date.UTC(2026, 10, 5, 3); // 12:00 JST
const DAY = 86_400_000;
const code = async (p: Promise<unknown>) => { try { await p; return 'ok'; } catch (e) { return (e as AppError).code; } };

function world() {
  const clock = { now: T0 };
  const repo = new MemoryPlayerRepo();
  const store = new FakeStoreVerifier();
  const dir = new MemoryStableDirectory();
  const svc = new PlayerService(repo, {
    master: m, rng: seededRng(11), clock: () => clock.now, verifiers: { fake: store },
    onStable: async (id: string, snap: StableSnapshot | null) => { if (snap) await dir.put(snap); else await dir.remove(id); },
  });
  const invoker: PlayerInvoker = { invoke: (async (method: string, ...args: unknown[]) => (svc as unknown as Record<string, (...a: unknown[]) => unknown>)[method]!.apply(svc, args)) as PlayerInvoker['invoke'] };
  const stable = new StableService(stablePlayersFrom(() => invoker), dir, () => stableConfig(m));
  const buy = (id: string, productId: string, tx: string) => {
    const p = m.products.find((x) => x.id === productId)!;
    return svc.purchase(id, 'fake', productId, store.issue({ transactionId: tx, productId, purchasedAt: clock.now, priceYen: p.priceYen }));
  };
  const schedule = async (id: string) => {
    const t = ((await svc.requestDeletion(id, null)) as { confirmToken: string }).confirmToken;
    await svc.requestDeletion(id, t);
  };
  const retained: RetainedRecord[] = [];
  const ports: DeletionPorts = {
    snapshot: (u) => svc.deletionSnapshot(u),
    markStep: async (u, st) => { await svc.deletionMarkStep(u, st); },
    friends: { removeFriend: (o, u) => svc.friendRemove(o, u), dropOutgoing: (f, u) => svc.friendCancel(f, u), dropIncoming: (to, u) => svc.friendDecline(to, u) },
    directory: { forget: async () => undefined },
    leaderboards: { forget: async () => undefined, deleteGhosts: async () => undefined },
    // the production wiring (do/deletionPorts.ts): the player's own stableForget, then StableService.removeStable
    stable: stableDeletionPort((u) => svc.stableForget(u), stable),
    finalize: (u) => svc.deletionFinalize(u),
    retain: async (_u, r) => { retained.push(r); },
    wipe: (u) => svc.wipe(u),
  };
  return { clock, repo, svc, dir, stable, buy, schedule, ports, retained };
}

describe('account deletion × マイ厩舎 (REQ-UXS-040 × REQ-STABLE-*)', () => {
  it('removes the public stable snapshot, clears the layout and like records, and later likes cannot revive it', async () => {
    const w = world();
    await w.svc.setAge('p', 1990, 1, false);
    await w.svc.tx('p', null, (s, now) => { s.items['decor_flower_box'] = 1; createHorseFromTemplate(s, m.templates[0]!, now); });
    await w.svc.tx('q', null, (s, now) => { s.items['decor_flower_box'] = 1; createHorseFromTemplate(s, m.templates[0]!, now); });
    await w.stable.save('p', { theme: 'standard', name: null, slots: ['decor_flower_box'], featuredHorseIds: [] });
    await w.stable.save('q', { theme: 'standard', name: null, slots: ['decor_flower_box'], featuredHorseIds: [] });
    await w.stable.like('q', 'p', 'c:l1'); // p received a like from q
    await w.stable.like('p', 'q', 'c:l2'); // p gave a like to q
    expect(await w.dir.get('p')).not.toBeNull();

    await w.schedule('p');
    // still visible during the cancel window (the account keeps working)
    expect((await w.stable.visit('q', 'p')).stable.playerId).toBe('p');
    w.clock.now += 14 * DAY;
    // a deletion that has started never publishes the stable again, even if a like slips in
    await w.svc.deletionMarkStep('p', 'friends');
    expect(await w.dir.get('p')).toBeNull();
    const st = await w.svc.state('p');
    expect((await w.svc.stableLikeReceive('p', 'q', `q:${gameDayKey(w.clock.now)}:9`))).toMatchObject({ counted: false, snapshot: null });
    expect(((await w.svc.state('p')) as typeof st & { stable?: { likes: number } }).stable?.likes).toBe(1);

    const r = await runAccountDeletion(w.ports, 'p', w.clock.now);
    expect(r.done).toContain('stable');
    expect(await w.dir.get('p')).toBeNull();
    expect(w.repo.data.has('p')).toBe(false);
    expect(await code(w.stable.visit('q', 'p'))).toBe('NOT_FOUND');
    expect(await code(w.stable.like('q', 'p', 'c:l3'))).toBe('NOT_FOUND');
    // a like that passed the directory check just before the wipe does not create a fresh player object
    expect(await w.svc.stableLikeReceive('p', 'q', `q:${gameDayKey(w.clock.now)}:5`)).toEqual({ counted: false, likes: 0, snapshot: null });
    expect(w.repo.data.has('p')).toBe(false);
    // the like p gave stays in q's total as a plain count; q's stable still works
    expect((await w.stable.visit('q', 'q')).stable.likes).toBe(1);
    expect((await w.stable.visits('q')).recommended.map((x) => x.playerId)).not.toContain('p');
  });

  it('stableForget alone clears the layout and like records (idempotent)', async () => {
    const w = world();
    await w.svc.tx('p', null, (s) => { s.items['decor_flower_box'] = 1; });
    await w.stable.save('p', { theme: 'standard', name: 'あ', slots: ['decor_flower_box'], featuredHorseIds: [] });
    expect(await w.svc.stableForget('p')).toEqual({ removed: true });
    expect(await w.svc.stableForget('p')).toEqual({ removed: false });
    expect((await w.svc.stableMine('p')).saved).toBe(false);
    expect(await w.dir.get('p')).toBeNull();
  });
});

describe('account deletion × monetization (REQ-UXS-040 × REQ-UXS-017..021)', () => {
  it('a scheduled deletion blocks offers, offer views, the daily-pack claim and every new SKU; cancelling restores them', async () => {
    const w = world();
    await w.svc.setAge('p', 1990, 1, false);
    await w.buy('p', 'stable_allowance_30d', 'A1');
    for (let i = 0; i < 6; i++) await w.svc.applyRace('p', { raceId: `r${i}`, mode: 'ranked', place: 8, fieldSize: 12, newRating: null, void: false, humans: 1 });
    const offers = (await w.svc.shopOffers('p')).offers;
    expect(offers.length).toBeGreaterThan(0);
    await w.schedule('p');
    expect(await code(w.svc.shopOffers('p'))).toBe('DELETION_PENDING');
    expect(await code(w.svc.markOfferViewed('p', offers[0]!.id))).toBe('DELETION_PENDING');
    expect(await code(w.svc.claimAllowance('p', 'c:a1'))).toBe('DELETION_PENDING');
    for (const sku of ['coin_160', 'starter_pack', 'season_pass', 'season_pass_plus', 'stable_allowance_30d', 'promo_pack_B']) {
      expect(await code(w.svc.purchaseIntent('p', sku)), sku).toBe('DELETION_PENDING');
    }
    await w.svc.cancelDeletion('p');
    expect(await code(w.svc.shopOffers('p'))).toBe('ok');
    expect((await w.svc.claimAllowance('p', 'c:a2')).freeCoins).toBe(30);
  });

  it('finalize forfeits the 厩舎手当 queue (running + queued days) and the season pass', async () => {
    const w = world();
    await w.svc.setAge('p', 1990, 1, false);
    await w.buy('p', 'stable_allowance_30d', 'A1');
    await w.svc.claimAllowance('p', 'c:a1');
    await w.buy('p', 'stable_allowance_30d', 'A2'); // arrived while A1 runs: queued after it
    await w.buy('p', 'season_pass', 'P1');
    for (let i = 0; i < 10; i++) await w.svc.applyRace('p', { raceId: `r${i}`, mode: 'ranked', place: 5, fieldSize: 12, newRating: null, void: false, humans: 1 });
    const preview = (await w.svc.requestDeletion('p', null)) as { confirmToken: string; forfeit: { allowanceDays: number; seasonPass: boolean } };
    expect(preview.forfeit).toMatchObject({ allowanceDays: 59, seasonPass: true });
    await w.svc.requestDeletion('p', preview.confirmToken);
    w.clock.now += 14 * DAY; // 14 more days of A1 went unclaimed
    const r = await runAccountDeletion(w.ports, 'p', w.clock.now);
    expect(r.done).toContain('wipe');
    const rec = w.retained[0]!;
    // A1: days 15..30 (16), A2: 30 days → 46 days, 30 coins each
    expect(rec.forfeited.allowance).toEqual({ days: 46, freeCoins: 46 * 30 });
    expect(rec.forfeited.pass).toMatchObject({ seasonId: '2026-11', premium: true, level: 2, unclaimedFree: 2, unclaimedPremium: 2 });
    expect(rec.forfeited.paidCoins).toBe(200);
  });

  it('finalize leaves no claimable daily pack or pass level on the state before the wipe', async () => {
    const w = world();
    await w.svc.setAge('p', 1990, 1, false);
    await w.buy('p', 'stable_allowance_30d', 'A1');
    await w.buy('p', 'season_pass', 'P1');
    await w.schedule('p');
    w.clock.now += 14 * DAY;
    await w.svc.deletionMarkStep('p', 'friends');
    await w.svc.deletionFinalize('p');
    const s = await w.svc.state('p');
    expect(s.shop!.allowances.every((a) => a.forfeitedAt === w.clock.now)).toBe(true);
    expect((await w.svc.allowance('p')).active).toBe(false);
    expect(s.seasonPass.expiresAt).toBeLessThanOrEqual(w.clock.now);
    expect(s.wallet).toMatchObject({ paid: 0, free: 0 });
  });
});

describe('A/B starterOfferTrigger (REQ-UXS-032 × REQ-UXS-017)', () => {
  const ab = (value: 'first_bottom_half' | 'fifth_race') => ({
    ...m, progression: { ...m.progression, experiments: [{ id: 'ab_starter', active: true, buckets: [{ id: 'a', weight: 1, values: { starterOfferTrigger: value } }] }] },
  });
  const run = async (master: typeof m, places: number[]) => {
    const svc = new PlayerService(new MemoryPlayerRepo(), { master, rng: seededRng(3), clock: () => T0, verifiers: {} });
    for (const [i, place] of places.entries()) await svc.applyRace('p', { raceId: `r${i}`, mode: 'ranked', place, fieldSize: 12, newRating: null, void: false, humans: 1 });
    return (await svc.shopOffers('p')).offers.find((o) => o.touchpoint === 'T2')?.reason ?? null;
  };
  it('without an experiment the earlier of the two triggers shows the starter pack; with one only that trigger', async () => {
    expect(await run(m, [8])).toBe('first_4th_or_worse');
    expect(await run(ab('fifth_race'), [8])).toBeNull();
    expect(await run(ab('fifth_race'), [8, 8, 8, 8, 8])).toBe('race5');
    expect(await run(ab('first_bottom_half'), [1, 2, 1, 2, 1])).toBeNull();
    expect(await run(ab('first_bottom_half'), [1, 2, 1, 2, 1, 9])).toBe('first_4th_or_worse');
  });
});

describe('GET /v1/missions (onboarding × monetization)', () => {
  it('returns daily missions, beginner and season missions and the first-win bonus in one body', async () => {
    const w = world();
    const invoker: PlayerInvoker = { invoke: (async (method: string, ...args: unknown[]) => (w.svc as unknown as Record<string, (...a: unknown[]) => unknown>)[method]!.apply(w.svc, args)) as PlayerInvoker['invoke'] };
    const c = { master: m, authenticate: async () => 'u', player: () => invoker, clock: () => w.clock.now } as unknown as AppContext;
    await w.svc.applyRace('u', { raceId: 'r1', mode: 'ranked', place: 1, fieldSize: 12, newRating: null, void: false, humans: 1 });
    const res = await handle(new Request('https://x/v1/missions'), {}, c);
    const body = (await res.json()) as Record<string, any>;
    expect(res.status).toBe(200);
    expect(Object.keys(body).sort()).toEqual(['beginner', 'firstWinBonus', 'missions', 'season']);
    expect(body.missions.map((x: { id: string }) => x.id)).toEqual(m.progression.dailyMissions.map((x) => x.id));
    expect(body.beginner.steps[0]).toMatchObject({ id: 'bm_scout', step: 1 });
    expect(body.season).toMatchObject({ seasonId: '2026-11' });
    expect(body.season.missions.find((x: { id: string }) => x.id === 'sm_wins5')).toMatchObject({ progress: 1 });
    expect(body.firstWinBonus).toEqual({ modes: ['ranked'], byWin: [30, 20, 10], winsToday: 1, remaining: 2, next: 20 });
  });
});

describe('game days in monetization (REQ-UXS-011 × REQ-UXS-010/018/020)', () => {
  it('gameDaysUntil counts game days, equal to ceil(days) with the midnight rollover', () => {
    const end = Date.UTC(2026, 10, 30, 15); // 2026-12-01 00:00 JST
    for (const now of [end - 1, end - 3_600_000, end - DAY, end - DAY - 1, end - 6.5 * DAY]) expect(gameDaysUntil(end, now)).toBe(Math.ceil((end - now) / DAY));
    expect(gameDaysUntil(end, end)).toBe(0);
    // with a 04:00 rollover, 02:00 JST on the 1st is still the last game day of November
    expect(gameDaysUntil(end, end - 3_600_000, 4)).toBe(1);
    expect(gameDaysUntil(end + 2 * 3_600_000, end + 3_600_000, 4)).toBe(1);
  });

  it('the first-win bonus and the daily pack reset on the game day', async () => {
    const w = world();
    await w.svc.setAge('p', 1990, 1, false);
    await w.buy('p', 'stable_allowance_30d', 'A1');
    await w.svc.claimAllowance('p', 'c:a1');
    expect(await code(w.svc.claimAllowance('p', 'c:a2'))).toBe('ALREADY_CLAIMED');
    await w.svc.applyRace('p', { raceId: 'w1', mode: 'ranked', place: 1, fieldSize: 12, newRating: null, void: false, humans: 1 });
    expect((await w.svc.state('p')).dailyWins).toEqual({ date: gameDayKey(w.clock.now), count: 1 });
    w.clock.now += DAY;
    expect((await w.svc.claimAllowance('p', 'c:a3')).day).toBe(2);
    expect((await w.svc.missionsAll('p')).firstWinBonus.winsToday).toBe(0);
  });
});

describe('onboarding gift horses × unique skills (REQ-UXS-002/013 × REQ-UXS-050)', () => {
  it('the partner (SR sashi) and the broodmare (R senko) carry a skill that fits their rarity and style', () => {
    for (const [tid, sk] of [['t_partner', 'sk_sueashi'], ['t_broodmare', 'sk_kouinonebari']] as const) {
      const t = m.templateById.get(tid)!;
      const d = m.skills.byId.get(t.skillId!)!;
      expect(t.skillId).toBe(sk);
      expect(d.rarity).toBe(t.rarity);
      expect(d.styles).toContain(t.style);
    }
  });

  it('the granted partner races with its skill (capped in ranked, also in the beginner match), never in the tutorial', async () => {
    const w = world();
    const { horse } = await w.svc.grantPartner('p', 'アイボウ', 'c:/v1/player/partner:k');
    expect(horse.skillId).toBe('sk_sueashi');
    const rh = toRaceHorse(m, horse);
    expect(rh.skill).toMatchObject({ id: 'sk_sueashi', trigger: 'spurtBehind' });
    const build = (mode: 'ranked' | 'tutorial' | 'friend', extra: Record<string, unknown> = {}) => buildRaceConfig(m, {
      raceId: `r_${mode}`, mode, trackId: 'aoba_turf_1600', humans: [{ playerId: 'p', horse: rh }], cpuCount: mode === 'tutorial' ? 0 : 11, cpuLevel: 1,
      statCap: mode === 'ranked' ? 2800 : null, rng: seededRng(4), ...extra,
    });
    const mine = (c: ReturnType<typeof build>) => c.entrants.find((e) => e.playerId === 'p')!.horse;
    const caps = m.skills.rankedCaps;
    const ranked = mine(build('ranked', { cpuStatPermille: 780 }));
    expect(ranked.skill!.id).toBe('sk_sueashi');
    expect(ranked.skill!.speedPermille).toBeLessThanOrEqual(caps.speedPermille);
    expect(ranked.skill!.durationTicks).toBeLessThanOrEqual(caps.durationTicks);
    expect(mine(build('friend')).skill).toEqual(rh.skill);
    expect(mine(build('tutorial')).skill).toBeUndefined();
    // beginner-match CPUs are weaker but keep their template skills
    for (const e of build('ranked', { cpuStatPermille: 780 }).entrants.filter((x) => x.kind === 'cpu')) {
      const t = m.templates.find((x) => `cpu_${x.id}` === e.horse.id)!;
      expect(e.horse.skill?.id ?? null).toBe(t.skillId ?? null);
    }
  });
});
