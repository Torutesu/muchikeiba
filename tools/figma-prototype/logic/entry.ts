// Browser bundle of the REAL server domain logic (server/src/domain), used by the web prototype instead of mocks:
// PlayerService (gacha draws with the ppm tables, 10-pull guarantee, pity, horse naming with the NG list,
// wallet paid/free ordering, purchase-intent age checks, season pass), odds disclosure from the same tables.
// State lives in localStorage (one player, "local"). No server, no billing.
import { loadMaster } from '../../../server/src/domain/master.js';
import { PlayerService, type PlayerRepo } from '../../../server/src/domain/service.js';
import { playerView, type PlayerState } from '../../../server/src/domain/player.js';
import { oddsDisclosure, findBanner, bannerList, bannerStatus } from '../../../server/src/domain/gacha.js';
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
import { InviteService, MemoryInviteDirectory, deliverInviteOutbox, displayInviteCode, inviteRewardYen, normalizeInviteCode } from '../../../server/src/domain/invite.js';
import type { Directory } from '../../../server/src/domain/friends.js';

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
  reset() {
    try {
      localStorage.removeItem(KEY + ':' + ID); localStorage.removeItem(DAY_KEY);
      // round 10: demo players of the invite screen and the invite directory start over too
      for (const k of Object.keys(localStorage)) if (k.startsWith(KEY + ':demo_')) localStorage.removeItem(k);
    } catch { /* ignore */ }
    inviteCodes.clear();
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

  // ---------------------------------------------------------------- round 10: 友達招待 (REQ-INV-*, contracts/protocol.md §18)
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
        const before = (await svc.view(ID)).wallet.free;
        const out = await deliverInviteOutbox({
          due: (u) => svc.inviteDue(u), deliver: (o, i, ms, nm) => svc.inviteMilestone(o, i, ms, nm),
          acked: (u, x) => svc.inviteAcked(u, x), later: (u, x) => svc.inviteRetryLater(u, x),
        }, target.playerId);
        return { friend: target.playerId, delivered: out.delivered, freeCoinsGained: (await svc.view(ID)).wallet.free - before };
      });
    },
    /** A demo player's code for trying the entry (only redeemable while the local player is in the window, after the FTUE). */
    async demoInviterCode() {
      await svc.bootstrap('demo_inviter');
      await svc.setDisplayName('demo_inviter', 'ミナトの騎手').catch(() => undefined);
      return displayInviteCode(await inviteCodes.codeOf('demo_inviter'));
    },
  },
};

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
