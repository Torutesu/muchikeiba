/**
 * The English string table and the response-boundary translator (REQ-L10N-002..006, contracts/protocol.md §23).
 *
 * Two tables feed one catalog, both keyed by the exact Japanese text the server renders:
 *   - master/locale-en.json (`Master.locale.en`, replaceable/extendable by remote config `locale.en`): every
 *     player-facing Japanese string of the master data (product names, notices, skill names, stamps, push templates…);
 *   - i18n/en.ts (CODE_EN): texts the domain code builds (reward lines, odds notices, skill conditions, error details).
 * A key with `{placeholders}` is a template: `残り{v}m` matches 「残り200m」 and renders `{v} m to go` with the captured
 * value (itself translated when it is Japanese). Composite texts fall back to their sentences (。) and list parts (＋・、).
 *
 * Japanese stays the source of truth: domain code, golden files and the Japanese API are unchanged. A text with no
 * translation is sent in Japanese (never dropped) and the coverage tests fail on it (test/l10n.test.ts).
 */
import { CODE_EN } from './en.js';
import { hasJapanese, type Locale } from './locale.js';

export type StringTable = Record<string, string>;
interface Template { ja: string; en: string; re: RegExp; names: string[]; literal: number }
export interface Catalog {
  exact: Map<string, string>; templates: Template[]; memo: Map<string, string | null>;
  /** Clients only: a katakana name with no entry is romanized (a player-named horse). The server never does this. */
  romanize?: boolean;
}

const PH = /\{(\w+)\}/g;
/** In the English, `{n:ord}` renders a number as an ordinal (「3着」 → 3rd). */
const PH_EN = /\{(\w+)(:ord)?\}/g;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The placeholders of a text, sorted (`{name}` → `name`). */
export function placeholders(s: string): string[] {
  return [...s.matchAll(PH_EN)].map((x) => x[1]!).sort();
}

export function ordinal(n: number): string {
  const t = n % 100;
  return n + (t >= 11 && t <= 13 ? 'th' : n % 10 === 1 ? 'st' : n % 10 === 2 ? 'nd' : n % 10 === 3 ? 'rd' : 'th');
}

/**
 * What a placeholder may capture. Number-like names only match numbers ("1,020", "2.5%"), so a template such as
 * `{n}秒間 {parts}` cannot swallow the text before it; any other name matches any text (translated recursively).
 */
const NUMERIC = new Set(['n', 'm', 'v', 'p', 'a', 'b', 'i', 'y', 'days', 'levels', 'qty', 'minutes', 'points']);
const CAPTURE: Record<string, string> = { id: '([A-Za-z0-9]+)', code: '([A-Z0-9-]+)', url: '(\\S+)', hm: '([0-9]{1,2}:[0-9]{2})' };
/** Placeholders that carry player-written text (display names, team names): kept as written when not in the table. */
const VERBATIM = new Set(['name', 'team', 'url', 'code', 'id', 'cup']); // cup: a hosted cup's name (§42, player text)
const captureOf = (name: string) => (NUMERIC.has(name) ? '([+\\-−]?[0-9][0-9.,]*%?)' : CAPTURE[name] ?? '(.+?)');

function compileTemplate(ja: string, en: string): Template {
  const names: string[] = [];
  let src = '^';
  let last = 0;
  for (const mt of ja.matchAll(PH)) {
    src += escapeRe(ja.slice(last, mt.index));
    src += captureOf(mt[1]!);
    names.push(mt[1]!);
    last = mt.index! + mt[0].length;
  }
  src += escapeRe(ja.slice(last)) + '$';
  return { ja, en, re: new RegExp(src, 's'), names, literal: ja.replace(PH, '').length };
}

/** Later tables win (remote config over master over code). */
export function compileCatalog(...tables: (StringTable | undefined)[]): Catalog {
  return compileCatalogWith({}, ...tables);
}

export function compileCatalogWith(o: { romanize?: boolean }, ...tables: (StringTable | undefined)[]): Catalog {
  const exact = new Map<string, string>();
  for (const t of tables) for (const [k, v] of Object.entries(t ?? {})) if (!k.startsWith('_')) exact.set(k, v);
  const templates = [...exact].filter(([k]) => /\{\w+\}/.test(k)).map(([k, v]) => compileTemplate(k, v));
  templates.sort((a, b) => b.literal - a.literal); // the most specific template first
  return { exact, templates, memo: new Map(), ...(o.romanize ? { romanize: true } : {}) };
}

const byTable = new WeakMap<object, Catalog>();
const NO_TABLE = {};
/** The catalog of a master (cached per table object, so a remote-config version gets its own). */
export function catalogFor(m: { locale?: { en?: StringTable } }): Catalog {
  const key = m.locale?.en ?? NO_TABLE;
  let c = byTable.get(key);
  if (!c) { c = compileCatalog(CODE_EN, m.locale?.en); byTable.set(key, c); }
  return c;
}

// same order as the C# client (Muchi.Client LocaleCatalog)
const LIST_SEPARATORS: [string, string][] = [['　/　', '  /  '], ['　·　', '  ·  '], ['  /  ', '  /  '], [' / ', ' / '], ['\n', '\n'], [' または ', ' or '], [' ・ ', ' · '], ['＋', ' + '], ['・', ', '], ['、', ', '], ['　', '  ']];
const MEMO_MAX = 20_000;

/** English for a Japanese text, or null when the catalog cannot translate it. Texts without Japanese are returned as is. */
export function translateText(s: string, cat: Catalog, depth = 0): string | null {
  if (!hasJapanese(s)) return s;
  const hit = cat.exact.get(s);
  if (hit !== undefined) return hit;
  if (depth > 6) return null;
  if (cat.memo.has(s)) return cat.memo.get(s)!;
  const out = translateUncached(s, cat, depth);
  if (cat.memo.size > MEMO_MAX) cat.memo.clear();
  cat.memo.set(s, out);
  return out;
}

function translateUncached(s: string, cat: Catalog, depth: number): string | null {
  for (const t of cat.templates) {
    const mt = t.re.exec(s);
    if (!mt) continue;
    const vals: Record<string, string> = {};
    let ok = true;
    t.names.forEach((n, i) => {
      const raw = mt[i + 1]!;
      const v = translateText(raw, cat, depth + 1) ?? (VERBATIM.has(n) ? (cat.romanize ? romanizeName(raw) : raw) : null);
      if (v === null) ok = false;
      else vals[n] = v;
    });
    if (ok) return t.en.replace(PH_EN, (_, n: string, ord?: string) => (ord && /^\d+$/.test(vals[n] ?? '') ? ordinal(Number(vals[n])) : vals[n] ?? ''));
  }
  // a notice made of several sentences: each sentence on its own
  const sentences = s.split(/(?<=。)/).filter((x) => x.length > 0);
  if (sentences.length > 1) {
    const parts = sentences.map((x) => translateText(x, cat, depth + 1));
    if (parts.every((x) => x !== null)) return parts.join(' ');
  }
  for (const [sep, en] of LIST_SEPARATORS) {
    if (!s.includes(sep)) continue;
    const parts = s.split(sep).map((x) => (x === '' ? '' : translateText(x, cat, depth + 1)));
    if (parts.every((x) => x !== null)) return parts.join(en);
  }
  return cat.romanize && isKatakanaName(s) ? romanizeName(s) : null;
}

// ----------------------------------------------------------------------------- katakana names (clients, REQ-L10N-010)

const TWO: Record<string, string> = {
  キャ: 'kya', キュ: 'kyu', キョ: 'kyo', シャ: 'sha', シュ: 'shu', ショ: 'sho', シェ: 'she', チャ: 'cha', チュ: 'chu', チョ: 'cho', チェ: 'che',
  ニャ: 'nya', ニュ: 'nyu', ニョ: 'nyo', ヒャ: 'hya', ヒュ: 'hyu', ヒョ: 'hyo', ミャ: 'mya', ミュ: 'myu', ミョ: 'myo', リャ: 'rya', リュ: 'ryu',
  リョ: 'ryo', ギャ: 'gya', ギュ: 'gyu', ギョ: 'gyo', ジャ: 'ja', ジュ: 'ju', ジョ: 'jo', ジェ: 'je', ビャ: 'bya', ビュ: 'byu', ビョ: 'byo',
  ピャ: 'pya', ピュ: 'pyu', ピョ: 'pyo', ファ: 'fa', フィ: 'fi', フェ: 'fe', フォ: 'fo', ティ: 'ti', ディ: 'di', トゥ: 'tu', ドゥ: 'du',
  ウィ: 'wi', ウェ: 'we', ウォ: 'wo', ヴァ: 'va', ヴィ: 'vi', ヴェ: 've', ヴォ: 'vo', ツァ: 'tsa', デュ: 'dyu', テュ: 'tyu',
};
const ONE_LIST = 'ア a イ i ウ u エ e オ o カ ka キ ki ク ku ケ ke コ ko サ sa シ shi ス su セ se ソ so タ ta チ chi ツ tsu テ te ト to '
  + 'ナ na ニ ni ヌ nu ネ ne ノ no ハ ha ヒ hi フ fu ヘ he ホ ho マ ma ミ mi ム mu メ me モ mo ヤ ya ユ yu ヨ yo ラ ra リ ri ル ru レ re ロ ro ワ wa ヲ o ン n '
  + 'ガ ga ギ gi グ gu ゲ ge ゴ go ザ za ジ ji ズ zu ゼ ze ゾ zo ダ da ヂ ji ヅ zu デ de ド do バ ba ビ bi ブ bu ベ be ボ bo パ pa ピ pi プ pu ペ pe ポ po ヴ vu '
  + 'ァ a ィ i ゥ u ェ e ォ o ャ ya ュ yu ョ yo ヮ wa ヵ ka ヶ ke';
const ONE: Record<string, string> = {};
{ const w = ONE_LIST.split(' '); for (let i = 0; i + 1 < w.length; i += 2) ONE[w[i]!] = w[i + 1]!; }

export const isKatakanaName = (s: string) => s.length >= 2 && /^[ァ-ヶー・]+$/.test(s);

/** 「ミドリカワ」 → Midorikawa (Hepburn, long vowels unmarked); the same as Muchi.Client Romaji.Name. */
export function romanizeName(s: string): string {
  if (!isKatakanaName(s)) return s;
  let out = '';
  let sokuon = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === 'ッ') { sokuon = true; continue; }
    if (c === '・') { out += ' '; continue; }
    if (c === 'ー') continue;
    let syl = TWO[s.slice(i, i + 2)];
    if (syl) i++;
    else syl = ONE[c] ?? '';
    if (sokuon && syl) { out += syl.startsWith('ch') ? 't' : syl[0]; sokuon = false; }
    out += syl;
  }
  return out.split(' ').map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : w)).join(' ');
}

/** A text in the locale: the English when there is one, else the Japanese (never empty). */
export function textIn(locale: Locale, s: string, cat: Catalog): string {
  return locale === 'ja' ? s : translateText(s, cat) ?? s;
}

/**
 * A JSON value in the locale: every string value translated (object keys, ids and numbers untouched). `ja` returns the
 * value itself. Used on every response body at the boundary (http/app.ts) and on push messages (domain/push.ts).
 */
/** Fields that hold identifiers, never display text (asset and voice keys may embed a Japanese name; `replayLog` is re-simulated byte for byte, REQ-MYRP-008). */
export const ID_KEYS = new Set(['id', 'key', 'voiceName', 'asset', 'assetKey', 'icon', 'templateId', 'clipKey', 'clipKeys', 'replayLog']);
/**
 * Fields that only ever hold what a player typed (display, branch, plate names and the names copied from them): never
 * looked up, even when the name happens to equal a table entry (a player called 「決勝」 stays 「決勝」, QA R11).
 */
export const PLAYER_TEXT_KEYS = new Set(['displayName', 'teamName', 'plateName', 'ownerName', 'opponentName', 'inviterName', 'inviteeName', 'fromName', 'byName', 'anonName', 'rivalName', 'horseName', 'replayTitle', 'caption', 'inquiryText', 'messageText', 'cupName', 'hostName']);
/**
 * REQ-QCHAT-009/013: quick chat texts are built in the viewer's language by the domain (the phrase pair plus player-sourced
 * values that are never translated), so the boundary leaves them as they are.
 */
export const PRE_LOCALIZED_KEYS = new Set(['qchatText', 'qchatTemplate', 'qchatValue',
  // REQ-SHOW-007 (§62): showcase phrases and background names are picked in the viewer's language from their JA + EN pair
  'phraseText', 'backgroundName',
  // REQ-PED-011/010 (§71): bloodline names / founders are picked from their JA + EN pair, and the pair hints are built in the
  // viewer's language (they may quote a player's horse name, which is never translated)
  'lineName', 'founderName', 'hintText']);
/** `name:シンセイアカツキ`, `voice/ja/name/…`: an identifier, not a text. */
const ID_LIKE = /^[a-z][a-z0-9_]*[:/]/;

export function localize<T>(v: T, locale: Locale, cat: Catalog): T {
  if (locale === 'ja') return v;
  const walk = (x: unknown): unknown => {
    if (typeof x === 'string') return ID_LIKE.test(x) ? x : translateText(x, cat) ?? x;
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === 'object' && Object.getPrototypeOf(x) === Object.prototype) {
      const o: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(x)) o[k] = ID_KEYS.has(k) || PLAYER_TEXT_KEYS.has(k) || PRE_LOCALIZED_KEYS.has(k) ? val : walk(val);
      return o;
    }
    return x;
  };
  return walk(v) as T;
}

/** Every Japanese string left in a value (coverage tests; `skipKeys` = player-written fields such as names). */
export function untranslated(v: unknown, skipKeys: ReadonlySet<string> = new Set(), path = '$'): string[] {
  if (typeof v === 'string') return hasJapanese(v) ? [`${path}: ${v}`] : [];
  if (Array.isArray(v)) return v.flatMap((x, i) => untranslated(x, skipKeys, `${path}[${i}]`));
  if (v && typeof v === 'object') return Object.entries(v).flatMap(([k, x]) => (skipKeys.has(k) ? [] : untranslated(x, skipKeys, `${path}.${k}`)));
  return [];
}

// ----------------------------------------------------------------------------- English wording lint (REQ-L10N-008)

/**
 * The English side of the legal wording rules (docs/planning/03, REQ-UXS-022, REQ-AD-004): no multipliers
 * ("2x", "double"), no fake urgency ("limited time only", "hurry"), no reference prices or discounts.
 */
export const EN_BANNED: RegExp[] = [
  /\b\d+\s*[x×]\b/i, /(^|[^\w])[x×]\s*\d+\b/i, /\bdouble[sd]?\b/i, /\btwice\b/i, /\btriple\b/i,
  /\blimited[- ]time\b/i, /\btoday only\b/i, /\bonly today\b/i, /\bends soon\b/i, /\bhurry\b/i, /\blast chance\b/i, /\bact now\b/i, /\bdon'?t miss\b/i,
  /\bwhile (stocks|supplies) last\b/i, /\bonly \d+ left\b/i, /\d+\s*% off\b/i, /\b(regular|usual|original|normal) price\b/i, /\bbest (deal|value)\b/i,
  /\bbargain\b/i, /\bsave \d/i, /\bfree gacha\b/i, /\brate[- ]?up\b/i, /\bodds up\b/i,
];
/** Extra words never used in an ad offer (REQ-AD-004, like AD_BANNED_WORDS for Japanese). */
export const EN_AD_BANNED: RegExp[] = [...EN_BANNED, /\bguarantee/i, /\bbonus\b/i, /\bdeal\b/i];

export function enWordingProblems(en: string, banned: RegExp[] = EN_BANNED): string[] {
  return banned.filter((re) => re.test(en)).map((re) => `wording ${re.source}`);
}

/** A string table is usable: English values, same placeholders as the Japanese key, wording lint. */
export function tableProblems(table: StringTable, label: string): string[] {
  const out: string[] = [];
  for (const [ja, en] of Object.entries(table)) {
    if (ja.startsWith('_')) continue;
    const at = `${label}「${ja.length > 40 ? ja.slice(0, 40) + '…' : ja}」`;
    if (typeof en !== 'string' || en.trim() === '') { out.push(`${at}: empty English text`); continue; }
    if (!hasJapanese(ja) && placeholders(ja).length === 0) out.push(`${at}: the key is not Japanese`);
    if (hasJapanese(en)) out.push(`${at}: the English text contains Japanese: ${en}`);
    if (placeholders(ja).join(',') !== placeholders(en).join(',')) out.push(`${at}: placeholders differ (${placeholders(ja).join(',')} vs ${placeholders(en).join(',')})`);
    for (const p of enWordingProblems(en)) out.push(`${at}: ${p}: ${en}`);
  }
  return out;
}
