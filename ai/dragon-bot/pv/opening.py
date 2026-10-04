# PROJECT DRAGONFALL のオープニング（約 8.5 秒、1920x1080、60fps、効果音付き MP4）
# 使い方: python3 opening.py <出力フォルダ>
# 流れ: 「3 AI BOTS / 1 RANDOM SEED / 1 ENDER DRAGON」が打ち込まれる → エンダードラゴンの目が光る
#       → 衝撃音とともにロゴがブロック単位で組み上がる → 副題 → 暗転
import sys, os, subprocess, wave
import numpy as np
from PIL import Image, ImageDraw, ImageFont
from brand import logo, eye_icon

W, H, FPS = 1920, 1080, 60
DUR = 8.5
N = int(DUR * FPS)
MONO = '/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf'
JP = '/usr/share/fonts/opentype/ipafont-gothic/ipag.ttf'
T_IMPACT = 3.2
rng = np.random.default_rng(20261004)


def ease_out(x): x = min(max(x, 0), 1); return 1 - (1 - x) ** 3
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


# ---------- 素材 ----------
yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
vign = 1 - 0.75 * (((xx - W / 2) / (W * 0.62)) ** 2 + ((yy - H / 2) / (H * 0.62)) ** 2)
BG = np.clip(vign, 0, 1)[..., None] * np.array([0.045, 0.012, 0.08], np.float32)

full_logo, _ = logo(cell=12)
scale = min(1500 / full_logo.width, 700 / full_logo.height)
CELL = 12 * scale
LW, LH = int(full_logo.width * scale), int(full_logo.height * scale)
logo_img = full_logo.resize((LW, LH), Image.NEAREST)
L_RGB, L_A = rgba(logo_img)
LX, LY = (W - LW) // 2, (H - LH) // 2 - 40
# 光の層（ロゴをぼかして紫に）
from PIL import ImageFilter
gl = logo_img.split()[-1].filter(ImageFilter.GaussianBlur(28))
G_A = (np.asarray(gl, dtype=np.float32) / 255)[..., None]
G_RGB = np.ones((LH, LW, 3), np.float32) * np.array([0.7, 0.25, 1.0], np.float32)
# ブロック単位で組み上がる順番: 目（上の中央）から外へ広がる。少しばらつかせる
gw, gh = int(np.ceil(LW / CELL)), int(np.ceil(LH / CELL))
cy, cx = np.mgrid[0:gh, 0:gw].astype(np.float32)
eye_c = (gw / 2, gh * 0.22)
dist = np.hypot((cx - eye_c[0]) / gw, (cy - eye_c[1]) / gh * 0.5)
reveal = T_IMPACT + 0.05 + dist / dist.max() * 0.75 + rng.random((gh, gw)) * 0.18
REVEAL_PX = np.repeat(np.repeat(reveal, int(np.ceil(CELL)), 0), int(np.ceil(CELL)), 1)
REVEAL_PX = np.kron(reveal, np.ones((1, 1)))  # 下で拡大し直す
cell_px = CELL
ry = np.minimum((np.arange(LH) / cell_px).astype(int), gh - 1)
rx = np.minimum((np.arange(LW) / cell_px).astype(int), gw - 1)
REVEAL_PX = reveal[ry][:, rx][..., None]

eye_big = eye_icon(24)
E_RGB, E_A = rgba(eye_big)
eg = eye_big.split()[-1].filter(ImageFilter.GaussianBlur(30))
EG_A = (np.asarray(eg.resize(eye_big.size), dtype=np.float32) / 255)[..., None]


def text_layer(txt, font, size, color, spacing=0):
    f = ImageFont.truetype(font, size)
    l, t, r, b = f.getbbox(txt)
    img = Image.new('RGBA', (r - l + 40 + spacing * len(txt), b - t + 40), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    x = 20
    if spacing:
        for ch in txt:
            d.text((x, 20 - t), ch, font=f, fill=color)
            x += f.getlength(ch) + spacing
    else:
        d.text((20 - l, 20 - t), txt, font=f, fill=color)
    return rgba(img)


LINES = [('3 AI BOTS', 0.25), ('1 RANDOM SEED', 0.95), ('1 ENDER DRAGON', 1.65)]
LINE_LAYERS = [text_layer(s, MONO, 76, (235, 220, 255, 255), 6) for s, _ in LINES]
TAG = text_layer('3体のAIは、エンダードラゴンを倒せるか。', JP, 54, (240, 230, 255, 255), 4)
SMALL = text_layer('AI SPEEDRUN EXPERIMENT   2026.10.04', MONO, 30, (190, 160, 235, 255), 8)

# 粒子（エンドの紫の粒が上へ漂う）
P = 170
px_ = rng.random(P) * W
py_ = rng.random(P) * H
pv = 20 + rng.random(P) * 60
ps = rng.integers(3, 9, P)
pphase = rng.random(P) * 6.28


def particles(frame, t, boost):
    for i in range(P):
        y = (py_[i] - pv[i] * t * (1 + 3 * boost)) % H
        x = px_[i] + np.sin(t * 0.8 + pphase[i]) * 12
        s = int(ps[i])
        tw = 0.35 + 0.65 * (0.5 + 0.5 * np.sin(t * 3 + pphase[i]))
        x0, y0 = int(x), int(y)
        if 0 <= x0 < W - s and 0 <= y0 < H - s:
            frame[y0:y0 + s, x0:x0 + s] += np.array([0.55, 0.2, 0.85], np.float32) * tw * 0.6


def render_frame(i):
    t = i / FPS
    f = BG.copy()
    boost = clamp01(1 - abs(t - T_IMPACT) / 0.5)
    particles(f, t, boost)
    # 1) 打ち込み文字
    if t < 2.9:
        out = clamp01((2.9 - t) / 0.35)
        for k, ((s, st), (rgb, a)) in enumerate(zip(LINES, LINE_LAYERS)):
            if t < st: continue
            # 文字を左から少しずつ見せる（打ち込み）
            n = len(s)
            shown = clamp01((t - st) / 0.35)
            wcut = int(a.shape[1] * shown)
            glitch = int((rng.random() - 0.5) * 18) if t - st < 0.12 else 0
            y = 360 + k * 120
            x = (W - a.shape[1]) // 2 + glitch
            aa = a.copy(); aa[:, wcut:] = 0
            paste(f, rgb, aa, x, y, out)
            # 色ずれ（RGB を左右にずらした残像）
            if t - st < 0.18:
                add(f, rgb * np.array([1, 0, 0.4], np.float32), aa, x - 8, y, 0.5)
                add(f, rgb * np.array([0, 0.6, 1], np.float32), aa, x + 8, y, 0.5)
    # 2) 目がためて光る
    shake = (rng.random(2) - 0.5) * 26 * clamp01(1 - (t - T_IMPACT) / 0.35) if t >= T_IMPACT else np.zeros(2)
    sx, sy = int(shake[0]), int(shake[1])
    if 2.75 <= t < T_IMPACT + 0.05:
        k = ease_out((t - 2.75) / 0.45)
        # ロゴの目と同じ位置・大きさに向かって、大きく光ってから衝撃で収まる
        target = 13 * CELL
        sc = (target * (0.5 + 1.1 * k)) / eye_big.width
        e = eye_big.resize((max(1, int(eye_big.width * sc)), max(1, int(eye_big.height * sc))), Image.NEAREST)
        er, ea = rgba(e)
        ecx, ecy = W // 2, LY + int(80 * scale + target / 2)
        ex, ey = ecx - e.width // 2, ecy - e.height // 2
        paste(f, er, ea, ex, ey, k)
        ge = Image.fromarray((EG_A[..., 0] * 255).astype(np.uint8)).resize(e.size)
        ga = (np.asarray(ge, np.float32) / 255)[..., None]
        add(f, np.ones_like(er) * np.array([0.8, 0.3, 1.0], np.float32), ga, ex, ey, 1.5 * k)
    # 3) ロゴ（ブロック単位で組み上がる）
    if t >= T_IMPACT:
        hold = clamp01((t - 5.0) / 2.5)
        zoom = 1 + 0.035 * hold
        mask = (REVEAL_PX <= t).astype(np.float32)
        # 出たばかりのブロックは白く光る
        fresh = np.clip(1 - (t - REVEAL_PX) / 0.18, 0, 1) * mask
        rgb = L_RGB * (1 - fresh) + fresh
        a = L_A * mask
        if zoom != 1:
            zw, zh = int(LW * zoom), int(LH * zoom)
            img = Image.fromarray((np.concatenate([rgb, a], 2) * 255).astype(np.uint8), 'RGBA').resize((zw, zh), Image.NEAREST)
            rgb, a = rgba(img)
            x, y = (W - zw) // 2 + sx, LY - (zh - LH) // 2 + sy
            gimg = Image.fromarray((G_A[..., 0] * 255).astype(np.uint8)).resize((zw, zh))
            ga = (np.asarray(gimg, np.float32) / 255)[..., None]
            grgb = np.ones((zh, zw, 3), np.float32) * np.array([0.7, 0.25, 1.0], np.float32)
        else:
            x, y = LX + sx, LY + sy
            ga, grgb = G_A, G_RGB
        breathe = 0.55 + 0.25 * np.sin(t * 2.2) + 1.2 * clamp01(1 - (t - T_IMPACT) / 0.6)
        add(f, grgb, ga * clamp01((t - T_IMPACT - 0.45) / 0.5), x, y, breathe)
        paste(f, rgb, a, x, y)
    # 4) 白い閃光
    if T_IMPACT - 0.02 <= t < T_IMPACT + 0.4:
        f += (1 - (t - T_IMPACT + 0.02) / 0.42) ** 2 * 0.9
    # 5) 副題
    if t >= 5.3:
        rgb, a = TAG
        k = ease_out((t - 5.3) / 0.7)
        paste(f, rgb, a, (W - a.shape[1]) // 2, LY + LH + 10 + int(20 * (1 - k)), k)
    if t >= 5.9:
        rgb, a = SMALL
        k = ease_out((t - 5.9) / 0.7)
        paste(f, rgb, a, (W - a.shape[1]) // 2, LY + LH + 90, k * 0.9)
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
    # 低いうなり（徐々に上がる）
    drone_f = 55 * (1 + 0.08 * np.clip(t / T_IMPACT, 0, 1))
    ph = 2 * np.pi * np.cumsum(drone_f) / SR
    drone = (np.sin(ph) + 0.5 * np.sin(2 * ph) + 0.25 * np.sin(3 * ph)) * 0.18
    out += drone * np.clip(t / 1.0, 0, 1) * np.clip((DUR - t) / 1.2, 0, 1)
    # 打ち込みの電子音
    for _, st in LINES:
        for k in range(6):
            s0 = int((st + k * 0.055) * SR)
            seg = np.arange(int(0.035 * SR)) / SR
            blip = np.sign(np.sin(2 * np.pi * (1400 + 120 * k) * seg)) * np.exp(-seg * 90) * 0.08
            out[s0:s0 + len(seg)] += blip[:max(0, n - s0)]
    # 吸い込む音（ノイズが高くなっていく）
    r0, r1 = int(2.0 * SR), int(T_IMPACT * SR)
    noise = rng.standard_normal(r1 - r0)
    env = np.linspace(0, 1, r1 - r0) ** 3
    # 簡単なハイパス（差分）で「シュー」という音に
    out[r0:r1] += np.diff(np.concatenate([[0], noise])) * env * 0.12
    # 衝撃音（重い低音＋破裂）
    i0 = int(T_IMPACT * SR)
    seg = np.arange(n - i0) / SR
    boom = np.sin(2 * np.pi * (38 + 60 * np.exp(-seg * 18)) * seg) * np.exp(-seg * 2.2) * 0.85
    crack = rng.standard_normal(len(seg)) * np.exp(-seg * 14) * 0.35
    out[i0:] += boom + crack
    # 余韻のきらめく和音（ラ・ド・ミ）
    chord = sum(np.sin(2 * np.pi * f0 * seg) + 0.6 * np.sin(2 * np.pi * f0 * 1.003 * seg) for f0 in (220, 261.6, 329.6, 440))
    shimmer = chord * (1 - np.exp(-seg * 3)) * np.exp(-seg * 0.35) * 0.06
    out[i0:] += shimmer * np.clip((DUR - t[i0:]) / 1.2, 0, 1)
    out = np.tanh(out * 1.2) * 0.9
    return (out * 32767).astype(np.int16)


if __name__ == '__main__':
    dst = sys.argv[1] if len(sys.argv) > 1 else '.'
    os.makedirs(dst, exist_ok=True)
    wav = os.path.join(dst, 'opening_sfx.wav')
    a = audio()
    with wave.open(wav, 'wb') as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR); w.writeframes(a.tobytes())
    mp4 = os.path.join(dst, 'dragonfall_opening.mp4')
    p = subprocess.Popen(['ffmpeg', '-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{W}x{H}', '-r', str(FPS), '-i', '-',
                          '-i', wav, '-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-pix_fmt', 'yuv420p',
                          '-c:a', 'aac', '-b:a', '256k', '-ac', '2', '-shortest', '-movflags', '+faststart', mp4], stdin=subprocess.PIPE)
    only = os.environ.get('ONLY')  # 確認用: ONLY=3.5 でその時刻の 1 枚だけ PNG に
    if only:
        p.stdin.close(); p.kill()
        for s in only.split(','):
            Image.fromarray(render_frame(int(float(s) * FPS))).save(os.path.join(dst, f'frame_{s}.png'))
        sys.exit()
    for i in range(N):
        p.stdin.write(render_frame(i).tobytes())
        if i % 60 == 0: print(f'{i}/{N}', flush=True)
    p.stdin.close(); p.wait()
    print('ok', mp4)
