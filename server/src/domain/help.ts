/**
 * ヘルプセンター (in-app help & inquiry) — REQ-HELP-001..024, contracts/protocol.md §48.
 *
 *  - FAQ articles in Japanese and English (master/help.json, replaceable by remote config `help`), checked at boot and on
 *    every config version (helpProblems): ids, categories, lengths, links (in-app screens, the existing legal pages,
 *    other articles, the official support site only), contexts, tokens and wording.
 *  - Numbers never live in an article: `{{tokens}}` are filled from data when the article is read (gacha rates and pity
 *    through oddsDisclosure — the same computation as the rates screen —, age limits, deletion days, history windows,
 *    the active ruleset's whip count).
 *  - Search folds Japanese the way the NG-name check does (foldForCompare: NFKC, hiragana → katakana, small kana, long
 *    vowels, ヴ) plus lower-case Latin. The query is never stored (KPI: normalised length and category only).
 *  - Inquiries live in the player's state (status, support replies, unread), with attached §33 history rows copied at
 *    submission and diagnostics limited to what support needs. Nothing here moves coins or items.
 *
 * Pure functions on master + state; the PlayerService runs the state changes inside its transaction.
 */
import { CHEER_MIN_INTERVAL_MS } from './cheer.js';
import helpJson from '../../master/help.json';
import { AppError } from './errors.js';
import type { Master } from './master.js';
import type { PlayerState } from './player.js';
import type { KpiEvent } from './kpi.js';
import { searchFold } from './horses.js';
import { findBanner, oddsDisclosure } from './gacha.js';
import { deletionConfig } from './accountDeletion.js';
import { HISTORY_LIMITS, SUPPORT_TOPIC_TEXT, type ResolvedRef } from './history.js';
import { bettingWordsIn } from './bettingWords.js';
import { enWordingProblems } from '../i18n/catalog.js';
import { dayRule, gameDayKey, gameDayStartMs, addJstDays } from './time.js';
import type { Locale } from '../i18n/locale.js';
import { recordActivity } from './activity.js';
import { DATA_EXPORT_DEFAULTS } from './dataExport.js';
import { quickChatOf } from './quickChat.js';

// ------------------------------------------------------------------------------------------------ master

export interface Loc { ja: string; en: string }
export const HELP_CATEGORY_IDS = ['getting_started', 'races', 'horses', 'scout', 'purchases', 'account', 'deletion', 'accessibility'] as const;
export type HelpCategoryId = typeof HELP_CATEGORY_IDS[number];
/** In-app screens an article may open (protocol §48.1). */
export const HELP_SCREENS = [
  'home', 'settings', 'race_lobby', 'tutorial', 'training', 'breeding', 'stable', 'collection', 'gacha', 'gacha_odds', 'shop', 'history',
  'gift_box', 'activity', 'accessibility', 'account_link', 'deletion', 'inquiry', 'my_inquiries',
  // Round 18 integration: settings › privacy (§51), the branch feed (§52 quick chat), practice races (§50)
  'privacy', 'team_feed', 'practice',
  // §56 (REQ-PERF-018): the 画質・通信量 settings and the storage screen
  'performance', 'storage',
  // Round 19 (§57): the ヒント screen (tutorial replays and the tips library)
  'tips',
  // Round 20: settings › privacy › ads and analytics (§58)
  'privacy_choices',
  // Round 20: settings › notifications (push categories, quiet hours and the device reminders, §61)
  'notifications',
  // Round 21 (§62): the トレーナーカード editor (settings)
  'showcase',
] as const;
export type HelpScreen = typeof HELP_SCREENS[number];
/** The existing legal pages (利用規約・プライバシーポリシー・特定商取引法に基づく表記・資金決済法に基づく表示). */
export const LEGAL_DOCS = ['terms', 'privacy', 'tokushoho', 'shikin'] as const;
export type LegalDoc = typeof LEGAL_DOCS[number];
/** REQ-HELP-008: screens that deep-link to an article. */
export const HELP_CONTEXTS = ['gacha_odds', 'coin_shortfall', 'purchase', 'race_whip', 'race_result', 'training', 'breeding', 'history', 'gift_box', 'account_link', 'deletion', 'accessibility', 'privacy', 'storage', 'practice',  // R19 integration: the practice setup's ? link
  // Round 20 (§58): settings › privacy › ads and analytics, and the pre-prompt sheet
  'privacy_choices',
  // Round 20 (§61): settings › notifications (the device reminders article)
  'notifications',
  // Round 21 (§62): the トレーナーカード editor
  'showcase'] as const;
export type HelpContext = typeof HELP_CONTEXTS[number];

export type HelpLink =
  | { type: 'screen'; screen: HelpScreen }
  | { type: 'legal'; doc: LegalDoc }
  | { type: 'article'; id: string }
  | { type: 'url'; url: string };
export interface HelpArticle {
  id: string; category: HelpCategoryId; title: Loc; body: Loc;
  keywords?: { ja: string[]; en: string[] };
  links?: HelpLink[];
  related?: string[];
}
export interface HelpCategory { id: HelpCategoryId; title: Loc; icon: string }
export interface InquiryConfig { descriptionMin: number; descriptionMax: number; attachMax: number; openMax: number; perDay: number; minIntervalSec: number; keepMax: number; replyMax: number }
export interface HelpConfig {
  enabled: boolean; supportSiteHost: string; titleMaxChars: number; bodyMaxChars: number; searchMaxChars: number; searchMaxResults: number;
  feedbackPerDay: number; inquiry: InquiryConfig;
}
export interface HelpMaster { version: number; config: HelpConfig; categories: HelpCategory[]; articles: HelpArticle[]; contexts: Record<string, string> }

export const BASE_HELP = helpJson as unknown as HelpMaster;
export const helpOf = (m: Pick<Master, 'help'>): HelpMaster => m.help ?? BASE_HELP;

/** Limits the config values must stay in (boot and remote config). */
export const HELP_LIMITS = {
  titleMaxChars: [10, 80], bodyMaxChars: [200, 4000], searchMaxChars: [10, 100], searchMaxResults: [1, 50], feedbackPerDay: [1, 500],
  descriptionMin: [1, 50], descriptionMax: [100, 4000], attachMax: [0, HISTORY_LIMITS.ticketRefsMax], openMax: [1, 10], perDay: [1, 50],
  minIntervalSec: [0, 3600], keepMax: [5, 200], replyMax: [100, 8000],
} as const;
export const HELP_KEYWORDS_MAX = 20;
export const HELP_KEYWORD_CHARS = 20;

// labels of links (code texts in both languages; the article title for an article link)
const SCREEN_LABEL: Record<HelpScreen, Loc> = {
  home: { ja: 'ホームを開く', en: 'Open the home screen' },
  settings: { ja: '設定を開く', en: 'Open the settings' },
  notifications: { ja: '通知の設定を開く', en: 'Open the notification settings' },
  race_lobby: { ja: 'レースを開く', en: 'Open races' },
  tutorial: { ja: 'チュートリアルを開く', en: 'Open the tutorial' },
  training: { ja: '調教を開く', en: 'Open training' },
  breeding: { ja: '配合を開く', en: 'Open breeding' },
  stable: { ja: '厩舎を開く', en: 'Open the stable' },
  collection: { ja: '図鑑を開く', en: 'Open the collection' },
  gacha: { ja: 'スカウトを開く', en: 'Open the scout' },
  gacha_odds: { ja: '提供割合を開く', en: 'Open the rates' },
  shop: { ja: 'ショップを開く', en: 'Open the shop' },
  history: { ja: '購入・コイン・ガチャ履歴を開く', en: 'Open your purchase, coin and gacha history' },
  gift_box: { ja: 'プレゼントボックスを開く', en: 'Open the gift box' },
  activity: { ja: 'アクティビティを開く', en: 'Open the activity list' },
  accessibility: { ja: 'アクセシビリティの設定を開く', en: 'Open the accessibility settings' },
  account_link: { ja: '引き継ぎの設定を開く', en: 'Open data transfer' },
  deletion: { ja: 'アカウント削除を開く', en: 'Open account deletion' },
  inquiry: { ja: '問い合わせる', en: 'Contact us' },
  my_inquiries: { ja: '自分の問い合わせを見る', en: 'See your inquiries' },
  privacy: { ja: 'プライバシーを開く', en: 'Open privacy' },
  team_feed: { ja: '支部のフィードを開く', en: 'Open the branch feed' },
  practice: { ja: '練習レースを開く', en: 'Open practice races' },
  performance: { ja: '画質・通信量の設定を開く', en: 'Open graphics and data settings' },
  storage: { ja: 'ストレージを開く', en: 'Open storage' },
  tips: { ja: 'ヒントを開く', en: 'Open tips' },
  privacy_choices: { ja: '広告と分析の設定を開く', en: 'Open the ads and analytics settings' },
  showcase: { ja: 'トレーナーカードを開く', en: 'Open the trainer card' },
};
/** Round 21 (§64 release notes): the link label of an in-app screen, in the request's language. */
export function screenLabel(screen: HelpScreen, lang: Locale): string { return pick(SCREEN_LABEL[screen], lang); }
const LEGAL_LABEL: Record<LegalDoc, Loc> = {
  terms: { ja: '利用規約', en: 'Terms of service' },
  privacy: { ja: 'プライバシーポリシー', en: 'Privacy policy' },
  tokushoho: { ja: '特定商取引法に基づく表記', en: 'Notice under the Specified Commercial Transactions Act' },
  shikin: { ja: '資金決済法に基づく表示', en: 'Notice under the Payment Services Act' },
};
const SUPPORT_SITE_LABEL: Loc = { ja: '公式サポートサイト', en: 'Official support site' };

// ------------------------------------------------------------------------------------------------ tokens

const TOKEN_RE = /\{\{([a-z_]+)(?::([A-Za-z0-9_-]+))?(?::([A-Za-z0-9_-]+))?\}\}/g;
const fmtInt = (n: number) => n.toLocaleString('en-US');
/** Context a token is filled from: the master, and the whip count of the ruleset in effect (absent = the default). */
export interface TokenEnv { m: Master; maxWhips: number }

const discCache = new WeakMap<object, Map<string, ReturnType<typeof oddsDisclosure>>>();
function disclosure(m: Master, bannerId: string) {
  let c = discCache.get(m.gacha);
  if (!c) { c = new Map(); discCache.set(m.gacha, c); }
  let d = c.get(bannerId);
  if (!d) { d = oddsDisclosure(m, findBanner(m, bannerId)); c.set(bannerId, d); }
  return d;
}

/** The value of one token, or throws an Error saying why it cannot be filled (helpProblems reports it). */
function tokenValue(env: TokenEnv, name: string, a?: string, b?: string): string {
  const m = env.m;
  const banner = () => {
    if (!a || !m.gacha.banners.some((x) => x.id === a)) throw new Error(`unknown banner ${a ?? ''}`);
    return disclosure(m, a);
  };
  switch (name) {
    case 'pity_pulls': return fmtInt(banner().pity.pullsRequired);
    case 'pity_coins': return fmtInt(banner().pity.costCoins);
    case 'pity_cost': {
      const g = a ? m.gacha.pityGroups[a] : undefined;
      if (!g) throw new Error(`unknown pity group ${a ?? ''}`);
      return fmtInt(g.cost);
    }
    case 'rate': case 'guarantee_rate': {
      const d = banner();
      const totals = name === 'rate' ? d.rarityTotals : d.guarantee.rarityTotals;
      const r = b ? totals[b] : undefined;
      if (!r) throw new Error(`banner ${a} has no ${b ?? ''} in its ${name === 'rate' ? 'pool' : 'guarantee pool'}`);
      return r.rate;
    }
    case 'price_single': banner(); return fmtInt(m.gacha.banners.find((x) => x.id === a)!.priceSingle);
    case 'price_ten': banner(); return fmtInt(m.gacha.banners.find((x) => x.id === a)!.priceTen);
    case 'monthly_limit': {
      const band = m.ageLimits.bands.find((x) => x.id === a);
      if (!band) throw new Error(`unknown age band ${a ?? ''}`);
      if (band.monthlyLimitYen === null) throw new Error(`age band ${a} has no monthly limit`);
      return fmtInt(band.monthlyLimitYen);
    }
    case 'guardian_age': return String(m.ageLimits.guardianConsentUnderAge);
    case 'deletion_days': return String(deletionConfig(m).cancelWindowDays);
    case 'purchase_keep_days': return fmtInt(deletionConfig(m).ledgerRetentionDays);
    case 'coin_history_days': return String(HISTORY_LIMITS.coinDays);
    case 'gacha_history_days': return String(HISTORY_LIMITS.gachaDays);
    case 'max_whips': return String(env.maxWhips);
    // Round 18 integration: §51 data export and §52 quick chat limits (remote config)
    case 'export_cooldown_days': return String({ ...DATA_EXPORT_DEFAULTS, ...(m.progression.dataExport ?? {}) }.cooldownDays);
    case 'export_keep_days': return String({ ...DATA_EXPORT_DEFAULTS, ...(m.progression.dataExport ?? {}) }.keepDays);
    case 'export_link_minutes': return String({ ...DATA_EXPORT_DEFAULTS, ...(m.progression.dataExport ?? {}) }.linkTtlMinutes);
    case 'qchat_interval_sec': return String(Math.round(quickChatOf(m).config.postIntervalMs / 1000));
    case 'qchat_per_day': return String(quickChatOf(m).config.postsPerDay);
    case 'cheer_interval_sec': return String(CHEER_MIN_INTERVAL_MS / 1000); // §55 REQ-CHEER-004
    // Round 20: §61 the device reminders' daily cap (remote config)
    case 'lnotif_daily_cap': return String(m.progression.localNotifications?.dailyCap ?? 2);
    default: throw new Error(`unknown token ${name}`);
  }
}

/** Round 19 (§57 tips): why each token of a text cannot be filled (empty = every token is fillable; the same check as articles). */
export function tokenProblems(env: TokenEnv, at: string, text: string): string[] {
  const out: string[] = [];
  for (const mt of text.matchAll(TOKEN_RE)) {
    try { tokenValue(env, mt[1]!, mt[2], mt[3]); } catch (e) { out.push(`${at}: ${mt[0]}: ${(e as Error).message}`); }
  }
  if (/\{\{|\}\}/.test(text.replace(TOKEN_RE, ''))) out.push(`${at}: malformed token`);
  return out;
}

export function tokensOf(text: string): string[] {
  return [...text.matchAll(TOKEN_RE)].map((x) => x[0]).sort();
}

/** REQ-HELP-005: the article text with every token filled from data. */
export function fillTokens(env: TokenEnv, text: string): string {
  return text.replace(TOKEN_RE, (_, n: string, a?: string, b?: string) => tokenValue(env, n, a, b));
}

// ------------------------------------------------------------------------------------------------ validation

/** Japanese shop words (docs/planning/03, REQ-UXS-022): never in an article. */
export const HELP_BANNED_JA = ['倍', 'お得', '今だけ', '残りわずか', '通常価格'];
const DIGIT = '[0-9０-９]';
/** A number written next to a unit that must come from data (outside tokens). */
const NUMBER_UNIT_JA = new RegExp(`${DIGIT}+(?:[.,．，]${DIGIT}+)*\\s*(?:%|％|pt|ポイント|円|コイン|枚|回|日|か月|ヶ月)|[¥￥]\\s*${DIGIT}`);
const NUMBER_UNIT_EN = new RegExp(`${DIGIT}+(?:[.,]${DIGIT}+)*\\s*(?:%|pt\\b|points?\\b|coins?\\b|pulls?\\b|days?\\b|yen\\b|times\\b)|[¥￥]\\s*${DIGIT}`, 'i');
/** The only digits a scout article may carry outside tokens (the product word). */
const ALLOWED_SCOUT_DIGITS = /10連|10-pulls?/g;

export function digitsProblems(at: string, text: string, strict: boolean, en: boolean): string[] {
  const bare = text.replace(TOKEN_RE, '').replace(ALLOWED_SCOUT_DIGITS, '');
  const out: string[] = [];
  if ((en ? NUMBER_UNIT_EN : NUMBER_UNIT_JA).test(bare)) out.push(`${at}: a number with a unit must come from a {{token}}`);
  if (strict && new RegExp(DIGIT).test(bare)) out.push(`${at}: scout articles may not carry numbers outside {{tokens}}`);
  return out;
}

function urlProblems(at: string, url: string, host: string): string[] {
  let u: URL;
  try { u = new URL(url); } catch { return [`${at}: bad url ${url}`]; }
  if (u.protocol !== 'https:') return [`${at}: url must be https`];
  if (u.hostname !== host || u.username || u.password || u.port) return [`${at}: url must be on the official support site ${host}`];
  return [];
}

export const wordingProblems = (at: string, ja: string, en: string): string[] => [
  ...HELP_BANNED_JA.filter((w) => ja.includes(w)).map((w) => `${at}.ja: shop word 「${w}」`),
  ...bettingWordsIn(ja).map((w) => `${at}.ja: betting word ${w}`),
  ...enWordingProblems(en).map((p) => `${at}.en: ${p}`),
  ...bettingWordsIn(en).map((w) => `${at}.en: betting word ${w}`),
];

const isLoc = (x: unknown): x is Loc => !!x && typeof x === 'object' && typeof (x as Loc).ja === 'string' && typeof (x as Loc).en === 'string';
const JP_RE = /[぀-ヿ㐀-鿿・]/;

/** REQ-HELP-003/004/005/019: everything wrong with a help master against the resolved master (empty = fine). */
export function helpProblems(m: Master, h: HelpMaster = helpOf(m), maxWhips = 6): string[] {
  const out: string[] = [];
  if (!h || typeof h !== 'object') return ['help must be an object'];
  const c = h.config;
  if (!c || typeof c !== 'object') return ['help.config is required'];
  if (typeof c.enabled !== 'boolean') out.push('help.config.enabled must be a boolean');
  if (typeof c.supportSiteHost !== 'string' || !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(c.supportSiteHost)) out.push('help.config.supportSiteHost must be a host name');
  const int = (path: string, v: unknown, [lo, hi]: readonly [number, number]) => {
    if (!Number.isInteger(v) || (v as number) < lo || (v as number) > hi) out.push(`${path} must be an integer ${lo}..${hi}`);
  };
  for (const k of ['titleMaxChars', 'bodyMaxChars', 'searchMaxChars', 'searchMaxResults', 'feedbackPerDay'] as const) int(`help.config.${k}`, c[k], HELP_LIMITS[k]);
  const q = c.inquiry;
  if (!q || typeof q !== 'object') out.push('help.config.inquiry is required');
  else {
    for (const k of ['descriptionMin', 'descriptionMax', 'attachMax', 'openMax', 'perDay', 'minIntervalSec', 'keepMax', 'replyMax'] as const) int(`help.config.inquiry.${k}`, q[k], HELP_LIMITS[k]);
    if (Number.isInteger(q.openMax) && Number.isInteger(q.keepMax) && q.keepMax < q.openMax) out.push('help.config.inquiry.keepMax must be ≥ openMax');
  }
  if (!Number.isInteger(h.version) || h.version < 1) out.push('help.version must be a positive integer');
  // categories: all eight, once each
  const cats = Array.isArray(h.categories) ? h.categories : [];
  const catIds = cats.map((x) => x?.id);
  for (const id of HELP_CATEGORY_IDS) if (!catIds.includes(id)) out.push(`help.categories: missing ${id}`);
  if (new Set(catIds).size !== catIds.length) out.push('help.categories: duplicate id');
  cats.forEach((x, i) => {
    if (!(HELP_CATEGORY_IDS as readonly string[]).includes(x?.id)) out.push(`help.categories[${i}]: unknown id ${x?.id}`);
    if (!isLoc(x?.title) || !x.title.ja || !x.title.en) out.push(`help.categories[${i}]: title needs ja and en`);
    else {
      if (JP_RE.test(x.title.en)) out.push(`help.categories[${i}].title.en contains Japanese`);
      out.push(...wordingProblems(`help.categories.${x.id}.title`, x.title.ja, x.title.en));
    }
    if (typeof x?.icon !== 'string' || !/^[a-z0-9_]{1,24}$/.test(x.icon)) out.push(`help.categories[${i}]: bad icon`);
  });
  // articles
  const arts = Array.isArray(h.articles) ? h.articles : [];
  if (arts.length === 0) out.push('help.articles must not be empty');
  const ids = new Set<string>();
  const env: TokenEnv = { m, maxWhips };
  for (const [i, a] of arts.entries()) {
    const at = `help.articles[${i}]${a?.id ? ` ${a.id}` : ''}`;
    if (typeof a?.id !== 'string' || !/^[a-z0-9_]{2,40}$/.test(a.id)) { out.push(`${at}: bad id`); continue; }
    if (ids.has(a.id)) out.push(`${at}: duplicate id`);
    ids.add(a.id);
    if (!(HELP_CATEGORY_IDS as readonly string[]).includes(a.category)) out.push(`${at}: unknown category ${a.category}`);
    if (!isLoc(a.title) || !isLoc(a.body)) { out.push(`${at}: title and body need ja and en`); continue; }
    for (const lang of ['ja', 'en'] as const) {
      const t = a.title[lang], b = a.body[lang];
      if (t.trim().length < 1 || [...t].length > c.titleMaxChars) out.push(`${at}.title.${lang}: 1..${c.titleMaxChars} characters`);
      if (b.trim().length < 1 || [...b].length > c.bodyMaxChars) out.push(`${at}.body.${lang}: 1..${c.bodyMaxChars} characters`);
      if (/[\u0000-\u0009\u000b-\u001f\u007f]/.test(t + b)) out.push(`${at}.${lang}: control characters`);
      for (const p of digitsProblems(`${at}.${lang}`, `${t}\n${b}`, a.category === 'scout', lang === 'en')) out.push(p);
    }
    if (JP_RE.test(a.title.en) || JP_RE.test(a.body.en)) out.push(`${at}.en contains Japanese`);
    if (tokensOf(a.body.ja).join() !== tokensOf(a.body.en).join() || tokensOf(a.title.ja).join() !== tokensOf(a.title.en).join()) out.push(`${at}: ja and en carry different tokens`);
    for (const lang of ['ja', 'en'] as const) {
      for (const tk of [...tokensOf(a.title[lang]), ...tokensOf(a.body[lang])]) {
        const mt = [...tk.matchAll(TOKEN_RE)][0]!;
        try { tokenValue(env, mt[1]!, mt[2], mt[3]); } catch (e) { out.push(`${at}.${lang}: ${tk}: ${(e as Error).message}`); }
      }
      if (/\{\{|\}\}/.test(a.body[lang].replace(TOKEN_RE, ''))) out.push(`${at}.body.${lang}: malformed token`);
    }
    out.push(...wordingProblems(at, `${a.title.ja}\n${a.body.ja}\n${(a.keywords?.ja ?? []).join(' ')}`, `${a.title.en}\n${a.body.en}\n${(a.keywords?.en ?? []).join(' ')}`));
    if (a.keywords !== undefined) {
      for (const lang of ['ja', 'en'] as const) {
        const k = a.keywords[lang];
        if (!Array.isArray(k) || k.length > HELP_KEYWORDS_MAX || k.some((w) => typeof w !== 'string' || w.trim() === '' || [...w].length > HELP_KEYWORD_CHARS)) out.push(`${at}.keywords.${lang}: up to ${HELP_KEYWORDS_MAX} words of 1..${HELP_KEYWORD_CHARS} characters`);
        else if (lang === 'en' && k.some((w) => JP_RE.test(w))) out.push(`${at}.keywords.en contains Japanese`);
      }
    }
    for (const [j, l] of (a.links ?? []).entries()) {
      const lat = `${at}.links[${j}]`;
      if (l?.type === 'screen') { if (!(HELP_SCREENS as readonly string[]).includes(l.screen)) out.push(`${lat}: unknown screen ${l.screen}`); }
      else if (l?.type === 'legal') { if (!(LEGAL_DOCS as readonly string[]).includes(l.doc)) out.push(`${lat}: unknown legal page ${l.doc}`); }
      else if (l?.type === 'article') { if (typeof l.id !== 'string') out.push(`${lat}: article id required`); }
      else if (l?.type === 'url') out.push(...urlProblems(lat, String(l.url), c.supportSiteHost));
      else out.push(`${lat}: unknown link type`);
    }
    if ((a.links?.length ?? 0) > 8) out.push(`${at}: at most 8 links`);
  }
  for (const a of arts) {
    for (const l of a?.links ?? []) if (l?.type === 'article' && (!ids.has(l.id) || l.id === a.id)) out.push(`help.articles ${a.id}: link to unknown article ${l.id}`);
    for (const r of a?.related ?? []) if (!ids.has(r) || r === a.id) out.push(`help.articles ${a.id}: related article ${r} does not exist`);
  }
  for (const id of HELP_CATEGORY_IDS) if (!arts.some((a) => a?.category === id)) out.push(`help: category ${id} has no article`);
  const ctx = h.contexts && typeof h.contexts === 'object' ? h.contexts : {};
  for (const k of HELP_CONTEXTS) {
    if (!(k in ctx)) out.push(`help.contexts: missing ${k}`);
    else if (!ids.has(ctx[k]!)) out.push(`help.contexts.${k}: unknown article ${ctx[k]}`);
  }
  for (const k of Object.keys(ctx)) if (!(HELP_CONTEXTS as readonly string[]).includes(k)) out.push(`help.contexts: unknown context ${k}`);
  return out;
}

// ------------------------------------------------------------------------------------------------ reading

export const pick = (l: Loc, lang: Locale) => (lang === 'en' ? l.en : l.ja);

/** REQ-HELP-009/011: what the form says about attachments and diagnostics (code texts in both languages). */
export const INQUIRY_NOTES = {
  diagnostics: {
    ja: '送信すると、アプリの版・端末の種類（iOS／Android）・プレイヤーID・直近のレースID（最大3件）が自動で添えられます。名前・メールアドレス・端末の機種名・位置情報は送りません。',
    en: 'When you send, the app version, device type (iOS/Android), your player ID and your latest race IDs (up to three) are attached automatically. Your name, email address, device model and location are not sent.',
  },
  privacy: {
    ja: '本文にメールアドレス・電話番号・パスワード・カード番号は書かないでください（メールアドレスや電話番号らしい部分は自動で消します）。',
    en: 'Please do not write email addresses, phone numbers, passwords or card numbers in the message (anything that looks like an email address or phone number is removed automatically).',
  },
} satisfies Record<string, Loc>;

export const INQUIRY_CATEGORIES = ['purchase_missing', 'refund', 'coins', 'gacha', 'race', 'account', 'deletion', 'accessibility', 'bug', 'other'] as const;
export type InquiryCategory = typeof INQUIRY_CATEGORIES[number];
/** The §33 ticket topics keep their titles; the rest are new. English: i18n/en.ts (CODE_EN) for the shared ones too. */
export const INQUIRY_CATEGORY_TEXT: Record<InquiryCategory, Loc> = {
  purchase_missing: { ja: SUPPORT_TOPIC_TEXT.purchase_missing, en: 'Bought but not received' },
  refund: { ja: SUPPORT_TOPIC_TEXT.refund, en: 'About a refund' },
  coins: { ja: SUPPORT_TOPIC_TEXT.coins, en: 'About a coin change' },
  gacha: { ja: SUPPORT_TOPIC_TEXT.gacha, en: 'About a scout result' },
  race: { ja: 'レース・ムチについて', en: 'About races and the whip' },
  account: { ja: 'アカウント・引き継ぎについて', en: 'About your account and data transfer' },
  deletion: { ja: 'アカウント削除について', en: 'About account deletion' },
  accessibility: { ja: 'アクセシビリティについて', en: 'About accessibility' },
  bug: { ja: '不具合の報告', en: 'Report a problem' },
  other: { ja: SUPPORT_TOPIC_TEXT.other, en: 'Something else' },
};
/** Categories whose form offers the §33 history rows first (any category may attach them). */
export const INQUIRY_HISTORY_CATEGORIES: readonly InquiryCategory[] = ['purchase_missing', 'refund', 'coins', 'gacha'];
export type InquiryStatus = 'received' | 'answered' | 'closed';
export const INQUIRY_STATUS_TEXT: Record<InquiryStatus, Loc> = {
  received: { ja: '受付済み', en: 'Received' },
  answered: { ja: '回答済み', en: 'Answered' },
  closed: { ja: '完了', en: 'Closed' },
};

const supportSiteUrl = (h: HelpMaster) => `https://${h.config.supportSiteHost}/`;

/** REQ-HELP-001/002/008: GET /v1/help — the index (no player state). */
export function helpIndex(m: Master, lang: Locale) {
  const h = helpOf(m);
  const on = h.config.enabled;
  const q = h.config.inquiry;
  return {
    enabled: on, version: h.version, lang,
    categories: on ? h.categories.map((c) => ({ id: c.id, title: pick(c.title, lang), icon: c.icon, count: h.articles.filter((a) => a.category === c.id).length })) : [],
    articles: on ? h.articles.map((a) => ({ id: a.id, category: a.category, title: pick(a.title, lang) })) : [],
    contexts: on ? { ...h.contexts } : {},
    supportSite: supportSiteUrl(h),
    inquiry: {
      categories: INQUIRY_CATEGORIES.map((id) => ({ id, title: pick(INQUIRY_CATEGORY_TEXT[id], lang), history: INQUIRY_HISTORY_CATEGORIES.includes(id) })),
      descriptionMin: q.descriptionMin, descriptionMax: q.descriptionMax, attachMax: q.attachMax,
      diagnosticsNote: pick(INQUIRY_NOTES.diagnostics, lang), privacyNote: pick(INQUIRY_NOTES.privacy, lang),
    },
  };
}

function articleOf(h: HelpMaster, id: string): HelpArticle {
  const a = h.config.enabled ? h.articles.find((x) => x.id === id) : undefined;
  if (!a) throw new AppError('NOT_FOUND', `article ${id}`);
  return a;
}

function linkView(h: HelpMaster, l: HelpLink, lang: Locale) {
  switch (l.type) {
    case 'screen': return { type: l.type, screen: l.screen, label: pick(SCREEN_LABEL[l.screen], lang) };
    case 'legal': return { type: l.type, doc: l.doc, label: pick(LEGAL_LABEL[l.doc], lang) };
    case 'article': return { type: l.type, articleId: l.id, label: pick(articleOf(h, l.id).title, lang) };
    case 'url': return { type: l.type, url: l.url, label: pick(SUPPORT_SITE_LABEL, lang) };
  }
}

/** REQ-HELP-001/004/005: GET /v1/help/articles/:id — the body with its tokens filled. */
export function helpArticle(m: Master, id: string, lang: Locale, maxWhips = 6) {
  const h = helpOf(m);
  const a = articleOf(h, id);
  const env: TokenEnv = { m, maxWhips };
  const cat = h.categories.find((c) => c.id === a.category)!;
  return {
    id: a.id, category: a.category, categoryTitle: pick(cat.title, lang),
    title: fillTokens(env, pick(a.title, lang)), body: fillTokens(env, pick(a.body, lang)),
    links: (a.links ?? []).map((l) => linkView(h, l, lang)),
    related: (a.related ?? []).map((r) => ({ id: r, title: pick(articleOf(h, r).title, lang) })),
    version: h.version,
  };
}

/** REQ-HELP-006: the folded form used by search (the NG-name fold + lower-case Latin). Same as C# HelpText.Fold. */
export const helpFold = searchFold;
/** The query split into folded words (blank → none). */
export function helpQueryWords(q: string): string[] {
  return q.normalize('NFKC').split(/[\s　]+/).map(helpFold).filter((w) => w.length > 0);
}

/** REQ-HELP-006: GET /v1/help/search — every word must match; title 3 / keyword 2 / body 1. The query is not kept. */
export function searchHelp(m: Master, q: string, category: string | null, limit: number | null, lang: Locale, maxWhips = 6) {
  const h = helpOf(m);
  const c = h.config;
  const t = q.trim();
  if ([...t].length < 1 || [...t].length > c.searchMaxChars) throw new AppError('BAD_REQUEST', `q must be 1..${c.searchMaxChars} characters`);
  if (category !== null && !(HELP_CATEGORY_IDS as readonly string[]).includes(category)) throw new AppError('BAD_REQUEST', 'unknown category');
  const lim = limit ?? c.searchMaxResults;
  if (!Number.isInteger(lim) || lim < 1 || lim > c.searchMaxResults) throw new AppError('BAD_REQUEST', `limit must be 1..${c.searchMaxResults}`);
  const words = helpQueryWords(t);
  const length = Math.min(64, words.join('').length);
  if (!c.enabled || words.length === 0) return { items: [], total: 0, query: { length } };
  const env: TokenEnv = { m, maxWhips };
  const hits: { a: HelpArticle; score: number; order: number; body: string }[] = [];
  h.articles.forEach((a, order) => {
    if (category !== null && a.category !== category) return;
    const title = helpFold(fillTokens(env, pick(a.title, lang)));
    const kws = (lang === 'en' ? a.keywords?.en : a.keywords?.ja) ?? [];
    const kw = kws.map(helpFold).join('|');
    const body = fillTokens(env, pick(a.body, lang));
    const fb = helpFold(body);
    let score = 0;
    for (const w of words) {
      const s = (title.includes(w) ? 3 : 0) + (kw.includes(w) ? 2 : 0) + (fb.includes(w) ? 1 : 0);
      if (s === 0) return;
      score += s;
    }
    hits.push({ a, score, order, body });
  });
  hits.sort((x, y) => y.score - x.score || x.order - y.order);
  return {
    items: hits.slice(0, lim).map(({ a, body }) => ({ id: a.id, category: a.category, title: fillTokens(env, pick(a.title, lang)), snippet: snippetOf(body, words) })),
    total: hits.length, query: { length },
  };
}

/** The first body line holding a word (folded comparison), cut to 60 characters around it. */
function snippetOf(body: string, words: string[]): string {
  const lines = body.split('\n').map((l) => l.replace(/^[・•]\s*/, '').trim()).filter(Boolean);
  const line = lines.find((l) => words.some((w) => helpFold(l).includes(w))) ?? lines[0] ?? '';
  const chars = [...line];
  return chars.length <= 60 ? line : chars.slice(0, 59).join('') + '…';
}

// ------------------------------------------------------------------------------------------------ state

export interface InquiryAttachment { ref: string; kind: 'purchase' | 'coin' | 'gacha'; at: number; title: string; detail: string }
export interface InquiryMessage { from: 'player' | 'support'; content: string; at: number; by?: string }
export interface InquiryTicket {
  id: string; key: string; category: InquiryCategory; status: InquiryStatus; lang: Locale;
  createdAt: number; updatedAt: number; firstReplyAt: number | null;
  description: string; redacted: number;
  attachments: InquiryAttachment[];
  diagnostics: { appVersion: string; platform: Platform; playerId: string; lastRaceIds: string[] };
  messages: InquiryMessage[];
  /** Support messages the player has opened (unread = support messages beyond this count). */
  seenReplies: number;
  /** REQ-HELP-016: the ops index has this ticket's current summary. */
  indexed: boolean;
  /** REQ-HELP-017: reply opKeys already applied (a retried reply is answered from here). */
  replyKeys: string[];
}
export interface HelpState {
  votes: Record<string, { helpful: boolean; at: number }>;
  voteDay: string; votesToday: number;
  seq: number; tickets: InquiryTicket[];
  sentDay: string; sentToday: number; lastSentAt: number;
}
export const PLATFORMS = ['ios', 'android', 'editor'] as const;
export type Platform = typeof PLATFORMS[number];

const peek = (s: PlayerState) => (s as PlayerState & { help?: HelpState }).help;
export function ensureHelp(s: PlayerState): HelpState {
  const x = s as PlayerState & { help?: HelpState };
  x.help ??= { votes: {}, voteDay: '', votesToday: 0, seq: 0, tickets: [], sentDay: '', sentToday: 0, lastSentAt: 0 };
  return x.help;
}

/** REQ-HELP-007: one vote per article (changeable); `feedbackPerDay` per game day. */
export function voteHelp(m: Master, s: PlayerState, articleId: string, helpful: boolean, now: number, emit?: (e: KpiEvent) => void) {
  const h = helpOf(m);
  const a = articleOf(h, articleId);
  const st = ensureHelp(s);
  const prev = st.votes[articleId];
  if (prev && prev.helpful === helpful) return { articleId, helpful, changed: false };
  const day = gameDayKey(now, dayRule(m));
  if (st.voteDay !== day) { st.voteDay = day; st.votesToday = 0; }
  if (st.votesToday >= h.config.feedbackPerDay) throw new AppError('RATE_LIMITED', 'too many feedback votes today', undefined, { retryAt: gameDayStartMs(addJstDays(day, 1), dayRule(m)) });
  st.votesToday += 1;
  st.votes[articleId] = { helpful, at: now };
  emit?.({ name: 'help_feedback', s1: articleId, s2: a.category, value: helpful ? 1 : 0 });
  return { articleId, helpful, changed: true };
}

/** REQ-HELP-011: what looks like an email address, a phone number or a card number is replaced before storing. */
export const REDACTED = '［削除しました］';
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
/** Ten or more digits in a row (spaces / hyphens allowed between them): phone and card numbers. */
const LONG_NUMBER_RE = /(?<![0-9０-９A-Za-z])(?:[+＋][0-9０-９]{1,3}[ \-－]?)?[0-9０-９](?:[ \-－]?[0-9０-９]){9,18}(?![0-9０-９A-Za-z])/g;
export function redactPersonal(text: string): { text: string; n: number } {
  let n = 0;
  const sub = () => { n++; return REDACTED; };
  const out = text.replace(EMAIL_RE, sub).replace(LONG_NUMBER_RE, sub);
  return { text: out, n };
}

export interface InquiryInput { category: InquiryCategory; description: string; refs: string[]; diagnostics: { appVersion: string; platform: Platform } }

const openCount = (st: HelpState) => st.tickets.filter((t) => t.status === 'received').length;

/** The limits shown on the list and refused on submit (REQ-HELP-013). */
function limitsOf(m: Master, st: HelpState, now: number) {
  const q = helpOf(m).config.inquiry;
  const rule = dayRule(m);
  const day = gameDayKey(now, rule);
  const today = st.sentDay === day ? st.sentToday : 0;
  const open = openCount(st);
  let retryAt: number | null = null;
  let reason: 'open' | 'day' | 'interval' | null = null;
  if (open >= q.openMax) reason = 'open';
  else if (today >= q.perDay) { reason = 'day'; retryAt = gameDayStartMs(addJstDays(day, 1), rule); }
  else if (st.lastSentAt > 0 && now < st.lastSentAt + q.minIntervalSec * 1000) { reason = 'interval'; retryAt = st.lastSentAt + q.minIntervalSec * 1000; }
  return { openMax: q.openMax, open, perDay: q.perDay, today, retryAt, reason };
}

/** Latest confirmed races of the player (newest first, at most 3) — race ids only. */
function lastRaceIds(s: PlayerState): string[] {
  return Object.entries(s.appliedRaces ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([id]) => id);
}

const CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;

/**
 * REQ-HELP-009..013: store a new inquiry. `rows` are the resolved §33 rows of `input.refs` (resolved by the caller before
 * the transaction, in the same order). A retry with the same client key returns the stored ticket.
 */
export function submitInquiry(m: Master, s: PlayerState, input: InquiryInput, rows: ResolvedRef[], key: string, lang: Locale, now: number, emit?: (e: KpiEvent) => void) {
  const h = helpOf(m);
  const q = h.config.inquiry;
  const st = ensureHelp(s);
  const prev = st.tickets.find((t) => t.key === key);
  if (prev) return inquiryDetail(m, s, prev.id, lang);
  if (s.deletion?.status === 'deleting') throw new AppError('FORBIDDEN', 'account deletion in progress');
  if (!(INQUIRY_CATEGORIES as readonly string[]).includes(input.category)) throw new AppError('BAD_REQUEST', 'unknown category');
  const d = input.description.trim();
  if (CONTROL.test(d.replace(/\n/g, ''))) throw new AppError('BAD_REQUEST', 'description has control characters');
  const len = [...d].length;
  if (len < q.descriptionMin || len > q.descriptionMax) throw new AppError('BAD_REQUEST', `description must be ${q.descriptionMin}..${q.descriptionMax} characters`);
  if (input.refs.length > q.attachMax || new Set(input.refs).size !== input.refs.length) throw new AppError('BAD_REQUEST', `refs: up to ${q.attachMax} distinct references`);
  if (rows.length !== input.refs.length) throw new AppError('BAD_REQUEST', 'refs and rows differ');
  if (!(PLATFORMS as readonly string[]).includes(input.diagnostics.platform) || !/^[0-9A-Za-z.+-]{1,32}$/.test(input.diagnostics.appVersion)) throw new AppError('BAD_REQUEST', 'bad diagnostics');
  const lim = limitsOf(m, st, now);
  if (lim.reason) {
    const msg = lim.reason === 'open' ? `up to ${q.openMax} inquiries can wait for an answer` : lim.reason === 'day' ? `up to ${q.perDay} inquiries a day` : `wait ${q.minIntervalSec} seconds between inquiries`;
    throw new AppError('RATE_LIMITED', msg, undefined, { reason: lim.reason, retryAt: lim.retryAt });
  }
  const red = redactPersonal(d);
  const day = gameDayKey(now, dayRule(m));
  if (st.sentDay !== day) { st.sentDay = day; st.sentToday = 0; }
  st.sentToday += 1;
  st.lastSentAt = now;
  st.seq += 1;
  const t: InquiryTicket = {
    id: `q_${st.seq}`, key, category: input.category, status: 'received', lang, createdAt: now, updatedAt: now, firstReplyAt: null,
    description: red.text, redacted: red.n,
    attachments: rows.map((r) => ({ ref: r.ref, kind: r.kind, at: r.row.at, ...ticketLine(r) })),
    diagnostics: { appVersion: input.diagnostics.appVersion, platform: input.diagnostics.platform, playerId: s.id, lastRaceIds: lastRaceIds(s) },
    messages: [], seenReplies: 0, indexed: false, replyKeys: [],
  };
  st.tickets.push(t);
  pruneTickets(st, q.keepMax);
  emit?.({ name: 'inquiry_submit', s1: t.category, count: t.attachments.length, value: red.n });
  return inquiryDetail(m, s, t.id, lang);
}

/** One line per attached row: the §33 ticket line (what the player saw, no internal id). */
function ticketLine(r: ResolvedRef): { title: string; detail: string } {
  const fmt = (n: number) => n.toLocaleString('en-US');
  if (r.kind === 'purchase') return { title: r.row.product, detail: `¥${fmt(r.row.priceYen)}・${r.row.storeName}・${r.row.statusText}` };
  if (r.kind === 'coin') {
    const cur = r.row.currency === 'paid' ? '有償コイン' : '無償コイン';
    const dir = r.row.direction === 'earned' ? '獲得' : r.row.direction === 'spent' ? '使用' : '記録';
    return { title: r.row.title, detail: `${cur}${fmt(r.row.amount)}枚・${dir}` };
  }
  return { title: r.row.banner, detail: `スカウト${r.row.count}回・${r.row.summary}` };
}

/** Newest `keepMax` tickets; tickets waiting for an answer are never dropped. */
function pruneTickets(st: HelpState, keepMax: number) {
  while (st.tickets.length > keepMax) {
    const i = st.tickets.findIndex((t) => t.status !== 'received');
    if (i < 0) break;
    st.tickets.splice(i, 1);
  }
}

const unreadOf = (t: InquiryTicket) => t.messages.filter((x) => x.from === 'support').length > t.seenReplies;

function ticketOf(s: PlayerState, ticketId: string): InquiryTicket {
  const t = peek(s)?.tickets.find((x) => x.id === ticketId);
  if (!t) throw new AppError('NOT_FOUND', `inquiry ${ticketId}`);
  return t;
}

/** REQ-HELP-014: GET /v1/help/inquiries/:id (`internal`: the ops view adds who replied and the index flag). */
export function inquiryDetail(m: Master, s: PlayerState, ticketId: string, lang: Locale, internal = false) {
  void m;
  const t = ticketOf(s, ticketId);
  return {
    ticketId: t.id, category: t.category, categoryTitle: pick(INQUIRY_CATEGORY_TEXT[t.category], lang), status: t.status, statusText: pick(INQUIRY_STATUS_TEXT[t.status], lang),
    createdAt: t.createdAt, updatedAt: t.updatedAt, lang: t.lang, inquiryText: t.description, redacted: t.redacted,
    attachments: t.attachments.map((x) => ({ ...x })), diagnostics: { ...t.diagnostics, lastRaceIds: [...t.diagnostics.lastRaceIds] },
    messages: t.messages.map((x) => ({ from: x.from, messageText: x.content, at: x.at, ...(internal && x.by ? { by: x.by } : {}) })),
    unread: unreadOf(t),
    ...(internal ? { indexed: t.indexed, firstReplyAt: t.firstReplyAt } : {}),
  };
}

/** REQ-HELP-014: GET /v1/help/inquiries — newest first, with the limits. */
export function inquiryList(m: Master, s: PlayerState, lang: Locale, now: number) {
  const st = peek(s);
  const tickets = [...(st?.tickets ?? [])].reverse();
  const lim = limitsOf(m, st ?? { votes: {}, voteDay: '', votesToday: 0, seq: 0, tickets: [], sentDay: '', sentToday: 0, lastSentAt: 0 }, now);
  return {
    items: tickets.map((t) => ({
      ticketId: t.id, category: t.category, categoryTitle: pick(INQUIRY_CATEGORY_TEXT[t.category], lang), status: t.status, statusText: pick(INQUIRY_STATUS_TEXT[t.status], lang),
      createdAt: t.createdAt, updatedAt: t.updatedAt, unread: unreadOf(t),
    })),
    unread: tickets.filter(unreadOf).length,
    limits: { openMax: lim.openMax, open: lim.open, perDay: lim.perDay, today: lim.today, retryAt: lim.retryAt },
  };
}

/** Summaries the ops index has not confirmed yet (REQ-HELP-016). */
export function unindexedSummaries(s: PlayerState): InquirySummary[] {
  return (peek(s)?.tickets ?? []).filter((t) => !t.indexed).map((t) => summaryOf(s.id, t));
}

/** REQ-HELP-014: mark a ticket's replies read (idempotent). */
export function markInquiryRead(s: PlayerState, ticketId: string) {
  const t = ticketOf(s, ticketId);
  t.seenReplies = t.messages.filter((x) => x.from === 'support').length;
  return { ticketId, unread: false, unreadTotal: helpBadge(s).unreadReplies };
}

/** REQ-HELP-016: the index confirmed these ticket versions (`updatedAt` must match, so a newer change stays unindexed). */
export function markIndexed(s: PlayerState, items: { ticketId: string; updatedAt: number }[]) {
  let n = 0;
  for (const it of items) {
    const t = peek(s)?.tickets.find((x) => x.id === it.ticketId);
    if (t && t.updatedAt === it.updatedAt && !t.indexed) { t.indexed = true; n++; }
  }
  return { indexed: n };
}

/** REQ-HELP-014: the settings badge (GET /v1/player `help`). */
export function helpBadge(s: PlayerState) {
  return { unreadReplies: (peek(s)?.tickets ?? []).filter(unreadOf).length };
}

/** REQ-HELP-016: what the ops index keeps (never the text). */
export interface InquirySummary { ticketId: string; playerId: string; category: InquiryCategory; status: InquiryStatus; lang: Locale; attachments: number; createdAt: number; updatedAt: number }
export const summaryOf = (playerId: string, t: InquiryTicket): InquirySummary => ({
  ticketId: t.id, playerId, category: t.category, status: t.status, lang: t.lang, attachments: t.attachments.length, createdAt: t.createdAt, updatedAt: t.updatedAt,
});

/**
 * REQ-HELP-015/017: an operator's reply. Idempotent per opKey; a closed ticket takes no reply. Writes the activity entry
 * (once per reply) and the inquiry_answered KPI on the first reply.
 */
export function replyInquiry(m: Master, s: PlayerState, ticketId: string, content: string, close: boolean, actor: string, opKey: string, now: number, emit?: (e: KpiEvent) => void) {
  const q = helpOf(m).config.inquiry;
  const t = ticketOf(s, ticketId);
  if (t.replyKeys.includes(opKey)) return { ...summaryOf(s.id, t), replies: t.messages.filter((x) => x.from === 'support').length, duplicate: true };
  if (t.status === 'closed') throw new AppError('CONFLICT', 'inquiry is closed');
  const c = content.trim();
  if ([...c].length < 1 || [...c].length > q.replyMax) throw new AppError('BAD_REQUEST', `content must be 1..${q.replyMax} characters`);
  if (CONTROL.test(c.replace(/\n/g, ''))) throw new AppError('BAD_REQUEST', 'content has control characters');
  t.messages.push({ from: 'support', content: c, at: now, by: actor });
  t.replyKeys.push(opKey);
  if (t.replyKeys.length > 50) t.replyKeys.splice(0, t.replyKeys.length - 50);
  t.status = close ? 'closed' : 'answered';
  t.updatedAt = now;
  t.indexed = false;
  const n = t.messages.filter((x) => x.from === 'support').length;
  if (t.firstReplyAt === null) {
    t.firstReplyAt = now;
    emit?.({ name: 'inquiry_answered', s1: t.category, durationMs: now - t.createdAt });
  }
  recordActivity(m, s, { kind: 'inquiry_answered', source: `inquiry:${t.id}:${n}`, linkId: t.id }, now);
  return { ...summaryOf(s.id, t), replies: n, duplicate: false };
}

/** REQ-HELP-006: the inputs of the shared fold vectors (contracts/help-fold.vectors.json, scripts/gen-help-vectors.ts). */
export const HELP_FOLD_INPUTS = [
  'てんじょう', 'テンジョウ', 'ﾃﾝｼﾞｮｳ', '天井', 'ＰＩＴＹ', 'Pity Exchange', 'ヴァイオリン', 'ゔぁいおりん', 'コーヒー', 'こ～ひ〜', 'ｺｰﾋｰ', '10連', '10-pull',
  '　有償　コイン　', 'ガチャ履歴', 'がちゃりれき', 'ｶﾞﾁｬ', 'ムチ', 'むち', 'Ａｂｃ１２３', 'キャンセル', 'きゃんせる', 'ﾍﾙﾌﾟ', 'へるぷ　せんたー',
];
export function helpFoldVectorsJson(): string {
  return JSON.stringify({
    _note: 'REQ-HELP-006: the help search fold (server help.ts helpFold / helpQueryWords = C# Muchi.Client HelpText.Fold / Words). Regenerate with npm run gen:help-vectors.',
    vectors: HELP_FOLD_INPUTS.map((input) => ({ input, fold: helpFold(input), words: helpQueryWords(input) })),
  }, null, 2) + '\n';
}
