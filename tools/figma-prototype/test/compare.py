"""Side-by-side sheets: Codex's designs vs. the prototype screenshots.

  club UI    : frontend/design/screens/<name>.png (25 detailed screens)  vs  .screens/club-<name>.png
  ムチ一閃 UI : unity/design/figma-screens/<NN-name>.png (01–18)           vs  .screens/u-<nn>-<name>.png (e2e.cjs)
Each sheet also prints a mean absolute pixel difference (0 = identical, after scaling to the design's size),
so changes in fidelity show up as numbers, not only as pictures. Screens 11–18 have no PNG export: render them first
with render-design.cjs (they are read from <out-dir>/_render_<name>.png).

usage: python3 compare.py <repo-root> <screens-dir> <out-dir>
"""
import json, os, re, sys
from PIL import Image, ImageChops, ImageDraw, ImageStat

root, shots, out = sys.argv[1], sys.argv[2], sys.argv[3]
os.makedirs(out, exist_ok=True)


def find(name):
    """The e2e screenshot u-<nn>-<name>.png (the screen number changes when the walkthrough grows)."""
    for f in sorted(os.listdir(shots)):
        m = re.match(r'^u-\d+-(.+)\.png$', f)
        if m and m.group(1) == name:
            return os.path.join(shots, f)
    return None


def diff(a, b):
    b = b.resize(a.size)
    return sum(ImageStat.Stat(ImageChops.difference(a, b)).mean) / 3


def letterbox_crop(im):
    """The landscape-phone screenshots (844×390) letterbox the 16:9 stage: compare the stage only."""
    w, h = im.size
    sw = round(h * 16 / 9)
    if sw < w:
        x = (w - sw) // 2
        return im.crop((x, 0, x + sw, h))
    return im


def sheet(dp, sp, label, name, width=700):
    a = Image.open(dp).convert('RGB'); b = letterbox_crop(Image.open(sp).convert('RGB'))
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
# 1) club UI (club.html) vs Codex's 25 detailed screens
design = os.path.join(root, 'frontend/design/screens')
for e in json.load(open(os.path.join(design, 'manifest.json'))):
    sp = os.path.join(shots, f"club-{e['name']}.png")
    if not os.path.exists(sp):
        print('skip', e['name']); continue
    rows.append((e['name'], e['title'], sheet(os.path.join(design, e['name'] + '.png'), sp, e['name'] + ' ' + e['title'], 'club-' + e['name'])))
# 2) ムチ一閃 UI (index.html) vs Codex's Figma screens 01–18
udesign = os.path.join(root, 'unity/design/figma-screens')
pairs = [
    ('01-title', 'title'), ('02-first-ride', 'tutorial-whip-chance'), ('03-partner-naming', 'naming'),
    ('04-scout', 'free-scout'), ('05-scout-results', 'scout-list'), ('06-home', 'home-day3'), ('07-stable', 'stable'),
    ('08-race-entry', 'race-lobby'), ('09-ranked-race', 'race-hud-straight-whip'), ('10-race-result', 'race-result-day7'),
    ('11-wardrobe', 'wardrobe'), ('12-course-looks', 'course-looks'), ('13-conditions', 'conditions'), ('14-care-feed', 'care'),
    ('15-store-coins', 'shop-coins'), ('16-store-cosmetics', 'shop-looks'), ('17-season-pass', 'season-pass'), ('18-purchase-review', 'purchase-registered'),
]
for d, s in pairs:
    dp = os.path.join(udesign, d + '.png')
    if not os.path.exists(dp):
        dp = os.path.join(out, '_render_' + d + '.png')  # rendered from SVG by render-design.cjs when no PNG exists
    sp = find(s)
    if not (os.path.exists(dp) and sp):
        print('skip', d, s); continue
    rows.append(('muchi/' + d, s, sheet(dp, sp, d, 'muchi-' + d)))
for name, title, score in rows:
    print(f'{name:28s} {score:5.1f}  {title}')
print('compare sheets in', out)
