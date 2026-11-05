import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { z } from 'zod';
import { AppError } from '../domain/errors.js';
import { sha256Hex } from './hash.js';

/**
 * Admin authentication, roles, rate limiting and audit records (REQ-OPS-010..014).
 * Roles are ordered: viewer < operator < admin. Tokens are never stored in clear: configuration holds
 * their SHA-256 (`ADMIN_TOKENS` secret). Cloudflare Access can be used instead of / in addition to tokens.
 */
export type AdminRole = 'viewer' | 'operator' | 'admin';
export const ROLE_RANK: Record<AdminRole, number> = { viewer: 1, operator: 2, admin: 3 };

export interface AdminPrincipal { id: string; role: AdminRole; via: 'token' | 'access' | 'legacy' }

const tokenEntry = z.object({ name: z.string().min(1).max(64), role: z.enum(['viewer', 'operator', 'admin']), sha256: z.string().regex(/^[0-9a-f]{64}$/) }).strict();
export type AdminTokenEntry = z.infer<typeof tokenEntry>;

export function parseAdminTokens(json: string | undefined): AdminTokenEntry[] {
  if (!json) return [];
  const r = z.array(tokenEntry).safeParse(JSON.parse(json));
  if (!r.success) throw new AppError('CONFIG_INVALID', `ADMIN_TOKENS: ${r.error.issues.map((i) => i.message).join(', ')}`);
  return r.data;
}

function constantTimeHexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export interface AccessConfig { teamDomain: string; audience: string; roles: Record<string, AdminRole>; jwks?: JWTVerifyGetKey }

export interface AdminAuthConfig {
  tokens: AdminTokenEntry[];
  /** Legacy single ADMIN_TOKEN (treated as role admin, id "legacy"). */
  legacyToken?: string | undefined;
  access?: AccessConfig | undefined;
}

let remoteJwks: { domain: string; get: JWTVerifyGetKey } | null = null;

/** Resolves the caller of an admin request, or throws UNAUTHORIZED. */
export async function authenticateAdmin(req: Request, cfg: AdminAuthConfig): Promise<AdminPrincipal> {
  const accessJwt = req.headers.get('cf-access-jwt-assertion');
  if (accessJwt && cfg.access) {
    const a = cfg.access;
    if (!remoteJwks || remoteJwks.domain !== a.teamDomain) remoteJwks = { domain: a.teamDomain, get: createRemoteJWKSet(new URL(`https://${a.teamDomain}/cdn-cgi/access/certs`)) };
    try {
      const { payload } = await jwtVerify(accessJwt, a.jwks ?? remoteJwks.get, { issuer: `https://${a.teamDomain}`, audience: a.audience });
      const email = typeof payload.email === 'string' ? payload.email.toLowerCase() : null;
      // role keys are configured by hand (ACCESS_ROLES); compare case-insensitively like the email
      const role = email ? Object.entries(a.roles).find(([k]) => k.trim().toLowerCase() === email)?.[1] : undefined;
      if (!email || !role) throw new AppError('FORBIDDEN', 'no admin role for this identity');
      return { id: email, role, via: 'access' };
    } catch (e) {
      if (e instanceof AppError) throw e;
      throw new AppError('UNAUTHORIZED', 'invalid access token');
    }
  }
  const auth = req.headers.get('authorization') ?? '';
  const m = /^Bearer (.{1,512})$/.exec(auth);
  if (m) {
    const digest = await sha256Hex(m[1]!);
    let found: AdminTokenEntry | null = null;
    for (const t of cfg.tokens) if (constantTimeHexEqual(digest, t.sha256)) found = t; // no early exit
    if (found) return { id: found.name, role: found.role, via: 'token' };
    if (cfg.legacyToken && constantTimeHexEqual(digest, await sha256Hex(cfg.legacyToken))) return { id: 'legacy', role: 'admin', via: 'legacy' };
  }
  throw new AppError('UNAUTHORIZED');
}

export function requireRole(p: AdminPrincipal, need: AdminRole) {
  if (ROLE_RANK[p.role] < ROLE_RANK[need]) throw new AppError('FORBIDDEN', `requires role ${need}`);
}

// ------------------------------------------------------------------------------------ rate limit

export interface RateLimitPolicy { capacity: number; refillPerSec: number }
export const ADMIN_RATE: Record<'read' | 'write', RateLimitPolicy> = {
  read: { capacity: 120, refillPerSec: 2 },
  write: { capacity: 30, refillPerSec: 0.5 },
};

/** Token bucket per (principal, kind). In-memory: one ops object serializes all admin traffic. */
export class RateLimiter {
  private buckets = new Map<string, { tokens: number; at: number }>();
  constructor(private readonly policy: Record<'read' | 'write', RateLimitPolicy> = ADMIN_RATE) {}

  take(principalId: string, kind: 'read' | 'write', now: number) {
    const p = this.policy[kind];
    const key = `${principalId}|${kind}`;
    const b = this.buckets.get(key) ?? { tokens: p.capacity, at: now };
    b.tokens = Math.min(p.capacity, b.tokens + ((now - b.at) / 1000) * p.refillPerSec);
    b.at = now;
    if (b.tokens < 1) {
      this.buckets.set(key, b);
      throw new AppError('RATE_LIMITED', `admin ${kind} rate limit`);
    }
    b.tokens -= 1;
    this.buckets.set(key, b);
  }
}

// ------------------------------------------------------------------------------------ audit

export interface AuditInput {
  actor: string; role: AdminRole; action: string; method: string; path: string;
  target: string | null; reason: string | null; before: unknown; after: unknown;
  result: 'ok' | 'error'; error?: string | undefined;
}
export interface AuditEntry extends AuditInput { seq: number; at: number }
export interface AuditQuery { actor?: string; target?: string; action?: string; beforeSeq?: number; limit?: number }

export interface AuditRepo {
  append(e: Omit<AuditEntry, 'seq'>): AuditEntry;
  query(q: AuditQuery): AuditEntry[];
}

/** Values in the audit log are truncated so one entry stays small. */
export function auditValue(v: unknown, max = 8000): unknown {
  if (v === undefined) return null;
  const s = JSON.stringify(v);
  return s.length <= max ? v : { truncated: true, preview: s.slice(0, max) };
}

export class MemoryAuditRepo implements AuditRepo {
  rows: AuditEntry[] = [];
  append(e: Omit<AuditEntry, 'seq'>) {
    const row = { ...e, seq: this.rows.length + 1 };
    this.rows.push(row);
    return row;
  }
  query(q: AuditQuery) {
    return this.rows
      .filter((r) => (!q.actor || r.actor === q.actor) && (!q.target || r.target === q.target) && (!q.action || r.action === q.action) && (!q.beforeSeq || r.seq < q.beforeSeq))
      .sort((a, b) => b.seq - a.seq)
      .slice(0, Math.min(200, q.limit ?? 50));
  }
}
