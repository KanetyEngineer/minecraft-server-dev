# PROJECT DRAGONFALL のオープニング（約 8.5 秒、1920x1080、60fps、効果音付き MP4）
# 使い方: python3 opening.py <出力フォルダ>（フォントは fetch_fonts.sh で fonts/ に入れる）
# 流れ: 「3 AI BOTS / 1 RANDOM SEED / 1 ENDER DRAGON」が切り込む → 集中線の中でエンダードラゴンの目がためる
#       → 斬撃と閃光で「竜墜」が斜めに切り出される → DRAGONFALL・PROJECT・帯が順に入る → 金属の照り返し → 副題 → 暗転
import sys, os, subprocess, wave, math
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter
from brand import logo, sharp_eye, ORDER, MINCHO, MICHROMA

W, H, FPS = 1920, 1080, 60
DUR = 8.5
N = int(DUR * FPS)
T_IMPACT = 3.2
rng = np.random.default_rng(20261004)


def ease_out(x): x = min(max(x, 0), 1); return 1 - (1 - x) ** 3
def ease_out5(x): x = min(max(x, 0), 1); return 1 - (1 - x) ** 5
def clamp01(x): return min(max(x, 0.0), 1.0)


def rgba(img):
    a = np.asarray(img.convert('RGBA'), dtype=np.float32) / 255
    return a[..., :3], a[..., 3:4]


def paste(frame, rgb, alpha, x, y, opacity=1.0):
    """frame（H,W,3）に rgb/alpha を (x,y) へ重ねる（はみ出しは切る）"""
    h, w = alpha.shape[:2]
    x0, y0, x1, y1 = max(x, 0), max(y, 0), min(x + w, W), min(y + h, H)
    if x0 >= x1 or y0 >= y1: return
    a = alpha[y0 - y:y1 - y, x0 - x:x1 - x] * opacity
    frame[y0:y1, x0:x1] = frame[y0:y1, x0:x1] * (1 - a) + rgb[y0 - y:y1 - y, x0 - x:x1 - x] * a


def add(frame, rgb, alpha, x, y, opacity=1.0):
    """光（加算）"""
    h, w = alpha.shape[:2]
    x0, y0, x1, y1 = max(x, 0), max(y, 0), min(x + w, W), min(y + h, H)
    if x0 >= x1 or y0 >= y1: return
    frame[y0:y1, x0:x1] += rgb[y0 - y:y1 - y, x0 - x:x1 - x] * alpha[y0 - y:y1 - y, x0 - x:x1 - x] * opacity


# ---------- 背景 ----------
yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
vign = np.clip(1 - 0.8 * (((xx - W / 2) / (W * 0.6)) ** 2 + ((yy - H / 2) / (H * 0.6)) ** 2), 0, 1)
BG = vign[..., None] * np.array([0.05, 0.012, 0.09], np.float32)
# 斜めの細い光の筋（アニメの背景によくある斜線）
stripes = ((xx + yy * 0.35) % 90 < 2).astype(np.float32) * 0.018 * vign
BG += stripes[..., None] * np.array([0.7, 0.4, 1.0], np.float32)

# ---------- ロゴ（パーツごとの層） ----------
_full, _layers = logo(1.0)
SCALE = min(1560 / _full.width, 780 / _full.height)
LW, LH = int(_full.width * SCALE), int(_full.height * SCALE)
LX, LY = (W - LW) // 2, (H - LH) // 2 - 70
LAY = {n: rgba(_layers[n].resize((LW, LH), Image.LANCZOS)) for n in ORDER}
ly, lx = np.mgrid[0:LH, 0:LW].astype(np.float32)
DIAG = (lx + (LH - ly) * 0.55) / (LW + LH * 0.55)   # 左下 → 右上へ進む斜めの位置（0〜1）


def wipe(p, soft=0.004):
    """斜めの切り出し（p=0 で何も見えない、p=1 で全部）。縁のハイライト量も返す"""
    q = p * 1.08 - 0.04
    m = np.clip((q - DIAG) / soft, 0, 1)[..., None]
    edge = np.clip(1 - np.abs(q - DIAG) / 0.012, 0, 1)[..., None]
    return m, edge


# ---------- 目（ため） ----------
EYE = Image.new('RGBA', (520, 520), (0, 0, 0, 0)); EYE.alpha_composite(sharp_eye(360), (80, 80))  # 光がはみ出せるよう余白つき
E_RGB, E_A = rgba(EYE)
EG = EYE.split()[-1].filter(ImageFilter.GaussianBlur(26))
EG_A = (np.asarray(EG, np.float32) / 255)[..., None]


# 集中線（中央に向かう細いくさび）を 4 枚作って入れ替える
def speed_lines(seed):
    r = np.random.default_rng(seed)
    S = 2
    img = Image.new('L', (W * S, H * S), 0)
    d = ImageDraw.Draw(img)
    cx, cy = W * S / 2, H * S / 2
    R = math.hypot(cx, cy) * 1.05
    for _ in range(150):
        a = r.random() * math.tau
        inner = R * (0.33 + r.random() * 0.25)
        wdt = 0.004 + r.random() * 0.01
        d.polygon([(cx + math.cos(a - wdt) * R, cy + math.sin(a - wdt) * R),
                   (cx + math.cos(a + wdt) * R, cy + math.sin(a + wdt) * R),
                   (cx + math.cos(a) * inner, cy + math.sin(a) * inner)], fill=int(150 + r.random() * 105))
    return (np.asarray(img.resize((W, H), Image.LANCZOS), np.float32) / 255)[..., None]


SPEED = [speed_lines(s) for s in range(4)]
WHITE = np.ones((H, W, 3), np.float32)


def text_layer(txt, font, size, color, spacing=0):
    f = ImageFont.truetype(font, size * 2)
    l, t, r, b = f.getbbox(txt)
    img = Image.new('RGBA', (r - l + 80 + spacing * 2 * len(txt), b - t + 80), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    x = 40
    for ch in txt:
        d.text((x, 40 - t), ch, font=f, fill=color)
        x += f.getlength(ch) + spacing * 2
    img = img.crop(img.getbbox())
    img = img.resize((img.width // 2 + 1, img.height // 2 + 1), Image.LANCZOS)
    pad = Image.new('RGBA', (img.width + 20, img.height + 20), (0, 0, 0, 0)); pad.alpha_composite(img, (10, 10))
    return rgba(pad)


LINES = [('3 AI BOTS', 0.25), ('1 RANDOM SEED', 0.9), ('1 ENDER DRAGON', 1.55)]
LINE_LAYERS = [text_layer(s, MICHROMA, 58, (240, 232, 255, 255), 14) for s, _ in LINES]
TAG = text_layer('3体のAIは、エンダードラゴンを倒せるか。', MINCHO, 56, (245, 238, 255, 255), 6)
SMALL = text_layer('AI SPEEDRUN EXPERIMENT  /  2026.10.04', MICHROMA, 22, (190, 165, 235, 255), 10)

# 粒子（小さなひし形の光が上へ漂う）
spr = Image.new('L', (36, 36), 0)
ImageDraw.Draw(spr).polygon([(18, 0), (24, 18), (18, 36), (12, 18)], fill=255)
SPR_A = (np.asarray(spr.resize((12, 12), Image.LANCZOS), np.float32) / 255)[..., None]
SPR_RGB = np.ones((12, 12, 3), np.float32) * np.array([0.75, 0.45, 1.0], np.float32)
P = 120
px_ = rng.random(P) * W
py_ = rng.random(P) * H
pv = 20 + rng.random(P) * 60
pphase = rng.random(P) * 6.28


def particles(frame, t, boost):
    for i in range(P):
        y = (py_[i] - pv[i] * t * (1 + 4 * boost)) % H
        x = px_[i] + np.sin(t * 0.8 + pphase[i]) * 12
        tw = 0.3 + 0.7 * (0.5 + 0.5 * np.sin(t * 3 + pphase[i]))
        add(frame, SPR_RGB, SPR_A, int(x), int(y), tw * 0.55)


def logo_frame(t):
    """時刻 t のロゴ（LW x LH の rgb と alpha）"""
    rgb = np.zeros((LH, LW, 3), np.float32)
    a = np.zeros((LH, LW, 1), np.float32)
    glow_add = np.zeros((LH, LW, 3), np.float32)

    def over(name, m=1.0, dx=0, op=1.0):
        nonlocal rgb, a
        lr, la = LAY[name]
        if dx:
            lr = np.roll(lr, dx, 1); la = np.roll(la, dx, 1)
            if dx > 0: la = la.copy(); la[:, :dx] = 0
            else: la = la.copy(); la[:, dx:] = 0
        k = la * m * op
        rgb = rgb * (1 - k) + lr * k
        a = a * (1 - k) + k

    ti = t - T_IMPACT
    # 背景の目の枠: 衝撃で大きく広がってから収まる
    if ti >= 0:
        over('ring', op=clamp01(ti / 0.25) * (0.75 + 0.25 * math.sin(t * 2)))
    # 横に走る細い線と小さな目、PROJECT（上から）
    if ti >= 0.55:
        k = ease_out5((ti - 0.55) / 0.35)
        m, _ = wipe(k, soft=0.05)
        over('lines', m)
        over('eye', op=k); over('proj', op=k, dx=int(-60 * (1 - k)))
    # 斬撃: 一瞬で走ってから細く残る
    if ti >= 0:
        k = ease_out5(ti / 0.12)
        m, e = wipe(k)
        fade = 1 - 0.55 * clamp01((ti - 0.2) / 0.5)
        over('blade', m, op=fade)
        glow_add += LAY['blade'][1] * e * 2.0
    # 竜墜: 斬撃に続いて斜めに切り出される（縁が白く光る）
    if ti >= 0.04:
        k = ease_out((ti - 0.04) / 0.28)
        m, e = wipe(k)
        over('kanji', m)
        glow_add += LAY['kanji'][1] * e * 1.6 * (1 - k * 0.3)
    # DRAGONFALL: 右から滑り込む
    if ti >= 0.3:
        k = ease_out5((ti - 0.3) / 0.3)
        over('eng', dx=int(220 * (1 - k)), op=clamp01(k * 3))
    # 帯: 左から伸びる
    if ti >= 0.7:
        k = ease_out5((ti - 0.7) / 0.35)
        m = (lx <= LW * (0.15 + 0.85 * k)).astype(np.float32)[..., None]
        over('band', m)
    # 金属の照り返し（斜めの光が文字の上をなでる）
    for ts in (1.35, 4.2):
        if ts <= ti < ts + 0.55:
            p = (ti - ts) / 0.55
            band = np.clip(1 - np.abs(DIAG - (p * 1.3 - 0.15)) / 0.035, 0, 1)[..., None]
            glow_add += (LAY['kanji'][1] + LAY['eng'][1]) * band * 0.9
    rgb = np.clip(rgb + glow_add, 0, 1)
    a = np.clip(a + glow_add[..., :1] * 0.5, 0, 1)
    return rgb, a


def render_frame(i):
    t = i / FPS
    f = BG.copy()
    boost = clamp01(1 - abs(t - T_IMPACT) / 0.5)
    particles(f, t, boost)
    # 1) 文字が右から切り込む（先頭に白い縁）
    if t < 2.65:
        out = clamp01((2.65 - t) / 0.25)
        for k, ((s, st), (rgb, a)) in enumerate(zip(LINES, LINE_LAYERS)):
            if t < st: continue
            p = ease_out5((t - st) / 0.32)
            y = 380 + k * 110
            x = (W - a.shape[1]) // 2 + int(140 * (1 - p))
            cut = int(a.shape[1] * p)
            aa = a.copy(); aa[:, cut:] = 0
            paste(f, rgb, aa, x, y, out)
            # 下線（左右に伸びる細い線）
            lw = int((a.shape[1] + 160) * p)
            f[y + a.shape[0] + 4:y + a.shape[0] + 6, W // 2 - lw // 2:W // 2 + lw // 2] += np.array([0.5, 0.3, 0.8], np.float32) * out
            if p < 1:
                ex = x + cut
                f[y:y + a.shape[0], max(0, ex - 3):ex] += out * (1 - p)
    # 2) 集中線の中で目がためる
    shake = (rng.random(2) - 0.5) * 30 * clamp01(1 - (t - T_IMPACT) / 0.3) if t >= T_IMPACT else np.zeros(2)
    sx, sy = int(shake[0]), int(shake[1])
    if 2.6 <= t < T_IMPACT:
        k = ease_out((t - 2.6) / 0.6)
        sl = SPEED[int(t * 30) % 4]
        add(f, WHITE * np.array([0.85, 0.7, 1.0], np.float32), sl, 0, 0, 0.55 * k)
        sc = 0.55 + 0.5 * k + 0.04 * math.sin(t * 60)
        e = EYE.resize((int(EYE.width * sc), int(EYE.height * sc)), Image.LANCZOS)
        er, ea = rgba(e)
        ex, ey = W // 2 - e.width // 2, H // 2 - e.height // 2 - 40
        add(f, np.ones_like(er) * np.array([0.7, 0.25, 1.0], np.float32),
            (np.asarray(Image.fromarray((EG_A[..., 0] * 255).astype(np.uint8)).resize(e.size), np.float32) / 255)[..., None], ex, ey, 1.4 * k)
        paste(f, er, ea, ex, ey, clamp01(k * 2))
    # 3) ロゴ
    if t >= T_IMPACT:
        ti = t - T_IMPACT
        rgb, a = logo_frame(t)
        zoom = 1 + 0.03 * clamp01((t - 4.6) / 3.9) + 0.06 * (1 - ease_out5(ti / 0.45))
        x, y = LX + sx, LY + sy
        if abs(zoom - 1) > 1e-4:
            zw, zh = int(LW * zoom), int(LH * zoom)
            img = Image.fromarray((np.concatenate([rgb, a], 2) * 255).astype(np.uint8), 'RGBA').resize((zw, zh), Image.BILINEAR)
            rgb, a = rgba(img)
            x, y = (W - zw) // 2 + sx, LY - (zh - LH) // 2 + sy
        ga = LAY['glow'][1]
        if ga.shape[:2] != a.shape[:2]:
            ga = (np.asarray(Image.fromarray((ga[..., 0] * 255).astype(np.uint8)).resize((a.shape[1], a.shape[0])), np.float32) / 255)[..., None]
        add(f, np.ones_like(rgb) * np.array([0.6, 0.2, 1.0], np.float32), ga,
            x, y, clamp01((ti - 0.3) / 0.6) * (0.45 + 0.12 * math.sin(t * 2.2)))
        paste(f, rgb, a, x, y)
    # 4) 白い閃光（短く鋭く）
    if T_IMPACT - 0.02 <= t < T_IMPACT + 0.22:
        f += (1 - (t - T_IMPACT + 0.02) / 0.24) ** 3 * 1.0
    # 5) 副題
    if t >= 5.2:
        rgb, a = TAG
        k = ease_out5((t - 5.2) / 0.6)
        paste(f, rgb, a, (W - a.shape[1]) // 2 + int(40 * (1 - k)), LY + LH + 6, k)
    if t >= 5.7:
        rgb, a = SMALL
        k = ease_out5((t - 5.7) / 0.6)
        paste(f, rgb, a, (W - a.shape[1]) // 2, LY + LH + 92, k * 0.9)
    # 6) 暗転
    if t > DUR - 1.0:
        f *= clamp01((DUR - t) / 1.0)
    return (np.clip(f, 0, 1) * 255).astype(np.uint8)


# ---------- 効果音 ----------
SR = 48000


def audio():
    n = int(DUR * SR)
    t = np.arange(n) / SR
    out = np.zeros(n)

    def put(s0, sig):
        s0 = int(s0 * SR); e = min(n, s0 + len(sig)); out[s0:e] += sig[:e - s0]

    # 低いうなり（徐々に上がる）
    drone_f = 55 * (1 + 0.08 * np.clip(t / T_IMPACT, 0, 1))
    ph = 2 * np.pi * np.cumsum(drone_f) / SR
    drone = (np.sin(ph) + 0.5 * np.sin(2 * ph) + 0.25 * np.sin(3 * ph)) * 0.17
    out += drone * np.clip(t / 1.0, 0, 1) * np.clip((DUR - t) / 1.2, 0, 1)
    # 文字が切り込む「シュッ」（短いノイズを高域だけに）
    for _, st in LINES:
        seg = np.arange(int(0.16 * SR)) / SR
        nz = np.diff(np.concatenate([[0], rng.standard_normal(len(seg))]))
        put(st, nz * np.exp(-seg * 30) * 0.16)
        put(st + 0.02, np.sin(2 * np.pi * 2200 * seg) * np.exp(-seg * 40) * 0.05)
    # ためる音（ノイズが高くなっていく）
    r0, r1 = int(2.3 * SR), int(T_IMPACT * SR)
    noise = rng.standard_normal(r1 - r0)
    env = np.linspace(0, 1, r1 - r0) ** 3
    out[r0:r1] += np.diff(np.concatenate([[0], noise])) * env * 0.13
    # 斬撃の金属音（高い倍音が鋭く鳴って伸びる）＋衝撃音
    i0 = int(T_IMPACT * SR)
    seg = np.arange(n - i0) / SR
    ring = sum(np.sin(2 * np.pi * f0 * seg) * amp for f0, amp in ((2637, 1), (3951, 0.6), (5274, 0.35), (1318, 0.5)))
    out[i0:] += ring * np.exp(-seg * 3.5) * 0.07
    boom = np.sin(2 * np.pi * (38 + 60 * np.exp(-seg * 18)) * seg) * np.exp(-seg * 2.4) * 0.85
    crack = rng.standard_normal(len(seg)) * np.exp(-seg * 22) * 0.35
    out[i0:] += boom + crack
    # DRAGONFALL・帯が入る「シュッ」
    for ts in (0.3, 0.7):
        s = np.arange(int(0.25 * SR)) / SR
        nz = np.diff(np.concatenate([[0], rng.standard_normal(len(s))]))
        put(T_IMPACT + ts, nz * np.sin(np.pi * s / 0.25) * 0.1)
    # 照り返しのきらめき
    for ts in (1.35, 4.2):
        s = np.arange(int(0.6 * SR)) / SR
        put(T_IMPACT + ts, sum(np.sin(2 * np.pi * f0 * s) for f0 in (3136, 4186)) * np.exp(-s * 7) * 0.035)
    # 余韻の和音（ラ・ド・ミ）
    chord = sum(np.sin(2 * np.pi * f0 * seg) + 0.6 * np.sin(2 * np.pi * f0 * 1.003 * seg) for f0 in (220, 261.6, 329.6, 440))
    shimmer = chord * (1 - np.exp(-seg * 3)) * np.exp(-seg * 0.35) * 0.06
    out[i0:] += shimmer * np.clip((DUR - t[i0:]) / 1.2, 0, 1)
    out = np.tanh(out * 1.2) * 0.9
    return (out * 32767).astype(np.int16)


if __name__ == '__main__':
    dst = sys.argv[1] if len(sys.argv) > 1 else '.'
    os.makedirs(dst, exist_ok=True)
    only = os.environ.get('ONLY')  # 確認用: ONLY=3.5,4.0 でその時刻の PNG だけ書き出す
    if only:
        for s in only.split(','):
            Image.fromarray(render_frame(int(float(s) * FPS))).save(os.path.join(dst, f'frame_{s}.png'))
        sys.exit()
    wav = os.path.join(dst, 'opening_sfx.wav')
    a = audio()
    with wave.open(wav, 'wb') as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR); w.writeframes(a.tobytes())
    mp4 = os.path.join(dst, 'dragonfall_opening.mp4')
    p = subprocess.Popen(['ffmpeg', '-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{W}x{H}', '-r', str(FPS), '-i', '-',
                          '-i', wav, '-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-pix_fmt', 'yuv420p',
                          '-c:a', 'aac', '-b:a', '256k', '-ac', '2', '-shortest', '-movflags', '+faststart', mp4], stdin=subprocess.PIPE)
    for i in range(N):
        p.stdin.write(render_frame(i).tobytes())
        if i % 60 == 0: print(f'{i}/{N}', flush=True)
    p.stdin.close(); p.wait()
    print('ok', mp4)
