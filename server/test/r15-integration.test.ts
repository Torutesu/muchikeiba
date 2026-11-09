/**
 * Round 15 integration: how the four Round 15 features (§38 photo mode, §39 pre-race advice, §40 activity, §41
 * accessibility) meet Round 14 (§34..§37) and each other.
 */
import { describe, expect, it } from 'vitest';
import { BETTING_WORDS_EN, BETTING_WORDS_JA } from '../src/domain/bettingWords.js';
import * as packs from '../src/domain/commentaryPacks.js';
import { adviceTextProblems } from '../src/domain/raceAdvice.js';

// ------------------------------------------------------------------------------------------------ §39 × §36

describe('§39 advice lint × §36 commentary lint: one betting-word list (REQ-ADV-004, REQ-CMT-004)', () => {
  it('the commentary lint reads the shared list (the same arrays, not a copy)', () => {
    expect(packs.BETTING_WORDS_JA).toBe(BETTING_WORDS_JA);
    expect(packs.BETTING_WORDS_EN).toBe(BETTING_WORDS_EN);
  });
  it('the advice lint refuses every shared betting word, Japanese and English', () => {
    for (const w of BETTING_WORDS_JA) expect(adviceTextProblems(`この馬は${w}`).length, w).toBeGreaterThan(0);
    for (const s of ['place a bet', 'betting tips', 'the bettor', 'good odds', 'a wager', 'payout', 'gambling', 'jackpot', 'bookmaker', 'punters', 'trifecta', 'each-way', 'the favourites', 'long shots', 'stake money']) {
      expect(adviceTextProblems(s).length, s).toBeGreaterThan(0);
      expect(packs.commentaryTextProblems(s, 'en').some((x) => x.startsWith('betting word')), s).toBe(true);
    }
  });
  it('the \\bbet fix holds in both lints: better / between / alphabet / Betty are not betting words', () => {
    for (const s of ['a better line', 'between the horses', 'alphabet', 'Betty runs']) {
      expect(adviceTextProblems(s), s).toEqual([]);
      expect(packs.commentaryTextProblems(s, 'en').filter((x) => x.startsWith('betting word')), s).toEqual([]);
    }
  });
});
