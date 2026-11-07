import { weatherProblems } from '../domain/ground.js';
import { leagueProblems, teamRewardProblems } from '../domain/league.js';
import { BASE_BANNED_SILKS, bannedSilksListSchema, bannedSilksProblems, type BannedSilksList } from '../domain/bannedSilks.js';
import { VISUALS, collectItemIds } from '../domain/visuals.js';
import { bondProblems } from '../domain/bond.js';
import { itemsProblems } from '../domain/itemShop.js';
import { stampsProblems } from '../domain/teamFeed.js';
import { holdPolicyProblems } from '../domain/retention.js';
import { roomsProblems } from '../domain/presets.js';
import { studConfigProblems } from '../domain/stud.js';
import { stableConfigProblems, stableConfigSchema, type StableConfig } from '../domain/stable.js';
import { uxProblems } from '../domain/onboarding.js';
import type { ChangelogEntry } from '../domain/comeback.js';
import { z } from 'zod';
import { AppError } from '../domain/errors.js';
import { buildBanner, buildPityGroups, gameDaySchedules, rescheduleGacha, splitMasterTrack, type Master, type Progression, type RawBanner } from '../domain/master.js';
import { validateGacha } from '../domain/gacha.js';
import { skillProblems } from '../domain/skills.js';
import { buildRuleset, DEFAULT_RULESET, type Ruleset } from '../domain/ruleset.js';
import { trackSchema } from '../domain/schemas.js';
import { eventProblems } from '../domain/events.js';
import type { EventDef } from '../domain/master.js';
import { canonicalJson, hashOf } from './hash.js';
import { dayRolloverChangeProblems, dayRolloverProblems, dayRule, type DayRollover } from '../domain/time.js';
import { assetCatalogProblems, assetCatalogSchema, EMPTY_ASSET_CATALOG, sameCatalogContent, type AssetCatalog } from '../domain/assetCatalog.js';

/**
 * Remote config (REQ-OPS-002..007). A bundle changes the parts of the game that may change without an
 * app update: the race ruleset, gacha banners/schedule, tracks and selected master data. Every stored
 * version is immutable and identified by the SHA-256 of its canonical JSON. Versions are validated by
 * the same validators the server runs at boot, then activated at a scheduled time and can be rolled back.
 */
const int = z.number().int();
const dayKey = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const rawBannerSchema = z.object({
  id: z.string().min(1).max(64), name: z.string().min(1).max(80), currency: z.enum(['any', 'paidOnly']),
  priceSingle: int.min(1), priceTen: int.min(1), pityGroup: z.string().min(1), pityTargets: z.array(z.string()),
  pool: z.union([z.literal('auto'), z.array(z.object({ templateId: z.string(), ppm: int.min(0) }))]),
  rates: z.record(z.string(), int.min(0)).optional(), guaranteeRates: z.record(z.string(), int.min(0)).optional(),
  guaranteePool: z.array(z.object({ templateId: z.string(), ppm: int.min(0) })).optional(),
  pickup: z.object({ templateId: z.string(), ppm: int.min(0) }).optional(),
  startAtMs: int.optional(), endAtMs: int.optional(),
  // REQ-GACHA-011: game-day schedule (startDay … endDay = last day) and the announcement window
  startDay: dayKey.optional(), endDay: dayKey.optional(), announceAtMs: int.optional(), announceDays: int.min(0).max(30).optional(),
  // REQ-GACHA-014: step-up steps (10-pulls only)
  stepUp: z.object({
    afterLast: z.enum(['loop', 'repeatLast']),
    steps: z.array(z.object({ priceTen: int.min(1), finalSlotRates: z.record(z.string(), int.min(0)).optional() }).strict()).min(1).max(10),
  }).strict().optional(),
  // REQ-BREED-020: seasonal templates offered by this banner (validated against their windows)
  seasonal: z.array(z.string().min(1).max(64)).max(20).optional(),
}).strict();

export const configBundleSchema = z.object({
  /** Partial or full ruleset; the merged result must keep the exact key set (contracts/ruleset-params.default.json). */
  ruleset: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
  gacha: z.object({
    pityGroups: z.record(z.string(), z.object({ cost: int.min(1), endAtMs: int.optional(), endDay: dayKey.optional(), convertTo: z.string().optional(), label: z.string().min(1).max(40).optional() }).strict()).optional(),
    /** Replaces the whole banner list (schedule = startAtMs/endAtMs per banner). */
    banners: z.array(rawBannerSchema).optional(),
  }).strict().optional(),
  /** Replaces the track list. Each track is checked like at boot (segments must sum to distanceM). */
  tracks: z.array(z.record(z.string(), z.unknown())).optional(),
  /** Shallow override of master progression values (reward tables, caps, retention…). */
  progression: z.record(z.string(), z.unknown()).optional(),
  ng: z.object({ exact: z.array(z.string()), contains: z.array(z.string()) }).strict().optional(),
  /** REQ-OPS-040: replaces the banned real-silks list (admin import stages a version carrying it). */
  bannedSilks: bannedSilksListSchema.optional(),
  /** REQ-EVENT-001: replaces the event list; each event is validated like at boot (tracks, ruleset override keys, fees). */
  events: z.array(z.record(z.string(), z.unknown())).optional(),
  /** REQ-STABLE-008: replaces the マイ厩舎 section (like caps within STABLE_HARD_LIMITS, themes). */
  stable: stableConfigSchema.optional(),
  /** REQ-DLV-005: replaces the asset delivery catalog. Content changes must bump catalogVersion (clients refetch on it). */
  assets: assetCatalogSchema.optional(),
  /** REQ-CB-008: replaces the what's-new entries (master/changelog.json). */
  changelog: z.array(z.record(z.string(), z.unknown())).max(200).optional(),
}).strict();
export type ConfigBundle = z.infer<typeof configBundleSchema>;

export interface ResolvedConfig {
  versionId: string;
  hash: string;
  master: Master;
  ruleset: Ruleset;
  activatedAt: number | null;
}

/** Applies a bundle to the base master. Throws CONFIG_INVALID listing every problem found. */
export function resolveBundle(base: Master, bundle: ConfigBundle): { master: Master; ruleset: Ruleset } {
  const problems: string[] = [];
  const parsed = configBundleSchema.safeParse(bundle);
  if (!parsed.success) throw new AppError('CONFIG_INVALID', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  const b = parsed.data;

  let ruleset: Ruleset = DEFAULT_RULESET;
  try {
    ruleset = buildRuleset(b.ruleset ?? {});
  } catch (e) {
    problems.push((e as Error).message);
  }
  if (ruleset.rulesetVersion === DEFAULT_RULESET.rulesetVersion && canonicalJson(ruleset) !== canonicalJson(DEFAULT_RULESET)) {
    problems.push('ruleset values differ from the default but rulesetVersion was not changed');
  }

  let tracks = base.tracks;
  let litTracks = base.litTracks;
  if (b.tracks) {
    tracks = [];
    litTracks = new Set();
    b.tracks.forEach((t, i) => {
      const { track: rest, lights } = splitMasterTrack(t);
      const r = trackSchema.safeParse(rest);
      if (r.success) { tracks.push(r.data); if (lights) litTracks.add(r.data.id); }
      else problems.push(`tracks[${i}]: ${r.error.issues.map((x) => x.message).join(', ')}`);
    });
    if (tracks.length === 0) problems.push('tracks: at least one track is required');
    if (new Set(tracks.map((t) => t.id)).size !== tracks.length) problems.push('tracks: duplicate id');
  }

  const progression = b.progression ? ({ ...base.progression, ...b.progression } as Progression) : base.progression;
  for (const k of Object.keys(b.progression ?? {})) if (!(k in base.progression)) problems.push(`progression: unknown key ${k}`);
  // REQ-GACHA-011 / REQ-DAY-001: game-day schedules (startDay/endDay) resolve with this version's day rule
  const rule = dayRule({ progression });
  const baseGacha = canonicalJson(rule) !== canonicalJson(dayRule(base)) ? rescheduleGacha(base.gacha, base.templates, rule) : base.gacha;
  let pityGroups = baseGacha.pityGroups;
  if (b.gacha?.pityGroups) {
    try { pityGroups = buildPityGroups(b.gacha.pityGroups, rule); } catch (e) { problems.push((e as Error).message); }
  }
  let banners = baseGacha.banners;
  if (b.gacha?.banners) {
    banners = [];
    for (const raw of b.gacha.banners) {
      try {
        banners.push(buildBanner(raw as RawBanner, base.templates, rule));
      } catch (e) {
        problems.push(`banner ${raw.id}: ${(e as Error).message}`);
      }
    }
    if (new Set(banners.map((x) => x.id)).size !== banners.length) problems.push('gacha: duplicate banner id');
  }

  for (const [k, v] of Object.entries(b.progression ?? {})) {
    if (k in base.progression) problems.push(...shapeProblems(`progression.${k}`, (base.progression as unknown as Record<string, unknown>)[k], v));
  }
  if (b.progression && 'weather' in b.progression) problems.push(...weatherProblems(progression.weather, base.tracks));
  if (b.progression && 'bond' in b.progression) {
    const paidOnly = new Set((base.items?.cosmetics ?? []).filter((c) => c.currency === 'paidOnly').map((c) => c.id));
    problems.push(...bondProblems(progression.bond, new Set(collectItemIds(base)), paidOnly));
  }
  if (b.progression && 'rooms' in b.progression) problems.push(...roomsProblems(progression.rooms));
  if (b.progression && 'league' in b.progression) problems.push(...leagueProblems(progression.league, new Set(collectItemIds(base))));
  if (b.progression && 'teams' in b.progression) problems.push(...teamRewardProblems(progression.teams?.seasonRewards, new Set(collectItemIds(base))));
  if (b.progression && 'dayRollover' in b.progression) problems.push(...dayRolloverProblems(progression.dayRollover)); // REQ-DAY-001
  if (b.progression && 'replayHoldDays' in b.progression) problems.push(...holdPolicyProblems(progression.replayHoldDays));
  if (b.progression && ('stud' in b.progression || 'atavismPermille' in b.progression)) problems.push(...studConfigProblems(progression));

  // REQ-UXS-*: consent, partner, beginner match, beginner login bonus, unlocks, beginner/season missions (unique ids),
  // experiments (A/B keys only, never prices), nudges and account deletion — checked on every version (tracks may change too)
  problems.push(...uxProblems({ ...base, progression, tracks, ...(b.changelog ? { changelog: b.changelog as unknown as ChangelogEntry[] } : {}) }, new Set(collectItemIds(base))));
  const events = (b.events as EventDef[] | undefined) ?? base.events;
  if (b.events) {
    const tpl = base.events[0];
    for (const ev of b.events as unknown as EventDef[]) {
      problems.push(...shapeProblems(`event ${ev.id}.points`, tpl?.points, ev.points));
      problems.push(...shapeProblems(`event ${ev.id}.milestones`, tpl?.milestones, ev.milestones));
      problems.push(...shapeProblems(`event ${ev.id}.rankRewards`, tpl?.rankRewards, ev.rankRewards));
    }
  }
  const bannedSilks = (b.bannedSilks as BannedSilksList | undefined) ?? base.bannedSilks ?? BASE_BANNED_SILKS;
  if (b.bannedSilks) problems.push(...bannedSilksProblems(bannedSilks, VISUALS).map((x) => `bannedSilks: ${x}`));
  const stable = (b.stable as StableConfig | undefined) ?? base.stable;
  if (b.stable) problems.push(...stableConfigProblems(b.stable as StableConfig, base));
  const assetCatalog = (b.assets as AssetCatalog | undefined) ?? base.assetCatalog;
  if (b.assets) problems.push(...assetCatalogVersionProblems(b.assets as AssetCatalog, base.assetCatalog ?? EMPTY_ASSET_CATALOG));
  const master: Master = { ...base, tracks, litTracks, gacha: { ...base.gacha, pityGroups, banners, daySchedules: { banners: b.gacha?.banners ? gameDaySchedules(b.gacha.banners as RawBanner[], {}).banners : baseGacha.daySchedules?.banners ?? {}, pityEndDays: b.gacha?.pityGroups ? gameDaySchedules([], b.gacha.pityGroups).pityEndDays : baseGacha.daySchedules?.pityEndDays ?? {} } }, progression, ng: b.ng ?? base.ng, events, bannedSilks, ...(stable ? { stable } : {}), ...(assetCatalog ? { assetCatalog } : {}), ...(b.changelog ? { changelog: b.changelog as unknown as ChangelogEntry[] } : {}) };
  problems.push(...eventProblems(master, events, ruleset));
  // QA r6 #1: tickets must never reach a paid-only banner, including after a remote-config banner change
  if (master.items) problems.push(...itemsProblems(master));
  if (master.items) problems.push(...stampsProblems(master)); // REQ-TEAMFEED-002: stamp cosmetics and stamps stay paired
  // REQ-UXS-050: a ruleset override may not lower a skill cap below what the skill master uses
  if (master.skills) problems.push(...skillProblems(master, ruleset));
  if (problems.length === 0) {
    try {
      validateGacha(master); // ppm sums, pools, pity groups, comp-gacha lint (REQ-GACHA-003/008)
    } catch (e) {
      problems.push((e as Error).message);
    }
  }
  if (problems.length) throw new AppError('CONFIG_INVALID', problems.join('; '));
  return { master, ruleset };
}

/**
 * REQ-DLV-005: a remote catalog is checked like the shipped one, and a catalogVersion names one content: changing the
 * entries, template or policy without raising catalogVersion above the base would leave clients on their cached copy.
 */
export function assetCatalogVersionProblems(next: AssetCatalog, base: AssetCatalog): string[] {
  const out = assetCatalogProblems(next).map((x) => `assets: ${x}`);
  if (next.catalogVersion < base.catalogVersion) out.push(`assets: catalogVersion ${next.catalogVersion} is older than the shipped ${base.catalogVersion}`);
  else if (next.catalogVersion === base.catalogVersion && !sameCatalogContent(next, base)) out.push(`assets: content differs from the shipped catalog but catalogVersion was not bumped (> ${base.catalogVersion})`);
  return out;
}

/**
 * Structural check of a remote-config override against the shipped master value (review r5 #9): same
 * types, non-empty tables where the base table is non-empty, finite non-negative numbers, integers where
 * the base is an integer, and `every` ≥ 1. Rejects e.g. `loginBonus: []`, `passRewards.every: 0` or
 * negative reward coins before they can crash claims or stall a rollover.
 */
export function shapeProblems(path: string, base: unknown, v: unknown): string[] {
  if (base === undefined) return [];
  if (v === null) return base === null || typeof base === 'number' ? [] : [`${path}: must not be null`];
  if (base === null) return typeof v === 'number' ? shapeProblems(path, 0, v) : [];
  if (typeof base === 'number') {
    if (typeof v !== 'number' || !Number.isFinite(v)) return [`${path}: must be a number`];
    if (v < 0) return [`${path}: must not be negative`];
    if (Number.isInteger(base) && !Number.isInteger(v)) return [`${path}: must be an integer`];
    if (/(^|\.)every$/.test(path) && v < 1) return [`${path}: must be ≥ 1`];
    return [];
  }
  if (Array.isArray(base)) {
    if (!Array.isArray(v)) return [`${path}: must be an array`];
    if (base.length > 0 && v.length === 0) return [`${path}: must not be empty`];
    return v.flatMap((x, i) => shapeProblems(`${path}[${i}]`, base[i] ?? base[0], x));
  }
  if (typeof base === 'object') {
    if (typeof v !== 'object' || Array.isArray(v)) return [`${path}: must be an object`];
    const b = base as Record<string, unknown>;
    return Object.entries(v as Record<string, unknown>).flatMap(([k, x]) => shapeProblems(`${path}.${k}`, b[k], x));
  }
  return typeof v === typeof base ? [] : [`${path}: must be a ${typeof base}`];
}

// ---------------------------------------------------------------------------------- versions store

export interface ConfigVersion {
  id: string; hash: string; createdAt: number; createdBy: string; note: string;
  rulesetVersion: string; rulesetHash: string; bundle: ConfigBundle;
}
export interface Activation {
  id: string; versionId: string; at: number; createdAt: number; by: string; reason: string;
  kind: 'activate' | 'rollback'; cancelled: boolean;
}
export interface ConfigRepo {
  versions(): ConfigVersion[];
  version(id: string): ConfigVersion | null;
  versionByHash(hash: string): ConfigVersion | null;
  putVersion(v: ConfigVersion): void;
  activations(): Activation[];
  putActivation(a: Activation): void;
  nextSeq(kind: 'version' | 'activation'): number;
}

export class MemoryConfigRepo implements ConfigRepo {
  private v: ConfigVersion[] = [];
  private a: Activation[] = [];
  private seq = { version: 0, activation: 0 };
  versions() { return [...this.v]; }
  version(id: string) { return this.v.find((x) => x.id === id) ?? null; }
  versionByHash(hash: string) { return this.v.find((x) => x.hash === hash) ?? null; }
  putVersion(v: ConfigVersion) { this.v.push(v); }
  activations() { return [...this.a]; }
  putActivation(a: Activation) {
    const i = this.a.findIndex((x) => x.id === a.id);
    if (i >= 0) this.a[i] = a;
    else this.a.push(a);
  }
  nextSeq(kind: 'version' | 'activation') { return ++this.seq[kind]; }
}

export const BASE_VERSION_ID = 'base';

/** Ordering of activations: by effective time, then by creation (a later decision for the same instant wins). */
const byTime = (x: Activation, y: Activation) => x.at - y.at || x.createdAt - y.createdAt || x.id.localeCompare(y.id);

export class ConfigStore {
  constructor(private readonly repo: ConfigRepo, private readonly base: Master) {}

  /** Validates without storing. Returns the problems (empty = valid). */
  validate(bundle: unknown): string[] {
    try {
      const { ruleset, master } = resolveBundle(this.base, bundle as ConfigBundle);
      return [...this.rulesetVersionProblems(ruleset), ...this.catalogVersionProblems(master.assetCatalog)];
    } catch (e) {
      return (e as Error).message.split('; ');
    }
  }

  /** A rulesetVersion names exactly one set of values, forever (old races keep verifying with it). */
  private rulesetVersionProblems(ruleset: Ruleset): string[] {
    const content = canonicalJson(ruleset);
    for (const v of this.repo.versions()) {
      if (v.rulesetVersion !== ruleset.rulesetVersion) continue;
      const other = canonicalJson(resolveBundle(this.base, v.bundle).ruleset);
      if (other !== content) return [`rulesetVersion ${ruleset.rulesetVersion} is already used by ${v.id} with different values`];
    }
    return [];
  }

  /** REQ-DLV-005: like rulesetVersion, an asset catalogVersion names exactly one content across stored versions. */
  private catalogVersionProblems(cat: AssetCatalog | undefined): string[] {
    if (!cat) return [];
    for (const v of this.repo.versions()) {
      const other = v.bundle.assets as AssetCatalog | undefined;
      if (other && other.catalogVersion === cat.catalogVersion && !sameCatalogContent(other, cat)) return [`assets: catalogVersion ${cat.catalogVersion} is already used by ${v.id} with different content`];
    }
    return [];
  }

  /** Stores an immutable version. Identical content returns the existing version (idempotent). */
  async stage(bundle: unknown, by: string, note: string, now: number): Promise<{ version: ConfigVersion; created: boolean }> {
    const problems = this.validate(bundle);
    if (problems.length) throw new AppError('CONFIG_INVALID', problems.join('; '));
    const parsed = configBundleSchema.parse(bundle);
    const hash = await hashOf(parsed);
    const existing = this.repo.versionByHash(hash);
    if (existing) return { version: existing, created: false };
    const { ruleset } = resolveBundle(this.base, parsed);
    const version: ConfigVersion = {
      id: `cfg_${this.repo.nextSeq('version')}`, hash, createdAt: now, createdBy: by, note,
      rulesetVersion: ruleset.rulesetVersion, rulesetHash: await hashOf(ruleset), bundle: parsed,
    };
    this.repo.putVersion(version);
    return { version, created: true };
  }

  /** Activates a version now or at `at` (scheduled). Re-validated against the current base master. */
  schedule(versionId: string, at: number, by: string, reason: string, now: number, kind: Activation['kind'] = 'activate'): Activation {
    const v = this.repo.version(versionId);
    if (!v) throw new AppError('NOT_FOUND', `config version ${versionId}`);
    resolveBundle(this.base, v.bundle); // a base-master change could have invalidated an old version
    const a: Activation = { id: `act_${this.repo.nextSeq('activation')}`, versionId, at: Math.max(at, now), createdAt: now, by, reason, kind, cancelled: false };
    this.dayRuleChainCheck(now, a);
    this.repo.putActivation(a);
    return a;
  }

  /** Cancels a scheduled activation that has not taken effect yet. */
  cancel(activationId: string, now: number): Activation {
    const a = this.repo.activations().find((x) => x.id === activationId);
    if (!a) throw new AppError('NOT_FOUND', `activation ${activationId}`);
    if (a.cancelled) return a;
    if (a.at <= now) throw new AppError('CONFLICT', 'activation already in effect; use rollback');
    this.dayRuleChainCheck(now, null, a.id); // the activation after it gets a new neighbour
    const c = { ...a, cancelled: true };
    this.repo.putActivation(c);
    return c;
  }

  /** Rolls back to `versionId`, or to the version that was active before the current one. Effective now. */
  rollback(versionId: string | null, by: string, reason: string, now: number): Activation {
    let target = versionId;
    if (!target) {
      const history = this.effectiveHistory(now);
      const current = history[history.length - 1];
      if (!current) throw new AppError('CONFLICT', 'nothing to roll back');
      const prev = [...history].reverse().find((h) => h.versionId !== current.versionId);
      target = prev ? prev.versionId : BASE_VERSION_ID;
    }
    if (target === BASE_VERSION_ID) {
      const a: Activation = { id: `act_${this.repo.nextSeq('activation')}`, versionId: BASE_VERSION_ID, at: now, createdAt: now, by, reason, kind: 'rollback', cancelled: false };
      this.dayRuleChainCheck(now, a);
      this.repo.putActivation(a);
      return a;
    }
    return this.schedule(target, now, by, reason, now, 'rollback');
  }

  private dayRuleOf(versionId: string): DayRollover {
    if (versionId === BASE_VERSION_ID) return dayRule(this.base);
    return dayRule(resolveBundle(this.base, this.get(versionId).bundle).master);
  }

  /**
   * REQ-DAY-002: an activation may not change the game day rule retroactively or with less than the lead time. Checked
   * over the whole timeline that the change would produce (QA r9): the new activation against the one before it, and
   * every pending activation against its (possibly new) predecessor — inserting, rolling back or cancelling gives the
   * next pending activation a new neighbour. Activations already in effect are history and are not re-checked.
   */
  private dayRuleChainCheck(now: number, added: Activation | null, removedId?: string) {
    const all = this.repo.activations().filter((x) => !x.cancelled && x.id !== removedId);
    if (added) all.push(added);
    all.sort(byTime);
    const rules = new Map<string, DayRollover>();
    const ruleOf = (id: string) => { let r = rules.get(id); if (!r) { r = this.dayRuleOf(id); rules.set(id, r); } return r; };
    let prev = BASE_VERSION_ID;
    const problems: string[] = [];
    for (const x of all) {
      if (x === added || x.at > now) {
        const p = dayRolloverChangeProblems(ruleOf(prev), ruleOf(x.versionId), x.at);
        if (p.length) problems.push(...(x === added ? p : p.map((m) => `pending activation ${x.id} (${x.versionId}) would become invalid: ${m}`)));
      }
      prev = x.versionId;
    }
    if (problems.length) throw new AppError('CONFIG_INVALID', problems.join('; '));
  }

  private effectiveHistory(now: number) {
    return this.repo.activations().filter((a) => !a.cancelled && a.at <= now).sort(byTime);
  }

  /** The activation in effect at `now` (null = base master and default ruleset). */
  activeAt(now: number): Activation | null {
    const h = this.effectiveHistory(now);
    const a = h[h.length - 1] ?? null;
    return a && a.versionId !== BASE_VERSION_ID ? a : null;
  }

  pending(now: number): Activation[] {
    return this.repo.activations().filter((a) => !a.cancelled && a.at > now).sort(byTime);
  }

  list(now: number) {
    const active = this.activeAt(now);
    return {
      active: active ? { versionId: active.versionId, activationId: active.id, since: active.at } : { versionId: BASE_VERSION_ID, activationId: null, since: null },
      pending: this.pending(now),
      versions: this.repo.versions().map(({ bundle: _b, ...meta }) => meta),
      activations: this.repo.activations().sort(byTime),
    };
  }

  get(id: string): ConfigVersion {
    const v = this.repo.version(id);
    if (!v) throw new AppError('NOT_FOUND', `config version ${id}`);
    return v;
  }

  /** What the workers need to resolve the active config; the bundle is omitted when the caller already has it. */
  activeFor(now: number, knownHash: string | null): ActiveConfigInfo {
    const a = this.activeAt(now);
    if (!a) return { versionId: BASE_VERSION_ID, hash: null, activatedAt: null, bundle: null, nextChangeAt: this.pending(now)[0]?.at ?? null };
    const v = this.get(a.versionId);
    return { versionId: v.id, hash: v.hash, activatedAt: a.at, bundle: knownHash === v.hash ? null : v.bundle, nextChangeAt: this.pending(now)[0]?.at ?? null };
  }

  /** REQ-OPS-008: dry run of an activation / rollback / cancellation (nothing is stored). */
  dryRun(op: DryRunOp, by: string, now: number) { return configDryRun(this.repo, this.base, op, by, now); }
}

/** A read-only view of a repo: writes land in a scratch overlay, so a dry run can call the real operations. */
class DryRunRepo implements ConfigRepo {
  private acts = new Map<string, Activation>();
  private seq = 0;
  constructor(private readonly inner: ConfigRepo) {}
  versions() { return this.inner.versions(); }
  version(id: string) { return this.inner.version(id); }
  versionByHash(hash: string) { return this.inner.versionByHash(hash); }
  putVersion() { /* never stored */ }
  activations() {
    const base = this.inner.activations().map((a) => this.acts.get(a.id) ?? a);
    return [...base, ...[...this.acts.values()].filter((a) => !base.some((b) => b.id === a.id))];
  }
  putActivation(a: Activation) { this.acts.set(a.id, a); }
  nextSeq() { return -++this.seq; } // negative: never equal to a real id
}

export type DryRunOp =
  | { kind: 'activate'; versionId: string; at?: number | undefined }
  | { kind: 'rollback'; versionId: string | null }
  | { kind: 'cancel'; activationId: string };
export interface DryRunResult { ok: boolean; problems: string[]; effect: Activation | null }

/**
 * Admin dry run of an activation, a rollback or a cancellation (REQ-OPS-008): runs the real ConfigStore operation on a
 * scratch overlay of the repo (nothing is stored) and reports every problem — the bundle re-validated against the current
 * base master, and the game-day rule chain over the timeline the change would produce (REQ-DAY-002).
 */
export function configDryRun(repo: ConfigRepo, base: Master, op: DryRunOp, by: string, now: number): DryRunResult {
  const store = new ConfigStore(new DryRunRepo(repo), base);
  try {
    const effect = op.kind === 'activate' ? store.schedule(op.versionId, op.at ?? now, by, 'dry run', now)
      : op.kind === 'rollback' ? store.rollback(op.versionId, by, 'dry run', now)
        : store.cancel(op.activationId, now);
    return { ok: true, problems: [], effect: effect.id.startsWith('act_-') ? { ...effect, id: '(dry run)' } : effect };
  } catch (e) {
    if (!(e instanceof AppError)) throw e;
    return { ok: false, problems: e.message.split('; '), effect: null };
  }
}

export type ProblemGroup = 'dayRule' | 'assetCatalog' | 'gacha' | 'ruleset' | 'other';
/** Groups validator messages for the ops console (the messages themselves are unchanged). */
export function groupProblems(problems: string[]): Record<ProblemGroup, string[]> {
  const out: Record<ProblemGroup, string[]> = { dayRule: [], assetCatalog: [], gacha: [], ruleset: [], other: [] };
  for (const p of problems) {
    if (/dayRollover|game day|pending activation/i.test(p)) out.dayRule.push(p);
    else if (/^assets[:.]|catalogVersion/.test(p)) out.assetCatalog.push(p);
    else if (/gacha|banner|pity|ppm|step-?up|pool|ticket/i.test(p)) out.gacha.push(p);
    else if (/ruleset/i.test(p)) out.ruleset.push(p);
    else out.other.push(p);
  }
  return out;
}

export interface DiffRow { path: string; before: unknown; after: unknown }
/** A flat JSON diff (path → before/after) between two bundles, for the console's version compare. */
export function bundleDiff(a: unknown, b: unknown, path = ''): DiffRow[] {
  const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
  if (isObj(a) && isObj(b)) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    return keys.flatMap((k) => bundleDiff(a[k], b[k], path ? `${path}.${k}` : k));
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    // lists of objects with ids (banners, events, tracks) are compared by id
    const ids = (x: unknown[]) => (x.every((e) => isObj(e) && typeof e.id === 'string') ? new Map(x.map((e) => [(e as { id: string }).id, e])) : null);
    const ia = ids(a), ib = ids(b);
    if (ia && ib) return [...new Set([...ia.keys(), ...ib.keys()])].flatMap((k) => bundleDiff(ia.get(k), ib.get(k), `${path}[${k}]`));
    if (a.length === b.length) return a.flatMap((x, i) => bundleDiff(x, b[i], `${path}[${i}]`));
  }
  if (canonicalJson(a ?? null) === canonicalJson(b ?? null)) return [];
  return [{ path: path || '(root)', before: a ?? null, after: b ?? null }];
}

export interface ActiveConfigInfo {
  versionId: string;
  hash: string | null;
  activatedAt: number | null;
  /** null when unchanged for the caller (knownHash matched) or for the base config. */
  bundle: ConfigBundle | null;
  /** When the next scheduled activation takes effect (callers can expire their cache then). */
  nextChangeAt: number | null;
}

/** Caches resolved configs per version hash so a worker resolves a bundle once. */
export class ConfigResolver {
  private byHash = new Map<string, ResolvedConfig>();
  constructor(private readonly base: Master) {}

  baseConfig(): ResolvedConfig {
    return { versionId: BASE_VERSION_ID, hash: 'base', master: this.base, ruleset: DEFAULT_RULESET, activatedAt: null };
  }

  /** `info.bundle` may be null when the hash is already cached. Returns null if it is unknown and missing. */
  resolve(info: ActiveConfigInfo): ResolvedConfig | null {
    if (!info.hash) return this.baseConfig();
    const hit = this.byHash.get(info.hash);
    if (hit) return { ...hit, activatedAt: info.activatedAt };
    if (!info.bundle) return null;
    const { master, ruleset } = resolveBundle(this.base, info.bundle);
    const r: ResolvedConfig = { versionId: info.versionId, hash: info.hash, master, ruleset, activatedAt: info.activatedAt };
    this.byHash.set(info.hash, r);
    return r;
  }

  knows(hash: string | null) { return hash === null || this.byHash.has(hash); }
}
