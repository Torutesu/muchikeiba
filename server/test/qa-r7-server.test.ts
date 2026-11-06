/**
 * Regression tests for the round-7 QA findings on the server (stud lending, tournaments, league,
 * spectators, purchase bonus). Each block names the finding it pins down.
 */
import { describe, expect, it } from 'vitest';
import {
  assembleTournament, bracketSeats, cancelTournament, heatRaceId, newTournament, playerViewWithTicket, register, stepTournament,
  tournamentCore, tournamentDefSchema, advanceCount, HEAT_CREATE_LEAD_MS, HEAT_TIMEOUT_MS, MAX_ENTRANTS, MAX_BRACKET_SEATS_PER_ENTRANT,
  type HeatOutcome, type HeatSpec, type PersistHint, type Registrant, type TournamentDefInput, type TournamentPorts, type TournamentState,
} from '../src/domain/tournaments.js';
import { leagueTick, newLeague, seasonStartMs, type LeagueState } from '../src/domain/league.js';
import { commitMember, leave, newTeam, reportPoints, teamSummary, type MemberSnapshot } from '../src/domain/teams.js';
import { resolveBundle } from '../src/ops/config.js';
import { RateLimiter } from '../src/ops/admin.js';
import { admitSpectator, SpectateService, SPECTATE_RATE, type LiveRace } from '../src/domain/spectate.js';
import { MemoryPlayerRepo, PlayerService } from '../src/domain/service.js';
import { MemoryStudDirectory, StudService, type StudPlayers } from '../src/domain/studService.js';
import { studHeldFree, STUD_PURCHASE_HOLD_DAYS } from '../src/domain/stud.js';
import { studPlayersFrom, handle, type AppContext, type PlayerInvoker } from '../src/http/app.js';
import { assignmentsFor, createRace, TICKET_TTL_MS } from '../src/race/orchestrate.js';
import { signTicket, verifyTicket } from '../src/http/ticket.js';
import { createHorseFromTemplate } from '../src/domain/horses.js';
import { seededRng } from '../src/domain/rng.js';
import { grantFree } from '../src/domain/wallet.js';
import { AppError } from '../src/domain/errors.js';
import type { PlayerState, PurchaseRecord } from '../src/domain/player.js';
import { toRaceHorse } from '../src/domain/raceConfig.js';
import { freshPlayer, m } from './helpers.js';

const NOW = Date.UTC(2026, 10, 5, 3);
const code = async (p: Promise<unknown>) => {
  try { await p; } catch (e) { return (e as AppError).code; }
  return 'NO_ERROR';
};

// ================================================================= stud lending (#1, #9, #10)

function studWorld() {
  const clock = { now: NOW };
  const svc = new PlayerService(new MemoryPlayerRepo(), { master: m, rng: seededRng(9), clock: () => clock.now, verifiers: {} });
  const invoker: PlayerInvoker = { invoke: (async (method: string, ...args: unknown[]) => (svc as unknown as Record<string, (...a: unknown[]) => unknown>)[method]!.apply(svc, args)) as PlayerInvoker['invoke'] };
  const ports: StudPlayers = studPlayersFrom(() => invoker);
  return { svc, clock, invoker, ports, stud: new StudService(ports, new MemoryStudDirectory()) };
}
const retired = (s: PlayerState, tpl: string, now: number) => { const h = createHorseFromTemplate(s, m.templateById.get(tpl)!, now); h.status = 'retired'; return h; };
const snapshot = (w: ReturnType<typeof studWorld>, id: string) => w.svc.tx(id, null, (s) => structuredClone(s));

/** owner "o": a cheap public stallion X and a friends-only stallion Y; borrower "b" (not a friend): a mare and 500 free. */
async function studSetup(w: ReturnType<typeof studWorld>, free = 500) {
  let X = '', Y = '';
  await w.svc.tx('o', null, (s, now) => { X = retired(s, 't_kawarabi', now).id; Y = retired(s, 't_ginga', now).id; return null; });
  const mare = await w.svc.tx('b', null, (s, now) => { if (free) grantFree(s, free, now, 'test', 'seed'); return retired(s, 't_kohaku', now); });
  await w.stud.list('o', X, 'public', 0, 3);
  await w.stud.list('o', Y, 'friends', 100, 1);
  return { X, Y, mare: mare.id };
}

describe('QA r7 #1: a reused idempotency key cannot switch the stallion', () => {
  it('a held reservation for another horse (or borrower) is a CONFLICT; nothing is charged or bred', async () => {
    const w = studWorld();
    const { X, Y, mare } = await studSetup(w);
    expect(await code(w.stud.preview('b', 'o', Y, mare))).toBe('FORBIDDEN'); // friends only
    // request A reserved X and is still in flight (its apply has not run yet)
    await w.ports.reserve('o', 'stud:b:same-key', 'b', X);
    // request B reuses the key for the hidden stallion Y
    expect(await code(w.stud.breed('b', 'o', Y, mare, 'same-key', false))).toBe('CONFLICT');
    // ...or another borrower id under the same op id
    expect(await code(w.ports.reserve('o', 'stud:b:same-key', 'evil', X))).toBe('CONFLICT');
    const b = await snapshot(w, 'b');
    expect(b.wallet.free).toBe(500);
    expect(b.horses.some((h) => h.studSire)).toBe(false);
    // the original request resumes on X
    const r = await w.stud.breed('b', 'o', X, mare, 'same-key', false);
    expect(r).toMatchObject({ horseId: X, fee: 0, feeStatus: 'paid' });
  });

  it('a settled op keeps its horse: the same key for another horse is a CONFLICT, for the same horse the first result', async () => {
    const w = studWorld();
    const { X, Y, mare } = await studSetup(w);
    const first = await w.stud.breed('b', 'o', X, mare, 'k1', false);
    const o = await snapshot(w, 'o');
    expect(o.stud!.settled['stud:b:k1']).toMatchObject({ horseId: X, borrowerId: 'b' });
    expect(await code(w.stud.breed('b', 'o', Y, mare, 'k1', false))).toBe('CONFLICT');
    expect((await w.stud.breed('b', 'o', X, mare, 'k1', false)).foal.id).toBe(first.foal.id);
    // the snapshot of a resumed op is the reserved horse, never the newly requested one
    const snap = await w.ports.reserve('o', 'stud:b:k1', 'b', X);
    expect(snap.horseId).toBe(X);
  });
});

describe('QA r7 #9: expectedFee → FEE_CHANGED', () => {
  it('refuses when the owner changed the fee since the borrower saw it; nothing is reserved or charged', async () => {
    const w = studWorld();
    const { X, mare } = await studSetup(w);
    await w.stud.list('o', X, 'public', 40, 1); // the owner raises the fee from 0 to 40
    const e = await w.stud.breed('b', 'o', X, mare, 'k', false, 0).catch((x: AppError) => x);
    expect(e).toBeInstanceOf(AppError);
    expect((e as AppError).code).toBe('FEE_CHANGED');
    expect((e as AppError).status).toBe(409);
    expect((await snapshot(w, 'b')).wallet.free).toBe(500);
    expect(Object.keys((await snapshot(w, 'o')).stud!.reservations)).toEqual([]); // the only daily slot stays free
    const ok = await w.stud.breed('b', 'o', X, mare, 'k2', false, 40);
    expect(ok.fee).toBe(40);
    // omitted = old clients: no check
    w.clock.now += 86_400_000; // the borrower's breedings for today are used up
    await w.stud.list('o', X, 'public', 10, 3);
    expect((await w.stud.breed('b', 'o', X, mare, 'k3', false)).fee).toBe(10);
  });

  it('over HTTP the body takes expectedFee and the error code reaches the client', async () => {
    const w = studWorld();
    const { X, mare } = await studSetup(w);
    await w.stud.list('o', X, 'public', 25, 2);
    const c = {
      master: m, player: () => w.invoker, clock: () => NOW, stud: w.stud,
      authenticate: async (req: Request) => { const u = req.headers.get('x-test-user'); if (!u) throw new AppError('UNAUTHORIZED'); return u; },
    } as unknown as AppContext;
    const res = await handle(new Request('https://x/v1/stud/breed', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-test-user': 'b', 'idempotency-key': 'h1' },
      body: JSON.stringify({ ownerId: 'o', horseId: X, damId: mare, expectedFee: 20 }),
    }), {}, c);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('FEE_CHANGED');
  });
});

describe('QA r7 #10: purchase-credited free coins cannot leave as stud fees before the refund window ends', () => {
  const purchase = (o: Partial<PurchaseRecord> = {}): PurchaseRecord => ({
    txId: 'T1', platform: 'fake', productId: 'coins_s', priceYen: 160, at: NOW, paidCoinsGranted: 100, bonusCoinsGranted: 100,
    lotId: null, refunded: false, limitBreach: false, ...o,
  });

  it('the first-purchase bonus (free) is held: a fee that would dip into it is refused, other free coins pay', async () => {
    const w = studWorld();
    const { X, mare } = await studSetup(w, 0);
    await w.svc.tx('b', null, (s, now) => { s.purchases.push(purchase()); grantFree(s, 100, now, 'first purchase bonus', 'T1', 'bonus'); return null; });
    await w.stud.list('o', X, 'public', 50, 3);
    expect(((await w.stud.preview('b', 'o', X, mare)) as { stud: { canPay: boolean; heldFree: number } }).stud).toMatchObject({ canPay: false, heldFree: 100 });
    expect(await code(w.stud.breed('b', 'o', X, mare, 'k1', false))).toBe('INSUFFICIENT_COINS');
    expect((await snapshot(w, 'o')).wallet.free).toBe(0); // nothing reached the owner
    // free coins earned in play pay the fee; the bonus stays for a refund to claw back
    await w.svc.tx('b', null, (s, now) => { grantFree(s, 60, now, 'race', 'r'); return null; });
    expect((await w.stud.breed('b', 'o', X, mare, 'k2', false)).fee).toBe(50);
    expect((await snapshot(w, 'b')).wallet.free).toBe(110);
  });

  it('the hold ends after the refund window, a refunded or paid-coin bonus holds nothing, sandbox credits are held', () => {
    const s = { purchases: [purchase()] } as unknown as PlayerState;
    expect(studHeldFree(s, NOW)).toBe(100);
    expect(studHeldFree(s, NOW + STUD_PURCHASE_HOLD_DAYS * 86_400_000 + 1)).toBe(0);
    expect(studHeldFree({ purchases: [purchase({ refunded: true })] } as unknown as PlayerState, NOW)).toBe(0);
    expect(studHeldFree({ purchases: [purchase({ bonusLotId: 'lot_b' })] } as unknown as PlayerState, NOW)).toBe(0);
    expect(studHeldFree({ purchases: [purchase({ bonusCoinsGranted: 0, sandbox: true, sandboxFreeGranted: 300 })] } as unknown as PlayerState, NOW)).toBe(300);
  });
});

// ================================================================= tournaments (#2, #3, #4, #5, #11)

const T_OPEN = NOW - 60_000;
const T_CLOSE = NOW + 10 * 60_000;
const T_START = T_CLOSE + 10 * 60_000;
type E = { playerId: string };
const tdef = (o: Partial<TournamentDefInput> = {}) => tournamentDefSchema.parse({
  id: 'cup_qa', name: 'QA杯', trackIds: ['aoba_dirt_1400'], registrationOpensAtMs: T_OPEN, registrationClosesAtMs: T_CLOSE, startsAtMs: T_START,
  heatSize: 4, fieldSize: 4, advancePerHeat: 1, maxEntrants: 16, prizes: [{ maxRank: 1, reward: { freeCoins: 500 } }], ...o,
});
const okInfo = { classId: 'C', rankedRaces: 10, style: 'senko', horseActive: true, moderation: 'ok' as const };
const reg = (p: string, rating = 1500): Registrant<E> => ({ playerId: p, displayName: p.toUpperCase(), horseId: `h_${p}`, rating, registeredAt: NOW, entry: { playerId: p } });
function field(ps: string[], o: Partial<TournamentDefInput> = {}) {
  const t = newTournament<E>(tdef(o), 'ops', NOW);
  ps.forEach((p, i) => register(t, reg(p, 1700 - i * 10), okInfo, NOW));
  return t;
}

/** Ports with hooks; heats finish in seed order unless told otherwise. */
class Ports implements TournamentPorts<E> {
  specs: HeatSpec[] = [];
  awards: string[] = [];
  onCreate: ((spec: HeatSpec) => Promise<void> | void) | null = null;
  onResult: (() => void) | null = null;
  fresh: (r: Registrant<E>) => Promise<{ entry: E; info: typeof okInfo | { classId: string; rankedRaces: number; style: string; horseActive: boolean; moderation: 'ok' | 'quarantined' | 'banned' } } | null> = async () => null;
  async refreshEntry(r: Registrant<E>) { return this.fresh(r); }
  async createHeat(spec: HeatSpec) {
    this.specs.push(spec);
    await this.onCreate?.(spec);
    return { raceId: spec.raceId, startAtMs: spec.startAtMs, slots: Object.fromEntries(spec.playerIds.map((p, i) => [p, i])) };
  }
  async heatResult(raceId: string): Promise<HeatOutcome> {
    this.onResult?.();
    const spec = this.specs.find((s) => s.raceId === raceId)!;
    const slots = spec.playerIds.map((p, i) => ({ slot: i, playerId: p }));
    return { phase: 'final', final: { status: 'confirmed', order: slots.map((s) => s.slot) }, slots, noShows: [] };
  }
  async notify() {}
  async award(pid: string) { this.awards.push(pid); }
}

describe('QA r7 #2: an admin cancel during a step is never overwritten and pays nothing', () => {
  it('cancel while the step awaits the race room: stays cancelled, no standings, no prizes, nothing persisted over it', async () => {
    const t = field(['a', 'b', 'c', 'd']);
    const p = new Ports();
    const persisted: string[] = [];
    const persist = async () => { persisted.push(t.status); };
    await stepTournament(t, T_CLOSE, p, persist);
    await stepTournament(t, T_START - HEAT_CREATE_LEAD_MS, p, persist);
    p.onResult = () => { cancelTournament(t, 'admin', T_START); }; // the admin RPC interleaves at the await
    persisted.length = 0;
    const r = await stepTournament(t, T_START + 10_000, p, persist);
    expect(t.status).toBe('cancelled');
    expect(t.cancelReason).toBe('admin');
    expect(t.standings).toBeNull();
    expect(t.payouts).toEqual({});
    expect(p.awards).toEqual([]);
    expect(persisted).toEqual([]);
    expect(r).toMatchObject({ wakeAt: null });
    expect(r.log).toContain('cancelledDuringStep');
    // later alarms do nothing
    await stepTournament(t, T_START + 3_600_000, p, persist);
    expect(p.awards).toEqual([]);
  });

  it('cancel while a heat room is being created, or during an entry refresh, stops the step too', async () => {
    for (const where of ['create', 'refresh'] as const) {
      const t = field(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
      const p = new Ports();
      await stepTournament(t, T_CLOSE, p, async () => {});
      if (where === 'create') p.onCreate = () => { cancelTournament(t, 'admin', T_START); };
      else p.fresh = async () => { cancelTournament(t, 'admin', T_START); return null; };
      await stepTournament(t, T_START - HEAT_CREATE_LEAD_MS, p, async () => {});
      expect(t.status).toBe('cancelled');
      expect(p.specs.length).toBeLessThanOrEqual(1); // the second heat is never created
      expect(t.rounds[0]!.heats.every((h) => h.status === 'planned')).toBe(true);
    }
  });
});

describe('QA r7 #3: a heat whose room creation keeps failing goes void on time', () => {
  it('the deadline counts from the round start; failed attempts never move the start', async () => {
    const t = field(['a', 'b', 'c', 'd']);
    const p = new Ports();
    p.onCreate = () => { throw new Error('room init failed'); };
    let now = T_CLOSE;
    for (let i = 0; i < 2000 && t.rounds[0]?.heats[0]?.status !== 'void'; i++) {
      const r = await stepTournament(t, now, p, async () => {});
      now = r.wakeAt ?? now + 5_000;
    }
    const h = t.rounds[0]!.heats[0]!;
    expect(h.status).toBe('void');
    expect(h.startAtMs).toBe(T_START);
    expect(now).toBeLessThanOrEqual(T_START + HEAT_TIMEOUT_MS / 4 + 10_000);
    expect(h.createAttempts).toBeGreaterThan(1);
    expect(new Set(p.specs.map((s) => s.raceId)).size).toBe(h.createAttempts); // a new room per known failure
    expect(h.creating).toBe(false);
  });
});

describe('QA r7 #5: a restart during room creation never makes a second room', () => {
  it('the raceId is deterministic per heat attempt and the attempt is durable before the room is made', async () => {
    const t = field(['a', 'b', 'c', 'd']);
    let saved = '';
    const persist = async () => { saved = JSON.stringify(t); };
    const p1 = new Ports();
    await stepTournament(t, T_CLOSE, p1, persist);
    // the object dies while createHeat is in flight (the room may exist already)
    p1.onCreate = () => new Promise<void>(() => {});
    void stepTournament(t, T_START - HEAT_CREATE_LEAD_MS, p1, persist);
    await new Promise((r) => setTimeout(r, 10));
    expect(p1.specs).toHaveLength(1);
    const firstId = p1.specs[0]!.raceId;
    expect(firstId).toBe(heatRaceId('cup_qa', '0-0', 1));
    // restart: the state as last persisted
    const t2 = JSON.parse(saved) as TournamentState<E>;
    expect(t2.rounds[0]!.heats[0]).toMatchObject({ status: 'planned', createAttempts: 1, creating: true });
    const p2 = new Ports();
    await stepTournament(t2, T_START - HEAT_CREATE_LEAD_MS + 2_000, p2, async () => {});
    expect(p2.specs.map((s) => s.raceId)).toEqual([firstId]); // the same room (init is idempotent per raceId)
    expect(t2.rounds[0]!.heats[0]).toMatchObject({ status: 'created', raceId: firstId, createAttempts: 1, creating: false });
  });

  it('createRace takes the raceId; tickets are a pure function of the room, so a resumed attempt hands out the same ones', async () => {
    const s = freshPlayer('px', NOW);
    const entry = (pid: string) => ({ playerId: pid, horse: toRaceHorse(m, createHorseFromTemplate(s, m.templates[0]!, NOW)), rating: { r: 1500, rd: 350, vol: 0.06 }, classId: 'C', statCap: 9999, moderation: 'ok' } as never);
    const a = await createRace(m, { mode: 'tournament', humans: [entry('p1'), entry('p2')], cpuCount: 2, cpuLevel: 3, rng: seededRng(1), now: NOW, ticketSecret: 's', trackId: 'aoba_dirt_1400', startAtMs: NOW + 30_000, raceId: 't-cup_qa-0-0-1' });
    expect(a.config.raceId).toBe('t-cup_qa-0-0-1');
    expect(a.assignments.p1!.wsPath).toBe('/v1/race/t-cup_qa-0-0-1/ws');
    expect(await assignmentsFor(a.config, a.startAtMs, 's')).toEqual(a.assignments);
    // the DO mints a player's ticket from (raceId, slot, start) exactly like createRace did
    const seat = a.assignments.p2!;
    expect(await signTicket({ raceId: seat.raceId, slot: seat.slot, playerId: 'p2', exp: seat.startAtMs + TICKET_TTL_MS }, 's')).toBe(seat.ticket);
  });
});

describe('QA r7 #11: eligibility is checked again when the heat is created', () => {
  it('banned/quarantined players and retired or missing horses become no-shows; an outage keeps the player', async () => {
    const t = field(['a', 'b', 'c', 'd'], { heatSize: 4, fieldSize: 6, advancePerHeat: 2 });
    const p = new Ports();
    p.fresh = async (r) => {
      if (r.playerId === 'a') return { entry: r.entry, info: { ...okInfo, moderation: 'banned' } };
      if (r.playerId === 'b') throw new AppError('HORSE_NOT_ACTIVE');
      if (r.playerId === 'c') throw new Error('player object unavailable');
      return { entry: r.entry, info: { ...okInfo, moderation: 'quarantined' } };
    };
    await stepTournament(t, T_CLOSE, p, async () => {});
    await stepTournament(t, T_START - HEAT_CREATE_LEAD_MS, p, async () => {});
    expect(p.specs[0]).toMatchObject({ playerIds: ['c'], cpuCount: 5 });
    const h = t.rounds[0]!.heats[0]!;
    expect([...h.excluded!].sort()).toEqual(['a', 'b', 'd']);
    await stepTournament(t, T_START + 10_000, p, async () => {});
    const res = Object.fromEntries(h.results!.map((x) => [x.playerId, x]));
    expect(res.c).toMatchObject({ advanced: true, noShow: false });
    for (const x of ['a', 'b', 'd']) expect(res[x]).toMatchObject({ advanced: false, noShow: true });
  });

  it('a heat where nobody is eligible any more is void without a room, and nobody advances from it', async () => {
    const t = field(['a', 'b']);
    const p = new Ports();
    p.fresh = async (r) => ({ entry: r.entry, info: { ...okInfo, horseActive: false } });
    await stepTournament(t, T_CLOSE, p, async () => {});
    await stepTournament(t, T_START - HEAT_CREATE_LEAD_MS, p, async () => {});
    expect(p.specs).toEqual([]);
    expect(t.rounds[0]!.heats[0]!.status).toBe('void');
    expect(t.rounds[0]!.heats[0]!.results!.every((x) => !x.advanced && x.noShow)).toBe(true);
  });
});

describe('QA r7 #4: tournament state size (REQ-TOUR-011)', () => {
  it('tickets are never stored; /me mints the player\'s own ticket', async () => {
    const t = field(['a', 'b', 'c', 'd']);
    const p = new Ports();
    await stepTournament(t, T_CLOSE, p, async () => {});
    await stepTournament(t, T_START - HEAT_CREATE_LEAD_MS, p, async () => {});
    const raceId = t.rounds[0]!.heats[0]!.raceId!;
    const v = await playerViewWithTicket(t, 'b', T_START, (seat, pid) => signTicket({ raceId: seat.raceId, slot: seat.slot, playerId: pid, exp: seat.startAtMs + TICKET_TTL_MS }, 's'));
    expect(await verifyTicket(v.heat!.assignment!.ticket, 's', raceId, T_START)).toMatchObject({ playerId: 'b', slot: 1 });
    expect(JSON.stringify(t)).not.toContain(v.heat!.assignment!.ticket);
  });

  it('the schema caps the field and the bracket', () => {
    expect(tournamentDefSchema.safeParse({ ...tdefInput(), maxEntrants: MAX_ENTRANTS + 1 }).success).toBe(false);
    // 12-player heats advancing 11 would race ~50 rounds: refused at full capacity, fine for a small field
    const slow = { ...tdefInput(), heatSize: 12, fieldSize: 12, advancePerHeat: 11 };
    expect(tournamentDefSchema.safeParse({ ...slow, maxEntrants: 1024 }).success).toBe(false);
    expect(tournamentDefSchema.safeParse({ ...slow, maxEntrants: 12 }).success).toBe(true);
    expect(tournamentDefSchema.safeParse({ ...tdefInput(), heatSize: 12, fieldSize: 12, advancePerHeat: 6, maxEntrants: 1024 }).success).toBe(true);
  });

  it('worst case allowed by the schema: the whole state stays under 1 MB, and each stored row is small', async () => {
    // the allowed (heatSize, advance) with the most heat seats at the maximum field
    let worst = { heatSize: 2, advance: 1, seats: 0 };
    for (let hs = 2; hs <= 12; hs++) for (let adv = 1; adv < hs; adv++) {
      const d = { advancePerHeat: adv } as never;
      const seats = bracketSeats(MAX_ENTRANTS, hs, (n) => advanceCount(d, n));
      if (seats <= MAX_BRACKET_SEATS_PER_ENTRANT * MAX_ENTRANTS && seats > worst.seats) worst = { heatSize: hs, advance: adv, seats };
    }
    const d = tournamentDefSchema.parse({
      ...tdefInput(), heatSize: worst.heatSize, fieldSize: 12, advancePerHeat: worst.advance, maxEntrants: MAX_ENTRANTS,
      prizes: Array.from({ length: 16 }, (_, i) => ({ maxRank: i === 15 ? null : i + 1, reward: { freeCoins: 100_000, items: Array.from({ length: 8 }, (_, j) => ({ itemId: `item_${'x'.repeat(50)}_${j}`, qty: 1000 })) } })),
    });
    const t = newTournament<E>(d, 'ops', NOW);
    const uid = (i: number) => `U${String(i).padStart(5, '0')}`.padEnd(28, 'x'); // Firebase uids are 28 chars
    for (let i = 0; i < MAX_ENTRANTS; i++) register(t, { ...reg(uid(i), 1500 + (i % 300)), displayName: '長'.repeat(40) }, okInfo, NOW);
    const p = new Ports();
    const writes: PersistHint[] = [];
    let now = T_CLOSE;
    for (let i = 0; i < 10_000 && t.status !== 'finished'; i++) {
      const r = await stepTournament(t, now, p, async (h) => { if (h) writes.push(h); });
      now = Math.max(now + 1_000, r.wakeAt ?? now + 1_000);
    }
    expect(t.status).toBe('finished');
    const bytes = (x: unknown) => new TextEncoder().encode(JSON.stringify(x)).length;
    const { registrants: _r, ...whole } = t;
    expect(bytes(whole)).toBeLessThan(1_000_000);
    // what the Durable Object writes: a small core, one row per heat / payout, the standings once
    expect(bytes(tournamentCore(t))).toBeLessThan(64_000);
    expect(bytes(t.standings)).toBeLessThan(1_000_000);
    expect(Math.max(...t.rounds.flatMap((r) => r.heats).map(bytes))).toBeLessThan(8_000);
    expect(writes.filter((w) => w.standings)).toHaveLength(1);
    // a payout persists only its own row (not every player's)
    for (const w of writes) if (!w.standings) expect(w.payouts?.length ?? 0).toBeLessThanOrEqual(1);
    // rows → state round trip
    const back = assembleTournament<E>(JSON.parse(JSON.stringify(tournamentCore(t))), {
      registrants: t.registrants, heats: t.rounds.flatMap((r) => r.heats).reverse(), payouts: Object.values(t.payouts), standings: t.standings,
    });
    expect(back.legacyInline).toBe(false);
    expect(back.state).toEqual(JSON.parse(JSON.stringify(t)));
  }, 60_000);

  it('a core stored by the previous build (heats, payouts and standings inline) still loads', async () => {
    const t = field(['a', 'b']);
    await stepTournament(t, T_CLOSE, new Ports(), async () => {});
    const old = { ...t, registrants: undefined } as never;
    const back = assembleTournament<E>(old, { registrants: t.registrants, heats: [], payouts: [], standings: null });
    expect(back.legacyInline).toBe(true);
    expect(back.state.rounds).toEqual(t.rounds);
  });
});
function tdefInput(): TournamentDefInput {
  return { id: 'cup_qa', name: 'QA杯', trackIds: ['aoba_dirt_1400'], registrationOpensAtMs: T_OPEN, registrationClosesAtMs: T_CLOSE, startsAtMs: T_START, heatSize: 4, fieldSize: 4, advancePerHeat: 1, maxEntrants: 16 };
}

// ================================================================= league (#6, #7)

describe('QA r7 #6: a member leaving keeps their in-window growth for the team', () => {
  const SEASON = '2026-11';
  const START = seasonStartMs(SEASON);
  const cfg = m.progression.league;
  const tcfg = m.progression.teams;
  const snap = (playerId: string, points: number): MemberSnapshot => ({ playerId, displayName: playerId, season: SEASON, points });

  it('the week score sums per-member growth inside the window; a departure no longer wipes it', () => {
    const at = START + 3_600_000;
    const A = newTeam('taaaaaa1', 'A', snap('a1', 0), 'open', '', at);
    const B = newTeam('tbbbbbb1', 'B', snap('b1', 0), 'open', '', at);
    for (const [t, ids] of [[A, ['a2', 'a3', 'spy']], [B, ['b2', 'b3', 'b4']]] as const) for (const id of ids) commitMember(t, tcfg, snap(id, 0), at);
    const sum = (now: number) => [teamSummary(A, SEASON, tcfg.memberPointsCap, now), teamSummary(B, SEASON, tcfg.memberPointsCap, now)];
    const st: LeagueState = newLeague(SEASON, cfg, {});
    const w1 = st.weeks[1]!;
    // week 1: the spy earns 300 for A
    leagueTick(st, cfg, sum(at), at);
    reportPoints(A, 'spy', SEASON, 300, 'spy');
    leagueTick(st, cfg, sum(w1.startMs + 1000), w1.startMs + 1000); // week 1 scored, week 2 opens
    // week 2: A's honest members earn 400, B's 100, the spy earns 50 more, then leaves before the window ends
    reportPoints(A, 'a1', SEASON, 200, 'a1'); reportPoints(A, 'a2', SEASON, 200, 'a2');
    reportPoints(A, 'spy', SEASON, 350, 'spy');
    reportPoints(B, 'b1', SEASON, 100, 'b1');
    leave(A, tcfg, 'spy', w1.endMs - 1000);
    leagueTick(st, cfg, sum(w1.endMs + 1000), w1.endMs + 1000);
    const match = st.weeks[1]!.matches[st.divisionOf.taaaaaa1!]!.find((x) => x.a === 'taaaaaa1' || x.b === 'taaaaaa1')!;
    const [aScore, bScore] = match.a === 'taaaaaa1' ? [match.aScore, match.bScore] : [match.bScore, match.aScore];
    expect(aScore).toBe(450); // 400 + the spy's 50 inside the window (frozen at the leave)
    expect(bScore).toBe(100);
    expect(st.table.taaaaaa1!.won).toBe(2);
  });

  it('summaries from older builds (no stints) keep the old points difference', () => {
    const st = newLeague(SEASON, cfg, {});
    const team = (id: string, points: number) => ({ teamId: id, name: id, joinPolicy: 'open' as const, members: 5, points, season: SEASON, updatedAt: 0 });
    leagueTick(st, cfg, [team('A', 10), team('B', 0)], START + 1000);
    leagueTick(st, cfg, [team('A', 50), team('B', 20)], st.weeks[0]!.endMs + 1000);
    const mt = st.weeks[0]!.matches.s3![0]!;
    expect([mt.aScore, mt.bScore]).toEqual(mt.a === 'A' ? [40, 20] : [20, 40]);
  });
});

describe('QA r7 #7: league and team rewards take free coins and items only', () => {
  const league = m.progression.league;
  const div = league.divisions[league.divisions.length - 1]!.id;
  it('a horse (or any unknown key) in a league or team reward is refused by remote config', () => {
    const lg = (reward: unknown) => ({ progression: { league: { ...league, rewards: [{ divisionId: div, maxPlace: null, reward }] } } }) as never;
    expect(() => resolveBundle(m, lg({ freeCoins: 100, horse: 't_seiya' }))).toThrow(/horse is not allowed/);
    expect(() => resolveBundle(m, lg({ freeCoins: 100, gems: 5 }))).toThrow(/gems is not allowed/);
    expect(() => resolveBundle(m, lg({ items: [{ itemId: m.items.breedingMaterial.itemId, qty: 1, extra: 1 }] }))).toThrow(/unknown key extra/);
    expect(resolveBundle(m, lg({ freeCoins: 100, items: [{ itemId: m.items.breedingMaterial.itemId, qty: 1 }] })).master.progression.league.rewards).toHaveLength(1);
    const teams = (reward: unknown) => ({ progression: { teams: { ...m.progression.teams, seasonRewards: [{ maxRank: null, reward }] } } }) as never;
    expect(() => resolveBundle(m, teams({ freeCoins: 100, horse: 't_seiya' }))).toThrow(/teams.seasonRewards\[0\].reward: horse is not allowed/);
    expect(resolveBundle(m, teams({ freeCoins: 100 })).master.progression.teams.seasonRewards).toHaveLength(1);
  });
});

// ================================================================= spectators (#8)

describe('QA r7 #8: one spectator socket per player; ticket rate limit', () => {
  it('a player\'s new socket replaces their old ones; the cap counts other players only', () => {
    const others = [{ ws: 1, playerId: 'u' }, { ws: 2, playerId: 'u' }, { ws: 3, playerId: 'v' }];
    expect(admitSpectator(others, 'u', 2)).toEqual({ admit: true, replace: [1, 2] });
    expect(admitSpectator(others, 'w', 2)).toEqual({ admit: false, replace: [] });
    expect(admitSpectator([{ ws: 1, playerId: 'u' }, { ws: 3, playerId: 'v' }], 'w', 3)).toEqual({ admit: true, replace: [] });
    // one user opening many sockets never takes more than one place
    let room: { ws: number; playerId: string | null }[] = [];
    for (let i = 0; i < 50; i++) {
      const d = admitSpectator(room, 'spammer', 3);
      room = room.filter((x) => !d.replace.includes(x.ws));
      if (d.admit) room.push({ ws: i, playerId: 'spammer' });
    }
    expect(room).toHaveLength(1);
    expect(admitSpectator(room, 'fan', 3).admit).toBe(true);
  });

  it('the spectate endpoint is rate-limited per viewer', async () => {
    const live: LiveRace = { raceId: 'r1', mode: 'ranked', startAtMs: NOW, trackId: 't', visibility: 'public', playerIds: ['x'], rating: 1500, delayMs: 10_000, title: null, tournamentId: null };
    const limiter = new RateLimiter({ read: SPECTATE_RATE, write: SPECTATE_RATE }, 'spectate');
    const clock = { now: NOW };
    const svc = new SpectateService({
      liveRaces: async () => [live], liveRace: async () => live, friendIds: async () => [],
      signTicket: (t) => signTicket(t, 's'), admit: (u, now) => limiter.take(u, 'read', now),
    }, () => clock.now);
    for (let i = 0; i < SPECTATE_RATE.capacity; i++) await svc.spectate('u', 'r1');
    expect(await code(svc.spectate('u', 'r1'))).toBe('RATE_LIMITED');
    expect(await code(svc.spectate('other', 'r1'))).toBe('NO_ERROR');
    clock.now += 6_000;
    expect(await code(svc.spectate('u', 'r1'))).toBe('NO_ERROR');
  });
});
