import { AppError } from './errors.js';
import type { Master } from './master.js';
import { migratePlayer, newPlayer, playerView, type PlayerState, type PurchaseRecord } from './player.js';
import { equipTitle, evaluateTitles, publicProfile, setDisplayName, type PublicProfile } from './stats.js';
import { closeSeason } from './season.js';
import { friendAccept, friendAccepted, friendCancel, friendDecline, friendReceive, friendRemove, friendSend, pruneInvites, receiveInvite } from './friends.js';
import type { SeasonEntry } from './leaderboard.js';
import type { Rng } from './rng.js';
import type { Clock } from './time.js';
import { seasonIdFor, rollSeason, classDef } from './season.js';
import { applyRefund, applySubscriptionStatus, applyVerifiedPurchase, checkPurchaseIntent, registerAge, type StoreVerifier, type SubscriptionStatus, type VerifiedReceipt } from './purchase.js';
import { drawGacha, exchangePity, settlePityGroups } from './gacha.js';
import { awaken, breed, breedingPreview, getHorse, nameHorse, pedigree, retire } from './horses.js';
import { applyRaceResult, claimLoginBonus, claimMission, claimPass, missionsView, passLevel, type RaceResultForPlayer } from './rewards.js';
import { toRaceHorse } from './raceConfig.js';
import { paidBalanceYen, invariantsHold } from './wallet.js';
import type { PaidBalanceSnapshot } from './accounting.js';
import { jstDateKey } from './time.js';
import { abortSubmit, prepareSubmit, recordResult, startTimeAttack, timeAttackView } from './timeAttack.js';
import type { VerifierOutput } from './schemas.js';
import { trackById } from './master.js';

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
}

const standingKey = (s: PlayerState) => JSON.stringify([s.season.id, s.season.classId, s.season.points, s.season.races, Math.round(s.rating.r), s.profile.displayName, s.profile.titleId]);
const profileKey = (s: PlayerState) => JSON.stringify([s.profile.displayName, s.profile.titleId, s.season.classId, Math.round(s.rating.r), s.stats.races, s.stats.wins, s.stats.top3]);

const IDEM_KEEP = 200;

/**
 * Application service for one player's data. Every mutation runs on a cloned draft and is saved only
 * if it completes (all-or-nothing, REQ-GACHA-009). Mutations with an idempotency key return the stored
 * result on retry (REQ-API-003, REQ-WAL-004).
 */
export class PlayerService {
  constructor(private readonly repo: PlayerRepo, private readonly d: PlayerServiceDeps) {}

  private async load(id: string): Promise<PlayerState> {
    const s = await this.repo.get(id);
    if (s) return migratePlayer(s);
    const now = this.d.clock();
    return newPlayer(id, now, seasonIdFor(now));
  }

  async tx<T>(id: string, idemKey: string | null, fn: (s: PlayerState, now: number) => T): Promise<T> {
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
    const result = fn(draft, now);
    if (!invariantsHold(draft)) throw new Error('wallet invariant violated');
    if (idemKey) {
      draft.idem.push({ key: idemKey, result: JSON.parse(JSON.stringify(result ?? null)) });
      if (draft.idem.length > IDEM_KEEP) draft.idem.splice(0, draft.idem.length - IDEM_KEEP);
    }
    draft.profile.lastSeenAt = now;
    const pushProfile = this.d.onProfile && (profileKey(draft) !== profileBefore || now - draft.profile.lastPushedAt >= this.d.master.progression.social.profilePushIntervalMs);
    if (pushProfile) draft.profile.lastPushedAt = now;
    await this.repo.put(draft);
    if (pushProfile) await this.d.onProfile!(publicProfile(draft));
    if (this.d.onSeasonEntry && draft.season.races > 0 && standingKey(draft) !== standingBefore) {
      await this.d.onSeasonEntry({
        playerId: id, seasonId: draft.season.id, classId: draft.season.classId, points: draft.season.points, rating: Math.round(draft.rating.r),
        races: draft.season.races, displayName: draft.profile.displayName, titleId: draft.profile.titleId, updatedAt: now,
      });
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
    return playerView(s);
  }

  async state(id: string) { return this.load(id); }

  bootstrap(id: string) { return this.tx(id, null, (s) => playerView(s)); }

  setAge(id: string, birthYear: number, birthMonth: number, guardianConsent: boolean) {
    return this.tx(id, null, (s, now) => {
      const r = registerAge(this.d.master, s, birthYear, birthMonth, guardianConsent, now);
      return { age: r.age, band: r.band.id, monthlyLimitYen: r.band.monthlyLimitYen };
    });
  }

  async purchaseIntent(id: string, productId: string) {
    const s = await this.load(id);
    return checkPurchaseIntent(this.d.master, s, productId, this.d.clock());
  }

  async purchase(id: string, platform: PurchaseRecord['platform'], productId: string, receipt: string) {
    const v = this.d.verifiers[platform];
    if (!v) throw new AppError('BAD_REQUEST', `unsupported platform ${platform}`);
    const r = await v.verify(receipt, productId, { playerId: id }); // throws RECEIPT_INVALID
    await this.claimStoreKeys(id, r);
    const out = await this.tx(id, `purchase:${r.transactionId}`, (s, now) => {
      const { record, duplicate } = applyVerifiedPurchase(this.d.master, s, platform, r, now);
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
      if (owner !== id) throw new AppError('RECEIPT_INVALID', 'this purchase is already linked to another player');
    }
  }

  /** Store server notification: a new subscription period (Apple DID_RENEW/SUBSCRIBED, Google RENEWED…). Idempotent. */
  async storeRenewal(id: string, platform: PurchaseRecord['platform'], r: VerifiedReceipt) {
    await this.claimStoreKeys(id, r);
    return this.tx(id, `purchase:${r.transactionId}`, (s, now) => {
      const { record, duplicate } = applyVerifiedPurchase(this.d.master, s, platform, r, now);
      return { record, duplicate, passExpiresAt: s.seasonPass.expiresAt };
    });
  }

  /** Store server notification: subscription status change (expired, revoked, grace…). */
  subscriptionStatus(id: string, platform: PurchaseRecord['platform'], key: string, status: SubscriptionStatus, expiresAt: number | null) {
    return this.tx(id, null, (s, now) => applySubscriptionStatus(s, platform, key, status, expiresAt, now));
  }

  refund(id: string, transactionId: string) {
    return this.tx(id, `refund:${transactionId}`, (s, now) => applyRefund(this.d.master, s, transactionId, now));
  }

  async draw(id: string, bannerId: string, count: 1 | 10, idemKey: string | null) {
    return this.tx(id, this.requireKey(idemKey), (s, now) => {
      const r = drawGacha(this.d.master, s, bannerId, count, this.d.rng, now);
      return { ...r, wallet: playerView(s).wallet };
    });
  }

  async tutorialDraw(id: string, idemKey: string | null) {
    return this.tx(id, this.requireKey(idemKey), (s, now) => drawGacha(this.d.master, s, 'standard', 10, this.d.rng, now, { tutorialFree: true }));
  }

  async pityExchange(id: string, bannerId: string, templateId: string, idemKey: string | null) {
    return this.tx(id, this.requireKey(idemKey), (s, now) => exchangePity(this.d.master, s, bannerId, templateId, now));
  }

  nameHorse(id: string, horseId: string, name: string) { return this.tx(id, null, (s) => nameHorse(this.d.master, s, horseId, name)); }
  async awaken(id: string, horseId: string, idemKey: string | null) { return this.tx(id, this.requireKey(idemKey), (s) => awaken(this.d.master, s, horseId)); }
  retire(id: string, horseId: string) { return this.tx(id, null, (s) => retire(s, horseId)); }

  async breedingPreview(id: string, sireId: string, damId: string) {
    return breedingPreview(this.d.master, await this.load(id), sireId, damId);
  }
  async breed(id: string, sireId: string, damId: string, idemKey: string | null) {
    return this.tx(id, this.requireKey(idemKey), (s, now) => breed(this.d.master, s, sireId, damId, this.d.rng, now));
  }
  async pedigree(id: string, horseId: string) { return pedigree(await this.load(id), horseId); }

  async claimLogin(id: string, idemKey: string | null) { return this.tx(id, this.requireKey(idemKey), (s, now) => claimLoginBonus(this.d.master, s, now)); }
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
  applyRace(id: string, r: RaceResultForPlayer) {
    return this.tx(id, `race:${r.raceId}`, (s, now) => applyRaceResult(this.d.master, s, r, now));
  }

  /** Snapshot used by the matchmaker: horse for the race, rating, class cap, beginner flag. */
  async raceEntry(id: string, horseId: string) {
    const s = await this.load(id);
    const h = getHorse(s, horseId);
    if (h.status !== 'active') throw new AppError('HORSE_NOT_ACTIVE');
    const cls = classDef(this.d.master, s.season.classId);
    return {
      playerId: id, horse: toRaceHorse(this.d.master, h),
      rating: { r: s.rating.r, rd: s.rating.rd, vol: s.rating.vol },
      classId: cls.id, statCap: cls.statCap, beginner: s.rating.rankedRaces < this.d.master.progression.beginnerRaces,
    };
  }

  // ---- profile, titles, stats (REQ-STAT-*, REQ-TITLE-*, REQ-SOCIAL-006) ----
  setDisplayName(id: string, name: string) { return this.tx(id, null, (s) => setDisplayName(this.d.master, s, name)); }
  equipTitle(id: string, titleId: string | null) { return this.tx(id, null, (s) => equipTitle(this.d.master, s, titleId)); }
  async titles(id: string) {
    const s = await this.load(id);
    return { equipped: s.profile.titleId, titles: this.d.master.titles.map((t) => ({ id: t.id, name: t.name, unlocked: s.titles.includes(t.id) })) };
  }
  async stats(id: string) { return (await this.load(id)).stats; }
  async publicProfile(id: string) { return publicProfile(await this.load(id)); }

  /** REQ-SEASON-002: rollover job → reward the closed season once (idempotent via the season record). */
  closeSeason(id: string, seasonId: string, rank: number | null) {
    return this.tx(id, null, (s, now) => {
      const r = closeSeason(this.d.master, s, seasonId, rank, now);
      const titles = evaluateTitles(this.d.master, s); // class titles (promotion happened in rollSeason)
      return { ...r, titles };
    });
  }

  // ---- friends: per-player steps, orchestrated by FriendsService (REQ-SOCIAL-*) ----
  friendSend(id: string, toId: string) { return this.tx(id, null, (s, now) => friendSend(this.d.master, s, toId, now)); }
  friendReceive(id: string, fromId: string) { return this.tx(id, null, (s, now) => friendReceive(this.d.master, s, fromId, now)); }
  friendAccept(id: string, fromId: string) { return this.tx(id, null, (s) => friendAccept(this.d.master, s, fromId)); }
  friendAccepted(id: string, byId: string) { return this.tx(id, null, (s) => friendAccepted(s, byId)); }
  friendDecline(id: string, fromId: string) { return this.tx(id, null, (s) => friendDecline(s, fromId)); }
  friendCancel(id: string, toId: string) { return this.tx(id, null, (s) => friendCancel(s, toId)); }
  friendRemove(id: string, otherId: string) { return this.tx(id, null, (s) => friendRemove(s, otherId)); }
  friendInvite(id: string, fromId: string, passphrase: string) { return this.tx(id, null, (s, now) => receiveInvite(this.d.master, s, fromId, passphrase, now)); }
  async friendsState(id: string) {
    const s = await this.load(id);
    pruneInvites(this.d.master, s, this.d.clock());
    return { ids: s.friends.ids, incoming: s.friends.incoming, outgoing: s.friends.outgoing, invites: s.friends.invites };
  }

  // ---- time attack (REQ-TA-*) ----
  /** Issue a session. The id is random (crypto in production) and doubles as the race id suffix. */
  taStart(id: string, trackId: string, horseId: string) {
    return this.tx(id, null, (s, now) => {
      const sessionId = [0, 0, 0].map(() => this.d.rng.nextU32().toString(36)).join('');
      return startTimeAttack(this.d.master, s, this.d.master.progression.timeAttack, trackId, horseId, sessionId, this.d.rng, now);
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
}
