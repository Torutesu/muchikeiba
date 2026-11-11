/**
 * アップデートのお知らせ (what's new per app version) — REQ-NEW-001..020, contracts/protocol.md §64.
 *
 *  - Ops write 1..5 illustrated pages per app version (master/release-notes.json, replaceable by remote config
 *    `releaseNotes`), Japanese and English side by side. A page reuses an existing art key (§57 TIP_ARTS: no new art) and may
 *    have one deep target: an in-app screen (§48.1, never the shop / scout / rates), a help article (§48) or a tip card (§57).
 *  - Numbers never live in a page: the help center's `{{tokens}}` (help.ts fillTokens / tokenProblems) are filled from data.
 *    Wording follows §48 (shop words, the shared betting words, the English banned list).
 *  - Who sees it (POST /v1/release-notes/check): only a player who updated — the newest note with
 *    version ≤ the app's version (x-client-version), > the account's baseline, > the newest version already seen, and released
 *    after the account was created. Never during the FTUE (the same test as §45's onboarding; such a check moves the baseline
 *    up to the app's version, so a mid-FTUE update is never introduced later), never for a brand-new install, never for an old
 *    app without the version header. The check marks nothing seen: the client may show another system prompt first
 *    (protocol §64.6) and the note then comes back next session.
 *  - Seen versions are kept on the account (`releaseNotes.seen`, bounded by `seenMax`) so a reinstall never re-shows.
 *  - Nothing here moves coins or items.
 */
import releaseNotesJson from '../../master/release-notes.json';
import { AppError } from './errors.js';
import type { Master } from './master.js';
import type { PlayerState } from './player.js';
import { HELP_SCREENS, digitsProblems, fillTokens, helpOf, pick, screenLabel, tokenProblems, tokensOf, wordingProblems, type HelpScreen, type Loc, type TokenEnv } from './help.js';
import { TIP_ARTS, openKeys, tipsOf } from './tips.js';
import { compareVersions, parseVersion } from './maintenance.js';
import type { Locale } from '../i18n/locale.js';

// ------------------------------------------------------------------------------------------------ master

export const RELEASE_TARGET_KINDS = ['screen', 'help', 'tip'] as const;
export type ReleaseTargetKind = typeof RELEASE_TARGET_KINDS[number];
/** REQ-NEW-005: a page's only CTA may never lead to the shop, the scout or a paid product. */
export const PAID_SCREENS: readonly HelpScreen[] = ['shop', 'gacha', 'gacha_odds'];
/** The screens a page may open (§48.1's screens without the paid ones). */
export const RELEASE_SCREENS: readonly HelpScreen[] = HELP_SCREENS.filter((x) => !PAID_SCREENS.includes(x));

export interface ReleaseTarget { kind: ReleaseTargetKind; id: string }
export interface ReleasePage { art: string; title: Loc; body: Loc; target?: ReleaseTarget }
export interface ReleaseNote { appVersion: string; releasedOn: string; pages: ReleasePage[] }
export interface ReleaseNotesConfig { enabled: boolean; titleMaxChars: number; bodyMaxChars: number; seenMax: number; historyMax: number }
export interface ReleaseNotesMaster { version: number; config: ReleaseNotesConfig; notes: ReleaseNote[] }

export const BASE_RELEASE_NOTES = releaseNotesJson as unknown as ReleaseNotesMaster;
export const releaseNotesOf = (m: Pick<Master, 'releaseNotes'>): ReleaseNotesMaster => m.releaseNotes ?? BASE_RELEASE_NOTES;

export const RELEASE_NOTES_LIMITS = { titleMaxChars: [8, 40], bodyMaxChars: [40, 240], seenMax: [10, 100], historyMax: [5, 50] } as const;
export const RELEASE_NOTES_MAX = 50;
export const RELEASE_PAGES_MAX = 5;

// ------------------------------------------------------------------------------------------------ validation

const isLoc = (x: unknown): x is Loc => !!x && typeof x === 'object' && typeof (x as Loc).ja === 'string' && typeof (x as Loc).en === 'string';
const JP_RE = /[぀-ヿ㐀-鿿・]/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** `YYYY-MM-DD` (JST) → the instant that day starts in Japan; null when not a real date. */
export function releaseStartMs(day: string): number | null {
  const mt = typeof day === 'string' ? DATE_RE.exec(day) : null;
  if (!mt) return null;
  const [y, mo, d] = [Number(mt[1]), Number(mt[2]), Number(mt[3])];
  const ms = Date.UTC(y, mo - 1, d);
  const back = new Date(ms);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  return ms - 9 * 3_600_000;
}

/** REQ-NEW-002..005: everything wrong with a release notes master against the resolved master (empty = fine). */
export function releaseNotesProblems(m: Master, r: ReleaseNotesMaster = releaseNotesOf(m), maxWhips = 6): string[] {
  const out: string[] = [];
  if (!r || typeof r !== 'object') return ['releaseNotes must be an object'];
  const c = r.config;
  if (!c || typeof c !== 'object') return ['releaseNotes.config is required'];
  if (typeof c.enabled !== 'boolean') out.push('releaseNotes.config.enabled must be a boolean');
  for (const k of ['titleMaxChars', 'bodyMaxChars', 'seenMax', 'historyMax'] as const) {
    const [lo, hi] = RELEASE_NOTES_LIMITS[k];
    if (!Number.isInteger(c[k]) || c[k] < lo || c[k] > hi) out.push(`releaseNotes.config.${k} must be an integer ${lo}..${hi}`);
  }
  if (!Number.isInteger(r.version) || r.version < 1) out.push('releaseNotes.version must be a positive integer');
  const notes = Array.isArray(r.notes) ? r.notes : null;
  if (!notes) return [...out, 'releaseNotes.notes must be an array'];
  if (notes.length > RELEASE_NOTES_MAX) out.push(`releaseNotes.notes: at most ${RELEASE_NOTES_MAX}`);
  const help = helpOf(m);
  const helpIds = new Set((help?.articles ?? []).map((a) => a.id));
  const tipIds = new Set((tipsOf(m)?.tips ?? []).map((t) => t.id));
  const env: TokenEnv = { m, maxWhips };
  const versions = new Set<string>();
  const dated: { v: string; day: number }[] = [];
  for (const [i, n] of notes.entries()) {
    const at = `releaseNotes.notes[${i}]${typeof n?.appVersion === 'string' ? ` ${n.appVersion}` : ''}`;
    if (!n || typeof n !== 'object') { out.push(`${at}: must be an object`); continue; }
    if (typeof n.appVersion !== 'string' || !parseVersion(n.appVersion) || n.appVersion.trim() !== n.appVersion) out.push(`${at}: appVersion must be x.y.z`);
    else if (versions.has(n.appVersion)) out.push(`${at}: duplicate appVersion`);
    else versions.add(n.appVersion);
    const day = releaseStartMs(n.releasedOn);
    if (day === null) out.push(`${at}: releasedOn must be a date YYYY-MM-DD`);
    else if (parseVersion(n.appVersion)) dated.push({ v: n.appVersion, day });
    const pages = Array.isArray(n.pages) ? n.pages : [];
    if (pages.length < 1 || pages.length > RELEASE_PAGES_MAX) out.push(`${at}: 1..${RELEASE_PAGES_MAX} pages`);
    for (const [j, p] of pages.entries()) {
      const pat = `${at}.pages[${j}]`;
      if (!p || typeof p !== 'object') { out.push(`${pat}: must be an object`); continue; }
      if (!(TIP_ARTS as readonly string[]).includes(p.art)) out.push(`${pat}: unknown art ${String(p.art)} (use an existing art key)`);
      if (!isLoc(p.title) || !isLoc(p.body)) { out.push(`${pat}: title and body need ja and en`); continue; }
      for (const lang of ['ja', 'en'] as const) {
        const ti = p.title[lang], b = p.body[lang];
        if (ti.trim().length < 1 || [...ti].length > c.titleMaxChars) out.push(`${pat}.title.${lang}: 1..${c.titleMaxChars} characters`);
        if (b.trim().length < 1 || [...b].length > c.bodyMaxChars) out.push(`${pat}.body.${lang}: 1..${c.bodyMaxChars} characters`);
        if (/[\u0000-\u001f\u007f]/.test(ti + b)) out.push(`${pat}.${lang}: control characters`);
        // REQ-NEW-003: numbers only from tokens (strict, like scout articles)
        out.push(...digitsProblems(`${pat}.${lang}`, `${ti}\n${b}`, true, lang === 'en'));
        out.push(...tokenProblems(env, `${pat}.${lang}`, `${ti}\n${b}`));
      }
      if (JP_RE.test(p.title.en) || JP_RE.test(p.body.en)) out.push(`${pat}.en contains Japanese`);
      if (tokensOf(p.title.ja + p.body.ja).join() !== tokensOf(p.title.en + p.body.en).join()) out.push(`${pat}: ja and en carry different tokens`);
      out.push(...wordingProblems(pat, `${p.title.ja}\n${p.body.ja}`, `${p.title.en}\n${p.body.en}`));
      if (p.target !== undefined) {
        const t = p.target;
        if (!t || typeof t !== 'object' || !(RELEASE_TARGET_KINDS as readonly string[]).includes(t.kind) || typeof t.id !== 'string') out.push(`${pat}.target: { kind: screen | help | tip, id }`);
        else if (t.kind === 'screen') {
          if ((PAID_SCREENS as readonly string[]).includes(t.id)) out.push(`${pat}.target: a page may not lead to the shop or a paid product (${t.id}) as its only CTA`);
          else if (!(RELEASE_SCREENS as readonly string[]).includes(t.id)) out.push(`${pat}.target: unknown screen ${t.id}`);
        } else if (t.kind === 'help' && !helpIds.has(t.id)) out.push(`${pat}.target: help article ${t.id} does not exist`);
        else if (t.kind === 'tip' && !tipIds.has(t.id)) out.push(`${pat}.target: tip card ${t.id} does not exist`);
        for (const k of Object.keys(t ?? {})) if (k !== 'kind' && k !== 'id') out.push(`${pat}.target: unknown key ${k}`);
      }
      for (const k of Object.keys(p)) if (!['art', 'title', 'body', 'target'].includes(k)) out.push(`${pat}: unknown key ${k}`);
    }
  }
  // a later version is never released before an earlier one
  dated.sort((a, b) => compareVersions(a.v, b.v));
  for (let i = 1; i < dated.length; i++) if (dated[i]!.day < dated[i - 1]!.day) out.push(`releaseNotes.notes: ${dated[i]!.v} is released before ${dated[i - 1]!.v}`);
  return out;
}

// ------------------------------------------------------------------------------------------------ player state

export interface ReleaseNotesState {
  /** Versions shown to this player (version order, oldest dropped past seenMax). */
  seen: string[];
  /** The app version of the first check made during the FTUE (or the highest such): nothing at or below it is introduced. */
  baseline?: string;
}

const maxVersion = (xs: readonly string[]): string | null => xs.reduce<string | null>((a, x) => (parseVersion(x) && (a === null || compareVersions(x, a) > 0) ? x : a), null);

/** §45's onboarding test: the partner is missing or fewer than `onboardingRaces` races are done. */
export function inFtue(m: Master, s: PlayerState): boolean {
  const races = s.onboarding?.races ?? s.stats?.races ?? 0;
  return !s.flags.partnerHorseId || races < (m.progression.nextActions?.onboardingRaces ?? 2);
}

/** A page in the request's language with its tokens filled and its target if this player can open it. */
function pageView(m: Master, s: PlayerState | null, p: ReleasePage, lang: Locale, now: number, maxWhips: number) {
  const env: TokenEnv = { m, maxWhips };
  return { art: p.art, title: fillTokens(env, pick(p.title, lang)), body: fillTokens(env, pick(p.body, lang)), target: targetView(m, s, p.target, lang, now) };
}

/** REQ-NEW-011: the target only when it opens for this player (a closed tip card, a disabled library → null). */
function targetView(m: Master, s: PlayerState | null, t: ReleaseTarget | undefined, lang: Locale, now: number) {
  if (!t) return null;
  if (t.kind === 'screen') return (RELEASE_SCREENS as readonly string[]).includes(t.id) ? { kind: t.kind, id: t.id, label: screenLabel(t.id as HelpScreen, lang) } : null;
  if (t.kind === 'help') {
    const h = helpOf(m);
    const a = h.config.enabled ? h.articles.find((x) => x.id === t.id) : undefined;
    return a ? { kind: t.kind, id: t.id, label: (lang === 'en' ? 'Help: ' : 'ヘルプ：') + pick(a.title, lang) } : null;
  }
  const tips = tipsOf(m);
  const card = tips.config.enabled ? tips.tips.find((x) => x.id === t.id) : undefined;
  if (!card || (s && !openKeys(m, s, now)(card.unlock))) return null;
  return { kind: t.kind, id: t.id, label: (lang === 'en' ? 'Tip: ' : 'ヒント：') + pick(card.title, lang) };
}

const newestFirst = (a: ReleaseNote, b: ReleaseNote) => compareVersions(b.appVersion, a.appVersion);

export type ReleaseNotesReason = 'disabled' | 'unknown_version' | 'ftue' | 'new_install' | 'seen' | 'none';

/**
 * REQ-NEW-006..008: POST /v1/release-notes/check — the note to show now (or why not). Writes only during the FTUE
 * (the baseline moves up to the app's version). Never marks anything seen.
 */
export function checkReleaseNotes(m: Master, s: PlayerState, appVersion: string | null, lang: Locale, now: number, maxWhips = 6) {
  const r = releaseNotesOf(m);
  const v = appVersion && parseVersion(appVersion) ? appVersion.trim() : null;
  const base = { enabled: r.config.enabled, appVersion: v };
  const none = (reason: ReleaseNotesReason) => ({ ...base, reason, show: null });
  if (!r.config.enabled) return none('disabled');
  if (!v) return none('unknown_version');
  if (inFtue(m, s)) {
    const st = (s.releaseNotes ??= { seen: [] });
    if (!st.baseline || compareVersions(v, st.baseline) > 0) st.baseline = v;
    return none('ftue');
  }
  const st = s.releaseNotes;
  const seenTop = maxVersion(st?.seen ?? []);
  const upToApp = r.notes.filter((n) => compareVersions(n.appVersion, v) <= 0).sort(newestFirst);
  if (!upToApp.length) return none('none');
  const afterBaseline = upToApp.filter((n) => !st?.baseline || compareVersions(n.appVersion, st.baseline) > 0);
  const unseen = afterBaseline.filter((n) => seenTop === null || compareVersions(n.appVersion, seenTop) > 0);
  if (!unseen.length) return none(seenTop ? 'seen' : 'none');
  const eligible = unseen.filter((n) => s.createdAt < (releaseStartMs(n.releasedOn) ?? Infinity));
  if (!eligible.length) return none('new_install');
  const top = eligible[0]!;
  return {
    ...base, reason: null,
    show: {
      appVersion: top.appVersion, releasedOn: top.releasedOn,
      skipped: eligible.length - 1,
      hasPast: upToApp.length > 1,
      pages: top.pages.map((p) => pageView(m, s, p, lang, now, maxWhips)),
    },
  };
}

/** REQ-NEW-009: POST /v1/release-notes/seen — idempotent; an unknown version is 404 and nothing is recorded. */
export function markReleaseNotesSeen(m: Master, s: PlayerState, appVersion: string) {
  const r = releaseNotesOf(m);
  if (!r.config.enabled) throw new AppError('NOT_FOUND', 'release notes are not available');
  if (!r.notes.some((n) => n.appVersion === appVersion)) throw new AppError('NOT_FOUND', `release notes ${appVersion}`);
  const st = (s.releaseNotes ??= { seen: [] });
  const marked = !st.seen.includes(appVersion);
  if (marked) st.seen.push(appVersion);
  st.seen = st.seen.filter((x) => parseVersion(x)).sort(compareVersions).slice(-r.config.seenMax);
  return { marked, seen: [...st.seen] };
}

/** REQ-NEW-010: GET /v1/release-notes — the past notes up to the app's version (all without the header), newest first. */
export function releaseNotesHistory(m: Master, s: PlayerState | null, appVersion: string | null, lang: Locale, now: number, maxWhips = 6) {
  const r = releaseNotesOf(m);
  const v = appVersion && parseVersion(appVersion) ? appVersion.trim() : null;
  if (!r.config.enabled) return { enabled: false, appVersion: v, notes: [] };
  const seen = new Set(s?.releaseNotes?.seen ?? []);
  const notes = r.notes.filter((n) => !v || compareVersions(n.appVersion, v) <= 0).sort(newestFirst).slice(0, r.config.historyMax)
    .map((n) => ({ appVersion: n.appVersion, releasedOn: n.releasedOn, seen: seen.has(n.appVersion), pages: n.pages.map((p) => pageView(m, s, p, lang, now, maxWhips)) }));
  return { enabled: true, appVersion: v, notes };
}

/** REQ-NEW-016: the ops console preview — every note in both languages (tokens filled, target labels) and the problems. */
export function releaseNotesPreview(m: Master, r: ReleaseNotesMaster = releaseNotesOf(m), maxWhips = 6, now = Date.now()) {
  const problems = releaseNotesProblems(m, r, maxWhips);
  const withR: Master = { ...m, releaseNotes: r };
  const safe = <T>(f: () => T, d: T): T => { try { return f(); } catch { return d; } };
  const notes = (Array.isArray(r?.notes) ? [...r.notes] : []).filter((n) => n && parseVersion(n.appVersion)).sort(newestFirst).map((n) => ({
    appVersion: n.appVersion, releasedOn: n.releasedOn,
    pages: (Array.isArray(n.pages) ? n.pages : []).map((p, j) => ({
      index: j + 1, art: p?.art ?? null,
      ja: safe(() => pageView(withR, null, p, 'ja', now, maxWhips), null),
      en: safe(() => pageView(withR, null, p, 'en', now, maxWhips), null),
    })),
  }));
  return { ok: problems.length === 0, problems, enabled: !!r?.config?.enabled, notes };
}
