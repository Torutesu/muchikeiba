import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../env.js';
import { DIRECTORY_SHARDS, friendCode, shardOf, shardOfCode, type Directory } from '../domain/friends.js';
import type { PublicProfile } from '../domain/stats.js';
import { unwrap, wrap, type Envelope } from './rpc.js';
import type { StudEntry } from '../domain/stud.js';
import { sortListings, type StudDirectory } from '../domain/studService.js';
import { sortStables, type StableDirectory, type StableSnapshot } from '../domain/stable.js';

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
};

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
