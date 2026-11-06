/**
 * Asset delivery catalog (REQ-DLV-001..010, contracts/protocol.md §15, contracts/assets.md §6).
 *
 * The catalog tells the client, per platform, which file on the CDN holds each asset key, its SHA-256 and size,
 * which preload group it belongs to and whether the group's screen must wait for it. The base catalog is
 * `server/master/assets-catalog.json` (written by `npm run scan:assets` from the asset output folder); remote config
 * may replace it (`assets` in a bundle). The CDN base URL never lives in the catalog: it comes from the
 * `ASSET_CDN_BASE` var (wrangler.toml), so a config change cannot point clients at another host and no signed URL or
 * token can be stored here. Clients cache the platform view by its `hash` (ETag) and refetch when
 * `GET /v1/config` reports a different `assetCatalogVersion`.
 */
import { z } from 'zod';
import { canonicalJson, sha256Hex } from '../ops/hash.js';
import { ASSET_KEY_RE, ASSET_KINDS, fallbackKey, kindOf } from './visuals.js';

export const ASSET_PLATFORMS = ['ios', 'android'] as const;
export type AssetPlatform = (typeof ASSET_PLATFORMS)[number];

/** Preload groups in download order. `ondemand` is fetched when a screen first needs the key (voice names, banners…). */
export const ASSET_GROUPS = ['boot', 'ftue', 'home', 'race', 'shop', 'ondemand'] as const;
export type AssetGroup = (typeof ASSET_GROUPS)[number];
/** Groups whose screen may wait for `required` entries. Everything else always degrades to the kind's fallback. */
export const BLOCKING_GROUPS: readonly AssetGroup[] = ['boot', 'ftue'];

export const DEFAULT_URL_TEMPLATE = '{base}/{platform}/{sha256}/{file}';
const URL_TOKENS = new Set(['base', 'platform', 'sha256', 'file']);

/**
 * Hard limits for the FTUE (docs/planning/06 §2: first race within 5 s of the first tap, aha① ≤ 30 s). The tutorial
 * screen never waits longer than `tutorialMaxWaitMs`, and the bytes it may wait for are capped, so a slow network
 * can only ever cost placeholders, never the aha moment.
 */
export const DELIVERY_HARD_LIMITS = { ftueBlockingMaxBytes: 5_000_000, tutorialMaxWaitMs: 5_000, maxParallel: 8 } as const;

const int = z.number().int();
export const assetPolicySchema = z.object({
  /** Max bytes of `required` boot+ftue entries (what the tutorial may wait for). */
  ftueBlockingMaxBytes: int.min(0).max(DELIVERY_HARD_LIMITS.ftueBlockingMaxBytes),
  /** On a cellular connection, ask before downloading more than this (Wi-Fi recommended). */
  cellularWarnBytes: int.min(0),
  /** The FTUE download screen gives up waiting after this and starts the tutorial with placeholders. */
  tutorialMaxWaitMs: int.min(0).max(DELIVERY_HARD_LIMITS.tutorialMaxWaitMs),
  /** Concurrent downloads. */
  maxParallel: int.min(1).max(DELIVERY_HARD_LIMITS.maxParallel),
}).strict();
export type AssetPolicy = z.infer<typeof assetPolicySchema>;
export const DEFAULT_ASSET_POLICY: AssetPolicy = { ftueBlockingMaxBytes: 3_000_000, cellularWarnBytes: 50_000_000, tutorialMaxWaitMs: 3_000, maxParallel: 4 };

/** Path of the file under `{platform}/` on the CDN, as the scanner found it: lowercase, no `..`, no leading `/`. */
export const ASSET_FILE_RE = /^[a-z0-9_][a-z0-9_.@-]*(\/[a-z0-9_][a-z0-9_.@-]*)*$/;

export const assetEntrySchema = z.object({
  key: z.string().regex(ASSET_KEY_RE, 'malformed asset key'),
  file: z.string().max(200).regex(ASSET_FILE_RE, 'file must be a relative lowercase path'),
  sha256: z.string().regex(/^[0-9a-f]{64}$/, 'sha256 must be 64 lowercase hex'),
  size: int.min(1).max(2_000_000_000),
  group: z.enum(ASSET_GROUPS),
  required: z.boolean(),
}).strict();
export type AssetEntry = z.infer<typeof assetEntrySchema>;

export const assetCatalogSchema = z.object({
  _note: z.string().optional(),
  /** Bump whenever entries change: it is what clients compare (GET /v1/config `assetCatalogVersion`). */
  catalogVersion: int.min(1),
  /** contracts/assets.manifest.json `version` the catalog was built against. */
  manifestVersion: int.min(1),
  urlTemplate: z.string().min(1).max(200).default(DEFAULT_URL_TEMPLATE),
  policy: assetPolicySchema.default(DEFAULT_ASSET_POLICY),
  platforms: z.object({
    ios: z.object({ entries: z.array(assetEntrySchema).max(20_000) }).strict().optional(),
    android: z.object({ entries: z.array(assetEntrySchema).max(20_000) }).strict().optional(),
  }).strict(),
}).strict();
export type AssetCatalog = z.infer<typeof assetCatalogSchema>;

export const EMPTY_ASSET_CATALOG: AssetCatalog = {
  catalogVersion: 1, manifestVersion: 1, urlTemplate: DEFAULT_URL_TEMPLATE, policy: DEFAULT_ASSET_POLICY, platforms: { ios: { entries: [] }, android: { entries: [] } },
};

/** Semantic checks on top of the schema (run at boot, by the scanner and for every remote-config version). */
export function assetCatalogProblems(c: AssetCatalog): string[] {
  const out: string[] = [];
  const tpl = c.urlTemplate;
  if (!tpl.startsWith('{base}/')) out.push('urlTemplate must start with "{base}/" (the CDN host comes from ASSET_CDN_BASE, never from config)');
  if (/[?#]/.test(tpl)) out.push('urlTemplate must not have a query or fragment (no tokens or signatures in config)');
  for (const m of tpl.matchAll(/\{([^}]*)\}/g)) if (!URL_TOKENS.has(m[1]!)) out.push(`urlTemplate: unknown placeholder {${m[1]}}`);
  if (!tpl.includes('{sha256}') && !tpl.includes('{file}')) out.push('urlTemplate needs {sha256} or {file}');
  for (const p of ASSET_PLATFORMS) {
    const entries = c.platforms[p]?.entries ?? [];
    const seen = new Set<string>();
    const byFile = new Map<string, { sha256: string; size: number }>();
    const bySha = new Map<string, number>();
    let blocking = 0;
    const counted = new Set<string>();
    for (const e of entries) {
      const at = `${p} ${e.key}`;
      if (seen.has(e.key)) out.push(`${at}: duplicate key`);
      seen.add(e.key);
      const kind = kindOf(e.key);
      if (!ASSET_KINDS[kind]) out.push(`${at}: unknown kind ${kind}`);
      if (e.file.split('/').some((s) => s === '.' || s === '..')) out.push(`${at}: file must not contain . or .. segments`);
      if (e.key.replace(/@v[0-9]+$/, '') === fallbackKey(kind) && (e.group !== 'boot' || !e.required)) out.push(`${at}: <kind>/default must be required in group boot (REQ-ASSET-002)`);
      if (e.required && !BLOCKING_GROUPS.includes(e.group)) out.push(`${at}: only boot/ftue entries may be required (group ${e.group} always degrades to the fallback)`);
      const f = byFile.get(e.file);
      if (f && (f.sha256 !== e.sha256 || f.size !== e.size)) out.push(`${at}: file ${e.file} is listed with different sha256/size`);
      byFile.set(e.file, { sha256: e.sha256, size: e.size });
      const s = bySha.get(e.sha256);
      if (s !== undefined && s !== e.size) out.push(`${at}: sha256 ${e.sha256.slice(0, 12)}… is listed with different sizes`);
      bySha.set(e.sha256, e.size);
      if (e.required && !counted.has(e.sha256)) { counted.add(e.sha256); blocking += e.size; }
    }
    if (blocking > c.policy.ftueBlockingMaxBytes) {
      out.push(`${p}: required boot/ftue entries are ${blocking} bytes, over policy.ftueBlockingMaxBytes ${c.policy.ftueBlockingMaxBytes} (the tutorial must not wait for them; mark big ones optional)`);
    }
  }
  return out;
}

/** Parses + checks; throws with every problem (boot / scanner). */
export function parseAssetCatalog(raw: unknown): AssetCatalog {
  const r = assetCatalogSchema.safeParse(raw);
  if (!r.success) throw new Error('asset catalog: ' + r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  const problems = assetCatalogProblems(r.data);
  if (problems.length) throw new Error('asset catalog: ' + problems.join('; '));
  return r.data;
}

/** True when two catalogs have the same deliverable content (ignoring the note and the version number). */
export function sameCatalogContent(a: AssetCatalog, b: AssetCatalog): boolean {
  const strip = ({ _note: _n, catalogVersion: _v, ...rest }: AssetCatalog) => rest;
  return canonicalJson(strip(a)) === canonicalJson(strip(b));
}

export interface PlatformCatalogView {
  catalogVersion: number;
  manifestVersion: number;
  platform: AssetPlatform;
  /** SHA-256 of the rest of this object (canonical JSON); also the ETag. */
  hash: string;
  /** ASSET_CDN_BASE without trailing slash; "" when the deployment has no CDN (clients then use bundled assets only). */
  baseUrl: string;
  urlTemplate: string;
  policy: AssetPolicy;
  groups: readonly AssetGroup[];
  entries: AssetEntry[];
}

const viewCache = new WeakMap<AssetCatalog, Map<string, PlatformCatalogView>>();

/** What `GET /v1/assets/catalog?platform=` returns (cached per catalog object, platform and CDN base). */
export async function platformCatalog(c: AssetCatalog, platform: AssetPlatform, cdnBase: string | undefined): Promise<PlatformCatalogView> {
  const baseUrl = (cdnBase ?? '').trim().replace(/\/+$/, '');
  let per = viewCache.get(c);
  if (!per) { per = new Map(); viewCache.set(c, per); }
  const ck = `${platform}|${baseUrl}`;
  const hit = per.get(ck);
  if (hit) return hit;
  const entries = [...(c.platforms[platform]?.entries ?? [])].sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
  const body = { catalogVersion: c.catalogVersion, manifestVersion: c.manifestVersion, platform, baseUrl, urlTemplate: c.urlTemplate, policy: c.policy, groups: ASSET_GROUPS, entries };
  const view: PlatformCatalogView = { ...body, hash: await sha256Hex(canonicalJson(body)) };
  per.set(ck, view);
  return view;
}

/** `"<hash>"` — strong ETag of a platform view. */
export const catalogEtag = (v: PlatformCatalogView) => `"${v.hash}"`;

/** Does an If-None-Match header match this ETag (handles lists, weak validators and `*`)? */
export function etagMatches(ifNoneMatch: string | null, etag: string): boolean {
  if (!ifNoneMatch) return false;
  return ifNoneMatch.split(',').map((s) => s.trim().replace(/^W\//, '')).some((t) => t === '*' || t === etag);
}

/** Expands the URL template for an entry (same rule as Muchi.Client AssetCatalog.UrlFor). */
export function assetUrl(v: Pick<PlatformCatalogView, 'baseUrl' | 'urlTemplate' | 'platform'>, e: Pick<AssetEntry, 'sha256' | 'file'>): string {
  return v.urlTemplate.replace(/\{(base|platform|sha256|file)\}/g, (_m, t: string) =>
    t === 'base' ? v.baseUrl : t === 'platform' ? v.platform : t === 'sha256' ? e.sha256 : e.file);
}
