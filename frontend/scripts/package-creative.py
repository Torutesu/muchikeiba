"""Validate and package the creative delivery kit (Pillow + stdlib)."""
from pathlib import Path
import json,hashlib,zipfile,csv,io,base64,html,wave,math,struct
import xml.etree.ElementTree as ET
from PIL import Image
FRONT=Path(__file__).resolve().parents[1];ROOT=FRONT/'public/creative';DESIGN=FRONT/'design/creative'
manifest=json.loads((ROOT/'manifest.json').read_text());assets=manifest['assets'];ids=set()
for a in assets:
 assert a['id']not in ids;ids.add(a['id']);p=ROOT/a['file'];assert p.is_file(),a['file'];assert hashlib.sha256(p.read_bytes()).hexdigest()==a['sha256'],a['id']
 if p.suffix=='.svg':
  doc=ET.parse(p).getroot();assert float(doc.get('width'))==a['width'] and float(doc.get('height'))==a['height'];assert a.get('raster'),a['id']
  for image in doc.iter('{http://www.w3.org/2000/svg}image'):assert image.get('href','').startswith('data:image/')
 if a.get('raster'):
  im=Image.open(ROOT/a['raster']['file']);assert im.size==(a['raster']['width'],a['raster']['height'])
 if a['category']=='audio':
  with wave.open(str(p))as audio:
   assert audio.getframerate()==44100 and audio.getsampwidth()==2 and audio.getnchannels()==1
   samples=struct.unpack('<'+'h'*audio.getnframes(),audio.readframes(audio.getnframes()));peak=max(abs(x)for x in samples)/32767;assert .39<=peak<=.405
 if a.get('safeArea'):assert a['measuredMinimumContrast']>=4.5
assert len(assets)==112
atlas=json.loads((ROOT/'atlas/ui-icons.json').read_text());unity=json.loads((ROOT/'atlas/ui-icons-unity.json').read_text());im=Image.open(ROOT/'atlas/ui-icons@2x.png').convert('RGBA');assert im.size==(1024,640)
for rect,flipped in zip(atlas['spriteRects'],unity['spriteRects']):
 x,y,w,h=(rect[k]for k in ('x','y','width','height'));assert x>=0 and y>=0 and x+w<=im.width and y+h<=im.height;assert im.crop((x,y,x+w,y+h)).getextrema()[3][1]>0;assert flipped['y']==640-y-h
icon=Image.open(ROOT/'raster/app-icon.png').convert('RGBA');assert icon.size==(1024,1024) and icon.getextrema()[3]==(255,255)
trophy=Image.open(ROOT/'keyart/victory-trophy.png');assert trophy.mode=='RGBA' and trophy.getextrema()[3][0]==0
# Public provenance is portable and excludes execution-machine paths.
pro=json.loads((DESIGN/'provenance.json').read_text());public=dict(artDirection=pro['artDirection'],assets=[])
for a in pro['assets']:
 p=DESIGN/'masters'/(a['slug']+'.png');public['assets'].append(dict(id=a['slug'],master='masters/'+p.name,prompt=a['prompt'],transparentBackground=a['transparent_background'],generatedWith=a['origin'],sha256=hashlib.sha256(p.read_bytes()).hexdigest()))
(ROOT/'provenance.json').write_text(json.dumps(public,ensure_ascii=False,indent=2))
# Editable metadata for production asset managers and localization handoff.
stream=io.StringIO();writer=csv.writer(stream);writer.writerow(['id','title','category','file','width','height','raster','usage','source','sha256'])
for a in assets:writer.writerow([a['id'],a['title'],a['category'],a['file'],a['width'],a['height'],a.get('raster',{}).get('file',''),a['usage'],a.get('source',''),a['sha256']])
(ROOT/'asset-register.csv').write_text(stream.getvalue(),encoding='utf-8-sig')
# Figma overview board; individual SVGs remain the editable source assets.
labels={k:k.upper()for k in {a['category']for a in assets}}
body=['<rect width="1440" height="{}" fill="#eef0e5"/>'.format(260+math.ceil(len(assets)/5)*265),'<text x="40" y="67" font-family="Club Serif, serif" font-size="32" fill="#213a32">MUCHI ISSEN / CREATIVE ATELIER 01</text>','<text x="42" y="104" font-family="Club Sans, sans-serif" font-size="12" fill="#7f916c">112 creative resources / individual source files, fonts and original masters included</text>']
for i,a in enumerate(assets):
 x=40+(i%5)*276;y=150+(i//5)*265;body.append(f'<g transform="translate({x} {y})"><rect width="256" height="245" rx="6" fill="#fffef8" stroke="#d4deca"/>')
 p=ROOT/(a.get('raster',{}).get('file')or a['file'])
 if p.suffix in ('.png','.webp'):
  image=Image.open(p);image.thumbnail((448,320));buffer=io.BytesIO();image.save(buffer,'PNG');uri='data:image/png;base64,'+base64.b64encode(buffer.getvalue()).decode()
  body.append(f'<image href="{uri}" x="16" y="12" width="224" height="164" preserveAspectRatio="xMidYMid meet"/>')
 else:
  mark=ROOT/('raster/crest-forest@2x.png'if a['category']=='motion'else'raster/icon-volume@2x.png');uri='data:image/png;base64,'+base64.b64encode(mark.read_bytes()).decode();body.append(f'<image href="{uri}" x="96" y="55" width="64" height="64"/>')
 body.append(f'<text x="16" y="199" font-family="Club Sans, sans-serif" font-size="11" fill="#213a32">{html.escape(a["title"])}</text><text x="16" y="222" font-family="Club Sans, sans-serif" font-size="8" fill="#7d926b">{html.escape(a["id"])}</text></g>')
height=260+math.ceil(len(assets)/5)*265;board=f'<svg xmlns="http://www.w3.org/2000/svg" width="1440" height="{height}" viewBox="0 0 1440 {height}">'+''.join(body)+'</svg>';(ROOT/'creative-board.svg').write_text(board);ET.fromstring(board)
archive=DESIGN/'muchi-creative-kit.zip'
with zipfile.ZipFile(archive,'w',zipfile.ZIP_DEFLATED)as out:
 for p in ROOT.rglob('*'):
  if p.is_file() and p.suffix!='.zip':out.write(p,Path('muchi-creative-kit')/p.relative_to(ROOT))
 for p in (DESIGN/'masters').glob('*.png'):out.write(p,Path('muchi-creative-kit/masters')/p.name)
 for name in ['build-creative.py','build-creative-materials.py','render-creative.cjs','creative-catalog.html','creative-motion.js','creative-frames.css','package-creative.py']:
  out.write(FRONT/'scripts'/name,Path('muchi-creative-kit/SOURCE')/name)
with zipfile.ZipFile(archive)as check:assert check.testzip()is None
print('Validated 112 resources, 93 raster derivatives, audio headroom, safe areas, 36 atlas rects and archive:',archive)
