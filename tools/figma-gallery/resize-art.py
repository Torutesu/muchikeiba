# Downscales Codex's raster art for the gallery (keeps the archive small).
import sys, os
from PIL import Image
src, out, maxw = sys.argv[1], sys.argv[2], int(sys.argv[3])
os.makedirs(out, exist_ok=True)
n = 0
for root, _, files in os.walk(src):
    for f in sorted(files):
        if not f.lower().endswith(('.png', '.jpg', '.jpeg')): continue
        rel = os.path.relpath(os.path.join(root, f), src)
        dst = os.path.join(out, os.path.splitext(rel)[0] + '.jpg')
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        im = Image.open(os.path.join(root, f)).convert('RGB')
        if im.width > maxw: im = im.resize((maxw, round(im.height * maxw / im.width)), Image.LANCZOS)
        im.save(dst, 'JPEG', quality=80, optimize=True); n += 1
print('resized', n)
