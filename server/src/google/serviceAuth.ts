/**
 * OAuth2 access token from a Google service-account JWT (RFC 7523), cached until shortly before expiry.
 * Shared by the Play Developer API (stores/google.ts) and FCM HTTP v1 (push/fcm.ts); only the scope differs.
 */
import { importPKCS8, SignJWT } from 'jose';
import { AppError, type ErrorCode } from '../domain/errors.js';

export interface ServiceAccount { client_email: string; private_key: string; token_uri?: string; project_id?: string }

export type Fetch = typeof fetch;
export const defaultFetch: Fetch = (...a) => fetch(...a);

export interface ServiceAuthOptions {
  scope: string;
  /** Error raised when the token endpoint refuses (callers map it to their own domain). */
  errorCode?: ErrorCode;
  errorPrefix?: string;
}

export class GoogleOAuth {
  private cached: { token: string; exp: number } | null = null;
  private key: CryptoKey | null = null;
  constructor(
    private readonly sa: ServiceAccount,
    private readonly opts: ServiceAuthOptions,
    private readonly f: Fetch = defaultFetch,
    private readonly now: () => number = Date.now,
  ) {}

  /** Drop the cached token (e.g. after the API answered 401). */
  invalidate() { this.cached = null; }

  async accessToken(): Promise<string> {
    const t = this.now();
    if (this.cached && this.cached.exp - 60_000 > t) return this.cached.token;
    this.key ??= (await importPKCS8(this.sa.private_key, 'RS256')) as CryptoKey;
    const aud = this.sa.token_uri ?? 'https://oauth2.googleapis.com/token';
    const iat = Math.floor(t / 1000);
    const assertion = await new SignJWT({ scope: this.opts.scope })
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
      .setIssuer(this.sa.client_email).setAudience(aud).setIssuedAt(iat).setExpirationTime(iat + 3600)
      .sign(this.key);
    const res = await this.f(aud, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
    });
    if (!res.ok) throw new AppError(this.opts.errorCode ?? 'BAD_REQUEST', `${this.opts.errorPrefix ?? 'google'}: oauth ${res.status}`, 502);
    const j = (await res.json()) as { access_token: string; expires_in: number };
    this.cached = { token: j.access_token, exp: t + j.expires_in * 1000 };
    return j.access_token;
  }
}
