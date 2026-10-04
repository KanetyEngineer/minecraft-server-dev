# PROJECT DRAGONFALL のロゴ（英語のみ・シンプルで現代的: 白い文字＋紫 1 色のアクセント）
# 使い方: python3 brand.py <出力フォルダ>
# フォントは Google Fonts の Inter（OFL）: fetch_fonts.sh で fonts/ に入れる
import sys, os
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
FONTS = os.environ.get('DRAGONFALL_FONTS', os.path.join(HERE, 'fonts'))
INTER = os.path.join(FONTS, 'Inter[opsz,wght].ttf')
SS = 2  # 2 倍で描いてから縮小して輪郭をきれいに

WHITE = (244, 244, 247)
GRAY = (148, 148, 160)
ACCENT = (124, 92, 255)   # 紫（エンドの色）を 1 色だけ
BG = (10, 10, 14)


def font(size, weight=400):
    f = ImageFont.truetype(INTER, size)
    f.set_variation_by_axes([32 if size >= 64 else 14, weight])
    return f


def text(txt, size, weight=400, color=WHITE, tracking=0.0):
    """字間つきの文字（透明 PNG、文字の外形ぴったりに切り抜く。右端の余分な字間は付けない）"""
    f = font(size * SS, weight)
    track = size * SS * tracking
    adv = [f.getlength(ch) for ch in txt]
    l, t, r, b = f.getbbox(txt)
    w = int(sum(adv) + track * (len(txt) - 1)) + size * SS
    h = (b - t) + size * SS
    img = Image.new('RGBA', (w, h), color + (0,))
    d = ImageDraw.Draw(img)
    x = size * SS // 2
    for ch, a in zip(txt, adv):
        d.text((x, size * SS // 2 - t), ch, font=f, fill=color + (255,))
        x += a + track
    img = img.crop(img.getbbox())
    return img.resize((max(1, img.width // SS), max(1, img.height // SS)), Image.LANCZOS)


def mark(size, color=ACCENT, stroke=0.075):
    """マーク: エンダードラゴンの目を、ひし形の線と縦に細い瞳だけで表したもの"""
    S = size * SS
    img = Image.new('RGBA', (S, S), color + (0,))
    d = ImageDraw.Draw(img)
    c = S / 2
    dia = lambda r: [(c, c - r), (c + r, c), (c, c + r), (c - r, c)]
    sw = S * stroke
    d.polygon(dia(c), fill=color + (255,))
    d.polygon(dia(c - sw * 1.41), fill=color + (0,))
    d.polygon([(c, c - S * 0.3), (c + S * 0.07, c), (c, c + S * 0.3), (c - S * 0.07, c)], fill=color + (255,))
    return img.resize((size, size), Image.LANCZOS)


ORDER = ('mark', 'proj', 'word', 'line', 'sub')


def logo(scale=1.0):
    """ロゴ一式（透明 PNG）と、パーツごとの位置 {名前: (画像, x, y)} を返す（オープニングの演出用）"""
    s = lambda v: max(1, int(v * scale))
    parts = {
        'mark': mark(s(84)),
        'proj': text('PROJECT', s(26), 600, GRAY, tracking=0.62),
        'word': text('DRAGONFALL', s(168), 800, WHITE, tracking=0.05),
        'line': Image.new('RGBA', (s(96), s(3)), ACCENT + (255,)),
        'sub': text('AI ENDER DRAGON SPEEDRUN EXPERIMENT', s(24), 500, GRAY, tracking=0.34),
    }
    gaps = {'mark': s(44), 'proj': s(26), 'word': s(40), 'line': s(30), 'sub': 0}
    W = max(im.width for im in parts.values()) + s(160)
    H = sum(im.height + gaps[n] for n, im in parts.items()) + s(120)
    out = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    pos = {}
    y = s(60)
    for n in ORDER:
        im = parts[n]
        pos[n] = (im, (W - im.width) // 2, y)
        out.alpha_composite(im, pos[n][1:])
        y += im.height + gaps[n]
    return out, pos


if __name__ == '__main__':
    dst = sys.argv[1] if len(sys.argv) > 1 else '.'
    os.makedirs(dst, exist_ok=True)
    img, _ = logo()
    img.save(os.path.join(dst, 'dragonfall_logo.png'))
    bg = Image.new('RGBA', (1920, 1080), BG + (255,))
    s = min(1500 / img.width, 900 / img.height)
    lg = img.resize((int(img.width * s), int(img.height * s)), Image.LANCZOS)
    bg.alpha_composite(lg, ((1920 - lg.width) // 2, (1080 - lg.height) // 2))
    bg.convert('RGB').save(os.path.join(dst, 'dragonfall_logo_dark.png'))
    icon = Image.new('RGBA', (512, 512), BG + (255,))
    icon.alpha_composite(mark(300), (106, 106))
    icon.save(os.path.join(dst, 'dragonfall_icon.png'))
    print('ok', img.size)
