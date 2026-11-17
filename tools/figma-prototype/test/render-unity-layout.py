#!/usr/bin/env python3
"""Draws the Unity daily screens' audited boxes (U1-A, Muchi.Game.DailyLayout) over the Unity art, so they can be put next to
the prototype's screenshots without opening Unity.

    MUCHI_LAYOUT_DUMP=/tmp/layouts dotnet run --project "unity/Checks~/GameChecks"
    python3 tools/figma-prototype/test/render-unity-layout.py /tmp/layouts /tmp/layouts-png [repo root]

Approximates the screen kit (MuchiApp.Kit.cs): navy cards with a cyan rule, letter-spaced cyan kickers, the skewed cyan CTA
with 」»」, outlined ghosts. Japanese text as laid out (the English pass is checked by GameChecks, not drawn here).
"""
import json, os, sys
from PIL import Image, ImageDraw, ImageFont

src, out = sys.argv[1], sys.argv[2]
root = sys.argv[3] if len(sys.argv) > 3 else os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
res = os.path.join(root, 'unity', 'Assets', 'Resources')
FONT = os.path.join(res, 'Fonts', 'NotoSansCJKjp-Bold.ttf')
os.makedirs(out, exist_ok=True)
TONES = {'white': (255, 255, 255), 'soft': (199, 219, 240), 'muted': (140, 163, 189), 'dim': (102, 120, 140), 'cyan': (0, 204, 242),
         'gold': (255, 212, 20), 'ok': (115, 230, 153), 'warn': (255, 148, 77), 'line': (255, 255, 255, 36)}
NAVY = (6, 19, 36, 199)
fonts = {}


def font(size):
    if size not in fonts:
        fonts[size] = ImageFont.truetype(FONT, size)
    return fonts[size]


def spaced(s):
    s = s.upper()
    o = ''
    for i, c in enumerate(s):
        if i > 0 and c != ' ' and s[i - 1] != ' ':
            o += ' '
        o += c
    return o


def text(d, b, s, color, size, x, y, w, align):
    f = font(size)
    tw = d.textlength(s, font=f)
    if align == 'right':
        x = x + w - tw
    elif align == 'center':
        x = x + (w - tw) / 2
    d.text((x, y), s, font=f, fill=color)


def wrap(d, s, size, w):
    f = font(size)
    lines, cur = [], ''
    for c in s:
        if d.textlength(cur + c, font=f) > w and cur:
            lines.append(cur)
            cur = c
        else:
            cur += c
    if cur:
        lines.append(cur)
    return lines


for name in sorted(os.listdir(src)):
    if not name.endswith('.json'):
        continue
    data = json.load(open(os.path.join(src, name), encoding='utf-8'))
    screen = data['screen']
    art = 'first-ride' if screen.startswith('training-play') else 'home-paddock'
    base = Image.open(os.path.join(res, 'Art', art + '.png')).convert('RGBA').resize((1600, 900))
    if not screen.startswith('home') and not screen.startswith('training-play'):
        base = Image.alpha_composite(base, Image.new('RGBA', base.size, (3, 9, 18, 90)))
    layer = Image.new('RGBA', base.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    for b in data['boxes']:
        k, x, y, w, h = b['kind'], b['x'], b['y'], b['w'], b['h']
        color = TONES.get(b['tone'], (255, 255, 255))
        if k == 'Card':
            d.rectangle([x, y, x + w, y + h], fill=NAVY if not b['disabled'] else (6, 19, 36, 128), outline=(0, 204, 242) if b['selected'] else None, width=2)
            d.rectangle([x, y, x + w, y + 3], fill=(0, 204, 242, 140))
        elif k == 'Gauge':
            d.rectangle([x, y, x + w, y + h], fill=(255, 255, 255, 36))
            if b['fill'] > 0:
                d.rectangle([x, y, x + w * b['fill'], y + h], fill=color)
        elif k == 'Pips':
            p = w / max(1, b['count'])
            for i in range(b['count']):
                fill = (255, 212, 20) if i < b['on'] else (255, 255, 255, 40)
                d.rectangle([x + i * p, y, x + i * p + p - 4, y + h], fill=fill, outline=(0, 204, 242) if i == b['on'] else None)
        elif k == 'Rule':
            d.rectangle([x, y, x + w, y + h], fill=color)
        elif k == 'Cta':
            sk = 9
            d.polygon([(x + sk, y), (x + w + sk, y), (x + w - sk, y + h), (x - sk, y + h)], fill=(0, 204, 242, 90 if b['disabled'] else 255))
            text(d, b, b['text'] + '　»', (6, 19, 36), 27, x + 28, y + 16, w - 56, 'left')
        elif k == 'Ghost':
            d.rectangle([x, y, x + w, y + h], fill=(0, 0, 0, 64), outline=(0, 204, 242, 140), width=2)
            text(d, b, b['text'], (255, 255, 255), 21, x + 12, y + 16, w - 24, 'center')
        elif k == 'Chrome':
            d.rectangle([x, y, x + w, y + h], fill=(6, 19, 36, 230))
            text(d, b, 'English', (255, 255, 255), 20, x, y + h / 2 - 14, w, 'center')
        elif k == 'Kicker':
            text(d, b, spaced(b['text']), TONES['cyan'], 16, x, y, w, 'left')
        elif k in ('Text', 'Link'):
            if b['wrap']:
                for i, line in enumerate(wrap(d, b['text'], b['size'], w)):
                    text(d, b, line, color, b['size'], x, y + i * b['size'] * 1.3, w, b['align'])
            else:
                text(d, b, b['text'], color, b['size'], x, y, w, b['align'])
    Image.alpha_composite(base, layer).convert('RGB').save(os.path.join(out, name[:-5] + '.png'))
    print(os.path.join(out, name[:-5] + '.png'))
