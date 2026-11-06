"""Contact sheet of every ムチ一閃 screen the e2e walkthrough captured (u-<nn>-<name>.png) → <screens-dir>/contact-sheet.png.

usage: python3 contact-sheet.py [screens-dir]   (default: tools/figma-prototype/.screens)
The landscape-phone captures (844×390) are cropped to the 16:9 stage; 6 per row, labelled with their file names.
"""
import os, re, sys
from PIL import Image, ImageDraw

shots = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), '..', '.screens')
files = sorted(f for f in os.listdir(shots) if re.match(r'^u-\d+-.+\.png$', f))
if not files:
    sys.exit('no u-*.png screenshots in ' + shots)
COLS, TW, TH, LH, PAD = 6, 400, 225, 22, 10
rows = (len(files) + COLS - 1) // COLS
sheet = Image.new('RGB', (PAD + COLS * (TW + PAD), PAD + rows * (TH + LH + PAD)), (8, 14, 22))
d = ImageDraw.Draw(sheet)
for i, f in enumerate(files):
    im = Image.open(os.path.join(shots, f)).convert('RGB')
    w, h = im.size
    sw = round(h * 16 / 9)
    if sw < w:
        x = (w - sw) // 2; im = im.crop((x, 0, x + sw, h))
    im = im.resize((TW, TH), Image.LANCZOS)
    x, y = PAD + (i % COLS) * (TW + PAD), PAD + (i // COLS) * (TH + LH + PAD)
    sheet.paste(im, (x, y + LH))
    d.text((x + 2, y + 5), f[:-4], fill=(0, 210, 237))
out = os.path.join(shots, 'contact-sheet.png')
sheet.save(out, optimize=True)
print('contact sheet', out, f'({len(files)} screens)')
