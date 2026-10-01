"""三角形メッシュ -> ボクセル (numpy のみ。Blender に依存しない)。

方式:
  1. 各三角形の表面に、ボクセル 1 辺の 1/4 以下の間隔で点を打つ
  2. 点が落ちたボクセルを「表面ボクセル」とし、点の色の平均をそのボクセルの色にする
  3. (任意) 外側から空きボクセルを塗りつぶし、届かなかった所を「内部」とする
座標はすべてボクセル単位 (1.0 = 1 ブロック)、Minecraft の向き (Y が上)。
"""

import numpy as np

from . import png

DEFAULT_SPACING = 0.25


def _bary_lattice(n):
    """三角形を n 分割した格子点の重心座標 (K, 3)"""
    i, j = np.meshgrid(np.arange(n + 1), np.arange(n + 1), indexing="ij")
    mask = (i + j) <= n
    i = i[mask].astype(np.float64)
    j = j[mask].astype(np.float64)
    w1 = i / n
    w2 = j / n
    w0 = 1.0 - w1 - w2
    bary = np.stack([w0, w1, w2], axis=1)
    if n > 1:
        # 隣の三角形と点が重ならないよう、少しだけ内側へずらす
        centroid = np.full(3, 1 / 3)
        bary = bary + (centroid - bary) * 1e-4
    return bary


def sample_triangles(tris, spacing=DEFAULT_SPACING, max_points=2_000_000):
    """tris: (T, 3, 3) の頂点座標。
    (tri_index (P,), bary (P, 3), points (P, 3)) をまとまりごとに yield する。"""
    tris = np.asarray(tris, dtype=np.float64)
    if len(tris) == 0:
        return
    e0 = np.linalg.norm(tris[:, 1] - tris[:, 0], axis=1)
    e1 = np.linalg.norm(tris[:, 2] - tris[:, 1], axis=1)
    e2 = np.linalg.norm(tris[:, 0] - tris[:, 2], axis=1)
    longest = np.maximum(np.maximum(e0, e1), e2)
    n_div = np.maximum(1, np.ceil(longest / spacing)).astype(np.int64)
    for n in np.unique(n_div):
        idx = np.nonzero(n_div == n)[0]
        bary = _bary_lattice(int(n))
        k = len(bary)
        per = max(1, max_points // k)
        for s in range(0, len(idx), per):
            sel = idx[s:s + per]
            pts = np.einsum("kv,tvc->tkc", bary, tris[sel]).reshape(-1, 3)
            tri_index = np.repeat(sel, k)
            yield tri_index, np.tile(bary, (len(sel), 1)), pts


class VoxelAccumulator:
    """点と色を受け取り、ボクセルごとの色を求める。

    matcher を渡すと「最頻」モード: 点ごとにブロックを決め、ボクセル内で最も多い
    ブロックを採用する (色の境目で混ざった中間色のブロックが出ない)。
    渡さなければ「平均」モード: 点の平均色を後でブロックに対応づける。"""

    def __init__(self, dims, alpha_threshold=0.5, matcher=None):
        self.dims = tuple(int(d) for d in dims)
        self.alpha_threshold = alpha_threshold
        self.matcher = matcher
        self._keys = []
        self._sums = []
        self._counts = []
        self._votes = []

    def add(self, points, rgba):
        """points: (P, 3) ボクセル座標、rgba: (P, 4) sRGB 0..1"""
        rgba = np.asarray(rgba, dtype=np.float64)
        keep = rgba[:, 3] >= self.alpha_threshold
        if not keep.any():
            return
        pts = points[keep]
        lin = png.srgb_to_linear(np.clip(rgba[keep, :3], 0.0, 1.0))
        ijk = np.floor(pts).astype(np.int64)
        dx, dy, dz = self.dims
        for a, d in enumerate(self.dims):
            np.clip(ijk[:, a], 0, d - 1, out=ijk[:, a])
        keys = (ijk[:, 0] * dy + ijk[:, 1]) * dz + ijk[:, 2]
        if self.matcher is not None:
            nb = len(self.matcher.block_ids)
            srgb = png.linear_to_srgb(lin) * 255.0
            blocks = self.matcher.match_quantized(srgb)
            pair, cnt = np.unique(keys * nb + blocks, return_counts=True)
            self._votes.append((pair, cnt))
        uniq, inv = np.unique(keys, return_inverse=True)
        sums = np.zeros((len(uniq), 3))
        np.add.at(sums, inv, lin)
        counts = np.bincount(inv, minlength=len(uniq)).astype(np.float64)
        self._keys.append(uniq)
        self._sums.append(sums)
        self._counts.append(counts)

    def result(self):
        """(coords (N, 3) int, rgb (N, 3) sRGB 0-255, blocks (N,) または None)
        blocks は最頻モードのときの matcher.block_ids のインデックス。"""
        if not self._keys:
            return np.zeros((0, 3), dtype=np.int64), np.zeros((0, 3)), None
        keys = np.concatenate(self._keys)
        sums = np.concatenate(self._sums)
        counts = np.concatenate(self._counts)
        uniq, inv = np.unique(keys, return_inverse=True)
        tot = np.zeros((len(uniq), 3))
        np.add.at(tot, inv, sums)
        cnt = np.bincount(inv, weights=counts, minlength=len(uniq))
        mean = tot / cnt[:, None]
        rgb = png.linear_to_srgb(mean) * 255.0
        dx, dy, dz = self.dims
        coords = np.stack([uniq // (dy * dz), (uniq // dz) % dy, uniq % dz], axis=1)
        blocks = None
        if self.matcher is not None:
            nb = len(self.matcher.block_ids)
            pair = np.concatenate([p for p, _ in self._votes])
            cnt = np.concatenate([c for _, c in self._votes])
            pair, inv = np.unique(pair, return_inverse=True)
            cnt = np.bincount(inv, weights=cnt)
            vkey, vblock = pair // nb, pair % nb
            # キーごとに票の多い順へ並べ、各キーの先頭を取る
            order = np.lexsort((-cnt, vkey))
            vkey, vblock = vkey[order], vblock[order]
            first = np.ones(len(vkey), dtype=bool)
            first[1:] = vkey[1:] != vkey[:-1]
            blocks = vblock[first]  # vkey[first] は uniq と同じ並び
        return coords, rgb, blocks


def _propagate(outside, free, axis):
    """axis 方向に連続した空きボクセルの並びへ「外側」を広げる。"""
    o = np.moveaxis(outside, axis, -1)
    f = np.moveaxis(free, axis, -1)
    shape = o.shape
    o2 = o.reshape(-1, shape[-1])
    f2 = f.reshape(-1, shape[-1])
    length = shape[-1]
    run = np.cumsum(~f2, axis=1) + (np.arange(len(f2)) * (length + 1))[:, None]
    has_out = np.bincount(run[o2 & f2], minlength=run.max() + 1) > 0
    result = f2 & has_out[run]
    return np.moveaxis(result.reshape(shape), -1, axis)


def flood_outside(solid):
    """solid の外側 (境界から空きボクセルを通って届く所) を True にした配列を返す。"""
    free = ~solid
    outside = np.zeros_like(solid)
    outside[0, :, :] = free[0, :, :]
    outside[-1, :, :] |= free[-1, :, :]
    outside[:, 0, :] |= free[:, 0, :]
    outside[:, -1, :] |= free[:, -1, :]
    outside[:, :, 0] |= free[:, :, 0]
    outside[:, :, -1] |= free[:, :, -1]
    while True:
        before = int(outside.sum())
        for axis in range(3):
            outside = _propagate(outside, free, axis)
        if int(outside.sum()) == before:
            return outside


def _dilate6(mask):
    out = mask.copy()
    out[1:] |= mask[:-1]
    out[:-1] |= mask[1:]
    out[:, 1:] |= mask[:, :-1]
    out[:, :-1] |= mask[:, 1:]
    out[:, :, 1:] |= mask[:, :, :-1]
    out[:, :, :-1] |= mask[:, :, 1:]
    return out


def interior_mask(shell):
    """表面ボクセル shell の内側を True にした配列 (shell 自体は含まない)。

    サンプリングの取りこぼしで殻に小さな穴があっても中身が漏れないよう、
    1 マス太らせた殻で塗りつぶしてから、殻に接する外側の 1 層を戻す。"""
    padded = np.pad(shell, 1)
    thick = _dilate6(padded)
    outside = flood_outside(thick)
    for _ in range(2):
        outside = outside | (_dilate6(outside) & ~padded)
    inside = ~outside & ~padded
    return inside[1:-1, 1:-1, 1:-1]
