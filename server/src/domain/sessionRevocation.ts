/**
 * ログイン中の端末 (REQ-DEV-004/005/008, contracts/protocol.md §70): the session revocation check the Worker runs on every
 * player request, after the §54.6 old-device check. Kept free of imports so the session guard (transferCode.ts) and the
 * device list (devices.ts) can both use it without an import cycle.
 *
 * A session is one Firebase sign-in, identified by the ID token's `auth_time` (seconds; a token refresh keeps it).
 */
import { AppError } from './errors.js';

/** What the player object answers for the guard (no hashes, no labels: only what the check needs). */
export interface SessionRevocations {
  /** `auth_time` (seconds) of the sessions signed out one by one. */
  revoked: number[];
  /** 「この端末以外すべて」: every session signed in at or before `at` (ms) is revoked, except the one with `auth_time` = `keep` (null = none kept: support's "all"). */
  othersBefore: { at: number; keep: number | null } | null;
}

/** True when a token signed in at `authTimeSec` was signed out from another device (or by support). */
export function sessionRevoked(r: SessionRevocations | null | undefined, authTimeSec: number | null): boolean {
  if (!r || authTimeSec === null) return false; // a token without auth_time cannot be told apart: only §54.6 refuses those
  if (r.revoked.includes(authTimeSec)) return true;
  const o = r.othersBefore;
  return o !== null && authTimeSec * 1000 <= o.at && authTimeSec !== o.keep;
}

export const sessionRevokedError = () => new AppError('SESSION_REVOKED', 'この端末はログアウトされました', 401);
