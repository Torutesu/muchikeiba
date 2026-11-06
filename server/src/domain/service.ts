import { AppError } from './errors.js';
import type { Master } from './master.js';
import { migratePlayer, moderationOf, newPlayer, playerView, type PlayerState, type PurchaseRecord } from './player.js';
import { setModeration, supportCorrectAge, supportGrant, supportResetName, supportSettleDebt, supportView, type Grant } from '../ops/support.js';
import { equipTitle, evaluateTitles, publicProfile, setDisplayName, type PublicProfile } from './stats.js';
import { closeSeason } from './season.js';
import { friendAccept, friendAccepted, friendCancel, friendDecline, friendReceive, friendRemove, friendSend, pruneInvites, receiveInvite } from './friends.js';
import type { SeasonEntry } from './leaderboard.js';
import type { Rng } from './rng.js';
import type { Clock } from './time.js';
import { seasonIdFor, rollSeason, classDef } from './season.js';
import { applyRefund, applySubscriptionStatus, applyVerifiedPurchase, checkPurchaseIntent, registerAge, type StoreVerifier, type SubscriptionStatus, type VerifiedReceipt } from './purchase.js';
import { drawGacha, exchangePity, settlePityGroups } from './gacha.js';
import { awaken, breed, breedingPreviewWithAllowance, getHorse, nameHorse, pedigree, retire } from './horses.js';
import { buyCosmetic, cosmeticsCatalog, setEquipment, useTicket, type EquipmentPatch } from './itemShop.js';
import { applyRaceResult, claimLoginBonus, claimMission, claimPass, missionsView, passLevel, type RaceResultForPlayer } from './rewards.js';
import { toRaceHorse } from './raceConfig.js';
import { paidBalanceYen, invariantsHold } from './wallet.js';
import type { PaidBalanceSnapshot } from './accounting.js';
import { jstDateKey } from './time.js';
import { enqueuePush, ensurePush, nextPushWake, pushPrefsView, registerDevice, setPushPrefs, settlePushes, takeDuePushes, unregisterDevice, type DeliveryOutcome, type DevicePlatform, type PrefsPatch } from './push.js';
import { admitClientBatch, clientToKpi, ensureKpi, isPayer, kpiRecord, type ClientBatch, type KpiEvent, type KpiRecord } from './kpi.js';

/** Collects analytics events inside a transaction; they are emitted only if the transaction is saved. */
export type Emit = (e: KpiEvent) => void;
import type { Ruleset } from './ruleset.js';
import { abortSubmit, prepareSubmit, recordResult, startTimeAttack, timeAttackView } from './timeAttack.js';
import type { VerifierOutput } from './schemas.js';
import { trackById } from './master.js';
import { appearanceOf, assetKeys, defaultSilks, validateSilks, type EntrantVisual, type Silks, effectiveSilks } from './visuals.js';
import type { LeaguePlace } from './league.js';
import { ensureTeam, playerAbortJoin, playerAddOutgoing, playerCommitJoin, playerLeft, playerPrepareJoin, playerRemoveOutgoing, playerTeamReward, snapshotOf } from './teams.js';
import { applyEventResult, cancelEntry, closeEventForPlayer, ensureEvent, enterEvent, eventsForPlayer, findEvent, type EventEntry } from './events.js';
import { bondLevels, bondView, careHorse, horseBondLevel } from './bond.js';
import { dueStudOutbox, ensureStud, nextStudWake, studAcked, studApply, studList, studPeek, studPreview, studReserve, studRetryLater, studSettle, studUnlist, studView, type StudSnapshot, type StudVisibility } from './stud.js';
import { clearRoomConditions, presetsView, setCourseLook, setRoomConditions, type RoomConditions } from './presets.js';

/** Storage for one player's state. The Durable Object implements this with SQLite; tests use memory. */
export interface PlayerRepo {
  get(id: string): PlayerState | null | Promise<PlayerState | null>;
  put(state: PlayerState): void | Promise<void>;
}

export class MemoryPlayerRepo implements PlayerRepo {
  readonly data = new Map<string, string>();
  get(id: string) {
    const j = this.data.get(id);
    return j ? (JSON.parse(j) as PlayerState) : null;
  }
  put(s: PlayerState) {
    this.data.set(s.id, JSON.stringify(s));
  }
}

export interface PlayerServiceDeps {
  master: Master;
  rng: Rng;
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
}

const standingKey = (s: PlayerState) => JSON.stringify([s.season.id, s.season.classId, s.season.points, s.season.races, Math.round(s.rating.r), s.profile.displayName, s.profile.titleId]);
const profileKey = (s: PlayerState) => JSON.stringify([s.profile.displayName, s.profile.titleId, s.season.classId, Math.round(s.rating.r), s.stats.races, s.stats.wins, s.stats.top3]);

const IDEM_KEEP = 200;
/** The object's alarm serves the push outbox and the stud fee outbox (REQ-PUSH-005, REQ-BREED-012). */
const nextWake = (s: PlayerState) => {
  const a = nextPushWake(s);
  const b = nextStudWake(s);
  return a === null ? b : b === null ? a : Math.min(a, b);
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
    if (s) return migratePlayer(s);
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
    const kpi: KpiRecord[] = [];
    const emit: Emit = (e) => { kpi.push(kpiRecord(draft, now, e)); };
    const result = fn(draft, now, emit);
    if (!invariantsHold(draft)) throw new Error('wallet invariant violated');
    if (idemKey) {
      draft.idem.push({ key: idemKey, result: JSON.parse(JSON.stringify(result ?? null)) });
      if (draft.idem.length > IDEM_KEEP) draft.idem.splice(0, draft.idem.length - IDEM_KEEP);
    }
    draft.profile.lastSeenAt = now;
    const pushProfile = this.d.onProfile && (profileKey(draft) !== profileBefore || now - draft.profile.lastPushedAt >= this.d.master.progression.social.profilePushIntervalMs);
    if (pushProfile) draft.profile.lastPushedAt = now;
    await this.repo.put(draft);
    const wake = nextWake(draft);
    if (wake !== null && wake !== wakeBefore && this.d.onPushWake) await this.d.onPushWake(wake);
    if (kpi.length > 0 && this.d.onKpi) await this.d.onKpi(id, kpi);
    if (pushProfile) await this.d.onProfile!(publicProfile(draft, this.d.master.bannedSilks));
    if (this.d.onSeasonEntry && draft.season.races > 0 && standingKey(draft) !== standingBefore) {
      await this.d.onSeasonEntry({
        playerId: id, seasonId: draft.season.id, classId: draft.season.classId, points: draft.season.points, rating: Math.round(draft.rating.r),
        races: draft.season.races, displayName: draft.profile.displayName, titleId: draft.profile.titleId, updatedAt: now,
      });
    }
    const teamId = draft.team?.teamId ?? null;
    if (this.d.onTeamPoints && teamId && (standingKey(draft) !== standingBefore || teamId !== (current.team?.teamId ?? null))) {
      await this.d.onTeamPoints({ teamId, playerId: id, seasonId: draft.season.id, points: draft.season.points, displayName: draft.profile.displayName });
    }
    if (draft.wallet.paid !== paidBefore && this.d.onPaidBalance) {
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

  async view(id: string) {
    const s = await this.load(id);
    return playerView(s, this.d.master.bannedSilks);
  }

  async state(id: string) { return this.load(id); }

  bootstrap(id: string) {
    return this.tx(id, null, (s, _now, emit) => {
      const k = ensureKpi(s);
      if (!k.firstOpenSent) { k.firstOpenSent = true; emit({ name: 'first_open' }); }
      return playerView(s, this.d.master.bannedSilks);
    });
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
      emit({ name: 'gacha_draw', s1: bannerId, count, paidCoins: r.spent.paid, freeCoins: r.spent.free, value: r.results.filter((x) => x.rarity === 'SSR').length });
      return { ...r, wallet: playerView(s).wallet };
    });
  }

  async tutorialDraw(id: string, idemKey: string | null) {
    return this.tx(id, this.requireKey(idemKey), (s, now, emit) => {
      const r = drawGacha(this.d.master, s, 'standard', 10, this.d.rng, now, { tutorialFree: true });
      emit({ name: 'tutorial_gacha', count: 10 });
      return r;
    });
  }

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
    return this.tx(id, key, (s, now) => breed(this.d.master, s, sireId, damId, this.d.rng, now, { useMaterial, ref: key }));
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
  studReserve(id: string, opId: string, borrowerId: string, horseId: string) {
    return this.tx(id, null, (s, now) => studReserve(this.d.master, s, opId, borrowerId, horseId, now));
  }
  studSettle(id: string, opId: string, ok: boolean, info: { borrowerId: string; horseId: string; fee: number; foalId: string | null }) {
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
      emit({ name: 'gacha_draw', s1: bannerId ?? itemId, s2: 'ticket', count: 1, paidCoins: 0, freeCoins: 0, value: r.result.rarity === 'SSR' ? 1 : 0 });
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
      const r = claimLoginBonus(this.d.master, s, now);
      emit({ name: 'login_bonus', value: r.day });
      return r;
    });
  }
  async missions(id: string) { return this.tx(id, null, (s, now) => missionsView(this.d.master, s, now)); }
  async claimMission(id: string, missionId: string, idemKey: string | null) { return this.tx(id, this.requireKey(idemKey), (s, now) => claimMission(this.d.master, s, missionId, now)); }
  async passView(id: string) {
    const s = await this.load(id);
    return { level: passLevel(this.d.master, s), xp: s.seasonPass.xp, active: s.seasonPass.expiresAt > this.d.clock(), expiresAt: s.seasonPass.expiresAt, claimed: s.seasonPass.claimed };
  }
  async claimPass(id: string, track: 'free' | 'premium', level: number, idemKey: string | null) {
    return this.tx(id, this.requireKey(idemKey), (s, now) => claimPass(this.d.master, s, track, level, now));
  }

  /** Called by the race room after a race is final (idempotent per race). */
  async applyRace(id: string, r: RaceResultForPlayer) {
    const out = await this.tx(id, `race:${r.raceId}`, (s, now, emit) => {
      // QA r6 #3: durable per-race guard, independent of the evictable idempotency ring
      const applied = (s.appliedRaces ??= {});
      for (const [k, at] of Object.entries(applied)) if (now - at > APPLIED_RACE_KEEP_MS) delete applied[k];
      if (applied[r.raceId] !== undefined) return { duplicate: true as const, event: null };
      applied[r.raceId] = now;
      const base = applyRaceResult(this.d.master, s, r, now);
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
      const st = s.events![ev.id]!;
      return {
        ...base,
        event: { eventId: ev.id, gained: e.gained, total: e.total, milestones: e.milestones, refunded: e.refunded,
          entry: { playerId: id, eventId: ev.id, points: st.points, races: st.races, wins: st.wins, displayName: s.profile.displayName, updatedAt: now } as EventEntry },
      };
    });
    await this.flushEventPushes(id);
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
    };
  }

  // ---- bond / stable care (REQ-BOND-*) ----
  async bond(id: string, horseId: string) { return bondView(this.d.master, await this.load(id), horseId, this.d.clock()); }
  async bondLevels(id: string) { return { levels: bondLevels(this.d.master, await this.load(id)) }; }
  async care(id: string, horseId: string, action: string, idemKey: string | null) {
    return this.tx(id, this.requireKey(idemKey), (s, now) => careHorse(this.d.master, s, horseId, action, now));
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
    return this.tx(id, null, (s) => { s.profile.silks = validateSilks(silks, s.items, undefined, this.d.master.bannedSilks); return { silks: s.profile.silks }; });
  }
  async titles(id: string) {
    const s = await this.load(id);
    return { equipped: s.profile.titleId, titles: this.d.master.titles.map((t) => ({ id: t.id, name: t.name, icon: assetKeys.title(t.id), unlocked: s.titles.includes(t.id) })) };
  }
  async stats(id: string) { return (await this.load(id)).stats; }
  async publicProfile(id: string) { return publicProfile(await this.load(id), this.d.master.bannedSilks); }

  /** REQ-SEASON-002: rollover job → reward the closed season once (idempotent via the season record). */
  closeSeason(id: string, seasonId: string, rank: number | null) {
    return this.tx(id, null, (s, now, emit) => {
      const r = closeSeason(this.d.master, s, seasonId, rank, now);
      if (r.status === 'rewarded') emit({ name: 'season_close', s1: seasonId, s2: r.classId ?? '', s3: r.nextClassId ?? '', ...(rank !== null ? { place: rank } : {}) });
      const titles = evaluateTitles(this.d.master, s); // class titles (promotion happened in rollSeason)
      return { ...r, titles };
    });
  }

  // ---- friends: per-player steps, orchestrated by FriendsService (REQ-SOCIAL-*) ----
  friendSend(id: string, toId: string) {
    return this.tx(id, null, (s, now, emit) => {
      const out = friendSend(this.d.master, s, toId, now);
      if (out === 'sent' || out === 'mutual') emit({ name: 'friend_request', s1: out });
      return out;
    });
  }
  /** REQ-PUSH-002: the receiver is notified (`fromName` comes from the public profile directory). */
  friendReceive(id: string, fromId: string, fromName?: string) {
    return this.tx(id, null, (s, now) => {
      const out = friendReceive(this.d.master, s, fromId, now);
      if (out === 'received') enqueuePush(this.d.master, s, 'friend_request', { name: fromName ?? 'フレンド' }, now);
      return out;
    });
  }
  friendAccept(id: string, fromId: string) {
    return this.tx(id, null, (s, _now, emit) => {
      const out = friendAccept(this.d.master, s, fromId);
      if (out === 'accepted') emit({ name: 'friend_accept' });
      return out;
    });
  }
  friendAccepted(id: string, byId: string, byName?: string) {
    return this.tx(id, null, (s, now) => {
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

  // ---- support / anti-cheat (admin API only; REQ-OPS-020..025, REQ-OPS-032) ----
  async adminView(id: string) { return supportView(this.d.master, await this.load(id), this.d.clock()); }
  /**
   * Admin money operations are idempotent per opKey FOREVER (review r5 #4): the general idempotency cache
   * keeps only the last IDEM_KEEP results, so their results live in a never-evicted per-player record.
   */
  private adminOnce<T>(id: string, key: string, fn: (s: PlayerState, now: number) => T): Promise<T> {
    return this.tx(id, null, (s, now) => {
      const ops = (s.adminOps ??= {});
      if (key in ops) return ops[key] as T;
      const r = fn(s, now);
      ops[key] = JSON.parse(JSON.stringify(r ?? null));
      return r;
    });
  }
  adminGrant(id: string, grant: Grant, reason: string, actor: string, opKey: string) {
    return this.adminOnce(id, `grant:${opKey}`, (s, now) => supportGrant(s, grant, reason, actor, `admin:${opKey}`, now));
  }
  adminSettleDebt(id: string, coins: number, items: Record<string, number>, reason: string, actor: string, opKey: string) {
    return this.adminOnce(id, `settle:${opKey}`, (s, now) => supportSettleDebt(s, coins, items, reason, actor, `admin:${opKey}`, now));
  }
  adminCorrectAge(id: string, birthYear: number, birthMonth: number, guardianConsent: boolean, actor: string) {
    return this.tx(id, null, (s, now) => supportCorrectAge(this.d.master, s, birthYear, birthMonth, guardianConsent, actor, now));
  }
  adminResetName(id: string, target: 'display' | 'horse', horseId: string | null) {
    return this.tx(id, null, (s) => supportResetName(this.d.master, s, target, horseId));
  }
  setModeration(id: string, status: 'ok' | 'quarantined' | 'banned', until: number | null, reason: string) {
    return this.tx(id, null, (s, now) => setModeration(s, status, until, reason, now));
  }

  // ---- push notifications (REQ-PUSH-*) ----
  registerDevice(id: string, token: string, platform: DevicePlatform) { return this.tx(id, null, (s, now) => registerDevice(this.d.master, s, token, platform, now)); }
  unregisterDevice(id: string, token: string) { return this.tx(id, null, (s) => unregisterDevice(this.d.master, s, token)); }
  async pushPreferences(id: string) { return pushPrefsView(this.d.master, await this.load(id)); }
  setPushPreferences(id: string, patch: PrefsPatch) { return this.tx(id, null, (s) => setPushPrefs(this.d.master, s, patch)); }
  /** Alarm step 1: drop expired messages and return what is due (kept in the outbox until settled). */
  pushTake(id: string) { return this.tx(id, null, (s, now) => takeDuePushes(this.d.master, s, now)); }
  /** Alarm step 2: apply send results (prune dead tokens, back off retries). */
  pushSettle(id: string, outcomes: DeliveryOutcome[]) {
    return this.tx(id, null, (s, now) => ({ ...settlePushes(this.d.master, s, outcomes, now), nextAt: nextPushWake(s) }));
  }
  /** Ops/test hook: queue a templated push for this player (same rules as event-driven pushes). */
  queuePush(id: string, templateId: string, vars: Record<string, string>) {
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
      const sessionId = [0, 0, 0].map(() => this.d.rng.nextU32().toString(36)).join('');
      return startTimeAttack(this.d.master, s, this.d.master.progression.timeAttack, trackId, horseId, sessionId, this.d.rng, now, ruleset);
    });
  }
  taPrepare(id: string, sessionId: string, inputs: unknown, resultHash: string, echoedConfig: unknown) {
    return this.tx(id, null, (s, now) => prepareSubmit(s, this.d.master.progression.timeAttack, sessionId, inputs, resultHash, echoedConfig, now));
  }
  taAbort(id: string, sessionId: string) { return this.tx(id, null, (s) => abortSubmit(s, sessionId)); }
  taRecord(id: string, sessionId: string, out: VerifierOutput, claimedHash: string) {
    return this.tx(id, null, (s, now) => recordResult(this.d.master, s, this.d.master.progression.timeAttack, sessionId, out, claimedHash, now));
  }
  async taView(id: string, trackId: string) {
    trackById(this.d.master, trackId);
    return timeAttackView(await this.load(id), this.d.master.progression.timeAttack, trackId, this.d.clock());
  }

  // ---- teams: per-player steps, orchestrated by TeamsService (REQ-TEAM-*) ----
  teamPrepareJoin(id: string, teamId: string) { return this.tx(id, null, (s, now) => playerPrepareJoin(s, teamId, now)); }
  teamCommitJoin(id: string, teamId: string) {
    return this.tx(id, null, (s, now, emit) => {
      const was = s.team?.teamId ?? null;
      const r = playerCommitJoin(s, teamId, now);
      if (was !== teamId) emit({ name: 'team_join', s1: teamId });
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
  teamSeasonReward(id: string, seasonId: string, teamId: string, rank: number | null, total: number, league: LeaguePlace | null = null) {
    return this.tx(id, null, (s, now) => playerTeamReward(s, this.d.master.progression.teams, seasonId, teamId, rank, total, now, { cfg: this.d.master.progression.league, place: league }));
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
      const ev = findEvent(this.d.master, eventId);
      const entryId = [0, 0].map(() => this.d.rng.nextU32().toString(36)).join('');
      const r = enterEvent(ev, s, getHorse(s, horseId), entryId, now);
      if (!r.existing) emit({ name: 'event_entry', s1: eventId, s2: r.fee.kind });
      return r;
    });
  }
  /** Refunds a held entry fee (queue cancelled / refused). `entryId` null = whatever is held. */
  eventCancel(id: string, eventId: string, entryId: string | null) {
    return this.tx(id, null, (s, now) => cancelEntry(s, eventId, entryId, now));
  }
  /** REQ-EVENT-008: final rank reward (event end job; idempotent). An event removed from config pays nothing. */
  eventClose(id: string, eventId: string, rank: number | null) {
    return this.tx(id, null, (s, now) => {
      const ev = this.d.master.events.find((e) => e.id === eventId);
      if (!ev) {
        const st = ensureEvent(s, eventId);
        st.closed = true;
        return { status: 'unknown_event' as const, reward: null };
      }
      return closeEventForPlayer(ev, s, rank, now, this.d.master);
    });
  }
}
