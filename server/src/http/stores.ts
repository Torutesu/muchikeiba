import { AppError } from '../domain/errors.js';
import { FakeStoreVerifier, type StoreVerifier, type VerifiedReceipt } from '../domain/purchase.js';
import type { StoreNotification } from './app.js';

/**
 * Production store adapters. Wiring the real APIs needs credentials that do not exist yet:
 * - Apple: App Store Server API (GET /inApps/v1/transactions/{id}) with an ES256 JWT, then verify the
 *   signedTransactionInfo JWS chain against Apple Root CA G3.
 * - Google: Play Developer API purchases.products.get with a service account.
 * Until then they reject every receipt (safe default: nothing is granted).
 */
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

export function makeVerifiers(devMode: boolean): Partial<Record<'apple' | 'google' | 'fake', StoreVerifier>> {
  return { apple: new NotConfiguredStoreVerifier('apple'), google: new NotConfiguredStoreVerifier('google'), ...(devMode ? { fake: new DevFakeStore() } : {}) };
}

/** Refund notifications. Apple/Google server notifications need signature verification (TODO with credentials). */
export async function parseStoreNotification(platform: string, req: Request, devMode: boolean): Promise<StoreNotification | null> {
  if (platform === 'fake' && devMode) {
    const b = (await req.json()) as { playerId?: string; transactionId?: string };
    return b.playerId && b.transactionId ? { playerId: b.playerId, transactionId: b.transactionId, kind: 'refund' } : null;
  }
  return null;
}
