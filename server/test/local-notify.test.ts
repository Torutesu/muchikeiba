import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { m } from './helpers.js';
import { MemoryPlayerRepo, PlayerService } from '../src/domain/service.js';
import { seededRng } from '../src/domain/rng.js';
import { clientBatchSchema, clientToKpi } from '../src/domain/kpi.js';
import type { Master } from '../src/domain/master.js';
import { PUSH_CATEGORIES } from '../src/domain/master.js';
import { deliverGift } from '../src/domain/giftBox.js';
import { uxProblems } from '../src/domain/onboarding.js';
import { bettingWordsIn } from '../src/domain/bettingWords.js';
import { enqueuePush, registerDevice } from '../src/domain/push.js';
import { handle, type AppContext, type PlayerInvoker } from '../src/http/app.js';
import { AppError } from '../src/domain/errors.js';
import {
  LNOTIF_CATEGORY, LNOTIF_KINDS, LNOTIF_OWNERSHIP, LNOTIF_SCREEN, LNOTIF_TEXTS, diffLocalNotifications, lnotifFingerprint, localNotificationsProblems,
  localNotifyRows, localRemindersView, planLocalNotifications, type LocalNotifyConfig, type LocalNotifySnapshot, type LocalRemindersDigest,
} from '../src/domain/localNotify.js';

const H = 3_600_000;
const DAY = 24 * H;
const MIN = 60_000;
const T0 = Date.UTC(2026, 11, 8, 3); // 2026-12-08 (Tue) 12:00 JST, after the 04:00 rollover took effect
const NEXT_DAY = Date.UTC(2026, 11, 8, 19); // 2026-12-09 04:00 JST
const WEEK_END = Date.UTC(2026, 11, 13, 19); // 2026-12-14 (Mon) 04:00 JST
const VECTORS_PATH = join(__dirname, '..', '..', 'contracts', 'local-notifications.vectors.json');
const cfg = m.progression.localNotifications as LocalNotifyConfig;
const withCfg = (patch: Partial<LocalNotifyConfig> | undefined): Master => ({ ...m, progression: { ...m.progression, localNotifications: patch === undefined ? undefined : { ...cfg, ...patch } } as Master['progression'] });

/** A digest with every source present (the vectors and the unit tests vary it). */
function digest(o: Partial<LocalRemindersDigest> = {}): LocalRemindersDigest {
  const { _note: _n, enabled: _e, ...config } = cfg;
  return {
    v: 1, enabled: true, now: T0, nextDayAt: NEXT_DAY, nextDay: '2026-12-09', config: structuredClone(config),
    categories: { season: true, friends: true, invites: true, events: true, comeback: false, gifts: true, reminders: true },
    quietHours: { startHour: 22, endHour: 8 }, deleting: false, onboarding: false,
    loginBonus: { unlocked: true },
    training: { sessionId: 'ts1', horseId: 'h1', expiresAt: T0 + 8 * MIN, trainedEver: true },
    weeklyChallenge: { unlocked: true, endsAt: WEEK_END, uncleared: 2 },
    rival: { weekEndsAt: WEEK_END, rankedRaces: 0 },
    exchanges: [{ eventId: 'ev_autumn', points: 120, closesAt: Date.UTC(2026, 11, 10, 19) }],
    gifts: [Date.UTC(2026, 11, 11, 15), Date.UTC(2026, 11, 11, 20), Date.UTC(2026, 11, 20, 15)],
    ...o,
  };
}
const snap = (o: Partial<LocalNotifySnapshot> = {}, d: Partial<LocalRemindersDigest> = {}): LocalNotifySnapshot => ({
  now: T0, locale: 'ja', permission: 'granted', showDetails: false, signedIn: true, digest: digest(d), horseNames: { h1: 'アカツキ' }, ...o,
});
const kinds = (x: LocalNotifySnapshot) => planLocalNotifications(x).items.map((i) => i.kind);
const reasonOf = (x: LocalNotifySnapshot, kind: string) => planLocalNotifications(x).dropped.find((d) => d.kind === kind)?.reason;

describe('§61 config (REQ-LNOTIF-019)', () => {
  it('the master config is valid and part of the boot / remote-config checks', () => {
    expect(localNotificationsProblems(m)).toEqual([]);
    expect(uxProblems(m, new Set(Object.keys(m.items?.tickets ?? {}))).filter((p) => p.includes('localNotifications'))).toEqual([]);
    expect(localNotificationsProblems(withCfg(undefined))).toEqual([]);
  });
  it('rejects unknown kinds, duplicates, out-of-range numbers, a lead longer than the training session and unknown keys', () => {
    const p = (patch: Record<string, unknown>) => localNotificationsProblems(withCfg(patch as Partial<LocalNotifyConfig>)).join('\n');
    expect(p({ kinds: ['shop_offer'] })).toMatch(/kinds/);
    expect(p({ kinds: ['daily_bonus', 'daily_bonus'] })).toMatch(/duplicate/);
    expect(p({ dailyCap: 9 })).toMatch(/dailyCap/);
    expect(p({ dailyHourJst: 3 })).toMatch(/dailyHourJst/); // never a night-time reminder
    expect(p({ maxPending: 64 })).toMatch(/maxPending/);
    expect(p({ trainingLeadMin: 9 })).toBe(''); // 9 min < the 10 min session
    expect(localNotificationsProblems({ progression: { ...withCfg({ trainingLeadMin: 9 }).progression, training: { ...m.progression.training!, sessionTtlMs: 300_000 } } } as Master).join()).toMatch(/sessionTtlMs/);
    expect(p({ leadHours: { ...cfg.leadHours, daily_bonus: 3 } })).toMatch(/leadHours/); // only the deadline kinds have a lead
    expect(p({ leadHours: { ...cfg.leadHours, gift_expiring: 0 } })).toMatch(/gift_expiring/);
    expect(p({ shopNudge: true })).toMatch(/shopNudge|Unrecognized/);
  });
});

describe('§61.1 kinds, categories and owners (REQ-LNOTIF-001/002/009)', () => {
  it('every push.json template has an owner on the server side, and no server event is also a local one', () => {
    const server = LNOTIF_OWNERSHIP.server;
    for (const id of Object.keys(m.push.templates)) expect(server[id], `push template ${id} needs an owner in LNOTIF_OWNERSHIP`).toBeTruthy();
    const local = new Set(Object.values(LNOTIF_OWNERSHIP.local));
    for (const ev of Object.values(server)) expect(local.has(ev)).toBe(false);
    expect(Object.keys(LNOTIF_OWNERSHIP.local).sort()).toEqual([...LNOTIF_KINDS].sort());
  });
  it('reminders is a new opt-in category the server never pushes', () => {
    expect(PUSH_CATEGORIES).toContain('reminders');
    expect(m.push.defaults.categories.reminders).toBe(false);
    expect(Object.values(m.push.templates).some((t) => t.category === 'reminders')).toBe(false);
    for (const k of LNOTIF_KINDS) expect(PUSH_CATEGORIES).toContain(LNOTIF_CATEGORY[k]);
    expect(LNOTIF_CATEGORY.training_session).toBe('reminders');
    expect(LNOTIF_CATEGORY.daily_bonus).toBe('reminders');
  });
  it('no kind opens the shop, a pass purchase or a scout', () => {
    for (const k of LNOTIF_KINDS) expect(['shop', 'season_pass', 'scout', 'gacha', 'purchase']).not.toContain(LNOTIF_SCREEN[k]);
    expect(LNOTIF_SCREEN.gift_expiring).toBe('gift_box');
  });
  it('a stored push state without the new category reads it as off (and enqueue never sends it)', () => {
    const s = { push: { devices: [], outbox: [], sent: { date: '', count: 0 }, seq: 0, prefs: { categories: { season: true, friends: true, invites: true, events: true, comeback: false, gifts: true }, quietHours: null } } };
    const st = s as unknown as Parameters<typeof enqueuePush>[1];
    registerDevice(m, st, 'tok-aaaaaaaa', 'ios', T0);
    expect((st as unknown as typeof s).push.prefs.categories).toMatchObject({ reminders: false });
  });
});

describe('§61.2 the plan (REQ-LNOTIF-003..007)', () => {
  it('is pure: the same snapshot gives the same plan, ordered by time', () => {
    const a = planLocalNotifications(snap()), b = planLocalNotifications(structuredClone(snap()));
    expect(a).toEqual(b);
    expect(a.status).toBe('ok');
    const times = a.items.map((i) => i.fireAt);
    expect(times).toEqual([...times].sort((x, y) => x - y));
    expect(a.items[0]).toMatchObject({ kind: 'training_session', id: 'lnotif.training_session.ts1', fireAt: T0 + 5 * MIN, screen: 'training', category: 'reminders' });
  });
  it('signed out, disabled, deleting or onboarding: nothing; no permission: the plan without scheduling', () => {
    expect(planLocalNotifications(snap({ signedIn: false }))).toEqual({ status: 'signed_out', items: [], dropped: [] });
    expect(planLocalNotifications(snap({ digest: { v: 1, enabled: false } })).status).toBe('off');
    expect(planLocalNotifications(snap({ digest: null })).status).toBe('off');
    expect(planLocalNotifications(snap({}, { deleting: true })).items).toEqual([]);
    expect(planLocalNotifications(snap({}, { onboarding: true })).items).toEqual([]);
    for (const p of ['unknown', 'denied'] as const) {
      const r = planLocalNotifications(snap({ permission: p }));
      expect(r.status).toBe('no_permission');
      expect(r.items.length).toBeGreaterThan(0); // the settings screen still shows what would come
    }
    expect(planLocalNotifications(snap({ permission: 'provisional' })).status).toBe('ok');
  });
  it('a category switched off in the push settings switches the local kind off too', () => {
    expect(reasonOf(snap({}, { categories: { ...digest().categories, reminders: false } }), 'training_session')).toBe('category_off');
    expect(reasonOf(snap({}, { categories: { ...digest().categories, reminders: false } }), 'daily_bonus')).toBe('category_off');
    expect(reasonOf(snap({}, { categories: { ...digest().categories, gifts: false } }), 'gift_expiring')).toBe('category_off');
    expect(reasonOf(snap({}, { categories: { ...digest().categories, friends: false } }), 'rival_week_closing')).toBe('category_off');
    const off = { ...digest().config, kinds: digest().config.kinds.filter((k) => k !== 'exchange_closing') };
    expect(reasonOf(snap({}, { config: off }), 'exchange_closing')).toBe('kind_off');
  });
  it('quiet hours: a training session is not sent, others move to the end, never closer than an hour to the deadline', () => {
    // a session opened at 21:55 JST: its reminder would be at 22:02 → dropped
    const late = Date.UTC(2026, 11, 8, 12, 55);
    expect(reasonOf(snap({ now: late }, { training: { sessionId: 'x', horseId: 'h1', expiresAt: late + 10 * MIN, trainedEver: true } }), 'training_session')).toBe('quiet_hours');
    // the weekly challenge ends Mon 04:00 → 24 h before is Sun 04:00 (quiet) → moved to Sun 08:00
    const wc = planLocalNotifications(snap({}, { config: { ...digest().config, dailyCap: 4 } })).items.find((i) => i.kind === 'weekly_challenge_closing')!;
    expect(wc.fireAt).toBe(Date.UTC(2026, 11, 12, 23)); // 2026-12-13 08:00 JST
    // a 2 h lead into a 04:00 deadline: 02:00 is quiet and 08:00 is past the deadline → dropped
    const short = { ...digest().config, leadHours: { ...digest().config.leadHours, weekly_challenge_closing: 2 } };
    expect(reasonOf(snap({}, { config: short }), 'weekly_challenge_closing')).toBe('quiet_hours');
    // no quiet hours: the plain time
    const plain = planLocalNotifications(snap({}, { quietHours: null, config: { ...digest().config, dailyCap: 4 } })).items.find((i) => i.kind === 'weekly_challenge_closing')!;
    expect(plain.fireAt).toBe(WEEK_END - DAY);
  });
  it('the daily bonus: once, at dailyHourJst of the next game day, only when unlocked', () => {
    const d = planLocalNotifications(snap()).items.find((i) => i.kind === 'daily_bonus')!;
    expect(d.fireAt).toBe(NEXT_DAY + 8 * H); // 12:00 JST
    expect(d.id).toBe('lnotif.daily_bonus.2026-12-09');
    expect(planLocalNotifications(snap()).items.filter((i) => i.kind === 'daily_bonus')).toHaveLength(1);
    expect(kinds(snap({}, { loginBonus: { unlocked: false } }))).not.toContain('daily_bonus');
  });
  it('conditions from the data: uncleared challenges, no ranked race yet, points left, unclaimed gifts', () => {
    expect(kinds(snap({}, { weeklyChallenge: { unlocked: true, endsAt: WEEK_END, uncleared: 0 } }))).not.toContain('weekly_challenge_closing');
    expect(kinds(snap({}, { weeklyChallenge: { unlocked: false, endsAt: WEEK_END, uncleared: 3 } }))).not.toContain('weekly_challenge_closing');
    expect(planLocalNotifications(snap({}, { rival: { weekEndsAt: WEEK_END, rankedRaces: 1 } })).dropped.concat(planLocalNotifications(snap({}, { rival: { weekEndsAt: WEEK_END, rankedRaces: 1 } })).items as never[]).some((x: { kind: string }) => x.kind === 'rival_week_closing')).toBe(false);
    expect(kinds(snap({}, { exchanges: [{ eventId: 'ev', points: 0, closesAt: Date.UTC(2026, 11, 10, 19) }] }))).not.toContain('exchange_closing');
    expect(kinds(snap({}, { gifts: [] }))).not.toContain('gift_expiring');
    expect(kinds(snap({}, { training: { sessionId: null, horseId: null, expiresAt: null, trainedEver: true } }))).not.toContain('training_session');
  });
  it('past and beyond the horizon are dropped (opening the app after the lead time does not schedule)', () => {
    const now = Date.UTC(2026, 11, 10, 3); // exchange closes 12-11 04:00, reminder 12-10 04:00 → past
    expect(reasonOf(snap({ now }, { training: { sessionId: null, horseId: null, expiresAt: null, trainedEver: true } }), 'exchange_closing')).toBe('past');
    expect(reasonOf(snap({}, { gifts: [T0 + 20 * DAY] }), 'gift_expiring')).toBe('horizon');
  });
  it('the daily cap per game day keeps the higher priority, maxPending keeps the earliest', () => {
    // Sunday 12-13: weekly challenge, rival (both moved to 08:00) and the daily bonus (12:00) → cap 2 drops the daily bonus
    const all = planLocalNotifications(snap({}, { gifts: [], exchanges: [], training: { sessionId: null, horseId: null, expiresAt: null, trainedEver: true }, nextDayAt: Date.UTC(2026, 11, 12, 19), nextDay: '2026-12-13' }));
    expect(all.items.map((i) => i.kind).sort()).toEqual(['rival_week_closing', 'weekly_challenge_closing']);
    expect(all.dropped).toEqual([{ id: 'lnotif.daily_bonus.2026-12-13', kind: 'daily_bonus', reason: 'daily_cap' }]);
    const one = planLocalNotifications(snap({}, { config: { ...digest().config, dailyCap: 1 }, gifts: [], exchanges: [], training: { sessionId: null, horseId: null, expiresAt: null, trainedEver: true } }));
    expect(one.items.map((i) => i.kind)).toContain('weekly_challenge_closing');
    expect(one.dropped.find((x) => x.kind === 'rival_week_closing')?.reason).toBe('daily_cap');
    // today: training (12:05) and the daily cap of 2 → the gift reminder on 12-11 is another day; everything on its day
    const days = new Map<number, number>();
    for (const i of planLocalNotifications(snap()).items) { const k = Math.floor((i.fireAt - NEXT_DAY) / DAY); days.set(k, (days.get(k) ?? 0) + 1); }
    for (const n of days.values()) expect(n).toBeLessThanOrEqual(cfg.dailyCap);
    const capped = planLocalNotifications(snap({}, { config: { ...digest().config, maxPending: 2 } }));
    expect(capped.items).toHaveLength(2);
    expect(capped.dropped.filter((x) => x.reason === 'max_pending').length).toBeGreaterThan(0);
  });
  it('one exchange reminder per event, one gift reminder for the earliest expiry', () => {
    const ex = [{ eventId: 'ev_b', points: 5, closesAt: Date.UTC(2026, 11, 12, 19) }, { eventId: 'ev_a', points: 1, closesAt: Date.UTC(2026, 11, 10, 19) }];
    const p = planLocalNotifications(snap({}, { exchanges: ex, config: { ...digest().config, dailyCap: 4 } }));
    expect(p.items.filter((i) => i.kind === 'exchange_closing').map((i) => i.refId)).toEqual(['ev_a', 'ev_b']);
    expect(p.items.filter((i) => i.kind === 'gift_expiring')).toHaveLength(1);
  });
});

describe('§61.2 texts: languages, privacy, legal (REQ-LNOTIF-007/017/018)', () => {
  it('Japanese and English by the device language, dates in JST', () => {
    const ja = planLocalNotifications(snap({}, { config: { ...digest().config, dailyCap: 4 } })).items;
    const en = planLocalNotifications(snap({ locale: 'en' }, { config: { ...digest().config, dailyCap: 4 } })).items;
    expect(ja.find((i) => i.kind === 'exchange_closing')!.body).toBe('交換所は12月11日 4:00に閉まります。残ったポイントは素材になります');
    expect(en.find((i) => i.kind === 'exchange_closing')!.body).toBe('The exchange closes on 12/11 at 4:00. Leftover points become materials');
    expect(ja.find((i) => i.kind === 'training_session')!.body).toBe('始めた調教が仕上げを待っています（12:08まで）');
    for (const i of en) expect(/[぀-ヿ一-鿿]/.test(i.title + i.body), i.body).toBe(false);
  });
  it('player-typed names only with showDetails (default off); counts too', () => {
    const off = planLocalNotifications(snap()).items;
    expect(off.some((i) => i.body.includes('アカツキ'))).toBe(false);
    const on = planLocalNotifications(snap({ showDetails: true }, { config: { ...digest().config, dailyCap: 4 } })).items;
    expect(on.find((i) => i.kind === 'training_session')!.body).toBe('アカツキの調教が仕上げを待っています（12:08まで）');
    expect(on.find((i) => i.kind === 'exchange_closing')!.body).toContain('120ポイント');
    expect(on.find((i) => i.kind === 'gift_expiring')!.body).toBe('受け取り期限が近い品が2件あります（最初は12月12日 0:00）');
    // a horse the device does not know: the plain text, never an empty name
    const unknown = planLocalNotifications(snap({ showDetails: true, horseNames: {} })).items.find((i) => i.kind === 'training_session')!;
    expect(unknown.body).toBe('始めた調教が仕上げを待っています（12:08まで）');
    const en1 = planLocalNotifications(snap({ showDetails: true, locale: 'en' }, { gifts: [Date.UTC(2026, 11, 11, 15)], weeklyChallenge: { unlocked: true, endsAt: WEEK_END, uncleared: 1 }, config: { ...digest().config, dailyCap: 4 } })).items;
    expect(en1.find((i) => i.kind === 'gift_expiring')!.body).toBe('1 gift box item can be collected until 12/12 at 0:00');
    expect(en1.find((i) => i.kind === 'weekly_challenge_closing')!.body).toBe('1 challenge left to clear. It changes on 12/14 at 4:00');
  });
  it('no betting words, no urgency words, no prices in any text', () => {
    const banned = ['倍', '今だけ', '残りわずか', 'お得', '通常価格', '急いで', '¥', '円', 'セール', 'only now', 'hurry', 'last chance', 'sale', 'discount'];
    for (const k of LNOTIF_KINDS) for (const lang of ['ja', 'en'] as const) {
      const t = LNOTIF_TEXTS[k][lang];
      for (const s of [t.title, t.body, t.detail, t.detailOne ?? '']) {
        expect(bettingWordsIn(s), s).toEqual([]);
        for (const w of banned) expect(s.toLowerCase().includes(w.toLowerCase()), `${s} has ${w}`).toBe(false);
      }
    }
  });
});

describe('§61.5 re-scheduling (REQ-LNOTIF-011/012)', () => {
  it('only the difference: unchanged stays, a changed time is cancel + schedule, gone is cancelled', () => {
    const a = planLocalNotifications(snap()).items;
    const prev = Object.fromEntries(a.map((i) => [i.id, lnotifFingerprint(i)]));
    expect(diffLocalNotifications(prev, a)).toEqual({ cancel: [], schedule: [], added: [] });
    // the training was finished early: its reminder is cancelled
    const b = planLocalNotifications(snap({}, { training: { sessionId: null, horseId: null, expiresAt: null, trainedEver: true } })).items;
    expect(diffLocalNotifications(prev, b).cancel).toEqual(['lnotif.training_session.ts1']);
    // the gift box changed: the earliest expiry moved → a new id
    const c = planLocalNotifications(snap({}, { gifts: [Date.UTC(2026, 11, 11, 20)] })).items;
    const d = diffLocalNotifications(prev, c);
    expect(d.cancel).toContain('lnotif.gift_expiring.' + Date.UTC(2026, 11, 11, 15));
    expect(d.added).toEqual(['lnotif.gift_expiring.' + Date.UTC(2026, 11, 11, 20)]);
    // the language changed: same ids, new texts → re-scheduled but not "added" (KPI only for new ids)
    const e = diffLocalNotifications(prev, planLocalNotifications(snap({ locale: 'en' })).items);
    expect(e.added).toEqual([]);
    expect(e.schedule.length).toBe(a.length);
  });
  it('the settings rows follow the categories', () => {
    const rows = localNotifyRows(digest({ categories: { ...digest().categories, reminders: false } }));
    expect(rows.map((r) => r.kind)).toEqual([...LNOTIF_KINDS]);
    expect(rows.find((r) => r.kind === 'daily_bonus')).toEqual({ kind: 'daily_bonus', category: 'reminders', on: false });
    expect(rows.find((r) => r.kind === 'gift_expiring')!.on).toBe(true);
    expect(localNotifyRows({ v: 1, enabled: false }).every((r) => !r.on)).toBe(true);
  });
});

describe('§61.3 the digest in bootstrap / GET /v1/player (REQ-LNOTIF-008)', () => {
  function world(master: Master = m) {
    let now = T0;
    const svc = new PlayerService(new MemoryPlayerRepo(), { master, rng: seededRng(5), clock: () => now, verifiers: {} });
    let n = 0;
    const player = async (id: string, races = 3) => {
      await svc.bootstrap(id);
      await svc.grantPartner(id, 'アイボウ', `c:partner-${id}`);
      for (let i = 0; i < races; i++) await svc.applyRace(id, { raceId: `r_${id}_${n++}`, mode: 'ranked', place: 5, fieldSize: 12, newRating: null, void: false, humans: 2 });
    };
    return { svc, player, advance: (ms: number) => { now += ms; } };
  }
  type Boot = { localReminders: LocalRemindersDigest };

  it('a new player: onboarding (nothing planned) and the master defaults (reminders off)', async () => {
    const w = world();
    const b = (await w.svc.bootstrap('p')) as unknown as Boot;
    expect(b.localReminders).toMatchObject({ v: 1, enabled: true, onboarding: true, deleting: false, loginBonus: { unlocked: false } });
    expect(b.localReminders.categories.reminders).toBe(false);
    expect(b.localReminders.quietHours).toEqual(m.push.defaults.quietHours);
    expect(b.localReminders.nextDayAt).toBe(NEXT_DAY);
    expect(b.localReminders.nextDay).toBe('2026-12-09');
    expect(planLocalNotifications({ now: T0, locale: 'ja', permission: 'granted', showDetails: false, signedIn: true, digest: b.localReminders }).items).toEqual([]);
  });

  it('a training session, gifts and the push settings show up; GET /v1/player is read-only and the same', async () => {
    const w = world();
    await w.player('p');
    await w.svc.setPushPreferences('p', { categories: { reminders: true } });
    const st = await w.svc.state('p');
    const horseId = st.horses[0]!.id;
    const r = await w.svc.trainingStart('p', horseId, 'pool', 'c:t1') as { session: { sessionId?: string; id?: string; expiresAt: number } };
    await w.svc.tx('p', null, (s, now) => { deliverGift(m, s, { source: 'ops_grant', ref: 'g1', reward: { freeCoins: 10 }, note: 'grant', expiryDays: 2 }, now); });
    const view = (await w.svc.view('p')) as unknown as Boot;
    const d = view.localReminders;
    expect(d.training).toMatchObject({ horseId, expiresAt: r.session.expiresAt, trainedEver: true });
    expect(d.training.sessionId).toBeTruthy();
    expect(d.gifts).toHaveLength(1);
    expect(d.categories.reminders).toBe(true);
    expect(d.loginBonus.unlocked).toBe(true);
    const plan = planLocalNotifications({ now: T0, locale: 'ja', permission: 'granted', showDetails: false, signedIn: true, digest: d });
    expect(plan.items.map((i) => i.kind)).toEqual(expect.arrayContaining(['training_session', 'daily_bonus']));
    expect(((await w.svc.bootstrap('p')) as unknown as Boot).localReminders).toEqual(d);
  });

  it('reading the digest never creates the push state', async () => {
    const w = world();
    await w.player('q');
    await w.svc.tx('q', null, (s) => { delete (s as { push?: unknown }).push; });
    await w.svc.view('q');
    expect((await w.svc.state('q') as { push?: unknown }).push).toBeUndefined();
  });

  it('a scheduled deletion and a disabled config', async () => {
    const w = world();
    await w.player('p');
    await w.svc.tx('p', null, (s) => { s.deletion = { status: 'scheduled' } as typeof s.deletion; });
    expect(((await w.svc.view('p')) as unknown as Boot).localReminders.deleting).toBe(true);
    const off = world(withCfg({ enabled: false }));
    await off.player('q');
    expect(((await off.svc.view('q')) as unknown as Boot).localReminders).toEqual({ v: 1, enabled: false });
    const none = world(withCfg(undefined));
    await none.player('q');
    expect(localRemindersView(withCfg(undefined), await none.svc.state('q'), T0)).toEqual({ v: 1, enabled: false });
  });
});

describe('§61.6 KPI and the settings route (REQ-LNOTIF-013, REQ-LNOTIF-004)', () => {
  it('client events lnotif_scheduled / lnotif_opened / lnotif_permission', () => {
    const b = clientBatchSchema.parse({ platform: 'ios', appVersion: '1.0.0', events: [
      { name: 'lnotif_scheduled', at: T0, props: { kind: 'training_session' } },
      { name: 'lnotif_opened', at: T0, props: { kind: 'gift_expiring' } },
      { name: 'lnotif_permission', at: T0, props: { result: 'provisional' } },
    ] });
    expect(b.events.map(clientToKpi)).toEqual([
      { name: 'lnotif_scheduled', s1: 'training_session' }, { name: 'lnotif_opened', s1: 'gift_expiring' }, { name: 'lnotif_permission', s1: 'provisional' },
    ]);
    expect(clientBatchSchema.safeParse({ platform: 'ios', appVersion: '1.0.0', events: [{ name: 'lnotif_scheduled', at: T0, props: { kind: 'shop_offer' } }] }).success).toBe(false);
    expect(clientBatchSchema.safeParse({ platform: 'ios', appVersion: '1.0.0', events: [{ name: 'lnotif_permission', at: T0, props: { result: 'maybe' } }] }).success).toBe(false);
  });

  it('PUT /v1/push/preferences switches reminders (and gifts, which was dropped before)', async () => {
    const svc = new PlayerService(new MemoryPlayerRepo(), { master: m, rng: seededRng(3), clock: () => T0, verifiers: {} });
    const invoker: PlayerInvoker = { invoke: (async (method: string, ...args: unknown[]) => (svc as unknown as Record<string, (...a: unknown[]) => unknown>)[method]!.apply(svc, args)) as PlayerInvoker['invoke'] };
    const c = {
      master: m, player: () => invoker, clock: () => T0, adminToken: 'x',
      authenticate: async (req: Request) => { const u = req.headers.get('x-test-user'); if (!u) throw new AppError('UNAUTHORIZED'); return u; },
    } as unknown as AppContext;
    const res = await handle(new Request('https://x/v1/push/preferences', { method: 'PUT', headers: { 'content-type': 'application/json', 'x-test-user': 'u' }, body: JSON.stringify({ categories: { reminders: true, gifts: false } }) }), {}, c);
    const body = (await res.json()) as { categories: Record<string, boolean> };
    expect(res.status).toBe(200);
    expect(body.categories).toMatchObject({ reminders: true, gifts: false });
    const d = ((await svc.view('u')) as unknown as { localReminders: LocalRemindersDigest }).localReminders;
    expect(d.categories).toMatchObject({ reminders: true, gifts: false });
  });
});

describe('§61 shared vectors (TS ↔ C# LocalNotificationPlanner)', () => {
  it('matches contracts/local-notifications.vectors.json', () => {
    const v = vectors();
    if (process.env.UPDATE_VECTORS === '1') writeFileSync(VECTORS_PATH, JSON.stringify(v, null, 2) + '\n');
    const file = JSON.parse(readFileSync(VECTORS_PATH, 'utf8')) as ReturnType<typeof vectors>;
    expect(file).toEqual(v);
  });
});

function vectors() {
  const none = { sessionId: null, horseId: null, expiresAt: null, trainedEver: true };
  const c = digest().config;
  const cases: [string, Partial<LocalNotifySnapshot>, Partial<LocalRemindersDigest>][] = [
    ['everything, ja', {}, {}],
    ['everything, en', { locale: 'en' }, {}],
    ['everything, details ja', { showDetails: true }, {}],
    ['everything, details en', { showDetails: true, locale: 'en' }, {}],
    ['cap 4', {}, { config: { ...c, dailyCap: 4 } }],
    ['cap 1', {}, { config: { ...c, dailyCap: 1 } }],
    ['max pending 2', {}, { config: { ...c, maxPending: 2 } }],
    ['reminders off', {}, { categories: { ...digest().categories, reminders: false } }],
    ['events and gifts off', {}, { categories: { ...digest().categories, events: false, gifts: false } }],
    ['no quiet hours', {}, { quietHours: null, config: { ...c, dailyCap: 4 } }],
    ['quiet 0-6', {}, { quietHours: { startHour: 0, endHour: 6 }, config: { ...c, dailyCap: 4 } }],
    ['quiet 23-11 (daily bonus moved)', {}, { quietHours: { startHour: 23, endHour: 11 }, config: { ...c, dailyHourJst: 9 } }],
    ['short lead into quiet', {}, { config: { ...c, leadHours: { ...c.leadHours, weekly_challenge_closing: 2, rival_week_closing: 3 } } }],
    ['late session (quiet)', { now: Date.UTC(2026, 11, 8, 12, 55) }, { training: { sessionId: 'x', horseId: 'h1', expiresAt: Date.UTC(2026, 11, 8, 13, 5), trainedEver: true } }],
    ['nothing open', {}, { training: none, weeklyChallenge: null, rival: null, exchanges: [], gifts: [] }],
    ['only gifts, singular en', { locale: 'en', showDetails: true }, { training: none, weeklyChallenge: null, rival: null, exchanges: [], gifts: [Date.UTC(2026, 11, 11, 15)] }],
    ['two exchanges', { showDetails: true }, { exchanges: [{ eventId: 'ev_b', points: 1, closesAt: Date.UTC(2026, 11, 12, 19) }, { eventId: 'ev_a', points: 30, closesAt: Date.UTC(2026, 11, 10, 19) }], config: { ...c, dailyCap: 4 } }],
    ['past and horizon', { now: Date.UTC(2026, 11, 10, 3) }, { gifts: [Date.UTC(2026, 11, 30, 15)] }],
    ['rival raced, challenge cleared', {}, { rival: { weekEndsAt: WEEK_END, rankedRaces: 2 }, weeklyChallenge: { unlocked: true, endsAt: WEEK_END, uncleared: 0 } }],
    ['locked bonus and challenge', {}, { loginBonus: { unlocked: false }, weeklyChallenge: { unlocked: false, endsAt: WEEK_END, uncleared: 3 } }],
    ['kinds subset', {}, { config: { ...c, kinds: ['gift_expiring', 'daily_bonus'] } }],
    ['daily hour 21, next day Sunday', {}, { config: { ...c, dailyHourJst: 21 }, nextDayAt: Date.UTC(2026, 11, 12, 19), nextDay: '2026-12-13' }],
    ['no permission', { permission: 'denied' }, {}],
    ['provisional', { permission: 'provisional' }, {}],
    ['signed out', { signedIn: false }, {}],
    ['deleting', {}, { deleting: true }],
    ['onboarding', {}, { onboarding: true }],
  ];
  return {
    _note: 'REQ-LNOTIF-003 (contracts/protocol.md §61.2): server/src/domain/localNotify.ts planLocalNotifications and C# Muchi.Client LocalNotificationPlanner.Plan must agree (items with texts in both languages, dropped reasons, status). Regenerate with UPDATE_VECTORS=1 npx vitest run test/local-notify.test.ts.',
    v: 1,
    cases: cases.map(([name, o, d]) => { const s = snap(o, d); return { name, snapshot: s, expect: planLocalNotifications(s) }; }),
  };
}
