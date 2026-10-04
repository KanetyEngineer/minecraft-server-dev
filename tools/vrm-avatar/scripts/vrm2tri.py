"""VRM -> vanilla item models made of one rotated flat element per triangle (26.x multi-axis rotation),
with each triangle's texture re-baked into an axis-aligned slot of one atlas (cutout outside the triangle).

usage: python vrm2tri.py model.glb out_dir name [decimate_ratio] [atlas_size]
Blender frame: front -Y, character's right -X, up +Z. MC model frame: x=x_b, y=z_b, z=-y_b, 16 units/m,
part pivot at model (8,8,8).
"""
import bpy, sys, os, json, math
import numpy as np
from mathutils import Vector, Matrix
from PIL import Image

SRC, OUT, NAME = sys.argv[-5], sys.argv[-4], sys.argv[-3]
RATIO, ATLAS = float(sys.argv[-2]), int(sys.argv[-1])
os.makedirs(OUT, exist_ok=True)
NS = "vrmav"
DOUBLE = ("hair", "tops", "bottoms")  # materials whose inside can be seen

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=SRC)
arm = next(o for o in bpy.data.objects if o.type == "ARMATURE")
B = arm.data.bones

def chain_has(b, name):
    while b:
        if b.name == name:
            return True
        b = b.parent
    return False

def part_of_bone(name):
    b = B.get(name)
    if b is None:
        return "body"
    if chain_has(b, "J_Bip_C_Neck"):
        return "head"
    for side, s in (("L", "l"), ("R", "r")):
        if any(chain_has(b, f"J_{k}_{side}_{n}") for k, n in (("Bip", "UpperArm"), ("Aim", "TopsUpperArm"), ("Aim", "Shoulder"))):
            return f"arm_{s}"
        if chain_has(b, f"J_Bip_{side}_UpperLeg") or chain_has(b, f"J_Aim_{side}_UpperLeg"):
            return f"leg_{s}"
    return "body"

W = lambda n: arm.matrix_world @ B[n].head_local
PIVOT = {"head": W("J_Bip_C_Head"), "body": W("J_Bip_C_Hips"),
         "arm_l": W("J_Bip_L_UpperArm"), "arm_r": W("J_Bip_R_UpperArm"),
         "leg_l": W("J_Bip_L_UpperLeg"), "leg_r": W("J_Bip_R_UpperLeg")}
ROT = {k: Matrix.Identity(3) for k in PIVOT}
ROT["arm_l"] = Matrix.Rotation(math.radians(80), 3, "Y")
ROT["arm_r"] = Matrix.Rotation(math.radians(-80), 3, "Y")

def to_mc(p_b, part):
    r = ROT[part] @ (Vector(p_b) - PIVOT[part])
    return np.array([8 + 16 * r.x, 8 + 16 * r.z, 8 - 16 * r.y])

TEX = {}
def tex_of(mat):
    if mat.name not in TEX:
        img = None
        for n in mat.node_tree.nodes:
            if n.type == "TEX_IMAGE" and n.image and n.image.size[0] > 0:
                # prefer the image feeding base color
                img = n.image
                if any(l.to_socket.name == "Base Color" for l in n.outputs[0].links):
                    break
        arr = None
        if img is not None:
            w, h = img.size
            arr = np.array(img.pixels[:], np.float32).reshape(h, w, 4)[::-1]  # row 0 = top
        TEX[mat.name] = arr
    return TEX[mat.name]

# optional decimation (keeps UVs)
meshes = [o for o in bpy.data.objects if o.type == "MESH" and o.name in ("Body", "Face", "Hair")]
if RATIO < 1:
    for o in meshes:
        if o.data.shape_keys:
            o.shape_key_clear()
        md = o.modifiers.new("dec", "DECIMATE"); md.ratio = RATIO
        bpy.context.view_layer.objects.active = o
        # keep armature modifier off while applying decimate
        for m in o.modifiers:
            if m.type == "ARMATURE":
                m.show_viewport = False
        bpy.ops.object.modifier_apply(modifier="dec")

tris = []  # (part, A,B,C (mc), uvA,uvB,uvC (texel coords), mat, double)
for o in meshes:
    me = o.data
    me.calc_loop_triangles()
    uvl = me.uv_layers.active.data
    gname = {g.index: g.name for g in o.vertex_groups}
    vpart = []
    for v in me.vertices:
        vpart.append(part_of_bone(gname[max(v.groups, key=lambda g: g.weight).group]) if v.groups else "body")
    for t in me.loop_triangles:
        mat = me.materials[t.material_index]
        arr = tex_of(mat)
        if arr is None:
            continue
        ps = [vpart[i] for i in t.vertices]
        part = max(set(ps), key=ps.count)
        P = [to_mc(o.matrix_world @ me.vertices[i].co, part) for i in t.vertices]
        h, w = arr.shape[:2]
        UV = [np.array([uvl[l].uv[0] * w, (1 - uvl[l].uv[1]) * h]) for l in t.loops]
        tris.append((part, P, UV, mat.name, any(k in mat.name.lower() for k in DOUBLE)))
print("triangles", len(tris))

# --- per-triangle rectangle frame and slot size
items = []
for part, P, UV, mname, dbl in tris:
    A, Bv, C = P
    e = [(0, 1, 2), (1, 2, 0), (2, 0, 1)]
    lens = [np.linalg.norm(P[j] - P[i]) for i, j, _ in e]
    k = int(np.argmax(lens)); i, j, l = e[k]
    a, b, c = P[i], P[j], P[l]
    L = lens[k]
    if L < 1e-5:
        continue
    u = (b - a) / L
    ac = c - a
    t = float(ac @ u)
    vv = ac - t * u
    hgt = np.linalg.norm(vv)
    if hgt < 1e-5:
        continue
    v = vv / hgt
    n = np.cross(u, v)
    # texel density from the source UVs
    ua, ub, uc = UV[i], UV[j], UV[l]
    uv_area = abs(np.cross(ub - ua, uc - ua)) / 2
    area3 = L * hgt / 2
    dens = math.sqrt(uv_area / area3) if area3 > 0 else 1  # texels per model unit
    items.append(dict(part=part, a=a, u=u, v=v, n=n, L=L, h=hgt, t=t, uv=(ua, ub, uc), mat=mname, dbl=dbl, dens=dens))

# global scale so all slots fit the atlas (shelf packing, ~75% efficiency target)
def slot_dims(it, s):
    return max(1, int(math.ceil(it["L"] * it["dens"] * s))) + 2, max(1, int(math.ceil(it["h"] * it["dens"] * s))) + 2

def pack(s):
    order = sorted(range(len(items)), key=lambda q: -slot_dims(items[q], s)[1])
    x = y = rowh = 0
    pos = {}
    for q in order:
        w, h = slot_dims(items[q], s)
        if x + w > ATLAS:
            x = 0; y += rowh; rowh = 0
        if y + h > ATLAS:
            return None
        pos[q] = (x, y, w, h)
        x += w; rowh = max(rowh, h)
    return pos

s = 1.0
pos = pack(s)
while pos is None:
    s *= 0.92
    pos = pack(s)
print(f"density scale {s:.3f} (1.0 = same texel density as the source textures)")

atlas = np.zeros((ATLAS, ATLAS, 4), np.float32)
def sample(arr, xy):
    h, w = arr.shape[:2]
    x = np.clip(xy[..., 0], 0, w - 1.001); y = np.clip(xy[..., 1], 0, h - 1.001)
    x0 = np.floor(x).astype(int); y0 = np.floor(y).astype(int); fx = (x - x0)[..., None]; fy = (y - y0)[..., None]
    return (arr[y0, x0] * (1 - fx) * (1 - fy) + arr[y0, x0 + 1] * fx * (1 - fy) +
            arr[y0 + 1, x0] * (1 - fx) * fy + arr[y0 + 1, x0 + 1] * fx * fy)

models = {p: [] for p in PIVOT}
FACE_SCALE = 16.0 / ATLAS
for q, it in enumerate(items):
    if q not in pos:
        continue
    x0, y0, w, h = pos[q]
    iw, ih = w - 2, h - 2  # inner area; 1px border repeats edge texels
    # pixel centers -> rectangle coords (sx along base 0..L, sy height 0..h from base)
    gx, gy = np.meshgrid(np.arange(w) - 1 + 0.5, np.arange(h) - 1 + 0.5)
    sx = gx / iw * it["L"]; sy = (ih - gy) / ih * it["h"]   # image row 0 = top = far from base
    # barycentric in the rectangle plane: a=(0,0), b=(L,0), c=(t,h)
    L, H, T = it["L"], it["h"], it["t"]
    wc = sy / H
    wb = (sx - wc * T) / L
    wa = 1 - wb - wc
    # inside test with a small dilation so neighbouring triangles leave no cracks
    tol = 1.5 / max(iw, ih)
    inside = (wa > -tol) & (wb > -tol) & (wc > -tol)
    bw = np.stack([np.clip(wa, 0, 1), np.clip(wb, 0, 1), np.clip(wc, 0, 1)], -1)
    bw /= bw.sum(-1, keepdims=True)
    ua, ub, uc = it["uv"]
    uvp = bw[..., 0:1] * ua + bw[..., 1:2] * ub + bw[..., 2:3] * uc
    col = sample(TEX[it["mat"]], uvp)
    col[..., 3] = np.where(inside & (col[..., 3] > 0.5), 1.0, 0.0)
    atlas[y0:y0 + h, x0:x0 + w] = col
    # element
    R = Matrix([list(it["u"]), list(it["v"]), list(it["n"])]).transposed()
    eul = R.to_euler("XYZ")
    a = it["a"]
    u0 = (x0 + 1) * FACE_SCALE; u1 = (x0 + 1 + iw) * FACE_SCALE
    v0 = (y0 + 1) * FACE_SCALE; v1 = (y0 + 1 + ih) * FACE_SCALE
    uvs = [round(u0, 5), round(v0, 5), round(u1, 5), round(v1, 5)]
    r4 = lambda z: round(float(z), 4)
    rot = {"origin": [r4(a[0]), r4(a[1]), r4(a[2])],
           "x": round(math.degrees(eul.x), 3), "y": round(math.degrees(eul.y), 3), "z": round(math.degrees(eul.z), 3)}
    els = models[it["part"]]
    els.append({"from": [r4(a[0]), r4(a[1]), r4(a[2])], "to": [r4(a[0] + L), r4(a[1] + H), r4(a[2])],
                "rotation": rot, "faces": {"south": {"uv": uvs, "texture": "#0"}}, "shade": False})
    if it["dbl"]:
        # back side as its own element pushed 0.02 units behind, so the two sides never z-fight
        z = r4(a[2] - 0.02)
        els.append({"from": [r4(a[0]), r4(a[1]), z], "to": [r4(a[0] + L), r4(a[1] + H), z],
                    "rotation": rot, "faces": {"north": {"uv": [uvs[2], uvs[1], uvs[0], uvs[3]], "texture": "#0"}}, "shade": False})

img = Image.fromarray((np.clip(atlas, 0, 1) * 255).round().astype(np.uint8), "RGBA")
img.save(os.path.join(OUT, f"{NAME}_atlas.png"))
out = {"pivots": {k: list(v) for k, v in PIVOT.items()}, "models": {}}
for p, els in models.items():
    out["models"][p] = {"textures": {"0": f"{NS}:item/{NAME}_atlas", "particle": f"{NS}:item/{NAME}_atlas"}, "elements": els}
json.dump(out, open(os.path.join(OUT, "tri_models.json"), "w"), separators=(",", ":"))
nq = sum(len(e["faces"]) for els in models.values() for e in els)
print("elements", {p: len(e) for p, e in models.items()}, "quads", nq)
allc = np.array([e["from"] + e["to"] for els in models.values() for e in els])
print("coord range", allc.min(), allc.max())
