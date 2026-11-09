// Browser bundle of the REAL server domain logic (server/src/domain), used by the web prototype instead of mocks:
// PlayerService (gacha draws with the ppm tables, 10-pull guarantee, pity, horse naming with the NG list,
// wallet paid/free ordering, purchase-intent age checks, season pass), odds disclosure from the same tables.
// State lives in localStorage (one player, "local"). No server, no billing.
import { loadMaster } from '../../../server/src/domain/master.js';
import { PlayerService, type PlayerRepo, type ShortfallQuery } from '../../../server/src/domain/service.js';
import type { ClientBatch } from '../../../server/src/domain/kpi.js';
import { playerView, type PlayerState } from '../../../server/src/domain/player.js';
import { oddsDisclosure, findBanner, bannerList, bannerStatus } from '../../../server/src/domain/gacha.js';
import { cryptoRng } from '../../../server/src/domain/rng.js';
import { exchangeClosesAt } from '../../../server/src/domain/exchange.js';
import { dayRule } from '../../../server/src/domain/time.js';
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
import { FakeStoreVerifier } from '../../../server/src/domain/purchase.js';
import { raceFieldSeen } from '../../../server/src/domain/collection.js';
import { deliverGift } from '../../../server/src/domain/giftBox.js';
import type { RaceStartConfig } from '../../../server/src/domain/schemas.js';
import { MemoryTeams, TeamsService, type TeamPlayers } from '../../../server/src/domain/teamService.js';
import type { ReportReason } from '../../../server/src/domain/teamFeed.js';
import { InviteService, MemoryInviteDirectory, deliverInviteOutbox, displayInviteCode, inviteRewardYen, normalizeInviteCode } from '../../../server/src/domain/invite.js';
import type { Directory } from '../../../server/src/domain/friends.js';
import { signAdMobQuery, StaticKeySource, verifyAdMobCallback } from '../../../server/src/ads/ssv.js';
import { MemoryRivalRegistry, RivalService, rivalPlayersFrom } from '../../../server/src/domain/rivalService.js';
import { noteRivalTa, prevWeekId, rivalCard, rivalTrackName, weekEndMs, weekIdAt } from '../../../server/src/domain/rival.js';
import { actorIdsOf, renderActivityItems } from '../../../server/src/domain/activity.js';
import type { PlayerInvoker } from '../../../server/src/http/app.js';
// REQ-L10N-*: the server's English tables (master/locale-en.json + i18n/en.ts), the client's (ui-en.json) and the
// prototype's own screen texts (proto-en.json), in one catalog with the server's template rules (katakana names romanized)
import { compileCatalogWith, translateText, romanizeName } from '../../../server/src/i18n/catalog.js';
import { CODE_EN } from '../../../server/src/i18n/en.js';
import uiEn from '../../../engine/Muchi.Client/Resources/Muchi/ui-en.json';
import protoEn from './proto-en.json';

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
// round 9: an extra shift (ms) so the demo can stand just before a banner's real end (not persisted)
let clockShift = 0;
const now = () => Date.now() + dayOffset * DAY_MS + clockShift;
// a blank player state to build demo ghost riders' horses on (never stored)
let blank: PlayerState | null = null;
const svcStateTemplate = () => blank!;
// round 10: a fake store so the demo can stand after a purchase (no billing: receipts are issued locally)
const store = new FakeStoreVerifier();
// round 10 (REQ-TEAMFEED-*): a demo 支部 on the real team objects (MemoryTeams = TeamCore, the TeamDO logic, in memory)
const teams = new MemoryTeams(() => master, now);
const repo = new LocalRepo();
const svc = new PlayerService(repo, {
  master, rng: cryptoRng, clock: now, verifiers: { fake: store },
  onTeamPoints: async (p) => { await teams.reportPoints(p.teamId, p.playerId, p.seasonId, p.points, p.displayName).catch(() => undefined); },
  onTeamFeed: async (p) => { await teams.feedRace(p.teamId, p.playerId, p.race); },
  // round 12 (REQ-RIVAL-*): the week registry learns candidates / withdrawals / weekly bests after each transaction
  onRival: async (u) => { await rivalSvc.apply(u); },
  // round 13 (REQ-TGOAL-*): settled results count toward the team's weekly goal (TeamCore, like TeamDO); a milestone
  // queues the team_goal push for the other members (the daily cap applies)
  onTeamGoal: async (c) => {
    const r = await teams.goalContribute(c.teamId, c);
    // round 15 (REQ-ACT-002): the same player call as TeamDO — push + activity entry
    if (r.milestone !== null) for (const to of r.notify) await svc.teamGoalMilestone(to, c.teamId, r.milestone).catch(() => undefined);
    return r;
  },
  onTeamGoalForget: async (p) => teams.goalForget(p.teamId, p.playerId),
});
// round 12 (REQ-RIVAL-*): the weekly rival on the real RivalService + an in-memory week registry (RivalWeekCore, the
// LeaderboardDO rival:<week> logic). A demo rival (demo_rv_1, ミドリカワ) registers with the local player as last week's
// candidates, so this week's pairing, head to head, time attack and the week result run the server code paths.
const rivalReg = new MemoryRivalRegistry(() => master, now);
const rivalInvoker: PlayerInvoker = { invoke: (async (m: string, ...a: unknown[]) => (svc as unknown as Record<string, (...x: unknown[]) => unknown>)[m]!.apply(svc, a)) as PlayerInvoker['invoke'] };
const rivalSvc = new RivalService(() => master, rivalPlayersFrom(() => rivalInvoker), rivalReg);
const RIVAL_DEMO = 'demo_rv_1';
let rivalRace = 0;
async function rivalDemoSeed() {
  const week = weekIdAt(master, now());
  if (rivalReg.store(week).paired()) return;
  if (!(await repo.get(RIVAL_DEMO))) {
    await svc.bootstrap(RIVAL_DEMO);
    await svc.setDisplayName(RIVAL_DEMO, 'ミドリカワ');
    await svc.grantPartner(RIVAL_DEMO, 'ハヤテ', key());
  }
  const me = await svc.state(ID);
  const them = await svc.state(RIVAL_DEMO);
  const at = now() - DAY_MS;
  for (const s of [me, them]) {
    await rivalReg.register(prevWeekId(week), { playerId: s.id, classId: me.season.classId, rating: Math.round(me.rating.r) + (s.id === ID ? 0 : 20), rankedAt: at, blocked: [], card: { ...rivalCard(master, s), classId: me.season.classId }, updatedAt: at });
  }
}
const teamPlayers: TeamPlayers = {
  prepareJoin: (u, t) => svc.teamPrepareJoin(u, t), commitJoin: (u, t) => svc.teamCommitJoin(u, t), abortJoin: (u, t) => svc.teamAbortJoin(u, t),
  addOutgoing: (u, t) => svc.teamAddOutgoing(u, t), removeOutgoing: (u, t) => svc.teamRemoveOutgoing(u, t), left: (u, t, c) => svc.teamLeft(u, t, c),
  state: (u) => svc.teamState(u), push: (u, id, v) => svc.queuePush(u, id, v),
  stampCatalog: (u) => svc.stampCatalog(u), stampCheck: (u, s) => svc.stampCheck(u, s), stampPosted: (u, s, k, t, ref) => svc.stampPosted(u, s, k, t, ref ?? null),
  feedViewer: (u, f) => svc.feedViewer(u, f), feedMutes: (u) => svc.feedMutes(u), feedMute: (u, t, m) => svc.feedMute(u, t, m),
  feedReported: (u, t, q, b, r) => svc.feedReported(u, t, q, b, r), cheerPush: (u, f, n) => svc.cheerPush(u, f, n),
  goalPlayerView: (u) => svc.goalPlayerView(u),
};
const teamsSvc = new TeamsService(() => master, teams, teamPlayers, teams, teams, cryptoRng, now);
const DEMO_MEMBERS = [['demo_tm_lead', 'ミドリカワ'], ['demo_tm_2', 'クロサキ'], ['demo_tm_3', 'ハヤテ']] as const;
let demoRace = 0;
let demoTeamId: string | null = null;
let n = 0;
const kpiLog: ClientBatch['events'] = [];
const key = () => `c:/proto:${Date.now()}:${n++}`;

async function wrap<T>(f: () => Promise<T> | T): Promise<{ ok: true; value: T } | { ok: false; code: string; message: string; details?: Record<string, unknown> }> {
  try { return { ok: true, value: await f() }; }
  catch (e) {
    // REQ-SHORT-004: `details` as the HTTP error body carries it (INSUFFICIENT_COINS → details.shortfall)
    if (e instanceof AppError) return { ok: false, code: e.code, message: e.message, ...(e.details ? { details: JSON.parse(JSON.stringify(e.details)) } : {}) };
    return { ok: false, code: 'INTERNAL', message: String((e as Error)?.message ?? e) };
  }
}

const enCatalog = compileCatalogWith({ romanize: true }, CODE_EN, master.locale?.en, (uiEn as { strings: Record<string, string> }).strings, (protoEn as { strings: Record<string, string> }).strings);

export const MuchiLogic = {
  /** REQ-L10N-*: English of a Japanese text (null when there is none); a katakana name comes back romanized. */
  l10n: { translate: (s: string) => translateText(s, enCatalog), romanize: romanizeName, size: enCatalog.exact.size },
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
    // ticket names for rewards that are not shop items (comeback track: 10連スカウト券, SR以上確定スカウト券)
    itemLabels: { ...Object.fromEntries(Object.entries(master.items.tickets).map(([k, t]) => [k, t.name])), ...(master.shopDisplay?.itemLabels ?? {}) } as Record<string, string>,
    passRewards: master.progression.passRewards,
    unlocks: master.progression.unlocks,
    beginnerLoginBonus: master.progression.beginnerLoginBonus,
    beginnerRaces: master.progression.beginnerRaces,
  },
  odds: (bannerId: string) => oddsDisclosure(master, findBanner(master, bannerId)),
  // ---------------------------------------------------------------- round 9 (06 §7 item 7, REQ-GACHA-011..015)
  // the live-ops calendar and the player's pity meter, exactly what GET /v1/gacha/banners and GET /v1/gacha/status return
  bannerList: () => bannerList(master, now()),
  bannerStatus: (bannerId: string) => bannerStatus(findBanner(master, bannerId), now()),
  gachaStatus: () => svc.gachaStatus(ID),
  /** Demo clock in ms (the banner calendar demo moves the clock to a banner's last minutes). */
  setClockMs(ms: number | null) { clockShift = ms === null ? 0 : ms - Date.now() - dayOffset * DAY_MS; },
  clockShift: () => clockShift,
  legalLinks: master.shopDisplay?.legalLinks ?? [],
  async bootstrap() {
    const r = await wrap(() => svc.bootstrap(ID));
    if (!blank) { const st = structuredClone(await svc.state(ID)); st.horses = []; blank = st; }
    // Prototype starting balance (the Unity offline build shows the same sample wallet): free coins only.
    // adminGrant is idempotent per opKey (persistent admin op set), so this grants exactly once per device.
    // REQ-BOX-001: an ops grant now arrives in the gift box; the starting balance is received at once (a second boot
    // answers ALREADY_CLAIMED, which is fine)
    const g = await wrap(() => svc.adminGrant(ID, { freeCoins: 1200 }, 'web prototype starting balance', 'prototype', 'proto-start'));
    if (g.ok && g.value.gift) await wrap(() => svc.giftClaim(ID, g.value.gift!.giftId, key()));
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
  // round 11: `config` (the race the WASM engine ran) gives the 図鑑 the CPU field it met (REQ-COL-002) and `skillFired` the
  // player's unique-skill activation (REQ-ACH-002), exactly what settleRace sends from a confirmed room
  // round 12: `assist` (whip | full) is what the rider's own `res.assist` gives the room (REQ-ASSIST-007): KPI only
  applyRace: (raceId: string, place: number, fieldSize: number, details: { trackId: string; style: Style; finishTick: number | null; whips: number; skillFired?: boolean; assist?: 'whip' | 'full' }, config?: RaceStartConfig) =>
    wrap(() => svc.applyRace(ID, { raceId, mode: 'ranked', place, fieldSize, newRating: null, void: false, humans: 1,
      details: { ...details, startReactionTicks: null, whipMashed: false, cpuAssisted: false },
      ...(config ? { seen: raceFieldSeen(config, config.entrants.find((e) => e.playerId === ID)?.slot ?? -1) } : {}) })),
  reset() {
    try {
      localStorage.removeItem(KEY + ':' + ID); localStorage.removeItem(DAY_KEY);
      // round 10: demo players of the invite screen and the invite directory start over too
      for (const k of Object.keys(localStorage)) if (k.startsWith(KEY + ':demo_')) localStorage.removeItem(k);
    } catch { /* ignore */ }
    inviteCodes.clear();
    rivalReg.weeks.clear(); // round 12: the rival week registry starts over too
    dayOffset = 0;
  },

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
  // ---------------------------------------------------------------- 調教 (REQ-TRAIN-*, contracts/protocol.md §25)
  // The real server rules: slots by game day, menus, fatigue, the potential, the beat schedule from a server seed, and the
  // deterministic re-score of the taps (times in ms after the mini-game began) with the anti-cheat bounds.
  training: () => wrap(() => svc.training(ID)),
  trainingStart: (horseId: string, menuId: string) => wrap(() => svc.trainingStart(ID, horseId, menuId, key())),
  trainingFinish: (sessionId: string, taps: number[], skipped = false) => wrap(() => svc.trainingFinish(ID, sessionId, skipped ? { taps: [], skipped: true } : { taps }, key())),
  trainingUseItem: (itemId: string, horseId: string) => wrap(() => svc.trainingUseItem(ID, itemId, horseId, key())),
  // ---------------------------------------------------------------- round 13: 週替わりチャレンジ (REQ-WCH-*, protocol §31)
  // The real server rules: the week (Monday at the game-day rollover), the rotation, the issued config (CPU field, ground,
  // normalised stats, no skills, the loan horse at the cap), and the submit path: prepare builds the replay log from the
  // ISSUED config + the validated inputs, `verify` re-simulates THAT log in the WASM engine (the C# verifier's code), and
  // record evaluates the conditions on the verified result — the device's own verdict is never sent.
  weeklyChallenges: () => wrap(() => svc.wchView(ID)),
  weeklyChallengeStart: (challengeId: string, horseId: string | null) => wrap(() => svc.wchStart(ID, challengeId, horseId ? { horseId } : { loan: true }, key())),
  async weeklyChallengeSubmit(sessionId: string, inputs: number[][], resultHash: string, verify: (logJson: string) => string) {
    return wrap(async () => {
      const prep = await svc.wchPrepare(ID, sessionId, inputs, resultHash, undefined);
      if (prep.kind === 'done') return prep.result;
      let out;
      try { out = JSON.parse(verify(JSON.stringify(prep.log))); }
      catch (e) { await svc.wchAbort(ID, sessionId); throw new AppError('VERIFIER_UNAVAILABLE', String((e as Error)?.message ?? e)); }
      const rec = await svc.wchRecord(ID, sessionId, out, resultHash);
      if ('rejected' in rec) throw new AppError('CHALLENGE_RESULT_MISMATCH', 'the server re-simulation does not match the submitted run');
      return rec;
    });
  },
  /** The stats the horse races with (base + awakening + growth) and after the class normalisation (ranked). */
  trainingRaceStats: (horseId: string) => {
    const s = repo.get(ID);
    const h = s?.horses.find((x) => x.id === horseId);
    if (!s || !h) return null;
    const cap = classDef(master, s.season.classId).statCap;
    const raw = toRaceHorse(master, h);
    const keys = ['speed', 'stamina', 'burst', 'guts', 'temper'] as const;
    const total = keys.reduce((a, k) => a + raw[k], 0);
    return { total, cap, ranked: Math.min(total, cap), capped: total > cap };
  },
  // ---------------------------------------------------------------- プレゼントボックス (REQ-BOX-*, contracts/protocol.md §26)
  // The real server rules: what arrives in the box (ops grants, compensations, tournament prizes…), expiry, hold limits,
  // keyed claims; free coins and items only.
  giftBox: (tab: 'box' | 'history' = 'box', offset = 0, limit = 50) => wrap(() => svc.giftBox(ID, tab, offset, limit)),
  giftClaim: (giftId: string) => wrap(() => svc.giftClaim(ID, giftId, key())),
  giftClaimAll: () => wrap(() => svc.giftClaimAll(ID, key())),
  /**
   * Demo state 「プレゼントボックス」: what the box looks like after a maintenance, a tournament and a promotion — delivered by
   * the real routes (a compensation under the two-person threshold, a tournament prize, a grant with no expiry, one that
   * expires in 3 days), plus one already received and one that expired (history).
   */
  async seedGifts() {
    await this.seedDemo(3, [2, 2, 2]);
    await svc.adminGrant(ID, { freeCoins: 300, items: [{ itemId: 'gacha_ticket', qty: 1 }] }, 'maintenance 11/10', 'ops', 'demo-gift-comp', true, { source: 'ops_compensation', titleKey: 'ops_compensation_maintenance' });
    await svc.tournamentClose(ID, 'demo_gift_cup', 2, { freeCoins: 150, items: [{ itemId: 'breeding_material', qty: 2 }] }, 'デモ杯');
    await svc.adminGrant(ID, { freeCoins: 50 }, 'thank-you gift', 'ops', 'demo-gift-forever', true, { expiryDays: null });
    await svc.adminGrant(ID, { items: [{ itemId: 'gacha_ticket', qty: 1 }] }, 'campaign', 'ops', 'demo-gift-soon', true, { expiryDays: 3 });
    // history: one received, one that expired yesterday (delivered 2 days ago with a 1-day expiry)
    const old = await svc.adminGrant(ID, { freeCoins: 20 }, 'earlier gift', 'ops', 'demo-gift-old', true);
    if (old.gift) await svc.giftClaim(ID, old.gift.giftId, key());
    const s = await svc.state(ID);
    deliverGift(master, s, { source: 'event', ref: 'demo:event:rank', reward: { freeCoins: 80 }, note: 'demo event', expiryDays: 1, rank: 12 }, now() - 2 * DAY_MS);
    repo.put(s);
    return svc.giftBox(ID);
  },
  // ---------------------------------------------------------------- イベント交換所 (REQ-EXCH-*, contracts/protocol.md §30)
  // The real server rules: points only from event race results (place + participation, daily cap by game day), fixed-price
  // lines with a per-player stock, the grace days after the event and the leftover conversion at the close.
  exchangeEventId: () => master.events.find((e) => e.exchange)?.id ?? null,
  events: () => wrap(() => svc.eventsView(ID)),
  exchange: (eventId: string) => wrap(() => svc.exchangeView(ID, eventId)),
  exchangeBuy: (eventId: string, itemId: string, qty = 1) => wrap(() => svc.exchangeBuy(ID, eventId, itemId, qty, key())),
  /** Demo: one confirmed event race at `place` (the race room's result path, PlayerService.applyRace with mode "event"). */
  eventDemoRace: (eventId: string, place: number) => wrap(async () => {
    const r = await svc.applyRace(ID, { raceId: `demo_ev_${now()}_${Math.floor(Math.random() * 1e6)}`, mode: 'event', eventId, place, fieldSize: 12, newRating: null, void: false, humans: 4 });
    return (r as { event?: { exchange?: { gained: number; capped: boolean; points: number; remainingToday: number } | null } | null }).event?.exchange ?? null;
  }),
  /** Demo clock for the exchange: `open` = the event's 2nd day at 12:00 JST, `grace` = the day after it ended, `closed` = after the close, null = real time. */
  exchangeDemo(phase: 'open' | 'grace' | 'closed' | null) {
    const ev = master.events.find((e) => e.exchange);
    if (!ev || phase === null) { this.setClockMs(null); return null; }
    const at = phase === 'open' ? ev.startAtMs + 36 * 3600_000 : phase === 'grace' ? ev.endAtMs + 24 * 3600_000 : exchangeClosesAt(ev, ev.exchange!, dayRule(master)) + 3600_000;
    this.setClockMs(at);
    return ev.id;
  },
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
  // ---------------------------------------------------------------- returning players (REQ-CB-001..012, contracts/protocol.md §20), index.html
  // GET /v1/comeback, the claims and the what's-new card, on the real comeback rules (server/src/domain/comeback.ts)
  comeback: () => wrap(() => svc.comeback(ID)),
  comebackClaimLogin: () => wrap(() => svc.comebackClaimLogin(ID, key())),
  comebackClaimMission: (missionId: string) => wrap(() => svc.comebackClaimMission(ID, missionId, key())),
  comebackWelcomed: () => wrap(() => svc.comebackWelcomed(ID)),
  whatsNew: () => wrap(() => svc.whatsNew(ID)),
  whatsNewSeen: (upTo: number) => wrap(() => svc.whatsNewSeen(ID, upTo)),
  pushPreferences: () => svc.pushPreferences(ID),
  setComebackPush: (on: boolean) => wrap(() => svc.setPushPreferences(ID, { categories: { comeback: on } })),
  comebackConfig: master.progression.comeback ?? null,
  /**
   * Demo state 「復帰」: 3 game days of play (6 races, past minRacesBefore), then 14 days away. The return goes through
   * bootstrap like the app, so the window (mid tier), the login track and the catch-up come from the server rules. The
   * what's-new position is put back to before the dated changelog entries so the card has something to show.
   */
  async seedComeback(awayDays = 14) {
    await this.seedDemo(3, [2, 2, 2]);
    const st = await svc.state(ID);
    if (st.comeback) { st.comeback.seenUpTo = Date.UTC(2026, 9, 25); repo.put(st); }
    this.setDayOffset(2 + awayDays);
    await this.bootstrap();
    return svc.view(ID);
  },
  playerView,

  // ---------------------------------------------------------------- round 11: 図鑑・実績・称号 (REQ-COL-*, REQ-ACH-*, contracts/protocol.md §24)
  collection: () => wrap(() => svc.collection(ID)),
  achievements: () => wrap(() => svc.achievements(ID)),
  claimAchievement: (achievementId: string, tier: number) => wrap(() => svc.claimAchievement(ID, achievementId, tier, key())),
  claimAllAchievements: () => wrap(() => svc.claimAllAchievements(ID, key())),
  titles: () => svc.titles(ID),
  equipTitle: (titleId: string | null) => wrap(() => svc.equipTitle(ID, titleId)),
  /**
   * Demo state 「図鑑」: a week of play on the real rules — races on several courses against CPU fields built by the server's
   * buildRaceConfig (so the book shows the horses and skills met as 出会った), every other race the partner's skill fires,
   * a tournament win and five stable likes from demo players — then the book, achievements and titles are all server data.
   */
  async seedCollection() {
    await this.seedDemo(3, [2, 2, 2]);
    const s = await svc.state(ID);
    const h = s.horses.find((x) => x.status === 'active') ?? s.horses[0]!;
    let k = 0;
    for (const t of master.tracks.slice(0, 5)) {
      for (let i = 0; i < 3; i++, k++) {
        const config = buildRaceConfig(master, { raceId: `demo_col_${k}`, mode: 'ranked', trackId: t.id, statCap: 3200, humans: [{ playerId: ID, horse: toRaceHorse(master, h), cpuLevel: 3 }], cpuCount: 11, cpuLevel: 3, rng: cryptoRng });
        await this.applyRace(config.raceId, [1, 3, 5][i]!, 12, { trackId: t.id, style: h.style, finishTick: 1900, whips: 3, skillFired: k % 2 === 0 }, config);
      }
    }
    await svc.tournamentClose(ID, 'demo_cup', 1, null, 'デモ杯');
    for (const from of ['demo_like_1', 'demo_like_2', 'demo_like_3', 'demo_like_4', 'demo_like_5']) await svc.stableLikeReceive(ID, from, `like:${from}:demo:1`);
    return svc.view(ID);
  },

  // ---------------------------------------------------------------- round 13: 購入履歴・コイン履歴・ガチャ履歴 (REQ-HIST-*, contracts/protocol.md §33)
  // What GET /v1/history/* and POST /v1/history/support-ticket return, on the real rules (the local state holds the whole ledger).
  history: (kind: 'summary' | 'purchases' | 'coins' | 'gacha', q: { cursor?: string | null; limit?: number; currency?: 'paid' | 'free' | null } = {}) => wrap(() => svc.history(ID, kind, q)),
  historyTicket: (refs: string[], topic: 'purchase_missing' | 'refund' | 'coins' | 'gacha' | 'other') => wrap(() => svc.historyTicket(ID, refs, topic)),
  /** Demo: a 14-year-old's month (¥5,000 limit): two coin packs bought, one refunded by the store, scouts on paid and free coins. */
  async seedHistory() {
    await this.seedDemo(3, [2, 2, 2]);
    await wrap(() => svc.setAge(ID, 2012, 1, true));
    const buy = (productId: string, priceYen: number) => wrap(() => svc.purchase(ID, 'fake', productId, store.issue({ transactionId: `proto_h_${productId}_${n++}`, productId, purchasedAt: now(), priceYen })));
    const a = await buy('coin_480', 480);
    // refunded before anything was spent, so no refund debt blocks the demo player
    if (a.ok) await wrap(() => svc.refund(ID, (a.value as { record?: { txId: string } }).record?.txId ?? ''));
    await buy('coin_1500', 1500);
    await wrap(() => svc.draw(ID, 'standard', 10, key()));
    await wrap(() => svc.draw(ID, 'pickup_akatsuki', 1, key()));
    return svc.view(ID);
  },

  // ---------------------------------------------------------------- round 15: アクティビティ (REQ-ACT-*, contracts/protocol.md §40)
  // What GET /v1/activity returns: the real PlayerService page, names resolved like the HTTP route (a player with no
  // public profile — deleted — shows the neutral name), and POST /v1/activity/read.
  activity: (cursor: string | null = null, limit = 20) => wrap(async () => {
    const p = await svc.activity(ID, cursor === null ? null : Number(cursor), limit);
    const ids = actorIdsOf(p.items);
    const profiles = (await Promise.all(ids.map(async (id) => ((await repo.get(id)) ? svc.publicProfile(id) : null)))).filter((x) => x !== null);
    return { ...p, items: renderActivityItems(p.items, profiles) };
  }),
  activityRead: (upTo: string | null = null) => wrap(() => svc.activityRead(ID, upTo === null ? null : Number(upTo))),
  /**
   * Demo 「アクティビティ」: what happened while away, written by the real event sources at their push points — a friend
   * request and an accepted one, likes on My Stable (collapsed), cheer stamps, a rival's time-attack record, a tournament
   * result (its prize waits in the gift box without a second entry), a compensation in the gift box, the team goal's
   * milestone and last week's result. The oldest few are already read.
   */
  async seedActivity() {
    await this.seedDemo(3, [2, 2, 2]);
    const people: [string, string][] = [['demo_act_1', 'アサヒ'], ['demo_act_2', 'カエデ'], ['demo_act_3', 'シノノメ']];
    for (const [id, name] of people) if (!(await repo.get(id))) { await svc.bootstrap(id); await svc.setDisplayName(id, name); }
    // the demo rival exactly as rivalDemoSeed makes it (with its partner), so its name shows on the rival row
    if (!(await repo.get(RIVAL_DEMO))) { await svc.bootstrap(RIVAL_DEMO); await svc.setDisplayName(RIVAL_DEMO, 'ミドリカワ'); await svc.grantPartner(RIVAL_DEMO, 'ハヤテ', key()); }
    const day = new Date(now() + 9 * 3600e3).toISOString().slice(0, 10);
    await svc.teamGoalReward(ID, 'demo-week', 'demo_team', 2, 6);
    await svc.friendAccepted(ID, 'demo_act_2', 'カエデ');
    await svc.activityRead(ID, null); // the two above were seen on an earlier visit
    await svc.tournamentClose(ID, 'demo_act_cup', 3, { freeCoins: 100 }, 'デモ杯');
    await svc.adminGrant(ID, { freeCoins: 200 }, 'maintenance', 'ops', 'demo-act-comp', true, { source: 'ops_compensation', titleKey: 'ops_compensation_maintenance' });
    await svc.rivalPush(ID, 'ミドリカワ', rivalTrackName('aoba_turf_1600'), RIVAL_DEMO);
    await svc.teamGoalMilestone(ID, 'demo_team', 1);
    await svc.cheerPush(ID, 'demo_act_3', 'シノノメ', 'react:demo_team:1');
    for (let i = 0; i < 12; i++) await svc.stableLikeReceive(ID, `demo_like_${i}`, `demo_like_${i}:${day}:0`);
    await svc.friendReceive(ID, 'demo_act_1', 'アサヒ');
    return svc.view(ID);
  },

  // ---------------------------------------------------------------- round 10
  // r10 fix: the shop list with this player's ownership (GET /v1/shop/products?mine=1)
  myShopProducts: () => svc.shopProducts(ID),
  // ---------------------------------------------------------------- round 12
  // T6 コイン不足の案内 (REQ-SHORT-*, protocol §29): GET /v1/shop/shortfall on the real rules
  coinShortfall: (q: ShortfallQuery) => wrap(() => svc.coinShortfall(ID, q)),
  /** Client KPI (offer_view / offer_click …) through the server's own batch check (kpi.ts clientEventSchema); kept for the tests. */
  async kpi(events: ClientBatch['events']) {
    const r = await wrap(() => svc.kpiIngest(ID, { platform: 'editor', appVersion: 'proto', events }));
    if (r.ok) kpiLog.push(...events);
    return r;
  },
  kpiLog: () => kpiLog.slice(),
  /** Demo only: a store purchase granted through a locally issued receipt (no billing), so the "already bought" state can be seen. */
  async demoPurchase(productId: string) {
    const v = await svc.view(ID);
    if (!v.age) await wrap(() => svc.setAge(ID, 1990, 1, false));
    const p = master.products.find((x) => x.id === productId)!;
    return wrap(async () => {
      await svc.purchaseIntent(ID, productId);
      return svc.purchase(ID, 'fake', productId, store.issue({ transactionId: `proto_${Date.now().toString(36)}_${n++}`, productId, purchasedAt: now(), priceYen: p.priceYen }));
    });
  },
  // 支部の応援スタンプ (REQ-TEAMFEED-*): a demo team led by demo members; every rule is the server's (TeamsService/TeamCore)
  async teamDemo() {
    const live = (t: string | null) => !!t && teams.cores.has(t) && !teams.cores.get(t)!.state?.disbanded;
    const st = await svc.teamState(ID);
    if (live(st.teamId)) return { teamId: st.teamId!, name: (await teams.view(st.teamId!, ID)).name };
    if (st.teamId) await svc.teamLeft(ID, st.teamId, false); // the team lived in memory before a reload
    let fresh = false;
    if (!live(demoTeamId)) {
      for (const [id, name] of DEMO_MEMBERS) {
        await svc.bootstrap(id);
        await wrap(() => svc.setDisplayName(id, name));
        const t = (await svc.teamState(id)).teamId;
        if (t && !live(t)) await svc.teamLeft(id, t, false);
      }
      const v = await teamsSvc.create(DEMO_MEMBERS[0][0], 'あおばRC', 'open', '毎晩21時に集合！');
      for (const [id] of DEMO_MEMBERS.slice(1)) await teamsSvc.join(id, v.teamId);
      demoTeamId = v.teamId;
      fresh = true;
    }
    const s = await svc.state(ID);
    if ((s.team?.cooldownUntil ?? 0) > now()) { s.team!.cooldownUntil = 0; new LocalRepo().put(s); } // demo: no rejoin wait
    // a demo reset wiped the local player but the in-memory team still lists it: take that stale membership out first
    if (teams.cores.get(demoTeamId!)!.isMember(ID)) await teams.leave(demoTeamId!, ID);
    await teamsSvc.join(ID, demoTeamId!);
    // some history: stamps and a teammate's race result (settled by the real reward rules → an automatic feed item)
    if (fresh) await this.teamActivity();
    return { teamId: demoTeamId!, name: (await teams.view(demoTeamId!, ID)).name };
  },
  /** Demo teammates act: a race result (1st–3rd in ranked or a tournament) and a stamp. */
  async teamActivity() {
    const [lead, m2, m3] = DEMO_MEMBERS.map((x) => x[0]);
    const k = demoRace++;
    await svc.applyRace(m2!, { raceId: `proto_tm_${Date.now().toString(36)}_${k}`, mode: k % 2 ? 'tournament' : 'ranked', place: 1 + (k % 3), fieldSize: 12, newRating: null, void: false, humans: 6 });
    await wrap(() => teamsSvc.postStamp(lead!, ['cheer', 'lets_go', 'nice'][k % 3]!));
    await wrap(() => teamsSvc.postStamp(m3!, ['clap', 'thanks', 'gg'][k % 3]!));
  },
  // 支部の共同目標 (REQ-TGOAL-*): the weekly goal of the demo team on the real TeamCore / PlayerService rules
  teamGoal: () => wrap(() => teamsSvc.goal(ID)),
  /**
   * Demo teammates play: settled ranked races (place 1–5, the real reward and goal rules: kinds, the per-member daily cap)
   * and, for a time attack goal, a verified season best each (the stand-in for the verifier: the team still applies its rules).
   */
  async teamGoalActivity(races = 4) {
    const st = await svc.teamState(ID);
    if (!st.teamId) return;
    for (const [id, name] of DEMO_MEMBERS) {
      for (let i = 0; i < races; i++) {
        const k = demoRace++;
        await svc.applyRace(id, { raceId: `proto_tg_${Date.now().toString(36)}_${k}`, mode: 'ranked', place: 1 + (k % 5), fieldSize: 12, newRating: null, void: false, humans: 6 });
      }
      await teams.goalContribute(st.teamId, { teamId: st.teamId, playerId: id, displayName: name, ref: `ta:proto_${Date.now().toString(36)}_${demoRace++}`, at: now(), races: 0, wins: 0, taPb: 1 });
    }
  },
  /** My settled races (as many as asked; the same rules as a ranked race result from the room). */
  async teamGoalMyRaces(count = 3) {
    for (let i = 0; i < count; i++) {
      const k = demoRace++;
      await svc.applyRace(ID, { raceId: `proto_tgme_${Date.now().toString(36)}_${k}`, mode: 'ranked', place: 1 + ((k * 3) % 6), fieldSize: 12, newRating: null, void: false, humans: 6 });
    }
  },
  /** Demo: the week ends — the clock moves past Monday 04:00 JST and the team object's alarm closes the week and pays. */
  async teamGoalCloseWeek() {
    const st = await svc.teamState(ID);
    if (!st.teamId) return wrap(() => teamsSvc.goal(ID));
    const v = await teamsSvc.goal(ID);
    if (v.current) clockShift = v.current.endsAt + 60_000 - Date.now() - dayOffset * DAY_MS;
    const teamId = st.teamId;
    await teams.goalAlarm(teamId, async (pid, c) => { await svc.teamGoalReward(pid, c.week, teamId, c.tier, c.eligible.find((x) => x.playerId === pid)?.n ?? 0); });
    return wrap(() => teamsSvc.goal(ID));
  },
  stamps: () => svc.stampCatalog(ID),
  teamFeed: (before: number | null = null) => wrap(() => teamsSvc.feed(ID, before, 20)),
  postStamp: (stampId: string) => wrap(() => teamsSvc.postStamp(ID, stampId)),
  reactToFeed: (seq: number, stampId: string | null) => wrap(() => teamsSvc.react(ID, seq, stampId)),
  reportFeed: (seq: number, reason: ReportReason) => wrap(() => teamsSvc.report(ID, seq, reason)),
  muteMember: (playerId: string, muted: boolean) => wrap(() => teamsSvc.mute(ID, playerId, muted)),
  /** Unlocks for the demo: lifetime races (play) — the pass and cosmetic stamps unlock by demoPurchase / the 見た目 shop. */
  async demoRaces(count: number) { const s = await svc.state(ID); s.stats.races = Math.max(s.stats.races, count); new LocalRepo().put(s); },
  // ---------------------------------------------------------------- round 12: ライバル (REQ-RIVAL-*, contracts/protocol.md §28)
  rival: {
    view: () => wrap(async () => { await rivalDemoSeed(); return rivalSvc.view(ID); }),
    seen: (weekId: string) => wrap(() => rivalSvc.seen(ID, weekId)),
    optOut: (optOut: boolean) => wrap(() => rivalSvc.setOptOut(ID, optOut)),
    block: () => wrap(() => rivalSvc.block(ID)),
    challenge: () => wrap(() => rivalSvc.challenge(ID, 'demo-room', key())),
    /** A confirmed ranked race with the rival in the field (both objects receive the same places). */
    demoRace: (mine: number, theirs: number, mode: 'ranked' | 'friend' = 'ranked') => wrap(async () => {
      const raceId = `proto_rv_${Date.now().toString(36)}_${rivalRace++}`;
      const field = [{ playerId: ID, place: mine }, { playerId: RIVAL_DEMO, place: theirs }];
      for (const f of field) await svc.applyRace(f.playerId, { raceId, mode, place: f.place, fieldSize: 12, newRating: null, void: false, humans: 2, field });
    }),
    /** Verified time-attack bests this week for both (the path PlayerService.taRecord takes). */
    demoTa: (trackId: string, mineMs: number, theirsMs: number) => wrap(async () => {
      await svc.tx(ID, null, (s, t) => { noteRivalTa(master, s, trackId, mineMs, t); });
      await svc.tx(RIVAL_DEMO, null, (s, t) => { noteRivalTa(master, s, trackId, theirsMs, t); });
    }),
    /** Moves the clock into next week (the week settles on the next view). */
    demoWeekEnd() { const end = weekEndMs(master, weekIdAt(master, now())); clockShift += end + 3_600_000 - now(); },
  },
  // ---------------------------------------------------------------- round 10: 友達招待 (REQ-INV-*, contracts/protocol.md §19)
  // The real InviteService / per-player steps / milestone outbox on the local PlayerService. Demo friends are extra players
  // in the same local repo (ids demo_inv_*), so "a friend joins with my code" and "the friend reaches a milestone" run the
  // exact server code paths (directory lookup, device claim, inviter + invitee steps, outbox delivery).
  invite: {
    view: () => wrap(() => inviteSvc.view(ID, installId())),
    redeem: (code: string) => wrap(() => inviteSvc.redeem(ID, code, installId())),
    normalize: (raw: string) => normalizeInviteCode(raw),
    display: (code: string) => displayInviteCode(code),
    rewardYen: (r: Parameters<typeof inviteRewardYen>[1]) => inviteRewardYen(master, r),
    config: master.progression.invite ?? null,
    /** A demo friend enters MY code (bootstrap → partner → redeem from their own device). */
    async demoFriendJoins() {
      const n = (await svc.state(ID)).referral?.invitees.length ?? 0;
      const id = `demo_inv_${n + 1}`;
      return wrap(async () => {
        await svc.bootstrap(id);
        await svc.setDisplayName(id, DEMO_NAMES[n % DEMO_NAMES.length]!);
        await svc.grantPartner(id, 'デモノアイボウ', key());
        const code = (await inviteSvc.view(ID, installId())).code;
        return { id, result: await inviteSvc.redeem(id, code, `demo-install-${id}`) };
      });
    },
    /** The newest demo friend without this milestone reaches it (their own transaction notices it; the outbox delivers it). */
    async demoMilestone(milestoneId: string) {
      return wrap(async () => {
        const me = await svc.state(ID);
        const target = me.referral?.invitees.find((x) => !x.deleted && x.playerId.startsWith('demo_inv_') && !x.milestones.some((m) => m.id === milestoneId));
        if (!target) throw new AppError('NOT_FOUND', 'no demo friend left for this milestone');
        const repo = localRepo;
        const s = (await svc.state(target.playerId));
        if (milestoneId === 'im_graduate') s.onboarding = { races: 15, breedings: 1, counts: {}, ...(s.onboarding ?? {}), claimed: (master.progression.beginnerMissions ?? []).map((d) => d.id) };
        else s.season.classId = master.progression.invite!.milestones.find((m) => m.id === milestoneId)?.classId ?? 'B';
        repo.put(s);
        await svc.missionsAll(target.playerId);
        // REQ-BOX-001: the inviter's bonus arrives in the gift box (counted there, the wallet changes on claim)
        const boxed = async () => { const st = await svc.state(ID); return st.wallet.free + (st.giftBox?.box ?? []).reduce((a, x) => a + (x.contents.freeCoins ?? 0), 0); };
        const before = await boxed();
        const out = await deliverInviteOutbox({
          due: (u) => svc.inviteDue(u), deliver: (o, i, ms, nm) => svc.inviteMilestone(o, i, ms, nm),
          acked: (u, x) => svc.inviteAcked(u, x), later: (u, x) => svc.inviteRetryLater(u, x),
        }, target.playerId);
        return { friend: target.playerId, delivered: out.delivered, freeCoinsGained: (await boxed()) - before, inGiftBox: true };
      });
    },
    /** A demo player's code for trying the entry (only redeemable while the local player is in the window, after the FTUE). */
    async demoInviterCode() {
      await svc.bootstrap('demo_inviter');
      await svc.setDisplayName('demo_inviter', 'ミナトの騎手').catch(() => undefined);
      return displayInviteCode(await inviteCodes.codeOf('demo_inviter'));
    },
  },
  // ---------------------------------------------------------------- rewarded ads (REQ-AD-*, contracts/protocol.md §21)
  // The real server rules: eligibility (FTUE, install day, 30 days after a payment, age), caps by game day, sessions. The
  // ad network is simulated in the browser: it signs an AdMob-style SSV callback with a local ECDSA P-256 key, and the
  // real verifyAdMobCallback checks that signature before the real applyAdCallback grants free coins. No ad SDK, no network.
  // ---------------------------------------------------------------- かんたん操作 (REQ-ASSIST-*, contracts/protocol.md §27)
  // The real server rules: the setting (default off), the last-place streak counted by applyRace, the one-time prompt.
  assist: () => svc.assist(ID),
  setAssist: (level: 'off' | 'whip' | 'full', source: 'settings' | 'prompt' = 'settings') => wrap(() => svc.setAssist(ID, level, source)),
  assistPromptSeen: () => wrap(() => svc.assistPromptSeen(ID)),
  /** Demo: three ranked races finishing last (12th of 12), settled by the real applyRace — the prompt becomes due. */
  async demoLastPlaces(n = 3) {
    for (let i = 0; i < n; i++) await svc.applyRace(ID, { raceId: `demo_last_${Date.now().toString(36)}_${i}`, mode: 'ranked', place: 12, fieldSize: 12, newRating: null, void: false, humans: 1 });
    return svc.assist(ID);
  },
  ads: () => svc.ads(ID),
  setAdPref: (mode: 'auto' | 'on' | 'off') => wrap(() => svc.setAdPref(ID, mode)),
  adStart: (placementId: string) => wrap(() => svc.adStart(ID, placementId, key())),
  adSession: (sessionId: string) => wrap(() => svc.adSession(ID, sessionId)),
  /** The simulated network's SSV callback for a watched ad (what AdMob would GET on the server). */
  simulateAdCallback: (start: { customData: string; userId: string; adUnitKey: string }) => wrap(async () => {
    adKeys ??= (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'])) as CryptoKeyPair;
    const q = await signAdMobQuery({ adUnit: 'proto/' + start.adUnitKey, customData: start.customData, timestamp: now(), transactionId: `proto_${Date.now().toString(36)}_${n++}`, userId: start.userId, keyId: 'proto' }, adKeys.privateKey);
    const cb = await verifyAdMobCallback(q, StaticKeySource.fromCryptoKeys({ proto: adKeys.publicKey }));
    return svc.adReward(cb.userId, cb);
  }),
};
let adKeys: CryptoKeyPair | null = null;

const DEMO_NAMES = ['ハヤテ', 'サクラ', 'コウガ', 'ミズキ', 'レン', 'ツバサ', 'ヒナタ', 'カイ', 'ユズ', 'アオイ', 'ソラ', 'リク'];
/** Random per install, like the app's keychain value (only its hash reaches the invite code). */
function installId() {
  try {
    let v = localStorage.getItem('muchi.installId');
    if (!v) { v = 'i-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10); localStorage.setItem('muchi.installId', v); }
    return v;
  } catch { return 'i-private-mode'; }
}
/** The invite directory in localStorage (codes and install claims survive a reload, like DirectoryDO). */
class LocalInviteDirectory extends MemoryInviteDirectory {
  private static K = 'muchi.proto.inviteDir';
  constructor() {
    super(cryptoRng);
    try {
      const j = JSON.parse(localStorage.getItem(LocalInviteDirectory.K) ?? 'null') as { codes: [string, { playerId: string | null; retired: boolean }][]; installs: [string, string | null][] } | null;
      if (j) {
        for (const [c, v] of j.codes) { this.codes.set(c, v); if (v.playerId) (this as unknown as { byPlayer: Map<string, string> }).byPlayer.set(v.playerId, c); }
        for (const [h, p] of j.installs) this.installs.set(h, p);
      }
    } catch { /* fresh */ }
  }
  clear() {
    this.codes.clear(); this.installs.clear(); (this as unknown as { byPlayer: Map<string, string> }).byPlayer.clear();
    try { localStorage.removeItem(LocalInviteDirectory.K); } catch { /* */ }
  }
  private save() { try { localStorage.setItem(LocalInviteDirectory.K, JSON.stringify({ codes: [...this.codes], installs: [...this.installs] })); } catch { /* */ } }
  override async codeOf(p: string) { const c = await super.codeOf(p); this.save(); return c; }
  override async claimInstall(h: string, p: string) { const r = await super.claimInstall(h, p); this.save(); return r; }
  override async releaseInstall(h: string, p: string) { await super.releaseInstall(h, p); this.save(); }
}
const localRepo = new LocalRepo();
const inviteCodes = new LocalInviteDirectory();
/** Display names straight from the local players' states (the server reads them from DirectoryDO profiles). */
const profileDir: Directory = {
  codeOf: async () => '', lookup: async () => null, putProfile: async () => undefined,
  profiles: async (ids) => ids.map((id) => localRepo.get(id)).filter((s): s is PlayerState => !!s).map((s) => ({ playerId: s.id, displayName: s.profile.displayName } as never)),
};
// the same per-player ports as server/src/http/app.ts invitePlayersFrom, on the local PlayerService
const inviteSvc = new InviteService({
  attempt: (u, h) => svc.inviteAttempt(u, h),
  view: (u, h) => svc.inviteView(u, h),
  accept: (o, i, h, nm) => svc.inviteAccept(o, i, h, nm),
  revert: (o, i, unfriend) => svc.inviteRevert(o, i, unfriend),
  commit: (u, o, c, h, f) => svc.inviteCommit(u, o, c, h, f),
  flag: (u, f) => svc.inviteFlag(u, f),
  unfriend: (u, o) => svc.friendRemove(u, o),
}, inviteCodes, profileDir, () => master);

(globalThis as unknown as { MuchiLogic: typeof MuchiLogic }).MuchiLogic = MuchiLogic;
