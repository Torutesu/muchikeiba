// REQ-TRF-001..020: 引き継ぎコード (contracts/protocol.md §54).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pbkdf2Sync } from 'node:crypto';
import { importSPKI, jwtVerify, exportSPKI } from 'jose';
import { handle, makeFriendsService, type AppContext, type PlayerInvoker } from '../src/http/app.js';
import { MemoryDirectory } from '../src/domain/friends.js';
import { MemoryPlayerRepo, PlayerService } from '../src/domain/service.js';
import { FakeStoreVerifier } from '../src/domain/purchase.js';
import { seededRng } from '../src/domain/rng.js';
import { AppError } from '../src/domain/errors.js';
import { DEFAULT_RULESET } from '../src/domain/ruleset.js';
import { authenticateAdmin, type AdminAuthConfig } from '../src/ops/admin.js';
import { sha256Hex as opsSha } from '../src/ops/hash.js';
import { memoryOps } from '../src/ops/memoryOps.js';
import { resolveBundle } from '../src/ops/config.js';
import { untranslated } from '../src/i18n/catalog.js';
import {
  COMMON_PASSWORDS, DEFAULT_TRANSFER, ID_ALPHABET, SESSION_SKEW_MS, SessionGuard, TRANSFER_KDF, codeShard, formatCodeId, hashPassword, makeCodeId,
  makeGeneratedPassword, normalizeCodeId, normalizeInput, passwordProblems, sessionReplaced, transferConfig, transferProblems,
} from '../src/domain/transferCode.js';
import { MemoryTransferDirectory, TransferService, beginStep, limitStep, type CustomTokenSigner } from '../src/domain/transferService.js';
import { CUSTOM_TOKEN_AUDIENCE, firebaseCustomTokenSigner, parseServiceAccount, signerFromEnv } from '../src/http/customToken.js';
import { EXEMPT_ROUTES, gateRequest, DEFAULT_MAINTENANCE } from '../src/domain/maintenance.js';
import { shardOf } from '../src/domain/friends.js';
import type { KpiRecord } from '../src/domain/kpi.js';
import type { Master } from '../src/domain/master.js';
import { m } from './helpers.js';

const NOW = Date.UTC(2026, 10, 11, 3); // 12:00 JST
const DAY = 86_400_000;
const TOKENS = { viewer: 'viewer-token-0123456789', operator: 'operator-token-0123456789' };
const GOOD = 'Haneda2026!';

/** A test signer: tokens are readable, so tests can see whose account they open. */
const fakeSigner: CustomTokenSigner = { sign: async (uid, now) => `ct.${uid}.${Math.floor(now / 1000)}` };

async function setup(opts: { signer?: CustomTokenSigner | null; master?: Master; iterations?: number } = {}) {
  let now = NOW;
  const master = opts.master ?? m;
  const store = new FakeStoreVerifier();
  const repo = new MemoryPlayerRepo();
  const kpi: { id: string; rec: KpiRecord }[] = [];
  const svc = new PlayerService(repo, { master, rng: seededRng(19), clock: () => now, verifiers: { fake: store }, onKpi: (id, recs) => { for (const rec of recs) kpi.push({ id, rec }); } });
  const invoker: PlayerInvoker = { invoke: (async (method: string, ...args: unknown[]) => (svc as unknown as Record<string, (...a: unknown[]) => unknown>)[method]!.apply(svc, args)) as PlayerInvoker['invoke'] };
  const dir = new MemoryTransferDirectory();
  const guard = new SessionGuard((uid) => svc.transferCutoff(uid), () => now);
  const transfer = new TransferService({
    view: (u) => svc.transferView(u), checkIssue: (u) => svc.transferCheckIssue(u), issued: (u, c, mode) => svc.transferIssued(u, c, mode),
    revoke: (u, by) => svc.transferRevoke(u, by), progress: (u) => svc.transferProgress(u), redeemed: (u, c) => svc.transferRedeemed(u, c),
    noteFail: (u, r) => svc.transferFailed(u, r), admin: (u) => svc.adminTransfer(u),
    redeemReplay: (u, k) => svc.transferRedeemReplay(u, k), redeemRemember: (u, k, p, n) => svc.transferRedeemRemember(u, k, p, n),
  }, dir, () => transferConfig(master), opts.signer === undefined ? fakeSigner : opts.signer, {
    clock: () => now, iterations: opts.iterations ?? 1000, limitSalt: 'salt', onRedeemed: (u, c) => guard.note(u, c),
  });
  const ops = memoryOps(master, () => invoker);
  const auth: AdminAuthConfig = { tokens: await Promise.all((Object.keys(TOKENS) as (keyof typeof TOKENS)[]).map(async (name) => ({ name, role: name, sha256: await opsSha(TOKENS[name]) }))) };
  const session = (req: Request) => {
    const u = req.headers.get('x-test-user');
    if (!u) throw new AppError('UNAUTHORIZED');
    const t = req.headers.get('x-test-auth');
    return { uid: u, authTime: t === null ? Math.floor(now / 1000) : t === 'none' ? null : Number(t) };
  };
  const c: AppContext = {
    master,
    authenticate: async (req) => session(req).uid,
    authenticateSession: async (req) => session(req),
    sessionGuard: (uid, at) => guard.check(uid, at),
    player: () => invoker,
    match: {} as AppContext['match'],
    friends: makeFriendsService(() => invoker, new MemoryDirectory()),
    leaderboard: { board: async () => ({ entries: [], total: 0 }), myRank: async () => ({}) },
    timeAttack: {} as AppContext['timeAttack'],
    clock: () => now,
    race: { websocket: async () => new Response(null), report: async () => ({}), replay: async (id) => ({ raceId: id }) },
    paidBalance: async () => ({}),
    adminToken: undefined,
    parseStoreNotification: async () => null,
    ops: ops.api,
    authenticateAdmin: (req) => authenticateAdmin(req, auth),
    configInfo: async () => ({ versionId: 'base', hash: 'base', rulesetVersion: DEFAULT_RULESET.rulesetVersion, activatedAt: null }),
    transfer,
  };
  const call = async (user: string, path: string, init: { method?: string; body?: unknown; lang?: string; ip?: string; authAt?: number | 'none'; install?: string; key?: string } = {}) => {
    const headers: Record<string, string> = { 'x-test-user': user, 'content-type': 'application/json' };
    if (init.lang) headers['accept-language'] = init.lang;
    headers['cf-connecting-ip'] = init.ip ?? '203.0.113.7';
    if (init.authAt !== undefined) headers['x-test-auth'] = String(init.authAt);
    if (init.install) headers['x-install-id'] = init.install;
    if (init.key) headers['idempotency-key'] = init.key;
    const res = await handle(new Request(`https://x${path}`, { method: init.method ?? 'GET', headers, ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}) }), {}, c);
    return { status: res.status, headers: res.headers, body: (await res.json()) as any };
  };
  const admin = async (path: string, who: keyof typeof TOKENS = 'viewer', body?: unknown) => {
    const res = await handle(new Request(`https://x${path}`, {
      method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${TOKENS[who]}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}),
    }), {}, c);
    return { status: res.status, body: (await res.json()) as any };
  };
  const issue = (u: string, body: unknown = { mode: 'custom', password: GOOD }) => call(u, '/v1/transfer/code', { method: 'POST', body });
  const redeem = (u: string, codeId: string, password: string, extra: Record<string, unknown> = {}, init: Parameters<typeof call>[2] = {}) =>
    call(u, '/v1/transfer/redeem', { method: 'POST', body: { codeId, password, ...extra }, ...init });
  let n = 0;
  const buy = async (pid: string, productId = 'coin_480', priceYen = 480) => {
    const tx = `fake:T${++n}`;
    await svc.purchase(pid, 'fake', productId, store.issue({ transactionId: tx, productId, purchasedAt: now, priceYen }));
    return tx;
  };
  return { svc, repo, dir, kpi, c, call, admin, issue, redeem, buy, guard, transfer, ops, tick: (ms: number) => { now += ms; }, now: () => now };
}

afterEach(() => { vi.restoreAllMocks(); });

describe('code id and password formats (REQ-TRF-002/003)', () => {
  it('ids use 31 readable characters, carry the owner shard, and survive full-width / hyphen / lower-case input', () => {
    expect(ID_ALPHABET).toHaveLength(31);
    for (const ch of '01OIL') expect(ID_ALPHABET).not.toContain(ch);
    for (let s = 0; s < 16; s++) {
      const id = makeCodeId(s);
      expect(id).toMatch(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{9}$/);
      expect(codeShard(id)).toBe(s);
    }
    expect(formatCodeId('K7MQ3XPHR')).toBe('K7M-Q3X-PHR');
    expect(normalizeCodeId('k7m-q3x-phr')).toBe('K7MQ3XPHR');
    expect(normalizeCodeId('Ｋ７Ｍ－Ｑ３Ｘ－ＰＨＲ')).toBe('K7MQ3XPHR'); // full-width, as typed on a Japanese keyboard
    expect(normalizeCodeId(' K7M ー Q3X PHR ')).toBe('K7MQ3XPHR');
    expect(normalizeCodeId('K7MQ3XPH0')).toBeNull(); // 0 is not in the alphabet
    expect(normalizeCodeId('K7MQ3XPH')).toBeNull();
    expect(makeGeneratedPassword()).toMatch(/^[23456789abcdefghjkmnpqrstuvwxyz]{12}$/);
  });
  it('custom passwords: length, half-width characters, letters and numbers, not common — every broken rule is listed', () => {
    const cfg = DEFAULT_TRANSFER;
    expect(passwordProblems(GOOD, cfg)).toEqual([]);
    expect(passwordProblems('abc1', cfg)).toEqual(['length']);
    expect(passwordProblems('abcdefghij', cfg)).toEqual(['mix']);
    expect(passwordProblems('12345678', cfg)).toEqual(['mix']);
    expect(passwordProblems('あいうえおかきく1a', cfg)).toEqual(['charset']);
    expect(passwordProblems('Password1', cfg)).toEqual(['common']);
    expect(passwordProblems('a'.repeat(33) + '1', cfg)).toEqual(['length']);
    expect(passwordProblems('ab', cfg)).toEqual(['length', 'mix']);
    for (const p of COMMON_PASSWORDS) expect(p).toBe(p.toLowerCase());
    expect(normalizeInput('Ｈａｎｅｄａ２０２６！')).toBe(GOOD); // full-width typed → the same password
  });
  it('config is validated at boot and in remote config (REQ-TRF-018)', () => {
    expect(transferProblems(m)).toEqual([]);
    expect(transferConfig(m)).toMatchObject({ enabled: true, expiryDays: 30, maxAttemptsPerCode: 5 });
    const bad = (x: Record<string, unknown>) => transferProblems({ progression: { ...m.progression, transfer: { ...DEFAULT_TRANSFER, ...x } } } as never).join(' | ');
    expect(bad({ expiryDays: 0 })).toMatch(/expiryDays/);
    expect(bad({ expiryDays: 91 })).toMatch(/expiryDays/);
    expect(bad({ maxAttemptsPerCode: 1 })).toMatch(/maxAttemptsPerCode/);
    expect(bad({ passwordMin: 16, passwordMax: 16 })).toBe('');
    expect(bad({ passwordMin: 6 })).toMatch(/passwordMin/);
    expect(bad({ deviceFailuresPerHour: 30, ipFailuresPerHour: 20 })).toMatch(/deviceFailuresPerHour/);
    expect(bad({ extra: 1 })).toMatch(/Unrecognized|extra/);
    expect(() => resolveBundle(m, { progression: { ...m.progression, transfer: { ...DEFAULT_TRANSFER, expiryDays: 365 } } })).toThrow(/expiryDays/);
  });
  it('the hash is PBKDF2-HMAC-SHA256 at 100,000 iterations (the Workers maximum), 32 bytes, matching node:crypto', async () => {
    expect(TRANSFER_KDF).toMatchObject({ name: 'pbkdf2-sha256', iterations: 100_000, saltBytes: 16, hashBytes: 32 });
    const salt = '0f'.repeat(16);
    const h = await hashPassword(GOOD, salt);
    expect(h).toBe(pbkdf2Sync(GOOD, Buffer.from(salt, 'hex'), 100_000, 32, 'sha256').toString('hex'));
  });
  it('attempt and limit steps: the attempt that reaches the maximum still runs, then the code locks', () => {
    expect(beginStep(3, NOW, 5, 1000)).toEqual({ attempts: 4, lockedUntil: 0, lockedNow: false });
    expect(beginStep(4, NOW, 5, 1000)).toEqual({ attempts: 0, lockedUntil: NOW + 1000, lockedNow: true });
    expect(limitStep(null, NOW, 3, 1000)).toEqual({ windowStart: NOW, failures: 1, lockedUntil: 0 });
    expect(limitStep({ windowStart: NOW, failures: 2, lockedUntil: 0 }, NOW + 10, 3, 1000)).toEqual({ windowStart: NOW + 10, failures: 0, lockedUntil: NOW + 1010 });
    expect(limitStep({ windowStart: NOW - 3_600_000, failures: 2, lockedUntil: 0 }, NOW, 3, 1000)).toEqual({ windowStart: NOW, failures: 1, lockedUntil: 0 });
  });
});

describe('issue and redeem over HTTP (REQ-TRF-001/005/009/010)', () => {
  it('issues a code, moves the account to the new device with a custom token for the same uid, and the old device is cut off', async () => {
    const w = await setup();
    await w.svc.bootstrap('old');
    await w.svc.setDisplayName('old', 'ハヤテ');
    const before = await w.call('old', '/v1/transfer/code');
    expect(before.body).toMatchObject({ enabled: true, code: null, issuesToday: 0, issuesPerDay: 5, passwordMin: 8, passwordMax: 32, expiryDays: 30 });
    expect(before.body.rules.map((r: { id: string }) => r.id)).toEqual(['length', 'charset', 'mix', 'common']);
    const r = await w.issue('old');
    expect(r.status).toBe(200);
    expect(r.body.codeId).toMatch(/^[2-9A-HJKMNP-Z]{3}-[2-9A-HJKMNP-Z]{3}-[2-9A-HJKMNP-Z]{3}$/);
    expect(r.body.password).toBeUndefined(); // a custom password is never echoed
    expect(r.body.expiresAt - r.body.issuedAt).toBe(30 * DAY);
    expect(codeShard(normalizeCodeId(r.body.codeId)!)).toBe(shardOf('old'));
    const view = await w.call('old', '/v1/transfer/code');
    expect(view.body.code).toMatchObject({ codeId: r.body.codeId, mode: 'custom', expired: false });
    expect(JSON.stringify(view.body)).not.toContain(GOOD);
    // the directory keeps the hash, never the password
    expect(JSON.stringify([...w.dir.codes.values()])).not.toContain(GOOD);

    w.tick(60_000);
    const loginOld = Math.floor((w.now() - 3600_000) / 1000); // the old device signed in an hour ago
    const ok = await w.redeem('new', r.body.codeId.toLowerCase().replace(/-/g, ' '), GOOD);
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ customToken: `ct.old.${Math.floor(w.now() / 1000)}`, expiresInSec: 3600, displayName: 'ハヤテ' });
    // single use: the same code again is just "invalid"
    const again = await w.redeem('new2', r.body.codeId, GOOD);
    expect(again.status).toBe(400);
    expect(again.body.error.code).toBe('TRANSFER_INVALID');
    expect(w.dir.codes.size).toBe(0);
    // the old device: its next request is refused; the new device (signed in with the custom token, later) plays on
    const oldReq = await w.call('old', '/v1/player', { authAt: loginOld });
    expect(oldReq.status).toBe(401);
    expect(oldReq.body.error.code).toBe('SESSION_REPLACED');
    expect((await w.call('old', '/v1/player', { authAt: 'none' })).status).toBe(401);
    const newReq = await w.call('old', '/v1/player', { authAt: Math.floor(w.now() / 1000) + 2 });
    expect(newReq.status).toBe(200);
    expect(newReq.body.profile.displayName).toBe('ハヤテ');
    expect((await w.call('old', '/v1/transfer/code', { authAt: Math.floor(w.now() / 1000) })).body).toMatchObject({ code: null, lastTransferredAt: w.now() });
    // English message for the old device
    expect((await w.call('old', '/v1/player', { authAt: loginOld, lang: 'en' })).body.error.message).toBe('This account has moved to another device');
  });

  it('the cut-off allows 30 s of clock difference and other isolates learn it within the cache time', async () => {
    expect(sessionReplaced(null, null)).toBe(false);
    expect(sessionReplaced(NOW, Math.floor((NOW - SESSION_SKEW_MS + 1000) / 1000))).toBe(false);
    expect(sessionReplaced(NOW, Math.floor((NOW - SESSION_SKEW_MS - 1000) / 1000))).toBe(true);
    let now = NOW;
    let cutoff: number | null = null;
    let reads = 0;
    const g = new SessionGuard(async () => { reads++; return cutoff; }, () => now);
    await g.check('u', 1);
    await g.check('u', 1);
    expect(reads).toBe(1); // cached
    cutoff = NOW + 1000;
    await g.check('u', 1); // still the cached null
    now += 31_000;
    await expect(g.check('u', 1)).rejects.toMatchObject({ code: 'SESSION_REPLACED', status: 401 });
    expect(reads).toBe(2);
  });

  it('a generated password is returned once (formatted), works with or without hyphens, and re-issuing revokes the previous code', async () => {
    const w = await setup();
    const a = await w.issue('old', { mode: 'generated' });
    expect(a.body.password).toMatch(/^[2-9a-hjkmnp-z]{4}-[2-9a-hjkmnp-z]{4}-[2-9a-hjkmnp-z]{4}$/);
    expect((await w.call('old', '/v1/transfer/code')).body.code.mode).toBe('generated');
    const b = await w.issue('old', { mode: 'generated' });
    expect(b.body.codeId).not.toBe(a.body.codeId);
    expect((await w.redeem('new', a.body.codeId, a.body.password)).body.error.code).toBe('TRANSFER_INVALID');
    expect([...w.dir.codes.keys()]).toEqual([normalizeCodeId(b.body.codeId)]);
    const ok = await w.redeem('new', b.body.codeId, b.body.password.replace(/-/g, '').toUpperCase().replace(/./g, (ch: string) => ch.toLowerCase()));
    expect(ok.status).toBe(200);
  });

  it('weak passwords are refused with every broken rule; issuing is limited per game day and refused for banned / deleting accounts', async () => {
    const w = await setup();
    const weak = await w.issue('old', { mode: 'custom', password: 'abcd' });
    expect(weak.status).toBe(400);
    expect(weak.body.error).toMatchObject({ code: 'TRANSFER_PASSWORD_WEAK', details: { rules: ['length', 'mix'] } });
    expect((await w.issue('old', { mode: 'custom' })).status).toBe(400);
    expect((await w.issue('old', { mode: 'other' })).status).toBe(400);
    for (let i = 0; i < 5; i++) expect((await w.issue('old')).status).toBe(200);
    const limit = await w.issue('old');
    expect(limit.status).toBe(429);
    expect(limit.body.error.code).toBe('TRANSFER_ISSUE_LIMIT');
    expect(w.dir.codes.size).toBe(1); // every re-issue removed the code it replaced
    w.tick(DAY); // next game day (04:00 JST rollover)
    expect((await w.issue('old')).status).toBe(200);
    await w.svc.setModeration('banned1', 'banned', null, 'cheat');
    expect((await w.issue('banned1')).body.error.code).toBe('BANNED');
    await w.svc.bootstrap('del');
    const tok = await w.call('del', '/v1/player', { method: 'DELETE' });
    await w.call('del', '/v1/player', { method: 'DELETE', body: { confirmToken: tok.body.confirmToken } });
    expect((await w.issue('del')).body.error.code).toBe('DELETION_PENDING');
  });
});

describe('no oracle, attempt limits and expiry (REQ-TRF-006/007/008)', () => {
  it('an unknown id and a wrong password answer the same, after the same hashing', async () => {
    const w = await setup();
    const r = await w.issue('old');
    const spy = vi.spyOn(crypto.subtle, 'deriveBits');
    const wrong = await w.redeem('new', r.body.codeId, 'Wrong2026!');
    const hashesWrong = spy.mock.calls.length;
    const unknown = await w.redeem('new', 'ZZZ-ZZZ-ZZZ', 'Wrong2026!');
    const garbage = await w.redeem('new', '???', 'Wrong2026!');
    expect(spy.mock.calls.length).toBe(hashesWrong * 3); // a dummy PBKDF2 for the unknown and malformed ids too
    expect(wrong.status).toBe(400);
    expect(unknown.status).toBe(wrong.status);
    expect(unknown.body).toEqual(wrong.body);
    expect(garbage.body).toEqual(wrong.body);
  });

  it('a code locks after 5 wrong passwords — and looks exactly like an unknown id — then opens again', async () => {
    const w = await setup();
    const r = await w.issue('old');
    for (let i = 0; i < 5; i++) expect((await w.redeem(`dev${i}`, r.body.codeId, 'Wrong2026!', {}, { ip: `198.51.100.${i}` })).body.error.code).toBe('TRANSFER_INVALID');
    const locked = await w.redeem('devX', r.body.codeId, GOOD, {}, { ip: '198.51.100.99' });
    expect(locked.status).toBe(400);
    expect(locked.body).toEqual((await w.redeem('devX', 'ZZZ-ZZZ-ZZZ', GOOD, {}, { ip: '198.51.100.99' })).body);
    const audit = (await w.admin('/v1/admin/players/old/transfer')).body.audit.map((a: { event: string }) => a.event);
    expect(audit).toContain('locked');
    w.tick(61 * 60_000);
    expect((await w.redeem('devX', r.body.codeId, GOOD, {}, { ip: '198.51.100.99' })).status).toBe(200);
  });

  it('20 failures from one IP (or 10 from one device) lock that IP / device with 429 and Retry-After; other IPs are unaffected', async () => {
    const w = await setup();
    const r = await w.issue('old');
    for (let i = 0; i < 20; i++) await w.redeem(`d${i}`, 'ZZZ-ZZZ-ZZZ', 'Wrong2026!', {}, { ip: '203.0.113.50', install: `install-${i}-xxxx` });
    const ip = await w.redeem('d99', r.body.codeId, GOOD, {}, { ip: '203.0.113.50', install: 'install-99-xxxx' });
    expect(ip.status).toBe(429);
    expect(ip.body.error.code).toBe('TRANSFER_LOCKED');
    expect(ip.body.error.details.retryAfterSec).toBe(3600);
    expect(ip.headers.get('retry-after')).toBe('3600');
    for (let i = 0; i < 10; i++) await w.redeem('same', 'ZZZ-ZZZ-ZZZ', 'Wrong2026!', {}, { ip: `192.0.2.${i}`, install: 'device-one-xxxx' });
    expect((await w.redeem('same', r.body.codeId, GOOD, {}, { ip: '192.0.2.200', install: 'device-one-xxxx' })).body.error.code).toBe('TRANSFER_LOCKED');
    // without an install id the requesting account is the device
    expect((await w.redeem('other', r.body.codeId, GOOD, {}, { ip: '192.0.2.201' })).status).toBe(200);
  });

  it('an expired code says "expired" only to the right password', async () => {
    const w = await setup();
    const r = await w.issue('old');
    w.tick(30 * DAY + 1);
    expect((await w.call('old', '/v1/transfer/code')).body.code.expired).toBe(true);
    expect((await w.redeem('new', r.body.codeId, 'Wrong2026!')).body.error.code).toBe('TRANSFER_INVALID');
    const ex = await w.redeem('new', r.body.codeId, GOOD);
    expect(ex.status).toBe(410);
    expect(ex.body.error.code).toBe('TRANSFER_EXPIRED');
    // the row is purged a week after expiry (then it is simply invalid)
    w.tick(8 * DAY);
    await w.issue('someone');
    expect((await w.redeem('new', r.body.codeId, GOOD)).body.error.code).toBe('TRANSFER_INVALID');
  });

  it('a retry after a lost response (same account, same key) gets a fresh token for the same account; other keys / accounts do not', async () => {
    const w = await setup();
    await w.svc.setDisplayName('old', 'ツバメ');
    const r = await w.issue('old');
    const first = await w.redeem('new', r.body.codeId, GOOD, {}, { key: 'redeem-1' });
    expect(first.status).toBe(200);
    w.tick(5_000);
    const retry = await w.redeem('new', r.body.codeId, GOOD, {}, { key: 'redeem-1' });
    expect(retry.status).toBe(200);
    expect(retry.body).toMatchObject({ customToken: `ct.old.${Math.floor(w.now() / 1000)}`, displayName: 'ツバメ' });
    expect((await w.redeem('new', r.body.codeId, GOOD, {}, { key: 'redeem-2' })).body.error.code).toBe('TRANSFER_INVALID');
    expect((await w.redeem('thief', r.body.codeId, GOOD, {}, { key: 'redeem-1' })).body.error.code).toBe('TRANSFER_INVALID');
    w.tick(3_600_000);
    expect((await w.redeem('new', r.body.codeId, GOOD, {}, { key: 'redeem-1' })).body.error.code).toBe('TRANSFER_INVALID');
  });

  it('two devices entering the same code at once: one success', async () => {
    const w = await setup();
    const r = await w.issue('old');
    const out = await Promise.all([w.redeem('a', r.body.codeId, GOOD, {}, { ip: '1.1.1.1' }), w.redeem('b', r.body.codeId, GOOD, {}, { ip: '2.2.2.2' })]);
    expect(out.map((x) => x.status).sort()).toEqual([200, 400]);
  });
});

describe('edge cases (REQ-TRF-009/012/015)', () => {
  it('a device with its own progress must confirm first; the confirmation shows its paid coins', async () => {
    const w = await setup();
    const r = await w.issue('old');
    await w.svc.setAge('newdev', 1990, 1, false);
    await w.buy('newdev');
    const c = await w.redeem('newdev', r.body.codeId, GOOD);
    expect(c.status).toBe(409);
    expect(c.body.error.code).toBe('TRANSFER_CONFIRM_REQUIRED');
    expect(c.body.error.details).toMatchObject({ paidCoins: 310, purchases: 1 });
    expect(w.dir.codes.size).toBe(1); // nothing was tried yet
    // a fresh install (no stored account) needs no confirmation
    expect((await w.svc.transferProgress('fresh'))).toBeNull();
    const ok = await w.redeem('newdev', r.body.codeId, GOOD, { confirmDiscard: true });
    expect(ok.status).toBe(200);
  });

  it('banned and deleting accounts are refused (the code stays usable), a deleted account is just invalid, own code on own device is refused', async () => {
    const w = await setup();
    const r = await w.issue('old');
    await w.svc.setModeration('old', 'banned', null, 'cheat');
    const b = await w.redeem('new', r.body.codeId, GOOD);
    expect(b.status).toBe(403);
    expect(b.body.error).toMatchObject({ code: 'TRANSFER_REFUSED', details: { reason: 'banned' } });
    await w.svc.setModeration('old', 'ok', null, 'appeal');
    const tok = await w.call('old', '/v1/player', { method: 'DELETE' });
    await w.call('old', '/v1/player', { method: 'DELETE', body: { confirmToken: tok.body.confirmToken } });
    const d = await w.redeem('new', r.body.codeId, GOOD);
    expect(d.body.error).toMatchObject({ code: 'TRANSFER_REFUSED', details: { reason: 'deletion_pending' } });
    await w.call('old', '/v1/player/deletion/cancel', { method: 'POST' });
    expect((await w.redeem('old', r.body.codeId, GOOD)).body.error.code).toBe('TRANSFER_SAME_ACCOUNT');
    // the account is wiped (deletion ran): the code no longer matches anything
    w.repo.delete('old');
    w.dir.forget('old');
    expect((await w.redeem('new', r.body.codeId, GOOD)).body.error.code).toBe('TRANSFER_INVALID');
    expect(w.repo.get('old')).toBeNull(); // the failed redeem did not recreate the account
    expect(w.kpi.filter((k) => k.rec.name === 'transfer_redeem').map((k) => k.rec.s2)).toEqual(expect.arrayContaining(['refused_banned', 'refused_deletion', 'same_account', 'invalid']));
  });

  it('paid coins, purchases and store refunds stay with the uid that moved (資金決済法)', async () => {
    const w = await setup();
    await w.svc.setAge('old', 1990, 1, false);
    const tx = await w.buy('old');
    const paidBefore = (await w.svc.state('old')).wallet.paid;
    expect(paidBefore).toBe(310);
    const r = await w.issue('old');
    expect((await w.redeem('new', r.body.codeId, GOOD)).status).toBe(200);
    const after = await w.call('old', '/v1/player', { authAt: Math.floor(w.now() / 1000) });
    expect(after.body.wallet.paid).toBe(paidBefore);
    expect((await w.svc.state('old')).purchases.map((p) => p.txId)).toContain(tx);
    expect((await w.svc.state('new')).wallet.paid).toBe(0); // nothing was copied anywhere
    // a store refund after the move still reaches the same account
    await w.svc.refund('old', tx);
    expect((await w.svc.state('old')).wallet.paid).toBe(0);
  });

  it('the feature is off without the signing key or when config disables it', async () => {
    const w = await setup({ signer: null });
    expect((await w.call('u', '/v1/transfer/code')).body).toEqual({ enabled: false });
    expect((await w.issue('u')).status).toBe(404);
    expect((await w.redeem('u', 'ABC-DEF-GHJ', GOOD)).status).toBe(404);
    const off = await setup({ master: { ...m, progression: { ...m.progression, transfer: { ...DEFAULT_TRANSFER, enabled: false } } } as Master });
    expect((await off.call('u', '/v1/transfer/code')).body).toEqual({ enabled: false });
  });
});

describe('maintenance, KPI, audit, ops, English (REQ-TRF-013/014/016)', () => {
  it('transfer routes are never gated: an `all` maintenance window and an outdated app still pass', () => {
    for (const r of ['GET /v1/transfer/code', 'POST /v1/transfer/code', 'DELETE /v1/transfer/code', 'POST /v1/transfer/redeem']) expect(EXEMPT_ROUTES).toContain(r);
    const cfg = { ...DEFAULT_MAINTENANCE, windows: [{ id: 'm1', startAtMs: NOW - 1000, endAtMs: NOW + 3600_000, scope: 'all' as const, message: { ja: 'メンテナンス', en: 'Maintenance' } }],
      clientVersions: { ios: { min: '9.0.0', recommended: '9.0.0', storeUrl: 'https://apps.apple.com/jp/app/id1' }, android: DEFAULT_MAINTENANCE.clientVersions.android } };
    const h = { platform: 'ios', version: '1.0.0', engine: 1 };
    expect(gateRequest(cfg, 'POST', '/v1/transfer/redeem', h, NOW)).toBeNull();
    expect(gateRequest(cfg, 'POST', '/v1/transfer/code', h, NOW)).toBeNull();
    expect(gateRequest(cfg, 'GET', '/v1/player', h, NOW)?.code).toBe('UPGRADE_REQUIRED');
  });

  it('KPI rows carry only the mode / outcome / reason; ids, passwords and IPs never reach KPI, the audit or the logs', async () => {
    const w = await setup();
    const logs: string[] = [];
    for (const k of ['log', 'error', 'warn', 'info'] as const) vi.spyOn(console, k).mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')); });
    const a = await w.issue('old', { mode: 'generated' });
    await w.redeem('new', a.body.codeId, 'Wrong2026!');
    await w.redeem('new', a.body.codeId, a.body.password);
    const rows = w.kpi.filter((k) => k.rec.name.startsWith('transfer_')).map((k) => [k.id, k.rec.name, k.rec.s1, k.rec.s2 ?? null]);
    expect(rows).toEqual([['old', 'transfer_issue', 'generated', null], ['new', 'transfer_redeem', 'fail', 'invalid'], ['old', 'transfer_redeem', 'ok', null]]);
    const secret = [a.body.codeId, normalizeCodeId(a.body.codeId)!, a.body.password, a.body.password.replace(/-/g, ''), '203.0.113.7'];
    const everything = JSON.stringify([w.kpi, w.dir.rows, (await w.admin('/v1/admin/players/old/transfer')).body, logs, await w.ops.api.auditQuery({ limit: 100 } as never)]);
    for (const s of secret) expect(everything).not.toContain(s);
    expect(w.dir.rows.map((r) => r.event)).toEqual(['issued', 'failed', 'redeemed']);
    expect(w.dir.rows[1]).toMatchObject({ playerId: 'old', codeRef: expect.stringMatching(/^[0-9a-f]{8}$/), ipRef: expect.stringMatching(/^[0-9a-f]{8}$/), devRef: expect.stringMatching(/^[0-9a-f]{8}$/) });
  });

  it('ops can view and revoke a code (operator, reason, audit log); a revoked code is invalid; the player can revoke too', async () => {
    const w = await setup();
    const r = await w.issue('old');
    const v = await w.admin('/v1/admin/players/old/transfer');
    expect(v.status).toBe(200);
    expect(v.body.state.code.codeId).toBe(r.body.codeId);
    expect((await w.admin('/v1/admin/players/old/transfer/revoke', 'viewer', { reason: 'stolen phone' })).status).toBe(403);
    const rv = await w.admin('/v1/admin/players/old/transfer/revoke', 'operator', { reason: 'stolen phone' });
    expect(rv.status).toBe(200);
    expect(rv.body).toEqual({ revoked: true });
    expect((await w.redeem('new', r.body.codeId, GOOD)).body.error.code).toBe('TRANSFER_INVALID');
    const log = await w.ops.api.auditQuery({ limit: 50 } as never);
    expect(log.some((e) => e.action === 'player.transfer.revoke' && e.target === 'player:old')).toBe(true);
    expect((await w.call('old', '/v1/transfer/code')).body.code).toBeNull();
    const r2 = await w.issue('old');
    expect((await w.call('old', '/v1/transfer/code', { method: 'DELETE' })).body).toEqual({ revoked: true });
    expect((await w.call('old', '/v1/transfer/code', { method: 'DELETE' })).body).toEqual({ revoked: false });
    expect((await w.redeem('new', r2.body.codeId, GOOD)).body.error.code).toBe('TRANSFER_INVALID');
    expect((await w.svc.state('old')).transfer!.history.map((h) => h.event)).toEqual(['issued', 'ops_revoked', 'issued', 'revoked']);
  });

  it('English: the rule lines are translated, nothing Japanese is left', async () => {
    const w = await setup();
    const v = await w.call('old', '/v1/transfer/code', { lang: 'en' });
    expect(v.body.rules.map((r: { text: string }) => r.text)).toEqual(['8–32 characters', 'Letters, numbers and symbols', 'Use both letters and numbers', 'No common passwords']);
    expect(untranslated(v.body)).toEqual([]);
  });

  it('account deletion forgets the codes and the audit rows (REQ-TRF-017)', async () => {
    const w = await setup();
    await w.issue('old');
    w.dir.forget('old');
    expect(w.dir.codes.size).toBe(0);
    expect(w.dir.rows.filter((r) => r.playerId === 'old')).toEqual([]);
  });
});

describe('custom token (REQ-TRF-011)', () => {
  it('signs an RS256 Firebase custom token for the uid with the service account (iss = sub, audience, 1 h)', async () => {
    const kp = (await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
    const pk = Buffer.from(await crypto.subtle.exportKey('pkcs8', kp.privateKey)).toString('base64');
    const pem = `-----BEGIN PRIVATE KEY-----\n${pk.match(/.{1,64}/g)!.join('\n')}\n-----END PRIVATE KEY-----\n`;
    const json = JSON.stringify({ type: 'service_account', client_email: 'firebase-adminsdk@muchi.iam.gserviceaccount.com', private_key: pem });
    expect(parseServiceAccount(json)).not.toBeNull();
    expect(parseServiceAccount('{}')).toBeNull();
    expect(parseServiceAccount('not json')).toBeNull();
    expect(signerFromEnv(undefined)).toBeNull();
    const tok = await firebaseCustomTokenSigner(parseServiceAccount(json)!).sign('player-42', NOW);
    const pub = await importSPKI(await exportSPKI(kp.publicKey), 'RS256');
    const { payload, protectedHeader } = await jwtVerify(tok, pub, { audience: CUSTOM_TOKEN_AUDIENCE, issuer: 'firebase-adminsdk@muchi.iam.gserviceaccount.com', currentDate: new Date(NOW + 1000) });
    expect(protectedHeader.alg).toBe('RS256');
    expect(payload).toMatchObject({ uid: 'player-42', sub: 'firebase-adminsdk@muchi.iam.gserviceaccount.com', iat: NOW / 1000, exp: NOW / 1000 + 3600 });
    expect(Object.keys(payload).sort()).toEqual(['aud', 'exp', 'iat', 'iss', 'sub', 'uid']);
  });

  it('a signing failure consumes nothing', async () => {
    let fail = true;
    const w = await setup({ signer: { sign: async (uid, now) => { if (fail) throw new Error('bad key'); return `ct.${uid}.${now}`; } } });
    const r = await w.issue('old');
    expect((await w.redeem('new', r.body.codeId, GOOD)).status).toBe(500);
    fail = false;
    expect((await w.redeem('new', r.body.codeId, GOOD)).status).toBe(200);
  });

  it('the default service hashes new records at 100,000 iterations', async () => {
    const w = await setup({ iterations: undefined as never });
    const svc2 = new TransferService({
      view: async () => ({}), checkIssue: async () => ({}), issued: async () => ({ previous: null, issuedAt: NOW, expiresAt: NOW + DAY }),
      revoke: async () => ({ revoked: null }), progress: async () => null, redeemed: async () => ({ displayName: 'x', cutoffAt: NOW }), noteFail: async () => ({}), admin: async () => ({}),
      redeemReplay: async () => null, redeemRemember: async () => ({}),
    }, w.dir, () => DEFAULT_TRANSFER, fakeSigner, { clock: () => NOW });
    await svc2.issue('x', { mode: 'generated' });
    expect([...w.dir.codes.values()].map((r) => r.iterations)).toEqual([100_000]);
  });
});
