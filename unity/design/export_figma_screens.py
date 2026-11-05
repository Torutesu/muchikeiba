from pathlib import Path
import base64
from html import escape

ROOT = Path(__file__).resolve().parents[1]
ART = ROOT / 'Assets' / 'Resources' / 'Art'
OUT = ROOT / 'design' / 'figma-screens'
OPT_ART = ROOT / 'design' / 'figma-optimized-art'
OUT.mkdir(parents=True, exist_ok=True)
W,H=1672,941
NAVY='#08182a'
CYAN='#00d2ed'
GOLD='#ffd34f'
WHITE='#f7fbff'
FONT='Noto Sans CJK JP, Arial, sans-serif'
JA={
'RACE  /  START':'レースをはじめる','MUCHI ISSEN  /  JOCKEY RACING':'ジョッキーレーシングゲーム',
'A RACE IS WON IN THE LAST STRAIGHT.':'最後の直線で、勝負が決まる。','TAP TO RIDE':'タップして騎乗',
'SEASON 01   /   TURF SERIES':'シーズン 01　/　芝シリーズ','200 m':'残り 200 m',
'STAMINA':'スタミナ','TIME YOUR SPUR':'タイミングを合わせよう','SPUR':'仕掛ける',
'FIRST RIDE  /  TUTORIAL':'初めてのレース　/　チュートリアル',
'01  /  YOUR FIRST PARTNER':'01　/　はじめての相棒','NAME YOUR PARTNER':'相棒に名前をつけよう',
'A good name makes a great story.':'名前をつけたら、物語のはじまり。','PARTNER NAME':'相棒の名前',
'AKATSUKI':'アカツキ','SPEED   84        STAMINA   78':'スピード　84　　 スタミナ　78',
'POWER   81        CLOSER':'パワー　81　　 脚質　追込','You can change the name later.':'名前はあとから変更できます。',
'CONFIRM  /  CONTINUE':'この名前に決定　/　つづける','WELCOME SCOUT  /  FREE 10':'初回無料スカウト',
'MEET YOUR NEXT':'新しい相棒に','PARTNER':'出会おう','SR+  GUARANTEED':'SR以上 1頭確定',
'Ten horses. One new story.':'10頭との出会い。新しい物語。','Your first scout is free.':'初回のスカウトは無料です。',
'At least one SR horse is included.':'SR以上の馬が1頭以上登場します。',
'PREVIEW ONLY  /  NO CURRENCY USED':'プレビュー　/　通貨は消費されません',
'FREE 10-HORSE SCOUT':'無料10連スカウト','NEW PARTNERS  /  FIRST SCOUT':'新しい仲間　/　初回スカウト',
'KOHAKU':'コハク','SR  /  FRONT RUNNER':'SR　/　先行','A bold start. A steady stride.':'積極的な走りと、安定した末脚。',
'TURF  /  SHORT DISTANCE':'芝　/　短距離','SHIRANAMI':'シラナミ','SR  /  CLOSER':'SR　/　追込',
'Eight more horses joined your stable.':'ほかにも8頭が厩舎に加わりました。','GO TO HOME':'ホームへ',
'JOCKEY 001  /  SEASON 01':'ジョッキー 001　/　シーズン 01','ROOKIE II':'ルーキー II',
'◎  1,200    ◈  240':'◎  1,200　　◈  240','YOUR PARTNER':'あなたの相棒',
'CLOSER  /  TURF  /  2,000m':'追込　/　芝　/　2,000m','STABLE':'厩舎','SCOUT':'スカウト',
'MISSIONS':'ミッション','RANKED RACE  /  ENTER':'ランク戦へ出走','HOME   ·   STABLE   ·   RACE':'ホーム　・　厩舎　・　レース',
'STABLE  /  01 OF 20':'厩舎　/　20頭中 1頭','SSR  /  CLOSER':'SSR　/　追込','SPEED':'スピード',
'STAMINA':'スタミナ','POWER':'パワー','APTITUDE':'適性','TURF A    /    MIDDLE A    /    GOOD A':'芝 A　/　中距離 A　/　良馬場 A',
'SELECT FOR RACE':'この馬で出走','RANKED RACE  /  ENTRY':'ランク戦　/　出走登録',
'GREENFIELD CUP':'グリーンフィールド杯','TURF  /  2,000 m  /  LEFT':'芝　/　2,000m　/　左回り',
'HOME STRAIGHT  ━━━━━ FINISH':'直線コース　━━━━━　ゴール',
'12 runners  /  CPU fills open gates':'最大12頭　/　空き枠はCPUが参加',
'Ranked race  /  ability cap enabled':'ランク戦　/　能力上限あり','Partner  /  AKATSUKI':'出走馬　/　アカツキ',
'ENTER THE RACE':'出走する','420 m':'残り 420 m','3 / 12':'3位　/　12位',
'TIME YOUR SPUR':'仕掛けのタイミング','SPURS':'仕掛け','FINAL STRAIGHT':'最後の直線',
'HOLD TO REIN  /  STEER WITH ARROWS':'手綱を引く　/　矢印で進路変更',
'SPUR WINDOW':'仕掛けの好機','HOLD YOUR LINE':'進路を保て','PERFECT TIMING':'完璧なタイミング','SPUR!':'仕掛ける！',
'RACE RESULT  /  GREENFIELD CUP':'レース結果　/　グリーンフィールド杯','VICTORY':'勝利',
'AKATSUKI  /  TURF 2,000 m':'アカツキ　/　芝 2,000m','TIME':'タイム','RANK POINTS':'ランクポイント',
'Your first race is complete.':'初めてのレース、おつかれさま。','MEET YOUR PARTNER':'相棒に会いにいく'
}

def emit(name, art, pieces, title):
    optimized=OPT_ART/(Path(art).with_suffix('.jpg'))
    source=optimized if optimized.exists() else ART/art
    mime='image/jpeg' if optimized.exists() else 'image/png'
    raw=base64.b64encode(source.read_bytes()).decode()
    language=box(1500,130,125,52,.82,4)+txt(1534,163,17,'EN',WHITE,17,'700',2)
    svg=f'''<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="{W}" height="{H}" viewBox="0 0 {W} {H}"><title>{title}</title><image x="0" y="0" width="{W}" height="{H}" preserveAspectRatio="xMidYMid slice" href="data:{mime};base64,{raw}" xlink:href="data:{mime};base64,{raw}"/>{pieces}{language}</svg>'''
    (OUT/f'{name}.svg').write_text(svg)

def txt(x,y,s,text,color=WHITE,size=25,weight='600',spacing=0):
    text=escape(JA.get(text,text))
    return f'<text x="{x}" y="{y}" fill="{color}" font-size="{size}" font-weight="{weight}" font-family="{FONT}" letter-spacing="{spacing}">{text}</text>'
def box(x,y,w,h,opacity=.87,r=4):
    return f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{r}" fill="{NAVY}" fill-opacity="{opacity}"/>'
def line(x,y,w,color=CYAN,h=3):
    return f'<rect x="{x}" y="{y}" width="{w}" height="{h}" fill="{color}"/>'
def btn(x,y,w,label):
    return f'<path d="M{x} {y}h{w}l-25 76h-{w}z" fill="{CYAN}"/><path d="M{x+3} {y+2}h{w-5}" stroke="#b9f7ff" stroke-width="2"/>'+txt(x+28,y+48,23,label,NAVY,23,'700',1.5)+f'<path d="M{x+w-62} {y+25}l14 14-14 14m12-28 14 14-14 14" fill="none" stroke="{NAVY}" stroke-width="3"/>'

emit('01-title','title-screen.png',
     '<defs><linearGradient id="shade"><stop stop-color="#061524" stop-opacity=".85"/><stop offset=".48" stop-color="#071b2b" stop-opacity=".43"/><stop offset=".78" stop-color="#071b2b" stop-opacity="0"/></linearGradient></defs><rect width="1672" height="941" fill="url(#shade)"/>'+line(82,138,114)+txt(80,270,100,'ムチ一閃',WHITE,102,'700',4)+txt(87,325,21,'MUCHI ISSEN  /  JOCKEY RACING','#d7eaf4',21,'600',7)+line(87,380,65,GOLD,4)+txt(82,478,54,'最後の直線を、',WHITE,54,'700')+txt(82,551,54,'相棒と。',WHITE,54,'700')+txt(88,612,19,'A RACE IS WON IN THE LAST STRAIGHT.','#e0edf4',19,'500',2)+btn(82,684,422,'RACE  /  START')+txt(91,823,15,'TAP TO RIDE',WHITE,15,'500',4)+txt(1190,884,14,'SEASON 01   /   TURF SERIES',WHITE,14,'500',3), 'ムチ一閃 / タイトル')

race_top = box(35,32,260,82)+txt(58,84,31,'200 m',WHITE,32,'700')+box(1355,32,275,86)+txt(1395,88,45,'3 / 12',GOLD,42,'700')
stamina=box(34,776,450,112)+txt(61,812,17,'STAMINA',WHITE,17,'700',2)+f'<rect x="60" y="833" width="390" height="18" rx="9" fill="#19364b"/><rect x="60" y="833" width="282" height="18" rx="9" fill="{CYAN}"/>'
spur='<circle cx="1504" cy="792" r="75" fill="#07182b" fill-opacity=".88" stroke="#ffe661" stroke-width="7"/><circle cx="1504" cy="792" r="63" fill="none" stroke="#fff1a6" stroke-opacity=".75" stroke-width="2"/>'+txt(1457,801,23,'SPUR',GOLD,23,'800',1)
pips=box(1322,677,260,54,.88,20)+''.join(f'<circle cx="{1352+i*38}" cy="704" r="11" fill="{GOLD if i<5 else "#435368"}"/>' for i in range(6))
feedback=box(565,183,555,74,.78,4)+txt(614,231,25,'TIME YOUR SPUR',GOLD,25,'700',2)

emit('02-first-ride','first-ride.png', race_top+stamina+spur+feedback+txt(35,740,16,'FIRST RIDE  /  TUTORIAL',WHITE,16,'600',2), '初回チュートリアルレース')

panel=box(970,52,630,840,.88)
name_ui=panel+line(1020,105,90)+txt(1020,167,20,'01  /  YOUR FIRST PARTNER',CYAN,20,'700',2)+txt(1020,235,34,'NAME YOUR PARTNER',WHITE,34,'700',1)+txt(1020,288,19,'A good name makes a great story.','#d5e1e9',19)+txt(1020,365,17,'PARTNER NAME',CYAN,17,'700',2)+f'<rect x="1020" y="391" width="500" height="75" rx="4" fill="#122b40" stroke="#7394a8" stroke-width="2"/>'+txt(1042,440,29,'AKATSUKI',WHITE,29,'600',1)+txt(1020,528,22,'SPEED   84        STAMINA   78',WHITE,22,'600')+txt(1020,570,22,'POWER   81        CLOSER',WHITE,22,'600')+txt(1020,637,16,'You can change the name later.','#b9c8d3',16)+btn(1020,686,500,'CONFIRM  /  CONTINUE')+txt(1020,835,15,'PARTNER PROFILE  /  SSR','#d5e1e9',15,'500',2)
emit('03-partner-naming','partner-naming.png',name_ui,'相棒の命名')

scout=box(38,50,560,830,.89)+line(78,100,82)+txt(78,151,18,'WELCOME SCOUT  /  FREE 10',CYAN,18,'700',2)+txt(78,225,44,'MEET YOUR NEXT',WHITE,44,'700')+txt(78,282,44,'PARTNER',WHITE,44,'700')+f'<path d="M78 338h175l-14 50H78z" fill="{GOLD}"/>'+txt(91,372,18,'SR+  GUARANTEED',NAVY,18,'800',1)+txt(78,463,23,'Ten horses. One new story.',WHITE,23,'600')+txt(78,520,20,'Your first scout is free.',WHITE,20)+txt(78,557,20,'At least one SR horse is included.',WHITE,20)+txt(78,624,15,'PREVIEW ONLY  /  NO CURRENCY USED','#c0d1dc',15,'500',1)+btn(78,685,468,'FREE 10-HORSE SCOUT')+txt(79,835,15,'PROBABILITIES SHOWN BEFORE PAID SCOUTS','#c0d1dc',15,'500',1)
emit('04-scout','scout-reveal.png',scout,'初回無料スカウト')

reveal=box(38,50,580,830,.91)+line(78,100,82)+txt(78,151,18,'NEW PARTNERS  /  FIRST SCOUT',CYAN,18,'700',2)+txt(78,230,48,'KOHAKU',WHITE,48,'700',2)+txt(78,275,20,'SR  /  FRONT RUNNER',GOLD,20,'700',2)+txt(78,337,20,'A bold start. A steady stride.',WHITE,20)+txt(78,377,17,'TURF  /  SHORT DISTANCE', '#d5e2e9',17,'600',1)+line(78,432,480,'#7ea1b6',1)+txt(78,495,36,'SHIRANAMI',WHITE,36,'700',1)+txt(78,540,19,'SR  /  CLOSER',GOLD,19,'700',2)+txt(78,594,18,'Eight more horses joined your stable.',WHITE,18)+btn(78,704,468,'GO TO HOME')
emit('05-scout-results','scout-reveal.png',reveal,'スカウト結果')

home=box(34,33,490,105,.78)+txt(59,72,19,'JOCKEY 001  /  SEASON 01',CYAN,19,'700',2)+txt(59,112,22,'ROOKIE II',WHITE,22,'700',1)+box(1235,35,362,80,.77)+txt(1264,84,24,'◎  1,200    ◈  240',GOLD,24,'700')+box(35,602,470,216,.79)+txt(65,646,17,'YOUR PARTNER',CYAN,17,'700',2)+txt(65,705,45,'AKATSUKI',WHITE,45,'700',2)+txt(65,755,18,'CLOSER  /  TURF  /  2,000m',WHITE,18,'600',1)+box(1190,234,405,335,.77)+txt(1230,291,25,'STABLE',WHITE,25,'700',2)+line(1227,310,330,'#96adbb',1)+txt(1230,375,25,'SCOUT',WHITE,25,'700',2)+line(1227,394,330,'#96adbb',1)+txt(1230,460,25,'MISSIONS',WHITE,25,'700',2)+btn(1160,665,435,'RANKED RACE  /  ENTER')+txt(55,877,15,'HOME   ·   STABLE   ·   RACE','#e0eaf1',15,'600',2)
emit('06-home','home-paddock.png',home,'ホーム')

stable=box(980,53,620,838,.89)+line(1025,104,92)+txt(1025,151,18,'STABLE  /  01 OF 20',CYAN,18,'700',2)+txt(1025,220,44,'AKATSUKI',WHITE,44,'700',2)+txt(1025,262,19,'SSR  /  CLOSER',GOLD,19,'700',2)
for i,(label,value,pct) in enumerate([('SPEED','84',.84),('STAMINA','78',.78),('POWER','81',.81)]):
    y=340+i*93;stable+=txt(1025,y,17,label,WHITE,17,'700',1)+txt(1474,y,20,value,GOLD,20,'700')+f'<rect x="1025" y="{y+17}" width="465" height="8" rx="4" fill="#23394a"/><rect x="1025" y="{y+17}" width="{465*pct:.0f}" height="8" rx="4" fill="{CYAN}"/>'
stable+=txt(1025,641,17,'APTITUDE',CYAN,17,'700',1)+txt(1025,682,18,'TURF A    /    MIDDLE A    /    GOOD A',WHITE,18,'600')+btn(1025,729,485,'SELECT FOR RACE')
emit('07-stable','partner-naming.png',stable,'厩舎 / 馬詳細')

entry=box(965,49,635,840,.91)+line(1010,104,92)+txt(1010,150,18,'RANKED RACE  /  ENTRY',CYAN,18,'700',2)+txt(1010,224,36,'GREENFIELD CUP',WHITE,36,'700',1)+txt(1010,277,20,'TURF  /  2,000 m  /  LEFT',GOLD,20,'700',1)+box(1010,321,520,150,.78)+txt(1042,378,20,'HOME STRAIGHT  ━━━━━ FINISH',WHITE,20,'700')+txt(1010,534,19,'12 runners  /  CPU fills open gates',WHITE,19)+txt(1010,579,19,'Ranked race  /  ability cap enabled',WHITE,19)+txt(1010,624,19,'Partner  /  AKATSUKI',WHITE,19)+btn(1010,691,500,'ENTER THE RACE')
emit('08-race-entry','first-ride.png',entry,'レース登録')

hud=race_top.replace('200 m','420 m')+stamina+spur+pips+box(570,40,500,68,.74)+txt(612,83,18,'GREENFIELD CUP  /  FINAL STRAIGHT',WHITE,18,'700',1)
# Mini-map on a dark plate, course oval is a vector layer.
hud+=box(1430,650,190,104,.83,20)+f'<path d="M1473 705 C1473 670 1585 670 1585 705 C1585 738 1473 738 1473 705Z" fill="none" stroke="#d5e3ee" stroke-width="3"/>'+''.join(f'<circle cx="{1486+i*10}" cy="{701+(i%3)*3}" r="4" fill="{GOLD if i==0 else CYAN}"/>' for i in range(8))+txt(58,742,15,'HOLD TO REIN  /  STEER WITH ARROWS','#f1f7fb',15,'600',1)
emit('09-ranked-race','first-ride.png',hud,'ランクレース / HUD')

result=box(35,50,630,840,.91)+line(79,100,88)+txt(79,151,18,'RACE RESULT  /  GREENFIELD CUP',CYAN,18,'700',2)+txt(79,294,105,'1ST',GOLD,105,'800',3)+txt(81,356,34,'VICTORY',WHITE,34,'700',2)+txt(81,408,20,'AKATSUKI  /  TURF 2,000 m',WHITE,20,'600',1)+line(81,457,500,'#88a8bb',1)+txt(81,515,16,'TIME',CYAN,16,'700',2)+txt(81,564,32,'1:58.4',WHITE,32,'700')+txt(345,515,16,'RANK POINTS',CYAN,16,'700',2)+txt(345,564,32,'+120 pt',GOLD,32,'700')+txt(81,635,18,'Your first race is complete.',WHITE,18)+btn(81,697,500,'MEET YOUR PARTNER')
emit('10-race-result','race-result.png',result,'レース結果')

(OUT/'README.md').write_text('''# Figma screen exports\n\nImport each SVG as a separate frame with Figma's SVG import/drag-and-drop. Each file contains an embedded background image plus vector UI shapes and text. Screen labels are in filenames. These are individual landscape 16:9 screen designs, not a clickable prototype.\n\n01 Title · 02 First ride · 03 Partner naming · 04 Scout · 05 Scout results · 06 Home · 07 Stable · 08 Race entry · 09 Ranked race · 10 Race result.\n\nThe Figma connector is not exposed in the current tool session, so no document was modified remotely.\n''')
