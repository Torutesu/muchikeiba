const $ = (s) => document.querySelector(s);
const SCREEN_NAMES = { '01-title': 'タイトル', '02-first-ride': '初レース', '03-partner-naming': '相棒の命名', '04-scout': 'スカウト', '05-scout-results': 'スカウト結果', '06-home': 'ホーム', '07-stable': '厩舎', '08-race-entry': 'レースエントリー', '09-ranked-race': 'ランク戦（レース中）', '10-race-result': 'レース結果', '11-wardrobe': '着せ替え・3Dモデル', '12-course-looks': 'コースの見た目', '13-conditions': 'コンディション', '14-care-feed': '飼葉・ケア', '15-store-coins': 'ショップ（コイン）', '16-store-cosmetics': 'ショップ（見た目）', '17-season-pass': 'シーズンパス', '18-purchase-review': '購入前の確認' };
const COAT = { Bay: '#8a4b25', Chestnut: '#b5652d', DappleGrey: '#c9c9c9', Black: '#25272c', Palomino: '#e2c27a' };
const SILK = { Crimson: '#d33b45', Azure: '#2fa3e6', Violet: '#8d5bd6', Emerald: '#2fb27a', Gold: '#e8b93a' };
const base = (p) => p.split('/').pop().replace('.jpg', '');
const fig = (src, title, sub) => `<figure data-src="${src}" data-cap="${title}"><img loading="lazy" src="${src}" alt="${title}"><figcaption><b>${title}</b>${sub || ''}</figcaption></figure>`;

document.querySelectorAll('#tabs button').forEach((b) => b.onclick = () => {
  document.querySelectorAll('#tabs button').forEach((x) => x.classList.toggle('on', x === b));
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('on', t.id === b.dataset.tab));
});
document.addEventListener('click', (e) => {
  const f = e.target.closest('figure');
  const lb = $('#lightbox');
  if (f) { lb.querySelector('img').src = f.dataset.src; lb.querySelector('p').textContent = f.dataset.cap; lb.hidden = false; }
  else if (e.target.closest('#lightbox')) lb.hidden = true;
});

(async () => {
  const [files, partners, manifest, race] = await Promise.all(['data/files.json', 'data/partners.json', 'data/assets.manifest.json', 'data/race.json'].map((u) => fetch(u).then((r) => r.json())));
  $('#stamp').textContent = 'unity/ の内容を反映（自動生成）';
  $('#screen-grid').innerHTML = files.screens.map((s) => { const k = base(s); return fig(s, SCREEN_NAMES[k] || k, ` ${k}`); }).join('');
  $('#preview-grid').innerHTML = files.previews.map((s) => fig(s, base(s).replace('Partner_', '').replace('_', ' × '), ' 3Dプレビュー')).join('');
  $('#art-grid').innerHTML = files.art.map((s) => fig(s, base(s), ' ' + s.split('/').slice(2, -1).join('/'))).join('');
  const pv = partners.partnerVariants || [];
  $('#partner-table').innerHTML = '<tr><th>ID</th><th>馬</th><th>毛色</th><th>勝負服</th><th>モデル</th></tr>' + pv.map((p) =>
    `<tr><td>${p.id}</td><td>${p.horse}</td><td><span class="swatch" style="background:${COAT[p.coat] || '#888'}"></span>${p.coat}</td><td><span class="swatch" style="background:${SILK[p.silk] || '#888'}"></span>${p.silkName || p.silk}</td><td><code>${p.model}</code></td></tr>`).join('');

  const keys = manifest.keys || [];
  const byKind = {};
  for (const k of keys) { const kind = k.split('/')[0]; byKind[kind] = (byKind[kind] || 0) + 1; }
  $('#asset-summary').innerHTML = `<p class="note">アセットの取り決め（<code>contracts/assets.md</code>）で、ロジック側が参照する全アセットキー。Unity側はこのキーをCodexの3Dモデル・画像に対応づけ、無いものは <code>種類/default</code> に置き換える。</p>
    <div class="kpi"><div><b>${keys.length}</b>アセットキー</div><div><b>${pv.length}</b>3Dモデル（毛色×勝負服）</div><div><b>${files.screens.length}</b>画面</div><div><b>${files.art.length + files.previews.length}</b>アート素材</div></div>
    <h2>種類別のキー数</h2><table><tr><th>種類</th><th>キー数</th></tr>${Object.entries(byKind).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<tr><td><code>${k}</code></td><td>${v}</td></tr>`).join('')}</table>`;

  // ---- race replay: real engine output (tools/figma-gallery/race-frames), not an animation ----
  const cv = $('#track'), ctx = cv.getContext('2d');
  const pts = race.rail.concat(race.outer);
  const xs = pts.map((p) => p[0]), zs = pts.map((p) => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minZ = Math.min(...zs), maxZ = Math.max(...zs);
  const sc = Math.min((cv.width - 60) / (maxX - minX || 1), (cv.height - 60) / (maxZ - minZ || 1));
  const P = (x, z) => [30 + (x - minX) * sc, cv.height - 30 - (z - minZ) * sc];
  const n = race.names.length;
  const colors = race.names.map((_, i) => { const p = pv[i % pv.length]; return p ? [COAT[p.coat], SILK[p.silk]] : ['#ccc', '#fff']; });
  $('#race-note').innerHTML = `コース <code>${race.track}</code>（${race.distanceM}m）。サーバーと同じC#エンジン（Muchi.Engine）でゴールデンレースを再計算した位置・順位・実況です。結果ハッシュ：${race.hash === race.expectedHash ? '一致 ✔' : '不一致'}。馬の色はCodexの3Dモデル（毛色×勝負服）を枠順に割り当てたもの。`;
  let fi = 0, playing = false, last = 0;
  const lineAt = (tick) => { let cur = null; for (const l of race.lines) if (l[0] <= tick && tick < l[0] + l[1] + 40) cur = l; return cur ? cur[2] : ''; };
  function draw() {
    const f = race.frames[Math.min(fi, race.frames.length - 1)];
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.lineWidth = 2; ctx.strokeStyle = '#ffffffcc';
    for (const line of [race.rail, race.outer]) { ctx.beginPath(); line.forEach((p, i) => { const [x, y] = P(p[0], p[1]); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.stroke(); }
    const [fx, fy] = P(...race.rail[race.rail.length - 1]); ctx.fillStyle = '#f2c14e'; ctx.fillRect(fx - 3, fy - 10, 6, 20);
    const rows = [];
    for (let s = 0; s < n; s++) {
      const o = 1 + s * 5; const [x, y] = P(f[o], f[o + 1]);
      ctx.beginPath(); ctx.fillStyle = colors[s][0]; ctx.arc(x, y, 7, 0, Math.PI * 2); ctx.fill();
      ctx.lineWidth = 3; ctx.strokeStyle = colors[s][1]; ctx.stroke();
      ctx.fillStyle = '#fff'; ctx.font = 'bold 10px sans-serif'; ctx.fillText(String(s + 1), x - 3, y + 3);
      rows.push({ s, rank: f[o + 2], st: f[o + 3], whips: f[o + 4] });
    }
    rows.sort((a, b) => a.rank - b.rank);
    $('#standings').innerHTML = rows.map((r) => `<li><span class="swatch" style="background:${colors[r.s][1]}"></span>${r.s + 1}番 ${race.names[r.s]} <span class="bar" style="width:${r.st / 12}px"></span> ムチ${r.whips}</li>`).join('');
    const sec = Math.max(0, (f[0] - race.gateOpenTick) / race.tickHz);
    $('#clock').textContent = f[0] < race.gateOpenTick ? 'ゲートイン' : sec.toFixed(1) + ' 秒';
    $('#subtitle').textContent = lineAt(f[0]);
  }
  function loop(t) {
    if (playing) { const step = Number($('#speed').value); if (t - last > 100 / step * 1) { fi += 1; last = t; if (fi >= race.frames.length) { fi = race.frames.length - 1; playing = false; $('#play').textContent = '▶ 再生'; } draw(); } }
    requestAnimationFrame(loop);
  }
  $('#play').onclick = () => { playing = !playing; $('#play').textContent = playing ? '❚❚ 停止' : '▶ 再生'; };
  $('#restart').onclick = () => { fi = 0; draw(); };
  draw(); requestAnimationFrame(loop);
})();
