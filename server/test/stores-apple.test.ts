import { beforeAll, describe, expect, it } from 'vitest';
import { exportPKCS8, generateKeyPair, jwtVerify, decodeProtectedHeader } from 'jose';
import { AppleStoreVerifier, AppStoreServerApi, APPLE_ROOT_CA_G3_PEM, parseAppleNotification, verifyAppleJws, type AppleConfig, type AppleTransaction } from '../src/stores/apple.js';
import { appleAccountToken, MemoryStoreTxIndex } from '../src/stores/binding.js';
import { parseCertificate, pemToDer, verifyIssuedBy } from '../src/stores/x509.js';
import { resolveStoreEvent } from '../src/http/stores.js';
import { handle, type AppContext, type PlayerInvoker } from '../src/http/app.js';
import { MemoryPlayerRepo, PlayerService } from '../src/domain/service.js';
import { seededRng } from '../src/domain/rng.js';
import { AppError } from '../src/domain/errors.js';
import { issueCert, makeApplePki, signAppleJws, type ApplePki } from './pki.js';
import { m } from './helpers.js';

const NOW = Date.UTC(2026, 10, 5, 3);
const BUNDLE = 'jp.example.muchi';
let pki: ApplePki;
let cfg: AppleConfig;

beforeAll(async () => {
  pki = await makeApplePki();
  cfg = {
    bundleId: BUNDLE, roots: [pki.root.der], acceptSandbox: true, now: () => NOW,
    subscriptionProductIds: new Set(['season_pass']),
    priceYen: (id) => m.products.find((p) => p.id === id)!.priceYen,
  };
});

const tx = (o: Partial<AppleTransaction> = {}): AppleTransaction => ({
  transactionId: '2000000123', originalTransactionId: '2000000123', bundleId: BUNDLE, productId: 'coin_1500',
  purchaseDate: NOW - 1000, environment: 'Production', type: 'Consumable', price: 1_500_000, currency: 'JPY', signedDate: NOW, ...o,
});

describe('X.509 parsing', () => {
  it('parses the real Apple Root CA - G3 and verifies its self-signature', async () => {
    const root = parseCertificate(pemToDer(APPLE_ROOT_CA_G3_PEM));
    expect(root.curve).toBe('P-384');
    expect(root.isCa).toBe(true);
    expect(root.notAfter).toBe(Date.UTC(2039, 3, 30, 18, 19, 6));
    expect(await verifyIssuedBy(root, root)).toBe(true);
  });
});

describe('Apple JWS chain verification', () => {
  it('accepts a valid production transaction and maps it', async () => {
    const v = new AppleStoreVerifier(cfg);
    const r = await v.verify(await signAppleJws(tx(), pki), 'coin_1500');
    expect(r).toMatchObject({ transactionId: 'apple:2000000123', productId: 'coin_1500', priceYen: 1500, sandbox: false });
    expect(r.originalTransactionId).toBeUndefined();
  });

  it('defaults to the real Apple root, which rejects a test chain', async () => {
    await expect(verifyAppleJws(await signAppleJws(tx(), pki), { now: () => NOW })).rejects.toThrow(/untrusted root/);
  });

  it('rejects an untrusted root, an expired leaf, a broken chain, missing Apple markers and bad signatures', async () => {
    const v = new AppleStoreVerifier(cfg);
    const other = await makeApplePki();
    await expect(v.verify(await signAppleJws(tx(), other), 'coin_1500')).rejects.toMatchObject({ code: 'RECEIPT_INVALID', message: expect.stringMatching(/untrusted root/) });

    const expired = await makeApplePki({ leafNotAfter: NOW - 1000 });
    const vExp = new AppleStoreVerifier({ ...cfg, roots: [expired.root.der] });
    await expect(vExp.verify(await signAppleJws(tx(), expired), 'coin_1500')).rejects.toThrow(/not valid at this time/);

    // leaf issued by a different intermediate than the one in x5c
    const strayInter = await issueCert({ cn: 'Test WWDR', curve: 'P-384', issuer: pki.root, ca: true, marker: '1.2.840.113635.100.6.2.1' });
    const strayLeaf = await issueCert({ cn: 'Test Leaf', curve: 'P-256', issuer: strayInter, ca: false, marker: '1.2.840.113635.100.6.11.1' });
    const broken = await signAppleJws(tx(), { ...pki, leaf: strayLeaf }, [strayLeaf.der, pki.inter.der, pki.root.der]);
    await expect(v.verify(broken, 'coin_1500')).rejects.toThrow(/leaf not signed by intermediate/);

    const noMarker = await makeApplePki({ leafMarker: false });
    await expect(new AppleStoreVerifier({ ...cfg, roots: [noMarker.root.der] }).verify(await signAppleJws(tx(), noMarker), 'coin_1500')).rejects.toThrow(/not an Apple leaf/);
    const noInterMarker = await makeApplePki({ interMarker: false });
    await expect(new AppleStoreVerifier({ ...cfg, roots: [noInterMarker.root.der] }).verify(await signAppleJws(tx(), noInterMarker), 'coin_1500')).rejects.toThrow(/not an Apple intermediate/);

    const good = await signAppleJws(tx(), pki);
    const [h, , s] = good.split('.');
    const forged = `${h}.${btoa(JSON.stringify(tx({ productId: 'coin_10000', price: 10_000_000 }))).replace(/=+$/, '')}.${s}`;
    await expect(v.verify(forged, 'coin_10000')).rejects.toThrow(/bad signature/);
    await expect(v.verify('not-a-jws', 'coin_1500')).rejects.toMatchObject({ code: 'RECEIPT_INVALID' });
  });

  it('checks bundleId, productId, revocation and environment', async () => {
    const v = new AppleStoreVerifier(cfg);
    await expect(v.verify(await signAppleJws(tx({ bundleId: 'com.other' }), pki), 'coin_1500')).rejects.toThrow(/bundleId/);
    await expect(v.verify(await signAppleJws(tx(), pki), 'coin_160')).rejects.toThrow(/productId/);
    await expect(v.verify(await signAppleJws(tx({ revocationDate: NOW }), pki), 'coin_1500')).rejects.toThrow(/revoked/);
    const sandbox = await v.verify(await signAppleJws(tx({ environment: 'Sandbox' }), pki), 'coin_1500');
    expect(sandbox).toMatchObject({ sandbox: true, priceYen: 0 });
    const strict = new AppleStoreVerifier({ ...cfg, acceptSandbox: false });
    await expect(strict.verify(await signAppleJws(tx({ environment: 'Sandbox' }), pki), 'coin_1500')).rejects.toThrow(/sandbox/);
    await expect(v.verify(await signAppleJws(tx({ environment: 'Weird' }), pki), 'coin_1500')).rejects.toThrow(/environment/);
  });

  it('uses the master price when the store currency is not JPY', async () => {
    const r = await new AppleStoreVerifier(cfg).verify(await signAppleJws(tx({ currency: 'USD', price: 9_990 }), pki), 'coin_1500');
    expect(r.priceYen).toBe(1500);
  });

  it('binds the purchase to the player through appAccountToken', async () => {
    const v = new AppleStoreVerifier(cfg);
    const mine = await appleAccountToken('p1');
    expect(mine).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    await expect(v.verify(await signAppleJws(tx({ appAccountToken: mine }), pki), 'coin_1500', { playerId: 'p1' })).resolves.toMatchObject({ productId: 'coin_1500' });
    await expect(v.verify(await signAppleJws(tx({ appAccountToken: mine }), pki), 'coin_1500', { playerId: 'p2' })).rejects.toThrow(/another player/);
  });

  it('maps subscriptions with the store expiry and rejects already-expired periods', async () => {
    const v = new AppleStoreVerifier(cfg);
    const sub = tx({ productId: 'season_pass', type: 'Auto-Renewable Subscription', price: 1_000_000, transactionId: '3001', originalTransactionId: '3000', expiresDate: NOW + 30 * 86400_000 });
    const r = await v.verify(await signAppleJws(sub, pki), 'season_pass');
    expect(r).toMatchObject({ transactionId: 'apple:3001', originalTransactionId: 'apple:3000', expiresAt: NOW + 30 * 86400_000, priceYen: 1000 });
    await expect(v.verify(await signAppleJws({ ...sub, expiresDate: NOW - 1 }, pki), 'season_pass')).rejects.toThrow(/expired/);
  });
});

function setup() {
  const index = new MemoryStoreTxIndex();
  const svc = new PlayerService(new MemoryPlayerRepo(), { master: m, rng: seededRng(1), clock: () => NOW, verifiers: { apple: new AppleStoreVerifier(cfg) }, storeIndex: index });
  return { svc, index };
}

describe('Apple purchases through PlayerService', () => {
  it('grants once, is idempotent, and refuses the same receipt on another account', async () => {
    const { svc } = setup();
    await svc.setAge('p1', 1990, 1, false);
    await svc.setAge('p2', 1990, 1, false);
    const jws = await signAppleJws(tx(), pki);
    const a = await svc.purchase('p1', 'apple', 'coin_1500', jws);
    expect(a.duplicate).toBe(false);
    expect(a.wallet.paid).toBe(1020);
    const again = await svc.purchase('p1', 'apple', 'coin_1500', jws);
    expect(again.wallet.paid).toBe(1020);
    await expect(svc.purchase('p2', 'apple', 'coin_1500', jws)).rejects.toMatchObject({ code: 'RECEIPT_INVALID', message: expect.stringMatching(/another player/) });
  });
});

describe('App Store Server Notifications V2', () => {
  const note = async (notificationType: string, t: AppleTransaction | null, extra: Record<string, unknown> = {}) => ({
    signedPayload: await signAppleJws({ notificationType, notificationUUID: crypto.randomUUID(), data: { bundleId: BUNDLE, environment: t?.environment ?? 'Production', ...(t ? { signedTransactionInfo: await signAppleJws(t, pki) } : {}) }, signedDate: NOW, ...extra }, pki),
  });

  function ctx(svc: PlayerService, index: MemoryStoreTxIndex): AppContext {
    const invoker: PlayerInvoker = { invoke: (async (method: string, ...args: unknown[]) => (svc as unknown as Record<string, (...a: unknown[]) => unknown>)[method]!.apply(svc, args)) as PlayerInvoker['invoke'] };
    return {
      master: m, authenticate: async () => { throw new AppError('UNAUTHORIZED'); }, player: () => invoker,
      match: {} as AppContext['match'], race: {} as AppContext['race'], friends: {} as AppContext['friends'], leaderboard: {} as AppContext['leaderboard'], timeAttack: {} as AppContext['timeAttack'], paidBalance: async () => ({}), adminToken: undefined,
      parseStoreNotification: async (platform, req) => resolveStoreEvent(platform as 'apple', await parseAppleNotification(await req.json(), cfg), index),
    };
  }
  const post = (body: unknown) => new Request('https://x/v1/store/notifications/apple', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('REFUND claws back coins and the first-purchase bonus, leaving debt for what was spent', async () => {
    const { svc, index } = setup();
    await svc.setAge('p1', 1990, 1, false);
    await svc.purchase('p1', 'apple', 'coin_1500', await signAppleJws(tx(), pki));
    await svc.draw('p1', 'standard', 10, 'c:g1'); // spends 1000 paid
    const res = await handle(post(await note('REFUND', tx())), {}, ctx(svc, index));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { debt: number };
    expect(body.debt).toBeGreaterThan(0);
    const v = await svc.view('p1');
    expect(v.wallet).toMatchObject({ paid: 0, free: 0 });
    // repeated delivery is harmless (idempotent: same result, nothing taken twice)
    const before = await svc.view('p1');
    expect((await handle(post(await note('REFUND', tx())), {}, ctx(svc, index))).status).toBe(200);
    expect((await svc.view('p1')).wallet).toEqual(before.wallet);
  });

  it('DID_RENEW extends the season pass, EXPIRED/REVOKE end it', async () => {
    const { svc, index } = setup();
    await svc.setAge('p1', 1990, 1, false);
    const first = tx({ productId: 'season_pass', type: 'Auto-Renewable Subscription', price: 1_000_000, transactionId: '3001', originalTransactionId: '3000', expiresDate: NOW + 30 * 86400_000 });
    await svc.purchase('p1', 'apple', 'season_pass', await signAppleJws(first, pki));
    const renewal = { ...first, transactionId: '3002', purchaseDate: NOW + 30 * 86400_000, expiresDate: NOW + 60 * 86400_000 };
    const r = (await (await handle(post(await note('DID_RENEW', renewal)), {}, ctx(svc, index))).json()) as { passExpiresAt: number; duplicate: boolean };
    expect(r).toMatchObject({ passExpiresAt: NOW + 60 * 86400_000, duplicate: false });
    // replayed notification does not double-grant
    await handle(post(await note('DID_RENEW', renewal)), {}, ctx(svc, index));
    expect((await svc.view('p1')).seasonPass.expiresAt).toBe(NOW + 60 * 86400_000);
    const ex = (await (await handle(post(await note('EXPIRED', { ...renewal, expiresDate: NOW + 45 * 86400_000 }, { subtype: 'VOLUNTARY' })), {}, ctx(svc, index))).json()) as { status: string; passExpiresAt: number };
    expect(ex).toMatchObject({ status: 'expired', passExpiresAt: NOW + 45 * 86400_000 });
    const rev = (await (await handle(post(await note('REVOKE', renewal)), {}, ctx(svc, index))).json()) as { alreadyRefunded: boolean };
    expect(rev.alreadyRefunded).toBe(false);
    expect((await svc.view('p1')).seasonPass.expiresAt).toBe(NOW);
  });

  it('acknowledges TEST, CONSUMPTION_REQUEST and unknown purchases; rejects forged payloads', async () => {
    const { svc, index } = setup();
    const c = ctx(svc, index);
    expect(await (await handle(post(await note('TEST', null)), {}, c)).json()).toMatchObject({ ok: true, ignored: 'TEST' });
    expect(await (await handle(post(await note('CONSUMPTION_REQUEST', tx())), {}, c)).json()).toMatchObject({ ok: true });
    expect(await (await handle(post(await note('REFUND', tx({ transactionId: '999' }))), {}, c)).json()).toMatchObject({ ok: true, ignored: expect.stringMatching(/unknown purchase/) });
    const other = await makeApplePki();
    const forged = { signedPayload: await signAppleJws({ notificationType: 'REFUND', notificationUUID: 'x', data: { bundleId: BUNDLE } }, other) };
    expect((await handle(post(forged), {}, c)).status).toBe(401);
    expect((await handle(post({}), {}, c)).status).toBe(400);
  });

  it('ignores Sandbox notifications when Sandbox is not accepted', async () => {
    const ev = await parseAppleNotification(await note('REFUND', tx({ environment: 'Sandbox' })), { ...cfg, acceptSandbox: false });
    expect(ev).toMatchObject({ kind: 'ignored', reason: 'sandbox' });
  });
});

describe('App Store Server API client', () => {
  it('authenticates with an ES256 JWT and returns the signed transaction', async () => {
    const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
    const pem = await exportPKCS8(privateKey);
    let auth = '';
    let url = '';
    const api = new AppStoreServerApi({
      issuerId: 'iss-1', keyId: 'KEY123', privateKeyPem: pem, bundleId: BUNDLE, sandbox: true,
      fetch: async (u, init) => {
        url = String(u);
        auth = new Headers(init?.headers).get('authorization') ?? '';
        return new Response(JSON.stringify({ signedTransactionInfo: 'jws' }), { status: 200 });
      },
    });
    expect(await api.getSignedTransaction('2000000123')).toBe('jws');
    expect(url).toBe('https://api.storekit-sandbox.itunes.apple.com/inApps/v1/transactions/2000000123');
    const token = auth.replace('Bearer ', '');
    expect(decodeProtectedHeader(token)).toMatchObject({ alg: 'ES256', kid: 'KEY123' });
    const { payload } = await jwtVerify(token, publicKey, { issuer: 'iss-1', audience: 'appstoreconnect-v1' });
    expect(payload.bid).toBe(BUNDLE);
    const notFound = new AppStoreServerApi({ issuerId: 'i', keyId: 'k', privateKeyPem: pem, bundleId: BUNDLE, sandbox: false, fetch: async () => new Response('', { status: 404 }) });
    await expect(notFound.getSignedTransaction('1')).rejects.toMatchObject({ code: 'RECEIPT_INVALID' });
  });
});
