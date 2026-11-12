/**
 * ディープリンク・招待リンク (REQ-LINK-001..013/020..022, contracts/protocol.md §63): the pure rules — configuration, the token
 * format (random, carries the owner's directory shard), parsing of URLs / scheme links / typed tokens, link URLs, expiry,
 * the screen and maintenance group of each type, the share text and the static web fallback page.
 * The orchestration (directory, player objects, the targets) is linkService.ts; the rematch is rematch.ts.
 *
 * A token is never logged and never put into KPI rows. URLs never carry a player id or any other personal data.
 */
import { z } from 'zod';
import type { Master } from './master.js';
import type { MaintenanceGroup } from './maintenance.js';
import { shardOf } from './friends.js';
import { AppError } from './errors.js';

// ------------------------------------------------------------------------------------------------ types

export const LINK_TYPES = ['room', 'cup', 'replay', 'invite', 'friend', 'team', 'help'] as const;
export type LinkType = typeof LINK_TYPES[number];

/** REQ-LINK-005: the screen a resolved link opens (the client maps it, DeepLinkRoutes). */
export const LINK_SCREENS: Record<LinkType, string> = {
  room: 'friend_room_join', cup: 'cup_join', replay: 'friend_replay', invite: 'invite_redeem', friend: 'friend_request', team: 'team_view', help: 'help_article',
};
/** REQ-LINK-009: the §46 maintenance group of each target (null = never closed: the help center is exempt). */
export const LINK_GROUPS: Record<LinkType, MaintenanceGroup | null> = {
  room: 'ranked', cup: 'cups', replay: 'social', invite: 'social', friend: 'social', team: 'teams', help: null,
};

export const LINK_STATES = ['ok', 'unavailable', 'friends_only', 'maintenance', 'update_required'] as const;
export type LinkState = typeof LINK_STATES[number];

// ------------------------------------------------------------------------------------------------ configuration

export interface LinksConfig {
  enabled: boolean;
  /** https origin of the universal / app links (a placeholder until the production domain exists). */
  baseUrl: string;
  appScheme: string;
  createsPerDay: number;
  roomMinutes: number;
  cupDaysMax: number;
  defaultDays: number;
  resolvesPerHour: number;
  failuresPerHour: number;
  lockMinutes: number;
  /** REQ-LINK-009: types that need a newer app (`update_required`). */
  minClientVersion: Partial<Record<LinkType, string>>;
  rematchWindowSec: number;
  rematchOfferMinutes: number;
  apple?: { appIds: string[] };
  android?: { packageName: string; sha256CertFingerprints: string[] };
}

export const DEFAULT_LINKS: LinksConfig = {
  enabled: true, baseUrl: 'https://link.muchi-issen.example', appScheme: 'muchi', createsPerDay: 30, roomMinutes: 30, cupDaysMax: 14, defaultDays: 30,
  resolvesPerHour: 60, failuresPerHour: 10, lockMinutes: 30, minClientVersion: {}, rematchWindowSec: 20, rematchOfferMinutes: 15,
};

const int = (min: number, max: number) => z.number().int().min(min).max(max);
const semver = z.string().regex(/^\d{1,4}\.\d{1,4}\.\d{1,4}$/);
const configSchema = z.object({
  _note: z.string().optional(),
  enabled: z.boolean(),
  baseUrl: z.string().regex(/^https:\/\/[a-z0-9.-]+(:\d{1,5})?$/, 'an https origin without a path'),
  appScheme: z.string().regex(/^[a-z][a-z0-9+.-]{1,30}$/),
  createsPerDay: int(1, 200),
  roomMinutes: int(5, 120),
  cupDaysMax: int(1, 30),
  defaultDays: int(1, 90),
  resolvesPerHour: int(10, 600),
  failuresPerHour: int(3, 100),
  lockMinutes: int(5, 1440),
  minClientVersion: z.object(Object.fromEntries(LINK_TYPES.map((t) => [t, semver.optional()])) as Record<LinkType, z.ZodOptional<typeof semver>>).strict(),
  rematchWindowSec: int(5, 120),
  rematchOfferMinutes: int(5, 60),
  apple: z.object({ appIds: z.array(z.string().regex(/^[A-Z0-9]{10}\.[A-Za-z0-9.-]+$/)).max(5) }).strict().optional(),
  android: z.object({ packageName: z.string().regex(/^[a-zA-Z][\w]*(\.[a-zA-Z][\w]*)+$/), sha256CertFingerprints: z.array(z.string().regex(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/)).max(5) }).strict().optional(),
}).strict();

/** REQ-LINK-022: boot and every remote-config version. */
export function linksProblems(m: Pick<Master, 'progression'>, path = 'progression.links'): string[] {
  const raw = (m.progression as { links?: unknown }).links;
  if (raw === undefined) return [];
  const r = configSchema.safeParse(raw);
  if (!r.success) return r.error.issues.map((i) => `${path}.${i.path.join('.')}: ${i.message}`);
  const out: string[] = [];
  if (r.data.failuresPerHour > r.data.resolvesPerHour) out.push(`${path}.failuresPerHour: must not exceed resolvesPerHour`);
  return out;
}

export const linksConfig = (m: Pick<Master, 'progression'>): LinksConfig => ({ ...DEFAULT_LINKS, ...((m.progression as { links?: Partial<LinksConfig> }).links ?? {}) });

// ------------------------------------------------------------------------------------------------ tokens

/** 31 characters without 0 1 o i l (REQ-LINK-002). */
export const TOKEN_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz';
export const TOKEN_LENGTH = 22;
export const LINK_SHARDS = 16;

export type RandomBytes = (n: number) => Uint8Array;
export const cryptoBytes: RandomBytes = (n) => crypto.getRandomValues(new Uint8Array(n));

/** A new token: the first character puts it in the owner's directory shard, the other 21 are uniform random (≈104 bits). */
export function makeToken(ownerId: string, rand: RandomBytes = cryptoBytes): string {
  const shard = shardOf(ownerId);
  const firsts = [...TOKEN_ALPHABET].filter((_, i) => i % LINK_SHARDS === shard);
  let out = firsts[rand(1)[0]! % firsts.length]!;
  const limit = 256 - (256 % TOKEN_ALPHABET.length);
  while (out.length < TOKEN_LENGTH) {
    for (const b of rand(32)) {
      if (b >= limit) continue;
      out += TOKEN_ALPHABET[b % TOKEN_ALPHABET.length];
      if (out.length === TOKEN_LENGTH) break;
    }
  }
  return out;
}
/** The directory shard of a token (its first character). */
export const tokenShard = (token: string) => TOKEN_ALPHABET.indexOf(token[0]!) % LINK_SHARDS;

/** The canonical token from typed input (NFKC, spaces / dashes removed, lower case), or null when it is not one. */
export function normalizeToken(raw: string): string | null {
  const s = raw.normalize('NFKC').replace(/[\s\-‐‑‒–—―−ーｰ]/g, '').toLowerCase();
  if (s.length !== TOKEN_LENGTH) return null;
  for (const ch of s) if (!TOKEN_ALPHABET.includes(ch)) return null;
  return s;
}

/**
 * REQ-LINK-001: a token from anything a player can bring: `https://<any host>/l/<token>[?…][#…]`, `<scheme>://l/<token>`, or the
 * token typed by hand (the web page shows it in groups of four). The host is not checked here (the server looks the token up
 * either way); anything else → null.
 */
export function parseLink(raw: string, scheme = DEFAULT_LINKS.appScheme): string | null {
  const s = raw.normalize('NFKC').trim();
  const m = s.match(/^https:\/\/[^/?#\s]+\/l\/([^/?#\s]+)\/?(?:[?#].*)?$/i) ?? s.match(new RegExp(`^${scheme}:\\/\\/l\\/([^/?#\\s]+)\\/?(?:[?#].*)?$`, 'i'));
  if (m) return normalizeToken(decodeURIComponent(m[1]!));
  return normalizeToken(s);
}

/** Groups of four for reading out / typing (`abcd-efgh-…`). */
export const formatToken = (t: string) => t.match(/.{1,4}/g)!.join('-');

export const linkUrl = (cfg: LinksConfig, token: string) => `${cfg.baseUrl}/l/${token}`;
export const appUrl = (cfg: LinksConfig, token: string) => `${cfg.appScheme}://l/${token}`;

// ------------------------------------------------------------------------------------------------ expiry and text

const MIN = 60_000, DAY = 86_400_000;
/** REQ-LINK-004: rooms live as long as the room, cups until their close (capped), the rest `defaultDays`. */
export function linkExpiry(cfg: LinksConfig, type: LinkType, now: number, targetEnd?: number | null): number {
  if (type === 'room') return now + cfg.roomMinutes * MIN;
  if (type === 'cup') return Math.min(now + cfg.cupDaysMax * DAY, targetEnd ?? Infinity);
  return now + cfg.defaultDays * DAY;
}

/** REQ-LINK-003: the share sheet text — no rewards, no amounts, no urgency, no player names (English in i18n/en.ts). */
export const SHARE_TEXT: Record<LinkType, string> = {
  room: 'ムチ一閃のフレンド部屋に招待します',
  cup: 'ムチ一閃の主催カップに招待します',
  replay: 'ムチ一閃のリプレイを見てください',
  invite: 'ムチ一閃を一緒に遊びませんか',
  friend: 'ムチ一閃でフレンドになりませんか',
  team: 'ムチ一閃の支部に招待します',
  help: 'ムチ一閃のヘルプ',
};
export const shareText = (cfg: LinksConfig, type: LinkType, token: string) => `${SHARE_TEXT[type]}\n${linkUrl(cfg, token)}`;

// ------------------------------------------------------------------------------------------------ web fallback (REQ-LINK-010/011)

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/**
 * The page `GET /l/:token` serves when the app is not installed. It never looks the token up (the same page for any string:
 * no oracle, no personal data). A token-shaped path is carried to the app (scheme button) and to Google Play (install referrer);
 * on iOS the page shows the token to type into 「リンクを開く」 after installing (the App Store carries nothing; no clipboard).
 */
export function fallbackPage(cfg: LinksConfig, rawToken: string, stores: { ios: string | null; android: string | null }): string {
  const token = normalizeToken(rawToken);
  const play = stores.android ? `${stores.android}${stores.android.includes('?') ? '&' : '?'}referrer=${encodeURIComponent(token ? `link=${token}` : 'link=')}` : null;
  const btn = (href: string, label: string) => `<a class="cta" href="${esc(href)}">${label} »</a>`;
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>ムチ一閃 / Muchi Issen</title>
<style>body{margin:0;min-height:100vh;background:#07142b;color:#e9f3ff;font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center}
main{max-width:420px;padding:28px;background:rgba(10,30,64,.82);border:1px solid rgba(80,200,255,.35)}
.label{font-size:11px;letter-spacing:.24em;color:#5fd3ff}h1{font-size:22px;margin:6px 0 14px}p{font-size:14px;line-height:1.6}
.cta{display:block;margin:12px 0;padding:12px 18px;background:#21c8ff;color:#04152e;font-weight:700;text-decoration:none;transform:skewX(-12deg)}
code{font-size:16px;letter-spacing:.08em;color:#9fe6ff}</style></head><body><main>
<div class="label">MUCHI ISSEN</div><h1>ムチ一閃</h1>
<p>アプリで開いてください。アプリが入っていなければ、ストアから入れてください。<br>Open this link in the app. If you do not have it yet, get it from the store.</p>
${token ? btn(appUrl(cfg, token), 'アプリで開く / Open in the app') : ''}
${stores.ios ? btn(stores.ios, 'App Store') : ''}${play ? btn(play, 'Google Play') : ''}
${token ? `<p>iPhone：入れた後、アプリの「リンクを開く」にこのコードを入れてください（自動では開きません）。<br>iPhone: after installing, enter this code in 「リンクを開く」 (Open a link) in the app. It does not open by itself.</p><p><code>${esc(formatToken(token))}</code></p>` : ''}
</main></body></html>`;
}

/** REQ-LINK-012: apple-app-site-association (null when not configured). */
export function appleAssociation(cfg: LinksConfig) {
  if (!cfg.apple?.appIds.length) return null;
  return { applinks: { apps: [], details: cfg.apple.appIds.map((appID) => ({ appID, appIDs: [appID], paths: ['/l/*'], components: [{ '/': '/l/*' }] })) } };
}
/** REQ-LINK-012: Digital Asset Links (null when not configured). */
export function androidAssetLinks(cfg: LinksConfig) {
  if (!cfg.android?.sha256CertFingerprints.length) return null;
  return [{ relation: ['delegate_permission/common.handle_all_urls'], target: { namespace: 'android_app', package_name: cfg.android.packageName, sha256_cert_fingerprints: cfg.android.sha256CertFingerprints } }];
}

// ------------------------------------------------------------------------------------------------ replay start tick (REQ-HL-013, §72.4)

/** The largest start tick a replay link may carry (the engine's tick ceiling). */
export const REPLAY_LINK_MAX_START_TICK = 72000;

/** The optional `startTick` of a replay link target (the sharer's top highlight): an integer 0..72000, or null when absent. */
export function replayStartTick(t: Record<string, unknown>): number | null {
  const st = t.startTick;
  if (st === undefined || st === null) return null;
  if (typeof st !== 'number' || !Number.isInteger(st) || st < 0 || st > REPLAY_LINK_MAX_START_TICK) {
    throw new AppError('BAD_REQUEST', `target.startTick must be an integer 0..${REPLAY_LINK_MAX_START_TICK}`);
  }
  return st;
}

/** The directory row of a replay link: a different start tick is a different target (`raceId@tick`). */
export const replayLinkRow = (raceId: string, startTick: number | null): { targetKey: string; data: Record<string, string> } =>
  startTick === null ? { targetKey: raceId, data: { raceId } } : { targetKey: `${raceId}@${startTick}`, data: { raceId, startTick: String(startTick) } };

/** What a resolved replay link adds to its target: `{ startTick }` when the link carries one. */
export const replayLinkExtra = (data: Record<string, string>): { startTick?: number } => (data.startTick !== undefined ? { startTick: Number(data.startTick) } : {});
