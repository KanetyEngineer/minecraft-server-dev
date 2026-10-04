# PROJECT DRAGONFALL のロゴを作る（ドット絵の文字とエンダードラゴンの目）
# 使い方: python3 brand.py <出力フォルダ>
import sys, os
from PIL import Image, ImageDraw, ImageFont, ImageFilter

BOLD = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'
JP = '/usr/share/fonts/opentype/ipafont-gothic/ipag.ttf'
PURPLE_TOP = (232, 160, 255)
PURPLE_MID = (178, 76, 255)
PURPLE_DEEP = (70, 16, 120)


def pixel_text(text, px, cell, font=BOLD):
    """小さいサイズでアンチエイリアス無しに描いてから拡大し、マイクラ風のドット文字にする"""
    f = ImageFont.truetype(font, px)
    l, t, r, b = f.getbbox(text)
    small = Image.new('L', (r - l + 2, b - t + 2), 0)
    d = ImageDraw.Draw(small)
    d.fontmode = '1'
    d.text((1 - l, 1 - t), text, font=f, fill=255)
    return small, small.resize((small.width * cell, small.height * cell), Image.NEAREST)


def gradient_fill(mask, top, mid, bottom):
    """上から下へ 3 色のグラデーションで塗る（ドットの段ごとに色を変えて、ドット絵らしくする）"""
    w, h = mask.size
    img = Image.new('RGBA', (w, h))
    px = img.load()
    for y in range(h):
        t = y / max(1, h - 1)
        a, b, k = (top, mid, t / 0.5) if t < 0.5 else (mid, bottom, (t - 0.5) / 0.5)
        c = tuple(int(a[i] + (b[i] - a[i]) * k) for i in range(3))
        for x in range(w):
            px[x, y] = (*c, 255)
    img.putalpha(mask)
    return img


# マイクラのタイトル風の 5x7 ドットフォント（1 ドット = 立体的なブロック）
GLYPHS = {
    'D': ['####.', '#...#', '#...#', '#...#', '#...#', '#...#', '####.'],
    'R': ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
    'A': ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
    'G': ['.####', '#....', '#....', '#.###', '#...#', '#...#', '.###.'],
    'O': ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
    'N': ['#...#', '##..#', '#.#.#', '#..##', '#...#', '#...#', '#...#'],
    'F': ['#####', '#....', '#....', '####.', '#....', '#....', '#....'],
    'L': ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
    'P': ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
    'J': ['....#', '....#', '....#', '....#', '#...#', '#...#', '.###.'],
    'E': ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
    'C': ['.###.', '#...#', '#....', '#....', '#....', '#...#', '.###.'],
    'T': ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
    ' ': ['...', '...', '...', '...', '...', '...', '...'],
}


def block_text(text, cell, top, mid, bottom, spacing=1):
    """1 ドットを、上と左が明るく下と右が暗いブロックとして描く（立体的なドット文字）"""
    cols = sum(len(GLYPHS[c][0]) + spacing for c in text) - spacing
    img = Image.new('RGBA', (cols * cell, 7 * cell), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    bev = max(1, cell // 6)
    x0 = 0
    for ch in text:
        g = GLYPHS[ch]
        for y, row in enumerate(g):
            t = y / 6
            a, b, k = (top, mid, t / 0.5) if t < 0.5 else (mid, bottom, (t - 0.5) / 0.5)
            c = tuple(int(a[i] + (b[i] - a[i]) * k) for i in range(3))
            hi = tuple(min(255, int(v * 1.25 + 30)) for v in c)
            lo = tuple(int(v * 0.6) for v in c)
            for x, on in enumerate(row):
                if on != '#': continue
                X, Y = (x0 + x) * cell, y * cell
                d.rectangle([X, Y, X + cell - 1, Y + cell - 1], fill=lo + (255,))
                d.rectangle([X, Y, X + cell - 1 - bev, Y + cell - 1 - bev], fill=hi + (255,))
                d.rectangle([X + bev, Y + bev, X + cell - 1 - bev, Y + cell - 1 - bev], fill=c + (255,))
        x0 += len(g[0]) + spacing
    return img


# エンダードラゴンの目（13x13 のドット絵）。. = 透明、P = 紫、L = 明るい紫、W = 白、K = 黒（瞳）
EYE = [
    '......P......',
    '.....PLP.....',
    '....PLLLP....',
    '...PLLWLLP...',
    '..PLLWKWLLP..',
    '.PLLWWKWWLLP.',
    'PLLWWWKWWWLLP',
    '.PLLWWKWWLLP.',
    '..PLLWKWLLP..',
    '...PLLWLLP...',
    '....PLLLP....',
    '.....PLP.....',
    '......P......',
]
EYE_COLORS = {'P': (120, 30, 200), 'L': (205, 120, 255), 'W': (250, 235, 255), 'K': (16, 0, 28)}


def eye_icon(cell):
    n = len(EYE)
    img = Image.new('RGBA', (n * cell, n * cell), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    for y, row in enumerate(EYE):
        for x, ch in enumerate(row):
            if ch in EYE_COLORS:
                d.rectangle([x * cell, y * cell, (x + 1) * cell - 1, (y + 1) * cell - 1], fill=EYE_COLORS[ch] + (255,))
    return img


def glow(img, radius, color, strength=2):
    a = img.split()[-1].filter(ImageFilter.GaussianBlur(radius))
    g = Image.new('RGBA', img.size, color + (0,))
    g.putalpha(a.point(lambda v: min(255, v * strength)))
    return g


def logo(cell=12, pad=80):
    """ロゴ一式（透明 PNG）。目のアイコン＋ PROJECT / DRAGONFALL ＋日本語の副題"""
    title = block_text('DRAGONFALL', cell * 2 + cell // 3, PURPLE_TOP, PURPLE_MID, PURPLE_DEEP)
    small = block_text('PROJECT', cell - 2, (255, 255, 255), (225, 205, 255), (175, 145, 230))
    sub_f = ImageFont.truetype(JP, cell * 3)
    sub = Image.new('RGBA', (title.width, cell * 4), (0, 0, 0, 0))
    ImageDraw.Draw(sub).text((sub.width // 2, 0), 'A I  エ ン ダ ー ド ラ ゴ ン 討 伐 計 画', font=sub_f, fill=(225, 210, 255, 255), anchor='ma', stroke_width=1, stroke_fill=(225, 210, 255, 255))
    eye = eye_icon(cell)

    gap = cell * 2
    w = max(title.width, eye.width) + pad * 2
    depth = cell  # DRAGONFALL の奥行き（マイクラのタイトルのように下へ押し出す）
    h = eye.height + gap + small.height + cell * 2 + title.height + depth + gap + sub.height + pad * 2
    out = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    y = pad
    parts = []
    for part in (eye, None, small, 'cell', 'cell', title, 'depth', None, sub):
        if part is None: y += gap; continue
        if part == 'cell': y += cell; continue
        if part == 'depth': y += depth; continue
        parts.append((part, ((w - part.width) // 2, y)))
        y += part.height
    # 文字の影（右下に 1 ドット）→ 光 → 本体
    for part, (x, yy) in parts:
        shadow = Image.new('RGBA', part.size, (20, 0, 40, 0))
        shadow.putalpha(part.split()[-1])
        out.alpha_composite(shadow, (x + cell // 2, yy + cell // 2))
    # DRAGONFALL の押し出し（暗い紫を 1px ずつ下へずらして重ねる）
    tx, ty = parts[2][1]
    side = Image.new('RGBA', title.size, (48, 8, 86, 0)); side.putalpha(title.split()[-1])
    side_dark = Image.new('RGBA', title.size, (28, 4, 52, 0)); side_dark.putalpha(title.split()[-1])
    for k in range(depth, 0, -1):
        out.alpha_composite(side_dark if k > depth * 0.6 else side, (tx, ty + k))
    glow_layer = Image.new('RGBA', out.size, (0, 0, 0, 0))
    for part, pos in parts: glow_layer.alpha_composite(part, pos)
    out = Image.alpha_composite(glow(glow_layer, cell * 2, (170, 60, 255), 1.4), out)
    for part, pos in parts: out.alpha_composite(part, pos)
    return out, parts


if __name__ == '__main__':
    dst = sys.argv[1] if len(sys.argv) > 1 else '.'
    os.makedirs(dst, exist_ok=True)
    img, _ = logo()
    img.save(os.path.join(dst, 'dragonfall_logo.png'))
    # 暗い背景つき（確認用・サムネイル素材）
    bg = Image.new('RGBA', (1920, 1080), (8, 2, 16, 255))
    s = min(1700 / img.width, 950 / img.height)
    lg = img.resize((int(img.width * s), int(img.height * s)), Image.NEAREST)
    bg.alpha_composite(lg, ((1920 - lg.width) // 2, (1080 - lg.height) // 2))
    bg.convert('RGB').save(os.path.join(dst, 'dragonfall_logo_dark.png'))
    eye_icon(64).save(os.path.join(dst, 'dragonfall_icon.png'))
    print('ok', img.size)
