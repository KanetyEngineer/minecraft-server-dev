"""ブロックの色パレットと、色 -> ブロックの対応づけ。

色の近さは CIEDE2000 色差で測る。RGB の距離より人の見た目に近い。
"""

import json
import os
import zipfile

import numpy as np

from . import png
from .blocks import BLOCK_DEFS

TEXTURE_PREFIX = "assets/minecraft/textures/block/"


# --- 色空間 ---------------------------------------------------------------

def srgb255_to_lab(rgb):
    rgb = np.asarray(rgb, dtype=np.float64) / 255.0
    lin = png.srgb_to_linear(rgb)
    m = np.array([[0.4124564, 0.3575761, 0.1804375],
                  [0.2126729, 0.7151522, 0.0721750],
                  [0.0193339, 0.1191920, 0.9503041]])
    xyz = lin @ m.T
    xyz = xyz / np.array([0.95047, 1.0, 1.08883])
    eps = 216 / 24389
    kappa = 24389 / 27
    f = np.where(xyz > eps, np.cbrt(xyz), (kappa * xyz + 16) / 116)
    lab = np.stack([116 * f[..., 1] - 16,
                    500 * (f[..., 0] - f[..., 1]),
                    200 * (f[..., 1] - f[..., 2])], axis=-1)
    return lab


def delta_e2000(lab1, lab2):
    """CIEDE2000 色差。lab1 (..., 3) と lab2 (..., 3) をブロードキャストして計算する。"""
    L1, a1, b1 = lab1[..., 0], lab1[..., 1], lab1[..., 2]
    L2, a2, b2 = lab2[..., 0], lab2[..., 1], lab2[..., 2]
    C1 = np.hypot(a1, b1)
    C2 = np.hypot(a2, b2)
    Cb7 = ((C1 + C2) / 2) ** 7
    G = 0.5 * (1 - np.sqrt(Cb7 / (Cb7 + 25 ** 7)))
    a1p, a2p = (1 + G) * a1, (1 + G) * a2
    C1p, C2p = np.hypot(a1p, b1), np.hypot(a2p, b2)
    h1p = np.degrees(np.arctan2(b1, a1p)) % 360
    h2p = np.degrees(np.arctan2(b2, a2p)) % 360
    dLp = L2 - L1
    dCp = C2p - C1p
    dh = h2p - h1p
    dh = np.where(dh > 180, dh - 360, np.where(dh < -180, dh + 360, dh))
    dh = np.where(C1p * C2p == 0, 0, dh)
    dHp = 2 * np.sqrt(C1p * C2p) * np.sin(np.radians(dh / 2))
    Lbp = (L1 + L2) / 2
    Cbp = (C1p + C2p) / 2
    hsum = h1p + h2p
    hbp = np.where(np.abs(h1p - h2p) > 180,
                   np.where(hsum < 360, (hsum + 360) / 2, (hsum - 360) / 2), hsum / 2)
    hbp = np.where(C1p * C2p == 0, hsum, hbp)
    T = (1 - 0.17 * np.cos(np.radians(hbp - 30)) + 0.24 * np.cos(np.radians(2 * hbp))
         + 0.32 * np.cos(np.radians(3 * hbp + 6)) - 0.20 * np.cos(np.radians(4 * hbp - 63)))
    dtheta = 30 * np.exp(-(((hbp - 275) / 25) ** 2))
    Cbp7 = Cbp ** 7
    Rc = 2 * np.sqrt(Cbp7 / (Cbp7 + 25 ** 7))
    Sl = 1 + 0.015 * (Lbp - 50) ** 2 / np.sqrt(20 + (Lbp - 50) ** 2)
    Sc = 1 + 0.045 * Cbp
    Sh = 1 + 0.015 * Cbp * T
    Rt = -np.sin(np.radians(2 * dtheta)) * Rc
    return np.sqrt((dLp / Sl) ** 2 + (dCp / Sc) ** 2 + (dHp / Sh) ** 2
                   + Rt * (dCp / Sc) * (dHp / Sh))


# --- パレットの用意 ---------------------------------------------------------

def load_builtin():
    """同梱のパレット: {block_id: (r, g, b)}"""
    from .palette_data import COLORS
    return dict(COLORS)


def compute_from_textures(source):
    """クライアント jar / リソースパック zip / 展開済みフォルダからブロックの平均色を計算する。
    source がフォルダなら、その中の assets/minecraft/textures/block か、
    フォルダ自体が textures/block であるものとして扱う。
    戻り値: ({block_id: (r, g, b)}, [見つからなかったテクスチャ名])"""
    reader = _texture_reader(source)
    colors, missing = {}, []
    for block_id, tex, _cat, _flags in BLOCK_DEFS:
        data = reader(tex)
        if data is None:
            missing.append(tex)
            continue
        rgb, _cov = png.average_color(png.decode(data))
        colors[block_id] = rgb
    return colors, missing


def _texture_reader(source):
    source = os.path.expanduser(source)
    if os.path.isdir(source):
        base = source
        sub = os.path.join(source, *TEXTURE_PREFIX.strip("/").split("/"))
        if os.path.isdir(sub):
            base = sub

        def read_dir(name):
            path = os.path.join(base, name + ".png")
            if not os.path.isfile(path):
                return None
            with open(path, "rb") as f:
                return f.read()
        return read_dir

    zf = zipfile.ZipFile(source)
    names = set(zf.namelist())

    def read_zip(name):
        path = TEXTURE_PREFIX + name + ".png"
        return zf.read(path) if path in names else None
    return read_zip


def save_json(path, colors):
    with open(path, "w", encoding="utf-8") as f:
        json.dump({k: list(v) for k, v in colors.items()}, f, indent=1)


def load_json(path):
    with open(path, encoding="utf-8") as f:
        return {k: tuple(v) for k, v in json.load(f).items()}


# --- 対応づけ ---------------------------------------------------------------

def select_blocks(colors, categories=None, allow_gravity=False, allow_light=True,
                  allow_glass=False, exclude=(), include=()):
    """条件に合うブロックの ID リストを返す。"""
    exclude = set(exclude)
    chosen = []
    for block_id, _tex, cat, flags in BLOCK_DEFS:
        if block_id not in colors or block_id in exclude:
            continue
        if block_id in include:
            chosen.append(block_id)
            continue
        if categories is not None and cat not in categories:
            continue
        if "gravity" in flags and not allow_gravity:
            continue
        if "light" in flags and not allow_light:
            continue
        if "glass" in flags and not allow_glass:
            continue
        chosen.append(block_id)
    for block_id in include:
        if block_id in colors and block_id not in chosen:
            chosen.append(block_id)
    return chosen


class Matcher:
    """色 (sRGB 0-255) を最も近いブロックへ対応づける。"""

    def __init__(self, colors, block_ids):
        if not block_ids:
            raise ValueError("使えるブロックがありません。カテゴリの選択を見直してください。")
        self.block_ids = list(block_ids)
        self.rgb = np.array([colors[b] for b in self.block_ids], dtype=np.float64)
        self.lab = srgb255_to_lab(self.rgb)

    def match(self, rgb):
        """rgb: (N, 3) -> 各色に対応する block_ids のインデックス (N,)"""
        lab = srgb255_to_lab(np.asarray(rgb, dtype=np.float64))
        out = np.empty(len(lab), dtype=np.int64)
        step = 2048
        for i in range(0, len(lab), step):
            d = delta_e2000(lab[i:i + step, None, :], self.lab[None, :, :])
            out[i:i + step] = d.argmin(axis=1)
        return out

    def match_quantized(self, rgb):
        """match と同じだが、色を各 5bit に丸めて表を引く (大量の点向け)。"""
        if getattr(self, "_lut", None) is None:
            q = np.arange(32, dtype=np.float64) * (255 / 31)
            r, g, b = np.meshgrid(q, q, q, indexing="ij")
            self._lut = self.match(np.stack([r, g, b], axis=-1).reshape(-1, 3))
        q = np.clip(np.rint(np.asarray(rgb, dtype=np.float64) * (31 / 255)), 0, 31).astype(np.int64)
        return self._lut[(q[:, 0] * 32 + q[:, 1]) * 32 + q[:, 2]]
