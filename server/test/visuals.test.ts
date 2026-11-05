import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { m } from './helpers.js';
import { seededRng } from '../src/domain/rng.js';
import {
  ASSET_KEY_RE, ASSET_KINDS, VISUALS, appearanceOf, assetKeys, bracketOf, collectItemIds, defaultEmblem, defaultSilks, deriveAppearance,
  fallbackKey, fnv1a64Hex, inheritAppearance, kindOf, startVisuals, templateAppearance, trackVisual, validateEmblem, validateSilks, visualsCatalog,
  visualsProblems, type Appearance, type VisualsMaster,
} from '../src/domain/visuals.js';
import { buildAssetManifest, manifestProblems, phraseClipIds, type AssetManifest, type CommentaryJson } from '../src/domain/assetManifest.js';
import { COMMENTARY_PATH, MANIFEST_PATH, renderManifest } from '../scripts/gen-assets.js';
import { breed, createHorseFromTemplate, retire } from '../src/domain/horses.js';
import { migratePlayer, newPlayer } from '../src/domain/player.js';
import { buildRaceConfig } from '../src/domain/raceConfig.js';
import { toRaceHorse } from '../src/domain/raceConfig.js';
import { RaceRoomCore } from '../src/domain/raceRoom.js';

const commentary = JSON.parse(readFileSync(COMMENTARY_PATH, 'utf8')) as CommentaryJson;

describe('visual catalog (master/visuals.json)', () => {
  it('is consistent with the rest of the master data', () => {
    expect(visualsProblems(m)).toEqual([]);
  });

  it('catches broken entries', () => {
    const v = structuredClone(VISUALS) as VisualsMaster;
    v.horse.templates.t_akatsuki = { ...v.horse.templates.t_akatsuki!, coat: 'purple_unicorn' };
    delete v.tracks.aoba_turf_1600;
    v.palette.push({ id: 'red', hex: '#ff0000' });
    const p = visualsProblems(m, v).join('\n');
    expect(p).toMatch(/unknown coat purple_unicorn/);
    expect(p).toMatch(/aoba_turf_1600: no venue/);
    expect(p).toMatch(/duplicate palette ids/);
    expect(p).toMatch(/hex must be/);
  });

  it('public catalog lists every track with venue/direction and every template look', () => {
    const c = visualsCatalog(m);
    expect(c.tracks).toHaveLength(m.tracks.length);
    expect(c.tracks.find((t) => t.trackId === 'kirameki_turf_2000')!.direction).toBe('right');
    for (const t of m.templates) expect(c.templates[t.id]!.appearance).not.toBeNull();
  });
});

describe('asset keys and manifest (contracts/assets.manifest.json)', () => {
  it('the committed manifest is exactly what the generator produces (run npm run gen:assets)', () => {
    expect(readFileSync(MANIFEST_PATH, 'utf8')).toBe(renderManifest());
  });

  it('every key is well formed, of a known kind, and every kind has its fallback', () => {
    const man = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as AssetManifest;
    expect(manifestProblems(man)).toEqual([]);
    for (const kind of Object.keys(ASSET_KINDS)) expect(man.keys).toContain(fallbackKey(kind));
  });

  it('every key master data can produce is in the manifest', () => {
    const keys = new Set((JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as AssetManifest).keys);
    const expected: string[] = [
      ...collectItemIds(m).map(assetKeys.item), ...m.titles.map((t) => assetKeys.title(t.id)),
      ...m.gacha.banners.map((b) => assetKeys.gachaBanner(b.id)), ...m.events.map((e) => assetKeys.eventBanner(e.id)),
      ...m.templates.map((t) => assetKeys.voiceName(t.name)),
    ];
    for (const t of m.templates) {
      const a = templateAppearance(t.id)!;
      expected.push(assetKeys.coat(a.coat), assetKeys.face(a.face), assetKeys.mane(a.mane), assetKeys.build(a.build), ...a.legs.map(assetKeys.leg));
    }
    for (const t of m.tracks) {
      const tv = trackVisual({ ...t, going: t.surface === 'dirt' ? 'sloppy' : 'soft', night: m.litTracks.has(t.id) });
      expected.push(tv.keys.venue, tv.keys.surface, ...(tv.keys.night ? [tv.keys.night] : []), tv.keys.going!);
    }
    for (const k of expected) expect(keys.has(k), k).toBe(true);
    // a master entry without a manifest key fails the drift check
    const m2 = { ...m, titles: [...m.titles, { id: 'brand_new_title', name: 'x', condition: { kind: 'races', value: 1 } }] } as typeof m;
    expect(buildAssetManifest(m2, commentary).keys).toContain('title/brand_new_title');
    expect(keys.has('title/brand_new_title')).toBe(false);
  });

  it('key rules', () => {
    expect(ASSET_KEY_RE.test('horse/coat/bay')).toBe(true);
    expect(ASSET_KEY_RE.test('scene/venue/aoba@v2')).toBe(true);
    expect(ASSET_KEY_RE.test('Horse/coat/bay')).toBe(false);
    expect(ASSET_KEY_RE.test('coat')).toBe(false);
    expect(ASSET_KEY_RE.test('horse/coat/bay-2')).toBe(false);
    expect(kindOf('scene/venue/aoba@v2')).toBe('scene/venue');
    expect(phraseClipIds('good_start_1', '{name}、好スタート！')).toEqual(['good_start_1#0']);
    expect(phraseClipIds('x', 'A{name}B{place}C')).toEqual(['x#0', 'x#1', 'x#2']);
    expect(assetKeys.voicePhrase('gate_open_1#0')).toBe('voice/ja/phrase/gate_open_1_p0');
    // same FNV-1a 64 as Muchi.Engine.Fnv1a64 (offset basis for the empty string)
    expect(fnv1a64Hex('')).toBe('cbf29ce484222325');
    expect(fnv1a64Hex('a')).toBe('af63dc4c8601ec8c');
  });
});

describe('appearance', () => {
  it('template horses get their template look; derived looks are stable and valid', () => {
    const s = newPlayer('p1', 0, '2026-11');
    const h = createHorseFromTemplate(s, m.templateById.get('t_akatsuki')!, 0);
    expect(h.appearance).toEqual(templateAppearance('t_akatsuki'));
    const a = deriveAppearance('p1:h9');
    expect(deriveAppearance('p1:h9')).toEqual(a);
    expect(VISUALS.horse.coats.map((c) => c.id)).toContain(a.coat);
    expect(a.legs).toHaveLength(4);
  });

  it('older saves get a look on load (migration) and keep it', () => {
    const s = newPlayer('p2', 0, '2026-11');
    const h = createHorseFromTemplate(s, m.templateById.get('t_yukimi')!, 0);
    delete h.appearance;
    delete (s.profile as { silks?: unknown }).silks;
    migratePlayer(s);
    expect(s.horses[0]!.appearance).toEqual(templateAppearance('t_yukimi'));
    expect(s.profile.silks).toEqual(defaultSilks('p:p2'));
    expect(appearanceOf({ id: 'h5', templateId: null }, 'p2')).toEqual(deriveAppearance('p2:h5'));
  });

  it('foals inherit each trait from a parent (with rare mutation), deterministically per RNG', () => {
    const sire: Appearance = { coat: 'chestnut', face: 'blaze', legs: ['sock', 'none', 'sock', 'none'], mane: 'flaxen', build: 'rangy' };
    const dam: Appearance = { coat: 'bay', face: 'none', legs: ['none', 'none', 'none', 'stocking'], mane: 'normal', build: 'compact' };
    const noMut = structuredClone(VISUALS) as VisualsMaster;
    noMut.horse.inheritance.mutationPermille = 0;
    for (let seed = 1; seed < 200; seed++) {
      const f = inheritAppearance(sire, dam, seededRng(seed), noMut);
      expect([sire.coat, dam.coat]).toContain(f.coat);
      expect([sire.face, dam.face]).toContain(f.face);
      f.legs.forEach((l, i) => expect([sire.legs[i], dam.legs[i]]).toContain(l));
      expect(inheritAppearance(sire, dam, seededRng(seed), noMut)).toEqual(f);
    }
    // gray parent passes gray about half the time
    const gray = { ...sire, coat: 'gray' };
    let grays = 0;
    for (let seed = 1; seed <= 400; seed++) if (inheritAppearance(gray, dam, seededRng(seed), noMut).coat === 'gray') grays++;
    expect(grays).toBeGreaterThan(140);
    expect(grays).toBeLessThan(260);
  });

  it('breeding stores an inherited look and leaves the other breeding outcomes unchanged', () => {
    const mk = () => {
      const s = newPlayer('p3', 0, '2026-11');
      const a = createHorseFromTemplate(s, m.templateById.get('t_akatsuki')!, 0);
      const b = createHorseFromTemplate(s, m.templateById.get('t_kohaku')!, 0);
      retire(s, a.id); retire(s, b.id);
      return { s, a, b };
    };
    const x = mk();
    const r = breed(m, x.s, x.a.id, x.b.id, seededRng(42), Date.UTC(2026, 10, 5));
    expect(r.foal.appearance).toBeDefined();
    // the look is drawn after all other rolls: without it the stats would be identical
    const y = mk();
    const r2 = breed(m, y.s, y.a.id, y.b.id, seededRng(42), Date.UTC(2026, 10, 5));
    expect(r2.foal.base).toEqual(r.foal.base);
    expect(r2.foal.appearance).toEqual(r.foal.appearance);
  });
});

describe('silks and emblems', () => {
  it('validates pattern, colour count, palette, caps, unlock items and the banned list', () => {
    expect(validateSilks({ pattern: 'hoops', colors: ['red', 'white'], cap: 'plain' }, {})).toEqual({ pattern: 'hoops', colors: ['red', 'white'], cap: 'plain' });
    expect(() => validateSilks({ pattern: 'nope', colors: ['red', 'white'], cap: 'plain' }, {})).toThrow(/unknown silks pattern/);
    expect(() => validateSilks({ pattern: 'hoops', colors: ['red'], cap: 'plain' }, {})).toThrow(/takes 2/);
    expect(() => validateSilks({ pattern: 'hoops', colors: ['red', 'red'], cap: 'plain' }, {})).toThrow(/two different/);
    expect(() => validateSilks({ pattern: 'hoops', colors: ['red', 'fuchsia'], cap: 'plain' }, {})).toThrow(/unknown colour/);
    expect(() => validateSilks({ pattern: 'hoops', colors: ['red', 'white'], cap: 'tophat' }, {})).toThrow(/unknown cap/);
    expect(() => validateSilks({ pattern: 'lightning', colors: ['red', 'white', 'gold'], cap: 'plain' }, {})).toThrow(/needs item costume_starter/);
    expect(validateSilks({ pattern: 'lightning', colors: ['red', 'white', 'gold'], cap: 'plain' }, { costume_starter: 1 }).pattern).toBe('lightning');
    const v = structuredClone(VISUALS) as VisualsMaster;
    v.silks.banned.push({ pattern: 'hoops', colors: ['red', 'white'] });
    expect(() => validateSilks({ pattern: 'hoops', colors: ['red', 'white'], cap: 'star' }, {}, v)).toThrow(/reserved/);
    expect(validateSilks({ pattern: 'hoops', colors: ['white', 'red'], cap: 'star' }, {}, v).colors).toEqual(['white', 'red']);
  });

  it('default silks are free, valid and never banned', () => {
    for (let i = 0; i < 200; i++) {
      const s = defaultSilks(`p:${i}`);
      expect(() => validateSilks(s, {})).not.toThrow();
    }
  });

  it('emblems', () => {
    const e = defaultEmblem('t123');
    expect(validateEmblem(e)).toEqual(e);
    expect(() => validateEmblem({ ...e, shape: 'triangle' })).toThrow(/shape/);
    expect(() => validateEmblem({ ...e, colors: ['red', 'red'] })).toThrow(/different/);
  });
});

describe('race visuals (start message)', () => {
  it('gate brackets follow the 8-bracket rule', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8].map((g) => bracketOf(g, 8))).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(Array.from({ length: 12 }, (_, i) => bracketOf(i + 1, 12))).toEqual([1, 2, 3, 4, 5, 5, 6, 6, 7, 7, 8, 8]);
    expect(Array.from({ length: 10 }, (_, i) => bracketOf(i + 1, 10))).toEqual([1, 2, 3, 4, 5, 6, 7, 7, 8, 8]);
    expect(bracketOf(3, 5)).toBe(3);
  });

  it('every entrant gets a look; humans use their own; the config (and its hash) is untouched', () => {
    const s = newPlayer('alice', 0, '2026-11');
    const h = createHorseFromTemplate(s, m.templateById.get('t_akatsuki')!, 0);
    const config = buildRaceConfig(m, {
      raceId: 'r_vis', mode: 'ranked', trackId: 'minato_turf_2400', statCap: null, cpuCount: 11, cpuLevel: 3, rng: seededRng(5),
      humans: [{ playerId: 'alice', horse: toRaceHorse(m, h) }], ground: { going: 'soft', night: true },
    });
    const before = JSON.stringify(config);
    const silks = { pattern: 'hoops', colors: ['red', 'white'], cap: 'plain' };
    const vis = startVisuals(config, { alice: { appearance: h.appearance!, silks, displayName: 'アリス', titleId: null } });
    expect(JSON.stringify(config)).toBe(before);
    expect(vis.entrants).toHaveLength(12);
    expect(vis.track).toMatchObject({ venue: 'minato', direction: 'left', going: 'soft', night: true });
    expect(vis.track.keys).toEqual({ venue: 'scene/venue/minato', surface: 'scene/surface/minato_turf', night: 'scene/night/minato', going: 'fx/going/soft' });
    const me = vis.entrants.find((e) => config.entrants[e.slot]!.playerId === 'alice')!;
    expect(me.silks).toEqual(silks);
    expect(me.displayName).toBe('アリス');
    for (const e of vis.entrants) {
      const ent = config.entrants[e.slot]!;
      if (ent.kind === 'cpu') expect(e.appearance).toEqual(templateAppearance(ent.horse.id.slice(4)));
      expect(e.voiceName).toBe(assetKeys.voiceName(ent.horse.name));
      expect(e.bracket).toBe(bracketOf(e.slot + 1, 12));
    }
  });

  it('the room sends visuals with `start` and keeps them across a snapshot', () => {
    const s = newPlayer('bob', 0, '2026-11');
    const h = createHorseFromTemplate(s, m.templateById.get('t_kohaku')!, 0);
    const config = buildRaceConfig(m, { raceId: 'r_vis2', mode: 'tutorial', trackId: 'aoba_turf_1600', statCap: null, cpuCount: 3, cpuLevel: 1, rng: seededRng(6), humans: [{ playerId: 'bob', horse: toRaceHorse(m, h) }] });
    const visuals = startVisuals(config, {});
    const room = new RaceRoomCore(config, 1000, { verifySampleRate: 0, resultWaitMs: 5000, rng: seededRng(1), visuals });
    const slot = config.entrants.find((e) => e.playerId === 'bob')!.slot;
    const out = room.hello(slot, -1, 1000);
    expect(out[0]!.msg).toMatchObject({ t: 'start', visuals });
    const back = RaceRoomCore.fromJSON(JSON.parse(JSON.stringify(room.toJSON())), seededRng(1));
    expect(back.hello(slot, -1, 1000)[0]!.msg).toMatchObject({ t: 'start', visuals });
    expect(back.replayLog().config).toEqual(config); // replay log (verifier input) carries no visuals
    const plain = new RaceRoomCore(config, 1000, { verifySampleRate: 0, resultWaitMs: 5000, rng: seededRng(1) });
    expect(plain.hello(slot, -1, 1000)[0]!.msg).not.toHaveProperty('visuals');
  });
});
