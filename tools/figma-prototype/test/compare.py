"""Side-by-side sheets: Codex's designs vs. the prototype screenshots.

  club UI  : frontend/design/screens/<name>.png (25 detailed screens)  vs  .screens/club-<name>.png
  Unity UI : unity/design/figma-screens/<name>.png                      vs  .screens/NN-<name>.png
Each sheet also prints a mean absolute pixel difference (0 = identical, after scaling to the design's size),
so changes in fidelity show up as numbers, not only as pictures.

usage: python3 compare.py <repo-root> <screens-dir> <out-dir>
"""
import json, os, sys
from PIL import Image, ImageChops, ImageDraw, ImageStat

root, shots, out = sys.argv[1], sys.argv[2], sys.argv[3]
os.makedirs(out, exist_ok=True)


def find(prefix):
    for f in sorted(os.listdir(shots)):
        if f.startswith(prefix + '.') or f[:-4] == prefix or (f[2:3] == '-' and f[3:-4] == prefix):
            return os.path.join(shots, f)
    return None


def diff(a, b):
    b = b.resize(a.size)
    return sum(ImageStat.Stat(ImageChops.difference(a, b)).mean) / 3


def sheet(dp, sp, label, name, width=700):
    a = Image.open(dp).convert('RGB'); b = Image.open(sp).convert('RGB')
    score = diff(a, b)
    ha = round(a.height * width / a.width); hb = round(b.height * width / b.width)
    s = Image.new('RGB', (width * 2 + 10, max(ha, hb) + 30), (20, 20, 20))
    s.paste(a.resize((width, ha)), (0, 30)); s.paste(b.resize((width, hb)), (width + 10, 30))
    d = ImageDraw.Draw(s)
    d.text((8, 8), f'Codex design: {label}  ({a.width}x{a.height})', fill=(255, 255, 255))
    d.text((width + 18, 8), f'Prototype: {os.path.basename(sp)}  ({b.width}x{b.height})  diff {score:.1f}', fill=(255, 255, 255))
    s.save(os.path.join(out, 'cmp-' + name + '.jpg'), quality=82)
    return score


rows = []
# 1) club UI vs Codex's 25 detailed screens
design = os.path.join(root, 'frontend/design/screens')
for e in json.load(open(os.path.join(design, 'manifest.json'))):
    sp = os.path.join(shots, f"club-{e['name']}.png")
    if not os.path.exists(sp):
        print('skip', e['name']); continue
    rows.append((e['name'], e['title'], sheet(os.path.join(design, e['name'] + '.png'), sp, e['name'] + ' ' + e['title'], 'club-' + e['name'])))
# 2) Unity UI vs Codex's Unity screens (unchanged pairs)
udesign = os.path.join(root, 'unity/design/figma-screens')
pairs = [
    ('01-title', '01-title'), ('02-first-ride', '03-first-ride-straight'), ('03-partner-naming', '05-partner-naming'),
    ('04-scout', '07-scout-free'), ('05-scout-results', '08-scout-results'), ('06-home', '09-home'), ('07-stable', '10-stable'),
    ('08-race-entry', '26-race-entry'), ('09-ranked-race', '28-ranked-race-straight'), ('10-race-result', '29-ranked-race-result'),
    ('11-wardrobe', '14-wardrobe'), ('12-course-looks', '16-course-looks'), ('13-conditions', '17-conditions'), ('14-care-feed', '18-care-feed'),
    ('15-store-coins', '19-store-coins'), ('16-store-cosmetics', '22-store-cosmetics'), ('17-season-pass', '24-season-pass'), ('18-purchase-review', '20-purchase-review'),
]
for d, s in pairs:
    dp = os.path.join(udesign, d + '.png')
    if not os.path.exists(dp):
        dp = os.path.join(out, '_render_' + d + '.png')  # rendered from SVG by render-design.cjs when no PNG exists
    sp = os.path.join(shots, s + '.png') if os.path.exists(os.path.join(shots, s + '.png')) else find(s)
    if not (os.path.exists(dp) and sp):
        print('skip', d, s); continue
    rows.append(('unity/' + d, '', sheet(dp, sp, d, 'unity-' + d)))
for name, title, score in rows:
    print(f'{name:28s} {score:5.1f}  {title}')
print('compare sheets in', out)
