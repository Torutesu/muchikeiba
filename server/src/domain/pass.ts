/**
 * Season pass per season (REQ-UXS-019..021, spec 06 §5.2 / §6.9).
 *
 * - A pass is bought for one season (= JST calendar month) and ends with it: no auto-renew, no carry-over.
 *   The purchase covers the season that is current when the store purchase is granted (a purchase made in
 *   the last minutes of a month and delivered after it ended covers the new month in full).
 * - Pass+ adds `pass.levels` levels of XP at purchase (once per season even if bought twice).
 * - At the season close (rollSeason, which runs inside the first transaction of the new month — the rollover
 *   job's closeSeason, or the player's own next request), every reached level that was not claimed is granted
 *   automatically: the free track always, the premium track when the pass was active at the season end.
 *   The grant and the reset of the pass happen in the same transaction, so it can never run twice.
 * - A refund takes back what the refunded pass gave (premium-track rewards, the Pass+ levels and the
 *   free-track rewards that only those levels unlocked); shortfalls become debt / item debt (REQ-PUR-006).
 */
import type { Master, Product, Reward } from './master.js';
import type { PlayerState, PurchaseRecord } from './player.js';
import type { PassSeasonRecord } from './shop.js';
import { grantReward, clawbackItems } from './items.js';
import { clawbackFree } from './wallet.js';
import { DAY_MS, jstMonthEndMs, jstMonthKey } from './time.js';

export const PASS_HISTORY_KEEP = 12;
export type PassTrack = 'free' | 'premium';

export const levelOf = (m: Master, xp: number) => Math.min(m.progression.passMaxLevel, Math.floor(Math.max(0, xp) / m.progression.passXpPerLevel));
export const seasonEndMs = (seasonId: string) => jstMonthEndMs(seasonId);

const productOf = (m: Master, id: string): Product | undefined => m.products.find((p) => p.id === id);
const boostLevelsOf = (m: Master, rec: PurchaseRecord) => productOf(m, rec.productId)?.pass?.levels ?? 0;

/** Non-refunded per-season pass purchases covering `seasonId`. */
export function passPurchasesFor(s: PlayerState, seasonId: string): PurchaseRecord[] {
  return s.purchases.filter((x) => !x.refunded && x.passSeasonId === seasonId);
}

/** REQ-UXS-020: what the purchase confirmation shows (remaining days only matter in the last 7 days). */
export function passPurchaseInfo(m: Master, p: Product, now: number) {
  const seasonId = jstMonthKey(now);
  const endsAt = seasonEndMs(seasonId);
  const remainingDays = Math.max(0, Math.ceil((endsAt - now) / DAY_MS));
  return { seasonId, endsAt, remainingDays, lastWeek: remainingDays <= 7, autoRenew: false as const, levels: p.pass?.levels ?? 0 };
}

/**
 * REQ-UXS-020: grant a verified per-season pass purchase (called from applyVerifiedPurchase before the
 * record is stored). Returns the period it paid for. A second pass for the same season (the app skipped the
 * intent check) is still credited but changes nothing about the entitlement; support is flagged.
 */
export function grantSeasonPass(m: Master, s: PlayerState, p: Product, txId: string, now: number): { passUntil: number; passSeasonId: string } {
  const seasonId = jstMonthKey(now);
  const passUntil = seasonEndMs(seasonId);
  const owned = passPurchasesFor(s, seasonId);
  if (owned.length > 0) (s.supportFlags ??= []).push(`pass_duplicate:${seasonId}:${txId}`);
  s.seasonPass.expiresAt = Math.max(s.seasonPass.expiresAt, passUntil);
  const levels = p.pass?.levels ?? 0;
  if (levels > 0 && !owned.some((x) => boostLevelsOf(m, x) > 0) && s.seasonPass.seasonId === seasonId) {
    const xp = levels * m.progression.passXpPerLevel;
    s.seasonPass.xp += xp;
    s.seasonPass.boostXp = (s.seasonPass.boostXp ?? 0) + xp;
  }
  return { passUntil, passSeasonId: seasonId };
}

/** Free coins of a pass reward count as "from a purchase" (stud hold, REQ-UXS-018/021) on the record that unlocked it. */
function attribute(m: Master, s: PlayerState, seasonId: string, track: PassTrack, level: number, reward: Reward, xp: number, boostXp: number) {
  const coins = reward.freeCoins ?? 0;
  if (coins <= 0) return;
  const recs = passPurchasesFor(s, seasonId);
  const naturalLevel = levelOf(m, xp - boostXp);
  const rec = track === 'premium' ? recs[0] : level > naturalLevel ? recs.find((x) => boostLevelsOf(m, x) > 0) : undefined;
  if (rec) rec.linkedFree = (rec.linkedFree ?? 0) + coins;
}

/** Called after a manual claim (rewards.claimPass). */
export function notePassClaim(m: Master, s: PlayerState, track: PassTrack, level: number, reward: Reward) {
  attribute(m, s, s.seasonPass.seasonId, track, level, reward, s.seasonPass.xp, s.seasonPass.boostXp ?? 0);
}

/**
 * REQ-UXS-021: close the pass of the season that is ending (called by rollSeason before the reset).
 * Grants every reached, unclaimed level and records the season in passHistory. Never fails on an empty pass.
 */
export function closePassSeason(m: Master, s: PlayerState, now: number): PassSeasonRecord | null {
  const sp = s.seasonPass;
  const seasonId = sp.seasonId ?? s.season.id;
  if ((s.passHistory ?? []).some((h) => h.seasonId === seasonId)) return null;
  const level = levelOf(m, sp.xp);
  const premium = sp.expiresAt >= seasonEndMs(seasonId);
  if (level === 0 && !premium) return null;
  const granted = { free: [...sp.claimed.free], premium: [...sp.claimed.premium] };
  const autoGranted: { free: number[]; premium: number[] } = { free: [], premium: [] };
  const coins = { free: 0, premium: 0 };
  for (const track of ['free', 'premium'] as const) {
    if (track === 'premium' && !premium) continue;
    const def = m.progression.passRewards[track];
    for (let lv = def.every; lv <= level; lv += def.every) {
      if (granted[track].includes(lv)) continue;
      grantReward(s, def.reward, now, `pass ${track} ${lv} (auto, season ${seasonId} closed)`, `passclose:${seasonId}:${track}:${lv}`);
      attribute(m, s, seasonId, track, lv, def.reward, sp.xp, sp.boostXp ?? 0);
      granted[track].push(lv);
      autoGranted[track].push(lv);
      coins[track] += def.reward.freeCoins ?? 0;
    }
  }
  const rec: PassSeasonRecord = { seasonId, xp: sp.xp, level, premium, boostXp: sp.boostXp ?? 0, granted, autoGranted, autoFreeCoins: coins.free + coins.premium, at: now };
  s.passHistory ??= [];
  s.passHistory.push(rec);
  if (s.passHistory.length > PASS_HISTORY_KEEP) s.passHistory.splice(0, s.passHistory.length - PASS_HISTORY_KEEP);
  return rec;
}

function clawbackReward(s: PlayerState, r: Reward, now: number, ref: string, acc: { freeCoins: number; items: Record<string, number>; owedItems: Record<string, number> }) {
  if (r.freeCoins) {
    clawbackFree(s, r.freeCoins, now, ref);
    acc.freeCoins += r.freeCoins;
  }
  if (r.items) {
    for (const it of r.items) acc.items[it.itemId] = (acc.items[it.itemId] ?? 0) + it.qty;
    for (const [k, v] of Object.entries(clawbackItems(s, r.items))) acc.owedItems[k] = (acc.owedItems[k] ?? 0) + v;
  }
}

/**
 * REQ-PUR-006 for a per-season pass (called from applyRefund after the record was marked refunded):
 * premium-track rewards of that season are taken back unless another pass still covers it; for Pass+, the
 * boost XP is removed (current season) and the free/premium levels above the remaining level are taken back.
 * Levels taken back in the current season can be earned and claimed again.
 */
export function refundSeasonPass(m: Master, s: PlayerState, rec: PurchaseRecord, now: number) {
  const acc = { freeCoins: 0, items: {} as Record<string, number>, owedItems: {} as Record<string, number> };
  const seasonId = rec.passSeasonId;
  if (!seasonId) return acc;
  const others = passPurchasesFor(s, seasonId);
  const premiumStill = others.length > 0;
  const boost = boostLevelsOf(m, rec) > 0 && !others.some((x) => boostLevelsOf(m, x) > 0) ? boostLevelsOf(m, rec) * m.progression.passXpPerLevel : 0;
  let granted: { free: number[]; premium: number[] };
  let newLevel: number;
  if (s.seasonPass.seasonId === seasonId) {
    const removed = Math.min(boost, s.seasonPass.boostXp ?? 0);
    s.seasonPass.xp = Math.max(0, s.seasonPass.xp - removed);
    s.seasonPass.boostXp = (s.seasonPass.boostXp ?? 0) - removed;
    newLevel = levelOf(m, s.seasonPass.xp);
    granted = s.seasonPass.claimed;
  } else {
    const h = (s.passHistory ?? []).find((x) => x.seasonId === seasonId);
    if (!h) return acc;
    const removed = Math.min(boost, h.boostXp);
    h.xp = Math.max(0, h.xp - removed);
    h.boostXp -= removed;
    h.level = levelOf(m, h.xp);
    if (!premiumStill) h.premium = false;
    newLevel = h.level;
    granted = h.granted;
  }
  for (const track of ['free', 'premium'] as const) {
    const take = granted[track].filter((lv) => lv > newLevel || (track === 'premium' && !premiumStill));
    for (const lv of take) clawbackReward(s, m.progression.passRewards[track].reward, now, `refund:${rec.txId}:pass:${track}:${lv}`, acc);
    granted[track] = granted[track].filter((lv) => !take.includes(lv));
  }
  return acc;
}

/** REQ-UXS-020: the season pass screen (values only from the server; spec 06 §6.9). */
export function passScreen(m: Master, s: PlayerState, now: number) {
  const sp = s.seasonPass;
  const level = levelOf(m, sp.xp);
  const endsAt = seasonEndMs(sp.seasonId);
  const remainingDays = Math.max(0, Math.ceil((endsAt - now) / DAY_MS));
  const per = m.progression.passXpPerLevel;
  const max = m.progression.passMaxLevel;
  const owned = passPurchasesFor(s, sp.seasonId);
  const hist = s.passHistory ?? [];
  const last = hist[hist.length - 1] ?? null;
  return {
    seasonId: sp.seasonId, level, xp: sp.xp, xpPerLevel: per, maxLevel: max,
    xpToNextLevel: level >= max ? 0 : (level + 1) * per - sp.xp,
    racesToNextLevel: level >= max ? 0 : Math.ceil(((level + 1) * per - sp.xp) / m.progression.passXpPerRace),
    active: sp.expiresAt > now, expiresAt: sp.expiresAt,
    seasonEndsAt: endsAt, remainingDays, lastWeek: remainingDays <= 7, autoRenew: false,
    boostLevels: Math.floor((sp.boostXp ?? 0) / per),
    owned: owned.map((x) => x.productId),
    purchasable: owned.length === 0 ? m.products.filter((p) => p.kind === 'season_pass' && p.storeType !== 'auto_renewing').map((p) => p.id) : [],
    claimed: sp.claimed,
    rewards: m.progression.passRewards,
    autoGrantAtSeasonEnd: true,
    lastSeason: last && last.seasonId !== sp.seasonId ? last : null,
  };
}
