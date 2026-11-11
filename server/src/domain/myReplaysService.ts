/**
 * マイリプレイ orchestration (REQ-MYRP-*, contracts/protocol.md §37): the player's Durable Object holds the list,
 * R2 holds the copies (`myreplays/<playerId>/<raceId>.json`, outside the swept `replays/` prefix).
 */
import { AppError } from './errors.js';
import {
  friendSavedView, isReplayId, replayDataOf, savedReplayKey, sourceReplayKey, type ReplayPatch, type SavedReplay, type SavedReplayFile,
} from './myReplays.js';
import { replayLogSchema, type ReplayLog } from './schemas.js';
import { cheerSummaryKey, parseCheerSummary } from './cheer.js';
import type { Master } from './master.js';
import type { PlayerInvoker } from '../http/app.js';

/** The part of R2 the feature needs (lets tests use a map). */
export interface ReplayStore {
  get(key: string): Promise<string | null>;
  put(key: string, body: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export class MemoryReplayStore implements ReplayStore {
  readonly files = new Map<string, string>();
  async get(key: string) { return this.files.get(key) ?? null; }
  async put(key: string, body: string) { this.files.set(key, body); }
  async delete(key: string) { this.files.delete(key); }
}

const idOrThrow = (raceId: string) => { if (!isReplayId(raceId)) throw new AppError('NOT_FOUND', 'no such replay'); };
const bytesOf = (s: string) => new TextEncoder().encode(s).length;

export class MyReplaysService {
  /**
   * @param friendIds REQ-ACT-002 (§40): the player's friends, for the activity entry when a save becomes public
   *   (http/app.ts friendIdsFrom). Absent = no activity entries (tests and tools that do not need them).
   */
  constructor(private readonly master: () => Master, private readonly player: (uid: string) => PlayerInvoker, private readonly store: ReplayStore,
    private readonly friendIds?: (uid: string) => Promise<string[]>) {}

  view(uid: string) { return this.player(uid).invoke('myReplays', uid); }

  /**
   * REQ-MYRP-003: copy the source log next to the player's saves, then record it. The copy is written before the record
   * (a failed copy leaves nothing behind); a record that then fails (limit reached by a parallel save) removes its copy.
   */
  async save(uid: string, raceId: string, title: string | null, idemKey: string) {
    idOrThrow(raceId);
    const p = this.player(uid);
    const prep = await p.invoke('replayPrepareSave', uid, raceId, title);
    if (prep.existing) return p.invoke('replayCommitSave', uid, raceId, title, prep.existing.sizeBytes, idemKey);
    const race = prep.race!;
    const src = await this.store.get(sourceReplayKey(raceId));
    if (src === null) {
      await p.invoke('replayForget', uid, raceId);
      throw new AppError('REPLAY_EXPIRED', 'the replay of this race is no longer kept');
    }
    let log: ReplayLog;
    try { log = replayLogSchema.parse(JSON.parse(src)); } catch { throw new AppError('REPLAY_EXPIRED', 'the stored replay cannot be read'); }
    // the race must be the one the player rode, in the slot the room settled
    if (log.config.raceId !== raceId || log.config.entrants[race.slot]?.playerId !== uid) throw new AppError('NOT_FOUND', 'not one of your races');
    // REQ-CHEER-012 (§55.6): the race's cheer counts travel with the copy when the room wrote them (optional, small)
    const cheers = parseCheerSummary(await this.store.get(cheerSummaryKey(raceId)).catch(() => null));
    const file: SavedReplayFile = { v: 1, log, resultHash: race.resultHash, ...(cheers ? { cheers } : {}) };
    const body = JSON.stringify(file);
    const size = bytesOf(body);
    const max = (this.master().progression as { myReplays?: { maxBytes: number } }).myReplays?.maxBytes ?? 0;
    if (size > max) throw new AppError('REPLAY_TOO_LARGE', `the replay is ${size} bytes (at most ${max})`);
    const key = savedReplayKey(uid, raceId);
    await this.store.put(key, body);
    try {
      return await p.invoke('replayCommitSave', uid, raceId, title, size, idemKey);
    } catch (e) {
      const ref = await p.invoke('replayOwnRef', uid, raceId).catch(() => null);
      if (ref?.kind !== 'saved') await this.store.delete(key).catch(() => undefined);
      throw e;
    }
  }

  /**
   * REQ-MYRP-004. When a save becomes public (§40 REQ-ACT-002), each friend gets one `replay_share` activity entry — keyed by
   * owner + race, so turning it off and on again writes nothing new; a friend who blocked the owner gets none (recordActivity).
   * Best effort after the change is stored: a friend that cannot be reached misses the entry, the update still succeeds.
   */
  async update(uid: string, raceId: string, patch: ReplayPatch) {
    idOrThrow(raceId);
    const p = this.player(uid);
    const was = patch.public === true && this.friendIds ? await p.invoke('replayOwnRef', uid, raceId).catch(() => null) : null;
    const out = await p.invoke('replayUpdate', uid, raceId, patch);
    if (was?.kind === 'saved' && !was.rec.public && out.saved.public && this.friendIds) {
      const friends = await this.friendIds(uid).catch(() => [] as string[]);
      await Promise.all(friends.map((f) => this.player(f).invoke('activityReplayShare', f, uid, raceId).catch(() => undefined)));
    }
    return out;
  }

  /** REQ-MYRP-005: the record first, then the copy (a copy left by a failed delete is never listed and goes with the account). */
  async remove(uid: string, raceId: string) {
    idOrThrow(raceId);
    const out = await this.player(uid).invoke('replayDelete', uid, raceId);
    if (out.deleted) {
      try { await this.store.delete(savedReplayKey(uid, raceId)); } catch (e) { console.error('saved replay copy not deleted', uid, raceId, (e as Error).message); }
    }
    return out;
  }

  private async readFile(key: string): Promise<SavedReplayFile | null> {
    const raw = await this.store.get(key);
    if (raw === null) return null;
    return JSON.parse(raw) as SavedReplayFile;
  }

  /** REQ-MYRP-008: the player's own saved replay, best moment or recent race. */
  async data(uid: string, raceId: string) {
    idOrThrow(raceId);
    const p = this.player(uid);
    const ref = await p.invoke('replayOwnRef', uid, raceId);
    if (!ref) throw new AppError('NOT_FOUND', 'no such replay');
    let file: SavedReplayFile | null;
    if (ref.kind === 'saved') file = await this.readFile(savedReplayKey(uid, raceId));
    else {
      const src = await this.store.get(sourceReplayKey(raceId));
      const cheers = src === null ? null : parseCheerSummary(await this.store.get(cheerSummaryKey(raceId)).catch(() => null));
      file = src === null ? null : { v: 1, log: JSON.parse(src) as ReplayLog, resultHash: ref.rec.resultHash, ...(cheers ? { cheers } : {}) };
      if (!file) await p.invoke('replayForget', uid, raceId);
    }
    if (!file) throw new AppError('REPLAY_EXPIRED', 'the replay of this race is no longer kept');
    const out = replayDataOf(this.master(), uid, 'me', file, { raceId, replayTitle: ref.rec.replayTitle ?? null, slot: ref.rec.slot, rulesetVersion: ref.rec.rulesetVersion });
    await p.invoke('replayViewed', uid, 'own', out.playable ? 'playable' : out.reason!, ref.rec.mode);
    return out;
  }

  /** REQ-MYRP-010: both sides must allow it; anything else is a plain 404 (never says why). */
  private async shared(viewer: string, owner: string) {
    if (viewer === owner) throw new AppError('NOT_FOUND', 'no such player');
    const list = await this.player(owner).invoke('replayShared', owner, viewer);
    if (!list) throw new AppError('NOT_FOUND', 'no such player');
    const mine = await this.player(viewer).invoke('feedMutes', viewer);
    if (mine.muted.includes(owner)) throw new AppError('NOT_FOUND', 'no such player');
    return list;
  }

  async friendList(viewer: string, owner: string) {
    const list = await this.shared(viewer, owner);
    const m = this.master();
    return { playerId: owner, displayName: list.displayName, replays: list.replays.map((r: SavedReplay) => friendSavedView(m, r)) };
  }

  async friendData(viewer: string, owner: string, raceId: string) {
    idOrThrow(raceId);
    const list = await this.shared(viewer, owner);
    const rec = list.replays.find((r: SavedReplay) => r.raceId === raceId);
    if (!rec) throw new AppError('NOT_FOUND', 'no such replay');
    const file = await this.readFile(savedReplayKey(owner, raceId));
    if (!file) throw new AppError('NOT_FOUND', 'no such replay');
    const out = replayDataOf(this.master(), owner, 'friend', file, { raceId, replayTitle: rec.replayTitle, slot: rec.slot, rulesetVersion: rec.rulesetVersion });
    await this.player(viewer).invoke('replayViewed', viewer, 'friend', out.playable ? 'playable' : out.reason!, rec.mode);
    return { ...out, ownerName: list.displayName };
  }
}
