import { weatherProblems } from '../domain/ground.js';
import { z } from 'zod';
import { AppError } from '../domain/errors.js';
import { buildBanner, splitMasterTrack, type Master, type Progression, type RawBanner } from '../domain/master.js';
import { validateGacha } from '../domain/gacha.js';
import { buildRuleset, DEFAULT_RULESET, type Ruleset } from '../domain/ruleset.js';
import { trackSchema } from '../domain/schemas.js';
import { canonicalJson, hashOf } from './hash.js';

/**
 * Remote config (REQ-OPS-002..007). A bundle changes the parts of the game that may change without an
 * app update: the race ruleset, gacha banners/schedule, tracks and selected master data. Every stored
 * version is immutable and identified by the SHA-256 of its canonical JSON. Versions are validated by
 * the same validators the server runs at boot, then activated at a scheduled time and can be rolled back.
 */
const int = z.number().int();
const rawBannerSchema = z.object({
  id: z.string().min(1).max(64), name: z.string().min(1).max(80), currency: z.enum(['any', 'paidOnly']),
  priceSingle: int.min(1), priceTen: int.min(1), pityGroup: z.string().min(1), pityTargets: z.array(z.string()),
  pool: z.union([z.literal('auto'), z.array(z.object({ templateId: z.string(), ppm: int.min(0) }))]),
  rates: z.record(z.string(), int.min(0)).optional(), guaranteeRates: z.record(z.string(), int.min(0)).optional(),
  guaranteePool: z.array(z.object({ templateId: z.string(), ppm: int.min(0) })).optional(),
  pickup: z.object({ templateId: z.string(), ppm: int.min(0) }).optional(),
  startAtMs: int.optional(), endAtMs: int.optional(),
}).strict();

export const configBundleSchema = z.object({
  /** Partial or full ruleset; the merged result must keep the exact key set (contracts/ruleset-params.default.json). */
  ruleset: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
  gacha: z.object({
    pityGroups: z.record(z.string(), z.object({ cost: int.min(1), endAtMs: int.optional(), convertTo: z.string().optional() }).strict()).optional(),
    /** Replaces the whole banner list (schedule = startAtMs/endAtMs per banner). */
    banners: z.array(rawBannerSchema).optional(),
  }).strict().optional(),
  /** Replaces the track list. Each track is checked like at boot (segments must sum to distanceM). */
  tracks: z.array(z.record(z.string(), z.unknown())).optional(),
  /** Shallow override of master progression values (reward tables, caps, retention…). */
  progression: z.record(z.string(), z.unknown()).optional(),
  ng: z.object({ exact: z.array(z.string()), contains: z.array(z.string()) }).strict().optional(),
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

  const pityGroups = b.gacha?.pityGroups ?? base.gacha.pityGroups;
  let banners = base.gacha.banners;
  if (b.gacha?.banners) {
    banners = [];
    for (const raw of b.gacha.banners) {
      try {
        banners.push(buildBanner(raw as RawBanner, base.templates));
      } catch (e) {
        problems.push(`banner ${raw.id}: ${(e as Error).message}`);
      }
    }
    if (new Set(banners.map((x) => x.id)).size !== banners.length) problems.push('gacha: duplicate banner id');
  }

  const progression = b.progression ? ({ ...base.progression, ...b.progression } as Progression) : base.progression;
  for (const k of Object.keys(b.progression ?? {})) if (!(k in base.progression)) problems.push(`progression: unknown key ${k}`);
  if (b.progression && 'weather' in b.progression) problems.push(...weatherProblems(progression.weather));

  const master: Master = { ...base, tracks, litTracks, gacha: { ...base.gacha, pityGroups, banners }, progression, ng: b.ng ?? base.ng };
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
      const { ruleset } = resolveBundle(this.base, bundle as ConfigBundle);
      return this.rulesetVersionProblems(ruleset);
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
    this.repo.putActivation(a);
    return a;
  }

  /** Cancels a scheduled activation that has not taken effect yet. */
  cancel(activationId: string, now: number): Activation {
    const a = this.repo.activations().find((x) => x.id === activationId);
    if (!a) throw new AppError('NOT_FOUND', `activation ${activationId}`);
    if (a.cancelled) return a;
    if (a.at <= now) throw new AppError('CONFLICT', 'activation already in effect; use rollback');
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
      this.repo.putActivation(a);
      return a;
    }
    return this.schedule(target, now, by, reason, now, 'rollback');
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
