import { z } from 'zod';
import type { Master } from './master.js';

/**
 * クライアントのエラー報告 (client error & crash reporting, REQ-CERR-001..020, contracts/protocol.md §60): the pure part —
 * the batch schema, the config and its validation, the scrubber and the fingerprint. The C# client (Muchi.Client
 * ClientErrors.cs) implements the same scrubber / fingerprint; contracts/client-errors.vectors.json keeps them equal.
 * Nothing here touches the player state, coins or items.
 */

export const CLIENT_ERROR_CATEGORIES = ['exception', 'api', 'desync', 'asset', 'stall'] as const;
export type ClientErrorCategory = typeof CLIENT_ERROR_CATEGORIES[number];
export const CLIENT_ERROR_PLATFORMS = ['ios', 'android', 'editor'] as const;
export type ClientErrorPlatform = typeof CLIENT_ERROR_PLATFORMS[number];

// ------------------------------------------------------------------------------------------------ config (REQ-CERR-001)

export interface ClientErrorsConfig {
  enabled: boolean;
  /** Per-category sampling in permille (the device keeps this share of the items). desync is always 1000. */
  sampling: Record<ClientErrorCategory, number>;
  maxItems: number;
  maxBodyBytes: number;
  perPlayerPerHour: number;
  perDevicePerHour: number;
  anonymousPerMinute: number;
  flushIntervalSec: number;
  maxGroups: number;
  samplesPerGroup: number;
  retentionDays: number;
  spikeMinCount: number;
  spikeWindowHours: number;
}
export const CLIENT_ERRORS_DEFAULTS: ClientErrorsConfig = {
  enabled: true,
  sampling: { exception: 1000, api: 200, desync: 1000, asset: 500, stall: 100 },
  maxItems: 20, maxBodyBytes: 32768, perPlayerPerHour: 20, perDevicePerHour: 20, anonymousPerMinute: 120, flushIntervalSec: 60,
  maxGroups: 2000, samplesPerGroup: 5, retentionDays: 30, spikeMinCount: 50, spikeWindowHours: 24,
};

export function clientErrorsConfig(m: Pick<Master, 'progression'>): ClientErrorsConfig {
  const raw = (m.progression as { clientErrors?: Partial<ClientErrorsConfig> }).clientErrors ?? {};
  const known = Object.fromEntries(Object.entries(raw).filter(([k]) => !k.startsWith('_'))) as Partial<ClientErrorsConfig>; // `_note`
  return { ...CLIENT_ERRORS_DEFAULTS, ...known, sampling: { ...CLIENT_ERRORS_DEFAULTS.sampling, ...(known.sampling ?? {}) } };
}

/** REQ-CERR-001: boot and remote-config validation. */
export function clientErrorsProblems(m: Pick<Master, 'progression'>, path = 'progression.clientErrors'): string[] {
  const raw = (m.progression as { clientErrors?: unknown }).clientErrors;
  if (raw === undefined) return [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [`${path} must be an object`];
  const out: string[] = [];
  for (const k of Object.keys(raw)) if (!(k in CLIENT_ERRORS_DEFAULTS) && !k.startsWith('_')) out.push(`${path}.${k} is unknown`);
  const c = clientErrorsConfig(m);
  if (typeof c.enabled !== 'boolean') out.push(`${path}.enabled must be true or false`);
  const intIn = (v: unknown, lo: number, hi: number) => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;
  const rawSampling = (raw as { sampling?: unknown }).sampling;
  if (rawSampling !== undefined) {
    if (!rawSampling || typeof rawSampling !== 'object' || Array.isArray(rawSampling)) out.push(`${path}.sampling must be an object`);
    else {
      for (const k of Object.keys(rawSampling)) if (!(CLIENT_ERROR_CATEGORIES as readonly string[]).includes(k)) out.push(`${path}.sampling.${k} is unknown`);
      for (const k of CLIENT_ERROR_CATEGORIES) if (!(k in rawSampling)) out.push(`${path}.sampling.${k} is required (all five categories)`);
    }
  }
  for (const k of CLIENT_ERROR_CATEGORIES) if (!intIn(c.sampling[k], 0, 1000)) out.push(`${path}.sampling.${k} must be an integer 0..1000 (permille)`);
  if (c.sampling.desync !== 1000) out.push(`${path}.sampling.desync must be 1000 (desyncs are never sampled out: fairness)`);
  const int = (k: keyof ClientErrorsConfig, lo: number, hi: number) => { if (!intIn(c[k], lo, hi)) out.push(`${path}.${k} must be an integer ${lo}..${hi}`); };
  int('maxItems', 1, 50);
  int('maxBodyBytes', 4096, 65536);
  int('perPlayerPerHour', 1, 600);
  int('perDevicePerHour', 1, 600);
  int('anonymousPerMinute', 1, 6000);
  int('flushIntervalSec', 10, 3600);
  int('maxGroups', 100, 20000);
  int('samplesPerGroup', 1, 20);
  int('retentionDays', 7, 90);
  int('spikeMinCount', 1, 100000);
  int('spikeWindowHours', 1, 168);
  return out;
}

/** What the device needs to know (POST answer and GET /v1/config). */
export const clientErrorsClientView = (c: ClientErrorsConfig) => ({ enabled: c.enabled, sampling: { ...c.sampling }, flushIntervalSec: c.flushIntervalSec });

// ------------------------------------------------------------------------------------------------ the batch (REQ-CERR-002/003)

export const CLIENT_ERROR_LIMITS = { message: 300, stack: 4000, stackLines: 40, title: 160 } as const;
const ident = (max: number) => z.string().regex(/^[A-Za-z0-9_.:\-]+$/).min(1).max(max);
const common = {
  at: z.number().int().min(0).max(4_102_444_800_000),
  count: z.number().int().min(1).max(10_000).default(1),
  sampleRate: z.number().int().min(1).max(1000).default(1000),
};
const exceptionItem = z.object({
  category: z.literal('exception'), ...common,
  type: z.string().regex(/^[A-Za-z0-9_.$`<>+\-]+$/).min(1).max(80),
  message: z.string().max(2000).default(''),
  stack: z.string().max(16000).default(''),
  handled: z.boolean().default(false),
  screen: ident(40).optional(),
}).strict();
const apiItem = z.object({
  category: z.literal('api'), ...common,
  method: z.enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH']),
  route: z.string().regex(/^\/v1\/[A-Za-z0-9_.:\/\-]*$/).max(160),
  status: z.number().int().min(0).max(599),
  code: ident(40).optional(),
  reason: z.enum(['network', 'timeout', 'http']),
}).strict();
/** REQ-CERR-002: race id and tick only — a key carrying inputs / checksums / state makes the batch invalid (strict). */
const desyncItem = z.object({
  category: z.literal('desync'), ...common,
  raceId: ident(80),
  tick: z.number().int().min(0).max(100_000),
  mode: ident(32),
  engineLevel: z.number().int().min(0).max(9999).optional(),
}).strict();
const assetItem = z.object({
  category: z.literal('asset'), ...common,
  assetKey: z.string().regex(/^[A-Za-z0-9_.\/\-]+$/).min(1).max(120),
  reason: z.enum(['http', 'hash', 'disk', 'timeout', 'network', 'other']),
  status: z.number().int().min(0).max(599).optional(),
}).strict();
const stallItem = z.object({
  category: z.literal('stall'), ...common,
  kind: z.enum(['long_frame', 'anr']),
  durationMs: z.number().int().min(1).max(600_000),
  screen: ident(40),
}).strict();
export const clientErrorItemSchema = z.discriminatedUnion('category', [exceptionItem, apiItem, desyncItem, assetItem, stallItem]);
export type ClientErrorItem = z.infer<typeof clientErrorItemSchema>;

export const clientErrorBatchSchema = z.object({
  batchId: z.string().regex(/^[A-Za-z0-9_\-]{8,64}$/),
  platform: z.enum(CLIENT_ERROR_PLATFORMS),
  appVersion: z.string().regex(/^[A-Za-z0-9.+_\-]{1,32}$/),
  osVersion: z.string().max(80).default(''),
  deviceModel: z.string().max(80).default(''),
  /** A random id the app makes on first launch (never derived from a device or advertising id). */
  installId: z.string().regex(/^[A-Za-z0-9_\-]{8,64}$/),
  attachPlayer: z.boolean().default(true),
  items: z.array(clientErrorItemSchema).min(1).max(50),
}).strict();
export type ClientErrorBatch = z.infer<typeof clientErrorBatchSchema>;

// ------------------------------------------------------------------------------------------------ scrubber (REQ-CERR-008)

const RE_EDGES = /^[ \t\r\n\f\v]+|[ \t\r\n\f\v]+$/g;
/** Device model / OS version: a short allow-listed charset, else `other` (REQ-CERR-008). */
export function deviceField(v: string | undefined | null): string {
  const s = (v ?? '').replace(RE_EDGES, '').replace(/[ \t\r\n\f\v]+/g, ' ');
  if (s === '') return '';
  return /^[A-Za-z0-9 ,._()\-]{1,40}$/.test(s) ? s : 'other';
}

// Every class is spelled out in ASCII ([0-9] not \d, explicit word boundaries, no `i` flag): .NET and JavaScript read
// \d, \s, \b and case folding differently, and the C# ErrorScrubber uses these exact patterns.
const WS = ' \\t\\r\\n\\f\\v';
const B0 = '(?<![A-Za-z0-9_])';
const B1 = '(?![A-Za-z0-9_])';
const g = (src: string) => new RegExp(src, 'g');
const RE = {
  il: g(`[${WS}]*\\[0x[0-9a-fA-F]+\\]`),
  build: g(`[${WS}]*in <[0-9a-fA-F]{6,}>(?::[0-9]+)?`),
  email: g('[A-Za-z0-9._%+\\-]+@[A-Za-z0-9.\\-]+\\.[A-Za-z]{2,}'),
  bearer: g(`${B0}(?:[Bb]earer|BEARER)[ \\t]+[A-Za-z0-9._~+/=\\-]+`),
  jwt: g(`${B0}eyJ[A-Za-z0-9_\\-]*\\.[A-Za-z0-9_\\-]+\\.[A-Za-z0-9_\\-]+`),
  url: g(`${B0}[A-Za-z][A-Za-z0-9+.\\-]*://[^${WS}"'<>()]+`),
  // a path with at least one directory: keep the last segment (file name, maybe with :line)
  path: g(`(?:[A-Za-z]:)?(?:[^${WS}\\\\/:"'()<>\\[\\]]*[\\\\/])+([^${WS}\\\\/:"'()<>\\[\\]]+)`),
  quoted: g('"[^"\\n]*"|\'[^\'\\n]*\'|「[^」\\n]*」'),
  nonAscii: g('[^\\x00-\\x7F]+'),
  hex: g(`${B0}[0-9a-fA-F]{12,}${B1}`),
  // R21 integration (§63 × §60): a share link token (22 characters of its alphabet, maybe without a digit) — a key to its target
  linkToken: g(`${B0}[2-9a-hjkmnp-z]{22}${B1}`),
  longId: g(`${B0}(?=[A-Za-z0-9_\\-]*[0-9])[A-Za-z0-9_\\-]{20,}${B1}`),
  idPrefix: g(`${B0}[a-z]{1,4}_(?=[A-Za-z0-9]*[0-9])[A-Za-z0-9]{3,}${B1}`),
  digits: g('[0-9]{5,}'),
  spaces: g('[ \\t]+'),
  edges: g(`^[${WS}]+|[${WS}]+$`),
};
/** The rules in order with their replacement (the C# ErrorScrubber has the same list). */
export const SCRUB_RULES: [RegExp, string][] = [
  [RE.il, ''], [RE.build, ''], [RE.email, '<email>'], [RE.bearer, '<token>'], [RE.jwt, '<token>'], [RE.url, '<url>'], [RE.path, '$1'],
  [RE.quoted, '"…"'], [RE.nonAscii, '…'], [RE.hex, '<id>'], [RE.linkToken, '<token>'], [RE.longId, '<id>'], [RE.idPrefix, '<id>'], [RE.digits, '<n>'], [RE.spaces, ' '], [RE.edges, ''],
];

/**
 * R22 §69 (REQ-SURVEY-012): the PII part of the rules for free text a player wrote on purpose (survey answers): emails,
 * tokens, URLs, long ids and long numbers. Japanese text and quotes stay (they are the answer). R22 integration: the §63
 * share-link token rule too (a pasted /l/<token> or bare token is a key to a room / invite), in the same order as above.
 */
export const FREE_TEXT_SCRUB_RULES: [RegExp, string][] = [
  [RE.email, '<email>'], [RE.bearer, '<token>'], [RE.jwt, '<token>'], [RE.url, '<url>'], [RE.hex, '<id>'], [RE.linkToken, '<token>'], [RE.longId, '<id>'], [RE.idPrefix, '<id>'], [RE.digits, '<n>'],
];

/**
 * Round 23 (§73.3): the secret rules alone (bearer tokens, JWTs, share-link tokens) for text a person must still read —
 * support tickets keep Japanese, quotes and numbers, so the other rules are not applied there.
 */
export const SECRET_SCRUB_RULES: readonly [RegExp, string][] = [[RE.bearer, '<token>'], [RE.jwt, '<token>'], [RE.linkToken, '<token>']];

/** One line of free text: the §60.3 rules in order. */
function scrubLine(s: string): string {
  let out = s;
  for (const [re, to] of SCRUB_RULES) out = out.replace(re, to);
  return out;
}

/** REQ-CERR-008: a message (one line, at most 300 chars). */
export function scrubMessage(s: string): string {
  return truncate(scrubLine((s ?? '').replace(/[\r\n]+/g, ' ')), CLIENT_ERROR_LIMITS.message);
}

/** REQ-CERR-008: a stack trace (at most 40 non-empty lines, 4,000 chars). */
export function scrubStack(s: string): string {
  const lines = (s ?? '').split(/\r?\n/).map(scrubLine).filter((l) => l !== '').slice(0, CLIENT_ERROR_LIMITS.stackLines);
  return truncate(lines.join('\n'), CLIENT_ERROR_LIMITS.stack);
}

function truncate(s: string, max: number): string {
  const cps = [...s];
  return cps.length <= max ? s : cps.slice(0, max - 1).join('') + '…';
}

// ------------------------------------------------------------------------------------------------ fingerprint (REQ-CERR-009)

/** FNV-1a 64-bit over the UTF-8 bytes, 16 lowercase hex chars (C# ErrorFingerprint.Fnv64 is the same). */
export function fnv1a64(text: string): string {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (const b of new TextEncoder().encode(text)) {
    h ^= BigInt(b);
    h = (h * prime) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, '0');
}

/** The message's shape: digits → `#` (after the scrubber). */
export const messageTemplate = (scrubbed: string) => scrubbed.replace(/[0-9]+/g, '#');

/** One stack line without addresses and line numbers (so a small edit does not split a fingerprint). */
export function frameKey(line: string): string {
  return line
    .replace(/\[0x[0-9a-fA-F]+\]/g, '')
    .replace(/<[0-9a-fA-F]{6,}>/g, '')
    .replace(/\+[ \t]*0x[0-9a-fA-F]+/g, '')
    .replace(/:[0-9]+/g, '')
    .replace(/[0-9]+/g, '#')
    .replace(/[ \t\r\n\f\v]+/g, ' ')
    .replace(RE_EDGES, '');
}
export function topFrames(scrubbedStack: string, n = 5): string[] {
  return scrubbedStack.split('\n').map(frameKey).filter((l) => l !== '').slice(0, n);
}

/** `/v1/horses/h_9f2k/goals` → `/v1/horses/:id/goals` (ids: all digits, has a digit and ≥ 6 chars, or `x_…` with a digit). */
export function normalizeRoute(route: string): string {
  const path = route.split(/[?#]/)[0]!;
  return path.split('/').map((seg) => {
    if (seg === '' || seg.startsWith(':')) return seg;
    if (/^[a-z]{1,4}_(?=[A-Za-z0-9]*[0-9])[A-Za-z0-9]+$/.test(seg) || (/[0-9]/.test(seg) && seg.length >= 6) || /^[0-9]+$/.test(seg) || /^[2-9a-hjkmnp-z]{22}$/.test(seg)) return ':id'; // R21: a link token
    return seg;
  }).join('/');
}

/** `ab/cd/ef.bundle` → `ab/cd` (the first two levels group the downloads). */
export const assetGroup = (key: string) => key.split('/').slice(0, 2).join('/');

/** The scrubbed item the server keeps (every free text field re-scrubbed: the device is not trusted). */
export type ScrubbedItem =
  | { category: 'exception'; type: string; message: string; stack: string; handled: boolean; screen: string | null }
  | { category: 'api'; method: string; route: string; status: number; code: string | null; reason: string }
  | { category: 'desync'; raceId: string; tick: number; mode: string; engineLevel: number | null }
  | { category: 'asset'; assetKey: string; reason: string; status: number | null }
  | { category: 'stall'; kind: string; durationMs: number; screen: string };

export function scrubItem(i: ClientErrorItem): ScrubbedItem {
  switch (i.category) {
    case 'exception': return { category: 'exception', type: i.type, message: scrubMessage(i.message), stack: scrubStack(i.stack), handled: i.handled, screen: i.screen ?? null };
    case 'api': return { category: 'api', method: i.method, route: normalizeRoute(i.route), status: i.status, code: i.code ?? null, reason: i.reason };
    case 'desync': return { category: 'desync', raceId: i.raceId, tick: i.tick, mode: i.mode, engineLevel: i.engineLevel ?? null };
    case 'asset': return { category: 'asset', assetKey: i.assetKey, reason: i.reason, status: i.status ?? null };
    case 'stall': return { category: 'stall', kind: i.kind, durationMs: i.durationMs, screen: i.screen };
  }
}

/** The string the fingerprint hashes (§60.4). */
export function fingerprintSource(s: ScrubbedItem): string {
  switch (s.category) {
    case 'exception': return ['exception', s.type, messageTemplate(s.message), topFrames(s.stack).join(';')].join('|');
    case 'api': return ['api', s.method, normalizeRoute(s.route), String(s.status), s.code ?? '-'].join('|');
    case 'desync': return ['desync', s.mode].join('|');
    case 'asset': return ['asset', s.reason, assetGroup(s.assetKey)].join('|');
    case 'stall': return ['stall', s.kind, s.screen].join('|');
  }
}
export const fingerprintOf = (s: ScrubbedItem) => fnv1a64(fingerprintSource(s));

/** The one-line title the console lists (scrubbed). */
export function titleOf(s: ScrubbedItem): string {
  const t = (() => {
    switch (s.category) {
      case 'exception': return `${s.type}: ${messageTemplate(s.message)}`;
      case 'api': return `${s.method} ${s.route} → ${s.status}${s.code ? ` ${s.code}` : ''} (${s.reason})`;
      case 'desync': return `desync (${s.mode})`;
      case 'asset': return `asset ${assetGroup(s.assetKey)} (${s.reason}${s.status ? ` ${s.status}` : ''})`;
      case 'stall': return `${s.kind} on ${s.screen}`;
    }
  })();
  return truncate(t, CLIENT_ERROR_LIMITS.title);
}

/** The category-specific part a sample keeps (desync: race id and tick — never inputs). */
export function contextOf(s: ScrubbedItem): Record<string, unknown> {
  const { category: _c, ...rest } = s;
  if (s.category === 'exception') { const { message: _m, stack: _s, ...x } = rest as Record<string, unknown>; return x; }
  return rest;
}

// ------------------------------------------------------------------------------------------------ shared vectors (REQ-CERR-008/009)

/** Inputs of contracts/client-errors.vectors.json (npm run gen:client-error-vectors writes the expected outputs). */
export const CLIENT_ERROR_VECTOR_INPUTS = {
  messages: [
    'Object reference not set to an instance of an object',
    'Login failed for alice.smith@example.com with token Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJl',
    'Horse "ハヤテ号" not found for player p_9f2k31',
    'Could not load https://assets.example.com/ios/abc/def.bundle?sig=xyz in 12345 ms',
    'Failed to open C:\\Users\\bob\\AppData\\LocalLow\\Muchi\\save.json',
    'File /Users/alice/proj/Assets/Muchi/Game/HudModel.cs line 120',
    'Key 6c1f0b9e2a7d4c3b8a9e already present (index 42)',
    'チームに参加できません',
    "Unexpected char 'x' at position 7",
    '名前「サクラ」は使えません',
    'Session 1a2b3c4d5e6f7a8b9c0d1e2f expired',
    '  multiple   spaces\tand\ttabs  ',
    // engine differences the patterns avoid (\b, \s, case folding, surrogate pairs, BOM)
    'あBearer secret123 sent',
    'Kelvin K and　wide space, BEARER abc',
    'emoji 🐎 run p_1x2 done',
    // R21 integration (§63 × §60): share link tokens, with and without a digit
    'resolve failed: https://link.muchi-issen.example/l/kmqxphrabcdefghjkmnpqr',
    'open /l/kmqxphrabcdefghjkmnpqr failed',
    'token kmqxphrabcdefghjkmnpqr rejected; revoke(k7mq3xphr2abcdefghjkmn)',
    'muchi://l/kmqxphrabcdefghjkmnpqr',
    '﻿bom first',
  ],
  stacks: [
    'Muchi.Game.HudModel.Update () (at Assets/Muchi/Game/HudModel.cs:120)\nMuchi.Game.RaceDrivers.Tick (System.Int32 t) (at Assets/Muchi/Game/RaceDrivers.cs:88)\nUnityEngine.Events.InvokableCall.Invoke () (at /Users/build/unity/Runtime/Export/UnityEvent.cs:178)',
    '  at Muchi.Client.ApiClient+<Call>d__12`1[T].MoveNext () [0x0012f] in <8c2f1a9b3d4e4f5a>:0\n  at System.Runtime.CompilerServices.AsyncMethodBuilderCore.Start () [0x00000] in /home/runner/work/x.cs:12',
  ],
  routes: ['/v1/horses/h_9f2k/goals', '/v1/gacha/standard/draw', '/v1/race/race_20261111_0042/report', '/v1/teams/123456/feed?cursor=9', '/v1/player', '/v1/time-attack/sakura_2000/me', '/v1/links/kmqxphrabcdefghjkmnpqr', '/v1/links/k7mq3xphr2abcdefghjkmn'],
  devices: ['iPhone15,2', 'iOS 18.1', 'SM-S918B', 'Android 14 (API 34)', 'Pixel 8 Pro — test', '<script>', '', '\uFEFFiPhone', ' \t iPad13,1 '],
  items: [
    { category: 'exception', at: 1, type: 'NullReferenceException', message: 'Object reference not set to an instance of an object', stack: 'Muchi.Game.HudModel.Update () (at Assets/Muchi/Game/HudModel.cs:120)\nMuchi.Game.RaceDrivers.Tick (System.Int32 t) (at Assets/Muchi/Game/RaceDrivers.cs:88)', handled: false },
    { category: 'exception', at: 1, type: 'NullReferenceException', message: 'Object reference not set to an instance of an object', stack: 'Muchi.Game.HudModel.Update () (at /Users/carol/other/Assets/Muchi/Game/HudModel.cs:131)\nMuchi.Game.RaceDrivers.Tick (System.Int32 t) (at Assets/Muchi/Game/RaceDrivers.cs:90)', handled: false },
    { category: 'exception', at: 1, type: 'InvalidOperationException', message: 'Sequence contains 3 elements', stack: '', handled: true },
    { category: 'api', at: 1, method: 'POST', route: '/v1/horses/h_9f2k/goals', status: 500, code: 'INTERNAL', reason: 'http' },
    { category: 'api', at: 1, method: 'GET', route: '/v1/player', status: 0, reason: 'network' },
    { category: 'desync', at: 1, raceId: 'race_1', tick: 812, mode: 'ranked' },
    { category: 'asset', at: 1, assetKey: 'ios/horses/sakura.bundle', reason: 'hash' },
    { category: 'stall', at: 1, kind: 'anr', durationMs: 6200, screen: 'gacha_reveal' },
  ] as unknown[],
};

export function clientErrorVectorsJson(): string {
  const v = CLIENT_ERROR_VECTOR_INPUTS;
  const doc = {
    _note: 'REQ-CERR-008/009 (contracts/protocol.md §60.3–60.4): the TS server (server/src/domain/clientErrors.ts) and the C# client (Muchi.Client ErrorScrubber / ErrorFingerprint) turn every input into exactly these outputs. npm run gen:client-error-vectors rewrites this file.',
    fnv: ['', 'a', 'exception|X|y|z', 'ムチ一閃'].map((input) => ({ input, hash: fnv1a64(input) })),
    messages: v.messages.map((input) => ({ input, output: scrubMessage(input) })),
    stacks: v.stacks.map((input) => ({ input, output: scrubStack(input), frames: topFrames(scrubStack(input)) })),
    routes: v.routes.map((input) => ({ input, output: normalizeRoute(input) })),
    devices: v.devices.map((input) => ({ input, output: deviceField(input) })),
    fingerprints: v.items.map((input) => { const s = scrubItem(clientErrorItemSchema.parse(input)); return { input, source: fingerprintSource(s), fingerprint: fingerprintOf(s) }; }),
  };
  return `${JSON.stringify(doc, null, 2)}\n`;
}
