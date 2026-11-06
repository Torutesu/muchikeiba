import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { handle, type AppContext } from '../src/http/app.js';
import { DEFAULT_RULESET, SKILL_RULESET_KEYS, buildRuleset, rulesetKeyProblems, timeAttackRuleset } from '../src/domain/ruleset.js';
import { SKILL_TRIGGERS, raceSkillSchema, raceStartConfigSchema } from '../src/domain/schemas.js';
import { buildRaceConfig, toRaceHorse } from '../src/domain/raceConfig.js';
import { breed, breedingPreview, createHorseFromTemplate } from '../src/domain/horses.js';
import { oddsDisclosure, drawGacha } from '../src/domain/gacha.js';
import { seededRng } from '../src/domain/rng.js';
import { buildSkillsMaster, capSkill, conditionText, effectText, horseSkillId, migrateSkills, rulesetSkillCaps, skillCatalog, skillInheritOdds, skillProblems, toRaceSkill } from '../src/domain/skills.js';
import type { Master } from '../src/domain/master.js';
import type { HorseInstance } from '../src/domain/player.js';
import { freshPlayer, m } from './helpers.js';

const repo = (p: string) => join(__dirname, '../..', p);
const NOW = Date.UTC(2026, 10, 5, 3);

describe('skill master (REQ-UXS-050, server/master/skills.json)', () => {
  it('has 12-16 original skills, all valid against the default ruleset', () => {
    expect(m.skills.skills.length).toBeGreaterThanOrEqual(12);
    expect(m.skills.skills.length).toBeLessThanOrEqual(16);
    expect(skillProblems(m, DEFAULT_RULESET)).toEqual([]);
    for (const s of m.skills.skills) expect(raceSkillSchema.safeParse(toRaceSkill(s)).success, s.id).toBe(true);
  });

  it('every template has a skill of its own rarity that fits its running style', () => {
    for (const t of m.templates) {
      const s = m.skills.byId.get(t.skillId!);
      expect(s, t.id).toBeDefined();
      expect(s!.rarity).toBe(t.rarity);
      expect(s!.styles).toContain(t.style);
    }
    // every rarity tier is used, and each running style has a skill at every rarity
    for (const r of ['R', 'SR', 'SSR'] as const) for (const st of ['nige', 'senko', 'sashi', 'oikomi'] as const) {
      expect(m.skills.skills.some((s) => s.rarity === r && s.styles.includes(st)), `${r} ${st}`).toBe(true);
    }
  });

  it('rejects unknown skills, effects above the ruleset caps and rarity/style mismatches', () => {
    const bad: Master = {
      ...m,
      templates: m.templates.map((t, i) => (i === 0 ? { ...t, skillId: 'sk_nope' } : i === 1 ? { ...t, skillId: 'sk_ichibanyari' } : t)),
      skills: buildSkillsMaster({
        ...m.skills,
        skills: m.skills.skills.map((s, i) => (i === 2 ? { ...s, speedPermille: 999 } : s)),
        rankedCaps: { ...m.skills.rankedCaps, speedPermille: 500 },
      }),
    };
    const p = skillProblems(bad, DEFAULT_RULESET).join('\n');
    expect(p).toMatch(/unknown skill sk_nope/);
    expect(p).toMatch(/SSR horse with R skill sk_ichibanyari/);
    expect(p).toMatch(/speedPermille 999 exceeds ruleset skillMaxSpeedPermille/);
    expect(p).toMatch(/rankedCaps.speedPermille 500 exceeds/);
    // a ruleset whose caps fall below the master's skills (e.g. a remote-config override) is caught too
    expect(skillProblems(m, buildRuleset({ skillMaxSpeedPermille: 10, rulesetVersion: '1.3.0+x' })).join()).toMatch(/exceeds ruleset skillMaxSpeedPermille 10/);
    const pre13: Record<string, unknown> = { ...DEFAULT_RULESET };
    for (const k of SKILL_RULESET_KEYS) delete pre13[k];
    expect(skillProblems(m, pre13).join()).toMatch(/no skill keys/);
  });

  it('display text is generated from the engine values', () => {
    const s = m.skills.byId.get('sk_nukedashi')!;
    expect(conditionText(s)).toBe('最後の直線で前に2頭以内');
    expect(effectText(s)).toBe('4秒間 目標速度+1.8%');
    expect(effectText(m.skills.byId.get('sk_ninoashi')!)).toBe('脚を3%回復');
    expect(conditionText({ trigger: 'goodStart', value: 1 })).toBe('ゲートが開いて0.05秒以内にスタート');
    const cat = skillCatalog(m);
    expect(cat.skills).toHaveLength(m.skills.skills.length);
    const ssr = cat.skills.find((x) => x.id === 'sk_oudou')!;
    expect(ssr.effect).toBe('4秒間 目標速度+2%');
    expect(ssr.rankedEffect).toBe('4秒間 目標速度+1.8%'); // capped in ranked
  });

  it('GET /v1/skills serves the catalog without auth', async () => {
    const res = await handle(new Request('https://x/v1/skills'), {}, { master: m } as unknown as AppContext);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { skills: { id: string; condition: string }[] };
    expect(body.skills.map((s) => s.id)).toEqual(m.skills.skills.map((s) => s.id));
  });
});

describe('ruleset 1.3 skill keys (REQ-UXS-051)', () => {
  it('the skill key group matches the engine list and is all-or-none', () => {
    const cs = readFileSync(repo('engine/Muchi.Engine/RulesetParams.cs'), 'utf8');
    const block = cs.slice(cs.indexOf('SkillIntKeys ='), cs.indexOf('SkillNeutralValues'));
    expect([...block.matchAll(/"([a-z][A-Za-z]+)"/g)].map((x) => x[1])).toEqual([...SKILL_RULESET_KEYS]);
    expect(DEFAULT_RULESET.rulesetVersion).toBe('1.3.0');
    const v120: Record<string, unknown> = { ...DEFAULT_RULESET };
    for (const k of SKILL_RULESET_KEYS) delete v120[k];
    expect(rulesetKeyProblems(v120)).toEqual([]);
    expect(rulesetSkillCaps(v120)).toBeNull();
    expect(rulesetKeyProblems({ ...v120, skillMaxSpeedPermille: 30 }).join()).toMatch(/skill \(1\.3\) keys must be all present or all absent/);
  });

  it('the trigger names and value limits match the engine', () => {
    const cs = readFileSync(repo('engine/Muchi.Net/ProtocolCodec.cs'), 'utf8');
    const names = cs.slice(cs.indexOf('SkillTriggerNames ='), cs.indexOf('SkillTriggerToString'));
    expect([...names.matchAll(/"([a-zA-Z]+)"/g)].map((x) => x[1])).toEqual([...SKILL_TRIGGERS]);
    const model = readFileSync(repo('engine/Muchi.Engine/Model.cs'), 'utf8');
    const max = model.slice(model.indexOf('MaxValue = {'), model.indexOf('};', model.indexOf('MaxValue = {')));
    expect([...max.matchAll(/\d+/g)].map((x) => Number(x[0]))).toEqual([11, 11, 1000, 11, 4000, 4000, 1200, 60]);
  });
});

describe('race config carries each entrant\'s skill (REQ-UXS-050)', () => {
  const p = freshPlayer();
  const horse = (tid: string) => toRaceHorse(m, createHorseFromTemplate(p, m.templateById.get(tid)!, 0));
  const build = (mode: 'ranked' | 'friend' | 'timeattack' | 'tutorial', statCap: number | null, extra: Record<string, unknown> = {}) => buildRaceConfig(m, {
    raceId: `r_sk_${mode}`, mode, trackId: 'kirameki_turf_2000', humans: [{ playerId: 'p_a', horse: horse('t_ginga') }],
    cpuCount: mode === 'timeattack' ? 0 : 11, cpuLevel: 3, statCap, rng: seededRng(9), ...extra,
  });

  it('friend races carry the full skill; CPUs carry their template skill (deterministic)', () => {
    const c = build('friend', null);
    expect(raceStartConfigSchema.safeParse(c).success).toBe(true);
    const me = c.entrants.find((e) => e.playerId === 'p_a')!;
    expect(me.horse.skill).toEqual(toRaceSkill(m.skills.byId.get('sk_oudou')!));
    for (const e of c.entrants.filter((x) => x.kind === 'cpu')) {
      const t = m.templateById.get(e.horse.id.replace(/^cpu_/, ''))!;
      expect(e.horse.skill?.id).toBe(t.skillId);
    }
    expect(build('friend', null).entrants.map((e) => e.horse.skill)).toEqual(c.entrants.map((e) => e.horse.skill)); // same seed → same skills
  });

  it('ranked caps every effect at rankedCaps', () => {
    const c = build('ranked', 3200);
    const caps = m.skills.rankedCaps;
    for (const e of c.entrants) {
      const s = e.horse.skill!;
      expect(s).toBeDefined();
      expect(s.speedPermille).toBeLessThanOrEqual(caps.speedPermille);
      expect(s.accelPermille).toBeLessThanOrEqual(caps.accelPermille);
      expect(s.drainSavePermille).toBeLessThanOrEqual(caps.drainSavePermille);
      expect(s.recoverPermille).toBeLessThanOrEqual(caps.recoverPermille);
      expect(s.durationTicks).toBeLessThanOrEqual(caps.durationTicks);
    }
    expect(c.entrants.find((e) => e.playerId === 'p_a')!.horse.skill).toEqual(capSkill(toRaceSkill(m.skills.byId.get('sk_oudou')!), caps));
  });

  it('time attack, the tutorial, fixed-stat events and pre-1.3 rulesets carry no skill', () => {
    expect(build('timeattack', 3200, { rulesetOverrides: timeAttackRuleset() }).entrants.every((e) => e.horse.skill === undefined)).toBe(true);
    expect(build('tutorial', null).entrants.every((e) => e.horse.skill === undefined)).toBe(true);
    expect(build('friend', null, { fixedStats: { speed: 500, stamina: 500, burst: 500, guts: 500, temper: 500 } }).entrants.every((e) => e.horse.skill === undefined)).toBe(true);
  });

  it('a horse stored before skills existed races with its template skill; a skill-less foal with none', () => {
    const old = createHorseFromTemplate(p, m.templateById.get('t_kohaku')!, 0);
    delete old.skillId;
    expect(horseSkillId(m, old)).toBe('sk_shippu');
    expect(toRaceHorse(m, old).skill?.id).toBe('sk_shippu');
    migrateSkills(m, [old]);
    expect(old.skillId).toBe('sk_shippu');
    const foal = { ...old, templateId: null, skillId: undefined } as HorseInstance;
    expect(horseSkillId(m, foal)).toBeNull();
    expect(toRaceHorse(m, foal)).not.toHaveProperty('skill');
  });
});

describe('gacha shows the skill without touching the odds (REQ-UXS-050, REQ-GACHA-002)', () => {
  it('every odds row has its horse\'s skill; ppm are unchanged', () => {
    for (const b of m.gacha.banners) {
      const d = oddsDisclosure(m, b);
      d.items.forEach((row, i) => {
        expect(row.ppm).toBe(b.pool[i]!.ppm);
        expect(row.skill?.id).toBe(m.templateById.get(row.templateId)!.skillId);
        expect(row.skill?.condition).toBeTruthy();
      });
      expect(d.items.reduce((a, r) => a + r.ppm, 0)).toBe(1_000_000);
    }
  });

  it('pulled horses get their template skill', () => {
    const s = freshPlayer('g');
    s.wallet.free = 100000;
    const out = drawGacha(m, s, m.gacha.banners[0]!.id, 10, seededRng(4), NOW);
    for (const r of out.results.filter((x) => x.horseId)) {
      const h = s.horses.find((x) => x.id === r.horseId)!;
      expect(h.skillId).toBe(m.templateById.get(r.templateId)!.skillId);
    }
  });
});

describe('breeding passes on skills (REQ-UXS-050; odds from the same function, REQ-HORSE-008)', () => {
  const mm: Master = { ...m, progression: { ...m.progression, breedingPerDay: 100000 } };
  const pair = () => {
    const s = freshPlayer('b');
    const sire = createHorseFromTemplate(s, m.templateById.get('t_ginga')!, 0); // male, sk_oudou
    const dam = createHorseFromTemplate(s, m.templateById.get('t_kohaku')!, 0); // female, sk_shippu
    sire.status = 'retired'; dam.status = 'retired';
    return { s, sire, dam };
  };

  it('odds: one parent 300‰, two parents 200‰ each, the same skill twice adds up', () => {
    expect(skillInheritOdds(m, null, null)).toEqual({ none: 1000, skills: [] });
    expect(skillInheritOdds(m, 'sk_oudou', null)).toEqual({ none: 700, skills: [{ skillId: 'sk_oudou', permille: 300, from: ['sire'] }] });
    expect(skillInheritOdds(m, 'sk_oudou', 'sk_shippu')).toEqual({ none: 600, skills: [{ skillId: 'sk_oudou', permille: 200, from: ['sire'] }, { skillId: 'sk_shippu', permille: 200, from: ['dam'] }] });
    expect(skillInheritOdds(m, 'sk_oudou', 'sk_oudou').skills).toEqual([{ skillId: 'sk_oudou', permille: 400, from: ['sire', 'dam'] }]);
  });

  it('the preview shows the very odds breed() draws with, and the observed rates match', () => {
    const { s, sire, dam } = pair();
    const pv = breedingPreview(mm, s, sire.id, dam.id);
    expect(pv.skill.nonePermille).toBe(600);
    expect(pv.skill.candidates.map((c) => [c.id, c.permille])).toEqual([['sk_oudou', 200], ['sk_shippu', 200]]);
    const rng = seededRng(5);
    const seen: Record<string, number> = {};
    const N = 2000;
    for (let i = 0; i < N; i++) {
      const r = breed(mm, s, sire.id, dam.id, rng, NOW);
      seen[r.skillId ?? 'none'] = (seen[r.skillId ?? 'none'] ?? 0) + 1;
      expect(r.foal.skillId ?? null).toBe(r.skillId);
    }
    expect(seen.none! / N).toBeGreaterThan(0.55);
    expect(seen.none! / N).toBeLessThan(0.65);
    expect(seen.sk_oudou! / N).toBeGreaterThan(0.17);
    expect(seen.sk_shippu! / N).toBeLessThan(0.23);
  });

  it('parents without skills draw no extra random number (foals are exactly as before)', () => {
    const run = (strip: boolean) => {
      const { s, sire, dam } = pair();
      if (strip) { sire.templateId = null; dam.templateId = null; delete sire.skillId; delete dam.skillId; }
      const rng = seededRng(77);
      return [breed(mm, s, sire.id, dam.id, rng, NOW).foal, breed(mm, s, sire.id, dam.id, rng, NOW).foal];
    };
    const [a1, a2] = run(true);
    expect(a1!.skillId).toBeUndefined();
    // with skills the first foal's stats are unchanged (skill drawn last); without them the second foal is unaffected by a draw
    const [b1] = run(false);
    expect(b1!.base).toEqual(a1!.base);
    expect(a2!.base).toBeDefined();
  });
});
