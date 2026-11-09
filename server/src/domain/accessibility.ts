/**
 * アクセシビリティ設定 (accessibility settings, REQ-A11Y-001..016, contracts/protocol.md §41).
 *
 * A small per-account settings blob: text size, colour-vision support, reduce motion, haptics, commentary subtitles,
 * one-handed layout hint and whip input (tap / hold). Everything here is presentation or an input aid that only produces
 * the normal input bytes (the hold → `Muchi.Client.WhipHold`, capped like §27): nothing touches a race result, a ruleset,
 * the verifier or a replay. PUT is an idempotent full replace (keys left out go back to their defaults).
 */
import { z } from 'zod';
import { AppError } from './errors.js';
import type { PlayerState } from './player.js';
import type { Emit } from './service.js';

export const TEXT_SIZES = ['standard', 'large', 'largest'] as const;
export const COLOR_MODES = ['standard', 'cvd'] as const;
export const ONE_HANDED = ['off', 'left', 'right'] as const;
export const WHIP_INPUTS = ['tap', 'hold'] as const;

export interface AccessibilitySettings {
  textSize: typeof TEXT_SIZES[number];
  colorMode: typeof COLOR_MODES[number];
  reduceMotion: boolean;
  haptics: boolean;
  subtitles: boolean;
  oneHanded: typeof ONE_HANDED[number];
  whipInput: typeof WHIP_INPUTS[number];
}

/** REQ-A11Y-001: the defaults (also what a player who never opened the screen gets). */
export const A11Y_DEFAULTS: Readonly<AccessibilitySettings> = Object.freeze({
  textSize: 'standard', colorMode: 'standard', reduceMotion: false, haptics: true, subtitles: true, oneHanded: 'off', whipInput: 'tap',
});
/** Key order = KPI row order. */
export const A11Y_KEYS = Object.keys(A11Y_DEFAULTS) as (keyof AccessibilitySettings)[];
/** REQ-A11Y-005: body text multipliers per step (headings ≥ 28 px stay as they are). */
export const TEXT_SCALE: Readonly<Record<AccessibilitySettings['textSize'], number>> = Object.freeze({ standard: 1, large: 1.15, largest: 1.3 });
/** REQ-A11Y-008: no effect may flash more often than this in any one second (WCAG 2.3.1 general flash threshold). */
export const MAX_FLASHES_PER_SECOND = 3;

/** PUT /v1/settings/accessibility body: every key optional (left out = default), nothing else allowed. */
export const accessibilityBodySchema = z.object({
  textSize: z.enum(TEXT_SIZES).optional(),
  colorMode: z.enum(COLOR_MODES).optional(),
  reduceMotion: z.boolean().optional(),
  haptics: z.boolean().optional(),
  subtitles: z.boolean().optional(),
  oneHanded: z.enum(ONE_HANDED).optional(),
  whipInput: z.enum(WHIP_INPUTS).optional(),
}).strict();
export type AccessibilityBody = z.infer<typeof accessibilityBodySchema>;

export interface AccessibilityState extends AccessibilitySettings {
  /** +1 on every PUT that changed a value (clients compare it with their local copy). */
  rev: number;
  updatedAt: number | null;
}

/** GET /v1/settings/accessibility (and `accessibility` in GET /v1/player / bootstrap). Read-only: never creates state. */
export function accessibilityView(s: PlayerState) {
  const a = s.accessibility;
  const settings: AccessibilitySettings = { ...A11Y_DEFAULTS };
  if (a) for (const k of A11Y_KEYS) (settings as unknown as Record<string, unknown>)[k] = a[k];
  return {
    ...settings,
    rev: a?.rev ?? 0,
    updatedAt: a?.updatedAt ?? null,
    textScale: { ...TEXT_SCALE },
    // REQ-A11Y-012/013: fixed policy (in the spec, not remote config)
    rules: { affectsRace: false, whipHold: 'same_as_tap', maxFlashesPerSecond: MAX_FLASHES_PER_SECOND },
  };
}

const wire = (v: unknown) => (v === true ? 'on' : v === false ? 'off' : String(v));

/**
 * PUT /v1/settings/accessibility (REQ-A11Y-002): replaces the whole blob. The same body twice changes nothing (no rev
 * bump, no KPI), so retries need no idempotency key. One `a11y_setting_change` per changed key (REQ-A11Y-014).
 */
export function setAccessibility(s: PlayerState, body: AccessibilityBody, now: number, emit: Emit) {
  // the route validates too; this keeps internal callers (the prototype, tests) to the same values
  const r = accessibilityBodySchema.safeParse(body);
  if (!r.success) throw new AppError('BAD_REQUEST', 'accessibility: ' + r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  const next: AccessibilitySettings = { ...A11Y_DEFAULTS, ...stripUndefined(r.data) };
  const before = accessibilityView(s);
  const changed = A11Y_KEYS.filter((k) => before[k] !== next[k]);
  if (changed.length === 0) return before;
  s.accessibility = { ...next, rev: before.rev + 1, updatedAt: now };
  for (const k of changed) emit({ name: 'a11y_setting_change', s1: k, s2: wire(next[k]), s3: 'settings' });
  return accessibilityView(s);
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  return out;
}
