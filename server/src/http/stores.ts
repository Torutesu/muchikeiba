import { AppError } from '../domain/errors.js';
import type { Master } from '../domain/master.js';
import { FakeStoreVerifier, type StoreVerifier, type VerifiedReceipt } from '../domain/purchase.js';
import type { Env } from '../env.js';
import { AppleStoreVerifier, parseAppleNotification, type AppleConfig, type StoreEvent } from '../stores/apple.js';
import { REVOKED_OWNER, type StoreTxIndex } from '../stores/binding.js';
import { GooglePlayApi, GoogleServiceAuth, GoogleStoreVerifier, parseGoogleRtdn, type RtdnConfig, type ServiceAccount } from '../stores/google.js';
import type { StoreNotification } from './app.js';

/** Store that is not configured in this deployment: rejects every receipt (nothing is granted). */
export class NotConfiguredStoreVerifier implements StoreVerifier {
  constructor(readonly platform: 'apple' | 'google') {}
  async verify(): Promise<VerifiedReceipt> {
    throw new AppError('RECEIPT_INVALID', `${this.platform} store verification is not configured`);
  }
}

/** Dev-only fake store: a receipt is a JSON VerifiedReceipt (lets Codex/Unity test purchases locally). */
export class DevFakeStore extends FakeStoreVerifier {
  override async verify(receipt: string, expectedProductId: string): Promise<VerifiedReceipt> {
    try {
      const r = JSON.parse(receipt) as VerifiedReceipt;
      if (r.productId !== expectedProductId || !r.transactionId) throw new Error();
      return r;
    } catch {
      return super.verify(receipt, expectedProductId);
    }
  }
}

/** Store settings resolved from the Worker environment. Missing settings ⇒ that store is "not configured". */
export interface StoreSettings {
  devMode: boolean;
  apple: AppleConfig | null;
  google: (Omit<RtdnConfig, 'audience' | 'serviceAccountEmail'> & { rtdn: { audience: string; serviceAccountEmail: string } | null }) | null;
}

export function storeSettingsFromEnv(env: Env, master: Master): StoreSettings {
  // REQ-UXS-018..020: every product is a one-time store product except those registered as auto-renewing
  // subscriptions (none since the per-season pass). Once-only bundles are non-consumable (acknowledged on Google).
  const subscriptionProductIds = new Set(master.products.filter((p) => p.storeType === 'auto_renewing').map((p) => p.id));
  const nonConsumableProductIds = new Set(master.products.filter((p) => p.storeType === 'non_consumable').map((p) => p.id));
  const priceYen = (id: string) => master.products.find((p) => p.id === id)?.priceYen ?? 0;
  const apple: AppleConfig | null = env.APPLE_BUNDLE_ID
    // Sandbox is opt-in (review r5 #7). Accepted sandbox purchases only ever credit free coins.
    ? { bundleId: env.APPLE_BUNDLE_ID, acceptSandbox: env.APPLE_ACCEPT_SANDBOX === '1', subscriptionProductIds, priceYen }
    : null;
  let google: StoreSettings['google'] = null;
  if (env.GOOGLE_PACKAGE_NAME && env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    let sa: ServiceAccount;
    try {
      sa = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON) as ServiceAccount;
    } catch {
      throw new AppError('CONFIG_INVALID', 'GOOGLE_SERVICE_ACCOUNT_JSON is not JSON');
    }
    const api = new GooglePlayApi(env.GOOGLE_PACKAGE_NAME, new GoogleServiceAuth(sa));
    google = {
      packageName: env.GOOGLE_PACKAGE_NAME, api, subscriptionProductIds, nonConsumableProductIds, priceYen,
      acceptTest: env.GOOGLE_ACCEPT_TEST !== '0',
      rtdn: env.GOOGLE_PUBSUB_AUDIENCE && env.GOOGLE_PUBSUB_SERVICE_ACCOUNT ? { audience: env.GOOGLE_PUBSUB_AUDIENCE, serviceAccountEmail: env.GOOGLE_PUBSUB_SERVICE_ACCOUNT } : null,
    };
  }
  return { devMode: env.DEV_MODE === '1', apple, google };
}

export function makeVerifiers(st: StoreSettings): Partial<Record<'apple' | 'google' | 'fake', StoreVerifier>> {
  return {
    apple: st.apple ? new AppleStoreVerifier(st.apple) : new NotConfiguredStoreVerifier('apple'),
    google: st.google ? new GoogleStoreVerifier(st.google) : new NotConfiguredStoreVerifier('google'),
    ...(st.devMode ? { fake: new DevFakeStore() } : {}),
  };
}

/**
 * Store server notifications (REQ-PUR-006): verify, interpret, and find the owning player through the
 * global transaction index. Unknown purchases are acknowledged and ignored (the app flow grants them).
 */
export async function parseStoreNotification(platform: string, req: Request, st: StoreSettings, index: Pick<StoreTxIndex, 'lookup' | 'claim'>): Promise<StoreNotification | null> {
  if (platform === 'fake' && st.devMode) {
    const b = (await req.json()) as { playerId?: string; transactionId?: string };
    return b.playerId && b.transactionId ? { kind: 'refund', playerId: b.playerId, transactionId: b.transactionId } : null;
  }
  let ev: StoreEvent;
  if (platform === 'apple') {
    if (!st.apple) throw new AppError('NOT_FOUND', 'apple notifications are not configured');
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      throw new AppError('BAD_REQUEST', 'invalid JSON');
    }
    ev = await parseAppleNotification(body, st.apple);
  } else if (platform === 'google') {
    if (!st.google?.rtdn) throw new AppError('NOT_FOUND', 'google notifications are not configured');
    ev = await parseGoogleRtdn(req, { ...st.google, ...st.google.rtdn });
  } else {
    return null;
  }
  return resolveStoreEvent(platform, ev, index);
}

export async function resolveStoreEvent(platform: 'apple' | 'google', ev: StoreEvent, index: Pick<StoreTxIndex, 'lookup' | 'claim'>): Promise<StoreNotification> {
  if (ev.kind === 'ignored') return ev;
  let playerId: string | null = null;
  for (const k of ev.lookupKeys) {
    playerId = await index.lookup(k);
    if (playerId) break;
  }
  if (!playerId) {
    if (ev.kind === 'refund') {
      // Refunded before the app reported it: claim the keys for a tombstone owner so the saved (still
      // validly signed) receipt can never be credited later (review r5 #3).
      for (const k of ev.lookupKeys) await index.claim(k, REVOKED_OWNER);
      return { kind: 'ignored', reason: 'refund for an unreported purchase: receipt revoked' };
    }
    return { kind: 'ignored', reason: 'unknown purchase (not yet reported by the app)' };
  }
  if (playerId === REVOKED_OWNER) return { kind: 'ignored', reason: 'purchase already revoked' };
  switch (ev.kind) {
    case 'refund': return { kind: 'refund', playerId, transactionId: ev.transactionId };
    case 'renewal': return { kind: 'renewal', playerId, platform, receipt: ev.receipt };
    case 'subscription': return { kind: 'subscription', playerId, platform, key: ev.key, status: ev.status, expiresAt: ev.expiresAt };
  }
}
