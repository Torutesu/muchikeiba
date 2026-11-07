import { z } from 'zod';
import { AppError } from '../domain/errors.js';
import type { ItemQty, Master } from '../domain/master.js';
import { defaultDisplayName, moderationOf, playerView, type PlayerState } from '../domain/player.js';
import { addItems } from '../domain/items.js';
import { grantFree, paidBalanceYen, writeOffDebt } from '../domain/wallet.js';
import { registerAge, ageBand } from '../domain/purchase.js';
import { getHorse } from '../domain/horses.js';
import { resetStableName } from '../domain/stable.js';
import type { AdminRole } from './admin.js';

/**
 * Customer-support operations on one player's state (REQ-OPS-020..025). Pure functions: the
 * PlayerService runs them inside its transaction, with an `admin:` idempotency key that clients can
 * never produce (client keys are always `c:`-prefixed).
 */
export const GRANT_LIMITS: Record<Exclude<AdminRole, 'viewer'>, { freeCoins: number; itemQty: number }> = {
  operator: { freeCoins: 10_000, itemQty: 100 },
  admin: { freeCoins: 100_000, itemQty: 1_000 },
};

export const itemIdSchema = z.string().regex(/^[a-z0-9_]{1,64}$/);
export const grantSchema = z.object({
  freeCoins: z.number().int().min(0).optional(),
  items: z.array(z.object({ itemId: itemIdSchema, qty: z.number().int().min(1) }).strict()).max(20).optional(),
}).strict().refine((g) => (g.freeCoins ?? 0) > 0 || (g.items?.length ?? 0) > 0, 'grant is empty');
export type Grant = z.infer<typeof grantSchema>;

export function checkGrantLimits(g: Grant, role: AdminRole) {
  if (role === 'viewer') throw new AppError('FORBIDDEN');
  const lim = GRANT_LIMITS[role];
  if ((g.freeCoins ?? 0) > lim.freeCoins) throw new AppError('FORBIDDEN', `freeCoins over the ${role} limit ${lim.freeCoins}`);
  for (const it of g.items ?? []) if (it.qty > lim.itemQty) throw new AppError('FORBIDDEN', `${it.itemId} qty over the ${role} limit ${lim.itemQty}`);
}

const walletOf = (s: PlayerState) => ({ paid: s.wallet.paid, free: s.wallet.free, debt: s.wallet.debt, itemDebt: s.itemDebt ?? {} });

/** Compensation grant (free coins / items only — paid coins are never created by support). */
export function supportGrant(s: PlayerState, g: Grant, reason: string, actor: string, ref: string, now: number) {
  const before = { ...walletOf(s), items: { ...s.items } };
  if (g.freeCoins) grantFree(s, g.freeCoins, now, `support grant by ${actor}: ${reason}`, ref);
  if (g.items?.length) addItems(s, g.items as ItemQty[]);
  return { before, after: { ...walletOf(s), items: { ...s.items } } };
}

/** Forgives outstanding refund debt (coins and/or items owed). */
export function supportSettleDebt(s: PlayerState, coins: number, items: Record<string, number>, reason: string, actor: string, ref: string, now: number) {
  const before = walletOf(s);
  const forgiven = writeOffDebt(s, coins, now, `${reason} (${actor})`, ref);
  const forgivenItems: Record<string, number> = {};
  for (const [itemId, qty] of Object.entries(items)) {
    const owed = s.itemDebt?.[itemId] ?? 0;
    const take = Math.min(owed, qty);
    if (take <= 0) continue;
    s.itemDebt![itemId] = owed - take;
    if (s.itemDebt![itemId] === 0) delete s.itemDebt![itemId];
    forgivenItems[itemId] = take;
  }
  if (forgiven === 0 && Object.keys(forgivenItems).length === 0) throw new AppError('CONFLICT', 'nothing to settle');
  (s.supportFlags ??= []).push(`debt_written_off:${now}`);
  return { forgiven, forgivenItems, before, after: walletOf(s) };
}

/** Age correction through support (REQ-PUR-002: the app path only allows moving to a later birth date). */
export function supportCorrectAge(m: Master, s: PlayerState, birthYear: number, birthMonth: number, guardianConsent: boolean, actor: string, now: number) {
  const before = s.age ? { ...s.age } : null;
  const band = registerAge(m, s, birthYear, birthMonth, guardianConsent, now, true);
  (s.supportFlags ??= []).push(`age_corrected:${now}:${actor}`);
  return { before, after: s.age, band: band.band.id, monthlyLimitYen: band.band.monthlyLimitYen };
}

/** Resets an offensive display name or horse name to a neutral default. */
export function supportResetName(m: Master, s: PlayerState, target: 'display' | 'horse' | 'stable', horseId: string | null) {
  if (target === 'stable') return resetStableName(s); // REQ-STABLE-007: offensive 表札
  if (target === 'display') {
    const before = s.profile.displayName;
    s.profile.displayName = defaultDisplayName(s.id);
    return { before, after: s.profile.displayName };
  }
  if (!horseId) throw new AppError('BAD_REQUEST', 'horseId required');
  const h = getHorse(s, horseId);
  const before = h.name;
  const tpl = h.templateId ? m.templateById.get(h.templateId) : undefined;
  h.name = tpl?.name ?? `ミメイ${h.id.replace(/\D/g, '').slice(-4)}`;
  h.named = false;
  return { before, after: h.name };
}

export function setModeration(s: PlayerState, status: 'ok' | 'quarantined' | 'banned', until: number | null, reason: string, now: number) {
  const before = s.moderation ?? null;
  s.moderation = { status, until, reason, at: now };
  return { before, after: s.moderation };
}

/** What support sees about a player (more than the player API; never the idempotency cache). */
export function supportView(m: Master, s: PlayerState, now: number) {
  const v = playerView(s, m.bannedSilks);
  return {
    ...v,
    createdAt: s.createdAt,
    walletDetail: { ...walletOf(s), lots: s.wallet.lots, paidBalanceYen: paidBalanceYen(s) },
    ledger: s.ledger.slice(-100),
    purchases: s.purchases,
    monthlySpendYen: s.monthlySpendYen,
    age: s.age, ageBand: s.age ? ageBand(m, s, now)?.band.id ?? null : null,
    supportFlags: s.supportFlags ?? [],
    storeSubscriptions: s.storeSubscriptions ?? {},
    moderation: { status: moderationOf(s, now), detail: s.moderation ?? null },
    friends: { count: s.friends.ids.length },
    seasonHistory: s.seasonHistory,
    // REQ-OPS-020: account deletion progress (never the confirmation token)
    deletion: s.deletion ? {
      status: s.deletion.status, requestedAt: s.deletion.requestedAt ?? null, deleteAt: s.deletion.deleteAt ?? null,
      steps: s.deletion.steps, attempts: s.deletion.attempts, retryAt: s.deletion.retryAt ?? null,
    } : null,
    // REQ-INV-*: who invited them and whom they invited (no install hashes)
    referral: s.referral ? {
      invitedBy: s.referral.invitedBy ? { playerId: s.referral.invitedBy.playerId, code: s.referral.invitedBy.code, at: s.referral.invitedBy.at, milestones: s.referral.invitedBy.milestones } : null,
      invitees: s.referral.invitees.map((x) => ({ playerId: x.playerId, at: x.at, counted: x.counted, deleted: x.deleted ?? false, milestones: x.milestones.length })),
      installs: s.referral.installs.length,
    } : null,
  };
}
