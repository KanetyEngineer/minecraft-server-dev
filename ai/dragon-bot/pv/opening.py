# PROJECT DRAGONFALL のオープニング（8 秒、1920x1080、60fps、効果音付き MP4）。英語のみ・シンプルで現代的な動き
# 使い方: python3 opening.py <出力フォルダ>（フォントは fetch_fonts.sh で fonts/ に入れる）
# 流れ: 「3 AI BOTS」「1 RANDOM SEED」「1 ENDER DRAGON」が下からせり上がっては消える
#       → マークが現れる → DRAGONFALL が広い字間から締まりながら出る → PROJECT・線・副題 → 問いかけ → 暗転
import sys, os, subprocess, wave, math
import numpy as np
from PIL import Image
from brand import logo, text, WHITE, GRAY, ACCENT, BG

W, H, FPS = 1920, 1080, 60
DUR = 8.0
N = int(DUR * FPS)
T_MARK, T_WORD = 2.55, 2.85
rng = np.random.default_rng(20261004)


def ease_out(x): x = min(max(x, 0), 1); return 1 - (1 - x) ** 3
def ease_out5(x): x = min(max(x, 0), 1); return 1 - (1 - x) ** 5
def ease_in(x): x = min(max(x, 0), 1); return x ** 3
def clamp01(x): return min(max(x, 0.0), 1.0)


def rgba(img):
    a = np.asarray(img.convert('RGBA'), dtype=np.float32) / 255
    return a[..., :3], a[..., 3:4]


def paste(frame, rgb, alpha, x, y, opacity=1.0, clip=None):
    """frame（H,W,3）に重ねる。clip=(上端, 下端) を指定するとその範囲の外は描かない（せり上がりの演出用）"""
    h, w = alpha.shape[:2]
    top, bot = clip if clip else (0, H)
    x0, y0, x1, y1 = max(x, 0), max(y, top, 0), min(x + w, W), min(y + h, bot, H)
    if x0 >= x1 or y0 >= y1 or opacity <= 0: return
    a = alpha[y0 - y:y1 - y, x0 - x:x1 - x] * opacity
    frame[y0:y1, x0:x1] = frame[y0:y1, x0:x1] * (1 - a) + rgb[y0 - y:y1 - y, x0 - x:x1 - x] * a


# ---------- 背景（ほぼ黒に、中央だけごくわずかに明るく。帯状のむらを防ぐ細かいノイズつき） ----------
yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
r2 = ((xx - W / 2) / (W * 0.7)) ** 2 + ((yy - H / 2) / (H * 0.7)) ** 2
BGF = (np.array(BG, np.float32) / 255 + np.clip(1 - r2, 0, 1)[..., None] * np.array([0.022, 0.02, 0.035], np.float32))
GRAIN = [rng.normal(0, 1.2 / 255, (H, W, 1)).astype(np.float32) for _ in range(4)]

# ---------- ロゴ ----------
_full, POS = logo(1.0)
LX, LY = (W - _full.width) // 2, (H - _full.height) // 2 - 60
P = {n: (rgba(im), LX + x, LY + y, im.width, im.height) for n, (im, x, y) in POS.items()}
WORD_Y = P['word'][2]
WORD_FINAL = P['word'][0]
_word_cache = {}


def word_at(tracking):
    k = round(tracking, 3)
    if k not in _word_cache:
        _word_cache[k] = rgba(text('DRAGONFALL', 168, 800, WHITE, tracking=k))
    return _word_cache[k]


# ---------- 冒頭の 3 行（数字だけ紫） ----------
def line_img(num, rest):
    a = text(num, 64, 700, ACCENT)
    b = text(rest, 64, 600, WHITE, tracking=0.16)
    gap = 40
    img = Image.new('RGBA', (a.width + gap + b.width, max(a.height, b.height)), (0, 0, 0, 0))
    img.alpha_composite(a, (0, img.height - a.height)); img.alpha_composite(b, (a.width + gap, img.height - b.height))
    return rgba(img)


LINES = [(line_img('3', 'AI BOTS'), 0.3), (line_img('1', 'RANDOM SEED'), 1.0), (line_img('1', 'ENDER DRAGON'), 1.7)]
LINE_HOLD = 0.62
TAG = rgba(text('Can three AIs defeat the Ender Dragon?', 40, 400, (220, 220, 228)))
DATE = rgba(text('2026.10.04', 22, 500, GRAY, tracking=0.3))


def render_frame(i):
    t = i / FPS
    f = BGF + GRAIN[i % 4]
    # 1) 3 行: 下の見えない線からせり上がり、少し置いて上へ抜ける
    for (rgb, a), st in LINES:
        if not (st <= t < st + LINE_HOLD + 0.3): continue
        h, w = a.shape[:2]
        cy = H // 2 - h // 2
        k_in = ease_out5((t - st) / 0.35)
        k_out = ease_in((t - st - LINE_HOLD) / 0.25)
        y = cy + int(h * 1.1 * (1 - k_in)) - int(h * 1.1 * k_out)
        paste(f, rgb, a, (W - w) // 2, y, clip=(cy - 4, cy + h + 4))
    # 2) マーク（少し小さい所からふわっと）
    if t >= T_MARK:
        k = ease_out5((t - T_MARK) / 0.6)
        (rgb, a), x, y, w, h = P['mark']
        sc = 0.8 + 0.2 * k
        im = Image.fromarray((np.concatenate([rgb, a], 2) * 255).astype(np.uint8), 'RGBA')
        im = im.resize((max(1, int(w * sc)), max(1, int(h * sc))), Image.LANCZOS)
        mr, ma = rgba(im)
        paste(f, mr, ma, x + (w - im.width) // 2, y + (h - im.height) // 2 + int(10 * (1 - k)), k)
    # 3) DRAGONFALL: 下からせり上がりつつ、広い字間から締まる
    if t >= T_WORD:
        k = ease_out5((t - T_WORD) / 1.4)
        if k < 0.999:
            rgb, a = word_at(0.05 + 0.3 * (1 - k))
        else:
            rgb, a = WORD_FINAL
        h, w = a.shape[:2]
        rise = ease_out5((t - T_WORD) / 0.55)
        y = WORD_Y + int(h * 0.9 * (1 - rise))
        paste(f, rgb, a, (W - w) // 2, y, clamp01(rise * 1.5), clip=(WORD_Y - 6, WORD_Y + h + 6))
    # 4) PROJECT（上から）
    if t >= 3.35:
        k = ease_out5((t - 3.35) / 0.7)
        (rgb, a), x, y, w, h = P['proj']
        paste(f, rgb, a, x, y - int(14 * (1 - k)), k)
    # 5) 紫の線（中央から左右へ伸びる）
    if t >= 3.7:
        k = ease_out5((t - 3.7) / 0.6)
        (rgb, a), x, y, w, h = P['line']
        cw = max(1, int(w * k))
        paste(f, rgb[:, :cw], a[:, :cw], x + (w - cw) // 2, y)
    # 6) 副題
    if t >= 3.95:
        k = ease_out5((t - 3.95) / 0.8)
        (rgb, a), x, y, w, h = P['sub']
        paste(f, rgb, a, x, y + int(10 * (1 - k)), k)
    # 7) 問いかけと日付
    base = P['sub'][2] + P['sub'][4] + 70
    if t >= 4.9:
        rgb, a = TAG
        k = ease_out5((t - 4.9) / 0.8)
        paste(f, rgb, a, (W - a.shape[1]) // 2, base + int(12 * (1 - k)), k)
    if t >= 5.4:
        rgb, a = DATE
        k = ease_out5((t - 5.4) / 0.8)
        paste(f, rgb, a, (W - a.shape[1]) // 2, base + 76, k * 0.9)
    # 8) 暗転
    if t > DUR - 0.9:
        f *= clamp01((DUR - t) / 0.9)
    return (np.clip(f, 0, 1) * 255).astype(np.uint8)


# ---------- 効果音（控えめ: 軽いクリック、低い一打、澄んだ和音） ----------
SR = 48000


def audio():
    n = int(DUR * SR)
    t = np.arange(n) / SR
    out = np.zeros((n, 2))

    def put(s0, sig, pan=0.0):
        s0 = int(s0 * SR); e = min(n, s0 + len(sig))
        out[s0:e, 0] += sig[:e - s0] * (1 - pan) ; out[s0:e, 1] += sig[:e - s0] * (1 + pan)

    seg = lambda d: np.arange(int(d * SR)) / SR
    # 3 行が出るたびの軽いクリック＋短い音
    for k, (_, st) in enumerate(LINES):
        s = seg(0.25)
        put(st, np.sin(2 * np.pi * (880 * 2 ** (k * 2 / 12)) * s) * np.exp(-s * 18) * 0.12, pan=(k - 1) * 0.3)
        c = seg(0.01)
        put(st, rng.standard_normal(len(c)) * np.exp(-c * 600) * 0.15)
    # マークの前のためる音（柔らかいノイズが膨らむ）
    s = seg(T_WORD - 1.9)
    nz = np.convolve(rng.standard_normal(len(s)), np.ones(8) / 8, 'same')
    put(1.9, nz * (s / s[-1]) ** 2 * 0.18)
    # DRAGONFALL の低い一打
    s = seg(2.5)
    put(T_WORD, np.sin(2 * np.pi * (46 + 30 * np.exp(-s * 12)) * s) * np.exp(-s * 2.2) * 0.7)
    # 澄んだ和音（ゆっくり立ち上がって最後まで）
    s = seg(DUR - T_WORD)
    pad = sum(np.sin(2 * np.pi * f0 * s) + 0.5 * np.sin(2 * np.pi * f0 * 1.004 * s) for f0 in (146.8, 220, 293.7, 349.2, 440))
    pad *= (1 - np.exp(-s * 1.5)) * np.clip((DUR - T_WORD - s) / 1.2, 0, 1) * 0.035
    put(T_WORD, pad)
    # 紫の線のきらめき
    s = seg(1.2)
    put(3.7, (np.sin(2 * np.pi * 1760 * s) + 0.4 * np.sin(2 * np.pi * 2637 * s)) * np.exp(-s * 4) * 0.05, pan=0.2)
    out = np.tanh(out * 1.1) * 0.9
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
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR); w.writeframes(a.tobytes())
    mp4 = os.path.join(dst, 'dragonfall_opening.mp4')
    p = subprocess.Popen(['ffmpeg', '-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{W}x{H}', '-r', str(FPS), '-i', '-',
                          '-i', wav, '-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-pix_fmt', 'yuv420p',
                          '-c:a', 'aac', '-b:a', '256k', '-shortest', '-movflags', '+faststart', mp4], stdin=subprocess.PIPE)
    for i in range(N):
        p.stdin.write(render_frame(i).tobytes())
        if i % 60 == 0: print(f'{i}/{N}', flush=True)
    p.stdin.close(); p.wait()
    print('ok', mp4)
