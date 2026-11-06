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
import { shopProducts } from '../../../server/src/domain/shop.js';
import { buildRaceConfig, toRaceHorse } from '../../../server/src/domain/raceConfig.js';
import { groundFor } from '../../../server/src/domain/ground.js';
import { skillCatalog, horseSkill, skillView } from '../../../server/src/domain/skills.js';
import { classDef } from '../../../server/src/domain/season.js';
import { startTimeAttack } from '../../../server/src/domain/timeAttack.js';
import { createHorseFromTemplate } from '../../../server/src/domain/horses.js';
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
// Demo clock (REQ-UXP-002 home states 初日 / 3日目 / 7日目): the real rules run on Date.now() + whole days, so
// unlocks by day, the beginner login bonus and the season end all come from the server code, not from the UI.
const DAY_KEY = 'muchi.proto.dayOffset';
const DAY_MS = 86_400_000;
let dayOffset = (() => { try { return Math.max(0, parseInt(localStorage.getItem(DAY_KEY) ?? '0', 10) || 0); } catch { return 0; } })();
const now = () => Date.now() + dayOffset * DAY_MS;
// a blank player state to build demo ghost riders' horses on (never stored)
let blank: PlayerState | null = null;
const svcStateTemplate = () => blank!;
const svc = new PlayerService(new LocalRepo(), { master, rng: cryptoRng, clock: now, verifiers: {} });
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
    itemLabels: (master.shopDisplay?.itemLabels ?? {}) as Record<string, string>,
    passRewards: master.progression.passRewards,
    unlocks: master.progression.unlocks,
    beginnerLoginBonus: master.progression.beginnerLoginBonus,
    beginnerRaces: master.progression.beginnerRaces,
  },
  odds: (bannerId: string) => oddsDisclosure(master, findBanner(master, bannerId)),
  async bootstrap() {
    const r = await wrap(() => svc.bootstrap(ID));
    if (!blank) { const st = structuredClone(await svc.state(ID)); st.horses = []; blank = st; }
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
  reset() { try { localStorage.removeItem(KEY + ':' + ID); localStorage.removeItem(DAY_KEY); } catch { /* ignore */ } dayOffset = 0; },

  // ---------------------------------------------------------------- round 8 (docs/planning/06, REQ-UXS-*), used by unity.html
  now,
  dayOffset: () => dayOffset,
  setDayOffset(days: number) { dayOffset = Math.max(0, Math.floor(days)); try { localStorage.setItem(DAY_KEY, String(dayOffset)); } catch { /* ignore */ } },
  consentVersions: master.progression.consent,
  // REQ-UXS-001: the terms/privacy versions agreed to and when
  recordConsent: () => wrap(() => svc.recordConsent(ID, master.progression.consent!.termsVersion, master.progression.consent!.privacyVersion)),
  // REQ-UXS-002: the horse ridden in the tutorial (t_partner) is granted and named in one step, apart from the free 10-pull
  grantPartner: (name: string) => wrap(() => svc.grantPartner(ID, name, key())),
  partnerTemplate: (() => { const t = master.templateById.get(master.progression.partner?.templateId ?? ''); return t ? { id: t.id, name: t.name, rarity: t.rarity, style: t.style, stats: t.stats, skillId: t.skillId ?? null } : null; })(),
  // REQ-UXS-022 shop display data and REQ-UXS-017 offers (server-built labels; no 「倍」 wording is made on the client)
  shopProducts: () => shopProducts(master),
  shopOffers: () => wrap(() => svc.shopOffers(ID)),
  markOfferViewed: (offerId: string) => wrap(() => svc.markOfferViewed(ID, offerId)),
  allowance: () => svc.allowance(ID),
  claimAllowance: () => wrap(() => svc.claimAllowance(ID, key())),
  claimPass: (track: 'free' | 'premium', level: number) => wrap(() => svc.claimPass(ID, track, level, key())),
  firstWinBonus: () => svc.firstWinBonus(ID),
  cosmetics: () => svc.cosmetics(ID),
  bond: (horseId: string) => wrap(() => svc.bond(ID, horseId)),
  // REQ-UXS-040: account deletion (two steps, 14-day cancel window); purchases and offers are blocked meanwhile
  requestDeletion: (token: string | null) => wrap(() => svc.requestDeletion(ID, token)),
  cancelDeletion: () => wrap(() => svc.cancelDeletion(ID)),
  // REQ-UXS-050: unique skills, texts generated from the values the engine uses
  skills: () => skillCatalog(master),
  horseSkill: (h: { skillId?: string; templateId?: string }) => { const d = horseSkill(master, h as never); return d ? skillView(master, d) : null; },
  /**
   * A beginner / ranked race built by the server's own buildRaceConfig (REQ-MM-005, REQ-UXS-003): the partner at the
   * class stat cap, CPU horses from the master with their skills (ruleset 1.3.0, capped like ranked), the day's going.
   * The WASM engine runs it offline (MuchiRace.StartConfig).
   */
  async raceConfig(horseId: string, trackId: string | null) {
    const s = await svc.state(ID);
    const h = s.horses.find((x) => x.id === horseId);
    if (!h) throw new Error('horse ' + horseId);
    const beginner = s.rating.rankedRaces < master.progression.beginnerRaces;
    const bm = master.progression.beginnerMatch;
    const tId = trackId ?? master.tracks[Math.floor(Math.random() * master.tracks.length)]!.id;
    const config = buildRaceConfig(master, {
      raceId: 'proto_' + Date.now().toString(36), mode: 'ranked', trackId: tId, statCap: classDef(master, s.season.classId).statCap,
      humans: [{ playerId: ID, horse: toRaceHorse(master, h), cpuLevel: 3 }], cpuCount: 11, cpuLevel: beginner && bm ? bm.cpuLevel : 3,
      rng: cryptoRng, ground: groundFor(master, tId, 'ranked', now()),
      ...(beginner && bm ? { cpuStatPermille: bm.cpuStatPermille } : {}),
    });
    return { config, beginner, trackName: trackNames.get(tId) ?? tId };
  },
  /**
   * Time attack (REQ-TA-001/002/009): the session config exactly as the server issues it (startTimeAttack: the partner at
   * timeAttack.statCap, no CPUs, the ruleset with the day's form off). Run on a copy of the state so the prototype does not
   * use up the day's attempts.
   */
  async taConfig(horseId: string, trackId: string) {
    const s = structuredClone(await svc.state(ID));
    const r = startTimeAttack(master, s, master.progression.timeAttack, trackId, horseId, 'proto_' + Date.now().toString(36), cryptoRng, now());
    return { config: r.config, trackName: trackNames.get(trackId) ?? trackId, attemptsLeft: r.attemptsLeft };
  },
  /**
   * Ghost runs for the picker demo (REQ-TA-008 lists 上位 / フレンド / 自分). The configs are built by the server's own
   * startTimeAttack for master horses ridden by demo players; the WASM engine then rides and times them (MuchiRace.TaGhosts),
   * so every time on the picker is a real simulated run. `friends: false` = a player with no friend ghosts yet (fallback).
   */
  taGhostSeeds(trackId: string, friends = true) {
    const pick = (rarity: string, k: number) => master.templates.filter((t) => t.rarity === rarity && !t.giftOnly && !t.seasonal)[k]!;
    const people: { id: string; name: string; kind: 'friends' | 'top'; t: ReturnType<typeof pick>; whips: number[] }[] = [
      { id: 'demo_friend_1', name: 'フレンドA（デモ）', kind: 'friends', t: pick('SR', 0), whips: [380, 300, 220] },
      { id: 'demo_friend_2', name: 'フレンドB（デモ）', kind: 'friends', t: pick('R', 1), whips: [600, 500, 400] },
      { id: 'demo_friend_3', name: 'フレンドC（デモ）', kind: 'friends', t: pick('SSR', 0), whips: [] },
      { id: 'demo_top_1', name: '上位1（デモ）', kind: 'top', t: pick('SSR', 1), whips: [400, 320, 240] },
      { id: 'demo_top_2', name: '上位2（デモ）', kind: 'top', t: pick('SSR', 2), whips: [360, 280, 200] },
      { id: 'demo_top_3', name: '上位3（デモ）', kind: 'top', t: pick('SR', 2), whips: [420, 340, 260] },
    ];
    return people.filter((p) => friends || p.kind !== 'friends').map((p) => {
      const s = structuredClone(svcStateTemplate());
      s.id = p.id;
      const h = createHorseFromTemplate(s, p.t, now());
      const r = startTimeAttack(master, s, master.progression.timeAttack, trackId, h.id, 'ghost_' + p.id, cryptoRng, now());
      return { id: p.id, name: p.name, horse: h.name, kind: p.kind, config: r.config, whips: p.whips };
    });
  },
  /**
   * Demo states for the home screen (REQ-UXP-002): plays `days` game days on the real rules — each day the login bonus is
   * claimed and `racesPerDay` races are settled through applyRace — then leaves the clock on the last day.
   */
  async seedDemo(days: number, racesPerDay: number[], partnerName = 'アカツキ') {
    await this.bootstrap();
    await this.recordConsent();
    let v = await svc.view(ID);
    if (!v.flags.partnerHorseId) await this.grantPartner(partnerName);
    v = await svc.view(ID);
    if (!v.flags.tutorialGachaUsed) await this.tutorialDraw();
    const places = [2, 1, 4, 3, 1, 5, 2, 6, 1, 3, 2, 7];
    let k = 0;
    for (let d = 0; d < days; d++) {
      this.setDayOffset(d);
      await this.claimLogin();
      for (let i = 0; i < (racesPerDay[d] ?? 0); i++, k++) {
        await this.applyRace(`demo_${d}_${i}`, places[k % places.length]!, 12, { trackId: 'aoba_turf_1600', style: 'sashi', finishTick: 1900, whips: 3 });
      }
    }
    return svc.view(ID);
  },
  playerView,
};

(globalThis as unknown as { MuchiLogic: typeof MuchiLogic }).MuchiLogic = MuchiLogic;
