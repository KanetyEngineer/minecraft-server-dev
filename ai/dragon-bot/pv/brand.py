# PROJECT DRAGONFALL のロゴ（アニメのタイトルロゴ風: 鋭い明朝の「竜墜」＋金属の質感＋斬撃の線）
# 使い方: python3 brand.py <出力フォルダ>
# フォントは Google Fonts（OFL）: fetch_fonts.sh で fonts/ に入れる
import sys, os, math
from PIL import Image, ImageDraw, ImageFont, ImageFilter, ImageChops

HERE = os.path.dirname(os.path.abspath(__file__))
FONTS = os.environ.get('DRAGONFALL_FONTS', os.path.join(HERE, 'fonts'))
MINCHO = os.path.join(FONTS, 'ShipporiMinchoB1-ExtraBold.ttf')
ORBITRON = os.path.join(FONTS, 'Orbitron[wght].ttf')
MICHROMA = os.path.join(FONTS, 'Michroma-Regular.ttf')
DELA = os.path.join(FONTS, 'DelaGothicOne-Regular.ttf')
SS = 3  # 3 倍で描いてから縮小し、輪郭をくっきりさせる

CHROME = ((255, 255, 255), (214, 190, 255), (150, 70, 250), (52, 8, 104))  # 上の明るい金属 → 中央で硬く切り替わって濃い紫へ
SILVER = ((255, 255, 255), (232, 228, 245), (170, 160, 205), (110, 96, 160))


def font(path, size, weight=None):
    f = ImageFont.truetype(path, size)
    if weight:
        try: f.set_variation_by_axes([weight])
        except Exception: pass
    return f


def grad_img(w, h, colors, split=0.5):
    top, top2, mid, bottom = colors
    g = Image.new('RGB', (1, h))
    for y in range(h):
        t = y / max(1, h - 1)
        if t < split: a, b, k = top, top2, t / split
        else: a, b, k = mid, bottom, (t - split) / (1 - split)
        g.putpixel((0, y), tuple(int(a[i] + (b[i] - a[i]) * k) for i in range(3)))
    return g.resize((w, h))


def grow(m, r):
    """マスクを r ピクセル太らせる（大きい MaxFilter は遅いので小さいのを繰り返す）"""
    while r > 0:
        s = min(r, 6); m = m.filter(ImageFilter.MaxFilter(s * 2 + 1)); r -= s
    return m


def styled(text, path, size, colors=CHROME, skew=0.18, outline=0.07, outer=0.025, tracking=0.0, weight=None, split=0.5):
    """斜体・金属グラデーション・濃い縁取り・外側の白い細線つきの文字（透明 PNG）"""
    f = font(path, size * SS, weight)
    adv = [f.getlength(ch) for ch in text]
    track = size * SS * tracking
    l, t, r, b = f.getbbox(text)
    w = int(sum(adv) + track * (len(text) - 1)) + size * SS
    h = (b - t) + size * SS
    mask = Image.new('L', (w, h), 0)
    d = ImageDraw.Draw(mask)
    x = size * SS // 2
    for ch, a in zip(text, adv):
        d.text((x, size * SS // 2 - t), ch, font=f, fill=255)
        x += a + track
    extra = int(h * skew)
    mask = mask.transform((w + extra, h), Image.AFFINE, (1, skew, -extra, 0, 1, 0), resample=Image.BICUBIC)
    bbox = mask.getbbox()
    o = int(size * SS * outline); oo = int(size * SS * outer)
    pad = o + oo + 4 * SS
    mask = mask.crop((bbox[0] - pad, bbox[1] - pad, bbox[2] + pad, bbox[3] + pad))
    w, h = mask.size
    m_out = grow(mask, o)
    m_outer = grow(m_out, oo)

    def lay(m, c):
        L = Image.new('RGBA', (w, h), c + (0,)); L.putalpha(m); return L
    img = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    if oo: img.alpha_composite(lay(m_outer, (245, 235, 255)))  # 外側の白い細線
    img.alpha_composite(lay(m_out, (12, 0, 26)))               # 濃い縁取り
    body = grad_img(w, h, colors, split).convert('RGBA'); body.putalpha(mask)
    img.alpha_composite(body)
    inner = ImageChops.subtract(mask, mask.filter(ImageFilter.MinFilter(3)))  # 輪郭の内側の細いハイライト
    img.alpha_composite(lay(inner.point(lambda v: v // 2), (255, 255, 255)))
    return img.resize((w // SS, h // SS), Image.LANCZOS)


def sharp_eye(size, ring_only=False):
    """エンダードラゴンの目（鋭いひし形と、縦に細い瞳）。ring_only は背景の枠だけ"""
    S = size * SS
    img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    c = S / 2
    dia = lambda r: [(c, c - r), (c + r, c), (c, c + r), (c - r, c)]
    if ring_only:
        d.polygon(dia(c), fill=(170, 80, 255, 255)); d.polygon(dia(c * 0.985), fill=(0, 0, 0, 0))
        d.polygon(dia(c * 0.9), fill=(170, 80, 255, 200)); d.polygon(dia(c * 0.89), fill=(0, 0, 0, 0))
        return img.resize((size, size), Image.LANCZOS)
    d.polygon(dia(c), fill=(10, 0, 22, 255))
    d.polygon(dia(c * 0.9), fill=(150, 50, 240, 255))
    d.polygon(dia(c * 0.72), fill=(40, 6, 80, 255))
    d.polygon(dia(c * 0.62), fill=(240, 225, 255, 255))
    d.polygon([(c, c - S * 0.27), (c + S * 0.045, c), (c, c + S * 0.27), (c - S * 0.045, c)], fill=(14, 0, 26, 255))
    d.polygon([(c - S * 0.17, c - S * 0.06), (c - S * 0.06, c - S * 0.17), (c - S * 0.03, c - S * 0.14), (c - S * 0.14, c - S * 0.03)], fill=(255, 255, 255, 255))
    return img.resize((size, size), Image.LANCZOS)


def slash(w, h, thick, color=(235, 215, 255)):
    """斬撃の線（細長い刃の形。中央が太く両端がとがる）"""
    img = Image.new('RGBA', (w * SS, h * SS), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    x0, y0, x1, y1 = 0, h * SS * 0.8, w * SS, h * SS * 0.2
    mx, my = (x0 + x1) / 2, (y0 + y1) / 2
    ang = math.atan2(y1 - y0, x1 - x0); nx, ny = -math.sin(ang), math.cos(ang)
    t = thick * SS
    d.polygon([(x0, y0), (mx + nx * t, my + ny * t), (x1, y1), (mx - nx * t * 0.35, my - ny * t * 0.35)], fill=color + (255,))
    return img.resize((w, h), Image.LANCZOS)


def glow(img, radius, color, strength=1.0):
    a = img.split()[-1].filter(ImageFilter.GaussianBlur(radius))
    g = Image.new('RGBA', img.size, color + (0,))
    g.putalpha(a.point(lambda v: min(255, int(v * strength))))
    return g


ORDER = ('glow', 'ring', 'lines', 'blade', 'kanji', 'eng', 'proj', 'band', 'eye')


def logo(scale=1.0):
    """ロゴ一式（透明 PNG）と、パーツごとの層（同じ大きさ、オープニングの演出用）を返す"""
    s = lambda v: int(v * scale)
    kanji = styled('竜墜', MINCHO, s(380), CHROME, skew=0.16, outline=0.028, outer=0.012, tracking=-0.02, split=0.52)
    eng = styled('DRAGONFALL', ORBITRON, s(118), CHROME, skew=0.2, outline=0.09, outer=0.03, tracking=0.08, weight=900)
    proj = styled('PROJECT', MICHROMA, s(40), SILVER, skew=0.2, outline=0.08, outer=0.0, tracking=0.6)
    sub_f = font(DELA, s(40))
    sub_txt = 'AI エンダードラゴン討伐計画'
    sw = int(sub_f.getlength(sub_txt)) + s(110)
    band = Image.new('RGBA', (sw, s(70)), (0, 0, 0, 0))
    bd = ImageDraw.Draw(band)
    k = s(26)
    bd.polygon([(k, 0), (sw, 0), (sw - k, band.height), (0, band.height)], fill=(18, 2, 38, 235))
    bd.polygon([(k, 0), (sw, 0), (sw - 2, 4), (k + 1, 4)], fill=(190, 120, 255, 255))
    bd.text((sw // 2, band.height // 2), sub_txt, font=sub_f, fill=(245, 238, 255), anchor='mm')
    eye_ring = sharp_eye(s(620), ring_only=True)
    eye = sharp_eye(s(64))
    blade = slash(int(kanji.width * 1.4), int(kanji.height * 0.95), s(10))

    W = max(kanji.width, eng.width) + s(300)
    H = s(60) + proj.height + kanji.height + eng.height + band.height + s(60)
    pos = {}
    y = s(40)
    pos['proj'] = ((W - proj.width) // 2, y); y += proj.height + s(4)
    pos['kanji'] = ((W - kanji.width) // 2, y); y += kanji.height - s(18)
    pos['eng'] = ((W - eng.width) // 2 + s(30), y); y += eng.height + s(4)
    pos['band'] = ((W - band.width) // 2 + s(20), y)
    H = y + band.height + s(40)
    kx, ky = pos['kanji']
    pos['ring'] = (kx + (kanji.width - eye_ring.width) // 2, ky + (kanji.height - eye_ring.height) // 2 + s(20))
    pos['blade'] = (kx - int(kanji.width * 0.2), ky)
    pos['eye'] = (pos['proj'][0] - eye.width - s(16), pos['proj'][1] + (proj.height - eye.height) // 2)
    lines = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    ld = ImageDraw.Draw(lines)
    py = pos['proj'][1] + proj.height // 2
    lx1 = pos['eye'][0] - s(24); rx0 = pos['proj'][0] + proj.width + s(24)
    ld.polygon([(lx1 - s(380), py), (lx1, py - 1), (lx1, py + 2)], fill=(210, 180, 255, 230))
    ld.polygon([(rx0, py - 1), (rx0 + s(380), py), (rx0, py + 2)], fill=(210, 180, 255, 230))
    parts = {'ring': eye_ring, 'blade': blade, 'kanji': kanji, 'eng': eng, 'proj': proj, 'band': band, 'eye': eye}
    layers = {'lines': lines}
    for name, im in parts.items():
        L = Image.new('RGBA', (W, H), (0, 0, 0, 0)); L.alpha_composite(im, pos[name]); layers[name] = L
    layers['ring'].putalpha(layers['ring'].split()[-1].point(lambda v: v * 45 // 100))
    glow_src = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    for n in ('kanji', 'eng'): glow_src.alpha_composite(layers[n])
    layers['glow'] = glow(glow_src, s(22), (150, 50, 255), 0.75)
    out = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    for n in ORDER: out.alpha_composite(layers[n])
    return out, layers


if __name__ == '__main__':
    dst = sys.argv[1] if len(sys.argv) > 1 else '.'
    os.makedirs(dst, exist_ok=True)
    img, _ = logo()
    img.save(os.path.join(dst, 'dragonfall_logo.png'))
    bg = Image.new('RGBA', (1920, 1080), (8, 2, 16, 255))
    s = min(1760 / img.width, 1000 / img.height)
    lg = img.resize((int(img.width * s), int(img.height * s)), Image.LANCZOS)
    bg.alpha_composite(lg, ((1920 - lg.width) // 2, (1080 - lg.height) // 2))
    bg.convert('RGB').save(os.path.join(dst, 'dragonfall_logo_dark.png'))
    sharp_eye(512).save(os.path.join(dst, 'dragonfall_icon.png'))
    print('ok', img.size)
