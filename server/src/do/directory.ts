import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../env.js';
import { DIRECTORY_SHARDS, friendCode, shardOf, shardOfCode, type Directory } from '../domain/friends.js';
import type { PublicProfile } from '../domain/stats.js';
import { unwrap, wrap, type Envelope } from './rpc.js';

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
};

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
