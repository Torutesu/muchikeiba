/**
 * Ties a store purchase to the player who made it, so a receipt cannot be redeemed by someone else.
 * The app passes these values to the store when it starts a purchase:
 * - iOS: `Product.PurchaseOption.appAccountToken(UUID)` ← appleAccountToken(playerId)
 * - Android: `BillingFlowParams.setObfuscatedAccountId(...)` ← googleAccountId(playerId)
 * Both are returned by GET /v1/shop/store-account, so the client never computes them itself.
 */
async function digest(playerId: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`muchi-store:${playerId}`)));
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

/** Name-based UUID (version 5 layout over SHA-256) for StoreKit's appAccountToken. Lower-case. */
export async function appleAccountToken(playerId: string): Promise<string> {
  const b = (await digest(playerId)).slice(0, 16);
  b[6] = (b[6]! & 0x0f) | 0x50;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = hex(b);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** 64 hex chars (Google's limit for obfuscatedAccountId is 64). Contains no personal data. */
export async function googleAccountId(playerId: string): Promise<string> {
  return hex(await digest(playerId));
}

/** Global "which player owns this store transaction / subscription" index (REQ-WAL-004 across players). */
export interface StoreTxIndex {
  /** First caller wins; returns the owner after the call. */
  claim(key: string, playerId: string): Promise<string>;
  lookup(key: string): Promise<string | null>;
}

export class MemoryStoreTxIndex implements StoreTxIndex {
  readonly owners = new Map<string, string>();
  async claim(key: string, playerId: string) {
    if (!this.owners.has(key)) this.owners.set(key, playerId);
    return this.owners.get(key)!;
  }
  async lookup(key: string) {
    return this.owners.get(key) ?? null;
  }
}
