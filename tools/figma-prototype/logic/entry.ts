// Browser bundle of the REAL server domain logic (server/src/domain), used by the web prototype instead of mocks:
// PlayerService (gacha draws with the ppm tables, 10-pull guarantee, pity, horse naming with the NG list,
// wallet paid/free ordering, purchase-intent age checks, season pass), odds disclosure from the same tables.
// State lives in localStorage (one player, "local"). No server, no billing.
import { loadMaster } from '../../../server/src/domain/master.js';
import { PlayerService, type PlayerRepo } from '../../../server/src/domain/service.js';
import { playerView, type PlayerState } from '../../../server/src/domain/player.js';
import { oddsDisclosure, findBanner } from '../../../server/src/domain/gacha.js';
import { cryptoRng } from '../../../server/src/domain/rng.js';
import { AppError } from '../../../server/src/domain/errors.js';

const KEY = 'muchi.proto.player';
const ID = 'local';

class LocalRepo implements PlayerRepo {
  get(id: string): PlayerState | null {
    try { const j = localStorage.getItem(KEY + ':' + id); return j ? (JSON.parse(j) as PlayerState) : null; } catch { return null; }
  }
  put(s: PlayerState) { try { localStorage.setItem(KEY + ':' + s.id, JSON.stringify(s)); } catch { /* private mode: memory only */ } }
}

const master = loadMaster();
const svc = new PlayerService(new LocalRepo(), { master, rng: cryptoRng, clock: () => Date.now(), verifiers: {} });
let n = 0;
const key = () => `c:/proto:${Date.now()}:${n++}`;

async function wrap<T>(f: () => Promise<T> | T): Promise<{ ok: true; value: T } | { ok: false; code: string; message: string }> {
  try { return { ok: true, value: await f() }; }
  catch (e) {
    if (e instanceof AppError) return { ok: false, code: e.code, message: e.message };
    return { ok: false, code: 'INTERNAL', message: String((e as Error)?.message ?? e) };
  }
}

export const MuchiLogic = {
  master: {
    templates: master.templates.map((t) => ({ id: t.id, name: t.name, rarity: t.rarity, style: t.style, surface: t.surface, distMinM: t.distMinM, distMaxM: t.distMaxM, stats: t.stats })),
    banners: master.gacha.banners.map((b) => ({ id: b.id, name: b.name, currency: b.currency, priceSingle: b.priceSingle, priceTen: b.priceTen, pityGroup: b.pityGroup, pityTargets: b.pityTargets })),
    products: master.products,
    pityCost: (g: string) => master.gacha.pityGroups[g]?.cost ?? 100,
  },
  odds: (bannerId: string) => oddsDisclosure(master, findBanner(master, bannerId)),
  async bootstrap() {
    const r = await wrap(() => svc.bootstrap(ID));
    // Prototype starting balance (the Unity offline build shows the same sample wallet): free coins only.
    // adminGrant is idempotent per opKey (persistent admin op set), so this grants exactly once per device.
    await wrap(() => svc.adminGrant(ID, { freeCoins: 1200 }, 'web prototype starting balance', 'prototype', 'proto-start'));
    return r;
  },
  view: () => svc.view(ID),
  tutorialDraw: () => wrap(() => svc.tutorialDraw(ID, key())),
  draw: (bannerId: string, count: 1 | 10) => wrap(() => svc.draw(ID, bannerId, count, key())),
  pityExchange: (bannerId: string, templateId: string) => wrap(() => svc.pityExchange(ID, bannerId, templateId, key())),
  nameHorse: (horseId: string, name: string) => wrap(() => svc.nameHorse(ID, horseId, name)),
  setAge: (y: number, m: number, guardian: boolean) => wrap(() => svc.setAge(ID, y, m, guardian)),
  purchaseIntent: (productId: string) => wrap(() => svc.purchaseIntent(ID, productId)),
  passView: () => svc.passView(ID),
  missions: () => wrap(() => svc.missions(ID)),
  claimLogin: () => wrap(() => svc.claimLogin(ID, key())),
  reset() { try { localStorage.removeItem(KEY + ':' + ID); } catch { /* ignore */ } },
  playerView,
};

(globalThis as unknown as { MuchiLogic: typeof MuchiLogic }).MuchiLogic = MuchiLogic;
