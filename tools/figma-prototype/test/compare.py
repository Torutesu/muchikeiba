"""Side-by-side sheets: Codex's design screens (unity/design/figma-screens) vs. the prototype screenshots.

usage: python3 compare.py <repo-root> <screens-dir> <out-dir>
"""
import os, sys
from PIL import Image, ImageDraw

root, shots, out = sys.argv[1], sys.argv[2], sys.argv[3]
os.makedirs(out, exist_ok=True)
design = os.path.join(root, 'unity/design/figma-screens')
pairs = [  # Codex design → prototype screenshot
    ('01-title', '01-title'), ('02-first-ride', '03-first-ride-straight'), ('03-partner-naming', '05-partner-naming'),
    ('04-scout', '07-scout-free'), ('05-scout-results', '08-scout-results'), ('06-home', '09-home'), ('07-stable', '10-stable'),
    ('08-race-entry', '26-race-entry'), ('09-ranked-race', '28-ranked-race-straight'), ('10-race-result', '29-ranked-race-result'),
    ('11-wardrobe', '14-wardrobe'), ('12-course-looks', '16-course-looks'), ('13-conditions', '17-conditions'), ('14-care-feed', '18-care-feed'),
    ('15-store-coins', '19-store-coins'), ('16-store-cosmetics', '22-store-cosmetics'), ('17-season-pass', '24-season-pass'), ('18-purchase-review', '20-purchase-review'),
]
files = {os.path.splitext(f)[0][3:] if f[:2].isdigit() else f: f for f in os.listdir(shots)}
def find(prefix):
    for f in sorted(os.listdir(shots)):
        if f.startswith(prefix + '.') or f[:-4] == prefix:
            return os.path.join(shots, f)
    return None
for d, s in pairs:
    dp = os.path.join(design, d + '.png')
    if not os.path.exists(dp):
        dp = os.path.join(out, '_render_' + d + '.png')  # rendered from SVG by the caller when no PNG exists
    sp = find(s)
    if not (os.path.exists(dp) and sp):
        print('skip', d, s); continue
    a = Image.open(dp).convert('RGB').resize((800, 450)); b = Image.open(sp).convert('RGB').resize((800, 450))
    sheet = Image.new('RGB', (1610, 480), (20, 20, 20)); sheet.paste(a, (0, 30)); sheet.paste(b, (810, 30))
    dr = ImageDraw.Draw(sheet); dr.text((8, 8), 'Codex design: ' + d, fill=(255, 255, 255)); dr.text((818, 8), 'Prototype: ' + os.path.basename(sp), fill=(255, 255, 255))
    sheet.save(os.path.join(out, 'cmp-' + d + '.jpg'), quality=82)
print('compare sheets in', out)
