// ムチ一閃 web prototype — Codex's Unity frontend (unity/Assets/Muchi/Runtime/MuchiApp.cs: 1600×900 layout, colours,
// art) with the round 8 experience of docs/planning/06 (REQ-UXP-001..005) running on
//   - MuchiLogic: the real server domain code in the browser (consent, partner grant, gacha tables, naming rules, unlocks,
//     shop display data and offers, purchase-intent age checks, season pass, rewards, account deletion)
//   - MuchiRace:  the real C# race engine + Unity game layer in WebAssembly (TutorialDirector, RaceFeel, RaceDebrief,
//     RaceResultModel, RaceCameraRig, unique skills of ruleset 1.3.0)
// Round 9 (06 §7 item 12 / §7.3): the replay share card (ReplayClip / ShareCard / ReplayShareModel), the account-link
// prompt (AccountLinkPrompt) and the time attack ghost picker with the friend tab (GhostPicker, GhostPlayer).
// Nothing on these screens is a made-up number: every value comes from one of the two.
import { RaceView } from './race-view.js';

const L = globalThis.MuchiLogic;
const $screens = document.getElementById('screens');
const $stage = document.getElementById('stage');
const $canvas = document.getElementById('race-canvas');

// ---------------------------------------------------------------- colours (Unity Color → CSS)
const col = (r, g, b, a = 1) => `rgba(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)},${a})`;
const NAVY = col(.025, .075, .14, .9), CYAN = col(0, .8, .95), GOLD = col(1, .83, .08), WHITE = '#fff';
const CARD = col(.045, .12, .19, .97), MUTED = col(.8, .89, .95), DIM = col(.62, .72, .8), RED = col(1, .35, .3), YELLOW = col(1, .82, .2);

// ---------------------------------------------------------------- persistence (PlayerPrefs keys of the Unity build)
const prefs = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, String(v)); } catch { /* private mode */ } },
  int(k, d) { const v = parseInt(this.get(k, ''), 10); return Number.isFinite(v) ? v : d; },
};
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// ---------------------------------------------------------------- localisation (LocaleService; Japanese is the default)
let JA = {};
const EXTRA_JA = {
  'SCOUT RATES': '提供割合', 'RARITY TOTALS': 'レア度ごとの合計', 'EACH HORSE': '馬ごとの提供割合',
  '10TH PULL GUARANTEE (SR+)': '10連の10枠目（SR以上確定）', 'PITY': '天井', 'pulls → exchange': '回で交換',
  'Generated from the same table used for drawing (server master).': '抽選と同じ表（サーバーのマスターデータ）から自動生成しています。',
};
const isJa = () => prefs.get('muchi.language', 'ja') === 'ja';
const T = (s) => (s == null ? s : isJa() ? (JA[s] ?? EXTRA_JA[s] ?? s) : s);
const MODE_LABEL = 'PROTOTYPE  /  LOCAL ENGINE';

// ---------------------------------------------------------------- art (Unity Resources paths → site files)
let ART = {};
const art = (res) => ART[res] || '';

// ---------------------------------------------------------------- screen builder (MuchiApp helpers)
let cur = null, currentScreen = null, timers = [];
function Clear(name) {
  raceActive = false;
  timers.forEach((t) => clearInterval(t)); timers = [];
  const next = document.createElement('div');
  next.className = 'screen';
  if (name) next.dataset.screen = name;
  $screens.appendChild(next);
  const prev = [...$screens.children].filter((c) => c !== next);
  prev.forEach((p) => { p.classList.add('out'); p.classList.remove('in'); setTimeout(() => p.remove(), 320); });
  requestAnimationFrame(() => requestAnimationFrame(() => next.classList.add('in')));
  cur = next;
  $canvas.hidden = true;
  globalThis.__muchi && (globalThis.__muchi.screen = name ?? '');
}
const every = (ms, f) => { f(); timers.push(setInterval(f, ms)); };
function el(cls, x, y, w, h, parent) {
  const d = document.createElement('div');
  d.className = 'el ' + cls;
  Object.assign(d.style, { left: x + 'px', top: y + 'px', width: w + 'px', height: h + 'px' });
  (parent || cur).appendChild(d);
  return d;
}
function Panel(name, x, y, w, h, color, parent) { const d = el('panel', x, y, w, h, parent); d.style.background = color; d.dataset.name = name; return d; }
function Label(value, x, y, w, h, size = 26, color = WHITE, parent, align) {
  const d = el('label', x, y, w, h, parent);
  d.textContent = T(value);
  Object.assign(d.style, { fontSize: size + 'px', color });
  if (align === 'center') Object.assign(d.style, { display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center' });
  return d;
}
function Button(value, x, y, w, h, action, color, parent) {
  if (typeof h === 'function') { parent = color; color = action; action = h; h = 72; }
  const d = el('btn', x, y, w, h, parent);
  const bg = document.createElement('div'); bg.className = 'bg'; bg.style.background = color ?? CYAN; d.appendChild(bg);
  const s = document.createElement('span');
  s.textContent = T(value);
  const size = h < 65 ? 21 : w < 220 ? 22 : h >= 96 ? 32 : 27;
  Object.assign(s.style, { fontSize: size + 'px', color: color && color !== GOLD ? WHITE : NAVY });
  d.appendChild(s);
  d.dataset.label = value;
  d.setAttribute('role', 'button');
  d.addEventListener('click', (e) => { if (d.classList.contains('disabled')) return; e.stopPropagation(); action(); });
  return d;
}
/** Secondary action (06 §6 共通: one filled button per screen; others outlined). */
function Ghost(value, x, y, w, h, action, parent) { const b = Button(value, x, y, w, h, action, NAVY, parent); b.classList.add('ghost'); return b; }
const disable = (b) => { b.classList.add('disabled'); return b; };
function SetArt(res) { const i = document.createElement('img'); i.className = 'art'; i.src = art(res); i.alt = ''; cur.insertBefore(i, cur.firstChild); }
function ArtImage(res, x, y, w, h, parent) {
  const i = document.createElement('img'); i.className = 'img'; i.src = art(res); i.alt = '';
  Object.assign(i.style, { left: x + 'px', top: y + 'px', width: w + 'px', height: h + 'px' });
  (parent || cur).appendChild(i); return i;
}
function Veil(a = .55) { Panel('Veil', 0, 0, 1600, 900, col(.01, .035, .07, a)); }
function Header(title, sub) {
  Panel('Header', 0, 0, 1600, 96, col(.015, .05, .1, .94));
  Panel('Header rule', 0, 96, 1600, 3, CYAN);
  Label(title, 40, 22, 900, 54, 34);
  if (sub) Label(sub, 40, 62, 900, 28, 16, MUTED);
}
function WalletChip(x = 1130, y = 18) {
  const w = player?.wallet ?? { paid: 0, free: 0 };
  const p = Panel('Wallet', x, y, 430, 62, NAVY);
  Label('有償 ◈ ' + fmt(w.paid), 18, 14, 190, 34, 22, GOLD, p).style.whiteSpace = 'nowrap';
  Label('無償 ◎ ' + fmt(w.free), 215, 14, 200, 34, 22, WHITE, p).style.whiteSpace = 'nowrap';
  return p;
}
function toast(text, ms = 2600) {
  const t = document.createElement('div');
  t.className = 'toast'; t.textContent = text;
  $stage.appendChild(t);
  setTimeout(() => t.classList.add('gone'), ms); setTimeout(() => t.remove(), ms + 400);
}
function show(fn, ...args) { currentScreen = () => fn(...args); return fn(...args); }

// ---------------------------------------------------------------- local player (real PlayerService)
let player = null, lastPulls = null;
const rarityRank = (r) => (r === 'SSR' ? 3 : r === 'SR' ? 2 : r === 'R' ? 1 : 0);
async function refresh() { player = await L.view(); return player; }
// legacy screens (Stable) read this summary
function profile() {
  const p = partner();
  return {
    classId: player?.season?.classId ?? 'C', seasonPoints: player?.season?.points ?? 0,
    free: player?.wallet?.free ?? 0, paid: player?.wallet?.paid ?? 0, debt: player?.wallet?.debt ?? 0,
    partnerId: p?.id ?? null, partnerName: p?.name ?? horseName, partnerRarity: p?.rarity ?? 'SR', partnerStyle: p?.style ?? 'sashi',
    partnerSurface: p?.surface ?? 'turf', partnerDistMinM: p?.distMinM ?? 1600, partnerDistMaxM: p?.distMaxM ?? 2400,
    partnerStats: p?.base ?? { speed: 560, stamina: 540, burst: 580, guts: 520, temper: 600 }, horseCount: player?.horses?.length ?? 0,
  };
}
function partnerLine(p) {
  return `${STYLE_JA[p.partnerStyle] ?? p.partnerStyle}  /  ${p.partnerSurface === 'dirt' ? 'ダート' : '芝'}  /  ${fmt(p.partnerDistMinM)}–${fmt(p.partnerDistMaxM)}m`;
}
function partner() {
  if (!player) return null;
  const id = player.flags?.partnerHorseId;
  return player.horses.find((h) => h.id === id && (h.status === 'active' || h.status == null))
    ?? player.horses.filter((h) => h.named && (h.status === 'active' || h.status == null)).sort((a, b) => rarityRank(b.rarity) - rarityRank(a.rarity))[0] ?? null;
}
const fmt = (n) => Number(n).toLocaleString('ja-JP');
const yen = (n) => fmt(n) + '円';
const stat100 = (v) => clamp(Math.round(v / 10), 0, 100);
const STYLE_JA = { nige: '逃げ', senko: '先行', sashi: '差し', oikomi: '追込' };
const horseNameOf = (id) => player?.horses.find((h) => h.id === id)?.name;
const templateName = (id) => L.master.templates.find((t) => t.id === id)?.name ?? id;
const unlock = (key) => player?.unlocks?.features?.find((f) => f.key === key) ?? { unlocked: true };
/** 「あと2戦で開放」「3日目に開放」: the earlier of the conditions the server returns (REQ-UXS-014). */
function unlockText(key) {
  const f = unlock(key), u = player?.unlocks;
  if (!f || f.unlocked || !u) return '';
  const parts = [];
  if (f.races != null) parts.push(`あと${f.races - u.races}戦`);
  if (f.rankedRaces != null) parts.push(`初心者マッチあと${f.rankedRaces - u.rankedRaces}戦`);
  if (f.days != null) parts.push(`${f.days}日目`);
  if (f.breedings != null) parts.push(`配合あと${f.breedings - u.breedings}回`);
  return parts.join(' か ') + 'で開放';
}
function rewardText(r) {
  if (!r) return '';
  const out = [];
  if (r.paidCoins) out.push(`有償コイン${fmt(r.paidCoins)}枚`);
  if (r.freeCoins) out.push(`無償コイン${fmt(r.freeCoins)}枚`);
  for (const it of r.items ?? []) out.push(`${L.master.itemLabels[it.itemId] ?? it.itemId}×${it.qty}`);
  if (r.broodmare) out.push(`繁殖牝馬「${templateName(r.broodmare)}」`);
  return out.join('＋');
}
// the server's season end is the exclusive start of the next month: show its last minute (「11月30日 23:59まで」)
const seasonEnd = (ms) => jstDate(ms - 60_000);
const jstDate = (ms) => { const d = new Date(ms + 9 * 3600e3); return `${d.getUTCMonth() + 1}月${d.getUTCDate()}日 ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`; };
function countdown(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return `${d > 0 ? d + '日 ' : ''}${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}`;
}

// ---------------------------------------------------------------- UI state
let horseName = prefs.get('muchi.partner', 'アイボウ');
let tutorialAttempt = 1, ftue = false, firstScout = null;
let raceInfo = null, raceCtx = null, raceActive = false, lastFrame = null, reinHeld = false, keyRein = false;
let purchaseReturn = null, previewCourse = -1, viewReady = null;
const equippedPartner = () => clamp(prefs.int('muchi.partner.model', 0), 0, 4);
const equippedCourse = () => clamp(prefs.int('muchi.cosmetic.course', 0), 0, 2);
const silkArt = (i) => (i === 1 ? 'Art/Cosmetics/jockey-cyan' : i === 2 ? 'Art/Cosmetics/jockey-violet' : 'Art/Cosmetics/jockey-crimson');
const courseArt = (i) => (i === 1 ? 'Art/Courses/spring-course' : i === 2 ? 'Art/Courses/autumn-course' : 'Art/home-paddock');
const weatherArt = (i) => 'Art/Weather/' + (i === 1 ? 'cloudy' : i === 2 ? 'rain' : i === 3 ? 'fog' : 'sunny');
const foodArt = (i) => 'Art/Food/' + (i === 1 ? 'hay-carrot' : i === 2 ? 'water-bucket' : 'oats-apple');
const PARTNERS = ['Bay_Crimson', 'Chestnut_Azure', 'DappleGrey_Violet', 'Black_Emerald', 'Palomino_Gold'];
const partnerPreview = (i) => 'Art/3DPreviews/Partner_' + PARTNERS[clamp(i, 0, 4)];
const partnerSprite = (i) => 'Sprites/Partner_' + PARTNERS[clamp(i, 0, 4)];
const SILK_CSS = ['#c8283a', '#16b4e8', '#8c5ae0', '#1fa660', '#f0c020'];

// ================================================================= FTUE (REQ-UXP-001, docs/planning/06 §2.3)
function Title() {
  currentScreen = Title; Clear('title'); SetArt('Art/title-screen');
  Panel('Title legibility veil', 0, 0, 760, 900, col(.015, .055, .11, .38));
  Panel('Top wordmark rule', 76, 105, 116, 5, CYAN);
  Label('ムチ一閃', 74, 128, 700, 130, 96, WHITE);
  Label('MUCHI ISSEN  /  JOCKEY RACING', 82, 262, 650, 39, 21, col(.82, .92, 1));
  Panel('Title accent rule', 82, 325, 65, 4, GOLD);
  Label('最後の直線を、\n相棒と。', 78, 352, 720, 180, 56, WHITE);
  // REQ-UXS-001 / F18: the links sit right above the one button; tapping the button records the versions agreed to
  const c = L.consentVersions;
  const terms = Ghost('利用規約', 80, 575, 200, 64, () => Legal('terms', Title));
  const priv = Ghost('プライバシーポリシー', 296, 575, 290, 64, () => Legal('privacy', Title));
  terms.classList.add('link'); priv.classList.add('link');
  Label(`「同意してはじめる」で、利用規約（${c.termsVersion}版）とプライバシーポリシー（${c.privacyVersion}版）に同意したものとします。`, 82, 650, 620, 60, 16, MUTED);
  Button('同意してはじめる', 80, 724, 500, 108, Consent);
  Label('SEASON 01    •    TURF SERIES', 1110, 828, 450, 34, 16, WHITE);
}
async function Consent() {
  const r = await L.recordConsent();
  if (!r.ok) { toast('同意を記録できませんでした：' + r.message); return; }
  ftue = true; tutorialAttempt = 1;
  StartTutorial();
}

function Legal(kind, back) {
  currentScreen = () => Legal(kind, back); Clear('legal'); SetArt('Art/home-paddock'); Veil(.7);
  const shop = L.shopProducts();
  const notices = shop.notices;
  const c = L.consentVersions;
  const docs = {
    terms: ['利用規約', `版：${c.termsVersion}\n\n本文は運営が用意します（このプロトタイプでは見出しのみ）。\n同意の版と時刻はサーバーに記録され、版が上がると再同意を求めます（REQ-UXS-001）。`],
    privacy: ['プライバシーポリシー', `版：${c.privacyVersion}\n\n本文は運営が用意します（このプロトタイプでは見出しのみ）。`],
    tokushoho: [notices['legal.tokushoho'], '販売事業者・所在地・連絡先・販売価格・支払時期・引渡時期・返品について（本文は運営が用意します）。\n\n' + [notices['shop.no_auto_renew'], notices['shop.pass_season_only'], notices['shop.allowance_daily_claim']].join('\n')],
    shikin: [notices['legal.shikin_kessai'], '前払式支払手段（有償コイン）の発行者・支払可能金額・有効期間・問い合わせ先（本文は運営が用意します）。\n\n' + notices['shop.paid_first']],
    paidFirst: ['有償コインの使用順', notices['shop.paid_first'] + '\n\n有償コインと無償コインは分けて表示します。「有償限定」の品は有償コインだけで買えます。'],
  };
  const [title, body] = docs[kind];
  Panel('Legal', 260, 110, 1080, 680, NAVY);
  Label(title, 310, 150, 980, 56, 36, CYAN);
  Label(body, 310, 240, 980, 420, 24);
  Button('閉じる', 560, 680, 480, 92, back);
}

// ---- race (tutorial = whip only; beginner / ranked = full HUD)
let engine = null, view = null, hud = {};
async function StartTutorial() {
  await viewReady;
  raceInfo = JSON.parse(engine.StartTutorial(tutorialAttempt));
  raceCtx = { tutorial: true, attempt: tutorialAttempt, ftue };
  view.useRig = true; view.start(raceInfo, equippedPartner());
  BuildRaceScreen();
}
async function StartRace(trackId = null) {
  await viewReady;
  const p = partner();
  const { config, trackName, beginner } = await L.raceConfig(p.id, trackId);
  raceInfo = JSON.parse(engine.StartConfig(JSON.stringify(config), 'local'));
  raceCtx = { tutorial: false, config, trackName, beginner, ftue, trackId: config.track.id };
  view.useRig = true; view.start(raceInfo, equippedPartner());
  BuildRaceScreen();
}
function BuildRaceScreen() {
  const tut = raceCtx.tutorial;
  currentScreen = BuildRaceScreen; Clear(tut ? 'race-tutorial' : 'race'); cur.classList.add('race', 'hud'); $canvas.hidden = false; raceActive = true;
  lastFrame = null; reinHeld = false; keyRein = false;
  hud = { msgUntil: 0, cutins: [], shownLane: false, lastWhips: null };
  // ② remaining distance (top left) ① place / runners (top right): 「—」 until the gate opens (F7)
  Panel('Distance plate', 30, 26, 330, 92, NAVY); hud.distance = Label('残り — m', 52, 40, 300, 64, 44); hud.distance.style.whiteSpace = 'nowrap';
  Panel('Position plate', 1290, 26, 280, 104, NAVY); hud.position = Label('—', 1310, 36, 245, 84, 60, GOLD, undefined, 'center'); hud.position.style.whiteSpace = 'nowrap';
  hud.clock = Label('0:00.0', 1290, 134, 280, 30, 20, MUTED, undefined, 'center');
  // ⑥ commentary (one line, bottom centre) and the one hint line (centre)
  hud.subtitle = Label('', 380, 812, 840, 52, 26, WHITE, undefined, 'center'); hud.subtitle.classList.add('subtitle');
  hud.hint = Label('', 360, 150, 880, 76, 40, GOLD, undefined, 'center'); hud.hint.classList.add('hint');
  hud.feedback = Label('', 560, 250, 480, 80, 52, WHITE, undefined, 'center'); hud.feedback.classList.add('pop');
  // partner overhead marker (silks colour + white edge) with the mini gauge, the gap to the horse ahead and slipstream lines
  hud.marker = el('marker', 0, 0, 220, 120); hud.marker.innerHTML = '<div class="tri"></div><div class="nm"></div><div class="mini"><i></i></div><div class="gap"></div><div class="wind"></div>';
  hud.marker.style.setProperty('--silk', SILK_CSS[equippedPartner()]);
  hud.marker.querySelector('.nm').textContent = raceInfo.names[raceInfo.playerSlot];
  // whip (right thumb, ≥ 88 pt), remaining whips as number + dots
  hud.whip = Button(tut ? 'ムチ' : 'スタート', tut ? 1230 : 1300, tut ? 520 : 580, tut ? 320 : 260, tut ? 320 : 260, Whip, GOLD); hud.whip.classList.add('round', 'whip');
  hud.whipText = hud.whip.querySelector('span');
  hud.whips = el('whipdots', tut ? 1230 : 1300, tut ? 470 : 534, tut ? 320 : 260, 40);
  if (tut) {
    // F4: the first race shows the whip button only. The gate countdown is the 3-second scene-setter.
    hud.intro = Label('最後の直線。前に7頭。', 300, 330, 1000, 110, 64, WHITE, undefined, 'center'); hud.intro.classList.add('intro');
    hud.coach = Label('合図が出たら、ムチ！', 1170, 860 - 30, 420, 36, 20, MUTED, undefined, 'center');
    return;
  }
  // ③ stamina gauge (30 % yellow, 10 % red + blink, 0 「脚が上がった」) under the distance
  Panel('Stamina plate', 30, 126, 330, 70, NAVY);
  hud.staminaLabel = Label('脚', 48, 136, 60, 50, 24);
  Panel('Stamina track', 104, 148, 236, 26, col(.2, .28, .34));
  hud.staminaFill = Panel('Stamina fill', 104, 148, 236, 26, CYAN); hud.staminaFill.classList.add('gauge');
  hud.staminaText = Label('', 30, 200, 330, 32, 19, MUTED);
  // left thumb: lanes; right thumb: rein (hold, left of the whip)
  Button('内へ', 30, 660, 190, 170, () => Lane(-1), NAVY).classList.add('pad');
  Button('外へ', 236, 660, 190, 170, () => Lane(1), NAVY).classList.add('pad');
  const rein = Button('手綱\n長押し', 1080, 650, 190, 180, () => {}, NAVY); rein.classList.add('pad', 'rein'); hud.rein = rein;
  const hold = (v) => (e) => { e.preventDefault(); reinHeld = v; rein.classList.toggle('held', v); };
  rein.addEventListener('pointerdown', hold(true)); rein.addEventListener('pointerup', hold(false)); rein.addEventListener('pointerleave', hold(false)); rein.addEventListener('pointercancel', hold(false));
  // ⑤ minimap: every runner's position along the course, vertical, the partner as the big dot
  Panel('Minimap', 1500, 180, 70, 320, NAVY);
  Label('先頭', 1490, 152, 90, 26, 14, MUTED, undefined, 'center');
  hud.spread = Label('', 1470, 502, 130, 26, 14, MUTED, undefined, 'center');
  hud.dots = raceInfo.names.map((_, i) => { const d = Panel('Runner ' + i, 1529, 520, 12, 12, WHITE); d.classList.add('dot'); if (i === raceInfo.playerSlot) d.classList.add('me'); return d; });
  // skill cut-ins (engine Skill events)
  hud.skillBox = el('cutins', 440, 560, 620, 230);
  Ghost('中断', 30, 248, 150, 64, () => { raceActive = false; Home(); });
}
function Lane(dir) { if (!raceActive || raceCtx.tutorial) return; engine.Lane(dir); }
function Whip() {
  if (!lastFrame || !raceActive) return;
  if (raceCtx.tutorial && !lastFrame.departed) return;
  if (lastFrame.departed && lastFrame.whips <= 0) return;
  engine.Spur();
  // presentation first (06 §6.3: the button and the horse react within a frame; the engine takes the input next tick)
  flash(hud.feedback, lastFrame.departed ? '伸びる！' : 'スタート！');
  hud.whip.classList.remove('hit'); void hud.whip.offsetWidth; hud.whip.classList.add('hit');
  try { navigator.vibrate?.(lastFrame.departed ? 40 : [12, 40, 12]); } catch { /* not supported */ }
}
function flash(node, text, ms = 1100) {
  node.textContent = text; hud.msgUntil = performance.now() + ms;
  node.classList.remove('flash'); void node.offsetWidth; node.classList.add('flash');
}
function raceLoop() {
  requestAnimationFrame(raceLoop);
  if (!raceActive) return;
  engine.Rein(reinHeld || keyRein);
  const f = JSON.parse(engine.Frame(performance.now()));
  lastFrame = f;
  view.draw(f);
  paintHud(f);
  if (f.done) { raceActive = false; setTimeout(() => RaceResult(f), 1100); }
}
function paintHud(f) {
  const tut = raceCtx.tutorial, feel = f.feel ?? {};
  hud.position.textContent = f.rankKnown ? `${f.rank}位/${f.runners}頭` : '—';
  hud.position.style.fontSize = (f.rankKnown ? 46 : 60) + 'px';
  hud.distance.textContent = `残り ${fmt(f.remainingM)} m`;
  hud.clock.textContent = f.time;
  // whip button: START before the gate (normal races), glowing only inside the whip window (F5)
  if (!tut) hud.whipText.textContent = f.departed ? 'ムチ' : 'スタート';
  else hud.whipText.textContent = f.departed ? 'ムチ' : 'まもなく';
  hud.whip.classList.toggle('chance', !!feel.whipChance);
  hud.whip.classList.toggle('disabled', tut ? !f.departed || f.whips <= 0 : f.departed && f.whips <= 0);
  if (hud.lastWhips !== f.whips) {
    hud.lastWhips = f.whips;
    hud.whips.innerHTML = `<b>${f.whips}</b>` + Array.from({ length: f.maxWhips }, (_, i) => `<i class="${i < f.whips ? 'on' : ''}"></i>`).join('');
  }
  if (tut && hud.intro) {
    const showIntro = !f.departed;
    hud.intro.style.opacity = showIntro ? 1 : 0;
  }
  // the one line: race feel hint (kakari / stamina / whip chance / runaway / slipstream), else one-time lane coaching
  let hint = feel.slipstream && feel.hint === '脚をためている' ? '' : feel.hint || '';
  if (!hint && !tut && f.departed && !hud.shownLane && f.remainingM < f.distanceM * .8) { hud.shownLane = performance.now() + 3200; }
  if (!hint && !tut && hud.shownLane && performance.now() < hud.shownLane) hint = '「内へ／外へ」で進路を変えられます';
  if (tut && feel.whipChance) hint = '今だ、ムチ！';
  if (feel.mashed) hint = '連打は効きが落ちる：間をあけて';
  hud.hint.textContent = hint;
  hud.hint.className = 'el label hint' + (feel.kakariWarning || feel.level === 'Critical' || feel.level === 'Empty' ? ' warn' : '');
  for (const c of feel.cues ?? []) {
    if (c.kind === 'Overtake') { flash(hud.feedback, '抜いた！', 900); try { navigator.vibrate?.(15); } catch { /* */ } }
    if (c.kind === 'StaminaCritical') { try { navigator.vibrate?.([30, 30, 30]); } catch { /* */ } }
  }
  if (performance.now() > hud.msgUntil) hud.feedback.textContent = '';
  hud.subtitle.textContent = f.subtitle;
  if (hud.ghost && f.ghostPoses?.[0]) { const gap = f.ghostPoses[0][4]; hud.ghost.textContent = `ゴースト ${raceCtx.ghost.name}：${gap >= 0 ? '前' : '後ろ'} ${Math.abs(gap).toFixed(1)}m`; }
  // overhead marker on the partner
  const p = view.project(raceInfo.playerSlot, 3.1);
  if (p && f.horses[raceInfo.playerSlot]?.[6]) {
    hud.marker.style.display = '';
    hud.marker.style.transform = `translate(${Math.round(p.x - 110)}px, ${Math.round(p.y - 120)}px)`;
    hud.marker.querySelector('.mini i').style.width = (f.stamina / 10) + '%';
    hud.marker.dataset.level = feel.level ?? 'Ok';
    hud.marker.classList.toggle('kakari', !!f.kakari);
    hud.marker.querySelector('.gap').textContent = !tut && f.departed && feel.gapAhead ? '前と' + feel.gapAhead : '';
    hud.marker.classList.toggle('slip', !!feel.slipstream);
    hud.marker.querySelector('.wind').textContent = feel.slipstream ? '脚をためている' : '';
  } else hud.marker.style.display = 'none';
  if (tut) return;
  hud.staminaFill.style.width = (236 * f.stamina / 1000) + 'px';
  hud.staminaFill.dataset.level = feel.level ?? 'Ok';
  hud.staminaFill.classList.toggle('blink', !!feel.blink);
  hud.staminaText.textContent = feel.level === 'Empty' ? '脚が上がった' : f.kakari ? (f.reining ? '手綱で抑えている' : '掛かっている') : f.reining ? '手綱：抑えて脚をためる' : feel.level === 'Low' ? '脚が残り少ない' : feel.level === 'Critical' ? '脚がもうない！' : '';
  hud.rein.classList.toggle('need', !!feel.kakariWarning);
  // ⑤ every runner by distance behind the leader (the field's spread fills the strip, at least 30 m)
  const ds = f.progress.map((pr) => pr * f.distanceM), lead = Math.max(...ds), spread = Math.max(30, lead - Math.min(...ds));
  ds.forEach((d, i) => { if (hud.dots[i]) hud.dots[i].style.top = (194 + 280 * (lead - d) / spread) + 'px'; });
  hud.spread.textContent = `↕ ${Math.round(spread)}m`;
  // skill cut-ins: about 2 s each, the partner's own in gold
  for (const e of f.skillEvents ?? []) {
    const mine = e.slot === raceInfo.playerSlot;
    const c = document.createElement('div'); c.className = 'cutin' + (mine ? ' mine' : '');
    c.innerHTML = `<small>${mine ? '相棒の固有スキル' : e.rank + '番手'}</small><b></b><em></em>`;
    c.querySelector('b').textContent = '「' + e.name + '」'; c.querySelector('em').textContent = e.horse;
    hud.skillBox.prepend(c);
    while (hud.skillBox.children.length > 2) hud.skillBox.lastChild.remove();
    setTimeout(() => c.classList.add('gone'), 2200); setTimeout(() => c.remove(), 2600);
    if (mine) try { navigator.vibrate?.(30); } catch { /* */ }
  }
}
document.addEventListener('keydown', (e) => {
  if (!raceActive || e.repeat) return;
  if (e.key === 'ArrowLeft') Lane(-1);
  else if (e.key === 'ArrowRight') Lane(1);
  else if (e.key === 'e' || e.key === 'E') Whip();
  else if (e.code === 'Space') { keyRein = true; e.preventDefault(); }
});
document.addEventListener('keyup', (e) => { if (e.code === 'Space') keyRein = false; });
window.addEventListener('blur', () => { reinHeld = false; keyRein = false; });

// ---- results (REQ-UXP-005 debrief line, 06 §6.4)
async function RaceResult(f) {
  if (raceCtx.tutorial) return TutorialResult(f);
  if (raceCtx.ta) return show(TaResult, f);
  const r = f.result;
  const finishTick = r.place > 0 ? f.finishTicks[r.place - 1] : -1;
  const passBefore = await L.passView();
  const applied = await L.applyRace(raceCtx.config.raceId, r.place, r.runners, { trackId: raceCtx.trackId, style: partner()?.style ?? 'sashi', finishTick: finishTick >= 0 ? finishTick : null, whips: r.facts?.whips ?? 0 });
  const passAfter = await L.passView();
  const missions = await L.missions();
  await refresh();
  const rewards = applied.ok ? applied.value : { coins: 0, seasonPoints: 0, firstWinBonus: 0 };
  show(ResultScreen, f, rewards, passAfter.xp - passBefore.xp + (passAfter.level - passBefore.level) * 0, passAfter, missions.ok ? missions.value : []);
}
function ResultScreen(f, rewards, passXp, pass, missions) {
  const r = f.result, first = raceCtx.ftue;
  Clear('result'); SetArt('Art/race-result');
  Panel('Result veil', 0, 0, 1600, 900, col(.01, .03, .06, .35));
  Panel('Result detail', 40, 40, 700, 820, NAVY);
  Label(`${raceCtx.trackName}　·　${raceCtx.beginner ? '初心者マッチ' : 'ランク戦'}（端末内のエンジンで実行）`, 76, 66, 640, 32, 17, CYAN);
  // ① place (big)
  Label(r.place > 0 ? String(r.place) : '—', 76, 96, 220, 170, 150, r.place === 1 ? GOLD : WHITE);
  Label(`着 / ${r.runners}頭`, 260, 190, 300, 60, 36, r.place === 1 ? GOLD : WHITE);
  Label(`タイム ${r.time}${r.place > 1 && r.margin ? '　·　勝ち馬から ' + r.margin : r.place === 1 && r.margin ? '　·　2着に ' + r.margin : ''}`, 76, 268, 640, 34, 21, MUTED);
  // ② the reason in one line + one tip (RaceDebrief)
  const why = Panel('Debrief', 76, 314, 628, 128, r.won ? col(.12, .1, .02, .9) : col(.03, .12, .19, .95));
  Label(r.won ? '勝因' : '敗因', 20, 14, 120, 30, 18, r.won ? GOLD : CYAN, why);
  Label(r.line || '—', 20, 44, 590, 44, 30, WHITE, why).dataset.debrief = r.code;
  Label(r.tip ? 'ヒント：' + r.tip : '', 20, 90, 590, 30, 18, MUTED, why);
  // ③ rewards on one screen
  Label('報酬', 76, 462, 200, 30, 18, CYAN);
  const items = [
    ['無償コイン', '+' + fmt(rewards.coins + (rewards.firstWinBonus ?? 0)), rewards.firstWinBonus ? `初勝利ボーナス +${rewards.firstWinBonus} を含む` : ''],
    ['シーズンpt', '+' + fmt(rewards.seasonPoints), `クラス${player.season.classId}　計${fmt(player.season.points)}pt`],
    ['パスXP', '+' + fmt(passXp), `パス Lv${pass.level}　次まで${pass.xpToNextLevel}XP`],
  ];
  items.forEach(([k, v, s], i) => {
    const c = Panel('Reward ' + i, 76 + i * 212, 498, 200, 128, CARD);
    Label(k, 14, 10, 180, 26, 16, MUTED, c); Label(v, 14, 36, 180, 48, 34, GOLD, c); Label(s, 14, 86, 180, 40, 13, DIM, c);
  });
  if (missions.length && unlock('missions').unlocked) {
    Label('デイリー ' + missions.map((m) => `${m.kind === 'races' ? '出走' : m.kind === 'wins' ? '勝利' : '3着内'} ${m.progress}/${m.target}`).join('　'), 76, 640, 640, 30, 17, MUTED);
  } else Label('デイリーミッション：' + unlockText('missions'), 76, 640, 640, 30, 17, DIM);
  // primary: もう一度 (F13) — in the first session it continues the onboarding instead
  if (first) {
    Button('つづける', 76, 690, 400, 100, () => AfterFirstRace(r));
    Ghost('もう一度', 492, 690, 212, 100, () => { raceCtx.ftue = false; ftue = false; StartRace(); });
  } else {
    Button('もう一度', 76, 690, 400, 100, () => OfferThen(() => StartRace()));
    Ghost('ホーム', 492, 690, 212, 100, () => OfferThen(Home));
  }
  // replay share (REQ-UXS-070): the last 200 m re-simulated on the device
  if (!first) Ghost('リプレイを共有', 1250, 806, 310, 76, () => ShareCard(currentScreen)).classList.add('share');
  // ④ result table, the player's row highlighted
  const rows = r.rows.slice(0, 12);
  const t = Panel('Order panel', 780, 40, 780, 74 + rows.length * 56, NAVY);
  Label('着順', 24, 18, 200, 34, 18, CYAN, t);
  rows.forEach((row, i) => {
    const y = 60 + i * 56;
    if (row.player) Panel('Me', 8, y - 4, 764, 52, col(1, .83, .08, .16), t);
    Label(String(row.place), 24, y, 60, 44, 26, row.player ? GOLD : WHITE, t);
    Label(row.name + (row.player ? '（相棒）' : ''), 90, y, 440, 44, 24, row.player ? GOLD : WHITE, t);
    Label(row.margin, 560, y + 4, 200, 40, 20, MUTED, t);
  });
}
async function AfterFirstRace(r) {
  ftue = false;
  // 06 §2.3 3:40: the notification primer only after a top-3 finish; otherwise wait for the next top 3
  if (r.place <= 3) return NotifyPrimer();
  prefs.set('muchi.notify.primer', 'pending');
  return Home();
}
function NotifyPrimer() {
  currentScreen = NotifyPrimer; Clear('notify'); SetArt('Art/race-result'); Veil(.6);
  Panel('Primer', 360, 150, 880, 600, NAVY);
  Label('お知らせを受け取りますか？', 410, 196, 780, 60, 40, CYAN);
  Label('シーズン開幕や大会の呼び出しを知らせます。\n通知の種類はあとから設定で選べます。', 410, 286, 780, 120, 28);
  Label('「通知を受け取る」のあと、端末の確認画面が出ます（このプロトタイプでは出しません）。', 410, 430, 780, 60, 18, MUTED);
  Button('通知を受け取る', 410, 560, 480, 100, () => { prefs.set('muchi.notify.primer', 'accepted'); Home(); });
  Ghost('あとで', 910, 560, 280, 100, () => { prefs.set('muchi.notify.primer', 'later'); Home(); });
}
function TutorialResult(f) {
  const r = f.result;
  if (r.won) return show(Victory, r);
  return show(TutorialRetry, r);
}
function Victory(r) {
  Clear('victory'); SetArt('Art/race-result');
  Panel('Victory veil', 0, 0, 1600, 900, col(.01, .03, .06, .45));
  const face = ArtImage(partnerSprite(equippedPartner()), 820, 80, 680, 680); face.classList.add('zoom');
  Label(r.headline || '差し切った！', 70, 120, 760, 150, 112, GOLD).classList.add('flash');
  Label(r.line, 76, 300, 700, 60, 32);
  Label(`${r.margin ? r.margin + '差' : ''}　·　タイム ${r.time}`, 76, 360, 700, 40, 22, MUTED);
  Label('この馬が、あなたの相棒になります。', 76, 470, 700, 50, 30);
  Button('相棒に名前をつける', 76, 640, 560, 108, () => { ftue = true; NamePartner(); });
}
function TutorialRetry(r) {
  Clear('tutorial-retry'); SetArt('Art/first-ride'); Veil(.5);
  Panel('Retry', 70, 110, 800, 640, NAVY);
  Label('おしい！ ' + (r.margin ? r.margin + '差' : '') + 'の' + r.place + '着', 110, 150, 720, 80, 50, CYAN);
  Label(r.line, 110, 250, 720, 50, 30);
  Label(r.tip ? 'ヒント：' + r.tip : '', 110, 310, 720, 80, 24, MUTED);
  Label('同じ場面から、すぐにもう一度走れます。', 110, 420, 720, 50, 24);
  Button('もう一度', 110, 600, 520, 108, () => { tutorialAttempt = r.nextAttempt || tutorialAttempt + 1; StartTutorial(); });
}

// ---- naming the horse you rode (REQ-UXS-002, F1–F3)
const NAME_CHIPS = ['イッセン', 'アカツキ', 'ハヤテマル'];
let nameError = '';
function NamePartner(value = '') {
  currentScreen = () => NamePartner(value); Clear('naming'); SetArt('Art/partner-naming');
  Panel('Name panel', 940, 60, 620, 780, NAVY);
  Label('乗った馬に、名前を', 980, 96, 540, 36, 20, CYAN);
  Label('この馬に名前を', 980, 140, 540, 70, 46);
  Label('カタカナ2〜9文字。ひらがなはカタカナに変わります。', 980, 216, 540, 34, 18, MUTED);
  const fieldPanel = Panel('Name field', 980, 266, 540, 92, col(.13, .2, .27));
  const input = document.createElement('input');
  input.className = 'field'; input.maxLength = 12; input.value = value; input.placeholder = 'ここに入力'; input.setAttribute('aria-label', '馬の名前');
  Object.assign(input.style, { left: '18px', top: '16px', width: '505px', height: '60px', fontSize: '38px' });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') ConfirmName(input.value); });
  fieldPanel.appendChild(input);
  Label('候補', 980, 374, 200, 30, 18, CYAN);
  NAME_CHIPS.forEach((n, i) => { const b = Ghost(n, 980 + i * 182, 410, 170, 88, () => { input.value = n; nameError = ''; err.textContent = ''; [...cur.querySelectorAll('.chip')].forEach((c) => c.classList.toggle('on', c === b)); }); b.classList.add('chip'); });
  const err = Label(nameError, 980, 512, 540, 60, 20, RED);
  const t = L.partnerTemplate;
  if (t) Label(`${t.rarity}　·　${STYLE_JA[t.style]}　·　スピード ${stat100(t.stats.speed)}　スタミナ ${stat100(t.stats.stamina)}　瞬発 ${stat100(t.stats.burst)}`, 980, 580, 560, 30, 18, GOLD);
  const sk = t?.skillId ? L.horseSkill({ skillId: t.skillId }) : null;
  if (sk) Label(`固有スキル「${sk.name}」：${sk.condition}／${sk.effect}`, 980, 612, 560, 56, 16, MUTED);
  Button('この名前にする', 980, 700, 540, 104, () => ConfirmName(input.value));
}
async function ConfirmName(raw) {
  const value = (raw ?? '').trim();
  if (value.length < 1) { nameError = '名前を入れるか、候補から選んでください。'; NamePartner(value); return; }
  const r = await L.grantPartner(value);
  if (!r.ok) {
    nameError = r.code === 'NG_NAME' ? 'この名前は使えません。別の名前にしてください。' : r.code === 'PARTNER_ALREADY_GRANTED' ? 'もう名前が付いています。' : 'カタカナ2〜9文字で入力してください（ひらがなは自動でカタカナになります）。';
    if (r.code === 'PARTNER_ALREADY_GRANTED') { await refresh(); return PartnerArrive(); }
    NamePartner(value); return;
  }
  nameError = '';
  await refresh(); horseName = partner()?.name ?? value; prefs.set('muchi.partner', horseName);
  PartnerArrive();
}
function PartnerArrive() {
  currentScreen = PartnerArrive; Clear('partner-arrive'); SetArt('Art/home-paddock');
  Panel('Arrive veil', 0, 0, 1600, 900, col(.01, .03, .06, .3));
  const horse = ArtImage(partnerSprite(equippedPartner()), 500, 120, 600, 600); horse.classList.add('walkin');
  const tag = Panel('Name tag', 560, 690, 480, 110, NAVY); tag.classList.add('nametag');
  Label(horseName, 0, 14, 480, 80, 56, GOLD, tag, 'center');
  Label('あなたの相棒', 0, 60, 1600, 50, 30, WHITE, undefined, 'center');
  // no tap needed: it walks in and moves on (tap to skip)
  cur.addEventListener('click', () => FreeScout(), { once: true });
  const me = cur; setTimeout(() => { if (cur === me) FreeScout(); }, 3200);
}

// ---- first gacha with a card-by-card reveal (REQ-GACHA-010, F9)
function FreeScout() {
  currentScreen = FreeScout; Clear('free-scout'); SetArt('Art/scout-reveal'); Veil(.3);
  Panel('Scout info', 60, 90, 760, 720, NAVY);
  Label('入厩祝い', 100, 130, 680, 40, 24, CYAN);
  Label('10頭スカウト\n（SR以上1頭確定）', 100, 180, 680, 170, 56);
  Label('無料・コインは使いません。出た馬はすべて厩舎に入ります。\n同じ馬が出たら、覚醒素材になります。', 100, 380, 680, 90, 22, MUTED);
  Ghost('提供割合', 100, 510, 260, 72, () => Odds('standard'));
  Button('10頭スカウトする（無料）', 100, 640, 680, 110, async () => {
    const r = await L.tutorialDraw();
    if (!r.ok) { toast(r.code === 'TUTORIAL_GACHA_USED' ? '入厩祝いのスカウトは受け取り済みです' : r.message); return Home(); }
    firstScout = r.value; await refresh();
    Reveal(r.value, true);
  });
}
const RARITY_SHAPE = { N: '●', R: '◆', SR: '★', SSR: '★★' };
/** A result card. `c` is a GachaRevealModel card (shape + text + color + frame + badge, from the Unity game layer in WASM). */
function rarityCard(c, big) {
  const d = document.createElement('div');
  d.className = `rcard r-${c.rarity} f-${c.frame ?? 'plain'}${big ? ' big' : ''}`;
  d.innerHTML = `<div class="shape"></div><div class="rar"></div><div class="nm"></div><div class="tag"></div>`;
  d.querySelector('.shape').textContent = c.shape ?? RARITY_SHAPE[c.rarity] ?? '●';
  d.querySelector('.rar').textContent = c.text ?? c.rarity;
  d.querySelector('.nm').textContent = c.name ?? templateName(c.templateId);
  const tag = d.querySelector('.tag');
  tag.textContent = (c.guaranteed ? '確定枠　' : '') + (c.badge ?? '');
  if (c.isNew) d.classList.add('new');
  if (c.duplicate) d.classList.add('dup');
  d.setAttribute('aria-label', c.caption ?? `${c.rarity} ${c.name}`);
  d.dataset.rarity = c.rarity; d.dataset.slot = c.slot;
  return d;
}
/** The card back before the flip: it already glows in the coming rarity's color and shows its shape (06 §6.5 光の色＋形). */
function cardBack(c) {
  const d = document.createElement('div');
  d.className = `rcard back r-${c.rarity} f-${c.frame ?? 'plain'} big`;
  d.innerHTML = '<div class="shape"></div><div class="rar"></div>';
  d.querySelector('.shape').textContent = c.shape; d.querySelector('.rar').textContent = 'タップでめくる';
  d.style.setProperty('--glow', c.color);
  return d;
}
/** Template id → name for the reveal plan (the horse's own name when the stable already named it). */
function revealNames(results) {
  const names = {};
  for (const p of results) names[p.templateId] = horseNameOf(p.horseId) ?? templateName(p.templateId);
  return names;
}
/**
 * Scout reveal (06 §6.5): one card per tap, rarest last (order from GachaRevealModel), 「すべてめくる」 skips to the summary in
 * one tap; the summary always lists every result with NEW / ダブり→覚醒素材 +N, totals, coins, step-up and pity lines.
 */
function Reveal(draw, first, bannerId, pity) {
  const plan = JSON.parse(engine.GachaReveal(JSON.stringify(draw), JSON.stringify(revealNames(draw.results))));
  globalThis.__muchi && (globalThis.__muchi.reveal = plan);
  let i = 0;
  const step = () => {
    currentScreen = step; Clear('scout-reveal'); SetArt('Art/scout-reveal'); Veil(.45);
    Label(`${i + 1} / ${plan.order.length}`, 0, 40, 1600, 50, 28, MUTED, undefined, 'center');
    const c = plan.order[i];
    const holder = el('cardholder', 560, 110, 480, 600);
    // the back glows first (rarity light), then the face flips in
    const back = cardBack(c); holder.appendChild(back);
    const me = cur;
    const face = () => { if (cur !== me || !holder.contains(back)) return; holder.innerHTML = ''; const f = rarityCard(c, true); f.classList.add('flip'); holder.appendChild(f); };
    setTimeout(face, 380);
    back.addEventListener('click', face);
    const t = L.master.templates.find((x) => x.id === c.templateId);
    const sk = L.horseSkill({ templateId: c.templateId });
    Label(t ? `${STYLE_JA[t.style]}　·　${t.surface === 'dirt' ? 'ダート' : '芝'} ${fmt(t.distMinM)}〜${fmt(t.distMaxM)}m${sk ? '　·　固有スキル「' + sk.name + '」' : ''}` : '', 0, 724, 1600, 40, 22, WHITE, undefined, 'center');
    const next = Button(i + 1 < plan.order.length ? 'タップでめくる' : '一覧を見る', 560, 776, 480, 100, () => { i++; if (i < plan.order.length) step(); else List(); });
    next.classList.add('next');
    Ghost('すべてめくる', 1210, 776, 340, 100, List);
  };
  const List = () => {
    currentScreen = List; Clear('scout-list'); SetArt('Art/scout-reveal'); Veil(.55);
    Label(first ? '入厩祝い　10頭スカウトの結果' : `スカウトの結果　${plan.summary.length}頭`, 60, 24, 1100, 50, 32, CYAN);
    const sub = Label(plan.summaryLine + (plan.spentLine ? '　·　' + plan.spentLine : ''), 60, 74, 1500, 34, 20, MUTED);
    sub.dataset.summary = plan.summaryLine;
    const big = plan.summary.length <= 5;
    plan.summary.forEach((c, k) => {
      const h = el('cardholder', 60 + (k % 5) * 300, 120 + Math.floor(k / 5) * 300, 280, big ? 420 : 280);
      const card = rarityCard(c, false); card.style.animationDelay = (k * .04) + 's'; card.classList.add('reveal-card'); h.appendChild(card);
    });
    const lines = [];
    if (plan.stepUpLine) lines.push(plan.stepUpLine);
    if (pity) lines.push(`交換pt ${pity.points} / ${pity.cost}` + (pity.remaining > 0 ? `（あと${pity.remaining}回）` : '（交換できます）'));
    if (lines.length) Label(lines.join('　·　'), 60, 726, 980, 40, 20, GOLD).dataset.revealLines = '1';
    if (first) Button('つづける', 1060, 770, 500, 100, SecondRaceIntro);
    else { Button('ホームへ', 1060, 770, 500, 100, Home); Ghost('もう一度スカウト', 700, 770, 340, 100, () => Scout(bannerId)); }
  };
  step();
}
function SecondRaceIntro() {
  currentScreen = SecondRaceIntro; Clear('second-race'); SetArt('Art/first-ride'); Veil(.35);
  Panel('Intro', 920, 70, 640, 760, NAVY);
  Label('2戦目', 960, 106, 560, 36, 20, CYAN);
  Label(`${horseName}で、\n本番のコースへ`, 960, 150, 560, 150, 50);
  Label('青葉競馬場 芝1,600m　·　12頭　·　初心者マッチ', 960, 330, 560, 34, 22, GOLD);
  Label('スタートでボタンを押す。\n最後の直線でムチ。\n掛かったら「手綱」を長押し。', 960, 400, 560, 160, 28);
  Label('相手は初心者向けのCPU（サーバーと同じ組み方）。端末内のエンジンで走ります。', 960, 580, 560, 60, 17, MUTED);
  Button('出走する', 960, 690, 560, 108, () => StartRace('aoba_turf_1600'));
}

// ================================================================= home (REQ-UXP-002, 06 §6.1 / §4.3)
const TABS = [['ホーム', () => Home()], ['厩舎', () => Stable()], ['スカウト', () => Scout()], ['ショップ', () => Store('recommended')], ['その他', () => Settings()]];
function TabBar(active) {
  Panel('Tab bar', 0, 800, 1600, 100, col(.015, .05, .1, .96));
  Panel('Tab rule', 0, 800, 1600, 2, col(.2, .4, .5));
  TABS.forEach(([name, go], i) => {
    const key = name === 'ショップ' ? 'shop' : null;
    const locked = key && !unlock(key).unlocked;
    const b = Button(locked ? name + '　🔒' : name, i * 320, 802, 320, 98, locked ? () => toast(`${name}は${unlockText(key)}`) : go, i === active ? col(0, .8, .95, .22) : 'transparent');
    b.classList.add('tab'); if (i === active) b.classList.add('on'); if (locked) b.classList.add('locked');
  });
}
async function Home() {
  currentScreen = Home;
  await refresh();
  // the day's login bonus is received automatically and shown as a toast (06 §4.2)
  let bonus = null;
  const today = new Date(L.now() + 9 * 3600e3).toISOString().slice(0, 10);
  if (player.loginBonus?.lastClaimDate !== today) { const r = await L.claimLogin(); if (r.ok) { bonus = r.value; await refresh(); } }
  const p = partner();
  if (p) horseName = p.name;
  const [missions, fw, bond] = await Promise.all([L.missions(), L.firstWinBonus(), p ? L.bond(p.id) : null]);
  Clear('home'); SetArt('Art/home-paddock');
  Panel('Home veil', 0, 0, 1600, 800, col(.01, .03, .06, .18));
  const u = player.unlocks;
  // top: class / season (④) and the wallet
  const season = Panel('Season', 30, 18, 560, 86, NAVY);
  const cls = L.master.classes.find((c) => c.id === player.season.classId);
  if (unlock('season').unlocked) {
    Label(`クラス ${player.season.classId}　${fmt(player.season.points)}pt`, 22, 10, 520, 40, 28, CYAN, season);
    Label(cls?.promotePoints ? (player.season.points >= cls.promotePoints ? '昇級ラインに到達（月末に昇級）' : `昇級まであと${fmt(cls.promotePoints - player.season.points)}pt（月末に昇級）`) : '最上位クラス', 22, 50, 520, 30, 17, MUTED, season);
  } else {
    Label('シーズン・クラス 🔒', 22, 10, 520, 40, 26, DIM, season);
    Label(unlockText('season') + '（C級から。月末に昇級）', 22, 50, 520, 30, 17, DIM, season);
  }
  Label(`${u.day}日目　·　${u.races}戦`, 610, 30, 300, 40, 20, WHITE).classList.add('shadow');
  WalletChip();
  // ① partner (name, bond, condition)
  const pc = Panel('Partner', 30, 120, 620, 450, NAVY);
  ArtImage(partnerSprite(equippedPartner()), 330, 90, 300, 300, pc);
  Label('相棒', 26, 20, 200, 30, 18, CYAN, pc);
  Label(p ? p.name : '—', 26, 52, 520, 80, 56, WHITE, pc);
  if (p) {
    Label(`${p.rarity}　·　${STYLE_JA[p.style] ?? p.style}　·　${p.surface === 'dirt' ? 'ダート' : '芝'} ${fmt(p.distMinM)}〜${fmt(p.distMaxM)}m`, 26, 136, 560, 30, 19, GOLD, pc);
    const sk = L.horseSkill(p);
    if (sk) Label(`固有スキル「${sk.name}」`, 26, 172, 360, 30, 18, MUTED, pc);
    if (unlock('bond').unlocked && bond?.ok) {
      Label(`絆 Lv${bond.value.level}`, 26, 300, 200, 40, 28, WHITE, pc);
      Label(bond.value.nextLevelAt != null ? `次のLvまで ${bond.value.nextLevelAt - bond.value.points}` : '最大', 26, 340, 260, 28, 16, MUTED, pc);
      Label(`調子：${['ふつう', '上向き', '好調'][Math.min(2, bond.value.todayActions)]}`, 26, 372, 260, 30, 20, WHITE, pc);
      Ghost('お世話', 300, 360, 150, 72, Care, pc);
    } else {
      Label('絆・お世話 🔒', 26, 300, 300, 36, 24, DIM, pc);
      Label(unlockText('bond'), 26, 340, 300, 30, 16, DIM, pc);
    }
    Ghost('詳しく', 470, 360, 130, 72, Stable, pc);
  } else {
    Label('無料スカウトで相棒を迎えよう', 26, 160, 560, 40, 24, WHITE, pc);
  }
  // ③ today's to-do: login bonus, daily missions, first-win bonus
  const td = Panel('Today', 670, 120, 520, 450, NAVY);
  Label('今日やること', 24, 20, 400, 34, 22, CYAN, td);
  const row = (y, title, value, sub, done, locked) => {
    const r = Panel('Todo', 16, y, 488, 116, locked ? col(.03, .07, .11, .9) : CARD, td);
    Label((locked ? '🔒 ' : done ? '✓ ' : '') + title, 18, 12, 300, 36, 22, locked ? DIM : done ? col(.5, .9, .6) : WHITE, r);
    Label(value, 300, 10, 170, 40, 26, locked ? DIM : GOLD, r).style.textAlign = 'right';
    Label(sub, 18, 58, 460, 50, 16, locked ? DIM : MUTED, r);
    return r;
  };
  const lb = player.loginBonus;
  if (unlock('login_bonus').unlocked || bonus) row(66, 'ログインボーナス', lb?.beginnerDay ? `初心者 ${lb.beginnerDay}/7日` : `${lb?.streakDay ?? 0}日目`, bonus ? '受け取りました：' + rewardText(bonus.reward) : '今日の分は受け取り済み', true, false);
  else row(66, 'ログインボーナス', '', unlockText('login_bonus'), false, true);
  const ms = missions.ok ? missions.value : [];
  const done = ms.filter((m) => m.progress >= m.target).length;
  if (unlock('missions').unlocked) {
    const m = row(194, 'デイリーミッション', `${done}/${ms.length}`, ms.map((x) => `${x.kind === 'races' ? '出走' : x.kind === 'wins' ? '勝利' : '3着内'} ${x.progress}/${x.target}${x.claimed ? '✓' : ''}`).join('　'), done === ms.length && ms.length > 0, false);
    const claimable = ms.filter((x) => x.progress >= x.target && !x.claimed);
    if (claimable.length) { const b = Button('受け取る', 340, 56, 140, 54, async () => { for (const x of claimable) await L.claimMission(x.id); toast('ミッション報酬を受け取りました'); Home(); }, CYAN, m); b.classList.add('small'); }
  } else row(194, 'デイリーミッション', '', unlockText('missions') + '　「毎日3本。終わればコイン」', false, true);
  row(322, '初勝利ボーナス', fw.remaining > 0 ? `残り${fw.remaining}回` : '本日終了', fw.next ? `今日の次の1着で 無償コイン+${fw.next}（ランク戦）` : '明日また受け取れます', fw.remaining === 0, false);
  // feature keys (unlocked by races or days, from the server)
  const keys = [['season_pass', 'パス', () => SeasonPass()], ['breeding', '配合'], ['friends', 'フレンド'], ['teams', '支部'], ['time_attack', 'タイムアタック', () => TimeAttack()], ['events', 'イベント'], ['my_stable', 'マイ厩舎']];
  keys.forEach(([k, name, go], i) => {
    const f = unlock(k);
    const x = 30 + i * 166, b = Button(f.unlocked ? name : name + ' 🔒', x, 590, 156, 90, f.unlocked ? (go ?? (() => toast(`${name}：開放済み（画面はクラブ版で確認できます）`))) : () => toast(`${name}は${unlockText(k)}`), f.unlocked ? NAVY : col(.03, .07, .11, .85));
    b.classList.add('key'); b.dataset.key = k; if (!f.unlocked) { b.classList.add('locked'); Label(unlockText(k), x, 684, 156, 46, 13, WHITE, undefined, 'center').classList.add('shadow'); }
  });
  // ② race (bottom right, the largest)
  Panel('Race frame', 1210, 120, 360, 450, NAVY);
  Label('次のレース', 1234, 140, 320, 30, 18, CYAN);
  Label(player.rating.rankedRaces < L.master.beginnerRaces ? `初心者マッチ\nあと${L.master.beginnerRaces - player.rating.rankedRaces}戦` : 'ランク戦', 1234, 178, 320, 100, 30);
  Label('12頭　·　1レース約90秒', 1234, 290, 320, 30, 17, MUTED);
  const go = Button('レースへ', 1180, 600, 390, 180, RaceLobby); go.classList.add('hero');
  if (bonus) toast(`ログインボーナス ${bonus.track === 'beginner' ? '初心者' : ''}${bonus.day}日目：${rewardText(bonus.reward)}`);
  TabBar(0);
  MaybeLinkPrompt('Home', Home);
}
function RaceLobby() {
  currentScreen = RaceLobby; Clear('lobby'); SetArt(equippedCourse() === 0 ? 'Art/first-ride' : courseArt(equippedCourse()));
  const p = partner();
  Panel('Lobby', 940, 60, 620, 740, NAVY);
  Label(player.rating.rankedRaces < L.master.beginnerRaces ? '初心者マッチ' : 'ランク戦', 980, 96, 540, 40, 22, CYAN);
  Label('今日のコースは\n出走時に決まります', 980, 146, 540, 120, 40);
  Label('コース・馬場・天気はサーバーと同じ規則（その日の馬場）で決まります。', 980, 290, 540, 60, 18, MUTED);
  Label(`出走馬　${p?.name ?? '—'}（${STYLE_JA[p?.style] ?? ''}・${fmt(p?.distMinM ?? 0)}〜${fmt(p?.distMaxM ?? 0)}m）`, 980, 380, 540, 40, 22, GOLD);
  Label('参加費なし　·　報酬：着順のコイン・シーズンpt・パスXP', 980, 430, 540, 60, 20);
  Label('端末内のエンジンで走るオフライン版です（ランクの変動なし）。', 980, 500, 540, 40, 16, DIM);
  Button('ランク戦に出る', 980, 600, 540, 110, () => StartRace());
  Ghost('戻る', 980, 726, 200, 72, Home);
}

// ================================================================= scout (06 §6.5, §7 item 7; REQ-GACHA-011..015)
// Banner calendar (GET /v1/gacha/banners via MuchiLogic.bannerList: active + announced, sorted, real end times), the
// pity meter and carry-over rule (MuchiLogic.gachaStatus = GET /v1/gacha/status), rows/countdowns from the Unity game
// layer's BannerListModel in WASM. Countdowns exist only for banners with a real end (06 §5.5: no fake urgency).
let scoutSel = null;
async function Scout(selectId) {
  currentScreen = () => Scout(selectId ?? scoutSel); await refresh();
  const list = L.bannerList();
  const status = await L.gachaStatus();
  const deviceNow = Date.now();
  const view = JSON.parse(engine.GachaBanners(JSON.stringify(list), JSON.stringify(status), deviceNow));
  if (selectId) scoutSel = selectId;
  if (!list.banners.some((b) => b.id === scoutSel)) scoutSel = list.banners[0]?.id ?? 'standard';
  const b = list.banners.find((x) => x.id === scoutSel);
  const row = view.rows.find((r) => r.id === scoutSel);
  const bs = status.banners.find((x) => x.bannerId === scoutSel);
  const group = status.groups.find((g) => g.group === b.pityGroup);
  Clear('scout'); SetArt('Art/scout-reveal'); Veil(.3);
  Header('スカウト', '提供割合は抽選と同じ表から表示します　·　残り時間は実際の終了日時まで');
  WalletChip();

  // ① banner list (left)
  const cdLabels = [];
  view.rows.forEach((r, i) => {
    const bn = list.banners[i];
    const y = 114 + i * 136;
    const card = Panel('Banner ' + r.id, 24, y, 540, 128, r.id === scoutSel ? col(.05, .2, .3, .97) : NAVY);
    card.classList.add('banner-row'); card.dataset.banner = r.id; card.dataset.status = bn.status;
    if (r.id === scoutSel) card.classList.add('sel');
    card.setAttribute('role', 'button');
    card.addEventListener('click', () => Scout(r.id));
    const chips = [bn.upcoming || bn.status === 'upcoming' ? '予告' : null, bn.currency === 'paidOnly' ? '有償限定' : null, bn.limited ? '季節限定' : null, bn.stepUp ? 'ステップアップ' : null, bn.pickup ? 'ピックアップ' : null].filter(Boolean);
    Label(r.title, 18, 10, 500, 34, 22, r.id === scoutSel ? GOLD : WHITE, card);
    Label(chips.join('　'), 18, 44, 500, 24, 14, CYAN, card);
    Label(r.periodLine, 18, 70, 250, 26, 16, MUTED, card);
    const cd = Label(r.countdown ?? '', 260, 70, 262, 26, 16, YELLOW, card); cd.dataset.countdown = r.id; cd.style.textAlign = 'right';
    cdLabels.push(cd);
    if (!r.upcoming && r.pityLine) {
      const bar = Panel('Pity bar ' + r.id, 18, 104, 504, 8, col(.15, .25, .32), card);
      Panel('Pity fill ' + r.id, 0, 0, Math.round(504 * r.pityFill), 8, GOLD, bar).dataset.pityFill = String(r.pityFill);
    }
  });
  // countdowns tick on the corrected clock; when a banner ends (or an announced one opens) the list reloads
  every(1000, () => {
    const c = JSON.parse(engine.GachaCountdowns(Date.now()));
    c.texts.forEach((t, i) => { if (cdLabels[i]) cdLabels[i].textContent = t ?? ''; });
    if (c.needsRefresh && cur?.dataset.screen === 'scout') { toast('開催期間が切り替わりました。一覧を更新します'); Scout(); }
  });

  // ② selected banner (right): the horse, price and balance, pity meter, odds link, real period
  const info = Panel('Scout buy', 590, 114, 986, 676, NAVY);
  info.dataset.banner = b.id;
  Label(b.name, 30, 18, 920, 44, 30, CYAN, info);
  const pk = b.pickup ? L.master.templates.find((t) => t.id === b.pickup.templateId) : null;
  const featured = pk ? [pk] : (b.pityTargets ?? []).map((id) => L.master.templates.find((t) => t.id === id)).filter(Boolean).slice(0, 1);
  featured.forEach((t) => {
    Label(`${RARITY_SHAPE[t.rarity]} ${t.rarity}　${t.name}`, 30, 70, 600, 40, 26, t.rarity === 'SSR' ? GOLD : WHITE, info);
    const sk = L.horseSkill({ templateId: t.id });
    Label(`${STYLE_JA[t.style]}　·　${t.surface === 'dirt' ? 'ダート' : '芝'} ${fmt(t.distMinM)}〜${fmt(t.distMaxM)}m${sk ? `　·　固有スキル「${sk.name}」${sk.condition}／${sk.effect}` : ''}`, 30, 112, 920, 30, 16, MUTED, info);
  });
  Label(row.priceLine + '\n有償コインから先に使われます。', 30, 152, 920, 56, 18, WHITE, info);
  if (row.stepLine) Label(row.stepLine, 30, 212, 920, 28, 18, GOLD, info).dataset.stepLine = '1';
  // ③ pity meter (交換pt 37/100), what it can be exchanged for, and the carry-over rule of a closing group
  if (bs && group) {
    const meter = Panel('Pity meter', 30, 252, 926, 150, col(.03, .09, .15, .96), info);
    meter.dataset.pity = `${bs.points}/${bs.cost}`;
    Label(`天井（${group.label}）`, 18, 10, 400, 26, 16, CYAN, meter);
    Label(row.pityLine, 18, 36, 880, 30, 20, WHITE, meter).dataset.pityLine = '1';
    const bar = Panel('Pity bar', 18, 72, 890, 14, col(.15, .25, .32), meter);
    Panel('Pity fill', 0, 0, Math.round(890 * Math.min(1, bs.points / bs.cost)), 14, GOLD, bar);
    Label(`交換先：${group.targets.map((x) => x.name + (x.owned ? '（所持）' : '')).join('・')}（えらんで交換・抽選なし）`, 18, 94, 890, 24, 15, MUTED, meter);
    if (row.carryOverNotice) Label(row.carryOverNotice, 18, 118, 890, 30, 13, YELLOW, meter).dataset.carryOver = '1';
    if (group.exchangeable > 0 && b.status === 'active') {
      const ex = Ghost('交換する', 750, 6, 160, 50, () => PityExchange(b, group), meter); ex.classList.add('small');
    }
  }
  Ghost('提供割合', 30, 420, 240, 66, () => Odds(b.id), info);
  Label(`期間：${row.periodLine}`, 300, 438, 400, 30, 18, MUTED, info);
  if (b.status === 'upcoming') {
    Label('開始前です。提供割合は開始前から確認できます。', 30, 520, 920, 40, 20, YELLOW, info);
    disable(Button(`10回引く（開始前）`, 470, 560, 486, 100, () => {}, CYAN, info));
  } else {
    const ten = b.stepUp ? (bs?.stepUp?.priceTen ?? b.stepUp.prices[0]) : b.priceTen;
    if (!b.stepUp && b.singleAllowed !== false) Ghost(`1回（${fmt(b.priceSingle)}）`, 30, 560, 230, 100, () => PaidScout(b, 1), info);
    Button(`10回引く（${fmt(ten)}）`, 470, 560, 486, 100, () => PaidScout(b, 10), CYAN, info);
  }
  TabBar(2);
}
async function PaidScout(b, count) {
  const r = await L.draw(b.id, count);
  if (!r.ok) {
    if (r.code === 'INSUFFICIENT_COINS') {
      // T6: the shortfall and the one smallest pack that covers it (paid-only banners count paid coins only)
      const st = (await L.gachaStatus()).banners.find((x) => x.bannerId === b.id);
      const price = count === 10 ? (st?.stepUp?.priceTen ?? b.stepUp?.prices[0] ?? b.priceTen) : b.priceSingle;
      const need = price - (b.currency === 'paidOnly' ? player.wallet.paid : player.wallet.paid + player.wallet.free);
      const pack = L.shopProducts().products.filter((p) => p.kind === 'coins' && p.paidCoins >= need).sort((a, c) => a.priceYen - c.priceYen)[0];
      return Info('コインが足りません', `${b.currency === 'paidOnly' ? '有償コインが' : ''}あと${fmt(need)}コイン必要です。${pack ? `\n${pack.name}（${yen(pack.priceYen)}）で足ります。` : ''}`, () => (pack ? PurchaseConfirm(pack.id, () => Scout(b.id)) : Scout(b.id)));
    }
    // REQ-GACHA-011: the server decides by its clock; a pull after the end is refused with the end time and the list reloads
    if (r.code === 'BANNER_CLOSED') return Info('このスカウトは終了しました', `${r.message}\n一覧を更新します。`, () => Scout());
    return Info('スカウトできませんでした', r.message, () => Scout(b.id));
  }
  await refresh();
  lastPulls = r.value.results;
  const pity = (await L.gachaStatus()).banners.find((x) => x.bannerId === b.id) ?? null;
  Reveal(r.value, false, b.id, pity);
}
async function PityExchange(b, group) {
  const target = group.targets.find((t) => !t.owned) ?? group.targets[0];
  const r = await L.pityExchange(b.id, target.templateId);
  if (!r.ok) return Info('交換できませんでした', r.message, () => Scout(b.id));
  await refresh();
  toast(`交換pt ${group.cost} で ${target.name} と交換しました`);
  Scout(b.id);
}
function Info(title, body, next) {
  currentScreen = () => Info(title, body, next); Clear('info'); SetArt('Art/home-paddock'); Veil(.5); Panel('Information', 300, 170, 1000, 560, NAVY);
  Label(title, 350, 210, 900, 70, 42, CYAN); Label(body, 350, 310, 900, 240, 28); Button('OK', 700, 600, 400, 100, next);
}

// ================================================================= shop (REQ-UXP-003, 06 §6.8, doc 03 legal guards)
const SHOP_TABS = [['recommended', 'おすすめ'], ['coins', 'コイン'], ['looks', '見た目'], ['pass', 'パス']];
async function Store(tab = 'recommended') {
  currentScreen = () => Store(tab);
  if (tab === 'pass') return SeasonPass();
  await refresh();
  const shop = L.shopProducts();
  const offers = await L.shopOffers();
  const blocked = !offers.ok && offers.code === 'DELETION_PENDING';
  Clear('shop-' + tab); SetArt('Art/home-paddock'); Veil(.45);
  Header('ショップ', '中身は数量で表示しています　·　有償と無償は分けて表示');
  // ① balance, paid and free apart
  WalletChip();
  SHOP_TABS.forEach(([id, name], i) => { const b = Button(name, 40 + i * 230, 112, 220, 84, () => Store(id), id === tab ? CYAN : NAVY); b.classList.add('stab'); });
  if (blocked) {
    // REQ-UXS-040: nothing is sold while the account is scheduled for deletion
    const bl = Panel('Blocked', 40, 214, 1520, 120, col(.25, .06, .07, .95));
    Label('アカウント削除の手続き中のため、購入できません', 30, 16, 1200, 44, 30, col(1, .75, .7), bl);
    Label('削除を取り消すと購入できます（「その他」→「アカウント削除の取り消し」）。期間が過ぎるとデータは削除されます。', 30, 66, 1300, 40, 19, WHITE, bl);
    Button('取り消しへ', 1300, 26, 200, 72, Settings, NAVY, bl);
  } else if (offers.ok && offers.value.firstPurchase.available && tab !== 'looks') {
    // ② T1: first-purchase bonus, worded as free coins (never 「倍」)
    const fp = Panel('First purchase', 1000, 112, 560, 84, col(.04, .14, .2, .95));
    Label('はじめての購入', 18, 8, 300, 28, 16, CYAN, fp);
    Label(shop.notices[offers.value.firstPurchase.noticeKey], 18, 34, 530, 48, 14, WHITE, fp);
  }
  const top = blocked ? 350 : 214;
  if (tab === 'recommended') DrawRecommended(shop, offers.ok ? offers.value : null, top, blocked);
  else if (tab === 'coins') DrawCoins(shop, offers.ok ? offers.value : null, top, blocked);
  else await DrawLooks(top, blocked);
  // ④ legal links at the bottom (2 taps from anywhere in the shop)
  shop.legalLinks.forEach((l, i) => { const b = Ghost(l.title, 40 + i * 360, 712, 340, 70, () => Legal(l.key === 'legal.tokushoho' ? 'tokushoho' : l.key === 'legal.shikin_kessai' ? 'shikin' : 'paidFirst', () => Store(tab))); b.classList.add('link'); });
  Label('このプロトタイプでは決済しません（購入確認まで）', 1130, 730, 440, 30, 15, DIM);
  TabBar(3);
}
function productCard(p, x, y, w, h, opts = {}) {
  const c = Panel('Product ' + p.id, x, y, w, h, CARD);
  c.dataset.product = p.id;
  Label(p.name, 20, 14, w - 200, 40, 26, WHITE, c);
  Label(yen(p.priceYen), w - 190, 14, 170, 40, 28, GOLD, c).style.textAlign = 'right';
  Label(p.contents.map((x) => '・' + x.label).join('\n'), 20, 60, w - 40, h - 150, 17, WHITE, c);
  const tags = [];
  if (p.oneTime) tags.push(p.oneTimeScope === 'class' ? '各クラス1回限り' : '1回限り');
  if (p.period?.kind === 'season') tags.push('今シーズン限り・自動更新なし');
  if (p.period?.kind === 'days') tags.push(`${p.period.days}日間・自動更新なし`);
  if (opts.bonus) tags.push(opts.bonus);
  Label(tags.join('　·　'), 20, h - 84, w - 240, 60, 14, CYAN, c);
  if (opts.note) Label(opts.note, 20, h - 46, w - 240, 40, 14, opts.noteColor ?? YELLOW, c);
  const b = Button(opts.cta ?? '購入を確認', w - 220, h - 92, 200, 76, opts.action ?? (() => PurchaseConfirm(p.id, currentScreen)), opts.ctaColor ?? CYAN, c);
  if (opts.disabled) disable(b);
  return c;
}
function DrawRecommended(shop, offers, top, blocked) {
  const byId = new Map(shop.products.map((p) => [p.id, p]));
  const list = offers?.offers ?? [];
  const starter = byId.get('starter_pack');
  const starterOffer = list.find((o) => o.productId === 'starter_pack');
  // T2 starter: in the recommended tab after its trigger, until bought (no fake timer: it has no end date)
  if (starter) productCard(starter, 40, top, 740, 250, { note: starterOffer ? 'おすすめ：期限はありません（購入するまでここに置いておきます）' : 'ランク戦で初めて4着以下になるか、5戦目の後に案内します', disabled: blocked });
  // T3 pass (real season end, live countdown)
  const passOffer = list.find((o) => o.productId === 'season_pass');
  const pass = byId.get('season_pass');
  const pc = productCard(pass, 800, top, 760, 250, { cta: 'パスを見る', action: () => SeasonPass(), ctaColor: GOLD, disabled: blocked });
  if (passOffer?.endsAt) { const cd = Label('', 20, 204, 540, 30, 15, YELLOW, pc); every(1000, () => { cd.textContent = `今シーズンの終わり（${seasonEnd(passOffer.endsAt)}）まで あと ${countdown(passOffer.endsAt - L.now())}`; }); cd.classList.add('countdown'); }
  else if (!unlock('season_pass').unlocked) Label('シーズンパスは' + unlockText('season_pass'), 20, 204, 540, 30, 15, YELLOW, pc);
  // daily pack (厩舎手当) and the promotion packs (T4: only once the class is reached)
  const allowance = byId.get('stable_allowance_30d');
  const av = offers?.allowance;
  if (allowance) productCard(allowance, 40, top + 266, 740, 220, { note: av?.active ? `受け取り中：残り${av.daysLeft}日` : shop.notices['shop.allowance_no_stack'], disabled: blocked || !!av?.active || !!av?.queued });
  const promos = shop.products.filter((p) => p.kind === 'promotion');
  const promoOffer = list.filter((o) => o.touchpoint === 'T4');
  promos.slice(0, 3).forEach((p, i) => {
    const ok = promoOffer.some((o) => o.productId === p.id);
    const c = Panel('Promo ' + p.id, 800 + i * 256, top + 266, 248, 220, ok ? CARD : col(.03, .07, .11, .9));
    c.dataset.product = p.id;
    Label(p.name, 14, 12, 220, 60, 18, ok ? WHITE : DIM, c);
    Label(yen(p.priceYen), 14, 74, 220, 36, 24, ok ? GOLD : DIM, c);
    Label(p.contents.map((x) => x.label).join('\n'), 14, 112, 220, 60, 13, ok ? WHITE : DIM, c);
    if (ok) Button('確認', 14, 160, 220, 52, () => PurchaseConfirm(p.id, currentScreen), CYAN, c);
    else Label(`🔒 ${p.classId}級に昇級すると購入できます`, 14, 172, 230, 40, 14, DIM, c);
  });
}
function DrawCoins(shop, offers, top, blocked) {
  const firstLeft = new Set(offers?.firstPurchase.productIds ?? []);
  const coins = shop.products.filter((p) => p.kind === 'coins').sort((a, b) => a.priceYen - b.priceYen);
  coins.forEach((p, i) => {
    const x = 40 + (i % 4) * 382, y = top + Math.floor(i / 4) * 246;
    const c = Panel('Coin ' + p.id, x, y, 366, 232, CARD); c.dataset.product = p.id;
    Label(p.contents[0].label, 18, 14, 330, 40, 24, WHITE, c);
    Label(yen(p.priceYen), 18, 56, 330, 48, 36, GOLD, c);
    Label(firstLeft.has(p.id) && p.firstPurchaseBonus ? p.firstPurchaseBonus.label : 'はじめての購入ボーナスは受け取り済み', 18, 108, 330, 50, 14, firstLeft.has(p.id) ? CYAN : DIM, c);
    const b = Button('購入を確認', 18, 160, 330, 60, () => PurchaseConfirm(p.id, currentScreen), CYAN, c);
    if (blocked) disable(b);
  });
}
async function DrawLooks(top, blocked) {
  const cat = await L.cosmetics();
  const items = cat.items.filter((x) => x.forSale).slice(0, 8);
  const artOf = (it) => (it.kind === 'silks' ? 'Art/Cosmetics/silk-jacket' : it.kind === 'decor' ? 'Art/Cosmetics/stable-plaque' : it.id.includes('saddle') ? 'Art/Cosmetics/saddlecloth' : 'Art/Cosmetics/bridle');
  items.forEach((it, i) => {
    const x = 40 + (i % 4) * 382, y = top + Math.floor(i / 4) * 246;
    const c = Panel('Look ' + it.id, x, y, 366, 232, CARD);
    ArtImage(artOf(it), 8, 10, 120, 210, c);
    Label(it.name, 138, 14, 220, 64, 20, WHITE, c);
    Label(`${fmt(it.price)}コイン${it.currency === 'paidOnly' ? '（有償限定）' : ''}`, 138, 84, 220, 34, 20, GOLD, c);
    Label({ silks: '勝負服の柄', tack: '馬具', decor: '厩舎の飾り' }[it.kind] + '・能力は変わりません', 138, 120, 220, 40, 13, MUTED, c);
    const b = Button(it.owned ? '所持' : '試着して買う', 138, 164, 212, 56, () => toast('試着してから買えます（確率なしの直販）'), it.owned ? NAVY : CYAN, c);
    if (it.owned || blocked) disable(b);
  });
  Label(cat.notice, 40, top + 490, 1500, 30, 15, MUTED);
}

// ---- purchase confirmation: unregistered / registered / under 18 / over the limit (REQ-PUR-001/002, 06 §6.8)
let ageForm = null; // { year, month, guardian }
async function PurchaseConfirm(productId, back) {
  if (back) purchaseReturn = back;
  currentScreen = () => PurchaseConfirm(productId);
  const shop = L.shopProducts();
  const p = shop.products.find((x) => x.id === productId);
  const r = await L.purchaseIntent(productId);
  Clear('purchase'); SetArt('Art/home-paddock'); Veil(.65);
  const box = Panel('Purchase', 200, 50, 1200, 800, NAVY);
  Label('購入の確認', 40, 26, 600, 44, 30, CYAN, box);
  Label(p.name, 40, 80, 760, 56, 40, WHITE, box);
  Label(yen(p.priceYen) + '（税込）', 820, 84, 340, 50, 36, GOLD, box).style.textAlign = 'right';
  Label(p.contents.map((x) => '・' + x.label).join('\n'), 40, 146, 1120, 110, 20, WHITE, box);
  const notices = p.noticeKeys.filter((k) => !k.startsWith('legal.')).map((k) => shop.notices[k]).filter(Boolean);
  Label(notices.join('\n'), 40, 262, 1120, 120, 15, MUTED, box);
  const state = el('pstate', 40, 392, 1120, 270, box);
  const S = (t, y, h, size, c) => Label(t, 0, y, 1120, h, size, c, state);
  const close = () => { ageForm = null; (purchaseReturn ?? Home)(); };
  if (r.ok) {
    // registered: what is bought, the free coins on top (first time only), this month's remaining limit
    const v = r.value;
    state.dataset.state = 'registered';
    S('年齢確認済み', 0, 36, 22, col(.5, .9, .6));
    S(v.firstPurchaseBonus ? v.firstPurchaseBonus.label : 'はじめての購入ボーナスの対象ではありません', 44, 34, 20, v.firstPurchaseBonus ? CYAN : DIM);
    S(v.monthlyLimitYen == null ? '今月の購入上限：なし（20歳以上）' : `今月の購入上限 ${yen(v.monthlyLimitYen)}　·　あと ${yen(v.remainingYen)}　（翌月1日に戻ります）`, 88, 34, 20, WHITE);
    if (v.pass) S(`有効期間：${seasonEnd(v.pass.endsAt)}まで（今シーズン限り・自動更新なし）${v.pass.remainingDays != null ? '　残り' + v.pass.remainingDays + '日' : ''}`, 132, 34, 18, YELLOW);
    if (v.allowance) S(`${v.allowance.days}日間、毎日 無償コイン${v.allowance.dailyFreeCoins}枚（自動更新なし）`, 132, 34, 18, YELLOW);
    const buy = disable(Button('購入する（プロトタイプでは決済しません）', 560, 690, 600, 92, () => {}, GOLD, box));
    Ghost('年齢を訂正する', 0, 190, 280, 72, () => { buy.remove(); ageForm = { year: '', month: '', guardian: false, correcting: true }; AgeForm(productId, box, state); }, state).classList.add('link');
  } else if (r.code === 'AGE_REQUIRED' || r.code === 'GUARDIAN_CONSENT_REQUIRED') {
    state.dataset.state = r.code === 'AGE_REQUIRED' ? 'unregistered' : 'guardian';
    if (r.code === 'GUARDIAN_CONSENT_REQUIRED') ageForm = { ...(ageForm ?? { year: '', month: '' }), guardian: false, needGuardian: true };
    AgeForm(productId, box, state);
  } else if (r.code === 'AGE_LIMIT_EXCEEDED') {
    state.dataset.state = 'limit';
    const cheap = await L.purchaseIntent('coin_160');
    const rem = cheap.ok ? cheap.value.remainingYen : 0;
    S('今月の購入上限を超えます', 0, 50, 34, RED);
    S(`今月はあと ${yen(rem ?? 0)} まで購入できます。上限は翌月1日に戻ります。`, 62, 40, 24, WHITE);
    S('年齢ごとの月の上限は、未成年の保護のために設けています。', 112, 34, 18, MUTED);
    Ghost('年齢を訂正する', 0, 190, 280, 72, () => { ageForm = { year: '', month: '', guardian: false, correcting: true }; AgeForm(productId, box, state); }, state).classList.add('link');
  } else if (r.code === 'DELETION_PENDING') {
    state.dataset.state = 'deletion';
    S('アカウント削除の手続き中のため、購入できません', 0, 50, 30, RED);
    S('「その他」から削除を取り消すと購入できます。', 62, 40, 22, WHITE);
  } else {
    state.dataset.state = 'error';
    S(r.code === 'ALREADY_PURCHASED' ? '購入済みです（1回限りの商品・今シーズンのパス）' : r.code === 'NOT_ELIGIBLE' ? 'まだ購入できません（昇級すると購入できます）' : r.message, 0, 50, 26, YELLOW);
  }
  Ghost('閉じる', 40, 690, 260, 92, close, box);
}
/** Birth year and month, asked only while unregistered (or to correct it); guardian consent only under 18. */
function AgeForm(productId, box, state) {
  state.innerHTML = '';
  const f = ageForm ??= { year: '', month: '', guardian: false };
  const now = new Date(L.now());
  Label(f.correcting ? '生年月を訂正（若い方への訂正のみ）' : '年齢の確認（初回の購入時に1回だけ）', 0, 0, 1120, 36, 22, CYAN, state);
  Label('生まれた年と月を選んでください', 0, 40, 600, 30, 18, MUTED, state);
  const sel = (opts, val, x, w, onChange, label) => {
    const s = document.createElement('select'); s.className = 'el select'; s.setAttribute('aria-label', label);
    Object.assign(s.style, { left: x + 'px', top: '80px', width: w + 'px', height: '72px' });
    s.innerHTML = `<option value="">${label}</option>` + opts.map((o) => `<option value="${o}"${String(o) === String(val) ? ' selected' : ''}>${o}</option>`).join('');
    s.addEventListener('change', () => { onChange(s.value); AgeForm(productId, box, state); });
    state.appendChild(s); return s;
  };
  const years = Array.from({ length: 90 }, (_, i) => now.getFullYear() - i);
  sel(years, f.year, 0, 240, (v) => { f.year = v; }, '年');
  sel(Array.from({ length: 12 }, (_, i) => i + 1), f.month, 260, 160, (v) => { f.month = v; }, '月');
  const age = f.year && f.month ? now.getFullYear() - Number(f.year) - ((now.getMonth() + 1) < Number(f.month) ? 1 : 0) : null;
  if (age != null) Label(`${age}歳`, 440, 96, 200, 40, 26, WHITE, state);
  const under18 = age != null && age < L.master.ageLimits.guardianConsentUnderAge;
  if (under18 || f.needGuardian) {
    const g = Ghost(f.guardian ? '☑ 保護者の同意を得ました' : '☐ 保護者の同意を得ました', 0, 170, 520, 72, () => { f.guardian = !f.guardian; AgeForm(productId, box, state); }, state);
    g.classList.add('check'); if (f.guardian) g.classList.add('on');
    Label('18歳未満の方は、保護者の同意が必要です。', 0, 248, 560, 30, 17, MUTED, state);
  }
  const ok = age != null && (!under18 || f.guardian);
  const b = Button('登録して確認する', 620, 170, 500, 80, async () => {
    const r = await L.setAge(Number(f.year), Number(f.month), !!f.guardian);
    if (!r.ok) { toast(r.code === 'CONFLICT' ? '年齢は若い方へだけ訂正できます。サポートへ連絡してください。' : r.message); return; }
    ageForm = null; PurchaseConfirm(productId);
  }, CYAN, state);
  if (!ok) disable(b);
}
async function OfferThen(next) {
  // T2 / T4: once, after the result screen is closed (never during the tutorial or right on a loss screen)
  const o = await L.shopOffers();
  const pop = o.ok ? o.value.offers.find((x) => x.showPopup && (x.touchpoint === 'T2' || x.touchpoint === 'T4')) : null;
  if (!pop) return next();
  await L.markOfferViewed(pop.id);
  const p = L.shopProducts().products.find((x) => x.id === pop.productId);
  currentScreen = () => next(); Clear('offer'); SetArt('Art/home-paddock'); Veil(.65);
  const box = Panel('Offer', 300, 90, 1000, 700, NAVY);
  Label(pop.touchpoint === 'T2' ? 'スターターパックのご案内' : '昇級おめでとう', 40, 30, 900, 44, 30, CYAN, box);
  Label(p.name + '　' + yen(p.priceYen), 40, 90, 900, 56, 40, WHITE, box);
  Label(p.contents.map((x) => '・' + x.label).join('\n'), 40, 170, 900, 140, 22, WHITE, box);
  Label('1回限り　·　期限はありません（ショップの「おすすめ」にも置いておきます）', 40, 330, 900, 40, 18, MUTED, box);
  // the close button is the most prominent (06 §5.1 T2)
  Button('閉じる', 40, 560, 560, 108, next, CYAN, box);
  Ghost('中身を確認', 620, 560, 340, 108, () => PurchaseConfirm(p.id, next), box);
}

// ================================================================= season pass (REQ-UXP-004, 06 §6.9)
async function SeasonPass() {
  currentScreen = SeasonPass;
  const pass = await L.passView();
  await refresh();
  const shop = L.shopProducts();
  const products = shop.products.filter((p) => p.kind === 'season_pass');
  const rw = L.master.passRewards;
  Clear('pass'); SetArt('Art/home-paddock'); Veil(.5);
  Header('シーズンパス', `シーズン ${pass.seasonId}　·　${seasonEnd(pass.seasonEndsAt)}まで（あと${pass.remainingDays}日）　·　自動更新なし`);
  WalletChip();
  // ① level and XP (next = N races)
  const lv = Panel('Level', 40, 116, 420, 180, NAVY);
  Label('レベル', 24, 14, 200, 30, 18, CYAN, lv);
  Label(`${pass.level}`, 24, 44, 160, 90, 76, GOLD, lv);
  Label(`/ ${pass.maxLevel}`, 150, 84, 120, 40, 28, WHITE, lv);
  Label(pass.xpToNextLevel > 0 ? `次まで ${pass.xpToNextLevel}XP ＝ あと${pass.racesToNextLevel}戦` : '最大レベル', 24, 136, 380, 30, 18, MUTED, lv);
  const bar = Panel('XP track', 240, 60, 160, 16, col(.2, .28, .34), lv); Panel('XP fill', 0, 0, 160 * ((pass.xp % pass.xpPerLevel) / pass.xpPerLevel), 16, CYAN, bar);
  // ③ purchase-time items + the two products (Pass / Pass+), all contents visible before buying
  products.forEach((p, i) => {
    const owned = pass.owned.includes(p.id);
    const c = Panel('Pass product ' + p.id, 480 + i * 540, 116, 520, 180, i === 0 ? col(.1, .08, .02, .92) : col(.08, .04, .12, .92));
    Label(p.name, 20, 12, 320, 40, 26, i === 0 ? GOLD : col(.8, .6, 1), c);
    Label(yen(p.priceYen), 340, 12, 160, 40, 28, GOLD, c).style.textAlign = 'right';
    Label(p.contents.map((x) => '・' + x.label).join('\n'), 20, 56, 480, 80, 14, WHITE, c);
    const b = Button(owned ? '購入済み' : i === 0 ? '有料ラインを開ける' : 'パス＋にする', 300, 128, 200, 44, () => PurchaseConfirm(p.id, SeasonPass), i === 0 ? GOLD : col(.55, .35, .85), c);
    b.classList.add('small'); if (owned || pass.purchasable.length === 0) disable(b);
  });
  // ② every tier of the free / paid / plus lines (horizontal scroll), claimable tiers highlighted
  const strip = el('pass-strip', 40, 312, 1520, 400);
  const rail = document.createElement('div'); rail.className = 'rail'; strip.appendChild(rail);
  const premium = pass.active;
  const tracks = [
    ['free', '無料', rw.free], ['premium', '有料', rw.premium],
  ];
  const head = document.createElement('div'); head.className = 'tier head';
  head.innerHTML = '<div class="lv">Lv</div><div class="cell free"><b>無料ライン</b></div><div class="cell premium"><b>有料ライン</b><small>パス・パス＋</small></div><div class="cell plus"><b>パス＋</b><small>購入時 Lv＋' + (products.find((p) => p.pass?.levels)?.pass.levels ?? 10) + '</small></div>';
  rail.appendChild(head);
  for (let l = 1; l <= pass.maxLevel; l++) {
    const t = document.createElement('div'); t.className = 'tier' + (l <= pass.level ? ' reached' : '') + (l === pass.level + 1 ? ' next' : ''); t.dataset.level = l;
    const lvd = document.createElement('div'); lvd.className = 'lv'; lvd.textContent = l; t.appendChild(lvd);
    for (const [track, , def] of tracks) {
      const cell = document.createElement('div'); cell.className = 'cell ' + track;
      const has = l % def.every === 0;
      const claimed = pass.claimed[track].includes(l);
      const can = has && l <= pass.level && !claimed && (track === 'free' || premium);
      cell.innerHTML = has ? `<span>${rewardText(def.reward)}</span>` : '<span>—</span>';
      if (claimed) cell.classList.add('claimed');
      if (can) {
        cell.classList.add('claimable');
        const b = document.createElement('button'); b.textContent = '受け取る'; b.dataset.label = `受け取る ${track} ${l}`;
        b.addEventListener('click', async (e) => { e.stopPropagation(); const r = await L.claimPass(track, l); toast(r.ok ? `Lv${l}：${rewardText(def.reward)}を受け取りました` : r.message); SeasonPass(); });
        cell.appendChild(b);
      } else if (track === 'premium' && !premium && has) cell.classList.add('locked');
      t.appendChild(cell);
    }
    const plus = document.createElement('div'); plus.className = 'cell plus';
    plus.innerHTML = l <= (products.find((p) => p.pass?.levels)?.pass.levels ?? 0) ? '<span>購入時に到達</span>' : '<span></span>';
    t.appendChild(plus);
    rail.appendChild(t);
  }
  requestAnimationFrame(() => { const n = rail.querySelector('.tier.next') ?? rail.querySelector('.tier.reached:last-of-type'); if (n) strip.scrollLeft = Math.max(0, n.offsetLeft - 300); });
  // primary: unpaid → open the paid line; paid → claim everything
  const free = Array.from({ length: pass.level }, (_, i) => i + 1).filter((l) => !pass.claimed.free.includes(l));
  if (free.length) Button(`まとめて受け取る（無料 ${free.length}段）`, 1040, 726, 520, 66, async () => { for (const l of free) await L.claimPass('free', l); toast(`無料ライン ${free.length}段分を受け取りました`); SeasonPass(); });
  Label(shop.notices['shop.pass_auto_grant'] + '　' + shop.notices['shop.no_auto_renew'], 40, 728, 980, 60, 14, MUTED);
  TabBar(3);
}

// ================================================================= round 9 (06 §7 item 12 / §7.3, REQ-UXS-070..074)
// ---- replay share: the race just run, re-simulated by ReplayClip in the WASM engine and posed by ReplayShareModel
async function ShareCard(back) {
  const info = JSON.parse(engine.ShareClip(raceCtx?.trackName ?? ''));
  if (!info.ok) { toast(info.message); return; }
  currentScreen = () => ShareCard(back);
  Clear('share'); cur.classList.add('race'); $canvas.hidden = false;
  const { card, clip } = info;
  // the clip loops on the 3D view (RaceCameraRig keyframes: follow → low on the straight → side-on at the line)
  const frame = Panel('Clip frame', 30, 30, 1000, 566, 'transparent'); frame.classList.add('clipframe');
  const wm = Label(card.watermark, 54, 46, 400, 60, 40, WHITE); wm.classList.add('shadow', 'watermark');
  const rem = Label('', 54, 520, 400, 50, 30, WHITE); rem.classList.add('shadow');
  const mode = Label('', 640, 520, 370, 50, 20, MUTED); mode.classList.add('shadow'); mode.style.textAlign = 'right';
  const t0 = performance.now(), loop = clip.durationMs + 1200;
  every(33, () => {
    const t = Math.min(clip.durationMs, (performance.now() - t0) % loop);
    const f = JSON.parse(engine.ClipFrame(t));
    view.draw(f);
    rem.textContent = f.remainingM > 0 ? `残り ${Math.ceil(f.remainingM)} m` : 'ゴール';
    mode.textContent = `カメラ：${{ Follow: '追走', FinalStraight: '直線', Finish: 'ゴール横' }[f.cam[7]] ?? f.cam[7]}`;
    globalThis.__muchi && (globalThis.__muchi.clipT = t);
  });
  // the card (REQ-UXS-071): place, time, horse, course, skills, watermark — no player name or id
  const c = Panel('Share card', 1060, 30, 510, 840, NAVY); c.dataset.card = 'share';
  Label(card.watermark, 28, 22, 454, 40, 26, CYAN, c);
  Label(card.mode || '', 28, 66, 454, 30, 18, MUTED, c);
  Label(card.placeText, 28, 100, 454, 90, card.place === 1 ? 64 : 52, card.place === 1 ? GOLD : WHITE, c).dataset.share = 'place';
  Label(card.time, 28, 196, 454, 60, 44, WHITE, c).dataset.share = 'time';
  Label(card.horse, 28, 266, 454, 56, 38, GOLD, c).dataset.share = 'horse';
  Label(card.course, 28, 326, 454, 36, 22, WHITE, c);
  Label(card.skills.length ? card.skills.join('\n') : '固有スキルの発動なし', 28, 374, 454, 80, 18, card.skills.length ? YELLOW : DIM, c);
  Label('共有の文：' + card.shareText, 28, 466, 454, 90, 15, MUTED, c);
  const same = clip.hash === clip.liveHash;
  Label(`最後の${Math.round(clip.startRemainingM)}m・${(clip.durationMs / 1000).toFixed(1)}秒・${clip.fps}fps（${clip.frames}フレーム）\n端末で再計算：${same ? '結果が一致 ✓' : '不一致'}　カメラ ${clip.modes.map((m) => ({ Follow: '追走', FinalStraight: '直線', Finish: 'ゴール横' }[m] ?? m)).join('→')}`, 28, 566, 454, 80, 15, same ? col(.5, .9, .6) : RED, c).dataset.hash = same ? 'match' : 'mismatch';
  Button('動画で共有', 28, 660, 454, 84, () => toast('書き出しと共有はアプリ（IClipRecorder）で行います'), GOLD, c);
  Ghost('戻る', 28, 756, 454, 66, back ?? Home, c);
  Label('動画には名前・IDを入れません（選んだ馬の名前だけ）', 30, 612, 1000, 30, 16, MUTED);
}

// ---- account-link prompt (REQ-UXS-073): AccountLinkPrompt on the PlayerPrefs keys muchi.link.*
const LINK_KEYS = ['muchi.link.prompt', 'muchi.link.firstPurchase'];
function linkOp(op, args = {}) {
  const store = {};
  for (const k of LINK_KEYS) { const v = prefs.get(k, null); if (v != null) store[k] = v; }
  const r = JSON.parse(engine.LinkPrompt(op, JSON.stringify(store), JSON.stringify(args)));
  for (const k of LINK_KEYS) if (r.store[k] != null) prefs.set(k, r.store[k]);
  return r;
}
const linkedProvider = () => prefs.get('muchi.link.provider', '');
function linkArgs(context) {
  return {
    context, anonymous: !linkedProvider(), day: player.unlocks.day, online: true, deletion: player.deletion?.status === 'scheduled',
    partner: !!player.flags?.partnerHorseId, gacha: !!player.flags?.tutorialGachaUsed, rankedRaces: player.rating.rankedRaces,
  };
}
/** Home / after a result / after a purchase: shows the prompt when the rules say so; returns true when it did. */
function MaybeLinkPrompt(context, next) {
  const r = linkOp('eval', linkArgs(context));
  if (!r.show) return false;
  LinkPrompt(r.trigger, next);
  return true;
}
function LinkPrompt(trigger, next = Home) {
  const v = linkOp('show', { trigger, ios: true }).view; // counts as shown now (once only)
  currentScreen = next; Clear('link-prompt'); SetArt('Art/home-paddock'); Veil(.7);
  const box = Panel('Link prompt', 300, 110, 1000, 680, NAVY); box.dataset.trigger = trigger;
  ArtImage(partnerSprite(equippedPartner()), 640, -40, 380, 380, box);
  Label(trigger === 'FirstPurchase' ? 'はじめての購入の後に' : '3日目のお知らせ', 40, 30, 600, 30, 18, CYAN, box);
  Label(v.title, 40, 70, 600, 120, 38, WHITE, box);
  Label(v.body, 40, 210, 900, 120, 22, MUTED, box);
  v.providers.forEach((p, i) => Button(p === 'apple' ? v.apple : v.google, 40 + i * 470, 380, 440, 100, () => Link(p, next), i === 0 ? GOLD : CYAN, box).classList.add('provider-' + p));
  Ghost(v.later, 40, 520, 300, 84, () => { linkOp('dismiss'); next(); }, box);
  Label(v.footnote + '（プロトタイプ：サインインの画面は省略します）', 360, 532, 600, 60, 15, DIM, box);
}
function Link(provider, next) {
  const r = linkOp('linked', { provider, at: L.now() });
  prefs.set('muchi.link.provider', provider);
  toast(`${provider === 'apple' ? 'Apple' : 'Google'}で引き継ぎ登録しました` + (r.event ? `（KPI ${r.event.name}）` : ''));
  globalThis.__muchi && (globalThis.__muchi.lastKpi = r.event?.name ?? null);
  (next ?? Home)();
}

// ---- time attack with ghosts (REQ-TA-*, friend ghosts first: REQ-UXS-074)
let taCache = null;
const taBestKey = (trackId) => 'muchi.proto.ta.' + trackId;
function taBest(trackId) { try { return JSON.parse(prefs.get(taBestKey(trackId), 'null')); } catch { return null; } }
async function TimeAttack(trackId = 'aoba_turf_1600', tab = '', selected = '') {
  await viewReady;
  const p = partner();
  const friends = prefs.get('muchi.proto.taFriends', '1') === '1';
  const key = trackId + ':' + friends + ':' + (taBest(trackId)?.timeMs ?? 0);
  if (taCache?.key !== key) {
    const { config, trackName, attemptsLeft } = await L.taConfig(p.id, trackId);
    const seeds = L.taGhostSeeds(trackId, friends);
    const best = taBest(trackId);
    const entries = seeds.map((s) => ({ id: s.id, name: s.name, horse: s.horse, kind: s.kind, config: s.config, whips: s.whips }));
    if (best) entries.push({ id: 'local', name: '自分のベスト', horse: p.name, kind: 'me', log: best.log });
    const times = JSON.parse(engine.TaGhosts(JSON.stringify(entries)));
    const list = entries.map((e) => ({ id: e.id, name: e.name, horse: e.horse, kind: e.kind, timeMs: times.find((t) => t.id === e.id).timeMs }));
    taCache = { key, config, trackName, attemptsLeft, list };
  }
  const best = taBest(trackId);
  const pk = JSON.parse(engine.PickGhosts(JSON.stringify(taCache.list), 'local', best?.timeMs ?? 0, tab, selected));
  currentScreen = () => TimeAttack(trackId, pk.tab, pk.selected);
  Clear('time-attack'); SetArt('Art/home-paddock'); Veil(.6);
  Header('タイムアタック', `${taCache.trackName}　·　ゴーストと並走（相手には影響しません）`);
  const me = Panel('My best', 40, 120, 520, 250, NAVY);
  Label('自己ベスト（今シーズン）', 24, 18, 460, 30, 18, CYAN, me);
  Label(best ? fmtMs(best.timeMs) : '— 記録なし', 24, 58, 460, 80, 60, best ? GOLD : DIM, me);
  Label(`相棒 ${p.name}　·　能力はTAの上限にそろえます`, 24, 150, 470, 30, 17, MUTED, me);
  Label(`今日の残り ${taCache.attemptsLeft}回（サーバーと同じ発行）`, 24, 190, 470, 30, 17, MUTED, me);
  const dm = Panel('Demo', 40, 390, 520, 200, col(.03, .06, .1, .92));
  Label('デモ（レビュー用）', 24, 16, 460, 30, 18, CYAN, dm);
  Ghost(friends ? 'フレンドのゴースト：あり' : 'フレンドのゴースト：なし', 24, 60, 470, 72, () => { prefs.set('muchi.proto.taFriends', friends ? '0' : '1'); TimeAttack(trackId); }, dm).classList.add('ta-friends-toggle');
  Label('相手の走りは全て端末のエンジンで計算した実際のタイムです。', 24, 144, 470, 50, 14, DIM, dm);
  // picker: tabs フレンド / 上位 / 自分 (opens on フレンド; falls back to 上位 when no friend has run this course)
  const pp = Panel('Ghost picker', 590, 120, 970, 660, NAVY); pp.dataset.tab = pk.tab; pp.dataset.fellback = String(pk.fellBack);
  pk.tabs.forEach((t, i) => {
    const b = Button(`${t.label}（${t.count}）`, 24 + i * 240, 18, 228, 72, () => TimeAttack(trackId, t.kind, ''), t.kind === pk.tab ? col(0, .8, .95, .25) : 'transparent', pp);
    b.classList.add('stab', 'ghosttab'); b.dataset.kind = t.kind; if (t.kind === pk.tab) b.classList.add('on');
  });
  if (pk.note) Label(pk.note, 24, 104, 920, 34, 19, YELLOW, pp).dataset.note = pk.fellBack ? 'fallback' : 'empty';
  pk.list.slice(0, 5).forEach((g, i) => {
    const y = 148 + i * 88;
    const row = Button('', 24, y, 920, 80, () => TimeAttack(trackId, pk.tab, g.id), g.selected ? col(1, .83, .08, .2) : CARD, pp);
    row.classList.add('ghostrow'); row.dataset.ghost = g.id; if (g.selected) row.classList.add('on');
    Label((g.selected ? '▶ ' : '') + g.name, 20, 10, 420, 34, 24, g.selected ? GOLD : WHITE, row).style.textAlign = 'left';
    Label(g.horse, 20, 44, 420, 28, 16, MUTED, row).style.textAlign = 'left';
    Label(g.line, 440, 18, 460, 44, 26, WHITE, row).style.textAlign = 'right';
  });
  if (!pk.list.length && pk.tab === 'friends') Label('フレンドを追加すると、ここにフレンドのベストが並びます。', 24, 160, 900, 40, 20, DIM, pp);
  const sel = taCache.list.find((x) => x.id === pk.selected);
  Button(sel ? `${sel.name}と走る` : 'ひとりで走る', 590, 790, 620, 92, () => StartTimeAttack(trackId, sel?.id ?? ''), GOLD).classList.add('ta-start');
  Ghost('ホーム', 1230, 790, 330, 92, Home);
}
const fmtMs = (ms) => { const t = Math.floor(ms / 100); return `${Math.floor(t / 600)}:${String(Math.floor(t / 10) % 60).padStart(2, '0')}.${t % 10}`; };
async function StartTimeAttack(trackId, ghostId) {
  await viewReady;
  raceInfo = JSON.parse(engine.StartTimeAttack(JSON.stringify(taCache.config), ghostId));
  raceCtx = { tutorial: false, ta: true, trackId, trackName: taCache.trackName, config: taCache.config, ghost: raceInfo.ghosts[0] ?? null };
  view.useRig = true; view.start(raceInfo, equippedPartner()); view.setGhosts(raceInfo.ghosts.length, equippedPartner());
  BuildRaceScreen();
  if (raceCtx.ghost) { hud.ghost = Label('', 380, 120, 840, 34, 22, col(.75, .9, 1), undefined, 'center'); hud.ghost.classList.add('shadow'); }
}
function TaResult(f) {
  const r = f.result, ta = f.ta, best = taBest(raceCtx.trackId);
  const newBest = ta.timeMs >= 0 && (!best || ta.timeMs < best.timeMs);
  if (newBest) { prefs.set(taBestKey(raceCtx.trackId), JSON.stringify({ timeMs: ta.timeMs, log: ta.log })); taCache = null; }
  const ghost = raceCtx.ghost, gt = ta.ghostTimes[0];
  currentScreen = () => TaResult(f);
  Clear('ta-result'); SetArt('Art/race-result'); Veil(.4);
  const box = Panel('TA result', 40, 40, 900, 820, NAVY);
  Label(`${raceCtx.trackName}　·　タイムアタック`, 36, 26, 820, 32, 18, CYAN, box);
  Label(r.time, 36, 70, 820, 140, 110, newBest ? GOLD : WHITE, box).dataset.taTime = String(ta.timeMs);
  Label(newBest ? '自己ベスト更新！' : best ? `自己ベスト ${fmtMs(best.timeMs)}` : '', 36, 220, 820, 50, 32, newBest ? GOLD : MUTED, box);
  if (ghost && gt >= 0) {
    const d = (gt - ta.timeMs) / 1000;
    Label(`${ghost.name}（${fmtMs(gt)}）に ${Math.abs(d).toFixed(1)}秒差で${d > 0 ? '勝ち' : d < 0 ? '負け' : '同着'}`, 36, 290, 820, 50, 28, d > 0 ? col(.5, .9, .6) : WHITE, box).dataset.vsGhost = d > 0 ? 'win' : 'lose';
  }
  Label(r.line ? '一言：' + r.line : '', 36, 360, 820, 40, 22, MUTED, box);
  Label('記録はサーバーが同じエンジンで再計算して確定します（このプロトタイプでは端末に保存）。', 36, 410, 820, 60, 16, DIM, box);
  Button('もう一度', 36, 640, 400, 100, () => TimeAttack(raceCtx.trackId), CYAN, box);
  Ghost('リプレイを共有', 456, 640, 260, 100, () => ShareCard(currentScreen), box);
  Ghost('ホーム', 736, 640, 140, 100, Home, box);
}

// ================================================================= その他 / settings (language, legal, account deletion, demo states)
async function Settings() {
  currentScreen = Settings; await refresh();
  Clear('settings'); SetArt('Art/home-paddock'); Veil(.55);
  Header('その他', '設定・法定表示・アカウント');
  const lang = Panel('Language', 40, 120, 740, 150, NAVY);
  Label('言語', 24, 16, 300, 30, 18, CYAN, lang);
  Button(isJa() ? '日本語（使用中）' : '日本語', 24, 60, 330, 72, () => { prefs.set('muchi.language', 'ja'); Settings(); }, isJa() ? CYAN : NAVY, lang);
  Ghost('English（一部）', 380, 60, 330, 72, () => { prefs.set('muchi.language', 'en'); Settings(); }, lang);
  const legal = Panel('Legal', 40, 290, 740, 230, NAVY);
  Label('法定表示・規約', 24, 16, 300, 30, 18, CYAN, legal);
  [['利用規約', 'terms'], ['プライバシーポリシー', 'privacy'], ['特定商取引法に基づく表記', 'tokushoho'], ['資金決済法に基づく表示', 'shikin']].forEach(([n, k], i) => { const b = Ghost(n, 24 + (i % 2) * 350, 56 + Math.floor(i / 2) * 84, 330, 72, () => Legal(k, Settings), legal); b.classList.add('link'); });
  const more = Panel('More', 40, 540, 740, 240, NAVY);
  Label('相棒の見た目・お世話', 24, 16, 400, 30, 18, CYAN, more);
  Ghost('衣装', 24, 56, 160, 72, Wardrobe, more); Ghost('コースの見た目', 200, 56, 240, 72, CourseThemes, more); Ghost('レース条件', 456, 56, 260, 72, Conditions, more);
  Ghost('お世話', 24, 140, 160, 72, Care, more);
  // REQ-UXS-040 (UXP-007 preview): two-step deletion with a 14-day cancel window; purchases are blocked meanwhile
  const del = Panel('Delete', 820, 120, 740, 250, NAVY);
  Label('アカウント削除', 24, 16, 400, 30, 18, CYAN, del);
  const d = player.deletion;
  if (d?.status === 'scheduled') {
    Label(`削除予定：${jstDate(d.deleteAt)}\nそれまでは取り消せます。手続き中は購入できません。`, 24, 56, 690, 90, 20, YELLOW, del);
    Button('アカウント削除の取り消し', 24, 160, 460, 72, async () => { const r = await L.cancelDeletion(); toast(r.ok ? '削除を取り消しました' : r.message); Settings(); }, CYAN, del);
  } else {
    Label('削除すると14日後に全てのデータが消えます。期間内は取り消せます。', 24, 60, 690, 60, 18, MUTED, del);
    Ghost('アカウントを削除する', 24, 150, 460, 80, async () => {
      const r = await L.requestDeletion(null);
      if (!r.ok) { toast(r.message); return; }
      ConfirmDeletion(r.value);
    }, del).classList.add('danger');
  }
  // 引き継ぎ (REQ-API-005): the same buttons as the prompt; the prompt itself shows once (REQ-UXS-073)
  const link = Panel('Link', 820, 386, 740, 100, NAVY);
  Label('引き継ぎ（Apple・Google）', 24, 12, 400, 30, 18, CYAN, link);
  const lp = linkedProvider();
  Label(lp ? `${lp === 'apple' ? 'Apple' : 'Google'}で登録済み` : '未登録（機種変更の前に登録してください）', 24, 50, 420, 34, 18, lp ? col(.5, .9, .6) : WHITE, link);
  if (!lp) { Button('Apple', 450, 18, 130, 64, () => Link('apple', Settings), GOLD, link); Button('Google', 590, 18, 130, 64, () => Link('google', Settings), CYAN, link); }
  // demo states for review (REQ-UXP-002): the same rules on a moved clock
  const demo = Panel('Demo', 820, 500, 740, 280, col(.03, .06, .1, .92));
  Label('デモ状態（レビュー用）', 24, 16, 600, 30, 18, CYAN, demo);
  Label(`いま：${player.unlocks.day}日目・${player.unlocks.races}戦`, 24, 52, 600, 30, 18, MUTED, demo);
  [['初日', 'day1'], ['3日目', 'day3'], ['7日目', 'day7'], ['最初から', 'new']].forEach(([n, k], i) => Ghost(n, 24 + i * 176, 92, 164, 66, () => Demo(k), demo));
  Ghost('初回購入の直後', 24, 170, 340, 60, () => { linkOp('purchase'); if (!MaybeLinkPrompt('PurchaseComplete', Settings)) toast('引き継ぎの案内は出ません（表示済み・登録済み・FTUE中）'); }, demo).classList.add('small');
  Ghost('タイムアタック', 376, 170, 340, 60, () => TimeAttack(), demo).classList.add('small');
  Label('サーバーと同じ規則のまま、日付だけ進めてログボとレースを消化します。', 24, 238, 690, 30, 15, DIM, demo);
  TabBar(4);
}
function ConfirmDeletion(v) {
  currentScreen = () => ConfirmDeletion(v); Clear('delete-confirm'); SetArt('Art/home-paddock'); Veil(.75);
  const box = Panel('Confirm delete', 260, 90, 1080, 720, NAVY);
  Label('本当に削除しますか？', 40, 30, 1000, 56, 40, RED, box);
  Label(v.notice, 40, 110, 1000, 200, 20, WHITE, box);
  const f = v.forfeit;
  Label(`失うもの：有償コイン ${fmt(f.paidCoins)}　無償コイン ${fmt(f.freeCoins)}　馬 ${f.horses}頭　アイテム ${f.items}個${f.allowanceDays ? `　厩舎手当 残り${f.allowanceDays}日` : ''}${f.seasonPass ? '　シーズンパス' : ''}`, 40, 330, 1000, 80, 20, YELLOW, box);
  Button('やめる', 40, 590, 460, 100, Settings, CYAN, box);
  Ghost('削除を確定（14日後）', 540, 590, 500, 100, async () => { const r = await L.requestDeletion(v.confirmToken); toast(r.ok ? '削除を受け付けました。14日以内なら取り消せます。' : r.message); Settings(); }, box).classList.add('danger');
}
async function Demo(kind) {
  L.reset();
  document.querySelectorAll('.toast').forEach((t) => t.remove());
  for (const k of ['muchi.partner', 'muchi.notify.primer', 'muchi.link.prompt', 'muchi.link.firstPurchase', 'muchi.link.provider', 'muchi.proto.taFriends']) { try { localStorage.removeItem(k); } catch { /* */ } }
  try { for (const k of Object.keys(localStorage)) if (k.startsWith('muchi.proto.ta.')) localStorage.removeItem(k); } catch { /* */ }
  taCache = null;
  if (kind === 'new') { await L.bootstrap(); await refresh(); return Title(); }
  const spec = { day1: [1, [1]], day3: [3, [2, 2, 2]], day7: [7, [3, 3, 3, 3, 3, 3, 3]] }[kind];
  await L.seedDemo(spec[0], spec[1]);
  await refresh();
  return Home();
}

// ================================================================= legacy screens (Codex's Unity UI, unchanged layouts)
function Stable() {
  currentScreen = Stable; Clear(); SetArt('Art/partner-naming'); Panel('Stable detail', 990, 70, 570, 740, NAVY);
  const sp = profile(); const real = sp.partnerId != null;
  Label(real ? 'STABLE  /  YOUR PARTNER' : 'STABLE  /  01 OF 20', 1030, 108, 480, 34, 17, CYAN);
  const spd = real ? stat100(sp.partnerStats.speed) : 84, sta = real ? stat100(sp.partnerStats.stamina) : 78, pow = real ? stat100(sp.partnerStats.burst) : 81;
  Label(real ? sp.partnerName : horseName, 1030, 161, 480, 72, 44);
  Label(real ? `${sp.partnerRarity}   ·   ${partnerLine(sp)}` : 'SSR   ·   CLOSER', 1030, 238, 480, 34, 18, GOLD);
  Label('SPEED', 1030, 316, 170, 30, 17); Label(String(spd), 1440, 316, 60, 30, 19, GOLD); Panel('Speed bar', 1030, 353, 4.9 * spd, 9, col(.08, .8, .95));
  Label('STAMINA', 1030, 390, 170, 30, 17); Label(String(sta), 1440, 390, 60, 30, 19, GOLD); Panel('Stamina bar', 1030, 427, 4.9 * sta, 9, col(.08, .8, .95));
  Label('POWER', 1030, 465, 170, 30, 17); Label(String(pow), 1440, 465, 60, 30, 19, GOLD); Panel('Power bar', 1030, 502, 4.9 * pow, 9, col(.08, .8, .95));
  Label('APTITUDE', 1030, 545, 200, 30, 17, CYAN);
  Label(real ? `${(sp.partnerSurface ?? 'turf').toUpperCase()}   ${sp.partnerDistMinM}–${sp.partnerDistMaxM}m   ·   ${sp.horseCount} HORSES` : 'TURF  A       MIDDLE  A       GOOD  A', 1030, 585, 480, 58, 18);
  Button('SELECT FOR RACE  >>', 1030, 680, 470, RaceLobby);
  Button('BACK', 1030, 760, 170, Home, NAVY);
  Button('CARE / FEED', 1215, 760, 285, Care, NAVY);
}


function Odds(bannerId) {
  currentScreen = () => Odds(bannerId); Clear('odds'); SetArt('Art/scout-reveal');
  Panel('Odds veil', 0, 0, 1600, 900, col(.01, .035, .07, .55));
  Panel('Odds frame', 36, 30, 1528, 800, NAVY);
  // REQ-GACHA-002/015: every number below is generated by the server from the very table used for drawing
  const o = L.odds(bannerId);
  Label(T('SCOUT RATES') + '  /  ' + o.name, 70, 46, 1100, 40, 24, CYAN);
  Label('Generated from the same table used for drawing (server master).', 70, 88, 1100, 26, 16, col(.8, .89, .95));
  Label('RARITY TOTALS', 70, 126, 400, 28, 17, CYAN);
  Object.entries(o.rarityTotals).forEach(([r, v], i) => { Label(`${RARITY_SHAPE[r]} ${r}`, 70, 160 + i * 36, 120, 32, 20, r === 'SSR' ? GOLD : WHITE); Label(v.rate, 200, 160 + i * 36, 200, 32, 20); });
  Label('10TH PULL GUARANTEE (SR+)', 70, 280, 420, 28, 17, CYAN);
  Object.entries(o.guarantee.rarityTotals).forEach(([r, v], i) => { Label(`${RARITY_SHAPE[r]} ${r}`, 70, 314 + i * 36, 120, 32, 20, r === 'SSR' ? GOLD : WHITE); Label(v.rate, 200, 314 + i * 36, 200, 32, 20); });
  Label('PITY', 70, 400, 400, 28, 17, CYAN);
  const pity = Label(`${o.pity.pullsRequired} ${T('pulls → exchange')}（${o.pity.label}）\n${o.pity.targets.map(templateName).join(' / ')}\n最大 ${fmt(o.pity.costCoins)}コイン（≈ ${yen(o.pity.estimatedMaxCostYen)}）`, 70, 434, 420, 96, 17);
  pity.dataset.pityCost = String(o.pity.costCoins);
  if (o.pity.carryOver) Label(o.pity.carryOver.notice, 70, 534, 420, 120, 14, YELLOW).dataset.carryOver = '1';
  else Label('この天井は期間で閉じません。', 70, 534, 420, 30, 14, MUTED);
  if (o.limitedNotice) Label(o.limitedNotice, 70, 660, 420, 80, 13, MUTED);
  Label('EACH HORSE', 520, 126, 660, 28, 17, CYAN);
  const rows = [...o.items].sort((a, b) => rarityRank(b.rarity) - rarityRank(a.rarity) || b.ppm - a.ppm);
  rows.forEach((r, i) => {
    const colIdx = Math.floor(i / 15), row = i % 15;
    if (colIdx > 1) return;
    const x = 520 + colIdx * 340, y = 160 + row * 38;
    Label(`${RARITY_SHAPE[r.rarity]} ${r.rarity}`, x, y, 72, 30, 15, r.rarity === 'SSR' ? GOLD : r.rarity === 'SR' ? CYAN : WHITE);
    const n = Label(r.name + (r.limited ? '（限定）' : '') + (o.pickup?.templateId === r.templateId ? '★PU' : ''), x + 72, y, 180, 30, 15); n.style.whiteSpace = 'nowrap';
    Label(r.rate, x + 250, y, 90, 30, 15, col(.8, .89, .95));
  });
  // right column: the pickup's own rate, the step-up steps, legal pages (unchanged links)
  let y = 126;
  if (o.pickup) {
    Label('PICKUP', 1220, y, 320, 28, 17, CYAN);
    const p = Label(`${o.pickup.name}（${o.pickup.rarity}）\n1〜10枠目：${o.pickup.rate}\n10枠目の保証：${o.pickup.guaranteeRate}`, 1220, y + 32, 320, 96, 16);
    p.dataset.pickupRate = o.pickup.rate;
    y += 140;
  }
  if (o.stepUp) {
    Label('STEP-UP', 1220, y, 320, 28, 17, CYAN);
    o.stepUp.steps.forEach((s, i) => {
      const totals = s.finalSlot.rarityTotals ? Object.entries(s.finalSlot.rarityTotals).map(([r, v]) => `${r} ${v.rate}`).join(' ') : 'SR以上の保証（上の表）';
      Label(`ステップ${s.step}　10連 ${fmt(s.priceTen)}　10枠目：${totals}`, 1220, y + 32 + i * 30, 330, 28, 13, s.finalSlot.items ? GOLD : WHITE).dataset.step = String(s.step);
    });
    y += 32 + o.stepUp.steps.length * 30 + 6;
    Label(o.stepUp.notice, 1220, y, 320, 100, 12, MUTED);
    y += 104;
  }
  const legal = (L.legalLinks ?? []).filter((l) => l.key.startsWith('legal.'));
  legal.forEach((l, i) => { const b = Ghost(l.title, 1220, 640 + i * 66, 320, 58, () => Legal(l.key === 'legal.tokushoho' ? 'tokushoho' : 'shikin', () => Odds(bannerId))); b.classList.add('link'); });
  Button('BACK', 70, 760, 180, () => Scout(bannerId), NAVY);
}


function Wardrobe() {
  currentScreen = Wardrobe; Clear(); SetArt('Art/home-paddock');
  Panel('Partner wardrobe frame', 38, 54, 1524, 770, NAVY);
  Label('PARTNER WARDROBE  /  3D RACE MODELS', 76, 78, 980, 42, 24, CYAN);
  Label("Five coats and five silk sets. Your race model (LOCAL ONLY); rivals use the server's looks.", 76, 120, 960, 34, 18, col(.78, .89, .96));
  Panel('Selected partner preview', 72, 174, 448, 352, col(.03, .09, .15, .96));
  ArtImage(partnerPreview(equippedPartner()), 76, 176, 440, 352);
  Panel('Selected partner details', 72, 530, 448, 178, col(.04, .11, .18, .96));
  Label(['KOHAKU  /  BAY · CRIMSON', 'AKANE  /  CHESTNUT · AZURE', 'SHIRANAMI  /  DAPPLE · VIOLET', 'YORU  /  BLACK · EMERALD', 'KINAKO  /  PALOMINO · GOLD'][equippedPartner()], 94, 548, 410, 34, 18, GOLD);
  Label('FULL 3D HORSE + JOCKEY PAIR', 94, 588, 400, 30, 16, CYAN);
  Label('Original coat, tack, racing silks and rider details.', 94, 626, 400, 52, 15, col(.80, .88, .95));
  const names = ['KOHAKU · CRIMSON LAUREL', 'AKANE · AZURE CHEVRON', 'SHIRANAMI · VIOLET STAR', 'YORU · EMERALD CHECK', 'KINAKO · MIDNIGHT GOLD'];
  const accents = [col(.74, .12, .2), CYAN, col(.56, .35, .88), col(.12, .65, .38), GOLD];
  for (let i = 0; i < 5; i++) {
    const look = i; const x = 548 + (i % 3) * 326; const y = 174 + Math.floor(i / 3) * 276;
    Panel('Partner card ' + i, x, y, 306, 260, col(.055, .13, .21, .98));
    Panel('Partner accent ' + i, x, y, 306, 5, accents[i]);
    ArtImage(partnerPreview(i), x + 38, y + 11, 230, 184);
    Label(names[i], x + 12, y + 193, 282, 28, 15, i === equippedPartner() ? GOLD : WHITE);
    const equip = Button(i === equippedPartner() ? 'EQUIPPED' : 'EQUIP PARTNER', x + 13, y + 222, 280, 32, () => { prefs.set('muchi.partner.model', look); Wardrobe(); }, NAVY);
    if (i === equippedPartner()) disable(equip);
  }
  Panel('Partner vanity note', 548, 732, 956, 40, col(.04, .11, .18, .94));
  Label('HORSE COAT  /  RACING SILKS  /  SADDLE  /  BRIDLE  ·  COSMETIC ONLY', 566, 739, 920, 27, 15);
  Button('BACK', 76, 785, 180, Home, NAVY);
  Button('BROWSE COSMETICS', 1115, 785, 380, () => { Store('looks'); }, CYAN);
}


function CourseThemes() {
  currentScreen = CourseThemes; const activePreview = previewCourse >= 0 ? previewCourse : equippedCourse();
  Clear(); SetArt(courseArt(activePreview));
  Panel('Course screen veil', 0, 0, 1600, 900, col(.01, .04, .08, .45));
  Panel('Course selector frame', 36, 52, 1528, 770, NAVY);
  Label('RACECOURSE LOOKS  /  COSMETIC', 70, 72, 860, 42, 24, CYAN);
  Label('Course skins change the scene only. Ranked rules stay the same for everyone.', 70, 115, 1050, 34, 18);
  const names = ['GREENFIELD TURF', 'SPRING MEADOW', 'AUTUMN GOLD'];
  const rarities = ['N  ·  OWNED', 'SR  ·  PREVIEW', 'SSR  ·  PREVIEW'];
  for (let i = 0; i < 3; i++) {
    const theme = i; const x = 57 + i * 500;
    Panel('Course card ' + i, x, 212, 475, 510, col(.045, .12, .19, .97));
    ArtImage(courseArt(i), x + 12, 224, 451, 245);
    Label(names[i], x + 22, 482, 430, 36, 22);
    Label(rarities[i], x + 22, 521, 430, 28, 15, i === 0 ? CYAN : GOLD);
    Label(i === 0 ? 'Standard course environment.' : 'Visual environment preview. No gameplay advantage.', x + 22, 553, 430, 50, 15, col(.8, .88, .94));
    Button(theme === 0 ? 'EQUIP STANDARD' : 'PREVIEW', x + 18, 620, 210, () => { previewCourse = theme; CourseThemes(); }, NAVY);
    Button(i === 0 ? (equippedCourse() === 0 ? 'EQUIPPED' : 'USE LOOK') : 'VIEW IN SHOP', x + 245, 620, 210,
      i === 0 ? () => { prefs.set('muchi.cosmetic.course', 0); previewCourse = -1; CourseThemes(); } : () => { Store('looks'); }, i === 0 ? CYAN : GOLD);
  }
  Label('Preview changes are temporary until a theme is owned and equipped.  LOCAL ONLY (not on the server yet).', 70, 744, 1100, 32, 16, col(.8, .9, .95));
  Button('BACK', 70, 785, 180, Home, NAVY);
  Button('COURSE THEME SHOP', 1150, 785, 360, () => { Store('looks'); }, CYAN);
}


function Conditions() {
  currentScreen = Conditions;
  const weather = clamp(prefs.int('muchi.race.weather', 0), 0, 3), surface = clamp(prefs.int('muchi.race.surface', 1), 0, 3);
  const temperature = clamp(prefs.int('muchi.race.temperature', 1), 0, 3), wind = clamp(prefs.int('muchi.race.wind', 0), 0, 3);
  const set = (k, v) => { prefs.set(k, v); Conditions(); };
  Clear(); SetArt(weatherArt(weather));
  Panel('Conditions veil', 0, 0, 1600, 900, col(.015, .045, .08, .55));
  Panel('Conditions frame', 30, 45, 1540, 785, NAVY);
  Label('RACE CONDITIONS  /  PRIVATE ROOM PRESET', 60, 64, 850, 40, 24, CYAN);
  Label('Ranked races use official shared conditions. These settings are for private-room design.', 60, 106, 1150, 30, 17);
  const weatherNames = ['SUNNY', 'CLOUDY', 'RAIN', 'MORNING FOG'];
  for (let i = 0; i < 4; i++) {
    const choice = i; const x = 50 + i * 375;
    Panel('Weather card ' + i, x, 210, 350, 315, col(.045, .12, .19, .96));
    ArtImage(weatherArt(i), x + 8, 218, 334, 190);
    Label(weatherNames[i], x + 18, 417, 310, 30, 19);
    const b = Button(i === weather ? 'SELECTED' : 'PREVIEW', x + 12, 453, 326, 58, () => set('muchi.race.weather', choice), i === weather ? CYAN : NAVY);
    if (i === weather) disable(b);
  }
  Panel('Detailed settings', 50, 535, 1500, 260, col(.035, .095, .16, .97));
  Label('GROUND', 72, 546, 170, 32, 16, CYAN);
  ['FIRM', 'GOOD', 'SOFT', 'HEAVY'].forEach((g, i) => { const b = Button(g, 250 + i * 180, 530, 165, 58, () => set('muchi.race.surface', i), i === surface ? CYAN : NAVY); if (i === surface) disable(b); });
  Label('TEMPERATURE', 72, 613, 170, 32, 16, CYAN);
  [14, 18, 22, 26].forEach((t, i) => { const b = Button(t + ' °C', 250 + i * 180, 600, 165, 58, () => set('muchi.race.temperature', i), i === temperature ? CYAN : NAVY); if (i === temperature) disable(b); });
  Label('WIND', 72, 680, 170, 32, 16, CYAN);
  [0, 5, 10, 15].forEach((w, i) => { const b = Button(w + ' km/h', 250 + i * 180, 667, 165, 58, () => set('muchi.race.wind', i), i === wind ? CYAN : NAVY); if (i === wind) disable(b); });
  Label("Saved on this device only (LOCAL ONLY). Online races use the server's ground and weather. No paid advantage.", 72, 742, 1360, 27, 15, col(.8, .89, .95));
  Button('BACK', 60, 785, 180, Home, NAVY);
  Button('WEATHER EFFECTS', 1160, 785, 350, () => Store('looks'), GOLD);
}


function Care() {
  currentScreen = Care; const feed = clamp(prefs.int('muchi.care.feed', 0), 0, 2);
  Clear(); SetArt('Art/home-paddock');
  Panel('Care frame', 38, 55, 1524, 770, NAVY);
  Label('STABLE CARE  /  DAILY ROUTINE', 76, 76, 760, 42, 24, CYAN);
  Label('Choose a care focus freely. LOCAL ONLY (not on the server). Ranked stats are normalized.', 76, 118, 1000, 32, 17);
  const feedNames = ['GRAIN & APPLE', 'HAY & CARROT', 'FRESH WATER'];
  const rarity = ['N  ·  COMMON', 'R  ·  SELECT', 'SR  ·  REFINED'];
  const focus = ['Balanced condition', 'Endurance routine', 'Calm handling'];
  for (let i = 0; i < 3; i++) {
    const choice = i; const x = 72 + i * 500;
    Panel('Care card ' + i, x, 210, 465, 485, col(.045, .12, .19, .97));
    ArtImage(foodArt(i), x + 25, 225, 415, 255);
    Label(feedNames[i], x + 26, 490, 410, 35, 20);
    Label(rarity[i], x + 26, 532, 410, 28, 16, i === feed ? GOLD : CYAN);
    Label(focus[i], x + 26, 565, 410, 32, 17);
    const b = Button(i === feed ? "TODAY'S CARE SET" : 'CHOOSE CARE', x + 22, 610, 420, () => { prefs.set('muchi.care.feed', choice); Care(); }, i === feed ? CYAN : NAVY);
    if (i === feed) disable(b);
  }
  Panel('Premium decor', 72, 710, 950, 72, col(.035, .095, .16, .97));
  ArtImage('Art/Food/premium-bowl', 80, 702, 80, 80);
  Label('SSR STABLE BOWL  /  DECOR ONLY  /  NO FEED BONUS', 170, 731, 760, 34, 17, GOLD);
  Button('VIEW DECOR', 1170, 710, 300, () => { Store('looks'); }, GOLD);
  Button('BACK', 72, 785, 180, Home, NAVY);
}


// ================================================================= boot
function fit() {
  const s = Math.min(window.innerWidth / 1600, window.innerHeight / 900);
  $stage.style.transform = `scale(${s})`;
}
window.addEventListener('resize', fit);
fit();

async function boot() {
  const [ja, artIndex, ruleset, commentary, partners] = await Promise.all([
    fetch('data/ja.json').then((r) => r.json()), fetch('data/art.json').then((r) => r.json()),
    fetch('data/ruleset.json').then((r) => r.text()), fetch('data/commentary-ja.json').then((r) => r.text()), fetch('data/partners.json').then((r) => r.json()),
  ]);
  for (const e of ja.entries ?? []) JA[e.key] = e.value;
  ART = artIndex;
  const demo = new URLSearchParams(location.search).get('demo');
  if (demo) { L.reset(); }
  await L.bootstrap(); await refresh();
  const { dotnet } = await import('./engine/_framework/dotnet.js');
  const runtime = await dotnet.create();
  engine = (await runtime.getAssemblyExports(runtime.getConfig().mainAssemblyName)).MuchiRace;
  engine.Init(ruleset, commentary);
  view = new RaceView($canvas, (res) => art(res), partners);
  // the 3D models load while the title is up (the first race waits for them)
  viewReady = view.load();
  document.getElementById('boot').classList.add('hidden');
  globalThis.__muchi = {
    ready: false, screen: '',
    show: (name, ...a) => ({ Title, Home, NamePartner, Stable, Scout, Wardrobe, CourseThemes, Conditions, Care, Store, SeasonPass, RaceLobby, Settings, FreeScout, SecondRaceIntro, PurchaseConfirm, NotifyPrimer, TimeAttack, LinkPrompt, Odds: (id) => Odds(id ?? 'standard') })[name]?.(...a),
    demo: (k) => Demo(k),
    offer: () => OfferThen(Home),
    state: () => ({ player, lastFrame, raceActive, raceInfo, ftue, tutorialAttempt }),
    logic: L,
  };
  if (demo) await Demo(demo);
  else if (player.flags?.partnerHorseId || player.horses.some((h) => h.named)) await Home(); else Title();
  requestAnimationFrame(raceLoop);
  globalThis.__muchi.ready = true;
}
boot().catch((e) => { document.getElementById('boot').textContent = 'ERROR: ' + (e?.message ?? e); console.error(e); });
