// Browser bundle of the REAL server domain logic (server/src/domain), used by the web prototype instead of mocks:
// PlayerService (gacha draws with the ppm tables, 10-pull guarantee, pity, horse naming with the NG list,
// wallet paid/free ordering, purchase-intent age checks, season pass), odds disclosure from the same tables.
// State lives in localStorage (one player, "local"). No server, no billing.
import { COMMENTARY_PACKS } from '../../../server/src/domain/commentaryPacks.js';
import { loadMaster } from '../../../server/src/domain/master.js';
import { PlayerService, type PlayerRepo, type ShortfallQuery } from '../../../server/src/domain/service.js';
import { clientBatchSchema, clientToKpi, type ClientBatch } from '../../../server/src/domain/kpi.js';
import type { AccessibilityBody } from '../../../server/src/domain/accessibility.js';
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
import { HallService, MemoryHallDirectory, hallConfig, hallSnapshot } from '../../../server/src/domain/hallOfFame.js';
import { hallPlayersFrom } from '../../../server/src/http/hallPorts.js';
import { MemoryReplayStore, MyReplaysService } from '../../../server/src/domain/myReplaysService.js';
import { DEFAULT_RULESET } from '../../../server/src/domain/ruleset.js';
import { computeRaceAdvice, adviceTextProblems, adviceTexts, type AdviceInput } from '../../../server/src/domain/raceAdvice.js';
import type { AdviceQuery } from '../../../server/src/domain/raceAdviceService.js';
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
const serverKpi: { name: string; s1?: string; s2?: string; s3?: string }[] = [];
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
  // round 14 (REQ-HOF-011): the visitors' copy of each hall (DirectoryDO halls in production; memory here)
  onHall: async (id, snap) => { if (snap) await hallDir.put(snap); else await hallDir.remove(id); },
  // round 15 (REQ-A11Y-014): the server-side KPI rows, kept for the tests (the real Analytics Engine is not here)
  onKpi: (_id, recs) => { serverKpi.push(...recs.map((r) => ({ name: r.name, s1: r.s1, s2: r.s2, s3: r.s3 }))); if (serverKpi.length > 300) serverKpi.splice(0, serverKpi.length - 300); },
});
// round 14 (REQ-HOF-*): 殿堂 on the real HallService. A demo friend (demo_hof_1, アオバ) has a hall of their own to visit.
const hallDir = new MemoryHallDirectory();
const hallSvc = new HallService(hallPlayersFrom(() => rivalInvoker), hallDir, () => hallConfig(master));
const HALL_DEMO = 'demo_hof_1';
let hallRace = 0;
/** Confirmed races for one horse (the path settleRace → applyRace takes, with the entrant's horse id). */
async function hallRaces(uid: string, horseId: string, places: number[], mode: 'ranked' | 'event' = 'ranked') {
  for (const place of places) {
    await svc.applyRace(uid, { raceId: `proto_hof_${Date.now().toString(36)}_${hallRace++}`, mode, place, fieldSize: 12, newRating: null, void: false, humans: 4, horseId,
      details: { trackId: 'aoba_turf_1600', style: 'sashi', finishTick: 1900, startReactionTicks: 2, whips: 3, whipMashed: false, cpuAssisted: false } });
  }
}
/** A horse of `uid` with a career: wins / other places, an optional tournament title, then (optionally) retired. */
async function hallDemoHorse(uid: string, tpl: number, name: string, wins: number, others: number, title: string | null, retire: boolean) {
  const horseId = await svc.tx(uid, null, (s, t) => { const h = createHorseFromTemplate(s, master.templates[tpl % master.templates.length]!, t); h.name = name; h.named = true; return h.id; });
  await hallRaces(uid, horseId, [...Array(wins).fill(1), ...Array.from({ length: others }, (_, i) => 2 + (i % 6))]);
  if (title) await svc.tournamentClose(uid, `proto_cup_${horseId}`, 1, null, title, horseId);
  return retire ? (await svc.retire(uid, horseId)).ceremony : horseId;
}
async function hallDemoFriend() {
  if (!(await repo.get(HALL_DEMO))) {
    await svc.bootstrap(HALL_DEMO);
    await svc.setDisplayName(HALL_DEMO, 'アオバ');
    await hallDemoHorse(HALL_DEMO, 3, 'アオバノツバサ', 12, 9, null, true);
    await hallDemoHorse(HALL_DEMO, 5, 'ギンノカケハシ', 4, 6, '秋の陣', true);
    await hallDemoHorse(HALL_DEMO, 7, 'ハルカゼダンサー', 10, 20, '春の陣', true);
  }
  await svc.tx(HALL_DEMO, null, (s) => { if (!s.friends.ids.includes(ID)) s.friends.ids.push(ID); });
  await svc.tx(ID, null, (s) => { if (!s.friends.ids.includes(HALL_DEMO)) s.friends.ids.push(HALL_DEMO); });
  // the memory directory does not survive a reload: re-publish the friend's copy from their state
  if (!(await hallDir.get(HALL_DEMO))) { const snap = hallSnapshot(master, await svc.state(HALL_DEMO), now()); if (snap) await hallDir.put(snap); }
  return HALL_DEMO;
}
// round 12 (REQ-RIVAL-*): the weekly rival on the real RivalService + an in-memory week registry (RivalWeekCore, the
// LeaderboardDO rival:<week> logic). A demo rival (demo_rv_1, ミドリカワ) registers with the local player as last week's
// candidates, so this week's pairing, head to head, time attack and the week result run the server code paths.
const rivalReg = new MemoryRivalRegistry(() => master, now);
const rivalInvoker: PlayerInvoker = { invoke: (async (m: string, ...a: unknown[]) => (svc as unknown as Record<string, (...x: unknown[]) => unknown>)[m]!.apply(svc, a)) as PlayerInvoker['invoke'] };
const rivalSvc = new RivalService(() => master, rivalPlayersFrom(() => rivalInvoker), rivalReg);
const RIVAL_DEMO = 'demo_rv_1';

// round 14 (REQ-MYRP-*): マイリプレイ on the real MyReplaysService. The "R2" store keeps its files in localStorage (best
// effort, oldest source logs dropped first when the quota is full); a demo friend (demo_rp_friend) owns a public replay.
const RP_KEY = 'muchi.proto.r2:';
class LocalReplayStore extends MemoryReplayStore {
  constructor() {
    super();
    try { for (const k of Object.keys(localStorage)) if (k.startsWith(RP_KEY)) this.files.set(k.slice(RP_KEY.length), localStorage.getItem(k)!); } catch { /* memory only */ }
  }
  async put(key: string, body: string) {
    await super.put(key, body);
    for (let i = 0; i < 20; i++) {
      try { localStorage.setItem(RP_KEY + key, body); return; } catch {
        const old = [...this.files.keys()].find((k) => k.startsWith('replays/') && k !== key);
        if (!old) return;
        try { localStorage.removeItem(RP_KEY + old); } catch { /* ignore */ }
      }
    }
  }
  async delete(key: string) { await super.delete(key); try { localStorage.removeItem(RP_KEY + key); } catch { /* ignore */ } }
  clear() { for (const k of [...this.files.keys()]) { this.files.delete(k); try { localStorage.removeItem(RP_KEY + k); } catch { /* ignore */ } } }
}
const replayStore = new LocalReplayStore();
// round 15: the friends port — making a save public writes the friends' replay_share activity entry (§40)
const myReplaysSvc = new MyReplaysService(() => master, () => rivalInvoker, replayStore, async (u) => (await svc.friendsState(u)).ids);
const RP_FRIEND = 'demo_rp_friend';
const RP_FRIEND_NAME = 'ハヤテ乗り';
async function ensureReplayFriend() {
  const s = await svc.state(RP_FRIEND);
  if (s.horses.length === 0) {
    await svc.bootstrap(RP_FRIEND);
    await svc.grantPartner(RP_FRIEND, 'ハヤテ', key());
    await svc.setDisplayName(RP_FRIEND, RP_FRIEND_NAME);
  }
  for (const [a, b] of [[ID, RP_FRIEND], [RP_FRIEND, ID]] as const) {
    const st = await svc.state(a);
    if (!st.friends.ids.includes(b)) { st.friends.ids.push(b); repo.put(st); }
  }
}
/** The smallest finish-tick gap to the neighbouring places (what settleRace puts in `replay.marginTicks`). */
function marginTicksOf(order: number[], finishTicks: number[], slot: number): number | null {
  const i = order.indexOf(slot);
  const t = finishTicks[i];
  if (i < 0 || t === undefined || t < 0) return null;
  const gaps = [finishTicks[i - 1], finishTicks[i + 1]].filter((x): x is number => x !== undefined && x >= 0).map((x) => Math.abs(x - t));
  return gaps.length ? Math.min(...gaps) : null;
}
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
  // round 14 (REQ-MYRP-001): `replay` = the race's confirmed inputs + hash from the WASM engine; the source log is stored as the
  // race room writes it (R2 replays/) and the result carries the replay ref settleRace adds, so the race shows in マイリプレイ
  applyRace: (raceId: string, place: number, fieldSize: number, details: { trackId: string; style: Style; finishTick: number | null; whips: number; skillFired?: boolean; assist?: 'whip' | 'full' }, config?: RaceStartConfig,
    replay?: { slot: number; hash: string; endTick: number; inputs: [number, number, number][]; marginTicks: number | null }) =>
    wrap(async () => (config && replay ? await replayStore.put(`replays/${raceId}.json`, JSON.stringify({ v: 1, config, endTick: replay.endTick, inputs: replay.inputs })) : undefined, svc.applyRace(ID, { raceId, mode: 'ranked', place, fieldSize, newRating: null, void: false, humans: 1,
      ...(config && replay ? { replay: { slot: replay.slot, resultHash: replay.hash, rulesetVersion: String(config.ruleset.rulesetVersion), trackId: config.track.id, marginTicks: replay.marginTicks } } : {}),
      details: { ...details, startReactionTicks: null, whipMashed: false, cpuAssisted: false },
      ...(config ? { seen: raceFieldSeen(config, config.entrants.find((e) => e.playerId === ID)?.slot ?? -1) } : {}),
      // round 14 (REQ-HOF-002): the horse that ran, as settleRace takes it from the entrant
      ...(config?.entrants.find((e) => e.playerId === ID) ? { horseId: config.entrants.find((e) => e.playerId === ID)!.horse.id } : {}) }))),
  reset() {
    try {
      localStorage.removeItem(KEY + ':' + ID); localStorage.removeItem(DAY_KEY);
      // round 10: demo players of the invite screen and the invite directory start over too
      for (const k of Object.keys(localStorage)) if (k.startsWith(KEY + ':demo_')) localStorage.removeItem(k);
    } catch { /* ignore */ }
    inviteCodes.clear();
    rivalReg.weeks.clear(); // round 12: the rival week registry starts over too
    hallDir.rows.clear(); // round 14: the hall copies too
    replayStore.clear(); // round 14: the saved replays and source logs too
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
  // ---------------------------------------------------------------- round 15: 出走前アドバイス (REQ-ADV-*, protocol §39)
  // GET /v1/races/advice on the real service (raceAdviceFor: the player's horses, today's going, the challenge's loan horse)
  // and the pure scorer itself (the page recomputes the tips for another selected horse; the WASM C# mirror must agree).
  raceAdvice: (q: AdviceQuery) => wrap(() => svc.raceAdvice(ID, q)),
  computeAdvice: (input: AdviceInput) => computeRaceAdvice(input),
  adviceLint: (texts: string[]) => texts.flatMap((t) => adviceTextProblems(t)),
  adviceTexts: (a: Parameters<typeof adviceTexts>[0]) => adviceTexts(a),
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

  // ---------------------------------------------------------------- round 15: フォトモード (REQ-PHOTO-*, contracts/protocol.md §38)
  // GET /v1/photo/catalog, the photo records and the shop purchase of a photo frame / stamp, on the real rules. The picture
  // itself (snapshot, camera, card) is the C# PhotoModeModel in WASM.
  photoCatalog: () => wrap(() => svc.photoCatalog(ID)),
  photos: () => wrap(() => svc.photos(ID)),
  photoSave: (spec: unknown, idemKey?: string) => wrap(() => svc.photoSave(ID, spec as never, idemKey ? 'c:/v1/photos:' + idemKey : key())),
  photoDelete: (photoId: string) => wrap(() => svc.photoDelete(ID, photoId)),
  buyCosmetic: (itemId: string) => wrap(() => svc.buyCosmetic(ID, itemId, key())),
  /** KPI rows the client would send (photo_take / photo_share), checked against the server's client-event schema. */
  photoKpi: (name: 'photo_take' | 'photo_share', props: Record<string, unknown>) => wrap(() => clientBatchSchema.parse({ platform: 'editor', appVersion: 'proto', events: [{ name, at: now(), props }] }).events.map(clientToKpi)[0]),
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
  // ---------------------------------------------------------------- round 14: 殿堂・引退式 (REQ-HOF-*, contracts/protocol.md §34)
  hall: {
    mine: (cursor: string | null = null, limit: number | null = null) => wrap(() => hallSvc.mine(ID, cursor, limit)),
    visit: (playerId: string, cursor: string | null = null) => wrap(() => hallSvc.visit(ID, playerId, cursor, null)),
    career: (horseId: string) => wrap(() => svc.horseCareer(ID, horseId)),
    ack: (horseId: string) => wrap(() => svc.hallAck(ID, horseId)),
    setVisibility: (v: string) => wrap(() => svc.hallSettings(ID, v)),
    /** A friend with a hall of three plaques (the friendship both ways), for 友達の殿堂. */
    demoFriend: () => wrap(() => hallDemoFriend()),
    /** Confirmed races for one of my horses (wins first), e.g. to bring the partner to its induction. */
    demoRaces: (horseId: string, wins: number, others: number) => wrap(() => hallRaces(ID, horseId, [...Array(wins).fill(1), ...Array(others).fill(4)])),
    /** A new horse of mine with a career (a tournament title when `title`), retired: returns its ceremony. */
    demoRetire: (name: string, wins: number, others: number, title: string | null) => wrap(() => hallDemoHorse(ID, 2 + hallRace % 9, name, wins, others, title, true)),
    /** A tournament final rank for one of my horses (tournamentClose with the registered horse). */
    demoTitle: (horseId: string, name: string) => wrap(() => svc.tournamentClose(ID, `proto_cup_${horseId}_${hallRace++}`, 1, null, name, horseId)),
  },
  /** round 14: a course's display name (server tracks.json). */
  trackName: (id: string) => trackNames.get(id) ?? id,
  // ---------------------------------------------------------------- round 14: マイリプレイ (REQ-MYRP-*, contracts/protocol.md §37)
  // The real MyReplaysService / PlayerService rules on the local player. R2 is a local store (localStorage, best effort):
  // `replays/<raceId>.json` is what the race room would write, `myreplays/<player>/<raceId>.json` the saved copies.
  replays: {
    view: () => wrap(() => myReplaysSvc.view(ID)),
    save: (raceId: string, title: string | null = null) => wrap(() => myReplaysSvc.save(ID, raceId, title, key())),
    update: (raceId: string, patch: { replayTitle?: string | null; favorite?: boolean; public?: boolean }) => wrap(() => myReplaysSvc.update(ID, raceId, patch)),
    remove: (raceId: string) => wrap(() => myReplaysSvc.remove(ID, raceId)),
    data: (raceId: string) => wrap(() => myReplaysSvc.data(ID, raceId)),
    /** The demo friend's public replays (friend view, privacy rules on the owner's state). */
    friendList: () => wrap(async () => { await ensureReplayFriend(); return myReplaysSvc.friendList(ID, RP_FRIEND); }),
    friendData: (raceId: string) => wrap(() => myReplaysSvc.friendData(ID, RP_FRIEND, raceId)),
    /** A config for the demo friend's race (the same buildRaceConfig as a ranked room). */
    async friendConfig() {
      await ensureReplayFriend();
      const s = await svc.state(RP_FRIEND);
      const h = s.horses[0]!;
      const tId = 'aoba_turf_1600';
      const config = buildRaceConfig(master, {
        raceId: 'proto_rpf_' + Date.now().toString(36), mode: 'ranked', trackId: tId, statCap: classDef(master, s.season.classId).statCap,
        humans: [{ playerId: RP_FRIEND, horse: toRaceHorse(master, h), cpuLevel: 3 }], cpuCount: 11, cpuLevel: 3, rng: cryptoRng, ground: groundFor(master, tId, 'ranked', now()),
      });
      return { config, playerId: RP_FRIEND };
    },
    /** The friend's race (simulated in WASM by the page) is settled, saved and made public on the friend's object. */
    demoFriendSave: (config: RaceStartConfig, sim: { slot: number; place: number; hash: string; endTick: number; order: number[]; finishTicks: number[]; inputs: [number, number, number][] }) => wrap(async () => {
      await replayStore.put(`replays/${config.raceId}.json`, JSON.stringify({ v: 1, config, endTick: sim.endTick, inputs: sim.inputs }));
      await svc.applyRace(RP_FRIEND, { raceId: config.raceId, mode: 'ranked', place: sim.place, fieldSize: config.entrants.length, newRating: null, void: false, humans: 1,
        replay: { slot: sim.slot, resultHash: sim.hash, rulesetVersion: String(config.ruleset.rulesetVersion), trackId: config.track.id, marginTicks: marginTicksOf(sim.order, sim.finishTicks, sim.slot) } });
      await myReplaysSvc.save(RP_FRIEND, config.raceId, '青葉の差し切り', `c:/proto:rpf:${config.raceId}`);
      await myReplaysSvc.update(RP_FRIEND, config.raceId, { public: true });
    }),
    friendName: () => RP_FRIEND_NAME,
    /** Demo: retire the shipped ruleset version (REQ-MYRP-007) so saved replays show 「再生できません」; false restores. */
    demoRetired(on: boolean) { master.progression.myReplays!.retiredRulesets = on ? [String(DEFAULT_RULESET.rulesetVersion)] : []; },
    /** A word on the NG list (test hook for the title moderation). */
    ngSample: () => master.ng.exact[0] ?? '',
    marginTicks: (order: number[], finishTicks: number[], slot: number) => marginTicksOf(order, finishTicks, slot),
    /** The stored files (test hook). */
    files: () => [...replayStore.files.keys()],
  },
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
  // ---------------------------------------------------------------- 勝負服エディタ (REQ-SILK-*, contracts/protocol.md §35)
  // The real server rules: parts and their sources, the shared code, ownership, readability, the banned list, presets and
  // the part purchase through the cosmetics flow (paid coins first, paid-only parts on paid coins). Never random.
  silksEditor: () => svc.silksEditor(ID),
  silksPreview: (design: Parameters<typeof svc.silksPreview>[1]) => wrap(() => svc.silksPreview(ID, design)),
  saveSilks: (design: Parameters<typeof svc.saveSilks>[1]) => wrap(() => svc.saveSilks(ID, design)),
  silksPresetCreate: (name: string | undefined, design: Parameters<typeof svc.saveSilks>[1]) => wrap(() => svc.silksPresetCreate(ID, name, design)),
  silksPresetUpdate: (slot: number, name: string | undefined, design: Parameters<typeof svc.saveSilks>[1] | null) => wrap(() => svc.silksPresetUpdate(ID, slot, name, design)),
  silksPresetDelete: (slot: number) => wrap(() => svc.silksPresetDelete(ID, slot)),
  silksPresetApply: (slot: number) => wrap(() => svc.silksPresetApply(ID, slot)),
  buySilksPart: (itemId: string) => wrap(() => svc.buySilksPart(ID, itemId, key())),
  silksNoticeSeen: () => wrap(() => svc.silksNoticeSeen(ID)),
  // ---------------------------------------------------------------- かんたん操作 (REQ-ASSIST-*, contracts/protocol.md §27)
  // The real server rules: the setting (default off), the last-place streak counted by applyRace, the one-time prompt.
  assist: () => svc.assist(ID),
  setAssist: (level: 'off' | 'whip' | 'full', source: 'settings' | 'prompt' = 'settings') => wrap(() => svc.setAssist(ID, level, source)),
  assistPromptSeen: () => wrap(() => svc.assistPromptSeen(ID)),
  // ---------------------------------------------------------------- アクセシビリティ設定 (REQ-A11Y-*, contracts/protocol.md §41)
  // The real server rules: defaults, the idempotent full replace, strict values, one a11y_setting_change per changed key.
  accessibility: () => svc.accessibility(ID),
  setAccessibility: (body: AccessibilityBody) => wrap(() => svc.setAccessibility(ID, body)),
  serverKpiLog: () => serverKpi.slice(),
  /** Demo: three ranked races finishing last (12th of 12), settled by the real applyRace — the prompt becomes due. */
  async demoLastPlaces(n = 3) {
    for (let i = 0; i < n; i++) await svc.applyRace(ID, { raceId: `demo_last_${Date.now().toString(36)}_${i}`, mode: 'ranked', place: 12, fieldSize: 12, newRating: null, void: false, humans: 1 });
    return svc.assist(ID);
  },
  // ---------------------------------------------------------------- 実況パック (REQ-CMT-*, contracts/protocol.md §36)
  // The real server rules: owned (standard / the 10-race achievement / bought), price, equip, the coin purchase (paid first).
  commentaryPacks: () => svc.commentaryPacks(ID),
  /** The pack's name (Japanese; the EN toggle translates it) for the race HUD label. */
  commentaryPackName: (packId: string) => COMMENTARY_PACKS.packs.find((p) => p.id === packId)?.name ?? packId,
  equipCommentaryPack: (packId: string, source: 'settings' | 'shop' = 'settings') => wrap(() => svc.equipCommentaryPack(ID, packId, source)),
  buyCommentaryPack: (packId: string, equip = true) => wrap(() => svc.buyCommentaryPack(ID, packId, equip, key())),
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
