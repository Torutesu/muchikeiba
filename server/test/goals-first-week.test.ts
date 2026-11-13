// Quality pass 2 — the first week on the goal ladder (docs/quality/first-week.md, REQ-GOAL-013..015):
// tomorrow as facts, the partner's growth, the next first step one tap away. Reads only, nothing granted.
import { describe, expect, it } from 'vitest';
import { m } from './helpers.js';
import { MemoryPlayerRepo, PlayerService } from '../src/domain/service.js';
import { seededRng } from '../src/domain/rng.js';
import { goalLadderView, PATH_SCREENS, type GoalLadderView } from '../src/domain/goals.js';
import { growthStage } from '../src/domain/horseProfile.js';

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 11, 8, 3); // 2026-12-08 12:00 JST (after the 2026-12-01 rollover change)

function world() {
  let now = T0;
  const svc = new PlayerService(new MemoryPlayerRepo(), { master: m, rng: seededRng(11), clock: () => now, verifiers: {} });
  let n = 0, k = 0;
  const key = () => `c:fw${k++}`;
  const race = (id: string, place: number) => svc.applyRace(id, { raceId: `r_${id}_${n++}`, mode: 'ranked', place, fieldSize: 12, newRating: null, void: false, humans: 2 });
  const player = async (id: string, places: number[] = [], login = true) => {
    await svc.bootstrap(id);
    await svc.grantPartner(id, 'アイボウ', `c:partner-${id}`);
    if (login) await svc.claimLogin(id, key());
    for (const p of places) await race(id, p);
  };
  const train = async (id: string, menu = 'hill') => {
    const s = await svc.state(id);
    const st = await svc.trainingStart(id, s.flags.partnerHorseId!, menu, key());
    return svc.trainingFinish(id, st.session.sessionId, { taps: [], skipped: true }, key());
  };
  return { svc, race, player, train, key, now: () => now, advance: (ms: number) => { now += ms; } };
}
const goals = async (w: ReturnType<typeof world>, id = 'p') => (await w.svc.goals(id)) as GoalLadderView;

describe('first week — tomorrow on the ladder (REQ-GOAL-013)', () => {
  it('day 1 after the login bonus: tomorrow\'s bonus (the beginner day 2), the features day 2 opens, the training slots', async () => {
    const w = world();
    await w.player('p', [2, 3, 4]); // 3 races: missions and training open (progression.unlocks)
    const v = await goals(w);
    expect(v.today.playerDay).toBe(1);
    const t = v.today.tomorrow!;
    expect(t.playerDay).toBe(2);
    expect(t.at).toBe(v.today.resetAt); // a real time (the next game day's start), never a countdown
    const { day: _d, ...day2 } = m.progression.beginnerLoginBonus![1]!;
    expect(t.loginBonus).toEqual({ track: 'beginner', day: 2, days: 7, reward: day2 });
    const byDay2 = (m.progression.unlocks ?? []).filter((u) => u.days === 2).map((u) => u.key);
    expect(byDay2.length).toBeGreaterThan(0);
    expect(t.opens).toEqual(byDay2);
    expect(t.trainingSlots).toBe(m.progression.training!.slotsPerDay);
  });

  it('before today\'s login bonus is received there is no tomorrow bonus (today\'s is the news); training not open → no slots', async () => {
    const w = world();
    await w.player('p', [], false);
    const t = (await goals(w)).today.tomorrow!;
    expect(t.loginBonus).toBeNull();
    expect(t.trainingSlots).toBeNull(); // training opens by races, not by tomorrow's day count
  });

  it('a feature already opened by races is not announced for tomorrow', async () => {
    const w = world();
    const breedingRaces = m.progression.unlocks!.find((u) => u.key === 'breeding')!.races!;
    await w.player('p', Array.from({ length: breedingRaces }, () => 5));
    const v = await goals(w);
    expect(v.today.tomorrow!.opens).not.toContain('breeding');
    w.advance(DAY);
    expect((await goals(w)).today.tomorrow!.opens.every((k) => !['breeding'].includes(k))).toBe(true);
  });

  it('the day count moves with the game day; the beginner bonus track ends into the 7-day cycle', async () => {
    const w = world();
    await w.player('p', [1, 1]);
    for (let d = 2; d <= 7; d++) { w.advance(DAY); await w.svc.claimLogin('p', w.key()); }
    const v = await goals(w);
    expect(v.today.playerDay).toBe(7);
    expect(v.today.tomorrow!.loginBonus).toMatchObject({ track: 'normal', day: 1 });
    expect(v.today.tomorrow!.opens).toEqual((m.progression.unlocks ?? []).filter((u) => u.days === 8).map((u) => u.key));
  });
});

describe('first week — the partner grows on the ladder (REQ-GOAL-014)', () => {
  it('stage, trained total, gained today and the game day before, sessions left — the 馬カード stage function', async () => {
    const w = world();
    await w.player('p', [2, 3, 4]);
    let v = await goals(w);
    const c = m.progression.training!;
    expect(v.partner).toMatchObject({ stage: 0, stageKey: 'debut', stages: 5, trainedTotal: 0, gainedToday: 0, gainedYesterday: 0, trainingOpen: true, sessionsLeft: Math.min(c.slotsPerDay, c.perHorsePerDay), full: false });
    await w.train('p', 'hill');
    await w.train('p', 'wood');
    v = await goals(w);
    const p = v.partner!;
    expect(p.trainedTotal).toBeGreaterThan(0);
    expect(p.gainedToday).toBe(p.trainedTotal);
    expect(p.sessionsLeft).toBe(Math.max(0, Math.min(c.slotsPerDay - 2, c.perHorsePerDay - 2)));
    const st = growthStage(p.trainedTotal, p.potential);
    expect([p.stage, p.nextStageAt]).toEqual([st.index, st.nextAt]);
    const prof = await w.svc.horseProfile('p', p.horseId);
    expect(prof.growth).toMatchObject({ trainedTotal: p.trainedTotal, stage: p.stage, nextStageAt: p.nextStageAt });
    expect(p.stageFrom).toBeLessThanOrEqual(p.trainedTotal);
    w.advance(DAY);
    v = await goals(w);
    expect(v.partner).toMatchObject({ gainedToday: 0, gainedYesterday: p.trainedTotal, sessionsLeft: Math.min(c.slotsPerDay, c.perHorsePerDay) });
    w.advance(2 * DAY);
    expect((await goals(w)).partner!.gainedYesterday).toBe(0); // only the game day before
  });

  it('training not open yet: the growth reads, no sessions; no partner → null', async () => {
    const w = world();
    await w.player('p', []);
    const v = await goals(w);
    expect(v.partner).toMatchObject({ trainingOpen: false, sessionsLeft: 0, stage: 0 });
    const st = await w.svc.state('p');
    expect(goalLadderView(m, { ...st, flags: { ...st.flags, partnerHorseId: undefined } }, w.now()).partner).toBeNull();
  });
});

describe('first week — the next first step is one tap away (REQ-GOAL-015)', () => {
  it('every beginner step kind has a screen fixed in code, never the shop or a purchase', () => {
    for (const d of m.progression.beginnerMissions ?? []) {
      const s = PATH_SCREENS[d.kind];
      expect(s, d.kind).toBeTruthy();
      expect(['shop', 'store', 'purchase', 'season_pass', 'gacha_paid']).not.toContain(s!.screen);
    }
  });

  it('the current step carries its screen and whether it is open yet (breeding opens on day 2)', async () => {
    const w = world();
    await w.player('p', [2]);
    let v = await goals(w);
    expect(v.path!.current).toMatchObject({ kind: 'gacha', screen: 'scout', open: true });
    const st = await w.svc.state('p');
    const defs = m.progression.beginnerMissions!;
    const iBreed = defs.findIndex((d) => d.kind === 'breed');
    const at = (s: typeof st) => goalLadderView(m, { ...s, onboarding: { ...s.onboarding!, claimed: defs.slice(0, iBreed).map((d) => d.id) } }, w.now());
    expect(at(st).path!.current).toMatchObject({ kind: 'breed', screen: 'breeding', open: false });
    w.advance(DAY);
    expect(at(await w.svc.state('p')).path!.current).toMatchObject({ kind: 'breed', open: true });
    v = await goals(w);
    expect(v.path!.current.screen).toBe('scout');
  });

  it('reads only: tomorrow / partner / path never write', async () => {
    const w = world();
    await w.player('p', [1, 2, 3]);
    await w.train('p');
    const before = JSON.stringify(await w.svc.state('p'));
    await goals(w);
    expect(JSON.stringify(await w.svc.state('p'))).toBe(before);
  });
});
