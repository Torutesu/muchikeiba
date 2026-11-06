// ムチ一閃 club UI — Codex's frontend (frontend/src/main.js + details.js, the 25 detailed screens in
// frontend/design/screens) with its mock data replaced by the real game:
//   - MuchiLogic (js/logic.js): the server domain (server/src/domain) bundled for the browser — gacha with the ppm
//     tables, naming with the NG list, missions / login bonus, race rewards, breeding, room conditions, age checks.
//   - MuchiRace (engine/_framework): the C# race engine + Unity game layer in WebAssembly (tutorial and 2000m races).
// Markup and class names follow Codex's code so its stylesheets (copied to club/codex/ by build.sh) apply unchanged.
// State lives in localStorage. No server, no billing, no online play.
const L = globalThis.MuchiLogic;
const safe = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const read = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } };
const write = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ } };
const app = document.querySelector('#app');
const screens = ['はじめに', '初めての直線', '相棒の命名', '無料スカウト', 'ホーム', '厩舎', '出走登録', 'レース', 'リザルト', 'ショップ'];
const params = new URLSearchParams(location.search);
const SPEED = Math.min(8, Math.max(1, Number(params.get('speed')) || 1)); // test hook: race clock multiplier
const KEYS = { selected: 'muchi-club-selected', scout: 'muchi-club-first-scout', race: 'muchi-club-last-race', layout: 'muchi-club-layout', horse: 'muchi-club-horse' };

// ---------------------------------------------------------------- real data → Codex's display vocabulary
const STYLE = { nige: '逃げ', senko: '先行', sashi: '差し', oikomi: '追込' };
const SURFACE = { turf: '芝', dirt: 'ダート', both: '芝・ダート' };
const RARITY = { R: 1, SR: 2, SSR: 3 };
const GOING = { firm: '良（硬め）', good: '良', yielding: '稍重', soft: '重', fast: '良', muddy: '稍重', sloppy: '重' };
const WEATHER = { sunny: '晴れ', cloudy: 'くもり', rain: '雨', fog: '霧' };
const SKILL = {
  nige: ['ハナを奪う', '序盤から先頭に立ち、そのまま押し切る逃げタイプ。'],
  senko: ['好位のリズム', '序盤から好位置を取りやすい先行タイプ。'],
  sashi: ['直線の一閃', '最後の直線で伸びる、差し脚が持ち味。'],
  oikomi: ['ラストスパート', '脚をためて、後方から長い末脚を使う。'],
};
const fmt = (n) => Number(n).toLocaleString('ja-JP');
const distClass = (h) => { const mid = (h.distMinM + h.distMaxM) / 2; return mid < 1500 ? '短距離' : mid <= 2200 ? '中距離' : '長距離'; };
const total = (h) => Math.min(99, Math.round((h.base.speed + h.base.stamina + h.base.burst + h.base.guts + h.base.temper) / 40));
const aptitude = (h, surface) => (h.surface === surface || h.surface === 'both' ? 'A' : 'C');
const jstDate = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const ERROR_TEXT = {
  INVALID_NAME: 'カタカナ2〜9文字で入力してください（ひらがなは自動でカタカナになります）。',
  NG_NAME: 'この名前は使用できません。別の名前を入力してください。',
  AGE_REQUIRED: '生年月を入力してください。', AGE_LIMIT_EXCEEDED: '今月の購入上限に達しています。',
  CONFLICT: '生年月は若い方向にしか訂正できません。サポートへお問い合わせください。',
  GUARDIAN_CONSENT_REQUIRED: '18歳未満の方は保護者の同意が必要です。', ALREADY_PURCHASED: 'この商品は購入済みです（1アカウント1回）。',
  ALREADY_CLAIMED: '受取済みです。', NOT_ELIGIBLE: 'まだ条件を満たしていません。', INSUFFICIENT_COINS: 'コインが足りません。',
  HORSE_NOT_RETIRED: '引退した馬だけが配合できます。', BREEDING_INVALID_PAIR: '父馬（牡）と母馬（牝）を選んでください。',
  BREEDING_DAILY_LIMIT: '今日の配合回数を使い切りました。', HORSE_NOT_ACTIVE: 'この馬はすでに引退しています。',
};
const errorText = (r) => ERROR_TEXT[r.code] ?? r.message;

// ---------------------------------------------------------------- state
let player = null, missions = [], engine = null, raceInfo = null, frame = null, raceActive = false, raceMode = null, lastNow = 0, clock = 0, reinHeld = false, lane = 1, timer;
let selectedId = read(KEYS.selected, null), firstScout = read(KEYS.scout, null), lastRace = read(KEYS.race, null);
const route = Number(location.hash.slice(1));
let current = Number.isInteger(route) && route >= 0 && route < 10 ? route : 0;

async function refresh() {
  player = await L.view();
  const m = await L.missions();
  missions = m.ok ? m.value : [];
}
const active = () => (player?.horses ?? []).filter((h) => h.status === 'active');
function partner() {
  const list = active();
  return list.find((h) => h.id === selectedId) ?? list.filter((h) => h.named)[0]
    ?? [...list].sort((a, b) => RARITY[b.rarity] - RARITY[a.rarity] || total(b) - total(a))[0] ?? null;
}
const horseName = () => partner()?.name ?? read(KEYS.horse, 'アカツキ');
// Codex's horse rows: [name, rarity, style, 'surface / distance', total]
const row = (h) => [h.name, h.rarity, STYLE[h.style] ?? h.style, `${SURFACE[h.surface] ?? h.surface} / ${distClass(h)}`, String(total(h))];
function stable() { // partner first, then rarity and rating (Codex's card 01 is the partner)
  const p = partner();
  return active().sort((a, b) => (b === p) - (a === p) || RARITY[b.rarity] - RARITY[a.rarity] || total(b) - total(a));
}
const loginClaimed = () => player?.loginBonus?.lastClaimDate === jstDate();
function rewardText(r) {
  if (!r) return '';
  const parts = [];
  if (r.freeCoins) parts.push(`無償コイン ×${fmt(r.freeCoins)}`);
  for (const it of r.items ?? []) parts.push(`${ITEM_NAME[it.itemId] ?? it.itemId} ×${it.qty}`);
  return parts.join(' · ');
}
const ITEM_NAME = { breeding_material: '配合素材', costume_login: 'ログイン限定衣装', ticket_sr_plus: 'SR以上確定券', ticket_single: 'スカウト券', awakening: '覚醒素材' };
const seasonLabel = (id) => { const m = /^(\d{4})-(\d{2})$/.exec(id ?? ''); return m ? `${m[2]} / ${['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE', 'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER'][Number(m[2]) - 1]}` : safe(id ?? ''); };
const classOf = () => {
  const cls = L.master.classes, id = player?.season?.classId ?? 'C';
  const i = Math.max(0, cls.findIndex((c) => c.id === id));
  return { cur: cls[i], next: cls[i + 1] ?? null };
};

// ---------------------------------------------------------------- Codex's building blocks
const horseArt = (cls = '') => `<div class="horse-art ${cls}"><div class="sun"></div><svg viewBox="0 0 640 440" aria-label="駆ける競走馬" role="img"><defs><linearGradient id="coat" x2="1" y2="1"><stop stop-color="#bb7955"/><stop offset="1" stop-color="#55362e"/></linearGradient></defs><path d="M68 362Q310 310 593 356" fill="none" stroke="#c5d1b4" stroke-width="2"/><path d="M153 208Q91 205 75 255Q100 242 157 243L215 279L274 282L337 250L403 235L449 176L485 163L499 132L476 110L465 76L451 106L430 87L431 129L400 161L355 174L284 164L216 173Z" fill="url(#coat)"/><path d="M187 239L211 280L171 329L113 347L108 358L183 350L247 281M270 257L285 292L239 345L243 356L269 343L318 291L311 247M346 232L392 282L459 309L471 305L432 277L399 222M390 207L449 228L491 270L505 270L472 217L419 181" fill="none" stroke="#694432" stroke-width="19" stroke-linejoin="round"/><path d="M156 211Q102 177 69 198Q93 208 106 236" fill="#2b2925"/><path d="M430 130L405 163L385 174" fill="none" stroke="#2b2925" stroke-width="14"/><path d="M265 170L330 177L321 224L263 216Z" fill="#e7dfc4"/><text x="284" y="206" fill="#17382c" font-size="28" font-family="serif">7</text><path d="M294 172L320 136L350 144L365 171" fill="none" stroke="#f2e9cf" stroke-width="16"/><path d="M313 142L303 116L327 99L348 124L367 145L410 151" fill="none" stroke="#315d47" stroke-width="19"/><circle cx="332" cy="88" r="15" fill="#d4ad86"/><path d="M316 85Q315 63 336 67L350 83Z" fill="#e4bb62"/><path d="M360 146L454 150" stroke="#d2bb84" fill="none" stroke-width="2"/><circle cx="475" cy="133" r="3" fill="#161e19"/></svg><span class="art-caption">THE NEXT CHAPTER IS YOURS.</span></div>`;
// Leaving a race screen (or switching to the other one) drops that race: coming back via Back / the hash starts a new one
// instead of showing a frozen track (render restarts whenever raceMode was cleared).
function go(n) { clearTimeout(timer); if (n !== current || (n !== 1 && n !== 7)) { raceActive = false; raceMode = null; } current = n; location.hash = n; render(); }
const button = (label, n, kind = 'primary') => `<button class="${kind}" data-go="${n}">${label}<span>↗</span></button>`;
const eyebrow = (t) => `<div class="eyebrow"><span></span>${t}</div>`;
const head = (en, ja, sub) => `<div class="page-head"><div>${eyebrow(en)}<h1>${ja}</h1><p>${sub}</p></div><span class="edition">MUCHI ISSEN<br>RACING CLUB / 01</span></div>`;
const meter = (label, value, max = 1000) => `<div class="stat-line"><span>${label}</span><div class="meter"><i style="width:${Math.round(100 * Math.min(value, max) / max)}%"></i></div><b>${value}</b></div>`;
const badge = (text) => `<span class="status-pill">${text}</span>`;
const bind = (root, selector, fn) => root.querySelectorAll(selector).forEach((el) => (el.onclick = () => fn(el)));
function shell(content) {
  const w = player?.wallet ?? { free: 0, paid: 0 };
  return `<aside class="rail"><a class="brand" href="#4">M<span>一閃</span></a><div class="rail-line"></div><span class="vertical">RIDE YOUR OWN STORY</span><span class="rail-bottom">EST. 2026</span></aside><div class="workspace"><header><div class="wordmark">ムチ一閃 <small>JOCKEY RACING CLUB</small></div><div class="wallet"><span>◈ <b>${fmt(w.free)}</b> <small>無償</small></span><span>◎ <b>${fmt(w.paid)}</b> <small>有償</small></span><button class="avatar" data-go="4" aria-label="ホーム">Y</button></div></header><main>${content}</main><footer><span>© MUCHI ISSEN　 /　 DEVELOPMENT PREVIEW</span><span>JAPAN · TURF · 2,000m <i>●</i></span></footer></div>`;
}
function nav() { return `<nav>${[['⌂', 'ホーム', 4], ['♞', '厩舎', 5], ['⚑', 'レース', 6], ['✧', 'スカウト', 3], ['◇', 'ショップ', 9]].map(([icon, label, id]) => `<button class="${current === id ? 'active' : ''}" data-go="${id}"><span>${icon}</span>${label}</button>`).join('')}</nav>`; }
function toast(t) { document.querySelector('.toast')?.remove(); const e = document.createElement('div'); e.className = 'toast'; e.setAttribute('role', 'status'); e.textContent = t; document.body.append(e); setTimeout(() => e.remove(), 3500); }
function dialog(title, body) {
  document.querySelectorAll('dialog').forEach((previous) => { previous.close(); previous.remove(); });
  const d = document.createElement('dialog'); d.className = 'detail-dialog'; d.setAttribute('aria-label', title);
  d.innerHTML = `<button class="close" aria-label="閉じる">×</button><div class="eyebrow"><span></span>MUCHI ISSEN / CLUB GUIDE</div><h2>${title}</h2>${body}`;
  document.body.append(d); d.querySelector('.close').onclick = () => d.close(); d.addEventListener('close', () => d.remove()); d.showModal(); return d;
}

// ---------------------------------------------------------------- screens (frontend/src/main.js)
function render() {
  const p = partner(), name = safe(horseName()), list = stable();
  let content = '';
  if (current === 0) content = `<section class="landing"><div class="intro">${eyebrow('YOUR STORY STARTS HERE')}<h1>あなたと、<br>まだ見ぬ<span>直線へ。</span></h1><p>一瞬の判断が、運命を変える。<br>相棒と駆ける、90秒の物語。</p><label class="consent"><input id="consent" type="checkbox" checked> 利用規約・プライバシーポリシーに同意する</label>${button('はじめてのレースへ', 1)}<small class="quiet">登録不要。まずは、走ってみよう。</small></div>${horseArt()}<div class="landing-note"><b>01 / THE BEGINNING</b><span>最後の直線、あなたの一手で。</span></div></section>`;
  if (current === 1 || current === 7) {
    const tut = current === 1, dist = raceInfo?.distanceM ?? (tut ? 400 : 2000), surf = raceInfo?.surface === 'dirt' ? 'ダート' : '芝';
    content = `<section class="race"><div class="race-top"><span>${tut ? 'FIRST RIDE / チュートリアル' : 'GREENFIELD CUP / ランク戦'}</span><b><span id="position">${frame?.rank ?? '—'}</span><small> / ${frame?.runners ?? raceInfo?.names?.length ?? 12} 位</small></b><span>${surf} ${fmt(dist)}m · 良</span></div><div class="track"><div class="track-lines"></div>${horseArt()}<div class="distance">LAST <b id="distance">${frame?.remainingM ?? dist}</b> m</div><div class="race-message">${tut ? '最後の直線。タイミングを合わせて、差し切ろう。' : '脚をためて、ここで仕掛ける。'}</div></div><div class="race-controls"><button class="secondary" id="rein">← 手綱を引く</button><div><span>STAMINA</span><div class="stamina"><i></i></div><small>折り合い GOOD</small></div><button class="primary whip" id="whip">仕掛ける <span>⚡ <b id="whips">${frame?.whips ?? 6}</b></span></button></div></section>`;
  }
  if (current === 2) content = `<section class="split">${horseArt()}<div class="form-panel">${eyebrow('MEET YOUR PARTNER')}<h1>その出会いに、<br>名前をつけよう。</h1><p>初めての勝利を、一緒につかんだ相棒。<br>これからの物語は、あなたたちのもの。</p><label class="field-label" for="horse-name">相棒の名前 <span>カタカナ2〜9文字</span></label><input class="name-input" id="horse-name" maxlength="9" value="${safe(read(KEYS.horse, 'アカツキ'))}" placeholder="名前を入力"><p class="input-help" id="name-help">ひらがなはカタカナに変換されます。</p><button class="primary" id="save-name">この名前で、一緒に走る <span>↗</span></button></div></section>`;
  if (current === 3) content = `${head('THE PADDOCK / SCOUT', '新しい出会いが、待っている。', '走り方も、個性も、十頭十色。次の相棒を見つけよう。')}<section class="scout-panel"><div>${eyebrow('WELCOME GIFT')}<h2>最初の10頭に、<br>無限の可能性。</h2><p>チュートリアル限定・初回10連無料<br>SR以上の馬が1頭以上登場します。</p><button class="primary" id="scout">無料で10連スカウト <span>✧</span></button><button class="text-button" id="rates">提供割合・スカウトについて ↗</button></div>${horseArt()}</section>${nav()}`;
  if (current === 4) content = `<div class="home-heading"><div>${eyebrow('A NEW DAY, A NEW RACE')}<h1>おかえり、ジョッキー。</h1></div><div class="season">SEASON 01 <b>クラス ${classOf().cur.id}</b><span>${classOf().next ? `次のクラスまで ${Math.max(0, classOf().cur.promotePoints - (player?.season?.points ?? 0))} pt` : '最上位クラス'}</span></div></div><section class="home-hero"><div><span class="tag">YOUR PARTNER · ${p?.rarity ?? '—'}</span><h2>${name}</h2><p>今日も、いい走りができそうだ。</p><div class="horse-meta"><span>${p ? STYLE[p.style] : '—'}</span><span>芝適性 ${p ? aptitude(p, 'turf') : '—'}</span><span>${p ? distClass(p) : '—'}</span></div>${button('レースへ向かう', 6)}</div>${horseArt()}<span class="hero-index">01 — PARTNER</span></section><div class="home-cards"><button data-go="5"><span>STABLE / ${String(list.length).padStart(2, '0')}</span><b>相棒たちに会いにいく</b><i>↗</i></button><button id="daily"><span>DAILY MISSIONS</span><b>今日の一歩、次の勝利へ</b><i>0 / 0</i></button><button data-go="3"><span>WELCOME SCOUT</span><b>まだ見ぬ才能と出会う</b><i>✧</i></button></div>${nav()}`;
  if (current === 5) content = `${head('YOUR STABLE', '一頭ずつ、ひとつの物語。', '相棒の個性を知ることが、勝利への近道。')}<div class="tabs"><button class="selected" id="stable-tab">所属馬 <b>${list.length}</b></button><button id="breed-tab">配合</button><span>${list.length} 頭 / 引退 ${(player?.horses ?? []).length - list.length} 頭</span></div><div class="horse-grid"></div>${nav()}`;
  if (current === 6) content = `${head('RACE ENTRY', 'さあ、ゲートの向こうへ。', '腕を試す一戦も、仲間との一戦も。あなたのペースで。')}<div class="entry-grid"><section class="rank-card"><span class="tag">RANKED RACE</span><h2>グリーンフィールド杯</h2><p>芝 2,000m / 左回り / 良</p><div class="course"><svg viewBox="0 0 400 140"><rect x="25" y="20" width="350" height="100" rx="50" fill="none" stroke="#bfa975" stroke-width="15"/><path d="M210 110h60" stroke="#fff" stroke-width="3"/><circle cx="270" cy="110" r="6" fill="#f8d581"/></svg></div><div class="race-spec"><span>最大12頭<small>空き枠はCPUが参加</small></span><span>能力上限あり<small>腕で勝てるランク戦</small></span></div>${button('このレースに出走', 7)}</section><section class="entry-side"><span class="eyebrow">SELECTED PARTNER</span><h2>${name}</h2>${horseArt()}${button('出走馬を変更する', 5, 'secondary')}<button class="friend" id="friend">フレンドルーム <span>＋</span></button></section></div>${nav()}`;
  if (current === 8) {
    const r = lastRace, place = r?.place ?? 0, ord = ['ST', 'ND', 'RD'][place - 1] ?? 'TH';
    content = `<section class="result"><div class="result-title">${eyebrow('GREENFIELD CUP / RACE RESULT')}<h1><em>${place || '—'}</em><span>${ord}<br>PLACE</span></h1><h2>${place === 1 ? 'その一瞬が、勝利になった。' : place && place <= 3 ? 'あと少しで、頂点に届く。' : '次の直線で、きっと届く。'}</h2><p>${name} とつかんだ、最高の直線。</p></div>${horseArt()}<div class="result-bottom"><div><small>TIME</small><b>${r?.time ?? '—'}</b></div><div><small>RANK POINT</small><b>＋${r?.seasonPoints ?? 0} <span>pt</span></b></div><div><small>REWARD</small><b>◈ ${fmt(r?.coins ?? 0)}</b></div>${button('ホームへ戻る', 4)}</div></section>`;
  }
  if (current === 9) {
    const pass = L.master.products.find((x) => x.kind === 'season_pass');
    content = `${head('CLUB STORE', '走る日々を、あなたらしく。', '勝負服も、新しい出会いも。楽しみ方を広げよう。')}<div class="store-banner"><div>${eyebrow('SEASON 01 / NOVEMBER')}<h2>次の季節も、相棒と。</h2><p>シーズンパス · 限定勝負服と毎日の報酬</p></div><button class="secondary purchase" data-product="${pass.id}">¥${fmt(pass.priceYen)} <span>↗</span></button></div><div class="shop-grid">${L.master.products.filter((x) => x.kind === 'coins').map((x) => `<button class="coin-card purchase" data-product="${x.id}"><span>COIN PACK</span><div>◈</div><h2>${fmt(x.paidCoins)} <small>有償コイン</small></h2><b>¥${fmt(x.priceYen)} ↗</b></button>`).join('')}</div><p class="quiet">有償残高 ${fmt(player.wallet.paid)} / 無償残高 ${fmt(player.wallet.free)}　・　購入前に年齢と月額上限を確認します。</p>${nav()}`;
  }
  const layout = read(KEYS.layout, 'auto');
  app.innerHTML = `<div class="design-toolbar"><span>MUCHI ISSEN <b>INTERACTIVE PROTOTYPE</b></span><select id="screen-select" aria-label="画面を選択">${screens.map((s, i) => `<option value="${i}" ${current === i ? 'selected' : ''}>${String(i + 1).padStart(2, '0')} / ${s}</option>`).join('')}</select><select id="layout-select" aria-label="レイアウト">${[['auto', '自動（縦長はモバイル）'], ['desktop', 'PC（横長）'], ['mobile', 'モバイル（縦長）']].map(([v, l]) => `<option value="${v}" ${layout === v ? 'selected' : ''}>${l}</option>`).join('')}</select><a href="unity.html">Unity版の画面 ↗</a></div><div class="app-frame">${shell(content)}</div><div class="prototype-note">REAL GAME LOGIC <span>サーバーと同じロジックと、本物のレースエンジン（WebAssembly）で動きます。決済・オンライン対戦は行いません。</span><button id="reset">最初から体験 ↗</button></div>`;
  app.querySelectorAll('[data-go]').forEach((b) => (b.onclick = () => { if (current === 0 && !document.querySelector('#consent').checked) return toast('利用規約への同意を確認してください'); go(Number(b.dataset.go)); }));
  document.querySelector('#screen-select').onchange = (e) => go(Number(e.target.value));
  document.querySelector('#layout-select').onchange = (e) => { write(KEYS.layout, e.target.value); applyLayout(); };
  document.querySelector('#reset').onclick = async () => { raceActive = false; L.reset(); for (const k of Object.values(KEYS)) if (k !== KEYS.layout) localStorage.removeItem(k); selectedId = null; firstScout = null; lastRace = null; await L.bootstrap(); await refresh(); go(0); };
  enhance();
  if ((current === 1 || current === 7) && raceMode !== (current === 1 ? 'tutorial' : 'practice')) startRace(current === 1 ? 'tutorial' : 'practice');
  else if (current === 1 || current === 7) paintRace();
}
function applyLayout() {
  const pref = read(KEYS.layout, 'auto');
  const mobile = pref === 'mobile' || (pref === 'auto' && innerHeight > innerWidth);
  document.documentElement.classList.toggle('layout-mobile', mobile);
}
window.addEventListener('resize', applyLayout);

// ---------------------------------------------------------------- details (frontend/src/details.js)
let filter = 'all', query = '', sort = 'rating';
const on = (id, fn) => { const e = document.getElementById(id); if (e) e.onclick = fn; };
const toKatakana = (s) => s.replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));
function enhance() {
  const content = app.querySelector('main'), p = partner(), list = stable();
  if (current === 0) {
    const consent = app.querySelector('#consent'), start = app.querySelector('[data-go="1"]'); consent.checked = false; start.disabled = true; consent.onchange = () => (start.disabled = !consent.checked);
    app.querySelector('.intro .quiet').insertAdjacentHTML('afterend', '<div class="intro-steps"><span><b>01</b> 走ってみる</span><span><b>02</b> 相棒に出会う</span><span><b>03</b> クラブへ</span></div>');
  }
  if (current === 2) {
    // the real naming rule (server/src/domain/horses.ts validateName): katakana 2–9, hiragana converted, NG list on submit
    const input = app.querySelector('#horse-name'), help = app.querySelector('#name-help'), btn = app.querySelector('#save-name'); input.setAttribute('aria-describedby', 'name-help');
    const validate = () => {
      const v = toKatakana(input.value.trim()), n = Array.from(v).length, invalid = !/^[ァ-ヴー]{2,9}$/.test(v) || v.startsWith('ー');
      help.textContent = invalid ? ERROR_TEXT.INVALID_NAME : `${n} / 9文字 · ひらがなはカタカナに変換されます。`;
      help.classList.toggle('field-error', invalid); input.setAttribute('aria-invalid', String(invalid)); btn.disabled = invalid;
    };
    input.oninput = validate; validate();
    btn.onclick = async () => {
      btn.disabled = true;
      const value = toKatakana(input.value.trim());
      const s = await ensureFirstScout(); // as GameBackend.NamePartnerAsync: the free first scout brings the partner
      if (!s.ok) { help.textContent = errorText(s); help.classList.add('field-error'); btn.disabled = false; return; }
      const target = partner();
      const r = await L.nameHorse(target.id, value);
      if (!r.ok) { help.textContent = errorText(r); help.classList.add('field-error'); input.setAttribute('aria-invalid', 'true'); btn.disabled = false; return; }
      write(KEYS.horse, r.value.name ?? value); selectedId = target.id; write(KEYS.selected, selectedId); await refresh(); go(3);
    };
  }
  if (current === 4) {
    app.querySelector('.home-hero>.horse-art').classList.add('variant-' + (list.indexOf(p) % 3 + 3) % 3);
    app.querySelector('.home-hero p').textContent = p ? '調子は良好。次の一戦に備えよう。' : 'まずは無料スカウトで相棒を迎えよう。';
    if (p) app.querySelector('.horse-meta').innerHTML = `<span>${STYLE[p.style]}</span><span>${SURFACE[p.surface]} / ${distClass(p)}</span><span>総合 ${total(p)}</span>`;
    const done = (loginClaimed() ? 1 : 0) + missions.filter((m) => m.claimed).length, all = 1 + missions.length;
    app.querySelector('#daily b').textContent = done === all ? '今日の報酬は受取済み' : '今日の報酬を確認する'; app.querySelector('#daily i').textContent = done + ' / ' + all;
    const day = ((player.loginBonus?.streakDay ?? 0) % L.master.loginBonus.length) + 1;
    const todayBonus = loginClaimed() ? L.master.loginBonus.find((d) => d.day === player.loginBonus.streakDay) : L.master.loginBonus.find((d) => d.day === day);
    const MISSION = { races: (m) => `レースに${m.target}回出走する`, wins: (m) => `レースで${m.target}回勝つ`, top3: (m) => `${m.target}回3着以内に入る` };
    const rows = missions.map((m) => `<div class="mission-row"><div><b>${(MISSION[m.kind] ?? (() => m.id))(m)}</b><small>${rewardText(m.reward)} · ${m.progress} / ${m.target}</small></div><button class="small-button" data-mission="${m.id}" ${m.claimed || m.progress < m.target ? 'disabled' : ''}>${m.claimed ? '受取済み' : m.progress >= m.target ? '受け取る' : '挑戦中'}</button></div>`).join('');
    const { cur, next } = classOf(), pts = player.season.points, goal = cur.promotePoints ?? pts;
    content.querySelector('nav').insertAdjacentHTML('beforebegin', `<section class="club-dashboard"><div class="panel"><div class="section-caption"><h2>今日のクラブノート</h2>${badge('デイリー')}</div><div class="mission-row"><div><b>ログインする <small style="display:inline">${loginClaimed() ? player.loginBonus.streakDay : day}日目</small></b><small>${rewardText(todayBonus)}</small></div><button class="small-button" id="claim-login" ${loginClaimed() ? 'disabled' : ''}>${loginClaimed() ? '受取済み' : '受け取る'}</button></div>${rows}</div><div class="panel season-panel"><div class="section-caption"><h2>シーズンの記録</h2><span>${seasonLabel(player.season.id)}</span></div><strong>クラス ${cur.id} <small>${next ? '→ クラス ' + next.id : '最上位'}</small></strong><div class="meter"><i style="width:${goal ? Math.min(100, Math.round(100 * pts / goal)) : 100}%"></i></div><p>${pts} / ${goal} pt <span>${next ? `あと${Math.max(0, goal - pts)} ptで昇級` : ''}</span></p><div class="season-summary"><span>出走 <b>${player.season.races}</b></span><span>勝利 <b>${player.stats?.wins ?? 0}</b></span><span>3着以内 <b>${player.stats?.top3 ?? 0}</b></span></div></div></section>`);
    on('claim-login', async () => {
      const r = await L.claimLogin(); if (!r.ok) return toast(errorText(r));
      await refresh(); render(); toast(`ログインボーナス ${r.value.day}日目：${rewardText(r.value.reward)} を受け取りました`);
    });
    bind(app, '[data-mission]', async (el) => {
      const r = await L.claimMission(el.dataset.mission); if (!r.ok) return toast(errorText(r));
      await refresh(); render(); toast(`${rewardText(r.value)} を受け取りました`);
    });
    app.querySelector('#daily').onclick = () => app.querySelector('.club-dashboard').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  if (current === 5) {
    const grid = app.querySelector('.horse-grid');
    grid.insertAdjacentHTML('beforebegin', `<div class="stable-tools"><label class="search-field"><span>⌕</span><input id="horse-search" type="search" placeholder="相棒の名前で検索" aria-label="相棒の名前で検索" value="${safe(query)}"></label><div class="filter-group" aria-label="レアリティで絞り込み">${[['all', 'すべて'], ['SSR', 'SSR'], ['SR', 'SR'], ['R', 'R']].map(([v, l]) => `<button data-filter="${v}" aria-pressed="${filter === v}">${l}</button>`).join('')}</div><label class="sort-field">並び順 <select id="horse-sort"><option value="rating">総合評価順</option><option value="name">名前順</option></select></label></div>`);
    const paint = () => {
      const shown = list.map((h, i) => ({ h, i })).filter(({ h }) => (filter === 'all' || h.rarity === filter) && h.name.includes(query))
        .sort((a, b) => (sort === 'name' ? a.h.name.localeCompare(b.h.name, 'ja') : total(b.h) - total(a.h)));
      grid.innerHTML = shown.map(({ h, i }) => { const r = row(h), mine = h === p; return `<article class="horse-card ${mine ? 'chosen' : ''}"><div class="card-top"><span>${r[1]}</span><small>${mine ? '● 出走馬に選択中' : 'PARTNER / ' + String(i + 1).padStart(2, '0')}</small></div>${horseArt('variant-' + (i % 3))}<h2>${safe(h.name)}</h2><p>${r[2]}<span>${r[3]}</span></p>${meter('スピード', h.base.speed)}${meter('スタミナ', h.base.stamina)}<div class="rating">TOTAL RATING <b>${r[4]}</b></div><div class="card-actions"><button class="small-button" data-detail="${h.id}">能力・スキル</button><button class="small-button filled" data-pick="${h.id}" ${mine ? 'disabled' : ''}>${mine ? '選択中' : '出走馬にする'}</button></div></article>`; }).join('')
        || `<div class="empty-state"><span>⌕</span><h2>${list.length ? '相棒が見つかりません' : 'まだ所属馬がいません'}</h2><p>${list.length ? '名前や絞り込み条件を変えてみてください。' : '無料スカウトで、最初の相棒を迎えましょう。'}</p><button class="small-button" id="clear-filter">${list.length ? '条件をクリア' : 'スカウトへ'}</button></div>`;
      bind(grid, '[data-pick]', (el) => selectHorse(el.dataset.pick)); bind(grid, '[data-detail]', (el) => horseDetail(el.dataset.detail));
      on('clear-filter', () => { if (!list.length) return go(3); query = ''; filter = 'all'; render(); });
    };
    app.querySelector('#horse-search').oninput = (e) => { query = e.target.value; paint(); };
    app.querySelector('#horse-sort').value = sort; app.querySelector('#horse-sort').onchange = (e) => { sort = e.target.value; paint(); };
    bind(app, '[data-filter]', (el) => { filter = el.dataset.filter; app.querySelectorAll('[data-filter]').forEach((b) => b.setAttribute('aria-pressed', String(b === el))); paint(); });
    paint();
    app.querySelector('#breed-tab').onclick = breeding;
  }
  if (current === 6) {
    const turf = p ? aptitude(p, 'turf') : '—', fits = p && p.distMinM <= 2000 && 2000 <= p.distMaxM;
    app.querySelector('.entry-side').insertAdjacentHTML('beforeend', `<div class="entry-check"><span>${turf === 'A' ? '✓' : '△'} 芝適性 ${turf}</span><span>${!p ? '△ 相棒がいません（標準の馬で出走）' : fits ? '✓ 出走条件を満たしています' : `△ 得意距離 ${fmt(p.distMinM)}〜${fmt(p.distMaxM)}m`}</span></div>`);
    app.querySelector('.rank-card').insertAdjacentHTML('beforeend', '<p class="entry-footnote">参加費なし · ランクポイント対象<br>レースは端末内の本物のエンジンで走り、報酬はサーバーと同じ表で精算します。</p>');
    app.querySelector('.rank-card [data-go="7"]').onclick = () => {
      const d = dialog('出走の準備ができました', `<div class="match-course">${badge('RANKED / 2,000m')}<h3>グリーンフィールド杯</h3><p>出走馬：${safe(horseName())} · ${p ? STYLE[p.style] : '標準'}</p></div><dl class="spec-list"><div><dt>馬場</dt><dd>芝 / 良</dd></div><div><dt>参加枠</dt><dd>12頭（CPU補完）</dd></div><div><dt>通信</dt><dd>オフライン（端末内エンジン）</dd></div></dl><p class="quiet" id="match-status" role="status">準備完了。レースを開始できます。</p><div class="dialog-actions"><button class="secondary" id="match-cancel">キャンセル</button><button class="primary" id="match-start">レース開始 <span>↗</span></button></div>`);
      d.querySelector('#match-cancel').onclick = () => d.close(); d.querySelector('#match-start').onclick = () => { d.close(); raceMode = null; go(7); };
    };
    app.querySelector('#friend').onclick = friendRoom;
  }
  if (current === 1 || current === 7) {
    app.querySelector('.track').insertAdjacentHTML('beforeend', `<div class="race-leaderboard"><span>LIVE POSITION</span></div><div class="lane-indicator">LANE <b id="lane-number">${lane}</b> / ${raceInfo?.laneCount ?? 4}</div>`);
    app.querySelector('.race-controls').insertAdjacentHTML('beforebegin', '<div class="race-telemetry"><div><span>残り脚</span><b id="stamina-value">100%</b></div><div><span>折り合い</span><b id="temper-value">良好</b></div><div><span>ムチの使いどころ</span><b>直線で脚を使う</b></div><div class="lane-buttons"><button id="lane-in" aria-label="内側へ移動">← 内へ</button><button id="lane-out" aria-label="外側へ移動">外へ →</button></div></div>');
    on('lane-in', () => steer(-1)); on('lane-out', () => steer(1));
    const rein = app.querySelector('#rein'), hold = (v) => (e) => { e.preventDefault?.(); reinHeld = v; };
    rein.addEventListener('pointerdown', hold(true)); rein.addEventListener('pointerup', hold(false)); rein.addEventListener('pointerleave', hold(false)); rein.addEventListener('pointercancel', hold(false));
    on('whip', spur);
  }
  if (current === 8) {
    const r = lastRace;
    if (!r) { content.insertAdjacentHTML('beforeend', '<section class="result-details"><div class="panel"><p class="quiet">まだレース結果がありません。出走登録からレースに出走してください。</p></div></section>'); return; }
    const rows = r.standings.map((s) => `<tr class="${s.you ? 'you-row' : ''}"><td>${s.place}</td><td>${safe(s.name)} ${s.you ? '<small>YOU</small>' : ''}</td><td>${s.time}</td><td>${s.margin}</td></tr>`).join('');
    content.insertAdjacentHTML('beforeend', `<section class="result-details"><div class="panel"><div class="section-caption"><h2>着順・タイム</h2>${badge('グリーンフィールド杯')}</div><table class="standings"><thead><tr><th>着順</th><th>馬名</th><th>タイム</th><th>着差</th></tr></thead><tbody>${rows}</tbody></table><p class="quiet">レースエンジンの確定結果（上位4頭${r.place > 4 ? '・あなた' : ''}）。</p></div><div class="panel"><div class="section-caption"><h2>今回の報酬</h2>${badge(r.place + (['ST', 'ND', 'RD'][r.place - 1] ?? 'TH') + ' PLACE')}</div><dl class="spec-list"><div><dt>着順報酬</dt><dd>無償コイン ${fmt(r.coins)}</dd></div><div><dt>シーズンポイント</dt><dd>＋${r.seasonPoints} pt</dd></div><div><dt>デイリーミッション</dt><dd>出走${r.place === 1 ? '・勝利' : ''}${r.place <= 3 ? '・3着以内' : ''}を記録</dd></div></dl><button class="primary" id="claim-race" ${r.claimed || !r.claimError ? 'disabled' : ''}>${r.claimed ? '報酬受取済み' : r.claimError ? '報酬の反映を再試行' : '報酬を反映しています…'}<span>✓</span></button><button class="text-button" id="race-again">もう一度出走する ↗</button></div></section>`);
    // rewards are applied when the race settles (as the server does); the button only shows the state, or retries a failure
    on('claim-race', () => claimRace(r));
    on('race-again', () => go(6));
  }
  if (current === 3) {
    const btn = app.querySelector('#scout'), revealed = player.flags?.tutorialGachaUsed && !(firstScout && !firstScout.revealed);
    if (revealed) { btn.disabled = true; btn.textContent = '初回無料スカウト受取済み'; }
    btn.onclick = async () => {
      if (revealed) return;
      btn.disabled = true;
      const s = await ensureFirstScout(); if (!s.ok) { btn.disabled = false; return toast(errorText(s)); }
      firstScout.revealed = true; write(KEYS.scout, firstScout); await refresh();
      const name = (id) => L.master.templates.find((t) => t.id === id)?.name ?? id;
      const d = dialog('新しい仲間を、迎えよう。', `<p>初回無料10連スカウト ${badge('SR以上確定枠 ×1')}</p><div class="scout-results">${firstScout.results.map((x) => `<div class="pull-card ${RARITY[x.rarity] >= 2 ? 'rare' : ''}"><small>${x.rarity}</small><span>♞</span><b>${safe(name(x.templateId))}</b><em>${x.duplicate ? '素材 +' + x.material : 'NEW'}</em></div>`).join('')}</div><p class="quiet">サーバーと同じ提供割合の表で抽選しました。所属馬に追加済みです。</p><button class="primary" id="finish-scout">ホームへ <span>↗</span></button>`);
      d.querySelector('#finish-scout').onclick = () => { d.close(); go(4); }; d.addEventListener('close', () => { if (current === 3) render(); });
    };
    app.querySelector('#rates').onclick = () => {
      const o = L.odds('standard'), tot = Object.entries(o.rarityTotals).map(([k, v]) => `${k} ${v.rate}`).join(' / ');
      dialog('スカウトの提供内容', `<dl class="spec-list"><div><dt>対象</dt><dd>チュートリアル初回限定</dd></div><div><dt>消費コイン</dt><dd>0</dd></div><div><dt>内容</dt><dd>10頭 / SR以上1頭確定</dd></div></dl><div class="notice"><b>提供割合（${safe(o.name)}）</b><p>${tot}<br>10枠目：${safe(o.guarantee.appliesTo)}。天井：${o.pity.pullsRequired}回で好きな対象馬と交換（最大 約¥${fmt(o.pity.estimatedMaxCostYen)}）。重複時は覚醒素材に交換されます。</p></div><details class="odds-table"><summary>個別の提供割合（${o.items.length}頭）</summary><table class="standings"><tbody>${o.items.map((x) => `<tr><td>${x.rarity}</td><td>${safe(x.name)}</td><td>${x.rate}</td></tr>`).join('')}</tbody></table></details>`);
    };
  }
  if (current === 9) {
    app.querySelector('.shop-grid').insertAdjacentHTML('beforebegin', '<div class="store-heading"><h2>コインパック</h2><span>すべて税込 / 一回購入</span></div>');
    app.querySelector('.shop-grid').insertAdjacentHTML('afterend', '<div class="notice store-notice"><b>購入前にご確認ください</b><p>コインの内訳・価格・年齢に応じた購入条件を、確認画面でご案内します。このプロトタイプでは決済されません（確認はサーバーと同じ規則で行います）。</p></div>');
    bind(app, '.purchase', (el) => purchase(L.master.products.find((x) => x.id === el.dataset.product)));
  }
}

// ---------------------------------------------------------------- flows wired to MuchiLogic
async function ensureFirstScout() {
  if (player.flags?.tutorialGachaUsed) return { ok: true };
  const r = await L.tutorialDraw();
  if (!r.ok) return r;
  firstScout = { results: r.value.results, revealed: false }; write(KEYS.scout, firstScout);
  await refresh();
  return { ok: true };
}
function selectHorse(id) { selectedId = id; write(KEYS.selected, id); render(); }
function horseDetail(id) {
  const h = active().find((x) => x.id === id); if (!h) return;
  const i = stable().indexOf(h), r = row(h), mine = h === partner(), [skill, note] = SKILL[h.style] ?? ['—', ''];
  const d = dialog(safe(h.name), `<div class="detail-summary">${horseArt('variant-' + (i % 3))}<div>${badge(r[1] + ' / ' + r[2])}<p>${r[3]} · 総合評価 ${r[4]}</p><div class="detail-tabs"><button data-tab="stats" aria-pressed="true">能力</button><button data-tab="skill" aria-pressed="false">スキル・適性</button></div><div id="detail-body"></div></div></div><button class="primary" id="detail-select" ${mine ? 'disabled' : ''}>${mine ? '出走馬に選択中' : 'この相棒で出走する'}<span>↗</span></button><button class="text-button" id="detail-retire">引退させて配合に使う ↗</button>`);
  const paint = (t) => {
    d.querySelector('#detail-body').innerHTML = t === 'stats'
      ? [['スピード', 'speed'], ['加速', 'burst'], ['スタミナ', 'stamina'], ['根性', 'guts'], ['折り合い', 'temper']].map(([l, k]) => meter(l, h.base[k])).join('') + (h.awakening ? `<p class="quiet">覚醒 ${h.awakening} 段階</p>` : '')
      : `<div class="skill-note"><b>✧ ${skill}</b><p>${note}</p></div><dl class="spec-list"><div><dt>芝適性</dt><dd>${aptitude(h, 'turf')}</dd></div><div><dt>ダート適性</dt><dd>${aptitude(h, 'dirt')}</dd></div><div><dt>得意距離</dt><dd>${fmt(h.distMinM)}〜${fmt(h.distMaxM)}m（${distClass(h)}）</dd></div><div><dt>脚質</dt><dd>${STYLE[h.style]}</dd></div><div><dt>性別</dt><dd>${h.sex === 'male' ? '牡' : '牝'}</dd></div><div><dt>血統</dt><dd>${safe(h.sireName ?? '—')} × ${safe(h.damName ?? '—')}</dd></div></dl>`;
  };
  paint('stats');
  bind(d, '[data-tab]', (el) => { d.querySelectorAll('[data-tab]').forEach((b) => b.setAttribute('aria-pressed', String(b === el))); paint(el.dataset.tab); });
  d.querySelector('#detail-select').onclick = () => { d.close(); selectHorse(id); };
  d.querySelector('#detail-retire').onclick = async () => {
    if (active().length <= 1) return toast('最後の1頭は引退させられません。');
    const res = await L.retire(id); if (!res.ok) return toast(errorText(res));
    if (selectedId === id) { selectedId = null; write(KEYS.selected, null); }
    d.close(); await refresh(); render(); toast(`${h.name} が引退しました。配合で血統を引き継げます。`);
  };
}
async function breeding() {
  const retired = (player.horses ?? []).filter((h) => h.status === 'retired');
  const sires = retired.filter((h) => h.sex === 'male'), dams = retired.filter((h) => h.sex === 'female');
  if (!sires.length || !dams.length) {
    dialog('次の世代へ、物語をつなぐ。', `<div class="locked-feature"><span>◇</span><h3>配合は、引退馬がそろうと開放</h3><p>引退した父馬と母馬から、適性や個性を引き継ぎます。</p></div><ol class="guide-list"><li>父馬と母馬を選ぶ</li><li>血統と相性を確認する</li><li>新しい相棒を迎える</li></ol><p class="quiet">いまの引退馬：牡 ${sires.length} 頭 / 牝 ${dams.length} 頭。厩舎の「能力・スキル」から引退させられます。</p>`);
    return;
  }
  const opt = (list) => list.map((h) => `<option value="${h.id}">${safe(h.name)}（${h.rarity}・${STYLE[h.style]}）</option>`).join('');
  const d = dialog('次の世代へ、物語をつなぐ。', `<label class="field-label" for="sire">父馬 <span>引退した牡馬</span></label><select class="name-input" id="sire">${opt(sires)}</select><label class="field-label" for="dam">母馬 <span>引退した牝馬</span></label><select class="name-input" id="dam">${opt(dams)}</select><div id="breed-preview"></div><button class="primary" id="breed-run">この組み合わせで配合する <span>↗</span></button>`);
  const preview = async () => {
    const r = await L.breedingPreview(d.querySelector('#sire').value, d.querySelector('#dam').value), box = d.querySelector('#breed-preview');
    if (!r.ok) { box.innerHTML = `<p class="field-error">${errorText(r)}</p>`; return; }
    const v = r.value, left = v.today.perDay - v.today.used;
    box.innerHTML = `<dl class="spec-list"><div><dt>ニックス</dt><dd>${v.nick ? '◎ 好相性' : '—'}</dd></div><div><dt>インブリード</dt><dd>${v.inbreedingCount} 回</dd></div><div><dt>得意距離</dt><dd>${fmt(v.distance.minM)}〜${fmt(v.distance.maxM)}m</dd></div><div><dt>今日の配合</dt><dd>残り ${Math.max(0, left)} 回${left <= 0 ? `（配合素材 ${v.today.materialCost} 個で追加 · 所持 ${v.today.materialOwned}）` : ''}</dd></div></dl>${[['スピード', 'speed'], ['スタミナ', 'stamina'], ['加速', 'burst']].map(([l, k]) => `<div class="stat-line"><span>${l}</span><div class="meter"><i style="width:${v.stats[k].max / 10}%"></i></div><b>${v.stats[k].min}〜${v.stats[k].max}</b></div>`).join('')}`;
    d.querySelector('#breed-run').dataset.material = left <= 0 ? '1' : '';
  };
  d.querySelector('#sire').onchange = preview; d.querySelector('#dam').onchange = preview; await preview();
  d.querySelector('#breed-run').onclick = async () => {
    const r = await L.breed(d.querySelector('#sire').value, d.querySelector('#dam').value, d.querySelector('#breed-run').dataset.material === '1');
    if (!r.ok) return toast(errorText(r));
    d.close(); await refresh(); render();
    const foal = r.value.foal ?? r.value;
    dialog('新しい相棒が生まれました', `<div class="confirmation-mark">✓</div><h3>${safe(foal.name ?? '仔馬')}</h3><p>${foal.rarity ?? ''} · ${STYLE[foal.style] ?? ''} · ${foal.distMinM ? `${fmt(foal.distMinM)}〜${fmt(foal.distMaxM)}m` : ''}</p><p class="quiet">厩舎に追加しました。</p>`);
  };
}
async function friendRoom() {
  const rooms = L.master.rooms, tracks = L.master.tracks, pre = await L.presets(), room = pre.ok ? pre.value.room : null;
  const sel = (id, items, value) => `<select class="name-input" id="${id}">${items.map(([v, l]) => `<option value="${v}" ${String(value) === String(v) ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
  const d = dialog('フレンドと、同じゲートへ。', `<label class="field-label" for="room-code">ルームコード <span>数字6桁</span></label><input class="name-input" id="room-code" inputmode="numeric" maxlength="6" placeholder="例：123456" aria-describedby="room-error"><p id="room-error" class="quiet" role="status">招待されたルームコードを入力してください。</p><details class="room-conditions"><summary>部屋の条件（ホスト）</summary><label class="field-label" for="room-track">コース</label>${sel('room-track', [['', 'おまかせ'], ...tracks.map((t) => [t.id, t.name])], room?.trackId ?? '')}<label class="field-label" for="room-going">馬場</label>${sel('room-going', [['', 'その日の馬場'], ['firm', '芝 良（硬め）'], ['good', '良'], ['yielding', '芝 稍重'], ['soft', '芝 重'], ['fast', 'ダート 良'], ['muddy', 'ダート 稍重'], ['sloppy', 'ダート 重']], room?.going ?? '')}<label class="field-label" for="room-night">ナイター</label>${sel('room-night', [['', '自動'], ['true', 'ナイター'], ['false', 'デイ']], room?.night ?? '')}<label class="field-label" for="room-weather">天気・気温・風 <span>演出のみ</span></label><div class="room-row">${sel('room-weather', rooms.weather.map((w) => [w, WEATHER[w] ?? w]), room?.weather ?? rooms.weather[0])}${sel('room-temp', rooms.temperaturesC.map((t) => [t, t + '℃']), room?.temperatureC ?? rooms.temperaturesC[1])}${sel('room-wind', rooms.windsKmh.map((w) => [w, w + 'km/h']), room?.windKmh ?? rooms.windsKmh[0])}</div><button class="small-button" id="save-room">条件を保存する</button></details><button class="primary" id="join-room" disabled>ルームを確認する <span>↗</span></button>`);
  const input = d.querySelector('#room-code'), btn = d.querySelector('#join-room'), status = d.querySelector('#room-error');
  input.oninput = () => (btn.disabled = !/^\d{6}$/.test(input.value));
  btn.onclick = () => { status.textContent = `ルーム ${input.value}：オンライン対戦はこのプロトタイプでは接続しません（コードは送信していません）。`; };
  d.querySelector('#save-room').onclick = async () => {
    const v = (id) => d.querySelector('#' + id).value;
    const r = await L.setRoomConditions({ trackId: v('room-track') || null, going: v('room-going') || null, night: v('room-night') === '' ? null : v('room-night') === 'true', weather: v('room-weather'), temperatureC: Number(v('room-temp')), windKmh: Number(v('room-wind')) });
    status.textContent = r.ok ? `部屋の条件を保存しました：${tracks.find((t) => t.id === r.value.room.trackId)?.name ?? 'コースおまかせ'} · ${GOING[r.value.room.going] ?? 'その日の馬場'} · ${WEATHER[r.value.room.weather]}` : `保存できません：${errorText(r)}`;
    status.classList.toggle('field-error', !r.ok);
  };
}
function purchase(prod) {
  const month = jstDate().slice(0, 7), label = prod.kind === 'season_pass' ? 'シーズンパス' : `有償コイン ${fmt(prod.paidCoins)}`;
  const d = dialog('購入内容の確認', `<dl class="spec-list"><div><dt>商品</dt><dd>${label}</dd></div><div><dt>お支払い金額</dt><dd>¥${fmt(prod.priceYen)}（税込）</dd></div><div><dt>現在の無償残高</dt><dd>${fmt(player.wallet.free)}</dd></div></dl><label class="field-label" for="birth-detail">生年月 <span>年齢確認</span></label><input class="name-input" id="birth-detail" type="month" max="${month}" aria-describedby="purchase-help"><p id="purchase-help" class="quiet" role="status">生年月を入力して内容を確認してください。年齢区分と月額上限はサーバーと同じ規則で確認します。</p><label class="purchase-consent" id="guardian-row" hidden><input id="guardian" type="checkbox"> 保護者の同意を得ています</label><label class="purchase-consent"><input id="purchase-consent" type="checkbox"> 商品・価格と、決済されないことを確認しました</label><button class="primary" id="purchase-review" disabled>確認を完了する <span>✓</span></button>`);
  const birth = d.querySelector('#birth-detail'), check = d.querySelector('#purchase-consent'), btn = d.querySelector('#purchase-review'), help = d.querySelector('#purchase-help');
  const ageOf = () => { const [y, m] = birth.value.split('-').map(Number), [ny, nm] = month.split('-').map(Number); return ny - y - (nm < m ? 1 : 0); };
  const valid = () => { btn.disabled = !(birth.value && birth.checkValidity() && check.checked); d.querySelector('#guardian-row').hidden = !(birth.value && ageOf() < 18); };
  birth.oninput = valid; check.onchange = valid;
  btn.onclick = async () => {
    const [y, m] = birth.value.split('-').map(Number);
    const a = await L.setAge(y, m, d.querySelector('#guardian').checked);
    if (!a.ok) { help.textContent = errorText(a); help.classList.add('field-error'); return; }
    const r = await L.purchaseIntent(prod.id);
    if (!r.ok) { help.textContent = errorText(r); help.classList.add('field-error'); return; }
    const lim = r.value.monthlyLimitYen;
    dialog('購入内容を確認しました', `<div class="confirmation-mark">✓</div><h3>ここから決済に進みます。</h3><p>年齢 ${a.value.age} 歳 · ${lim === null ? '月額上限なし' : `今月の上限 ¥${fmt(lim)}（残り ¥${fmt(r.value.remainingYen)}）`}</p><p class="quiet">プロトタイプのため決済とコインの追加は行いません。</p>`);
  };
}

// ---------------------------------------------------------------- race (MuchiRace WebAssembly engine)
function startRace(mode) {
  raceMode = mode;
  const p = partner();
  const partnerJson = p && mode !== 'tutorial' ? JSON.stringify({ speed: p.base.speed, stamina: p.base.stamina, burst: p.base.burst, guts: p.base.guts, temper: p.base.temper, style: p.style, distMinM: p.distMinM, distMaxM: p.distMaxM }) : '';
  raceInfo = JSON.parse(engine.Start(mode, horseName(), partnerJson, Date.now() % 2147483647));
  frame = null; clock = 1; lastNow = performance.now(); reinHeld = false; lane = 1; whipsUsed = 0; raceActive = true;
  render();
}
let whipsUsed = 0;
function steer(dir) { if (!raceActive) return; engine.Lane(dir); lane = Math.min(raceInfo.laneCount, Math.max(1, lane + dir)); paintRace(); }
function spur() {
  if (!raceActive || !frame) return;
  if (frame.departed && frame.whips <= 0) return;
  if (frame.departed) whipsUsed++;
  engine.Spur();
  const art = app.querySelector('.race .horse-art'); art?.classList.remove('surge'); requestAnimationFrame(() => art?.classList.add('surge'));
}
const temperText = (f) => (!f.gateOpen ? 'ゲート内' : !f.departed ? 'スタート！' : f.kakari ? '掛かり気味' : f.reining ? '脚を温存' : f.spurt ? 'スパート' : '良好');
const messageFor = (f) => f.subtitle || (!f.gateOpen ? `ゲートイン… ${Math.floor(f.gateTicks / 20) + 1}` : !f.departed ? 'ゲートが開いた！ 仕掛けてスタート。' : f.kakari ? '掛かっている。手綱を引いて、折り合いを。' : f.spurt ? '今だ、相棒を信じて。最後まで伸ばそう！' : '脚をためて、ここで仕掛ける。');
function paintRace() {
  const f = frame; if (!f || !raceInfo) return;
  const $ = (s) => app.querySelector(s);
  if (!$('#position')) return;
  $('#position').textContent = f.rank; $('#distance').textContent = f.remainingM; $('#whips').textContent = f.whips;
  $('.stamina i').style.width = f.stamina / 10 + '%'; $('#stamina-value').textContent = Math.round(f.stamina / 10) + '%';
  $('#temper-value').textContent = temperText(f); $('.race-controls small').textContent = '折り合い ' + (f.kakari ? 'KAKARI' : f.reining ? 'REIN' : 'GOOD');
  $('.race-message').textContent = messageFor(f);
  $('#whip').firstChild.textContent = f.departed ? '仕掛ける ' : 'スタート ';
  $('#lane-number').textContent = lane; $('#lane-in').disabled = lane <= 1; $('#lane-out').disabled = lane >= raceInfo.laneCount;
  const art = $('.track .horse-art'); if (art) art.style.marginLeft = `${(lane - 2) * 2}%`;
  // live order from the engine's ranks (0-based in the pose array): top 3 plus you
  const ranked = f.horses.map((h, slot) => ({ slot, rank: h[3] + 1 })).sort((a, b) => a.rank - b.rank);
  const shown = ranked.slice(0, 3); if (!shown.some((x) => x.slot === 0)) shown.push(ranked.find((x) => x.slot === 0));
  $('.race-leaderboard').innerHTML = '<span>LIVE POSITION</span>' + shown.map((x) => `<b class="${x.slot === 0 ? 'is-you' : ''}">${x.rank}　${safe(raceInfo.names[x.slot])} ${x.slot === 0 ? '<small>YOU</small>' : ''}</b>`).join('');
}
function raceLoop(now) {
  requestAnimationFrame(raceLoop);
  if (!raceActive || !engine) return;
  clock += Math.max(0, Math.min(250, now - lastNow)) * SPEED; lastNow = Math.max(lastNow, now);
  engine.Rein(reinHeld || keyRein);
  frame = JSON.parse(engine.Frame(clock));
  paintRace();
  if (frame.done) {
    raceActive = false; // raceMode stays until the screen is left (go), so a render meanwhile does not restart the race
    const f = frame, tut = raceMode === 'tutorial';
    if (!tut) lastRace = settle(f);
    timer = setTimeout(() => go(tut ? 2 : 8), 900);
  }
}
function settle(f) {
  const place = f.finishPlace > 0 ? f.finishPlace : f.rank, hz = f.tickHz || 20;
  const youTick = f.finishTicks?.[place - 1] ?? -1;
  const timeOf = (i) => { const t = f.finishTicks?.[i]; if (t == null || t < 0 || youTick < 0) return i === place - 1 ? f.time : '—'; return fmtTime(f.elapsedMs + (t - youTick) * 1000 / hz); };
  const marginOf = (i) => (i === 0 ? '—' : lengths(f.margins?.[i] ?? 0));
  const idx = [0, 1, 2, 3]; if (place > 4) idx.push(place - 1);
  const standings = idx.filter((i) => i < f.order.length).map((i) => ({ place: i + 1, name: raceInfo.names[f.order[i]], you: f.order[i] === 0, time: timeOf(i), margin: marginOf(i) }));
  const p = partner();
  const r = {
    raceId: 'web:' + f.hash + ':' + Date.now(), place, fieldSize: f.order.length, time: f.time, standings, claimed: false,
    coins: L.master.raceFreeCoinsByPlace.ranked?.[place - 1] ?? 0, seasonPoints: L.master.seasonPointsByPlace[place - 1] ?? 0,
    details: { trackId: 'kirameki_turf_2000', style: p?.style ?? 'sashi', finishTick: youTick >= 0 ? youTick : null, whips: whipsUsed },
  };
  write(KEYS.race, r);
  claimRace(r); // apply the rewards now: a later race must not replace an unclaimed one
  return r;
}
// L.applyRace is idempotent by raceId, so a retry (or a stored race from before this change) never pays twice.
async function claimRace(r) {
  if (!r || r.claimed || r.claiming) return;
  r.claiming = true;
  const res = await L.applyRace(r.raceId, r.place, r.fieldSize, r.details);
  r.claiming = false;
  if (!res.ok) { r.claimError = errorText(res); write(KEYS.race, r); if (current === 8 && lastRace === r) render(); return toast(r.claimError); }
  r.claimed = true; r.claimError = null; if (!res.value.duplicate) { r.coins = res.value.coins; r.seasonPoints = res.value.seasonPoints; }
  write(KEYS.race, r); await refresh();
  if (current === 8 && lastRace === r) { render(); toast(`着順報酬 ${fmt(r.coins)} コインとシーズンポイントを受け取りました`); }
}
function fmtTime(ms) { const t = Math.max(0, Math.round(ms / 100)); return `${Math.floor(t / 600)}:${String(Math.floor(t / 10) % 60).padStart(2, '0')}.${t % 10}`; }
function lengths(m) { // 1 馬身 ≈ 2.4 m, Japanese margin notation
  const l = m / 2.4;
  if (l < 0.1) return 'ハナ'; if (l < 0.25) return 'アタマ'; if (l < 0.4) return 'クビ'; if (l < 0.75) return '½馬身'; if (l > 10) return '大差';
  const whole = Math.floor(l), half = l - whole >= 0.5 ? '½' : '';
  return `${whole}${half}馬身`;
}
let keyRein = false;
document.addEventListener('keydown', (e) => {
  if (!raceActive || e.repeat) return;
  if (e.key === 'ArrowLeft') steer(-1); else if (e.key === 'ArrowRight') steer(1); else if (e.key === 'e' || e.key === 'E') spur();
  else if (e.code === 'Space') { keyRein = true; e.preventDefault(); }
});
document.addEventListener('keyup', (e) => { if (e.code === 'Space') keyRein = false; });
window.addEventListener('blur', () => { reinHeld = false; keyRein = false; });
window.addEventListener('hashchange', () => { const n = Number(location.hash.slice(1)); if (n !== current && n >= 0 && n < screens.length) go(n); });

// ---------------------------------------------------------------- boot
async function boot() {
  applyLayout();
  app.innerHTML = '<div class="boot-note">読み込み中…（ロジックとレースエンジンを準備しています）</div>';
  await L.bootstrap(); await refresh();
  const [ruleset, commentary] = await Promise.all([fetch('data/ruleset.json').then((r) => r.text()), fetch('data/commentary-ja.json').then((r) => r.text())]);
  const { dotnet } = await import('../engine/_framework/dotnet.js');
  const runtime = await dotnet.create();
  engine = (await runtime.getAssemblyExports(runtime.getConfig().mainAssemblyName)).MuchiRace;
  engine.Init(ruleset, commentary);
  if (firstScout && !player.flags?.tutorialGachaUsed) firstScout = null;
  if (lastRace && !lastRace.claimed) await claimRace(lastRace); // a race stored unclaimed by an older build
  render();
  requestAnimationFrame(raceLoop);
  globalThis.__club = { ready: true, go, state: () => ({ current, frame, raceActive, raceInfo, lastRace, player, lane }) };
}
boot().catch((e) => { app.textContent = 'ERROR: ' + (e?.message ?? e); console.error(e); });
