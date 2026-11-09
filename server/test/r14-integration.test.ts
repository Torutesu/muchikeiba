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
import { m } from './helpers.js';
import { ensureExchange, exchangeProblems } from '../src/domain/exchange.js';
import { ownsPart } from '../src/domain/silksEditor.js';
import { classifyLedger } from '../src/domain/history.js';
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
