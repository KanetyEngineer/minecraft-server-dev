"""小さな PNG デコーダ (numpy 版)。

Minecraft のテクスチャ (8bit RGBA / RGB / グレー / パレット) を読むためだけのもの。
インターレース PNG と 16bit は対象外 (バニラのテクスチャには存在しない)。
"""

import struct
import zlib

import numpy as np

_CHANNELS = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}


def _unfilter(raw, height, stride, bpp):
    out = np.zeros((height, stride), dtype=np.uint8)
    prev = np.zeros(stride, dtype=np.int32)
    pos = 0
    for y in range(height):
        ftype = raw[pos]
        line = np.frombuffer(raw, dtype=np.uint8, count=stride, offset=pos + 1).astype(np.int32)
        pos += stride + 1
        if ftype == 0:
            cur = line
        elif ftype == 1:
            cur = line.copy()
            for i in range(bpp, stride):
                cur[i] = (cur[i] + cur[i - bpp]) & 0xFF
        elif ftype == 2:
            cur = (line + prev) & 0xFF
        elif ftype == 3:
            cur = line.copy()
            for i in range(stride):
                left = cur[i - bpp] if i >= bpp else 0
                cur[i] = (cur[i] + ((left + prev[i]) >> 1)) & 0xFF
        elif ftype == 4:
            cur = line.copy()
            for i in range(stride):
                a = cur[i - bpp] if i >= bpp else 0
                b = prev[i]
                c = prev[i - bpp] if i >= bpp else 0
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                pred = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                cur[i] = (cur[i] + pred) & 0xFF
        else:
            raise ValueError(f"不正な PNG フィルタ {ftype}")
        out[y] = cur
        prev = cur
    return out


def decode(data):
    """PNG バイト列 -> (H, W, 4) uint8 の RGBA 配列"""
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("PNG ではありません")
    pos = 8
    idat = []
    plte = None
    trns = None
    width = height = depth = ctype = interlace = None
    while pos < len(data):
        length, kind = struct.unpack_from(">I4s", data, pos)
        chunk = data[pos + 8:pos + 8 + length]
        pos += 12 + length
        if kind == b"IHDR":
            width, height, depth, ctype, _, _, interlace = struct.unpack(">IIBBBBB", chunk)
        elif kind == b"PLTE":
            plte = np.frombuffer(chunk, dtype=np.uint8).reshape(-1, 3)
        elif kind == b"tRNS":
            trns = chunk
        elif kind == b"IDAT":
            idat.append(chunk)
        elif kind == b"IEND":
            break
    if interlace:
        raise ValueError("インターレース PNG には未対応です")
    if depth == 16:
        raise ValueError("16bit PNG には未対応です")
    channels = _CHANNELS[ctype]
    bits_pp = depth * channels
    stride = (width * bits_pp + 7) // 8
    bpp = max(1, bits_pp // 8)
    rows = _unfilter(zlib.decompress(b"".join(idat)), height, stride, bpp)

    if depth < 8:
        bits = np.unpackbits(rows, axis=1)
        bits = bits[:, :width * depth].reshape(height, width, depth)
        weights = (1 << np.arange(depth - 1, -1, -1)).astype(np.uint16)
        samples = (bits * weights).sum(axis=2).astype(np.uint16)
        if ctype == 0:
            samples = (samples * (255 // ((1 << depth) - 1))).astype(np.uint8)
        samples = samples[..., None]
    else:
        samples = rows[:, :width * channels].reshape(height, width, channels)

    rgba = np.empty((height, width, 4), dtype=np.uint8)
    if ctype == 3:
        idx = samples[..., 0].astype(np.int64)
        rgba[..., :3] = plte[idx]
        alpha = np.full(len(plte), 255, dtype=np.uint8)
        if trns is not None:
            t = np.frombuffer(trns, dtype=np.uint8)
            alpha[:len(t)] = t
        rgba[..., 3] = alpha[idx]
    elif ctype == 0:
        rgba[..., :3] = samples[..., :1]
        rgba[..., 3] = 255
    elif ctype == 4:
        rgba[..., :3] = samples[..., :1]
        rgba[..., 3] = samples[..., 1]
    elif ctype == 2:
        rgba[..., :3] = samples
        rgba[..., 3] = 255
    else:
        rgba[...] = samples
    return rgba


def average_color(rgba):
    """不透明部分の平均色 (sRGB 0-255) と、不透明画素の割合を返す。
    アニメーションテクスチャ (縦長) は最初のフレームだけを使う。"""
    h, w = rgba.shape[:2]
    if h > w and h % w == 0:
        rgba = rgba[:w]
    a = rgba[..., 3].astype(np.float64) / 255.0
    coverage = float(a.mean())
    if a.sum() == 0:
        return (0, 0, 0), 0.0
    # 平均は線形空間で取る (見た目の明るさに近くなる)
    lin = srgb_to_linear(rgba[..., :3].astype(np.float64) / 255.0)
    mean = (lin * a[..., None]).sum(axis=(0, 1)) / a.sum()
    srgb = linear_to_srgb(mean)
    return tuple(int(round(v * 255)) for v in srgb), coverage


def srgb_to_linear(c):
    c = np.asarray(c, dtype=np.float64)
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def linear_to_srgb(c):
    c = np.clip(np.asarray(c, dtype=np.float64), 0.0, 1.0)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * np.power(c, 1 / 2.4) - 0.055)
