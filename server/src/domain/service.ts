import { AppError } from './errors.js';
import { playerQchatCheck, playerQchatOptions, type QChatSlotInput } from './quickChat.js';
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
import { cancelSpendingRaise, selfLimitsDigest, selfLimitsView, setPlaytime, setSpendingLimit, type PlaytimeBody, type PlaytimeSettings } from './selfLimits.js';
import { ageCapOf, applyRefund, applySubscriptionStatus, applyVerifiedPurchase, checkPurchaseIntent, registerAge, type StoreVerifier, type SubscriptionStatus, type VerifiedReceipt } from './purchase.js';
import { assertBannerOpen, drawGacha, exchangePity, findBanner, gachaPrice, gachaStatus, settlePityGroups } from './gacha.js';
import { attachShortfall, coinShortfall } from './shortfall.js';
import { awaken, breed, breedingPreviewWithAllowance, getHorse, nameHorse, pedigree, retire } from './horses.js';
import { migrateSkills } from './skills.js';
import { buyCosmetic, cosmeticsCatalog, findCosmetic, setEquipment, useTicket, type EquipmentPatch } from './itemShop.js';
import {
  clearResetNotice, createPreset, deletePreset, designFromInput, equipDesign, nonFreeParts, partOfCosmetic, presetDesign, previewDesign, silksEditorView, updatePreset,
  type DesignInput, type SilksDesign,
} from './silksEditor.js';
import { deletePhoto, photoCatalog, photosView, savePhoto, type PhotoInput } from './photoMode.js';
import { applyRaceResult, claimLoginBonus, claimMission, claimPass, firstWinBonusView, missionsView, type RaceResultForPlayer } from './rewards.js';
import { allowanceView, claimAllowance, markOfferViewed, noteRaceForOffers, shopOffers, shopProducts } from './shop.js';
import { passScreen } from './pass.js';
import { adIneligibility, adSessionView, adsView, applyAdCallback, setAdPref, startAd, type AdCallback, type AdPref, type AdRewardResult } from './ads.js';
import { toRaceHorse } from './raceConfig.js';
import { paidBalanceYen, invariantsHold } from './wallet.js';
import type { PaidBalanceSnapshot } from './accounting.js';
import { DAY_MS, dayRule, gameDayKey, jstDateKey } from './time.js';
const gameDayKeyOf = (m: Master, now: number) => gameDayKey(now, dayRule(m));
import type { Locale } from '../i18n/locale.js';
import { enqueuePush, ensurePush, nextPushWake, pushPrefsView, registerDevice, setPushPrefs, settlePushes, takeDuePushes, unregisterDevice, type DeliveryOutcome, type DevicePlatform, type PrefsPatch } from './push.js';
import { admitClientBatch, clientToKpi, ensureKpi, isPayer, kpiRecord, type ClientBatch, type KpiEvent, type KpiRecord } from './kpi.js';

/** Collects analytics events inside a transaction; they are emitted only if the transaction is saved. */
export type Emit = (e: KpiEvent) => void;
/** §67.8 `playtime_setting_change` s1 names. */
const PLAYTIME_KPI_KEY: Record<keyof PlaytimeSettings, string> = { sessionMin: 'session', dailyMin: 'daily', quietAfterHour: 'quiet_after' };
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
  cancelDeletion, deletionConfig, deletionDue, deletionRetryLater, deletionScheduled, deletionSnapshot, deletionView, finalizeDeletion, markDeletionStep,
  nextDeletionWake, notWhileDeleting, requestDeletion, startDeletion, type DeletionStep,
} from './accountDeletion.js';
import {
  ensureFeed, FEED_RACE_MODES, notePostedIn, playerReported, playerStampCheck, stampCatalog, stampsOf, type FeedRace, type ReportReason,
} from './teamFeed.js';
import {
  dueInviteOutbox, forfeitInviteOutbox, forgetInvitee, forgetInviter, inviteAcked, inviteeCommit, inviteRetryLater, inviterAccept, inviterMilestone,
  inviterRevert, inviteStateView, nextInviteWake, noteInstall, noteInviteMilestones, recordRedeemAttempt,
} from './invite.js';
import {
  claimComebackLogin, claimComebackMission, comebackView, markComebackWelcomed, markWhatsNewSeen, nextComebackWake, noteActivity, runDueComebackPush, whatsNew,
} from './comeback.js';
import { claimAllGifts, claimGift, expireGifts, giftBadge, giftBoxView, giftGiver, giftsNeedExpiry, nextGiftWake, type OpsTitleKey } from './giftBox.js';
import { activityBadge, activityPage, markActivityRead, recordActivity } from './activity.js';
import { markTipsSeen, tipsBadge, tipsIndex } from './tips.js';
import { forgetShowcase, setShowcase, showcaseCopy, showcaseCopyKey, showcaseMine, type ShowcaseInput } from './showcase.js';
import { checkReleaseNotes, markReleaseNotesSeen, releaseNotesHistory } from './releaseNotes.js';
import { calendarView, markCalendar, type CalendarExternal } from './calendar.js';
import { helpBadge, inquiryDetail, inquiryList, markIndexed, markInquiryRead, replyInquiry, submitInquiry, unindexedSummaries, voteHelp, type InquiryInput } from './help.js';
import { fsugCard, fsugCardKey, fsugDismiss, fsugSelf, fsugSetHidden, ensureFsug, noteFsugRace, type FsugCard, type FsugDismissed, type FsugKind } from './friendSuggest.js';
import { finishTraining, startTraining, trainingDelta, trainingTick, trainingView, useTrainingItem } from './training.js';
import {
  commitSave, deleteSaved, forgetRecent, myReplaysView, noteRaceForReplays, ownReplayRef, prepareSave, sharedFor, updateSaved, validateReplayTitle,
  type ReplayPatch,
} from './myReplays.js';
import { assistView, markAssistPromptSeen, noteRaceForAssist, setAssist, type AssistLevel, type AssistSource } from './assist.js';
import { buyPack, commentaryPackBadge, equipPack, packsView, type EquipSource } from './commentaryPacks.js';
import { accessibilityView, setAccessibility, type AccessibilityBody } from './accessibility.js';
import { analyticsAllowed, notePrivacyPromptShown, privacyChoicesBadge, privacyChoicesView, setPrivacyChoices, setPrivacyPlatform, type PrivacyChoicesBody, type PrivacyPlatformBody } from './privacyChoices.js';
import { filterKpi } from './kpiConsent.js';
import {
  ensureRival, noteRivalRace, noteRivalTa, rivalBlock, rivalChallengeCheck, rivalChallengeReceive, rivalOutbound, rivalSeen, rivalSetOptOut, rivalSync,
  rivalUpdateOf, rivalView, rivalWithdrawn, weekIdAt, weeksToSync, type RegistryWeek, type RivalUpdate,
} from './rival.js';
import {
  coinHistory, gachaHistory, historySummary, pageLimit, purchaseHistory, recordGachaLog, resolveRefs, stateGachaPager, stateLedgerPager,
  HISTORY_LIMITS, type GachaLogEntry, type GachaPager, type LedgerPager, type SupportTopic,
} from './history.js';
import { buildSupportTicket } from '../ops/support.js';
import { reportOptions, reportSnapshotOf, takeReportAllowance, type ReportCategory, type ReportContent, type ReportSource } from './reports.js';
import { blockIds, blockListOf, isBlocking, setBlocked, type BlockOrigin } from './blocks.js';
import { raceAdviceFor, type AdviceQuery } from './raceAdviceService.js';
import { practiceCatalog } from './practice.js';
import { dismissNextAction, nextActionsView, noteFeatures, type TeamGoalBrief } from './nextAction.js';
import { attachRecapRank, noteRecapRace, noteRecapReplaySaved, noteRecapTeamGoal, recapProgress, recapView, recapsList, rollRecaps, type RecapStepName } from './seasonRecap.js';
import {
  countCodeAttempt, noteCupCommitted, playerCupsView, receiveCupClosed, receiveCupInvite, releaseCup, reserveCup, ensureCups,
  type CupClosedNotice, type CupFormat, type CupStartedNotice, type PlayerCupInvite,
} from './hostedCups.js';
import { abortChallengeSubmit, prepareChallengeSubmit, recordChallengeResult, startChallenge, weeklyChallengeView, type WchStartInput } from './weeklyChallenge.js';
import {
  ackCeremony, hallSnapshot, hallSnapshotKey, hallViewerOf, horseCareerView, myHallView, noteHallRace, noteHallRetire, noteHallTa, noteHallTournament,
  setHallVisibility, type HallRelation, type HallSnapshot,
} from './hallOfFame.js';
import { horseGoalsView, noteHorseGoals, pinHorseGoal, pinnedGoalView } from './horseGoals.js';
import { answerReviewPrompt, checkReviewPrompt, reviewPromptStatus, type ReviewCheckInput, type ReviewStep } from './reviewPrompt.js';
import { ackPromotion, notePromotionRace, promotionEnabled, promotionView } from './promotion.js';
import { localRemindersView } from './localNotify.js';
import {
  dataExportAdminView, dataExportDeleted, dataExportDeletionKeys, dataExportFile, dataExportView, markDataExportFailed, markDataExportReady,
  nextDataExportWake, noteDataExportDownload, requestDataExport, takeDataExport, takeExpiredDataExport, type DexFile, type DexLang, type DexReadyInfo,
} from './dataExport.js';
import { REDEEM_REPLAY_MS, ensureTransfer, assertMayIssue, formatCodeId, issueTransfer, progressOf, redeemTransfer, revokeTransfer, transferStateView, type TransferMode } from './transferCode.js';
import { assertNotLocked, bulkPreview, noteTournamentEntry, parseRosterQuery, pruneRoster, rosterView, runBulk, setFavorite, setLock, type BulkAction } from './roster.js';

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
  /** REQ-HOF-011: the public hall copy changed (null = remove it: empty, private, banned, deletion). The Durable Object writes the directory. */
  onHall?: (playerId: string, snap: HallSnapshot | null) => void | Promise<void>;
  /** REQ-FSUG-011: the おすすめフレンド card changed (null = remove it: hidden, under age, banned, deletion). The Durable Object writes the directory. */
  onFsugCard?: (playerId: string, card: FsugCard | null) => void | Promise<void>;
}

const standingKey = (s: PlayerState) => JSON.stringify([s.season.id, s.season.classId, s.season.points, s.season.races, Math.round(s.rating.r), s.profile.displayName, s.profile.titleId]);
// REQ-SHOW-005: the showcase copy is part of the key, so a retired / gone horse or a revoked title leaves the card on the next push
const profileKey = (m: Master, s: PlayerState, now: number) => JSON.stringify([s.profile.displayName, s.profile.titleId, s.season.classId, Math.round(s.rating.r), s.stats.races, s.stats.wins, s.stats.top3, moderationOf(s, now) === 'banned', s.cups?.trophies ?? null, showcaseCopyKey(m, s, now)]);

const IDEM_KEEP = 200;
/**
 * The object's alarm serves the push outbox, the stud fee outbox (REQ-PUSH-005, REQ-BREED-012), personal
 * nudges (REQ-UXS-012), a scheduled account deletion (REQ-UXS-040), invite milestone deliveries (REQ-INV-007)
 * comeback lapse reminders (REQ-CB-007) and gift box expiry (REQ-BOX-006).
 */
const nextWake = (s: PlayerState) => {
  const all = [nextPushWake(s), nextStudWake(s), nextNudgeWake(s), nextDeletionWake(s), nextInviteWake(s), nextComebackWake(s), nextGiftWake(s), nextDataExportWake(s)].filter((x): x is number => x !== null);
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
    const rolled = rollSeason(this.d.master, draft, now);
    // §68 × §40 (REQ-PROMO-018): a promotion at the close is one activity entry (linked to that month's recap)
    if (rolled.closed && rolled.from !== rolled.to && promotionEnabled(this.d.master) && rolled.seasonId) {
      const cs = this.d.master.progression.classes;
      if (cs.findIndex((c) => c.id === rolled.to) > cs.findIndex((c) => c.id === rolled.from)) {
        recordActivity(this.d.master, draft, { kind: 'class_promoted', source: `class_promoted:${rolled.seasonId}`, vars: { from: rolled.from!, to: rolled.to!, via: rolled.promo?.promo === 'series' ? 'series' : 'line' }, linkId: `season:${rolled.seasonId}` }, now);
      }
    }
    // REQ-RECAP-002/003: a closed season / game year becomes its recap (once); §43 × §40: one activity entry per recap
    for (const rid of rollRecaps(this.d.master, draft, now)) {
      const [kind, period] = rid.split(':') as [string, string];
      const [y, mo] = period.split('-');
      recordActivity(this.d.master, draft, { kind: 'recap_ready', source: `recap_ready:${rid}`, vars: kind === 'year' ? { kind, y: String(Number(y)) } : { kind, y: String(Number(y)), m: String(Number(mo)) }, linkId: rid }, now);
    }
    settlePityGroups(this.d.master, draft, now);
    const paidBefore = draft.wallet.paid;
    const standingBefore = standingKey(draft);
    const profileBefore = profileKey(this.d.master, draft, now);
    const wakeBefore = nextWake(draft);
    const stableBefore = this.d.onStable ? stableSnapshotKey(this.d.master, draft, now) : '';
    const rivalBefore = this.d.onRival ? rivalOutbound(this.d.master, draft, now) : null;
    const hallBefore = this.d.onHall ? hallSnapshotKey(this.d.master, draft, now) : '';
    const kpi: KpiRecord[] = [];
    const emit: Emit = (e) => { kpi.push(kpiRecord(draft, now, e)); };
    // REQ-PROMO-015: what the season close did to the promotion series / the shield (rollSeason ran before emit existed)
    if (rolled.closed && rolled.promo) {
      const x = rolled.promo.ended;
      if (x) emit({ name: 'promo_series_end', s1: 'season_end', s2: x.classId, s3: x.toClassId, count: x.results.filter((r) => r.top).length, value: x.results.length });
      if (rolled.promo.shielded) {
        const h = draft.seasonHistory.find((y) => y.seasonId === rolled.seasonId);
        emit({ name: 'demotion_shield_used', s1: rolled.from ?? '', s2: rolled.seasonId ?? '', value: h?.points ?? 0, count: rolled.promo.graceRaces ?? 0 });
      }
    }
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
    const pushProfile = !deleting && this.d.onProfile && (profileKey(this.d.master, draft, now) !== profileBefore || now - draft.profile.lastPushedAt >= this.d.master.progression.social.profilePushIntervalMs);
    if (pushProfile) draft.profile.lastPushedAt = now;
    // REQ-FSUG-011: the card is re-derived on every transaction and written when it changed (first write included), and
    // again with the periodic profile push, so a write lost to a directory outage heals within profilePushIntervalMs
    let fsugOut: { card: FsugCard | null } | null = null;
    if (this.d.onFsugCard) {
      const card = fsugCard(this.d.master, draft, now);
      const key = fsugCardKey(card);
      if (draft.friendSuggest?.cardKey !== key || (pushProfile && card)) { ensureFsug(draft).cardKey = key; fsugOut = { card }; }
    }
    await this.repo.put(draft);
    const wake = nextWake(draft);
    if (wake !== null && wake !== wakeBefore && this.d.onPushWake) await this.d.onPushWake(wake);
    if (kpi.length > 0 && this.d.onKpi) await this.writeKpi(id, draft, now, kpi); // REQ-CNS-013: optional events only with analytics on
    if (pushProfile) await this.d.onProfile!(publicProfile(draft, this.d.master.bannedSilks, now, showcaseCopy(this.d.master, draft, now)));
    if (this.d.onStable && stableSnapshotKey(this.d.master, draft, now) !== stableBefore) await this.d.onStable(id, stableSnapshot(this.d.master, draft, now));
    if (this.d.onHall && hallSnapshotKey(this.d.master, draft, now) !== hallBefore) {
      // best effort like the stable copy: the transaction is saved; the next change re-writes the copy
      try { await this.d.onHall(id, hallSnapshot(this.d.master, draft, now)); } catch (e) { console.error('hall copy failed', id, (e as Error).message); }
    }
    if (fsugOut) {
      // best effort like the hall copy: the transaction is saved; the next change or profile push re-writes the card
      try { await this.d.onFsugCard!(id, fsugOut.card); } catch (e) { console.error('fsug card failed', id, (e as Error).message); }
    }
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
    return { consent: consentView(m, s), unlocks: unlocksView(m, s, now), experiments: experimentsView(m, s.id), deletion: deletionView(s), giftBox: giftBadge(m, s, now), assist: assistView(s), commentaryPack: commentaryPackBadge(m, s), accessibility: accessibilityView(s), activity: activityBadge(m, s, now), help: helpBadge(s), tips: tipsBadge(m, s, now), nextActions: nextActionsView(m, s, now), horseGoalPin: pinnedGoalView(m, s), privacyChoices: privacyChoicesBadge(m, s, now, adIneligibility(m, s, now) === null), localReminders: localRemindersView(m, s, now), selfLimits: selfLimitsDigest(s, ageCapOf(m, s, now), now) };
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
      noteFeatures(this.d.master, s, now); // REQ-NEXT-008: the day each feature is first seen unlocked
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

  // ---- 次にやること (REQ-NEXT-005/010, contracts/protocol.md §45) ----
  /** GET /v1/home/next. `teamGoal`: the team's weekly goal when the caller is in a team (read from the TeamDO by the route). */
  nextActions(id: string, teamGoal: TeamGoalBrief | null = null) {
    return this.tx(id, null, (s, now) => {
      noteFeatures(this.d.master, s, now);
      return nextActionsView(this.d.master, s, now, teamGoal);
    });
  }
  /** POST /v1/home/next/dismiss: closes a kind for today's game day (idempotent; KPI next_card_dismiss once). */
  dismissNextAction(id: string, kind: string, teamGoal: TeamGoalBrief | null = null) {
    return this.tx(id, null, (s, now, emit) => {
      if (dismissNextAction(this.d.master, s, kind, now)) emit({ name: 'next_card_dismiss', s1: kind });
      return nextActionsView(this.d.master, s, now, teamGoal);
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
    const all = [nextNudgeWake(s), nextDeletionWake(s), nextInviteWake(s), nextComebackWake(s), nextGiftWake(s), nextDataExportWake(s)].filter((x): x is number => x !== null);
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
    try {
      return checkPurchaseIntent(this.d.master, s, productId, this.d.clock());
    } catch (e) {
      // REQ-LIMIT-016: a confirmation refused by the player's own limit (no state is written)
      if (e instanceof AppError && e.code === 'SELF_LIMIT_EXCEEDED' && this.d.onKpi) {
        const now = this.d.clock();
        await this.writeKpi(id, s, now, [kpiRecord(s, now, { name: 'self_limit_block', s1: productId, amountYen: Number(e.details?.priceYen ?? 0) })]);
      }
      throw e;
    }
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
  /** REQ-HOF-003: the response also carries the retirement ceremony (null when the hall is disabled). */
  retire(id: string, horseId: string) {
    return this.tx(id, null, (s, now, emit) => {
      assertNotLocked(s, horseId); // REQ-ORG-005: a locked horse is never retired
      const h = retire(s, horseId);
      const ceremony = noteHallRetire(this.d.master, s, h, now, emit);
      return { ...h, ceremony };
    });
  }

  // ---- 馬ごとの目標 (REQ-HGOAL-*, horseGoals.ts) ----
  /** REQ-HGOAL-010: a horse's goal chain (a read: completion is recorded where results are counted, never here). */
  async horseGoals(id: string, horseId: string) { return horseGoalsView(this.d.master, await this.load(id), horseId); }
  /** REQ-HGOAL-007: pin one horse's goal to the home (null = unpin). Idempotent; hgoal_pin only when the pin changes. */
  pinHorseGoal(id: string, horseId: string | null) { return this.tx(id, null, (s, _now, emit) => pinHorseGoal(this.d.master, s, horseId, emit)); }
  async pinnedHorseGoal(id: string) { return { pinned: pinnedGoalView(this.d.master, await this.load(id)) }; }

  // ---- レビュー依頼のタイミング (REQ-REV-*, reviewPrompt.ts) — nothing here ever grants anything ----
  /** REQ-REV-005: the rules and the server's facts for the device's pre-check (a read). */
  async reviewPrompt(id: string) { return reviewPromptStatus(this.d.master, await this.load(id), this.d.clock()); }
  /** REQ-REV-005/006: decide (and record only a yes). Idempotent by key. */
  reviewPromptCheck(id: string, input: ReviewCheckInput, idemKey: string) {
    return this.tx(id, idemKey, (s, now, emit) => checkReviewPrompt(this.d.master, s, input, now, emit));
  }
  /** REQ-REV-007: the pre-question answer / the native API was called (each written once). */
  reviewPromptAnswer(id: string, promptId: string, step: ReviewStep) {
    return this.tx(id, null, (s, now, emit) => answerReviewPrompt(s, promptId, step, now, emit));
  }

  // ---- 昇級戦と降級の猶予 (REQ-PROMO-*, promotion.ts) — nothing here ever grants anything ----
  /** REQ-PROMO-013: the series, the grace window, the rules (a read on a copy: a season close is not saved by a read). */
  async promotion(id: string) {
    const s = structuredClone(await this.load(id));
    rollSeason(this.d.master, s, this.d.clock());
    return promotionView(this.d.master, s);
  }
  /** REQ-PROMO-014: the result sheet of an ended series was seen (idempotent). */
  promotionAck(id: string, seriesId: string) { return this.tx(id, null, (s) => ackPromotion(s, seriesId)); }

  // ---- 厩舎の整理 (REQ-ORG-*, roster.ts) ----
  /** REQ-ORG-001..003: the organiser rows, filtered / sorted by the optional query (the client runs the same rules). */
  async roster(id: string, query: Record<string, string | undefined> = {}) {
    const q = parseRosterQuery(this.d.master, query);
    return rosterView(this.d.master, await this.load(id), this.d.clock(), q);
  }
  /** REQ-ORG-005: value replacements (idempotent). */
  rosterLock(id: string, horseId: string, locked: boolean) { return this.tx(id, null, (s) => setLock(s, horseId, locked)); }
  rosterFavorite(id: string, horseId: string, favorite: boolean) { return this.tx(id, null, (s) => setFavorite(s, horseId, favorite)); }
  /** REQ-ORG-007: changes nothing. */
  async rosterPreview(id: string, action: BulkAction, horseIds: string[]) { return bulkPreview(await this.load(id), action, horseIds, this.d.clock()); }
  /** REQ-ORG-008: keyed, all or nothing (one transaction). */
  async rosterBulk(id: string, action: BulkAction, horseIds: string[], confirmToken: string | undefined, idemKey: string | null) {
    return this.tx(id, this.requireKey(idemKey), (s, now, emit) => { pruneRoster(s, now); return runBulk(this.d.master, s, action, horseIds, confirmToken, now, emit); });
  }
  /** REQ-ORG-011: TournamentsService registered (horseId) / unregistered (null) the player. */
  async rosterTournament(id: string, tournamentId: string, horseId: string | null, untilMs: number) {
    if (await this.wiped(id)) return { ok: false }; // a deleted account is never re-created by a late tournament note
    return this.tx(id, null, (s, now) => { pruneRoster(s, now); noteTournamentEntry(s, tournamentId, horseId, untilMs); return { ok: true }; });
  }

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
    return this.tx(id, key, (s, now, emit) => {
      const r = buyCosmetic(this.d.master, s, itemId, now, key);
      this.noteSilksPartBuy(r, emit);
      return { ...r, wallet: playerView(s).wallet };
    });
  }
  /** REQ-SILK-014: silks_part_buy whichever purchase API bought a 勝負服エディタ part. */
  private noteSilksPartBuy(r: { itemId: string; spent: { paid: number; free: number } }, emit: Emit) {
    const c = findCosmetic(this.d.master, r.itemId);
    const part = partOfCosmetic(c);
    if (part) emit({ name: 'silks_part_buy', s1: c.id, s2: part.type, s3: c.currency, paidCoins: r.spent.paid, freeCoins: r.spent.free, value: c.price });
    return part;
  }

  // ---- 勝負服エディタ (REQ-SILK-*, silksEditor.ts, contracts/protocol.md §35) ----
  async silksEditor(id: string) { return silksEditorView(this.d.master, await this.load(id)); }
  /** REQ-SILK-006: try before buying — read only, parts need not be owned. */
  async silksPreview(id: string, input: DesignInput) { return previewDesign(this.d.master, await this.load(id), designFromInput(this.d.master, input)); }
  private equipSilks(s: PlayerState, d: SilksDesign, source: 'editor' | 'preset', emit: Emit) {
    const r = equipDesign(this.d.master, s, d);
    countOnboarding(s, 'silks');
    if (r.changed) emit({ name: 'silks_edit', s1: r.code, s2: source, value: nonFreeParts(this.d.master, r.design), count: silksEditorView(this.d.master, s).presets.length });
    return { design: r.design, code: r.code, silks: r.silks };
  }
  /** REQ-SILK-012 PUT /v1/silks: validated (owned parts, readability, reserved silks) and equipped. Idempotent. */
  saveSilks(id: string, input: DesignInput) {
    return this.tx(id, null, (s, _now, emit) => { notWhileDeleting(s); return this.equipSilks(s, designFromInput(this.d.master, input), 'editor', emit); });
  }
  silksPresetCreate(id: string, name: string | undefined, input: DesignInput) {
    return this.tx(id, null, (s, now) => {
      notWhileDeleting(s);
      const slot = createPreset(this.d.master, s, name, designFromInput(this.d.master, input), now);
      return { slot, presets: silksEditorView(this.d.master, s).presets };
    });
  }
  silksPresetUpdate(id: string, slot: number, name: string | undefined, input: DesignInput | null) {
    return this.tx(id, null, (s, now) => {
      notWhileDeleting(s);
      updatePreset(this.d.master, s, slot, name, input ? designFromInput(this.d.master, input) : null, now);
      return { slot, presets: silksEditorView(this.d.master, s).presets };
    });
  }
  silksPresetDelete(id: string, slot: number) {
    return this.tx(id, null, (s) => { deletePreset(s, slot); return { presets: silksEditorView(this.d.master, s).presets }; });
  }
  silksPresetApply(id: string, slot: number) {
    return this.tx(id, null, (s, _now, emit) => { notWhileDeleting(s); return this.equipSilks(s, presetDesign(this.d.master, s, slot), 'preset', emit); });
  }
  /** REQ-SILK-005: buy one part (same purchase as the shop's cosmetics tab: paid coins first, paid-only parts on paid coins). */
  async buySilksPart(id: string, itemId: string, idemKey: string | null) {
    const key = this.requireKey(idemKey);
    return this.tx(id, key, (s, now, emit) => {
      const c = this.d.master.items.cosmetics.find((x) => x.id === itemId);
      if (!c || !partOfCosmetic(c)) throw new AppError('NOT_FOUND', `silks part ${itemId}`);
      const r = buyCosmetic(this.d.master, s, itemId, now, key);
      const part = this.noteSilksPartBuy(r, emit)!;
      return { itemId: r.itemId, spent: r.spent, wallet: playerView(s).wallet, part: { ...part, owned: true } };
    });
  }
  silksNoticeSeen(id: string) { return this.tx(id, null, (s) => { clearResetNotice(s); return { ok: true }; }); }
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
  rivalBlock(id: string) {
    return this.tx(id, null, (s, now, emit) => {
      const r = rivalBlock(this.d.master, s, now);
      emit({ name: 'block_add', s1: 'rival' }); // REQ-RPT-017 (the rival block always adds: a blocked rival is never paired)
      return r;
    });
  }
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
  async rivalPush(id: string, byName: string, course: string, byId?: string) {
    if (await this.wiped(id)) return { status: 'skipped' as const, reason: 'deleted' as const };
    return this.tx(id, null, (s, now) => {
      const r = ensureRival(s);
      if (r.optOut) return { status: 'skipped' as const, reason: 'opted_out' as const };
      const day = gameDayKeyOf(this.d.master, now);
      // REQ-ACT-002: the activity entry (once per rival and game day, whatever the push preferences)
      recordActivity(this.d.master, s, { kind: 'rival_record', source: `rival_record:${byId ?? byName}:${day}`, actor: byId ? { id: byId, name: byName } : null, vars: { name: byName, course } }, now);
      if (r.pushDay && r.pushDay >= day) return { status: 'skipped' as const, reason: 'already_today' as const };
      const out = enqueuePush(this.d.master, s, 'rival_record', { name: byName, course }, now);
      if (out.status === 'queued') r.pushDay = day;
      return out;
    });
  }

  // ---------------------------------------------------------------- マイリプレイ (REQ-MYRP-*, myReplays.ts; R2 copies by MyReplaysService)
  myReplays(id: string) { return this.tx(id, null, (s, now) => myReplaysView(this.d.master, s, now)); }
  /** Save step 1 (read only): the existing save, or the race to copy. Checks the title first so nothing is uploaded for a bad one. */
  async replayPrepareSave(id: string, raceId: string, title: string | null) {
    const s = await this.load(id);
    const r = prepareSave(this.d.master, s, raceId, this.d.clock());
    if (!r.existing) validateReplayTitle(this.d.master, title);
    return r;
  }
  /** Save step 2, after the copy is in R2 (keyed with the client's key: a retry returns the first answer). */
  replayCommitSave(id: string, raceId: string, title: string | null, sizeBytes: number, idemKey: string | null) {
    return this.tx(id, this.requireKey(idemKey), (s, now, emit) => {
      const r = commitSave(this.d.master, s, raceId, title, sizeBytes, now, emit);
      if (!r.alreadySaved) noteRecapReplaySaved(this.d.master, s, now); // REQ-RECAP-001
      return r;
    });
  }
  replayForget(id: string, raceId: string) { return this.tx(id, null, (s) => { forgetRecent(s, raceId); return true; }); }
  replayUpdate(id: string, raceId: string, patch: ReplayPatch) { return this.tx(id, null, (s) => updateSaved(this.d.master, s, raceId, patch)); }
  replayDelete(id: string, raceId: string) { return this.tx(id, null, (s, now) => deleteSaved(this.d.master, s, raceId, now)); }
  async replayOwnRef(id: string, raceId: string) { return ownReplayRef(this.d.master, await this.load(id), raceId, this.d.clock()); }
  /** REQ-MYRP-010: the owner's public saves for a friend (null = hidden). */
  async replayShared(id: string, viewerId: string) {
    if (await this.wiped(id)) return null;
    return sharedFor(this.d.master, await this.load(id), viewerId, this.d.clock());
  }
  // ---------------------------------------------------------------- 個人データの開示 (REQ-DEX-*, dataExport.ts, protocol §51)
  /** REQ-DEX-003: the status (read only; the HTTP layer adds signed links when ready). A wiped account has nothing. */
  async dataExportView(id: string) {
    if (await this.wiped(id) && (await this.repo.tombstoned?.(id))) throw new AppError('NOT_FOUND', 'account deleted');
    return dataExportView(this.d.master, await this.load(id), this.d.clock());
  }
  /** REQ-DEX-002/004/005: request (or the running one again). Keyed by the client's idempotency key. */
  dataExportRequest(id: string, lang: DexLang, idemKey: string | null) {
    return this.tx(id, this.requireKey(idemKey), (s, now, emit) => {
      const r = requestDataExport(this.d.master, s, lang, this.d.rng, now);
      if (r.created) emit({ name: 'dex_request', s1: lang });
      return { ...dataExportView(this.d.master, s, now), created: r.created };
    });
  }
  /** Alarm: take a due build (null = nothing to build). */
  async dataExportTake(id: string) {
    if (await this.wiped(id)) return null;
    const at = nextDataExportWake(await this.load(id));
    if (at === null || at > this.d.clock()) return null; // nothing due: no write
    return this.tx(id, null, (s, now) => takeDataExport(this.d.master, s, now));
  }
  /**
   * Alarm: what the document is built from — the state, every ledger row inside the legal retention window and the
   * gacha records of the last 90 days (the Durable Object's SQL tables hold the rows the state JSON no longer keeps).
   */
  async dataExportCollect(id: string) {
    const s = await this.load(id);
    const now = this.d.clock();
    const p = this.pagers(id, s);
    const ledger: LedgerEntry[] = [];
    const ledgerSince = now - deletionConfig(this.d.master).ledgerRetentionDays * DAY_MS;
    for (let before: number | null = null; ;) {
      const page = await p.ledger({ beforeSeq: before, sinceAt: ledgerSince, limit: 500, currency: null });
      ledger.push(...page);
      if (page.length < 500) break;
      before = page[page.length - 1]!.seq;
    }
    const gacha: GachaLogEntry[] = [];
    for (let before: number | null = null; ;) {
      const page = await p.gacha({ beforeSeq: before, sinceAt: now - HISTORY_LIMITS.gachaDays * DAY_MS, limit: 500 });
      gacha.push(...page);
      if (page.length < 500) break;
      before = page[page.length - 1]!.seq;
    }
    return { state: s, ledger, gacha, now };
  }
  /** Alarm: the files are in R2 → ready, one activity entry (§40), KPI dex_ready. A stale request deletes its files instead. */
  dataExportReady(id: string, requestId: string, info: DexReadyInfo) {
    return this.tx(id, null, (s, now, emit) => {
      const requestedAt = s.dataExport?.current?.requestedAt ?? now;
      const lang = s.dataExport?.current?.lang ?? 'ja';
      if (!markDataExportReady(this.d.master, s, requestId, info, now)) return false;
      recordActivity(this.d.master, s, { kind: 'data_export_ready', source: `data_export_ready:${requestId}`, linkId: requestId }, now);
      emit({ name: 'dex_ready', s1: lang, value: info.sizeBytes, durationMs: now - requestedAt, count: info.truncated });
      return true;
    });
  }
  dataExportFailed(id: string, requestId: string, reason: string) { return this.tx(id, null, (s, now) => markDataExportFailed(this.d.master, s, requestId, reason, now)); }
  /** REQ-DEX-010: the stored file behind a verified signed link (never re-creates a deleted account). */
  async dataExportFile(id: string, requestId: string, f: DexFile) {
    if (await this.wiped(id)) throw new AppError('NOT_FOUND', 'this download is no longer available');
    return dataExportFile(await this.load(id), requestId, f, this.d.clock());
  }
  /** REQ-DEX-010/017: audit + KPI dex_download (isFirst = the first download of this request). */
  async dataExportDownloaded(id: string, requestId: string, f: DexFile) {
    if (await this.wiped(id)) return false;
    return this.tx(id, null, (s, now, emit) => {
      if (!noteDataExportDownload(this.d.master, s, requestId, f, now)) return false;
      emit({ name: 'dex_download', s1: f, isFirst: s.dataExport!.current!.downloads === 1 });
      return true;
    });
  }
  /** Alarm: R2 keys to delete now (marks an expired export). */
  async dataExportExpiring(id: string) {
    if (await this.wiped(id)) return [] as string[];
    const at = nextDataExportWake(await this.load(id));
    if (at === null || at > this.d.clock()) return [] as string[]; // nothing due: no write
    return this.tx(id, null, (s, now) => takeExpiredDataExport(this.d.master, s, now));
  }
  async dataExportDeleted(id: string, keys: string[]) {
    if (await this.wiped(id)) return;
    await this.tx(id, null, (s, now) => dataExportDeleted(this.d.master, s, keys, now));
  }
  /** REQ-DEX-014: ops status and audit (admin API; never contents or links). */
  async dataExportAdmin(id: string) { return dataExportAdminView(this.d.master, await this.load(id), this.d.clock()); }

  // ---------------------------------------------------------------- シーズンの振り返り (REQ-RECAP-*, seasonRecap.ts)
  /** Runs as a transaction so a period that ended since the last request is closed first (rollRecaps). */
  recaps(id: string) { return this.tx(id, null, (s) => recapsList(this.d.master, s)); }
  recap(id: string, recapId: string) { return this.tx(id, null, (s) => recapView(this.d.master, s, recapId)); }
  recapProgress(id: string, recapId: string, step: RecapStepName) {
    return this.tx(id, null, (s, now, emit) => recapProgress(this.d.master, s, recapId, step, now, emit));
  }

  /** REQ-MYRP-014: replay_view on the viewer's own record. */
  replayViewed(id: string, source: 'own' | 'friend', status: string, mode: string) {
    return this.tx(id, null, (_s, _now, emit) => { emit({ name: 'replay_view', s1: source, s2: status, s3: mode }); return true; });
  }

  // ---------------------------------------------------------------- プレイヤー主催カップ (REQ-CUP-*, hostedCups.ts; the cups by HostedCupsService)
  async cupsMine(id: string) {
    const s = await this.load(id);
    return { ...playerCupsView(this.d.master, s, this.d.clock()), teamId: s.team?.teamId ?? null };
  }
  /** REQ-CUP-006/007: limits, deletion, BAN — before the cup accepts a create / join (idempotent per cup). */
  cupReserve(id: string, cupId: string, role: 'host' | 'entrant', until: number, horseId?: string) {
    return this.tx(id, null, (s, now) => reserveCup(this.d.master, s, cupId, role, until, now, horseId));
  }
  cupRelease(id: string, cupId: string) { return this.tx(id, null, (s) => releaseCup(s, cupId)); }
  /** The player left a cup before its first race: the slot no longer counts. */
  cupLeft(id: string, cupId: string) {
    return this.tx(id, null, (s) => { const st = ensureCups(s); st.active = st.active.filter((r) => r.cupId !== cupId); return true; });
  }
  cupCommitted(id: string, cupId: string, kind: 'create' | 'join', meta: { format: CupFormat; capacity?: number; via?: string; team?: boolean; cupName?: string }) {
    return this.tx(id, null, (s, _now, emit) => { noteCupCommitted(s, cupId, kind, meta, emit); return true; });
  }
  /** REQ-CUP-003: one code attempt (RATE_LIMITED past the hourly cap). */
  cupCodeAttempt(id: string) { return this.tx(id, null, (s, now) => countCodeAttempt(this.d.master, s, now)); }
  /** REQ-CUP-004: an invitation from a host (dropped when muted / deleting) + the cup_invite push. */
  async cupInvited(id: string, inv: PlayerCupInvite) {
    if (await this.wiped(id)) return false;
    return this.tx(id, null, (s, now) => {
      const ok = receiveCupInvite(this.d.master, s, inv, now);
      if (ok && this.d.master.push.templates['cup_invite']) { ensurePush(this.d.master, s); enqueuePush(this.d.master, s, 'cup_invite', { name: inv.hostName }, now); }
      // §42.7 × §40: one activity entry per cup (recordActivity drops a blocked host and a repeat)
      if (ok) recordActivity(this.d.master, s, { kind: 'cup_invited', source: `cup_invited:${inv.cupId}`, actor: { id: inv.hostId, name: inv.hostName }, vars: { cup: inv.cupName }, linkId: inv.cupId }, now);
      return ok;
    });
  }
  /** REQ-CUP-012/014: the cup closed (result, trophy; once per cup). A wiped account answers ok (nothing to tell). */
  async cupClosed(id: string, n: CupClosedNotice) {
    if (await this.wiped(id)) return { recorded: false };
    return this.tx(id, null, (s, now, emit) => {
      const r = receiveCupClosed(this.d.master, s, n, emit);
      // §42.7 × §40: the result (or the cancellation) once per cup, for those who were in it
      if (r) {
        const finished = r.status === 'finished' && r.rank !== null;
        recordActivity(this.d.master, s, { kind: finished ? 'cup_finished' : 'cup_cancelled', source: `cup_closed:${n.cupId}`, vars: finished ? { cup: n.cupName, n: String(r.rank) } : { cup: n.cupName }, linkId: n.cupId }, now);
      }
      return { recorded: r !== null };
    });
  }
  /** §42.7 × §40: the cup's first race started — one activity entry (only while the player is still in that cup). */
  async cupStarted(id: string, n: CupStartedNotice) {
    if (await this.wiped(id)) return false;
    return this.tx(id, null, (s, now) => {
      if (!s.cups?.active.some((r) => r.cupId === n.cupId)) return false;
      return recordActivity(this.d.master, s, { kind: 'cup_started', source: `cup_started:${n.cupId}`, vars: { cup: n.cupName }, linkId: n.cupId }, now) === 'recorded';
    });
  }
  async cupHorseName(id: string, horseId: string) { return getHorse(await this.load(id), horseId).name ?? ''; }

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
      // REQ-MYRP-002: the course best before this race decides a personal-best moment
      const prevBest = r.details?.trackId ? s.stats.byTrack[r.details.trackId]?.bestFinishTick ?? null : null;
      if (r.mode === 'cup') {
        // REQ-CUP-013: a hosted cup race is unranked — recorded only (no coins, missions, pass, rating, season, stats,
        // rival, hall, team feed / goal, assist streak). The cup's own object keeps the standings.
        noteRaceForReplays(this.d.master, s, r, prevBest, now);
        noteFsugRace(this.d.master, s, r, now); // REQ-FSUG-013: cup mates are people met in the game (Round 17 integration)
        if (!r.void) emit({ name: 'race_finish', s1: r.mode, s2: r.details?.style ?? '', s3: r.details?.trackId ?? '', place: r.place, count: r.fieldSize, value: r.humans ?? 0 });
        return { coins: 0, seasonPoints: 0, titles: [] as string[], rewarded: false, firstWinBonus: 0, comebackXp: 0, achievements: [] as ReturnType<typeof syncCollection>, event: null };
      }
      const base0 = applyRaceResult(this.d.master, s, r, now);
      notePromotionRace(this.d.master, s, r, now, emit); // REQ-PROMO-003..007: the series / grace window (after the points)
      noteRaceForReplays(this.d.master, s, r, prevBest, now); // REQ-MYRP-001: offer the race in マイリプレイ
      noteRivalRace(this.d.master, s, r, now, emit); // REQ-RIVAL-004: head to head (ranked) / challenge (friend)
      noteFsugRace(this.d.master, s, r, now); // REQ-FSUG-013: friend-room / event / tournament opponents (never ranked)
      // REQ-HOF-001: the horse's career (a ranked race counted against the weekly rival with me ahead is a rival win)
      const rivalWin = r.mode === 'ranked' && !!s.rival?.weeks.some((w) => w.races.some((x) => x.raceId === r.raceId && x.mode === 'ranked' && x.point === 'me'));
      noteHallRace(this.d.master, s, r, now, rivalWin);
      noteHorseGoals(this.d.master, s, r.horseId, now, emit); // REQ-HGOAL-005: goals newly met by this counted race
      noteRecapRace(this.d.master, s, r, now); // REQ-RECAP-001: this season's and this game year's records
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
      noteRecapTeamGoal(this.d.master, s, goal, now); // REQ-RECAP-001
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
      // REQ-ACT-002: the week's result (the reward itself waits in the gift box, which writes no second entry)
      if (r.status === 'rewarded' || r.status === 'none') recordActivity(this.d.master, s, { kind: 'team_goal_week', source: `team_goal_week:${week}`, vars: { n: String(tier) } }, now);
      return r;
    });
  }
  /** REQ-TGOAL-004 / REQ-ACT-002: a newly reached tier of the team's goal — the push (daily cap applies) and the activity entry. */
  async teamGoalMilestone(id: string, teamId: string, tier: number) {
    if (await this.wiped(id)) return { status: 'skipped' as const, reason: 'deleted' as const };
    return this.tx(id, null, (s, now) => {
      recordActivity(this.d.master, s, { kind: 'team_goal_tier', source: `team_goal_tier:${teamId}:${weekKeyOf(now, dayRule(this.d.master))}:${tier}`, vars: { n: String(tier) } }, now);
      ensurePush(this.d.master, s);
      return enqueuePush(this.d.master, s, 'team_goal', { n: String(tier) }, now);
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
      attachRecapRank(this.d.master, s, seasonId); // REQ-RECAP-005: the final class rank, once (the recap itself was built by rollRecaps)
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
      if (out === 'received') {
        enqueuePush(this.d.master, s, 'friend_request', { name: fromName ?? 'フレンド' }, now);
        recordActivity(this.d.master, s, { kind: 'friend_request', source: `friend_request:${fromId}:${now}`, actor: { id: fromId, name: fromName ?? null } }, now); // REQ-ACT-002
      }
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
      if (!was) {
        enqueuePush(this.d.master, s, 'friend_accepted', { name: byName ?? 'フレンド' }, now);
        recordActivity(this.d.master, s, { kind: 'friend_accepted', source: `friend_accepted:${byId}:${gameDayKeyOf(this.d.master, now)}`, actor: { id: byId, name: byName ?? null } }, now); // REQ-ACT-002
      }
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

  // ---- おすすめフレンド: per-player steps, orchestrated by FriendSuggestService (REQ-FSUG-*, contracts/protocol.md §49) ----
  /** REQ-FSUG-010: what the computation needs from my own state (a read; no state is created). */
  async fsugSelf(id: string) { return fsugSelf(this.d.master, await this.load(id), this.d.clock()); }
  /** REQ-FSUG-008/009/014: remember a dismissed / requested suggestion; the KPI row only when the record changed. */
  fsugDismiss(id: string, target: string, why: FsugDismissed['why'], reason: FsugKind | 'none', outcome?: 'requested' | 'friends') {
    return this.tx(id, null, (s, now, emit) => {
      const changed = fsugDismiss(this.d.master, s, target, why, now);
      if (changed && why === 'requested') emit({ name: 'fsug_request', s1: reason, s2: outcome ?? 'requested' });
      if (changed && why === 'dismiss') emit({ name: 'fsug_dismiss', s1: reason });
      return { ok: true as const };
    });
  }
  /** REQ-FSUG-007: 「おすすめに表示しない」 (the card follows through onFsugCard). */
  fsugSetHidden(id: string, hidden: boolean) { return this.tx(id, null, (s) => fsugSetHidden(s, hidden)); }

  // ---- 引き継ぎコード: per-player steps, orchestrated by TransferService (REQ-TRF-*, contracts/protocol.md §54) ----
  async transferView(id: string) { return transferStateView(this.d.master, await this.load(id), this.d.clock()); }
  /** REQ-TRF-001: banned / deletion / today's issues, checked before the hash is computed (read only). */
  async transferCheckIssue(id: string) { assertMayIssue(this.d.master, await this.load(id), this.d.clock()); return { ok: true as const }; }
  transferIssued(id: string, codeId: string, mode: TransferMode) {
    return this.tx(id, null, (s, now, emit) => {
      const r = issueTransfer(this.d.master, s, codeId, mode, now);
      emit({ name: 'transfer_issue', s1: mode });
      return { previous: r.previous, issuedAt: now, expiresAt: r.expiresAt };
    });
  }
  transferRevoke(id: string, by: 'player' | 'ops') { return this.tx(id, null, (s, now) => ({ revoked: revokeTransfer(s, now, by) })); }
  /** REQ-TRF-009: what the redeeming device would leave behind (read only; a never-stored account has none). */
  async transferProgress(id: string) { return progressOf(await this.repo.get(id)); }
  /** REQ-TRF-005/012: consume the code on the owner's object (serialised: one success per code). */
  transferRedeemed(id: string, codeId: string) {
    return this.tx(id, null, (s, now, emit) => {
      redeemTransfer(s, codeId, now);
      emit({ name: 'transfer_redeem', s1: 'ok' });
      return { displayName: s.profile.displayName, cutoffAt: now };
    });
  }
  /** REQ-TRF-014: a failed redeem, counted on the requesting account (the reason category only). */
  transferFailed(id: string, reason: string) { return this.tx(id, null, (_s, _now, emit) => { emit({ name: 'transfer_redeem', s1: 'fail', s2: reason }); return { ok: true as const }; }); }
  /** REQ-TRF-009: a retried redeem (same idempotency key, within an hour) on the requesting account (read only). */
  async transferRedeemReplay(id: string, key: string) {
    const r = (await this.repo.get(id))?.transfer?.redeemedAs;
    return r && r.key === key && this.d.clock() - r.at < REDEEM_REPLAY_MS ? { playerId: r.playerId, displayName: r.displayName } : null;
  }
  transferRedeemRemember(id: string, key: string, playerId: string, displayName: string) {
    return this.tx(id, null, (s, now) => { ensureTransfer(s).redeemedAs = { key, playerId, displayName, at: now }; return { ok: true as const }; });
  }
  /** REQ-TRF-010: the old-device cut-off (read only; null for accounts that never moved). */
  async transferCutoff(id: string) { return (await this.repo.get(id))?.transfer?.cutoffAt ?? null; }
  async adminTransfer(id: string) {
    const s = await this.repo.get(id);
    const t = s?.transfer;
    return { exists: s !== null, code: t?.code ? { codeId: formatCodeId(t.code.id), mode: t.code.mode, issuedAt: t.code.issuedAt, expiresAt: t.code.expiresAt } : null, cutoffAt: t?.cutoffAt ?? null, lastRedeemedAt: t?.lastRedeemedAt ?? null, history: t?.history ?? [] };
  }

  // ---- ディープリンク・再戦: per-player steps, orchestrated by LinkService / the HTTP layer (REQ-LINK-*, contracts/protocol.md §63) ----
  /** REQ-LINK-006: ban / deletion / block list of an owner or viewer (read only; a never-stored or wiped account does not exist). */
  async linkParty(id: string) {
    const s = await this.repo.get(id);
    if (!s) return { exists: false, banned: false, deleting: false, blocks: [] as string[], displayName: '' };
    return { exists: true, banned: moderationOf(s, this.d.clock()) === 'banned', deleting: deletionScheduled(s), blocks: blockListOf(s), displayName: s.profile.displayName };
  }
  /** REQ-LINK-003: banned → BANNED, deletion scheduled → DELETION_PENDING (read only). */
  async linkCheckCreate(id: string) {
    const s = await this.load(id);
    if (moderationOf(s, this.d.clock()) === 'banned') throw new AppError('BANNED', 'links are disabled for this account');
    if (deletionScheduled(s)) throw new AppError('DELETION_PENDING', 'the account is scheduled for deletion');
    return { ok: true as const };
  }
  /** REQ-LINK-021: one KPI row (the type / outcome categories only — never a token, a target or an id). */
  linkNote(id: string, name: 'link_create' | 'link_resolve' | 'link_revoke' | 'rematch', s1: string, s2?: string, count?: number) {
    return this.tx(id, null, (_s, _now, emit) => {
      emit({ name, s1, ...(s2 !== undefined ? { s2 } : {}), ...(count !== undefined ? { count } : {}) });
      return { ok: true as const };
    });
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

  // ---- アクティビティ (REQ-ACT-*, contracts/protocol.md §40) ----
  /** REQ-ACT-001/007: one page (names unresolved; the HTTP layer resolves them from the directory, REQ-ACT-012). */
  async activity(id: string, cursor: number | null = null, limit: number = 20) {
    const s = await this.load(id);
    const now = this.d.clock();
    let whatsNewCount = 0;
    try { const w = whatsNew(this.d.master, s, now); whatsNewCount = w.items.length + w.more; } catch { /* comeback disabled */ }
    return activityPage(this.d.master, s, now, cursor, limit, whatsNewCount);
  }
  /** REQ-ACT-002 (§37 × §40): a friend made a saved replay public — one entry per owner + race (blocks: recordActivity). */
  async activityReplayShare(id: string, ownerId: string, raceId: string) {
    if (await this.wiped(id)) return 'skipped' as const; // a late fan-out never recreates a deleted account
    return this.tx(id, null, (s, now) => recordActivity(this.d.master, s, { kind: 'replay_share', source: `replay_share:${ownerId}:${raceId}`, actor: { id: ownerId }, linkId: ownerId }, now));
  }
  /** REQ-ACT-008: mark read up to an id (idempotent). */
  activityRead(id: string, upTo: number | null) { return this.tx(id, null, (s, now) => markActivityRead(this.d.master, s, upTo, now)); }

  // ---- チュートリアルのやり直しとヒント集 (REQ-TUT-*, contracts/protocol.md §57) ----
  /** REQ-TUT-005: the tips index for this player (reads only: cards open with the §4.3 unlocks, "new" = open and not seen). */
  async tips(id: string, lang: Locale = 'ja', maxWhips = 6) { return tipsIndex(this.d.master, await this.load(id), this.d.clock(), lang, maxWhips); }
  /** REQ-TUT-007: mark open cards seen (idempotent; never grants anything). */
  tipsSeen(id: string, ids: string[]) { return this.tx(id, null, (s, now) => markTipsSeen(this.d.master, s, ids, now)); }

  // ---- プロフィールのショーケース (REQ-SHOW-*, protocol §62)
  /** GET /v1/showcase: the selection, every choice with eligibility and the self preview (read only). */
  async showcaseMine(id: string, lang: Locale = 'ja') { return showcaseMine(this.d.master, await this.load(id), this.d.clock(), lang); }
  /** PUT /v1/showcase: validated replace; the public copy follows through the profile push (profileKey includes it). */
  showcaseSave(id: string, input: ShowcaseInput, lang: Locale = 'ja') {
    return this.tx(id, null, (s, now, emit) => { setShowcase(this.d.master, s, input, now, emit); return showcaseMine(this.d.master, s, now, lang); });
  }
  /** The viewer's side of GET /v1/showcase/:playerId: friends and the one block list (§47.1). No writes. */
  async showcaseViewer(id: string) { const s = await this.load(id); return { friendIds: [...s.friends.ids], blocked: [...blockIds(s)] }; }
  /** REQ-SHOW-018: account deletion step (the copy leaves with the directory profile; the state is wiped at the end anyway). */
  showcaseForget(id: string) { return this.tx(id, null, (s) => forgetShowcase(s)); }

  // ---- アップデートのお知らせ (REQ-NEW-*, contracts/protocol.md §64) ----
  /** REQ-NEW-006/007: the release notes to show at this home arrival (writes only the FTUE baseline; never marks seen, never grants). */
  releaseNotesCheck(id: string, appVersion: string | null, lang: Locale = 'ja', maxWhips = 6) { return this.tx(id, null, (s, now) => checkReleaseNotes(this.d.master, s, appVersion, lang, now, maxWhips)); }
  /** REQ-NEW-009: the sheet was shown (idempotent). */
  releaseNotesSeen(id: string, appVersion: string) { return this.tx(id, null, (s) => markReleaseNotesSeen(this.d.master, s, appVersion)); }
  /** REQ-NEW-010: past notes (reads only). */
  async releaseNotes(id: string, appVersion: string | null, lang: Locale = 'ja', maxWhips = 6) { return releaseNotesHistory(this.d.master, await this.load(id), appVersion, lang, this.d.clock(), maxWhips); }

  // ---- イベントカレンダー (REQ-CAL-*, contracts/protocol.md §65) ----
  /** REQ-CAL-004: the player's calendar (reads only; `ext` = tournaments and cups the HTTP layer read from their objects). */
  async calendar(id: string, q: { from?: string | null; to?: string | null }, ext: CalendarExternal) { return calendarView(this.d.master, await this.load(id), q, this.d.clock(), ext); }
  /** REQ-CAL-010: mark / unmark a row (idempotent; only the flag is stored, nothing is ever pushed for it). */
  calendarMark(id: string, entryId: string, on: boolean, ext: CalendarExternal) { return this.tx(id, null, (s, now, emit) => markCalendar(this.d.master, s, entryId, on, now, ext, emit)); }

  // ---- ヘルプセンター (REQ-HELP-*, contracts/protocol.md §48) ----
  /** REQ-HELP-007: one vote per article (changeable), capped per game day. */
  helpFeedback(id: string, articleId: string, helpful: boolean) {
    return this.tx(id, null, (s, now, emit) => voteHelp(this.d.master, s, articleId, helpful, now, emit));
  }
  /**
   * REQ-HELP-009..013: a new inquiry, keyed with the client's key (a retry returns the stored ticket, even after the
   * attached rows left their windows). The §33 rows are resolved before the transaction (they are read from SQL pages).
   */
  async helpInquirySubmit(id: string, input: InquiryInput, idemKey: string | null, lang: Locale = 'ja') {
    const key = this.requireKey(idemKey);
    const s = await this.historyState(id);
    const known = s.idem.find((e) => e.key === key);
    if (known) return known.result as ReturnType<typeof inquiryDetail>;
    const prev = (s as { help?: { tickets: { id: string; key: string }[] } }).help?.tickets.find((t) => t.key === key);
    if (prev) return inquiryDetail(this.d.master, s, prev.id, lang);
    let rows: Awaited<ReturnType<typeof resolveRefs>> = [];
    if (input.refs.length) {
      if (new Set(input.refs).size !== input.refs.length) throw new AppError('BAD_REQUEST', 'refs must be distinct');
      const p = this.pagers(id, s);
      rows = await resolveRefs(this.d.master, s, p.ledger, p.gacha, this.d.clock(), input.refs);
      const missing = rows.find((r) => r.kind === null);
      if (missing) throw new AppError('NOT_FOUND', `reference ${missing.ref}`);
    }
    return this.tx(id, key, (st, now, emit) => submitInquiry(this.d.master, st, input, rows as Exclude<typeof rows[number], { kind: null }>[], key, lang, now, emit));
  }
  /** REQ-HELP-014: the player's inquiries, newest first, with the limits. */
  async helpInquiries(id: string, lang: Locale = 'ja') {
    const s = await this.load(id);
    return { ...inquiryList(this.d.master, s, lang, this.d.clock()), unindexed: unindexedSummaries(s) };
  }
  async helpInquiry(id: string, ticketId: string, lang: Locale = 'ja') { return inquiryDetail(this.d.master, await this.load(id), ticketId, lang); }
  helpInquiryRead(id: string, ticketId: string) { return this.tx(id, null, (s) => markInquiryRead(s, ticketId)); }
  /** REQ-HELP-016: the ops index stored these ticket versions. */
  async helpInquiryIndexed(id: string, items: { ticketId: string; updatedAt: number }[]) {
    if (await this.wiped(id)) return { indexed: 0 };
    return this.tx(id, null, (s) => markIndexed(s, items));
  }
  /** REQ-HELP-016: the ops view of one inquiry (who replied; a deleted account is NOT_FOUND). */
  async adminInquiry(id: string, ticketId: string) {
    const s = await this.historyState(id);
    return { playerId: id, ...inquiryDetail(this.d.master, s, ticketId, 'ja', true), unindexed: unindexedSummaries(s) };
  }
  /** REQ-HELP-015/017: an operator's reply (once per opKey; never on a deleted account). */
  async adminInquiryReply(id: string, ticketId: string, content: string, close: boolean, actor: string, opKey: string) {
    await this.historyState(id);
    if (await this.wiped(id)) throw new AppError('NOT_FOUND', `inquiry ${ticketId}`);
    return this.tx(id, null, (s, now, emit) => replyInquiry(this.d.master, s, ticketId, content, close, actor, opKey, now, emit));
  }

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

  // ---- 殿堂 (REQ-HOF-*, hallOfFame.ts) ----
  /** REQ-HOF-009: my hall (a read: the hof_view KPI with relation self, no state is written). */
  async hallMine(id: string, cursor: string | null, limit: number | null) {
    const s = await this.load(id);
    const now = this.d.clock();
    const v = myHallView(this.d.master, s, cursor, limit);
    if (this.d.onKpi) await this.writeKpi(id, s, now, [kpiRecord(s, now, { name: 'hof_view', s1: 'self', value: v.entries.length })]);
    return v;
  }
  /** REQ-HOF-012: the visitor's side of a visit (friends, branch, block list), read only. */
  async hallViewer(id: string) { return hallViewerOf(await this.load(id)); }
  /** REQ-HOF-016: the hof_view KPI of a visit (no state is written). */
  async hallNoteView(id: string, relation: HallRelation, count: number) {
    if (!this.d.onKpi) return { noted: false };
    const s = await this.load(id);
    const now = this.d.clock();
    await this.writeKpi(id, s, now, [kpiRecord(s, now, { name: 'hof_view', s1: relation, value: count })]);
    return { noted: true };
  }
  async horseCareer(id: string, horseId: string) { return horseCareerView(this.d.master, await this.load(id), horseId); }
  /** REQ-HOF-004: idempotent by nature (a repeat returns the first acknowledgement). */
  hallAck(id: string, horseId: string) { return this.tx(id, null, (s, now) => ackCeremony(s, horseId, now)); }
  hallSettings(id: string, visibility: string) { return this.tx(id, null, (s) => setHallVisibility(s, visibility)); }

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
    if (this.d.onKpi && v.relation !== 'self') await this.writeKpi(id, s, now, [kpiRecord(s, now, { name: 'stable_visit', s1: v.relation })]);
    return v;
  }
  stableLikeGive(id: string, target: string, idemKey: string | null) {
    return this.tx(id, this.requireKey(idemKey), (s, now, emit) => { notWhileDeleting(s); return stableLikeGive(this.d.master, s, target, now, emit); });
  }
  async stableLikeReceive(id: string, from: string, likeId: string) {
    // REQ-UXS-040: a like that arrives after the owner's account was wiped must not create a fresh player
    if (!(await this.repo.get(id))) return { counted: false, likes: 0, snapshot: null };
    return this.tx(id, null, (s, now) => {
      const r = stableLikeReceive(this.d.master, s, from, likeId, now);
      if (r.counted) recordActivity(this.d.master, s, { kind: 'stable_like', source: `stable_like:${likeId}`, actor: { id: from } }, now); // REQ-ACT-002/006
      return { ...r, snapshot: stableSnapshot(this.d.master, s, now) };
    });
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

  // ---------------------------------------------------------------- 実況パック commentary packs (REQ-CMT-*, commentaryPacks.ts)
  /** GET /v1/commentary/packs: read-only. */
  async commentaryPacks(id: string) { return packsView(this.d.master, await this.load(id)); }
  /** PUT /v1/commentary/equipped: owned packs only; the same pack twice changes nothing. */
  equipCommentaryPack(id: string, packId: string, source: EquipSource) {
    return this.tx(id, null, (s, now, emit) => equipPack(this.d.master, s, packId, source, now, emit));
  }
  /** POST /v1/commentary/packs/:packId/buy: coins (paid first), idempotency key required. */
  async buyCommentaryPack(id: string, packId: string, equip: boolean, idemKey: string | null) {
    const key = this.requireKey(idemKey);
    return this.tx(id, key, (s, now, emit) => {
      const r = buyPack(this.d.master, s, packId, equip, now, key, emit);
      return { ...r, wallet: playerView(s).wallet, view: packsView(this.d.master, s) };
    });
  }

  // ---------------------------------------------------------------- 広告・分析の同意 (REQ-CNS-*, privacyChoices.ts, §58)
  /** GET /v1/privacy/choices: read-only (defaults when never chosen; never creates state). */
  async privacyChoices(id: string) {
    const s = await this.load(id);
    const now = this.d.clock();
    return privacyChoicesView(this.d.master, s, now, adIneligibility(this.d.master, s, now) === null);
  }
  /**
   * R20 integration (§58.10 × §60.6): may a client error sample keep this player's id? Only while analytics is effective,
   * never for an account being deleted (`deleting`) or already wiped (tombstone) — a token can outlive the wipe by up to an
   * hour, and the deletion's client_errors step has already run by then. Read-only.
   */
  async clientErrorsAttach(id: string): Promise<boolean> {
    const stored = await this.repo.get(id);
    if (!stored && (await this.repo.tombstoned?.(id))) return false;
    const s = await this.load(id);
    if (s.deletion?.status === 'deleting') return false;
    return analyticsAllowed(this.d.master, s, this.d.clock());
  }
  /** PUT /v1/privacy/choices: a decision under the current policy version (idempotent by content). */
  setPrivacyChoices(id: string, body: PrivacyChoicesBody) {
    return this.tx(id, null, (s, now, emit) => setPrivacyChoices(this.d.master, s, body, now, emit, adIneligibility(this.d.master, s, now) === null));
  }
  /** PUT /v1/privacy/platform: ATT / UMP results from the device. */
  setPrivacyPlatform(id: string, body: PrivacyPlatformBody) {
    return this.tx(id, null, (s, now, emit) => setPrivacyPlatform(this.d.master, s, body, now, emit, adIneligibility(this.d.master, s, now) === null));
  }
  /** POST /v1/privacy/prompt-shown: the pre-prompt was shown (once per policy version). */
  notePrivacyPromptShown(id: string, privacyVersion: string) {
    return this.tx(id, null, (s, now) => notePrivacyPromptShown(this.d.master, s, privacyVersion, now, adIneligibility(this.d.master, s, now) === null));
  }

  // ---------------------------------------------------------------- 使いすぎ・遊びすぎの防止 (REQ-LIMIT-*, selfLimits.ts, §67)
  /** GET /v1/self-limits: read-only (never creates state). */
  async selfLimits(id: string) {
    const s = await this.load(id);
    const now = this.d.clock();
    return selfLimitsView(this.d.master, s, ageCapOf(this.d.master, s, now), now);
  }
  /** PUT /v1/self-limits/spending: lowering applies now, raising / removing after the cool-off (idempotent by content). */
  setSpendingLimit(id: string, limitYen: number | null) {
    return this.tx(id, null, (s, now, emit) => {
      const age = ageCapOf(this.d.master, s, now);
      const r = setSpendingLimit(this.d.master, s, limitYen, age, now);
      if (r.kind) emit({ name: 'self_limit_set', s1: r.kind, amountYen: r.toYen ?? 0, value: r.fromYen ?? 0 });
      return { applied: r.applied, view: selfLimitsView(this.d.master, s, age, now) };
    });
  }
  /** DELETE /v1/self-limits/spending/pending: the waiting raise / removal is dropped (nothing waiting = no change). */
  cancelSpendingRaise(id: string) {
    return this.tx(id, null, (s, now, emit) => {
      const r = cancelSpendingRaise(this.d.master, s, now);
      if (r.kind) emit({ name: 'self_limit_set', s1: r.kind, amountYen: r.toYen ?? 0, value: r.fromYen ?? 0 });
      return { applied: r.applied, view: selfLimitsView(this.d.master, s, ageCapOf(this.d.master, s, now), now) };
    });
  }
  /** PUT /v1/self-limits/playtime: the reminder settings (missing keys keep their value). */
  setPlaytime(id: string, body: PlaytimeBody) {
    return this.tx(id, null, (s, now, emit) => {
      const r = setPlaytime(this.d.master, s, body, now);
      if (r.changed.length > 0) emit({ name: 'playtime_setting_change', s1: r.changed.map((k) => PLAYTIME_KPI_KEY[k]).join(','), s2: r.enabled ? 'on' : 'off' });
      return { changed: r.changed, view: selfLimitsView(this.d.master, s, ageCapOf(this.d.master, s, now), now) };
    });
  }

  // ---------------------------------------------------------------- アクセシビリティ設定 (REQ-A11Y-*, accessibility.ts)
  /** GET /v1/settings/accessibility: read-only (defaults when never set). */
  async accessibility(id: string) { return accessibilityView(await this.load(id)); }
  /** PUT /v1/settings/accessibility: idempotent full replace (keys left out = defaults). */
  setAccessibility(id: string, body: AccessibilityBody) {
    return this.tx(id, null, (s, now, emit) => setAccessibility(s, body, now, emit));
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

  /** REQ-CNS-013: writes the records the player's analytics choice allows (essential ones always). */
  private async writeKpi(id: string, s: PlayerState, now: number, records: KpiRecord[]) {
    if (!this.d.onKpi) return 0;
    const f = filterKpi(records, analyticsAllowed(this.d.master, s, now));
    if (f.kept.length > 0) await this.d.onKpi(id, f.kept);
    return f.withheld;
  }

  // ---- analytics (REQ-KPI-003/004) ----
  /** Client events: rate-limited per player, enriched with cohort/payer like server events, then emitted via onKpi. */
  async kpiIngest(id: string, batch: ClientBatch) {
    const r = await this.tx(id, null, (s, now) => {
      const events = admitClientBatch(s, batch, now);
      const records = events.map((e) => kpiRecord(s, now, clientToKpi(e), 'client', { platform: batch.platform, appVersion: batch.appVersion, at: e.at }));
      // REQ-CNS-013: counted against the rate limit either way; optional events are not written while analytics is off
      const f = filterKpi(records, analyticsAllowed(this.d.master, s, now));
      return { accepted: events.length, dropped: batch.events.length - events.length, withheld: f.withheld, records: f.kept };
    });
    if (r.records.length > 0 && this.d.onKpi) await this.d.onKpi(id, r.records);
    return { accepted: r.accepted, dropped: r.dropped, withheld: r.withheld };
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
        noteRecapTeamGoal(this.d.master, s, goal, now); // REQ-RECAP-001
        if (goal) {
          notePostedIn(s, goal.teamId);
          emit({ name: 'team_goal_contribute', s1: goal.teamId, s2: 'ta_pb', s3: goal.ref, count: 1 });
        }
      }
      if (!counted && 'finished' in r && r.finished && r.timeMs !== null) {
        const horseId = s.timeAttack?.sessions.find((x) => x.id === sessionId)?.horseId;
        if (horseId) noteHallTa(this.d.master, s, horseId, r.trackId, r.timeMs, now); // REQ-HOF-001
        if (horseId) noteHorseGoals(this.d.master, s, horseId, now, emit); // REQ-HGOAL-005
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
  // ---- 出走前アドバイス pre-race coach (REQ-ADV-*, contracts/protocol.md §39): read-only, free, the same for everyone ----
  async raceAdvice(id: string, q: AdviceQuery, ruleset?: Ruleset) { return raceAdviceFor(this.d.master, await this.load(id), q, this.d.clock(), ruleset); }
  /** REQ-PRAC-002 (§50.1): the practice catalog — read-only, never saves; practice results have no server path at all. */
  async practiceCatalog(id: string, ruleset?: Ruleset) { return practiceCatalog(this.d.master, await this.load(id), this.d.clock(), ruleset); }
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

  // ---- photo mode (REQ-PHOTO-*, photoMode.ts; the images stay on the device) ----
  async photoCatalog(id: string) { return photoCatalog(this.d.master, await this.load(id)); }
  async photos(id: string) { return photosView(this.d.master, await this.load(id)); }
  /** REQ-PHOTO-010: keyed with the client's key (a retry returns the first answer, never a second record). */
  photoSave(id: string, input: PhotoInput, idemKey: string | null) {
    return this.tx(id, this.requireKey(idemKey), (s, now, emit) => savePhoto(this.d.master, s, input, now, emit));
  }
  photoDelete(id: string, photoId: string) { return this.tx(id, null, (s) => deletePhoto(this.d.master, s, photoId)); }

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
  /** REQ-TEAMFEED-006 × REQ-RPT-010: the team feed's mute is the one block list (KPI block_add / block_remove, origin team_feed). */
  feedMute(id: string, target: string, muted: boolean) {
    return this.tx(id, null, (s, _now, emit) => { setBlocked(this.d.master, s, target, muted, 'team_feed', emit); return { muted: [...ensureFeed(s).muted] }; });
  }

  // ---- 通報とブロック管理 (REQ-RPT-*, contracts/protocol.md §47) ----
  async reportOptions(id: string) { return reportOptions(this.d.master, await this.load(id), this.d.clock()); }
  /** REQ-RPT-004: the reported content copied from THIS (the target's) state; a wiped / unknown account is NOT_FOUND. */
  async reportSnapshot(id: string, content: ReportContent) {
    if (await this.wiped(id)) throw new AppError('NOT_FOUND', 'no such player');
    return reportSnapshotOf(await this.load(id), content, this.d.clock());
  }
  /** REQ-RPT-006/009/017: the reporter's daily limits, the optional block and the report_submit KPI row, in one step. */
  reportCommit(id: string, target: string, category: ReportCategory, kind: ReportContent['kind'], source: ReportSource, alsoBlock: boolean) {
    return this.tx(id, null, (s, now, emit) => {
      const r = takeReportAllowance(this.d.master, s, target, now);
      if (alsoBlock) setBlocked(this.d.master, s, target, true, 'report', emit);
      emit({ name: 'report_submit', s1: category, s2: kind, s3: source });
      return { remainingToday: r.remainingToday, blocked: isBlocking(s, target) };
    });
  }
  async blockIds(id: string) { return blockIds(await this.load(id)); }
  /** REQ-RPT-011: PUT / DELETE /v1/blocks/:playerId (idempotent; the KPI row only when the list changed). */
  blockSet(id: string, target: string, blocked: boolean, origin: BlockOrigin) {
    return this.tx(id, null, (s, _now, emit) => {
      const r = setBlocked(this.d.master, s, target, blocked, origin, emit);
      return { playerId: r.playerId, blocked: r.blocked, count: r.count, max: r.max };
    });
  }
  /** REQ-RPT-013 warn: one 「運営からのお願い」 activity entry per report (never says who reported). */
  async reportWarn(id: string, reportId: string) {
    if (await this.wiped(id)) throw new AppError('NOT_FOUND', 'no such player');
    return this.tx(id, null, (s, now) => ({ outcome: recordActivity(this.d.master, s, { kind: 'ops_notice', source: `ops_notice:${reportId}` }, now) }));
  }
  /** REQ-RPT-013 hide: the saved replay goes private, loses its title and cannot be made public again. */
  replayOpsHide(id: string, raceId: string) {
    return this.tx(id, null, (s) => {
      const rec = s.myReplays?.saved.find((x) => x.raceId === raceId);
      if (!rec) throw new AppError('NOT_FOUND', 'no such saved replay');
      const before = { public: rec.public, replayTitle: rec.replayTitle };
      rec.public = false;
      rec.replayTitle = null;
      (rec as typeof rec & { opsHidden?: boolean }).opsHidden = true;
      return { before, after: { public: false, replayTitle: null, opsHidden: true } };
    });
  }
  /** REQ-RPT-013 hide: the photo's caption is removed. */
  photoOpsHide(id: string, photoId: string) {
    return this.tx(id, null, (s) => {
      const p = s.photos?.records.find((x) => x.id === photoId);
      if (!p) throw new AppError('NOT_FOUND', 'no such photo');
      const before = { caption: p.caption };
      p.caption = null;
      return { before, after: { caption: null } };
    });
  }
  /** REQ-TEAMFEED-007: support flag on the reported player (no-op for a deleted account). */
  async feedReported(id: string, teamId: string, seq: number, reporter: string, reason: ReportReason) {
    if (await this.wiped(id)) return { flagged: false };
    return this.tx(id, null, (s) => playerReported(s, teamId, seq, reporter, reason));
  }
  /** Optional push to the owner of a race item a teammate cheered (not from muted members, not while deleting). */
  async cheerPush(id: string, fromId: string, fromName: string, ref?: string) {
    if (await this.wiped(id)) return { queued: false };
    return this.tx(id, null, (s, now) => {
      // REQ-ACT-002/006/011: the activity entry (a muted sender writes nothing; recordActivity checks the block list)
      recordActivity(this.d.master, s, { kind: 'team_cheer', source: `team_cheer:${ref ?? `${fromId}:${now}`}:${fromId}`, actor: { id: fromId, name: fromName } }, now);
      if (deletionScheduled(s) || ensureFeed(s).muted.includes(fromId)) return { queued: false };
      ensurePush(this.d.master, s);
      return { queued: enqueuePush(this.d.master, s, 'team_cheer', { name: fromName }, now).status === 'queued' };
    });
  }

  // ---- 支部の定型チャット (REQ-QCHAT-*, quickChat.ts; the posts live in the team feed) ----
  /** REQ-QCHAT-008: phrases in the locale and the values of my own state a post would accept. */
  async qchatOptions(id: string, locale: 'ja' | 'en' = 'ja') { return playerQchatOptions(this.d.master, await this.load(id), locale, this.d.clock()); }
  /** REQ-QCHAT-003/004: before a post — deletion, membership, phrase and slot checks; returns the checked values. */
  qchatCheck(id: string, phraseId: string, slots: QChatSlotInput) { return this.tx(id, null, (s, now) => playerQchatCheck(this.d.master, s, phraseId, slots ?? {}, now)); }
  /** REQ-QCHAT-011: KPI after the team stored the post / a new reaction to a post. */
  qchatNote(id: string, kind: 'post' | 'react', a: string, b: string, teamId: string, n: number) {
    return this.tx(id, null, (_s, _now, emit) => {
      if (kind === 'post') emit({ name: 'qchat_post', s1: a, s2: teamId, s3: b, count: n });
      else emit({ name: 'qchat_react', s1: a, s2: b, s3: teamId });
      return { ok: true };
    });
  }
  /**
   * REQ-QCHAT-012: a phrase named this player — one activity entry per post (collapsed while unread). Never a push. A
   * blocked sender writes nothing (recordActivity checks the one block list); nothing while deleting.
   */
  async qchatMention(id: string, fromId: string, fromName: string, ref: string) {
    if (await this.wiped(id)) return { recorded: false };
    return this.tx(id, null, (s, now) => {
      if (deletionScheduled(s)) return { recorded: false };
      const r = recordActivity(this.d.master, s, { kind: 'qchat_mention', source: `${ref}:${fromId}`, actor: { id: fromId, name: fromName } }, now);
      return { recorded: r === 'recorded' || r === 'collapsed' };
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
  async tournamentClose(id: string, tournamentId: string, rank: number, reward: Reward | null, name: string, horseId: string | null = null) {
    if (await this.wiped(id)) return { status: 'already' as const, reward: null };
    return this.tx(id, null, (s, now, emit) => {
      const done = (s.tournaments ??= {});
      if (done[tournamentId]) return { status: 'already' as const, reward: done[tournamentId]!.reward };
      // REQ-BOX-001: the prize goes to the gift box
      if (reward) giftGiver(this.d.master, s, now, emit)(reward, `tournament ${tournamentId} rank ${rank}`, `tournament:${tournamentId}:rank`, 'tournament', rank);
      done[tournamentId] = { name, rank, at: now, reward };
      recordActivity(this.d.master, s, { kind: 'tournament_result', source: `tournament:${tournamentId}`, vars: { tournament: name, n: String(rank) }, linkId: tournamentId }, now); // REQ-ACT-002
      noteTournamentResult(s, rank); // REQ-ACH-002 (once per tournament, behind the same guard)
      noteHallTournament(this.d.master, s, horseId, tournamentId, name, rank, now); // REQ-HOF-001
      noteHorseGoals(this.d.master, s, horseId, now, emit); // REQ-HGOAL-005
      if (s.roster?.tournaments) delete s.roster.tournaments[tournamentId]; // REQ-ORG-011: the entry ends with the tournament
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
