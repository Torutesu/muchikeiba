/**
 * Round 16 integration: how the four Round 16 features (§42 hosted cups, §43 season recap, §44 roster organiser, §45 next
 * action) meet Round 15 (§38 photo mode, §39 pre-race advice, §40 activity, §41 accessibility), Round 14 and each other.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { m } from './helpers.js';
import { MemoryPlayerRepo, PlayerService } from '../src/domain/service.js';
import { seededRng } from '../src/domain/rng.js';
import type { AppError } from '../src/domain/errors.js';
import type { Master } from '../src/domain/master.js';
import type { RaceResultForPlayer } from '../src/domain/rewards.js';
import type { RaceMode } from '../src/domain/schemas.js';
import { HostedCupsService, MemoryCupBackend, type CupPorts } from '../src/domain/hostedCupService.js';
import type { PlayerInvoker, RaceEntry } from '../src/http/app.js';
import type { HeatOutcome } from '../src/domain/tournaments.js';
import type { RoomConditions } from '../src/domain/presets.js';
import { DELETION_STEPS, runAccountDeletion, type DeletionPorts } from '../src/domain/accountDeletion.js';
import { ACTIVITY_KINDS, ACTIVITY_META, ACTIVITY_SCREENS, renderActivityItems } from '../src/domain/activity.js';
import { ACTIVITY_KIND_NAMES, ACTIVITY_SCREEN_NAMES, ADVICE_KPI_CONTEXTS } from '../src/domain/kpi.js';
import { PHOTO_MODES, SHARED_RACE_MODES } from '../src/domain/photoMode.js';
import { BULK_REASONS } from '../src/domain/roster.js';
import { ADVICE_CONTEXTS } from '../src/domain/raceAdviceService.js';
import { bettingWordsIn } from '../src/domain/bettingWords.js';
import { catalogFor, localize, untranslated, PLAYER_TEXT_KEYS } from '../src/i18n/catalog.js';
import { CODE_EN } from '../src/i18n/en.js';

const ROOT = join(import.meta.dirname, '..', '..');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** JST wall clock → ms. */
const jst = (y: number, mo: number, d: number, h = 12, mi = 0) => Date.UTC(y, mo - 1, d, h - 9, mi);
const T0 = jst(2026, 11, 20, 12);
const RULES: RoomConditions = { trackId: 'aoba_turf_1600', going: 'good', night: false, weather: 'sunny', temperatureC: 18, windKmh: 0 };
const code = async (p: Promise<unknown>) => { try { await p; } catch (e) { return (e as AppError).code; } return 'NO_ERROR'; };

/** Players + hosted cups wired like the Durable Objects (one call at a time per player and per cup). */
function world(master: Master = m, start = T0) {
  let now = start;
  const repo = new MemoryPlayerRepo();
  const svc = new PlayerService(repo, { master, rng: seededRng(16), clock: () => now, verifiers: {} });
  const gates = new Map<string, Promise<unknown>>();
  const invoker = (uid: string): PlayerInvoker => ({ invoke: (async (method: string, ...args: unknown[]) => {
    const run = (gates.get(uid) ?? Promise.resolve()).then(() => (svc as unknown as Record<string, (...a: unknown[]) => unknown>)[method]!.apply(svc, args));
    gates.set(uid, run.catch(() => undefined));
    return run;
  }) as PlayerInvoker['invoke'] });
  const outcomes = new Map<string, HeatOutcome | null>();
  const ports: Omit<CupPorts<RaceEntry>, 'releaseCode'> = {
    refreshEntry: async (pid, horseId) => (await svc.raceEntry(pid, horseId)) as RaceEntry,
    startRace: async (spec) => ({ raceId: spec.raceId, startAtMs: now + 10_000 }),
    raceOutcome: async (raceId) => outcomes.get(raceId) ?? null,
    notifyClosed: async (pid, n) => { await invoker(pid).invoke('cupClosed', pid, n); },
    notifyStarted: async (pid, n) => { await invoker(pid).invoke('cupStarted', pid, n); },
  };
  const backend = new MemoryCupBackend<RaceEntry>(() => master, ports, () => now);
  const cups = new HostedCupsService<RaceEntry>(() => master, backend, invoker, () => now, async () => []);
  let n = 0;
  let raceSeq = 0;
  const k = () => `c:r16:${n++}`;
  const player = async (id: string, name = id.toUpperCase()) => {
    await svc.bootstrap(id);
    await svc.grantPartner(id, 'アイボウ', k());
    const s = await svc.state(id);
    s.profile.displayName = name;
    await repo.put(s);
    return s.horses[0]!.id;
  };
  const horse = async (id: string) => (await svc.state(id)).horses[0]!.id;
  const befriend = async (a: string, b: string) => {
    for (const [x, y] of [[a, b], [b, a]] as const) { const s = await svc.state(x); s.friends.ids.push(y); await repo.put(s); }
  };
  const body = (patch: Record<string, unknown> = {}) => ({ cupName: '金曜の夜カップ', capacity: 4, format: 'single' as const, opensAt: now, closesAt: now + 3 * HOUR, conditions: RULES, ...patch });
  const cupWith = async (host: string, others: string[], patch: Record<string, unknown> = {}) => {
    const c = await cups.create(host, { ...body(patch), horseId: await horse(host) } as never, k());
    for (const o of others) await cups.join(o, { code: c.cup.code!, horseId: await horse(o) }, k());
    return { cupId: c.cup.cupId, code: c.cup.code! };
  };
  const finish = (raceId: string, order: string[]) => {
    const slots = order.map((p, i) => ({ slot: i, playerId: p }));
    outcomes.set(raceId, { phase: 'finished', final: { status: 'confirmed', order: slots.map((s) => s.slot) }, slots, noShows: [] });
  };
  /** A confirmed race result as the room hands it to the player (no verifier needed in these tests). */
  const race = (id: string, place: number, o: { horseId?: string; mode?: RaceMode; raceId?: string; humans?: number } = {}) => {
    const r: RaceResultForPlayer = {
      raceId: o.raceId ?? `r16_${raceSeq++}`, mode: o.mode ?? 'ranked', place, fieldSize: 8, newRating: null, void: false, humans: o.humans ?? 4,
      details: { trackId: 'aoba_turf_1600', style: 'sashi', finishTick: 1500, startReactionTicks: null, whips: 0, whipMashed: false, cpuAssisted: false },
      replay: { slot: 0, resultHash: 'c'.repeat(64), rulesetVersion: '1.2.0', trackId: 'aoba_turf_1600', marginTicks: null },
      ...(o.horseId ? { horseId: o.horseId } : {}),
    };
    return svc.applyRace(id, r);
  };
  /** The page as the route renders it (stored names; the directory lookup is the route's job). */
  const page = async (uid: string) => { const p = await svc.activity(uid); return { ...p, items: renderActivityItems(p.items, null) }; };
  const entries = async (uid: string) => (await page(uid)).items;
  return { page, svc, repo, cups, backend, ports, outcomes, k, player, horse, befriend, body, cupWith, finish, race, entries, invoker, now: () => now, set: (ms: number) => { now = ms; }, advance: (ms: number) => { now += ms; } };
}

// ------------------------------------------------------------------------------------------------ §40 × §42 / §43

describe('§40 activity × §42 hosted cups (REQ-ACT-002/011, §42.7)', () => {
  it('the kinds, screens and KPI names stay in step on the server', () => {
    for (const kind of ['cup_invited', 'cup_started', 'cup_finished', 'cup_cancelled', 'recap_ready']) {
      expect(ACTIVITY_KINDS).toContain(kind);
      expect(ACTIVITY_KIND_NAMES).toContain(kind);
    }
    expect([...ACTIVITY_SCREENS]).toEqual([...ACTIVITY_SCREEN_NAMES]);
    expect(ACTIVITY_META.cup_invited).toMatchObject({ category: 'invites', screen: 'cups', collapse: false });
    expect(ACTIVITY_META.cup_finished.screen).toBe('cups');
    expect(ACTIVITY_META.recap_ready).toMatchObject({ category: 'season', screen: 'recap', collapse: false });
    // the clients know every kind and screen (the C# test checks the other direction)
    const cs = readFileSync(join(ROOT, 'engine/Muchi.Client/Activity.cs'), 'utf8');
    const app = readFileSync(join(ROOT, 'tools/figma-prototype/site/app.js'), 'utf8');
    for (const k of ACTIVITY_KINDS) { expect(cs, k).toContain(`"${k}"`); expect(app, k).toMatch(new RegExp(`ACT_LABEL = \\{[^}]*\\b${k}:`)); }
    for (const x of ACTIVITY_SCREENS) expect(cs, x).toContain(`"${x}"`);
  });

  it('an invitation writes one entry naming the host (never twice, never from a blocked host)', async () => {
    const w = world();
    for (const u of ['host', 'f1', 'f2']) await w.player(u);
    await w.befriend('host', 'f1'); await w.befriend('host', 'f2');
    await w.svc.feedMute('f2', 'host', true);
    const { cupId } = await w.cupWith('host', []);
    await w.cups.invite('host', cupId, { friendIds: ['f1', 'f2'] });
    await w.cups.invite('host', cupId, { friendIds: ['f1'] });
    const f1 = (await w.entries('f1')).filter((x) => x.kind === 'cup_invited');
    expect(f1).toHaveLength(1);
    expect(f1[0]).toMatchObject({ category: 'invites', link: { screen: 'cups', id: cupId }, text: 'HOSTさんから「金曜の夜カップ」に招待されました' });
    expect(f1[0]!.actors.map((a) => a.playerId)).toEqual(['host']);
    expect((await w.entries('f2')).filter((x) => x.kind === 'cup_invited')).toEqual([]);
    expect((await w.entries('host')).filter((x) => x.kind.startsWith('cup_'))).toEqual([]);
  });

  it('the first race tells every entrant once that the cup started; the result writes the place (once per cup)', async () => {
    const w = world();
    for (const u of ['host', 'a', 'b']) await w.player(u);
    const { cupId } = await w.cupWith('host', ['a', 'b'], { format: 'best_of_3' });
    const r0 = await w.cups.start('host', cupId);
    const started = async (u: string) => (await w.entries(u)).filter((x) => x.kind === 'cup_started');
    expect(await started('a')).toHaveLength(1);
    expect((await started('a'))[0]).toMatchObject({ link: { screen: 'cups', id: cupId }, text: '「金曜の夜カップ」が始まりました' });
    expect(await started('b')).toHaveLength(1);
    expect(await started('host')).toEqual([]); // the host pressed start
    // the second and third races write nothing new
    for (const [i, order] of [[0, ['a', 'host', 'b']], [1, ['a', 'b', 'host']], [2, ['b', 'a', 'host']]] as const) {
      const raceId = i === 0 ? r0.raceId : (await w.cups.start('host', cupId)).raceId;
      w.finish(raceId, [...order]);
      await w.backend.tickAll();
      w.advance(60_000);
    }
    expect(await started('a')).toHaveLength(1);
    const fin = (await w.entries('a')).filter((x) => x.kind === 'cup_finished');
    expect(fin).toHaveLength(1);
    expect(fin[0]!.text).toBe('「金曜の夜カップ」の順位は1位でした');
    expect((await w.entries('host')).filter((x) => x.kind === 'cup_finished')[0]!.text).toBe('「金曜の夜カップ」の順位は3位でした');
    // a repeated close notice (the cup retries its outbox) writes nothing more
    const s = await w.svc.state('a');
    const n0 = s.activity!.entries.length;
    await w.svc.cupClosed('a', { cupId, cupName: '金曜の夜カップ', format: 'best_of_3', status: 'finished', partial: false, cancelReason: null, rank: 1, points: 27, entrants: 3, at: w.now(), role: 'entrant' });
    expect((await w.svc.state('a')).activity!.entries.length).toBe(n0);
  });

  it('a cancelled cup says so (no place); an invitee who never joined gets no result entry', async () => {
    const w = world();
    for (const u of ['host', 'a', 'inv']) await w.player(u);
    await w.befriend('host', 'inv');
    const { cupId } = await w.cupWith('host', ['a']);
    await w.cups.invite('host', cupId, { friendIds: ['inv'] });
    await w.cups.leave('host', cupId);
    const a = (await w.entries('a')).filter((x) => x.kind === 'cup_cancelled');
    expect(a).toHaveLength(1);
    expect(a[0]!.text).toBe('「金曜の夜カップ」は中止になりました');
    expect((await w.entries('inv')).filter((x) => x.kind === 'cup_cancelled' || x.kind === 'cup_finished')).toEqual([]);
  });

  it('English: the cup name and the host name stay as typed', async () => {
    const w = world();
    for (const u of ['host', 'f1']) await w.player(u);
    await w.befriend('host', 'f1');
    const { cupId } = await w.cupWith('host', []);
    await w.cups.invite('host', cupId, { friendIds: ['f1'] });
    const en = localize(await w.page('f1'), 'en', catalogFor(m));
    expect(en.items.find((x) => x.kind === 'cup_invited')!.text).toBe('HOST invited you to “金曜の夜カップ”');
    // the only Japanese left is the cup name the host typed (a {cup} placeholder is verbatim, like {name})
    expect(untranslated(en, PLAYER_TEXT_KEYS)).toEqual(['$.items[0].text: HOST invited you to “金曜の夜カップ”']);
  });
});

describe('§40 activity × §43 season recap (REQ-ACT-002, REQ-RECAP-002)', () => {
  it('a closed season writes one recap_ready entry linking the recap; English reads well', async () => {
    const w = world(m, jst(2026, 11, 20));
    const horse = await w.player('u');
    for (let i = 0; i < 3; i++) await w.race('u', 2, { horseId: horse });
    w.set(jst(2026, 12, 1, 1));
    await w.svc.recaps('u');
    await w.svc.recaps('u');
    const items = (await w.entries('u')).filter((x) => x.kind === 'recap_ready');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ category: 'season', link: { screen: 'recap', id: 'season:2026-11' }, text: '2026年11月シーズンの振り返りができました' });
    const en = localize(await w.page('u'), 'en', catalogFor(m));
    expect(en.items.find((x) => x.kind === 'recap_ready')!.text).toBe('Your Season 11/2026 recap is ready');
  });
});

// ------------------------------------------------------------------------------------------------ §38 × §42

describe('§38 photo mode × §42 hosted cups (REQ-PHOTO-001)', () => {
  it('a cup race is run with other people: a live pause is refused; the result / replay photo is fine', async () => {
    expect(SHARED_RACE_MODES).toContain('cup');
    expect(PHOTO_MODES).toContain('cup');
    const w = world();
    await w.player('u');
    const input = (kind: 'paused' | 'result') => ({
      source: { kind, mode: 'cup' as const, raceId: 'cup-x-0-0', tick: 300 },
      camera: { focusSlot: 0, orbitDeg: 30, distanceDm: 60, heightDm: 15, fovDeg: 40, dof: 1 },
      lookId: 'natural', frameId: null, stamps: [], caption: null, names: 'masked' as const, hideUi: true,
    });
    expect(await code(w.svc.photoSave('u', input('paused') as never, 'c:p1'))).toBe('PHOTO_SOURCE_INVALID');
    expect(await code(w.svc.photoSave('u', input('result') as never, 'c:p2'))).toBe('NO_ERROR');
  });
  it('the clients refuse the pause in a cup race too (C# PhotoMode, prototype)', () => {
    const cs = readFileSync(join(ROOT, 'engine/Muchi.Client/PhotoMode.cs'), 'utf8');
    expect(cs).toMatch(/IsShared\(string mode\)[^;]*mode == "cup"/);
    expect(cs).toContain('case RaceMode.Cup: return "cup";');
    const app = readFileSync(join(ROOT, 'tools/figma-prototype/site/app.js'), 'utf8');
    // the prototype pauses only the solo races it names (time attack, weekly challenge, tutorial): a cup race never pauses
    expect(app).toContain('const phShared = () => !raceCtx?.ta && !raceCtx?.challenge && !raceCtx?.tutorial;');
  });
});

// ------------------------------------------------------------------------------------------------ §39 × §42

describe('§39 advice × §42 hosted cups (REQ-ADV-005)', () => {
  it('the cup context knows the course and going before the race (friend-room rules, one course)', async () => {
    expect(ADVICE_CONTEXTS).toContain('cup');
    expect(ADVICE_KPI_CONTEXTS).toContain('cup');
    const w = world();
    await w.player('u');
    const a = await w.svc.raceAdvice('u', { context: 'cup', trackId: 'aoba_turf_1600', going: 'soft', night: false });
    expect(a.context).toBe('cup');
    expect(a.input!.courses).toHaveLength(1);
    expect(a.input!.courses[0]).toMatchObject({ trackId: 'aoba_turf_1600', going: 'soft' });
    expect(a.input!.mode).toBe('friend'); // the device recompute uses the friend-room rules (no caps, no bond)
    expect(a.input!.statCap).toBeNull();
    expect(await code(w.svc.raceAdvice('u', { context: 'cup' }))).toBe('BAD_REQUEST'); // the cup always has its course
  });
});

// ------------------------------------------------------------------------------------------------ §37 / §34 / §43 × §42

describe('§37 my replays, §34 hall, §43 recap × §42 hosted cups (REQ-CUP-013)', () => {
  it('a cup race is offered in マイリプレイ (saveable like a friend race) but counts in neither the hall career nor the recap', async () => {
    const w = world();
    const horse = await w.player('u');
    await w.race('u', 1, { horseId: horse, mode: 'cup', raceId: 'cup-abc-0-0' });
    const v = await w.svc.myReplays('u') as { recent: { raceId: string; mode: string }[] };
    expect(v.recent.map((x) => x.raceId)).toContain('cup-abc-0-0');
    const career = await w.svc.horseCareer('u', horse) as { career: { races: number } };
    expect(career.career.races).toBe(0);
    const s = await w.svc.state('u');
    expect(s.seasonRecap?.acc.season?.races ?? 0).toBe(0);
    // a friend race with the same field does count (the cup is the one excluded mode)
    await w.race('u', 1, { horseId: horse, mode: 'friend', raceId: 'fr-1' });
    expect(((await w.svc.horseCareer('u', horse)) as { career: { races: number } }).career.races).toBe(1);
  });
});

// ------------------------------------------------------------------------------------------------ §44 × §42

describe('§44 roster organiser × §42 hosted cups (REQ-ORG-009)', () => {
  it('a horse entered in an active cup is refused by the bulk retire (cup_entry); after the cup closes it is free', async () => {
    expect(BULK_REASONS).toContain('cup_entry');
    const w = world();
    const h = await w.player('u');
    await w.player('host');
    await w.svc.grantPartner('u', 'ニバンメ', w.k()).catch(() => undefined);
    const { cupId } = await w.cupWith('host', ['u']);
    const rows = (await w.svc.roster('u')).horses;
    expect(rows.find((r) => r.horseId === h)!.blocks).toContain('cup_entry');
    const prev = await w.svc.rosterPreview('u', 'retire', [h]);
    expect(prev.horses[0]!.reasons).toContain('cup_entry');
    await w.cups.leave('host', cupId); // the host leaves = the cup is cancelled
    expect((await w.svc.roster('u')).horses.find((r) => r.horseId === h)!.blocks).not.toContain('cup_entry');
  });
});

// ------------------------------------------------------------------------------------------------ account deletion

describe('account deletion clears Round 16 state (REQ-CUP-016, REQ-RECAP-014, REQ-ORG-*, REQ-NEXT-*)', () => {
  it('cups, recaps, roster locks / favourites and next-action dismissals are gone; the cup forgets the player', async () => {
    const w = world(m, jst(2026, 11, 20));
    const h = await w.player('gone');
    await w.player('host');
    for (let i = 0; i < 3; i++) await w.race('gone', 2, { horseId: h });
    w.set(jst(2026, 12, 1, 1));
    await w.svc.recaps('gone');
    const { cupId } = await w.cupWith('host', ['gone']);
    await w.svc.rosterLock('gone', h, true);
    await w.svc.rosterFavorite('gone', h, true);
    const nx = await w.svc.nextActions('gone') as { primary: { kind: string; dismissible: boolean } | null; chips: { kind: string; dismissible: boolean }[] };
    const dismissible = [nx.primary, ...nx.chips].find((x) => x?.dismissible);
    if (dismissible) await w.svc.dismissNextAction('gone', dismissible.kind);
    const before = await w.svc.state('gone');
    expect(before.seasonRecap?.recaps.length).toBe(1);
    expect(before.cups?.active.map((r) => r.cupId)).toEqual([cupId]);
    expect(before.roster?.locked).toContain(h);
    expect(before.roster?.favorites).toContain(h);
    expect((await w.backend.get(cupId))!.entrants.map((e) => e.playerId)).toContain('gone');

    const tok = (await w.svc.requestDeletion('gone', null)) as { confirmToken: string };
    await w.svc.requestDeletion('gone', tok.confirmToken);
    w.advance(15 * DAY);
    const ports: DeletionPorts = {
      start: async (u) => { await w.svc.deletionStart(u); },
      snapshot: (u) => w.svc.deletionSnapshot(u),
      markStep: async (u, st) => { await w.svc.deletionMarkStep(u, st); },
      friends: { removeFriend: async () => undefined, dropOutgoing: async () => undefined, dropIncoming: async () => undefined },
      directory: { forget: async () => undefined },
      leaderboards: { forget: async () => undefined, deleteGhosts: async () => undefined },
      replays: { deleteAll: async () => undefined },
      cups: { forget: (c, u) => w.backend.forget(c, u, '退会したプレイヤー') },
      finalize: (u) => w.svc.deletionFinalize(u), retain: async () => undefined, wipe: (u) => w.svc.wipe(u),
    };
    const r = await runAccountDeletion(ports, 'gone', w.now());
    expect(DELETION_STEPS).toContain('cups');
    expect(r.done).toEqual(expect.arrayContaining(['cups', 'wipe']));
    expect(w.repo.get('gone')).toBeNull();
    const c = await w.backend.get(cupId);
    expect(c === null || !c.entrants.some((e) => e.playerId === 'gone')).toBe(true);
    // late deliveries never recreate the account
    expect(await w.svc.cupStarted('gone', { cupId, cupName: 'x', raceIndex: 0 })).toBe(false);
    expect(await w.svc.cupClosed('gone', { cupId, cupName: 'x', format: 'single', status: 'cancelled', partial: false, cancelReason: 'host_left', rank: null, points: null, entrants: 2, at: w.now(), role: 'entrant' })).toEqual({ recorded: false });
    expect(w.repo.get('gone')).toBeNull();
  });
});

// ------------------------------------------------------------------------------------------------ wording

describe('Round 16 wording × the shared betting-word list (docs/planning/03)', () => {
  it('the recap texts (Japanese and English) carry no betting word (bettingWordsIn, not a copy)', async () => {
    const w = world(m, jst(2026, 11, 20));
    const horse = await w.player('u');
    for (let i = 0; i < 4; i++) await w.race('u', i + 1, { horseId: horse });
    w.set(jst(2026, 12, 1, 1));
    const list = await w.svc.recaps('u') as { recaps: { id: string }[] };
    const v = await w.svc.recap('u', list.recaps[0]!.id);
    expect(bettingWordsIn(JSON.stringify(v))).toEqual([]);
    expect(bettingWordsIn(JSON.stringify(localize(v, 'en', catalogFor(m))))).toEqual([]);
    const keys = Object.keys(CODE_EN);
    const recapKeys = keys.slice(keys.indexOf('{y}年{m}月シーズン'), keys.indexOf('タイムアタックの自己ベスト') + 1);
    expect(recapKeys.length).toBeGreaterThan(40);
    for (const k of recapKeys) expect([...bettingWordsIn(k), ...bettingWordsIn(CODE_EN[k]!)], k).toEqual([]);
  });

  it('the next-action card texts (Unity model, prototype) and their English carry no betting word', () => {
    const literals = (src: string) => [...src.matchAll(/"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'/g)].map((x) => x[1] ?? x[2] ?? '');
    const model = readFileSync(join(ROOT, 'unity/Assets/Muchi/Game/NextActionModel.cs'), 'utf8');
    const ui = JSON.parse(readFileSync(join(ROOT, 'engine/Muchi.Client/Resources/Muchi/ui-en.json'), 'utf8')) as Record<string, string>;
    const texts = literals(model).filter((t) => /[ぁ-んァ-ン一-龥]/.test(t));
    expect(texts.length).toBeGreaterThan(30);
    for (const t of texts) {
      expect(bettingWordsIn(t), t).toEqual([]);
      if (ui[t]) expect(bettingWordsIn(ui[t]!), ui[t]).toEqual([]);
    }
    const app = readFileSync(join(ROOT, 'tools/figma-prototype/site/app.js'), 'utf8');
    const block = app.slice(app.indexOf('次にやること'), app.indexOf('次にやること') + 12_000);
    const proto = JSON.parse(readFileSync(join(ROOT, 'tools/figma-prototype/logic/proto-en.json'), 'utf8')) as Record<string, string>;
    for (const t of literals(block).filter((x) => /[ぁ-んァ-ン一-龥]/.test(x))) {
      expect(bettingWordsIn(t), t).toEqual([]);
      if (proto[t]) expect(bettingWordsIn(proto[t]!), proto[t]).toEqual([]);
    }
  });

  it('the new activity texts carry no betting word and no fake urgency', () => {
    for (const k of ['{name}さんから「{cup}」に招待されました', '「{cup}」が始まりました', '「{cup}」の順位は{n}位でした', '「{cup}」は中止になりました', '{y}年{m}月シーズンの振り返りができました', '{y}年の振り返りができました']) {
      expect(CODE_EN[k], k).toBeTruthy();
      expect([...bettingWordsIn(k), ...bettingWordsIn(CODE_EN[k]!)]).toEqual([]);
      expect(k).not.toMatch(/倍|今だけ|残りわずか|お得|通常価格/);
    }
  });
});
