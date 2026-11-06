"""Build a reproducible SVG / motion / audio / material creative library.
Generated key-art masters are read from design/creative/masters, never modified.
"""
from pathlib import Path
import json, math, wave, struct, random, hashlib, base64, shutil, html
from PIL import Image
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen

FRONT=Path(__file__).resolve().parents[1];OUT=FRONT/'public/creative';DESIGN=FRONT/'design/creative'
for name in ['keyart','brand','icons','emblems','items','frames','states','patterns','currency','materials','motion','audio','templates','atlas']:(OUT/name).mkdir(parents=True,exist_ok=True)
INK='#213a32';FOREST='#142f27';IVORY='#f7f6f0';GOLD='#b39459';LIGHT='#e2c88e';LINE='#d8dfcb'
assets=[]
# Export web derivatives from the immutable image-generation masters.
for master in (DESIGN/'masters').glob('*.png'):
 im=Image.open(master)
 if master.stem=='victory-trophy':shutil.copyfile(master,OUT/'keyart'/(master.stem+'.png'))
 else:im.save(OUT/'keyart'/(master.stem+'.webp'),'WEBP',quality=91,method=6)
def add(id,title,category,file,width,height,usage,**extra):
 extra.setdefault('source','authored-svg' if file.endswith('.svg') else 'authored-css' if file.endswith('.css') else 'project-original')
 entry=dict(id=id,title=title,category=category,file=file,width=width,height=height,usage=usage,**extra);assets.append(entry);return entry
def svg(file,body,w,h,title):
 p=OUT/file;p.parent.mkdir(parents=True,exist_ok=True)
 p.write_text(f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}"><title>{html.escape(title)}</title>{body}</svg>')
def defs(id='foil',a=LIGHT,b=GOLD):return f'<defs><linearGradient id="{id}" x1="0" y1="0" x2="1" y2="1"><stop stop-color="{a}"/><stop offset=".42" stop-color="{b}"/><stop offset=".68" stop-color="{a}"/><stop offset="1" stop-color="{b}"/></linearGradient></defs>'
def path(d,color=INK,stroke=1.5,fill='none'):return f'<path d="{d}" fill="{fill}" stroke="{color}" stroke-width="{stroke}" stroke-linecap="round" stroke-linejoin="round"/>'
# 24px, 1.5px stroke, 2px optical padding. Localization remains outside the graphic.
P={
'home':'m3 10 9-7 9 7v10H15v-7H9v7H3Z',
'stable':'M4 21V8l8-5 8 5v13M8 21v-8h8v8M3 21h18M10 8h4',
'race':'M5 22V3m0 1c5-4 9 4 14 0v11c-5 4-9-4-14 0',
'scout':'m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z',
'shop':'M3 9h18l-2-6H5ZM4 9v12h16V9M9 21v-7h6v7M3 9a3 3 0 0 0 6 0 3 3 0 0 0 6 0 3 3 0 0 0 6 0',
'speed':'M4 17a9 9 0 1 1 16 0M12 14l5-7M6 10l1 1m10 0 1-1M12 5v2M8 19h8',
'stamina':'M8 3h8v3h3v15H5V6h3ZM8 3v3h8M8 11h8m-8 4h6',
'focus':'M3 8V3h5m8 0h5v5m0 8v5h-5M8 21H3v-5M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10Zm0 3v4m-2-2h4',
'acceleration':'m13 2-8 12h6l-1 8 9-13h-6Z',
'turf':'M3 21h18M6 20l-1-8m7 8V5m6 15 1-10M12 11 8 7m4 8 5-6M6 16l-3-2m15 1 3-3',
'dirt':'M3 20h18M5 15l3-3 4 3 4-6 4 6M5 6h.01M11 8h.01M17 4h.01M8 19h.01m8-1h.01',
'sun':'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM12 2v2m0 16v2M2 12h2m16 0h2M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2',
'cloud':'M6 18a4 4 0 1 1 1-8 6 6 0 0 1 11-1 4.5 4.5 0 0 1 0 9Z',
'rain':'M5 14a4 4 0 0 1 1-8 5 5 0 0 1 9-1 4.5 4.5 0 1 1 4 9M7 17l-2 4m8-4-2 4m8-4-2 4',
'night':'M20 15A9 9 0 0 1 9 4a9 9 0 1 0 11 11Zm-2-12v4m-2-2h4',
'groom':'m6 10 9-6 5 7-9 6ZM4 12l3 4m0-6 4 6M11 8l4 6m-2-8 4 6M5 18l-2 3',
'water':'M5 8h14l-2 13H7ZM8 8V6a4 4 0 0 1 8 0v2M8 13h8m-7 4h6',
'feed':'M4 13h16l-2 8H6ZM7 11V6l5-3 5 3v5M12 4v8M9 7l3 2 3-2',
'saddle':'M5 5c4 4 10 4 14 0v9c-4 4-10 4-14 0ZM5 12l-2 7h5v-4m11-3 2 7h-5v-4',
'helmet':'M4 14v-3a8 8 0 0 1 16 0v3ZM4 14h18v3h-5m-9 0 3 4h6v-7M12 4v9',
'silks':'m7 3-5 5 4 4 2-2v11h8V10l2 2 4-4-5-5-5 3ZM8 10l4 3 4-3',
'bloodline':'M12 3v6M5 15v-4h14v4M3 16h4v5H3Zm14 0h4v5h-4ZM10 3h4v4h-4Z',
'friend':'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM2 21v-3a7 7 0 0 1 14 0v3m1-18a4 4 0 0 1 0 8m2 4a6 6 0 0 1 3 6',
'mission':'M7 4H4v18h16V4h-3M8 2h8v5H8ZM7 14l3 3 7-7',
'gift':'M3 10h18v4H3Zm2 4v8h14v-8M12 10v12M12 10C4 10 4 3 8 3c3 0 4 7 4 7Zm0 0c8 0 8-7 4-7-3 0-4 7-4 7Z',
'coin':'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 5 3 4-3 4-3-4Z',
'lock':'M7 10V7a5 5 0 0 1 10 0v3M5 10h14v12H5Zm7 4v4',
'search':'M10.5 3a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15Zm5.5 13 5 5',
'offline':'m3 3 18 18M2 9a16 16 0 0 1 5-3m4-1a16 16 0 0 1 11 4M5 13a10 10 0 0 1 6-3m5 1 3 2M8 17a5 5 0 0 1 8 0m-4 4h.01',
'check':'m5 12 4 4L19 6',
'close':'m5 5 14 14M5 19 19 5',
'back':'M20 12H4m6-6-6 6 6 6',
'arrow':'M4 12h16m-6-6 6 6-6 6',
'volume':'M4 9h4l5-5v16l-5-5H4Zm12-1a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14',
'settings':'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1Z',
'mail':'M3 5h18v14H3Zm0 0 9 8 9-8'}
LABELS=['ホーム','厩舎','レース','スカウト','ショップ','スピード','残り脚','折り合い','加速','芝','ダート','晴れ','曇り','雨','ナイター','ブラシ','給水','飼料','鞍','ヘルメット','勝負服','血統・配合','フレンド','ミッション','ギフト','コイン','ロック','検索','オフライン','完了','閉じる','戻る','進む','音量','設定','お知らせ']
(DESIGN/'icon-paths.json').write_text(json.dumps(P,ensure_ascii=False,indent=2))
for (slug,d),label in zip(P.items(),LABELS):
 f=f'icons/{slug}.svg';svg(f,f'<g color="{INK}">'+path(d,'currentColor')+'</g>',24,24,label);figma=f'figma/icons/{slug}.svg';svg(figma,path(d,INK),24,24,label);add('icon-'+slug,label,'icons',f,24,24,'24pxの操作・状態アイコン。インラインSVGで currentColor を指定。',minDisplayPx=20,source='authored-svg',tintable=True,figmaSource=figma)
# Image-generation masters are never cropped or painted by this builder.
keyart=[('greenfield-dawn','夜明けのクラブ厩舎','ホーム・厩舎・ログイン背景',[.04,.10,.42,.90]),('scout-gate','新しい出会いのゲート','スカウト・新しい相棒の紹介',[.04,.12,.34,.84]),('season-collection','シーズン・コレクション','シーズンパス・衣装告知',[.04,.12,.32,.82]),('victory-trophy','勝利のトロフィー','報酬・初勝利・シーズン表彰',None)]
for slug,title,use,safe in keyart:
 ext='png' if slug=='victory-trophy' else 'webp';p=OUT/'keyart'/f'{slug}.{ext}';im=Image.open(p)
 add(slug,title,'keyart',f'keyart/{slug}.{ext}',im.width,im.height,use,source='image_gen',transparent=im.mode=='RGBA',safeArea=safe,minimumTextContrast=4.5,previewFit='contain' if ext=='png' else 'cover',master=f'masters/{slug}.png')
# Typography is outlined in brand lockups for predictable Figma / native rendering.
fonts={key:TTFont('/usr/share/fonts/opentype/noto/'+file,fontNumber=0) for key,file in [('serif','NotoSerifCJK-Regular.ttc'),('sans','NotoSansCJK-Regular.ttc')]}
def outlines(text,x,y,size,color=INK,family='serif'):
 font=fonts[family];glyphs=font.getGlyphSet();cmap=font.getBestCmap();scale=size/font['head'].unitsPerEm;parts=[]
 for char in text:
  name=cmap.get(ord(char));
  if not name:x+=size*.5;continue
  pen=SVGPathPen(glyphs);glyphs[name].draw(TransformPen(pen,(scale,0,0,-scale,x,y)));parts.append(f'<path d="{pen.getCommands()}" fill="{color}"/>');x+=glyphs[name].width*scale
 return ''.join(parts)
def crest(bg=FOREST,fg=LIGHT):return f'<rect width="128" height="128" rx="28" fill="{bg}"/><rect x="12" y="12" width="104" height="104" rx="43" fill="none" stroke="{fg}" stroke-opacity=".4"/>'+path('M35 86V40l29 32 29-32v46',fg,3)+path('M51 101h26',fg,.9)
for slug,bg,fg,preview in [('crest-forest',FOREST,LIGHT,IVORY),('crest-ivory',IVORY,FOREST,FOREST)]:
 f=f'brand/{slug}.svg';svg(f,crest(bg,fg),128,128,'ムチ一閃 クラブ章');add(slug,'クラブ章 / '+slug.split('-')[1],'brand',f,128,128,'アプリアイコン・ヘッダー・ギフト包装。周囲1/4幅を空ける。',previewBackground=preview,minDisplayPx=32)
for slug,ink,bg in [('wordmark-dark',INK,IVORY),('wordmark-light',IVORY,FOREST)]:
 f=f'brand/{slug}.svg';body=f'<g transform="translate(8 8) scale(.88)">{crest(FOREST if ink==INK else IVORY,LIGHT if ink==INK else FOREST)}</g>'+outlines('ムチ一閃',145,72,53,ink)+outlines('THE JOCKEY RACING CLUB',149,101,10,ink,'sans')
 svg(f,body,600,130,'ムチ一閃 ロゴタイプ');add(slug,'ロゴタイプ / '+slug.split('-')[1],'brand',f,600,130,'横組みロゴ。文字はアウトライン。変形・縁取り・影の追加をしない。',previewBackground=bg,minDisplayPx=180)
svg('brand/app-icon.svg',f'<rect width="1024" height="1024" fill="{FOREST}"/><g transform="translate(128 128) scale(6)">{crest(FOREST,LIGHT)}</g>',1024,1024,'ムチ一閃 アプリアイコン');add('app-icon','アプリアイコン原版','brand','brand/app-icon.svg',1024,1024,'不透明の正方形原版。OSのマスクを前提に外周の角は焼き込まない。',opaque=True)
# Backend-compatible class identifiers; do not invent a new ranking system.
classes=json.loads((FRONT.parent/'server/master/progression.json').read_text())['classes']
class_colors=[('#d7b387','#815d40'),('#e4e9e2','#849890'),('#e8cf87','#a58a47'),('#d5e2dc','#4b7260')]
def laurel(cx,cy,r,color):
 result=''
 for side in (-1,1):
  result+=f'<path d="M{cx+side*r*.40} {cy+r*1.02}Q{cx+side*r*1.22} {cy+r*.62} {cx+side*r*.92} {cy-r*.55}" fill="none" stroke="{color}" stroke-width="1.2"/>'
  for j in range(7):
   a=math.radians(25+j*16);x=cx+side*math.sin(a)*r;y=cy+math.cos(a)*r;rotation=side*(48-j*8)
   result+=f'<g transform="translate({x:.2f} {y:.2f}) rotate({rotation})"><path d="M0-7.4C4.5-3.5 4.2 2.4 0 7.4C-4.2 2.4-4.5-3.5 0-7.4Z" fill="{color}"/><path d="M0-5V5" stroke="{IVORY}" stroke-width=".45" opacity=".25"/></g>'
 return result
for i,c in enumerate(classes):
 id=c['id'];light,dark=class_colors[i];body=defs('foil',light,dark)+f'<path d="M64 5 106 23 102 83 64 121 26 83 22 23Z" fill="{FOREST}" stroke="url(#foil)" stroke-width="2"/><path d="M64 14 97 29 94 78 64 110 34 78 31 29Z" fill="none" stroke="{dark}" stroke-width=".8"/>'+laurel(64,52,34,'url(#foil)')+outlines(id,48,76,46,light,'serif')
 f=f'emblems/class-{id.lower()}.svg';svg(f,body,128,128,'クラス '+id);add('class-'+id,'クラス '+id,'emblems',f,128,128,'サーバー classId='+id+' の紋章。表示名はUI側でローカライズ。',classId=id,statCap=c['statCap'],minDisplayPx=40)
for slug,title,count in [('first-victory','初勝利の記章',1),('season-champion','シーズン表彰の記章',3)]:
 body=defs()+f'<circle cx="64" cy="64" r="53" fill="{FOREST}" stroke="url(#foil)" stroke-width="2"/><circle cx="64" cy="64" r="46" fill="none" stroke="{GOLD}" stroke-opacity=".45"/>'+laurel(64,52,37,GOLD)+f'<g transform="translate(39 30) scale(2.1)">{path(P["race"],LIGHT,1)}</g>'+''.join(f'<circle cx="{64+(j-(count-1)/2)*10}" cy="96" r="2" fill="{LIGHT}"/>' for j in range(count))
 f=f'emblems/{slug}.svg';svg(f,body,128,128,title);add(slug,title,'emblems',f,128,128,'達成演出・戦績カード。称号の取得条件を画像へ焼き込まない。',minDisplayPx=40)
# Inventory illustrations use layered silhouettes and the same material palette.
def item_base():return defs()+f'<ellipse cx="64" cy="105" rx="37" ry="7" fill="{FOREST}" opacity=".08"/>'
items={
'feed-oats':('飼葉・オーツ',f'<path d="M27 56h74l-10 42H37Z" fill="#b6aa82" stroke="#8d845f" stroke-width="1.5"/><path d="M24 56h80v9H24Z" fill="#d6ca9f"/><path d="M36 49c10-22 19-12 28-21 6 14 17 8 26 21Z" fill="#b4a16a"/>'+''.join(f'<ellipse cx="{40+i*8}" cy="{45+(i%2)*4}" rx="3" ry="7" transform="rotate(32 {40+i*8} {45+(i%2)*4})" fill="#e6d9a7"/>'for i in range(7))),
'water-bucket':('給水バケツ',f'<path d="M34 44h60l-7 56H41Z" fill="{FOREST}" stroke="#657c61" stroke-width="2"/><ellipse cx="64" cy="45" rx="30" ry="8" fill="#b2c1a8" stroke="#729176"/><path d="M40 44V33a24 24 0 0 1 48 0v11" fill="none" stroke="{GOLD}" stroke-width="4"/><path d="M45 64h38M47 87h34" stroke="#bdcbad" stroke-opacity=".35"/>'),
'groom-brush':('お手入れブラシ',f'<g transform="rotate(-24 64 64)"><rect x="27" y="38" width="74" height="39" rx="16" fill="{FOREST}" stroke="{GOLD}" stroke-width="1.4"/><path d="M43 40v-7c0-14 42-14 42 0v7" fill="none" stroke="#9b7751" stroke-width="7"/><path d="M34 77v13m9-13v16m9-16v18m9-18v18m9-18v18m9-18v16m9-16v13m8-13v10" stroke="#baa579" stroke-width="5"/></g>'),
'premium-feed':('プレミアム飼料',f'<path d="M39 22h50l5 70c-18 14-42 14-60 0Z" fill="#e6dec1" stroke="#bdaf7d" stroke-width="1.5"/><path d="M38 26h52M35 86h58" stroke="{FOREST}" stroke-width="9"/><circle cx="64" cy="58" r="18" fill="{FOREST}"/><g transform="translate(51 45) scale(1.1)">{path(P["feed"],LIGHT,1.2)}</g>'),
'saddlecloth-ivory':('アイボリーのゼッケン',f'<path d="M27 29q37 15 74 0l-3 65q-34 15-68 0Z" fill="#e9e4cf" stroke="#c0ab70" stroke-width="2"/><path d="M34 39q30 11 60 0l-2 48q-28 11-56 0Z" fill="none" stroke="{FOREST}" stroke-width="1.5"/><circle cx="64" cy="65" r="14" fill="{FOREST}"/>'+outlines('M',52,74,24,LIGHT,'serif'))}
for slug,color in [('silks-crimson','#8e3544'),('silks-azure','#285e78'),('silks-violet','#66527c')]:
 items[slug]=('勝負服 / '+{'crimson':'クリムゾン','azure':'アズール','violet':'ヴァイオレット'}[slug.split('-')[1]],f'<path d="m40 20-22 19 13 23 13-9v49h40V53l13 9 13-23-22-19-24 9Z" fill="{color}" stroke="{GOLD}" stroke-width="1.4"/><path d="m43 40 21 17 21-17v13L64 70 43 53Z" fill="{IVORY}"/><path d="M64 29v73" stroke="{GOLD}" stroke-width="1"/>'+''.join(f'<circle cx="64" cy="{39+j*14}" r="1.6" fill="{LIGHT}"/>'for j in range(4)))
for slug,(title,body) in items.items():
 f=f'items/{slug}.svg';svg(f,item_base()+body,128,128,title);add(slug,title,'items',f,128,128,'所持品・ショップ・お世話の絵札。価格と数量はUI側に置く。',minDisplayPx=48,inventoryBinding=None)
# Transparent card surrounds and independently composable state overlays.
for rarity,color,details in [('R','#879c83',1),('SR',GOLD,2),('SSR','#c4a567',3)]:
 body=defs('foil',LIGHT,color)+f'<rect x="2" y="2" width="316" height="416" rx="12" fill="none" stroke="{color}" stroke-width="2"/><rect x="8" y="8" width="304" height="404" rx="8" fill="none" stroke="{color}" opacity=".35"/>'
 for x,y,sx,sy in [(14,14,1,1),(306,14,-1,1),(14,406,1,-1),(306,406,-1,-1)]:
  body+=f'<g transform="translate({x} {y}) scale({sx} {sy})">'+path('M0 22V0h22','url(#foil)',1.6)+''.join(f'<path d="M0-5Q2-1 5 0Q2 1 0 5Q-2 1-5 0Q-2-1 0-5Z" transform="translate({10+j*6} {10+j*6})" fill="{color}" opacity="{.45+j*.2}"/>'for j in range(details))+'</g>'
 f=f'frames/card-{rarity.lower()}.svg';svg(f,body,320,420,'カード枠 '+rarity);add('frame-'+rarity,'カード枠 '+rarity,'frames',f,320,420,'馬カードの最上面に重ねる透過枠。画像を潰して伸縮せず9-slice相当で扱う。',safeInsetPx=26+details*6,sliceInsets=[26+details*6]*4,rarity=rarity)
for slug,title,body in [('selected','選択中',f'<rect x="2" y="2" width="316" height="416" rx="12" fill="none" stroke="#789665" stroke-width="3"/><circle cx="290" cy="30" r="16" fill="{FOREST}"/><g transform="translate(278 18)">{path(P["check"],LIGHT,1.8)}</g>'),('locked','未開放',f'<rect x="2" y="2" width="316" height="416" rx="12" fill="#f7f6f0" opacity=".62"/><circle cx="160" cy="210" r="35" fill="{IVORY}" stroke="{LINE}"/><g transform="translate(142 192) scale(1.5)">{path(P["lock"],GOLD,1.2)}</g>')]:
 f=f'frames/overlay-{slug}.svg';svg(f,body,320,420,title);add('overlay-'+slug,title+'オーバーレイ','frames',f,320,420,'レアリティ枠とは別レイヤー。意味は必ずテキストでも示す。',safeInsetPx=48,scalingMode='preserveAspectRatio')
# Quiet state illustrations; no embedded wording, so Japanese and English share the same art.
state_specs=[('search-empty','検索結果なし','search','条件を変えてみましょう。'),('stable-empty','相棒がいない','stable','新しい相棒を迎えましょう。'),('breeding-locked','配合は未開放','bloodline','開放条件を確認しましょう。'),('offline','接続を確認','offline','接続後、もう一度お試しください。'),('reward-claimed','受取完了','gift','相棒との次の一戦へ。'),('maintenance','準備中','settings','クラブの準備が整うまでお待ちください。'),('action-failed','操作を完了できない','close','内容を確認して、もう一度お試しください。')]
for slug,title,symbol,copy in state_specs:
 accent='#b04b3c' if slug=='action-failed' else GOLD
 body=f'<ellipse cx="160" cy="191" rx="88" ry="12" fill="{FOREST}" opacity=".05"/><circle cx="160" cy="112" r="72" fill="#eef1e3"/><circle cx="160" cy="112" r="81" fill="none" stroke="{LINE}" stroke-dasharray="2 7"/><path d="M57 192h206" stroke="{LINE}"/><g transform="translate(119 70) scale(3.4)">{path(P[symbol],accent,1)}</g>'+path('M67 166q-15-25-4-41m0 20 13-6m-11 19-12-3M255 174q12-21 5-35m-3 17-10-5', '#a1b18b',1.4)
 # Each state gets its own quiet narrative vignette, not only a changed glyph.
 common=f'<ellipse cx="160" cy="194" rx="92" ry="10" fill="{FOREST}" opacity=".05"/><circle cx="160" cy="117" r="77" fill="#eef1e3"/>'
 if slug=='search-empty':
  vignette=f'<rect x="83" y="62" width="139" height="106" rx="7" fill="{IVORY}" stroke="{GOLD}" stroke-width="1.4"/><path d="M99 87h48m-48 16h29m-29 16h37" stroke="{LINE}" stroke-width="2"/><rect x="141" y="88" width="58" height="50" rx="23" fill="none" stroke="#9cad8c" stroke-width="3" stroke-dasharray="3 4"/><circle cx="202" cy="145" r="27" fill="{IVORY}" stroke="{GOLD}" stroke-width="2"/><path d="m222 165 21 21" stroke="{FOREST}" stroke-width="5" stroke-linecap="round"/>'
 elif slug=='stable-empty':
  vignette=f'<path d="m93 90 67-43 67 43v91H93Z" fill="{IVORY}" stroke="{GOLD}" stroke-width="1.4"/><path d="M110 177v-69h100v69m-50-69v69M111 143h98m-96-31 44 60m5 0 45-60" fill="none" stroke="#8ba27d" stroke-width="1.4"/><path d="M151 74v13a9 9 0 0 0 18 0V74" fill="none" stroke="{GOLD}" stroke-width="3"/><path d="m80 182 8-17 5 17m133 0 8-20 7 20" stroke="#a3b38f" fill="none"/>'
 elif slug=='breeding-locked':
  vignette=f'<path d="M160 87v27m-51 15v-15h102v15" fill="none" stroke="{GOLD}" stroke-width="1.5"/><circle cx="160" cy="71" r="23" fill="{IVORY}" stroke="{GOLD}"/><circle cx="109" cy="150" r="23" fill="{IVORY}" stroke="#9aaf87"/><circle cx="211" cy="150" r="23" fill="{IVORY}" stroke="#9aaf87"/><g transform="translate(148 59)">{path(P['bloodline'],GOLD,1)}</g><rect x="150" y="142" width="38" height="36" rx="6" fill="{FOREST}" stroke="{GOLD}"/><path d="M158 142v-9a11 11 0 0 1 22 0v9m-11 13v10" fill="none" stroke="{LIGHT}" stroke-width="1.5"/>'
 elif slug=='offline':
  vignette=f'<path d="M92 160h136l-8 20H100Z" fill="{IVORY}" stroke="{GOLD}" stroke-width="1.4"/><rect x="113" y="91" width="94" height="66" rx="6" fill="{IVORY}" stroke="#97ac83"/><path d="M132 68a45 45 0 0 1 56 0m-47 13a29 29 0 0 1 38 0m-29 14a12 12 0 0 1 20 0" fill="none" stroke="{GOLD}" stroke-width="2" stroke-linecap="round"/><path d="m142 114 12 12-11 13m35-25-12 12 11 13" fill="none" stroke="#a3b38f" stroke-width="1.4"/><path d="M157 126h6" stroke="{GOLD}" stroke-dasharray="2 3"/>'
 elif slug=='reward-claimed':
  vignette=f'<path d="M105 116h110v67H105Z" fill="#e6e1c8" stroke="{GOLD}" stroke-width="1.4"/><path d="m100 111 53-17-9-25-54 16Zm67-17 52 17 11-26-54-16Z" fill="{IVORY}" stroke="{GOLD}" stroke-width="1.2"/><rect x="145" y="102" width="30" height="81" fill="{FOREST}"/><path d="M155 98c-24-32-40-6-3 0m12 0c24-32 40-6 3 0" fill="none" stroke="{GOLD}" stroke-width="2"/><circle cx="212" cy="173" r="20" fill="{FOREST}" stroke="{GOLD}"/><g transform="translate(200 161)">{path(P['check'],LIGHT,1.5)}</g>'
 elif slug=='maintenance':
  vignette=f'<path d="M98 178V86l62-35 62 35v92Z" fill="{IVORY}" stroke="{GOLD}" stroke-width="1.4"/><path d="M113 179v-70h94v70m-47-70v70m-45-34h90" fill="none" stroke="#9caf89" stroke-width="1.4"/><path d="M160 53v23m-8 0h16v23h-16Z" fill="none" stroke="{GOLD}" stroke-width="1.5"/><circle cx="218" cy="162" r="27" fill="{IVORY}" stroke="{GOLD}" stroke-width="2"/><path d="M218 145v18l12 7" fill="none" stroke="{FOREST}" stroke-width="2"/>'
 else:
  vignette=f'<path d="M103 65h101l18 18v94H103Z" fill="{IVORY}" stroke="{GOLD}" stroke-width="1.4"/><path d="M204 65v20h18m-101 18h77m-77 14h59m-59 14h42" fill="none" stroke="{LINE}" stroke-width="2"/><circle cx="207" cy="160" r="25" fill="{IVORY}" stroke="#b04b3c" stroke-width="1.4"/><path d="M207 146v17m0 9h.01" stroke="#b04b3c" stroke-width="2.2" stroke-linecap="round"/>'
 body=common+vignette+path('M65 195h190','#c4d1b7',1)
 f=f'states/{slug}.svg';svg(f,body,320,240,title);add('state-'+slug,title,'states',f,320,240,copy,minDisplayPx=160,copyKey='creative.state.'+slug)
# Repeatable motifs stay low-contrast; semantic text never lives on top of a busy tile.
patterns={
'club-pinstripe':f'<path d="M0 0v64M32 0v64M64 0v64" stroke="{GOLD}" stroke-opacity=".14" stroke-width=".7"/>',
'silk-chevron':f'<path d="m-16 8 32 24L48 8 80 32M-16 40l32 24 32-24 32 24" fill="none" stroke="{GOLD}" stroke-opacity=".18" stroke-width="1"/>',
'laurel-weave':f'<g fill="{GOLD}" opacity=".16"><ellipse cx="16" cy="16" rx="3" ry="6" transform="rotate(-35 16 16)"/><ellipse cx="48" cy="48" rx="3" ry="6" transform="rotate(35 48 48)"/></g>'}
for slug,body in patterns.items():
 f=f'patterns/{slug}.svg';svg(f,body,64,64,slug);add(slug,{'club-pinstripe':'クラブ・ピンストライプ','silk-chevron':'勝負服のシェブロン','laurel-weave':'月桂樹の織り柄'}[slug],'patterns',f,64,64,'64pxのリピートタイル。装飾面のみ、合成不透明度4〜8%を上限目安にする。',tileable=True,recommendedLayerOpacity=.3)
for slug,title,paid,count in [('coin-free','無償コイン',False,1),('coin-paid','有償コイン',True,1),('coin-reward','コイン報酬',False,3)]:
 body=defs('foil',LIGHT,GOLD)
 for i in range(count):
  x=64+(i-(count-1)/2)*13;y=64-(i%2)*7
  body+=f'<circle cx="{x}" cy="{y}" r="39" fill="url(#foil)" stroke="#927b46" stroke-width="1"/><circle cx="{x}" cy="{y}" r="33" fill="none" stroke="#fff3c2" stroke-opacity=".7"/><g transform="translate({x-18} {y-23})">'+path('M0 40V3l18 21L36 3v37',FOREST,1.5)+'</g>'
  if paid:body+=f'<circle cx="{x}" cy="{y}" r="28" fill="none" stroke="#927b46" stroke-width=".7"/>'
 f=f'currency/{slug}.svg';svg(f,body,128,128,title);add(slug,title,'currency',f,128,128,'残高・価格・報酬。無償/有償は文字ラベルを必ず併記。',minDisplayPx=20,paid=paid)
# Material definitions are real reusable PBR inputs, not screenshots of another shader.
M=[
('coat-bay','鹿毛','#6c3826',.46,0),('coat-chestnut','栗毛','#99562f',.46,0),('coat-grey','芦毛','#bdc4bf',.5,0),('coat-black','青鹿毛','#272f2c',.44,0),('coat-palomino','河原毛','#b59c6b',.48,0),
('silk-crimson','クリムゾンの勝負服','#8e3544',.34,.02),('silk-azure','アズールの勝負服','#285e78',.34,.02),('silk-violet','ヴァイオレットの勝負服','#66527c',.34,.02),('silk-emerald','エメラルドの勝負服','#244f3a',.34,.02),('silk-gold','ゴールドの勝負服','#aa8b4c',.36,.03),
('tack-leather','オイルドレザー','#493125',.38,.04),('tack-brass','ブラッシュドブラス',GOLD,.27,.78),('cloth-ivory','アイボリーの織物','#dfdbc4',.68,0),('turf','ターフ','#6b814d',.95,0),('dirt','ダート','#88735a',.96,0),('paper','クラブの紙',IVORY,.88,0),('enamel','フォレストの琺瑯',FOREST,.23,.16)]
materials=[]
for slug,title,color,rough,metal in M:
 f=f'materials/{slug}.svg';body=f'<defs><radialGradient id="swatch" cx="32%" cy="25%" r="78%"><stop stop-color="{IVORY}" stop-opacity=".8"/><stop offset=".32" stop-color="{color}"/><stop offset="1" stop-color="{FOREST}"/></radialGradient></defs><ellipse cx="64" cy="108" rx="36" ry="7" fill="{FOREST}" opacity=".08"/><circle cx="64" cy="60" r="43" fill="url(#swatch)" stroke="{GOLD}" stroke-opacity=".25"/>'
 svg(f,body,128,128,title);entry=dict(id=slug,name=title,baseColor=color,colorSpace='sRGB',roughness=rough,metallic=metal,coatWeight=.02 if slug.startswith('coat') else 0,normalReferenceOnly=True);materials.append(entry)
 add('material-'+slug,title,'materials',f,128,128,'PBR材質の参照。球体のSVGは模式プレビュー、数値とBlenderライブラリを正とする。',pbr=entry,source='authored-pbr')
(OUT/'materials/pbr-palettes.json').write_text(json.dumps(dict(version=1,materials=materials),ensure_ascii=False,indent=2))
(OUT/'materials/lighting-presets.json').write_text(json.dumps(dict(version=1,targetEngine='Three.js r182 / ACESFilmicToneMapping',note='Blenderの光量へそのまま代入せず、カメラと露出を合わせて参照する。',presets=[dict(id='club-daylight',keyColor='#ffebc0',keyIntensity=2.2,fillIntensity=1.3,rimColor='#dbe9ff',rimIntensity=.8,exposure=1.1),dict(id='stable-dawn',keyColor='#ffe0ae',keyIntensity=2.0,fillIntensity=1.0,rimColor='#d9e4c8',rimIntensity=.65,exposure=1.0),dict(id='scout-reveal',keyColor='#fff1cb',keyIntensity=2.4,fillIntensity=.8,rimColor='#e8d7a1',rimIntensity=1.0,exposure=1.1)]),ensure_ascii=False,indent=2))
# Motion presets with reduced-motion equivalents. Timing is deliberately short and restrained.
motion=[('panel-in','パネルの登場',220,'translateY(8px)','translateY(0)'),('card-reveal','カードの開示',260,'translateY(12px) scale(.98)','translateY(0) scale(1)'),('button-press','ボタンの押下',90,'scale(1)','scale(.98)'),('selection','選択の切替',160,'scale(.985)','scale(1)'),('reward','報酬の受取',420,'translateY(6px) scale(.92)','translateY(0) scale(1)'),('toast','案内の表示',180,'translateY(6px)','translateY(0)'),('victory','勝利の記章',480,'scale(.92)','scale(1)'),('loading','読込中',1100,'rotate(0deg)','rotate(360deg)')]
css=['/* Apply only to visual wrappers. Keep labels and focus positions stable. */']
for slug,title,duration,start,end in motion:
 looping=slug=='loading';opacity='' if looping or slug=='button-press' else 'opacity:0;'
 css.append(f'@keyframes mi-{slug}{{from{{transform:{start};{opacity}}}to{{transform:{end};opacity:1}}}}.mi-motion-{slug}{{animation:mi-{slug} {duration}ms '+('linear infinite' if looping else 'cubic-bezier(.16,1,.3,1) both')+';}')
 add('motion-'+slug,title,'motion','motion/motion.css',128,128,'動きのプリセット。設定に従って一回のみ適用。読込中以外はループしない。',durationMs=duration,easing='linear' if looping else 'cubic-bezier(.16,1,.3,1)',cssClass='mi-motion-'+slug,reducedMotion='static',loop=looping)
css.append('@media(prefers-reduced-motion:reduce){[class*="mi-motion-"]{animation:none!important;transform:none!important;opacity:1!important;}}')
shutil.copyfile(FRONT/'scripts/creative-motion.js',OUT/'motion/motion.js')
(OUT/'motion/motion.css').write_text('\n'.join(css));(OUT/'motion/motion.json').write_text(json.dumps([a for a in assets if a['category']=='motion'],ensure_ascii=False,indent=2))
# Original synthesized UI cues, mono PCM, with headroom and click-free fades.
SR=44100
sound_specs=[('press','軽い押下',.055,[(820,0,.7)],.12),('back','戻る',.09,[(530,0,.7),(350,.025,.4)],.15),('confirm','確定',.20,[(660,0,.7),(990,.045,.4)],.08),('error','入力の確認',.22,[(220,0,.6),(196,.10,.45)],.05),('reward','報酬の受取',.48,[(523,0,.55),(659,.08,.45),(784,.16,.35)],.04),('gate','ゲートの開放',.28,[(160,0,.6),(320,.018,.25),(840,.025,.08)],.55),('finish','ゴール',.74,[(392,0,.4),(523,.08,.45),(659,.16,.3),(784,.24,.22)],.03)]
for slug,title,duration,partials,noise_amount in sound_specs:
 rng=random.Random('muchi-'+slug);signal=[];filtered=0
 for n in range(round(duration*SR)):
  t=n/SR;value=0
  for hz,start,volume in partials:
   age=t-start
   if age>=0:
    envelope=min(1,age/.007)*math.exp(-age/(.11 if duration>.3 else .04))
    value+=volume*envelope*(math.sin(math.tau*hz*age)+.16*math.sin(math.tau*hz*2.01*age))
  filtered=.82*filtered+.18*rng.uniform(-1,1);value+=noise_amount*filtered*math.exp(-t/.045)
  fade=min(1,t/.005,(duration-t)/.015);signal.append(value*max(0,fade))
 peak=max(abs(x)for x in signal)or 1;signal=[x/peak*.40 for x in signal]
 f=f'audio/{slug}.wav'
 with wave.open(str(OUT/f),'wb')as out:out.setnchannels(1);out.setsampwidth(2);out.setframerate(SR);out.writeframes(b''.join(struct.pack('<h',round(x*32767))for x in signal))
 add('audio-'+slug,title,'audio',f,0,0,'ユーザー操作時の短い効果音。初期ミュート、再生時の推奨音量0.18。',durationMs=round(duration*1000),sampleRate=SR,channels=1,peakDbFS=round(20*math.log10(.4),2),source='original-synthesis',defaultVolume=.18)
(OUT/'audio/mix.json').write_text(json.dumps(dict(defaultMuted=True,defaultVolume=.18,maxConcurrentVoices=3,duckingMs=60,cues=[a['id'] for a in assets if a['category']=='audio']),indent=2))
# Standalone campaign/share compositions. Outlined deliverables + editable text sources + bindings.
def uri(file):p=Path(file);mime='image/png'if p.suffix=='.png'else'image/webp';return 'data:'+mime+';base64,'+base64.b64encode(p.read_bytes()).decode()
def image(file,x,y,w,h,fit='xMidYMid slice'):return f'<image href="{uri(file)}" x="{x}" y="{y}" width="{w}" height="{h}" preserveAspectRatio="{fit}"/>'
def text(text,x,y,size,color=IVORY,family='serif',editable=False):return f'<text x="{x}" y="{y}" fill="{color}" font-family="Club {"Serif"if family=="serif"else"Sans"}" font-size="{size}">{html.escape(text)}</text>' if editable else outlines(text,x,y,size,color,family)
def marketing(kind,editable=False):
 if kind=='share-victory':
  w,h=1200,630;body=f'<rect width="{w}" height="{h}" fill="{FOREST}"/>'+defs()+f'<rect x="24" y="24" width="1152" height="582" rx="8" fill="none" stroke="{GOLD}" stroke-opacity=".55"/>'+image(OUT/'keyart/victory-trophy.png',780,70,360,480,'xMidYMid meet')+text('GREENFIELD CUP / RACE RESULT',64,84,14,LIGHT,'sans',editable)+text('1ST PLACE',64,280,112,LIGHT,'serif',editable)+text('アカツキ',70,390,56,IVORY,'serif',editable)+path('M70 437h610',GOLD,1)+text('TIME  1:58.4',74,498,30,IVORY,'sans',editable)+text('相棒とつかんだ、最高の直線。',74,555,20,'#b7c5aa','serif',editable)
 elif kind=='season-portrait':
  w,h=1080,1350;body=f'<rect width="{w}" height="{h}" fill="{FOREST}"/>'+image(OUT/'keyart/season-collection.webp',0,510,w,840)+f'<g transform="translate(65 60) scale(.7)">{crest()}</g>'+text('THE NOVEMBER COLLECTION',188,117,15,LIGHT,'sans',editable)+text('次の季節も、',68,281,70,IVORY,'serif',editable)+text('相棒と。',68,388,82,LIGHT,'serif',editable)+text('SEASON 01 / MUCHI ISSEN',73,452,17,'#b7c5aa','sans',editable)+f'<rect x="40" y="40" width="1000" height="1270" fill="none" stroke="{GOLD}" stroke-opacity=".55"/>'
 else:
  w,h=1920,1080;body=image(OUT/'keyart/greenfield-dawn.webp',0,0,w,h)+image(FRONT/'public/art/partner-0.webp',850,135,1060,870,'xMidYMid meet')+f'<g transform="translate(82 70) scale(.8)">{crest()}</g>'+text('THE JOCKEY RACING CLUB',211,132,18,LIGHT,'sans',editable)+text('その一瞬に、',94,365,88,IVORY,'serif',editable)+text('すべてを懸ける。',94,510,88,LIGHT,'serif',editable)+text('相棒と駆ける、90秒の物語。',100,632,27,'#d3dcc7','serif',editable)+text('ムチ一閃',99,925,62,IVORY,'serif',editable)+text('RIDE YOUR OWN STORY.',105,974,15,LIGHT,'sans',editable)
 return body,w,h
for kind,title in [('launch-landscape','ローンチ・横長キービジュアル'),('season-portrait','シーズン告知・縦長'),('share-victory','戦績シェア・横長')]:
 body,w,h=marketing(kind);f=f'templates/{kind}.svg';svg(f,body,w,h,title)
 body,_,_=marketing(kind,True);edit=f'templates/source/{kind}-editable.svg';svg(edit,body,w,h,title+' / 編集用')
 add(kind,title,'templates',f,w,h,'SVG原版は画像埋め込み・文字アウトライン。編集用SVGと差し替え用bindingsを同梱。',editableSource=edit,source='authored-layout',sampleValues=True)
(OUT/'templates/bindings.json').write_text(json.dumps(dict(version=1,shareVictory=dict(place=1,horseName='アカツキ',raceName='グリーンフィールド杯',time='1:58.4',message='相棒とつかんだ、最高の直線。',constraints=dict(horseName=dict(maxCharacters=12,maxWidthPx=610,maxFontSize=56,minFontSize=36,overflow='shrink-font-without-ellipsis'),time=dict(format='m:ss.s',maxWidthPx=280))),season=dict(seasonId='01',collection='NOVEMBER',title=['次の季節も、','相棒と。']),note='作例の値。公開時は表示名・言語・確定した戦績・開催期間で差し替える。'),ensure_ascii=False,indent=2))
# A white-alpha sprite atlas for Unity / native tinting. Source icons remain 24px SVGs.
atlas_body='';rects=[]
for i,(slug,d)in enumerate(P.items()):
 x=(i%8)*64;y=(i//8)*64;atlas_body+=f'<g transform="translate({x+16} {y+16}) scale(1.333333)">{path(d,"#ffffff")}</g>';rects.append(dict(id='icon-'+slug,x=(x+16)*2,y=(y+16)*2,width=64,height=64,pivot=[.5,.5]))
svg('atlas/ui-icons.svg',atlas_body,512,320,'UI icons / white alpha mask')
(OUT/'atlas/ui-icons.json').write_text(json.dumps(dict(image='ui-icons@2x.png',width=1024,height=640,alpha='straight',coordinates='top-left pixels',spriteRects=rects),indent=2))
unity_rects=[dict(rect,y=640-rect['y']-rect['height'])for rect in rects]
(OUT/'atlas/ui-icons-unity.json').write_text(json.dumps(dict(image='ui-icons@2x.png',width=1024,height=640,coordinates='bottom-left pixels',textureImporter=dict(type='Sprite',spriteMode='Multiple',alphaIsTransparency=True,sRGBTexture=True,mipmapEnabled=False,npotScale='None',filterMode='Bilinear'),spriteRects=unity_rects),indent=2))
# Delivery fonts and credits keep the kit useful when extracted outside the application.
(OUT/'fonts').mkdir(exist_ok=True)
for p in (FRONT/'public/fonts').glob('*.woff2'):shutil.copyfile(p,OUT/'fonts'/p.name)
for p in (FRONT/'design/fonts').glob('*.otf'):shutil.copyfile(p,OUT/'fonts'/p.name)
shutil.copyfile(FRONT/'public/fonts/LICENSE.txt',OUT/'fonts/LICENSE.txt')
order=['keyart','templates','brand','emblems','items','currency','frames','states','patterns','icons','materials','motion','audio']
assets.sort(key=lambda a:order.index(a['category']))
shutil.copyfile(FRONT/'scripts/creative-frames.css',OUT/'frames/frames.css')
manifest=dict(version=1,name='MUCHI ISSEN / Creative Library 01',artDirection='The Racing Club / Forest, Ivory & Brass',coordinateSystem='SVG px; normalized safeArea=[left,top,right,bottom]',assets=assets)
def luminance(rgb):
 return sum(weight*(v/3294.6 if v<=10.31475 else ((v/255+.055)/1.055)**2.4)for v,weight in zip(rgb,(.2126,.7152,.0722)))
for entry in assets:
 if entry.get('safeArea'):
  im=Image.open(OUT/entry['file']).convert('RGB');l,t,r,b=entry['safeArea'];crop=im.crop((int(l*im.width),int(t*im.height),int(r*im.width),int(b*im.height)))
  pixels=getattr(crop,'get_flattened_data',crop.getdata)();maximum=max(luminance(pixel)for pixel in pixels)
  entry['textColor']=IVORY;entry['measuredMinimumContrast']=round((luminance((247,246,240))+.05)/(maximum+.05),2)
  assert entry['measuredMinimumContrast']>=4.5, 'Text safe area needs revision: '+entry['id']
for entry in assets:
 p=OUT/entry['file'];entry['sha256']=hashlib.sha256(p.read_bytes()).hexdigest();entry['bytes']=p.stat().st_size
(OUT/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2))
copy={a['copyKey']:dict(ja=a['usage'],en={'search-empty':'Try another name or filter.','stable-empty':'Meet your next partner.','breeding-locked':'Check the unlock conditions.','offline':'Reconnect and try again.','reward-claimed':'On to the next race together.','maintenance':'The club will be ready soon.','action-failed':'Check the details and try again.'}[a['id'].removeprefix('state-')])for a in assets if a['category']=='states'}
copy['creative.marketing.launch']=dict(ja=['その一瞬に、','すべてを懸ける。'],en=['One moment.','Your story.'])
copy['creative.marketing.season']=dict(ja=['次の季節も、','相棒と。'],en=['A new season.','With your partner.'])
copy['creative.marketing.victory']=dict(ja='相棒とつかんだ、最高の直線。',en='Your partner. Your finest finish.')
(OUT/'copy.json').write_text(json.dumps(copy,ensure_ascii=False,indent=2))
print('Built',len(assets),'creative resources:',{c:sum(a['category']==c for a in assets)for c in sorted({a['category']for a in assets})})
# A self-contained catalog works both on the dev server and from an extracted kit.
template=(FRONT/'scripts/creative-catalog.html').read_text()
(OUT/'index.html').write_text(template.replace('__COUNT__',str(len(assets))).replace('__MANIFEST__',json.dumps(manifest,ensure_ascii=False).replace('</','<\\/')))
