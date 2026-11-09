/**
 * マイリプレイ — saved replays of the player's own races (REQ-MYRP-*, contracts/protocol.md §37).
 *
 * Only what re-simulates the race is kept: the §7 replay log (config + confirmed inputs) and the result hash. The
 * device re-runs the engine to show it (REQ-RACE-073) and refuses to play anything whose hash does not match. Coins and
 * items never move here (no economy target); the free slot count is never sold.
 *
 * Pure rules on the player's state; R2 and the friend checks live in myReplaysService.ts.
 */
import { z } from 'zod';
import { AppError } from './errors.js';
import { foldForCompare } from './horses.js';
import { deletionScheduled } from './accountDeletion.js';
import { moderationOf, type PlayerState } from './player.js';
import { DAY_MS } from './time.js';
import { rulesetKeyProblems } from './ruleset.js';
import type { Master } from './master.js';
import type { RaceMode, RaceStartConfig, ReplayLog } from './schemas.js';
import type { RaceResultForPlayer } from './rewards.js';
import type { Emit } from './service.js';

// ------------------------------------------------------------------------------------------------ config

export interface MyReplaysConfig {
  enabled: boolean;
  /** Free saved replays per player (never raised by a purchase). */
  maxSaved: number;
  titleMaxChars: number;
  /** Largest stored file (bytes of the JSON written to R2). */
  maxBytes: number;
  /** Recent races that are not best moments, newest first. */
  recentKeep: number;
  /** Auto-kept best moments (win / photo / pb); the oldest rotates out. */
  momentsKeep: number;
  /** Days a recent race / moment can still be saved (the source log must still be in R2: < replayRetentionDays). */
  momentDays: number;
  /** A finish within this many ticks of the neighbouring place is a photo finish. */
  photoFinishTicks: number;
  /** Ruleset versions the engine no longer replays (their saved replays show 「再生できません」). */
  retiredRulesets: string[];
}

/** R2 cost / retention ceilings a remote config can never exceed (REQ-MYRP-013). */
export const MY_REPLAYS_HARD_LIMITS = { maxSaved: 50, titleMaxChars: 30, minBytes: 16 * 1024, maxBytes: 1024 * 1024, recentKeep: 50, momentsKeep: 20, photoFinishTicks: 5, retired: 50 };

export const DEFAULT_MY_REPLAYS: MyReplaysConfig = {
  enabled: true, maxSaved: 20, titleMaxChars: 24, maxBytes: 256 * 1024, recentKeep: 30, momentsKeep: 10, momentDays: 28, photoFinishTicks: 1, retiredRulesets: [],
};

const myReplaysConfigSchema = z.object({
  _note: z.string().optional(),
  enabled: z.boolean(), maxSaved: z.number().int(), titleMaxChars: z.number().int(), maxBytes: z.number().int(),
  recentKeep: z.number().int(), momentsKeep: z.number().int(), momentDays: z.number().int(), photoFinishTicks: z.number().int(),
  retiredRulesets: z.array(z.string().min(1).max(40)),
}).strict();

export function myReplaysConfig(m: Master): MyReplaysConfig {
  return m.progression.myReplays ?? { ...DEFAULT_MY_REPLAYS, enabled: false };
}

export function myReplaysProblems(m: Pick<Master, 'progression'>, path = 'progression.myReplays'): string[] {
  const raw = (m.progression as { myReplays?: unknown }).myReplays;
  if (raw === undefined) return [];
  const r = myReplaysConfigSchema.safeParse(raw);
  if (!r.success) return r.error.issues.map((i) => `${path}.${i.path.join('.')}: ${i.message}`);
  const c = r.data;
  const H = MY_REPLAYS_HARD_LIMITS;
  const out: string[] = [];
  const within = (k: string, v: number, lo: number, hi: number) => { if (v < lo || v > hi) out.push(`${path}.${k}: must be ${lo}..${hi}`); };
  within('maxSaved', c.maxSaved, 1, H.maxSaved);
  within('titleMaxChars', c.titleMaxChars, 1, H.titleMaxChars);
  within('maxBytes', c.maxBytes, H.minBytes, H.maxBytes);
  within('recentKeep', c.recentKeep, 1, H.recentKeep);
  within('momentsKeep', c.momentsKeep, 0, H.momentsKeep);
  // the source log (R2 replays/) must still exist for the whole window, or a listed race could not be saved
  within('momentDays', c.momentDays, 1, Math.max(1, m.progression.replayRetentionDays - 1));
  within('photoFinishTicks', c.photoFinishTicks, 0, H.photoFinishTicks);
  if (c.retiredRulesets.length > H.retired) out.push(`${path}.retiredRulesets: at most ${H.retired}`);
  return out;
}

// ------------------------------------------------------------------------------------------------ state

export type ReplayMoment = 'win' | 'photo' | 'pb';
export const REPLAY_MOMENTS: readonly ReplayMoment[] = ['win', 'photo', 'pb'];

export interface RecentRace {
  raceId: string; at: number; mode: RaceMode; trackId: string; place: number; fieldSize: number; slot: number;
  resultHash: string; rulesetVersion: string; moment: ReplayMoment | null;
}
export interface SavedReplay extends RecentRace {
  replayTitle: string | null; favorite: boolean; public: boolean; savedAt: number; sizeBytes: number;
}
export interface MyReplaysState { recent: RecentRace[]; saved: SavedReplay[] }

export function ensureMyReplays(s: PlayerState): MyReplaysState {
  s.myReplays ??= { recent: [], saved: [] };
  return s.myReplays;
}
const peek = (s: PlayerState): MyReplaysState | undefined => s.myReplays;

/** R2 key of a saved copy (outside the swept `replays/` prefix). */
export const savedReplayKey = (playerId: string, raceId: string) => `myreplays/${playerId}/${raceId}.json`;
/** R2 key of the source log the race room wrote (§7). */
export const sourceReplayKey = (raceId: string) => `replays/${raceId}.json`;
/** The stored file (REQ-MYRP-003). */
export interface SavedReplayFile { v: 1; log: ReplayLog; resultHash: string }

/** Every saved copy of the player (account deletion, REQ-MYRP-012). */
export const savedReplayKeys = (s: PlayerState) => (peek(s)?.saved ?? []).map((r) => savedReplayKey(s.id, r.raceId));

// ------------------------------------------------------------------------------------------------ recording (applyRace)

const RACE_ID_RE = /^[\w.:-]{1,128}$/;
export const isReplayId = (id: string) => RACE_ID_RE.test(id);

/** What the room adds to a confirmed result for this feature (settleRace). */
export interface ReplayRef {
  slot: number; resultHash: string; rulesetVersion: string; trackId: string;
  /** Smallest finish-tick gap to the neighbouring place(s); null when the finish ticks are unknown or the horse did not finish. */
  marginTicks: number | null;
}

/** The best moment of a race, if any (REQ-MYRP-002). `prevBest` = the track's best finish tick before this race. */
export function momentOf(r: RaceResultForPlayer, prevBest: number | null, photoFinishTicks: number): ReplayMoment | null {
  if (r.place === 1) return 'win';
  const gap = r.replay?.marginTicks;
  if (gap !== null && gap !== undefined && gap <= photoFinishTicks) return 'photo';
  const ft = r.details?.finishTick;
  if (ft != null && ft >= 0 && !r.details?.cpuAssisted && prevBest !== null && ft < prevBest) return 'pb';
  return null;
}

/** Keeps the windows: drops what can no longer be saved, then trims moments and plain recent races separately. */
export function pruneRecent(m: Master, st: MyReplaysState, now: number) {
  const c = myReplaysConfig(m);
  const fresh = st.recent.filter((r) => now - r.at < c.momentDays * DAY_MS).sort((a, b) => b.at - a.at);
  const moments = fresh.filter((r) => r.moment !== null).slice(0, c.momentsKeep);
  const plain = fresh.filter((r) => r.moment === null).slice(0, c.recentKeep);
  const keep = new Set([...moments, ...plain]);
  st.recent = fresh.filter((r) => keep.has(r));
}

/** REQ-MYRP-001/002: remember a confirmed race of the player (applyRace, already de-duplicated per race id). */
export function noteRaceForReplays(m: Master, s: PlayerState, r: RaceResultForPlayer, prevBest: number | null, now: number) {
  const c = myReplaysConfig(m);
  if (!c.enabled || r.void || !r.replay || r.mode === 'tutorial' || r.mode === 'timeattack') return;
  const st = ensureMyReplays(s);
  if (st.recent.some((x) => x.raceId === r.raceId)) return;
  st.recent.push({
    raceId: r.raceId, at: now, mode: r.mode, trackId: r.replay.trackId, place: r.place, fieldSize: r.fieldSize, slot: r.replay.slot,
    resultHash: r.replay.resultHash, rulesetVersion: r.replay.rulesetVersion, moment: momentOf(r, prevBest, c.photoFinishTicks),
  });
  pruneRecent(m, st, now);
}

// ------------------------------------------------------------------------------------------------ playability

export type UnplayableReason = 'ruleset_retired' | 'ruleset_unknown';
/** The version without the event suffix (`1.0.0+ev.cup` → `1.0.0`, §8.2). */
export const baseRulesetVersion = (v: string) => v.split('+')[0]!;

/** REQ-MYRP-007: retired versions match exactly or as a dotted prefix (`1.0` retires 1.0 and 1.0.x). */
export function rulesetRetired(m: Master, version: string): boolean {
  const base = baseRulesetVersion(version);
  return myReplaysConfig(m).retiredRulesets.some((r) => base === r || base.startsWith(`${r}.`));
}

export function playabilityOf(m: Master, version: string, ruleset?: Record<string, unknown>): { playable: boolean; reason: UnplayableReason | null } {
  if (rulesetRetired(m, version)) return { playable: false, reason: 'ruleset_retired' };
  if (ruleset && rulesetKeyProblems(ruleset).length > 0) return { playable: false, reason: 'ruleset_unknown' };
  return { playable: true, reason: null };
}

// ------------------------------------------------------------------------------------------------ titles

const DELETION_GUARD = (s: PlayerState) => { if (deletionScheduled(s)) throw new AppError('DELETION_PENDING', 'the account is scheduled for deletion'); };

/** REQ-MYRP-004: the same rules as display names (NFKC, no control characters / URLs, the NG list). */
export function validateReplayTitle(m: Master, raw: string | null): string | null {
  if (raw === null) return null;
  const max = myReplaysConfig(m).titleMaxChars;
  const t = raw.normalize('NFKC').trim().replace(/\s+/g, ' ');
  const len = [...t].length;
  if (len < 1 || len > max) throw new AppError('INVALID_NAME', `1〜${max}文字`);
  if (/[\p{C}]/u.test(t)) throw new AppError('INVALID_NAME', 'control characters');
  if (/https?:|www\.|\.(com|net|jp)\b/i.test(t)) throw new AppError('INVALID_NAME', 'no URLs');
  const f = foldForCompare(t);
  if (m.ng.exact.some((n) => foldForCompare(n) === f)) throw new AppError('NG_NAME');
  if (m.ng.contains.some((n) => f.includes(foldForCompare(n)))) throw new AppError('NG_NAME');
  return t;
}

// ------------------------------------------------------------------------------------------------ views

const enabledOrThrow = (m: Master) => { if (!myReplaysConfig(m).enabled) throw new AppError('NOT_FOUND', 'my replays are not available'); };

export function savedView(m: Master, r: SavedReplay) {
  return { ...r, ...playabilityOf(m, r.rulesetVersion) };
}
export function friendSavedView(m: Master, r: SavedReplay) {
  const { favorite: _f, ...rest } = savedView(m, r);
  return rest;
}

export function myReplaysView(m: Master, s: PlayerState, now: number) {
  const c = myReplaysConfig(m);
  if (!c.enabled) return { enabled: false as const, maxSaved: 0, used: 0, titleMaxChars: c.titleMaxChars, saved: [], moments: [], recent: [] };
  const st = peek(s) ?? { recent: [], saved: [] };
  const savedIds = new Set(st.saved.map((x) => x.raceId));
  const fresh = st.recent.filter((r) => now - r.at < c.momentDays * DAY_MS).sort((a, b) => b.at - a.at);
  const row = (r: RecentRace) => ({ ...r, saved: savedIds.has(r.raceId), expiresAt: r.at + c.momentDays * DAY_MS });
  const saved = [...st.saved].sort((a, b) => Number(b.favorite) - Number(a.favorite) || b.savedAt - a.savedAt).map((r) => savedView(m, r));
  return {
    enabled: true as const, maxSaved: c.maxSaved, used: st.saved.length, titleMaxChars: c.titleMaxChars,
    saved, moments: fresh.filter((r) => r.moment !== null).map(row), recent: fresh.filter((r) => r.moment === null).map(row),
  };
}

// ------------------------------------------------------------------------------------------------ operations (in the player's transaction)

/** Step 1 of a save: the race to copy (own recent race, still in the window) — or the existing save. */
export function prepareSave(m: Master, s: PlayerState, raceId: string, now: number): { existing: SavedReplay | null; race: RecentRace | null } {
  enabledOrThrow(m);
  const st = ensureMyReplays(s);
  const existing = st.saved.find((x) => x.raceId === raceId) ?? null;
  if (existing) return { existing, race: null };
  DELETION_GUARD(s);
  const c = myReplaysConfig(m);
  const race = st.recent.find((x) => x.raceId === raceId && now - x.at < c.momentDays * DAY_MS);
  if (!race) throw new AppError('NOT_FOUND', 'not one of your recent races');
  if (st.saved.length >= c.maxSaved) throw new AppError('REPLAY_LIMIT', `at most ${c.maxSaved} saved replays`);
  return { existing: null, race };
}

/** Step 2: the copy is in R2 — record it (idempotent: a second commit returns the first). */
export function commitSave(m: Master, s: PlayerState, raceId: string, title: string | null, sizeBytes: number, now: number, emit: Emit) {
  const st = ensureMyReplays(s);
  const existing = st.saved.find((x) => x.raceId === raceId);
  if (existing) return { saved: savedView(m, existing), alreadySaved: true, view: myReplaysView(m, s, now) };
  const { race } = prepareSave(m, s, raceId, now);
  const rec: SavedReplay = { ...race!, replayTitle: validateReplayTitle(m, title), favorite: false, public: false, savedAt: now, sizeBytes };
  st.saved.push(rec);
  emit({ name: 'replay_save', s1: rec.moment ? 'moment' : 'recent', s2: rec.mode, s3: rec.moment ?? '', place: rec.place, value: sizeBytes });
  return { saved: savedView(m, rec), alreadySaved: false, view: myReplaysView(m, s, now) };
}

/** The source log is gone (swept): stop offering the race. */
export function forgetRecent(s: PlayerState, raceId: string) {
  const st = peek(s);
  if (st) st.recent = st.recent.filter((r) => r.raceId !== raceId);
}

export interface ReplayPatch { replayTitle?: string | null; favorite?: boolean; public?: boolean }

export function updateSaved(m: Master, s: PlayerState, raceId: string, p: ReplayPatch) {
  enabledOrThrow(m);
  const rec = peek(s)?.saved.find((x) => x.raceId === raceId);
  if (!rec) throw new AppError('NOT_FOUND', 'no such saved replay');
  if (p.public === true && !rec.public) DELETION_GUARD(s);
  if (p.replayTitle !== undefined) rec.replayTitle = validateReplayTitle(m, p.replayTitle);
  if (p.favorite !== undefined) rec.favorite = p.favorite;
  if (p.public !== undefined) rec.public = p.public;
  return { saved: savedView(m, rec) };
}

export function deleteSaved(m: Master, s: PlayerState, raceId: string, now: number) {
  const st = ensureMyReplays(s);
  const before = st.saved.length;
  st.saved = st.saved.filter((x) => x.raceId !== raceId);
  return { deleted: st.saved.length !== before, view: myReplaysView(m, s, now) };
}

/** What a read of the replay data needs from the owner's state (own view). Null = neither saved nor recent. */
export function ownReplayRef(m: Master, s: PlayerState, raceId: string, now: number): { kind: 'saved' | 'recent'; rec: RecentRace & Partial<SavedReplay> } | null {
  enabledOrThrow(m);
  const st = peek(s);
  const saved = st?.saved.find((x) => x.raceId === raceId);
  if (saved) return { kind: 'saved', rec: saved };
  const c = myReplaysConfig(m);
  const recent = st?.recent.find((x) => x.raceId === raceId && now - x.at < c.momentDays * DAY_MS);
  return recent ? { kind: 'recent', rec: recent } : null;
}

/**
 * REQ-MYRP-010: the owner's side of a friend's request. Hidden (null) unless the two are friends, neither blocked the
 * other on the owner's side, the owner is not banned or deleting. `raceId` null = the public list.
 */
export function sharedFor(m: Master, s: PlayerState, viewerId: string, now: number) {
  if (!myReplaysConfig(m).enabled) return null;
  if (!s.friends.ids.includes(viewerId)) return null;
  const muted = (s as PlayerState & { teamFeed?: { muted: string[] } }).teamFeed?.muted ?? [];
  if (muted.includes(viewerId)) return null;
  if (deletionScheduled(s) || moderationOf(s, now) === 'banned') return null;
  return { displayName: s.profile.displayName, replays: (peek(s)?.saved ?? []).filter((r) => r.public).sort((a, b) => b.savedAt - a.savedAt) };
}

// ------------------------------------------------------------------------------------------------ replay data

export type EntrantOwner = 'you' | 'player' | 'cpu' | 'owner_player';

/**
 * REQ-MYRP-008: the log as stored, with every human `playerId` other than the owner's replaced by `p<slot>` (the engine
 * never reads it, so the result hash is unchanged) and per-slot horse names with who rode them — never other players' names.
 */
export function replayDataOf(m: Master, ownerId: string, viewer: 'me' | 'friend', file: SavedReplayFile, meta: { raceId: string; replayTitle: string | null; slot: number; rulesetVersion: string }) {
  const cfg = file.log.config as RaceStartConfig;
  const entrants = cfg.entrants.map((e) => ({
    ...e, playerId: e.kind === 'cpu' ? null : e.playerId === ownerId ? e.playerId : `p${e.slot}`,
  }));
  const log = { ...file.log, config: { ...cfg, entrants } };
  const owner = (e: RaceStartConfig['entrants'][number]): EntrantOwner =>
    e.kind === 'cpu' ? 'cpu' : e.playerId === ownerId ? (viewer === 'me' ? 'you' : 'owner_player') : 'player';
  return {
    raceId: meta.raceId, owner: viewer, replayTitle: meta.replayTitle, resultHash: file.resultHash, focusSlot: meta.slot,
    rulesetVersion: meta.rulesetVersion, ...playabilityOf(m, meta.rulesetVersion, cfg.ruleset as Record<string, unknown>),
    entrants: cfg.entrants.map((e) => ({ slot: e.slot, horseName: e.horse.name, owner: owner(e) })),
    replayLog: log,
  };
}

export const ownReplayDataGuard = enabledOrThrow;
