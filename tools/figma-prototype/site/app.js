// ムチ一閃 web prototype — a 1:1 port of Codex's Unity frontend (unity/Assets/Muchi/Runtime/MuchiApp.cs:
// same 1600×900 layout coordinates, colours, texts, Japanese table and screen flow) running on
//   - MuchiLogic: the real server domain code (gacha tables, naming rules, wallet, purchase checks, pass) in the browser
//   - MuchiRace:  the real C# race engine + Unity game layer (OfflineRaceDriver/RaceInput/HudModel/CommentaryFeed) in WebAssembly
// Local-only features stay local exactly where the Unity build marks them LOCAL ONLY.
import { RaceView } from './race-view.js';

const L = globalThis.MuchiLogic;
const $screens = document.getElementById('screens');
const $stage = document.getElementById('stage');
const $canvas = document.getElementById('race-canvas');

// ---------------------------------------------------------------- colours (Unity Color → CSS)
const col = (r, g, b, a = 1) => `rgba(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)},${a})`;
const NAVY = col(.025, .075, .14, .9), CYAN = col(0, .8, .95), GOLD = col(1, .83, .08), WHITE = '#fff';

// ---------------------------------------------------------------- persistence (PlayerPrefs keys of the Unity build)
const prefs = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, String(v)); } catch { /* private mode */ } },
  int(k, d) { const v = parseInt(this.get(k, ''), 10); return Number.isFinite(v) ? v : d; },
};
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// ---------------------------------------------------------------- localisation (LocaleService)
let JA = {};
const EXTRA_JA = {
  'PROTOTYPE  /  LOCAL ENGINE': 'プロトタイプ ／ 端末内エンジン',
  'Server rules  /  ppm rate table  /  pity 100': '本番ルール ／ 確率表（ppm）／ 天井100回',
  'SCOUT RATES': '提供割合',
  'VIEW RATES': '提供割合',
  '1 PULL  ◎100': '1回 ◎100',
  '10 PULLS  ◎1,000': '10連 ◎1,000',
  'RARITY TOTALS': 'レア度ごとの合計',
  'EACH HORSE': '馬ごとの提供割合',
  '10TH PULL GUARANTEE (SR+)': '10連の10枠目（SR以上確定）',
  'PITY': '天井',
  'pulls → exchange': '回で交換',
  'Generated from the same table used for drawing (server master).': '抽選と同じ表（サーバーのマスターデータ）から自動生成しています。',
  'NOT ENOUGH COINS': 'コインが足りません',
  'Coins are spent paid-first. Get more in the coin shop.': '有償コインから先に使われます。コインショップで追加できます。',
  'PITY POINTS': '天井ポイント',
  'Name must be 2–9 katakana (hiragana is converted).': 'カタカナ2〜9文字で入力してください（ひらがなは自動でカタカナになります）。',
  'This name cannot be used.': 'この名前は使えません。',
  'NEW PARTNERS  /  ': '新しい相棒 ／ ',
  'MONTHLY LIMIT': '月の上限',
  'REMAINING': '残り',
  'NO LIMIT': '上限なし',
  'Age registered. Purchase allowed within the monthly limit.': '年齢を登録しました。月の上限の範囲で購入できます。',
  'Select your age range first.': '先に年齢を選んでください。',
  'Monthly limit reached for this age range.': 'この年齢区分の月の上限に達しています。',
  'Age can only be corrected toward younger. Contact support.': '年齢は若い方向にしか変更できません。サポートへ連絡してください。',
  'Already purchased (one per account).': '購入済みです（1アカウント1回）。',
  'Guardian consent is required under 18.': '18歳未満は保護者の同意が必要です。',
  'RESET PROTOTYPE': 'データを初期化',
};
const isJa = () => prefs.get('muchi.language', 'ja') === 'ja';
const T = (s) => (s == null ? s : isJa() ? (JA[s] ?? EXTRA_JA[s] ?? s) : s);
const MODE_LABEL = 'PROTOTYPE  /  LOCAL ENGINE';

// ---------------------------------------------------------------- art (Unity Resources paths → site files)
let ART = {};
const art = (res) => ART[res] || '';

// ---------------------------------------------------------------- screen builder (MuchiApp helpers)
let cur = null, currentScreen = null, languageButton = null;
function Clear() {
  raceActive = false;
  const next = document.createElement('div');
  next.className = 'screen';
  $screens.appendChild(next);
  const prev = [...$screens.children].filter((c) => c !== next);
  prev.forEach((p) => { p.classList.add('out'); p.classList.remove('in'); setTimeout(() => p.remove(), 320); });
  requestAnimationFrame(() => requestAnimationFrame(() => next.classList.add('in')));
  cur = next;
  $canvas.hidden = true;
  languageButton = Button(isJa() ? 'English' : '日本語', 1370, 132, 195, 72, ToggleLanguage, NAVY);
  languageButton.style.zIndex = 50;
}
function ToggleLanguage() { prefs.set('muchi.language', isJa() ? 'en' : 'ja'); currentScreen?.(); }
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
function Button(value, x, y, w, h, action, color) {
  if (typeof h === 'function') { color = action; action = h; h = 72; }
  const d = el('btn', x, y, w, h);
  const bg = document.createElement('div'); bg.className = 'bg'; bg.style.background = color ?? CYAN; d.appendChild(bg);
  const s = document.createElement('span');
  s.textContent = T(value);
  const size = h < 65 ? 21 : w < 220 ? 20 : 27;
  Object.assign(s.style, { fontSize: size + 'px', color: color ? WHITE : NAVY });
  d.appendChild(s);
  d.dataset.label = value;
  d.setAttribute('role', 'button');
  d.addEventListener('click', (e) => { if (d.classList.contains('disabled')) return; e.stopPropagation(); action(); });
  return d;
}
const disable = (b) => { b.classList.add('disabled'); return b; };
function SetArt(res) { const i = document.createElement('img'); i.className = 'art'; i.src = art(res); i.alt = ''; cur.insertBefore(i, cur.firstChild); }
function ArtImage(res, x, y, w, h, parent) {
  const i = document.createElement('img'); i.className = 'img'; i.src = art(res); i.alt = '';
  Object.assign(i.style, { left: x + 'px', top: y + 'px', width: w + 'px', height: h + 'px' });
  (parent || cur).appendChild(i); return i;
}
function Tag(title) { Panel('Header', 35, 30, 650, 65, NAVY); Label('/  ' + title, 55, 42, 620, 45, 30); Label(MODE_LABEL, 35, 850, 800, 30, 17, col(.8, .9, 1)); }
function show(fn, ...args) { currentScreen = () => fn(...args); fn(...args); }

// ---------------------------------------------------------------- local player (real PlayerService)
let player = null, firstScout = null, firstScoutRevealed = false, lastPulls = null;
const rarityRank = (r) => (r === 'SSR' ? 3 : r === 'SR' ? 2 : r === 'R' ? 1 : 0);
async function refresh() { player = await L.view(); return player; }
function partner() {
  if (!player || player.horses.length === 0) return null;
  const active = player.horses.filter((h) => h.status === 'active' || h.status == null);
  if (active.length === 0) return null;
  return active.filter((h) => h.named).sort((a, b) => rarityRank(b.rarity) - rarityRank(a.rarity))[0]
    ?? [...active].sort((a, b) => rarityRank(b.rarity) - rarityRank(a.rarity) || (a.id < b.id ? -1 : 1))[0];
}
function profile() {
  const p = partner();
  return {
    online: true, classId: player?.season?.classId ?? 'C', seasonPoints: player?.season?.points ?? 0, displayName: player?.profile?.displayName ?? '',
    free: player?.wallet?.free ?? 0, paid: player?.wallet?.paid ?? 0, debt: player?.wallet?.debt ?? 0,
    partnerId: p?.id ?? null, partnerName: p?.name ?? horseName, partnerRarity: p?.rarity ?? 'SR', partnerStyle: p?.style ?? 'sashi',
    partnerSurface: p?.surface ?? 'turf', partnerDistMinM: p?.distMinM ?? 1600, partnerDistMaxM: p?.distMaxM ?? 2400,
    partnerStats: p?.base ?? { speed: 560, stamina: 540, burst: 580, guts: 520, temper: 600 }, horseCount: player?.horses?.length ?? 0,
    tutorialScoutAvailable: !player?.flags?.tutorialGachaUsed || (firstScout != null && !firstScoutRevealed),
  };
}
const fmt = (n) => Number(n).toLocaleString('en-US');
const stat100 = (v) => clamp(Math.round(v / 10), 0, 100);
function partnerLine(p) {
  const style = p.partnerStyle === 'nige' ? 'FRONT RUNNER' : p.partnerStyle === 'senko' ? 'STALKER' : p.partnerStyle === 'oikomi' ? 'DEEP CLOSER' : 'CLOSER';
  return `${style}  /  ${(p.partnerSurface ?? 'turf').toUpperCase()}  /  ${fmt(p.partnerDistMinM)}–${fmt(p.partnerDistMaxM)}m`;
}
const horseNameOf = (id) => player?.horses.find((h) => h.id === id)?.name;
const templateName = (id) => L.master.templates.find((t) => t.id === id)?.name ?? id;

// ---------------------------------------------------------------- UI state
let horseName = prefs.get('muchi.partner', 'アカツキ');
let pendingName = null, storeTab = 0, previewCourse = -1, selectedAgeGroup = -1;
let purchaseReviewOpen = false, purchaseReturnScreen = null, pendingPurchase = null, pendingProductId = null, purchaseCheckMessage = null;
let tutorial = false, raceInfo = null, raceActive = false, lastFrame = null, messageUntil = 0, reinHeld = false, keyRein = false;
const equippedPartner = () => clamp(prefs.int('muchi.partner.model', 0), 0, 4);
const equippedCourse = () => clamp(prefs.int('muchi.cosmetic.course', 0), 0, 2);
const silkArt = (i) => (i === 1 ? 'Art/Cosmetics/jockey-cyan' : i === 2 ? 'Art/Cosmetics/jockey-violet' : 'Art/Cosmetics/jockey-crimson');
const courseArt = (i) => (i === 1 ? 'Art/Courses/spring-course' : i === 2 ? 'Art/Courses/autumn-course' : 'Art/home-paddock');
const weatherArt = (i) => 'Art/Weather/' + (i === 1 ? 'cloudy' : i === 2 ? 'rain' : i === 3 ? 'fog' : 'sunny');
const foodArt = (i) => 'Art/Food/' + (i === 1 ? 'hay-carrot' : i === 2 ? 'water-bucket' : 'oats-apple');
const PARTNERS = ['Bay_Crimson', 'Chestnut_Azure', 'DappleGrey_Violet', 'Black_Emerald', 'Palomino_Gold'];
const partnerPreview = (i) => 'Art/3DPreviews/Partner_' + PARTNERS[clamp(i, 0, 4)];

// ================================================================= screens
function Title() {
  currentScreen = Title; Clear(); SetArt('Art/title-screen');
  Panel('Title legibility veil', 0, 0, 720, 900, col(.015, .055, .11, .30));
  Panel('Top wordmark rule', 76, 105, 116, 5, CYAN);
  Label('ムチ一閃', 74, 135, 700, 130, 92, WHITE);
  Label('MUCHI ISSEN  /  JOCKEY RACING', 82, 270, 650, 39, 21, col(.82, .92, 1));
  Panel('Title accent rule', 82, 335, 65, 4, GOLD);
  Label(isJa() ? '最後の直線を、\n相棒と。' : 'Win together on the final straight.', 78, 370, 720, 180, 54, WHITE);
  Label('A RACE IS WON IN THE LAST STRAIGHT.', 84, 560, 720, 42, 21, col(.88, .93, .96));
  Button('RACE  /  START', 80, 690, 420, () => BeginRace(true));
  Label('TAP TO RIDE', 90, 785, 400, 34, 17, col(.89, .96, 1));
  Label('SEASON 01    •    TURF SERIES', 1110, 828, 450, 34, 16, WHITE);
  Label(MODE_LABEL, 1110, 792, 450, 30, 14, col(.82, .92, 1));
}

function Home() {
  currentScreen = Home; Clear(); SetArt('Art/home-paddock');
  const p = profile(); if (p.partnerId) horseName = p.partnerName;
  Panel('Player identity', 38, 34, 440, 104, NAVY);
  Label(`CLASS ${p.classId}  /  ${p.seasonPoints} PT`, 60, 47, 390, 36, 20, CYAN);
  Label('JOCKEY  ' + (p.displayName && !/^騎手[A-Z0-9]{0,4}$/.test(p.displayName) ? p.displayName : 'あなた'), 60, 90, 390, 30, 17);
  Panel('Wallet', 1210, 35, 350, 86, NAVY);
  Label((isJa() ? '無償 ◎ ' : 'FREE  ◎  ') + fmt(p.free), 1230, 46, 155, 29, 17, WHITE).style.whiteSpace = 'nowrap';
  Label((isJa() ? '有償 ◈ ' : 'PAID  ◈  ') + fmt(p.paid), 1390, 46, 155, 29, 17, GOLD).style.whiteSpace = 'nowrap';
  Label(p.debt > 0 ? 'Unsettled refund  ◈ ' + p.debt : 'Wallet balance', 1230, 79, 300, 25, 14, col(.75, .85, .91));
  Panel('Home greeting', 38, 244, 480, 230, NAVY);
  Label('YOUR PARTNER', 66, 275, 420, 36, 20, CYAN);
  Label(horseName, 66, 318, 425, 78, 49);
  Label(partnerLine(p), 66, 408, 425, 35, 18);
  Button('STABLE', 1180, 248, 176, Stable, NAVY);
  Button('SCOUT', 1374, 248, 176, Scout, NAVY);
  Button('WARDROBE', 1180, 328, 176, Wardrobe, NAVY);
  Button('COURSE', 1374, 328, 176, CourseThemes, NAVY);
  Button('SEASON PASS', 1180, 408, 176, SeasonPass, NAVY);
  Button('SHOP', 1374, 408, 176, () => { storeTab = 0; Store(); }, NAVY);
  Button('CARE / FEED', 1180, 488, 176, Care, NAVY);
  Button('CONDITIONS', 1374, 488, 176, Conditions, NAVY);
  Button('RACE  >>', 1160, 668, 392, Entry);
  Label('PRACTICE  /  OFFLINE', 1180, 754, 380, 35, 17, WHITE);
  Label('HOME   ·   ' + T(MODE_LABEL), 48, 836, 700, 32, 16, WHITE);
}

function NamePartner() {
  currentScreen = NamePartner; Clear(); SetArt('Art/partner-naming');
  Panel('Name panel', 980, 75, 580, 735, NAVY);
  Label('01  /  YOUR FIRST PARTNER', 1020, 110, 500, 35, 17, CYAN);
  Label('NAME YOUR PARTNER', 1020, 162, 500, 56, 31);
  Label('A good name makes a great story.', 1020, 225, 500, 38, 18, col(.82, .9, .96));
  Label('PARTNER NAME', 1020, 310, 500, 32, 17, CYAN);
  const fieldPanel = Panel('Name field', 1020, 353, 495, 75, col(.13, .2, .27));
  const input = document.createElement('input');
  input.className = 'field'; input.maxLength = 12; input.value = pendingName ?? horseName; input.setAttribute('aria-label', T('PARTNER NAME'));
  Object.assign(input.style, { left: '15px', top: '12px', width: '465px', height: '50px', fontSize: '30px' });
  input.addEventListener('input', () => { pendingName = input.value; });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') ConfirmName(input.value); });
  fieldPanel.appendChild(input);
  const np = profile();
  Label(np.partnerId
    ? `SPEED   ${stat100(np.partnerStats.speed)}        STAMINA   ${stat100(np.partnerStats.stamina)}\nPOWER   ${stat100(np.partnerStats.burst)}        RARITY      ${np.partnerRarity}`
    : 'SPEED   84        STAMINA   78\nPOWER   81        STYLE       CLOSER', 1020, 465, 495, 98, 23);
  Label('You can change the name later.', 1020, 587, 495, 32, 16, col(.82, .9, .96));
  Button('CONFIRM  >>', 1020, 667, 495, () => ConfirmName(input.value));
  Button('BACK', 1020, 758, 150, () => BeginRace(true), NAVY);
}
async function ensureFirstScout() {
  if (player.flags?.tutorialGachaUsed) return { ok: true };
  const r = await L.tutorialDraw();
  if (!r.ok) return r;
  firstScout = r.value; firstScoutRevealed = false; await refresh();
  return { ok: true };
}
async function ConfirmName(raw) {
  const value = (raw ?? '').trim();
  if (value.length < 2) { Info('NAME REQUIRED', 'Use 2 to 12 characters.', NamePartner); return; }
  // as GameBackend.NamePartnerAsync: draw the free first scout if needed, then name the partner (server NG rules)
  const s = await ensureFirstScout();
  if (!s.ok) { Info('NAME NOT ACCEPTED', s.message, NamePartner); return; }
  const p = partner();
  const r = await L.nameHorse(p.id, value);
  if (!r.ok) {
    pendingName = value;
    Info('NAME NOT ACCEPTED', r.code === 'NG_NAME' ? 'This name cannot be used.' : 'Name must be 2–9 katakana (hiragana is converted).', NamePartner);
    return;
  }
  await refresh(); horseName = partner()?.name ?? value; pendingName = horseName; prefs.set('muchi.partner', horseName);
  Scout();
}

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
  Button('SELECT FOR RACE  >>', 1030, 680, 470, Entry);
  Button('BACK', 1030, 760, 170, Home, NAVY);
  Button('CARE / FEED', 1215, 760, 285, Care, NAVY);
}

function Scout() {
  currentScreen = Scout; Clear(); SetArt('Art/scout-reveal'); Panel('Scout info', 40, 60, 550, 780, NAVY);
  const freeAvailable = profile().tutorialScoutAvailable;
  Label(freeAvailable ? 'WELCOME SCOUT  /  FREE 10' : 'FEATURED SCOUT  /  PREVIEW', 78, 101, 470, 40, 18, CYAN);
  Label('MEET YOUR\nNEXT PARTNER', 78, 165, 480, 150, 40);
  Panel('Rarity badge', 78, 355, 128, 49, GOLD); Label('SR+  GUARANTEED', 87, 366, 112, 28, 16, NAVY);
  Label('Ten horses. One new story.', 78, 427, 455, 38, 18);
  if (freeAvailable) {
    Label('Your first 10-pull is free.\nAt least one SR horse is included.', 78, 470, 455, 76, 20);
    Label('FREE PREVIEW  /  NO CURRENCY USED', 78, 564, 450, 30, 14, col(.72, .83, .91));
    Button('FREE 10-HORSE SCOUT', 78, 625, 470, StartScout);
  } else {
    // Paid scout on the real server table (Unity shows it paused until rates are configured; here the master table is live).
    const pity = player?.pity?.standard ?? 0;
    Label('Paid scout: 100 coins / 1 pull\n10-pull: 1 SR+ guaranteed\nExchange at 100 pulls.', 78, 470, 455, 105, 19);
    Label(`${T('PITY POINTS')}  ${pity} / ${L.master.pityCost('standard')}     FREE ◎ ${fmt(player.wallet.free)}  PAID ◈ ${fmt(player.wallet.paid)}`, 78, 586, 470, 45, 14, GOLD);
    Label('Server rules  /  ppm rate table  /  pity 100', 78, 627, 445, 52, 15, col(.82, .9, .96));
    Button('1 PULL  ◎100', 78, 690, 225, () => PaidScout(1), CYAN);
    Button('10 PULLS  ◎1,000', 323, 690, 225, () => PaidScout(10));
  }
  Button('BACK TO HOME', 78, 774, 200, Home, NAVY);
  Button('VIEW RATES', 298, 774, 250, () => Odds('standard'), NAVY);
}
async function StartScout() {
  const r = await ensureFirstScout();
  if (!r.ok) { Info('SCOUT FAILED', r.message, Scout); return; }
  RevealScout();
}
async function PaidScout(count) {
  const r = await L.draw('standard', count);
  if (!r.ok) { Info(r.code === 'INSUFFICIENT_COINS' ? 'NOT ENOUGH COINS' : 'SCOUT FAILED', r.code === 'INSUFFICIENT_COINS' ? 'Coins are spent paid-first. Get more in the coin shop.' : r.message, Scout); return; }
  await refresh();
  lastPulls = [...r.value.results].sort((a, b) => rarityRank(b.rarity) - rarityRank(a.rarity));
  RevealServerScout(lastPulls, false);
}
function RevealScout() {
  prefs.set('muchi.tutorial.scout.used', 1);
  const pulls = firstScout ? [...firstScout.results].sort((a, b) => rarityRank(b.rarity) - rarityRank(a.rarity)) : [];
  if (pulls.length > 0) { RevealServerScout(pulls, true); return; }
  // tutorial already drawn on an earlier visit: show the stable's best horses
  const best = [...(player?.horses ?? [])].sort((a, b) => rarityRank(b.rarity) - rarityRank(a.rarity)).slice(0, 10)
    .map((h) => ({ horseId: h.id, templateId: h.templateId, rarity: h.rarity, duplicate: false, guaranteed: false }));
  RevealServerScout(best, true);
}
function RevealServerScout(pulls, first) {
  if (first) firstScoutRevealed = true;
  currentScreen = () => RevealServerScout(pulls, first); Clear(); SetArt('Art/scout-reveal'); Panel('Scout result', 40, 70, 560, 760, NAVY);
  Label(T('NEW PARTNERS  /  ') + pulls.length, 78, 105, 475, 34, 17, CYAN);
  const name = (p) => horseNameOf(p.horseId) ?? templateName(p.templateId);
  const a = Label(name(pulls[0]), 78, 166, 470, 70, 47); a.classList.add('reveal-card');
  Label(pulls[0].rarity + (pulls[0].guaranteed ? '  ·  GUARANTEED' : ''), 78, 237, 470, 36, 20, GOLD);
  if (pulls.length > 1) {
    Panel('Horse result divider', 78, 400, 455, 2, col(.35, .55, .66));
    const b = Label(name(pulls[1]), 78, 430, 470, 58, 36); b.classList.add('reveal-card'); b.style.animationDelay = '.15s';
    Label(pulls[1].rarity, 78, 488, 470, 34, 18, GOLD);
  }
  const dup = pulls.filter((p) => p.duplicate).length;
  Label(`${Math.max(0, pulls.length - 2)} more partners joined your stable.` + (dup > 0 ? `\n${dup} duplicates became awakening material.` : ''), 78, 549, 470, 56, 18);
  // the full ten, as rarity chips (real draw results)
  pulls.slice(0, 10).forEach((p, i) => {
    const c = Panel('Pull ' + i, 640 + (i % 5) * 186, 590 + Math.floor(i / 5) * 110, 170, 96, col(.04, .1, .17, .92));
    c.classList.add('reveal-card'); c.style.animationDelay = (0.05 * i) + 's';
    Label(p.rarity, 12, 8, 150, 30, 20, p.rarity === 'SSR' ? GOLD : p.rarity === 'SR' ? CYAN : WHITE, c);
    Label(name(p), 12, 44, 150, 40, 15, WHITE, c);
  });
  Label('Server draw  /  free tutorial scout  /  odds on the gacha page', 78, 624, 455, 55, 14, col(.72, .83, .91));
  Button('GO TO HOME  >>', 78, 710, 470, Home);
}

function Odds(bannerId) {
  currentScreen = () => Odds(bannerId); Clear(); SetArt('Art/scout-reveal');
  Panel('Odds veil', 0, 0, 1600, 900, col(.01, .035, .07, .55));
  Panel('Odds frame', 36, 46, 1528, 772, NAVY);
  const o = L.odds(bannerId);
  Label(T('SCOUT RATES') + '  /  ' + o.name, 70, 68, 1100, 40, 24, CYAN);
  Label('Generated from the same table used for drawing (server master).', 70, 112, 1100, 30, 16, col(.8, .89, .95));
  Label('RARITY TOTALS', 70, 160, 400, 30, 17, CYAN);
  Object.entries(o.rarityTotals).forEach(([r, v], i) => { Label(r, 70, 200 + i * 40, 120, 34, 22, r === 'SSR' ? GOLD : WHITE); Label(v.rate, 200, 200 + i * 40, 200, 34, 22); });
  Label('10TH PULL GUARANTEE (SR+)', 70, 340, 420, 30, 17, CYAN);
  Object.entries(o.guarantee.rarityTotals).forEach(([r, v], i) => { Label(r, 70, 380 + i * 40, 120, 34, 22, r === 'SSR' ? GOLD : WHITE); Label(v.rate, 200, 380 + i * 40, 200, 34, 22); });
  Label('PITY', 70, 490, 400, 30, 17, CYAN);
  Label(`${o.pity.pullsRequired} ${T('pulls → exchange')}\n${o.pity.targets.map(templateName).join(' / ')}\n≈ ¥${fmt(o.pity.estimatedMaxCostYen)}`, 70, 528, 420, 120, 18);
  Label('EACH HORSE', 520, 160, 900, 30, 17, CYAN);
  const rows = [...o.items].sort((a, b) => rarityRank(b.rarity) - rarityRank(a.rarity) || b.ppm - a.ppm);
  rows.forEach((r, i) => {
    const colIdx = Math.floor(i / 12), row = i % 12;
    const x = 520 + colIdx * 340, y = 200 + row * 40;
    if (colIdx > 2) return;
    Label(r.rarity, x, y, 60, 30, 16, r.rarity === 'SSR' ? GOLD : r.rarity === 'SR' ? CYAN : WHITE);
    Label(r.name, x + 60, y, 190, 30, 16); Label(r.rate, x + 240, y, 90, 30, 16, col(.8, .89, .95));
  });
  Button('BACK', 70, 775, 180, Scout, NAVY);
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
  Button('BROWSE COSMETICS', 1115, 785, 380, () => { storeTab = 1; Store(); }, CYAN);
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
      i === 0 ? () => { prefs.set('muchi.cosmetic.course', 0); previewCourse = -1; CourseThemes(); } : () => { storeTab = 2; Store(); }, i === 0 ? CYAN : GOLD);
  }
  Label('Preview changes are temporary until a theme is owned and equipped.  LOCAL ONLY (not on the server yet).', 70, 744, 1100, 32, 16, col(.8, .9, .95));
  Button('BACK', 70, 785, 180, Home, NAVY);
  Button('COURSE THEME SHOP', 1150, 785, 360, () => { storeTab = 2; Store(); }, CYAN);
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
  Button('WEATHER EFFECTS', 1160, 785, 350, () => PurchaseReview('Course atmosphere effects', '¥240 (proposed)', 'COSMETIC'), GOLD);
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
  Button('VIEW DECOR', 1170, 710, 300, () => { storeTab = 1; Store(); }, GOLD);
  Button('BACK', 72, 785, 180, Home, NAVY);
}

function Store() {
  currentScreen = Store; Clear(); SetArt('Art/home-paddock');
  Panel('Store frame', 32, 42, 1536, 790, NAVY);
  Label('MUCHI STORE  /  DIRECT, CLEAR PRICES', 64, 59, 750, 42, 24, CYAN);
  const wp = profile();
  Label(`FREE  ◎  ${fmt(wp.free)}     PAID  ◈  ${fmt(wp.paid)}`, 930, 64, 390, 34, 19, GOLD);
  Button('COINS', 55, 132, 250, () => { storeTab = 0; Store(); }, storeTab === 0 ? CYAN : NAVY);
  Button('COSMETICS', 325, 132, 250, () => { storeTab = 1; Store(); }, storeTab === 1 ? CYAN : NAVY);
  Button('COURSE THEMES', 595, 132, 250, () => { storeTab = 2; Store(); }, storeTab === 2 ? CYAN : NAVY);
  Button('SEASON PASS', 865, 132, 250, SeasonPass, storeTab === 3 ? CYAN : NAVY);
  if (storeTab === 0) DrawCoinPackages(); else if (storeTab === 1) DrawCosmetics(); else DrawCourseProducts();
  Label('Store checkout is not connected in this build. No purchase can be completed here.', 62, 777, 1100, 28, 15, col(.8, .89, .95));
  Button('BACK', 1340, 775, 170, Home, NAVY);
}
function DrawCoinPackages() {
  const coins = L.master.products.filter((p) => p.kind === 'coins').sort((a, b) => a.priceYen - b.priceYen).slice(0, 8);
  coins.forEach((p, i) => {
    const c = i % 2, row = Math.floor(i / 2); const x = 62 + c * 755, y = 225 + row * 132;
    Panel('Coin pack ' + i, x, y, 705, 116, col(.045, .12, .19, .97));
    Label('¥' + fmt(p.priceYen), x + 22, y + 13, 170, 38, 23, GOLD);
    Label(fmt(p.paidCoins) + ' PAID COINS', x + 22, y + 54, 360, 34, 21);
    Label('FIRST TOP-UP  /  2× BONUS', x + 390, y + 18, 265, 26, 14, CYAN);
    Button('VIEW', x + 488, y + 48, 194, () => PurchaseReview(fmt(p.paidCoins) + ' PAID COINS', '¥' + fmt(p.priceYen), 'COIN PACK', p.id), CYAN);
  });
  Label('Paid and free coins are shown separately. Bonus is limited to one first purchase per pack.', 64, 756, 1280, 27, 15, col(.8, .89, .95));
}
function DrawCosmetics() {
  card('Art/Cosmetics/silk-jacket', 'CRIMSON SILK JACKET', 'SSR  ·  COSMETIC', '¥480 (proposed)', 64, 222, 'Racewear');
  card('Art/Cosmetics/bridle', 'BRASS-FIT BRIDLE', 'SR  ·  COSMETIC', '¥320 (proposed)', 572, 222, 'Horse tack');
  card('Art/Cosmetics/saddlecloth', 'STAR SADDLECLOTH', 'R  ·  COSMETIC', '¥320 (proposed)', 1080, 222, 'Horse tack');
  card('Art/Cosmetics/stable-plaque', 'STABLE NAMEPLATE', 'SSR  ·  COSMETIC', '¥480 (proposed)', 64, 474, 'Stable decor');
  card('Art/Food/premium-bowl', 'STAR STABLE BOWL', 'SSR  ·  DECOR ONLY', '¥240 (proposed)', 572, 474, 'Stable decor');
  Label('No random draw. The item and rarity are visible before purchase.', 64, 744, 1180, 28, 16, col(.8, .89, .95));
  function card(a, name, rarity, price, x, y, kind) {
    Panel('Cosmetic ' + name, x, y, 470, 230, col(.045, .12, .19, .97));
    ArtImage(a, x + 7, y + 13, 146, 200);
    Label(name, x + 164, y + 18, 292, 50, 18);
    Label(rarity, x + 164, y + 68, 292, 28, 14, GOLD);
    Label(T(kind) + T('  /  no ranked stat bonus'), x + 164, y + 99, 292, 34, 13, col(.8, .89, .95));
    Label(price, x + 164, y + 136, 292, 28, 16, CYAN);
    Button('REVIEW', x + 164, y + 166, 286, 58, () => PurchaseReview(name, price, 'COSMETIC'), NAVY);
  }
}
function DrawCourseProducts() {
  const cpc = (index, name, rarity, price, x, y) => {
    Panel('Course product ' + name, x, y, 680, 308, col(.045, .12, .19, .97));
    ArtImage(courseArt(index), x + 10, y + 10, 660, 175);
    Label(name, x + 22, y + 195, 400, 34, 21);
    Label(T(rarity) + T('  ·  no gameplay change'), x + 22, y + 232, 405, 28, 15, GOLD);
    Label(price, x + 435, y + 220, 220, 25, 16, GOLD);
    Button('REVIEW', x + 435, y + 250, 220, () => PurchaseReview(name, price, 'COSMETIC'), NAVY);
  };
  cpc(1, 'SPRING MEADOW', 'SR  ·  COURSE SKIN', '¥680 (proposed)', 68, 222);
  cpc(2, 'AUTUMN GOLD', 'SSR  ·  COURSE SKIN', '¥680 (proposed)', 816, 222);
  Panel('Weather pack tile', 68, 555, 1430, 174, col(.045, .12, .19, .97));
  ArtImage('Art/Weather/rain', 82, 563, 200, 156);
  Label('TWILIGHT RAIN ATMOSPHERE', 300, 576, 760, 36, 21);
  Label('SSR  ·  LIGHTING AND WEATHER EFFECTS ONLY', 300, 615, 760, 30, 15, GOLD);
  Label('Visual add-on for private rooms. Ranked weather is fixed by the event.', 300, 647, 770, 36, 15, col(.8, .89, .95));
  Label('¥240 (proposed)', 1140, 570, 300, 28, 17, GOLD);
  Button('REVIEW', 1130, 623, 340, () => PurchaseReview('Twilight rain atmosphere', '¥240 (proposed)', 'COSMETIC'), NAVY);
}

async function SeasonPass() {
  currentScreen = SeasonPass;
  const pass = await L.passView();
  Clear(); SetArt('Art/home-paddock');
  Panel('Pass frame', 36, 46, 1528, 772, NAVY);
  Label('TURF SERIES  /  SEASON 01', 70, 68, 760, 40, 24, CYAN);
  Panel('Pass hero panel', 66, 126, 405, 606, col(.04, .1, .17, .96));
  ArtImage('Art/Cosmetics/jockey-violet', 94, 138, 350, 420);
  Label('VIOLET STAR SILKS', 90, 568, 350, 34, 22, GOLD);
  Label('Immediate reward with Premium Pass.', 90, 605, 345, 46, 17);
  Label('FREE + PREMIUM REWARD TRACKS', 520, 92, 850, 37, 22);
  Label(`LEVEL ${pass.level}  ·  XP ${pass.xp}  ·  PREMIUM ${pass.active ? 'ACTIVE' : 'NOT ACTIVE'}`, 520, 129, 850, 30, 16, col(.8, .89, .95));
  const free = ['100 COINS', 'R CARE KIT', '100 COINS', 'SADDLE TAG', '200 COINS'];
  const premium = ['SILK SET', 'SR TICKET', 'STABLE DECOR', '300 COINS', 'SSR TACK'];
  for (let i = 0; i < 5; i++) {
    const x = 520 + i * 198;
    Panel('Free reward ' + i, x, 217, 180, 178, col(.055, .14, .22, .97));
    Label('TIER  ' + (i + 1), x + 14, 231, 150, 28, 15, CYAN); Label(free[i], x + 14, 281, 150, 72, 19); Label('FREE', x + 14, 357, 150, 24, 14, col(.78, .88, .94));
    Panel('Premium reward ' + i, x, 412, 180, 178, col(.09, .13, .22, .97));
    Label('TIER  ' + (i + 1), x + 14, 426, 150, 28, 15, GOLD); Label(premium[i], x + 14, 475, 150, 72, 19); Label('PREMIUM', x + 14, 552, 150, 24, 14, GOLD);
  }
  Panel('Pass price', 520, 594, 980, 74, col(.04, .11, .18, .97));
  Label('¥1,000 / 30 days  ·  renews through platform settings', 544, 609, 720, 29, 19, GOLD);
  Label('No charge until platform billing and age checks are configured.', 544, 638, 740, 24, 14, col(.8, .89, .95));
  Button('REVIEW PREMIUM PASS', 520, 683, 470, () => PurchaseReview('TURF SERIES PREMIUM PASS', '¥1,000 / 30 days', 'SEASON PASS', 'season_pass'), CYAN);
  Button('BACK', 70, 775, 180, Home, NAVY);
  Button('OPEN STORE', 1110, 775, 350, () => { storeTab = 0; Store(); }, NAVY);
}

// ---------------- purchase review (real server purchase-intent rules: age band, guardian consent, monthly limit, once-only)
const ERROR_TEXT = {
  AGE_REQUIRED: 'Select your age range first.', AGE_LIMIT_EXCEEDED: 'Monthly limit reached for this age range.',
  CONFLICT: 'Age can only be corrected toward younger. Contact support.', ALREADY_PURCHASED: 'Already purchased (one per account).',
  GUARDIAN_CONSENT_REQUIRED: 'Guardian consent is required under 18.',
};
async function RunPurchaseCheck(productId) {
  purchaseCheckMessage = 'CHECKING WITH SERVER…';
  const r = await L.purchaseIntent(productId);
  if (pendingProductId !== productId) return;
  if (r.ok) {
    const v = r.value;
    purchaseCheckMessage = T('Age registered. Purchase allowed within the monthly limit.') + '\n' +
      (v.monthlyLimitYen == null ? T('NO LIMIT') : `${T('MONTHLY LIMIT')} ¥${fmt(v.monthlyLimitYen)}  ·  ${T('REMAINING')} ¥${fmt(v.remainingYen)}`);
  } else purchaseCheckMessage = T(ERROR_TEXT[r.code] ?? r.message);
  if (purchaseReviewOpen) PurchaseReview(pendingPurchase.title, pendingPurchase.price, pendingPurchase.kind);
}
function PurchaseReview(title, price, kind, productId) {
  if (productId !== undefined && (pendingProductId !== productId || !purchaseReviewOpen)) {
    purchaseCheckMessage = null; pendingProductId = productId;
    if (productId) RunPurchaseCheck(productId);
  }
  if (!purchaseReviewOpen) { purchaseReturnScreen = currentScreen; selectedAgeGroup = -1; }
  purchaseReviewOpen = true;
  pendingPurchase = { title, price, kind };
  currentScreen = () => PurchaseReview(pendingPurchase.title, pendingPurchase.price, pendingPurchase.kind);
  Clear(); SetArt('Art/home-paddock'); Panel('Purchase review veil', 0, 0, 1600, 900, col(.01, .035, .07, .58));
  Panel('Purchase review', 225, 105, 1150, 690, NAVY);
  Label('PURCHASE REVIEW  /  AGE AND BILLING CHECK', 275, 140, 950, 40, 23, CYAN);
  Label('Selected item', 278, 220, 220, 28, 16, col(.8, .89, .95));
  Label(title, 278, 257, 735, 54, 32);
  Label(T(kind) + '  ·  ' + T(price), 278, 320, 740, 36, 21, GOLD);
  Panel('Review divider', 278, 378, 1000, 2, col(.35, .55, .66));
  Label('Select the age range to design the age-check step.', 278, 405, 900, 34, 18);
  ['UNDER 16', '16–17', '18+'].forEach((a, i) => {
    const b = Button(a, 278 + i * 235, 458, 210, () => SelectAgeGroup(i), selectedAgeGroup === i ? CYAN : NAVY);
    if (selectedAgeGroup === i) disable(b);
  });
  Label(purchaseCheckMessage ?? 'Age-based monthly limits and guardian consent rules must be supplied by the service.', 278, 548, 960, 58, 17, col(.82, .9, .96));
  Panel('Checkout lock', 278, 625, 995, 88, col(.16, .07, .08, .95));
  Label('CHECKOUT DISABLED  /  PLATFORM BILLING NOT CONNECTED', 300, 640, 930, 30, 18, col(1, .72, .55));
  Label('Displayed prices for cosmetics are proposals. No charge is made in this prototype.', 300, 675, 930, 28, 15, col(.9, .82, .78));
  Button('BACK', 278, 736, 290, ReturnFromPurchase, NAVY);
  Button('CLOSE', 1090, 736, 180, () => { purchaseReviewOpen = false; pendingProductId = null; Home(); }, NAVY);
}
async function SelectAgeGroup(i) {
  selectedAgeGroup = i;
  // register a representative birth month for the band (server rule: age can only move toward younger once set)
  const now = new Date(); const age = i === 0 ? 14 : i === 1 ? 17 : 30;
  const r = await L.setAge(now.getFullYear() - age - 1, 1, i < 2);
  if (!r.ok) purchaseCheckMessage = T(ERROR_TEXT[r.code] ?? r.message);
  if (pendingProductId && r.ok) { await RunPurchaseCheck(pendingProductId); return; }
  PurchaseReview(pendingPurchase.title, pendingPurchase.price, pendingPurchase.kind);
}
function ReturnFromPurchase() { purchaseReviewOpen = false; pendingProductId = null; (purchaseReturnScreen ?? Home)(); }

function Info(title, body, next) {
  currentScreen = () => Info(title, body, next); Clear(); SetArt('Art/home-paddock'); Panel('Information', 300, 170, 1000, 540, NAVY);
  Label(title, 350, 220, 900, 80, 44, CYAN); Label(body, 350, 335, 900, 240, 28); Button('CONTINUE  >>', 760, 610, 480, next);
}

function Entry() {
  currentScreen = Entry; Clear(); SetArt(equippedCourse() === 0 ? 'Art/first-ride' : courseArt(equippedCourse())); Panel('Race registration', 970, 67, 590, 755, NAVY);
  Label('PRACTICE RACE  /  OFFLINE', 1010, 105, 500, 35, 17, CYAN);
  Label('GREENFIELD CUP', 1010, 162, 500, 60, 34);
  Label('TURF  ·  2,000 m  ·  LEFT', 1010, 235, 500, 36, 20, GOLD);
  Panel('Course map plate', 1010, 300, 500, 145, col(.05, .15, .21, .9));
  Label('HOME STRAIGHT  ━━━━━━━  FINISH', 1040, 350, 450, 46, 20);
  Label(`12 runners   /   CPU opponents\nOffline practice   /   no rank points\nPartner   /   ${horseName}`, 1010, 490, 500, 130, 20);
  Button('ENTER THE RACE  >>', 1010, 675, 495, () => StartRace('practice'));
  Button('BACK', 1010, 765, 160, Home, NAVY);
}

// ================================================================= race (WASM engine + Unity HUD layout)
let engine = null, view = null, hud = {}, raceMode = 'tutorial';
function BeginRace(first) { tutorial = first; StartRace('tutorial'); }
function StartRace(mode) {
  raceMode = mode; tutorial = mode === 'tutorial';
  const p = partner();
  const partnerJson = p && mode !== 'tutorial' ? JSON.stringify({ speed: p.base.speed, stamina: p.base.stamina, burst: p.base.burst, guts: p.base.guts, temper: p.base.temper, style: p.style, distMinM: p.distMinM, distMaxM: p.distMaxM }) : '';
  raceInfo = JSON.parse(engine.Start(mode, horseName, partnerJson, Date.now() % 2147483647));
  view.start(raceInfo, equippedPartner());
  lastFrame = null; reinHeld = false; keyRein = false; messageUntil = 0;
  BuildRaceScreen();
}
function BuildRaceScreen() {
  currentScreen = BuildRaceScreen; Clear(); cur.classList.add('race'); $canvas.hidden = false; raceActive = true;
  Panel('Distance plate', 35, 35, 360, 90, NAVY); hud.distance = Label('— m', 60, 50, 320, 65, 46);
  Panel('Position plate', 1280, 35, 285, 100, NAVY); hud.position = Label('— / —', 1310, 48, 250, 75, 57, GOLD); hud.position.style.whiteSpace = 'nowrap';
  hud.clock = Label('0:00.0', 700, 40, 300, 50, 30);
  hud.status = Label('', 560, 92, 480, 34, 18, col(.82, .92, 1), undefined, 'center');
  Panel('Stamina plate', 35, 680, 500, 130, NAVY); hud.stamina = Label('STAMINA', 60, 700, 450, 40, 23);
  Panel('Stamina track', 60, 755, 440, 22, col(.2, .28, .34));
  hud.staminaFill = Panel('Stamina fill', 60, 755, 440, 22, CYAN);
  hud.feedback = Label(tutorial ? 'TIME YOUR SPUR' : 'FINAL STRAIGHT', 510, 220, 700, 80, 40, GOLD);
  hud.feedback.style.textShadow = '0 2px 10px rgba(0,0,0,.6)';
  hud.subtitle = Label('', 300, 610, 1000, 60, 26, WHITE, undefined, 'center');
  hud.subtitle.style.textShadow = '0 2px 8px rgba(0,0,0,.85)';
  hud.spurs = Label('SPURS  6 / 6', 1100, 530, 460, 50, 26, GOLD);
  Button('<', 35, 530, 110, () => engine.Lane(-1), NAVY); Button('>', 165, 530, 110, () => engine.Lane(1), NAVY);
  const spur = Button('SPUR', 1250, 600, 290, Spur, GOLD); hud.spurText = spur.querySelector('span');
  Label('Hold SPACE to rein / Arrow keys to steer / E to spur', 35, 820, 1050, 35, 20);
  const rein = Button('REIN', 325, 530, 210, () => {}, NAVY);
  const hold = (v) => (e) => { e.preventDefault(); reinHeld = v; };
  rein.addEventListener('pointerdown', hold(true)); rein.addEventListener('pointerup', hold(false)); rein.addEventListener('pointerleave', hold(false)); rein.addEventListener('pointercancel', hold(false));
  Button('EXIT', 1400, 815, 165, () => { raceActive = false; Home(); }, NAVY);
  Panel('Minimap', 1180, 725, 200, 85, NAVY);
  hud.dots = [];
  for (let i = 0; i < 12; i++) hud.dots.push(Panel('Runner ' + i, 1190, 735 + i * 5, 6, 6, i === 0 ? GOLD : WHITE));
  hud.dots.forEach((d, i) => { d.style.display = i < raceInfo.names.length ? '' : 'none'; });
}
function Spur() {
  if (!lastFrame) return;
  if (lastFrame.departed && lastFrame.whips <= 0) return;
  engine.Spur();
  hud.feedback.textContent = T(lastFrame.departed ? 'SPUR!' : 'GO!'); messageUntil = performance.now() + 1200;
  hud.feedback.classList.remove('flash'); void hud.feedback.offsetWidth; hud.feedback.classList.add('flash');
}
const phaseFeedback = (f) => (!f.gateOpen ? 'GATE IN ' + (Math.floor(f.gateTicks / 20) + 1) : !f.departed ? 'START!' : f.kakari ? 'HOLD THE REIN' : f.spurt ? 'SPUR WINDOW' : f.finished ? 'FINISH' : 'HOLD YOUR LINE');
function raceLoop() {
  requestAnimationFrame(raceLoop);
  if (!raceActive) return;
  engine.Rein(reinHeld || keyRein);
  const f = JSON.parse(engine.Frame(performance.now()));
  lastFrame = f;
  view.draw(f);
  hud.position.textContent = isJa() ? `${f.rank}位 / ${f.runners}頭` : `${f.rank} / ${f.runners}`;
  hud.position.style.fontSize = (hud.position.textContent.length > 7 ? 47 : 57) + "px";
  hud.distance.textContent = isJa() ? `残り ${f.remainingM} m` : `${f.remainingM} m`;
  hud.clock.textContent = f.time;
  hud.spurs.textContent = (isJa() ? 'ムチ　' : 'SPURS  ') + f.whips + ' / ' + f.maxWhips;
  hud.staminaFill.style.width = (440 * f.stamina / 1000) + 'px';
  hud.stamina.textContent = T(f.kakari ? 'STAMINA  ·  KAKARI' : f.reining ? 'STAMINA  ·  REIN' : 'STAMINA');
  hud.spurText.textContent = T(f.departed ? 'SPUR' : 'START');
  if (performance.now() > messageUntil) hud.feedback.textContent = T(phaseFeedback(f));
  hud.subtitle.textContent = f.subtitle;
  f.progress.forEach((p, i) => { if (hud.dots[i]) hud.dots[i].style.left = (1190 + 180 * p) + 'px'; });
  if (f.done) { raceActive = false; setTimeout(Result, 900); }
}
document.addEventListener('keydown', (e) => {
  if (!raceActive || e.repeat) return;
  if (e.key === 'ArrowLeft') engine.Lane(-1);
  else if (e.key === 'ArrowRight') engine.Lane(1);
  else if (e.key === 'e' || e.key === 'E') Spur();
  else if (e.code === 'Space') { keyRein = true; e.preventDefault(); }
});
document.addEventListener('keyup', (e) => { if (e.code === 'Space') keyRein = false; });
window.addEventListener('blur', () => { reinHeld = false; keyRein = false; });

function Result() {
  currentScreen = Result;
  const first = tutorial; const f = lastFrame ?? {};
  const place = f.finishPlace > 0 ? f.finishPlace : f.rank;
  Clear(); SetArt('Art/race-result'); Panel('Result detail', 42, 55, 620, 780, NAVY);
  Label('RACE RESULT  /  ' + (first ? 'FIRST RIDE' : 'PRACTICE'), 80, 99, 540, 34, 17, CYAN);
  Label(!place ? '—' : isJa() ? place + '位' : place === 1 ? '1ST' : place === 2 ? '2ND' : place === 3 ? '3RD' : place + 'TH', 80, 166, 540, 130, 89, GOLD);
  Label(place === 1 ? 'VICTORY' : 'RACE COMPLETE', 80, 300, 540, 60, 33);
  Label(`${horseName}  /  ${raceInfo.surface === 'dirt' ? 'DIRT ' : 'TURF '}${fmt(raceInfo.distanceM)} m`, 80, 377, 520, 35, 18);
  Panel('Result rule', 80, 440, 500, 2, col(.45, .62, .71));
  Label('TIME', 80, 482, 120, 30, 16, CYAN); Label(f.time ?? '—', 80, 520, 230, 45, 31);
  Label('MODE', 340, 482, 210, 30, 16, CYAN); Label('OFFLINE', 340, 520, 230, 45, 31, GOLD);
  Label('PRACTICE  /  NO RANK POINTS', 80, 600, 520, 38, 16, col(.82, .9, .96));
  // finishing order (real engine result)
  if (f.order) {
    Panel('Order panel', 700, 140, 380, 60 + Math.min(f.order.length, 12) * 44, NAVY);
    Label('RACE RESULT', 724, 156, 330, 30, 16, CYAN);
    f.order.slice(0, 12).forEach((slot, i) => Label(`${i + 1}.  ${raceInfo.names[slot]}`, 724, 196 + i * 44, 340, 36, 20, slot === 0 ? GOLD : WHITE));
  }
  Button(first ? 'MEET YOUR PARTNER' : 'CONTINUE  >>', 80, 675, 500, first ? NamePartner : Home);
  Label(MODE_LABEL, 80, 780, 500, 26, 13, col(.72, .83, .91));
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
  await L.bootstrap(); await refresh();
  const { dotnet } = await import('./engine/_framework/dotnet.js');
  const runtime = await dotnet.create();
  engine = (await runtime.getAssemblyExports(runtime.getConfig().mainAssemblyName)).MuchiRace;
  engine.Init(ruleset, commentary);
  view = new RaceView($canvas, (res) => art(res), partners);
  await view.load();
  document.getElementById('boot').classList.add('hidden');
  if (player.horses.some((h) => h.named)) Home(); else Title();
  requestAnimationFrame(raceLoop);
  globalThis.__muchi = { ready: true, show: (name) => ({ Title, Home, NamePartner, Stable, Scout, Wardrobe, CourseThemes, Conditions, Care, Store, SeasonPass, Entry, Odds: () => Odds('standard') })[name]?.(), state: () => ({ player, lastFrame, raceActive }) };
}
boot().catch((e) => { document.getElementById('boot').textContent = 'ERROR: ' + (e?.message ?? e); console.error(e); });
