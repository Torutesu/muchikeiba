/**
 * Opt-in rewarded video ads (REQ-AD-001..012, contracts/protocol.md §21, docs/planning/06 §5.1 T8).
 *
 * Monetises non-payers without touching payers or fairness:
 * - never forced, never interstitial: the player taps an offer card; nothing is shown during the FTUE, on the install
 *   game day, during races / matching (client rule, RewardedAdModel), to players under `minAge` (known age), and — by
 *   default — not to players who paid in the last `payerQuietDays` days unless they opt in (`prefs: 'on'`);
 * - rewards are FREE currency only (資金決済法: free coins are never paid coins) or a time attack attempt; no ranked
 *   stat, no gacha odds, no paid-only item. Reward texts are built here as fixed amounts (「無償コイン10枚」) — never a
 *   multiplier (「倍」), never 「お得」/「今だけ」 (validated, like the shop texts in shop.ts);
 * - a reward is granted ONLY by the ad network's server-side verification callback (SSV, src/ads/ssv.ts checks the
 *   signature), never by the client. The callback is tied to a session this object issued to this player
 *   (custom_data = session id, user_id = player id), idempotent by the network transaction id, inside a clock-skew
 *   window and the session's lifetime, and within the per-placement and global daily caps (game day, REQ-DAY-001).
 *   Rejected callbacks are recorded (KPI `ad_reject`) and many of them in one day raise a support flag.
 *
 * Idempotency across players is not needed: the signature covers user_id, so a replayed callback can only ever reach
 * the same player's object, which remembers the transaction ids it has seen.
 */
import { z } from 'zod';
import { AppError } from './errors.js';
import type { Master } from './master.js';
import type { PlayerState } from './player.js';
import { dayRule, gameDayIndex, gameDayKey, sameGameDay, ageAt, DAY_MS } from './time.js';
import { grantFree } from './wallet.js';
import { taState } from './timeAttack.js';
import type { Rng } from './rng.js';

export type AdSurface = 'home' | 'result' | 'time_attack' | 'shop';
export const AD_SURFACES: AdSurface[] = ['home', 'result', 'time_attack', 'shop'];
/** What one rewarded view gives. Free coins only (never paid), or extra time attack attempts today. */
export interface AdRewardDef { freeCoins?: number; taAttempts?: number }
export interface AdPlacement {
  id: string;
  /** Where the client may show the offer card (RewardedAdModel enforces it; result = only after a top-3 finish). */
  surface: AdSurface;
  /** Card title (validated wording). The reward text is generated from `reward`. */
  title: string;
  /** Rewarded views per game day. */
  dailyCap: number;
  reward: AdRewardDef;
  /** Key of the ad unit id in the server env ADS_AD_UNITS / the app's build settings (never the id itself). */
  adUnitKey: string;
}
export interface AdsConfig {
  enabled: boolean;
  network: 'admob';
  /** Rewarded views per game day over all placements. */
  globalDailyCap: number;
  /** Sessions (ad starts) a player may open per game day (rate limit; a session that never completes still counts). */
  startsPerDay: number;
  /** Open sessions at a time (older open ones beyond this are refused). */
  maxOpenSessions: number;
  /** How long a session accepts its callback after it was opened. */
  sessionTtlMs: number;
  /** |server now − callback timestamp| accepted. */
  maxClockSkewMs: number;
  /** FTUE gate: ranked races before the first offer. */
  minRankedRaces: number;
  /** First game day (1 = install day) with offers: 2 = never in the first session / install day. */
  minGameDay: number;
  /** A real paid purchase in the last N days hides offers unless the player opted in (prefs 'on'). */
  payerQuietDays: number;
  /** A registered age below this never sees an ad. */
  minAge: number;
  /** Rejected callbacks in one game day that add a support flag. */
  anomalyFlagAt: number;
  placements: AdPlacement[];
}

/** Code-side ceilings: a remote config can lower values but never go past these (economy E13, balance-targets 4.9). */
export const ADS_HARD_LIMITS = {
  globalDailyCap: 6, placementDailyCap: 3, freeCoinsPerView: 20, freeCoinsPerDay: 40, taAttemptsPerView: 1,
  startsPerDay: 30, maxOpenSessions: 5, sessionTtlMs: 2 * 3_600_000, maxClockSkewMs: 3_600_000, minAgeAtLeast: 13, payerQuietDaysMax: 90,
} as const;
/** Words never used in an ad offer (景品表示法: no multipliers, no fake urgency or reference prices). */
export const AD_BANNED_WORDS = ['倍', 'お得', '今だけ', '残りわずか', '通常価格', '無料ガチャ', '確定', '%OFF', 'x2', '×2'];

const placementSchema = z.object({
  id: z.string().regex(/^[a-z0-9_]{1,32}$/), surface: z.enum(['home', 'result', 'time_attack', 'shop']), title: z.string().min(1).max(40),
  dailyCap: z.number().int().min(1), reward: z.object({ freeCoins: z.number().int().min(1).optional(), taAttempts: z.number().int().min(1).optional() }).strict(),
  adUnitKey: z.string().regex(/^[A-Z0-9_]{1,40}$/),
}).strict();
export const adsConfigSchema = z.object({
  _note: z.string().optional(),
  enabled: z.boolean(), network: z.literal('admob'), globalDailyCap: z.number().int().min(0), startsPerDay: z.number().int().min(1),
  maxOpenSessions: z.number().int().min(1), sessionTtlMs: z.number().int().min(60_000), maxClockSkewMs: z.number().int().min(10_000),
  minRankedRaces: z.number().int().min(1), minGameDay: z.number().int().min(2), payerQuietDays: z.number().int().min(0),
  minAge: z.number().int(), anomalyFlagAt: z.number().int().min(1), placements: z.array(placementSchema).max(8),
}).strict();

const coinsOf = (p: AdPlacement) => (p.reward.freeCoins ?? 0) * p.dailyCap;

/** The most free coins a player can get from ads in one game day under the caps (greedy over the best placements). */
export function maxAdCoinsPerDay(c: AdsConfig): number {
  let left = c.globalDailyCap, coins = 0;
  for (const p of [...c.placements].sort((a, b) => (b.reward.freeCoins ?? 0) - (a.reward.freeCoins ?? 0))) {
    const n = Math.min(left, p.dailyCap);
    coins += n * (p.reward.freeCoins ?? 0);
    left -= n;
  }
  return coins;
}

/** REQ-AD-002: validation (boot and every remote-config version carrying progression.ads). */
export function adsProblems(raw: unknown, path = 'progression.ads'): string[] {
  if (raw === undefined) return [];
  const r = adsConfigSchema.safeParse(raw);
  if (!r.success) return r.error.issues.map((i) => `${path}.${i.path.join('.')}: ${i.message}`);
  const c = r.data as AdsConfig;
  const H = ADS_HARD_LIMITS;
  const out: string[] = [];
  if (c.globalDailyCap > H.globalDailyCap) out.push(`${path}.globalDailyCap: at most ${H.globalDailyCap}`);
  if (c.startsPerDay > H.startsPerDay) out.push(`${path}.startsPerDay: at most ${H.startsPerDay}`);
  if (c.startsPerDay < c.globalDailyCap) out.push(`${path}.startsPerDay: must be ≥ globalDailyCap`);
  if (c.maxOpenSessions > H.maxOpenSessions) out.push(`${path}.maxOpenSessions: at most ${H.maxOpenSessions}`);
  if (c.sessionTtlMs > H.sessionTtlMs) out.push(`${path}.sessionTtlMs: at most ${H.sessionTtlMs}`);
  if (c.maxClockSkewMs > H.maxClockSkewMs) out.push(`${path}.maxClockSkewMs: at most ${H.maxClockSkewMs}`);
  if (c.minAge < H.minAgeAtLeast) out.push(`${path}.minAge: at least ${H.minAgeAtLeast}`);
  if (c.payerQuietDays > H.payerQuietDaysMax) out.push(`${path}.payerQuietDays: at most ${H.payerQuietDaysMax}`);
  const ids = new Set<string>();
  c.placements.forEach((p, i) => {
    const at = `${path}.placements[${i}]`;
    if (ids.has(p.id)) out.push(`${at}.id: duplicate ${p.id}`);
    ids.add(p.id);
    const kinds = (p.reward.freeCoins ? 1 : 0) + (p.reward.taAttempts ? 1 : 0);
    if (kinds !== 1) out.push(`${at}.reward: exactly one of freeCoins / taAttempts`);
    if (p.dailyCap > H.placementDailyCap) out.push(`${at}.dailyCap: at most ${H.placementDailyCap}`);
    if ((p.reward.freeCoins ?? 0) > H.freeCoinsPerView) out.push(`${at}.reward.freeCoins: at most ${H.freeCoinsPerView}`);
    if ((p.reward.taAttempts ?? 0) > H.taAttemptsPerView) out.push(`${at}.reward.taAttempts: at most ${H.taAttemptsPerView}`);
    for (const w of AD_BANNED_WORDS) if (p.title.includes(w)) out.push(`${at}.title: must not contain 「${w}」`);
  });
  if (maxAdCoinsPerDay(c) > H.freeCoinsPerDay) out.push(`${path}: up to ${maxAdCoinsPerDay(c)} free coins a day from ads (at most ${H.freeCoinsPerDay})`);
  return out;
}

// ------------------------------------------------------------------------------------------- player state

export type AdPref = 'auto' | 'on' | 'off';
export type AdSessionStatus = 'open' | 'rewarded' | 'rejected' | 'expired';
export type AdRejectReason =
  | 'user_mismatch' | 'unknown_session' | 'session_used' | 'expired' | 'clock_skew' | 'ad_unit_mismatch' | 'cap' | 'deleting';
export interface AdSession {
  id: string; placementId: string; createdAt: number; expiresAt: number; status: AdSessionStatus;
  txId?: string; at?: number; reason?: AdRejectReason; reward?: AdRewardDef;
}
export interface AdsState {
  pref: AdPref;
  /** Game day of `counts`/`total`/`starts`/`rejects`. */
  day: string;
  counts: Record<string, number>;
  total: number;
  starts: number;
  rejects: number;
  sessions: AdSession[];
  /** Network transaction ids already handled (rewarded or rejected), newest last. */
  txIds: string[];
}
export const AD_SESSIONS_KEEP = 20;
export const AD_TX_KEEP = 200;

export function ensureAds(s: PlayerState): AdsState {
  s.ads ??= { pref: 'auto', day: '', counts: {}, total: 0, starts: 0, rejects: 0, sessions: [], txIds: [] };
  return s.ads;
}

const cfgOf = (m: Master): AdsConfig | null => (m.progression.ads as AdsConfig | undefined) ?? null;

function rollDay(m: Master, a: AdsState, now: number) {
  const today = gameDayKey(now, dayRule(m));
  if (!sameGameDay(a.day, today)) { a.day = today; a.counts = {}; a.total = 0; a.starts = 0; a.rejects = 0; }
}

function expireSessions(a: AdsState, now: number) {
  for (const x of a.sessions) if (x.status === 'open' && now > x.expiresAt) x.status = 'expired';
}

/** REQ-AD-001 (03 資金決済法): only real money counts as paying (sandbox / ¥0 / refunded purchases do not). */
function lastPaidAt(s: PlayerState): number | null {
  const paid = s.purchases.filter((p) => !p.refunded && p.priceYen > 0 && !p.sandbox).map((p) => p.at);
  return paid.length ? Math.max(...paid) : null;
}

export type AdIneligible = 'disabled' | 'opted_out' | 'deleting' | 'ftue' | 'first_day' | 'age' | 'payer_quiet' | 'moderation';

/** Why offers are hidden for this player now (null = offers may be shown). */
export function adIneligibility(m: Master, s: PlayerState, now: number): AdIneligible | null {
  const c = cfgOf(m);
  if (!c || !c.enabled || c.placements.length === 0) return 'disabled';
  const a = s.ads;
  if (a?.pref === 'off') return 'opted_out';
  if (s.deletion?.status === 'scheduled' || s.deletion?.status === 'deleting') return 'deleting';
  if (s.moderation && s.moderation.status === 'banned') return 'moderation';
  if (s.rating.rankedRaces < c.minRankedRaces) return 'ftue';
  const day = gameDayIndex(now, dayRule(m)) - gameDayIndex(s.createdAt, dayRule(m)) + 1;
  if (day < c.minGameDay) return 'first_day';
  if (s.age && ageAt(s.age.birthYear, s.age.birthMonth, now) < c.minAge) return 'age';
  const paidAt = lastPaidAt(s);
  if (a?.pref !== 'on' && paidAt !== null && now - paidAt < c.payerQuietDays * DAY_MS) return 'payer_quiet';
  return null;
}

/** REQ-AD-004: the reward text is generated (fixed amounts, never 「倍」). */
export function adRewardLabel(r: AdRewardDef): string {
  if (r.freeCoins) return `無償コイン${r.freeCoins}枚`;
  if (r.taAttempts) return `タイムアタック${r.taAttempts}回`;
  return '';
}

/**
 * Ad request hints for the native SDK (REQ-AD-009): no personalised ads unless the player is a registered adult
 * (unknown age → non-personalised), and the "under the age of consent" tag for registered players under 16.
 */
export function adRequestHints(s: PlayerState, now: number) {
  const age = s.age ? ageAt(s.age.birthYear, s.age.birthMonth, now) : null;
  return { nonPersonalized: age === null || age < 18, underAgeOfConsent: age !== null && age < 16, ageKnown: age !== null };
}

/** GET /v1/ads: the offer cards, today's counts and why ads are hidden (REQ-AD-003). Read-only (no state written). */
export function adsView(m: Master, s0: PlayerState, now: number) {
  const s = structuredClone(s0);
  const a = ensureAds(s);
  rollDay(m, a, now);
  expireSessions(a, now);
  const c = cfgOf(m);
  const reason = adIneligibility(m, s, now);
  const paidAt = lastPaidAt(s);
  const globalCap = c?.globalDailyCap ?? 0;
  const globalLeft = Math.max(0, globalCap - a.total);
  const startsLeft = Math.max(0, (c?.startsPerDay ?? 0) - a.starts);
  return {
    enabled: !!c?.enabled,
    eligible: reason === null,
    reason,
    pref: a.pref,
    payerQuietUntil: c && paidAt !== null && now - paidAt < c.payerQuietDays * DAY_MS ? paidAt + c.payerQuietDays * DAY_MS : null,
    day: a.day,
    globalCap, globalUsed: a.total, globalLeft, startsLeft,
    network: c?.network ?? null,
    placements: (c?.placements ?? []).map((p) => {
      const used = a.counts[p.id] ?? 0;
      const left = Math.max(0, Math.min(p.dailyCap - used, globalLeft));
      return {
        id: p.id, surface: p.surface, title: p.title, rewardLabel: adRewardLabel(p.reward), reward: { ...p.reward },
        dailyCap: p.dailyCap, used, left, adUnitKey: p.adUnitKey, available: reason === null && left > 0 && startsLeft > 0,
      };
    }),
    adRequest: adRequestHints(s, now),
    open: a.sessions.filter((x) => x.status === 'open').map((x) => ({ sessionId: x.id, placementId: x.placementId, expiresAt: x.expiresAt })),
  };
}

export function setAdPref(s: PlayerState, pref: AdPref) {
  ensureAds(s).pref = pref;
}

/**
 * REQ-AD-005: open a session for one rewarded view (the client then shows the ad with custom_data = sessionId and
 * user_id = player id). Nothing is granted here.
 */
export function startAd(m: Master, s: PlayerState, placementId: string, rng: Rng, now: number) {
  const c = cfgOf(m);
  const reason = adIneligibility(m, s, now);
  if (reason) throw new AppError(reason === 'deleting' ? 'DELETION_PENDING' : 'NOT_ELIGIBLE', `ads: ${reason}`);
  const p = c!.placements.find((x) => x.id === placementId);
  if (!p) throw new AppError('NOT_FOUND', `placement ${placementId}`);
  const a = ensureAds(s);
  rollDay(m, a, now);
  expireSessions(a, now);
  if ((a.counts[p.id] ?? 0) >= p.dailyCap || a.total >= c!.globalDailyCap) throw new AppError('AD_LIMIT_REACHED', `${p.id}: today's views are used up`);
  if (a.starts >= c!.startsPerDay) throw new AppError('RATE_LIMITED', 'ads: too many starts today');
  if (a.sessions.filter((x) => x.status === 'open').length >= c!.maxOpenSessions) throw new AppError('RATE_LIMITED', 'ads: too many open sessions');
  const id = 'ad_' + [rng.nextU32(), rng.nextU32()].map((x) => x.toString(16).padStart(8, '0')).join('');
  a.starts += 1;
  const sess: AdSession = { id, placementId: p.id, createdAt: now, expiresAt: now + c!.sessionTtlMs, status: 'open' };
  a.sessions.push(sess);
  if (a.sessions.length > AD_SESSIONS_KEEP) {
    // drop the oldest finished ones first
    const drop = a.sessions.length - AD_SESSIONS_KEEP;
    const finished = a.sessions.filter((x) => x.status !== 'open').slice(0, drop).map((x) => x.id);
    a.sessions = a.sessions.filter((x) => !finished.includes(x.id));
  }
  return {
    sessionId: id, placementId: p.id, network: c!.network, adUnitKey: p.adUnitKey, customData: id, userId: s.id,
    expiresAt: sess.expiresAt, rewardLabel: adRewardLabel(p.reward), adRequest: adRequestHints(s, now),
  };
}

/** A verified SSV callback (src/ads/ssv.ts checked the signature and the key). */
export interface AdCallback {
  network: 'admob';
  transactionId: string;
  userId: string;
  customData: string;
  /** Ad unit id as sent by the network. */
  adUnit: string;
  /** Key of that ad unit (ADS_AD_UNITS reverse lookup). undefined = no map configured (dev); null = unknown unit. */
  adUnitKey?: string | null;
  timestamp: number;
  rewardAmount: number;
  rewardItem: string;
}

export type AdRewardResult =
  | { status: 'rewarded'; sessionId: string; placementId: string; reward: AdRewardDef; rewardLabel: string }
  | { status: 'duplicate'; transactionId: string }
  | { status: 'rejected'; reason: AdRejectReason; sessionId: string | null };

type KpiEmit = (e: { name: string; s1?: string; s2?: string; s3?: string; freeCoins?: number; count?: number; value?: number }) => void;

/**
 * REQ-AD-006/007: apply one verified callback. Always completes (rejections are saved, never thrown), so the network
 * gets a 2xx and does not retry; the same transaction id again returns `duplicate`.
 */
export function applyAdCallback(m: Master, s: PlayerState, cb: AdCallback, now: number, emit: KpiEmit): AdRewardResult {
  const c = cfgOf(m);
  const a = ensureAds(s);
  rollDay(m, a, now);
  expireSessions(a, now);
  if (a.txIds.includes(cb.transactionId)) return { status: 'duplicate', transactionId: cb.transactionId };
  a.txIds.push(cb.transactionId);
  if (a.txIds.length > AD_TX_KEEP) a.txIds.splice(0, a.txIds.length - AD_TX_KEEP);
  const sess = a.sessions.find((x) => x.id === cb.customData) ?? null;
  const reject = (reason: AdRejectReason): AdRewardResult => {
    if (sess && sess.status === 'open') { sess.status = 'rejected'; sess.reason = reason; sess.txId = cb.transactionId; sess.at = now; }
    a.rejects += 1;
    emit({ name: 'ad_reject', s1: reason, s2: sess?.placementId ?? '', s3: cb.network, count: a.rejects });
    const flag = `ads_anomaly:${a.day}`;
    if (c && a.rejects >= c.anomalyFlagAt && !(s.supportFlags ?? []).includes(flag)) (s.supportFlags ??= []).push(flag);
    return { status: 'rejected', reason, sessionId: sess?.id ?? null };
  };
  if (cb.userId !== s.id) return reject('user_mismatch');
  if (!sess) return reject('unknown_session');
  if (sess.status !== 'open') return reject(sess.status === 'expired' ? 'expired' : 'session_used');
  if (!c) return reject('cap');
  if (Math.abs(now - cb.timestamp) > c.maxClockSkewMs || cb.timestamp < sess.createdAt - c.maxClockSkewMs) return reject('clock_skew');
  const p = c.placements.find((x) => x.id === sess.placementId);
  if (!p) return reject('unknown_session');
  if (cb.adUnitKey !== undefined && cb.adUnitKey !== p.adUnitKey) return reject('ad_unit_mismatch');
  if (s.deletion?.status === 'scheduled' || s.deletion?.status === 'deleting') return reject('deleting');
  if ((a.counts[p.id] ?? 0) >= p.dailyCap || a.total >= c.globalDailyCap) return reject('cap');
  // grant: free coins only (資金決済法), or time attack attempts for today
  if (p.reward.freeCoins) grantFree(s, p.reward.freeCoins, now, `rewarded ad ${p.id}`, `ad:${cb.network}:${cb.transactionId}`);
  if (p.reward.taAttempts) {
    const st = taState(s);
    const today = gameDayKey(now, dayRule(m));
    if (!sameGameDay(st.daily.date, today)) st.daily = { date: today, count: 0 };
    st.daily.bonus = (st.daily.bonus ?? 0) + p.reward.taAttempts;
  }
  a.counts[p.id] = (a.counts[p.id] ?? 0) + 1;
  a.total += 1;
  Object.assign(sess, { status: 'rewarded' as const, txId: cb.transactionId, at: now, reward: { ...p.reward } });
  emit({ name: 'ad_reward', s1: p.id, s2: cb.network, s3: p.surface, freeCoins: p.reward.freeCoins ?? 0, value: p.reward.taAttempts ?? 0, count: a.total });
  return { status: 'rewarded', sessionId: sess.id, placementId: p.id, reward: { ...p.reward }, rewardLabel: adRewardLabel(p.reward) };
}

/** GET /v1/ads/sessions/:id — the client polls this after the ad closed (the reward arrives by SSV, usually in seconds). */
export function adSessionView(m: Master, s0: PlayerState, sessionId: string, now: number) {
  const s = structuredClone(s0);
  const a = ensureAds(s);
  expireSessions(a, now);
  const x = a.sessions.find((q) => q.id === sessionId);
  if (!x) throw new AppError('NOT_FOUND', `ad session ${sessionId}`);
  return {
    sessionId: x.id, placementId: x.placementId, status: x.status, expiresAt: x.expiresAt,
    reward: x.reward ?? null, rewardLabel: x.reward ? adRewardLabel(x.reward) : null, reason: x.reason ?? null,
    wallet: { paid: s.wallet.paid, free: s.wallet.free, total: s.wallet.paid + s.wallet.free, debt: s.wallet.debt },
  };
}

export { coinsOf as adPlacementDailyCoins };
