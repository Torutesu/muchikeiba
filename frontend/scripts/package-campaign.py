"""Create the campaign review and portable handoff archive after UI exports."""
from pathlib import Path
import json, zipfile, html, hashlib
import xml.etree.ElementTree as ET
from PIL import Image
front=Path(__file__).resolve().parents[1]
out=front/'design/campaign'
labels={'store':'ストア全体','starter':'スターター商品詳細','welcome':'無料ギフト','event':'イベント','pass':'30日パス','wardrobe':'勝負服と3D配色','inventory':'所持品','pass-progress':'パス進行と受取'}
cards=[]
for width in [1440,844,390]:
 for slug,title in labels.items():
  p=out/'review'/f'{slug}-{width}.png';im=Image.open(p);assert im.width>0 and im.height>0
  cards.append(f'<article data-size="{width}"><a href="review/{p.name}" target="_blank"><img src="review/{p.name}" alt="{html.escape(title)} {width}px" loading="lazy"></a><div><h3>{title}</h3><p>{width}px表示 / {im.width} × {im.height}</p><a href="review/{p.name}" target="_blank">細部を見る ↗</a></div></article>')
css='''@font-face{font-family:Club;src:url('../fonts/club-sans.otf')}*{box-sizing:border-box}body{margin:0;color:#213a32;background:#f7f6f0;font-family:Club,sans-serif}header{padding:64px max(24px,6vw);background:#142f27;color:#f7f6f0}header small{color:#d6bd81;font-size:10px;letter-spacing:3px}h1{font-size:clamp(26px,4vw,46px);font-weight:400;line-height:1.6}header p{font-size:13px;line-height:2;color:#d0d9c6}header a{color:#e2c88e;display:inline-block;margin:16px 24px 0 0;font-size:12px}main{max-width:1480px;padding:36px 24px;margin:auto}nav{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:24px}button{border:1px solid #cfd7c2;background:transparent;padding:12px 18px;border-radius:4px;color:#213a32;cursor:pointer}button[aria-pressed=true]{background:#213a32;color:#fffefa}a{color:#496b4d;text-underline-offset:5px}button:focus-visible,a:focus-visible{outline:3px solid #b39459;outline-offset:4px}.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:24px}article{background:#fffefa;border:1px solid #dedfd3;border-radius:6px;overflow:hidden}article[hidden]{display:none}article img{width:100%;height:360px;object-fit:contain;object-position:top;background:#eeefe5}article div{padding:20px}article h3{font-weight:400;margin:0 0 10px}article p,article a{font-size:11px}section{margin-top:48px}section h2{font-weight:400;font-size:25px}section p{font-size:12px;line-height:2}.iterations{display:grid;grid-template-columns:1fr 1fr;gap:24px}.iterations img{height:450px;object-fit:cover;object-position:top}footer{padding:24px;font-size:10px;text-align:center;color:#68745d}@media(max-width:850px){.grid{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:550px){.grid,.iterations{grid-template-columns:1fr}header{padding:40px 24px}article img{height:340px}}'''
page='<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>相棒から始まるクラブ体験 / デザインレビュー</title><style>'+css+'</style><header><small>MUCHI ISSEN / FIRST PARTNER EXPERIENCE</small><h1>名前を贈る。勝利を分かち合う。<br>次の一着が、欲しくなる。</h1><p>オンボーディング・無料ギフト・イベント・スターター・30日パス。<br>3案を比較し、構成・ビジュアル・小画面の3段階で改善した実装です。</p><a href="STRATEGY.md">提案と改善記録 ↗</a><a href="../review.html">全48画面を見る ↗</a></header><main><nav aria-label="表示サイズ"><button data-filter="all" aria-pressed="true">すべて</button><button data-filter="1440" aria-pressed="false">デスクトップ</button><button data-filter="844" aria-pressed="false">タブレット</button><button data-filter="390" aria-pressed="false">モバイル</button></nav><div class="grid">'+''.join(cards)+'</div><section><h2>最初の構成から、欲しくなる見せ方へ。</h2><p>初稿は内容を説明するアイコン構成。商品写真のような新しいアートで素材感と世界観を足し、価格・確定内容はライブテキストで残しました。</p><div class="iterations"><article><a href="iterations/store-01.png" target="_blank"><img src="iterations/store-01.png" alt="第1回 ストア構成"></a><div><h3>01 / 構成</h3></div></article><article><a href="review/store-1440.png" target="_blank"><img src="review/store-1440.png" alt="第3回 素材感とモバイルの調整後"></a><div><h3>03 / ビジュアルと細部</h3></div></article></div></section></main><footer>商品・報酬はマスターの暫定値。実決済・抽選・オンラインイベントは未接続。所持・装備・イベント・パス進行はブラウザ内のデモです。画面テストによる改善で、課金率の向上を実証したものではありません。</footer><script>document.querySelectorAll("[data-filter]").forEach(b=>b.onclick=()=>{document.querySelectorAll("[data-filter]").forEach(x=>x.setAttribute("aria-pressed",String(x===b)));document.querySelectorAll("[data-size]").forEach(x=>x.hidden=b.dataset.filter!=="all"&&b.dataset.filter!==x.dataset.size)});</script></html>'
(out/'index.html').write_text(page)
for p in (front/'public/campaign/art').glob('*.svg'):ET.parse(p)
pro=json.loads((out/'provenance.json').read_text());master=out/pro['master'];assert hashlib.sha256(master.read_bytes()).hexdigest()==pro['sha256']
archive=out/'muchi-campaign-kit.zip'
with zipfile.ZipFile(archive,'w',zipfile.ZIP_DEFLATED) as z:
 for p in out.rglob('*'):
  if p.is_file() and p.suffix!='.zip': z.write(p,Path('muchi-campaign/design/campaign')/p.relative_to(out))
 for p in (front/'design/fonts').glob('*'):z.write(p,Path('muchi-campaign/design/fonts')/p.name)
 for p in (front/'public/campaign').rglob('*'):
  if p.is_file():z.write(p,Path('muchi-campaign/public/campaign')/p.relative_to(front/'public/campaign'))
 # Full review referenced by the campaign gallery, plus reusable Figma sources.
 for p in [front/'design/review.html',front/'design/screens/manifest.json',*list((front/'design/screens').glob('*.svg')),*list((front/'design/screens').glob('*.png'))]:z.write(p,Path('muchi-campaign/design')/p.relative_to(front/'design'))
 for name in ['commerce.js','journey.js','journey.css','club-state.js','club-ui.js','club.css']:z.write(front/'src'/name,Path('muchi-campaign/SOURCE')/name)
 for name in ['build-campaign-art.py','package-campaign.py','verify-journey.cjs','verify-club.cjs']:z.write(front/'scripts'/name,Path('muchi-campaign/SOURCE')/name)
 z.writestr('muchi-campaign/README.txt','design/campaign/index.html を開いてレビューできます。Figma用の個別SVGは design/screens/。SOURCEはリポジトリで使う制作元で、単体アプリではありません。実装と範囲は design/campaign/STRATEGY.md を参照。')
with zipfile.ZipFile(archive) as z:assert z.testzip() is None
print('Packaged campaign artwork, 24 reviews, iteration records, 48-screen handoff:',archive)
