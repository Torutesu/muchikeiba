import { describe, expect, it } from 'vitest';
import { CMD, RaceRoomCore, type Outbound } from '../src/domain/raceRoom.js';
import { seededRng } from '../src/domain/rng.js';
import { replayLogSchema, type InputTriple } from '../src/domain/schemas.js';
import { makeConfig } from './helpers.js';

const START = 1000;
const at = (tick: number) => START + (tick + 1) * 50; // time when `tick` becomes due
const H = (c: string) => c.repeat(64).slice(0, 64);

function room(humans = 3, mode: 'ranked' | 'friend' | 'tutorial' = 'ranked', sample = 0) {
  const cfg = makeConfig(humans, mode);
  const r = new RaceRoomCore(cfg, START, { verifySampleRate: sample, resultWaitMs: 5000, rng: seededRng(7) });
  const slots = r.humanSlots;
  for (const s of slots) r.hello(s, -1, 0);
  return { r, slots, cfg };
}
const bundles = (o: Outbound[]) => o.filter((x) => x.msg.t === 'b').map((x) => x.msg as { from: number; to: number; in: InputTriple[] });

describe('RaceRoomCore tick confirmation (REQ-NET-001/003)', () => {
  it('confirms ticks by time and bundles contiguous ranges', () => {
    const { r } = room();
    expect(r.advance(START)).toEqual([]);
    expect(r.lastConfirmedTick).toBe(-1);
    const b1 = bundles(r.advance(at(9)));
    expect(r.lastConfirmedTick).toBe(9);
    expect(b1).toEqual([{ t: 'b', from: 0, to: 9, in: [] }]);
    expect(bundles(r.advance(at(10)))).toEqual([]); // only 1 new tick < bundleInterval 2
    const b2 = bundles(r.advance(at(11)));
    expect(b2[0]).toMatchObject({ from: 10, to: 11 });
  });

  it('places inputs at their target tick, OR-merges, strips server-only bits, ignores zero', () => {
    const { r, slots } = room();
    const [a, b] = [slots[0]!, slots[1]!];
    r.advance(at(1));
    r.message(a, { t: 'in', tick: 5, cmd: CMD.WHIP | CMD.CPU_TAKEOVER | CMD.HUMAN_RESUME }, at(1));
    r.message(a, { t: 'in', tick: 5, cmd: CMD.LANE_IN }, at(1));
    r.message(b, { t: 'in', tick: 4, cmd: CMD.START }, at(1));
    expect(r.message(b, { t: 'in', tick: 6, cmd: 0 }, at(1))).toEqual([]);
    const out = bundles(r.advance(at(7)));
    expect(out[0]!.in).toEqual([[4, b, CMD.START], [5, a, CMD.WHIP | CMD.LANE_IN]]);
  });

  it('shifts late inputs to the next unconfirmed tick and rejects far-future ones', () => {
    const { r, slots } = room();
    r.advance(at(10));
    r.message(slots[0]!, { t: 'in', tick: 3, cmd: CMD.WHIP }, at(10));
    expect(r.message(slots[0]!, { t: 'in', tick: 10 + 13, cmd: CMD.WHIP }, at(10))).toEqual([{ to: slots[0], msg: { t: 'err', code: 'TOO_EARLY' } }]);
    r.advance(at(12));
    expect(r.replayLog().inputs).toEqual([[11, slots[0], CMD.WHIP]]);
  });

  it('rejects unknown slots', () => {
    const { r } = room(2);
    const cpuSlot = r.config.entrants.find((e) => e.kind === 'cpu')!.slot;
    expect(r.message(cpuSlot, { t: 'in', tick: 1, cmd: 1 }, 0)[0]!.msg).toEqual({ t: 'err', code: 'NOT_IN_RACE' });
  });
});

describe('disconnect / reconnect (REQ-NET-006/007)', () => {
  it('inserts CPU_TAKEOVER after the grace period and HUMAN_RESUME on reconnect with catch-up', () => {
    const { r, slots } = room();
    const s = slots[1]!;
    r.advance(at(20));
    r.disconnect(s, at(20));
    r.advance(at(20) + 2999);
    expect(r.isCpuControlled(s)).toBe(false);
    const takeoverTick = r.lastConfirmedTick + 1; // inserted at the next unconfirmed tick
    r.advance(at(20) + 3000);
    expect(r.isCpuControlled(s)).toBe(true);
    r.advance(at(90));
    expect(r.replayLog().inputs).toContainEqual([takeoverTick, s, CMD.CPU_TAKEOVER]);
    const hello = r.hello(s, 30, at(90));
    expect(hello[0]!.msg.t).toBe('start');
    expect(hello[1]!.msg).toMatchObject({ t: 'b', from: 31, to: r.lastConfirmedTick });
    const resumeTick = r.lastConfirmedTick + 1;
    r.advance(at(95));
    expect(r.replayLog().inputs).toContainEqual([resumeTick, s, CMD.HUMAN_RESUME]);
    expect(r.isCpuControlled(s)).toBe(false);
  });

  it('takes over a human who never connected', () => {
    const cfg = makeConfig(2);
    const r = new RaceRoomCore(cfg, START, { verifySampleRate: 0, resultWaitMs: 5000, rng: seededRng(1) });
    r.hello(r.humanSlots[0]!, -1, 0);
    r.advance(START + 3000);
    expect(r.isCpuControlled(r.humanSlots[1]!)).toBe(true);
    expect(r.isCpuControlled(r.humanSlots[0]!)).toBe(false);
  });
});

describe('checksums (REQ-NET-005)', () => {
  it('flags the minority client', () => {
    const { r, slots } = room(3);
    r.advance(at(25));
    expect(r.message(slots[0]!, { t: 'chk', tick: 20, h: 'aaaaaaaaaaaaaaaa' }, at(25))).toEqual([]);
    r.message(slots[1]!, { t: 'chk', tick: 20, h: 'aaaaaaaaaaaaaaaa' }, at(25));
    const out = r.message(slots[2]!, { t: 'chk', tick: 20, h: 'bbbbbbbbbbbbbbbb' }, at(25));
    expect(out).toEqual([{ to: slots[2], msg: { t: 'desync', tick: 20 } }]);
    expect(r.desyncSlots).toEqual([slots[2]]);
  });
  it('rejects checksums for unconfirmed or misaligned ticks', () => {
    const { r, slots } = room(2);
    r.advance(at(5));
    expect(r.message(slots[0]!, { t: 'chk', tick: 20, h: 'aaaaaaaaaaaaaaaa' }, at(5))[0]!.msg).toEqual({ t: 'err', code: 'BAD_MESSAGE' });
    r.advance(at(30));
    expect(r.message(slots[0]!, { t: 'chk', tick: 21, h: 'aaaaaaaaaaaaaaaa' }, at(30))[0]!.msg).toEqual({ t: 'err', code: 'BAD_MESSAGE' });
  });
});

describe('result consensus (REQ-NET-008)', () => {
  const finish = (r: RaceRoomCore, slots: number[], hashes: string[]) => {
    r.advance(at(100));
    let out: Outbound[] = [];
    slots.forEach((s, i) => { out = r.message(s, { t: 'res', h: hashes[i]!, order: [s] }, at(100)); });
    return out;
  };

  it('confirms when all clients agree, and stops advancing', () => {
    const { r, slots } = room(3);
    const out = finish(r, slots, [H('a'), H('a'), H('a')]);
    expect(out.at(-1)!.msg).toMatchObject({ t: 'final', status: 'confirmed', h: H('a') });
    expect(r.final).toMatchObject({ status: 'confirmed', via: 'consensus', suspects: [] });
    const tick = r.lastConfirmedTick;
    r.advance(at(300));
    expect(r.lastConfirmedTick).toBe(tick);
    expect(r.message(slots[0]!, { t: 'in', tick: tick + 1, cmd: 1 }, at(300))[0]!.msg).toEqual({ t: 'err', code: 'RACE_OVER' });
  });

  it('confirms a 2/3 majority and marks the dissenter as suspect', () => {
    const { r, slots } = room(3);
    finish(r, slots, [H('a'), H('b'), H('a')]);
    expect(r.final).toMatchObject({ status: 'confirmed', hash: H('a'), suspects: [slots[1]] });
  });

  it('sends a split result to the verifier and applies its answer', () => {
    const { r, slots } = room(2);
    const out = finish(r, slots, [H('a'), H('b')]);
    expect(out.at(-1)!.msg).toMatchObject({ t: 'final', status: 'verifying' });
    expect(r.phase).toBe('verifying');
    const fin = r.applyVerification({ resultHash: H('b'), order: [1, 0], finishTicks: [10, 11], checksums: {} });
    expect(fin[0]!.msg).toMatchObject({ t: 'final', status: 'confirmed', h: H('b') });
    expect(r.final).toMatchObject({ via: 'verifier', suspects: [slots[0]] });
  });

  it('voids the race when the verifier is unavailable', () => {
    const { r, slots } = room(2);
    finish(r, slots, [H('a'), H('b')]);
    r.applyVerification(null);
    expect(r.final).toMatchObject({ status: 'void' });
  });

  it('always verifies a ranked race with a single human', () => {
    const { r, slots } = room(1, 'ranked');
    finish(r, slots, [H('a')]);
    expect(r.phase).toBe('verifying');
  });

  it('accepts a single-human friend race', () => {
    const { r, slots } = room(1, 'friend');
    finish(r, slots, [H('a')]);
    expect(r.final?.status).toBe('confirmed');
  });

  it('verifies when reported or sampled', () => {
    const a = room(3);
    a.r.report();
    finish(a.r, a.slots, [H('a'), H('a'), H('a')]);
    expect(a.r.phase).toBe('verifying');
    const b = room(3, 'ranked', 1);
    finish(b.r, b.slots, [H('a'), H('a'), H('a')]);
    expect(b.r.phase).toBe('verifying');
  });

  it('stops confirming ticks at the first result and decides when everyone reported', () => {
    const { r, slots } = room(3);
    r.advance(at(100));
    const out = r.message(slots[0]!, { t: 'res', h: H('a'), order: [0] }, at(100));
    expect(r.phase).toBe('awaitingResults');
    expect(out.every((o) => o.msg.t !== 'final')).toBe(true);
    r.advance(at(150));
    expect(r.lastConfirmedTick).toBe(100);
    r.message(slots[1]!, { t: 'res', h: H('a'), order: [0] }, at(150));
    const fin = r.message(slots[2]!, { t: 'res', h: H('a'), order: [0] }, at(150));
    expect(fin.at(-1)!.msg).toMatchObject({ t: 'final', status: 'confirmed' });
    expect(r.replayLog().endTick).toBe(100);
  });

  it('stops at maxTicks and decides after the result wait', () => {
    const { r, slots } = room(3);
    const max = r.maxTicks;
    r.advance(at(max + 50));
    expect(r.lastConfirmedTick).toBe(max - 1);
    expect(r.phase).toBe('awaitingResults');
    r.message(slots[0]!, { t: 'res', h: H('a'), order: [0] }, at(max + 50));
    r.message(slots[1]!, { t: 'res', h: H('a'), order: [0] }, at(max + 50));
    expect(r.advance(at(max + 50) + 4999)).toEqual([]);
    const out = r.advance(at(max + 50) + 5000);
    expect(out[0]!.msg).toMatchObject({ t: 'final', status: 'confirmed' });
  });
});

describe('replay log & persistence', () => {
  it('produces a schema-valid, sorted log and survives a JSON round trip', () => {
    const { r, slots } = room(3);
    for (let t = 0; t < 200; t += 7) {
      r.advance(at(t));
      r.message(slots[t % 3]!, { t: 'in', tick: t + 3, cmd: 1 << (t % 6) }, at(t));
      r.message(slots[(t + 1) % 3]!, { t: 'in', tick: t + 3, cmd: CMD.WHIP }, at(t));
    }
    const copy = RaceRoomCore.fromJSON(JSON.parse(JSON.stringify(r.toJSON())), seededRng(7));
    const a = r.advance(at(260));
    const b = copy.advance(at(260));
    expect(b).toEqual(a);
    const log = r.replayLog();
    expect(() => replayLogSchema.parse(log)).not.toThrow();
    expect(log.endTick).toBe(260);
    expect(copy.replayLog()).toEqual(log);
  });
});
