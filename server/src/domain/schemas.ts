import { z } from 'zod';
import type { StartVisuals } from './visuals.js';
import { rulesetKeyProblems } from './ruleset.js';

const U64_MAX = (1n << 64n) - 1n;
export const u64Decimal = z.string().regex(/^(0|[1-9]\d{0,19})$/).refine((s) => BigInt(s) <= U64_MAX, 'exceeds uint64');
const int = z.number().int();
const i32 = int.min(-0x80000000).max(0x7fffffff);
const stat = int.min(0).max(1000);

export const styleSchema = z.enum(['nige', 'senko', 'sashi', 'oikomi']);
export const surfaceSchema = z.enum(['turf', 'dirt']);
export const aptSurfaceSchema = z.enum(['turf', 'dirt', 'both']);
// 'challenge': 週替わりチャレンジ (§31), a single-player race against CPU verified like time attack
export const modeSchema = z.enum(['ranked', 'friend', 'tutorial', 'timeattack', 'event', 'tournament', 'challenge']);
/** Ground condition names per surface (REQ-RACE-034). Absent = good. */
export const TURF_GOINGS = ['firm', 'good', 'yielding', 'soft'] as const;
export const DIRT_GOINGS = ['fast', 'good', 'muddy', 'sloppy'] as const;
export type Going = (typeof TURF_GOINGS)[number] | (typeof DIRT_GOINGS)[number];
export const goingSchema = z.enum(['firm', 'good', 'yielding', 'soft', 'fast', 'muddy', 'sloppy']);
export const goingAptitudeSchema = z.enum(['any', 'fast', 'heavy']);
export type GoingAptitude = z.infer<typeof goingAptitudeSchema>;
export const goingsFor = (surface: 'turf' | 'dirt'): readonly Going[] => (surface === 'dirt' ? DIRT_GOINGS : TURF_GOINGS);

export const segmentSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('straight'), lengthM: int.min(1) }).strict(),
  z.object({ kind: z.literal('corner'), lengthM: int.min(1), radiusM: int.min(1) }).strict(),
]);

export const trackSchema = z
  .object({
    id: z.string().min(1), surface: surfaceSchema, distanceM: int.min(1).max(4000), segments: z.array(segmentSchema).min(1),
    // optional ground fields (REQ-RACE-034/036): absent = good / day; old configs stay valid and unchanged
    going: goingSchema.optional(), night: z.boolean().optional(),
  })
  .strict()
  .refine((t) => t.segments.reduce((a, s) => a + s.lengthM, 0) === t.distanceM, 'segment lengths must sum to distanceM')
  .refine((t) => t.going === undefined || (goingsFor(t.surface) as readonly string[]).includes(t.going), 'going does not match the surface');

/** 固有スキルの発動条件 (ruleset 1.3, contracts/protocol.md §14). Conditions only: the engine never draws a random number for them. */
export const SKILL_TRIGGERS = ['finalStraight', 'cornerRail', 'lowStamina', 'spurtBehind', 'remaining', 'leading', 'slipstream', 'goodStart'] as const;
export const skillTriggerSchema = z.enum(SKILL_TRIGGERS);
export type SkillTrigger = z.infer<typeof skillTriggerSchema>;
/** Largest `value` per trigger (same as SkillSpec.MaxValue in engine/Muchi.Engine/Model.cs). */
export const SKILL_VALUE_MAX: Record<SkillTrigger, number> = {
  finalStraight: 11, cornerRail: 11, lowStamina: 1000, spurtBehind: 11, remaining: 4000, leading: 4000, slipstream: 1200, goodStart: 60,
};
const permille = int.min(0).max(1000);
/** The skill as a race config carries it: everything the engine needs, already capped for the mode (raceConfig.ts). */
export const raceSkillSchema = z
  .object({
    id: z.string().min(1), name: z.string().min(1), trigger: skillTriggerSchema, value: int.min(0),
    speedPermille: permille, accelPermille: permille, drainSavePermille: permille, recoverPermille: permille,
    durationTicks: int.min(0).max(1200),
  })
  .strict()
  .refine((k) => k.value <= SKILL_VALUE_MAX[k.trigger], 'skill value out of range for its trigger')
  .refine((k) => k.trigger !== 'slipstream' || k.value >= 1, 'slipstream skill value must be >= 1');
export type RaceSkill = z.infer<typeof raceSkillSchema>;

export const raceHorseSchema = z
  .object({
    id: z.string().min(1), name: z.string().min(1),
    speed: stat, stamina: stat, burst: stat, guts: stat, temper: stat,
    style: styleSchema, distMinM: int.min(0), distMaxM: int.min(0), surface: aptSurfaceSchema,
    goingAptitude: goingAptitudeSchema.optional(),
    // ruleset 1.3 unique skill; absent = none (and every config built before skills existed)
    skill: raceSkillSchema.optional(),
  })
  .strict()
  .refine((h) => h.distMinM <= h.distMaxM, 'distMinM > distMaxM');

export const entrantSchema = z
  .object({
    slot: int.min(0).max(11),
    kind: z.enum(['human', 'cpu']),
    playerId: z.string().min(1).nullable(),
    cpuLevel: int.min(1).max(5),
    horse: raceHorseSchema,
  })
  .strict()
  .refine((e) => (e.kind === 'cpu') === (e.playerId === null), 'cpu entrants have playerId null, humans non-null');

export const netSchema = z
  .object({
    tickHz: int.min(1).max(120), inputDelayTicks: int.min(0).max(60), bundleIntervalTicks: int.min(1).max(60),
    checksumIntervalTicks: int.min(1).max(1200), disconnectGraceMs: int.min(0).max(60000),
  })
  .strict();

export const rulesetSchema = z
  .record(z.string(), z.union([z.string(), i32]))
  .superRefine((r, ctx) => {
    for (const p of rulesetKeyProblems(r)) ctx.addIssue({ code: 'custom', message: p });
  });

export const raceStartConfigSchema = z
  .object({
    v: z.literal(1), raceId: z.string().min(1), mode: modeSchema, seed: u64Decimal,
    track: trackSchema, net: netSchema, ruleset: rulesetSchema, entrants: z.array(entrantSchema).min(1).max(12),
  })
  .strict()
  .superRefine((c, ctx) => {
    c.entrants.forEach((e, i) => { if (e.slot !== i) ctx.addIssue({ code: 'custom', message: `entrant ${i} has slot ${e.slot}` }); });
  });
export type RaceStartConfig = z.infer<typeof raceStartConfigSchema>;
export type Entrant = z.infer<typeof entrantSchema>;
export type RaceHorse = z.infer<typeof raceHorseSchema>;
export type Track = z.infer<typeof trackSchema>;
export type NetParams = z.infer<typeof netSchema>;
export type RaceMode = z.infer<typeof modeSchema>;

const hex16 = z.string().regex(/^[0-9a-f]{16}$/);
const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const tickN = int.min(0).max(1_000_000);

export const clientMessageSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('hello'), raceId: z.string().min(1), token: z.string().min(1), lastTick: int.min(-1) }).strict(),
  z.object({ t: z.literal('in'), tick: tickN, cmd: int.min(0).max(255) }).strict(),
  z.object({ t: z.literal('chk'), tick: tickN, h: hex16 }).strict(),
  // finishTicks (optional, same order as `order`, -1 = did not finish) lets the server keep best times without the verifier
  z.object({ t: z.literal('res'), h: hex64, order: z.array(int.min(0).max(11)).min(1).max(12), finishTicks: z.array(int.min(-1).max(1_000_000)).max(12).optional(), skills: z.array(int.min(0).max(11)).max(12).optional(), assist: z.enum(['whip', 'full']).optional() }).strict(),
  z.object({ t: z.literal('ping'), c: z.number() }).strict(),
]);
export type ClientMessage = z.infer<typeof clientMessageSchema>;

export const inputTripleSchema = z.tuple([tickN, int.min(0).max(11), int.min(1).max(255)]);
export type InputTriple = z.infer<typeof inputTripleSchema>;

export type ServerMessage =
  /** `you` = -1 and `spectator` set for a read-only spectator (REQ-SPEC-002). */
  | { t: 'start'; you: number; startAtMs: number; config: RaceStartConfig; visuals?: StartVisuals; spectator?: { delayMs: number } }
  | { t: 'b'; from: number; to: number; in: InputTriple[] }
  | { t: 'desync'; tick: number }
  | { t: 'final'; status: 'confirmed' | 'verifying' | 'void'; order: number[]; h: string }
  | { t: 'pong'; c: number; s: number }
  | { t: 'err'; code: string };

export const replayLogSchema = z
  .object({ v: z.literal(1), config: raceStartConfigSchema, endTick: int.min(-1), inputs: z.array(inputTripleSchema) })
  .strict()
  .superRefine((log, ctx) => {
    for (let i = 1; i < log.inputs.length; i++) {
      const [pt, ps] = log.inputs[i - 1]!;
      const [t, s] = log.inputs[i]!;
      if (t < pt || (t === pt && s <= ps)) ctx.addIssue({ code: 'custom', message: `inputs not sorted/unique at ${i}` });
    }
    for (const [, s] of log.inputs) if (s >= log.config.entrants.length) ctx.addIssue({ code: 'custom', message: `slot ${s} out of range` });
  });
export type ReplayLog = z.infer<typeof replayLogSchema>;

export const verifierOutputSchema = z
  .object({
    resultHash: hex64,
    order: z.array(int.min(0).max(11)),
    finishTicks: z.array(int.min(-1)),
    /** Q16.16 fraction of the finish tick per place, -1 = did not finish (optional for older verifiers). */
    finishFracs: z.array(int.min(-1).max(65535)).optional(),
    checksums: z.record(z.string().regex(/^\d+$/), hex16),
    /** REQ-ACH-002: slots whose unique skill fired in the re-simulation (optional for older verifiers). */
    skillsFired: z.array(int.min(0).max(11)).max(12).optional(),
  })
  .strict()
  .refine((o) => o.order.length === o.finishTicks.length, 'order/finishTicks length mismatch')
  .refine((o) => !o.finishFracs || o.finishFracs.length === o.order.length, 'order/finishFracs length mismatch');
export type VerifierOutput = z.infer<typeof verifierOutputSchema>;
