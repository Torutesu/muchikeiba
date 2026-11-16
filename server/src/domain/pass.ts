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
import type { CosmeticDef, Master, Product, Reward } from './master.js';
import type { PlayerState, PurchaseRecord } from './player.js';
import type { PassSeasonRecord } from './shop.js';
import { grantReward, clawbackItems } from './items.js';
import { clawbackFree } from './wallet.js';
import { dayRule, gameDaysUntil, jstMonthEndMs, jstMonthKey } from './time.js';
import { itemPurpose } from './receipt.js';

export const PASS_HISTORY_KEEP = 12;
export type PassTrack = 'free' | 'premium';

export const levelOf = (m: Master, xp: number) => Math.min(m.progression.passMaxLevel, Math.floor(Math.max(0, xp) / m.progression.passXpPerLevel));
export const seasonEndMs = (seasonId: string) => jstMonthEndMs(seasonId);

// ------------------------------------------------------------------ the two lines, tier by tier (quality pass 3)

/** The levels of a line that pay something (every `every`-th level up to the max). */
export function passLineLevels(m: Pick<Master, 'progression'>, track: PassTrack): number[] {
  const def = m.progression.passRewards[track];
  const out: number[] = [];
  if (!(def.every >= 1)) return out; // a bad config never loops
  for (let lv = def.every; lv <= m.progression.passMaxLevel; lv += def.every) out.push(lv);
  return out;
}

/** What a level of a line pays: the tier's own reward when `tiers` names it, else the line's reward (null = nothing). */
export function passRewardAt(m: Pick<Master, 'progression'>, track: PassTrack, level: number): Reward | null {
  const def = m.progression.passRewards[track];
  if (!(def.every >= 1) || !Number.isInteger(level) || level < 1 || level % def.every !== 0) return null;
  return def.tiers?.[String(level)] ?? def.reward;
}

/** Every tier of a line added up (coins and items; quality pass 2 showed it, pass 3 keeps it equal across the restructure). */
export function passLineTotal(m: Pick<Master, 'progression'>, track: PassTrack): Reward {
  let coins = 0;
  const items = new Map<string, number>();
  for (const lv of passLineLevels(m, track)) {
    const r = passRewardAt(m, track, lv)!;
    coins += r.freeCoins ?? 0;
    for (const it of r.items ?? []) items.set(it.itemId, (items.get(it.itemId) ?? 0) + it.qty);
  }
  return { ...(coins ? { freeCoins: coins } : {}), ...(items.size ? { items: [...items].map(([itemId, qty]) => ({ itemId, qty })) } : {}) };
}

/** How a looks-only cosmetic is drawn on the player's own silks (the pass screen's preview): which editor part it unlocks. */
export type PassLook = { part: 'pattern' | 'color' | 'sleeve' | 'cap'; ref: string } | { part: 'tack'; slot: string; asset: string };
function lookOf(c: CosmeticDef): PassLook | null {
  if (c.kind === 'silks') return { part: 'pattern', ref: c.pattern };
  if (c.kind === 'silks_part') return { part: c.part, ref: c.ref };
  if (c.kind === 'tack') return { part: 'tack', slot: c.slot, asset: c.asset };
  return null;
}

/** A standout tier: a level whose reward carries a looks-only cosmetic (the "I want that" of the line). */
export interface PassStandoutDef { track: PassTrack; level: number; itemId: string; look: PassLook }
export function passStandouts(m: Pick<Master, 'progression' | 'items'>): PassStandoutDef[] {
  const out: PassStandoutDef[] = [];
  for (const track of ['premium', 'free'] as const) {
    for (const lv of passLineLevels(m, track)) {
      for (const it of passRewardAt(m, track, lv)?.items ?? []) {
        const c = m.items.cosmetics.find((x) => x.id === it.itemId);
        const look = c ? lookOf(c) : null;
        if (look) out.push({ track, level: lv, itemId: it.itemId, look });
      }
    }
  }
  return out.sort((a, b) => a.level - b.level || (a.track === b.track ? 0 : a.track === 'premium' ? -1 : 1));
}

/** The standout tier of a line at a level, if any (where a pass-reward cosmetic says it comes from). */
export function standoutSource(m: Pick<Master, 'progression' | 'items'>, itemId: string): PassStandoutDef | null {
  return passStandouts(m).find((x) => x.itemId === itemId) ?? null;
}

/**
 * Quality pass 3 (docs/quality/pass.md): the shape rules of the pass lines, on every config version. Tier keys are reward
 * levels of their line; tier rewards hold only free coins and known items (never horses, broodmares or pass XP); a cosmetic
 * on a tier is not for sale anywhere else (it is what makes the tier stand out — selling it would make the tier a coupon)
 * and never paid-only; the free line never holds a cosmetic the premium line also holds (paid and free stay apart).
 */
export function passRewardsProblems(m: Pick<Master, 'progression' | 'items'>, knownItems: Set<string>): string[] {
  const out: string[] = [];
  const pr = m.progression.passRewards;
  if (!pr) return out;
  const owners = new Map<string, PassTrack>();
  for (const track of ['free', 'premium'] as const) {
    const def = pr[track];
    if (!def) { out.push(`passRewards.${track}: missing`); continue; }
    for (const [k, r] of Object.entries(def.tiers ?? {})) {
      const lv = Number(k);
      const path = `passRewards.${track}.tiers.${k}`;
      if (!Number.isInteger(lv) || String(lv) !== k || lv < 1 || lv > m.progression.passMaxLevel) { out.push(`${path}: the key must be a level 1..${m.progression.passMaxLevel}`); continue; }
      if (lv % def.every !== 0) out.push(`${path}: level ${lv} is not a reward level of the line (every ${def.every})`);
      if (!r || typeof r !== 'object') { out.push(`${path}: must be a reward`); continue; }
      for (const key of Object.keys(r)) if (key !== 'freeCoins' && key !== 'items') out.push(`${path}: ${key} is not allowed on a pass tier (free coins and items only)`);
      if (r.freeCoins !== undefined && !(Number.isInteger(r.freeCoins) && r.freeCoins >= 0)) out.push(`${path}.freeCoins: a non-negative integer`);
      for (const it of r.items ?? []) {
        if (!knownItems.has(it.itemId)) out.push(`${path}: unknown item ${it.itemId}`);
        if (!Number.isInteger(it.qty) || it.qty < 1) out.push(`${path}: item qty must be a positive integer`);
        const c = m.items.cosmetics.find((x) => x.id === it.itemId);
        if (!c) continue;
        if (!c.notForSale) out.push(`${path}: cosmetic ${it.itemId} is sold in the shop; a standout tier holds a not-for-sale cosmetic`);
        if (c.currency === 'paidOnly') out.push(`${path}: cosmetic ${it.itemId} is paid-only`);
        if (it.qty !== 1) out.push(`${path}: a cosmetic comes once (qty 1)`);
        const prev = owners.get(it.itemId);
        if (prev && prev !== track) out.push(`${path}: cosmetic ${it.itemId} is on both the free and the premium line`);
        owners.set(it.itemId, track);
      }
    }
  }
  return out;
}

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
  const remainingDays = gameDaysUntil(endsAt, now, dayRule(m));
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
  if (sp.forfeitedAt !== undefined) return null; // REQ-UXS-040: given up by an account deletion
  if ((s.passHistory ?? []).some((h) => h.seasonId === seasonId)) return null;
  const level = levelOf(m, sp.xp);
  const premium = sp.expiresAt >= seasonEndMs(seasonId);
  if (level === 0 && !premium) return null;
  const granted = { free: [...sp.claimed.free], premium: [...sp.claimed.premium] };
  const autoGranted: { free: number[]; premium: number[] } = { free: [], premium: [] };
  const coins = { free: 0, premium: 0 };
  for (const track of ['free', 'premium'] as const) {
    if (track === 'premium' && !premium) continue;
    for (const lv of passLineLevels(m, track)) {
      if (lv > level) break;
      if (granted[track].includes(lv)) continue;
      const reward = passRewardAt(m, track, lv)!;
      grantReward(s, reward, now, `pass ${track} ${lv} (auto, season ${seasonId} closed)`, `passclose:${seasonId}:${track}:${lv}`);
      attribute(m, s, seasonId, track, lv, reward, sp.xp, sp.boostXp ?? 0);
      granted[track].push(lv);
      autoGranted[track].push(lv);
      coins[track] += reward.freeCoins ?? 0;
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
    for (const lv of take) { const r = passRewardAt(m, track, lv); if (r) clawbackReward(s, r, now, `refund:${rec.txId}:pass:${track}:${lv}`, acc); }
    granted[track] = granted[track].filter((lv) => !take.includes(lv));
  }
  return acc;
}

/** REQ-UXS-020: the season pass screen (values only from the server; spec 06 §6.9). */
export function passScreen(m: Master, s: PlayerState, now: number) {
  const sp = s.seasonPass;
  const level = levelOf(m, sp.xp);
  const endsAt = seasonEndMs(sp.seasonId);
  const remainingDays = gameDaysUntil(endsAt, now, dayRule(m));
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
    rewards: { free: m.progression.passRewards.free, premium: m.progression.passRewards.premium },
    autoGrantAtSeasonEnd: true,
    lastSeason: last && last.seasonId !== sp.seasonId ? last : null,
    ...passStandoutView(m, s, now),
  };
}

const PASS_ITEM_LABEL = (m: Master, id: string) => m.shopDisplay?.itemLabels[id] ?? m.items.cosmetics.find((c) => c.id === id)?.name ?? id;

/**
 * Quality pass 3 (docs/quality/pass.md): the standout tiers of the season pass screen (additive fields of GET /v1/season-pass).
 * Each standout says what it is (server label + what it does), how it is drawn on the player's own silks (`look`), whether
 * the player already owns it, and how far it is (levels, races at passXpPerRace — the same count as racesToNextLevel).
 * `nextStandout` is the next one not reached yet on the premium line (the free line's when the premium line has none left),
 * so the screen can always say what the next peak is.
 */
export function passStandoutView(m: Master, s: PlayerState, now: number) {
  const sp = s.seasonPass;
  const level = levelOf(m, sp.xp);
  const per = m.progression.passXpPerLevel;
  const premiumOpen = sp.expiresAt > now;
  const standouts = passStandouts(m).map((d) => {
    const reached = d.level <= level;
    const claimed = sp.claimed[d.track].includes(d.level);
    const levelsAway = Math.max(0, d.level - level);
    const xpAway = reached ? 0 : d.level * per - sp.xp;
    return {
      track: d.track, level: d.level, itemId: d.itemId, label: PASS_ITEM_LABEL(m, d.itemId), purpose: itemPurpose(m, d.itemId), look: d.look,
      reward: passRewardAt(m, d.track, d.level)!,
      owned: (s.items[d.itemId] ?? 0) > 0, reached, claimed,
      claimable: reached && !claimed && sp.forfeitedAt === undefined && (d.track === 'free' || premiumOpen),
      levelsAway, racesAway: reached ? 0 : Math.ceil(xpAway / m.progression.passXpPerRace),
    };
  });
  const ahead = standouts.filter((x) => !x.reached);
  const next = ahead.find((x) => x.track === 'premium') ?? ahead.find((x) => x.track === 'free') ?? null;
  return {
    standouts,
    nextStandout: next ? { track: next.track, level: next.level, itemId: next.itemId, label: next.label, levelsAway: next.levelsAway, racesAway: next.racesAway } : null,
    totals: { free: passLineTotal(m, 'free'), premium: passLineTotal(m, 'premium') },
  };
}

/** What the season pass still holds for the player: this season's purchase and the levels not yet paid out. */
export function passRemaining(m: Master, s: PlayerState, now: number) {
  const sp = s.seasonPass;
  const level = levelOf(m, sp.xp);
  const premium = sp.expiresAt > now;
  const unclaimed = (track: 'free' | 'premium') => (track === 'premium' && !premium ? 0 : Array.from({ length: level }, (_, i) => i + 1).filter((l) => !sp.claimed[track].includes(l)).length);
  return { seasonId: sp.seasonId, premium, level, unclaimedFree: unclaimed('free'), unclaimedPremium: unclaimed('premium') };
}

/**
 * REQ-UXS-040: the account deletion gives up the season pass: the premium line ends now and nothing more is
 * granted (no automatic grant at the season close). Returns what was given up for the retained record.
 */
export function forfeitPass(m: Master, s: PlayerState, now: number) {
  const r = passRemaining(m, s, now);
  const sp = s.seasonPass;
  sp.expiresAt = Math.min(sp.expiresAt, now);
  // the season close grants nothing to a deleted account. `claimed` keeps what was really paid out: a refund that
  // arrives before the wipe takes back exactly that (marking every level claimed made it claw back 30 levels).
  sp.forfeitedAt = now;
  return r;
}
