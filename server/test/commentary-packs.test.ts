// 実況パック (REQ-CMT-001..014, contracts/protocol.md §36)
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { m } from './helpers.js';
import standardJa from '../../engine/Muchi.Client/Resources/Muchi/commentary-ja.json';
import standardEn from '../../engine/Muchi.Client/Resources/Muchi/commentary-en.json';
import manifest from '../../contracts/assets.manifest.json';
import { MemoryPlayerRepo, PlayerService } from '../src/domain/service.js';
import { seededRng } from '../src/domain/rng.js';
import { AppError } from '../src/domain/errors.js';
import { grantFree, grantPaid } from '../src/domain/wallet.js';
import { clientBatchSchema, clientToKpi, type KpiRecord } from '../src/domain/kpi.js';
import {
  BETTING_WORDS_JA, COMMENTARY_PACKS, commentaryPacksClientJson, commentaryPacksProblems, commentaryTextProblems, placeholdersOf,
  type CommentaryPacksMaster, type StandardCommentary,
} from '../src/domain/commentaryPacks.js';
import { phraseClipIds } from '../src/domain/assetManifest.js';
import { assetKeys } from '../src/domain/visuals.js';
import { handle, makeFriendsService, type AppContext, type PlayerInvoker } from '../src/http/app.js';
import { MemoryDirectory } from '../src/domain/friends.js';
import { catalogFor, localize, untranslated, PLAYER_TEXT_KEYS } from '../src/i18n/catalog.js';
import type { Master } from '../src/domain/master.js';

const STD = { ja: standardJa as unknown as StandardCommentary, en: standardEn as unknown as StandardCommentary };
const clone = (): CommentaryPacksMaster => structuredClone(COMMENTARY_PACKS);
const withPacks = (c: CommentaryPacksMaster): Master => ({ ...m, commentaryPacks: c });

function world() {
  let now = Date.UTC(2026, 11, 10, 3);
  const kpi: KpiRecord[] = [];
  const svc = new PlayerService(new MemoryPlayerRepo(), { master: m, rng: seededRng(3), clock: () => now, verifiers: {}, onKpi: (_id, recs) => { kpi.push(...recs); } });
  // confirmed races counted by the 「出走の記録」 achievement (stats.races; the achievement tier unlocks at the end of a transaction)
  const races = (id: string, n: number) => svc.tx(id, null, (s) => { s.stats.races += n; });
  const coins = (id: string, free: number, paid = 0) => svc.tx(id, null, (s, t) => { grantFree(s, free, t, 'test', 'test'); if (paid) grantPaid(s, paid, paid, t, 'test', `tx${t}`); });
  return { svc, kpi, races, coins, advance: (ms: number) => { now += ms; } };
}

describe('REQ-CMT-005 the shipped packs pass the lint (boot and against the standard templates)', () => {
  it('no problems in the catalog, with explicit fallback and placeholders checked per language', () => {
    expect(commentaryPacksProblems(m)).toEqual([]);
    expect(commentaryPacksProblems(m, COMMENTARY_PACKS, STD)).toEqual([]);
  });
  it('four packs: the free standard, one achievement pack (never sold), two coin packs at fixed prices', () => {
    const ids = COMMENTARY_PACKS.packs.map((p) => p.id);
    expect(ids).toEqual(['standard', 'nekketsu', 'ochitsuki', 'kofuu']);
    expect(COMMENTARY_PACKS.packs.filter((p) => p.acquire.kind === 'default').map((p) => p.id)).toEqual(['standard']);
    expect(COMMENTARY_PACKS.packs.filter((p) => p.acquire.kind === 'achievement')).toHaveLength(1);
    for (const p of COMMENTARY_PACKS.packs) if (p.acquire.kind === 'coins') expect(p.acquire.price).toBeGreaterThan(0);
  });
  it('the standard templates themselves pass the same wording / betting lint', () => {
    for (const [lang, t] of [['ja', STD.ja], ['en', STD.en]] as const) {
      for (const [k, p] of Object.entries(t.phrases)) for (const v of p.variants) expect(commentaryTextProblems(v.text, lang, m.ng), `${lang} ${k} ${v.text}`).toEqual([]);
    }
  });
  it('betting words, shop wording, real names and Japanese in English are refused', () => {
    expect(commentaryTextProblems('{name}の馬券が当たった！', 'ja')).toContain('betting word 「馬券」');
    expect(commentaryTextProblems('オッズで儲けるチャンス', 'ja').length).toBeGreaterThanOrEqual(2);
    expect(commentaryTextProblems('今だけの走り！', 'ja')).toContain('must not contain 「今だけ」');
    expect(commentaryTextProblems('ダービーのような走り', 'ja', m.ng)).toEqual(['real name 「ダービー」']);
    expect(commentaryTextProblems('Place your bets!', 'en').some((x) => x.startsWith('betting word'))).toBe(true);
    expect(commentaryTextProblems('The odds are against {name}', 'en').some((x) => x.startsWith('betting word'))).toBe(true);
    expect(commentaryTextProblems('Double the speed!', 'en').length).toBeGreaterThan(0);
    expect(commentaryTextProblems('{name}が先頭', 'en')).toContain('English text contains Japanese');
    expect(commentaryTextProblems('{horse}！', 'ja')).toContain('unknown placeholder {horse}');
    expect(BETTING_WORDS_JA).toContain('配当');
  });
  it('a pack missing a standard kind without fallback, or with a placeholder the standard does not use, is refused', () => {
    const c = clone();
    const nek = c.packs.find((p) => p.id === 'nekketsu')!;
    delete nek.phrases!.ja!['kakari'];
    delete nek.phrases!.en!['kakari'];
    expect(commentaryPacksProblems(withPacks(c), c, STD)).toContain('commentaryPacks.nekketsu: kind kakari is neither in phrases.ja nor in fallback');
    nek.fallback!.push('kakari');
    expect(commentaryPacksProblems(withPacks(c), c, STD)).toEqual([]);
    nek.phrases!.ja!['gate_open']!.variants[0]!.text = '{name}、ゲートオープン！';
    expect(commentaryPacksProblems(withPacks(c), c, STD).join('\n')).toContain('placeholder {name} is not used by the standard gate_open');
  });
  it('catalog rules: one default, achievement exists and is never priced, prices, variant ids unique and prefixed', () => {
    const c = clone();
    c.packs.find((p) => p.id === 'ochitsuki')!.acquire = { kind: 'coins', price: 0, currency: 'any' };
    c.packs.find((p) => p.id === 'nekketsu')!.acquire = { kind: 'achievement', achievementId: 'nope', tier: 1 };
    c.packs.find((p) => p.id === 'kofuu')!.phrases!.ja!['spurt']!.variants[0]!.id = 'nekketsu_spurt_1';
    const p = commentaryPacksProblems(withPacks(c), c);
    expect(p.join('\n')).toContain('ochitsuki: price must be');
    expect(p.join('\n')).toContain('unknown achievement nope');
    expect(p.join('\n')).toContain('variant id nekketsu_spurt_1 must be kofuu_');
    const d = clone();
    d.packs.push({ ...d.packs[0]!, id: 'standard2' });
    expect(commentaryPacksProblems(withPacks(d), d).join('\n')).toContain('exactly one default pack');
  });
  it('the sample race uses real templates (their names are voiced) and the master track', () => {
    const c = clone();
    c.sample.entrants[0]!.name = 'ニセモノ';
    c.sample.track.distanceM = 1700;
    const p = commentaryPacksProblems(withPacks(c), c).join('\n');
    expect(p).toContain('name must be');
    expect(p).toContain('differs from master/tracks.json');
  });
});

describe('REQ-CMT-001 / 006 client copy and voice clips', () => {
  it('the client copy equals the master (npm run gen:client-locale)', () => {
    const client = readFileSync(join(import.meta.dirname, '../../engine/Muchi.Client/Resources/Muchi/commentary-packs.json'), 'utf8');
    expect(client).toBe(commentaryPacksClientJson());
    expect(readFileSync(join(import.meta.dirname, '../master/commentary-packs.json'), 'utf8')).toBe(commentaryPacksClientJson());
  });
  it('every fixed fragment of every pack is in the asset manifest as voice/ja/phrase/<variant>_p<n>', () => {
    const keys = new Set((manifest as { keys: string[] }).keys);
    let n = 0;
    for (const p of COMMENTARY_PACKS.packs) for (const ph of Object.values(p.phrases?.ja ?? {})) for (const v of ph.variants) {
      for (const clip of phraseClipIds(v.id, v.text)) { expect(keys.has(assetKeys.voicePhrase(clip)), clip).toBe(true); n++; }
    }
    expect(n).toBeGreaterThan(100);
    for (const e of COMMENTARY_PACKS.sample.entrants) expect(keys.has(assetKeys.voiceName(e.name))).toBe(true);
  });
  it('placeholdersOf reads template placeholders in order', () => {
    expect(placeholdersOf('一着{name}、二着{name2}')).toEqual(['name', 'name2']);
  });
});

describe('REQ-CMT-007/009/011 ownership, view and equip', () => {
  it('a new player owns only the standard and has it equipped; reading creates no state', async () => {
    const w = world();
    await w.svc.bootstrap('p');
    const v = await w.svc.commentaryPacks('p');
    expect(v.equipped).toBe('standard');
    expect(v.packs.map((p) => [p.id, p.owned, p.forSale, p.price])).toEqual([['standard', true, false, null], ['nekketsu', false, false, null], ['ochitsuki', false, true, 300], ['kofuu', false, true, 300]]);
    expect(v.packs[1]!.unlock).toMatchObject({ achievementId: 'races', tier: 1, progress: 0, target: 10 });
    expect(v.packs[3]).toMatchObject({ english: 'standard', englishNote: '英語では標準の実況で話します' });
    expect(v.sample).toMatchObject({ trackId: 'aoba_turf_1600', seconds: 10, fieldSize: 8 });
    expect((await w.svc.state('p')).commentaryPack).toBeUndefined();
    expect((await w.svc.view('p')).commentaryPack).toEqual({ equipped: 'standard' });
  });
  it('equipping a pack you do not own is NOT_ELIGIBLE; an unknown pack is NOT_FOUND', async () => {
    const w = world();
    await w.svc.bootstrap('p');
    await expect(w.svc.equipCommentaryPack('p', 'ochitsuki', 'settings')).rejects.toMatchObject({ code: 'NOT_ELIGIBLE' });
    await expect(w.svc.equipCommentaryPack('p', 'nope', 'settings')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  it('the achievement pack is owned once 10 races are run (no coins, no draw) and stays owned once equipped', async () => {
    const w = world();
    await w.svc.bootstrap('p');
    await w.races('p', 9);
    expect((await w.svc.commentaryPacks('p')).packs[1]).toMatchObject({ owned: false, unlock: { progress: 9 } });
    await w.races('p', 1);
    expect((await w.svc.commentaryPacks('p')).packs[1]).toMatchObject({ owned: true });
    const walletBefore = (await w.svc.view('p')).wallet;
    const v = await w.svc.equipCommentaryPack('p', 'nekketsu', 'settings');
    expect(v.equipped).toBe('nekketsu');
    expect((await w.svc.view('p')).wallet).toEqual(walletBefore);
    expect((await w.svc.state('p')).commentaryPack!.owned['nekketsu']).toMatchObject({ via: 'achievement' });
    const eq = w.kpi.filter((k) => k.name === 'commentary_pack_equip');
    expect(eq).toHaveLength(1);
    expect(eq[0]).toMatchObject({ s1: 'nekketsu', s2: 'standard', s3: 'settings', isFirst: true });
    // equipping it again is a no-op (no KPI); back to the standard is a change
    await w.svc.equipCommentaryPack('p', 'nekketsu', 'settings');
    expect(w.kpi.filter((k) => k.name === 'commentary_pack_equip')).toHaveLength(1);
    await w.svc.equipCommentaryPack('p', 'standard', 'shop');
    expect(w.kpi.filter((k) => k.name === 'commentary_pack_equip').at(-1)).toMatchObject({ s1: 'standard', s2: 'nekketsu', s3: 'shop', isFirst: false });
  });
  it('an equipped pack that is gone from the catalog falls back to the standard', async () => {
    const w = world();
    await w.svc.bootstrap('p');
    await w.coins('p', 1000);
    await w.svc.buyCommentaryPack('p', 'kofuu', true, 'c:b1');
    const c = clone();
    c.packs = c.packs.filter((p) => p.id !== 'kofuu');
    const svc2 = new PlayerService((w.svc as unknown as { repo: MemoryPlayerRepo }).repo, { master: withPacks(c), rng: seededRng(1), clock: () => Date.now(), verifiers: {} });
    expect((await svc2.commentaryPacks('p')).equipped).toBe('standard');
  });
});

describe('REQ-CMT-010 buying a pack for coins', () => {
  it('spends paid first through the wallet, records ownership, KPI, idempotent with the same key', async () => {
    const w = world();
    await w.svc.bootstrap('p');
    await w.coins('p', 250, 100);
    const r = await w.svc.buyCommentaryPack('p', 'ochitsuki', false, 'c:buy-1');
    expect(r.spent).toEqual({ paid: 100, free: 200 });
    expect(r.wallet).toMatchObject({ paid: 0, free: 50 });
    expect(r.view.packs.find((p) => p.id === 'ochitsuki')).toMatchObject({ owned: true, equipped: false });
    const again = await w.svc.buyCommentaryPack('p', 'ochitsuki', false, 'c:buy-1');
    expect(again).toEqual(r);
    expect((await w.svc.view('p')).wallet).toMatchObject({ paid: 0, free: 50 });
    expect(w.kpi.filter((k) => k.name === 'commentary_pack_buy')).toEqual([expect.objectContaining({ s1: 'ochitsuki', s2: 'any', paidCoins: 100, freeCoins: 200, value: 300 })]);
    const s = await w.svc.state('p');
    expect(s.ledger.filter((l) => l.reason === 'commentary pack ochitsuki').map((l) => l.delta)).toEqual([-100, -200]);
    // a new key for an owned pack: ALREADY_PURCHASED, nothing spent
    await expect(w.svc.buyCommentaryPack('p', 'ochitsuki', false, 'c:buy-2')).rejects.toMatchObject({ code: 'ALREADY_PURCHASED' });
  });
  it('buy + equip in one call emits buy then equip (s3 buy)', async () => {
    const w = world();
    await w.svc.bootstrap('p');
    await w.coins('p', 300);
    const r = await w.svc.buyCommentaryPack('p', 'kofuu', true, 'c:k');
    expect(r.view.equipped).toBe('kofuu');
    expect(w.kpi.filter((k) => k.name.startsWith('commentary_pack_')).map((k) => [k.name, k.s3 ?? null])).toEqual([['commentary_pack_buy', null], ['commentary_pack_equip', 'buy']]);
  });
  it('not enough coins: INSUFFICIENT_COINS with the T6 shortfall, nothing changes, no idempotency record', async () => {
    const w = world();
    await w.svc.bootstrap('p');
    await w.coins('p', 120);
    const e = await w.svc.buyCommentaryPack('p', 'ochitsuki', false, 'c:x').catch((x: AppError) => x);
    expect(e).toBeInstanceOf(AppError);
    expect((e as AppError).code).toBe('INSUFFICIENT_COINS');
    expect(((e as AppError).details as { shortfall?: { shortfall: number } }).shortfall?.shortfall).toBe(180);
    expect((await w.svc.view('p')).wallet.free).toBe(120);
    await w.coins('p', 200);
    await expect(w.svc.buyCommentaryPack('p', 'ochitsuki', false, 'c:x')).resolves.toMatchObject({ packId: 'ochitsuki' });
  });
  it('the standard and the achievement pack are not sold; key required; deletion pending refuses', async () => {
    const w = world();
    await w.svc.bootstrap('p');
    await w.coins('p', 1000);
    await expect(w.svc.buyCommentaryPack('p', 'standard', false, 'c:1')).rejects.toMatchObject({ code: 'NOT_ELIGIBLE' });
    await expect(w.svc.buyCommentaryPack('p', 'nekketsu', false, 'c:2')).rejects.toMatchObject({ code: 'NOT_ELIGIBLE' });
    await expect(w.svc.buyCommentaryPack('p', 'kofuu', false, null)).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REQUIRED' });
    await w.svc.tx('p', null, (s, t) => { s.deletion = { status: 'scheduled', requestedAt: t, purgeAt: t + 1e9 } as never; });
    await expect(w.svc.buyCommentaryPack('p', 'kofuu', false, 'c:3')).rejects.toMatchObject({ code: 'DELETION_PENDING' });
  });
  it('a paid-only pack spends paid coins only', async () => {
    const c = clone();
    c.packs.find((p) => p.id === 'kofuu')!.acquire = { kind: 'coins', price: 300, currency: 'paidOnly' };
    let now = Date.UTC(2026, 11, 10);
    const svc = new PlayerService(new MemoryPlayerRepo(), { master: withPacks(c), rng: seededRng(1), clock: () => now++, verifiers: {} });
    await svc.bootstrap('p');
    await svc.tx('p', null, (s, t) => { grantFree(s, 1000, t, 'g', 'g'); grantPaid(s, 100, 160, t, 'g', 'tx'); });
    const e = await svc.buyCommentaryPack('p', 'kofuu', false, 'c:p').catch((x: AppError) => x);
    expect((e as AppError).code).toBe('INSUFFICIENT_COINS');
    expect(((e as AppError).details as { shortfall?: { coinKind: string } }).shortfall?.coinKind).toBe('paid');
  });
});

describe('REQ-CMT-012 client KPI commentary_pack_sample', () => {
  it('maps packId and owned', () => {
    const b = clientBatchSchema.parse({ platform: 'ios', appVersion: '1', events: [{ name: 'commentary_pack_sample', at: 1, props: { packId: 'kofuu', owned: false } }] });
    expect(b.events.map(clientToKpi)).toEqual([{ name: 'commentary_pack_sample', s1: 'kofuu', s2: 'not_owned' }]);
  });
});

describe('REQ-CMT-011 English', () => {
  it('the packs view has no Japanese left in English', async () => {
    const w = world();
    await w.svc.bootstrap('p');
    const v = localize(await w.svc.commentaryPacks('p'), 'en', catalogFor(m));
    expect(untranslated(v, PLAYER_TEXT_KEYS)).toEqual([]);
    expect(v.packs[1]!.unlock!.label).toBe('Unlocked at tier 1 of the achievement "Race Record"');
    expect(v.packs.map((p) => p.name)).toEqual(['Standard', 'Fired Up', 'Calm Analyst', 'Classic Caller']);
  });
});

describe('HTTP /v1/commentary/* (contracts/protocol.md §36)', () => {
  function ctx() {
    const w = world();
    const invoker: PlayerInvoker = { invoke: (async (method: string, ...args: unknown[]) => (w.svc as unknown as Record<string, (...a: unknown[]) => unknown>)[method]!.apply(w.svc, args)) as PlayerInvoker['invoke'] };
    const c = {
      master: m, authenticate: async (req: Request) => { const u = req.headers.get('x-test-user'); if (!u) throw new AppError('UNAUTHORIZED'); return u; },
      player: () => invoker, friends: makeFriendsService(() => invoker, new MemoryDirectory()), clock: () => Date.now(),
      paidBalance: async () => ({}), adminToken: 'x', parseStoreNotification: async () => null,
    } as unknown as AppContext;
    return { c, w };
  }
  const req = (method: string, path: string, user?: string, body?: unknown, key?: string) => new Request(`https://x${path}`, {
    method, headers: { ...(user ? { 'x-test-user': user } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(key ? { 'idempotency-key': key } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  it('GET, PUT equipped, POST buy (with and without a body); bad bodies 400; auth; key required', async () => {
    const { c, w } = ctx();
    await w.svc.bootstrap('u');
    await w.coins('u', 700);
    expect((await handle(req('GET', '/v1/commentary/packs'), {}, c)).status).toBe(401);
    expect(await (await handle(req('GET', '/v1/commentary/packs', 'u'), {}, c)).json()).toMatchObject({ equipped: 'standard' });
    expect((await handle(req('PUT', '/v1/commentary/equipped', 'u', { packId: 'kofuu' }), {}, c)).status).toBe(409);
    expect((await handle(req('PUT', '/v1/commentary/equipped', 'u', { packId: 'kofuu', extra: 1 }), {}, c)).status).toBe(400);
    expect((await handle(req('PUT', '/v1/commentary/equipped', 'u', { packId: 'kofuu', source: 'gacha' }), {}, c)).status).toBe(400);
    expect((await handle(req('POST', '/v1/commentary/packs/kofuu/buy', 'u'), {}, c)).status).toBe(400); // no idempotency key
    const bought = await handle(req('POST', '/v1/commentary/packs/kofuu/buy', 'u', undefined, 'k1'), {}, c);
    expect(bought.status).toBe(200);
    expect(await bought.json()).toMatchObject({ packId: 'kofuu', spent: { paid: 0, free: 300 }, view: { equipped: 'standard' } });
    const b2 = await handle(req('POST', '/v1/commentary/packs/ochitsuki/buy', 'u', { equip: true }, 'k2'), {}, c);
    expect(await b2.json()).toMatchObject({ view: { equipped: 'ochitsuki' } });
    expect((await handle(req('POST', '/v1/commentary/packs/nope/buy', 'u', {}, 'k3'), {}, c)).status).toBe(404);
    expect((await handle(req('POST', '/v1/commentary/packs/kofuu/buy', 'u', { equip: 'yes' }, 'k4'), {}, c)).status).toBe(400);
    expect(await (await handle(req('PUT', '/v1/commentary/equipped', 'u', { packId: 'kofuu', source: 'shop' }), {}, c)).json()).toMatchObject({ equipped: 'kofuu' });
    expect(await (await handle(req('GET', '/v1/player', 'u'), {}, c)).json()).toMatchObject({ commentaryPack: { equipped: 'kofuu' } });
  });
});
