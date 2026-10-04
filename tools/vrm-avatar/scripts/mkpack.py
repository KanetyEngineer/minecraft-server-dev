"""parts.json (voxels) -> vanilla resource pack with one flat-quad item model per body part.

usage: python mkpack.py vox/parts.json out_dir avatar_name
"""
import json, os, sys, zipfile
import numpy as np
from PIL import Image

SRC, OUT, NAME = sys.argv[1], sys.argv[2], sys.argv[3]
NS = "vrmav"
data = json.load(open(SRC))
os.makedirs(OUT, exist_ok=True)

# palette texture 16x16
pal = data["palette"]
pimg = Image.new("RGBA", (16, 16), (255, 0, 255, 255))
for i, c in enumerate(pal[:256]):
    pimg.putpixel((i % 16, i // 16), tuple(int(v) for v in c) + (255,))

FACES = {(0, 1): "east", (0, -1): "west", (1, 1): "up", (1, -1): "down", (2, 1): "south", (2, -1): "north"}

def mesh(cells):
    """cells: {(X,Y,Z): label} in MC axis order -> list of (axis, sign, plane, u0, v0, u1, v1, label)."""
    out = []
    keys = np.array(list(cells.keys()))
    for axis in range(3):
        oa = [a for a in range(3) if a != axis]
        for sign in (1, -1):
            # collect exposed faces grouped by slice
            sl = {}
            for k, lab in cells.items():
                n = list(k); n[axis] += sign
                if tuple(n) in cells:
                    continue
                plane = k[axis] + (1 if sign > 0 else 0)
                sl.setdefault(plane, {})[(k[oa[0]], k[oa[1]])] = lab
            for plane, m in sl.items():
                left = dict(m)
                for (u, v) in sorted(m):
                    if (u, v) not in left:
                        continue
                    lab = left[(u, v)]
                    u2 = u
                    while left.get((u2 + 1, v)) == lab:
                        u2 += 1
                    v2 = v
                    while all(left.get((uu, v2 + 1)) == lab for uu in range(u, u2 + 1)):
                        v2 += 1
                    for uu in range(u, u2 + 1):
                        for vv in range(v, v2 + 1):
                            del left[(uu, vv)]
                    out.append((axis, sign, plane, u, v, u2 + 1, v2 + 1, lab))
    return out

models = {}
stats = {}
for part, P in data["parts"].items():
    s = P["voxel"]
    # blender cell (i,j,k) -> MC cell (i, k, -j-1)
    cells = {(c[0], c[2], -c[1] - 1): c[3] for c in P["cells"]}
    quads = mesh(cells)
    els = []
    f = 16 * s
    for axis, sign, plane, u0, v0, u1, v1, lab in quads:
        oa = [a for a in range(3) if a != axis]
        lo = [0, 0, 0]; hi = [0, 0, 0]
        lo[axis] = hi[axis] = 8 + plane * f
        lo[oa[0]], hi[oa[0]] = 8 + u0 * f, 8 + u1 * f
        lo[oa[1]], hi[oa[1]] = 8 + v0 * f, 8 + v1 * f
        pu, pv = lab % 16, lab // 16
        els.append({"from": [round(x, 4) for x in lo], "to": [round(x, 4) for x in hi],
                    "faces": {FACES[(axis, sign)]: {"uv": [pu + 0.3, pv + 0.3, pu + 0.7, pv + 0.7], "texture": "#0"}}})
    allc = np.array([e["from"] + e["to"] for e in els])
    assert allc.min() >= -16 and allc.max() <= 32, (part, allc.min(), allc.max())
    models[part] = {"textures": {"0": f"{NS}:item/{NAME}_palette", "particle": f"{NS}:item/{NAME}_palette"},
                    "elements": els}
    stats[part] = len(els)
print("quads per part", stats, "total", sum(stats.values()))

rp = os.path.join(OUT, f"{NAME}_resourcepack.zip")
with zipfile.ZipFile(rp, "w", zipfile.ZIP_DEFLATED) as z:
    z.writestr("pack.mcmeta", json.dumps({"pack": {"description": f"VRM avatar: {NAME}",
                                                    "min_format": 65, "max_format": 999}}))
    import io
    b = io.BytesIO(); pimg.save(b, "PNG")
    z.writestr(f"assets/{NS}/textures/item/{NAME}_palette.png", b.getvalue())
    for part, m in models.items():
        z.writestr(f"assets/{NS}/models/item/{NAME}_{part}.json", json.dumps(m, separators=(",", ":")))
        z.writestr(f"assets/{NS}/items/{NAME}_{part}.json",
                   json.dumps({"model": {"type": "minecraft:model", "model": f"{NS}:item/{NAME}_{part}"}}))
json.dump(models, open(os.path.join(OUT, "models.json"), "w"))
pimg.save(os.path.join(OUT, "palette.png"))
print("wrote", rp, os.path.getsize(rp), "bytes")
