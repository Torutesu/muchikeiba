import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../env.js';
import { DIRECTORY_SHARDS, friendCode, shardOf, shardOfCode, type Directory } from '../domain/friends.js';
import type { PublicProfile } from '../domain/stats.js';
import { unwrap, wrap, type Envelope } from './rpc.js';
import type { StudEntry } from '../domain/stud.js';
import { sortListings, type StudDirectory } from '../domain/studService.js';
import { sortStables, type StableDirectory, type StableSnapshot } from '../domain/stable.js';
import { inviteShardOf, makeInviteCode, type InviteDirectory } from '../domain/invite.js';
import type { HallDirectory, HallSnapshot } from '../domain/hallOfFame.js';

/**
 * Friend codes and public profiles (REQ-SOCIAL-001/004), sharded by player id into DIRECTORY_SHARDS
 * objects named `dir:<n>`. A friend code carries its shard in its first two digits.
 */
export class DirectoryDO extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS players (player_id TEXT PRIMARY KEY, code TEXT UNIQUE, profile TEXT)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS seq (id INTEGER PRIMARY KEY CHECK (id = 0), n INTEGER NOT NULL)`);
    // REQ-BREED-011: browsable copy of stud listings (the owner's PlayerDO is the source of truth)
    this.sql.exec(`CREATE TABLE IF NOT EXISTS studs (owner_id TEXT NOT NULL, horse_id TEXT NOT NULL, visibility TEXT NOT NULL, listed_at INTEGER NOT NULL, entry TEXT NOT NULL, PRIMARY KEY (owner_id, horse_id))`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS studs_public ON studs (visibility, listed_at)`);
    // REQ-STABLE-003: public copy of each stable (the owner's PlayerDO is the source of truth)
    this.sql.exec(`CREATE TABLE IF NOT EXISTS stables (player_id TEXT PRIMARY KEY, likes INTEGER NOT NULL, updated_at INTEGER NOT NULL, snapshot TEXT NOT NULL)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS stables_top ON stables (likes, updated_at)`);
    // REQ-HOF-011: public copy of each hall of fame (the owner's PlayerDO is the source of truth)
    this.sql.exec(`CREATE TABLE IF NOT EXISTS halls (player_id TEXT PRIMARY KEY, updated_at INTEGER NOT NULL, snapshot TEXT NOT NULL)`);
    // REQ-INV-001: invite codes (shard = the player's shard, first character of the code). A retired code keeps its
    // row with no player, so it is never handed out again.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS invite_codes (code TEXT PRIMARY KEY, player_id TEXT UNIQUE, created_at INTEGER NOT NULL, retired_at INTEGER)`);
    // REQ-INV-005: one invite redemption per install, ever (sharded by the install hash; player_id NULL after a deletion)
    this.sql.exec(`CREATE TABLE IF NOT EXISTS invite_installs (install_hash TEXT PRIMARY KEY, player_id TEXT, at INTEGER NOT NULL)`);
  }

  async inviteCodeOf(playerId: string, shard: number): Promise<Envelope<string>> {
    return wrap(() => {
      const row = this.sql.exec<{ code: string }>('SELECT code FROM invite_codes WHERE player_id = ?', playerId).toArray()[0];
      if (row) return row.code;
      for (let i = 0; i < 50; i++) {
        const code = makeInviteCode(shard);
        if (!code) continue; // blocked letter run
        if (this.sql.exec('SELECT 1 FROM invite_codes WHERE code = ?', code).toArray().length) continue; // collision
        this.sql.exec('INSERT INTO invite_codes (code, player_id, created_at) VALUES (?, ?, ?)', code, playerId, Date.now());
        return code;
      }
      throw new Error('invite code space exhausted');
    });
  }

  async inviteLookup(code: string): Promise<Envelope<string | null>> {
    return wrap(() => this.sql.exec<{ player_id: string | null }>('SELECT player_id FROM invite_codes WHERE code = ? AND retired_at IS NULL', code).toArray()[0]?.player_id ?? null);
  }

  async inviteRetire(playerId: string): Promise<Envelope<boolean>> {
    return wrap(() => { this.sql.exec('UPDATE invite_codes SET player_id = NULL, retired_at = ? WHERE player_id = ?', Date.now(), playerId); return true; });
  }

  async installClaim(hash: string, playerId: string): Promise<Envelope<string>> {
    return wrap(() => {
      this.sql.exec('INSERT INTO invite_installs (install_hash, player_id, at) VALUES (?, ?, ?) ON CONFLICT(install_hash) DO NOTHING', hash, playerId, Date.now());
      return this.sql.exec<{ player_id: string | null }>('SELECT player_id FROM invite_installs WHERE install_hash = ?', hash).toArray()[0]?.player_id ?? '__deleted__';
    });
  }

  async installRelease(hash: string, playerId: string): Promise<Envelope<boolean>> {
    return wrap(() => { this.sql.exec('DELETE FROM invite_installs WHERE install_hash = ? AND player_id = ?', hash, playerId); return true; });
  }

  async installAnonymize(hash: string): Promise<Envelope<boolean>> {
    return wrap(() => { this.sql.exec('UPDATE invite_installs SET player_id = NULL WHERE install_hash = ?', hash); return true; });
  }

  async stablePut(x: StableSnapshot): Promise<Envelope<boolean>> {
    return wrap(() => {
      this.sql.exec('INSERT INTO stables (player_id, likes, updated_at, snapshot) VALUES (?, ?, ?, ?) ON CONFLICT(player_id) DO UPDATE SET likes = excluded.likes, updated_at = excluded.updated_at, snapshot = excluded.snapshot',
        x.playerId, x.likes, x.updatedAt, JSON.stringify(x));
      return true;
    });
  }

  async stableRemove(playerId: string): Promise<Envelope<boolean>> {
    return wrap(() => { this.sql.exec('DELETE FROM stables WHERE player_id = ?', playerId); return true; });
  }

  async stablesOf(ids: string[]): Promise<Envelope<StableSnapshot[]>> {
    return wrap(() => ids.slice(0, 200).flatMap((id) => this.sql.exec<{ snapshot: string }>('SELECT snapshot FROM stables WHERE player_id = ?', id).toArray().map((r) => JSON.parse(r.snapshot) as StableSnapshot)));
  }

  async stablesTop(limit: number): Promise<Envelope<StableSnapshot[]>> {
    return wrap(() => this.sql.exec<{ snapshot: string }>('SELECT snapshot FROM stables ORDER BY likes DESC, updated_at DESC LIMIT ?', Math.min(200, Math.max(1, limit))).toArray().map((r) => JSON.parse(r.snapshot) as StableSnapshot));
  }

  async hallPut(x: HallSnapshot): Promise<Envelope<boolean>> {
    return wrap(() => {
      this.sql.exec('INSERT INTO halls (player_id, updated_at, snapshot) VALUES (?, ?, ?) ON CONFLICT(player_id) DO UPDATE SET updated_at = excluded.updated_at, snapshot = excluded.snapshot',
        x.playerId, x.updatedAt, JSON.stringify(x));
      return true;
    });
  }

  async hallRemove(playerId: string): Promise<Envelope<boolean>> {
    return wrap(() => { this.sql.exec('DELETE FROM halls WHERE player_id = ?', playerId); return true; });
  }

  async hallGet(playerId: string): Promise<Envelope<HallSnapshot | null>> {
    return wrap(() => {
      const r = this.sql.exec<{ snapshot: string }>('SELECT snapshot FROM halls WHERE player_id = ?', playerId).toArray()[0];
      return r ? (JSON.parse(r.snapshot) as HallSnapshot) : null;
    });
  }

  async studPut(e: StudEntry): Promise<Envelope<boolean>> {
    return wrap(() => {
      this.sql.exec('INSERT INTO studs (owner_id, horse_id, visibility, listed_at, entry) VALUES (?, ?, ?, ?, ?) ON CONFLICT(owner_id, horse_id) DO UPDATE SET visibility = excluded.visibility, listed_at = excluded.listed_at, entry = excluded.entry',
        e.ownerId, e.horseId, e.visibility, e.listedAt, JSON.stringify(e));
      return true;
    });
  }

  async studRemove(ownerId: string, horseId: string): Promise<Envelope<boolean>> {
    return wrap(() => { this.sql.exec('DELETE FROM studs WHERE owner_id = ? AND horse_id = ?', ownerId, horseId); return true; });
  }

  async studOf(ownerIds: string[]): Promise<Envelope<StudEntry[]>> {
    return wrap(() => ownerIds.slice(0, 200).flatMap((id) => this.sql.exec<{ entry: string }>('SELECT entry FROM studs WHERE owner_id = ?', id).toArray().map((r) => JSON.parse(r.entry) as StudEntry)));
  }

  async studPublic(limit: number): Promise<Envelope<StudEntry[]>> {
    return wrap(() => this.sql.exec<{ entry: string }>("SELECT entry FROM studs WHERE visibility = 'public' ORDER BY listed_at DESC LIMIT ?", Math.min(200, Math.max(1, limit))).toArray().map((r) => JSON.parse(r.entry) as StudEntry));
  }

  /** REQ-UXS-040: account deletion — friend code, public profile, every stud listing and the public stable copy of the player. */
  async forget(playerId: string): Promise<Envelope<boolean>> {
    return wrap(() => {
      this.sql.exec('DELETE FROM players WHERE player_id = ?', playerId);
      this.sql.exec('DELETE FROM studs WHERE owner_id = ?', playerId);
      this.sql.exec('DELETE FROM stables WHERE player_id = ?', playerId);
      this.sql.exec('DELETE FROM halls WHERE player_id = ?', playerId); // REQ-HOF-011
      this.sql.exec('UPDATE invite_codes SET player_id = NULL, retired_at = ? WHERE player_id = ?', Date.now(), playerId); // REQ-INV-010
      return true;
    });
  }

  async codeOf(playerId: string, shard: number): Promise<Envelope<string>> {
    return wrap(() => {
      const row = this.sql.exec<{ code: string | null }>('SELECT code FROM players WHERE player_id = ?', playerId).toArray()[0];
      if (row?.code) return row.code;
      const n = this.sql.exec<{ n: number }>('SELECT n FROM seq WHERE id = 0').toArray()[0]?.n ?? 0;
      const code = friendCode(shard, n);
      this.sql.exec('INSERT INTO seq (id, n) VALUES (0, ?) ON CONFLICT(id) DO UPDATE SET n = excluded.n', n + 1);
      this.sql.exec('INSERT INTO players (player_id, code) VALUES (?, ?) ON CONFLICT(player_id) DO UPDATE SET code = excluded.code', playerId, code);
      return code;
    });
  }

  async lookup(code: string): Promise<Envelope<string | null>> {
    return wrap(() => this.sql.exec<{ player_id: string }>('SELECT player_id FROM players WHERE code = ?', code).toArray()[0]?.player_id ?? null);
  }

  async putProfile(p: PublicProfile): Promise<Envelope<boolean>> {
    return wrap(() => {
      this.sql.exec('INSERT INTO players (player_id, profile) VALUES (?, ?) ON CONFLICT(player_id) DO UPDATE SET profile = excluded.profile', p.playerId, JSON.stringify(p));
      return true;
    });
  }

  async profiles(ids: string[]): Promise<Envelope<PublicProfile[]>> {
    return wrap(() => {
      const out: PublicProfile[] = [];
      for (const id of ids.slice(0, 200)) {
        const r = this.sql.exec<{ profile: string | null }>('SELECT profile FROM players WHERE player_id = ?', id).toArray()[0];
        if (r?.profile) out.push(JSON.parse(r.profile) as PublicProfile);
      }
      return out;
    });
  }
}

type DirStub = {
  codeOf(p: string, s: number): Promise<Envelope<string>>;
  lookup(c: string): Promise<Envelope<string | null>>;
  putProfile(p: PublicProfile): Promise<Envelope<boolean>>;
  profiles(ids: string[]): Promise<Envelope<PublicProfile[]>>;
  studPut(e: StudEntry): Promise<Envelope<boolean>>;
  studRemove(o: string, h: string): Promise<Envelope<boolean>>;
  studOf(ids: string[]): Promise<Envelope<StudEntry[]>>;
  studPublic(limit: number): Promise<Envelope<StudEntry[]>>;
  stablePut(x: StableSnapshot): Promise<Envelope<boolean>>;
  stableRemove(id: string): Promise<Envelope<boolean>>;
  stablesOf(ids: string[]): Promise<Envelope<StableSnapshot[]>>;
  stablesTop(limit: number): Promise<Envelope<StableSnapshot[]>>;
  forget(p: string): Promise<Envelope<boolean>>;
  hallPut(x: HallSnapshot): Promise<Envelope<boolean>>;
  hallRemove(id: string): Promise<Envelope<boolean>>;
  hallGet(id: string): Promise<Envelope<HallSnapshot | null>>;
  inviteCodeOf(p: string, s: number): Promise<Envelope<string>>;
  inviteLookup(c: string): Promise<Envelope<string | null>>;
  inviteRetire(p: string): Promise<Envelope<boolean>>;
  installClaim(h: string, p: string): Promise<Envelope<string>>;
  installRelease(h: string, p: string): Promise<Envelope<boolean>>;
  installAnonymize(h: string): Promise<Envelope<boolean>>;
};

/** Install hashes are hex: their first byte picks the shard. */
const installShard = (hash: string) => parseInt(hash.slice(0, 2), 16) % DIRECTORY_SHARDS;

/** REQ-INV-001/005/010: invite codes by player shard, install claims by hash shard. */
export function shardedInviteDirectory(ns: DurableObjectNamespace): InviteDirectory {
  const shard = (n: number) => ns.get(ns.idFromName(`dir:${n}`)) as unknown as DirStub;
  return {
    async codeOf(playerId) { const s = shardOf(playerId); return unwrap(await shard(s).inviteCodeOf(playerId, s)); },
    async lookup(code) { return unwrap(await shard(inviteShardOf(code)).inviteLookup(code)); },
    async claimInstall(h, p) { return unwrap(await shard(installShard(h)).installClaim(h, p)); },
    async releaseInstall(h, p) { unwrap(await shard(installShard(h)).installRelease(h, p)); },
    async retire(p) { unwrap(await shard(shardOf(p)).inviteRetire(p)); },
    async anonymizeInstall(h) { unwrap(await shard(installShard(h)).installAnonymize(h)); },
  };
}

/** Recommended stables change slowly; one fan-out per isolate per minute keeps visits cheap. */
const STABLE_TOP_TTL_MS = 60_000;
let stableTopCache: { at: number; limit: number; rows: StableSnapshot[] } | null = null;

/** REQ-STABLE-003: public stable copies, sharded by owner like profiles; "recommended" fans out to every shard. */
export function shardedStableDirectory(ns: DurableObjectNamespace, clock: () => number = Date.now): StableDirectory {
  const shard = (n: number) => ns.get(ns.idFromName(`dir:${n}`)) as unknown as DirStub;
  return {
    async put(x) { unwrap(await shard(shardOf(x.playerId)).stablePut(x)); },
    async remove(id) { unwrap(await shard(shardOf(id)).stableRemove(id)); stableTopCache = null; },
    async get(id) { return unwrap(await shard(shardOf(id)).stablesOf([id]))[0] ?? null; },
    async ofPlayers(ids) {
      const groups = new Map<number, string[]>();
      for (const id of ids) groups.set(shardOf(id), [...(groups.get(shardOf(id)) ?? []), id]);
      return (await Promise.all([...groups].map(async ([s, g]) => unwrap(await shard(s).stablesOf(g))))).flat();
    },
    async top(limit) {
      const now = clock();
      if (stableTopCache && stableTopCache.limit >= limit && now - stableTopCache.at < STABLE_TOP_TTL_MS) return stableTopCache.rows.slice(0, limit);
      const parts = await Promise.all(Array.from({ length: DIRECTORY_SHARDS }, async (_, i) => unwrap(await shard(i).stablesTop(limit))));
      const rows = sortStables(parts.flat()).slice(0, limit);
      stableTopCache = { at: now, limit, rows };
      return rows;
    },
  };
}

/** REQ-HOF-011: public hall copies, sharded by owner like profiles and stables. */
export function shardedHallDirectory(ns: DurableObjectNamespace): HallDirectory {
  const shard = (n: number) => ns.get(ns.idFromName(`dir:${n}`)) as unknown as DirStub;
  return {
    async put(x) { unwrap(await shard(shardOf(x.playerId)).hallPut(x)); },
    async remove(id) { unwrap(await shard(shardOf(id)).hallRemove(id)); },
    async get(id) { return unwrap(await shard(shardOf(id)).hallGet(id)); },
  };
}

/** REQ-UXS-040: removes a deleted player's directory rows (their shard). */
export async function forgetInDirectory(ns: DurableObjectNamespace, playerId: string) {
  const s = ns.get(ns.idFromName(`dir:${shardOf(playerId)}`)) as unknown as DirStub;
  unwrap(await s.forget(playerId));
  stableTopCache = null;
}

/** Stud listings, sharded by owner like profiles; public browsing fans out to every shard. */
export function shardedStudDirectory(ns: DurableObjectNamespace): StudDirectory {
  const shard = (n: number) => ns.get(ns.idFromName(`dir:${n}`)) as unknown as DirStub;
  return {
    async put(e) { unwrap(await shard(shardOf(e.ownerId)).studPut(e)); },
    async remove(o, h) { unwrap(await shard(shardOf(o)).studRemove(o, h)); },
    async ofOwners(ids) {
      const groups = new Map<number, string[]>();
      for (const id of ids) groups.set(shardOf(id), [...(groups.get(shardOf(id)) ?? []), id]);
      return (await Promise.all([...groups].map(async ([s, g]) => unwrap(await shard(s).studOf(g))))).flat();
    },
    async publicList(limit) {
      const parts = await Promise.all(Array.from({ length: DIRECTORY_SHARDS }, async (_, i) => unwrap(await shard(i).studPublic(limit))));
      return sortListings(parts.flat()).slice(0, limit);
    },
  };
}

/** Routes Directory calls to the right shard. */
export function shardedDirectory(ns: DurableObjectNamespace): Directory {
  const shard = (n: number) => ns.get(ns.idFromName(`dir:${n}`)) as unknown as DirStub;
  return {
    async codeOf(playerId) {
      const s = shardOf(playerId);
      return unwrap(await shard(s).codeOf(playerId, s));
    },
    async lookup(code) {
      const s = shardOfCode(code);
      return s === null ? null : unwrap(await shard(s).lookup(code));
    },
    async putProfile(p) { unwrap(await shard(shardOf(p.playerId)).putProfile(p)); },
    async profiles(ids) {
      const groups = new Map<number, string[]>();
      for (const id of ids) {
        const s = shardOf(id);
        groups.set(s, [...(groups.get(s) ?? []), id]);
      }
      const parts = await Promise.all([...groups].map(async ([s, g]) => unwrap(await shard(s).profiles(g))));
      return parts.flat();
    },
  };
}

export { DIRECTORY_SHARDS };
