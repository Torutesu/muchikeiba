"""Build the Figma import kit after export-design.cjs (stdlib only)."""
from pathlib import Path
import json
import zipfile
import xml.etree.ElementTree as ET

frontend = Path(__file__).resolve().parent.parent
screens = frontend / 'design/screens'
entries = json.loads((screens / 'manifest.json').read_text())
items = []
for entry in entries:
    svg = (screens / (entry['name'] + '.svg')).read_text()
    ET.fromstring(svg)
    items.append(dict(entry, svg=svg))
ET.parse(frontend / 'design/screens.svg')
plugin_manifest = {
    'name': 'Muchikeiba Detailed UI Import',
    'id': 'muchikeiba-detailed-ui-import',
    'api': '1.0.0', 'main': 'code.js', 'editorType': ['figma'],
    'networkAccess': {'allowedDomains': ['none']},
}
code = 'const screens = ' + json.dumps(items, ensure_ascii=False) + ';\n' + '''
const frames=[];
try {
 let y=0;
 for(let i=0;i<screens.length;i+=2){
  const row=screens.slice(i,i+2);
  row.forEach((screen,column)=>{
   const node=figma.createNodeFromSvg(screen.svg);
   const frame=figma.createFrame();frame.name=screen.name+' / '+screen.title;
   frame.resize(screen.width,screen.height);frame.x=column*1460;frame.y=y;
   frame.fills=[];frame.clipsContent=true;frame.appendChild(node);node.x=0;node.y=0;
   node.name='Frontend SVG';frames.push(frame);
  });
  y+=Math.max(...row.map(s=>s.height))+100;
 }
 figma.currentPage.selection=frames;figma.viewport.scrollAndZoomIntoView(frames);
 figma.closePlugin(screens.length+'種類の画面を取り込みました');
} catch(error){figma.closePlugin('Import failed: '+String(error));}
'''
readme = '''# ムチ一閃・詳細 UI / Figma 取り込み

screens.svg を Figma のキャンバスにドラッグすると25種類を取り込めます。
個別画面は screens/ 内の SVG、ブラウザの見た目の参照は同名 PNG です。

名前付きフレームで取り込む場合は Figma デスクトップの Plugins → Development → Import plugin from manifest で figma-plugin/manifest.json を選択して実行してください。ネットワークアクセスなしで25フレームを作成します。Figma 実機でのプラグイン動作は未検証です。

SVG は DOM の近似変換です。CSS グラデーション・影・フィルター等は PNG と差が出ます。Auto Layout、再利用コンポーネント、プロトタイプ接続は含みません。Figma ファイルへの直接投稿はしていません。

ブラウザ UI はローカルの固定デモです。サーバー・決済・抽選・オンライン対戦には未接続です。
'''
archive = frontend / 'design/muchikeiba-figma-detailed.zip'
with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED) as out:
    for entry in entries:
        for ext in ('svg', 'png'):
            p = screens / (entry['name'] + '.' + ext)
            out.write(p, 'muchikeiba-detailed/screens/' + p.name)
    out.write(screens / 'manifest.json', 'muchikeiba-detailed/screens/manifest.json')
    out.write(frontend / 'design/screens.svg', 'muchikeiba-detailed/screens.svg')
    out.writestr('muchikeiba-detailed/figma-plugin/manifest.json', json.dumps(plugin_manifest, indent=2))
    out.writestr('muchikeiba-detailed/figma-plugin/code.js', code)
    out.writestr('muchikeiba-detailed/README.md', readme)
with zipfile.ZipFile(archive) as check:
    assert check.testzip() is None
print(f'Packaged {len(entries)} validated screens: {archive}')
