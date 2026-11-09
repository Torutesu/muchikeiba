/**
 * Round 14 integration: how the four Round 14 features (§34 hall of fame, §35 silks editor, §36 commentary packs,
 * §37 my replays) meet Round 13 (§30..§33) and each other.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MemoryPlayerRepo, PlayerService } from '../src/domain/service.js';
import { seededRng } from '../src/domain/rng.js';
import { createHorseFromTemplate } from '../src/domain/horses.js';
import { weeklyChallengeConfig } from '../src/domain/weeklyChallenge.js';
import type { PlayerState } from '../src/domain/player.js';
import type { RaceResultForPlayer } from '../src/domain/rewards.js';
import { m, makeConfig } from './helpers.js';
import { MemoryHallDirectory, type HallSnapshot } from '../src/domain/hallOfFame.js';
import { MemoryReplayStore, MyReplaysService } from '../src/domain/myReplaysService.js';
import { savedReplayKey, sourceReplayKey } from '../src/domain/myReplays.js';
import { settleRace } from '../src/race/orchestrate.js';
import { DELETION_STEPS, runAccountDeletion, type DeletionPorts } from '../src/domain/accountDeletion.js';
import type { PlayerInvoker } from '../src/http/app.js';
import type { RaceStartConfig } from '../src/domain/schemas.js';
import { ensureExchange, exchangeProblems } from '../src/domain/exchange.js';
import { ownsPart } from '../src/domain/silksEditor.js';
import { classifyLedger, COIN_TITLES } from '../src/domain/history.js';
import { grantFree } from '../src/domain/wallet.js';
import { catalogFor, localize, untranslated } from '../src/i18n/catalog.js';
import type { EventDef, Master } from '../src/domain/master.js';

const ROOT = join(import.meta.dirname, '..', '..');

/** Every duplicated key in a JSON text (JSON.parse silently keeps the last one). */
function duplicateKeys(text: string): string[] {
  const dups: string[] = [];
  const stack: Set<string>[] = [];
  // a small tokenizer: strings, braces and brackets; a string followed by ':' is a key of the innermost object
  const re = /"(?:[^"\\]|\\.)*"|[{}[\]:]/g;
  let m: RegExpExecArray | null;
  let last: string | null = null;
  const kinds: string[] = [];
  while ((m = re.exec(text))) {
    const t = m[0];
    if (t === '{') { kinds.push('{'); stack.push(new Set()); }
    else if (t === '[') kinds.push('[');
    else if (t === '}') { kinds.pop(); stack.pop(); }
    else if (t === ']') kinds.pop();
    else if (t === ':') {
      if (last !== null && kinds[kinds.length - 1] === '{') {
        const keys = stack[stack.length - 1]!;
        const k = JSON.parse(last) as string;
        if (keys.has(k)) dups.push(k);
        keys.add(k);
      }
    }
    last = t.startsWith('"') ? t : null;
  }
  return dups;
}

describe('locale files', () => {
  const files = [
    'engine/Muchi.Client/Resources/Muchi/ui-en.json',
    'engine/Muchi.Client/Resources/Muchi/server-en.json',
    'server/master/locale-en.json',
    'tools/figma-prototype/logic/proto-en.json',
  ];
  for (const f of files) {
    it(`${f} has no duplicate keys (the merged rounds each add strings)`, () => {
      expect(duplicateKeys(readFileSync(join(ROOT, f), 'utf8'))).toEqual([]);
    });
  }
});

// ------------------------------------------------------------------------------------------------ §34 × §31

const T_WCH = Date.UTC(2026, 10, 5, 3); // Thu 2026-11-05 12:00 JST: the anchor week of the shipped rotation
const HASH = 'a'.repeat(64);

function world(start = T_WCH) {
  let now = start;
  const repo = new MemoryPlayerRepo();
  const svc = new PlayerService(repo, { master: m, rng: seededRng(7), clock: () => now, verifiers: {} });
  return { svc, repo, state: (u: string) => repo.get(u) as PlayerState, set: (t: number) => { now = t; }, now: () => now };
}
type World = ReturnType<typeof world>;

async function ownHorse(w: World, uid: string, templateId: string) {
  await w.svc.bootstrap(uid);
  const s = w.repo.get(uid)!;
  const h = createHorseFromTemplate(s, m.templateById.get(templateId)!, w.now());
  w.repo.put(s);
  return h.id;
}

/** Runs one weekly challenge with the player's own horse to a verified 1st place. */
async function challengeWin(w: World, uid: string, horseId: string) {
  const ch = weeklyChallengeConfig(m)!.rotation[0]!.challenges[0]!; // the nige challenge
  const st = await w.svc.wchStart(uid, ch.id, { horseId });
  await w.svc.wchPrepare(uid, st.sessionId, [[60, st.playerSlot, 1]], HASH, undefined);
  const order = [st.playerSlot, ...st.config.entrants.map((e) => e.slot).filter((x) => x !== st.playerSlot)];
  const r = await w.svc.wchRecord(uid, st.sessionId, { resultHash: HASH, order, finishTicks: order.map((_, i) => 1800 + i * 10), finishFracs: order.map(() => 0), checksums: {} }, HASH);
  expect('rejected' in r).toBe(false);
  return st;
}

const rankedWin = (raceId: string, horseId: string): RaceResultForPlayer => ({
  raceId, mode: 'ranked', place: 1, fieldSize: 8, newRating: null, void: false, humans: 2, horseId,
  details: { trackId: 'aoba_turf_1600', style: 'nige', finishTick: 1000, startReactionTicks: 2, whips: 3, whipMashed: false, cpuAssisted: false },
});

describe('§34 hall of fame × §31 weekly challenge (REQ-HOF-001, REQ-STAT-001)', () => {
  it('a weekly challenge run is not part of the horse career (like the player statistics), and a ranked race counts once', async () => {
    const w = world();
    const horseId = await ownHorse(w, 'p', 't_kohaku'); // nige: eligible for the nige challenge
    await challengeWin(w, 'p', horseId);
    // a capped, CPU-only riding test (verified like time attack): no career line, no statistics
    expect(w.state('p').hall?.careers[horseId]?.races ?? 0).toBe(0);
    expect(w.state('p').stats.races).toBe(0);
    // a ranked race with the same horse counts, once, even when the room delivers the result twice
    await w.svc.applyRace('p', rankedWin('rk1', horseId));
    await w.svc.applyRace('p', rankedWin('rk1', horseId));
    expect(w.state('p').hall!.careers[horseId]).toMatchObject({ races: 1, wins: 1 });
    expect(w.state('p').stats.races).toBe(1);
  });
});

// ------------------------------------------------------------------------------------------------ §35 × §30 / §33

const exEvent = m.events.find((e) => e.exchange)!;
/** A sample exchange line (test only: no live config ships one). */
const withExchangeLine = (line: NonNullable<EventDef['exchange']>['items'][number]): EventDef => ({
  ...exEvent, exchange: { ...exEvent.exchange!, items: [...exEvent.exchange!.items, line] },
});

describe('§35 silks parts × §30 event exchange (REQ-EXCH-002, REQ-SILK-005)', () => {
  it('a silks part (an `any`-currency silks_part cosmetic) is a valid cosmetic exchange line; a paid-only part is refused', () => {
    const ok = withExchangeLine({ id: 'ex_silk_crimson', name: '勝負服の色', kind: 'cosmetic', price: 300, stock: 1, reward: { items: [{ itemId: 'silkpart_color_crimson', qty: 1 }] } });
    expect(exchangeProblems(m, ok, [ok])).toEqual([]);
    const paid = withExchangeLine({ id: 'ex_silk_platinum', name: '勝負服の色', kind: 'cosmetic', price: 300, stock: 1, reward: { items: [{ itemId: 'silkpart_color_platinum', qty: 1 }] } });
    expect(exchangeProblems(m, paid, [paid]).join()).toMatch(/paid-only/);
  });

  it('a part taken from the exchange is owned in the editor (the same item the shop sells)', async () => {
    const ev = withExchangeLine({ id: 'ex_silk_crimson', name: '勝負服の色', kind: 'cosmetic', price: 300, stock: 1, reward: { items: [{ itemId: 'silkpart_color_crimson', qty: 1 }] } });
    const master = { ...m, events: m.events.map((e) => (e.id === ev.id ? ev : e)) } as Master;
    let now = ev.startAtMs + 3_600_000;
    const repo = new MemoryPlayerRepo();
    const svc = new PlayerService(repo, { master, rng: seededRng(3), clock: () => now, verifiers: {} });
    await svc.bootstrap('p');
    const s = repo.get('p')!;
    expect(ownsPart(master, s, 'color', 'crimson')).toBe(false);
    ensureExchange(master, s, ev).points = 300;
    repo.put(s);
    await svc.exchangeBuy('p', ev.id, 'ex_silk_crimson', 1, 'c:x1');
    expect(ownsPart(master, repo.get('p')!, 'color', 'crimson')).toBe(true);
    expect(repo.get('p')!.wallet.free).toBe(s.wallet.free); // no coins move
    now += 1;
  });
});

describe('§35 silks part purchase × §33 coin history (REQ-HIST-003)', () => {
  it('shows a readable category in Japanese and English (never the raw reason)', async () => {
    const w = world();
    await w.svc.bootstrap('p');
    const s = w.repo.get('p')!;
    grantFree(s, 500, w.now(), 'test', 't');
    w.repo.put(s);
    await w.svc.buyCosmetic('p', 'silkpart_color_crimson', 'c:k1');
    const e = w.repo.get('p')!.ledger.at(-1)!;
    const row = classifyLedger(m, e);
    expect(row).toEqual({ category: 'shop', title: 'ショップで購入（勝負服の色「クリムゾン」）' });
    const en = localize(row.title, 'en', catalogFor(m));
    expect(en).toBe('Shop purchase (Silks colour "Crimson")');
    expect(untranslated(en)).toEqual([]);
  });
});

// ------------------------------------------------------------------------------------------------ §36 × §29 / §33

describe('§36 commentary packs × §29 coin shortfall × §33 coin history', () => {
  it('buying a pack without enough coins answers INSUFFICIENT_COINS with the shortfall sheet (T6); nothing is owned or spent', async () => {
    const w = world();
    await w.svc.bootstrap('p');
    const s = w.repo.get('p')!;
    s.wallet.free = 100; s.wallet.paid = 0;
    w.repo.put(s);
    const err = await w.svc.buyCommentaryPack('p', 'ochitsuki', true, 'c:b1').then(() => null, (e: unknown) => e as { code: string; details?: Record<string, unknown> });
    expect(err?.code).toBe('INSUFFICIENT_COINS');
    expect(err?.details?.shortfall).toMatchObject({ short: true, shortfall: 200 });
    expect(w.state('p').commentaryPack?.owned?.ochitsuki).toBeUndefined();
    expect(w.state('p').wallet.free).toBe(100);
  });

  it('a pack purchase shows a readable category in Japanese and English (never the raw reason); equipping spends nothing', async () => {
    const w = world();
    await w.svc.bootstrap('p');
    const s = w.repo.get('p')!;
    grantFree(s, 500, w.now(), 'test', 't');
    w.repo.put(s);
    await w.svc.buyCommentaryPack('p', 'ochitsuki', false, 'c:b2');
    const n = w.state('p').ledger.length;
    await w.svc.equipCommentaryPack('p', 'ochitsuki', 'settings');
    expect(w.state('p').ledger).toHaveLength(n);
    const e = w.state('p').ledger.at(-1)!;
    const row = classifyLedger(m, e);
    expect(row).toEqual({ category: 'commentary_pack', title: '実況パックの購入（落ち着いた解説）' });
    expect(COIN_TITLES.commentary_pack).toBe('実況パックの購入');
    const en = localize(row.title, 'en', catalogFor(m));
    expect(en).toBe('Commentary pack purchase (Calm Analyst)');
    expect(untranslated(en)).toEqual([]);
    // the history page shows the row under that category
    const page = await w.svc.history('p', 'coins', { currency: 'free', limit: 50 }) as { items: { category: string; title: string }[] };
    expect(page.items.map((r) => r.category)).toContain('commentary_pack');
    expect(JSON.stringify(page.items)).not.toMatch(/commentary pack ochitsuki/);
  });
});

describe('§36 commentary packs × §30 event exchange (REQ-EXCH-002, REQ-CMT-010)', () => {
  const line = (packId: string, extra: object = {}) => ({ id: `ex_pack_${packId}`, name: '実況パック', kind: 'commentary_pack' as const, price: 300, stock: 1, reward: { items: [{ itemId: packId, qty: 1 }] }, ...extra });
  type View = { items: { id: string; owned: boolean }[] };

  it('a coin-sold pack is a valid exchange line (stock 1); the standard, an achievement pack, an unknown pack or stock > 1 are refused', () => {
    const ok = withExchangeLine(line('ochitsuki'));
    expect(exchangeProblems(m, ok, [ok])).toEqual([]);
    for (const [bad, re] of [[line('standard'), /sold for coins/], [line('nekketsu'), /sold for coins/], [line('nope'), /known commentary pack/], [line('kofuu', { stock: 2 }), /stock 1/]] as const) {
      const ev = withExchangeLine(bad);
      expect(exchangeProblems(m, ev, [ev]).join()).toMatch(re);
    }
  });

  it('a pack taken from the exchange is owned (equippable), never an inventory item, and the shop then refuses to sell it', async () => {
    const ev = withExchangeLine(line('ochitsuki'));
    const master = { ...m, events: m.events.map((e) => (e.id === ev.id ? ev : e)) } as Master;
    const now = ev.startAtMs + 3_600_000;
    const repo = new MemoryPlayerRepo();
    const svc = new PlayerService(repo, { master, rng: seededRng(3), clock: () => now, verifiers: {} });
    await svc.bootstrap('p');
    const s = repo.get('p')!;
    ensureExchange(master, s, ev).points = 900;
    repo.put(s);
    expect(((await svc.exchangeView('p', ev.id)) as View).items.find((x) => x.id === 'ex_pack_ochitsuki')?.owned).toBe(false);
    await svc.exchangeBuy('p', ev.id, 'ex_pack_ochitsuki', 1, 'c:x1');
    expect(repo.get('p')!.commentaryPack?.owned.ochitsuki).toMatchObject({ via: 'exchange' });
    expect(repo.get('p')!.items.ochitsuki).toBeUndefined();
    await svc.equipCommentaryPack('p', 'ochitsuki', 'settings');
    expect(((await svc.exchangeView('p', ev.id)) as View).items.find((x) => x.id === 'ex_pack_ochitsuki')?.owned).toBe(true);
    await expect(svc.buyCommentaryPack('p', 'ochitsuki', false, 'c:b9')).rejects.toMatchObject({ code: 'ALREADY_PURCHASED' });
  });

  it('the exchange refuses a pack the player already owns (no points spent)', async () => {
    const ev = withExchangeLine(line('kofuu'));
    const master = { ...m, events: m.events.map((e) => (e.id === ev.id ? ev : e)) } as Master;
    const now = ev.startAtMs + 3_600_000;
    const repo = new MemoryPlayerRepo();
    const svc = new PlayerService(repo, { master, rng: seededRng(3), clock: () => now, verifiers: {} });
    await svc.bootstrap('p');
    const s = repo.get('p')!;
    grantFree(s, 500, now, 'test', 't');
    ensureExchange(master, s, ev).points = 900;
    repo.put(s);
    await svc.buyCommentaryPack('p', 'kofuu', false, 'c:b1');
    await expect(svc.exchangeBuy('p', ev.id, 'ex_pack_kofuu', 1, 'c:x2')).rejects.toMatchObject({ code: 'ALREADY_PURCHASED' });
    expect(repo.get('p')!.events?.[ev.id]?.exchange?.points).toBe(900);
  });
});

// ------------------------------------------------------------------------------------------------ §37 × §31, account deletion

/** Players, the hall's public copies, R2 (source logs + saved replays) and マイリプレイ, wired like the Durable Objects. */
function fullWorld(start: number) {
  let now = start;
  const repo = new MemoryPlayerRepo();
  const hallDir = new MemoryHallDirectory();
  const svc = new PlayerService(repo, {
    master: m, rng: seededRng(11), clock: () => now, verifiers: {},
    onHall: async (id: string, snap: HallSnapshot | null) => { if (snap) await hallDir.put(snap); else await hallDir.remove(id); },
  });
  let gate: Promise<unknown> = Promise.resolve();
  const invoker: PlayerInvoker = { invoke: (async (method: string, ...args: unknown[]) => {
    const run = gate.then(() => (svc as unknown as Record<string, (...a: unknown[]) => unknown>)[method]!.apply(svc, args));
    gate = run.catch(() => undefined);
    return run;
  }) as PlayerInvoker['invoke'] };
  const store = new MemoryReplayStore();
  const replays = new MyReplaysService(() => m, () => invoker, store);
  /** A confirmed ranked race ridden by `uid` alone (slot 0, 1st): the room writes the log, settleRace settles it. */
  const race = async (uid: string, raceId: string, horseId?: string) => {
    const c0 = makeConfig(1, 'ranked', 11) as RaceStartConfig;
    const entrants = c0.entrants.map((e) => (e.kind === 'human' ? { ...e, playerId: uid } : e));
    const c = { ...c0, raceId, entrants };
    const log = { v: 1 as const, config: c, endTick: 1500, inputs: [[60, 0, 1]] as [number, number, number][] };
    await store.put(sourceReplayKey(raceId), JSON.stringify(log));
    const human = c.entrants.find((e) => e.kind === 'human')!.slot;
    const order = [human, ...c.entrants.filter((e) => e.slot !== human).map((e) => e.slot)];
    const results = settleRace(c, { status: 'confirmed', order, hash: 'c'.repeat(64), via: 'consensus', suspects: [] }, {}, log);
    const r = results[uid]!;
    await svc.applyRace(uid, horseId ? { ...r, horseId } : r);
    return r;
  };
  return { svc, repo, hallDir, store, replays, race, now: () => now, set: (t: number) => { now = t; }, advance: (ms: number) => { now += ms; } };
}

describe('§37 my replays × §31 weekly challenge (REQ-MYRP-001, "confirmed race" rule)', () => {
  it('a weekly challenge run is not offered in マイリプレイ (verified like time attack, never applyRace); a ranked race is, and saves', async () => {
    const w = fullWorld(T_WCH);
    await w.svc.bootstrap('p');
    const s = w.repo.get('p')!;
    const h = createHorseFromTemplate(s, m.templateById.get('t_kohaku')!, w.now());
    w.repo.put(s);
    const ww = { svc: w.svc, repo: w.repo, state: (u: string) => w.repo.get(u) as PlayerState, set: w.set, now: w.now };
    const st = await challengeWin(ww, 'p', h.id);
    const v0 = await w.svc.myReplays('p') as { recent: { raceId: string }[]; moments: { raceId: string }[] };
    expect([...v0.recent, ...v0.moments].map((x) => x.raceId)).not.toContain(`wch_${st.sessionId}`);
    expect([...v0.recent, ...v0.moments]).toHaveLength(0);
    // even a result shaped like a room's (mode "challenge") is not remembered
    const r = await w.race('p', 'rk_1');
    await w.svc.applyRace('p', { ...r, raceId: 'wch_fake', mode: 'challenge' } as RaceResultForPlayer);
    const v1 = await w.svc.myReplays('p') as { recent: { raceId: string }[]; moments: { raceId: string }[] };
    expect([...v1.recent, ...v1.moments].map((x) => x.raceId)).toEqual(['rk_1']);
    await w.replays.save('p', 'rk_1', null, 'c:s1');
    expect(w.store.files.has(savedReplayKey('p', 'rk_1'))).toBe(true);
  });
});

describe('account deletion clears Round 13 + Round 14 state (REQ-UXS-040, REQ-HOF-011, REQ-SILK-*, REQ-CMT-*, REQ-MYRP-012)', () => {
  it('runs every step, leaves nothing of R13 / R14 behind, and late writes never recreate the account', async () => {
    const ev = m.events.find((e) => e.exchange)!;
    const w = fullWorld(ev.startAtMs + 3_600_000);
    const uid = 'gone';
    await w.svc.bootstrap(uid);
    const s0 = w.repo.get(uid)!;
    const horse = createHorseFromTemplate(s0, m.templateById.get('t_kohaku')!, w.now());
    grantFree(s0, 1000, w.now(), 'test', 't');
    ensureExchange(m, s0, ev).points = 90; // §30
    w.repo.put(s0);
    // R14: a hall plaque (tournament win → inducted at retirement) with its public copy, a saved replay, a silks preset,
    // a bought commentary pack; R13: weekly challenge state, a team goal gift, a gacha log entry
    await w.race(uid, 'rk_del', horse.id);
    await w.svc.tournamentClose(uid, 'cup_del', 1, null, '新春杯', horse.id);
    await w.svc.retire(uid, horse.id);
    expect(w.hallDir.rows.has(uid)).toBe(true);
    await w.replays.save(uid, 'rk_del', null, 'c:s1');
    await w.svc.silksPresetCreate(uid, '本番', { design: { pattern: 'hoops', colors: ['navy', 'white'], sleeve: 'match', cap: 'plain', capColors: ['navy', 'white'] } });
    await w.svc.buyCommentaryPack(uid, 'ochitsuki', true, 'c:b1');
    await w.svc.wchView(uid);
    await w.svc.teamGoalReward(uid, '2026-12-07', 'team_1', 1, 5);
    await w.svc.tutorialDraw(uid, 'c:tut');
    const before = w.repo.get(uid)!;
    expect(before.hall?.entries.length).toBe(1);
    expect((before as PlayerState & { silksEditor?: { presets: unknown[] } }).silksEditor?.presets.length).toBe(1);
    expect(before.commentaryPack?.owned.ochitsuki).toBeTruthy();
    expect(before.myReplays?.saved.length).toBe(1);
    expect(before.gachaLog?.entries.length).toBeGreaterThan(0);
    expect(before.giftBox?.box.length).toBe(1);
    expect(w.store.files.has(savedReplayKey(uid, 'rk_del'))).toBe(true);

    // request → the hall copy leaves the directory at once (a scheduled deletion is not visited)
    const tok = (await w.svc.requestDeletion(uid, null)) as { confirmToken: string };
    await w.svc.requestDeletion(uid, tok.confirmToken);
    expect(w.hallDir.rows.has(uid)).toBe(false);
    w.advance(15 * 86_400_000);
    const ports: DeletionPorts = {
      start: async (u) => { await w.svc.deletionStart(u); },
      snapshot: (u) => w.svc.deletionSnapshot(u),
      markStep: async (u, st) => { await w.svc.deletionMarkStep(u, st); },
      friends: { removeFriend: async () => undefined, dropOutgoing: async () => undefined, dropIncoming: async () => undefined },
      // DirectoryDO.forget drops profiles, studs, stables and the hall copies (REQ-HOF-011)
      directory: { forget: async (u) => { await w.hallDir.remove(u); } },
      leaderboards: { forget: async () => undefined, deleteGhosts: async () => undefined },
      replays: { deleteAll: async (keys) => { for (const k of keys) await w.store.delete(k); } },
      finalize: (u) => w.svc.deletionFinalize(u), retain: async () => undefined, wipe: (u) => w.svc.wipe(u),
    };
    const r = await runAccountDeletion(ports, uid, w.now());
    expect(DELETION_STEPS).toEqual(expect.arrayContaining(['rival', 'replays', 'finalize', 'wipe']));
    expect(r.done).toEqual(expect.arrayContaining(['replays', 'wipe']));
    expect(w.repo.data.has(uid)).toBe(false);
    expect(w.hallDir.rows.has(uid)).toBe(false);
    expect([...w.store.files.keys()].filter((k) => k.startsWith(`myreplays/${uid}/`))).toEqual([]);

    // late background deliveries (other objects still holding the id): a race result settled after the wipe, the team's
    // payout retry, a tournament close naming the retired horse (hall career), a friend opening the public replays
    expect(await w.svc.applyRace(uid, { ...(await w.race('other', 'rk_late')), raceId: 'rk_late2' })).toMatchObject({ skipped: 'deleted' });
    expect(await w.svc.teamGoalReward(uid, '2026-12-14', 'team_1', 2, 12)).toBeNull();
    expect(await w.svc.tournamentClose(uid, 'cup_late', 1, { freeCoins: 50 }, '冬杯', horse.id)).toMatchObject({ status: 'already' });
    expect(await w.svc.replayShared(uid, 'other')).toBeNull();
    expect(w.repo.data.has(uid)).toBe(false);
    expect(w.hallDir.rows.has(uid)).toBe(false);
  });
});
