/**
 * Betting words of 公営競技 (horse racing betting): the game must never read like wagering (docs/planning/03).
 * One list for every generated-text lint — the commentary packs (§36, commentaryPacks.ts) and the pre-race advice
 * (§39, raceAdvice.ts) both read these arrays, so a word added here is refused everywhere at once.
 *
 * Japanese entries are substrings: 「儲」 covers 儲かる / 儲け and 「賭」 covers 賭け / 賭博. English entries are word-bounded
 * patterns: `\bbet(s|ting|tor)?\b` refuses "bet" / "betting" but never "better", "between" or "alphabet".
 */
export const BETTING_WORDS_JA: readonly string[] = [
  '馬券', 'オッズ', '配当', '払い戻し', '払戻', '的中', '万馬券', '儲', '賭', '単勝', '複勝', '馬連', '馬単', '三連単', '三連複', '3連単', '3連複',
  '枠連', 'ワイド', '投票券', '予想屋', 'ギャンブル', '本命', '大穴', '穴馬',
];
export const BETTING_WORDS_EN: readonly RegExp[] = [
  /\bbet(s|ting|tor)?\b/i, /\bodds\b/i, /\bwager/i, /\bpay-?outs?\b/i, /\bgambl/i, /\bjackpot/i, /\bbookmaker/i, /\bbookies?\b/i,
  /\bpunters?\b/i, /\btrifecta/i, /\bexacta/i, /\bquinella/i, /\beach[- ]way\b/i, /\bfavou?rites?\b/i, /\blong ?shots?\b/i, /\bstakes? money\b/i,
];

/** The betting words found in one text (Japanese substrings and English patterns; empty = clean). */
export function bettingWordsIn(text: string): string[] {
  return [...BETTING_WORDS_JA.filter((w) => text.includes(w)), ...BETTING_WORDS_EN.filter((re) => re.test(text)).map((re) => re.source)];
}
