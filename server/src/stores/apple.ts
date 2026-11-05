/**
 * Apple App Store (StoreKit 2) — REQ-PUR-003/006.
 *
 * - Purchases: the app sends `Transaction.jwsRepresentation`. We verify the JWS x5c chain up to
 *   Apple Root CA - G3 (Apple leaf/intermediate OIDs, validity dates, ECDSA signatures), the ES256
 *   signature, bundleId, environment and productId, then map it to a VerifiedReceipt.
 * - App Store Server Notifications V2: the same verification on `signedPayload` and on the embedded
 *   `signedTransactionInfo`; mapped to refund / renewal / subscription-status events.
 * - App Store Server API client (optional lookups) authenticated with an ES256 JWT.
 */
import { importPKCS8, SignJWT } from 'jose';
import { AppError } from '../domain/errors.js';
import type { StoreVerifier, SubscriptionStatus, VerifiedReceipt } from '../domain/purchase.js';
import { appleAccountToken } from './binding.js';
import { b64ToBytes, b64urlToBytes, parseCertificate, pemToDer, sameBytes, verifyIssuedBy, importEcPublicKey, type Certificate } from './x509.js';

/** Apple Root CA - G3 (https://www.apple.com/certificateauthority/AppleRootCA-G3.cer), SHA-256 63:34:3A:BF:…:91:79. */
export const APPLE_ROOT_CA_G3_PEM = `-----BEGIN CERTIFICATE-----
MIICQzCCAcmgAwIBAgIILcX8iNLFS5UwCgYIKoZIzj0EAwMwZzEbMBkGA1UEAwwS
QXBwbGUgUm9vdCBDQSAtIEczMSYwJAYDVQQLDB1BcHBsZSBDZXJ0aWZpY2F0aW9u
IEF1dGhvcml0eTETMBEGA1UECgwKQXBwbGUgSW5jLjELMAkGA1UEBhMCVVMwHhcN
MTQwNDMwMTgxOTA2WhcNMzkwNDMwMTgxOTA2WjBnMRswGQYDVQQDDBJBcHBsZSBS
b290IENBIC0gRzMxJjAkBgNVBAsMHUFwcGxlIENlcnRpZmljYXRpb24gQXV0aG9y
aXR5MRMwEQYDVQQKDApBcHBsZSBJbmMuMQswCQYDVQQGEwJVUzB2MBAGByqGSM49
AgEGBSuBBAAiA2IABJjpLz1AcqTtkyJygRMc3RCV8cWjTnHcFBbZDuWmBSp3ZHtf
TjjTuxxEtX/1H7YyYl3J6YRbTzBPEVoA/VhYDKX1DyxNB0cTddqXl5dvMVztK517
IDvYuVTZXpmkOlEKMaNCMEAwHQYDVR0OBBYEFLuw3qFYM4iapIqZ3r6966/ayySr
MA8GA1UdEwEB/wQFMAMBAf8wDgYDVR0PAQH/BAQDAgEGMAoGCCqGSM49BAMDA2gA
MGUCMQCD6cHEFl4aXTQY2e3v9GwOAEZLuN+yRhHFD/3meoyhpmvOwgPUnPWTxnS4
at+qIxUCMG1mihDK1A3UT82NQz60imOlM27jbdoXt2QfyFMm+YhidDkLF1vLUagM
6BgD56KyKA==
-----END CERTIFICATE-----`;

/** Apple marker extensions (see Apple's app-store-server-library). */
export const APPLE_OID = { leaf: '1.2.840.113635.100.6.11.1', intermediate: '1.2.840.113635.100.6.2.1' } as const;

export interface AppleConfig {
  bundleId: string;
  /** Trusted roots (DER). Defaults to Apple Root CA - G3. Tests inject their own. */
  roots?: Uint8Array[];
  /** Accept Sandbox/Xcode transactions (needed for App Review and TestFlight). Granted with priceYen 0. */
  acceptSandbox: boolean;
  /** Master products sold as auto-renewable subscriptions. */
  subscriptionProductIds: ReadonlySet<string>;
  /** Fallback price when the transaction is not in JPY. */
  priceYen(productId: string): number;
  now?: () => number;
}

export interface AppleTransaction {
  transactionId: string;
  originalTransactionId: string;
  bundleId: string;
  productId: string;
  purchaseDate: number;
  environment: 'Production' | 'Sandbox' | 'Xcode' | string;
  type?: string;
  price?: number;
  currency?: string;
  expiresDate?: number;
  revocationDate?: number;
  appAccountToken?: string;
  signedDate?: number;
}

/** Verify an Apple-signed JWS (x5c chain + ES256) and return its decoded payload. Throws on any failure. */
export async function verifyAppleJws<T = unknown>(jws: string, cfg: Pick<AppleConfig, 'roots' | 'now'>): Promise<T> {
  const parts = jws.split('.');
  if (parts.length !== 3) throw new Error('jws: not compact');
  const [h, p, s] = parts as [string, string, string];
  const header = JSON.parse(new TextDecoder().decode(b64urlToBytes(h))) as { alg?: string; x5c?: string[] };
  if (header.alg !== 'ES256') throw new Error('jws: alg must be ES256');
  if (!Array.isArray(header.x5c) || header.x5c.length !== 3) throw new Error('jws: x5c must hold 3 certificates');

  const [leaf, inter, root] = header.x5c.map((c) => parseCertificate(b64ToBytes(c))) as [Certificate, Certificate, Certificate];
  const roots = cfg.roots ?? [pemToDer(APPLE_ROOT_CA_G3_PEM)];
  if (!roots.some((r) => sameBytes(r, root.der))) throw new Error('chain: untrusted root');
  const now = (cfg.now ?? Date.now)();
  for (const c of [leaf, inter, root]) {
    if (now < c.notBefore || now > c.notAfter) throw new Error('chain: certificate not valid at this time');
  }
  if (!inter.extensions.has(APPLE_OID.intermediate) || !inter.isCa) throw new Error('chain: not an Apple intermediate');
  if (!leaf.extensions.has(APPLE_OID.leaf)) throw new Error('chain: not an Apple leaf');
  if (!(await verifyIssuedBy(inter, root))) throw new Error('chain: intermediate not signed by root');
  if (!(await verifyIssuedBy(leaf, inter))) throw new Error('chain: leaf not signed by intermediate');
  if (leaf.curve !== 'P-256') throw new Error('jws: leaf key must be P-256');

  const sig = b64urlToBytes(s);
  if (sig.length !== 64) throw new Error('jws: bad signature length');
  const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, await importEcPublicKey(leaf), sig, new TextEncoder().encode(`${h}.${p}`));
  if (!ok) throw new Error('jws: bad signature');
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(p))) as T;
}

const isSandbox = (env: string) => env !== 'Production';

function checkEnvironment(env: string, cfg: AppleConfig) {
  if (env !== 'Production' && env !== 'Sandbox' && env !== 'Xcode') throw new Error(`unknown environment ${env}`);
  if (isSandbox(env) && !cfg.acceptSandbox) throw new Error('sandbox transactions are not accepted');
}

/** Map a verified transaction to what the purchase domain needs. */
export function appleToReceipt(t: AppleTransaction, cfg: AppleConfig): VerifiedReceipt {
  const sandbox = isSandbox(t.environment);
  const yen = t.currency === 'JPY' && typeof t.price === 'number' ? Math.round(t.price / 1000) : cfg.priceYen(t.productId);
  const subscription = cfg.subscriptionProductIds.has(t.productId);
  return {
    transactionId: `apple:${t.transactionId}`,
    productId: t.productId,
    purchasedAt: t.purchaseDate,
    priceYen: sandbox ? 0 : yen,
    sandbox,
    originalTransactionId: subscription ? `apple:${t.originalTransactionId}` : undefined,
    expiresAt: subscription && t.expiresDate ? t.expiresDate : undefined,
  };
}

export class AppleStoreVerifier implements StoreVerifier {
  readonly platform = 'apple' as const;
  constructor(private readonly cfg: AppleConfig) {}

  async verify(receipt: string, expectedProductId: string, ctx?: { playerId: string }): Promise<VerifiedReceipt> {
    let t: AppleTransaction;
    try {
      t = await verifyAppleJws<AppleTransaction>(receipt.trim(), this.cfg);
      checkEnvironment(t.environment, this.cfg);
    } catch (e) {
      throw new AppError('RECEIPT_INVALID', `apple: ${(e as Error).message}`);
    }
    if (t.bundleId !== this.cfg.bundleId) throw new AppError('RECEIPT_INVALID', 'apple: bundleId mismatch');
    if (t.productId !== expectedProductId) throw new AppError('RECEIPT_INVALID', 'apple: productId mismatch');
    if (t.revocationDate) throw new AppError('RECEIPT_INVALID', 'apple: transaction was revoked');
    if (ctx && t.appAccountToken && t.appAccountToken.toLowerCase() !== (await appleAccountToken(ctx.playerId))) {
      throw new AppError('RECEIPT_INVALID', 'apple: appAccountToken belongs to another player');
    }
    const r = appleToReceipt(t, this.cfg);
    const now = (this.cfg.now ?? Date.now)();
    if (r.expiresAt !== undefined && r.expiresAt <= now) throw new AppError('RECEIPT_INVALID', 'apple: subscription period already expired');
    return r;
  }
}

// ---------------------------------------------------------------- notifications V2

export interface AppleNotificationPayload {
  notificationType: string;
  subtype?: string;
  notificationUUID: string;
  data?: { bundleId?: string; environment?: string; signedTransactionInfo?: string; signedRenewalInfo?: string };
  signedDate?: number;
}

/** Store event independent of the platform; the HTTP layer resolves the player and applies it. */
export type StoreEvent =
  | { kind: 'refund'; transactionId: string; lookupKeys: string[] }
  | { kind: 'renewal'; receipt: VerifiedReceipt; lookupKeys: string[] }
  | { kind: 'subscription'; key: string; status: SubscriptionStatus; expiresAt: number | null; lookupKeys: string[] }
  | { kind: 'ignored'; reason: string };

export type { SubscriptionStatus };

/** Verify and interpret an App Store Server Notification V2 body (`{"signedPayload": "..."}`). */
export async function parseAppleNotification(body: unknown, cfg: AppleConfig): Promise<StoreEvent> {
  const signed = (body as { signedPayload?: unknown } | null)?.signedPayload;
  if (typeof signed !== 'string') throw new AppError('BAD_REQUEST', 'apple: missing signedPayload');
  let n: AppleNotificationPayload;
  let t: AppleTransaction | null = null;
  try {
    n = await verifyAppleJws<AppleNotificationPayload>(signed, cfg);
    if (n.data?.signedTransactionInfo) t = await verifyAppleJws<AppleTransaction>(n.data.signedTransactionInfo, cfg);
  } catch (e) {
    throw new AppError('UNAUTHORIZED', `apple: ${(e as Error).message}`);
  }
  if (n.notificationType === 'TEST') return { kind: 'ignored', reason: 'TEST' };
  if (n.data?.bundleId !== undefined && n.data.bundleId !== cfg.bundleId) throw new AppError('BAD_REQUEST', 'apple: bundleId mismatch');
  const env = n.data?.environment ?? t?.environment ?? 'Production';
  if (isSandbox(env) && !cfg.acceptSandbox) return { kind: 'ignored', reason: 'sandbox' };
  if (!t) return { kind: 'ignored', reason: `${n.notificationType}: no transaction` };
  if (t.bundleId !== cfg.bundleId) throw new AppError('BAD_REQUEST', 'apple: bundleId mismatch');

  const txKey = `apple:${t.transactionId}`;
  const subKey = `apple:${t.originalTransactionId}`;
  const keys = [txKey, subKey];
  switch (n.notificationType) {
    case 'REFUND':
    case 'REVOKE':
      return { kind: 'refund', transactionId: txKey, lookupKeys: keys };
    case 'SUBSCRIBED':
    case 'DID_RENEW':
    case 'OFFER_REDEEMED':
      if (!cfg.subscriptionProductIds.has(t.productId)) return { kind: 'ignored', reason: `${n.notificationType}: not a subscription product` };
      return { kind: 'renewal', receipt: appleToReceipt(t, cfg), lookupKeys: [subKey, txKey] };
    case 'DID_FAIL_TO_RENEW':
      return { kind: 'subscription', key: subKey, status: n.subtype === 'GRACE_PERIOD' ? 'grace' : 'billing_retry', expiresAt: t.expiresDate ?? null, lookupKeys: [subKey] };
    case 'GRACE_PERIOD_EXPIRED':
    case 'EXPIRED':
      return { kind: 'subscription', key: subKey, status: 'expired', expiresAt: t.expiresDate ?? null, lookupKeys: [subKey] };
    case 'DID_CHANGE_RENEWAL_STATUS':
      return { kind: 'subscription', key: subKey, status: n.subtype === 'AUTO_RENEW_DISABLED' ? 'canceled' : 'active', expiresAt: t.expiresDate ?? null, lookupKeys: [subKey] };
    case 'CONSUMPTION_REQUEST':
      // We do not send consumption data (optional for Apple). Acknowledge only.
      return { kind: 'ignored', reason: 'CONSUMPTION_REQUEST' };
    default:
      return { kind: 'ignored', reason: n.notificationType };
  }
}

// ---------------------------------------------------------------- App Store Server API (optional)

export interface AppStoreApiConfig {
  issuerId: string;
  keyId: string;
  /** PKCS#8 PEM of the In-App Purchase key (.p8). */
  privateKeyPem: string;
  bundleId: string;
  sandbox: boolean;
  fetch?: typeof fetch;
}

/** Lookups against the App Store Server API (e.g. recovering a transaction the app failed to report). */
export class AppStoreServerApi {
  private key: CryptoKey | null = null;
  constructor(private readonly cfg: AppStoreApiConfig) {}

  private async token(): Promise<string> {
    this.key ??= (await importPKCS8(this.cfg.privateKeyPem, 'ES256')) as CryptoKey;
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ bid: this.cfg.bundleId })
      .setProtectedHeader({ alg: 'ES256', kid: this.cfg.keyId, typ: 'JWT' })
      .setIssuer(this.cfg.issuerId).setAudience('appstoreconnect-v1').setIssuedAt(now).setExpirationTime(now + 300)
      .sign(this.key);
  }

  /** GET /inApps/v1/transactions/{transactionId} → signedTransactionInfo (verify it with verifyAppleJws). */
  async getSignedTransaction(transactionId: string): Promise<string> {
    const host = this.cfg.sandbox ? 'https://api.storekit-sandbox.itunes.apple.com' : 'https://api.storekit.itunes.apple.com';
    const f = this.cfg.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
    const res = await f(`${host}/inApps/v1/transactions/${encodeURIComponent(transactionId)}`, { headers: { authorization: `Bearer ${await this.token()}` } });
    if (res.status === 404) throw new AppError('RECEIPT_INVALID', 'apple: transaction not found');
    if (!res.ok) throw new AppError('RECEIPT_INVALID', `apple: server api ${res.status}`, 502);
    const j = (await res.json()) as { signedTransactionInfo?: string };
    if (!j.signedTransactionInfo) throw new AppError('RECEIPT_INVALID', 'apple: empty response', 502);
    return j.signedTransactionInfo;
  }
}
