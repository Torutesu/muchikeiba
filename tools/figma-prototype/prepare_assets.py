"""Copies Codex's Unity art/localization into the web prototype and subsets the bundled Noto Sans CJK JP font.

usage: python3 prepare_assets.py <repo-root> <site-dir>
- Art: unity/Assets/Resources/Art → site/art (backgrounds 1600 px JPEG; transparent cut-outs stay PNG, max 640 px),
  taken from unity/design/figma-optimized-art when Codex has an optimised copy of the same picture
- Data: Localization/ja.json, Models/Partners/catalog.json, ruleset (contracts) and commentary templates (engine)
- Font: unity/Assets/Resources/Fonts/NotoSansCJKjp-Bold.ttf subset to the characters the prototype can show → woff2
"""
import json, os, re, shutil, sys
from PIL import Image

root, site = sys.argv[1], sys.argv[2]
art_src = os.path.join(root, 'unity/Assets/Resources/Art')
art_dst = os.path.join(site, 'art')
shutil.rmtree(art_dst, ignore_errors=True)
count = 0
index = {}
for d, _, files in os.walk(art_src):
    for f in sorted(files):
        if not f.lower().endswith('.png'):
            continue
        src = os.path.join(d, f)
        rel = os.path.relpath(src, art_src)
        # Codex's Figma-optimised copies of the photoreal key art (unity/design/figma-optimized-art, 1600×900 JPEG and
        # 450 px cut-outs) are the same pictures the ムチ一閃 screens use: prefer them when present
        opt = os.path.join(root, 'unity/design/figma-optimized-art', rel)
        for cand in (opt, os.path.splitext(opt)[0] + '.jpg'):
            if os.path.exists(cand):
                src = cand; break
        im = Image.open(src)
        alpha = im.mode in ('RGBA', 'LA') and im.getextrema()[-1][0] < 255
        top_level = os.sep not in rel
        # key art and full-scene plates (Courses, Weather: also the race backdrop) stay 1600 px; cut-outs 640 px
        maxw = 1600 if top_level or rel.split(os.sep)[0] in ('Courses', 'Weather') else (900 if '3DPreviews' in rel else 640)
        if im.width > maxw:
            im = im.resize((maxw, round(im.height * maxw / im.width)), Image.LANCZOS)
        out = os.path.join(art_dst, os.path.splitext(rel)[0] + ('.png' if alpha else '.jpg'))
        os.makedirs(os.path.dirname(out), exist_ok=True)
        if alpha:
            im.save(out, 'PNG', optimize=True)
        else:
            im.convert('RGB').save(out, 'JPEG', quality=82, optimize=True)
        index['Art/' + os.path.splitext(rel)[0].replace(os.sep, '/')] = os.path.relpath(out, site).replace(os.sep, '/')
        count += 1
print('art', count)

# Race sprites: the partner renders are opaque studio shots (dark-blue vertical gradient). Cut the subject out by
# flood-filling, from the image border, every pixel close to its row's background colour.
import numpy as np
from collections import deque
sprite_dst = os.path.join(site, 'art', 'sprites')
os.makedirs(sprite_dst, exist_ok=True)
for f in sorted(os.listdir(os.path.join(art_src, '3DPreviews'))):
    if not f.startswith('Partner_'):
        continue
    im = Image.open(os.path.join(art_src, '3DPreviews', f)).convert('RGB')
    im = im.resize((im.width // 2, im.height // 2), Image.LANCZOS)
    a = np.asarray(im).astype(np.int32)
    h, w, _ = a.shape
    row_bg = (a[:, :6, :].mean(axis=1) + a[:, -6:, :].mean(axis=1)) / 2  # per-row studio colour
    dist = np.sqrt(((a - row_bg[:, None, :]) ** 2).sum(axis=2))
    bgish = dist < 26
    # the studio floor disc is a lighter blue-grey: also treat bluish pixels as background, but only in the lower part
    # of the frame (below the bellies), so blue silks/saddle cloths on the horse are never removed
    r_, g_, b_ = a[:, :, 0], a[:, :, 1], a[:, :, 2]
    bluish = ((b_ - r_) > 18) & (b_ >= g_) & (np.arange(h)[:, None] > int(h * 0.58))
    bgish = bgish | bluish
    mask = np.zeros((h, w), bool)
    q = deque()
    for x in range(w):
        for y in (0, h - 1):
            if bgish[y, x] and not mask[y, x]:
                mask[y, x] = True; q.append((y, x))
    for y in range(h):
        for x in (0, w - 1):
            if bgish[y, x] and not mask[y, x]:
                mask[y, x] = True; q.append((y, x))
    while q:
        y, x = q.popleft()
        for ny, nx in ((y - 1, x), (y + 1, x), (y, x - 1), (y, x + 1)):
            if 0 <= ny < h and 0 <= nx < w and not mask[ny, nx] and bgish[ny, nx]:
                mask[ny, nx] = True; q.append((ny, nx))
    alpha = np.where(mask, 0, 255).astype(np.uint8)
    rgba = np.dstack([a.astype(np.uint8), alpha])
    out = Image.fromarray(rgba, 'RGBA')
    bbox = out.getchannel('A').getbbox()
    if bbox:
        out = out.crop(bbox)
    out.save(os.path.join(sprite_dst, f), 'PNG', optimize=True)
    index['Sprites/' + os.path.splitext(f)[0]] = 'art/sprites/' + f
print('sprites', len([x for x in os.listdir(sprite_dst)]))

# 3D race models (RaceWorld.StartRace): the player's equipped partner uses the full model of one of the five featured
# partners (PartnerCatalog.Featured); offline races have fallback visuals (default coat bay, silks white/navy → Azure),
# so every opponent resolves to Partner_Bay_Azure and uses its LOD1 (catalog opponentLod).
FEATURED = ['Partner_Bay_Crimson', 'Partner_Chestnut_Azure', 'Partner_DappleGrey_Violet', 'Partner_Black_Emerald', 'Partner_Palomino_Gold']
model_dst = os.path.join(site, 'models')
shutil.rmtree(model_dst, ignore_errors=True)
os.makedirs(model_dst)
for name in FEATURED:
    shutil.copy(os.path.join(root, 'unity/Assets/Resources/Models/Partners', name + '.fbx'), os.path.join(model_dst, name + '.fbx'))
    index['Models/Partners/' + name] = 'models/' + name + '.fbx'
for name in ['Partner_Bay_Azure_LOD1']:
    shutil.copy(os.path.join(root, 'unity/Assets/Resources/Models/PartnerLODs', name + '.fbx'), os.path.join(model_dst, name + '.fbx'))
    index['Models/PartnerLODs/' + name] = 'models/' + name + '.fbx'
print('models', len(os.listdir(model_dst)))

data = os.path.join(site, 'data')
os.makedirs(data, exist_ok=True)
# Unity Resources path ("Art/home-paddock") → site file ("art/home-paddock.jpg")
json.dump(index, open(os.path.join(data, 'art.json'), 'w'), indent=1, sort_keys=True)
shutil.copy(os.path.join(root, 'unity/Assets/Resources/Localization/ja.json'), os.path.join(data, 'ja.json'))
shutil.copy(os.path.join(root, 'unity/Assets/Resources/Models/Partners/catalog.json'), os.path.join(data, 'partners.json'))
shutil.copy(os.path.join(root, 'contracts/ruleset-params.default.json'), os.path.join(data, 'ruleset.json'))
shutil.copy(os.path.join(root, 'engine/Muchi.Client/Resources/Muchi/commentary-ja.json'), os.path.join(data, 'commentary-ja.json'))

# Font subset: every character the prototype can render (UI strings, translations, master data, commentary).
chars = set()
def add(text):
    chars.update(text)
    # esbuild writes non-ASCII as \uXXXX (logic.js holds the server's own labels: shop contents, skill texts, notices)
    chars.update(chr(int(h, 16)) for h in re.findall(r'\\u([0-9a-fA-F]{4})', text) if not 0xd800 <= int(h, 16) <= 0xdfff)
for p in [os.path.join(site, 'app.js'), os.path.join(site, 'index.html'), os.path.join(site, 'js', 'logic.js'), os.path.join(data, 'ja.json'), os.path.join(data, 'commentary-ja.json')]:
    add(open(p, encoding='utf-8').read())
for p in ['server/master/horses.json', 'server/master/gacha.json', 'server/master/products.json', 'server/master/ng-names.json', 'server/master/progression.json', 'server/master/skills.json', 'server/master/items.json', 'server/master/tracks.json', 'server/master/collection.json', 'server/master/titles.json']:
    full = os.path.join(root, p)
    if os.path.exists(full):
        add(open(full, encoding='utf-8').read())
add(''.join(chr(c) for c in range(0x20, 0x7f)))
add(''.join(chr(c) for c in range(0x3041, 0x3097)))  # hiragana (name input)
add(''.join(chr(c) for c in range(0x30a1, 0x30fd)))  # katakana (name input)
add('ー・、。「」！？（）／〜◎◈━•·–—…→←↑↓×°%¥')
text_file = os.path.join(data, '.font-chars.txt')
open(text_file, 'w', encoding='utf-8').write(''.join(sorted(chars)))
font_dst = os.path.join(site, 'fonts')
os.makedirs(font_dst, exist_ok=True)
from fontTools import subset
subset.main([os.path.join(root, 'unity/Assets/Resources/Fonts/NotoSansCJKjp-Bold.ttf'), f'--text-file={text_file}',
             '--flavor=woff2', f'--output-file={os.path.join(font_dst, "NotoSansCJKjp-Bold-subset.woff2")}', '--layout-features=*'])
shutil.copy(os.path.join(root, 'unity/Assets/Resources/Fonts/Noto-CJK-copyright.txt'), os.path.join(font_dst, 'Noto-CJK-copyright.txt'))
# Regular / Medium weights (Noto Sans JP: the same glyph design as Noto Sans CJK JP) for the light body text of the
# ムチ一閃 UI, when build.sh could fetch them (otherwise the page falls back to the bold face)
extra = os.environ.get('MUCHI_FONTS', '')
for w in ['400Regular', '500Medium']:
    src = os.path.join(extra, f'NotoSansJP_{w}.ttf')
    if extra and os.path.exists(src):
        out = os.path.join(font_dst, f'NotoSansJP-{w}-subset.woff2')
        subset.main([src, f'--text-file={text_file}', '--flavor=woff2', f'--output-file={out}', '--layout-features=*'])
        print('font', w, os.path.getsize(out))
if extra and os.path.exists(os.path.join(extra, 'OFL.txt')):
    shutil.copy(os.path.join(extra, 'OFL.txt'), os.path.join(font_dst, 'NotoSansJP-OFL.txt'))
os.remove(text_file)
print('font glyph chars', len(chars), 'woff2', os.path.getsize(os.path.join(font_dst, 'NotoSansCJKjp-Bold-subset.woff2')))
