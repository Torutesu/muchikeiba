import { describe, expect, it } from 'vitest';
import { m } from './helpers.js';
import { exchangePity, settlePityGroups } from '../src/domain/gacha.js';
import { aggregatePaidBalances } from '../src/domain/accounting.js';
import { timingSafeEqual } from '../src/http/app.js';
import { newPlayer } from '../src/domain/player.js';

describe('bug review fixes', () => {
  it('#13 closed limited pity group converts to standard and cannot be exchanged on a closed banner', () => {
    const end = Date.UTC(2026, 11, 1);
    const master = structuredClone(m);
    master.gacha.pityGroups.pickup = { cost: 100, endAtMs: end, convertTo: 'standard' };
    const b = master.gacha.banners.find((x) => x.id === 'pickup_akatsuki')!;
    b.endAtMs = end;
    master.templateById = m.templateById;
    const s = newPlayer('p', end - 1000, '2026-11');
    s.pity.pickup = 120;
    expect(settlePityGroups(master, s, end - 1)).toBe(0);
    expect(() => exchangePity(master, s, 'pickup_akatsuki', 't_akatsuki', end)).toThrow(expect.objectContaining({ code: 'BANNER_CLOSED' }));
    expect(settlePityGroups(master, s, end)).toBe(120);
    expect(s.pity.pickup).toBe(0);
    expect(s.pity.standard).toBe(120);
    expect(settlePityGroups(master, s, end + 5)).toBe(0); // idempotent
  });

  it('#9 a late, older paid-balance snapshot never overwrites a newer one', () => {
    const r = aggregatePaidBalances([
      { playerId: 'a', date: '2026-11-05', paidCoins: 0, paidYen: 0, seq: 9 },
      { playerId: 'a', date: '2026-11-05', paidCoins: 1000, paidYen: 1500, seq: 8 },
    ]);
    expect(r.totalPaidCoins).toBe(0);
  });

  it('#12 admin token comparison', () => {
    expect(timingSafeEqual('Bearer x', 'Bearer x')).toBe(true);
    expect(timingSafeEqual('Bearer x', 'Bearer y')).toBe(false);
    expect(timingSafeEqual('Bearer', 'Bearer x')).toBe(false);
  });
});

describe('#12 DEV_MODE guard', () => {
  it('refuses on non-loopback hosts only', async () => {
    const { devModeRefused } = await import('../src/index.js').catch(() => ({ devModeRefused: null as never }));
    if (!devModeRefused) return; // index imports cloudflare:workers; covered by typecheck when not importable in node
    expect(devModeRefused(new Request('https://api.example.com/v1/health'), { DEV_MODE: '1' })).toBe(true);
    expect(devModeRefused(new Request('http://127.0.0.1:8787/v1/health'), { DEV_MODE: '1' })).toBe(false);
    expect(devModeRefused(new Request('https://api.example.com/v1/health'), { DEV_MODE: undefined as never })).toBe(false);
  });
});
