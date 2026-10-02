"""変換結果の採点 (どのツールの出力でも同じ物差しで測る)。

各出力について:
  1. 出力のグリッドとモデルの位置合わせ (整数ずらしを総当たり、表面に乗るボクセルが最多になる所)
  2. 精度 precision: 出力ボクセルのうち、中心から表面まで 0.87 (= ボクセルに表面が触れる) 以内の割合
  3. 再現率 recall: 「表面がボクセル中心の 0.3 以内を通る」ボクセル (= 置かれて当然のブロック) のうち、出力にある割合
     シーンでは部品ごと (猿・細い棒・斜め板・床) にも出す
  4. 色: 正しく置かれたボクセルの真の色 (0.1 間隔の細かい点の平均) とブロックの平均色の CIEDE2000 色差
"""
import json, os, sys, glob, collections
import numpy as np
import bpy
from mathutils.bvhtree import BVHTree
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, "/home/claude/minecraft-server-dev/tools/blender-to-litematic")
from blender_to_litematic import blender_source, litematic, palette, png, voxelize

TEX = os.path.join(HERE, "..", "..", "..", "-home-claude", "aec52b62-a788-5f56-ab8a-8f94a6029dde",
                   "scratchpad", "mcassets", "assets", "minecraft", "textures", "block")
TEX = "/tmp/claude-0/-home-claude/aec52b62-a788-5f56-ab8a-8f94a6029dde/scratchpad/mcassets/assets/minecraft/textures/block"

_block_cache = {}


def block_color(state):
    name = litematic.parse_block_state(state)["Name"].split(":")[1]
    if name in _block_cache:
        return _block_cache[name]
    base = name.replace("waxed_", "")
    cands = [base, base + "_side", base + "_front", base + "_top", base.replace("_block", ""),
             base.replace("_wood", "_log"), base.replace("_hyphae", "_stem"), base + "_0",
             base.replace("bricks", "brick"), "snow" if base == "snow_block" else base]
    rgb = None
    for c in cands:
        p = os.path.join(TEX, c + ".png")
        if os.path.exists(p):
            rgb, _ = png.average_color(png.decode(open(p, "rb").read()))
            break
    if rgb is None:
        print("  色不明:", name)
        rgb = (128, 128, 128)
    _block_cache[name] = rgb
    return rgb


def load_model(model):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=os.path.join(HERE, "models", model + ".glb"))
    objs = [o for o in bpy.context.scene.objects if o.type == "MESH"]
    parts = blender_source.collect(objs, bpy.context.evaluated_depsgraph_get())
    names = [o.name for o in objs]
    return parts, names


def model_space(parts):
    """MC 向き (Y 上) のワールド座標の三角形と、部品番号"""
    tris = np.concatenate([p.tris for p in parts]) @ blender_source.AXIS.T
    part_id = np.concatenate([np.full(len(p.tris), i) for i, p in enumerate(parts)])
    offsets = np.cumsum([0] + [len(p.tris) for p in parts])

    def color_fn(ti, bary):
        out = np.empty((len(ti), 4))
        pid = np.searchsorted(offsets, ti, side="right") - 1
        for k, part in enumerate(parts):
            sel = np.nonzero(pid == k)[0]
            if len(sel):
                out[sel] = part.colors(ti[sel] - offsets[k], bary[sel])
        return out
    return tris, part_id, color_fn


def bvh_of(tris):
    verts = tris.reshape(-1, 3)
    polys = np.arange(len(verts)).reshape(-1, 3).tolist()
    return BVHTree.FromPolygons([Vector(v) for v in verts], polys, all_triangles=True)


def nearest(bvh, pts):
    d = np.empty(len(pts)); f = np.empty(len(pts), dtype=np.int64)
    for i, p in enumerate(pts):
        r = bvh.find_nearest(Vector(p))
        d[i] = r[3]; f[i] = r[2]
    return d, f


def tool_transform(tool, tris_world, size, block_size):
    """ワールド座標 -> そのツールのボクセル座標 (セル [k, k+1) )"""
    lo = tris_world.reshape(-1, 3).min(axis=0)
    hi = tris_world.reshape(-1, 3).max(axis=0)
    if tool == "mine":
        return (tris_world - lo) / block_size
    # ObjToSchematic: 頂点 * (size-1)/高さ (+0.5 if size 偶数), ボクセル中心は整数 -> セルは +0.5 ずらし
    s = (size - 1) / (hi[1] - lo[1])
    v = tris_world * s
    if size % 2 == 0:
        v = v + np.array([0, 0.5, 0])
    v = v + 0.5
    return v - np.floor(v.reshape(-1, 3).min(axis=0))


def evaluate(tool, path, model, size, parts, part_names, info):
    grid, pal, root = litematic.read(path)
    tris_w, part_id, color_fn = model_space(parts)
    tris = tool_transform(tool, tris_w, size, info.get("block_size"))
    bvh = bvh_of(tris)
    occ = np.argwhere(grid > 0)
    ids = grid[grid > 0]

    # 位置合わせ: 一部のボクセルで整数ずらしを総当たり
    rng = np.random.default_rng(0)
    sub = occ[rng.choice(len(occ), min(1500, len(occ)), replace=False)]
    best = None
    for dx in range(-2, 3):
        for dy in range(-2, 3):
            for dz in range(-2, 3):
                c = sub + np.array([dx, dy, dz]) + 0.5
                d, _ = nearest(bvh, c)
                score = (d <= 0.87).mean()
                if best is None or score > best[0]:
                    best = (score, np.array([dx, dy, dz]))
    shift = best[1]
    centers = occ + shift + 0.5
    d_out, _ = nearest(bvh, centers)
    precision = float((d_out <= 0.87).mean())

    # 正解の「置かれて当然」ボクセル
    dims = np.ceil(tris.reshape(-1, 3).max(axis=0)).astype(int) + 2
    acc_keys = []
    fine_colors = collections.defaultdict(list)
    cand = set()
    sums = {}
    keys_all, cols_all = [], []
    for ti, bary, pts in voxelize.sample_triangles(tris, 0.1):
        rgba = color_fn(ti, bary)
        ijk = np.floor(pts).astype(np.int64)
        k = (ijk[:, 0] * dims[1] + ijk[:, 1]) * dims[2] + ijk[:, 2]
        keys_all.append(k)
        cols_all.append(np.concatenate([png.srgb_to_linear(np.clip(rgba[:, :3], 0, 1)), (rgba[:, 3:] >= 0.5)], axis=1))
    keys_all = np.concatenate(keys_all); cols_all = np.concatenate(cols_all)
    uk, inv = np.unique(keys_all, return_inverse=True)
    csum = np.zeros((len(uk), 4)); np.add.at(csum, inv, cols_all)
    cand_ijk = np.stack([uk // (dims[1] * dims[2]), (uk // dims[2]) % dims[1], uk % dims[2]], axis=1)
    d_c, f_c = nearest(bvh, cand_ijk + 0.5)
    core = d_c <= 0.3
    core_part = part_id[f_c]

    out_set = set(map(tuple, (occ + shift).tolist()))
    present = np.array([tuple(p) in out_set for p in cand_ijk.tolist()])
    recall = float(present[core].mean())
    per_part = {}
    if len(parts) > 1:
        for i, n in enumerate(part_names):
            m = core & (core_part == i)
            if m.any():
                per_part[n] = round(float(present[m].mean()), 4)

    # 色: 出力ボクセル (表面に触れていて、正解の色がある所)
    key_of = {tuple(p): j for j, p in enumerate(cand_ijk.tolist())}
    de = []
    pal_rgb = np.array([block_color(p) if p != "minecraft:air" else (0, 0, 0) for p in pal], dtype=np.float64)
    pal_lab = palette.srgb255_to_lab(pal_rgb)
    true_rgb, blk = [], []
    for j, p in enumerate((occ + shift).tolist()):
        if d_out[j] > 0.87:
            continue
        idx = key_of.get(tuple(p))
        if idx is None or csum[idx, 3] == 0:
            continue
        lin = csum[idx, :3] / max(csum[idx, 3], 1)
        true_rgb.append(png.linear_to_srgb(lin) * 255)
        blk.append(ids[j])
    true_lab = palette.srgb255_to_lab(np.array(true_rgb))
    de = palette.delta_e2000(true_lab, pal_lab[np.array(blk)])

    return {
        "tool": tool, "model": model, "size": size, "dims": list(grid.shape),
        "blocks": int(len(occ)), "palette_used": len(pal) - 1,
        "precision": round(precision, 4), "recall": round(recall, 4), "per_part_recall": per_part,
        "deltaE_mean": round(float(de.mean()), 2), "deltaE_median": round(float(np.median(de)), 2),
        "deltaE_p90": round(float(np.percentile(de, 90)), 2),
        "shift": shift.tolist(), "align_score": round(float(best[0]), 4),
        "times_ms": info.get("times_ms"),
    }


if __name__ == "__main__":
    results = []
    out = os.path.join(HERE, "out")
    for model in ("skull", "scene"):
        parts, names = load_model(model)
        for size in (64, 128, 256):
            for tool, fname in (("mine", f"mine_{model}_{size}"),
                                ("o2s-ray", f"o2s_{model}_{size}_ray-based"),
                                ("o2s-bvh", f"o2s_{model}_{size}_bvh-ray")):
                path = os.path.join(out, fname + ".litematic")
                if not os.path.exists(path):
                    continue
                info = json.load(open(os.path.join(out, fname + ".json")))
                r = evaluate("mine" if tool == "mine" else "o2s", path, model, size, parts, names, info)
                r["tool"] = tool
                print(json.dumps(r, ensure_ascii=False), flush=True)
                results.append(r)
    json.dump(results, open(os.path.join(out, "results.json"), "w"), ensure_ascii=False, indent=1)
