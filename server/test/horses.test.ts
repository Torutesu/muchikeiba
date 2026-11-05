import { describe, expect, it } from 'vitest';
import { awaken, breed, breedingPreview, createHorseFromTemplate, effectiveStats, foldForCompare, inbreedingCount, isNick, nameHorse, normalizeName, pedigree, retire, validateName } from '../src/domain/horses.js';
import { STAT_KEYS } from '../src/domain/master.js';
import { seededRng } from '../src/domain/rng.js';
import { freshPlayer, m } from './helpers.js';
import type { AppError } from '../src/domain/errors.js';

const NOW = Date.UTC(2026, 10, 5, 3);
const code = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as AppError).code; } return 'NO_ERROR'; };
const tpl = (id: string) => m.templateById.get(id)!;

describe('naming (REQ-HORSE-003)', () => {
  it('normalizes hiragana, half-width and long-vowel variants', () => {
    expect(normalizeName('しんせい あかつき')).toBe('シンセイアカツキ');
    expect(normalizeName('ｼﾝｾｲｱｶﾂｷ')).toBe('シンセイアカツキ');
    expect(normalizeName('ハヤテ-マル')).toBe('ハヤテーマル');
    expect(foldForCompare('ディープ')).toBe(foldForCompare('デイプ'));
  });
  it('accepts katakana 2-9, rejects others', () => {
    expect(validateName(m, 'あおぞら')).toBe('アオゾラ');
    for (const bad of ['ア', 'アイウエオカキクケコ', 'Sky', 'アオ空', 'ーアオ', '']) expect(code(() => validateName(m, bad))).toBe('INVALID_NAME');
  });
  it('rejects NG names after normalization (exact and contains)', () => {
    expect(code(() => validateName(m, 'でぃーぷいんぱくと'))).toBe('NG_NAME');
    expect(code(() => validateName(m, 'ﾃﾞｨｰﾌﾟｲﾝﾊﾟｸﾄ'))).toBe('NG_NAME');
    expect(code(() => validateName(m, 'ダービーオー'))).toBe('NG_NAME');
    expect(code(() => validateName(m, 'ダ-ビ-キング'))).toBe('NG_NAME');
    expect(validateName(m, 'ディープブルー')).toBe('ディープブルー'); // only exact match for horse names
  });
  it('names an owned horse', () => {
    const s = freshPlayer();
    const h = createHorseFromTemplate(s, tpl('t_natsu'), NOW);
    expect(nameHorse(m, s, h.id, 'はやてのつばさ')).toMatchObject({ name: 'ハヤテノツバサ', named: true });
  });
});

describe('awakening & retirement', () => {
  it('raises stats per level, consumes material, caps at max', () => {
    const s = freshPlayer();
    const h = createHorseFromTemplate(s, tpl('t_natsu'), NOW);
    const before = effectiveStats(m, h);
    expect(code(() => awaken(m, s, h.id))).toBe('INSUFFICIENT_COINS');
    s.materials.awakening = 1000;
    awaken(m, s, h.id);
    expect(effectiveStats(m, h).speed).toBe(Math.floor((before.speed * 1040) / 1000));
    for (let i = 1; i < 5; i++) awaken(m, s, h.id);
    expect(code(() => awaken(m, s, h.id))).toBe('AWAKENING_MAX');
    expect(s.materials.awakening).toBe(1000 - 155);
    for (const k of STAT_KEYS) expect(effectiveStats(m, h)[k]).toBeLessThanOrEqual(1000);
  });
  it('retires once', () => {
    const s = freshPlayer();
    const h = createHorseFromTemplate(s, tpl('t_natsu'), NOW);
    retire(s, h.id);
    expect(code(() => retire(s, h.id))).toBe('HORSE_NOT_ACTIVE');
  });
});

describe('breeding (REQ-HORSE-005..008)', () => {
  const setup = () => {
    const s = freshPlayer();
    const sire = createHorseFromTemplate(s, tpl('t_akatsuki'), NOW); // line akatsuki, male
    const dam = createHorseFromTemplate(s, tpl('t_tsukikage'), NOW); // line minamo, female
    retire(s, sire.id);
    retire(s, dam.id);
    return { s, sire, dam };
  };
  it('validates the pair', () => {
    const s = freshPlayer();
    const a = createHorseFromTemplate(s, tpl('t_akatsuki'), NOW);
    const b = createHorseFromTemplate(s, tpl('t_tsukikage'), NOW);
    expect(code(() => breed(m, s, a.id, b.id, seededRng(1), NOW))).toBe('HORSE_NOT_RETIRED');
    retire(s, a.id); retire(s, b.id);
    expect(code(() => breed(m, s, b.id, a.id, seededRng(1), NOW))).toBe('BREEDING_INVALID_PAIR');
    expect(code(() => breed(m, s, 'x', a.id, seededRng(1), NOW))).toBe('HORSE_NOT_FOUND');
  });
  it('produces a foal within the previewed ranges, with nick and pedigree, once per JST day', () => {
    const { s, sire, dam } = setup();
    expect(isNick(m, sire, dam)).toBe(true);
    const p = breedingPreview(m, s, sire.id, dam.id);
    expect(p.nick).toBe(true);
    const { foal } = breed(m, s, sire.id, dam.id, seededRng(3), NOW);
    for (const k of STAT_KEYS) {
      expect(foal.base[k]).toBeGreaterThanOrEqual(p.stats[k].min);
      expect(foal.base[k]).toBeLessThanOrEqual(p.stats[k].max);
    }
    expect(foal.distMinM).toBeGreaterThanOrEqual(p.distance.minM);
    expect(foal.distMaxM).toBeLessThanOrEqual(p.distance.maxM + 200);
    expect(foal).toMatchObject({ sireId: sire.id, damId: dam.id, status: 'active', templateId: null });
    expect(code(() => breed(m, s, sire.id, dam.id, seededRng(3), NOW))).toBe('BREEDING_DAILY_LIMIT');
    expect(() => breed(m, s, sire.id, dam.id, seededRng(3), NOW + 86400000)).not.toThrow();
  });
  it('preview ranges hold over many seeds', () => {
    for (let seed = 0; seed < 200; seed++) {
      const { s, sire, dam } = setup();
      const p = breedingPreview(m, s, sire.id, dam.id);
      const { foal } = breed(m, s, sire.id, dam.id, seededRng(seed), NOW);
      for (const k of STAT_KEYS) expect(foal.base[k] >= p.stats[k].min && foal.base[k] <= p.stats[k].max).toBe(true);
      expect(Object.keys(p.styles)).toContain(foal.style);
    }
  });
  it('builds a 5-generation pedigree and penalizes close inbreeding', () => {
    const { s, sire, dam } = setup();
    // generation chain: foal -> retire -> breed back with its sire
    let mother = dam;
    for (let g = 0; g < 5; g++) {
      const { foal } = breed(m, s, sire.id, mother.id, seededRng(g), NOW + g * 86400000);
      foal.sex = 'female';
      retire(s, foal.id);
      mother = foal;
    }
    const tree = pedigree(s, mother.id);
    let depth = 0;
    for (let n: typeof tree | null = tree; n; n = n.dam) depth++;
    expect(depth).toBe(1 + 5); // the horse + exactly 5 generations (deeper ancestors exist but are cut)
    expect(inbreedingCount(s, sire, mother)).toBeGreaterThan(0);
    const fresh = setup();
    expect(inbreedingCount(fresh.s, fresh.sire, fresh.dam)).toBe(0);
    const inbredPreview = breedingPreview(m, s, sire.id, mother.id);
    expect(inbredPreview.inbreedingCount).toBeGreaterThan(0);
  });
});
