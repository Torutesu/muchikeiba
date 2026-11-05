import { beforeAll, describe, expect, it } from 'vitest';
import { createLocalJWKSet, exportJWK, exportPKCS8, generateKeyPair, jwtVerify, SignJWT, type JWTVerifyGetKey } from 'jose';
import { GooglePlayApi, GoogleServiceAuth, GoogleStoreVerifier, parseGoogleRtdn, type GoogleConfig, type ProductPurchase, type RtdnConfig, type SubscriptionPurchaseV2 } from '../src/stores/google.js';
import { googleAccountId, MemoryStoreTxIndex } from '../src/stores/binding.js';
import { resolveStoreEvent } from '../src/http/stores.js';
import { MemoryPlayerRepo, PlayerService } from '../src/domain/service.js';
import { seededRng } from '../src/domain/rng.js';
import { m } from './helpers.js';

const NOW = Date.UTC(2026, 10, 5, 3);
const PKG = 'jp.example.muchi';

/** Fake Play Developer API: responses keyed by "METHOD path-suffix". Records calls. */
class FakePlay {
  calls: string[] = [];
  products = new Map<string, ProductPurchase>();
  subs = new Map<string, SubscriptionPurchaseV2>();
  status: number | null = null;
  fetch: typeof fetch = async (u, init) => {
    const url = String(u);
    const method = init?.method ?? 'GET';
    this.calls.push(`${method} ${url.replace(`https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${PKG}/purchases`, '')}`);
    if (this.status) return new Response('{}', { status: this.status });
    const prod = /\/products\/([^/]+)\/tokens\/([^/:]+)$/.exec(url);
    if (prod && method === 'GET') {
      const p = this.products.get(decodeURIComponent(prod[2]!));
      return p ? Response.json(p) : new Response('{}', { status: 404 });
    }
    const sub = /\/subscriptionsv2\/tokens\/([^/:]+)$/.exec(url);
    if (sub) {
      const s = this.subs.get(decodeURIComponent(sub[1]!));
      return s ? Response.json(s) : new Response('{}', { status: 404 });
    }
    if (method === 'POST') return new Response('', { status: 200 });
    return new Response('{}', { status: 404 });
  };
}

const staticAuth = { accessToken: async () => 'tok' };
const subIds = new Set(['season_pass']);
const priceYen = (id: string) => m.products.find((p) => p.id === id)!.priceYen;

function cfgFor(play: FakePlay, over: Partial<GoogleConfig> = {}): GoogleConfig {
  return { packageName: PKG, api: new GooglePlayApi(PKG, staticAuth, play.fetch), acceptTest: true, subscriptionProductIds: subIds, priceYen, now: () => NOW, ...over };
}

describe('Google service-account auth', () => {
  it('signs an RS256 assertion, exchanges it for an access token and caches it', async () => {
    const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
    const sa = { client_email: 'svc@proj.iam.gserviceaccount.com', private_key: await exportPKCS8(privateKey) };
    let now = NOW;
    const seen: string[] = [];
    const auth = new GoogleServiceAuth(sa, async (_u, init) => {
      const assertion = new URLSearchParams(String(init?.body)).get('assertion')!;
      seen.push(assertion);
      const { payload } = await jwtVerify(assertion, publicKey, { issuer: sa.client_email, audience: 'https://oauth2.googleapis.com/token', currentDate: new Date(now) });
      expect(payload.scope).toBe('https://www.googleapis.com/auth/androidpublisher');
      return Response.json({ access_token: `at${seen.length}`, expires_in: 3600 });
    }, () => now);
    expect(await auth.accessToken()).toBe('at1');
    expect(await auth.accessToken()).toBe('at1');
    expect(seen).toHaveLength(1);
    now += 3600_000;
    expect(await auth.accessToken()).toBe('at2');
    const bad = new GoogleServiceAuth(sa, async () => new Response('', { status: 401 }), () => NOW);
    await expect(bad.accessToken()).rejects.toMatchObject({ code: 'RECEIPT_INVALID' });
  });
});

describe('Google purchase verification', () => {
  let acct: string;
  beforeAll(async () => { acct = await googleAccountId('p1'); });

  it('accepts a purchased consumable, binds the account, and consumes it on finalize', async () => {
    const play = new FakePlay();
    play.products.set('T1', { purchaseState: 0, consumptionState: 0, orderId: 'GPA.1', purchaseTimeMillis: String(NOW - 5), purchaseType: undefined, obfuscatedExternalAccountId: acct });
    const v = new GoogleStoreVerifier(cfgFor(play));
    const r = await v.verify(JSON.stringify({ purchaseToken: 'T1' }), 'coin_1500', { playerId: 'p1' });
    expect(r).toMatchObject({ transactionId: 'google:GPA.1', priceYen: 1500, sandbox: false, purchasedAt: NOW - 5 });
    await v.finalize(r);
    expect(play.calls).toContain('POST /products/coin_1500/tokens/T1:consume');
    await expect(v.verify(JSON.stringify({ purchaseToken: 'T1' }), 'coin_1500', { playerId: 'p2' })).rejects.toThrow(/another player/);
  });

  it('rejects pending/cancelled, unknown tokens, bad receipts and (optionally) test purchases', async () => {
    const play = new FakePlay();
    play.products.set('P', { purchaseState: 2, orderId: 'GPA.2' });
    play.products.set('C', { purchaseState: 1, orderId: 'GPA.3' });
    play.products.set('TEST', { purchaseState: 0, orderId: 'GPA.4', purchaseType: 0 });
    const v = new GoogleStoreVerifier(cfgFor(play));
    const rcpt = (t: string) => JSON.stringify({ purchaseToken: t });
    await expect(v.verify(rcpt('P'), 'coin_160')).rejects.toThrow(/purchaseState 2/);
    await expect(v.verify(rcpt('C'), 'coin_160')).rejects.toThrow(/purchaseState 1/);
    await expect(v.verify(rcpt('none'), 'coin_160')).rejects.toMatchObject({ code: 'RECEIPT_INVALID' });
    await expect(v.verify('garbage', 'coin_160')).rejects.toThrow(/purchaseToken/);
    expect(await v.verify(rcpt('TEST'), 'coin_160')).toMatchObject({ sandbox: true, priceYen: 0 });
    await expect(new GoogleStoreVerifier(cfgFor(play, { acceptTest: false })).verify(rcpt('TEST'), 'coin_160')).rejects.toThrow(/test purchases/);
    play.status = 503;
    await expect(v.verify(rcpt('P'), 'coin_160')).rejects.toMatchObject({ code: 'RECEIPT_INVALID', status: 502 });
  });

  it('verifies active subscriptions with the store expiry and acknowledges them', async () => {
    const play = new FakePlay();
    const exp = new Date(NOW + 30 * 86400_000).toISOString();
    play.subs.set('S1', { subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE', latestOrderId: 'GPA.9', acknowledgementState: 'ACKNOWLEDGEMENT_STATE_PENDING', lineItems: [{ productId: 'season_pass', expiryTime: exp }] });
    play.subs.set('S2', { subscriptionState: 'SUBSCRIPTION_STATE_EXPIRED', latestOrderId: 'GPA.8', lineItems: [{ productId: 'season_pass' }] });
    const v = new GoogleStoreVerifier(cfgFor(play));
    const r = await v.verify(JSON.stringify({ purchaseToken: 'S1' }), 'season_pass');
    expect(r).toMatchObject({ transactionId: 'google:GPA.9', originalTransactionId: 'google:sub:S1', expiresAt: Date.parse(exp), priceYen: 1000 });
    await v.finalize(r);
    expect(play.calls).toContain('POST /subscriptions/season_pass/tokens/S1:acknowledge');
    await expect(v.verify(JSON.stringify({ purchaseToken: 'S2' }), 'season_pass')).rejects.toThrow(/SUBSCRIPTION_STATE_EXPIRED/);
  });

  it('through PlayerService: grants once, consumes, and refuses the token on another account', async () => {
    const play = new FakePlay();
    play.products.set('T1', { purchaseState: 0, orderId: 'GPA.1', consumptionState: 0 });
    const index = new MemoryStoreTxIndex();
    const svc = new PlayerService(new MemoryPlayerRepo(), { master: m, rng: seededRng(1), clock: () => NOW, verifiers: { google: new GoogleStoreVerifier(cfgFor(play)) }, storeIndex: index });
    await svc.setAge('p1', 1990, 1, false);
    await svc.setAge('p2', 1990, 1, false);
    const rcpt = JSON.stringify({ purchaseToken: 'T1' });
    expect((await svc.purchase('p1', 'google', 'coin_1500', rcpt)).wallet.paid).toBe(1020);
    expect((await svc.purchase('p1', 'google', 'coin_1500', rcpt)).wallet.paid).toBe(1020);
    expect(play.calls.filter((c) => c.endsWith(':consume'))).toHaveLength(2); // retried consume is harmless
    await expect(svc.purchase('p2', 'google', 'coin_1500', rcpt)).rejects.toThrow(/another player/);
    expect(await index.lookup('google:GPA.1')).toBe('p1');
  });

  it('a failed consume does not lose the grant', async () => {
    const play = new FakePlay();
    play.products.set('T1', { purchaseState: 0, orderId: 'GPA.1', consumptionState: 0 });
    const api = new GooglePlayApi(PKG, staticAuth, play.fetch);
    api.consumeProduct = async () => { throw new Error('network'); };
    const svc = new PlayerService(new MemoryPlayerRepo(), { master: m, rng: seededRng(1), clock: () => NOW, verifiers: { google: new GoogleStoreVerifier({ ...cfgFor(play), api }) } });
    await svc.setAge('p1', 1990, 1, false);
    expect((await svc.purchase('p1', 'google', 'coin_1500', JSON.stringify({ purchaseToken: 'T1' }))).wallet.paid).toBe(1020);
  });
});

describe('RTDN (Pub/Sub push)', () => {
  const AUD = 'https://api.example.com/v1/store/notifications/google';
  const SA = 'pubsub-push@proj.iam.gserviceaccount.com';
  let jwks: JWTVerifyGetKey;
  let signer: CryptoKey;
  beforeAll(async () => {
    const kp = await generateKeyPair('RS256', { extractable: true });
    signer = kp.privateKey as CryptoKey;
    jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(kp.publicKey)), kid: 'k1', alg: 'RS256' }] });
  });
  const oidc = (claims: Record<string, unknown> = {}, aud = AUD) =>
    new SignJWT({ email: SA, email_verified: true, ...claims }).setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer('https://accounts.google.com').setAudience(aud).setIssuedAt().setExpirationTime('5m').sign(signer);
  const push = async (n: unknown, token?: string) => new Request('https://x/v1/store/notifications/google', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token !== undefined ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ message: { data: btoa(JSON.stringify(n)), messageId: '1' }, subscription: 'projects/p/subscriptions/s' }),
  });
  const rtdn = (play: FakePlay): RtdnConfig => ({ ...cfgFor(play), audience: AUD, serviceAccountEmail: SA, jwks });

  it('rejects missing, wrong-audience, wrong-account and forged tokens', async () => {
    const play = new FakePlay();
    const n = { packageName: PKG, testNotification: { version: '1.0' } };
    await expect(parseGoogleRtdn(await push(n), rtdn(play))).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(parseGoogleRtdn(await push(n, await oidc({}, 'https://other')), rtdn(play))).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(parseGoogleRtdn(await push(n, await oidc({ email: 'evil@x.com' })), rtdn(play))).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    const other = await generateKeyPair('RS256');
    const forged = await new SignJWT({ email: SA, email_verified: true }).setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setIssuer('https://accounts.google.com').setAudience(AUD).setIssuedAt().setExpirationTime('5m').sign(other.privateKey);
    await expect(parseGoogleRtdn(await push(n, forged), rtdn(play))).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(await parseGoogleRtdn(await push(n, await oidc()), rtdn(play))).toMatchObject({ kind: 'ignored', reason: 'test' });
    await expect(parseGoogleRtdn(await push({ packageName: 'com.other', testNotification: {} }, await oidc()), rtdn(play))).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('voided purchase → refund of the right player; renewals and expiry update the season pass', async () => {
    const play = new FakePlay();
    const index = new MemoryStoreTxIndex();
    const svc = new PlayerService(new MemoryPlayerRepo(), { master: m, rng: seededRng(1), clock: () => NOW, verifiers: { google: new GoogleStoreVerifier(cfgFor(play)) }, storeIndex: index });
    await svc.setAge('p1', 1990, 1, false);

    play.products.set('T1', { purchaseState: 0, orderId: 'GPA.1', consumptionState: 0 });
    await svc.purchase('p1', 'google', 'coin_1500', JSON.stringify({ purchaseToken: 'T1' }));
    const voided = await resolveStoreEvent('google', await parseGoogleRtdn(await push({ packageName: PKG, voidedPurchaseNotification: { purchaseToken: 'T1', orderId: 'GPA.1', productType: 2 } }, await oidc()), rtdn(play)), index);
    expect(voided).toEqual({ kind: 'refund', playerId: 'p1', transactionId: 'google:GPA.1' });
    await svc.refund('p1', 'google:GPA.1');
    expect((await svc.view('p1')).wallet).toMatchObject({ paid: 0, free: 0 });

    const exp1 = new Date(NOW + 30 * 86400_000).toISOString();
    play.subs.set('S1', { subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE', latestOrderId: 'GPA.20', acknowledgementState: 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED', lineItems: [{ productId: 'season_pass', expiryTime: exp1 }] });
    await svc.purchase('p1', 'google', 'season_pass', JSON.stringify({ purchaseToken: 'S1' }));
    const exp2 = new Date(NOW + 60 * 86400_000).toISOString();
    play.subs.set('S1', { subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE', latestOrderId: 'GPA.20..0', lineItems: [{ productId: 'season_pass', expiryTime: exp2 }] });
    const renewed = await resolveStoreEvent('google', await parseGoogleRtdn(await push({ packageName: PKG, subscriptionNotification: { notificationType: 2, purchaseToken: 'S1', subscriptionId: 'season_pass' } }, await oidc()), rtdn(play)), index);
    expect(renewed).toMatchObject({ kind: 'renewal', playerId: 'p1', receipt: { transactionId: 'google:GPA.20..0', expiresAt: Date.parse(exp2) } });
    if (renewed.kind !== 'renewal') throw new Error();
    expect((await svc.storeRenewal('p1', 'google', renewed.receipt)).passExpiresAt).toBe(Date.parse(exp2));

    play.subs.set('S1', { subscriptionState: 'SUBSCRIPTION_STATE_EXPIRED', latestOrderId: 'GPA.20..0', lineItems: [{ productId: 'season_pass', expiryTime: exp1 }] });
    const expired = await resolveStoreEvent('google', await parseGoogleRtdn(await push({ packageName: PKG, subscriptionNotification: { notificationType: 13, purchaseToken: 'S1', subscriptionId: 'season_pass' } }, await oidc()), rtdn(play)), index);
    expect(expired).toMatchObject({ kind: 'subscription', playerId: 'p1', status: 'expired', expiresAt: Date.parse(exp1) });
    if (expired.kind !== 'subscription') throw new Error();
    expect((await svc.subscriptionStatus('p1', 'google', expired.key, expired.status, expired.expiresAt)).passExpiresAt).toBe(Date.parse(exp1));

    // a token nobody reported yet is acknowledged and ignored
    play.subs.set('S9', { subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE', latestOrderId: 'GPA.99', lineItems: [{ productId: 'season_pass', expiryTime: exp1 }] });
    const unknown = await resolveStoreEvent('google', await parseGoogleRtdn(await push({ packageName: PKG, subscriptionNotification: { notificationType: 4, purchaseToken: 'S9', subscriptionId: 'season_pass' } }, await oidc()), rtdn(play)), index);
    expect(unknown.kind).toBe('ignored');
    // one-time purchase notifications are granted by the app flow
    expect(await parseGoogleRtdn(await push({ packageName: PKG, oneTimeProductNotification: { notificationType: 1, purchaseToken: 'T2', sku: 'coin_160' } }, await oidc()), rtdn(play))).toMatchObject({ kind: 'ignored' });
  });
});
