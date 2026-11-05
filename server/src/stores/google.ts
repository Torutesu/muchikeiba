/**
 * Google Play — REQ-PUR-003/006.
 *
 * - Purchases: the app sends `{"purchaseToken": "..."}`. We query the Play Developer API
 *   (purchases.products.get / purchases.subscriptionsv2.get) with a service account, check state,
 *   package, product and account binding, and after granting consume (coins) or acknowledge (subscription).
 * - Real-time developer notifications (RTDN): Pub/Sub push requests authenticated by a Google-signed
 *   OIDC token (issuer, audience, service-account email). Voided purchases → refund; subscription
 *   changes → renewal or status update.
 */
import { createRemoteJWKSet, importPKCS8, jwtVerify, SignJWT, type JWTVerifyGetKey } from 'jose';
import { AppError } from '../domain/errors.js';
import type { StoreVerifier, VerifiedReceipt } from '../domain/purchase.js';
import type { StoreEvent } from './apple.js';
import type { SubscriptionStatus } from '../domain/purchase.js';
import { googleAccountId } from './binding.js';

export interface ServiceAccount { client_email: string; private_key: string; token_uri?: string }

type Fetch = typeof fetch;
const defaultFetch: Fetch = (...a) => fetch(...a);

/** OAuth2 access token from a service-account JWT (RFC 7523), cached until shortly before expiry. */
export class GoogleServiceAuth {
  private cached: { token: string; exp: number } | null = null;
  private key: CryptoKey | null = null;
  constructor(private readonly sa: ServiceAccount, private readonly f: Fetch = defaultFetch, private readonly now: () => number = Date.now) {}

  async accessToken(): Promise<string> {
    const t = this.now();
    if (this.cached && this.cached.exp - 60_000 > t) return this.cached.token;
    this.key ??= (await importPKCS8(this.sa.private_key, 'RS256')) as CryptoKey;
    const aud = this.sa.token_uri ?? 'https://oauth2.googleapis.com/token';
    const iat = Math.floor(t / 1000);
    const assertion = await new SignJWT({ scope: 'https://www.googleapis.com/auth/androidpublisher' })
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
      .setIssuer(this.sa.client_email).setAudience(aud).setIssuedAt(iat).setExpirationTime(iat + 3600)
      .sign(this.key);
    const res = await this.f(aud, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
    });
    if (!res.ok) throw new AppError('RECEIPT_INVALID', `google: oauth ${res.status}`, 502);
    const j = (await res.json()) as { access_token: string; expires_in: number };
    this.cached = { token: j.access_token, exp: t + j.expires_in * 1000 };
    return j.access_token;
  }
}

export interface ProductPurchase {
  purchaseState?: number; // 0 purchased, 1 canceled, 2 pending
  consumptionState?: number; // 0 yet to be consumed, 1 consumed
  acknowledgementState?: number;
  orderId?: string;
  purchaseTimeMillis?: string;
  purchaseType?: number; // 0 test (license testing), 1 promo, 2 rewarded
  obfuscatedExternalAccountId?: string;
  productId?: string;
}
export interface SubscriptionPurchaseV2 {
  subscriptionState?: string;
  latestOrderId?: string;
  linkedPurchaseToken?: string;
  acknowledgementState?: string;
  startTime?: string;
  testPurchase?: object;
  externalAccountIdentifiers?: { obfuscatedExternalAccountId?: string };
  lineItems?: { productId: string; expiryTime?: string }[];
}

/** Thin Play Developer API client (androidpublisher v3). */
export class GooglePlayApi {
  constructor(private readonly packageName: string, private readonly auth: { accessToken(): Promise<string> }, private readonly f: Fetch = defaultFetch) {}

  private base() {
    return `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(this.packageName)}/purchases`;
  }
  private async call<T>(method: 'GET' | 'POST', url: string): Promise<T> {
    const res = await this.f(url, { method, headers: { authorization: `Bearer ${await this.auth.accessToken()}`, ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) }, ...(method === 'POST' ? { body: '{}' } : {}) });
    if (res.status === 400 || res.status === 404 || res.status === 410) throw new AppError('RECEIPT_INVALID', `google: ${res.status}`);
    if (!res.ok) throw new AppError('RECEIPT_INVALID', `google: api ${res.status}`, 502);
    const text = await res.text();
    return (text ? JSON.parse(text) : {}) as T;
  }
  getProduct(productId: string, token: string) {
    return this.call<ProductPurchase>('GET', `${this.base()}/products/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(token)}`);
  }
  consumeProduct(productId: string, token: string) {
    return this.call<unknown>('POST', `${this.base()}/products/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(token)}:consume`);
  }
  acknowledgeProduct(productId: string, token: string) {
    return this.call<unknown>('POST', `${this.base()}/products/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(token)}:acknowledge`);
  }
  getSubscription(token: string) {
    return this.call<SubscriptionPurchaseV2>('GET', `${this.base()}/subscriptionsv2/tokens/${encodeURIComponent(token)}`);
  }
  acknowledgeSubscription(subscriptionId: string, token: string) {
    return this.call<unknown>('POST', `${this.base()}/subscriptions/${encodeURIComponent(subscriptionId)}/tokens/${encodeURIComponent(token)}:acknowledge`);
  }
}

export interface GoogleConfig {
  packageName: string;
  api: GooglePlayApi;
  /** Accept license-testing purchases (granted with priceYen 0). */
  acceptTest: boolean;
  subscriptionProductIds: ReadonlySet<string>;
  priceYen(productId: string): number;
  now?: () => number;
}

async function tokenHash(token: string) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)));
  return Array.from(d.slice(0, 12), (x) => x.toString(16).padStart(2, '0')).join('');
}

const ACTIVE_SUB = new Set(['SUBSCRIPTION_STATE_ACTIVE', 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD']);

/** Subscription (v2) → receipt for its latest paid period. */
export function googleSubToReceipt(sub: SubscriptionPurchaseV2, token: string, productId: string, cfg: Pick<GoogleConfig, 'priceYen'>, now: number): VerifiedReceipt {
  const line = sub.lineItems?.find((l) => l.productId === productId);
  if (!line) throw new AppError('RECEIPT_INVALID', 'google: productId mismatch');
  if (!sub.latestOrderId) throw new AppError('RECEIPT_INVALID', 'google: no order id');
  const sandbox = sub.testPurchase !== undefined;
  const expiresAt = line.expiryTime ? Date.parse(line.expiryTime) : undefined;
  return {
    transactionId: `google:${sub.latestOrderId}`,
    productId,
    purchasedAt: now,
    priceYen: sandbox ? 0 : cfg.priceYen(productId),
    sandbox,
    originalTransactionId: `google:sub:${token}`,
    expiresAt,
    storeRef: { token, kind: 'subscription', needsAck: sub.acknowledgementState === 'ACKNOWLEDGEMENT_STATE_PENDING' },
  };
}

export class GoogleStoreVerifier implements StoreVerifier {
  readonly platform = 'google' as const;
  constructor(private readonly cfg: GoogleConfig) {}

  private parse(receipt: string): string {
    try {
      const j = JSON.parse(receipt) as { purchaseToken?: unknown };
      if (typeof j.purchaseToken === 'string' && j.purchaseToken.length > 0 && j.purchaseToken.length < 4096) return j.purchaseToken;
    } catch { /* fall through */ }
    throw new AppError('RECEIPT_INVALID', 'google: receipt must be {"purchaseToken": "..."}');
  }

  async verify(receipt: string, expectedProductId: string, ctx?: { playerId: string }): Promise<VerifiedReceipt> {
    const token = this.parse(receipt);
    const now = (this.cfg.now ?? Date.now)();
    const expectAccount = ctx ? await googleAccountId(ctx.playerId) : null;

    if (this.cfg.subscriptionProductIds.has(expectedProductId)) {
      const sub = await this.cfg.api.getSubscription(token);
      if (!sub.subscriptionState || !ACTIVE_SUB.has(sub.subscriptionState)) throw new AppError('RECEIPT_INVALID', `google: subscription ${sub.subscriptionState ?? 'unknown'}`);
      if (sub.testPurchase !== undefined && !this.cfg.acceptTest) throw new AppError('RECEIPT_INVALID', 'google: test purchases are not accepted');
      const acct = sub.externalAccountIdentifiers?.obfuscatedExternalAccountId;
      if (expectAccount && acct && acct !== expectAccount) throw new AppError('RECEIPT_INVALID', 'google: purchase belongs to another player');
      return googleSubToReceipt(sub, token, expectedProductId, this.cfg, now);
    }

    const p = await this.cfg.api.getProduct(expectedProductId, token);
    if (p.purchaseState !== 0) throw new AppError('RECEIPT_INVALID', `google: purchaseState ${p.purchaseState ?? 'unknown'}`);
    if (p.productId !== undefined && p.productId !== expectedProductId) throw new AppError('RECEIPT_INVALID', 'google: productId mismatch');
    const sandbox = p.purchaseType === 0;
    if (sandbox && !this.cfg.acceptTest) throw new AppError('RECEIPT_INVALID', 'google: test purchases are not accepted');
    if (expectAccount && p.obfuscatedExternalAccountId && p.obfuscatedExternalAccountId !== expectAccount) throw new AppError('RECEIPT_INVALID', 'google: purchase belongs to another player');
    return {
      transactionId: `google:${p.orderId ?? `token-${await tokenHash(token)}`}`,
      productId: expectedProductId,
      purchasedAt: p.purchaseTimeMillis ? Number(p.purchaseTimeMillis) : now,
      priceYen: sandbox ? 0 : this.cfg.priceYen(expectedProductId),
      sandbox,
      storeRef: { token, kind: 'product', needsAck: p.consumptionState !== 1 },
    };
  }

  /** After the grant is saved: consume coins so they can be bought again; acknowledge subscriptions (else Google refunds in 3 days). */
  async finalize(r: VerifiedReceipt): Promise<void> {
    const ref = r.storeRef;
    if (!ref || !ref.needsAck) return;
    if (ref.kind === 'subscription') await this.cfg.api.acknowledgeSubscription(r.productId, ref.token);
    else await this.cfg.api.consumeProduct(r.productId, ref.token);
  }
}

// ---------------------------------------------------------------- RTDN (Pub/Sub push)

export interface RtdnConfig {
  packageName: string;
  /** Audience configured on the Pub/Sub push subscription. */
  audience: string;
  /** Service account the push subscription authenticates as. */
  serviceAccountEmail: string;
  jwks?: JWTVerifyGetKey;
  api: GooglePlayApi;
  subscriptionProductIds: ReadonlySet<string>;
  priceYen(productId: string): number;
  acceptTest: boolean;
  now?: () => number;
}

let googleJwks: JWTVerifyGetKey | null = null;
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

/** Verify the Pub/Sub OIDC bearer token. Throws UNAUTHORIZED. */
export async function verifyPubSubToken(authorization: string | null, cfg: Pick<RtdnConfig, 'audience' | 'serviceAccountEmail' | 'jwks'>) {
  const m = /^Bearer (.+)$/.exec(authorization ?? '');
  if (!m) throw new AppError('UNAUTHORIZED', 'pubsub: missing bearer token');
  const jwks = cfg.jwks ?? (googleJwks ??= createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs')));
  try {
    const { payload } = await jwtVerify(m[1]!, jwks, { issuer: GOOGLE_ISSUERS, audience: cfg.audience });
    if (payload.email !== cfg.serviceAccountEmail || payload.email_verified !== true) throw new Error('unexpected service account');
  } catch (e) {
    throw new AppError('UNAUTHORIZED', `pubsub: ${(e as Error).message}`);
  }
}

interface DeveloperNotification {
  version?: string;
  packageName?: string;
  oneTimeProductNotification?: { notificationType: number; purchaseToken: string; sku: string };
  subscriptionNotification?: { notificationType: number; purchaseToken: string; subscriptionId: string };
  voidedPurchaseNotification?: { purchaseToken: string; orderId: string; productType: number; refundType?: number };
  testNotification?: unknown;
}

const SUB_STATUS: Record<number, SubscriptionStatus | 'renew'> = {
  1: 'renew', // RECOVERED
  2: 'renew', // RENEWED
  3: 'canceled', // CANCELED (auto-renew off; entitled until expiry)
  4: 'renew', // PURCHASED
  5: 'paused', // ON_HOLD
  6: 'grace', // IN_GRACE_PERIOD
  7: 'renew', // RESTARTED
  10: 'paused', // PAUSED
  12: 'revoked', // REVOKED
  13: 'expired', // EXPIRED
};

/** Authenticate and interpret a Pub/Sub push request carrying a Play developer notification. */
export async function parseGoogleRtdn(req: Request, cfg: RtdnConfig): Promise<StoreEvent> {
  await verifyPubSubToken(req.headers.get('authorization'), cfg);
  let n: DeveloperNotification;
  try {
    const push = (await req.json()) as { message?: { data?: string } };
    n = JSON.parse(atob(push.message?.data ?? '')) as DeveloperNotification;
  } catch {
    throw new AppError('BAD_REQUEST', 'pubsub: bad message');
  }
  if (n.packageName !== cfg.packageName) throw new AppError('BAD_REQUEST', 'pubsub: packageName mismatch');
  if (n.testNotification) return { kind: 'ignored', reason: 'test' };

  if (n.voidedPurchaseNotification) {
    const v = n.voidedPurchaseNotification;
    const txKey = `google:${v.orderId}`;
    return { kind: 'refund', transactionId: txKey, lookupKeys: [txKey, `google:sub:${v.purchaseToken}`] };
  }
  if (n.subscriptionNotification) {
    const s = n.subscriptionNotification;
    const status = SUB_STATUS[s.notificationType];
    const subKey = `google:sub:${s.purchaseToken}`;
    if (!status) return { kind: 'ignored', reason: `subscription type ${s.notificationType}` };
    const sub = await cfg.api.getSubscription(s.purchaseToken);
    const keys = [subKey, ...(sub.linkedPurchaseToken ? [`google:sub:${sub.linkedPurchaseToken}`] : [])];
    const line = sub.lineItems?.find((l) => l.productId === s.subscriptionId);
    const expiresAt = line?.expiryTime ? Date.parse(line.expiryTime) : null;
    if (status === 'renew') {
      if (!sub.subscriptionState || !ACTIVE_SUB.has(sub.subscriptionState)) return { kind: 'subscription', key: subKey, status: 'billing_retry', expiresAt, lookupKeys: keys };
      if (sub.testPurchase !== undefined && !cfg.acceptTest) return { kind: 'ignored', reason: 'test purchase' };
      const receipt = googleSubToReceipt(sub, s.purchaseToken, s.subscriptionId, cfg, (cfg.now ?? Date.now)());
      return { kind: 'renewal', receipt, lookupKeys: keys };
    }
    return { kind: 'subscription', key: subKey, status, expiresAt, lookupKeys: keys };
  }
  if (n.oneTimeProductNotification) return { kind: 'ignored', reason: 'one-time purchases are granted by the app flow' };
  return { kind: 'ignored', reason: 'unknown notification' };
}
