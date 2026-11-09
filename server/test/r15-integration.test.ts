/**
 * Round 15 integration: how the four Round 15 features (§38 photo mode, §39 pre-race advice, §40 activity, §41
 * accessibility) meet Round 14 (§34..§37) and each other.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MemoryPlayerRepo, PlayerService } from '../src/domain/service.js';
import { seededRng } from '../src/domain/rng.js';
import { m, makeConfig } from './helpers.js';
import { MemoryReplayStore, MyReplaysService } from '../src/domain/myReplaysService.js';
import { maskedPlayerId, replayDataOf, sourceReplayKey } from '../src/domain/myReplays.js';
import { settleRace } from '../src/race/orchestrate.js';
import { friendIdsFrom, type PlayerInvoker } from '../src/http/app.js';
import type { RaceStartConfig } from '../src/domain/schemas.js';
import { ensureExchange, exchangeProblems } from '../src/domain/exchange.js';
import { classifyLedger } from '../src/domain/history.js';
import { grantFree } from '../src/domain/wallet.js';
import { catalogFor, localize, untranslated } from '../src/i18n/catalog.js';
import type { EventDef, Master } from '../src/domain/master.js';
import { photoInputSchema, type PhotoInput } from '../src/domain/photoMode.js';
import { BETTING_WORDS_EN, BETTING_WORDS_JA } from '../src/domain/bettingWords.js';
import * as packs from '../src/domain/commentaryPacks.js';
import { adviceTextProblems } from '../src/domain/raceAdvice.js';

// ------------------------------------------------------------------------------------------------ §39 × §36

describe('§39 advice lint × §36 commentary lint: one betting-word list (REQ-ADV-004, REQ-CMT-004)', () => {
  it('the commentary lint reads the shared list (the same arrays, not a copy)', () => {
    expect(packs.BETTING_WORDS_JA).toBe(BETTING_WORDS_JA);
    expect(packs.BETTING_WORDS_EN).toBe(BETTING_WORDS_EN);
  });
  it('the advice lint refuses every shared betting word, Japanese and English', () => {
    for (const w of BETTING_WORDS_JA) expect(adviceTextProblems(`この馬は${w}`).length, w).toBeGreaterThan(0);
    for (const s of ['place a bet', 'betting tips', 'the bettor', 'good odds', 'a wager', 'payout', 'gambling', 'jackpot', 'bookmaker', 'punters', 'trifecta', 'each-way', 'the favourites', 'long shots', 'stake money']) {
      expect(adviceTextProblems(s).length, s).toBeGreaterThan(0);
      expect(packs.commentaryTextProblems(s, 'en').some((x) => x.startsWith('betting word')), s).toBe(true);
    }
  });
  it('the \\bbet fix holds in both lints: better / between / alphabet / Betty are not betting words', () => {
    for (const s of ['a better line', 'between the horses', 'alphabet', 'Betty runs']) {
      expect(adviceTextProblems(s), s).toEqual([]);
      expect(packs.commentaryTextProblems(s, 'en').filter((x) => x.startsWith('betting word')), s).toEqual([]);
    }
  });
});

// ------------------------------------------------------------------------------------------------ shared worlds

const ROOT = join(import.meta.dirname, '..', '..');
const exEvent = m.events.find((e) => e.exchange)!;
/** A sample exchange line (test only: no live config ships one). */
const withExchangeLine = (line: NonNullable<EventDef['exchange']>['items'][number]): EventDef => ({
  ...exEvent, exchange: { ...exEvent.exchange!, items: [...exEvent.exchange!.items, line] },
});

/** Players, R2 (source logs + saved replays) and マイリプレイ with the friends port, wired like the Durable Objects. */
function fullWorld(start = exEvent.startAtMs + 3_600_000, master: Master = m) {
  let now = start;
  const repo = new MemoryPlayerRepo();
  const svc = new PlayerService(repo, { master, rng: seededRng(15), clock: () => now, verifiers: {} });
  let gate: Promise<unknown> = Promise.resolve();
  const invoker: PlayerInvoker = { invoke: (async (method: string, ...args: unknown[]) => {
    const run = gate.then(() => (svc as unknown as Record<string, (...a: unknown[]) => unknown>)[method]!.apply(svc, args));
    gate = run.catch(() => undefined);
    return run;
  }) as PlayerInvoker['invoke'] };
  const player = () => invoker;
  const store = new MemoryReplayStore();
  const replays = new MyReplaysService(() => master, player, store, friendIdsFrom(player));
  /** A confirmed ranked race ridden by `uid` (the human slot, 1st): the room writes the log, settleRace settles it. */
  const race = async (uid: string, raceId: string) => {
    const c0 = makeConfig(1, 'ranked', 11) as RaceStartConfig;
    const entrants = c0.entrants.map((e) => (e.kind === 'human' ? { ...e, playerId: uid } : e));
    const c = { ...c0, raceId, entrants };
    const log = { v: 1 as const, config: c, endTick: 1500, inputs: [[60, 0, 1]] as [number, number, number][] };
    await store.put(sourceReplayKey(raceId), JSON.stringify(log));
    const human = c.entrants.find((e) => e.kind === 'human')!.slot;
    const order = [human, ...c.entrants.filter((e) => e.slot !== human).map((e) => e.slot)];
    const results = settleRace(c, { status: 'confirmed', order, hash: 'c'.repeat(64), via: 'consensus', suspects: [] }, {}, log);
    await svc.applyRace(uid, results[uid]!);
    return results[uid]!;
  };
  const befriend = (a: string, b: string) => {
    for (const [x, y] of [[a, b], [b, a]] as const) { const s = repo.get(x)!; if (!s.friends.ids.includes(y)) s.friends.ids.push(y); repo.put(s); }
  };
  return { svc, repo, store, replays, race, befriend, now: () => now, advance: (ms: number) => { now += ms; } };
}

const photoInput = (over: Partial<PhotoInput['source']> = {}): PhotoInput => ({
  source: { kind: 'replay', mode: 'ranked', raceId: 'rk_ph', tick: 640, ...over },
  camera: { focusSlot: 0, orbitDeg: 30, distanceDm: 60, heightDm: 15, fovDeg: 40, dof: 1 },
  lookId: 'film', frameId: 'plain', stamps: [], caption: null, names: 'masked', hideUi: true,
});

// ------------------------------------------------------------------------------------------------ §38 × §37

describe('§38 photo mode × §37 my replays (REQ-PHOTO-002/008, REQ-MYRP-008)', () => {
  it('a photo record may point at one of the player\'s saved replays; the list says whether that replay is still saved', async () => {
    const w = fullWorld();
    await w.svc.bootstrap('p');
    await w.race('p', 'rk_ph');
    await w.replays.save('p', 'rk_ph', null, 'c:s1');
    const r = await w.svc.photoSave('p', photoInput({ replayId: 'rk_ph' }), 'c:ph1');
    expect(r.photo.source).toMatchObject({ kind: 'replay', raceId: 'rk_ph', replayId: 'rk_ph' });
    expect((await w.svc.photos('p')).photos[0]).toMatchObject({ id: r.photo.id, replaySaved: true });
    // the replay is deleted later: the photo stays (a pointer for re-rendering), the list no longer offers the replay
    await w.replays.remove('p', 'rk_ph');
    expect((await w.svc.photos('p')).photos[0]).toMatchObject({ id: r.photo.id, replaySaved: false });
  });
  it('refuses a replay id that is not one of the player\'s saved replays, or on a non-replay source', async () => {
    const w = fullWorld();
    await w.svc.bootstrap('p');
    await w.race('p', 'rk_ph');
    await expect(w.svc.photoSave('p', photoInput({ replayId: 'rk_ph' }), 'c:ph2')).rejects.toMatchObject({ code: 'NOT_FOUND' }); // recent, not saved
    await w.replays.save('p', 'rk_ph', null, 'c:s1');
    await expect(w.svc.photoSave('p', photoInput({ kind: 'result', replayId: 'rk_ph' }), 'c:ph3')).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(w.svc.photoSave('p', photoInput({ raceId: 'rk_other', replayId: 'rk_ph' }), 'c:ph4')).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(photoInputSchema.safeParse({ ...photoInput(), source: { ...photoInput().source, replayId: 'bad id!' } }).success).toBe(false);
  });
  it('a saved replay names other players p<slot> through the one shared helper (maskedPlayerId)', () => {
    const c0 = makeConfig(2, 'ranked', 10) as RaceStartConfig;
    let k = 0;
    const entrants = c0.entrants.map((e) => (e.kind === 'human' ? { ...e, playerId: k++ === 0 ? 'p' : 'stranger' } : e));
    const file = { v: 1 as const, log: { v: 1 as const, config: { ...c0, raceId: 'rk_mask', entrants }, endTick: 1500, inputs: [] }, resultHash: 'c'.repeat(64) };
    const out = replayDataOf(m, 'p', 'me', file as never, { raceId: 'rk_mask', replayTitle: null, slot: 0, rulesetVersion: '1.3' });
    const other = entrants.find((e) => e.kind === 'human' && e.playerId === 'stranger')!;
    expect(out.replayLog.config.entrants.find((e) => e.slot === other.slot)!.playerId).toBe(maskedPlayerId(other.slot));
    expect(maskedPlayerId(3)).toBe('p3');
    // the C# side: PhotoNames.Masked delegates to the §37 helper (one implementation per language)
    const photoCs = readFileSync(join(ROOT, 'engine/Muchi.Client/PhotoMode.cs'), 'utf8');
    expect(photoCs).toMatch(/Masked\(int slot\) => ReplayPrivacy\.MaskedId\(slot\)/);
  });
});

// ------------------------------------------------------------------------------------------------ §38 × §33 / §30

describe('§38 photo cosmetics × §33 coin history × §30 event exchange (REQ-PHOTO-005, REQ-HIST-003, REQ-EXCH-002)', () => {
  it('a photo frame purchase shows a readable category in Japanese and English', async () => {
    const w = fullWorld();
    await w.svc.bootstrap('p');
    const s = w.repo.get('p')!;
    grantFree(s, 500, w.now(), 'test', 't');
    w.repo.put(s);
    await w.svc.buyCosmetic('p', 'photo_frame_sakura', 'c:k1');
    const row = classifyLedger(m, w.repo.get('p')!.ledger.at(-1)!);
    expect(row).toEqual({ category: 'shop', title: 'ショップで購入（写真フレーム「桜吹雪」）' });
    const en = localize(row.title, 'en', catalogFor(m));
    expect(untranslated(en)).toEqual([]);
    expect(en).toMatch(/^Shop purchase \(/);
  });
  it('a photo frame is a valid cosmetic exchange line; taken from the exchange it is unlocked in photo mode', async () => {
    const ev = withExchangeLine({ id: 'ex_ph_sakura', name: '写真フレーム', kind: 'cosmetic', price: 300, stock: 1, reward: { items: [{ itemId: 'photo_frame_sakura', qty: 1 }] } });
    expect(exchangeProblems(m, ev, [ev])).toEqual([]);
    const master = { ...m, events: m.events.map((e) => (e.id === ev.id ? ev : e)) } as Master;
    const w = fullWorld(ev.startAtMs + 3_600_000, master);
    await w.svc.bootstrap('p');
    const frame = async () => ((await w.svc.photoCatalog('p')) as { frames: { id: string; unlocked: boolean }[] }).frames.find((f) => f.id === 'sakura')!;
    expect((await frame()).unlocked).toBe(false);
    const s = w.repo.get('p')!;
    ensureExchange(master, s, ev).points = 300;
    w.repo.put(s);
    await w.svc.exchangeBuy('p', ev.id, 'ex_ph_sakura', 1, 'c:x1');
    expect((await frame()).unlocked).toBe(true);
  });
});

// ------------------------------------------------------------------------------------------------ §40 × §37

describe('§40 activity × §37 my replays (REQ-ACT-002/011, REQ-MYRP-010)', () => {
  it('making a saved replay public writes one replay_share entry to each friend (never twice, never to a friend who blocked the owner)', async () => {
    const w = fullWorld();
    for (const u of ['owner', 'f1', 'f2', 'stranger']) await w.svc.bootstrap(u);
    w.befriend('owner', 'f1'); w.befriend('owner', 'f2');
    await w.svc.feedMute('f2', 'owner', true); // f2 blocked the owner (the team-feed mute list is the block list)
    await w.race('owner', 'rk_pub');
    await w.replays.save('owner', 'rk_pub', null, 'c:s1');
    await w.replays.update('owner', 'rk_pub', { public: true });
    await w.replays.update('owner', 'rk_pub', { public: false });
    await w.replays.update('owner', 'rk_pub', { public: true }); // off and on again: still one entry
    await w.replays.update('owner', 'rk_pub', { favorite: true }); // not a share
    const items = async (u: string) => (await w.svc.activity(u)).items.filter((x) => x.kind === 'replay_share');
    const f1 = await items('f1');
    expect(f1).toHaveLength(1);
    expect(f1[0]).toMatchObject({ kind: 'replay_share', category: 'friends', link: { screen: 'replay', id: 'owner' } });
    expect(f1[0]!.actors.map((a) => a.playerId)).toEqual(['owner']);
    expect(await items('f2')).toEqual([]);
    expect(await items('stranger')).toEqual([]);
    expect(await items('owner')).toEqual([]);
  });
});
