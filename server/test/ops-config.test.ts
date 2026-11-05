import { describe, expect, it } from 'vitest';
import gachaJson from '../master/gacha.json';
import tracksJson from '../master/tracks.json';
import { m } from './helpers.js';
import { BASE_VERSION_ID, ConfigResolver, ConfigStore, MemoryConfigRepo, resolveBundle, type ConfigBundle } from '../src/ops/config.js';
import { DEFAULT_RULESET } from '../src/domain/ruleset.js';
import { canonicalJson, hashOf } from '../src/ops/hash.js';
import { createRace } from '../src/race/orchestrate.js';
import { seededRng } from '../src/domain/rng.js';
import { newPlayer } from '../src/domain/player.js';
import { createHorseFromTemplate } from '../src/domain/horses.js';
import { toRaceHorse } from '../src/domain/raceConfig.js';
import { RaceRoomCore } from '../src/domain/raceRoom.js';

const T0 = Date.UTC(2026, 10, 10, 3);
type RawB = NonNullable<NonNullable<ConfigBundle['gacha']>['banners']>[number];
const banners = () => structuredClone((gachaJson as unknown as { banners: RawB[] }).banners);
const newRuleset = (v: string, maxWhips = 5) => ({ ...DEFAULT_RULESET, rulesetVersion: v, maxWhips });

function store() {
  return new ConfigStore(new MemoryConfigRepo(), m);
}

describe('remote config: validation (REQ-OPS-003)', () => {
  it('accepts a banner schedule change and resolves a new master', () => {
    const b = banners();
    b[1]!.startAtMs = T0;
    b[1]!.endAtMs = T0 + 7 * 86_400_000;
    const { master, ruleset } = resolveBundle(m, { gacha: { banners: b } });
    expect(master.gacha.banners.find((x) => x.id === 'pickup_akatsuki')!.endAtMs).toBe(T0 + 7 * 86_400_000);
    expect(ruleset).toEqual(DEFAULT_RULESET);
    expect(m.gacha.banners.find((x) => x.id === 'pickup_akatsuki')!.endAtMs).toBeUndefined(); // base untouched
  });

  it('rejects unknown ruleset keys and non-integer values', () => {
    expect(store().validate({ ruleset: { ...newRuleset('2.1.0'), bogusKey: 3 } }).join()).toMatch(/unknown key: bogusKey/);
    expect(store().validate({ ruleset: { rulesetVersion: '2.1.0', maxWhips: 2.5 } }).join()).toMatch(/maxWhips must be a 32-bit integer/);
  });

  it('rejects changed ruleset values without a new rulesetVersion', () => {
    expect(store().validate({ ruleset: { maxWhips: 9 } }).join()).toMatch(/rulesetVersion was not changed/);
  });

  it('rejects a banner whose rates do not sum to 100%', () => {
    const b = banners();
    b[0]!.rates!.SSR = 40_000;
    expect(store().validate({ gacha: { banners: b } }).join()).toMatch(/standard/);
  });

  it('rejects comp gacha (collect-a-set of gacha-only horses) — REQ-GACHA-008', () => {
    const ids = m.templates.filter((t) => t.rarity === 'SSR').slice(0, 2).map((t) => t.id);
    const p = store().validate({ progression: { collectionMissions: [{ id: 'set1', kind: 'collect', templateIds: ids, reward: { freeCoins: 100 } }] } });
    expect(p.join()).toMatch(/comp gacha is prohibited/);
  });

  it('rejects tracks whose segments do not sum to the distance, and unknown progression keys', () => {
    const tracks = structuredClone((tracksJson as { tracks: Record<string, unknown>[] }).tracks);
    (tracks[0]!.segments as { lengthM: number }[])[0]!.lengthM += 10;
    expect(store().validate({ tracks }).join()).toMatch(/segment lengths must sum to distanceM/);
    expect(store().validate({ progression: { noSuchThing: 1 } }).join()).toMatch(/unknown key noSuchThing/);
    expect(store().validate({ surprise: true }).join()).toMatch(/Unrecognized key/);
  });
});

describe('remote config: versions, scheduling, rollback (REQ-OPS-002/004)', () => {
  it('versions are immutable and content-addressed; re-staging identical content is idempotent', async () => {
    const s = store();
    const a = await s.stage({ ruleset: newRuleset('2.1.0') }, 'alice', 'fewer whips', T0);
    const reordered = JSON.parse(JSON.stringify({ ruleset: Object.fromEntries(Object.entries(newRuleset('2.1.0')).reverse()) })) as ConfigBundle;
    const b = await s.stage(reordered, 'bob', 'same thing', T0 + 1);
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.version.id).toBe(a.version.id);
    expect(a.version.hash).toBe(await hashOf(reordered));
    expect(a.version.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.version.rulesetVersion).toBe('2.1.0');
  });

  it('a rulesetVersion can never be reused for different values', async () => {
    const s = store();
    await s.stage({ ruleset: newRuleset('2.1.0', 5) }, 'alice', '', T0);
    await expect(s.stage({ ruleset: newRuleset('2.1.0', 4) }, 'alice', '', T0)).rejects.toMatchObject({ code: 'CONFIG_INVALID', message: expect.stringMatching(/already used/) });
    // same values + other changes is fine
    const b = banners();
    b[1]!.endAtMs = T0 + 1000;
    await expect(s.stage({ ruleset: newRuleset('2.1.0', 5), gacha: { banners: b } }, 'alice', '', T0)).resolves.toMatchObject({ created: true });
  });

  it('scheduled activation takes effect at its time; cancel only before it', async () => {
    const s = store();
    const { version } = await s.stage({ ruleset: newRuleset('2.1.0') }, 'alice', '', T0);
    const act = s.schedule(version.id, T0 + 3600_000, 'alice', 'Tuesday maintenance', T0);
    expect(s.activeAt(T0)).toBeNull();
    expect(s.activeFor(T0, null)).toMatchObject({ versionId: BASE_VERSION_ID, nextChangeAt: T0 + 3600_000 });
    expect(s.activeAt(T0 + 3600_000)!.versionId).toBe(version.id);
    const s2 = store();
    const v2 = (await s2.stage({ ruleset: newRuleset('2.2.0') }, 'a', '', T0)).version;
    const a2 = s2.schedule(v2.id, T0 + 1000, 'a', 'later', T0);
    expect(s2.cancel(a2.id, T0 + 500).cancelled).toBe(true);
    expect(s2.activeAt(T0 + 2000)).toBeNull();
    expect(() => s.cancel(act.id, T0 + 3600_001)).toThrow(/already in effect/);
  });

  it('rollback returns to the previous version, then to base', async () => {
    const s = store();
    const v1 = (await s.stage({ ruleset: newRuleset('2.1.0') }, 'a', '', T0)).version;
    const v2 = (await s.stage({ ruleset: newRuleset('2.2.0', 4) }, 'a', '', T0)).version;
    s.schedule(v1.id, T0, 'a', 'go', T0);
    s.schedule(v2.id, T0 + 10, 'a', 'go', T0 + 10);
    expect(s.activeAt(T0 + 20)!.versionId).toBe(v2.id);
    s.rollback(null, 'a', 'v2 broke start boosts', T0 + 30);
    expect(s.activeAt(T0 + 30)!.versionId).toBe(v1.id);
    s.rollback(BASE_VERSION_ID, 'a', 'back to shipped values', T0 + 40);
    expect(s.activeAt(T0 + 40)).toBeNull();
    expect(s.list(T0 + 40).activations.map((x) => x.kind)).toEqual(['activate', 'activate', 'rollback', 'rollback']);
  });

  it('workers get the bundle only when they do not have it; the resolver caches per hash', async () => {
    const s = store();
    const { version } = await s.stage({ ruleset: newRuleset('2.1.0') }, 'a', '', T0);
    s.schedule(version.id, T0, 'a', 'go', T0);
    const first = s.activeFor(T0, null);
    expect(first.bundle).not.toBeNull();
    expect(s.activeFor(T0, version.hash).bundle).toBeNull();
    const r = new ConfigResolver(m);
    expect(r.resolve(s.activeFor(T0, version.hash))).toBeNull(); // unknown hash and no bundle → caller refetches
    const resolved = r.resolve(first)!;
    expect(resolved.ruleset.maxWhips).toBe(5);
    expect(r.resolve(s.activeFor(T0, version.hash))!.hash).toBe(version.hash);
  });
});

describe('races record the ruleset they used (REQ-OPS-006)', () => {
  it('the active ruleset is embedded in the race config, so the replay log carries it to the verifier', async () => {
    const { ruleset } = resolveBundle(m, { ruleset: newRuleset('2.1.0') });
    const p = newPlayer('p0', T0, '2026-11');
    const horse = toRaceHorse(m, createHorseFromTemplate(p, m.templates[0]!, T0));
    const entry = { playerId: 'p0', horse, rating: { r: 1500, rd: 350, vol: 0.06 }, classId: 'C', statCap: 3200, beginner: false, moderation: 'ok' as const };
    const created = await createRace(m, { mode: 'friend', humans: [entry, { ...entry, playerId: 'p1' }], cpuCount: 0, cpuLevel: 3, rng: seededRng(5), now: T0, ticketSecret: 's', ruleset });
    expect(created.config.ruleset.rulesetVersion).toBe('2.1.0');
    expect(created.config.ruleset.maxWhips).toBe(5);
    const core = new RaceRoomCore(created.config, created.startAtMs, { verifySampleRate: 0, resultWaitMs: 5000, rng: seededRng(1) });
    expect(canonicalJson(core.replayLog().config.ruleset)).toBe(canonicalJson(ruleset));
  });
});
