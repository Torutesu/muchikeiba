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
import type { Style } from '../../../server/src/domain/master.js';
import tracksJson from '../../../server/master/tracks.json';

const trackNames = new Map((tracksJson as { tracks: { id: string; name?: string }[] }).tracks.map((t) => [t.id, t.name ?? t.id]));

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
    classes: master.progression.classes,
    dailyMissions: master.progression.dailyMissions,
    loginBonus: master.progression.loginBonus,
    raceFreeCoinsByPlace: master.progression.raceFreeCoinsByPlace,
    seasonPointsByPlace: master.progression.seasonPointsByPlace,
    rooms: master.progression.rooms,
    tracks: master.tracks.map((t) => ({ id: t.id, name: trackNames.get(t.id) ?? t.id, surface: t.surface, distanceM: t.distanceM, lit: master.litTracks.has(t.id) })),
    ageLimits: master.ageLimits,
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
  claimMission: (missionId: string) => wrap(() => svc.claimMission(ID, missionId, key())),
  // Breeding (REQ-HORSE-008): the same preview/breed functions as the server, against the local player.
  retire: (horseId: string) => wrap(() => svc.retire(ID, horseId)),
  breedingPreview: (sireId: string, damId: string) => wrap(() => svc.breedingPreview(ID, sireId, damId)),
  breed: (sireId: string, damId: string, useMaterial = false) => wrap(() => svc.breed(ID, sireId, damId, key(), useMaterial)),
  // Friend room conditions (REQ-ROOM-002): validated and stored by the real presets rules.
  presets: () => wrap(() => svc.presets(ID)),
  setRoomConditions: (c: Parameters<PlayerService['setRoomConditions']>[1]) => wrap(() => svc.setRoomConditions(ID, c)),
  // Settles a race run on the device (WASM engine) through the real reward rules: coins by place, season
  // points, pass XP and mission progress. Offline: there is no rating update and no server verification.
  applyRace: (raceId: string, place: number, fieldSize: number, details: { trackId: string; style: Style; finishTick: number | null; whips: number }) =>
    wrap(() => svc.applyRace(ID, { raceId, mode: 'ranked', place, fieldSize, newRating: null, void: false, humans: 1,
      details: { ...details, startReactionTicks: null, whipMashed: false, cpuAssisted: false } })),
  reset() { try { localStorage.removeItem(KEY + ':' + ID); } catch { /* ignore */ } },
  playerView,
};

(globalThis as unknown as { MuchiLogic: typeof MuchiLogic }).MuchiLogic = MuchiLogic;
