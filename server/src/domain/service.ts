import { AppError } from './errors.js';
import type { Master, Reward } from './master.js';

const TOURNAMENT_HISTORY_KEEP = 50;
import { migratePlayer, moderationOf, newPlayer, playerView, type Currency, type LedgerEntry, type PlayerState, type PurchaseRecord } from './player.js';
import { GRANT_LIMITS, setModeration, supportCorrectAge, supportGrant, supportResetName, supportSettleDebt, supportView, type Grant } from '../ops/support.js';
import { equipTitle, evaluateTitles, publicProfile, setDisplayName, type PublicProfile } from './stats.js';
import { achievementsView, claimAchievement, claimAllAchievements, collectionView, noteCheer, noteRaceCollection, noteTournamentResult, syncCollection } from './collection.js';
import { closeSeason } from './season.js';
import { friendAccept, friendAccepted, friendCancel, friendDecline, friendReceive, friendRemove, friendSend, pruneInvites, receiveInvite } from './friends.js';
import type { SeasonEntry } from './leaderboard.js';
import type { Rng } from './rng.js';
import type { Clock } from './time.js';
import { seasonIdFor, rollSeason, classDef } from './season.js';
import { applyRefund, applySubscriptionStatus, applyVerifiedPurchase, checkPurchaseIntent, registerAge, type StoreVerifier, type SubscriptionStatus, type VerifiedReceipt } from './purchase.js';
import { assertBannerOpen, drawGacha, exchangePity, findBanner, gachaPrice, gachaStatus, settlePityGroups } from './gacha.js';
import { attachShortfall, coinShortfall } from './shortfall.js';
import { awaken, breed, breedingPreviewWithAllowance, getHorse, nameHorse, pedigree, retire } from './horses.js';
import { migrateSkills } from './skills.js';
import { buyCosmetic, cosmeticsCatalog, findCosmetic, setEquipment, useTicket, type EquipmentPatch } from './itemShop.js';
import { applyRaceResult, claimLoginBonus, claimMission, claimPass, firstWinBonusView, missionsView, type RaceResultForPlayer } from './rewards.js';
import { allowanceView, claimAllowance, markOfferViewed, noteRaceForOffers, shopOffers, shopProducts } from './shop.js';
import { passScreen } from './pass.js';
import { adSessionView, adsView, applyAdCallback, setAdPref, startAd, type AdCallback, type AdPref, type AdRewardResult } from './ads.js';
import { toRaceHorse } from './raceConfig.js';
import { paidBalanceYen, invariantsHold } from './wallet.js';
import type { PaidBalanceSnapshot } from './accounting.js';
import { dayRule, gameDayKey, jstDateKey } from './time.js';
const gameDayKeyOf = (m: Master, now: number) => gameDayKey(now, dayRule(m));
import type { Locale } from '../i18n/locale.js';
import { enqueuePush, ensurePush, nextPushWake, pushPrefsView, registerDevice, setPushPrefs, settlePushes, takeDuePushes, unregisterDevice, type DeliveryOutcome, type DevicePlatform, type PrefsPatch } from './push.js';
import { admitClientBatch, clientToKpi, ensureKpi, isPayer, kpiRecord, type ClientBatch, type KpiEvent, type KpiRecord } from './kpi.js';

/** Collects analytics events inside a transaction; they are emitted only if the transaction is saved. */
export type Emit = (e: KpiEvent) => void;
import type { Ruleset } from './ruleset.js';
import { abortSubmit, prepareSubmit, recordResult, startTimeAttack, timeAttackView } from './timeAttack.js';
import { ensureGoal, mayContribute, playerGoalPending, playerGoalRace, playerGoalReward, playerGoalTa, playerGoalView, weekKeyOf, type GoalContribution } from './teamGoal.js';
import type { VerifierOutput } from './schemas.js';
import { trackById } from './master.js';
import { appearanceOf, assetKeys, defaultSilks, validateSilks, type EntrantVisual, type Silks, effectiveSilks } from './visuals.js';
import type { LeaguePlace } from './league.js';
import { ensureTeam, playerAbortJoin, playerAddOutgoing, playerCommitJoin, playerLeft, playerPrepareJoin, playerRemoveOutgoing, playerTeamReward, snapshotOf } from './teams.js';
import { buyExchange, earnExchangePoints, exchangeView, settleExchanges } from './exchange.js';
import { applyEventResult, cancelEntry, closeEventForPlayer, ensureEvent, enterEvent, eventsForPlayer, findEvent, type EventEntry } from './events.js';
import { bondLevels, bondView, careHorse, horseBondLevel } from './bond.js';
import { dueStudOutbox, ensureStud, nextStudWake, studAcked, studApply, studList, studPeek, studPreview, studReserve, studRetryLater, studSettle, studUnlist, studView, type StudSnapshot, type StudVisibility } from './stud.js';
import { clearStable, forgetStable, setStable, stableLikeGive, stableLikeReceive, stableSnapshot, stableSnapshotKey, stableView, viewerStatus, type StableInput, type StableSnapshot } from './stable.js';
import { clearRoomConditions, presetsView, setCourseLook, setRoomConditions, type RoomConditions } from './presets.js';
import {
  beginnerMissionsView, claimBeginnerMission, claimSeasonMission, consentView, countOnboarding, ensureOnboarding, experimentsView, firstRaceOf,
  grantPartner, missionTable, recordConsent, seasonMissionsView, unlocksView,
} from './onboarding.js';
import { armPromotionNudge, nextNudgeWake, nudgeTaBeaten, nudgeTournamentClosing, runDueNudges, type TournamentClosingInfo } from './nudges.js';
import {
  cancelDeletion, deletionDue, deletionRetryLater, deletionScheduled, deletionSnapshot, deletionView, finalizeDeletion, markDeletionStep,
  nextDeletionWake, notWhileDeleting, requestDeletion, startDeletion, type DeletionStep,
} from './accountDeletion.js';
import {
  ensureFeed, FEED_RACE_MODES, notePostedIn, playerMute, playerReported, playerStampCheck, stampCatalog, stampsOf, type FeedRace, type ReportReason,
} from './teamFeed.js';
import {
  dueInviteOutbox, forfeitInviteOutbox, forgetInvitee, forgetInviter, inviteAcked, inviteeCommit, inviteRetryLater, inviterAccept, inviterMilestone,
  inviterRevert, inviteStateView, nextInviteWake, noteInstall, noteInviteMilestones, recordRedeemAttempt,
} from './invite.js';
import {
  claimComebackLogin, claimComebackMission, comebackView, markComebackWelcomed, markWhatsNewSeen, nextComebackWake, noteActivity, runDueComebackPush, whatsNew,
} from './comeback.js';
import { claimAllGifts, claimGift, expireGifts, giftBadge, giftBoxView, giftGiver, giftsNeedExpiry, nextGiftWake, type OpsTitleKey } from './giftBox.js';
import { finishTraining, startTraining, trainingDelta, trainingTick, trainingView, useTrainingItem } from './training.js';
import { assistView, markAssistPromptSeen, noteRaceForAssist, setAssist, type AssistLevel, type AssistSource } from './assist.js';
import {
  ensureRival, noteRivalRace, noteRivalTa, rivalBlock, rivalChallengeCheck, rivalChallengeReceive, rivalOutbound, rivalSeen, rivalSetOptOut, rivalSync,
  rivalUpdateOf, rivalView, rivalWithdrawn, weekIdAt, weeksToSync, type RegistryWeek, type RivalUpdate,
} from './rival.js';
import {
  coinHistory, gachaHistory, historySummary, pageLimit, purchaseHistory, recordGachaLog, resolveRefs, stateGachaPager, stateLedgerPager,
  HISTORY_LIMITS, type GachaLogEntry, type GachaPager, type LedgerPager, type SupportTopic,
} from './history.js';
import { buildSupportTicket } from '../ops/support.js';
import { abortChallengeSubmit, prepareChallengeSubmit, recordChallengeResult, startChallenge, weeklyChallengeView, type WchStartInput } from './weeklyChallenge.js';

/** Storage for one player's state. The Durable Object implements this with SQLite; tests use memory. */
export interface PlayerRepo {
  get(id: string): PlayerState | null | Promise<PlayerState | null>;
  put(state: PlayerState): void | Promise<void>;
  /** REQ-UXS-040: removes the player's state (memory repos; the Durable Object deletes its whole storage). */
  delete?(id: string): void | Promise<void>;
  /** r10: the account deletion wiped this id (a tombstone was kept). Absent = no tombstones (treated as never deleted). */
  tombstoned?(id: string): boolean | Promise<boolean>;
  /**
   * REQ-HIST-003/004: older history than the state JSON keeps (the Durable Object's `ledger` / `gacha_log` tables).
   * Absent = the state holds every row (memory repos, the prototype).
   */
  ledgerPage?(id: string, q: Parameters<LedgerPager>[0]): LedgerEntry[] | Promise<LedgerEntry[]>;
  gachaPage?(id: string, q: Parameters<GachaPager>[0]): GachaLogEntry[] | Promise<GachaLogEntry[]>;
}

/** REQ-HIST-*: which list `history` reads, and its query. */
export type HistoryKindArg = 'summary' | 'purchases' | 'coins' | 'gacha';
export interface HistoryQuery { cursor?: string | null; limit?: number | null; currency?: Currency | null }

/** REQ-UXS-040: purchases, offers and the daily pack are disabled while the account is scheduled for deletion. */
/** REQ-SHORT-005: what GET /v1/shop/shortfall asks about. */
export type ShortfallQuery =
  | { for: 'gacha'; bannerId: string; count: 1 | 10 }
  | { for: 'cosmetic'; itemId: string }
  | { for: 'coins'; coins: number; kind: 'any' | 'paid' };

function notDeleting(s: PlayerState) {
  if (deletionScheduled(s)) throw new AppError('DELETION_PENDING', 'the account is scheduled for deletion');
}

/** REQ-UXS-014/015: a breeding (own pair or a borrowed stallion) counts toward unlocks and beginner missions. */
function countBreeding(s: PlayerState) {
  ensureOnboarding(s).breedings += 1;
  countOnboarding(s, 'breed');
}

export class MemoryPlayerRepo implements PlayerRepo {
  readonly data = new Map<string, string>();
  /** r10: ids whose account deletion wiped the state (delete() keeps a tombstone, like the Durable Object). */
  readonly tombstones = new Set<string>();
  get(id: string) {
    const j = this.data.get(id);
    return j ? (JSON.parse(j) as PlayerState) : null;
  }
  put(s: PlayerState) {
    this.data.set(s.id, JSON.stringify(s));
  }
  delete(id: string) { this.data.delete(id); this.tombstones.add(id); }
  tombstoned(id: string) { return this.tombstones.has(id); }
}

/** REQ-BOX-010: how an ops grant lands in the gift box. */
export interface AdminGiftOptions { source?: 'ops_grant' | 'ops_compensation'; titleKey?: OpsTitleKey; expiryDays?: number | null }

export interface PlayerServiceDeps {
  master: Master;
  rng: Rng;
  /** REQ-TRAIN-005: the training beat seeds (default: `rng`). The economy sim passes its own so gacha draws stay the same. */
  trainingRng?: Rng;
  /** REQ-WCH-003: challenge session ids and race seeds (default: `rng`). The economy sim passes its own so gacha draws stay the same. */
  challengeRng?: Rng;
  clock: Clock;
  verifiers: Partial<Record<PurchaseRecord['platform'], StoreVerifier>>;
  onPaidBalance?: (snap: PaidBalanceSnapshot) => void | Promise<void>;
  /** Global store-transaction owner index: one receipt can only ever credit one player. */
  storeIndex?: { claim(key: string, playerId: string): Promise<string> };
  /** REQ-LB-002: called after a change to the player's ranked standing (or name/title while ranked this season). */
  onSeasonEntry?: (e: SeasonEntry) => void | Promise<void>;
  /** REQ-SOCIAL-004: called when the public profile changed or the last push is older than profilePushIntervalMs. */
  onProfile?: (p: PublicProfile) => void | Promise<void>;
  /** REQ-PUSH-005: the push outbox needs attention at `at` (the Durable Object sets its alarm). */
  onPushWake?: (at: number) => void | Promise<void>;
  /** REQ-KPI-002: analytics events from a saved transaction (the Durable Object writes them to Analytics Engine). */
  onKpi?: (playerId: string, records: KpiRecord[]) => void | Promise<void>;
  /** REQ-TEAM-005: the player's season standing changed while in a team (the Durable Object tells the team). */
  onTeamPoints?: (p: { teamId: string; playerId: string; seasonId: string; points: number; displayName: string }) => void | Promise<void>;
  /** REQ-EVENT-007: event standing after an event race (the Durable Object tells the event board). */
  onEventEntry?: (e: EventEntry) => void | Promise<void>;
  /** REQ-STABLE-003: the public stable copy changed (null = remove it: cleared or banned). The Durable Object writes the directory. */
  onStable?: (playerId: string, snap: StableSnapshot | null) => void | Promise<void>;
  /** REQ-TEAMFEED-004: a member won or placed in a ranked / tournament race (the Durable Object tells the team feed). */
  onTeamFeed?: (p: { teamId: string; playerId: string; displayName: string; race: FeedRace }) => void | Promise<void>;
  /**
   * REQ-RIVAL-002/005/011: what the week's rival registry must learn from a saved transaction (candidate entry, withdrawal,
   * a pair I dissolved, new weekly time-attack bests). Best effort: RivalService re-sends what matters on the next sync.
   */
  onRival?: (u: RivalUpdate) => void | Promise<void>;
  /** REQ-TGOAL-003: a confirmed event counts toward the team's weekly goal (the Durable Object tells the team; throws when it is unreachable). */
  onTeamGoal?: (c: GoalContribution) => Promise<{ milestone: number | null } | null | undefined | void>;
  /** REQ-TGOAL-006: remove a quarantined / banned player's contribution from a team's weekly goal. */
  onTeamGoalForget?: (p: { teamId: string; playerId: string }) => Promise<unknown>;
}

const standingKey = (s: PlayerState) => JSON.stringify([s.season.id, s.season.classId, s.season.points, s.season.races, Math.round(s.rating.r), s.profile.displayName, s.profile.titleId]);
const profileKey = (s: PlayerState) => JSON.stringify([s.profile.displayName, s.profile.titleId, s.season.classId, Math.round(s.rating.r), s.stats.races, s.stats.wins, s.stats.top3]);

const IDEM_KEEP = 200;
/**
 * The object's alarm serves the push outbox, the stud fee outbox (REQ-PUSH-005, REQ-BREED-012), personal
 * nudges (REQ-UXS-012), a scheduled account deletion (REQ-UXS-040), invite milestone deliveries (REQ-INV-007)
 * comeback lapse reminders (REQ-CB-007) and gift box expiry (REQ-BOX-006).
 */
const nextWake = (s: PlayerState) => {
  const all = [nextPushWake(s), nextStudWake(s), nextNudgeWake(s), nextDeletionWake(s), nextInviteWake(s), nextComebackWake(s), nextGiftWake(s)].filter((x): x is number => x !== null);
  return all.length ? Math.min(...all) : null;
};
/** How long applied race ids are remembered (well beyond any settlement/dead-letter retry window). */
const APPLIED_RACE_KEEP_MS = 180 * 24 * 3600 * 1000;

/**
 * Application service for one player's data. Every mutation runs on a cloned draft and is saved only
 * if it completes (all-or-nothing, REQ-GACHA-009). Mutations with an idempotency key return the stored
 * result on retry (REQ-API-003, REQ-WAL-004).
 */
export class PlayerService {
  constructor(private readonly repo: PlayerRepo, private readonly d: PlayerServiceDeps) {}

  /** Swaps in the active remote config's master (REQ-OPS-005). */
  setMaster(m: Master) { this.d.master = m; }

  private async load(id: string): Promise<PlayerState> {
    const s = await this.repo.get(id);
    if (s) {
      migratePlayer(s);
      migrateSkills(this.d.master, s.horses); // REQ-UXS-050: template horses stored before skills existed
      return s;
    }
    const now = this.d.clock();
    return newPlayer(id, now, seasonIdFor(now));
  }

  async tx<T>(id: string, idemKey: string | null, fn: (s: PlayerState, now: number, emit: Emit) => T): Promise<T> {
    const current = await this.load(id);
    if (idemKey) {
      const hit = current.idem.find((e) => e.key === idemKey);
      if (hit) return hit.result as T;
    }
    const draft: PlayerState = structuredClone(current);
    const now = this.d.clock();
    rollSeason(this.d.master, draft, now);
    settlePityGroups(this.d.master, draft, now);
    const paidBefore = draft.wallet.paid;
    const standingBefore = standingKey(draft);
    const profileBefore = profileKey(draft);
    const wakeBefore = nextWake(draft);
    const stableBefore = this.d.onStable ? stableSnapshotKey(this.d.master, draft, now) : '';
    const rivalBefore = this.d.onRival ? rivalOutbound(this.d.master, draft, now) : null;
    const kpi: KpiRecord[] = [];
    const emit: Emit = (e) => { kpi.push(kpiRecord(draft, now, e)); };
    expireGifts(this.d.master, draft, now, emit); // REQ-BOX-006: lazy expiry on every transaction (the alarm runs one too)
    settleExchanges(this.d.master, draft, now, giftGiver(this.d.master, draft, now, emit)); // REQ-EXCH-006 / §26.1: leftover event points → material, into the gift box
    let result: T;
    try { result = fn(draft, now, emit); }
    catch (e) {
      // REQ-SHORT-004: a coin spend refused for lack of coins says what is short and the one pack that covers it.
      // Nothing of the draft is kept (the transaction is dropped and no idempotency record is written).
      attachShortfall(this.d.master, draft, e, now);
      throw e;
    }
    noteInviteMilestones(this.d.master, draft, now, emit); // REQ-INV-007: the invitee's milestones, once each
    // REQ-ACH-003: unlock achievement tiers that became due in this transaction (idempotent), then their titles
    if (syncCollection(this.d.master, draft, now, emit).length > 0) evaluateTitles(this.d.master, draft);
    if (!invariantsHold(draft)) throw new Error('wallet invariant violated');
    if (idemKey) {
      draft.idem.push({ key: idemKey, result: JSON.parse(JSON.stringify(result ?? null)) });
      if (draft.idem.length > IDEM_KEEP) draft.idem.splice(0, draft.idem.length - IDEM_KEEP);
    }
    draft.profile.lastSeenAt = now;
    // REQ-UXS-040: once the deletion has started, nothing public is written for the player again (the run removes the
    // directory profile and board rows step by step; a later transaction of the same run or a retry must not put them
    // back), and after the balances were forfeited the paid balance is not reported (retainDeleted removes that row).
    const deleting = draft.deletion?.status === 'deleting';
    const pushProfile = !deleting && this.d.onProfile && (profileKey(draft) !== profileBefore || now - draft.profile.lastPushedAt >= this.d.master.progression.social.profilePushIntervalMs);
    if (pushProfile) draft.profile.lastPushedAt = now;
    await this.repo.put(draft);
    const wake = nextWake(draft);
    if (wake !== null && wake !== wakeBefore && this.d.onPushWake) await this.d.onPushWake(wake);
    if (kpi.length > 0 && this.d.onKpi) await this.d.onKpi(id, kpi);
    if (pushProfile) await this.d.onProfile!(publicProfile(draft, this.d.master.bannedSilks));
    if (this.d.onStable && stableSnapshotKey(this.d.master, draft, now) !== stableBefore) await this.d.onStable(id, stableSnapshot(this.d.master, draft, now));
    if (this.d.onRival) {
      const u = rivalUpdateOf(id, rivalBefore, rivalOutbound(this.d.master, draft, now));
      if (u) { try { await this.d.onRival(u); } catch (e) { console.error('rival registry update failed', id, (e as Error).message); } }
    }
    if (!deleting && this.d.onSeasonEntry && draft.season.races > 0 && standingKey(draft) !== standingBefore) {
      await this.d.onSeasonEntry({
        playerId: id, seasonId: draft.season.id, classId: draft.season.classId, points: draft.season.points, rating: Math.round(draft.rating.r),
        races: draft.season.races, displayName: draft.profile.displayName, titleId: draft.profile.titleId, updatedAt: now,
      });
    }
    const teamId = draft.team?.teamId ?? null;
    if (!deleting && this.d.onTeamPoints && teamId && (standingKey(draft) !== standingBefore || teamId !== (current.team?.teamId ?? null))) {
      await this.d.onTeamPoints({ teamId, playerId: id, seasonId: draft.season.id, points: draft.season.points, displayName: draft.profile.displayName });
    }
    if (draft.wallet.paid !== paidBefore && this.d.onPaidBalance && !draft.deletion?.record) {
      await this.d.onPaidBalance({ playerId: id, date: jstDateKey(now), paidCoins: draft.wallet.paid, paidYen: paidBalanceYen(draft), seq: draft.ledgerSeq });
    }
    return result;
  }

  /** Keys passed in from clients must be namespaced (`c:` prefix, see http/app.ts clientIdemKey). */
  private requireKey(k: string | null | undefined): string {
    if (!k) throw new AppError('IDEMPOTENCY_KEY_REQUIRED');
    if (!k.startsWith('c:')) throw new AppError('BAD_REQUEST', 'client idempotency key must be namespaced');
    return k;
  }

  /** REQ-UXS-001/014/032/040: computed sections of GET /v1/player and bootstrap. */
  private extras(s: PlayerState, now: number) {
    const m = this.d.master;
    return { consent: consentView(m, s), unlocks: unlocksView(m, s, now), experiments: experimentsView(m, s.id), deletion: deletionView(s), giftBox: giftBadge(m, s, now), assist: assistView(s) };
  }

  async view(id: string) {
    const s = await this.load(id);
    return playerView(s, this.d.master.bannedSilks, this.extras(s, this.d.clock()));
  }

  async state(id: string) { return this.load(id); }

  bootstrap(id: string) {
    return this.tx(id, null, (s, now, emit) => {
      const k = ensureKpi(s);
      if (!k.firstOpenSent) { k.firstOpenSent = true; emit({ name: 'first_open' }); }
      const extra = this.extras(s, now);
      // REQ-UXS-032: one ab_assign row per experiment and player, so KPI queries can split any funnel by bucket
      const sent = (k.abSent ??= []);
      for (const [exp, bucket] of Object.entries(extra.experiments.assignments)) {
        if (sent.includes(exp)) continue;
        sent.push(exp);
        emit({ name: 'ab_assign', s1: exp, s2: bucket });
      }
      if (sent.length > 50) sent.splice(0, sent.length - 50);
      noteActivity(this.d.master, s, now, emit); // REQ-CB-001: app start = an active day (may start a comeback window)
      return playerView(s, this.d.master.bannedSilks, extra);
    });
  }

  // ---- onboarding (REQ-UXS-001/002) ----
  recordConsent(id: string, termsVersion: string, privacyVersion: string) {
    return this.tx(id, null, (s, now, emit) => {
      const before = s.consent ? `${s.consent.termsVersion}|${s.consent.privacyVersion}` : null;
      const r = recordConsent(this.d.master, s, termsVersion, privacyVersion, now);
      if (before !== `${termsVersion}|${privacyVersion}`) emit({ name: 'consent', s1: termsVersion, s2: privacyVersion });
      return r;
    });
  }
  async grantPartner(id: string, name: string, idemKey: string | null) {
    return this.tx(id, this.requireKey(idemKey), (s, now, emit) => {
      const r = grantPartner(this.d.master, s, name, now);
      emit({ name: 'partner_granted', s1: r.horse.templateId ?? '' });
      return r;
    });
  }

  // ---- account deletion (REQ-UXS-040) ----
  requestDeletion(id: string, confirmToken: string | null) {
    return this.tx(id, null, (s, now, emit) => {
      const was = deletionScheduled(s);
      const r = requestDeletion(this.d.master, s, confirmToken, this.d.rng, now);
      if (!was && deletionScheduled(s)) emit({ name: 'account_delete', s1: 'requested' });
      return r;
    });
  }
  cancelDeletion(id: string) {
    return this.tx(id, null, (s, _now, emit) => {
      const r = cancelDeletion(s);
      emit({ name: 'account_delete', s1: 'cancelled' });
      return r;
    });
  }
  async deletionDue(id: string) { return deletionDue(await this.load(id), this.d.clock()); }
  async deletionSnapshot(id: string) { return deletionSnapshot(await this.load(id)); }
  deletionStart(id: string) { return this.tx(id, null, (s) => startDeletion(s)); }
  deletionMarkStep(id: string, step: DeletionStep) { return this.tx(id, null, (s) => { markDeletionStep(s, step); }); }
  deletionRetryLater(id: string) { return this.tx(id, null, (s, now) => deletionRetryLater(s, now)); }
  /** Forfeits balances and returns the anonymised record (emitted once as account_delete/deleted). */
  deletionFinalize(id: string) {
    return this.tx(id, null, (s, now, emit) => {
      const had = !!s.deletion?.record;
      const r = finalizeDeletion(this.d.master, s, this.d.rng, now);
      if (!had) emit({ name: 'account_delete', s1: 'deleted', paidCoins: r.forfeited.paidCoins, freeCoins: r.forfeited.freeCoins });
      return r;
    });
  }
  /** Next nudge / deletion time (the object's alarm keeps them armed; push and stud have their own). */
  async nextWakeOf(id: string) {
    const s = await this.load(id);
    const all = [nextNudgeWake(s), nextDeletionWake(s), nextInviteWake(s), nextComebackWake(s), nextGiftWake(s)].filter((x): x is number => x !== null);
    return all.length ? Math.min(...all) : null;
  }
  /**
   * REQ-UXS-040: a player with no stored state at all. For the deliveries other objects send (season / tournament /
   * event / team rewards, stud fees, pushes, nudges) this can only be an account that was deleted and wiped: boards
   * and brackets keep a renamed row until they close, and running the delivery would create a fresh state under the
   * deleted id (with the reward in it). Those calls are answered as no-ops instead.
   */
  private async wiped(id: string) { return !(await this.repo.get(id)); }

  /** Tests / memory repos: drop the stored state (the Durable Object deletes its whole storage instead). */
  async wipe(id: string) { if (this.repo.delete) await this.repo.delete(id); }

  // ---- personal nudges (REQ-UXS-012) ----
  /** Alarm: due nudges (promotion). */
  runNudges(id: string) {
    return this.tx(id, null, (s, now) => {
      runDueComebackPush(this.d.master, s, now); // REQ-CB-007: lapse reminders share the alarm
      return runDueNudges(this.d.master, s, now);
    });
  }
  async nudgeTaBeaten(id: string, byName: string, course: string) {
    if (await this.wiped(id)) return { status: 'skipped' as const, reason: 'deleted' as const };
    return this.tx(id, null, (s, now) => nudgeTaBeaten(this.d.master, s, byName, course, now));
  }
  async nudgeTournamentClosing(id: string, info: TournamentClosingInfo) {
    if (await this.wiped(id)) return { status: 'skipped' as const, reason: 'deleted' as const };
    return this.tx(id, null, (s, now) => nudgeTournamentClosing(this.d.master, s, info, now));
  }

  setAge(id: string, birthYear: number, birthMonth: number, guardianConsent: boolean) {
    return this.tx(id, null, (s, now) => {
      const r = registerAge(this.d.master, s, birthYear, birthMonth, guardianConsent, now);
      return { age: r.age, band: r.band.id, monthlyLimitYen: r.band.monthlyLimitYen };
    });
  }

  async purchaseIntent(id: string, productId: string) {
    const s = await this.load(id);
    if (moderationOf(s, this.d.clock()) === 'banned') throw new AppError('BANNED', 'purchases are disabled for this account'); // REQ-OPS-033
    // REQ-UXS-040: no new purchases while the account is scheduled for deletion (cancel the deletion to buy)
    notDeleting(s);
    return checkPurchaseIntent(this.d.master, s, productId, this.d.clock());
  }

  async purchase(id: string, platform: PurchaseRecord['platform'], productId: string, receipt: string) {
    const v = this.d.verifiers[platform];
    if (!v) throw new AppError('BAD_REQUEST', `unsupported platform ${platform}`);
    const r = await v.verify(receipt, productId, { playerId: id }); // throws RECEIPT_INVALID
    await this.claimStoreKeys(id, r);
    const out = await this.tx(id, `purchase:${r.transactionId}`, (s, now, emit) => {
      const first = !isPayer(s);
      const { record, duplicate } = applyVerifiedPurchase(this.d.master, s, platform, r, now);
      // A completed store payment is always credited; a banned account gets a support flag (refund via support).
      if (!duplicate && moderationOf(s, now) === 'banned') (s.supportFlags ??= []).push(`purchase_while_banned:${record.txId}`);
      if (!duplicate && deletionScheduled(s)) (s.supportFlags ??= []).push(`purchase_while_deletion_pending:${record.txId}`);
      if (!duplicate) emit({ name: 'purchase', s1: record.productId, s2: platform, s3: record.sandbox ? 'sandbox' : 'real', amountYen: record.priceYen, paidCoins: record.paidCoinsGranted, freeCoins: record.bonusCoinsGranted, isFirst: first && record.priceYen > 0 && !record.sandbox });
      return { record, duplicate, wallet: playerView(s).wallet };
    });
    if (v.finalize) {
      // Consume/acknowledge only after the grant is saved. A failure is retried when the app re-sends the receipt.
      try {
        await v.finalize(r);
      } catch (e) {
        console.error('store finalize failed', platform, r.transactionId, e);
      }
    }
    return out;
  }

  private async claimStoreKeys(id: string, r: VerifiedReceipt) {
    if (!this.d.storeIndex) return;
    for (const key of [r.transactionId, r.originalTransactionId]) {
      if (!key) continue;
      const owner = await this.d.storeIndex.claim(key, id);
      if (owner === '__revoked__') throw new AppError('RECEIPT_INVALID', 'this purchase was refunded or revoked');
      if (owner !== id) throw new AppError('RECEIPT_INVALID', 'this purchase is already linked to another player');
    }
  }

  /** Store server notification: a new subscription period (Apple DID_RENEW/SUBSCRIBED, Google RENEWED…). Idempotent. */
  async storeRenewal(id: string, platform: PurchaseRecord['platform'], r: VerifiedReceipt) {
    await this.claimStoreKeys(id, r);
    return this.tx(id, `purchase:${r.transactionId}`, (s, now, emit) => {
      const { record, duplicate } = applyVerifiedPurchase(this.d.master, s, platform, r, now);
      if (!duplicate) emit({ name: 'pass_renew', s1: record.productId, s2: platform, amountYen: record.priceYen });
      return { record, duplicate, passExpiresAt: s.seasonPass.expiresAt };
    });
  }

  /** Store server notification: subscription status change (expired, revoked, grace…). */
  subscriptionStatus(id: string, platform: PurchaseRecord['platform'], key: string, status: SubscriptionStatus, expiresAt: number | null) {
    return this.tx(id, null, (s, now, emit) => {
      const r = applySubscriptionStatus(this.d.master, s, platform, key, status, expiresAt, now);
      emit({ name: 'pass_status', s1: String(status), s2: platform });
      return r;
    });
  }

  refund(id: string, transactionId: string) {
    return this.tx(id, `refund:${transactionId}`, (s, now, emit) => {
      const rec = s.purchases.find((x) => x.txId === transactionId);
      const wasRefunded = rec?.refunded ?? true;
      const r = applyRefund(this.d.master, s, transactionId, now);
      if (rec && !wasRefunded) emit({ name: 'refund', s1: rec.productId, s2: rec.platform, amountYen: -rec.priceYen });
      return r;
    });
  }

  async draw(id: string, bannerId: string, count: 1 | 10, idemKey: string | null) {
    return this.tx(id, this.requireKey(idemKey), (s, now, emit) => {
      const r = drawGacha(this.d.master, s, bannerId, count, this.d.rng, now);
      countOnboarding(s, 'gacha');
      recordGachaLog(s, now, { bannerId: r.bannerId, via: 'coins', count, paid: r.spent.paid, free: r.spent.free, results: r.results }); // REQ-HIST-004
      emit({ name: 'gacha_draw', s1: bannerId, count, paidCoins: r.spent.paid, freeCoins: r.spent.free, value: r.results.filter((x) => x.rarity === 'SSR').length });
      return { ...r, wallet: playerView(s).wallet };
    });
  }

  async tutorialDraw(id: string, idemKey: string | null) {
    return this.tx(id, this.requireKey(idemKey), (s, now, emit) => {
      const r = drawGacha(this.d.master, s, 'standard', 10, this.d.rng, now, { tutorialFree: true });
      countOnboarding(s, 'gacha');
      recordGachaLog(s, now, { bannerId: r.bannerId, via: 'tutorial', count: 10, paid: 0, free: 0, results: r.results }); // REQ-HIST-004
      emit({ name: 'tutorial_gacha', count: 10 });
      return r;
    });
  }

  /** REQ-GACHA-012..014: pity meter, carry-over rule and step-up progress (read only; the period-end conversion is previewed). */
  async gachaStatus(id: string) { return gachaStatus(this.d.master, await this.load(id), this.d.clock()); }

  async pityExchange(id: string, bannerId: string, templateId: string, idemKey: string | null) {
    return this.tx(id, this.requireKey(idemKey), (s, now) => exchangePity(this.d.master, s, bannerId, templateId, now));
  }

  nameHorse(id: string, horseId: string, name: string) { return this.tx(id, null, (s) => nameHorse(this.d.master, s, horseId, name)); }
  async awaken(id: string, horseId: string, idemKey: string | null) { return this.tx(id, this.requireKey(idemKey), (s) => awaken(this.d.master, s, horseId)); }
  retire(id: string, horseId: string) { return this.tx(id, null, (s) => retire(s, horseId)); }

  async breedingPreview(id: string, sireId: string, damId: string) {
    return breedingPreviewWithAllowance(this.d.master, await this.load(id), sireId, damId, this.d.clock());
  }
  async breed(id: string, sireId: string, damId: string, idemKey: string | null, useMaterial = false) {
    const key = this.requireKey(idemKey);
    return this.tx(id, key, (s, now) => {
      const r = breed(this.d.master, s, sireId, damId, this.d.rng, now, { useMaterial, ref: key });
      countBreeding(s);
      return r;
    });
  }

  // ---- stud lending (REQ-BREED-010..016; orchestrated across players by studService.ts) ----
  studView(id: string) { return this.tx(id, null, (s, now) => studView(this.d.master, s, now)); }
  studList(id: string, horseId: string, visibility: StudVisibility, fee: number, dailyLimit: number) {
    return this.tx(id, null, (s, now) => studList(this.d.master, s, horseId, visibility, fee, dailyLimit, now));
  }
  studUnlist(id: string, horseId: string) { return this.tx(id, null, (s) => studUnlist(s, horseId)); }
  /** Owner: snapshot for a preview (reserves nothing). */
  async studPeek(id: string, borrowerId: string, horseId: string) {
    const s = await this.load(id);
    return studPeek(this.d.master, s, borrowerId, horseId, this.d.clock());
  }
  studReserve(id: string, opId: string, borrowerId: string, horseId: string, expectedFee?: number) {
    return this.tx(id, null, (s, now) => studReserve(this.d.master, s, opId, borrowerId, horseId, now, expectedFee));
  }
  async studSettle(id: string, opId: string, ok: boolean, info: { borrowerId: string; horseId: string; fee: number; foalId: string | null }) {
    // the owner's account was deleted: nothing to pay into (the borrower acknowledges and stops retrying)
    if (await this.wiped(id)) return { opId, status: 'already' as const, paid: 0 };
    return this.tx(id, null, (s, now) => studSettle(this.d.master, s, opId, ok, info, now));
  }
  async studPreview(id: string, snap: StudSnapshot & { remainingToday?: number }, damId: string) {
    const s = await this.load(id);
    return studPreview(this.d.master, s, snap, damId, this.d.clock());
  }
  studApply(id: string, opId: string, snap: StudSnapshot, damId: string, useMaterial: boolean) {
    return this.tx(id, null, (s, now, emit) => {
      const before = s.stud?.applied[opId];
      const r = studApply(this.d.master, s, opId, snap, damId, this.d.rng, now, useMaterial);
      if (!before) countBreeding(s);
      if (!before) emit({ name: 'stud_breed', s1: snap.ownerId, s2: snap.horseId, count: 1, paidCoins: 0, freeCoins: r.fee, value: r.atavism ? 1 : 0 });
      return r;
    });
  }
  studAcked(id: string, opId: string) { return this.tx(id, null, (s) => studAcked(s, opId)); }
  /** Alarm: fee payments not yet acknowledged by their owners. */
  async studDue(id: string) {
    const s = await this.load(id);
    ensureStud(s);
    return dueStudOutbox(s, this.d.clock());
  }
  studRetryLater(id: string, opId: string) { return this.tx(id, null, (s, now) => studRetryLater(this.d.master, s, opId, now)); }

  // ---- items & cosmetics (REQ-ITEM-*) ----
  /** Use a gacha ticket (bannerId required) or an SR+ ticket. Idempotent per client key. */
  async useTicket(id: string, itemId: string, bannerId: string | null, idemKey: string | null) {
    const key = this.requireKey(idemKey);
    return this.tx(id, key, (s, now, emit) => {
      const r = useTicket(this.d.master, s, itemId, bannerId, this.d.rng, now, key);
      countOnboarding(s, 'gacha');
      const pulls = r.results ?? [r.result];
      recordGachaLog(s, now, { bannerId: r.bannerId, via: 'ticket', itemId, count: pulls.length, paid: 0, free: 0, results: pulls }); // REQ-HIST-004
      emit({ name: 'gacha_draw', s1: bannerId ?? itemId, s2: 'ticket', count: pulls.length, paidCoins: 0, freeCoins: 0, value: pulls.filter((x) => x.rarity === 'SSR').length });
      return r;
    });
  }
  async cosmetics(id: string) { return cosmeticsCatalog(this.d.master, await this.load(id)); }
  async buyCosmetic(id: string, itemId: string, idemKey: string | null) {
    const key = this.requireKey(idemKey);
    return this.tx(id, key, (s, now) => ({ ...buyCosmetic(this.d.master, s, itemId, now, key), wallet: playerView(s).wallet }));
  }
  setEquipment(id: string, patch: EquipmentPatch) {
    return this.tx(id, null, (s) => ({ equipment: setEquipment(this.d.master, s, patch) }));
  }
  async pedigree(id: string, horseId: string) { return pedigree(await this.load(id), horseId); }

  async claimLogin(id: string, idemKey: string | null) {
    return this.tx(id, this.requireKey(idemKey), (s, now, emit) => {
      noteActivity(this.d.master, s, now, emit);
      const r = claimLoginBonus(this.d.master, s, now);
      emit({ name: 'login_bonus', value: r.day });
      return r;
    });
  }
  async missions(id: string) { return this.tx(id, null, (s, now) => missionsView(this.d.master, s, now)); }
  /**
   * GET /v1/missions: daily (REQ-REW-002), beginner (REQ-UXS-015) and season missions (REQ-UXS-016), plus
   * today's first-win bonus (REQ-UXS-010, home screen "today" list).
   */
  async missionsAll(id: string) {
    return this.tx(id, null, (s, now, emit) => (noteActivity(this.d.master, s, now, emit), {
      missions: missionsView(this.d.master, s, now), beginner: beginnerMissionsView(this.d.master, s), season: seasonMissionsView(this.d.master, s),
      firstWinBonus: firstWinBonusView(this.d.master, s, now),
    }));
  }
  async claimMission(id: string, missionId: string, idemKey: string | null) {
    return this.tx(id, this.requireKey(idemKey), (s, now) => {
      const table = missionTable(this.d.master, missionId);
      if (table === 'beginner') return claimBeginnerMission(this.d.master, s, missionId, now);
      if (table === 'season') return claimSeasonMission(this.d.master, s, missionId, now);
      return claimMission(this.d.master, s, missionId, now);
    });
  }
  // ---- returning players and what's new (REQ-CB-*, comeback.ts) ----
  /** GET /v1/comeback: an active day too (a window may start here when the app skipped bootstrap). */
  comeback(id: string) { return this.tx(id, null, (s, now, emit) => { noteActivity(this.d.master, s, now, emit); return comebackView(this.d.master, s, now); }); }
  async comebackClaimLogin(id: string, idemKey: string | null) {
    return this.tx(id, this.requireKey(idemKey), (s, now, emit) => claimComebackLogin(this.d.master, s, now, emit));
  }
  async comebackClaimMission(id: string, missionId: string, idemKey: string | null) {
    return this.tx(id, this.requireKey(idemKey), (s, now, emit) => claimComebackMission(this.d.master, s, missionId, now, emit));
  }
  comebackWelcomed(id: string) { return this.tx(id, null, (s, now) => markComebackWelcomed(this.d.master, s, now)); }
  whatsNew(id: string) { return this.tx(id, null, (s, now) => whatsNew(this.d.master, s, now)); }
  whatsNewSeen(id: string, upTo: number) { return this.tx(id, null, (s, now) => markWhatsNewSeen(this.d.master, s, upTo, now)); }

  /** REQ-UXS-020/021: runs in a transaction so a new month first closes the old pass (auto-grant) and resets it. */
  async passView(id: string) { return this.tx(id, null, (s, now) => passScreen(this.d.master, s, now)); }
  /** REQ-UXS-010: today's first-win bonus state (home screen "today" list). */
  async firstWinBonus(id: string) { return firstWinBonusView(this.d.master, await this.load(id), this.d.clock()); }

  // ---- shop offers and the daily pack (REQ-UXS-017/018) ----
  /** Lazy triggers (race count, season start, promotion) are recorded, so this runs in a transaction. */
  // REQ-UXS-040: while a deletion is scheduled no offer is shown and no daily pack is paid (like purchase-intent)
  /** r10: the product list with this player's ownership (GET /v1/shop/products?mine=1). Read-only. */
  /**
   * REQ-SHORT-005: GET /v1/shop/shortfall — the shortfall of a gacha pull, a cosmetic or an amount before trying (read
   * only). Prices come from the same functions the payment uses (gachaPrice, the cosmetic's price and currency).
   */
  async coinShortfall(id: string, q: ShortfallQuery) {
    const s = structuredClone(await this.load(id));
    const now = this.d.clock();
    const m = this.d.master;
    rollSeason(m, s, now); // the copy only: a season close is not saved by a read
    if (q.for === 'gacha') {
      const b = findBanner(m, q.bannerId);
      assertBannerOpen(b, now); // the pull would be refused for this first (BANNER_CLOSED), so is its preview
      return coinShortfall(m, s, { coinKind: b.currency === 'paidOnly' ? 'paid' : 'any', need: gachaPrice(b, s, b.stepUp ? 10 : q.count) }, now);
    }
    if (q.for === 'cosmetic') {
      const c = findCosmetic(m, q.itemId);
      if (c.notForSale) throw new AppError('NOT_ELIGIBLE', `${c.id} is not sold for coins`);
      if ((s.items[c.id] ?? 0) > 0) throw new AppError('ALREADY_PURCHASED', `${c.id} is already owned`);
      return coinShortfall(m, s, { coinKind: c.currency === 'paidOnly' ? 'paid' : 'any', need: c.price }, now);
    }
    return coinShortfall(m, s, { coinKind: q.kind, need: q.coins }, now);
  }

  async shopProducts(id: string) { return shopProducts(this.d.master, { s: await this.load(id), now: this.d.clock() }); }
  shopOffers(id: string) { return this.tx(id, null, (s, now) => { notDeleting(s); return shopOffers(this.d.master, s, now); }); }
  markOfferViewed(id: string, offerId: string) { return this.tx(id, null, (s, now) => { notDeleting(s); return markOfferViewed(this.d.master, s, offerId, now); }); }
  async allowance(id: string) { return allowanceView(this.d.master, await this.load(id), this.d.clock()); }
  async claimAllowance(id: string, idemKey: string | null) {
    return this.tx(id, this.requireKey(idemKey), (s, now) => { notDeleting(s); return { ...claimAllowance(this.d.master, s, now), wallet: playerView(s).wallet }; });
  }
  // ---------------------------------------------------------------- rewarded ads (REQ-AD-*, ads.ts)
  /** GET /v1/ads: offer cards, today's counts, why ads are hidden. */
  async ads(id: string) { return adsView(this.d.master, await this.load(id), this.d.clock()); }
  /** PUT /v1/ads/preferences: 'auto' (default: hidden for 30 days after a payment), 'on' (opt in), 'off' (never). */
  async setAdPref(id: string, pref: AdPref) {
    return this.tx(id, null, (s, now) => { setAdPref(s, pref); return adsView(this.d.master, s, now); });
  }
  /** POST /v1/ads/:placementId/start (keyed): opens a session; the reward comes only from the SSV callback. */
  async adStart(id: string, placementId: string, idemKey: string | null) {
    return this.tx(id, this.requireKey(idemKey), (s, now) => startAd(this.d.master, s, placementId, this.d.rng, now));
  }
  async adSession(id: string, sessionId: string) { return adSessionView(this.d.master, await this.load(id), sessionId, this.d.clock()); }
  /** A verified SSV callback (signature checked by src/ads/ssv.ts). Idempotent by the network transaction id. */
  async adReward(id: string, cb: AdCallback): Promise<AdRewardResult> {
    // r10 QA: the signed user_id is whatever the app passed to the SDK, so it may name a player with no state (never
    // played, or wiped by an account deletion). No session can exist there: reject without writing, so a callback never
    // creates a player — nor resurrects a deleted one past its tombstone.
    if (!(await this.repo.get(id))) return { status: 'rejected', reason: 'unknown_session', sessionId: null };
    return this.tx(id, `ad:${cb.network}:${cb.transactionId}`, (s, now, emit) => applyAdCallback(this.d.master, s, cb, now, emit));
  }

  // ---------------------------------------------------------------- 調教 training (REQ-TRAIN-*, training.ts)
  /** GET /v1/training: slots, menus, each active horse's growth / fatigue; an expired open session is settled here. */
  async training(id: string) {
    const s = await this.load(id);
    const now = this.d.clock();
    // read-only unless an open session has expired (then it is settled in a transaction)
    if (!s.training?.open || now <= s.training.open.expiresAt) return trainingView(this.d.master, s, now);
    return this.tx(id, null, (st, at, emit) => { trainingTick(this.d.master, st, at, emit); return trainingView(this.d.master, st, at); });
  }
  /** POST /v1/training/start (keyed): uses a slot; the beat schedule comes from a server seed. */
  async trainingStart(id: string, horseId: string, menuId: string, idemKey: string | null) {
    return this.tx(id, this.requireKey(idemKey), (s, now, emit) => {
      notWhileDeleting(s);
      return { ...startTraining(this.d.master, s, horseId, menuId, this.d.trainingRng ?? this.d.rng, now, emit), training: trainingDelta(this.d.master, s, now, horseId) };
    });
  }
  /** POST /v1/training/:sessionId/finish (keyed): the server re-scores the taps against the issued beats. */
  async trainingFinish(id: string, sessionId: string, input: { taps: number[]; skipped?: boolean }, idemKey: string | null) {
    return this.tx(id, this.requireKey(idemKey), (s, now, emit) => { const r = finishTraining(this.d.master, s, sessionId, input, now, emit); return { ...r, training: trainingDelta(this.d.master, s, now, r.horseId) }; });
  }
  /** POST /v1/training/items/:itemId/use (keyed): fatigue relief on one horse. */
  async trainingUseItem(id: string, itemId: string, horseId: string, idemKey: string | null) {
    const key = this.requireKey(idemKey);
    return this.tx(id, key, (s, now) => ({ ...useTrainingItem(this.d.master, s, itemId, horseId, now, key), training: trainingDelta(this.d.master, s, now, horseId) }));
  }

  // ---------------------------------------------------------------- ライバル weekly rival (REQ-RIVAL-*, rival.ts; orchestrated by RivalService)
  /** What the sync needs: the unsettled weeks to ask the registry about, and what to re-send (read only). */
  async rivalPeek(id: string) {
    const s = await this.load(id);
    const now = this.d.clock();
    const cur = weekIdAt(this.d.master, now);
    const w = s.rival?.weeks.find((x) => x.weekId === cur);
    return {
      weeks: weeksToSync(this.d.master, s, now), currentWeek: cur, withdrawn: rivalWithdrawn(s, now), optOut: !!s.rival?.optOut,
      dissolveMine: w?.assignment?.kind === 'human' && w.assignment.dissolvedBy === 'me', ta: { ...(w?.ta ?? {}) },
      entry: rivalOutbound(this.d.master, s, now)?.entry ?? null,
    };
  }
  /** REQ-RIVAL-006: apply the registry's answers (server-side only), settle ended weeks, return GET /v1/rival. */
  rivalSync(id: string, data: Record<string, RegistryWeek | null>, quiet = false) {
    return this.tx(id, null, (s, now, emit) => { rivalSync(this.d.master, s, now, data, emit, quiet); return rivalView(this.d.master, s, now); });
  }
  rivalSetOptOut(id: string, optOut: boolean) {
    return this.tx(id, null, (s, now, emit) => {
      const was = !!s.rival?.optOut;
      const r = rivalSetOptOut(this.d.master, s, optOut);
      if (was !== optOut) emit({ name: 'rival_opt', s1: optOut ? 'out' : 'in' });
      return { ...r, view: rivalView(this.d.master, s, now) };
    });
  }
  rivalBlock(id: string) { return this.tx(id, null, (s, now) => rivalBlock(this.d.master, s, now)); }
  /** REQ-RIVAL-008: one daily challenge per call; a resent idempotency key returns the stored answer (no second challenge). */
  rivalChallengeCheck(id: string, idemKey: string | null = null) { return this.tx(id, idemKey, (s, now) => ({ rivalId: rivalChallengeCheck(this.d.master, s, now), displayName: s.profile.displayName })); }
  /** The rival's side; keyed by the challenger's request so a retried challenge never re-sends the invite push. */
  async rivalChallengeReceive(id: string, fromId: string, passphrase: string, fromName?: string, idemKey: string | null = null) {
    if (await this.wiped(id)) throw new AppError('NOT_ELIGIBLE', 'not your rival this week');
    return this.tx(id, idemKey, (s, now) => {
      const r = rivalChallengeReceive(this.d.master, s, fromId, passphrase, now);
      enqueuePush(this.d.master, s, 'room_invite', { name: fromName ?? 'ライバル' }, now);
      return r;
    });
  }
  rivalSeen(id: string, weekId: string) { return this.tx(id, null, (s) => rivalSeen(s, weekId)); }
  /** REQ-RIVAL-013: 「ライバルが記録を更新」 — at most once per game day, inside the push daily cap and preferences. */
  async rivalPush(id: string, byName: string, course: string) {
    if (await this.wiped(id)) return { status: 'skipped' as const, reason: 'deleted' as const };
    return this.tx(id, null, (s, now) => {
      const r = ensureRival(s);
      if (r.optOut) return { status: 'skipped' as const, reason: 'opted_out' as const };
      const day = gameDayKeyOf(this.d.master, now);
      if (r.pushDay && r.pushDay >= day) return { status: 'skipped' as const, reason: 'already_today' as const };
      const out = enqueuePush(this.d.master, s, 'rival_record', { name: byName, course }, now);
      if (out.status === 'queued') r.pushDay = day;
      return out;
    });
  }

  async claimPass(id: string, track: 'free' | 'premium', level: number, idemKey: string | null) {
    return this.tx(id, this.requireKey(idemKey), (s, now) => claimPass(this.d.master, s, track, level, now));
  }

  /** Called by the race room after a race is final (idempotent per race). */
  async applyRace(id: string, r: RaceResultForPlayer) {
    // r10: once the account deletion run has started the result is dropped — nothing may reach the player's boards,
    // team or wallet again — but the call resolves, so the room ACKs it (no retry, no dead letter) and settles the others
    const cur = await this.repo.get(id);
    if (cur?.deletion?.status === 'deleting') return { skipped: 'deletion_pending' as const, raceId: r.raceId, event: null };
    // r10: the account was already wiped (no state, but a deletion tombstone): a result settled after the wipe must not
    // create a fresh player under the deleted id. ACK it as a no-op. A player that merely has no state yet still applies.
    if (!cur && (await this.repo.tombstoned?.(id))) return { skipped: 'deleted' as const, raceId: r.raceId, event: null };
    let feed: { teamId: string; playerId: string; displayName: string; race: FeedRace } | null = null;
    let goal: GoalContribution | null = null;
    const out = await this.tx(id, `race:${r.raceId}`, (s, now, emit) => {
      // QA r6 #3: durable per-race guard, independent of the evictable idempotency ring
      const applied = (s.appliedRaces ??= {});
      for (const [k, at] of Object.entries(applied)) if (now - at > APPLIED_RACE_KEEP_MS) delete applied[k];
      if (applied[r.raceId] !== undefined) return { duplicate: true as const, event: null };
      applied[r.raceId] = now;
      const base0 = applyRaceResult(this.d.master, s, r, now);
      noteRivalRace(this.d.master, s, r, now, emit); // REQ-RIVAL-004: head to head (ranked) / challenge (friend)
      // REQ-COL-002 / REQ-ACH-002: what the race showed the 図鑑, a fired skill, and the tiers it unlocked (with titles)
      noteRaceCollection(this.d.master, s, r);
      const achievements = syncCollection(this.d.master, s, now, emit);
      const base = { ...base0, titles: [...base0.titles, ...(achievements.length ? evaluateTitles(this.d.master, s) : [])], achievements };
      // REQ-TEAMFEED-004: a win or a place in a ranked race or a tournament shows in the team feed
      const teamId = s.team?.teamId ?? null;
      if (!r.void && teamId && (FEED_RACE_MODES as readonly string[]).includes(r.mode) && r.place >= 1 && r.place <= stampsOf(this.d.master).config.racePlaceMax) {
        // r10 QA: the deletion must find this item even after the player left the team (REQ-TEAMFEED-008)
        notePostedIn(s, teamId);
        feed = { teamId, playerId: id, displayName: s.profile.displayName, race: { raceId: r.raceId, mode: r.mode as FeedRace['mode'], place: r.place, fieldSize: r.fieldSize, trackId: r.details?.trackId ?? null } };
      }
      // REQ-TGOAL-003/004: the settled result counts toward the team's weekly goal (account-wide daily cap)
      goal = playerGoalRace(this.d.master, s, r, now);
      if (goal) {
        notePostedIn(s, goal.teamId); // REQ-TGOAL-006: the deletion finds this team even after a leave
        emit({ name: 'team_goal_contribute', s1: goal.teamId, s2: goal.wins ? 'win' : 'race', s3: goal.ref, count: goal.races + goal.wins });
      }
      if (!r.void && r.mode === 'ranked') noteRaceForOffers(this.d.master, s, r.place, now); // REQ-UXS-017 T2
      noteRaceForAssist(s, r, now, emit); // REQ-ASSIST-010/011: last-place streak, race_assisted
      if (r.mode === 'ranked' && !r.void) armPromotionNudge(this.d.master, s, now); // REQ-UXS-012
      if (!r.void) {
        emit({
          name: 'race_finish', s1: r.mode, s2: r.details?.style ?? '', s3: r.details?.trackId ?? '',
          place: r.place, count: r.fieldSize, value: r.humans ?? 0,
          ...(r.details?.finishTick != null ? { durationMs: r.details.finishTick * 50 } : {}),
        });
      }
      // REQ-EVENT-005: event points, milestones and the held entry fee
      const ev = r.mode === 'event' && r.eventId ? this.d.master.events.find((e) => e.id === r.eventId) : undefined;
      if (!ev) return { ...base, event: null };
      const e = applyEventResult(ev, s, r, now, this.d.master);
      // REQ-EXCH-004: event points for the exchange (fixed by place + participation, daily cap); a void race earns none
      const ex = r.void ? null : earnExchangePoints(this.d.master, ev, s, r.place, now);
      if (ex) emit({ name: 'event_point_earn', s1: ev.id, s2: ex.capped ? 'capped' : 'full', place: r.place, value: ex.gained, count: ex.points });
      const st = s.events![ev.id]!;
      return {
        ...base,
        event: { eventId: ev.id, gained: e.gained, total: e.total, milestones: e.milestones, refunded: e.refunded,
          exchange: ex ? { gained: ex.gained, capped: ex.capped, points: ex.points, remainingToday: ex.remainingToday } : null,
          entry: { playerId: id, eventId: ev.id, points: st.points, races: st.races, wins: st.wins, displayName: s.profile.displayName, updatedAt: now } as EventEntry },
      };
    });
    await this.flushEventPushes(id);
    await this.sendTeamGoal(id, goal);
    if (feed && this.d.onTeamFeed) {
      // best effort: the result is committed; a TeamDO outage only loses the feed item
      try { await this.d.onTeamFeed(feed); } catch (e) { console.error('team feed race item failed', id, (e as Error).message); }
    }
    if (out.event && out.event.entry.races > 0 && this.d.onEventEntry) {
      // QA r6 #3: the result is already committed — an EventDO outage must not fail (and later dead-letter) it.
      // Keep the board update and re-send it with the player's next race.
      try {
        await this.d.onEventEntry(out.event.entry);
      } catch (e) {
        console.error('event board update failed; kept for retry', id, out.event.eventId, (e as Error).message);
        const entry = out.event.entry;
        await this.tx(id, null, (s) => { (s.pendingEventPushes ??= {})[entry.eventId] = entry; });
      }
    }
    return out;
  }

  /**
   * REQ-TGOAL-003: delivers a contribution (and any earlier undelivered ones) to the team. Delivery failures are kept on
   * the player (bounded) and re-sent with the next contribution; the team counts a ref once and only into its own week.
   * A milestone this contribution reached is the team_goal_milestone KPI row of the contributor.
   */
  private async sendTeamGoal(id: string, c: GoalContribution | null) {
    if (!this.d.onTeamGoal) return;
    const cur = await this.load(id);
    const pending = ensureGoal(cur).pending;
    if (!c && pending.length === 0) return;
    // REQ-TGOAL-006: undelivered contributions of a player who was quarantined / scheduled for deletion meanwhile are dropped
    const queue = mayContribute(cur, this.d.clock()) ? [...pending, ...(c ? [c] : [])] : [];
    const failed: GoalContribution[] = [];
    const milestones: { teamId: string; tier: number }[] = [];
    for (const x of queue) {
      try {
        const r = await this.d.onTeamGoal(x);
        if (r && r.milestone !== null && r.milestone !== undefined) milestones.push({ teamId: x.teamId, tier: r.milestone });
      } catch (e) {
        console.error('team goal contribution failed; kept for retry', id, x.teamId, (e as Error).message);
        failed.push(x);
      }
    }
    if (pending.length === 0 && failed.length === 0 && milestones.length === 0) return;
    await this.tx(id, null, (s, now, emit) => {
      playerGoalPending(s, failed, now);
      for (const ms of milestones) emit({ name: 'team_goal_milestone', s1: ms.teamId, s2: weekKeyOf(now, dayRule(this.d.master)), value: ms.tier });
    });
  }

  /** REQ-TGOAL-007/009: a closed week's tier reward (the team object's alarm; idempotent per week, whatever the team). */
  async teamGoalReward(id: string, week: string, teamId: string, tier: number, contribution: number) {
    if (await this.wiped(id)) return null;
    return this.tx(id, null, (s, now, emit) => {
      const r = playerGoalReward(this.d.master, s, week, teamId, tier, contribution, now, giftGiver(this.d.master, s, now, emit)); // §26.1: background payout → gift box
      if (r.status === 'rewarded') emit({ name: 'team_goal_reward', s1: teamId, s2: week, value: tier, count: contribution });
      return r;
    });
  }
  /** REQ-TGOAL-008: the player's side of GET /v1/teams/me/goal. */
  async goalPlayerView(id: string) { return playerGoalView(this.d.master, await this.load(id), this.d.clock()); }

  /** Re-sends event board updates that failed earlier (latest entry per event; boards accept newer totals). */
  private async flushEventPushes(id: string) {
    if (!this.d.onEventEntry) return;
    const s = await this.load(id);
    const pending = Object.entries(s.pendingEventPushes ?? {});
    if (pending.length === 0) return;
    const sent: string[] = [];
    for (const [eventId, entry] of pending) {
      try { await this.d.onEventEntry(entry as EventEntry); sent.push(eventId); } catch { /* keep for next time */ }
    }
    if (sent.length) await this.tx(id, null, (st) => { for (const k of sent) delete st.pendingEventPushes?.[k]; });
  }

  /** Snapshot used by the matchmaker: horse for the race, rating, class cap, beginner flag. */
  async raceEntry(id: string, horseId: string) {
    const s = await this.load(id);
    notWhileDeleting(s); // REQ-UXS-040: no new race once the deletion run has started
    const h = getHorse(s, horseId);
    if (h.status !== 'active') throw new AppError('HORSE_NOT_ACTIVE');
    const cls = classDef(this.d.master, s.season.classId);
    return {
      moderation: moderationOf(s, this.d.clock()),
      playerId: id, horse: toRaceHorse(this.d.master, h),
      // REQ-ASSET-006: look of this runner for the other clients (never part of the hashed config)
      ...({ visual: { appearance: appearanceOf(h, id), silks: effectiveSilks(s.profile.silks, `p:${id}`, this.d.master.bannedSilks), displayName: s.profile.displayName, titleId: s.profile.titleId, bondLevel: horseBondLevel(this.d.master, s, h.id) } } as { visual?: EntrantVisual }),
      // REQ-ROOM-003: the host's private-room conditions (used only when this entry hosts a friend room)
      ...({ roomPreset: s.presets?.room ?? null } as { roomPreset?: RoomConditions | null }),
      rating: { r: s.rating.r, rd: s.rating.rd, vol: s.rating.vol },
      classId: cls.id, statCap: cls.statCap, beginner: s.rating.rankedRaces < this.d.master.progression.beginnerRaces,
      // REQ-UXS-003: the player's first ranked race (shorter CPU fill, optional fixed course); null afterwards
      ...({ firstRace: firstRaceOf(this.d.master, s) } as { firstRace?: { cpuFillAfterMs: number; trackId: string | null } | null }),
    };
  }

  // ---- bond / stable care (REQ-BOND-*) ----
  async bond(id: string, horseId: string) { return bondView(this.d.master, await this.load(id), horseId, this.d.clock()); }
  async bondLevels(id: string) { return { levels: bondLevels(this.d.master, await this.load(id)) }; }
  async care(id: string, horseId: string, action: string, idemKey: string | null) {
    return this.tx(id, this.requireKey(idemKey), (s, now) => {
      const r = careHorse(this.d.master, s, horseId, action, now);
      countOnboarding(s, 'care');
      return r;
    });
  }

  // ---- presets: course look and private-room conditions (REQ-ROOM-*) ----
  async presets(id: string) { return presetsView(await this.load(id)); }
  setCourseLook(id: string, lookId: string | null) { return this.tx(id, null, (s) => setCourseLook(s, lookId)); }
  setRoomConditions(id: string, c: RoomConditions | null) {
    return this.tx(id, null, (s) => (c === null ? clearRoomConditions(s) : setRoomConditions(this.d.master, s, c)));
  }

  // ---- profile, titles, stats (REQ-STAT-*, REQ-TITLE-*, REQ-SOCIAL-006) ----
  setDisplayName(id: string, name: string) { return this.tx(id, null, (s) => setDisplayName(this.d.master, s, name)); }
  equipTitle(id: string, titleId: string | null) { return this.tx(id, null, (s) => equipTitle(this.d.master, s, titleId)); }
  /** REQ-ASSET-005: choose silks (unlockable patterns need their costume item). */
  setSilks(id: string, silks: Silks) {
    return this.tx(id, null, (s) => {
      s.profile.silks = validateSilks(silks, s.items, undefined, this.d.master.bannedSilks);
      countOnboarding(s, 'silks');
      return { silks: s.profile.silks };
    });
  }
  async titles(id: string) {
    const s = await this.load(id);
    // REQ-ACH-006: one title list — achievement titles name the tier that unlocks them
    return {
      equipped: s.profile.titleId,
      titles: this.d.master.titles.map((t) => ({
        id: t.id, name: t.name, icon: assetKeys.title(t.id), unlocked: s.titles.includes(t.id),
        source: t.condition.kind === 'achievement' ? 'achievement' as const : 'record' as const,
        ...(t.condition.kind === 'achievement' ? { achievementId: t.condition.achievementId, tier: t.condition.tier } : {}),
      })),
    };
  }

  // ---- 図鑑 and 実績 (REQ-COL-*, REQ-ACH-*) ----
  async collection(id: string) { return collectionView(this.d.master, await this.load(id)); }
  /** A read through tx so tiers that are due (e.g. after a master change) unlock before they are shown. */
  async achievements(id: string) { return this.tx(id, null, (s) => achievementsView(this.d.master, s)); }
  async claimAchievement(id: string, achievementId: string, tier: number, idemKey: string | null) {
    return this.tx(id, this.requireKey(idemKey), (s, now, emit) => ({ ...claimAchievement(this.d.master, s, achievementId, tier, now, emit), wallet: { free: s.wallet.free, paid: s.wallet.paid } }));
  }
  async claimAllAchievements(id: string, idemKey: string | null) {
    return this.tx(id, this.requireKey(idemKey), (s, now, emit) => ({ ...claimAllAchievements(this.d.master, s, now, emit), wallet: { free: s.wallet.free, paid: s.wallet.paid } }));
  }
  // ---- プレゼントボックス (REQ-BOX-*, giftBox.ts, contracts/protocol.md §26) ----
  /** GET /v1/gift-box: read-only unless something expired (then the expiry is written, REQ-BOX-006). */
  async giftBox(id: string, tab: 'box' | 'history' = 'box', offset = 0, limit = 50) {
    const s = await this.load(id);
    const q = { tab, offset, limit };
    if (giftsNeedExpiry(s, this.d.clock())) return this.tx(id, null, (d, now) => giftBoxView(this.d.master, d, now, q));
    return giftBoxView(this.d.master, s, this.d.clock(), q);
  }
  giftClaim(id: string, giftId: string, idemKey: string | null) {
    return this.tx(id, this.requireKey(idemKey), (s, now, emit) => claimGift(this.d.master, s, giftId, now, emit));
  }
  giftClaimAll(id: string, idemKey: string | null) {
    return this.tx(id, this.requireKey(idemKey), (s, now, emit) => claimAllGifts(this.d.master, s, now, emit));
  }

  async stats(id: string) { return (await this.load(id)).stats; }
  async publicProfile(id: string) { return publicProfile(await this.load(id), this.d.master.bannedSilks); }

  /** REQ-SEASON-002: rollover job → reward the closed season once (idempotent via the season record). */
  async closeSeason(id: string, seasonId: string, rank: number | null) {
    if (await this.wiped(id)) return { status: 'no-record' as const, reward: null, pass: null, titles: [] as string[] };
    return this.tx(id, null, (s, now, emit) => {
      const r = closeSeason(this.d.master, s, seasonId, rank, now, emit);
      if (r.status === 'rewarded') emit({ name: 'season_close', s1: seasonId, s2: r.classId ?? '', s3: r.nextClassId ?? '', ...(rank !== null ? { place: rank } : {}) });
      const titles = evaluateTitles(this.d.master, s); // class titles (promotion happened in rollSeason)
      return { ...r, titles };
    });
  }

  // ---- friends: per-player steps, orchestrated by FriendsService (REQ-SOCIAL-*) ----
  friendSend(id: string, toId: string) {
    return this.tx(id, null, (s, now, emit) => {
      notWhileDeleting(s);
      const out = friendSend(this.d.master, s, toId, now);
      if (out === 'sent' || out === 'mutual') emit({ name: 'friend_request', s1: out });
      return out;
    });
  }
  /** REQ-PUSH-002: the receiver is notified (`fromName` comes from the public profile directory). */
  friendReceive(id: string, fromId: string, fromName?: string) {
    return this.tx(id, null, (s, now) => {
      notWhileDeleting(s);
      const out = friendReceive(this.d.master, s, fromId, now);
      if (out === 'received') enqueuePush(this.d.master, s, 'friend_request', { name: fromName ?? 'フレンド' }, now);
      return out;
    });
  }
  friendAccept(id: string, fromId: string) {
    return this.tx(id, null, (s, _now, emit) => {
      notWhileDeleting(s);
      const out = friendAccept(this.d.master, s, fromId);
      if (out === 'accepted') emit({ name: 'friend_accept' });
      return out;
    });
  }
  friendAccepted(id: string, byId: string, byName?: string) {
    return this.tx(id, null, (s, now) => {
      notWhileDeleting(s);
      const was = s.friends.ids.includes(byId);
      const out = friendAccepted(s, byId);
      if (!was) enqueuePush(this.d.master, s, 'friend_accepted', { name: byName ?? 'フレンド' }, now);
      return out;
    });
  }
  friendDecline(id: string, fromId: string) { return this.tx(id, null, (s) => friendDecline(s, fromId)); }
  friendCancel(id: string, toId: string) { return this.tx(id, null, (s) => friendCancel(s, toId)); }
  friendRemove(id: string, otherId: string) { return this.tx(id, null, (s) => friendRemove(s, otherId)); }
  friendInvite(id: string, fromId: string, passphrase: string, fromName?: string) {
    return this.tx(id, null, (s, now) => {
      notWhileDeleting(s);
      const out = receiveInvite(this.d.master, s, fromId, passphrase, now);
      // The passphrase stays out of the notification text; the app reads it from GET /v1/friends (invites).
      enqueuePush(this.d.master, s, 'room_invite', { name: fromName ?? 'フレンド' }, now);
      return out;
    });
  }
  async friendsState(id: string) {
    const s = await this.load(id);
    pruneInvites(this.d.master, s, this.d.clock());
    return { ids: s.friends.ids, incoming: s.friends.incoming, outgoing: s.friends.outgoing, invites: s.friends.invites };
  }

  // ---- friend invite codes: per-player steps, orchestrated by InviteService (REQ-INV-*) ----
  inviteView(id: string, installHash: string | null) {
    return this.tx(id, null, (s, now) => {
      noteInstall(s, installHash);
      return { ...inviteStateView(this.d.master, s, now), displayName: s.profile.displayName };
    });
  }
  inviteAttempt(id: string, installHash: string) { return this.tx(id, null, (s, now) => recordRedeemAttempt(this.d.master, s, installHash, now)); }
  async inviteAccept(id: string, inviteeId: string, installHash: string, inviteeName: string) {
    if (await this.wiped(id)) return { status: 'refused' as const, reason: 'unavailable' as const };
    return this.tx(id, null, (s, now, emit) => inviterAccept(this.d.master, s, inviteeId, installHash, inviteeName, now, emit));
  }
  inviteRevert(id: string, inviteeId: string, unfriend: boolean) { return this.tx(id, null, (s) => inviterRevert(s, inviteeId, unfriend)); }
  inviteCommit(id: string, inviterId: string, code: string, installHash: string, inviterFriended: boolean) {
    return this.tx(id, null, (s, now, emit) => {
      notWhileDeleting(s);
      return inviteeCommit(this.d.master, s, inviterId, code, installHash, inviterFriended, now, emit);
    });
  }
  inviteFlag(id: string, flag: string) {
    return this.tx(id, null, (s) => { const l = (s.supportFlags ??= []); if (!l.includes(flag)) l.push(flag); return { ok: true }; });
  }
  /** Inviter side of a milestone (delivered from the invitee's outbox). A wiped inviter acknowledges as gone. */
  async inviteMilestone(id: string, inviteeId: string, milestoneId: string, inviteeName: string) {
    if (await this.wiped(id)) return { status: 'gone' as const };
    return this.tx(id, null, (s, now, emit) => inviterMilestone(this.d.master, s, inviteeId, milestoneId, inviteeName, now, emit));
  }
  async inviteDue(id: string) { return dueInviteOutbox(await this.load(id), this.d.clock()); }
  inviteAcked(id: string, outboxId: string) { return this.tx(id, null, (s) => inviteAcked(s, outboxId)); }
  inviteRetryLater(id: string, outboxId: string) { return this.tx(id, null, (s, now) => inviteRetryLater(s, outboxId, now)); }
  async inviteForgetInvitee(id: string, inviteeId: string) {
    if (await this.wiped(id)) return { ok: true };
    return this.tx(id, null, (s) => forgetInvitee(s, inviteeId));
  }
  async inviteForgetInviter(id: string, inviterId: string) {
    if (await this.wiped(id)) return { ok: true };
    return this.tx(id, null, (s) => forgetInviter(s, inviterId));
  }
  /** REQ-UXS-040: the deleting player's undelivered milestone rewards are given up. */
  inviteForfeit(id: string) { return this.tx(id, null, (s) => forfeitInviteOutbox(s)); }

  // ---- 購入履歴・コイン履歴・ガチャ履歴 (REQ-HIST-*, contracts/protocol.md §33; read only) ----
  /** REQ-HIST-006: a deleted (wiped) account has no history here; its anonymised legal record is never reachable by player id. */
  private async historyState(id: string): Promise<PlayerState> {
    const stored = await this.repo.get(id);
    if (!stored && (await this.repo.tombstoned?.(id))) throw new AppError('NOT_FOUND', 'account deleted');
    return this.load(id);
  }
  private pagers(id: string, s: PlayerState): { ledger: LedgerPager; gacha: GachaPager } {
    const repo = this.repo;
    return {
      ledger: repo.ledgerPage ? (q) => repo.ledgerPage!(id, q) : stateLedgerPager(s),
      gacha: repo.gachaPage ? (q) => repo.gachaPage!(id, q) : stateGachaPager(s),
    };
  }
  private async historyOf(id: string, kind: HistoryKindArg, q: HistoryQuery, internal: boolean) {
    const s = await this.historyState(id);
    const now = this.d.clock();
    const m = this.d.master;
    if (kind === 'summary') return historySummary(m, s, now);
    const limit = pageLimit(q.limit);
    if (kind === 'purchases') return purchaseHistory(m, s, now, q.cursor ?? null, limit, internal);
    const p = this.pagers(id, s);
    if (kind === 'coins') return coinHistory(m, s, p.ledger, now, q.currency ?? null, q.cursor ?? null, limit, internal);
    if (kind === 'gacha') return gachaHistory(m, p.gacha, now, q.cursor ?? null, limit);
    throw new AppError('BAD_REQUEST', 'unknown history kind');
  }
  /** REQ-HIST-001..005: the player's own history (summary or one list page). */
  history(id: string, kind: HistoryKindArg, q: HistoryQuery = {}) { return this.historyOf(id, kind, q, false); }
  /** REQ-HIST-009: the 問い合わせ draft for up to 10 of the player's own rows (refs outside the windows are NOT_FOUND). */
  async historyTicket(id: string, refs: string[], topic: SupportTopic) {
    if (refs.length < 1 || refs.length > HISTORY_LIMITS.ticketRefsMax || new Set(refs).size !== refs.length) throw new AppError('BAD_REQUEST', `refs: 1..${HISTORY_LIMITS.ticketRefsMax} distinct references`);
    const s = await this.historyState(id);
    const now = this.d.clock();
    const p = this.pagers(id, s);
    const rows = await resolveRefs(this.d.master, s, p.ledger, p.gacha, now, refs);
    const missing = rows.find((r) => r.kind === null);
    if (missing) throw new AppError('NOT_FOUND', `reference ${missing.ref}`);
    return buildSupportTicket(id, topic, rows as Exclude<typeof rows[number], { kind: null }>[], now);
  }
  /** REQ-HIST-010: the same lists for the ops console, with the internal values (admin API only). */
  adminHistory(id: string, kind: HistoryKindArg, q: HistoryQuery = {}) { return this.historyOf(id, kind, q, true); }
  /** REQ-HIST-010: the rows behind support references (unknown ones come back as `row: null`). */
  async adminHistoryRefs(id: string, refs: string[]) {
    const s = await this.historyState(id);
    const p = this.pagers(id, s);
    return { items: await resolveRefs(this.d.master, s, p.ledger, p.gacha, this.d.clock(), refs, true) };
  }

  // ---- support / anti-cheat (admin API only; REQ-OPS-020..025, REQ-OPS-032) ----
  /** REQ-OPS-020: `exists` false = no stored player (the view is a fresh default); `accountDeleted` = wiped by a deletion. */
  async adminView(id: string) {
    const exists = (await this.repo.get(id)) !== null;
    const accountDeleted = !exists && !!(await this.repo.tombstoned?.(id));
    return { ...supportView(this.d.master, await this.load(id), this.d.clock()), exists, accountDeleted };
  }
  /**
   * Admin money operations are idempotent per opKey FOREVER (review r5 #4): the general idempotency cache
   * keeps only the last IDEM_KEEP results, so their results live in a never-evicted per-player record.
   */
  private adminOnce<T>(id: string, key: string, fn: (s: PlayerState, now: number, emit: Emit) => T): Promise<T> {
    return this.tx(id, null, (s, now, emit) => {
      const ops = (s.adminOps ??= {});
      if (key in ops) return ops[key] as T;
      const r = fn(s, now, emit);
      ops[key] = JSON.parse(JSON.stringify(r ?? null));
      return r;
    });
  }
  /**
   * `singlePerson`: nobody else approved this grant, so it counts against the player's 24 h budget (QA R11, REQ-OPS-026).
   * `gift` (REQ-BOX-010): the grant goes to the gift box as a compensation or a plain grant, with an optional title and
   * expiry. An account wiped by a deletion is refused (no fresh player is created under its id).
   */
  async adminGrant(id: string, grant: Grant, reason: string, actor: string, opKey: string, singlePerson = false, gift: AdminGiftOptions = {}) {
    if (!(await this.repo.get(id)) && (await this.repo.tombstoned?.(id))) throw new AppError('NOT_FOUND', 'the account was deleted');
    return this.adminOnce(id, `grant:${opKey}`, (s, now, emit) => {
      if (s.deletion?.status === 'deleting') throw new AppError('DELETION_IN_PROGRESS', 'the account is being deleted');
      return supportGrant(s, grant, reason, actor, `admin:${opKey}`, now, singlePerson ? GRANT_LIMITS.operator : undefined, { master: this.d.master, emit, source: gift.source ?? 'ops_grant', ...(gift.titleKey ? { titleKey: gift.titleKey } : {}), ...(gift.expiryDays !== undefined ? { expiryDays: gift.expiryDays } : {}) });
    });
  }
  adminSettleDebt(id: string, coins: number, items: Record<string, number>, reason: string, actor: string, opKey: string) {
    return this.adminOnce(id, `settle:${opKey}`, (s, now) => supportSettleDebt(s, coins, items, reason, actor, `admin:${opKey}`, now));
  }
  adminCorrectAge(id: string, birthYear: number, birthMonth: number, guardianConsent: boolean, actor: string) {
    return this.tx(id, null, (s, now) => supportCorrectAge(this.d.master, s, birthYear, birthMonth, guardianConsent, actor, now));
  }
  adminResetName(id: string, target: 'display' | 'horse' | 'stable', horseId: string | null) {
    return this.tx(id, null, (s) => supportResetName(this.d.master, s, target, horseId));
  }
  async setModeration(id: string, status: 'ok' | 'quarantined' | 'banned', until: number | null, reason: string) {
    const out = await this.tx(id, null, (s, now) => {
      if (status !== 'ok') ensureGoal(s).pending = []; // REQ-TGOAL-006: never delivered later
      return setModeration(s, status, until, reason, now);
    });
    // REQ-TGOAL-006: a quarantined or banned player's contribution leaves the weekly goal of every team that holds it
    if (status !== 'ok' && this.d.onTeamGoalForget) {
      const s = await this.load(id);
      const teams = [...new Set([...(s.team?.teamId ? [s.team.teamId] : []), ...ensureFeed(s).postedIn])];
      for (const teamId of teams) await this.d.onTeamGoalForget({ teamId, playerId: id }).catch((e) => console.error('team goal forget failed', id, teamId, (e as Error).message));
    }
    return out;
  }

  // ---- マイ厩舎 (REQ-STABLE-*, stable.ts) ----
  async stableMine(id: string) { return stableView(this.d.master, await this.load(id), this.d.clock()); }
  stableSave(id: string, input: StableInput) {
    return this.tx(id, null, (s, now, emit) => {
      const layout = setStable(this.d.master, s, input, now, emit);
      countOnboarding(s, 'stable'); // REQ-CB-005: comeback mission "decorate マイ厩舎"
      return { layout, snapshot: stableSnapshot(this.d.master, s, now) };
    });
  }
  /** A visit is a read: the visitor's like status, plus the stable_visit KPI event (no state is written). */
  async stableVisit(id: string, target: string) {
    const s = await this.load(id);
    const now = this.d.clock();
    const v = viewerStatus(this.d.master, s, target, now);
    if (this.d.onKpi && v.relation !== 'self') await this.d.onKpi(id, [kpiRecord(s, now, { name: 'stable_visit', s1: v.relation })]);
    return v;
  }
  stableLikeGive(id: string, target: string, idemKey: string | null) {
    return this.tx(id, this.requireKey(idemKey), (s, now, emit) => { notWhileDeleting(s); return stableLikeGive(this.d.master, s, target, now, emit); });
  }
  async stableLikeReceive(id: string, from: string, likeId: string) {
    // REQ-UXS-040: a like that arrives after the owner's account was wiped must not create a fresh player
    if (!(await this.repo.get(id))) return { counted: false, likes: 0, snapshot: null };
    return this.tx(id, null, (s, now) => ({ ...stableLikeReceive(this.d.master, s, from, likeId, now), snapshot: stableSnapshot(this.d.master, s, now) }));
  }
  stableClear(id: string) { return this.tx(id, null, (s) => clearStable(s)); }
  /** REQ-UXS-040: the deletion's stable step (layout and like records; the public copy follows via onStable). */
  stableForget(id: string) { return this.tx(id, null, (s) => forgetStable(s)); }

  // ---- push notifications (REQ-PUSH-*) ----
  registerDevice(id: string, token: string, platform: DevicePlatform, locale: Locale = 'ja') { return this.tx(id, null, (s, now) => registerDevice(this.d.master, s, token, platform, now, locale)); }
  unregisterDevice(id: string, token: string) { return this.tx(id, null, (s) => unregisterDevice(this.d.master, s, token)); }
  // ---------------------------------------------------------------- かんたん操作 easy controls (REQ-ASSIST-*, assist.ts)
  /** GET /v1/player/assist: read-only. */
  async assist(id: string) { return assistView(await this.load(id)); }
  /** PUT /v1/player/assist: off | whip | full (idempotent; the same level twice changes nothing). */
  setAssist(id: string, level: AssistLevel, source: AssistSource) {
    return this.tx(id, null, (s, now, emit) => setAssist(s, level, source, now, emit));
  }
  /** POST /v1/player/assist/prompt-seen: the one-time suggestion was shown (once only). */
  assistPromptSeen(id: string) {
    return this.tx(id, null, (s, now, emit) => markAssistPromptSeen(s, now, emit));
  }

  async pushPreferences(id: string, locale: Locale = 'ja') { return pushPrefsView(this.d.master, await this.load(id), locale); }
  setPushPreferences(id: string, patch: PrefsPatch, locale: Locale = 'ja') { return this.tx(id, null, (s) => setPushPrefs(this.d.master, s, patch, locale)); }
  /** Alarm step 1: drop expired messages and return what is due (kept in the outbox until settled). */
  pushTake(id: string) { return this.tx(id, null, (s, now) => takeDuePushes(this.d.master, s, now)); }
  /** Alarm step 2: apply send results (prune dead tokens, back off retries). */
  pushSettle(id: string, outcomes: DeliveryOutcome[]) {
    return this.tx(id, null, (s, now) => ({ ...settlePushes(this.d.master, s, outcomes, now), nextAt: nextPushWake(s) }));
  }
  /** Ops/test hook: queue a templated push for this player (same rules as event-driven pushes). */
  async queuePush(id: string, templateId: string, vars: Record<string, string>) {
    if (await this.wiped(id)) return { status: 'skipped' as const, reason: 'deleted' };
    return this.tx(id, null, (s, now) => { ensurePush(this.d.master, s); return enqueuePush(this.d.master, s, templateId, vars, now); });
  }

  // ---- analytics (REQ-KPI-003/004) ----
  /** Client events: rate-limited per player, enriched with cohort/payer like server events, then emitted via onKpi. */
  async kpiIngest(id: string, batch: ClientBatch) {
    const r = await this.tx(id, null, (s, now) => {
      const events = admitClientBatch(s, batch, now);
      return { accepted: events.length, dropped: batch.events.length - events.length, records: events.map((e) => kpiRecord(s, now, clientToKpi(e), 'client', { platform: batch.platform, appVersion: batch.appVersion, at: e.at })) };
    });
    if (r.records.length > 0 && this.d.onKpi) await this.d.onKpi(id, r.records);
    return { accepted: r.accepted, dropped: r.dropped };
  }

  // ---- time attack (REQ-TA-*) ----
  /** Issue a session. The id is random (crypto in production) and doubles as the race id suffix. */
  /** `ruleset` is the active remote-config ruleset (REQ-TA-009); omitted = the built-in default. */
  taStart(id: string, trackId: string, horseId: string, ruleset?: Ruleset) {
    return this.tx(id, null, (s, now) => {
      notWhileDeleting(s);
      const sessionId = [0, 0, 0].map(() => this.d.rng.nextU32().toString(36)).join('');
      return startTimeAttack(this.d.master, s, this.d.master.progression.timeAttack, trackId, horseId, sessionId, this.d.rng, now, ruleset);
    });
  }
  taPrepare(id: string, sessionId: string, inputs: unknown, resultHash: string, echoedConfig: unknown) {
    return this.tx(id, null, (s, now) => { notWhileDeleting(s); return prepareSubmit(s, this.d.master.progression.timeAttack, sessionId, inputs, resultHash, echoedConfig, now); });
  }
  taAbort(id: string, sessionId: string) { return this.tx(id, null, (s) => abortSubmit(s, sessionId)); }
  async taRecord(id: string, sessionId: string, out: VerifierOutput, claimedHash: string) {
    let goal: GoalContribution | null = null;
    const res = await this.tx(id, null, (s, now, emit) => {
      const counted = s.timeAttack?.sessions.find((x) => x.id === sessionId)?.result ?? null;
      const r = recordResult(this.d.master, s, this.d.master.progression.timeAttack, sessionId, out, claimedHash, now);
      if (!counted && 'finished' in r && r.finished) countOnboarding(s, 'ta_finish');
      if (!counted && 'finished' in r && r.finished && r.timeMs !== null) noteRivalTa(this.d.master, s, r.trackId, r.timeMs, now); // REQ-RIVAL-005
      // REQ-TGOAL-003: a verified run that set a season best on its course counts once (a re-submit returns the stored result)
      if (!counted && 'seasonBest' in r && r.seasonBest) {
        goal = playerGoalTa(this.d.master, s, sessionId, now);
        if (goal) {
          notePostedIn(s, goal.teamId);
          emit({ name: 'team_goal_contribute', s1: goal.teamId, s2: 'ta_pb', s3: goal.ref, count: 1 });
        }
      }
      return r;
    });
    await this.sendTeamGoal(id, goal);
    return res;
  }
  async taView(id: string, trackId: string) {
    trackById(this.d.master, trackId);
    return timeAttackView(await this.load(id), this.d.master.progression.timeAttack, trackId, this.d.clock(), dayRule(this.d.master));
  }

  // ---- 週替わりチャレンジ weekly challenge (REQ-WCH-*, contracts/protocol.md §31; orchestrated by race/weeklyChallenge.ts) ----
  async wchView(id: string) { return weeklyChallengeView(this.d.master, await this.load(id), this.d.clock()); }
  /** Keyed (a retry returns the same session). `ruleset` = the active remote-config ruleset (the day's form is switched off). */
  wchStart(id: string, challengeId: string, input: WchStartInput, idemKey: string | null = null, ruleset?: Ruleset) {
    return this.tx(id, idemKey, (s, now, emit) => {
      notWhileDeleting(s);
      const rng = this.d.challengeRng ?? this.d.rng;
      const sessionId = 'w' + [0, 0, 0].map(() => rng.nextU32().toString(36)).join('');
      return startChallenge(this.d.master, s, challengeId, input, sessionId, rng, now, emit, ruleset);
    });
  }
  wchPrepare(id: string, sessionId: string, inputs: unknown, resultHash: string, echoedConfig: unknown) {
    return this.tx(id, null, (s, now) => { notWhileDeleting(s); return prepareChallengeSubmit(this.d.master, s, sessionId, inputs, resultHash, echoedConfig, now); });
  }
  wchAbort(id: string, sessionId: string) { return this.tx(id, null, (s) => abortChallengeSubmit(s, sessionId)); }
  wchRecord(id: string, sessionId: string, out: VerifierOutput, claimedHash: string) {
    return this.tx(id, null, (s, now, emit) => { notWhileDeleting(s); return recordChallengeResult(this.d.master, s, sessionId, out, claimedHash, now, emit); });
  }

  // ---- teams: per-player steps, orchestrated by TeamsService (REQ-TEAM-*) ----
  teamPrepareJoin(id: string, teamId: string) { return this.tx(id, null, (s, now) => playerPrepareJoin(s, teamId, now)); }
  teamCommitJoin(id: string, teamId: string) {
    return this.tx(id, null, (s, now, emit) => {
      const was = s.team?.teamId ?? null;
      const r = playerCommitJoin(s, teamId, now);
      if (was !== teamId) { emit({ name: 'team_join', s1: teamId }); countOnboarding(s, 'team'); }
      return r;
    });
  }
  teamAbortJoin(id: string, teamId: string) { return this.tx(id, null, (s) => playerAbortJoin(s, teamId)); }
  teamAddOutgoing(id: string, teamId: string) { return this.tx(id, null, (s, now) => playerAddOutgoing(s, this.d.master.progression.teams, teamId, now)); }
  teamRemoveOutgoing(id: string, teamId: string) { return this.tx(id, null, (s) => playerRemoveOutgoing(s, teamId)); }
  teamLeft(id: string, teamId: string, byChoice: boolean) {
    return this.tx(id, null, (s, now, emit) => {
      const r = playerLeft(s, this.d.master.progression.teams, teamId, now, byChoice);
      if (r.changed) emit({ name: 'team_leave', s1: teamId, s2: byChoice ? 'leave' : 'removed' });
      return r;
    });
  }
  async teamState(id: string) {
    const s = await this.load(id);
    const t = ensureTeam(s);
    return { teamId: t.teamId, joinedAt: t.joinedAt, cooldownUntil: t.cooldownUntil, outgoing: t.outgoing.map((o) => o.teamId), snapshot: snapshotOf(s) };
  }
  /** REQ-TEAM-008: team season reward (rollover job; idempotent per season). */
  async teamSeasonReward(id: string, seasonId: string, teamId: string, rank: number | null, total: number, league: LeaguePlace | null = null) {
    if (await this.wiped(id)) return null;
    return this.tx(id, null, (s, now, emit) => playerTeamReward(s, this.d.master.progression.teams, seasonId, teamId, rank, total, now, { cfg: this.d.master.progression.league, place: league }, giftGiver(this.d.master, s, now, emit)));
  }

  // ---- team cheer stamps (REQ-TEAMFEED-*) ----
  async stampCatalog(id: string) { return stampCatalog(this.d.master, await this.load(id)); }
  /** Before a post / reaction: deletion, membership and unlock checks; returns the team and the display name. */
  stampCheck(id: string, stampId: string) { return this.tx(id, null, (s) => playerStampCheck(this.d.master, s, stampId)); }
  /** After the team stored it: the KPI row (REQ-TEAMFEED-009). */
  stampPosted(id: string, stampId: string, kind: 'post' | 'reaction', teamId: string, ref: string | null = null) {
    return this.tx(id, null, (s, _now, emit) => {
      emit({ name: 'stamp_post', s1: stampId, s2: kind, s3: teamId });
      // REQ-ACH-002: a cheer counts once per feed ref (a retried call or a removed-then-renewed reaction is not a second cheer)
      if (!deletionScheduled(s)) noteCheer(s, ref);
      return { ok: true };
    });
  }
  /** The feed's viewer side: team and mute list; the first page of a visit is the team_feed_view KPI row. */
  feedViewer(id: string, firstPage: boolean) {
    return this.tx(id, null, (s, _now, emit) => {
      const teamId = s.team?.teamId ?? null;
      if (firstPage && teamId) emit({ name: 'team_feed_view', s1: teamId, count: ensureFeed(s).muted.length });
      return { teamId, muted: [...ensureFeed(s).muted] };
    });
  }
  async feedMutes(id: string) { return { muted: [...ensureFeed(await this.load(id)).muted] }; }
  feedMute(id: string, target: string, muted: boolean) { return this.tx(id, null, (s) => playerMute(this.d.master, s, target, muted)); }
  /** REQ-TEAMFEED-007: support flag on the reported player (no-op for a deleted account). */
  async feedReported(id: string, teamId: string, seq: number, reporter: string, reason: ReportReason) {
    if (await this.wiped(id)) return { flagged: false };
    return this.tx(id, null, (s) => playerReported(s, teamId, seq, reporter, reason));
  }
  /** Optional push to the owner of a race item a teammate cheered (not from muted members, not while deleting). */
  async cheerPush(id: string, fromId: string, fromName: string) {
    if (await this.wiped(id)) return { queued: false };
    return this.tx(id, null, (s, now) => {
      if (deletionScheduled(s) || ensureFeed(s).muted.includes(fromId)) return { queued: false };
      ensurePush(this.d.master, s);
      return { queued: enqueuePush(this.d.master, s, 'team_cheer', { name: fromName }, now).status === 'queued' };
    });
  }

  // ---- event races (REQ-EVENT-*) ----
  async eventsView(id: string) { return eventsForPlayer(this.d.master, await this.load(id), this.d.clock()); }
  /** Takes (or returns the already held) entry fee; the caller then queues the player in the event pool. */
  async eventEnter(id: string, eventId: string, horseId: string, idemKey: string | null) {
    // The client key is still required (API contract) but NOT used as a result cache: the domain is
    // idempotent through `pending`, and a cached result would let a resent key re-queue after the race
    // settled without paying again (review r5 #1).
    this.requireKey(idemKey);
    return this.tx(id, null, (s, now, emit) => {
      notWhileDeleting(s);
      const ev = findEvent(this.d.master, eventId);
      const entryId = [0, 0].map(() => this.d.rng.nextU32().toString(36)).join('');
      const r = enterEvent(ev, s, getHorse(s, horseId), entryId, now);
      if (!r.existing) emit({ name: 'event_entry', s1: eventId, s2: r.fee.kind });
      return r;
    });
  }
  /**
   * REQ-EXCH-009: the event's exchange. Runs as a transaction (no client key) so leftover points of a closed exchange
   * are converted before they are shown (settleExchanges); otherwise nothing changes.
   */
  async exchangeView(id: string, eventId: string) {
    const ev = findEvent(this.d.master, eventId);
    const s = await this.load(id);
    const closed = Object.values(s.events ?? {}).some((e) => e.exchange && !e.exchange.converted && this.d.clock() >= e.exchange.rule.closesAtMs);
    if (!closed) return exchangeView(this.d.master, ev, s, this.d.clock());
    return this.tx(id, null, (st, now) => exchangeView(this.d.master, ev, st, now));
  }
  /** REQ-EXCH-008: spend event points on one exchange line (atomic, idempotent per client key). */
  async exchangeBuy(id: string, eventId: string, itemId: string, qty: number, idemKey: string | null) {
    const key = this.requireKey(idemKey);
    return this.tx(id, key, (s, now, emit) => {
      notWhileDeleting(s);
      const ev = findEvent(this.d.master, eventId);
      const r = buyExchange(this.d.master, ev, s, itemId, qty, now, `exch:${eventId}:${itemId}:${key}`);
      emit({ name: 'exchange_buy', s1: eventId, s2: itemId, s3: r.kind, count: qty, value: r.spent });
      return { ...r, exchange: exchangeView(this.d.master, ev, s, now), wallet: playerView(s).wallet };
    });
  }
  /** Refunds a held entry fee (queue cancelled / refused). `entryId` null = whatever is held. */
  eventCancel(id: string, eventId: string, entryId: string | null) {
    return this.tx(id, null, (s, now) => cancelEntry(s, eventId, entryId, now));
  }
  /** REQ-TOUR-002/003: race entry + what tournament eligibility looks at. */
  async tournamentEntry(id: string, horseId: string) {
    const entry = await this.raceEntry(id, horseId);
    const s = await this.load(id);
    const h = getHorse(s, horseId);
    return { entry, displayName: s.profile.displayName, info: { classId: entry.classId, rankedRaces: s.rating.rankedRaces, style: h.style as string, horseActive: h.status === 'active', moderation: entry.moderation } };
  }
  /** REQ-TOUR-007: final rank + prize, once per tournament (resumable payout; a retry is a no-op). */
  async tournamentClose(id: string, tournamentId: string, rank: number, reward: Reward | null, name: string) {
    if (await this.wiped(id)) return { status: 'already' as const, reward: null };
    return this.tx(id, null, (s, now, emit) => {
      const done = (s.tournaments ??= {});
      if (done[tournamentId]) return { status: 'already' as const, reward: done[tournamentId]!.reward };
      // REQ-BOX-001: the prize goes to the gift box
      if (reward) giftGiver(this.d.master, s, now, emit)(reward, `tournament ${tournamentId} rank ${rank}`, `tournament:${tournamentId}:rank`, 'tournament', rank);
      done[tournamentId] = { name, rank, at: now, reward };
      noteTournamentResult(s, rank); // REQ-ACH-002 (once per tournament, behind the same guard)
      const keys = Object.entries(done).sort((a, b) => b[1].at - a[1].at).map(([k]) => k);
      for (const k of keys.slice(TOURNAMENT_HISTORY_KEEP)) delete done[k];
      return { status: 'rewarded' as const, reward };
    });
  }
  /** REQ-TOUR-009: the player's tournament history (newest first). */
  async tournamentHistory(id: string) {
    const s = await this.load(id);
    return { history: Object.entries(s.tournaments ?? {}).map(([tournamentId, r]) => ({ tournamentId, ...r })).sort((a, b) => b.at - a.at) };
  }
  /** REQ-EVENT-008: final rank reward (event end job; idempotent). An event removed from config pays nothing. */
  async eventClose(id: string, eventId: string, rank: number | null) {
    if (await this.wiped(id)) return { status: 'unknown_event' as const, reward: null };
    return this.tx(id, null, (s, now, emit) => {
      const ev = this.d.master.events.find((e) => e.id === eventId);
      if (!ev) {
        const st = ensureEvent(s, eventId);
        st.closed = true;
        return { status: 'unknown_event' as const, reward: null };
      }
      return closeEventForPlayer(ev, s, rank, now, this.d.master, giftGiver(this.d.master, s, now, emit));
    });
  }
}
