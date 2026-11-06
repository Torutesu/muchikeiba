import { describe, expect, it } from 'vitest';
import { dailyGoing, groundFor, weatherProblems } from '../src/domain/ground.js';
import { trackVisual, visualsProblems } from '../src/domain/visuals.js';
import { resolveBundle } from '../src/ops/config.js';
import { validateLeagueAndWeather } from '../src/domain/league.js';
import { buildAssetManifest } from '../src/domain/assetManifest.js';
import commentary from '../../engine/Muchi.Client/Resources/Muchi/commentary-ja.json';
import { m } from './helpers.js';

const NEW = ['nordhaven_turf_2400', 'santalucera_dirt_1700', 'bellmoor_turf_1200'] as const;
const DAY = 86_400_000;

describe('overseas-style venues (REQ-TRACK-001..004)', () => {
  it('three fictional venues with their own geometry, a straight course and a lit dirt track', () => {
    for (const id of NEW) expect(m.tracks.some((t) => t.id === id)).toBe(true);
    const bell = m.tracks.find((t) => t.id === 'bellmoor_turf_1200')!;
    expect(bell.segments).toEqual([{ kind: 'straight', lengthM: 1200 }]);
    expect(m.litTracks.has('santalucera_dirt_1700')).toBe(true);
    expect(m.litTracks.has('nordhaven_turf_2400')).toBe(false);
    expect(trackVisual(m.tracks.find((t) => t.id === 'nordhaven_turf_2400')!)).toMatchObject({ venue: 'nordhaven', direction: 'left' });
    expect(trackVisual(m.tracks.find((t) => t.id === 'santalucera_dirt_1700')!)).toMatchObject({ venue: 'santalucera', direction: 'right' });
    expect(visualsProblems(m)).toEqual([]);
  });

  it('each new course has bronze/silver/gold time attack medals in that order', () => {
    for (const id of NEW) {
      const ms = m.progression.timeAttack.milestones.filter((x) => x.trackId === id);
      expect(ms.map((x) => x.id.split('_').at(-1))).toEqual(['bronze', 'silver', 'gold']);
      expect(ms[0]!.maxTimeMs! > ms[1]!.maxTimeMs! && ms[1]!.maxTimeMs! > ms[2]!.maxTimeMs!).toBe(true);
    }
  });

  it('per-course climate: the tables shift the daily going and are validated against the course surface', () => {
    const w = m.progression.weather;
    const count = (trackId: string) => {
      const t = m.tracks.find((x) => x.id === trackId)!;
      const c: Record<string, number> = {};
      for (let d = 0; d < 2000; d++) { const g = dailyGoing(w, t, Date.UTC(2026, 0, 1, 3) + d * DAY); c[g] = (c[g] ?? 0) + 1; }
      return c;
    };
    const nord = count('nordhaven_turf_2400');
    const aoba = count('aoba_turf_1600');
    expect((nord.soft ?? 0) + (nord.yielding ?? 0)).toBeGreaterThan((aoba.soft ?? 0) + (aoba.yielding ?? 0)); // wetter north
    const santa = count('santalucera_dirt_1700');
    expect(santa.fast ?? 0).toBeGreaterThan(count('minato_dirt_1800').fast ?? 0); // dry south
    // same day, same course → same going for everyone (REQ-RACE-037 still holds)
    const t = Date.UTC(2026, 10, 5, 3);
    expect(groundFor(m, 'nordhaven_turf_2400', 'ranked', t)).toEqual(groundFor(m, 'nordhaven_turf_2400', 'ranked', t + 3600_000));
    // validation
    expect(weatherProblems(w, m.tracks)).toEqual([]);
    expect(weatherProblems({ ...w, byTrack: { nordhaven_turf_2400: { fast: 3 } } }, m.tracks).join()).toMatch(/unknown going fast/);
    expect(weatherProblems({ ...w, byTrack: { nope_turf_1000: { good: 1 } } }, m.tracks).join()).toMatch(/unknown track/);
    expect(weatherProblems({ ...w, byTrack: { bellmoor_turf_1200: { good: 0 } } }, m.tracks).join()).toMatch(/all be zero/);
    expect(() => resolveBundle(m, { progression: { weather: { ...w, byTrack: { santalucera_dirt_1700: { soft: 1 } } } } } as never)).toThrow(/unknown going soft/);
    expect(() => validateLeagueAndWeather(m)).not.toThrow();
  });

  it('the asset manifest lists the new venues (scene, surface, night) and the new commentary clips', () => {
    const man = buildAssetManifest(m, commentary as never);
    const keys = new Set(man.keys);
    for (const v of ['nordhaven', 'santalucera', 'bellmoor']) expect(keys.has(`scene/venue/${v}`), v).toBe(true);
    expect(keys.has('scene/surface/santalucera_dirt')).toBe(true);
    expect(keys.has('scene/night/santalucera')).toBe(true);
    expect(keys.has('scene/night/nordhaven')).toBe(false); // not lit
    expect(keys.has('voice/ja/phrase/spurt_bellmoor_1_p0')).toBe(true);
    expect(keys.has('voice/ja/phrase/photo_finish_2_p0')).toBe(true);
  });
});
