// REQ-NEW-001..020: アップデートのお知らせ (what's new per app version, contracts/protocol.md §64).
import { describe, expect, it } from 'vitest';
import { handle, makeFriendsService, type AppContext, type PlayerInvoker } from '../src/http/app.js';
import { MemoryDirectory } from '../src/domain/friends.js';
import { MemoryPlayerRepo, PlayerService } from '../src/domain/service.js';
import { FakeStoreVerifier } from '../src/domain/purchase.js';
import { seededRng } from '../src/domain/rng.js';
import { AppError } from '../src/domain/errors.js';
import { DEFAULT_RULESET } from '../src/domain/ruleset.js';
import { resolveBundle } from '../src/ops/config.js';
import { authenticateAdmin, type AdminAuthConfig } from '../src/ops/admin.js';
import { sha256Hex } from '../src/ops/hash.js';
import { memoryOps } from '../src/ops/memoryOps.js';
import { BASE_HELP } from '../src/domain/help.js';
import { BASE_TIPS } from '../src/domain/tips.js';
import {
  BASE_RELEASE_NOTES, PAID_SCREENS, RELEASE_SCREENS, checkReleaseNotes, inFtue, markReleaseNotesSeen, releaseNotesHistory, releaseNotesPreview,
  releaseNotesProblems, releaseStartMs, type ReleaseNotesMaster,
} from '../src/domain/releaseNotes.js';
import { RELEASE_HISTORY_SOURCES, RELEASE_NOTES_STAGES, RELEASE_TARGET_KIND_NAMES, clientBatchSchema, clientToKpi, type KpiRecord } from '../src/domain/kpi.js';
import { DEFAULT_MAINTENANCE, endpointGroup, gateRequest, isExempt, type MaintenanceConfig } from '../src/domain/maintenance.js';
import { classifyKey } from '../src/domain/dataExport.js';
import { CHEER_MIN_INTERVAL_MS } from '../src/domain/cheer.js';
import { newPlayer, type PlayerState } from '../src/domain/player.js';
import { seasonIdFor } from '../src/domain/season.js';
import type { Master } from '../src/domain/master.js';
import { m } from './helpers.js';

const NOW = Date.UTC(2026, 10, 11, 3); // 2026-11-11 12:00 JST (after 1.1.0 on 10-20 and 1.2.0 on 11-05)
const OLD = Date.UTC(2026, 9, 1); // an account from before both releases
const DAY = 86_400_000;
const JP = /[぀-ヿ㐀-鿿]/;
const clone = (): ReleaseNotesMaster => structuredClone(BASE_RELEASE_NOTES);
const withNotes = (r: ReleaseNotesMaster, base: Master = m): Master => ({ ...base, releaseNotes: r });
/** A player past the FTUE (partner + the onboarding races), created at `createdAt`. */
const veteran = (createdAt = OLD): PlayerState => {
  const s = newPlayer('p1', createdAt, seasonIdFor(createdAt));
  s.flags.partnerHorseId = 'h1';
  s.onboarding = { ...(s.onboarding ?? {}), races: 5 } as PlayerState['onboarding'];
  return s;
};
const page0 = (r: ReleaseNotesMaster) => r.notes[0]!.pages[0]!;

describe('the shipped release notes (REQ-NEW-001..005)', () => {
  it('pass every check: versions, dates, pages, art keys, lengths, tokens, wording, targets', () => {
    expect(releaseNotesProblems(m)).toEqual([]);
    const r = BASE_RELEASE_NOTES;
    expect(r.notes.length).toBeGreaterThanOrEqual(2);
    for (const n of r.notes) {
      expect(n.pages.length).toBeGreaterThanOrEqual(1);
      expect(n.pages.length).toBeLessThanOrEqual(5);
      for (const p of n.pages) if (p.target?.kind === 'screen') expect(PAID_SCREENS).not.toContain(p.target.id);
    }
    // numbers come from tokens: the cheer page carries the §55 interval as a token, never as a digit
    expect(JSON.stringify(r)).toContain('{{cheer_interval_sec}}');
  });

  it('RELEASE_SCREENS is the help screens without the shop / scout / rates', () => {
    for (const s of PAID_SCREENS) expect(RELEASE_SCREENS).not.toContain(s);
    expect(RELEASE_SCREENS).toContain('tips');
  });

  it('refuses bad versions, duplicates, dates out of order, page counts and unknown art', () => {
    const bad = clone();
    bad.notes[0]!.appVersion = '1.1';
    expect(releaseNotesProblems(m, bad).join()).toMatch(/appVersion must be x\.y\.z/);
    const dup = clone(); dup.notes[1]!.appVersion = dup.notes[0]!.appVersion;
    expect(releaseNotesProblems(m, dup).join()).toMatch(/duplicate appVersion/);
    const order = clone(); order.notes[1]!.releasedOn = '2026-10-01';
    expect(releaseNotesProblems(m, order).join()).toMatch(/1\.2\.0 is released before 1\.1\.0/);
    const date = clone(); date.notes[0]!.releasedOn = '2026-02-30';
    expect(releaseNotesProblems(m, date).join()).toMatch(/releasedOn must be a date/);
    const empty = clone(); empty.notes[0]!.pages = [];
    expect(releaseNotesProblems(m, empty).join()).toMatch(/1\.\.5 pages/);
    const six = clone(); six.notes[0]!.pages = Array.from({ length: 6 }, () => structuredClone(page0(six)));
    expect(releaseNotesProblems(m, six).join()).toMatch(/1\.\.5 pages/);
    const art = clone(); page0(art).art = 'brand_new_art';
    expect(releaseNotesProblems(m, art).join()).toMatch(/unknown art brand_new_art/);
    const cfg = clone(); cfg.config.seenMax = 1000;
    expect(releaseNotesProblems(m, cfg).join()).toMatch(/seenMax must be an integer 10\.\.100/);
  });

  it('refuses long text, digits outside tokens, mismatched tokens, unknown tokens and Japanese in English (REQ-NEW-003)', () => {
    const long = clone(); page0(long).body.ja = 'あ'.repeat(141);
    expect(releaseNotesProblems(m, long).join()).toMatch(/body\.ja: 1\.\.140 characters/);
    const title = clone(); page0(title).title.en = 'x'.repeat(25);
    expect(releaseNotesProblems(m, title).join()).toMatch(/title\.en: 1\.\.24 characters/);
    const digits = clone(); page0(digits).body.ja = '応援は2秒に1回まで。';
    expect(releaseNotesProblems(m, digits).join()).toMatch(/may not carry numbers outside \{\{tokens\}\}/);
    const coins = clone(); page0(coins).body.en = 'Get 100 coins.';
    expect(releaseNotesProblems(m, coins).join()).toMatch(/a number with a unit must come from a \{\{token\}\}/);
    const mismatch = clone(); page0(mismatch).body.ja = '{{max_whips}}回までムチ。';
    expect(releaseNotesProblems(m, mismatch).join()).toMatch(/ja and en carry different tokens/);
    const unknown = clone(); page0(unknown).body.ja = '{{nope}}'; page0(unknown).body.en = '{{nope}}';
    expect(releaseNotesProblems(m, unknown).join()).toMatch(/unknown token nope/);
    const jp = clone(); page0(jp).title.en = 'Replay レッスン';
    expect(releaseNotesProblems(m, jp).join()).toMatch(/\.en contains Japanese/);
  });

  it('refuses the shop words, the shared betting words and the English banned words (REQ-NEW-004)', () => {
    for (const w of ['倍', '今だけ', '残りわずか', 'お得', '通常価格']) {
      const r = clone(); page0(r).body.ja = `新しい機能が${w}です。`;
      expect(releaseNotesProblems(m, r).join(), w).toMatch(new RegExp(`shop word 「${w}」`));
    }
    const bet = clone(); page0(bet).body.ja = 'オッズを見て予想しよう。';
    expect(releaseNotesProblems(m, bet).join()).toMatch(/betting word/);
    for (const en of ['Limited-time feature!', 'Hurry and try it.', 'Best value ever.']) {
      const r = clone(); page0(r).body.en = en;
      expect(releaseNotesProblems(m, r).join(), en).toMatch(/\.en: wording/);
    }
  });

  it('refuses the shop, scout or rates as a page target, unknown screens, help articles and tip cards (REQ-NEW-005)', () => {
    for (const id of PAID_SCREENS) {
      const r = clone(); page0(r).target = { kind: 'screen', id };
      expect(releaseNotesProblems(m, r).join(), id).toMatch(/may not lead to the shop or a paid product/);
    }
    const scr = clone(); page0(scr).target = { kind: 'screen', id: 'casino' };
    expect(releaseNotesProblems(m, scr).join()).toMatch(/unknown screen casino/);
    const help = clone(); page0(help).target = { kind: 'help', id: 'no_such' };
    expect(releaseNotesProblems(m, help).join()).toMatch(/help article no_such does not exist/);
    const tip = clone(); page0(tip).target = { kind: 'tip', id: 'no_such' };
    expect(releaseNotesProblems(m, tip).join()).toMatch(/tip card no_such does not exist/);
    const kind = clone(); (page0(kind) as unknown as { target: unknown }).target = { kind: 'product', id: 'coin_1500' };
    expect(releaseNotesProblems(m, kind).join()).toMatch(/target: \{ kind: screen \| help \| tip, id \}/);
    const none = clone(); delete page0(none).target;
    expect(releaseNotesProblems(m, none)).toEqual([]);
  });
});

describe('remote config `releaseNotes` (REQ-NEW-002)', () => {
  it('replaces the notes; a bad version is CONFIG_INVALID', () => {
    const r = clone(); r.notes.push({ appVersion: '1.3.0', releasedOn: '2026-12-01', pages: [{ art: 'branch', title: { ja: '支部が見やすく', en: 'Clearer branches' }, body: { ja: '支部の画面を見やすくしました。', en: 'The branch screen is easier to read.' } }] });
    const ok = resolveBundle(m, { releaseNotes: r as unknown as Record<string, unknown> });
    expect(ok.master.releaseNotes?.notes.map((n) => n.appVersion)).toContain('1.3.0');
    const bad = clone(); page0(bad).body.ja = '今だけの新機能';
    expect(() => resolveBundle(m, { releaseNotes: bad as unknown as Record<string, unknown> })).toThrow(/shop word 「今だけ」/);
  });
  it('a version that removes a help article or tip card a page opens cannot be activated', () => {
    const help = structuredClone(BASE_HELP);
    help.articles = help.articles.filter((a) => a.id !== 'transfer_code');
    help.articles.forEach((a) => { a.related = (a.related ?? []).filter((x) => x !== 'transfer_code'); });
    help.contexts = Object.fromEntries(Object.entries(help.contexts).filter(([, v]) => v !== 'transfer_code'));
    expect(() => resolveBundle(m, { help: help as unknown as Record<string, unknown> })).toThrow(/releaseNotes.*help article transfer_code does not exist/);
    const tips = structuredClone(BASE_TIPS);
    tips.tips = tips.tips.filter((t) => t.id !== 'goals_tip');
    tips.tutorials.forEach((t) => { t.tips = t.tips.filter((x) => x !== 'goals_tip'); });
    expect(() => resolveBundle(m, { tips: tips as unknown as Record<string, unknown> })).toThrow(/tip card goals_tip does not exist/);
  });
});

describe('who sees the sheet (REQ-NEW-006..008)', () => {
  it('a player who updated sees the newest note once, with the skipped count and the past link', () => {
    const s = veteran();
    const r = checkReleaseNotes(m, s, '1.2.0', 'ja', NOW);
    expect(r.reason).toBeNull();
    expect(r.show).toMatchObject({ appVersion: '1.2.0', releasedOn: '2026-11-05', skipped: 1, hasPast: true });
    expect(r.show!.pages).toHaveLength(3);
    // numbers from data: the §55 interval fills the token
    expect(r.show!.pages[0]!.body).toContain(`${CHEER_MIN_INTERVAL_MS / 1000}秒ごと`);
    expect(r.show!.pages[0]!.target).toEqual({ kind: 'help', id: 'spectator_cheer', label: 'ヘルプ：観戦中の応援' });
    // the check marks nothing: another system prompt may take this session, so it comes back next time
    expect(checkReleaseNotes(m, s, '1.2.0', 'ja', NOW).show?.appVersion).toBe('1.2.0');
    expect(markReleaseNotesSeen(m, s, '1.2.0')).toEqual({ marked: true, seen: ['1.2.0'] });
    expect(checkReleaseNotes(m, s, '1.2.0', 'ja', NOW)).toMatchObject({ show: null, reason: 'seen' });
    // an older note never comes back once a newer one was seen
    expect(checkReleaseNotes(m, s, '1.2.0', 'ja', NOW + DAY).show).toBeNull();
  });

  it('one version at a time: 1.1.0 then the update to 1.2.0', () => {
    const s = veteran();
    expect(checkReleaseNotes(m, s, '1.1.0', 'ja', NOW).show).toMatchObject({ appVersion: '1.1.0', skipped: 0, hasPast: false });
    markReleaseNotesSeen(m, s, '1.1.0');
    expect(checkReleaseNotes(m, s, '1.1.5', 'ja', NOW)).toMatchObject({ show: null, reason: 'seen' });
    expect(checkReleaseNotes(m, s, '1.2.0', 'ja', NOW).show).toMatchObject({ appVersion: '1.2.0', skipped: 0, hasPast: true });
  });

  it('an old app against the new server never sees a newer note; no header = nothing (REQ-NEW-007)', () => {
    const s = veteran();
    expect(checkReleaseNotes(m, s, '1.0.9', 'ja', NOW)).toMatchObject({ show: null, reason: 'none' });
    expect(checkReleaseNotes(m, s, '1.1.3', 'ja', NOW).show?.appVersion).toBe('1.1.0');
    expect(checkReleaseNotes(m, s, null, 'ja', NOW)).toMatchObject({ show: null, reason: 'unknown_version', appVersion: null });
    expect(checkReleaseNotes(m, s, 'banana', 'ja', NOW)).toMatchObject({ show: null, reason: 'unknown_version' });
  });

  it('never during the FTUE; the FTUE check moves the baseline, so a mid-FTUE update is never introduced later', () => {
    const s = veteran();
    s.flags.partnerHorseId = undefined;
    expect(inFtue(m, s)).toBe(true);
    expect(checkReleaseNotes(m, s, '1.2.0', 'ja', NOW)).toMatchObject({ show: null, reason: 'ftue' });
    expect(s.releaseNotes).toEqual({ seen: [], baseline: '1.2.0' });
    // an older app during the FTUE never lowers it
    checkReleaseNotes(m, s, '1.1.0', 'ja', NOW);
    expect(s.releaseNotes!.baseline).toBe('1.2.0');
    s.flags.partnerHorseId = 'h1';
    expect(checkReleaseNotes(m, s, '1.2.0', 'ja', NOW)).toMatchObject({ show: null, reason: 'none' });
    // the next update after the FTUE is introduced
    const r = clone(); r.notes.push({ appVersion: '1.3.0', releasedOn: '2026-12-01', pages: [structuredClone(page0(r))] });
    expect(checkReleaseNotes(withNotes(r), s, '1.3.0', 'ja', NOW).show).toMatchObject({ appVersion: '1.3.0', skipped: 0 });
  });

  it('the onboarding races count too (§45 onboardingRaces)', () => {
    const s = veteran();
    s.onboarding = { ...(s.onboarding ?? {}), races: 1 } as PlayerState['onboarding'];
    expect(checkReleaseNotes(m, s, '1.2.0', 'ja', NOW).reason).toBe('ftue');
  });

  it('a brand-new install (account created after the release) gets the FTUE, never the note', () => {
    const s = veteran(Date.UTC(2026, 10, 8)); // after 1.2.0 (11-05)
    expect(checkReleaseNotes(m, s, '1.2.0', 'ja', NOW)).toMatchObject({ show: null, reason: 'new_install' });
    // created between the two releases: only 1.2.0 is new to them
    const mid = veteran(Date.UTC(2026, 9, 25));
    expect(checkReleaseNotes(m, mid, '1.2.0', 'ja', NOW).show).toMatchObject({ appVersion: '1.2.0', skipped: 0 });
    // the release day starts at 00:00 JST
    expect(releaseStartMs('2026-11-05')).toBe(Date.UTC(2026, 10, 4, 15));
  });

  it('English: the pages and target labels come in English, nothing Japanese is left (REQ-NEW-014)', () => {
    const r = checkReleaseNotes(m, veteran(), '1.2.0', 'en', NOW);
    expect(JP.test(JSON.stringify(r))).toBe(false);
    expect(r.show!.pages[0]!.title).toBe('Cheer while you watch');
    expect(r.show!.pages[2]!.target).toEqual({ kind: 'tip', id: 'goals_tip', label: 'Tip: ' + BASE_TIPS.tips.find((t) => t.id === 'goals_tip')!.title.en });
    const h = releaseNotesHistory(m, veteran(), '1.2.0', 'en', NOW);
    expect(JP.test(JSON.stringify(h))).toBe(false);
  });

  it('a target the player cannot open is null (a closed tip card, a disabled library) (REQ-NEW-011)', () => {
    const r = clone(); r.notes[1]!.pages[2]!.target = { kind: 'tip', id: 'teams_branch' }; // unlocks with teams
    const old = veteran(); // day 2 of the account: the branch is still closed
    const view = checkReleaseNotes(withNotes(r), old, '1.2.0', 'ja', OLD + DAY).show!;
    expect(view.pages[2]!.target).toBeNull();
    const tipsOff = structuredClone(BASE_TIPS); tipsOff.config.enabled = false;
    expect(checkReleaseNotes({ ...m, tips: tipsOff }, veteran(), '1.2.0', 'ja', NOW).show!.pages[2]!.target).toBeNull();
    const helpOff = structuredClone(BASE_HELP); helpOff.config.enabled = false;
    expect(checkReleaseNotes({ ...m, help: helpOff }, veteran(), '1.2.0', 'ja', NOW).show!.pages[0]!.target).toBeNull();
  });

  it('switched off: no sheet, an empty list, seen is 404', () => {
    const r = clone(); r.config.enabled = false;
    expect(checkReleaseNotes(withNotes(r), veteran(), '1.2.0', 'ja', NOW)).toMatchObject({ enabled: false, show: null, reason: 'disabled' });
    expect(releaseNotesHistory(withNotes(r), veteran(), '1.2.0', 'ja', NOW)).toEqual({ enabled: false, appVersion: '1.2.0', notes: [] });
    expect(() => markReleaseNotesSeen(withNotes(r), veteran(), '1.2.0')).toThrow(AppError);
  });
});

describe('seen marks and the past notes (REQ-NEW-009/010)', () => {
  it('seen is idempotent, refuses an unknown version and keeps at most seenMax versions in version order', () => {
    const s = veteran();
    expect(markReleaseNotesSeen(m, s, '1.2.0').marked).toBe(true);
    expect(markReleaseNotesSeen(m, s, '1.2.0')).toEqual({ marked: false, seen: ['1.2.0'] });
    expect(markReleaseNotesSeen(m, s, '1.1.0').seen).toEqual(['1.1.0', '1.2.0']);
    expect(() => markReleaseNotesSeen(m, s, '9.9.9')).toThrow(/release notes 9\.9\.9/);
    expect(s.releaseNotes!.seen).toEqual(['1.1.0', '1.2.0']);
    const r = clone(); r.config.seenMax = 10;
    r.notes = Array.from({ length: 12 }, (_, i) => ({ appVersion: `2.${i}.0`, releasedOn: '2026-11-05', pages: [structuredClone(page0(BASE_RELEASE_NOTES))] }));
    const st = veteran();
    for (let i = 11; i >= 0; i--) markReleaseNotesSeen(withNotes(r), st, `2.${i}.0`);
    expect(st.releaseNotes!.seen).toHaveLength(10);
    expect(st.releaseNotes!.seen[0]).toBe('2.2.0');
    expect(st.releaseNotes!.seen.at(-1)).toBe('2.11.0');
  });

  it('the list holds the notes up to the app version (all without the header), newest first, with seen flags', () => {
    const s = veteran();
    markReleaseNotesSeen(m, s, '1.1.0');
    expect(releaseNotesHistory(m, s, '1.2.0', 'ja', NOW).notes.map((n) => [n.appVersion, n.seen])).toEqual([['1.2.0', false], ['1.1.0', true]]);
    expect(releaseNotesHistory(m, s, '1.1.4', 'ja', NOW).notes.map((n) => n.appVersion)).toEqual(['1.1.0']);
    expect(releaseNotesHistory(m, s, null, 'ja', NOW).notes.map((n) => n.appVersion)).toEqual(['1.2.0', '1.1.0']);
    // the list is for anyone: a new install can read it too
    expect(releaseNotesHistory(m, veteran(NOW), '1.2.0', 'ja', NOW).notes).toHaveLength(2);
  });
});

describe('the ops console preview (REQ-NEW-016)', () => {
  it('renders every page in Japanese and English with the target labels and the problems', () => {
    const p = releaseNotesPreview(m);
    expect(p.ok).toBe(true);
    expect(p.notes.map((n) => n.appVersion)).toEqual(['1.2.0', '1.1.0']);
    const pg = p.notes[0]!.pages[0]!;
    expect(pg.ja!.body).toContain('秒ごと');
    expect(pg.en!.title).toBe('Cheer while you watch');
    expect(pg.en!.target!.label).toBe('Help: ' + BASE_HELP.articles.find((a) => a.id === 'spectator_cheer')!.title.en);
    const bad = clone(); page0(bad).target = { kind: 'screen', id: 'shop' };
    const q = releaseNotesPreview(m, bad);
    expect(q.ok).toBe(false);
    expect(q.problems.join()).toMatch(/paid product/);
  });
});

// ------------------------------------------------------------------------------------------------ HTTP

const TOKENS = { viewer: 'viewer-token-0123456789' };
async function setup(master: Master = m) {
  let now = NOW;
  const repo = new MemoryPlayerRepo();
  const kpi: KpiRecord[] = [];
  const svc = new PlayerService(repo, { master, rng: seededRng(21), clock: () => now, verifiers: { fake: new FakeStoreVerifier() }, onKpi: (_id, r) => { kpi.push(...r); } });
  const invoker: PlayerInvoker = { invoke: (async (method: string, ...args: unknown[]) => (svc as unknown as Record<string, (...a: unknown[]) => unknown>)[method]!.apply(svc, args)) as PlayerInvoker['invoke'] };
  const ops = memoryOps(master, () => invoker);
  const auth: AdminAuthConfig = { tokens: [{ name: 'viewer', role: 'viewer', sha256: await sha256Hex(TOKENS.viewer) }] };
  const c: AppContext = {
    master,
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
  const call = async (user: string | null, path: string, init: { method?: string; body?: unknown; version?: string; lang?: string; admin?: boolean } = {}) => {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (user) headers['x-test-user'] = user;
    if (init.admin) headers.authorization = `Bearer ${TOKENS.viewer}`;
    if (init.version) { headers['x-client-version'] = init.version; headers['x-client-platform'] = 'ios'; }
    if (init.lang) headers['accept-language'] = init.lang;
    const res = await handle(new Request(`https://x${path}`, { method: init.method ?? 'GET', headers, ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}) }), {}, c);
    return { status: res.status, body: (await res.json()) as any };
  };
  return { svc, repo, kpi, call, advance: (ms: number) => { now += ms; } };
}
/** An account from before the releases that finished the FTUE. */
async function veteranOver(w: Awaited<ReturnType<typeof setup>>, id = 'u1') {
  await w.svc.bootstrap(id);
  const s = await w.svc.state(id);
  s.createdAt = OLD; s.flags.partnerHorseId = 'h1'; s.onboarding = { ...(s.onboarding ?? {}), races: 3 } as PlayerState['onboarding'];
  w.repo.put(s);
}

describe('over HTTP (REQ-NEW-006..010, 017)', () => {
  it('check → seen → check again; the version comes from x-client-version; English from Accept-Language', async () => {
    const w = await setup();
    await veteranOver(w);
    const none = await w.call('u1', '/v1/release-notes/check', { method: 'POST' });
    expect(none.status).toBe(200);
    expect(none.body).toMatchObject({ show: null, reason: 'unknown_version' });
    const c1 = await w.call('u1', '/v1/release-notes/check', { method: 'POST', version: '1.2.0', lang: 'en' });
    expect(c1.body.show).toMatchObject({ appVersion: '1.2.0', skipped: 1, hasPast: true });
    expect(JP.test(JSON.stringify(c1.body))).toBe(false);
    const seen = await w.call('u1', '/v1/release-notes/seen', { method: 'POST', body: { appVersion: '1.2.0' } });
    expect(seen.body).toEqual({ marked: true, seen: ['1.2.0'] });
    expect((await w.call('u1', '/v1/release-notes/seen', { method: 'POST', body: { appVersion: '1.2.0' } })).body.marked).toBe(false);
    expect((await w.call('u1', '/v1/release-notes/check', { method: 'POST', version: '1.2.0' })).body).toMatchObject({ show: null, reason: 'seen' });
    expect((await w.call('u1', '/v1/release-notes/seen', { method: 'POST', body: { appVersion: '7.7.7' } })).status).toBe(404);
    expect((await w.call('u1', '/v1/release-notes/seen', { method: 'POST', body: { appVersion: 'latest' } })).status).toBe(400);
    expect((await w.call('u1', '/v1/release-notes/seen', { method: 'POST', body: { appVersion: '1.2.0', extra: 1 } })).status).toBe(400);
    const h = await w.call('u1', '/v1/release-notes', { version: '1.2.0' });
    expect(h.body.notes.map((n: { appVersion: string; seen: boolean }) => [n.appVersion, n.seen])).toEqual([['1.2.0', true], ['1.1.0', false]]);
    expect((await w.call(null, '/v1/release-notes')).status).toBe(401);
  });

  it('a reinstall (same account, new device) never re-shows a seen version', async () => {
    const w = await setup();
    await veteranOver(w);
    await w.call('u1', '/v1/release-notes/seen', { method: 'POST', body: { appVersion: '1.2.0' } });
    // a fresh install has no local state; the server still knows
    expect((await w.call('u1', '/v1/release-notes/check', { method: 'POST', version: '1.2.0' })).body.reason).toBe('seen');
  });

  it('a brand-new player through the FTUE never sees the current version', async () => {
    const w = await setup();
    await w.svc.bootstrap('n1');
    expect((await w.call('n1', '/v1/release-notes/check', { method: 'POST', version: '1.2.0' })).body.reason).toBe('ftue');
    const s = await w.svc.state('n1');
    expect(s.releaseNotes?.baseline).toBe('1.2.0');
    s.flags.partnerHorseId = 'h1'; s.onboarding = { ...(s.onboarding ?? {}), races: 3 } as PlayerState['onboarding'];
    w.repo.put(s);
    expect((await w.call('n1', '/v1/release-notes/check', { method: 'POST', version: '1.2.0' })).body.show).toBeNull();
  });

  it('gate group core: closed by an `all` window only, never exempt (REQ-NEW-017)', () => {
    for (const p of ['/v1/release-notes', '/v1/release-notes/check', '/v1/release-notes/seen']) {
      expect(endpointGroup(p)).toBe('core');
      expect(isExempt('POST', p)).toBe(false);
    }
    const win = (scope: MaintenanceConfig['windows'][number]['scope']): MaintenanceConfig => ({ ...structuredClone(DEFAULT_MAINTENANCE), windows: [{ id: 'm1', startAtMs: NOW - 1000, endAtMs: NOW + 3_600_000, scope, message: { ja: 'メンテナンス中です。', en: 'Under maintenance.' } }] });
    const h = { platform: 'ios', version: '1.2.0', engine: null };
    expect(gateRequest(win(['gacha', 'shop']), 'POST', '/v1/release-notes/check', h, NOW)).toBeNull();
    expect(gateRequest(win('all'), 'POST', '/v1/release-notes/check', h, NOW)?.code).toBe('MAINTENANCE');
  });

  it('ops console: the active notes and a draft preview in Japanese and English (viewer, nothing stored)', async () => {
    const w = await setup();
    const g = await w.call(null, '/v1/admin/release-notes', { admin: true });
    expect(g.status).toBe(200);
    expect(g.body).toMatchObject({ ok: true, enabled: true });
    expect(g.body.notes[0].pages[0].en.title).toBe('Cheer while you watch');
    const bad = clone(); page0(bad).body.en = 'Limited-time event!';
    const p = await w.call(null, '/v1/admin/release-notes/preview', { method: 'POST', admin: true, body: { releaseNotes: bad } });
    expect(p.status).toBe(200);
    expect(p.body.ok).toBe(false);
    expect(p.body.problems.join()).toMatch(/wording/);
    expect((await w.call(null, '/v1/admin/release-notes')).status).toBe(401);
  });
});

describe('KPI, data export, account deletion (REQ-NEW-018/019)', () => {
  it('the three client events map to KPI rows and refuse bad props', () => {
    const parse = (name: string, props: Record<string, unknown>) => clientBatchSchema.safeParse({ platform: 'ios', appVersion: '1.2.0', events: [{ name, at: NOW, props }] });
    const row = (name: string, props: Record<string, unknown>) => { const r = parse(name, props); if (!r.success) throw new Error(JSON.stringify(r.error.issues)); return clientToKpi(r.data.events[0]!); };
    expect(row('release_notes_view', { appVersion: '1.2.0', stage: 'skipped', page: 2, pages: 3 })).toEqual({ name: 'release_notes_view', s1: '1.2.0', s2: 'skipped', value: 2, count: 3 });
    expect(row('release_notes_target', { appVersion: '1.2.0', page: 1, kind: 'help', target: 'spectator_cheer' })).toEqual({ name: 'release_notes_target', s1: '1.2.0', s2: 'help', s3: 'spectator_cheer', value: 1 });
    expect(row('release_notes_history', { source: 'notices' })).toEqual({ name: 'release_notes_history', s1: 'notices' });
    expect(parse('release_notes_view', { appVersion: '1.2.0', stage: 'shown', page: 4, pages: 3 }).success).toBe(false);
    expect(parse('release_notes_view', { appVersion: 'x', stage: 'shown', page: 1, pages: 1 }).success).toBe(false);
    expect(parse('release_notes_target', { appVersion: '1.2.0', page: 1, kind: 'shop', target: 'coin_1500' }).success).toBe(false);
    expect(parse('release_notes_history', { source: 'push' }).success).toBe(false);
    expect([...RELEASE_NOTES_STAGES]).toEqual(['shown', 'finished', 'skipped']);
    expect([...RELEASE_TARGET_KIND_NAMES]).toEqual(['screen', 'help', 'tip']);
    expect([...RELEASE_HISTORY_SOURCES]).toEqual(['notices', 'tips', 'sheet']);
  });

  it('`releaseNotes` is classified for the data export (play); the wipe of an account deletion removes it', async () => {
    expect(classifyKey('releaseNotes')).toEqual({ section: 'play' });
    const w = await setup();
    await veteranOver(w, 'gone');
    await w.call('gone', '/v1/release-notes/seen', { method: 'POST', body: { appVersion: '1.2.0' } });
    expect((await w.svc.state('gone')).releaseNotes?.seen).toEqual(['1.2.0']);
    await w.svc.wipe('gone');
    expect(w.repo.get('gone')).toBeNull();
  });
});
