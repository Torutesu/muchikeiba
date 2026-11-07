/**
 * 友達招待 — friend invite codes (REQ-INV-001..012, contracts/protocol.md §19).
 *
 * Every player has one stable, short invite code (8 characters, no vowels and no look-alike characters, the last one a
 * check character). A new player may enter one code within their first `redeemWindowDays` game days, after the FTUE
 * (partner horse granted). The invitee gets a small welcome gift; the inviter gets nothing for the install itself, only
 * milestone rewards when the invitee reaches real engagement milestones (beginner missions done, a class), for at most
 * `maxCountedInvitees` invitees. Rewards are free coins and tickets only (never paid coins) and each one stays at or
 * below the lowest 総付景品 ceiling (¥200, see inviteRewardYen and docs/planning/03-legal-risk.md).
 *
 * A redemption touches two players and the directory, so InviteService performs idempotent per-player steps in a fixed
 * order (attempt → lookup → device claim → inviter → invitee) and compensates the inviter when the invitee step fails.
 * Milestones are detected inside the invitee's own transactions (PlayerService.tx → noteInviteMilestones) and
 * delivered to the inviter from the invitee's outbox (alarm, retried with backoff, idempotent per invitee+milestone).
 *
 * Anti-abuse: one redemption per account; one per install id ever (DirectoryDO install claims, kept anonymised after a
 * deletion); the inviter's own install ids are refused; self-invites and invite loops are refused; redeem attempts are
 * rate-limited; bursts of redemptions on one inviter, device reuse and loops raise support flags.
 */
import { deliverGift } from './giftBox.js';
import { z } from 'zod';
import { AppError } from './errors.js';
import { grantReward } from './items.js';
import type { Master, Reward } from './master.js';
import { moderationOf, type PlayerState } from './player.js';
import { cryptoRng, randInt, type Rng } from './rng.js';
import { dayRule, gameDayKey, DAY_MS } from './time.js';
import { playerDay } from './onboarding.js';
import { enqueuePush } from './push.js';
import { deletionScheduled } from './accountDeletion.js';
import { shardOf, DIRECTORY_SHARDS, type Directory } from './friends.js';
import type { KpiEvent } from './kpi.js';

// ------------------------------------------------------------------------------------------------ config

export type InviteMilestoneKind = 'beginner_complete' | 'class' | 'ranked_races';
export interface InviteMilestoneDef { id: string; kind: InviteMilestoneKind; classId?: string; target?: number; reward: Reward }
export interface InviteConfig {
  /** Game days (1 = install day) during which a new player may enter a code. */
  redeemWindowDays: number;
  /** Invitees per inviter whose milestones pay the inviter (later ones still join and become friends). */
  maxCountedInvitees: number;
  /** Days after the redemption during which the invitee's milestones count. */
  milestoneWindowDays: number;
  redeemAttemptsPerHour: number;
  redeemAttemptsPerDay: number;
  /** Redemptions of one inviter's code per game day above which a support flag is raised. */
  burstPerDay: number;
  welcomeGift: Reward;
  milestones: InviteMilestoneDef[];
  /** https fallback for the share link (placeholder domain until the real one exists). */
  shareBaseUrl: string;
  /** App deep link scheme: `<scheme>://invite/<code>`. */
  deepLinkScheme: string;
  /** Pointer to the terms section that covers invites (the app shows it next to the share button). */
  termsKey: string;
}

/**
 * Hard limits remote config can never exceed (like STUD_HARD_LIMITS). `maxRewardYen` is the 総付景品 ceiling for a
 * transaction under ¥1,000 (景品表示法 告示: ¥200), applied to every single grant even though invite rewards are not
 * tied to any purchase (conservative reading; docs/planning/03-legal-risk.md "友達招待").
 */
export const INVITE_HARD_LIMITS = { maxRewardYen: 200, maxCountedInvitees: 20, maxRedeemWindowDays: 14, maxMilestones: 5, maxMilestoneWindowDays: 180 } as const;

export const DEFAULT_INVITE_CONFIG: InviteConfig = {
  redeemWindowDays: 7, maxCountedInvitees: 10, milestoneWindowDays: 90, redeemAttemptsPerHour: 5, redeemAttemptsPerDay: 10, burstPerDay: 5,
  welcomeGift: { items: [{ itemId: 'gacha_ticket', qty: 1 }] },
  milestones: [
    // r10 merge (E2/E11): small and spread — the larger reward waits for the invitee's deeper play (class S ≥ 3 seasons)
    { id: 'im_graduate', kind: 'beginner_complete', reward: { freeCoins: 20 } },
    { id: 'im_class_a', kind: 'class', classId: 'A', reward: { freeCoins: 40 } },
    { id: 'im_class_s', kind: 'class', classId: 'S', reward: { items: [{ itemId: 'gacha_ticket', qty: 1 }] } },
  ],
  shareBaseUrl: 'https://invite.muchi-issen.example/i/', deepLinkScheme: 'muchi', termsKey: 'terms.invite',
};

export function inviteConfig(m: Master): InviteConfig | null {
  return m.progression.invite ?? null;
}
function cfgOrThrow(m: Master): InviteConfig {
  const c = inviteConfig(m);
  if (!c) throw new AppError('NOT_FOUND', 'invites are not available');
  return c;
}

/** The most a coin can cost in yen (smallest pack): every reward is valued at this price (conservative). */
export function worstYenPerCoin(m: Pick<Master, 'products'>): number {
  const coins = m.products.filter((p) => p.kind === 'coins' && p.paidCoins > 0);
  return coins.length ? Math.max(...coins.map((p) => p.priceYen / p.paidCoins)) : 0;
}

/**
 * Yen value of an invite reward (景品表示法 check): free coins and tickets at the price of the coins they replace, at
 * the worst unit price. Null = the reward contains something without a coin price (not allowed as an invite reward).
 */
export function inviteRewardYen(m: Pick<Master, 'products' | 'items' | 'gacha'>, r: Reward): number | null {
  if (r.horse || r.broodmare || r.passXp) return null;
  const yen = worstYenPerCoin(m);
  let coins = r.freeCoins ?? 0;
  for (const it of r.items ?? []) {
    const t = m.items.tickets[it.itemId];
    if (!t || t.kind === 'srPlus') return null;
    const banners = m.gacha.banners.filter((b) => t.banners.includes(b.id));
    if (!banners.length) return null;
    coins += it.qty * Math.max(...banners.map((b) => (t.kind === 'ten' ? b.priceTen : b.priceSingle)));
  }
  return Math.round(coins * yen);
}

const int = z.number().int();
const rewardSchema = z.object({
  freeCoins: int.min(0).max(10_000).optional(),
  items: z.array(z.object({ itemId: z.string().min(1).max(64), qty: int.min(1).max(10) }).strict()).max(3).optional(),
}).strict();
export const inviteConfigSchema = z.object({
  redeemWindowDays: int.min(1).max(INVITE_HARD_LIMITS.maxRedeemWindowDays),
  maxCountedInvitees: int.min(0).max(INVITE_HARD_LIMITS.maxCountedInvitees),
  milestoneWindowDays: int.min(1).max(INVITE_HARD_LIMITS.maxMilestoneWindowDays),
  redeemAttemptsPerHour: int.min(1).max(20), redeemAttemptsPerDay: int.min(1).max(50), burstPerDay: int.min(1).max(100),
  welcomeGift: rewardSchema,
  milestones: z.array(z.object({
    id: z.string().regex(/^[a-z0-9_]{1,40}$/), kind: z.enum(['beginner_complete', 'class', 'ranked_races']),
    classId: z.string().min(1).max(8).optional(), target: int.min(1).max(10_000).optional(), reward: rewardSchema,
  }).strict()).max(INVITE_HARD_LIMITS.maxMilestones),
  shareBaseUrl: z.string().regex(/^https:\/\/[a-z0-9.-]+\/[\w\-/]*$/),
  deepLinkScheme: z.string().regex(/^[a-z][a-z0-9+.-]{1,20}$/),
  termsKey: z.string().min(1).max(64),
  _note: z.string().optional(),
}).strict();

/** Boot and remote config (REQ-OPS-003): shape, references, and the legal value ceiling of every reward. */
export function inviteProblems(m: Pick<Master, 'products' | 'items' | 'gacha' | 'progression'>): string[] {
  const c = m.progression.invite;
  if (c === undefined) return [];
  const r = inviteConfigSchema.safeParse(c);
  if (!r.success) return r.error.issues.map((i) => `progression.invite.${i.path.join('.')}: ${i.message}`);
  const out: string[] = [];
  const rewards: [string, Reward][] = [['welcomeGift', c.welcomeGift], ...c.milestones.map((d, i) => [`milestones[${i}]`, d.reward] as [string, Reward])];
  for (const [path, rw] of rewards) {
    const yen = inviteRewardYen(m, rw);
    if (yen === null) out.push(`progression.invite.${path}: only free coins and single/10-pull tickets can be invite rewards`);
    else if (yen > INVITE_HARD_LIMITS.maxRewardYen) out.push(`progression.invite.${path}: worth ¥${yen}, above the ¥${INVITE_HARD_LIMITS.maxRewardYen} premium ceiling (景品表示法 総付景品)`);
  }
  if (new Set(c.milestones.map((d) => d.id)).size !== c.milestones.length) out.push('progression.invite.milestones: duplicate id');
  c.milestones.forEach((d, i) => {
    if (d.kind === 'class' && !m.progression.classes.some((x) => x.id === d.classId)) out.push(`progression.invite.milestones[${i}]: unknown class ${d.classId}`);
    if (d.kind === 'class' && m.progression.classes[0]?.id === d.classId) out.push(`progression.invite.milestones[${i}]: the starting class is not a milestone`);
    if (d.kind === 'ranked_races' && !d.target) out.push(`progression.invite.milestones[${i}]: ranked_races needs target`);
  });
  if (c.redeemAttemptsPerHour > c.redeemAttemptsPerDay) out.push('progression.invite: redeemAttemptsPerHour must not exceed redeemAttemptsPerDay');
  return out;
}

// ------------------------------------------------------------------------------------------------ codes

/** No vowels (no words), no 0/O, 1/I/L, U/V-like pairs dropped; 27 symbols. */
export const INVITE_ALPHABET = '23456789BCDFGHJKMNPQRSTVWXZ';
export const INVITE_CODE_LENGTH = 8;
/** Short letter runs that still read as something in English or romaji even without vowels. Codes containing one are skipped. */
export const INVITE_BLOCKLIST = ['FCK', 'FK', 'SHT', 'KKK', 'NGR', 'NZ', 'SX', 'XXX', 'CNT', 'DCK', 'PNS', 'WTF', 'STF', 'KS', 'SHN', 'BK', 'MNK', 'CHNK', 'TNK', 'NK', 'JP', 'GDD', 'DMN', 'HTL', 'SS', 'PP'];

const A = INVITE_ALPHABET;
function checkChar(body: string): string {
  let sum = 0;
  for (let i = 0; i < body.length; i++) sum += (A.indexOf(body[i]!) + 1) * (i + 2);
  return A[sum % A.length]!;
}

/** First character = directory shard, then 6 random characters, then the check character. Null = blocked word: draw again. */
export function makeInviteCode(shard: number, rng: Rng = cryptoRng): string | null {
  if (!Number.isInteger(shard) || shard < 0 || shard >= DIRECTORY_SHARDS) throw new AppError('CONFIG_INVALID', 'bad shard');
  let body = A[shard]!;
  for (let i = 0; i < INVITE_CODE_LENGTH - 2; i++) body += A[randInt(rng, A.length)]!;
  const code = body + checkChar(body);
  return INVITE_BLOCKLIST.some((w) => code.includes(w)) ? null : code;
}

/** Accepts lower case, spaces and dashes ("bcd2-fghj"). Null = not a well-formed code (bad symbol, length or check character). */
export function normalizeInviteCode(raw: string): string | null {
  const c = raw.toUpperCase().replace(/[\s-]/g, '');
  if (c.length !== INVITE_CODE_LENGTH || [...c].some((ch) => !A.includes(ch))) return null;
  if (checkChar(c.slice(0, -1)) !== c[c.length - 1]) return null;
  if (A.indexOf(c[0]!) >= DIRECTORY_SHARDS) return null;
  return c;
}
export const inviteShardOf = (code: string) => A.indexOf(code[0]!);
export const displayInviteCode = (code: string) => `${code.slice(0, 4)}-${code.slice(4)}`;

export function shareLinks(c: InviteConfig, code: string, inviterName: string) {
  const deepLink = `${c.deepLinkScheme}://invite/${code}`;
  const url = `${c.shareBaseUrl}${code}`;
  return {
    deepLink, url,
    // OS share sheet text (the app may append nothing else; no reward amounts in the text, see 03-legal-risk.md)
    text: `${inviterName}さんから「ムチ一閃」への招待です。招待コード ${displayInviteCode(code)} を入力すると、はじめてのプレゼントがもらえます。\n${url}`,
  };
}

// ------------------------------------------------------------------------------------------------ player state

export interface InviteeRecord {
  /** `deleted:<n>` once the invitee's account was deleted (the counted slot stays used). */
  playerId: string; at: number; counted: boolean;
  milestones: { id: string; at: number; rewarded: boolean }[];
  deleted?: boolean;
}
export interface InviteOutboxEntry { id: string; inviterId: string; milestoneId: string; at: number; nextAt: number; attempts: number }
export interface ReferralState {
  /** Install id hashes seen on this account (newest last). */
  installs: string[];
  /** Redeem attempt times (pruned to the last day). */
  attempts: number[];
  /** Set once a code was redeemed. playerId null = the inviter's account was deleted. */
  invitedBy?: { playerId: string | null; code: string; at: number; installHash: string; milestones: string[] };
  invitees: InviteeRecord[];
  outbox: InviteOutboxEntry[];
}
const INSTALLS_KEEP = 5;

export function ensureReferral(s: PlayerState): ReferralState {
  s.referral ??= { installs: [], attempts: [], invitees: [], outbox: [] };
  return s.referral;
}

function flag(s: PlayerState, f: string) {
  const list = (s.supportFlags ??= []);
  if (!list.includes(f)) list.push(f);
}

export function noteInstall(s: PlayerState, installHash: string | null) {
  if (!installHash) return;
  const r = ensureReferral(s);
  r.installs = [...r.installs.filter((x) => x !== installHash), installHash].slice(-INSTALLS_KEEP);
}

/** Why the player cannot enter a code right now (null = they can). */
export function redeemBlocker(m: Master, s: PlayerState, now: number): null | { code: 'NOT_ELIGIBLE' | 'INVITE_ALREADY_REDEEMED' | 'INVITE_WINDOW_CLOSED' | 'DELETION_PENDING'; reason: string } {
  const c = cfgOrThrow(m);
  if (s.referral?.invitedBy) return { code: 'INVITE_ALREADY_REDEEMED', reason: 'already_redeemed' };
  if (deletionScheduled(s)) return { code: 'DELETION_PENDING', reason: 'deletion' };
  if (playerDay(s, now, dayRule(m)) > c.redeemWindowDays) return { code: 'INVITE_WINDOW_CLOSED', reason: 'window_closed' };
  if (!s.flags.partnerHorseId) return { code: 'NOT_ELIGIBLE', reason: 'ftue' };
  return null;
}

/** Step 1 of a redemption: rate limit + eligibility. Never throws, so the attempt (and a flag) is saved either way. */
export function recordRedeemAttempt(m: Master, s: PlayerState, installHash: string | null, now: number): { ok: true } | { ok: false; code: string; message: string } {
  const c = cfgOrThrow(m);
  const r = ensureReferral(s);
  noteInstall(s, installHash);
  r.attempts = r.attempts.filter((t) => now - t < DAY_MS);
  const lastHour = r.attempts.filter((t) => now - t < 3_600_000).length;
  if (lastHour >= c.redeemAttemptsPerHour || r.attempts.length >= c.redeemAttemptsPerDay) {
    flag(s, `invite_rate_limited:${gameDayKey(now, dayRule(m))}`);
    return { ok: false, code: 'RATE_LIMITED', message: 'too many invite code attempts; try again later' };
  }
  r.attempts.push(now);
  const b = redeemBlocker(m, s, now);
  return b ? { ok: false, code: b.code, message: b.reason } : { ok: true };
}

export function linkFriend(m: Master, s: PlayerState, otherId: string): boolean {
  if (s.friends.ids.includes(otherId)) return true;
  if (s.friends.ids.length >= m.progression.social.maxFriends) return false;
  s.friends.ids.push(otherId);
  s.friends.incoming = s.friends.incoming.filter((x) => x.from !== otherId);
  s.friends.outgoing = s.friends.outgoing.filter((x) => x.to !== otherId);
  return true;
}

export type AcceptResult =
  | { status: 'accepted' | 'already'; counted: boolean; friended: boolean }
  | { status: 'refused'; reason: 'unavailable' | 'loop' | 'same_device' };

/** Inviter step: records the invitee (idempotent), checks loops and the device, links the friendship if there is room. */
export function inviterAccept(m: Master, s: PlayerState, inviteeId: string, installHash: string, inviteeName: string, now: number, emit: (e: KpiEvent) => void): AcceptResult {
  const c = cfgOrThrow(m);
  const r = ensureReferral(s);
  const existing = r.invitees.find((x) => x.playerId === inviteeId);
  if (existing) return { status: 'already', counted: existing.counted, friended: s.friends.ids.includes(inviteeId) };
  if (deletionScheduled(s) || moderationOf(s, now) === 'banned') return { status: 'refused', reason: 'unavailable' };
  if (r.invitedBy?.playerId === inviteeId) { flag(s, `invite_loop:${inviteeId}`); return { status: 'refused', reason: 'loop' }; }
  if (r.installs.includes(installHash)) { flag(s, `invite_same_device:${inviteeId}`); return { status: 'refused', reason: 'same_device' }; }
  const counted = r.invitees.filter((x) => x.counted).length < c.maxCountedInvitees;
  const today = gameDayKey(now, dayRule(m));
  if (r.invitees.filter((x) => gameDayKey(x.at, dayRule(m)) === today).length + 1 > c.burstPerDay) flag(s, `invite_burst:${today}`);
  r.invitees.push({ playerId: inviteeId, at: now, counted, milestones: [] });
  const friended = linkFriend(m, s, inviteeId);
  emit({ name: 'invite_redeem', s2: 'inviter', value: counted ? 1 : 0 });
  enqueuePush(m, s, 'invite_joined', { name: inviteeName }, now);
  return { status: 'accepted', counted, friended };
}

/** Compensation when the invitee step failed: the record is removed (not anonymised) and the friendship undone. */
export function inviterRevert(s: PlayerState, inviteeId: string, unfriend: boolean) {
  const r = ensureReferral(s);
  r.invitees = r.invitees.filter((x) => x.playerId !== inviteeId);
  if (unfriend) s.friends.ids = s.friends.ids.filter((x) => x !== inviteeId);
  return { ok: true };
}

/** Invitee step: records the inviter, pays the welcome gift once, links the friendship when the inviter did. */
export function inviteeCommit(m: Master, s: PlayerState, inviterId: string, code: string, installHash: string, inviterFriended: boolean, now: number, emit: (e: KpiEvent) => void) {
  const c = cfgOrThrow(m);
  const r = ensureReferral(s);
  if (r.invitedBy) {
    if (r.invitedBy.playerId === inviterId) return { status: 'already' as const, welcomeGift: c.welcomeGift, friended: s.friends.ids.includes(inviterId) };
    throw new AppError('INVITE_ALREADY_REDEEMED');
  }
  const b = redeemBlocker(m, s, now);
  if (b) throw new AppError(b.code, b.reason);
  if (r.invitees.some((x) => x.playerId === inviterId)) throw new AppError('INVITE_REFUSED', 'invite loop');
  r.invitedBy = { playerId: inviterId, code, at: now, installHash, milestones: [] };
  noteInstall(s, installHash);
  grantReward(s, c.welcomeGift, now, 'invite welcome gift', `invite:welcome:${inviterId}`, m);
  const friended = inviterFriended && linkFriend(m, s, inviterId);
  emit({ name: 'invite_redeem', s2: 'invitee', freeCoins: c.welcomeGift.freeCoins ?? 0, count: (c.welcomeGift.items ?? []).reduce((a, x) => a + x.qty, 0) });
  return { status: 'redeemed' as const, welcomeGift: c.welcomeGift, friended };
}

function classRank(m: Master, id: string) { return m.progression.classes.findIndex((x) => x.id === id); }

export function milestoneReached(m: Master, s: PlayerState, d: InviteMilestoneDef): boolean {
  switch (d.kind) {
    case 'beginner_complete': {
      const defs = m.progression.beginnerMissions ?? [];
      const claimed = s.onboarding?.claimed ?? [];
      return defs.length > 0 && defs.every((x) => claimed.includes(x.id));
    }
    case 'class': {
      const need = classRank(m, d.classId ?? '');
      if (need < 0) return false;
      return classRank(m, s.season.classId) >= need || s.seasonHistory.some((h) => classRank(m, h.nextClassId) >= need);
    }
    case 'ranked_races': return s.rating.rankedRaces >= (d.target ?? Infinity);
  }
}

/**
 * Called at the end of every invitee transaction (PlayerService.tx): newly reached milestones go to the outbox once.
 * Nothing after the milestone window, nothing once the account is being deleted, nothing when the inviter is gone.
 */
export function noteInviteMilestones(m: Master, s: PlayerState, now: number, emit: (e: KpiEvent) => void) {
  const ib = s.referral?.invitedBy;
  const c = inviteConfig(m);
  if (!ib || !ib.playerId || !c || s.deletion?.status === 'deleting') return;
  if (now - ib.at > c.milestoneWindowDays * DAY_MS) return;
  for (const d of c.milestones) {
    if (ib.milestones.includes(d.id) || !milestoneReached(m, s, d)) continue;
    ib.milestones.push(d.id);
    s.referral!.outbox.push({ id: `${s.id}:${d.id}`, inviterId: ib.playerId, milestoneId: d.id, at: now, nextAt: now, attempts: 0 });
    emit({ name: 'invite_milestone', s1: d.id, s2: 'invitee' });
  }
}

export type MilestoneDelivery = { status: 'rewarded'; reward: Reward } | { status: 'already' | 'uncounted' | 'unknown' | 'forfeited' | 'gone' };

/** Inviter side of a milestone (idempotent per invitee + milestone). Rewards only counted invitees. */
export function inviterMilestone(m: Master, s: PlayerState, inviteeId: string, milestoneId: string, inviteeName: string, now: number, emit: (e: KpiEvent) => void): MilestoneDelivery {
  const c = inviteConfig(m);
  if (s.deletion?.status === 'deleting') return { status: 'forfeited' };
  const rec = ensureReferral(s).invitees.find((x) => x.playerId === inviteeId);
  const def = c?.milestones.find((d) => d.id === milestoneId);
  if (!rec || !def) return { status: 'unknown' };
  if (rec.milestones.some((x) => x.id === milestoneId)) return { status: 'already' };
  if (!rec.counted) { rec.milestones.push({ id: milestoneId, at: now, rewarded: false }); return { status: 'uncounted' }; }
  rec.milestones.push({ id: milestoneId, at: now, rewarded: true });
  // REQ-BOX-001: the inviter was not there when it happened, so the bonus goes to the gift box
  deliverGift(m, s, { source: 'invite', ref: `invite:${inviteeId}:${milestoneId}`, reward: def.reward, note: `invite milestone ${milestoneId}` }, now, emit);
  emit({ name: 'invite_milestone', s1: milestoneId, s2: 'inviter', freeCoins: def.reward.freeCoins ?? 0, count: (def.reward.items ?? []).reduce((a, x) => a + x.qty, 0) });
  enqueuePush(m, s, 'invite_milestone', { name: inviteeName }, now);
  return { status: 'rewarded', reward: def.reward };
}

export function dueInviteOutbox(s: PlayerState, now: number) {
  const ob = s.deletion?.status === 'deleting' ? [] : s.referral?.outbox ?? [];
  return { due: ob.filter((o) => o.nextAt <= now), nextAt: ob.length ? Math.min(...ob.map((o) => o.nextAt)) : null, name: s.profile.displayName };
}
export function nextInviteWake(s: PlayerState): number | null {
  const ob = s.referral?.outbox ?? [];
  return ob.length && s.deletion?.status !== 'deleting' ? Math.min(...ob.map((o) => o.nextAt)) : null;
}
export function inviteAcked(s: PlayerState, id: string) {
  const r = ensureReferral(s);
  r.outbox = r.outbox.filter((o) => o.id !== id);
  return { ok: true };
}
export function inviteRetryLater(s: PlayerState, id: string, now: number) {
  const o = s.referral?.outbox.find((x) => x.id === id);
  if (!o) return null;
  o.attempts += 1;
  o.nextAt = now + Math.min(6 * 3_600_000, 60_000 * 2 ** Math.min(8, o.attempts));
  return o.nextAt;
}

// ---- account deletion (REQ-UXS-040 × REQ-INV-010) ----

/** Inviter side: a deleted invitee is anonymised; its counted slot stays used (deleting accounts never frees the cap). */
export function forgetInvitee(s: PlayerState, inviteeId: string) {
  const r = ensureReferral(s);
  const rec = r.invitees.find((x) => x.playerId === inviteeId);
  if (rec) { rec.playerId = `deleted:${r.invitees.indexOf(rec) + 1}`; rec.deleted = true; }
  return { ok: true };
}
/** Invitee side: the inviter was deleted; undelivered milestones for it are dropped (forfeited). */
export function forgetInviter(s: PlayerState, inviterId: string) {
  const r = ensureReferral(s);
  if (r.invitedBy?.playerId === inviterId) r.invitedBy.playerId = null;
  r.outbox = r.outbox.filter((o) => o.inviterId !== inviterId);
  return { ok: true };
}
/** The deleting player's own pending milestone deliveries are forfeited. */
export function forfeitInviteOutbox(s: PlayerState) {
  const r = ensureReferral(s);
  const n = r.outbox.length;
  r.outbox = [];
  return { forfeited: n };
}
export function inviteDeletionSnapshot(s: PlayerState) {
  const r = s.referral;
  return {
    inviterId: r?.invitedBy?.playerId ?? null,
    invitees: (r?.invitees ?? []).filter((x) => !x.deleted).map((x) => x.playerId),
    installHash: r?.invitedBy?.installHash ?? null,
  };
}

/** Read model for GET /v1/invite (names and the code are added by InviteService). */
export function inviteStateView(m: Master, s: PlayerState, now: number) {
  const c = cfgOrThrow(m);
  const r = ensureReferral(s);
  const b = redeemBlocker(m, s, now);
  const day = playerDay(s, now, dayRule(m));
  return {
    redeem: {
      eligible: b === null, reason: b?.reason ?? null, windowDays: c.redeemWindowDays, daysLeft: Math.max(0, c.redeemWindowDays - day + 1),
      invitedBy: r.invitedBy ? { playerId: r.invitedBy.playerId, at: r.invitedBy.at, milestones: r.invitedBy.milestones } : null,
      welcomeGift: c.welcomeGift,
    },
    invitees: r.invitees.map((x) => ({ ...x, milestones: x.milestones.map((y) => ({ ...y })) })),
    counted: r.invitees.filter((x) => x.counted).length,
    cap: c.maxCountedInvitees,
    milestones: c.milestones.map((d) => ({ id: d.id, kind: d.kind, classId: d.classId ?? null, target: d.target ?? null, reward: d.reward, rewardYen: inviteRewardYen(m, d.reward) })),
    termsKey: c.termsKey,
  };
}

// ------------------------------------------------------------------------------------------------ directory

/** Invite codes and install claims (DirectoryDO shards in production). */
export interface InviteDirectory {
  /** The player's invite code, created on first call (stable afterwards). */
  codeOf(playerId: string): Promise<string>;
  /** Null for unknown and retired codes. */
  lookup(code: string): Promise<string | null>;
  /** Claims an install for a redemption; returns the player that holds it (another id = this device already redeemed). */
  claimInstall(installHash: string, playerId: string): Promise<string>;
  /** Undoes a claim made by `playerId` (failed redemption). */
  releaseInstall(installHash: string, playerId: string): Promise<void>;
  /** Account deletion: the code is retired (never reused) and the claim keeps only the hash. */
  retire(playerId: string): Promise<void>;
  anonymizeInstall(installHash: string): Promise<void>;
}

export class MemoryInviteDirectory implements InviteDirectory {
  readonly codes = new Map<string, { playerId: string | null; retired: boolean }>();
  private byPlayer = new Map<string, string>();
  readonly installs = new Map<string, string | null>();
  constructor(private readonly rng: Rng = cryptoRng) {}
  async codeOf(playerId: string) {
    const have = this.byPlayer.get(playerId);
    if (have) return have;
    for (;;) {
      const c = makeInviteCode(shardOf(playerId), this.rng);
      if (!c || this.codes.has(c)) continue;
      this.codes.set(c, { playerId, retired: false });
      this.byPlayer.set(playerId, c);
      return c;
    }
  }
  async lookup(code: string) { const r = this.codes.get(code); return r && !r.retired ? r.playerId : null; }
  async claimInstall(h: string, p: string) {
    if (!this.installs.has(h)) this.installs.set(h, p);
    return this.installs.get(h) ?? '__deleted__';
  }
  async releaseInstall(h: string, p: string) { if (this.installs.get(h) === p) this.installs.delete(h); }
  async retire(p: string) {
    const c = this.byPlayer.get(p);
    if (c) { this.codes.set(c, { playerId: null, retired: true }); this.byPlayer.delete(p); }
  }
  async anonymizeInstall(h: string) { if (this.installs.has(h)) this.installs.set(h, null); }
}

/** Install ids are never stored: only a domain-separated SHA-256 prefix. */
export async function hashInstallId(installId: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`muchi-install:${installId}`));
  return [...new Uint8Array(d)].slice(0, 16).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ------------------------------------------------------------------------------------------------ orchestration

/** Per-player steps (PlayerService over Durable Object RPC in production). */
export interface InvitePlayers {
  attempt(uid: string, installHash: string): Promise<{ ok: true } | { ok: false; code: string; message: string }>;
  view(uid: string, installHash: string | null): Promise<ReturnType<typeof inviteStateView> & { displayName: string }>;
  accept(inviterId: string, inviteeId: string, installHash: string, inviteeName: string): Promise<AcceptResult>;
  revert(inviterId: string, inviteeId: string, unfriend: boolean): Promise<unknown>;
  commit(inviteeId: string, inviterId: string, code: string, installHash: string, inviterFriended: boolean): Promise<{ status: 'redeemed' | 'already'; welcomeGift: Reward; friended: boolean }>;
  flag(uid: string, flag: string): Promise<unknown>;
  unfriend(uid: string, otherId: string): Promise<unknown>;
}

export class InviteService {
  constructor(private readonly players: InvitePlayers, private readonly codes: InviteDirectory, private readonly dir: Directory, private readonly master: () => Master) {}

  private cfg() { return cfgOrThrow(this.master()); }

  /** REQ-INV-001/002/006: my code, share links, my redemption state, my invitees and the milestone table. */
  async view(uid: string, installId: string | null) {
    const c = this.cfg();
    const h = installId ? await hashInstallId(installId) : null;
    const [code, st] = await Promise.all([this.codes.codeOf(uid), this.players.view(uid, h)]);
    const ids = [...st.invitees.filter((x) => !x.deleted).map((x) => x.playerId), ...(st.redeem.invitedBy?.playerId ? [st.redeem.invitedBy.playerId] : [])];
    const names = new Map((ids.length ? await this.dir.profiles(ids).catch(() => []) : []).map((p) => [p.playerId, p.displayName]));
    const { displayName, ...rest } = st;
    return {
      code, displayCode: displayInviteCode(code), share: shareLinks(c, code, displayName),
      ...rest,
      redeem: { ...rest.redeem, invitedBy: rest.redeem.invitedBy ? { ...rest.redeem.invitedBy, displayName: rest.redeem.invitedBy.playerId ? names.get(rest.redeem.invitedBy.playerId) ?? null : null } : null },
      invitees: rest.invitees.map((x) => ({ ...x, displayName: x.deleted ? null : names.get(x.playerId) ?? null })),
    };
  }

  /**
   * Undo this attempt's device claim — unless the account HAS redeemed (a concurrent request of the same account on the
   * same device succeeded: the claim is that redemption's and must stay, or another account could reuse the device).
   * When the check itself fails the claim is kept (the same account can still retry; only other accounts are refused).
   */
  private async release(h: string, uid: string) {
    const st = await this.players.view(uid, null).catch(() => null);
    if (st && !st.redeem.invitedBy) await this.codes.releaseInstall(h, uid);
  }

  /** REQ-INV-003..005: enter a code. */
  async redeem(uid: string, rawCode: string, installId: string) {
    const h = await hashInstallId(installId);
    const a = await this.players.attempt(uid, h);
    if (!a.ok) throw new AppError(a.code as never, a.message);
    const code = normalizeInviteCode(rawCode);
    if (!code) throw new AppError('INVITE_CODE_INVALID', 'not an invite code');
    const inviter = await this.codes.lookup(code);
    if (!inviter) throw new AppError('NOT_FOUND', 'unknown invite code');
    if (inviter === uid) throw new AppError('INVITE_SELF', 'that is your own code');
    const owner = await this.codes.claimInstall(h, uid);
    if (owner !== uid) {
      await this.players.flag(uid, `invite_install_reuse:${h.slice(0, 12)}`);
      throw new AppError('INVITE_REFUSED', 'an invite code was already used on this device');
    }
    let name = '新しい騎手';
    try { name = (await this.dir.profiles([uid]))[0]?.displayName ?? name; } catch { /* default text */ }
    let acc: AcceptResult;
    try {
      acc = await this.players.accept(inviter, uid, h, name);
    } catch (e) {
      await this.release(h, uid);
      throw e;
    }
    if (acc.status === 'refused') {
      await this.release(h, uid);
      if (acc.reason === 'same_device') await this.players.flag(uid, `invite_same_device:${inviter}`);
      throw new AppError('INVITE_REFUSED', acc.reason === 'unavailable' ? 'this invite code cannot be used now' : 'this invite code cannot be used from this account');
    }
    let out: Awaited<ReturnType<InvitePlayers['commit']>>;
    try {
      out = await this.players.commit(uid, inviter, code, h, acc.friended);
    } catch (e) {
      if (acc.status === 'accepted') await this.players.revert(inviter, uid, acc.friended);
      await this.release(h, uid);
      throw e;
    }
    // r10 QA: (re)claim the device — a concurrent failed attempt of the same account may have released it meanwhile
    await this.codes.claimInstall(h, uid);
    // friend caps: the pair is linked only when both sides had room
    if (acc.friended && !out.friended) await this.players.unfriend(inviter, uid);
    let inviterName: string | null = null;
    try { inviterName = (await this.dir.profiles([inviter]))[0]?.displayName ?? null; } catch { /* optional */ }
    return { status: out.status, inviter: { playerId: inviter, displayName: inviterName }, welcomeGift: out.welcomeGift, friended: out.friended };
  }
}

/** Delivery of the invitee's milestone outbox to the inviters (alarm; idempotent on the inviter side). */
export interface InviteOutboxPorts {
  due(uid: string): Promise<ReturnType<typeof dueInviteOutbox>>;
  deliver(inviterId: string, inviteeId: string, milestoneId: string, inviteeName: string): Promise<MilestoneDelivery>;
  acked(uid: string, id: string): Promise<unknown>;
  later(uid: string, id: string): Promise<unknown>;
}
export async function deliverInviteOutbox(p: InviteOutboxPorts, uid: string) {
  const { due, name } = await p.due(uid);
  const out = { attempted: 0, delivered: 0, failed: 0 };
  for (const o of due) {
    out.attempted++;
    try {
      await p.deliver(o.inviterId, uid, o.milestoneId, name);
      await p.acked(uid, o.id);
      out.delivered++;
    } catch {
      out.failed++;
      await p.later(uid, o.id);
    }
  }
  return out;
}
