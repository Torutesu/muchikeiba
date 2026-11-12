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
import { byShard, type FsugCard, type SuggestDirectory } from '../domain/friendSuggest.js';
import { AUDIT_DAYS, AUDIT_KEEP, beginStep, limitStep, PURGE_AFTER_MS, type AuditRow, type BeginResult, type LimitRule, type TransferDirectory, type TransferRecord } from '../domain/transferService.js';
import { codeShard } from '../domain/transferCode.js';
import { isLive, LINK_PURGE_AFTER_MS, linkLimitStep, type LinkDirectory, type LinkLimitRow, type LinkLimitRules, type LinkRecord, type PutResult } from '../domain/linkService.js';
import { tokenShard } from '../domain/deepLinks.js';

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
    // REQ-FSUG-011: おすすめフレンド cards (block list + friend ids; never returned to other players). No wrangler migration:
    // a table inside the existing DirectoryDO SQLite storage.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS fsug_cards (player_id TEXT PRIMARY KEY, updated_at INTEGER NOT NULL, card TEXT NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS invite_installs (install_hash TEXT PRIMARY KEY, player_id TEXT, at INTEGER NOT NULL)`);
    // REQ-TRF-004/007/013 (§54.5): 引き継ぎコード — hash records (shard = the code's first character = the owner's shard),
    // IP / device attempt limits (shard = the key hash) and the audit (shard = the player). New tables in the existing
    // DirectoryDO SQLite storage: no wrangler migration.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS transfer_codes (code_id TEXT PRIMARY KEY, player_id TEXT NOT NULL, salt TEXT NOT NULL, hash TEXT NOT NULL, kdf TEXT NOT NULL, iterations INTEGER NOT NULL, issued_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, locked_until INTEGER NOT NULL DEFAULT 0)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS transfer_codes_player ON transfer_codes (player_id)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS transfer_limits (key TEXT PRIMARY KEY, window_start INTEGER NOT NULL, failures INTEGER NOT NULL, locked_until INTEGER NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS transfer_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, player_id TEXT NOT NULL, at INTEGER NOT NULL, event TEXT NOT NULL, code_ref TEXT NOT NULL, ip_ref TEXT, dev_ref TEXT)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS transfer_audit_player ON transfer_audit (player_id, id)`);
    // REQ-LINK-003/008/020 (§63.7): ディープリンク — link records (shard = the token's first character = the owner's shard, so
    // the account deletion's forget finds them) and lookup limits (shard = the key hash). New tables: no wrangler migration.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS links (token TEXT PRIMARY KEY, owner_id TEXT NOT NULL, type TEXT NOT NULL, target_key TEXT NOT NULL, data TEXT NOT NULL, day TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS links_owner ON links (owner_id, type, target_key)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS link_limits (key TEXT PRIMARY KEY, window_start INTEGER NOT NULL, lookups INTEGER NOT NULL, failures INTEGER NOT NULL, locked_until INTEGER NOT NULL)`);
  }

  // ---- ディープリンク (REQ-LINK-*): one shard's rows; the sharding is in shardedLinkDirectory ----
  private linkRows(where: string, ...args: (string | number)[]): LinkRecord[] {
    type Row = { token: string; owner_id: string; type: string; target_key: string; data: string; day: string; created_at: number; expires_at: number; revoked_at: number | null };
    return this.sql.exec<Row>(`SELECT * FROM links WHERE ${where}`, ...args).toArray().map((r) => ({
      token: r.token, ownerId: r.owner_id, type: r.type as LinkRecord['type'], targetKey: r.target_key, data: JSON.parse(r.data) as Record<string, string>,
      day: r.day, createdAt: r.created_at, expiresAt: r.expires_at, revokedAt: r.revoked_at,
    }));
  }
  async linkPut(rec: LinkRecord, perDay: number, now: number): Promise<Envelope<PutResult>> {
    return wrap((): PutResult => {
      this.sql.exec('DELETE FROM links WHERE expires_at < ?', now - LINK_PURGE_AFTER_MS);
      this.sql.exec('DELETE FROM link_limits WHERE locked_until < ? AND window_start < ?', now, now - 3_600_000);
      const same = this.linkRows('owner_id = ? AND type = ? AND target_key = ?', rec.ownerId, rec.type, rec.targetKey).find((x) => isLive(x, now));
      if (same) return { status: 'existing', rec: same };
      const made = this.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM links WHERE owner_id = ? AND day = ?', rec.ownerId, rec.day).toArray()[0]?.n ?? 0;
      if (made >= perDay) return { status: 'limit' };
      if (this.sql.exec('SELECT 1 FROM links WHERE token = ?', rec.token).toArray().length) return { status: 'taken' };
      this.sql.exec('INSERT INTO links (token, owner_id, type, target_key, data, day, created_at, expires_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)',
        rec.token, rec.ownerId, rec.type, rec.targetKey, JSON.stringify(rec.data), rec.day, rec.createdAt, rec.expiresAt);
      return { status: 'created', rec };
    });
  }
  async linkGet(token: string): Promise<Envelope<LinkRecord | null>> {
    return wrap(() => this.linkRows('token = ?', token)[0] ?? null);
  }
  async linkRevoke(token: string, ownerId: string, now: number): Promise<Envelope<LinkRecord | null>> {
    return wrap(() => {
      const r = this.linkRows('token = ? AND owner_id = ?', token, ownerId)[0];
      if (!r || !isLive(r, now)) return null;
      this.sql.exec('UPDATE links SET revoked_at = ? WHERE token = ?', now, token);
      return { ...r, revokedAt: now };
    });
  }
  async linkListOf(ownerId: string, day: string, now: number): Promise<Envelope<{ links: LinkRecord[]; madeToday: number }>> {
    return wrap(() => {
      const mine = this.linkRows('owner_id = ? ORDER BY created_at DESC LIMIT 500', ownerId);
      return { links: mine.filter((x) => isLive(x, now)), madeToday: mine.filter((x) => x.day === day).length };
    });
  }
  async linkLimitCheck(keys: string[], now: number): Promise<Envelope<number | null>> {
    return wrap(() => {
      let wait: number | null = null;
      for (const k of keys) {
        const u = this.sql.exec<{ locked_until: number }>('SELECT locked_until FROM link_limits WHERE key = ?', k).toArray()[0]?.locked_until ?? 0;
        if (u > now) wait = Math.max(wait ?? 0, u - now);
      }
      return wait;
    });
  }
  async linkLimitNote(keys: string[], now: number, failed: boolean, rules: LinkLimitRules): Promise<Envelope<boolean>> {
    return wrap(() => {
      for (const k of keys) {
        const row = this.sql.exec<{ window_start: number; lookups: number; failures: number; locked_until: number }>('SELECT window_start, lookups, failures, locked_until FROM link_limits WHERE key = ?', k).toArray()[0];
        const cur: LinkLimitRow | null = row ? { windowStart: row.window_start, lookups: row.lookups, failures: row.failures, lockedUntil: row.locked_until } : null;
        const n = linkLimitStep(cur, now, failed, rules);
        this.sql.exec('INSERT INTO link_limits (key, window_start, lookups, failures, locked_until) VALUES (?, ?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET window_start = excluded.window_start, lookups = excluded.lookups, failures = excluded.failures, locked_until = excluded.locked_until',
          k, n.windowStart, n.lookups, n.failures, n.lockedUntil);
      }
      return true;
    });
  }

  // ---- 引き継ぎコード (REQ-TRF-*): one shard's rows; the sharding is in shardedTransferDirectory ----
  async transferPut(rec: TransferRecord, now: number): Promise<Envelope<boolean>> {
    return wrap(() => {
      this.sql.exec('DELETE FROM transfer_codes WHERE expires_at < ?', now - PURGE_AFTER_MS);
      this.sql.exec('DELETE FROM transfer_limits WHERE locked_until < ? AND window_start < ?', now, now - 3_600_000);
      if (this.sql.exec('SELECT 1 FROM transfer_codes WHERE code_id = ?', rec.codeId).toArray().length) return false;
      this.sql.exec('INSERT INTO transfer_codes (code_id, player_id, salt, hash, kdf, iterations, issued_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        rec.codeId, rec.playerId, rec.salt, rec.hash, rec.kdf, rec.iterations, rec.issuedAt, rec.expiresAt);
      return true;
    });
  }
  async transferBegin(codeId: string, now: number, maxAttempts: number, lockMs: number): Promise<Envelope<BeginResult>> {
    return wrap((): BeginResult => {
      type Row = { code_id: string; player_id: string; salt: string; hash: string; kdf: string; iterations: number; issued_at: number; expires_at: number; attempts: number; locked_until: number };
      const r = this.sql.exec<Row>('SELECT * FROM transfer_codes WHERE code_id = ?', codeId).toArray()[0];
      if (!r) return { status: 'none' };
      if (r.locked_until > now) return { status: 'locked', playerId: r.player_id };
      const s = beginStep(r.attempts, now, maxAttempts, lockMs);
      this.sql.exec('UPDATE transfer_codes SET attempts = ?, locked_until = ? WHERE code_id = ?', s.attempts, s.lockedUntil, codeId);
      const rec: TransferRecord = { codeId: r.code_id, playerId: r.player_id, salt: r.salt, hash: r.hash, kdf: r.kdf, iterations: r.iterations, issuedAt: r.issued_at, expiresAt: r.expires_at };
      return { status: now >= r.expires_at ? 'expired' : 'ok', rec, lockedNow: s.lockedNow };
    });
  }
  async transferRemove(codeId: string, playerId: string): Promise<Envelope<boolean>> {
    return wrap(() => { this.sql.exec('DELETE FROM transfer_codes WHERE code_id = ? AND player_id = ?', codeId, playerId); return true; });
  }
  async transferLimitCheck(keys: string[], now: number): Promise<Envelope<number | null>> {
    return wrap(() => {
      let wait: number | null = null;
      for (const k of keys) {
        const u = this.sql.exec<{ locked_until: number }>('SELECT locked_until FROM transfer_limits WHERE key = ?', k).toArray()[0]?.locked_until ?? 0;
        if (u > now) wait = Math.max(wait ?? 0, u - now);
      }
      return wait;
    });
  }
  async transferLimitFail(keys: string[], now: number, rules: LimitRule[], lockMs: number): Promise<Envelope<boolean>> {
    return wrap(() => {
      for (const k of keys) {
        const per = rules.find((r) => k.startsWith(r.prefix))?.perHour;
        if (!per) continue;
        const row = this.sql.exec<{ window_start: number; failures: number; locked_until: number }>('SELECT window_start, failures, locked_until FROM transfer_limits WHERE key = ?', k).toArray()[0];
        const n = limitStep(row ? { windowStart: row.window_start, failures: row.failures, lockedUntil: row.locked_until } : null, now, per, lockMs);
        this.sql.exec('INSERT INTO transfer_limits (key, window_start, failures, locked_until) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET window_start = excluded.window_start, failures = excluded.failures, locked_until = excluded.locked_until',
          k, n.windowStart, n.failures, n.lockedUntil);
      }
      return true;
    });
  }
  async transferAudit(row: AuditRow): Promise<Envelope<boolean>> {
    return wrap(() => {
      this.sql.exec('INSERT INTO transfer_audit (player_id, at, event, code_ref, ip_ref, dev_ref) VALUES (?, ?, ?, ?, ?, ?)', row.playerId, row.at, row.event, row.codeRef, row.ipRef, row.devRef);
      this.sql.exec('DELETE FROM transfer_audit WHERE player_id = ? AND id NOT IN (SELECT id FROM transfer_audit WHERE player_id = ? ORDER BY id DESC LIMIT ?)', row.playerId, row.playerId, AUDIT_KEEP);
      this.sql.exec('DELETE FROM transfer_audit WHERE at < ?', row.at - AUDIT_DAYS * 86_400_000);
      return true;
    });
  }
  async transferAuditOf(playerId: string, limit: number): Promise<Envelope<AuditRow[]>> {
    return wrap(() => this.sql.exec<{ player_id: string; at: number; event: string; code_ref: string; ip_ref: string | null; dev_ref: string | null }>(
      'SELECT player_id, at, event, code_ref, ip_ref, dev_ref FROM transfer_audit WHERE player_id = ? ORDER BY id DESC LIMIT ?', playerId, Math.min(Math.max(limit, 1), AUDIT_KEEP)).toArray()
      .map((r) => ({ playerId: r.player_id, at: r.at, event: r.event as AuditRow['event'], codeRef: r.code_ref, ipRef: r.ip_ref, devRef: r.dev_ref })));
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

  async fsugPut(c: FsugCard): Promise<Envelope<boolean>> {
    return wrap(() => {
      this.sql.exec('INSERT INTO fsug_cards (player_id, updated_at, card) VALUES (?, ?, ?) ON CONFLICT(player_id) DO UPDATE SET updated_at = excluded.updated_at, card = excluded.card',
        c.playerId, c.updatedAt, JSON.stringify(c));
      return true;
    });
  }

  async fsugRemove(playerId: string): Promise<Envelope<boolean>> {
    return wrap(() => { this.sql.exec('DELETE FROM fsug_cards WHERE player_id = ?', playerId); return true; });
  }

  /** REQ-FSUG-010: cards with the same player's public profile (one call per shard). */
  async fsugCards(ids: string[]): Promise<Envelope<{ card: FsugCard; profile: PublicProfile | null }[]>> {
    return wrap(() => ids.slice(0, 200).flatMap((id) => {
      const r = this.sql.exec<{ card: string }>('SELECT card FROM fsug_cards WHERE player_id = ?', id).toArray()[0];
      if (!r) return [];
      const p = this.sql.exec<{ profile: string | null }>('SELECT profile FROM players WHERE player_id = ?', id).toArray()[0];
      return [{ card: JSON.parse(r.card) as FsugCard, profile: p?.profile ? (JSON.parse(p.profile) as PublicProfile) : null }];
    }));
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
      this.sql.exec('DELETE FROM fsug_cards WHERE player_id = ?', playerId); // REQ-FSUG-011
      this.sql.exec('UPDATE invite_codes SET player_id = NULL, retired_at = ? WHERE player_id = ?', Date.now(), playerId); // REQ-INV-010
      // REQ-TRF-017: the player's 引き継ぎコード and its audit live in the player's shard (the code's first character)
      this.sql.exec('DELETE FROM transfer_codes WHERE player_id = ?', playerId);
      this.sql.exec('DELETE FROM transfer_audit WHERE player_id = ?', playerId);
      // REQ-LINK-020: the player's links live in the player's shard (the token's first character): every link stops opening
      this.sql.exec('DELETE FROM links WHERE owner_id = ?', playerId);
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
  fsugPut(c: FsugCard): Promise<Envelope<boolean>>;
  fsugRemove(id: string): Promise<Envelope<boolean>>;
  fsugCards(ids: string[]): Promise<Envelope<{ card: FsugCard; profile: PublicProfile | null }[]>>;
  inviteCodeOf(p: string, s: number): Promise<Envelope<string>>;
  inviteLookup(c: string): Promise<Envelope<string | null>>;
  inviteRetire(p: string): Promise<Envelope<boolean>>;
  installClaim(h: string, p: string): Promise<Envelope<string>>;
  installRelease(h: string, p: string): Promise<Envelope<boolean>>;
  installAnonymize(h: string): Promise<Envelope<boolean>>;
  transferPut(rec: TransferRecord, now: number): Promise<Envelope<boolean>>;
  transferBegin(codeId: string, now: number, maxAttempts: number, lockMs: number): Promise<Envelope<BeginResult>>;
  transferRemove(codeId: string, playerId: string): Promise<Envelope<boolean>>;
  transferLimitCheck(keys: string[], now: number): Promise<Envelope<number | null>>;
  transferLimitFail(keys: string[], now: number, rules: LimitRule[], lockMs: number): Promise<Envelope<boolean>>;
  transferAudit(row: AuditRow): Promise<Envelope<boolean>>;
  transferAuditOf(playerId: string, limit: number): Promise<Envelope<AuditRow[]>>;
  linkPut(rec: LinkRecord, perDay: number, now: number): Promise<Envelope<PutResult>>;
  linkGet(token: string): Promise<Envelope<LinkRecord | null>>;
  linkRevoke(token: string, ownerId: string, now: number): Promise<Envelope<LinkRecord | null>>;
  linkListOf(ownerId: string, day: string, now: number): Promise<Envelope<{ links: LinkRecord[]; madeToday: number }>>;
  linkLimitCheck(keys: string[], now: number): Promise<Envelope<number | null>>;
  linkLimitNote(keys: string[], now: number, failed: boolean, rules: LinkLimitRules): Promise<Envelope<boolean>>;
};

/**
 * REQ-LINK-*: ディープリンク over the directory shards. A link lives in the shard its token's first character names (= the
 * owner's shard: idempotency, the daily count and the deletion's forget are one shard's work); limit keys in their hash's shard.
 */
export function shardedLinkDirectory(ns: DurableObjectNamespace): LinkDirectory {
  const shard = (n: number) => ns.get(ns.idFromName(`dir:${n}`)) as unknown as DirStub;
  const keyShard = (k: string) => parseInt(k.slice(k.indexOf(':') + 1, k.indexOf(':') + 3), 16) % DIRECTORY_SHARDS;
  const byKey = (keys: string[]) => {
    const g = new Map<number, string[]>();
    for (const k of keys) g.set(keyShard(k), [...(g.get(keyShard(k)) ?? []), k]);
    return [...g];
  };
  return {
    async put(rec, perDay, now) { return unwrap(await shard(tokenShard(rec.token)).linkPut(rec, perDay, now)); },
    async get(token) { return unwrap(await shard(tokenShard(token)).linkGet(token)); },
    async revoke(token, owner, now) { return unwrap(await shard(tokenShard(token)).linkRevoke(token, owner, now)); },
    async listOf(owner, day, now) { return unwrap(await shard(shardOf(owner)).linkListOf(owner, day, now)); },
    async limitCheck(keys, now) {
      const waits = await Promise.all(byKey(keys).map(async ([s, ks]) => unwrap(await shard(s).linkLimitCheck(ks, now))));
      const w = waits.filter((x): x is number => x !== null);
      return w.length ? Math.max(...w) : null;
    },
    async limitNote(keys, now, failed, rules) { await Promise.all(byKey(keys).map(async ([s, ks]) => unwrap(await shard(s).linkLimitNote(ks, now, failed, rules)))); },
  };
}

/**
 * REQ-TRF-*: 引き継ぎコード over the directory shards. A code lives in the shard its first character names (= the owner's
 * shard, so the account deletion's forget finds it); limit keys in the shard of their hash; the audit in the player's shard.
 */
export function shardedTransferDirectory(ns: DurableObjectNamespace): TransferDirectory {
  const shard = (n: number) => ns.get(ns.idFromName(`dir:${n}`)) as unknown as DirStub;
  const keyShard = (k: string) => parseInt(k.slice(k.indexOf(':') + 1, k.indexOf(':') + 3), 16) % DIRECTORY_SHARDS;
  const byKey = (keys: string[]) => {
    const g = new Map<number, string[]>();
    for (const k of keys) g.set(keyShard(k), [...(g.get(keyShard(k)) ?? []), k]);
    return [...g];
  };
  return {
    async put(rec, now) { return unwrap(await shard(codeShard(rec.codeId)).transferPut(rec, now)); },
    async begin(id, now, max, lockMs) { return unwrap(await shard(codeShard(id)).transferBegin(id, now, max, lockMs)); },
    async remove(id, p) { unwrap(await shard(codeShard(id)).transferRemove(id, p)); },
    async limitCheck(keys, now) {
      const waits = await Promise.all(byKey(keys).map(async ([s, ks]) => unwrap(await shard(s).transferLimitCheck(ks, now))));
      const w = waits.filter((x): x is number => x !== null);
      return w.length ? Math.max(...w) : null;
    },
    async limitFail(keys, now, rules, lockMs) { await Promise.all(byKey(keys).map(async ([s, ks]) => unwrap(await shard(s).transferLimitFail(ks, now, rules, lockMs)))); },
    async audit(row) { unwrap(await shard(shardOf(row.playerId)).transferAudit(row)); },
    async auditOf(p, limit) { return unwrap(await shard(shardOf(p)).transferAuditOf(p, limit)); },
  };
}

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

/** REQ-FSUG-010/011: おすすめフレンド cards, sharded by player like profiles (a lookup is at most one call per shard). */
export function shardedSuggestDirectory(ns: DurableObjectNamespace): SuggestDirectory {
  const shard = (n: number) => ns.get(ns.idFromName(`dir:${n}`)) as unknown as DirStub;
  return {
    async put(c) { unwrap(await shard(shardOf(c.playerId)).fsugPut(c)); },
    async remove(id) { unwrap(await shard(shardOf(id)).fsugRemove(id)); },
    async cards(ids) {
      return (await Promise.all([...byShard(ids)].map(async ([s, g]) => unwrap(await shard(s).fsugCards(g))))).flat();
    },
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
