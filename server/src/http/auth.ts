import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { AppError } from '../domain/errors.js';

const GOOGLE_JWKS = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
let remote: JWTVerifyGetKey | undefined;

/** A verified ID token: the account and when it signed in to Firebase (`auth_time`, seconds; null when absent). */
export interface FirebaseSession { uid: string; authTime: number | null }

/**
 * REQ-API-001: verifies a Firebase Auth ID token (RS256, issuer/audience = project, not expired,
 * non-empty sub). `keys` is injectable for tests. REQ-TRF-010: also returns `auth_time` (the old-device check, §54.6).
 */
export async function verifyFirebaseSession(token: string, projectId: string, keys?: JWTVerifyGetKey): Promise<FirebaseSession> {
  const getKey = keys ?? (remote ??= createRemoteJWKSet(new URL(GOOGLE_JWKS)));
  try {
    const { payload } = await jwtVerify(token, getKey, {
      issuer: `https://securetoken.google.com/${projectId}`,
      audience: projectId,
      algorithms: ['RS256'],
    });
    if (typeof payload.sub !== 'string' || payload.sub.length === 0 || payload.sub.length > 128) throw new Error('bad sub');
    if (typeof payload.auth_time === 'number' && payload.auth_time * 1000 > Date.now() + 60_000) throw new Error('auth_time in future');
    return { uid: payload.sub, authTime: typeof payload.auth_time === 'number' ? payload.auth_time : null };
  } catch {
    throw new AppError('UNAUTHORIZED');
  }
}

export async function verifyFirebaseIdToken(token: string, projectId: string, keys?: JWTVerifyGetKey): Promise<string> {
  return (await verifyFirebaseSession(token, projectId, keys)).uid;
}

export function bearer(req: Request): string {
  const h = req.headers.get('authorization') ?? '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  if (!m) throw new AppError('UNAUTHORIZED');
  return m[1]!;
}
