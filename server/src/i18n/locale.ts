/**
 * Localization (REQ-L10N-001..012, contracts/protocol.md §22). The server renders every player-facing text in
 * Japanese (the source language and the default); a request asking for English gets the same JSON with each text
 * translated at the response boundary from a validated string table (i18n/catalog.ts).
 *
 * Locale of a request: `?lang=` first, then `Accept-Language` (q-weighted, first supported tag wins), else `ja`.
 */
export const LOCALES = ['ja', 'en'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'ja';

/** `en`, `EN`, `en-US`, `en_GB` → `en`; anything unsupported → null. */
export function parseLocale(tag: string | null | undefined): Locale | null {
  if (!tag) return null;
  const base = tag.trim().toLowerCase().split(/[-_]/)[0];
  return (LOCALES as readonly string[]).includes(base ?? '') ? (base as Locale) : null;
}

/** RFC 9110 Accept-Language: highest q first (ties keep header order); `*` and q=0 never pick a language. */
export function localeFromAcceptLanguage(header: string | null | undefined): Locale | null {
  if (!header) return null;
  const tags = header.split(',').map((part, i) => {
    const [tag, ...params] = part.trim().split(';');
    const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
    const w = q ? Number(q.slice(2)) : 1;
    return { tag: tag ?? '', q: Number.isFinite(w) ? w : 0, i };
  }).filter((t) => t.q > 0 && t.tag !== '*').sort((a, b) => b.q - a.q || a.i - b.i);
  for (const t of tags) {
    const l = parseLocale(t.tag);
    if (l) return l;
  }
  return null;
}

export function resolveLocale(req: Request): Locale {
  const q = new URL(req.url).searchParams.get('lang');
  return parseLocale(q) ?? localeFromAcceptLanguage(req.headers.get('accept-language')) ?? DEFAULT_LOCALE;
}

/** Hiragana, katakana, CJK ideographs, CJK punctuation (「」、。) and full-width forms (（）＋！). */
export const JAPANESE_RE = /[　-ヿ㐀-䶿一-鿿＀-￯]/;
export const hasJapanese = (s: string) => JAPANESE_RE.test(s);
