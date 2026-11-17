// Quality pass 3 — week 2 and using what you have (docs/quality/week2.md, REQ-GOAL-017..020, REQ-UXS-041/042, REQ-ITEM-010/011):
// the solo ways of the social beginner steps, graduation as the week-2 goal on day 8, the week-2 arc (days 8..14, one reason
// a day, projected from the same login tables), the moment a treat / breeding material matters. Nothing new is granted.
import { describe, expect, it } from 'vitest';
import { m } from './helpers.js';
import { MemoryPlayerRepo, PlayerService } from '../src/domain/service.js';
import { seededRng } from '../src/domain/rng.js';
import { goalLadderView, loginBonusPlan, WEEK2, type GoalLadderView } from '../src/domain/goals.js';
import { onboardingProblems, SOCIAL_BEGINNER_KINDS } from '../src/domain/onboarding.js';
import { createHorseFromTemplate, retire } from '../src/domain/horses.js';
import { TREAT_MIN_FATIGUE } from '../src/domain/training.js';
import type { Reward } from '../src/domain/master.js';

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 11, 8, 3); // 2026-12-08 12:00 JST

function world() {
  let now = T0;
  const svc = new PlayerService(new MemoryPlayerRepo(), { master: m, rng: seededRng(12), clock: () => now, verifiers: {} });
  let n = 0, k = 0;
  const key = () => `c:w2${k++}`;
  const race = (id: string, place: number) => svc.applyRace(id, { raceId: `r_${id}_${n++}`, mode: 'ranked', place, fieldSize: 12, newRating: null, void: false, humans: 2 });
  const player = async (id: string, races = 0) => {
    await svc.bootstrap(id);
    await svc.grantPartner(id, 'アイボウ', `c:partner-${id}`);
    await svc.claimLogin(id, key());
    for (let i = 0; i < races; i++) await race(id, (i % 6) + 1);
  };
  const train = async (id: string, menu = 'hill') => {
    const s = await svc.state(id);
    const st = await svc.trainingStart(id, s.flags.partnerHorseId!, menu, key());
    return svc.trainingFinish(id, st.session.sessionId, { taps: [], skipped: true }, key());
  };
  /** Each day: advance one game day and receive the login bonus. */
  const nextDay = async (id: string) => { now += DAY; await svc.claimLogin(id, key()); };
  return { svc, race, player, train, key, nextDay, now: () => now, advance: (ms: number) => { now += ms; } };
}
const goals = async (w: ReturnType<typeof world>, id = 'p') => (await w.svc.goals(id)) as GoalLadderView;
const steps = () => m.progression.beginnerMissions!;
const stepIds = () => steps().map((d) => d.id);
/** Marks the steps before `id` claimed (the earlier steps are covered by the first-week tests). */
const claimedBefore = (w: ReturnType<typeof world>, id: string) =>
  w.svc.tx('p', null, (s) => { s.onboarding!.claimed = stepIds().slice(0, stepIds().indexOf(id)); });

const sumRewards = (rs: Reward[]) => {
  const items: Record<string, number> = {};
  let coins = 0;
  for (const r of rs) { coins += r.freeCoins ?? 0; for (const it of r.items ?? []) items[it.itemId] = (items[it.itemId] ?? 0) + it.qty; }
  return { coins, items };
};

describe('はじめの10歩 — a solo player can finish (REQ-UXS-041)', () => {
  it('every social step carries a solo alternative; the config check refuses one without', () => {
    for (const d of steps()) if (SOCIAL_BEGINNER_KINDS.includes(d.kind)) {
      expect(d.alt, d.id).toBeDefined();
      expect(SOCIAL_BEGINNER_KINDS).not.toContain(d.alt!.kind);
    }
    const known = new Set(['gacha_ticket', 'gacha_ticket_10', 'breeding_material']);
    const bad = { ...m.progression, beginnerMissions: [{ id: 'x_friend', kind: 'friends' as const, target: 1, reward: { freeCoins: 1 } }] };
    expect(onboardingProblems(bad, m, known).join('\n')).toMatch(/social step \(friends\) needs a solo alt/);
    const social = { ...m.progression, beginnerMissions: [{ id: 'x_friend', kind: 'friends' as const, target: 1, alt: { kind: 'team' as const, target: 1 }, reward: { freeCoins: 1 } }] };
    expect(onboardingProblems(social, m, known).join('\n')).toMatch(/needs a solo alt/);
    expect(onboardingProblems(m.progression, m, new Set([...known, 'ticket_sr_plus', 'costume_login', 'training_apple']))).toEqual([]);
  });

  it('the rewards of the ten steps are the same as before (re-shuffled in time, nothing added)', () => {
    expect(sumRewards(steps().map((d) => d.reward))).toEqual({ coins: 550, items: { gacha_ticket: 1, breeding_material: 2, gacha_ticket_10: 1 } });
  });

  it('the friend step is reached by a treat for the partner (no friend), the 支部 step by an extra breeding with material (no team)', async () => {
    const w = world();
    await w.player('p', 15);
    await claimedBefore(w, 'bm_friend');
    let v = await goals(w);
    expect(v.path!.current.id).toBe('bm_friend');
    expect(v.path!.current.claimable).toBe(false);
    expect(v.path!.current.alt).toMatchObject({ kind: 'treat', target: 1, progress: 0, screen: 'training', open: true });
    // two sessions make the partner tired enough; the day-1 mission apple is the treat
    await w.train('p', 'hill'); await w.train('p', 'wood');
    await w.svc.claimMission('p', 'train1', w.key());
    const s0 = await w.svc.state('p');
    await w.svc.trainingUseItem('p', 'training_apple', s0.flags.partnerHorseId!, w.key());
    v = await goals(w);
    expect(v.path!.current.alt!.progress).toBe(1);
    expect(v.path!.current.claimable).toBe(true);
    await w.svc.claimGoals('p', w.key());
    v = await goals(w);
    expect(v.path!.current.id).toBe('bm_team');
    expect(v.path!.current.alt).toMatchObject({ kind: 'breed_extra', screen: 'breeding' });
    // a retired pair, today's breeding, then one more with material
    const pair = await w.svc.tx('p', null, (s, now) => {
      const sire = createHorseFromTemplate(s, m.templateById.get('t_akatsuki')!, now);
      const dam = createHorseFromTemplate(s, m.templateById.get('t_tsukikage')!, now);
      retire(s, sire.id); retire(s, dam.id);
      s.items.breeding_material = (s.items.breeding_material ?? 0) + 1;
      return { sire: sire.id, dam: dam.id };
    });
    const first = await w.svc.breed('p', pair.sire, pair.dam, w.key());
    expect(first.usedMaterial).toBe(false);
    // REQ-ITEM-011: the response says what is left today, so the reveal can offer one more with material
    expect(first.today).toMatchObject({ used: 1, perDay: 1, extraUsed: 0, materialOwned: expect.any(Number) });
    expect((await goals(w)).path!.current.claimable).toBe(false);
    const extra = await w.svc.breed('p', pair.sire, pair.dam, w.key(), true);
    expect(extra.usedMaterial).toBe(true);
    expect(extra.today.extraUsed).toBe(1);
    expect((await goals(w)).path!.current.claimable).toBe(true);
    const s = await w.svc.state('p');
    expect(s.friends.ids).toEqual([]);
    expect(s.team?.teamId ?? null).toBeNull();
  });
});

describe('graduation is the week-2 goal (REQ-UXS-042, REQ-GOAL-017/018)', () => {
  it('the last step opens on day 8: reached on day 3 it waits; tomorrow says it on day 7; claimed on day 8', async () => {
    const w = world();
    await w.player('p', 15);
    await claimedBefore(w, 'bm_graduate');
    for (let d = 2; d <= 3; d++) await w.nextDay('p');
    let v = await goals(w);
    expect(v.path!.current).toMatchObject({ id: 'bm_graduate', reached: true, dayOk: false, fromDay: 8, claimable: false });
    expect(v.path!.finalFromDay).toBe(8);
    expect(v.claimable).toBe(v.today.claimable + v.season.missions.filter((x) => x.claimable).length);
    await expect(w.svc.claimMission('p', 'bm_graduate', w.key())).rejects.toMatchObject({ code: 'NOT_ELIGIBLE' });
    for (let d = 4; d <= 7; d++) await w.nextDay('p');
    v = await goals(w);
    expect(v.today.playerDay).toBe(7);
    expect(v.today.tomorrow!.graduate).toEqual({ reward: { items: [{ itemId: 'gacha_ticket_10', qty: 1 }] }, ready: true });
    // the claim-all on day 7 leaves it
    const before = (await w.svc.state('p')).items.gacha_ticket_10 ?? 0;
    await w.svc.claimGoals('p', w.key()).catch(() => undefined);
    expect((await w.svc.state('p')).items.gacha_ticket_10 ?? 0).toBe(before);
    await w.nextDay('p');
    v = await goals(w);
    expect(v.path!.current.claimable).toBe(true);
    expect(v.today.tomorrow!.graduate).toBeNull();
    await w.svc.claimGoals('p', w.key());
    expect((await w.svc.state('p')).items.gacha_ticket_10).toBe(before + 1);
    expect((await goals(w)).path).toBeNull();
  });

  it('not ready (earlier steps open): tomorrow still names the goal, ready false', async () => {
    const w = world();
    await w.player('p', 3);
    for (let d = 2; d <= 7; d++) await w.nextDay('p');
    const g = (await goals(w)).today.tomorrow!.graduate!;
    expect(g.ready).toBe(false);
    expect(g.reward.items![0]!.itemId).toBe('gacha_ticket_10');
  });
});

describe('the week-2 arc (REQ-GOAL-019)', () => {
  it('from day 7 to day 14 only; each day 8..14 has its login bonus; the peak is the guaranteed-SR ticket; graduation on day 8', async () => {
    const w = world();
    await w.player('p', 3);
    for (let d = 2; d <= 6; d++) await w.nextDay('p');
    expect((await goals(w)).week2).toBeNull();
    await w.nextDay('p');
    const v = await goals(w);
    const a = v.week2!;
    expect(a).toMatchObject({ fromDay: WEEK2.fromDay, toDay: WEEK2.toDay, day: 0 });
    expect(a.days.map((x) => x.playerDay)).toEqual([8, 9, 10, 11, 12, 13, 14]);
    expect(a.days.every((x) => x.loginBonus !== null && !x.past && !x.today)).toBe(true);
    const cycle = m.progression.loginBonus;
    // stream D: day 10 is the cycle's day 3 「翼」, which beginner day 3 already gave → the 2 breeding material it gives instead
    a.days.forEach((x, i) => {
      const { day: _d, ...r } = cycle[i]!;
      if (i === 2) expect(x.loginBonus).toEqual({ track: 'normal', day: 3, days: cycle.length, reward: { items: [{ itemId: 'breeding_material', qty: 2 }] }, swappedFrom: 'costume_login' });
      else expect(x.loginBonus).toEqual({ track: 'normal', day: i + 1, days: cycle.length, reward: r });
    });
    expect(a.peak).toEqual({ playerDay: 14, reward: { items: [{ itemId: 'ticket_sr_plus', qty: 1 }] } });
    expect(a.days[0]!.graduate).toMatchObject({ reward: { items: [{ itemId: 'gacha_ticket_10', qty: 1 }] } });
    expect(a.graduate).toMatchObject({ playerDay: 8 });
    // inside the week: today and the past are marked; the peak only looks ahead
    for (let d = 8; d <= 10; d++) await w.nextDay('p');
    const b = (await goals(w)).week2!;
    expect(b.day).toBe(3);
    expect(b.days.filter((x) => x.past).map((x) => x.playerDay)).toEqual([8, 9]);
    expect(b.days.find((x) => x.today)!.playerDay).toBe(10);
    // today's, received — what the claim really gave (stream D: the owned 「翼」 came as 2 breeding material)
    expect(b.days.find((x) => x.today)!.loginBonus).toEqual({ track: 'normal', day: 3, days: 7, reward: { items: [{ itemId: 'breeding_material', qty: 2 }] }, swappedFrom: 'costume_login' });
    expect(b.peak!.playerDay).toBe(14);
    for (let d = 11; d <= 15; d++) await w.nextDay('p');
    expect((await goals(w)).week2).toBeNull();
  });

  it('the projection is what the claims really give, day by day (the same tables, never a new reward)', async () => {
    const w = world();
    await w.player('p', 0);
    const s = await w.svc.state('p');
    const plan = loginBonusPlan(m, s, w.now(), 16);
    expect(plan[0]!.playerDay).toBe(2); // today's is received
    for (const p of plan) {
      w.advance(DAY);
      const r = await w.svc.claimLogin('p', w.key());
      const { day: _d, ...reward } = r.reward as Reward & { day: number };
      expect({ playerDay: p.playerDay, track: r.track, day: r.day, reward }).toEqual({ playerDay: p.playerDay, track: p.track, day: p.day, reward: p.reward });
    }
  });

  it('reads only: the ladder with the arc writes nothing', async () => {
    const w = world();
    await w.player('p', 3);
    for (let d = 2; d <= 8; d++) await w.nextDay('p');
    const s = await w.svc.state('p');
    const before = JSON.stringify(s);
    goalLadderView(m, s, w.now());
    expect(JSON.stringify(s)).toBe(before);
  });
});

describe('a treat when it matters (REQ-ITEM-010, REQ-GOAL-020)', () => {
  it('no hint while fresh or without a treat; tired enough + a treat → before/after from the training numbers; using it clears the hint', async () => {
    const w = world();
    await w.player('p', 3);
    const pid = (await w.svc.state('p')).flags.partnerHorseId!;
    const hint = async () => ((await w.svc.training('p')) as { horses: { horseId: string; treat: unknown }[] }).horses.find((h) => h.horseId === pid)!.treat as Record<string, unknown> | null;
    expect(await hint()).toBeNull();
    await w.train('p', 'hill'); await w.train('p', 'wood');
    expect(await hint()).toBeNull(); // tired, but no treat yet
    await w.svc.claimMission('p', 'train1', w.key());
    const t = (await hint())!;
    const tc = m.progression.training!;
    const f = tc.menus.find((x) => x.id === 'hill')!.fatigue + tc.menus.find((x) => x.id === 'wood')!.fatigue;
    expect(f).toBeGreaterThanOrEqual(TREAT_MIN_FATIGUE);
    expect(t).toEqual({
      itemId: 'training_apple', name: 'りんごのおやつ', owned: 1, fatigue: f, fatigueAfter: f - 30,
      efficiencyPermille: 1000 - f * 5, efficiencyAfterPermille: 1000 - (f - 30) * 5, tired: false, unblocks: false,
    });
    // the ladder's partner says it only while the partner can still train today (the per-horse limit of 2 is used → no)
    expect((await goals(w)).partner!.sessionsLeft).toBe(0);
    expect((await goals(w)).partner!.treat).toBeNull();
    await w.svc.trainingUseItem('p', 'training_apple', pid, w.key());
    expect(await hint()).toBeNull();
    // the next day: one session (fatigue 25−40→0, +30) leaves one more; a treat (from the mission) is suggested on home too
    w.advance(DAY);
    await w.train('p', 'hill');
    await w.svc.claimMission('p', 'train1', w.key());
    const p = (await goals(w)).partner!;
    expect(p.sessionsLeft).toBe(1);
    expect(p.treat).toMatchObject({ fatigue: 30, fatigueAfter: 0, efficiencyPermille: 850, efficiencyAfterPermille: 1000 });
  });
});

describe('growth stages re-based (display only)', () => {
  it('prime starts at 25% of the potential: an SR partner (240) at 60', async () => {
    const w = world();
    await w.player('p', 3);
    await w.svc.tx('p', null, (s) => { const h = s.horses.find((x) => x.id === s.flags.partnerHorseId)!; h.trained = { speed: 30, stamina: 30, burst: 0, guts: 0, temper: 0 } as never; });
    const p = (await goals(w)).partner!;
    expect(p.potential).toBe(240);
    expect(p.stage).toBe(2);
    expect(p.stageFrom).toBe(60);
    expect(p.nextStageAt).toBe(156);
  });
});
