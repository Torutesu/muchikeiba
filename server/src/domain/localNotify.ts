/**
 * REQ-LNOTIF-001..020: 端末のローカル通知 (on-device local notifications, contracts/protocol.md §61).
 *
 * The device schedules reminders for times it already knows (an open training session's deadline, the next game day's
 * login bonus, the end of the weekly challenge / rival week, an event exchange closing, a gift expiring) without a
 * server round trip. Three parts live here:
 *
 *   localRemindersView(m, s, now)   the read-only digest in bootstrap / GET /v1/player (`localReminders`). No writes,
 *                                   no new state key: it reads what §45's nextActionSummary reads.
 *   planLocalNotifications(snap)    the pure plan (same snapshot → same plan). Shared with C# LocalNotificationPlanner
 *                                   through contracts/local-notifications.vectors.json. Texts in Japanese and English
 *                                   (the device language), player-typed names only with showDetails.
 *   diffLocalNotifications(...)     what to cancel / schedule against what the device scheduled last time.
 *
 * Rules: the same categories and quiet hours as push (one settings screen), one owner per event (LNOTIF_OWNERSHIP:
 * every push.json template is the server's, the six local kinds are the device's), a daily cap, real deadlines only,
 * never a shop / purchase / gacha nudge (the screen of each kind is fixed in code).
 */
import { z } from 'zod';
import type { Master, PushCategory } from './master.js';
import { PUSH_CATEGORIES } from './master.js';
import type { PlayerState } from './player.js';
import { inQuietHours, quietHoursEnd, jstHour, type QuietHours } from './push.js';
import { nextActionSummary } from './nextAction.js';
import { deletionScheduled } from './accountDeletion.js';
import { addJstDays, dayRule, gameDayKey, gameDayStartMs, jstDateKey } from './time.js';

import { LNOTIF_KINDS, LNOTIF_PERMISSION_RESULTS, type LnotifKind } from './lnotifKinds.js';

export { LNOTIF_KINDS, LNOTIF_PERMISSION_RESULTS, type LnotifKind };
export const LNOTIF_VERSION = 1 as const;
export const LNOTIF_DEADLINE_KINDS = ['weekly_challenge_closing', 'rival_week_closing', 'exchange_closing', 'gift_expiring'] as const;
export type LnotifDeadlineKind = (typeof LNOTIF_DEADLINE_KINDS)[number];
export const LNOTIF_PERMISSIONS = ['unknown', 'granted', 'provisional', 'denied'] as const;
export type LnotifPermission = (typeof LNOTIF_PERMISSIONS)[number];

/** REQ-LNOTIF-004: the push category that switches each kind (one settings screen for push and local). */
export const LNOTIF_CATEGORY: Record<LnotifKind, PushCategory> = {
  training_session: 'reminders', daily_bonus: 'reminders', weekly_challenge_closing: 'events', rival_week_closing: 'friends', exchange_closing: 'events', gift_expiring: 'gifts',
};
/** The screen a tap opens, fixed in code (never the shop, a pass purchase or a paid scout). */
export const LNOTIF_SCREEN: Record<LnotifKind, string> = {
  training_session: 'training', daily_bonus: 'home', weekly_challenge_closing: 'weekly_challenge', rival_week_closing: 'rival', exchange_closing: 'event_exchange', gift_expiring: 'gift_box',
};

/**
 * REQ-LNOTIF-002: one owner per event. The device owns these events; every push.json template belongs to the server
 * (test/local-notify.test.ts fails when a template is missing here, so a new push has to decide its owner).
 */
export const LNOTIF_OWNERSHIP = {
  local: {
    training_session: 'training_session_deadline', daily_bonus: 'login_bonus_ready', weekly_challenge_closing: 'weekly_challenge_week_end',
    rival_week_closing: 'rival_week_end', exchange_closing: 'event_exchange_close', gift_expiring: 'gift_expiry',
  } satisfies Record<LnotifKind, string>,
  server: {
    friend_request: 'friend_request', friend_accepted: 'friend_accepted', invite_joined: 'invite_joined', invite_milestone: 'invite_milestone',
    cup_invite: 'cup_invite', room_invite: 'room_invite', season_start: 'season_start', season_end: 'season_end', season_last_day: 'season_last_day',
    team_cheer: 'team_cheer', team_request: 'team_request', team_approved: 'team_approved', team_goal: 'team_goal_milestone', event_start: 'event_start',
    tournament_heat_soon: 'tournament_heat_soon', promotion_near: 'promotion_near', tournament_closing: 'tournament_entry_close',
    rival_record: 'rival_ta_record', ta_beaten: 'ta_record_beaten', lapse_3d: 'comeback_lapse', lapse_7d: 'comeback_lapse', gift_arrived: 'gift_arrived',
  } as Record<string, string>,
} as const;

// ------------------------------------------------------------------------------------------------ config (§61.7)

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MIN = 60_000;

const leadSchema = z.object(Object.fromEntries(LNOTIF_DEADLINE_KINDS.map((k) => [k, z.number().int().min(1).max(72)])) as Record<LnotifDeadlineKind, z.ZodNumber>).strict();
const configSchema = z.object({
  _note: z.string().optional(),
  enabled: z.boolean(),
  kinds: z.array(z.enum(LNOTIF_KINDS)),
  dailyCap: z.number().int().min(1).max(4),
  dailyHourJst: z.number().int().min(8).max(21),
  horizonDays: z.number().int().min(1).max(14),
  maxPending: z.number().int().min(1).max(32),
  trainingLeadMin: z.number().int().min(1).max(9),
  leadHours: leadSchema,
  prePrompt: z.object({ maxAsks: z.number().int().min(1).max(3), retryDays: z.number().int().min(1).max(90) }).strict(),
}).strict();
export type LocalNotifyConfig = z.infer<typeof configSchema>;

/** REQ-LNOTIF-019: boot and every remote-config version. */
export function localNotificationsProblems(m: Pick<Master, 'progression'>, path = 'progression.localNotifications'): string[] {
  const raw = (m.progression as { localNotifications?: unknown }).localNotifications;
  if (raw === undefined) return [];
  const r = configSchema.safeParse(raw);
  if (!r.success) return r.error.issues.map((i) => `${path}.${i.path.join('.')}: ${i.message}`);
  const c = r.data;
  const out: string[] = [];
  if (new Set(c.kinds).size !== c.kinds.length) out.push(`${path}.kinds: duplicate kind`);
  const ttl = m.progression.training?.sessionTtlMs;
  if (ttl !== undefined && c.trainingLeadMin * MIN >= ttl) out.push(`${path}.trainingLeadMin: must be shorter than progression.training.sessionTtlMs`);
  return out;
}

export function localNotifyConfig(m: Pick<Master, 'progression'>): LocalNotifyConfig | null {
  const c = (m.progression as { localNotifications?: LocalNotifyConfig }).localNotifications;
  return c && c.enabled ? c : null;
}

// ------------------------------------------------------------------------------------------------ digest (§61.3)

export interface LocalRemindersDigest {
  v: 1; enabled: true; now: number; nextDayAt: number;
  config: Omit<LocalNotifyConfig, '_note' | 'enabled'>;
  categories: Record<PushCategory, boolean>;
  quietHours: QuietHours | null;
  deleting: boolean; onboarding: boolean;
  loginBonus: { unlocked: boolean };
  training: { sessionId: string | null; horseId: string | null; expiresAt: number | null; trainedEver: boolean };
  weeklyChallenge: { unlocked: boolean; endsAt: number; uncleared: number } | null;
  rival: { weekEndsAt: number; rankedRaces: number } | null;
  exchanges: { eventId: string; points: number; closesAt: number }[];
  gifts: number[];
}
export type LocalRemindersView = LocalRemindersDigest | { v: 1; enabled: false };

/** REQ-LNOTIF-008: bootstrap / GET /v1/player `localReminders`. Reads only (GET /v1/player is not saved). */
export function localRemindersView(m: Master, s: PlayerState, now: number): LocalRemindersView {
  const c = localNotifyConfig(m);
  if (!c) return { v: LNOTIF_VERSION, enabled: false };
  const rule = dayRule(m);
  const nextDayAt = gameDayStartMs(addJstDays(gameDayKey(now, rule), 1), rule);
  const x = nextActionSummary(m, s, now);
  // read-only: the stored preferences over the master defaults (ensurePush would write a push state)
  const stored = (s as PlayerState & { push?: { prefs: { categories: Partial<Record<PushCategory, boolean>>; quietHours: QuietHours | null } } }).push?.prefs;
  const categories = Object.fromEntries(PUSH_CATEGORIES.map((k) => [k, stored?.categories[k] ?? m.push.defaults.categories[k] ?? false])) as Record<PushCategory, boolean>;
  const quietHours = stored ? stored.quietHours : m.push.defaults.quietHours;
  const open = s.training?.open && x.trainingOpenExpiresAt !== null ? s.training.open : null;
  const { _note: _n, enabled: _e, ...config } = c;
  return {
    v: LNOTIF_VERSION, enabled: true, now, nextDayAt,
    config: { ...config, kinds: [...config.kinds], leadHours: { ...config.leadHours }, prePrompt: { ...config.prePrompt } },
    categories, quietHours: quietHours ? { startHour: quietHours.startHour, endHour: quietHours.endHour } : null,
    deleting: deletionScheduled(s), onboarding: x.onboarding,
    loginBonus: { unlocked: x.unlocked.includes('login_bonus') },
    training: {
      sessionId: open?.id ?? null, horseId: open?.horseId ?? null, expiresAt: open?.expiresAt ?? null,
      trainedEver: !!open || (s.training?.total ?? 0) > 0,
    },
    weeklyChallenge: x.weeklyChallenge ? { unlocked: x.unlocked.includes('weekly_challenge'), endsAt: x.weeklyChallenge.endsAt, uncleared: x.weeklyChallenge.uncleared } : null,
    rival: x.rival ? { weekEndsAt: x.rival.weekEndsAt, rankedRaces: x.rival.rankedRaces } : null,
    exchanges: x.exchanges.map((e) => ({ eventId: e.eventId, points: e.points, closesAt: e.closesAtMs })),
    gifts: [...x.giftExpiries].sort((a, b) => a - b).slice(0, 20),
  };
}

// ------------------------------------------------------------------------------------------------ texts (§61.2)

type Lang = 'ja' | 'en';
interface KindText { title: string; body: string; detail: string; detailOne?: string }
/**
 * REQ-LNOTIF-007: both languages live with the planner (the device language picks one, not the app's). {date} = a JST
 * date and time, {time} = a JST clock, {n} = a count, {horse} = the player's horse name (only with showDetails, never
 * translated). C# LocalNotificationPlanner.Texts holds the same table (the vectors compare the rendered texts).
 */
export const LNOTIF_TEXTS: Record<LnotifKind, Record<Lang, KindText>> = {
  training_session: {
    ja: { title: '調教の仕上げ', body: '始めた調教が仕上げを待っています（{time}まで）', detail: '{horse}の調教が仕上げを待っています（{time}まで）' },
    en: { title: 'Finish your training', body: 'A training session is waiting to be finished (until {time})', detail: "{horse}'s training session is waiting to be finished (until {time})" },
  },
  daily_bonus: {
    ja: { title: 'ログインボーナス', body: '今日のログインボーナスを受け取れます', detail: '今日のログインボーナスを受け取れます' },
    en: { title: 'Login bonus', body: "Today's login bonus is ready to collect", detail: "Today's login bonus is ready to collect" },
  },
  weekly_challenge_closing: {
    ja: { title: '週替わりチャレンジ', body: '今週のチャレンジは{date}に入れ替わります', detail: '未クリアのチャレンジが{n}つあります。{date}に入れ替わります' },
    en: { title: 'Weekly challenges', body: "This week's challenges change on {date}", detail: '{n} challenges left to clear. They change on {date}', detailOne: '1 challenge left to clear. It changes on {date}' },
  },
  rival_week_closing: {
    ja: { title: 'ライバル', body: '今週のライバルの週は{date}に締まります', detail: '今週はまだランク戦を走っていません。ライバルの週は{date}に締まります' },
    en: { title: 'Rival', body: 'This rival week ends on {date}', detail: 'No ranked race yet this week. The rival week ends on {date}' },
  },
  exchange_closing: {
    ja: { title: 'イベント交換所', body: '交換所は{date}に閉まります。残ったポイントは素材になります', detail: '{n}ポイント残っています。交換所は{date}に閉まります（残りは素材になります）' },
    en: { title: 'Event exchange', body: 'The exchange closes on {date}. Leftover points become materials', detail: '{n} points left. The exchange closes on {date} (leftovers become materials)', detailOne: '1 point left. The exchange closes on {date} (leftovers become materials)' },
  },
  gift_expiring: {
    ja: { title: 'プレゼントボックス', body: '受け取り期限が{date}の品があります', detail: '受け取り期限が近い品が{n}件あります（最初は{date}）' },
    en: { title: 'Gift box', body: 'A gift box item can be collected until {date}', detail: '{n} gift box items expire soon (the first on {date})', detailOne: '1 gift box item can be collected until {date}' },
  },
};

const pad2 = (n: number) => (n < 10 ? '0' : '') + n;
const jstParts = (ms: number) => { const d = new Date(ms + 9 * HOUR); return { mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes() }; };
/** 「11月16日 4:00」 / "11/16 at 4:00" (JST). */
export function lnotifDate(ms: number, lang: Lang): string {
  const p = jstParts(ms);
  return lang === 'ja' ? `${p.mo}月${p.d}日 ${p.h}:${pad2(p.mi)}` : `${p.mo}/${p.d} at ${p.h}:${pad2(p.mi)}`;
}
/** 「21:42」 (JST, both languages). */
export const lnotifTime = (ms: number): string => { const p = jstParts(ms); return `${p.h}:${pad2(p.mi)}`; };
const fill = (t: string, v: Record<string, string>) => t.replace(/\{(\w+)\}/g, (_, k: string) => v[k] ?? '');

// ------------------------------------------------------------------------------------------------ the plan (pure, §61.2)

export interface LocalNotifySnapshot {
  now: number;
  locale: Lang;
  permission: LnotifPermission;
  /** Device setting (default off): counts, points and the training horse's name on the lock screen. */
  showDetails: boolean;
  signedIn: boolean;
  digest: LocalRemindersView | null;
  /** The device's horse names (only read with showDetails). */
  horseNames?: Record<string, string>;
}
export type LnotifDropReason = 'kind_off' | 'category_off' | 'quiet_hours' | 'past' | 'horizon' | 'daily_cap' | 'max_pending';
export interface LocalNotifyItem { id: string; kind: LnotifKind; category: PushCategory; fireAt: number; screen: string; refId: string | null; title: string; body: string }
export interface LocalNotifyPlan {
  status: 'ok' | 'no_permission' | 'off' | 'signed_out';
  items: LocalNotifyItem[];
  dropped: { id: string; kind: LnotifKind; reason: LnotifDropReason }[];
}

interface Cand { kind: LnotifKind; id: string; fireAt: number; deadline: number; refId: string | null; n: number | null; horseId: string | null; dateAt: number }

/** REQ-LNOTIF-003..007: what the device schedules for one snapshot. */
export function planLocalNotifications(x: LocalNotifySnapshot): LocalNotifyPlan {
  const d = x.digest;
  if (!x.signedIn) return { status: 'signed_out', items: [], dropped: [] };
  if (!d || !d.enabled || d.deleting || d.onboarding) return { status: 'off', items: [], dropped: [] };
  const c = d.config;
  const now = x.now;
  const cands: Cand[] = [];
  const t = d.training;
  if (t.sessionId && t.expiresAt !== null) {
    cands.push({ kind: 'training_session', id: `lnotif.training_session.${t.sessionId}`, fireAt: t.expiresAt - c.trainingLeadMin * MIN, deadline: t.expiresAt, refId: t.horseId, n: null, horseId: t.horseId, dateAt: t.expiresAt });
  }
  if (d.loginBonus.unlocked) {
    const at = d.nextDayAt + (((c.dailyHourJst - jstHour(d.nextDayAt)) % 24) + 24) % 24 * HOUR;
    cands.push({ kind: 'daily_bonus', id: `lnotif.daily_bonus.${jstDateKey(d.nextDayAt)}`, fireAt: at, deadline: d.nextDayAt + DAY, refId: null, n: null, horseId: null, dateAt: at });
  }
  const lead = (k: LnotifDeadlineKind) => c.leadHours[k] * HOUR;
  const wc = d.weeklyChallenge;
  if (wc && wc.unlocked && wc.uncleared > 0) {
    cands.push({ kind: 'weekly_challenge_closing', id: `lnotif.weekly_challenge_closing.${wc.endsAt}`, fireAt: wc.endsAt - lead('weekly_challenge_closing'), deadline: wc.endsAt, refId: null, n: wc.uncleared, horseId: null, dateAt: wc.endsAt });
  }
  const rv = d.rival;
  if (rv && rv.rankedRaces === 0) {
    cands.push({ kind: 'rival_week_closing', id: `lnotif.rival_week_closing.${rv.weekEndsAt}`, fireAt: rv.weekEndsAt - lead('rival_week_closing'), deadline: rv.weekEndsAt, refId: null, n: null, horseId: null, dateAt: rv.weekEndsAt });
  }
  for (const e of [...d.exchanges].sort((a, b) => a.closesAt - b.closesAt || (a.eventId < b.eventId ? -1 : 1))) {
    if (e.points <= 0) continue;
    cands.push({ kind: 'exchange_closing', id: `lnotif.exchange_closing.${e.eventId}`, fireAt: e.closesAt - lead('exchange_closing'), deadline: e.closesAt, refId: e.eventId, n: e.points, horseId: null, dateAt: e.closesAt });
  }
  const gifts = d.gifts.filter((g) => g > now).sort((a, b) => a - b);
  if (gifts.length > 0) {
    const first = gifts[0]!;
    cands.push({ kind: 'gift_expiring', id: `lnotif.gift_expiring.${first}`, fireAt: first - lead('gift_expiring'), deadline: first, refId: null, n: gifts.filter((g) => g <= first + DAY).length, horseId: null, dateAt: first });
  }

  const dropped: LocalNotifyPlan['dropped'] = [];
  const drop = (k: Cand, reason: LnotifDropReason) => dropped.push({ id: k.id, kind: k.kind, reason });
  const live: Cand[] = [];
  for (const k of cands) {
    if (!c.kinds.includes(k.kind)) { drop(k, 'kind_off'); continue; }
    if (!d.categories[LNOTIF_CATEGORY[k.kind]]) { drop(k, 'category_off'); continue; }
    if (inQuietHours(d.quietHours, k.fireAt)) {
      if (k.kind === 'training_session') { drop(k, 'quiet_hours'); continue; }
      const later = quietHoursEnd(d.quietHours!, k.fireAt);
      if (later > k.deadline - HOUR) { drop(k, 'quiet_hours'); continue; }
      k.fireAt = later;
    }
    if (k.fireAt <= now) { drop(k, 'past'); continue; }
    if (k.fireAt > now + c.horizonDays * DAY) { drop(k, 'horizon'); continue; }
    live.push(k);
  }
  // the daily cap per game day of the fire time (relative to the digest's next game day), highest priority first
  const prio = (k: Cand) => LNOTIF_KINDS.indexOf(k.kind);
  live.sort((a, b) => prio(a) - prio(b) || a.fireAt - b.fireAt || (a.id < b.id ? -1 : 1));
  const perDay = new Map<number, number>();
  const capped: Cand[] = [];
  for (const k of live) {
    const day = Math.floor((k.fireAt - d.nextDayAt) / DAY);
    const used = perDay.get(day) ?? 0;
    if (used >= c.dailyCap) { drop(k, 'daily_cap'); continue; }
    perDay.set(day, used + 1);
    capped.push(k);
  }
  capped.sort((a, b) => a.fireAt - b.fireAt || prio(a) - prio(b) || (a.id < b.id ? -1 : 1));
  for (const k of capped.slice(c.maxPending)) drop(k, 'max_pending');
  const items = capped.slice(0, c.maxPending).map((k) => render(k, x));
  return { status: x.permission === 'granted' || x.permission === 'provisional' ? 'ok' : 'no_permission', items, dropped };
}

function render(k: Cand, x: LocalNotifySnapshot): LocalNotifyItem {
  const lang: Lang = x.locale === 'en' ? 'en' : 'ja';
  const tx = LNOTIF_TEXTS[k.kind][lang];
  const horse = k.horseId ? x.horseNames?.[k.horseId] : undefined;
  const detail = x.showDetails && (k.kind !== 'training_session' || !!horse);
  const tpl = !detail ? tx.body : k.n === 1 && tx.detailOne ? tx.detailOne : tx.detail;
  const body = fill(tpl, { date: lnotifDate(k.dateAt, lang), time: lnotifTime(k.dateAt), n: String(k.n ?? ''), horse: horse ?? '' });
  return { id: k.id, kind: k.kind, category: LNOTIF_CATEGORY[k.kind], fireAt: k.fireAt, screen: LNOTIF_SCREEN[k.kind], refId: k.refId, title: tx.title, body };
}

// ------------------------------------------------------------------------------------------------ re-scheduling (§61.5)

export const lnotifFingerprint = (i: Pick<LocalNotifyItem, 'fireAt' | 'title' | 'body'>): string => `${i.fireAt}|${i.title}|${i.body}`;

/**
 * REQ-LNOTIF-011: the change against what the device scheduled (`id → fingerprint`). A changed time or text is a cancel
 * plus a schedule of the same id; `added` are ids that were not scheduled at all (KPI lnotif_scheduled).
 */
export function diffLocalNotifications(previous: Record<string, string>, items: readonly LocalNotifyItem[]) {
  const next = new Map(items.map((i) => [i.id, i]));
  const cancel: string[] = [];
  for (const [id, fp] of Object.entries(previous)) { const i = next.get(id); if (!i || lnotifFingerprint(i) !== fp) cancel.push(id); }
  const schedule = items.filter((i) => previous[i.id] !== lnotifFingerprint(i));
  const added = items.filter((i) => previous[i.id] === undefined).map((i) => i.id);
  return { cancel: cancel.sort(), schedule, added };
}

/** REQ-LNOTIF-004 / §61.8: the settings rows — every local kind with the category that switches it. */
export function localNotifyRows(d: LocalRemindersView | null) {
  return LNOTIF_KINDS.map((kind) => {
    const category = LNOTIF_CATEGORY[kind];
    const on = !!d && d.enabled && d.config.kinds.includes(kind) && !!d.categories[category];
    return { kind, category, on };
  });
}
