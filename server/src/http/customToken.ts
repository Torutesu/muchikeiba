/**
 * REQ-TRF-011 (contracts/protocol.md §54.7): Firebase custom tokens signed in the Worker with the service-account key held
 * in the wrangler secret FIREBASE_AUTH_SERVICE_ACCOUNT_JSON (never in the repository; rotation in docs/ops/deploy.md §8).
 * Signing is local (no network), so a redeem signs before it consumes the code.
 */
import { importPKCS8, SignJWT } from 'jose';
import type { CustomTokenSigner } from '../domain/transferService.js';

export const CUSTOM_TOKEN_AUDIENCE = 'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit';
export const CUSTOM_TOKEN_TTL_SEC = 3600;

interface ServiceAccountKey { client_email: string; private_key: string }

/** Parses the secret; null when it is absent or not a service-account key (the feature then reports enabled: false). */
export function parseServiceAccount(json: string | undefined): ServiceAccountKey | null {
  if (!json) return null;
  try {
    const j = JSON.parse(json) as Partial<ServiceAccountKey>;
    if (typeof j.client_email !== 'string' || !j.client_email.includes('@') || typeof j.private_key !== 'string' || !j.private_key.includes('PRIVATE KEY')) return null;
    return { client_email: j.client_email, private_key: j.private_key };
  } catch { return null; }
}

/** RS256 JWT: iss = sub = the service account, aud = Identity Toolkit, exp = iat + 1 h, uid = the account (no extra claims). */
export function firebaseCustomTokenSigner(sa: ServiceAccountKey): CustomTokenSigner {
  let key: Promise<CryptoKey> | null = null;
  return {
    async sign(uid, nowMs) {
      if (!uid || uid.length > 128) throw new Error('custom token: bad uid');
      key ??= importPKCS8(sa.private_key, 'RS256') as Promise<CryptoKey>;
      const iat = Math.floor(nowMs / 1000);
      return new SignJWT({ uid })
        .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
        .setIssuer(sa.client_email).setSubject(sa.client_email).setAudience(CUSTOM_TOKEN_AUDIENCE)
        .setIssuedAt(iat).setExpirationTime(iat + CUSTOM_TOKEN_TTL_SEC)
        .sign(await key);
    },
  };
}

export function signerFromEnv(json: string | undefined): CustomTokenSigner | null {
  const sa = parseServiceAccount(json);
  return sa ? firebaseCustomTokenSigner(sa) : null;
}
