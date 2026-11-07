// REQ-L10N-001..012: the English locale end to end (contracts/protocol.md §23).
import { describe, expect, it } from 'vitest';
import { handle, makeFriendsService, type AppContext, type PlayerInvoker } from '../src/http/app.js';
import { MemoryDirectory } from '../src/domain/friends.js';
import { MemoryPlayerRepo, PlayerService } from '../src/domain/service.js';
import { FakeStoreVerifier } from '../src/domain/purchase.js';
import { seededRng } from '../src/domain/rng.js';
import { AppError } from '../src/domain/errors.js';
import { resolveBundle } from '../src/ops/config.js';
import { localeFromAcceptLanguage, parseLocale, resolveLocale, hasJapanese } from '../src/i18n/locale.js';
import { catalogFor, compileCatalog, enWordingProblems, localize, tableProblems, translateText, untranslated } from '../src/i18n/catalog.js';
import { CODE_EN } from '../src/i18n/en.js';
import { localeProblems, masterTexts } from '../src/i18n/validate.js';
import { bannerList, carryOverRule, oddsDisclosure } from '../src/domain/gacha.js';
import { ticketDisclosure } from '../src/domain/itemShop.js';
import { stampCatalog } from '../src/domain/teamFeed.js';
import { shareLinks } from '../src/domain/invite.js';
import { skillCatalog, conditionText, effectText } from '../src/domain/skills.js';
import { shopProducts } from '../src/domain/shop.js';
import { enqueuePush, messageFor, pushPrefsView, registerDevice, renderTemplate, takeDuePushes } from '../src/domain/push.js';
import { deliverDuePushes } from '../src/push/dispatch.js';
import { freshPlayer, m } from './helpers.js';

const NOW = Date.UTC(2026, 10, 5, 3);
const cat = catalogFor(m);
const en = <T>(v: T) => localize(v, 'en', cat);
/** Player-written values: they stay as typed (display names, horse names chosen by the player, team names). */
const PLAYER_TEXT = new Set(['displayName', 'teamName', 'plateName', 'key', 'voiceName']);

function ctx() {
  const svc = new PlayerService(new MemoryPlayerRepo(), { master: m, rng: seededRng(3), clock: () => NOW, verifiers: { fake: new FakeStoreVerifier() } });
  const invoker: PlayerInvoker = { invoke: (async (method: string, ...args: unknown[]) => (svc as unknown as Record<string, (...a: unknown[]) => unknown>)[method]!.apply(svc, args)) as PlayerInvoker['invoke'] };
  const c: AppContext = {
    master: m,
    authenticate: async (req) => { const u = req.headers.get('x-test-user'); if (!u) throw new AppError('UNAUTHORIZED'); return u; },
    player: () => invoker,
    match: { enqueue: async () => ({}), cancel: async () => ({}), status: async () => ({ state: 'none' }), friendCreate: async () => ({}), friendJoin: async () => ({}), friendStart: async () => ({}), tutorial: async () => ({}), friendMember: async () => false },
    friends: makeFriendsService(() => invoker, new MemoryDirectory()),
    leaderboard: { board: async (season, board) => ({ season, board }), myRank: async (p, season) => ({ p, season }) },
    timeAttack: {} as AppContext['timeAttack'],
    clock: () => NOW,
    race: { websocket: async () => new Response(null), report: async () => ({}), replay: async () => ({}) },
    paidBalance: async () => ({}), adminToken: 'x', parseStoreNotification: async () => null,
  };
  return { c, svc };
}
const get = async (c: AppContext, path: string, headers: Record<string, string> = {}, method = 'GET', body?: unknown) => {
  const r = await handle(new Request(`https://x${path}`, { method, headers: { 'x-test-user': 'u1', 'content-type': 'application/json', 'idempotency-key': 'c:k-' + path, ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) }), {}, c);
  return { status: r.status, lang: r.headers.get('content-language'), body: await r.json() as unknown };
};

describe('locale of a request (REQ-L10N-001)', () => {
  it('?lang= first, then Accept-Language by q, default ja', () => {
    expect(parseLocale('en-US')).toBe('en');
    expect(parseLocale('EN_gb')).toBe('en');
    expect(parseLocale('fr')).toBeNull();
    expect(localeFromAcceptLanguage('fr-FR, en;q=0.8, ja;q=0.9')).toBe('ja');
    expect(localeFromAcceptLanguage('fr, en-GB;q=0.5')).toBe('en');
    expect(localeFromAcceptLanguage('en;q=0, *')).toBeNull();
    const r = (u: string, al?: string) => resolveLocale(new Request(u, al ? { headers: { 'accept-language': al } } : {}));
    expect(r('https://x/v1/skills')).toBe('ja');
    expect(r('https://x/v1/skills', 'en-US,en;q=0.9')).toBe('en');
    expect(r('https://x/v1/skills?lang=ja', 'en')).toBe('ja');
    expect(r('https://x/v1/skills?lang=en', 'ja')).toBe('en');
    expect(r('https://x/v1/skills?lang=xx', 'en')).toBe('en');
  });
});

describe('string tables (REQ-L10N-004/008)', () => {
  it('every player-facing Japanese master text has English; both tables pass the checks', () => {
    expect(localeProblems(m)).toEqual([]);
    expect(tableProblems(CODE_EN, 'code')).toEqual([]);
    expect(masterTexts(m).length).toBeGreaterThan(200);
    for (const { text } of masterTexts(m)) expect(hasJapanese(translateText(text, cat) ?? text), text).toBe(false);
  });
  it('the English wording lint refuses multipliers and fake urgency', () => {
    for (const bad of ['2x coins', 'Coins x2', 'Double rewards', 'Limited time only!', 'Limited-time offer', 'Hurry, ends soon', '30% off', 'Regular price ¥960', 'Free gacha', 'Last chance'])
      expect(enWordingProblems(bad), bad).not.toEqual([]);
    for (const good of ['100 free coins', 'Season-exclusive silks pattern "Flame"', 'Scout Ticket ×1', 'Paid coins are used first', 'Valid until the end of the season'])
      expect(enWordingProblems(good.replace('×1', '')), good).toEqual([]);
    expect(tableProblems({ 'コイン2倍': 'Double coins' }, 't').join()).toMatch(/wording/);
    expect(tableProblems({ '残り{v}m': '{n} m to go' }, 't').join()).toMatch(/placeholders differ/);
    expect(tableProblems({ 'ナイス！': 'ナイス' }, 't').join()).toMatch(/contains Japanese/);
  });
  it('templates capture numbers only where a number belongs, and translate captured names', () => {
    const c = compileCatalog({ '残り{v}m': '{v} m to go', 'ピックアップ': 'Pickup', '{item}×{qty}': '{item} ×{qty}' });
    expect(translateText('残り200m', c)).toBe('200 m to go');
    expect(translateText('残りわずかm', c)).toBeNull();
    expect(translateText('ピックアップ×2', c)).toBe('Pickup ×2');
    expect(translateText('Already English', c)).toBe('Already English');
    expect(translateText('脚を2.5%回復、4秒間 目標速度+1.5%・加速+20%', cat)).toBe('recovers 2.5% stamina, for 4 s: target speed +1.5%, acceleration +20%');
  });

  it('QA R11: names players typed are never translated, even when they equal a table entry', () => {
    // a player may call themselves 「決勝」 or name a branch 「フレンド」: those are table keys, but they are names here
    const body = {
      displayName: '決勝', teamName: 'フレンド', plateName: '支部の応援', ownerName: '大会の覇者', opponentName: '坂路', inviterName: 'ミメイ', inviteeName: 'プール',
      fromName: 'ウッド', byName: '併せ馬', anonName: '決勝', friends: [{ displayName: '大会の覇者' }],
      name: '決勝', title: '坂路', // master / server texts stay translated
    };
    const out = localize(body, 'en', cat);
    expect(out).toMatchObject({
      displayName: '決勝', teamName: 'フレンド', plateName: '支部の応援', ownerName: '大会の覇者', opponentName: '坂路', inviterName: 'ミメイ', inviteeName: 'プール',
      fromName: 'ウッド', byName: '併せ馬', anonName: '決勝', friends: [{ displayName: '大会の覇者' }],
    });
    expect(out.name).toBe('Final');
    expect(out.title).toBe('Hill Course');
  });
});

describe('remote config needs English for its new texts (REQ-L10N-005)', () => {
  const ev = () => ({ ...(m.events[0] as unknown as Record<string, unknown>), id: 'night_cup', name: '月夜杯', startAtMs: Date.UTC(2027, 0, 1), endAtMs: Date.UTC(2027, 0, 8) });
  it('a new event without English is refused; with English accepted and served', () => {
    expect(() => resolveBundle(m, { events: [...m.events as never[], ev()] })).toThrow(/no English for events\[night_cup\]\.name「月夜杯」/);
    const { master } = resolveBundle(m, { events: [...m.events as never[], ev()], locale: { en: { '月夜杯': 'Moonlight Cup' } } });
    expect(translateText('月夜杯', catalogFor(master))).toBe('Moonlight Cup');
    expect(translateText('月夜杯', catalogFor(m))).toBeNull(); // the base catalog is not changed
  });
  it('the English of a version passes the same wording lint', () => {
    expect(() => resolveBundle(m, { events: [...m.events as never[], ev()], locale: { en: { '月夜杯': 'Moonlight Cup — limited time only!' } } })).toThrow(/wording/);
  });
});

describe('server-built texts in English (REQ-L10N-002/003)', () => {
  it('shop display, odds pages, ticket pages, carry-over, skills, stamps, invite share text, deletion notice', () => {
    const s = freshPlayer('p', NOW);
    const all: unknown[] = [
      shopProducts(m, { s, now: NOW }),
      bannerList(m, NOW),
      ...m.gacha.banners.map((b) => oddsDisclosure(m, b)),
      ...Object.keys(m.items.tickets).map((id) => ticketDisclosure(m, id)),
      ...Object.keys(m.gacha.pityGroups).map((g) => carryOverRule(m, g)),
      skillCatalog(m),
      stampCatalog(m, s),
      shareLinks(m.progression.invite!, 'ABCD2345', 'ミドリカワ'),
    ];
    for (const v of all) expect(untranslated(en(v), new Set(['text']))).toEqual([]); // the share text keeps the inviter's own name
    expect(en(shareLinks(m.progression.invite!, 'ABCD2345', 'Midori')).text).toMatch(/^Midori invites you to "Muchi Issen"\. Enter the invite code ABCD-2345/);
    // every trigger and effect the engine can express
    for (const d of m.skills.skills) {
      expect(hasJapanese(translateText(conditionText(d), cat) ?? '日'), conditionText(d)).toBe(false);
      expect(hasJapanese(translateText(effectText(d), cat) ?? '日'), effectText(d)).toBe(false);
    }
    const shop = en(shopProducts(m));
    const pass = shop.products.find((p) => p.id === 'season_pass')!;
    expect(pass.name).toBe('Season Pass');
    expect(pass.contents[0]!.label).toMatch(/^Season Pass premium track: \d+ tiers \(each tier: /);
    expect(shop.products.find((p) => p.id === 'coin_480')!.firstPurchaseBonus!.label).toBe('First purchase only: 310 free coins included');
    expect(shop.legalLinks.map((l) => l.title)).toEqual(['Specified Commercial Transactions Act notice (Japanese)', 'Payment Services Act notice (Japanese)', 'Order in which paid coins are used']);
    // the English never adds a multiplier or urgency the Japanese does not have
    expect(JSON.stringify(shop)).not.toMatch(/double|2x|limited time|hurry|% off/i);
  });
});

describe('HTTP responses in English (REQ-L10N-002/006)', () => {
  it('?lang=en and Accept-Language: every Japanese text of the player screens is translated; ja is unchanged', async () => {
    const { c, svc } = ctx();
    await svc.bootstrap('u1');
    await svc.recordConsent('u1', m.progression.consent!.termsVersion, m.progression.consent!.privacyVersion);
    await svc.grantPartner('u1', 'ミドリ', 'c:g1');
    await svc.tutorialDraw('u1', 'c:t1');
    await svc.claimLogin('u1', 'c:l1');
    const horses = (await svc.view('u1')).horses;
    const paths = [
      '/v1/config', '/v1/visuals', '/v1/player', '/v1/shop/products?mine=1', '/v1/shop/offers', '/v1/shop/allowance', '/v1/skills',
      '/v1/gacha/banners', '/v1/gacha/status', ...bannerList(m, NOW).banners.map((b) => `/v1/gacha/${b.id}/odds`), '/v1/horses',
      `/v1/horses/${horses[0]!.id}/pedigree`, '/v1/bond', '/v1/presets', '/v1/items/tickets', ...Object.keys(m.items.tickets).map((t) => `/v1/items/tickets/${t}/odds`),
      '/v1/shop/cosmetics', '/v1/missions', '/v1/comeback', '/v1/whats-new', '/v1/season-pass', '/v1/titles', '/v1/stats', '/v1/ads', '/v1/push/preferences',
    ];
    for (const p of paths) {
      const ja = await get(c, p);
      const viaQuery = await get(c, p + (p.includes('?') ? '&' : '?') + 'lang=en');
      const viaHeader = await get(c, p, { 'accept-language': 'en-US,en;q=0.9' });
      expect(ja.status, p).toBe(200);
      expect(viaQuery.lang, p).toBe('en');
      // the partner's name is the player's own katakana (the clients show it romanized in English, Romaji.cs / app.js)
      expect(untranslated(viaQuery.body, PLAYER_TEXT).filter((x) => !x.endsWith(': ミドリ')), p).toEqual([]);
      expect(viaHeader.body, p).toEqual(viaQuery.body);
      expect(ja.lang, p).toBe('ja');
    }
    // Japanese stays what the domain renders
    expect(JSON.stringify((await get(c, '/v1/skills')).body)).toMatch(/固有スキル/);
    // the deletion confirmation lists what is lost, in English
    const del = await get(c, '/v1/player?lang=en', {}, 'DELETE');
    expect((del.body as { notice: string }).notice).toMatch(/^Once confirmed, your account and all of its data are deleted after \d+ days\. You can cancel/);
    // a player-facing error detail
    const bad = await get(c, `/v1/horses/${horses[0]!.id}/name?lang=en`, {}, 'PUT', { name: 'ab' });
    expect(bad.status).toBe(400);
    expect(untranslated(bad.body)).toEqual([]);
  });
});

describe('push in the device language (REQ-L10N-007)', () => {
  it('each device gets its own language; topics follow the language', async () => {
    const s = freshPlayer('p', NOW);
    registerDevice(m, s, 'token-ja-000', 'ios', NOW);
    registerDevice(m, s, 'token-en-000', 'android', NOW, 'en');
    expect(enqueuePush(m, s, 'tournament_heat_soon', { tournament: '青葉スプリント杯', minutes: '10', round: '決勝' }, Date.UTC(2026, 10, 5, 3)).status).toBe('queued');
    const { due } = takeDuePushes(m, s, Date.UTC(2026, 10, 5, 3));
    expect(due).toHaveLength(1);
    expect(messageFor(due[0]!, 'token-ja-000').body).toBe('「青葉スプリント杯」の決勝が10分後に始まります');
    expect(messageFor(due[0]!, 'token-en-000')).toMatchObject({ title: 'Final starting soon', body: '"Aoba Sprint Cup" Final starts in 10 min' });
    const sent: [string, string][] = [];
    await deliverDuePushes({ take: async () => ({ due, expired: 0 }), settle: async () => ({ sent: 2, pruned: 0, retried: 0, dropped: 0, pending: 0, nextAt: null }) }, 'p', { send: async (t: string, msg: { title: string }) => { sent.push([t, msg.title]); return { kind: 'ok' }; }, sendTopic: async () => ({ kind: 'ok' }) } as never);
    expect(sent).toEqual([['token-ja-000', 'まもなく決勝'], ['token-en-000', 'Final starting soon']]);
    expect(renderTemplate(m.push.templates.season_start!, 'season_start', { season: '2026年12月' }, 'en', m).body).toBe('The 2026/12 season has started. Go for a promotion!');
    // a player-written name stays as written
    expect(renderTemplate(m.push.templates.friend_request!, 'friend_request', { name: 'ミドリ' }, 'en', m).body).toBe('ミドリ sent you a friend request');
    expect(pushPrefsView(m, s, 'en').topics).toEqual({ subscribe: ['season_en', 'events_en'], unsubscribe: ['season_ja', 'events_ja'] });
    expect(pushPrefsView(m, s, 'ja').topics).toEqual({ subscribe: ['season_ja', 'events_ja'], unsubscribe: ['season_en', 'events_en'] });
    for (const t of Object.values(m.push.templates)) {
      expect(hasJapanese(renderTemplate(t, 'x', { name: 'Midori', team: 'Aoba', event: '青葉スプリント杯', tournament: '青葉スプリント杯', round: '1回戦', minutes: '5', days: '2', points: '30', season: '2026年11月' }, 'en', m).title + renderTemplate(t, 'x', { name: 'Midori', team: 'Aoba', event: '青葉スプリント杯', tournament: '青葉スプリント杯', round: '1回戦', minutes: '5', days: '2', points: '30', season: '2026年11月' }, 'en', m).body), t.title).toBe(false);
    }
  });
});

describe('the clients get the same tables (REQ-L10N-011)', () => {
  it('engine/Muchi.Client/Resources/Muchi/server-en.json is up to date (npm run gen:client-locale)', async () => {
    const { readFileSync } = await import('node:fs');
    const { clientLocaleJson } = await import('../src/i18n/clientLocale.js');
    expect(readFileSync(new URL('../../engine/Muchi.Client/Resources/Muchi/server-en.json', import.meta.url).pathname, 'utf8')).toBe(clientLocaleJson());
  });
});
