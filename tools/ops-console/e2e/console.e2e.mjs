// Ops console end to end (Playwright, headless Chromium) against a local `wrangler dev` started by scripts/console-e2e.sh.
// Env: API_BASE, CONSOLE_URL, TOKEN_VIEWER, TOKEN_OPERATOR, TOKEN_ADMIN, TOKEN_ADMIN2, SCREENSHOT_DIR.
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

async function loadPlaywright() {
  try { return await import('playwright'); } catch {
    const root = execSync('npm root -g').toString().trim(); // CI images ship playwright globally (browsers in PLAYWRIGHT_BROWSERS_PATH)
    return import(pathToFileURL(join(root, 'playwright', 'index.mjs')).href);
  }
}

const env = (k) => { const v = process.env[k]; if (!v) throw new Error(`${k} is required`); return v; };
const API = env('API_BASE');
const CONSOLE = env('CONSOLE_URL');
const T = { viewer: env('TOKEN_VIEWER'), operator: env('TOKEN_OPERATOR'), admin: env('TOKEN_ADMIN'), admin2: env('TOKEN_ADMIN2') };
const SHOTS = process.env.SCREENSHOT_DIR ?? 'e2e-screenshots';
mkdirSync(SHOTS, { recursive: true });
const runId = Date.now().toString(36);
const steps = [];
const step = async (name, fn) => {
  const t0 = Date.now();
  try { await fn(); steps.push({ name, ok: true, ms: Date.now() - t0 }); console.log(`ok   ${name}`); } catch (e) { steps.push({ name, ok: false }); console.log(`FAIL ${name}\n${e.stack}`); throw e; }
};

// ---- seed a player through the public API (DEV_MODE: x-dev-user, fake store)
const PLAYER = `e2e_${runId}`;
let n = 0;
async function asPlayer(method, path, body) {
  const r = await fetch(API + path, { method, headers: { 'content-type': 'application/json', 'x-dev-user': PLAYER, 'idempotency-key': `e2e-${runId}-${n++}` }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const j = await r.json();
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${JSON.stringify(j)}`);
  return j;
}
async function asAdmin(who, method, path, body, extraHeaders = {}) {
  const r = await fetch(API + path, { method, headers: { authorization: `Bearer ${T[who]}`, ...(body ? { 'content-type': 'application/json' } : {}), ...extraHeaders }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, headers: r.headers, body: await r.json().catch(() => null) };
}

await asPlayer('POST', '/v1/player/bootstrap');
await asPlayer('PUT', '/v1/player/age', { birthYear: 1990, birthMonth: 1, guardianConsent: false });
await asPlayer('POST', '/v1/shop/purchase-intent', { productId: 'coin_1500' });
await asPlayer('POST', '/v1/shop/purchase', { platform: 'fake', productId: 'coin_1500', receipt: JSON.stringify({ transactionId: `T_${PLAYER}`, productId: 'coin_1500', purchasedAt: Date.now(), priceYen: 1500 }) });
const invite = await asPlayer('GET', '/v1/invite');
const inviteCode = invite.displayCode; // what a player reads out to support ("XXXX-XXXX")
assert.ok(inviteCode, `invite code in ${JSON.stringify(invite)}`);
const seeded = (await asAdmin('admin', 'GET', `/v1/admin/players/${PLAYER}`)).body.state;
const paid0 = seeded.walletDetail.paid, free0 = seeded.walletDetail.free;
assert.ok(paid0 > 0, 'seeded player has paid coins');

const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'ja-JP', timezoneId: 'Asia/Tokyo' });
const page = await ctx.newPage();
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push(String(e)));
const tid = (id) => page.getByTestId(id);
const shot = (name) => page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true });
async function login(who) {
  await page.goto(`${CONSOLE}/#/login`);
  if (await tid('logout').isVisible()) { await tid('logout').click(); }
  await tid('login-base').fill(API);
  await tid('login-token').fill(T[who]);
  await tid('login-submit').click();
  await page.getByTestId('whoami').getByText(who, { exact: true }).first().waitFor();
}
async function confirmWith(reason) {
  await tid('reason').fill(reason);
  await tid('confirm').click();
}

try {
  await step('login is required: a bad token is refused and nothing renders', async () => {
    await page.goto(CONSOLE);
    await tid('login-token').fill('not-a-real-token-000');
    await tid('login-base').fill(API);
    await tid('login-submit').click();
    await tid('error').getByText('UNAUTHORIZED').waitFor();
    assert.equal(await page.locator('#nav').isHidden(), true);
    await shot('01-login-refused');
  });

  await step('viewer: read-only UI, server refuses writes (403) and every call is audited', async () => {
    await login('viewer');
    await page.locator('#nav a[data-view=config]').click();
    await tid('active-version').waitFor();
    assert.equal(await tid('stage').count(), 0, 'no stage button for viewer');
    assert.equal(await tid('rollback-prev').count(), 0);
    const r = await asAdmin('viewer', 'POST', `/v1/admin/compensations`, { playerId: PLAYER, grant: { freeCoins: 10 }, opKey: `v-${runId}`, reason: 'viewer try' });
    assert.equal(r.status, 403);
    // the token stays out of URLs and local storage
    assert.ok(!page.url().includes(T.viewer));
    assert.equal(await page.evaluate(() => JSON.stringify(localStorage)), '{}');
  });

  await step('CSRF / CORS: listed origin gets CORS headers without credentials; other origins are refused', async () => {
    const ok = await asAdmin('viewer', 'GET', '/v1/admin/whoami', null, { origin: new URL(CONSOLE).origin });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('access-control-allow-origin'), new URL(CONSOLE).origin);
    assert.equal(ok.headers.get('access-control-allow-credentials'), null);
    const evil = await asAdmin('admin', 'GET', '/v1/admin/whoami', null, { origin: 'https://evil.example' });
    assert.equal(evil.status, 403);
    // from inside the console page, a write without a token fails (no cookie can stand in for it)
    const s = await page.evaluate(async (api) => (await fetch(`${api}/v1/admin/config/rollback`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"reason":"csrf try"}' })).status, API);
    assert.equal(s, 401);
  });

  await step('operator: draft validation shows grouped server problems; stage versions', async () => {
    await login('operator');
    await page.locator('#nav a[data-view=config]').click();
    await tid('draft').fill(JSON.stringify({ gacha: { pityGroups: { standard: { cost: 0 } } } }));
    await tid('validate').click();
    await tid('validate-problems').locator('[data-group=gacha]').waitFor();
    await shot('02-config-validate-problems');
    // a version whose day rule rewrites the past (REQ-DAY-002): valid as a bundle, refused at activation
    await tid('draft').fill(JSON.stringify({ progression: { dayRollover: { hourJst: 4, previousHourJst: 1, effectiveAtMs: Date.UTC(2026, 10, 30, 19) } } }));
    await tid('draft-note').fill(`e2e day rule ${runId}`);
    await tid('stage').click();
    await confirmWith('e2e: stage a day-rule change');
    await page.getByText(`e2e day rule ${runId}`).waitFor();
    await tid('draft').fill(JSON.stringify({ ng: { exact: [`e2e${runId}`], contains: [] } }));
    await tid('draft-note').fill(`e2e ng ${runId}`);
    await tid('stage').click();
    await confirmWith('e2e: stage an NG list change');
    await page.getByText(`e2e ng ${runId}`).waitFor();
    assert.equal(await tid('rollback-prev').count(), 0, 'operator cannot roll back');
  });

  await step('operator: player lookup by invite code shows wallet split, purchases, flags', async () => {
    await page.locator('#nav a[data-view=players]').click();
    await tid('player-query').fill(inviteCode);
    await tid('player-search').click();
    await tid('player-head').getByText(PLAYER).waitFor();
    assert.equal((await tid('wallet-paid').textContent()).replace(/,/g, ''), String(paid0));
    assert.equal((await tid('wallet-free').textContent()).replace(/,/g, ''), String(free0));
    await tid('purchases-table').getByText(`T_${PLAYER}`).waitFor();
    await shot('03-player-support');
  });

  await step('operator: small compensation is paid at once; a large one waits for approval', async () => {
    await tid('comp-coins').fill('500');
    await tid('comp-submit').click();
    await confirmWith('e2e: outage compensation');
    await tid('toast-ok').first().waitFor();
    // REQ-BOX-010: the compensation lands in the player's gift box (the wallet changes when the player receives it)
    await tid('player-gifts').getByText('無償コイン500枚').waitFor();
    assert.equal((await tid('wallet-free').textContent()).replace(/,/g, ''), String(free0));
    await tid('comp-coins').fill('20000');
    await tid('comp-submit').click();
    await page.locator('.modal').getByText('大口のため承認待ちになります', { exact: false }).waitFor();
    await confirmWith('e2e: long outage compensation');
    await tid('player-comps').getByText('pending').waitFor();
    assert.equal(await tid('player-gifts').locator('tbody tr').count(), 1, 'the pending one is not in the box yet');
    await shot('03b-player-gift-box');
  });

  let tourId = `e2e_${runId}`.slice(0, 40);
  await step('operator: create a mini tournament and see it listed', async () => {
    await page.locator('#nav a[data-view=events]').click();
    await tid('events-table').or(page.getByText('イベントはありません')).first().waitFor();
    await tid('t-id').fill(tourId);
    await tid('t-name').fill('E2Eミニ大会');
    await tid('t-create').click();
    await confirmWith('e2e: mini tournament');
    await tid('tournament-detail').getByText(`大会 ${tourId}`).waitFor();
    await tid(`tour-${tourId}`).waitFor();
    await shot('04-events-tournaments');
  });

  await step('admin: approves the pending compensation (two-person rule)', async () => {
    await login('admin');
    await page.locator('#nav a[data-view=compensations]').click();
    const row = tid('comp-table').locator('tr', { hasText: PLAYER });
    await row.first().waitFor();
    await shot('05-compensation-pending');
    await row.first().getByRole('button', { name: '承認' }).click();
    await confirmWith('e2e: incident INC-1 confirmed');
    await page.getByText('承認し、付与しました').waitFor();
    await tid('comp-table').or(page.getByText('該当する依頼はありません')).first().waitFor();
    const st = (await asAdmin('viewer', 'GET', `/v1/admin/players/${PLAYER}`)).body.state;
    const v = st.walletDetail;
    const boxed = st.giftBox.box.reduce((a, g) => a + g.contents.freeCoins, 0);
    assert.equal(boxed, 20_500, 'both compensations wait in the gift box');
    assert.ok(st.giftBox.box.every((g) => g.source === 'ops_compensation' && g.expiresAt > Date.now() + 89 * 86_400_000), 'compensations: 90 days');
    assert.equal(v.free, free0);
    assert.equal(v.paid, paid0, 'compensation never creates paid coins');
    // the admin's own large request cannot be self-approved: disabled in the UI and refused by the server
    const own = await asAdmin('admin', 'POST', '/v1/admin/compensations', { playerId: PLAYER, grant: { freeCoins: 30_000 }, opKey: `own-${runId}`, reason: 'admin own request' });
    assert.equal(own.body.request.status, 'pending');
    await page.reload();
    await tid(`approve-${own.body.request.id}`).waitFor();
    assert.equal(await tid(`approve-${own.body.request.id}`).isDisabled(), true);
    assert.equal((await asAdmin('admin', 'POST', `/v1/admin/compensations/${own.body.request.id}/approve`, { reason: 'self approve' })).status, 403);
    assert.equal((await asAdmin('admin2', 'POST', `/v1/admin/compensations/${own.body.request.id}/reject`, { reason: 'not needed' })).body.request.status, 'rejected');
  });

  await step('operator: a player inquiry (§48) is listed without its text, opened from the player object and answered once', async () => {
    const t = await asPlayer('POST', '/v1/help/inquiries', { category: 'purchase_missing', description: 'コインを購入しましたが反映されていません。確認をお願いします。', diagnostics: { appVersion: 'e2e', platform: 'ios' } });
    const list = await asAdmin('viewer', 'GET', '/v1/admin/inquiries?status=received');
    const row = list.body.items.find((x) => x.playerId === PLAYER && x.ticketId === t.ticketId);
    assert.ok(row && !('inquiryText' in row), 'the index has no text');
    await login('operator');
    await page.locator('#nav a[data-view=inquiries]').click();
    await tid(`inq-open-${t.ticketId}`).first().click();
    await tid('inq-text').getByText('反映されていません', { exact: false }).waitFor();
    await tid('inq-reply').fill('ストアの支払いを確認し、コインを付与しました。');
    await shot('05b-inquiry-detail');
    await tid('inq-send').click();
    await confirmWith('e2e: answer the inquiry');
    await page.getByText('返信しました').waitFor();
    const mine = await asPlayer('GET', `/v1/help/inquiries/${t.ticketId}`);
    assert.equal(mine.status, 'answered');
    assert.equal(mine.messages.length, 1, 'one reply');
    assert.equal(mine.messages[0].messageText, 'ストアの支払いを確認し、コインを付与しました。');
  });

  await step('operator: support tickets (§73) — the player replies, queue filters and SLA, internal notes kept from the player, assignee, template, status, CSV without text', async () => {
    const t = await asPlayer('POST', '/v1/help/inquiries', { category: 'bug', description: 'レースの結果画面が固まります。秘密の本文 e2e です。', shareDiagnostics: false });
    assert.equal(t.diagnostics.appVersion, null, 'no diagnostics without consent');
    await login('operator');
    await page.locator('#nav a[data-view=inquiries]').click();
    await tid('inq-table').waitFor();
    await tid('inq-lang').selectOption('ja');
    await tid(`inq-open-${t.ticketId}`).first().waitFor();
    assert.ok(!(await tid('inq-table').innerText()).includes('秘密の本文'), 'the queue has no text');
    await tid(`inq-open-${t.ticketId}`).first().click();
    await tid('inq-context').waitFor();
    assert.match(await tid('inq-context').innerText(), /添えない/, 'the player did not share diagnostics');
    // an internal note: shown to ops, never to the player
    await tid('inq-note').fill('e2e: 端末のログを確認中（内部メモ）');
    await tid('inq-note-add').click();
    await confirmWith('e2e: note');
    await tid('inq-notes').getByText('内部メモ', { exact: false }).waitFor();
    await tid('inq-assign-me').click();
    await confirmWith('e2e: take it');
    await tid('inq-summary').getByText('operator', { exact: false }).waitFor();
    await tid('inq-status-in_progress').click();
    await confirmWith('e2e: checking');
    await page.getByText('状態を変えました').waitFor();
    // a reply from a template (filled in the ticket's language, with the ticket id)
    await tid('inq-template').selectOption('received_ack');
    assert.match(await tid('inq-reply').inputValue(), new RegExp(t.ticketId), 'the template carries the ticket id');
    await shot('05e-ticket-desk');
    await tid('inq-send').click();
    await confirmWith('e2e: template reply');
    await page.getByText('返信しました').waitFor();
    const seen = await asPlayer('GET', `/v1/help/inquiries/${t.ticketId}`);
    assert.equal(seen.status, 'answered');
    assert.ok(!JSON.stringify(seen).includes('内部メモ') && !('assignee' in seen), 'the player never sees the notes or the assignee');
    // the player replies (keyed) → back to received; the queue shows it waiting
    await new Promise((r) => setTimeout(r, 31_000)); // the reply interval (help.config.tickets.replyIntervalSec)
    const back = await asPlayer('POST', `/v1/help/inquiries/${t.ticketId}/messages`, { content: 'ありがとうございます。まだ固まります。' });
    assert.equal(back.status, 'received');
    const q = await asAdmin('viewer', 'GET', '/v1/admin/inquiries?status=open&assignee=operator');
    assert.ok(q.body.items.some((x) => x.ticketId === t.ticketId && x.playerId === PLAYER && x.waitingMs >= 0), 'waiting again, assigned');
    const csv = await asAdmin('viewer', 'GET', '/v1/admin/inquiries/export?status=open');
    assert.ok(csv.body.csv.startsWith('ticket_id,player_id,category,status'), 'CSV header');
    assert.ok(!csv.body.csv.includes('秘密の本文') && !csv.body.csv.includes('内部メモ'), 'CSV without text');
    await page.locator('#nav a[data-view=inquiries]').click();
    await tid('inq-csv').click();
    await page.getByText('本文なし', { exact: false }).first().waitFor();
  });

  await step('viewer: client errors (§60) — top errors by fingerprint, a desync sample links to the replay, nothing personal shown', async () => {
    const post = async (b, headers = {}) => (await fetch(API + '/v1/client-errors', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(b) })).json();
    const base = { platform: 'android', appVersion: `9.${runId.length}.0`, osVersion: 'Android 14', deviceModel: 'Pixel 8', installId: `e2e_${runId}_dev` };
    const exc = { category: 'exception', at: Date.now(), type: 'NullReferenceException', message: 'Horse "ハヤテ" missing for e2e@example.com', stack: 'Muchi.Game.HudModel.Update () (at /Users/qa/Assets/Muchi/Game/HudModel.cs:120)', handled: false, count: 3 };
    const r1 = await post({ ...base, batchId: `b_${runId}_one`, items: [exc, { category: 'desync', at: Date.now(), raceId: `race_e2e_${runId}`, tick: 812, mode: 'ranked' }] }, { 'x-dev-user': PLAYER });
    assert.equal(r1.accepted, 2, JSON.stringify(r1));
    assert.equal((await post({ ...base, batchId: `b_${runId}_one`, items: [exc] })).duplicate, true, 'the same batch id is counted once');
    await login('viewer');
    await page.locator('#nav a[data-view=client-errors]').click();
    await tid('ce-table').waitFor();
    const text = await tid('ce-table').innerText();
    assert.ok(text.includes('NullReferenceException') && !text.includes('ハヤテ') && !text.includes('e2e@example.com'), 'scrubbed titles');
    await shot('05c-client-errors');
    await tid('ce-category').selectOption('desync');
    await tid('ce-table').locator('a').first().click();
    await tid('ce-replay').first().getByText(`/v1/admin/replays/race_e2e_${runId}`, { exact: false }).waitFor();
    assert.ok(!(await tid('ce-samples').innerText()).includes('inputs'), 'a desync sample has no inputs');
    await shot('05d-client-error-desync');
  });

  await step('admin: dry run surfaces the day-rule problem; clean version is activated; diff', async () => {
    await login('admin'); // the §48 inquiry step before this one works as operator
    await page.locator('#nav a[data-view=config]').click();
    const dayRow = tid('versions-table').locator('tr', { hasText: `e2e day rule ${runId}` });
    await dayRow.getByRole('button', { name: '有効化…' }).click();
    await tid('dryrun-problems').locator('[data-group=dayRule]').waitFor();
    await shot('06-config-dryrun-dayrule');
    assert.equal(await page.locator('.modal').count(), 0, 'no confirmation after a failed dry run');
    const ngRow = tid('versions-table').locator('tr', { hasText: `e2e ng ${runId}` });
    const ngId = (await ngRow.locator('td').first().textContent()).trim();
    await ngRow.getByRole('button', { name: '有効化…' }).click();
    await confirmWith('e2e: activate NG list');
    await page.waitForFunction((id) => document.querySelector('[data-testid=active-version]')?.textContent === id, ngId);
    await tid('diff-from').selectOption('base');
    await tid('diff-to').selectOption(ngId);
    await tid('diff-run').click();
    await tid('diff-table').getByText('ng').first().waitFor();
    await shot('07-config-active-diff');
  });

  await step('admin: gacha calendar timeline and the odds page exactly as players see it', async () => {
    await page.locator('#nav a[data-view=gacha]').click();
    await tid('gacha-timeline').waitFor();
    const pub = await (await fetch(`${API}/v1/gacha/banners`)).json();
    const banner = pub.banners[0];
    await tid(`odds-${banner.id}`).click();
    await tid('odds-preview').getByText(`提供割合プレビュー：${banner.name}`).waitFor();
    const playerOdds = await (await fetch(`${API}/v1/gacha/${banner.id}/odds`)).json();
    const adminOdds = (await asAdmin('viewer', 'GET', `/v1/admin/gacha/${banner.id}/odds`)).body.odds;
    assert.deepEqual(adminOdds, playerOdds);
    for (const row of playerOdds.items.slice(0, 3)) await tid('odds-preview').getByText(row.rate).first().waitFor();
    await tid('pity-table').waitFor();
    await shot('08-gacha-calendar-odds');
  });

  await step('admin: ban and unban from the player page', async () => {
    await page.goto(`${CONSOLE}/#/players/${PLAYER}`);
    await tid('ban').click();
    await confirmWith('e2e: abuse test ban');
    await tid('integrity-kv').getByText('banned').first().waitFor();
    await tid('unban').click();
    await confirmWith('e2e: lift test ban');
    await tid('integrity-kv').getByText('ok').first().waitFor();
  });

  await step('audit log: who / when / what / before / after for every write', async () => {
    await page.locator('#nav a[data-view=audit]').click();
    await tid('audit-action').fill('compensation.approve');
    await tid('audit-search').click();
    // the refused self-approval is logged too (result FORBIDDEN), newest first
    await tid('audit-table').locator('tbody tr', { hasText: 'self approve' }).getByText('FORBIDDEN').waitFor();
    const row = tid('audit-table').locator('tbody tr', { hasText: 'e2e: incident INC-1 confirmed' }).first();
    await row.getByText('admin', { exact: true }).first().waitFor();
    await row.locator('summary').click();
    await shot('09-audit-log');
    const all = (await asAdmin('viewer', 'GET', '/v1/admin/audit?limit=200')).body.entries;
    for (const a of ['config.stage', 'config.activate', 'compensation.request', 'compensation.approve', 'compensation.reject', 'tournament.create', 'integrity.ban', 'integrity.unban', 'config.dryrun']) {
      assert.ok(all.some((e) => e.action === a && e.result === 'ok'), `audited: ${a}`);
    }
    const approve = all.find((e) => e.action === 'compensation.approve' && e.result === 'ok' && e.target === `player:${PLAYER}`);
    assert.equal(approve.before.free, free0);
    assert.equal(approve.after.free, free0);
    assert.ok(approve.after.gift?.giftId, 'the audit names the gift box entry');
  });

  await step('admin: a maintenance window (§46) for hosted cups — preview, schedule, 503 for cups only, support stays open, cancel reopens', async () => {
    await login('admin');
    await page.locator('#nav a[data-view=maintenance]').click();
    await tid('mnt-table').waitFor();
    const jstMin = (ms) => new Date(ms + 9 * 3600_000).toISOString().slice(0, 16);
    const now = Date.now();
    const id = `e2e-${runId}`;
    await tid('mnt-id').fill(id);
    await tid('mnt-start').fill(jstMin(now + 120_000)); // a window may not start in the past: the next minute but one
    await tid('mnt-end').fill(jstMin(now + 30 * 60_000));
    await tid('mnt-all').uncheck();
    await tid('mnt-g-cups').check();
    await tid('mnt-ja').fill('主催カップのメンテナンスを行います。');
    await tid('mnt-en').fill('Hosted cups are under maintenance.');
    await tid('mnt-preview-btn').click();
    await tid('mnt-banner-en').getByText('Hosted cups are under maintenance.').waitFor();
    await shot('11-maintenance-preview');
    await tid('mnt-schedule').click();
    await confirmWith('e2e: hosted cup maintenance');
    await tid(`mnt-cancel-${id}`).waitFor();
    // the window starts within two minutes; the gate reads the active config (cached up to 30 s per isolate)
    const status = async (path) => (await fetch(API + path, { headers: { 'x-dev-user': PLAYER } })).status;
    let s = 0;
    for (let i = 0; i < 200 && s !== 503; i++) { s = await status('/v1/cups'); if (s !== 503) await new Promise((r) => setTimeout(r, 1000)); }
    assert.equal(s, 503, 'cups are closed by the window');
    assert.equal(await status('/v1/help'), 200, 'the help center stays open');
    assert.equal(await status('/v1/blocks'), 200, 'the block list stays open');
    assert.notEqual(await status('/v1/player'), 503, 'core stays open (scope cups)');
    await tid(`mnt-cancel-${id}`).click();
    await confirmWith('e2e: end the window');
    await page.getByText('変更しました').waitFor();
    for (let i = 0; i < 40 && s === 503; i++) { s = await status('/v1/cups'); if (s === 503) await new Promise((r) => setTimeout(r, 1000)); }
    assert.notEqual(s, 503, 'cancel reopens cups');
  });

  await step('viewer: アップデート情報 (§64) — the active notes in Japanese and English, a draft with a shop target refused, nothing stored', async () => {
    await login('viewer');
    await page.locator('#nav a[data-view=release-notes]').click();
    await tid('rn-active-problems').waitFor();
    await tid('rn-active-en-1.2.0-1').getByText('Cheer while you watch', { exact: true }).waitFor();
    await tid('rn-active-ja-1.2.0-1').getByText('観戦中に応援できる', { exact: true }).waitFor();
    const draft = { version: 1, config: { enabled: true, titleMaxChars: 24, bodyMaxChars: 140, seenMax: 30, historyMax: 20 },
      notes: [{ appVersion: '1.3.0', releasedOn: '2026-12-01', pages: [{ art: 'coins', title: { ja: 'ショップが新しく', en: 'A new shop' }, body: { ja: 'ショップを見てください。', en: 'Take a look at the shop.' }, target: { kind: 'screen', id: 'shop' } }] }] };
    await tid('rn-draft').fill(JSON.stringify(draft));
    await tid('rn-preview-btn').click();
    await tid('rn-problems').getByText(/paid product/).waitFor();
    await tid('rn-draft-en-1.3.0-1').getByText('A new shop', { exact: true }).waitFor();
    await shot('12-release-notes');
  });

  await step('viewer: the merged calendar (§65.3) lists the dates of the version and the overlaps to check', async () => {
    await login('viewer');
    await page.locator('#nav a[data-view=calendar]').click();
    await tid('cal-overlaps').waitFor();
    await tid('cal-table').waitFor();
    assert.ok((await page.locator('[data-testid=cal-table] tbody tr').count()) > 0, 'the calendar lists dates (seasons at least)');
    await shot('13-calendar');
  });

  await step('KPI quick view lists the documented queries', async () => {
    await page.locator('#nav a[data-view=kpi]').click();
    await tid('kpi-doc').waitFor();
    assert.ok((await page.locator('.sql').count()) >= 5);
    await shot('10-kpi');
  });

  assert.deepEqual(consoleErrors.filter((e) => !/Failed to load resource/.test(e)), [], 'no console / CSP errors');
} finally {
  await browser.close();
}
console.log(JSON.stringify({ ok: steps.every((s) => s.ok), steps: steps.length, screenshots: SHOTS }));
