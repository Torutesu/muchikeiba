"""Prepare versioned presentation assets and subset system Noto fonts (fonttools + brotli)."""
from pathlib import Path
import shutil
from PIL import Image
from fontTools import subset
from fontTools.ttLib import TTFont
ROOT=Path(__file__).resolve().parents[2]
front=ROOT/'frontend';public=front/'public'
(public/'art').mkdir(exist_ok=True);(public/'fonts').mkdir(exist_ok=True)
art=ROOT/'unity/Assets/Resources/Art'
for filename in ['title-screen.png','race-result.png','scout-reveal.png']:
 shutil.copyfile(art/filename,public/'art'/filename)
for folder,filenames in [('Courses',['spring-course.png'])]:
 for filename in filenames:shutil.copyfile(art/folder/filename,public/'art'/filename)
# Transcode without changing composition; keep browser transfers small.
for src in (public/'art').glob('*.png'):
 im=Image.open(src);im.thumbnail((1600,1100),Image.Resampling.LANCZOS);im.save(src.with_suffix('.webp'),'WEBP',quality=88,method=6);src.unlink()
text=''.join(p.read_text() for p in (front/'src').glob('*.js'))
for extra in [front/'scripts/creative-catalog.html',front/'scripts/build-creative.py',front/'design/creative/GUIDE.md']:
 if extra.exists():text+=extra.read_text()
unicodes=set(range(0x20,0x100))|set(range(0x3000,0x3100))|{ord(c) for c in text}
for source,name in [('NotoSansCJK-Regular.ttc','club-sans'),('NotoSansCJK-Bold.ttc','club-sans-bold'),('NotoSerifCJK-Regular.ttc','club-serif')]:
 font=TTFont('/usr/share/fonts/opentype/noto/'+source,fontNumber=0)
 options=subset.Options();options.flavor='woff2';sub=subset.Subsetter(options);sub.populate(unicodes=unicodes);sub.subset(font)
 family='Club Serif' if name=='club-serif' else 'Club Sans';style='Bold' if name.endswith('bold') else 'Regular'
 for name_id,value in [(1,family),(2,style),(4,family+' '+style),(6,family.replace(' ','')+'-'+style),(16,family),(17,style)]:
  for record in list(font['name'].names):
   if record.nameID==name_id:font['name'].setName(value,name_id,record.platformID,record.platEncID,record.langID)
 font.flavor='woff2';font.save(public/'fonts'/(name+'.woff2'))
 install=front/'design/fonts';install.mkdir(exist_ok=True);font.flavor=None;font.save(install/(name+'.otf'))
shutil.copyfile(ROOT/'unity/Assets/Resources/Fonts/Noto-CJK-copyright.txt',public/'fonts/LICENSE.txt')
print('Prepared presentation assets and',len(unicodes),'font codepoints')
