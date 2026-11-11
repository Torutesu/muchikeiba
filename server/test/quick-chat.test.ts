// 支部の定型チャット (REQ-QCHAT-001..013, contracts/protocol.md §52): fixed phrases in the §18 team feed, slot values checked
// by the server, each viewer's language, both-way blocks, limits, retention, leave / deletion, KPI and the activity entry.
import { describe, expect, it } from 'vitest';
import { m } from './helpers.js';
import { MemoryPlayerRepo, PlayerService } from '../src/domain/service.js';
import { seededRng } from '../src/domain/rng.js';
import { AppError } from '../src/domain/errors.js';
import { MemoryTeams, TeamsService } from '../src/domain/teamService.js';
import { handle, teamPlayersFrom, type AppContext, type PlayerInvoker } from '../src/http/app.js';
import { quickChatOf, quickChatProblems, type QuickChatMaster } from '../src/domain/quickChat.js';
import { renderActivityItems } from '../src/domain/activity.js';
import { catalogFor, localize } from '../src/i18n/catalog.js';
import { localeProblems } from '../src/i18n/validate.js';
import type { KpiRecord } from '../src/domain/kpi.js';
import type { PlayerState } from '../src/domain/player.js';
import type { Master } from '../src/domain/master.js';
import { createHorseFromTemplate } from '../src/domain/horses.js';

const T0 = Date.UTC(2026, 10, 5, 3); // 12:00 JST
const DAY = 86_400_000;
const code = async (p: Promise<unknown>) => { try { await p; return 'ok'; } catch (e) { return (e as AppError).code; } };
const withQc = (patch: Partial<QuickChatMaster['config']>, phrases?: QuickChatMaster['phrases']): Master =>
  ({ ...m, quickChat: { ...quickChatOf(m), config: { ...quickChatOf(m).config, ...patch }, ...(phrases ? { phrases } : {}) } }) as Master;

function world(master: Master = m) {
  let t = T0;
  const clock = () => t;
  const repo = new MemoryPlayerRepo();
  const teams = new MemoryTeams(() => master, clock);
  const kpi: { id: string; r: KpiRecord }[] = [];
  const svc = new PlayerService(repo, {
    master, rng: seededRng(5), clock, verifiers: {},
    onTeamFeed: async (p) => { await teams.feedRace(p.teamId, p.playerId, p.race); },
    onKpi: (id, recs) => { for (const r of recs) kpi.push({ id, r }); },
  });
  const invoker: PlayerInvoker = { invoke: (async (method: string, ...args: unknown[]) => (svc as unknown as Record<string, (...a: unknown[]) => unknown>)[method]!.apply(svc, args)) as PlayerInvoker['invoke'] };
  const ts = new TeamsService(() => master, teams, teamPlayersFrom(() => invoker), teams, teams, seededRng(9), clock);
  const state = (u: string) => repo.get(u) as PlayerState;
  const edit = (u: string, f: (s: PlayerState) => void) => { const s = state(u); f(s); repo.put(s); };
  const activity = async (u: string) => renderActivityItems((await svc.activity(u)).items, null);
  return { svc, repo, teams, ts, kpi, state, edit, activity, invoker, advance: (ms: number) => { t += ms; }, now: clock };
}
type W = ReturnType<typeof world>;

async function team(w: W, ...ids: string[]) {
  for (const id of ['lead', ...ids]) await w.svc.bootstrap(id);
  const v = await w.ts.create('lead', 'あおばRC', 'open', '');
  for (const id of ids) await w.ts.join(id, v.teamId);
  return v.teamId;
}
const qitems = async (w: W, u: string, locale: 'ja' | 'en' = 'ja') => (await w.ts.feed(u, null, null, locale)).items.filter((x) => x.kind === 'qchat');

describe('REQ-QCHAT-001/002 the phrase catalog', () => {
  it('the shipped catalog is valid: JA + EN pairs, slots, categories, no betting or urgency words', () => {
    expect(quickChatProblems(m)).toEqual([]);
    const qc = quickChatOf(m);
    expect(qc.phrases.length).toBeGreaterThanOrEqual(15);
    for (const p of qc.phrases) { expect(p.ja.length).toBeGreaterThan(0); expect(p.en.length).toBeGreaterThan(0); }
    expect(qc.phrases.map((p) => p.id)).toEqual(expect.arrayContaining(['otsukare', 'run_together', 'goal_close', 'nice_player']));
    expect(qc.config.retainMax).toBeLessThan(100); // chat never pushes every race / goal item out of the feed
    // the phrase table is not part of the §23 string table (pairs of their own)
    expect(localeProblems(m).filter((x) => x.includes('quickChat'))).toEqual([]);
  });

  it('refuses betting words (JA / EN), 倍・お得・今だけ, English urgency, URLs, bad slots and bad config', () => {
    const one = (ph: { id?: string; category?: string; ja: string; en: string }) => quickChatProblems(withQc({}, [{ id: 'x', category: 'greet', ...ph } as never])).join(';');
    expect(one({ ja: '馬券を買おう', en: 'Hi' })).toMatch(/betting word in ja/);
    expect(one({ ja: 'やあ', en: 'Place a bet' })).toMatch(/betting word in en/);
    expect(one({ ja: '経験値2倍', en: 'More XP' })).toMatch(/「倍」/);
    expect(one({ ja: '今だけお得', en: 'Now' })).toMatch(/「今だけ」.*「お得」|「お得」/);
    expect(one({ ja: 'やあ', en: 'Hurry, last chance' })).toMatch(/en wording/);
    expect(one({ ja: 'www.example.com を見て', en: 'See it' })).toMatch(/no URLs/);
    expect(one({ ja: '{course}で{horse}と{cup}', en: '{course} {horse} {cup}' })).toMatch(/at most 2 slots/);
    expect(one({ ja: '{course}で', en: 'At {horse}' })).toMatch(/same slots/);
    expect(one({ ja: '{phone}に連絡', en: 'Call {phone}' })).toMatch(/unknown slot/);
    expect(one({ ja: 'やあ', en: 'やあ' })).toMatch(/en contains Japanese/);
    expect(quickChatProblems(withQc({}, [{ id: 'a', category: 'greet', ja: 'a', en: 'a' }, { id: 'a', category: 'shop' as never, ja: 'b', en: 'b' }])).join(';')).toMatch(/duplicate.*unknown category|unknown category/);
    expect(quickChatProblems(withQc({ retainMax: 101 })).join(';')).toMatch(/retainMax must be 10..100/);
    expect(quickChatProblems(withQc({ postIntervalMs: 100 })).join(';')).toMatch(/postIntervalMs/);
  });
});

describe('REQ-QCHAT-003/004/009/013 posting and reading', () => {
  it('members only; the phrase id and checked values are stored; each viewer reads their own language', async () => {
    const w = world();
    const teamId = await team(w, 'a');
    await w.svc.bootstrap('loner');
    expect(await code(w.ts.postQuickChat('loner', 'otsukare', {}))).toBe('NOT_IN_TEAM');
    expect(await code(w.ts.postQuickChat('a', 'no_such', {}))).toBe('NOT_FOUND');
    expect(await code(w.ts.postQuickChat('a', 'run_together', {}))).toBe('BAD_REQUEST'); // missing slot
    expect(await code(w.ts.postQuickChat('a', 'otsukare', { course: 'aoba_turf_1600' }))).toBe('BAD_REQUEST'); // extra slot
    expect(await code(w.ts.postQuickChat('a', 'run_together', { course: 'mars_turf_9000' }))).toBe('BAD_REQUEST');
    const r = await w.ts.postQuickChat('a', 'run_together', { course: 'kirameki_turf_2000' });
    expect(r).toMatchObject({ teamId, seq: 1, phraseId: 'run_together' });
    const stored = w.teams.cores.get(teamId)!.feed.items[0]!;
    expect(stored).toMatchObject({ kind: 'qchat', qchat: { phraseId: 'run_together', slots: [{ name: 'course', ref: 'kirameki_turf_2000' }] } });
    expect(JSON.stringify(stored)).not.toContain('一緒に走ろう'); // never the text
    const [ja] = await qitems(w, 'lead');
    expect(ja!.qchat).toMatchObject({ phraseId: 'run_together', category: 'invite', mention: false, mentionsMe: false, anon: false, qchatText: 'きらめき競馬場 芝2000mで一緒に走ろう', report: { kind: 'team_feed', teamId, seq: 1 } });
    expect(ja!.displayName).toBe(w.state('a').profile.displayName);
    const [en] = await qitems(w, 'lead', 'en');
    expect(en!.qchat!.qchatText).toBe("Let's race together at Kirameki Racecourse, Turf 2000 m");
    // a feed of other kinds says qchat: null
    await w.ts.postStamp('lead', 'cheer');
    expect((await w.ts.feed('a', null, null)).items.find((x) => x.kind === 'stamp')!.qchat).toBeNull();
  });

  it('horse, race, time-attack and cup values come only from the poster\'s own state; player-sourced text is never translated', async () => {
    const w = world();
    const teamId = await team(w, 'a');
    for (const u of ['a', 'lead']) w.edit(u, (s) => { s.horses.push(createHorseFromTemplate(s, m.templates[0]!, T0)); });
    const mine = w.state('a').horses[0]!;
    const theirs = w.state('lead').horses[0]!;
    expect(await code(w.ts.postQuickChat('a', 'my_horse', { horse: theirs.id + '_x' }))).toBe('NOT_ELIGIBLE'); // not in a's stable
    // a horse named like a string-table entry stays as named in English (QA R11 rule for player text)
    w.edit('a', (s) => { s.horses[0]!.name = 'ナイス！'; });
    await w.ts.postQuickChat('a', 'my_horse', { horse: mine.id });
    expect((await qitems(w, 'lead', 'en'))[0]!.qchat!.qchatText).toBe('Giving it my all with ナイス！');
    const http = localize(await w.ts.feed('lead', null, null, 'en'), 'en', catalogFor(m));
    expect(http.items[0]!.qchat!.qchatText).toBe('Giving it my all with ナイス！');
    expect(http.items[0]!.qchat!.slots[0]!.qchatValue).toBe('ナイス！');
    w.advance(16_000);
    expect(await code(w.ts.postQuickChat('a', 'time_report', { time: 'aoba_turf_1600' }))).toBe('NOT_ELIGIBLE');
    w.edit('a', (s) => { s.timeAttack = { sessions: [], daily: { date: '', count: 0 }, seasonBest: {}, allTimeBest: { aoba_turf_1600: { timeMs: 95_340, finishTick: 1906, finishFrac: 0, sessionId: 's', horseId: mine.id, horseName: 'x', at: T0 } }, milestones: [] }; });
    await w.ts.postQuickChat('a', 'time_report', { time: 'aoba_turf_1600' });
    expect((await qitems(w, 'lead'))[0]!.qchat!.qchatText).toBe('タイムアタック 青葉競馬場 芝1600m 1:35.3 が出た！');
    w.advance(16_000);
    expect(await code(w.ts.postQuickChat('a', 'race_report', { race: 'r_none' }))).toBe('NOT_ELIGIBLE');
    w.edit('a', (s) => { s.myReplays = { recent: [{ raceId: 'r_1', at: T0, mode: 'ranked', trackId: 'minato_turf_2400', place: 2, fieldSize: 12, slot: 0, resultHash: 'h', rulesetVersion: 'v', moment: null }], saved: [] } as never; });
    await w.ts.postQuickChat('a', 'race_report', { race: 'r_1' });
    expect((await qitems(w, 'lead'))[0]!.qchat!.qchatText).toBe('みなと競馬場 芝2400mで2着でした！');
    expect((await qitems(w, 'lead', 'en'))[0]!.qchat!.qchatText).toBe('My result: 2nd at Minato Racecourse, Turf 2400 m!');
    w.advance(16_000);
    expect(await code(w.ts.postQuickChat('a', 'cup_in', { cup: 'c1' }))).toBe('NOT_ELIGIBLE');
    w.edit('a', (s) => { s.cups = { active: [{ cupId: 'c1', role: 'entrant', until: T0 + 7 * DAY, noted: true, cupName: '決勝' }], invites: [], history: [], trophies: { gold: 0, silver: 0, bronze: 0 }, codeAttempts: { hour: 0, count: 0 } }; });
    await w.ts.postQuickChat('a', 'cup_in', { cup: 'c1' });
    expect((await qitems(w, 'lead', 'en'))[0]!.qchat!.qchatText).toBe('I\'m racing in "決勝"'); // a cup name stays as the host typed it
    // the picker lists exactly what a post would accept
    const pick = await w.ts.quickChat('a', 'en');
    expect(pick).toMatchObject({ enabled: true, teamId });
    expect(pick.options.cup).toEqual([{ ref: 'c1', qchatValue: '決勝' }]);
    expect(pick.options.time).toEqual([{ ref: 'aoba_turf_1600', qchatValue: 'Aoba Racecourse, Turf 1600 m 1:35.3' }]);
    expect(pick.options.race[0]).toEqual({ ref: 'r_1', qchatValue: '2nd at Minato Racecourse, Turf 2400 m' });
    expect(pick.options.horse.map((x) => x.ref)).toContain(mine.id);
    expect(pick.options.player.map((x) => x.ref)).toEqual(['lead']);
    expect(pick.phrases.find((p) => p.id === 'run_together')).toEqual({ id: 'run_together', category: 'invite', slots: ['course'], mention: false, qchatTemplate: "Let's race together at {course}" });
    expect(pick.usage.postsToday).toBe(4);
  });

  it('deletion pending blocks a post; outside a branch the picker is empty', async () => {
    const w = world();
    await team(w, 'a');
    w.edit('a', (s) => { s.deletion = { status: 'scheduled', requestedAt: T0, executeAt: T0 + 7 * DAY } as never; });
    expect(await code(w.ts.postQuickChat('a', 'otsukare', {}))).toBe('DELETION_PENDING');
    await w.svc.bootstrap('solo');
    const p = await w.ts.quickChat('solo');
    expect(p).toMatchObject({ teamId: null, usage: { postsToday: 0 } });
    expect(Object.values(p.options).every((x) => x.length === 0)).toBe(true);
    const off = world(withQc({ enabled: false }));
    await team(off, 'b');
    expect(await code(off.ts.postQuickChat('b', 'otsukare', {}))).toBe('NOT_FOUND');
  });
});

describe('REQ-QCHAT-005/006 limits and retention', () => {
  it('15 s apart, no repeat of the same phrase + values within 10 min, 30 a day, separate from stamps, reset at the game day', async () => {
    const w = world();
    await team(w, 'a');
    await w.ts.postQuickChat('a', 'otsukare', {});
    expect(await code(w.ts.postQuickChat('a', 'hello', {}))).toBe('RATE_LIMITED');
    expect(await code(w.ts.postStamp('a', 'cheer'))).toBe('ok'); // stamps have their own limit
    w.advance(15_000);
    expect(await code(w.ts.postQuickChat('a', 'otsukare', {}))).toBe('RATE_LIMITED'); // the same phrase again
    expect(await code(w.ts.postQuickChat('a', 'hello', {}))).toBe('ok');
    w.advance(15_000);
    expect(await code(w.ts.postQuickChat('a', 'run_together', { course: 'aoba_turf_1600' }))).toBe('ok');
    w.advance(15_000);
    expect(await code(w.ts.postQuickChat('a', 'run_together', { course: 'minato_turf_2400' }))).toBe('ok'); // other values = another message
    w.advance(600_000);
    expect(await code(w.ts.postQuickChat('a', 'otsukare', {}))).toBe('ok');
    for (let i = 5; i < 30; i++) { w.advance(15_000); await w.ts.postQuickChat('a', i % 2 ? 'hello' : 'see_you', {}); }
    w.advance(15_000);
    expect(await code(w.ts.postQuickChat('a', 'morning', {}))).toBe('RATE_LIMITED'); // 30 today
    expect(await code(w.ts.postQuickChat('lead', 'morning', {}))).toBe('ok'); // per member
    w.advance(DAY);
    expect(await code(w.ts.postQuickChat('a', 'morning', {}))).toBe('ok');
  });

  it('a branch keeps at most retainMax quick chat items for retainDays; race and stamp items are untouched', async () => {
    const w = world(withQc({ retainMax: 10, postIntervalMs: 3000, repeatWindowMs: 0, retainDays: 2 }));
    const teamId = await team(w, 'a');
    await w.ts.postStamp('lead', 'cheer');
    for (let i = 0; i < 14; i++) { w.advance(3000); await w.ts.postQuickChat(i % 2 ? 'a' : 'lead', 'hello', {}); }
    const f = w.teams.cores.get(teamId)!.feed;
    expect(f.items.filter((x) => x.kind === 'qchat')).toHaveLength(10);
    expect(f.items.filter((x) => x.kind === 'stamp')).toHaveLength(1);
    w.advance(2 * DAY + 1);
    expect(await qitems(w, 'a')).toHaveLength(0); // past the days: not shown even before the next write prunes
    await w.ts.postQuickChat('a', 'otsukare', {});
    expect(f.items.filter((x) => x.kind === 'qchat')).toHaveLength(1);
    expect(f.items.filter((x) => x.kind === 'stamp')).toHaveLength(1);
  });
});

describe('REQ-QCHAT-007 the one block list hides quick chat both ways', () => {
  it('blocked and blocking members do not see each other\'s phrases, cannot react to them or name each other', async () => {
    const w = world();
    await team(w, 'a', 'b', 'c');
    await w.ts.postQuickChat('a', 'otsukare', {});
    await w.ts.postQuickChat('b', 'hello', {});
    await w.ts.mute('a', 'b', true); // a blocks b
    expect((await qitems(w, 'a')).map((x) => x.playerId)).toEqual(['a']); // b's hidden for a (as in §18)
    expect((await qitems(w, 'b')).map((x) => x.playerId)).toEqual(['b']); // and a's hidden for b (the other way)
    expect((await qitems(w, 'c')).map((x) => x.playerId).sort()).toEqual(['a', 'b']);
    expect(await code(w.ts.react('b', 1, 'cheer'))).toBe('NOT_FOUND');
    expect(await code(w.ts.react('c', 1, 'cheer'))).toBe('ok');
    w.advance(16_000);
    expect(await code(w.ts.postQuickChat('b', 'nice_player', { player: 'a' }))).toBe('NOT_ELIGIBLE');
    expect(await code(w.ts.postQuickChat('a', 'nice_player', { player: 'b' }))).toBe('NOT_ELIGIBLE');
    expect((await w.ts.quickChat('b')).options.player.map((x) => x.ref).sort()).toEqual(['c', 'lead']);
    expect((await w.ts.quickChat('a')).options.player.map((x) => x.ref).sort()).toEqual(['c', 'lead']);
    // unblock: visible again both ways
    await w.ts.mute('a', 'b', false);
    expect((await qitems(w, 'b')).map((x) => x.playerId).sort()).toEqual(['a', 'b']);
  });
});

describe('REQ-QCHAT-012 mentions write one bounded activity entry, never a push', () => {
  it('the named member gets a collapsed entry; members only; not yourself; a blocked sender writes nothing; mentions per day', async () => {
    const w = world(withQc({ mentionsPerDay: 2 }));
    await team(w, 'a', 'b');
    await w.svc.bootstrap('out');
    w.edit('a', (s) => { s.profile.displayName = 'シノノメ'; });
    expect(await code(w.ts.postQuickChat('a', 'nice_player', { player: 'a' }))).toBe('BAD_REQUEST');
    expect(await code(w.ts.postQuickChat('a', 'nice_player', { player: 'out' }))).toBe('NOT_ELIGIBLE');
    const pushes0 = (w.state('b').push?.outbox ?? []).length;
    await w.ts.postQuickChat('a', 'nice_player', { player: 'b' });
    const [it] = await qitems(w, 'b');
    expect(it!.qchat).toMatchObject({ mention: true, mentionsMe: true, qchatText: `${w.state('b').profile.displayName}さんナイス！` });
    expect((await qitems(w, 'lead'))[0]!.qchat!.mentionsMe).toBe(false);
    w.advance(16_000);
    await w.ts.postQuickChat('lead', 'thanks_player', { player: 'b' });
    const act = (await w.activity('b')).filter((x) => x.kind === 'qchat_mention');
    expect(act).toHaveLength(1);
    expect(act[0]).toMatchObject({ count: 2, link: { screen: 'team_feed' }, text: '支部のチャットで2件の声がかかりました' });
    expect((w.state('b').push?.outbox ?? []).length).toBe(pushes0); // no push category, no push
    w.advance(16_000);
    await w.ts.postQuickChat('a', 'omedeto_player', { player: 'lead' });
    w.advance(16_000);
    expect(await code(w.ts.postQuickChat('a', 'thanks_player', { player: 'lead' }))).toBe('RATE_LIMITED'); // 2 mentions today
    expect(await code(w.ts.postQuickChat('a', 'otsukare', {}))).toBe('ok');
    // b blocks lead: lead's later mention of b is refused (both ways), and nothing reaches b's list
    await w.ts.mute('b', 'lead', true);
    w.advance(16_000);
    expect(await code(w.ts.postQuickChat('lead', 'omedeto_player', { player: 'b' }))).toBe('NOT_ELIGIBLE');
    // the activity text in English keeps the name as written
    const en = localize(renderActivityItems((await w.svc.activity('lead')).items, null), 'en', catalogFor(m));
    expect(en.find((x) => x.kind === 'qchat_mention')!.text).toBe(`${w.state('a').profile.displayName} mentioned you in the branch chat`);
  });
});

describe('REQ-QCHAT-010 leaving the branch and account deletion', () => {
  it('a leaver\'s phrases stay without the name (元メンバー / Former member); a deleted account\'s phrases are removed and its name in others\' phrases is cleared', async () => {
    const w = world();
    const teamId = await team(w, 'a', 'b', 'gone');
    await w.ts.postQuickChat('a', 'otsukare', {});
    await w.ts.postQuickChat('b', 'nice_player', { player: 'a' });
    await w.ts.postQuickChat('gone', 'hello', {});
    await w.ts.postQuickChat('lead', 'thanks_player', { player: 'gone' });
    await w.ts.leave('a');
    let items = await qitems(w, 'b');
    const left = items.find((x) => x.qchat!.phraseId === 'otsukare')!;
    expect(left).toMatchObject({ playerId: '', displayName: '元メンバー', mine: false, qchat: { anon: true } });
    expect(items.find((x) => x.qchat!.phraseId === 'nice_player')!.qchat!.qchatText).toBe('元メンバーさんナイス！');
    expect((await qitems(w, 'b', 'en')).find((x) => x.qchat!.phraseId === 'otsukare')!.displayName).toBe('Former member');
    expect(JSON.stringify(items)).not.toContain(w.state('a').profile.displayName);
    // the stored id stays for the deletion: a's later account deletion still removes the anonymized phrase
    await w.teams.feedForget(teamId, 'a');
    items = await qitems(w, 'b');
    expect(items.some((x) => x.qchat!.phraseId === 'otsukare')).toBe(false);
    // account deletion of a current member: their phrases go, the name slot pointing at them is cleared
    await w.teams.feedForget(teamId, 'gone');
    items = await qitems(w, 'b');
    expect(items.some((x) => x.qchat!.phraseId === 'hello')).toBe(false);
    const thanks = items.find((x) => x.qchat!.phraseId === 'thanks_player')!;
    expect(thanks.qchat!.slots[0]).toMatchObject({ name: 'player', ref: '', qchatValue: '元メンバー' });
    expect(JSON.stringify(w.teams.cores.get(teamId)!.feed)).not.toContain('"gone"');
  });
});

describe('REQ-QCHAT-011 KPI and reactions', () => {
  it('qchat_post per stored post, qchat_react for a new stamp reaction on a phrase', async () => {
    const w = world();
    const teamId = await team(w, 'a');
    await w.ts.postQuickChat('a', 'nice_player', { player: 'lead' });
    await w.ts.react('lead', 1, 'nice');
    w.advance(3000);
    await w.ts.react('lead', 1, 'nice'); // not new
    expect(w.kpi.filter((k) => k.r.name === 'qchat_post').map((k) => k.r)).toEqual([expect.objectContaining({ s1: 'nice_player', s2: teamId, s3: 'mention', count: 1 })]);
    expect(w.kpi.filter((k) => k.r.name === 'qchat_react').map((k) => k.r)).toEqual([expect.objectContaining({ s1: 'nice', s2: 'nice_player', s3: teamId })]);
    expect((await qitems(w, 'a'))[0]!.reactions).toEqual([{ stampId: 'nice', count: 1, mine: false }]);
    // a refused post writes no KPI
    expect(await code(w.ts.postQuickChat('a', 'otsukare', {}))).toBe('RATE_LIMITED');
    expect(w.kpi.filter((k) => k.r.name === 'qchat_post')).toHaveLength(1);
  });
});

describe('HTTP API (§52.10)', () => {
  it('picker in the request language, post validation (no free text), the feed item', async () => {
    const w = world();
    await team(w, 'a');
    const c = {
      master: m, clock: w.now, player: () => w.invoker, teams: w.ts,
      authenticate: async (req: Request) => { const u = req.headers.get('x-test-user'); if (!u) throw new AppError('UNAUTHORIZED'); return u; },
    } as unknown as AppContext;
    const call = async (method: string, path: string, user: string, body?: unknown) => {
      const res = await handle(new Request(`https://x${path}`, { method, headers: { 'content-type': 'application/json', 'x-test-user': user }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }), {}, c);
      return { status: res.status, body: (await res.json()) as any };
    };
    const en = await call('GET', '/v1/teams/me/quick-chat?lang=en', 'a');
    expect(en.body.phrases.find((p: { id: string }) => p.id === 'goal_close').qchatTemplate).toBe("Almost at this week's team goal");
    expect(en.body.options.course[0].qchatValue).toBe('Aoba Racecourse, Turf 1600 m');
    expect((await call('POST', '/v1/teams/me/feed/quick-chat', 'a', { phraseId: 'otsukare', text: 'free text' })).status).toBe(400);
    expect((await call('POST', '/v1/teams/me/feed/quick-chat', 'a', { phraseId: 'run_together', slots: { course: 'aoba_turf_1600', note: 'x' } })).status).toBe(400);
    expect((await call('POST', '/v1/teams/me/feed/quick-chat', 'a', { phraseId: 'run_together', slots: { course: 'a b' } })).status).toBe(400);
    expect((await call('POST', '/v1/teams/me/feed/quick-chat', 'a', { phraseId: 'Bad' })).status).toBe(400);
    const ok = await call('POST', '/v1/teams/me/feed/quick-chat', 'a', { phraseId: 'run_together', slots: { course: 'aoba_turf_1600' } });
    expect(ok.body).toMatchObject({ seq: 1, phraseId: 'run_together' });
    expect((await call('POST', '/v1/teams/me/feed/quick-chat', 'a', { phraseId: 'otsukare' })).status).toBe(429);
    const feed = await call('GET', '/v1/teams/me/feed?lang=en', 'lead');
    expect(feed.body.items[0]).toMatchObject({ kind: 'qchat', qchat: { qchatText: "Let's race together at Aoba Racecourse, Turf 1600 m" } });
    const ja = await call('GET', '/v1/teams/me/feed', 'lead');
    expect(ja.body.items[0].qchat.qchatText).toBe('青葉競馬場 芝1600mで一緒に走ろう');
    expect((await call('PUT', '/v1/teams/me/feed/1/reaction', 'lead', { stampId: 'nice' })).body).toMatchObject({ myReaction: 'nice' });
  });
});
