"""変換の本体: 三角形 + 色の取り方 -> .litematic (Blender に依存しない)。"""

from dataclasses import dataclass, field

import numpy as np

from . import litematic, palette, voxelize


@dataclass
class Options:
    color_mode: str = "MODE"  # "MODE" (最頻) / "AVERAGE" (平均)
    fill_interior: bool = False
    interior_block: str = "minecraft:stone"
    spacing: float = voxelize.DEFAULT_SPACING
    alpha_threshold: float = 0.5
    data_version: int = litematic.DATA_VERSIONS[litematic.DEFAULT_MC_VERSION]
    name: str = "Model"
    author: str = ""
    description: str = ""


@dataclass
class Result:
    dims: tuple
    block_counts: dict = field(default_factory=dict)
    surface_voxels: int = 0
    interior_voxels: int = 0

    @property
    def total_blocks(self):
        return sum(self.block_counts.values())


def grid_dims(tris):
    """ボクセル座標の三角形を囲むグリッドの大きさ。
    ちょうど整数の位置にある面 (例: 高さ 8.0 の天面) は内側のマスに入れる。"""
    hi = np.asarray(tris).reshape(-1, 3).max(axis=0)
    return tuple(int(v) for v in np.maximum(1, np.ceil(hi - 1e-7).astype(np.int64)))


def convert(tris, color_fn, matcher, out_path, options=None, progress=None):
    """tris: (T, 3, 3) ボクセル座標 (min が 0 付近、Y が上)。
    color_fn(tri_index, bary) -> (P, 4) の sRGB 0..1 (A は透明度)。
    matcher: palette.Matcher
    """
    options = options or Options()
    tris = np.asarray(tris, dtype=np.float64)
    dims = grid_dims(tris)
    acc = voxelize.VoxelAccumulator(
        dims, options.alpha_threshold, matcher if options.color_mode == "MODE" else None)
    for tri_index, bary, pts in voxelize.sample_triangles(tris, options.spacing):
        acc.add(pts, color_fn(tri_index, bary))
        if progress:
            progress()
    coords, rgb, voted = acc.result()

    names = ["minecraft:air"]
    name_index = {"minecraft:air": 0}

    def idx_of(block):
        if block not in name_index:
            name_index[block] = len(names)
            names.append(block)
        return name_index[block]

    grid = np.zeros(dims, dtype=np.int32)
    if len(coords):
        matched = voted if voted is not None else matcher.match(rgb)
        lut = np.array([idx_of(b) for b in matcher.block_ids], dtype=np.int64)
        grid[coords[:, 0], coords[:, 1], coords[:, 2]] = lut[matched]

    interior = 0
    if options.fill_interior and len(coords):
        inside = voxelize.interior_mask(grid > 0)
        interior = int(inside.sum())
        if interior:
            grid[inside] = idx_of(litematic.format_block_state(
                litematic.parse_block_state(options.interior_block)))

    # 使われなかったブロックをパレットから外して詰め直す
    counts_all = np.bincount(grid.reshape(-1), minlength=len(names))
    used = np.nonzero(counts_all)[0]
    remap = np.zeros(len(names), dtype=np.int32)
    remap[used] = np.arange(len(used))
    grid = remap[grid]
    names = [names[i] for i in used]
    if names[0] != "minecraft:air":
        names = ["minecraft:air"] + names
        grid = grid + 1

    litematic.write(out_path, grid, names, name=options.name, author=options.author,
                    description=options.description, data_version=options.data_version)
    counts = np.zeros(len(names), dtype=np.int64)
    counts[(remap[used] + (0 if used[0] == 0 else 1))] = counts_all[used]
    return Result(
        dims=dims,
        block_counts={names[i]: int(c) for i, c in enumerate(counts) if i > 0 and c},
        surface_voxels=int(len(coords)),
        interior_voxels=interior,
    )


def default_matcher(colors=None, **select_kwargs):
    colors = colors or palette.load_builtin()
    return palette.Matcher(colors, palette.select_blocks(colors, **select_kwargs))
