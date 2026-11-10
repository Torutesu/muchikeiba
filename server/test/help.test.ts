// REQ-HELP-001..024: ヘルプセンター (contracts/protocol.md §48).
import { describe, expect, it } from 'vitest';
import { handle, makeFriendsService, type AppContext, type PlayerInvoker } from '../src/http/app.js';
import { MemoryDirectory } from '../src/domain/friends.js';
import { MemoryPlayerRepo, PlayerService } from '../src/domain/service.js';
import { FakeStoreVerifier } from '../src/domain/purchase.js';
import { seededRng } from '../src/domain/rng.js';
import { AppError } from '../src/domain/errors.js';
import { DEFAULT_RULESET } from '../src/domain/ruleset.js';
import { authenticateAdmin, type AdminAuthConfig } from '../src/ops/admin.js';
import { sha256Hex } from '../src/ops/hash.js';
import { memoryOps } from '../src/ops/memoryOps.js';
import { resolveBundle } from '../src/ops/config.js';
import { untranslated, PLAYER_TEXT_KEYS } from '../src/i18n/catalog.js';
import { hasJapanese } from '../src/i18n/locale.js';
import {
  BASE_HELP, HELP_CATEGORY_IDS, HELP_CONTEXTS, fillTokens, helpArticle, helpFold, helpIndex, helpProblems, redactPersonal, searchHelp,
  type HelpMaster,
} from '../src/domain/help.js';
import { findBanner, oddsDisclosure } from '../src/domain/gacha.js';
import { ACTIVITY_KINDS, ACTIVITY_META } from '../src/domain/activity.js';
import { ACTIVITY_KIND_NAMES, clientBatchSchema, clientToKpi, type KpiRecord } from '../src/domain/kpi.js';
import type { Master } from '../src/domain/master.js';
import type { PlayerState } from '../src/domain/player.js';
import { m } from './helpers.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { helpFoldVectorsJson } from '../src/domain/help.js';

const NOW = Date.UTC(2026, 10, 10, 3);
const TOKENS = { viewer: 'viewer-token-0123456789', operator: 'operator-token-0123456789' };
const clone = (): HelpMaster => structuredClone(BASE_HELP);
const withHelp = (h: HelpMaster): Master => ({ ...m, help: h });

async function setup(opts: { brokenIndex?: boolean } = {}) {
  let now = NOW;
  const store = new FakeStoreVerifier();
  const repo = new MemoryPlayerRepo();
  const kpi: KpiRecord[] = [];
  const svc = new PlayerService(repo, { master: m, rng: seededRng(17), clock: () => now, verifiers: { fake: store }, onKpi: (_id, recs) => { kpi.push(...recs); } });
  let n = 0;
  const buy = (pid: string, productId: string, priceYen: number) =>
    svc.purchase(pid, 'fake', productId, store.issue({ transactionId: `fake:ORDER-${++n}`, productId, purchasedAt: now, priceYen }));
  const invoker: PlayerInvoker = { invoke: (async (method: string, ...args: unknown[]) => (svc as unknown as Record<string, (...a: unknown[]) => unknown>)[method]!.apply(svc, args)) as PlayerInvoker['invoke'] };
  const ops = memoryOps(m, () => invoker);
  let indexDown = opts.brokenIndex ?? false;
  const realUpsert = ops.api.inquiries!.upsert;
  ops.api.inquiries!.upsert = async (items) => { if (indexDown) throw new Error('ops down'); return realUpsert(items); };
  const auth: AdminAuthConfig = { tokens: await Promise.all((Object.keys(TOKENS) as (keyof typeof TOKENS)[]).map(async (name) => ({ name, role: name, sha256: await sha256Hex(TOKENS[name]) }))) };
  const c: AppContext = {
    master: m,
    authenticate: async (req) => { const u = req.headers.get('x-test-user'); if (!u) throw new AppError('UNAUTHORIZED'); return u; },
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
  };
  const call = async (user: string, path: string, init: { method?: string; body?: unknown; key?: string | null; lang?: string } = {}) => {
    const headers: Record<string, string> = { 'x-test-user': user, 'content-type': 'application/json' };
    if (init.key !== undefined && init.key !== null) headers['idempotency-key'] = init.key;
    if (init.lang) headers['accept-language'] = init.lang;
    const res = await handle(new Request(`https://x${path}`, { method: init.method ?? 'GET', headers, ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}) }), {}, c);
    return { status: res.status, body: (await res.json()) as any };
  };
  const admin = async (path: string, who: keyof typeof TOKENS = 'viewer', body?: unknown) => {
    const res = await handle(new Request(`https://x${path}`, {
      method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${TOKENS[who]}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}),
    }), {}, c);
    return { status: res.status, body: (await res.json()) as any };
  };
  const submit = (user: string, key: string, extra: Record<string, unknown> = {}, lang?: string) => call(user, '/v1/help/inquiries', {
    method: 'POST', key, ...(lang ? { lang } : {}),
    body: { category: 'purchase_missing', description: 'コインを買ったのに増えていません。確認をお願いします。', diagnostics: { appVersion: '1.4.0', platform: 'ios' }, ...extra },
  });
  return { svc, repo, kpi, buy, call, admin, submit, ops, setIndexDown: (v: boolean) => { indexDown = v; }, setNow: (t: number) => { now = t; }, now: () => now };
}

describe('help master (REQ-HELP-001..005, REQ-HELP-019)', () => {
  it('the shipped help.json passes every check: eight categories with articles, contexts, links, tokens, wording', () => {
    expect(helpProblems(m)).toEqual([]);
    expect(BASE_HELP.categories.map((c) => c.id)).toEqual([...HELP_CATEGORY_IDS]);
    for (const id of HELP_CATEGORY_IDS) expect(BASE_HELP.articles.some((a) => a.category === id)).toBe(true);
    for (const k of HELP_CONTEXTS) expect(BASE_HELP.articles.map((a) => a.id)).toContain(BASE_HELP.contexts[k]);
    expect(BASE_HELP.contexts.gacha_odds).toBe('pity');
    expect(BASE_HELP.contexts.coin_shortfall).toBe('buy_coins');
  });

  it('rejects links outside the app and the official support site, unknown screens and unknown legal pages', () => {
    const h = clone();
    h.articles[0]!.links = [{ type: 'url', url: 'https://evil.example/x' }, { type: 'url', url: 'http://support.muchi-issen.example/x' }, { type: 'screen', screen: 'casino' as never }, { type: 'legal', doc: 'nda' as never }, { type: 'article', id: 'nope' }];
    const p = helpProblems(withHelp(h), h).join('\n');
    expect(p).toMatch(/official support site/);
    expect(p).toMatch(/must be https/);
    expect(p).toMatch(/unknown screen casino/);
    expect(p).toMatch(/unknown legal page nda/);
    expect(p).toMatch(/unknown article nope/);
  });

  it('rejects ids, categories, lengths, contexts and duplicate articles', () => {
    const h = clone();
    h.articles.push({ ...structuredClone(h.articles[0]!) });
    h.articles[1]!.id = 'Bad Id';
    h.articles[2]!.title.ja = 'あ'.repeat(41);
    h.categories = h.categories.filter((c) => c.id !== 'deletion');
    delete (h.contexts as Record<string, string>).coin_shortfall;
    h.contexts.race_whip = 'ghost';
    const p = helpProblems(withHelp(h), h).join('\n');
    expect(p).toMatch(/duplicate id/);
    expect(p).toMatch(/bad id/);
    expect(p).toMatch(/title\.ja: 1\.\.40/);
    expect(p).toMatch(/missing deletion/);
    expect(p).toMatch(/missing coin_shortfall/);
    expect(p).toMatch(/race_whip: unknown article ghost/);
  });

  it('numbers come from data: hard-coded rates / pity in an article, unknown tokens and ja/en token mismatches are refused', () => {
    const h = clone();
    const pity = h.articles.find((a) => a.id === 'pity')!;
    pity.body.ja = pity.body.ja.replace('{{pity_pulls:standard}}', '100');
    const rates = h.articles.find((a) => a.id === 'scout_rates')!;
    rates.body.en = rates.body.en.replace('{{rate:standard:SSR}}', '3%');
    const buy = h.articles.find((a) => a.id === 'buy_coins')!;
    buy.body.ja += '\n・コインは500円から';
    const whip = h.articles.find((a) => a.id === 'whip')!;
    whip.body.en = whip.body.en.replace('{{max_whips}}', '{{max_whip}}');
    const age = h.articles.find((a) => a.id === 'age_limits')!;
    age.body.ja = age.body.ja.replace('{{monthly_limit:under16}}', '{{monthly_limit:adult}}');
    age.body.en = age.body.en.replace('{{monthly_limit:under16}}', '{{monthly_limit:adult}}');
    const p = helpProblems(withHelp(h), h).join('\n');
    expect(p).toMatch(/pity.ja: scout articles may not carry numbers/);
    expect(p).toMatch(/scout_rates.en: a number with a unit/);
    expect(p).toMatch(/buy_coins.ja: a number with a unit/);
    expect(p).toMatch(/whip: ja and en carry different tokens/);
    expect(p).toMatch(/unknown token max_whip/);
    expect(p).toMatch(/age band adult has no monthly limit/);
  });

  it('refuses shop words, betting words and English wording problems', () => {
    const h = clone();
    h.articles[0]!.body.ja += '\n今だけお得なスカウト';
    h.articles[1]!.body.en += '\nCheck the odds — limited time only';
    h.articles[2]!.title.ja = '馬券の買い方';
    h.articles[3]!.body.en += ' Get double rewards.';
    const p = helpProblems(withHelp(h), h).join('\n');
    expect(p).toMatch(/shop word 「今だけ」/);
    expect(p).toMatch(/shop word 「お得」/);
    expect(p).toMatch(/betting word 馬券/);
    expect(p).toMatch(/betting word .*odds/);
    expect(p).toMatch(/limited/);
    expect(p).toMatch(/double/);
  });

  it('remote config replaces the help (checked against that version): a banner an article quotes cannot be removed', () => {
    const h = clone();
    h.articles[0]!.title.ja = '最初の遊び方（改訂）';
    const r = resolveBundle(m, { help: h as unknown as Record<string, unknown> });
    expect(helpIndex(r.master, 'ja').articles[0]!.title).toBe('最初の遊び方（改訂）');
    const bad = clone();
    bad.articles.find((a) => a.id === 'pity')!.body.ja += '{{rate:winter_9999:SSR}}';
    expect(() => resolveBundle(m, { help: bad as unknown as Record<string, unknown> })).toThrow(/unknown banner winter_9999/);
    // a gacha change that drops the standard banner breaks the scout articles → the version is refused
    const banners = m.gacha.daySchedules ? Object.values(m.gacha.daySchedules.banners).filter((b) => b.id !== 'standard') : [];
    if (banners.length) expect(() => resolveBundle(m, { gacha: { banners: banners as never } })).toThrow(/help\.articles/);
  });
});

describe('reading articles (REQ-HELP-001/004/005/008)', () => {
  it('fills tokens from the same data as the rates screen, in each language', () => {
    const d = oddsDisclosure(m, findBanner(m, 'standard'));
    const ja = helpArticle(m, 'pity', 'ja');
    expect(ja.body).toContain(`${d.pity.pullsRequired}回分`);
    expect(ja.body).toContain(`${d.pity.costCoins.toLocaleString('en-US')}コイン`);
    const rates = helpArticle(m, 'scout_rates', 'en');
    expect(rates.body).toContain(`SSR is ${d.rarityTotals.SSR!.rate}`);
    expect(rates.body).toContain(`SSR ${d.guarantee.rarityTotals.SSR!.rate}`);
    expect(helpArticle(m, 'whip', 'ja', 9).body).toContain('9回まで');
    for (const a of BASE_HELP.articles) {
      for (const lang of ['ja', 'en'] as const) {
        const v = helpArticle(m, a.id, lang);
        expect(v.body).not.toMatch(/\{\{|\}\}/);
        if (lang === 'en') expect(untranslated(v)).toEqual([]);
      }
    }
  });

  it('links carry labels: screens, legal pages (特商法・資金決済法) and the support site', () => {
    const v = helpArticle(m, 'buy_coins', 'ja');
    expect(v.links).toEqual(expect.arrayContaining([
      { type: 'legal', doc: 'shikin', label: '資金決済法に基づく表示' },
      { type: 'legal', doc: 'tokushoho', label: '特定商取引法に基づく表記' },
      expect.objectContaining({ type: 'screen', screen: 'shop' }),
    ]));
    expect(helpArticle(m, 'refunds', 'en').links).toContainEqual({ type: 'url', url: 'https://support.muchi-issen.example/refunds', label: 'Official support site' });
    expect(helpArticle(m, 'pity', 'ja').related).toEqual([{ id: 'scout_rates', title: 'スカウトの提供割合' }]);
  });

  it('a switched-off help center lists nothing (articles 404)', () => {
    const h = clone();
    h.config.enabled = false;
    expect(helpIndex(withHelp(h), 'ja')).toMatchObject({ enabled: false, categories: [], articles: [] });
    expect(() => helpArticle(withHelp(h), 'pity', 'ja')).toThrow(/article pity/);
  });
});

describe('search (REQ-HELP-006)', () => {
  it('folds hiragana / katakana / half-width forms and small kana the same way', () => {
    expect(helpFold('てんじょう')).toBe(helpFold('テンジョウ'));
    expect(helpFold('ﾃﾝｼﾞｮｳ')).toBe(helpFold('てんじょう'));
    expect(helpFold('ＰＩＴＹ')).toBe('pity');
    for (const q of ['てんじょう', 'テンジョウ', 'ﾃﾝｼﾞｮｳ', '天井']) expect(searchHelp(m, q, null, null, 'ja').items[0]!.id).toBe('pity');
    expect(searchHelp(m, 'PITY', null, null, 'en').items[0]!.id).toBe('pity');
  });

  it('the shared fold vectors (C# HelpText.Fold reads the same file) are current', () => {
    expect(readFileSync(join(import.meta.dirname, '../../contracts/help-fold.vectors.json'), 'utf8')).toBe(helpFoldVectorsJson());
  });

  it('Round 17 integration: articles for hosted cups, the season recap and the stable organiser (JA and EN)', () => {
    expect(searchHelp(m, 'カップ', null, null, 'ja').items[0]!.id).toBe('hosted_cups');
    expect(searchHelp(m, 'ふりかえり', null, null, 'ja').items[0]!.id).toBe('season_recap');
    expect(searchHelp(m, 'まとめて引退', null, null, 'ja').items[0]!.id).toBe('roster_organiser');
    expect(searchHelp(m, 'hosted cup', null, null, 'en').items[0]!.id).toBe('hosted_cups');
    expect(searchHelp(m, 'recap', null, null, 'en').items[0]!.id).toBe('season_recap');
    expect(searchHelp(m, 'lock', null, null, 'en').items.map((x) => x.id)).toContain('roster_organiser');
  });
  it('every word must match; title beats keyword beats body; category filter; snippet', () => {
    const r = searchHelp(m, 'コイン 返金', null, null, 'ja');
    expect(r.items[0]!.id).toBe('refunds');
    expect(r.items.every((x) => x.category === 'purchases' || x.category === 'account' || x.category === 'deletion' || x.category === 'getting_started')).toBe(true);
    expect(searchHelp(m, 'コイン', 'scout', null, 'ja').items.every((x) => x.category === 'scout')).toBe(true);
    expect(searchHelp(m, 'ぜったいにないことば', null, null, 'ja')).toMatchObject({ items: [], total: 0 });
    expect(r.items[0]!.snippet.length).toBeLessThanOrEqual(60);
    expect(searchHelp(m, 'ムチ', null, 1, 'ja').items).toHaveLength(1);
  });

  it('query length and parameters are checked; the response only echoes the normalised length', () => {
    expect(() => searchHelp(m, '  ', null, null, 'ja')).toThrow(/q must be/);
    expect(() => searchHelp(m, 'あ'.repeat(41), null, null, 'ja')).toThrow(/q must be/);
    expect(() => searchHelp(m, 'ムチ', 'casino', null, 'ja')).toThrow(/unknown category/);
    expect(() => searchHelp(m, 'ムチ', null, 99, 'ja')).toThrow(/limit/);
    const r = searchHelp(m, 'てんじょう', null, null, 'ja');
    expect(JSON.stringify(r)).not.toContain('てんじょう');
    expect(r.query).toEqual({ length: 5 }); // テンジヨウ (small kana folded)
  });
});

describe('HTTP: help index, article, search, feedback (REQ-HELP-001/007/021)', () => {
  it('answers in the requested language (Japanese master text never leaks into English)', async () => {
    const x = await setup();
    const ja = await x.call('u1', '/v1/help');
    expect(ja.status).toBe(200);
    expect(ja.body.categories.find((c: any) => c.id === 'scout').title).toBe('スカウト（提供割合・天井）');
    expect(ja.body.inquiry.diagnosticsNote).toMatch(/アプリの版/);
    const en = await x.call('u1', '/v1/help?lang=en');
    expect(en.body.lang).toBe('en');
    expect(untranslated(en.body)).toEqual([]);
    const art = await x.call('u1', '/v1/help/articles/pity', { lang: 'en' });
    expect(art.body.title).toBe('How the pity (exchange points) works');
    expect((await x.call('u1', '/v1/help/articles/nope')).status).toBe(404);
    const s = await x.call('u1', `/v1/help/search?q=${encodeURIComponent('ﾃﾝｼﾞｮｳ')}`);
    expect(s.body.items[0].id).toBe('pity');
    expect((await x.call('u1', '/v1/help/search?q=a&evil=1')).status).toBe(400);
  });

  it('feedback: one vote per article, changeable, KPI only when it changes, capped per game day', async () => {
    const x = await setup();
    const v1 = await x.call('u1', '/v1/help/articles/pity/feedback', { method: 'POST', body: { helpful: true } });
    expect(v1.body).toEqual({ articleId: 'pity', helpful: true, changed: true });
    const v2 = await x.call('u1', '/v1/help/articles/pity/feedback', { method: 'POST', body: { helpful: true } });
    expect(v2.body.changed).toBe(false);
    const v3 = await x.call('u1', '/v1/help/articles/pity/feedback', { method: 'POST', body: { helpful: false } });
    expect(v3.body.changed).toBe(true);
    expect(x.kpi.filter((k) => k.name === 'help_feedback').map((k) => [k.s1, k.s2, k.value])).toEqual([['pity', 'scout', 1], ['pity', 'scout', 0]]);
    expect((await x.call('u1', '/v1/help/articles/nope/feedback', { method: 'POST', body: { helpful: true } })).status).toBe(404);
    expect((await x.call('u1', '/v1/help/articles/pity/feedback', { method: 'POST', body: { helpful: true, extra: 1 } })).status).toBe(400);
    // the daily cap (50 changes)
    let last = 200;
    for (let i = 0; i < 60 && last === 200; i++) last = (await x.call('u1', '/v1/help/articles/whip/feedback', { method: 'POST', body: { helpful: i % 2 === 0 } })).status;
    expect(last).toBe(429);
    x.setNow(NOW + 86_400_000);
    expect((await x.call('u1', '/v1/help/articles/whip/feedback', { method: 'POST', body: { helpful: true } })).status).toBe(200);
  });

  it('client KPI events: help_search keeps the length / category / count only, help_article_view the id and entry', () => {
    const b = clientBatchSchema.parse({ platform: 'ios', appVersion: '1', events: [
      { name: 'help_search', at: 1, props: { length: 4, category: 'all', results: 3 } },
      { name: 'help_article_view', at: 2, props: { articleId: 'pity', source: 'context' } },
    ] });
    expect(b.events.map(clientToKpi)).toEqual([{ name: 'help_search', s1: 'all', value: 4, count: 3 }, { name: 'help_article_view', s1: 'pity', s2: 'context' }]);
    expect(clientBatchSchema.safeParse({ platform: 'ios', appVersion: '1', events: [{ name: 'help_search', at: 1, props: { length: 4, category: 'all', results: 3, query: 'てんじょう' } }] }).success).toBe(false);
  });
});

describe('inquiries (REQ-HELP-009..018)', () => {
  it('submit needs a key; the same key returns the same ticket; history rows are copied; diagnostics are what support needs', async () => {
    const x = await setup();
    await x.buy('u1', 'coin_480', 480);
    await x.svc.draw('u1', 'standard', 1, 'c:d1');
    expect((await x.call('u1', '/v1/help/inquiries', { method: 'POST', body: { category: 'bug', description: '0123456789ab', diagnostics: { appVersion: '1', platform: 'ios' } } })).status).toBe(400);
    const hist = (await x.svc.history('u1', 'purchases')) as { items: { ref: string }[] };
    const gacha = (await x.svc.history('u1', 'gacha')) as { items: { ref: string }[] };
    const refs = [hist.items[0]!.ref, gacha.items[0]!.ref];
    const t1 = await x.submit('u1', 'c:q1', { refs });
    expect(t1.status).toBe(200);
    expect(t1.body).toMatchObject({ ticketId: 'q_1', category: 'purchase_missing', status: 'received', statusText: '受付済み', lang: 'ja', unread: false, messages: [] });
    expect(t1.body.attachments.map((a: any) => a.ref)).toEqual(refs);
    expect(t1.body.attachments[0]).toMatchObject({ kind: 'purchase', title: expect.any(String), detail: expect.stringMatching(/¥480/) });
    expect(t1.body.diagnostics).toEqual({ appVersion: '1.4.0', platform: 'ios', playerId: 'u1', lastRaceIds: [] });
    expect(JSON.stringify(t1.body)).not.toMatch(/ORDER-|txId|fake:/);
    const again = await x.submit('u1', 'c:q1', { refs });
    expect(again.body.ticketId).toBe('q_1');
    expect((await x.call('u1', '/v1/help/inquiries')).body.items).toHaveLength(1);
    expect(x.kpi.filter((k) => k.name === 'inquiry_submit').map((k) => [k.s1, k.count])).toEqual([['purchase_missing', 2]]);
    // other players' or unknown references are not found; extra diagnostics keys are refused
    expect((await x.submit('u2', 'c:q9', { refs })).status).toBe(404);
    expect((await x.submit('u1', 'c:q10', { diagnostics: { appVersion: '1', platform: 'ios', deviceModel: 'iPhone' } })).status).toBe(400);
    expect((await x.submit('u1', 'c:q11', { description: '短い' })).status).toBe(400);
  });

  it('personal data in the text is replaced before storing', () => {
    expect(redactPersonal('連絡は taro@example.com か 090-1234-5678 へ。カード 4111 1111 1111 1111').text).toBe('連絡は ［削除しました］ か ［削除しました］ へ。カード ［削除しました］');
    expect(redactPersonal('C-120 と P-1A2B3C4D、コイン1,020枚').n).toBe(0);
  });

  it('rate limits: the minimum interval, open tickets and the daily count (429 with retryAt)', async () => {
    const x = await setup();
    expect((await x.submit('u1', 'c:a')).status).toBe(200);
    const fast = await x.submit('u1', 'c:b');
    expect(fast.status).toBe(429);
    expect(fast.body.error.details).toMatchObject({ reason: 'interval', retryAt: NOW + 60_000 });
    x.setNow(NOW + 61_000);
    expect((await x.submit('u1', 'c:b')).status).toBe(200);
    x.setNow(NOW + 122_000);
    expect((await x.submit('u1', 'c:c')).status).toBe(200);
    x.setNow(NOW + 183_000);
    const open = await x.submit('u1', 'c:d');
    expect(open.status).toBe(429);
    expect(open.body.error.details.reason).toBe('open');
    const list = await x.call('u1', '/v1/help/inquiries');
    expect(list.body.limits).toMatchObject({ openMax: 3, open: 3, perDay: 5, today: 3 });
  });

  it('a deleting account cannot send; the ops index has no text; a reply answers, notifies once and counts as unread', async () => {
    const x = await setup();
    const t = await x.submit('u1', 'c:a', { description: '購入したコインが届きません。メールは taro@example.com です。' });
    expect(t.body.redacted).toBe(1);
    expect(t.body.inquiryText).not.toContain('taro@');
    // ops: list (no text), detail, reply
    const list = await x.admin('/v1/admin/inquiries?status=received');
    expect(list.status).toBe(200);
    expect(list.body.items).toEqual([{ ticketId: 'q_1', playerId: 'u1', category: 'purchase_missing', status: 'received', lang: 'ja', attachments: 0, createdAt: NOW, updatedAt: NOW }]);
    const detail = await x.admin('/v1/admin/players/u1/inquiries/q_1');
    expect(detail.body).toMatchObject({ playerId: 'u1', ticketId: 'q_1', indexed: true, inquiryText: expect.stringContaining('［削除しました］') });
    expect((await x.admin('/v1/admin/players/u1/inquiries/q_1/reply', 'viewer', { opKey: 'r-1', content: 'x', reason: 'answer' })).status).toBe(403);
    x.setNow(NOW + 3_600_000);
    const rep = await x.admin('/v1/admin/players/u1/inquiries/q_1/reply', 'operator', { opKey: 'reply-q1-1', content: '確認しました。コインを付与しました。', reason: 'answer the ticket' });
    expect(rep.status).toBe(200);
    expect(rep.body).toMatchObject({ status: 'answered', replies: 1, duplicate: false });
    const dup = await x.admin('/v1/admin/players/u1/inquiries/q_1/reply', 'operator', { opKey: 'reply-q1-1', content: '確認しました。コインを付与しました。', reason: 'retry' });
    expect(dup.body).toMatchObject({ replies: 1, duplicate: true });
    expect((await x.admin('/v1/admin/inquiries?status=answered')).body.items[0]).toMatchObject({ ticketId: 'q_1', status: 'answered' });
    expect(x.kpi.filter((k) => k.name === 'inquiry_answered').map((k) => k.durationMs)).toEqual([3_600_000]);
    // the player sees it: badge, list, detail, activity entry (once)
    expect((await x.svc.view('u1')).help).toEqual({ unreadReplies: 1 });
    const mine = await x.call('u1', '/v1/help/inquiries');
    expect(mine.body).toMatchObject({ unread: 1, items: [{ ticketId: 'q_1', status: 'answered', statusText: '回答済み', unread: true }] });
    const act = await x.call('u1', '/v1/activity');
    expect(act.body.items.filter((i: any) => i.kind === 'inquiry_answered')).toEqual([expect.objectContaining({ category: 'support', link: { screen: 'help_inquiry', id: 'q_1' }, text: 'お問い合わせに運営から返信がありました' })]);
    const en = await x.call('u1', '/v1/help/inquiries/q_1', { lang: 'en' });
    expect(en.body.messages[0].messageText).toBe('確認しました。コインを付与しました。'); // a person's words are never translated
    expect(en.body.statusText).toBe('Answered');
    expect(untranslated(en.body, PLAYER_TEXT_KEYS)).toEqual([]);
    expect((await x.call('u1', '/v1/activity', { lang: 'en' })).body.items.find((i: any) => i.kind === 'inquiry_answered').text).toBe('Support replied to your inquiry');
    expect((await x.call('u1', '/v1/help/inquiries/q_1/read', { method: 'POST' })).body).toEqual({ ticketId: 'q_1', unread: false, unreadTotal: 0 });
    expect((await x.call('u1', '/v1/help/inquiries/q_1/read', { method: 'POST' })).body.unreadTotal).toBe(0);
    // close, then no more replies
    await x.admin('/v1/admin/players/u1/inquiries/q_1/reply', 'operator', { opKey: 'reply-q1-2', content: 'これで完了とします。', close: true, reason: 'close' });
    expect((await x.admin('/v1/admin/players/u1/inquiries/q_1/reply', 'operator', { opKey: 'reply-q1-3', content: 'もう一度', reason: 'again' })).status).toBe(409);
    expect((await x.call('u2', '/v1/help/inquiries/q_1')).status).toBe(404);
    // deletion in progress: no new inquiry
    const s = x.repo.get('u1') as PlayerState;
    s.deletion = { ...(s.deletion ?? {}), status: 'deleting' } as PlayerState['deletion'];
    x.repo.put(s);
    x.setNow(NOW + 7_200_000);
    expect((await x.submit('u1', 'c:z')).status).toBe(403);
  });

  it('an index write that failed is repeated when the player opens the list; a deleted account leaves the index', async () => {
    const x = await setup({ brokenIndex: true });
    expect((await x.submit('u1', 'c:a')).status).toBe(200);
    expect((await x.admin('/v1/admin/inquiries')).body.items).toEqual([]);
    x.setIndexDown(false);
    await x.call('u1', '/v1/help/inquiries');
    expect((await x.admin('/v1/admin/inquiries')).body.items.map((i: any) => i.ticketId)).toEqual(['q_1']);
    expect((await x.svc.state('u1') as PlayerState & { help: { tickets: { indexed: boolean }[] } }).help.tickets[0]!.indexed).toBe(true);
    x.repo.delete('u1');
    expect((await x.admin('/v1/admin/players/u1/inquiries/q_1')).status).toBe(404);
    expect((await x.admin('/v1/admin/inquiries')).body.items).toEqual([]);
  });

  it('the activity kind is wired like the others (no push category: no push)', () => {
    expect(ACTIVITY_KINDS).toContain('inquiry_answered');
    expect([...ACTIVITY_KIND_NAMES]).toEqual([...ACTIVITY_KINDS]);
    expect(ACTIVITY_META.inquiry_answered).toEqual({ category: 'support', screen: 'help_inquiry', collapse: false });
  });

  it('English help responses keep the player text untouched and have no Japanese elsewhere', async () => {
    const x = await setup();
    const t = await x.submit('u1', 'c:a', {}, 'en');
    expect(t.body.lang).toBe('en');
    expect(t.body.categoryTitle).toBe('Bought but not received');
    expect(hasJapanese(t.body.inquiryText)).toBe(true);
    expect(untranslated(t.body, PLAYER_TEXT_KEYS)).toEqual([]);
    expect(fillTokens({ m, maxWhips: 6 }, '{{deletion_days}}')).toBe('14');
  });
});
