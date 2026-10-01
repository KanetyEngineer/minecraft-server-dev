import os, sys, tempfile, time
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from blender_to_litematic import converter, litematic, palette, nbt


def icosphere(subdiv=3, r=10.0, c=(10.5, 10.5, 10.5)):
    t = (1 + 5 ** 0.5) / 2
    v = [(-1, t, 0), (1, t, 0), (-1, -t, 0), (1, -t, 0), (0, -1, t), (0, 1, t), (0, -1, -t), (0, 1, -t),
         (t, 0, -1), (t, 0, 1), (-t, 0, -1), (-t, 0, 1)]
    f = [(0, 11, 5), (0, 5, 1), (0, 1, 7), (0, 7, 10), (0, 10, 11), (1, 5, 9), (5, 11, 4), (11, 10, 2), (10, 7, 6),
         (7, 1, 8), (3, 9, 4), (3, 4, 2), (3, 2, 6), (3, 6, 8), (3, 8, 9), (4, 9, 5), (2, 4, 11), (6, 2, 10), (8, 6, 7), (9, 8, 1)]
    v = [np.array(p, float) / np.linalg.norm(p) for p in v]
    for _ in range(subdiv):
        cache, nf = {}, []
        def mid(a, b):
            k = tuple(sorted((a, b)))
            if k not in cache:
                m = v[a] + v[b]; v.append(m / np.linalg.norm(m)); cache[k] = len(v) - 1
            return cache[k]
        for a, b, cc in f:
            ab, bc, ca = mid(a, b), mid(b, cc), mid(cc, a)
            nf += [(a, ab, ca), (b, bc, ab), (cc, ca, bc), (ab, bc, ca)]
        f = nf
    V = np.array(v) * r + np.array(c)
    return V[np.array(f)]


def test_bitpack_roundtrip():
    rng = np.random.default_rng(1)
    for bits in (2, 3, 5, 7, 13):
        vals = rng.integers(0, 1 << bits, 1001)
        longs = litematic.pack_indices(vals, bits)
        assert (litematic.unpack_indices(longs, bits, len(vals)) == vals).all()


def test_sphere():
    tris = icosphere()
    # 上半分は赤、下半分は青
    def color_fn(ti, bary):
        p = np.einsum("pv,pvc->pc", bary, tris[ti])
        out = np.zeros((len(ti), 4)); out[:, 3] = 1
        top = p[:, 1] > 10.5
        out[top, 0] = 0.8; out[~top, 2] = 0.8
        return out
    m = converter.default_matcher(categories={"concrete"})
    for fill in (False, True):
        path = os.path.join(tempfile.mkdtemp(), "s.litematic")
        res = converter.convert(tris, color_fn, m, path, converter.Options(fill_interior=fill, name="sphere"))
        grid, pal, root = litematic.read(path)
        print("fill", fill, res.dims, res.block_counts)
        assert root["Version"].value == 7 and root["MinecraftDataVersion"].value == 4903
        assert "minecraft:red_concrete" in pal and "minecraft:blue_concrete" in pal
        top = np.array(pal)[grid[:, 15:, :]]; assert set(np.unique(top)) <= {"minecraft:air", "minecraft:red_concrete", "minecraft:stone"}
        if fill:
            assert pal[grid[10, 10, 10]] == "minecraft:stone"
        else:
            assert grid[10, 10, 10] == 0
        # litemapy (独立した実装) でも読めるか
        import litemapy
        s = litemapy.Schematic.load(path)
        reg = list(s.regions.values())[0]
        assert (reg.width, reg.height, reg.length) == res.dims
        n = sum(1 for x in reg.range_x() for y in reg.range_y() for z in reg.range_z() if reg[x, y, z].id != "minecraft:air")
        assert n == res.total_blocks, (n, res.total_blocks)


def test_speed():
    tris = icosphere(5, r=60, c=(61, 61, 61))
    m = converter.default_matcher()
    t = time.time()
    res = converter.convert(tris, lambda ti, b: np.tile([0.5, 0.6, 0.3, 1], (len(ti), 1)), m,
                            os.path.join(tempfile.mkdtemp(), "big.litematic"), converter.Options(fill_interior=True))
    print("big sphere", res.dims, res.surface_voxels, res.interior_voxels, f"{time.time()-t:.1f}s")
    # 半径 60 の球の体積 ≒ 904779
    assert abs(res.total_blocks - 4 / 3 * np.pi * 60 ** 3) / (4 / 3 * np.pi * 60 ** 3) < 0.05


if __name__ == "__main__":
    for k, f in list(globals().items()):
        if k.startswith("test_"):
            f(); print("ok", k)
