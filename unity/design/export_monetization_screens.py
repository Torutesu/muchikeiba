import base64
from pathlib import Path
import zipfile
from export_figma_screens import ART, OUT, emit, box, txt, line, btn
OPT_ART=Path(__file__).resolve().parent/'figma-optimized-art'
THREE_D=Path(__file__).resolve().parents[1]/'Assets'/'Resources'/'Art'/'3DPreviews'

def image(path,x,y,w,h,fit='xMidYMid meet'):
    if path.startswith('3DPreviews/'):
        source=THREE_D/Path(path).name
        raw=base64.b64encode(source.read_bytes()).decode()
        return f'<image x="{x}" y="{y}" width="{w}" height="{h}" preserveAspectRatio="{fit}" href="data:image/png;base64,{raw}" xlink:href="data:image/png;base64,{raw}"/>'
    optimized_png=OPT_ART/path
    optimized_jpg=OPT_ART/Path(path).with_suffix('.jpg')
    source=optimized_png if optimized_png.exists() else optimized_jpg if optimized_jpg.exists() else ART/path
    mime='image/png' if source.suffix=='.png' else 'image/jpeg'
    raw=base64.b64encode(source.read_bytes()).decode()
    return f'<image x="{x}" y="{y}" width="{w}" height="{h}" preserveAspectRatio="{fit}" href="data:{mime};base64,{raw}" xlink:href="data:{mime};base64,{raw}"/>'
def head(title,subtitle):
    return box(38,32,1120,92,.86)+line(60,54,88)+txt(60,92,25,title,'#f7fbff',25,'700',1)+txt(60,114,15,subtitle,'#d0dce5',15,'500')
def card(x,y,w,h,title,sub,color='#00d2ed'):
    return box(x,y,w,h,.93,6)+line(x+2,y+2,w-4,color,4)
def compact_btn(x,y,w,h,label):
    return f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="4" fill="#0b2032" stroke="#00d2ed" stroke-width="2"/>'+txt(x+14,y+h/2+6,15,label,'#f7fbff',15,'700',1)

# 11. Wardrobe / five original 3D horse-and-jockey pairs
partners=[('Partner_Bay_Crimson.png','コハク / 鹿毛・紅','#c54a55'),('Partner_Chestnut_Azure.png','アカネ / 栗毛・蒼','#00d2ed'),('Partner_DappleGrey_Violet.png','シラナミ / 芦毛・紫','#9968d3'),('Partner_Black_Emerald.png','ヨル / 青毛・翠','#2eaa72'),('Partner_Palomino_Gold.png','キナコ / 月毛・金','#ffd34f')]
p=box(36,50,1528,782,.91)+head('相棒の着せ替え / 3Dレースモデル','5種類の毛色と5種類の勝負服。ランク戦の能力には影響しません。')+image('3DPreviews/'+partners[0][0],72,174,448,352)+box(72,530,448,178,.96)
p+=txt(94,572,22,partners[0][1],'#ffd34f',22,'700')+txt(94,616,16,'馬と騎手の3Dモデル','#00d2ed',16,'700')+txt(94,652,15,'毛色、鞍具、勝負服、騎手まで一組で表示。','#f7fbff',15)
for i,(asset,title,color) in enumerate(partners):
    x=548+(i%3)*326;y=174+(i//3)*276
    p+=card(x,y,306,260,title,'見た目専用',color)+image('3DPreviews/'+asset,x+38,y+11,230,184)+txt(x+12,y+216,15,title,'#f7fbff',15,'700')+compact_btn(x+13,y+222,280,32,'装備する')
p+=box(548,732,956,40,.92)+txt(566,758,15,'毛色 / 勝負服 / 鞍 / 頭絡 ・ 見た目のみ','#f7fbff',15,'600')
emit('11-wardrobe','home-paddock.png',p,'相棒の3D着せ替え')

# 12. Course looks
p=box(36,50,1528,782,.91)+head('競馬場スキン / 景観コレクション','景色だけを変更。ランク戦の条件は全員共通。')
themes=[('home-paddock.png','グリーンフィールド芝','N / 所持済み','#00d2ed'),('Courses/spring-course.png','春の牧草地','SR / プレビュー','#ffd34f'),('Courses/autumn-course.png','秋の黄金色','SSR / プレビュー','#e99152')]
for i,(asset,title,rarity,color) in enumerate(themes):
    x=55+i*505;p+=card(x,212,480,510,title,rarity,color)+image(asset,x+12,224,456,245,'xMidYMid slice')+txt(x+22,485,21,title,'#f7fbff',21,'700')+txt(x+22,520,15,rarity,color,15,'600')+txt(x+22,552,15,'景観のみ / 能力への影響なし','#d6e2ea',15)+btn(x+18,620,210,'プレビュー')+btn(x+246,620,210,'ショップを見る')
emit('12-course-looks','home-paddock.png',p,'競馬場スキン')

# 13. Conditions
p=box(30,45,1540,785,.91)+head('レース条件 / プライベートルーム','ランク戦は公式共通条件を使用します。')
for i,(asset,title) in enumerate([('sunny.png','晴れ'),('cloudy.png','曇り'),('rain.png','雨'),('fog.png','朝霧')]):
    x=50+i*375;p+=card(x,210,350,315,title,'天候プレビュー')+image('Weather/'+asset,x+8,218,334,190,'xMidYMid slice')+txt(x+18,434,19,title,'#f7fbff',19,'700')+txt(x+180,434,14,'天候プレビュー','#c5d4df',14)+btn(x+12,458,326,'選択')
p+=box(50,535,1500,260,.94)
for row,(label,values) in enumerate([('馬場',['硬め','良','稍重','重']),('気温',['14 ℃','18 ℃','22 ℃','26 ℃']),('風',['0 km/h','5 km/h','10 km/h','15 km/h'])]):
    y=560+row*68;p+=txt(72,y,17,label,'#00d2ed',17,'700')
    for i,value in enumerate(values):p+=box(248+i*180,y-30,165,54,.83,5)+txt(267+i*180,y+7,17,value,'#f7fbff',17,'600')
p+=txt(72,752,15,'天候・馬場・気温・風はルーム設定として保存。課金による有利さはありません。','#d0dce5',15)
emit('13-conditions','Weather/sunny.png',p,'天候と馬場設定')

# 14. Care
p=box(38,55,1524,770,.91)+head('厩舎のお世話 / 毎日のルーティン','餌は自由に選択。ランク戦能力は公平性のため調整。')
foods=[('oats-apple.png','穀物とりんご','N / COMMON','体調を整える','#00d2ed'),('hay-carrot.png','干し草とにんじん','R / SELECT','持久力のケア','#ffd34f'),('water-bucket.png','新鮮な水','SR / REFINED','落ち着いた手入れ','#c8eaff')]
for i,(asset,title,rarity,effect,color) in enumerate(foods):
    x=72+i*500;p+=card(x,210,465,485,title,rarity,color)+image('Food/'+asset,x+20,225,425,255)+txt(x+26,505,19,title,'#f7fbff',19,'700')+txt(x+26,536,14,rarity,color,14,'600')+txt(x+26,567,16,effect,'#f7fbff',16,'600')+btn(x+22,610,420,'今日のお世話に設定')
p+=box(72,710,950,72,.94)+image('Food/premium-bowl.png',80,702,80,80)+txt(170,757,18,'SSR 厩舎ボウル / 飾り専用 / 餌効果なし','#ffd34f',18,'700')+btn(1168,710,302,'飾りを見る')
emit('14-care-feed','home-paddock.png',p,'餌とお世話')

# 15. Coin store
p=box(32,42,1536,790,.93)+head('ムチ一閃ショップ / 有償コイン','無償・有償コインを分けて表示。パック初回購入は2倍。')
packs=[('¥160','100'),('¥480','310'),('¥800','530'),('¥1,500','1,020'),('¥2,400','1,660'),('¥3,800','2,680'),('¥5,000','3,600'),('¥10,000','7,400')]
for i,(price,amount) in enumerate(packs):
    x=62+(i%2)*755;y=222+(i//2)*132;p+=box(x,y,705,116,.94,5)+txt(x+22,y+47,23,price,'#ffd34f',23,'700')+txt(x+205,y+45,25,amount+' 有償コイン','#f7fbff',25,'700')+txt(x+390,y+26,13,'初回購入 2倍','#00d2ed',13,'600')+btn(x+488,y+47,194,'内容を確認')
p+=txt(64,757,15,'決済前に商品・年齢区分・プラットフォーム価格を確認します。','#d0dce5',15)
emit('15-store-coins','home-paddock.png',p,'有償コインショップ')

# 16. Direct cosmetics
p=box(32,42,1536,790,.93)+head('見た目アイテム / 直接販売','抽選なし。購入前にアイテムとレア度を確認できます。')
products=[('Cosmetics/silk-jacket.png','紅の勝負服','SSR / COSMETIC','¥480 価格案'),('Cosmetics/bridle.png','真鍮飾りの頭絡','SR / COSMETIC','¥320 価格案'),('Cosmetics/saddlecloth.png','星刺繍の鞍下布','R / COSMETIC','¥320 価格案'),('Cosmetics/stable-plaque.png','厩舎のネームプレート','SSR / COSMETIC','¥480 価格案'),('Food/premium-bowl.png','星柄の厩舎ボウル','SSR / DECOR ONLY','¥240 価格案')]
for i,(asset,title,rarity,price) in enumerate(products):
    x=64+(i%3)*508;y=220+(i//3)*252;p+=card(x,y,470,230,title,rarity,'#ffd34f')+image(asset,x+7,y+13,146,200)+txt(x+164,y+49,18,title,'#f7fbff',18,'700')+txt(x+164,y+83,14,rarity,'#ffd34f',14,'600')+txt(x+164,y+133,15,price,'#00d2ed',15)+btn(x+164,y+166,286,'内容を確認')
emit('16-store-cosmetics','home-paddock.png',p,'見た目アイテムショップ')

# 17. Season pass
p=box(36,46,1528,772,.93)+head('TURF SERIES / SEASON 01','無料・プレミアム報酬ライン / レースでティアを獲得')+box(66,130,405,604,.94)
p+=image('Cosmetics/jockey-violet.png',94,142,350,420)+txt(90,600,23,'紫の星の勝負服','#ffd34f',23,'700')+txt(90,641,17,'プレミアムパス購入時に即時獲得','#f7fbff',17)
free=['コイン 100','R お手入れ','コイン 100','鞍のタグ','コイン 200'];premium=['勝負服セット','SRチケット','厩舎の飾り','コイン 300','SSR馬具']
for i in range(5):
    x=520+i*198;p+=card(x,217,180,178,'ティア '+str(i+1),'無料報酬')+txt(x+14,256,16,'ティア '+str(i+1),'#f7fbff',16,'700')+txt(x+14,291,13,'無料報酬','#00d2ed',13)+txt(x+14,356,16,free[i],'#f7fbff',16,'600')+card(x,412,180,178,'ティア '+str(i+1),'プレミアム','#ffd34f')+txt(x+14,451,16,'ティア '+str(i+1),'#f7fbff',16,'700')+txt(x+14,486,13,'プレミアム','#ffd34f',13)+txt(x+14,552,16,premium[i],'#f7fbff',16,'600')
p+=box(520,594,980,74,.94)+txt(544,638,20,'30日間 1,000円 / 更新はプラットフォーム設定から','#ffd34f',20,'700')+btn(520,683,470,'プレミアムパスを確認')
emit('17-season-pass','home-paddock.png',p,'シーズンパス')

# 18. Purchase review and age gate
p=box(225,105,1150,690,.95)+head('購入確認 / 年齢・決済チェック','決済前に商品と条件を確認します。')+txt(278,248,18,'選択アイテム','#d0dce5',18)+txt(278,302,36,'星刺繍の鞍下布','#f7fbff',36,'700')+txt(278,352,22,'見た目アイテム ・ 320円（価格案）','#ffd34f',22,'600')+line(278,398,1000,'#607d91',1)+txt(278,452,19,'年齢区分','#00d2ed',19,'700')
for i,label in enumerate(['16歳未満','16〜17歳','18歳以上']):
    x=278+i*235;p+=box(x,470,210,70,.86,5)+txt(x+25,513,20,label,'#f7fbff',20,'600')
p+=txt(278,582,17,'年齢別月間上限と保護者同意のルール設定が必要です。','#f7fbff',17)+box(278,625,995,88,.94,5)+txt(300,660,19,'決済停止中 / プラットフォーム未接続','#ffb68e',19,'700')+txt(300,692,15,'価格は案です。このプロトタイプで請求は発生しません。','#ddd2cc',15)+btn(278,736,290,'ショップに戻る')
emit('18-purchase-review','home-paddock.png',p,'購入確認と年齢区分')

OUT.joinpath('README.md').write_text('''# Figma screen exports

Import each SVG as an individual frame in Figma by dragging it onto the canvas. Text and UI shapes remain editable; generated key art is embedded. Japanese is the default display language.

01 Title · 02 First ride · 03 Partner naming · 04 Scout · 05 Scout results · 06 Home · 07 Stable · 08 Race entry · 09 Ranked race · 10 Race result · 11 Wardrobe · 12 Course looks · 13 Conditions · 14 Care/feed · 15 Coin shop · 16 Cosmetics shop · 17 Season pass · 18 Purchase review.

Screen 11 embeds five generated 3D partner previews. PNG quick-review captures are available for screens 01–10; screens 11–18 are vector SVG frames. The Figma connector is not exposed in the current tool session, so no document was changed remotely. These SVGs are ready to import.
''',encoding='utf-8')

with zipfile.ZipFile(OUT/'muchi-figma-screens.zip','w',compression=zipfile.ZIP_DEFLATED,compresslevel=6) as bundle:
    for svg in sorted(OUT.glob('*.svg')):bundle.write(svg,svg.name)
