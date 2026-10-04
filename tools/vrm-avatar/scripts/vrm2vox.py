"""VRM -> voxel item models per body part (vanilla resource pack, no mods).

usage: python vrm2vox.py model.glb out_dir
Writes out_dir/parts.json (boxes per part, palette) used by mkpack.py and the preview.
Blender frame: front -Y, character's right -X, up +Z (meters).
MC model frame: x = x_b, y = z_b, z = -y_b (front = +Z / south), 16 units per meter.
"""
import bpy, sys, os, json, math
import numpy as np
from mathutils import Vector, Matrix

SRC, OUT = sys.argv[-2], sys.argv[-1]
os.makedirs(OUT, exist_ok=True)
_h, _b = (float(x) for x in os.environ.get("VOX", "0.0125,0.02").split(","))
VOX = {"head": _h, "body": _b, "arm_r": _b, "arm_l": _b, "leg_r": _b, "leg_l": _b}

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
        if chain_has(b, f"J_Bip_{side}_UpperArm") or chain_has(b, f"J_Aim_{side}_TopsUpperArm") or chain_has(b, f"J_Aim_{side}_Shoulder"):
            return f"arm_{s}"
        if chain_has(b, f"J_Bip_{side}_UpperLeg") or chain_has(b, f"J_Aim_{side}_UpperLeg"):
            return f"leg_{s}"
    return "body"

W = lambda n: arm.matrix_world @ B[n].head_local
PIVOT = {
    "head": W("J_Bip_C_Head"),
    "body": W("J_Bip_C_Hips"),
    "arm_l": W("J_Bip_L_UpperArm"), "arm_r": W("J_Bip_R_UpperArm"),
    "leg_l": W("J_Bip_L_UpperLeg"), "leg_r": W("J_Bip_R_UpperLeg"),
}
# arms: T-pose -> hanging straight down (rotate about Y at the shoulder)
ROT = {"arm_l": Matrix.Rotation(math.radians(80), 3, "Y"), "arm_r": Matrix.Rotation(math.radians(-80), 3, "Y")}
for k in PIVOT:
    ROT.setdefault(k, Matrix.Identity(3))

def prio(matname):
    n = matname.lower()
    if "hair" in n and "back" not in n:
        return 3
    if any(k in n for k in ("eye", "brow", "mouth")):
        return 4
    if "skin" in n:
        return 0
    return 1

# texture cache
TEX = {}
def mat_info(mat):
    if mat.name in TEX:
        return TEX[mat.name]
    nt = mat.node_tree
    bsdf = next((n for n in nt.nodes if n.type == "BSDF_PRINCIPLED"), None)
    if bsdf is None:
        texn = next((n for n in nt.nodes if n.type == "TEX_IMAGE" and n.image), None)
        img = texn.image if texn else None
        arr = None
        if img is not None:
            w, h = img.size
            arr = np.array(img.pixels[:], np.float32).reshape(h, w, 4)
        print("non-principled material", mat.name, img)
        TEX[mat.name] = (arr, np.ones(4, np.float32))
        return TEX[mat.name]
    img = None
    def find_img(sock):
        if not sock.is_linked:
            return None
        n = sock.links[0].from_node
        if n.type == "TEX_IMAGE":
            return n.image
        for i in n.inputs:
            r = find_img(i)
            if r:
                return r
        return None
    img = find_img(bsdf.inputs["Base Color"])
    fac = np.array(bsdf.inputs["Base Color"].default_value[:4], np.float32)
    arr = None
    if img is not None:
        w, h = img.size
        arr = np.array(img.pixels[:], np.float32).reshape(h, w, 4)
        # image pixels are linear for sRGB images in bpy? pixels[] returns stored values (sRGB bytes /255)
    TEX[mat.name] = (arr, fac)
    return TEX[mat.name]

samples = {k: [] for k in PIVOT}  # (pos(3), rgba(4), prio)
dg = bpy.context.evaluated_depsgraph_get()
for ob in bpy.data.objects:
    if ob.type != "MESH" or ob.name not in ("Body", "Face", "Hair"):
        continue
    me = ob.data
    me.calc_loop_triangles()
    uvl = me.uv_layers.active.data
    gname = {g.index: g.name for g in ob.vertex_groups}
    vpart = []
    for v in me.vertices:
        if v.groups:
            g = max(v.groups, key=lambda g: g.weight)
            vpart.append(part_of_bone(gname[g.group]))
        else:
            vpart.append("body")
    co = np.array([ob.matrix_world @ v.co for v in me.vertices], np.float32)
    for tri in me.loop_triangles:
        mat = me.materials[tri.material_index]
        arr, fac = mat_info(mat)
        pr = prio(mat.name)
        part = max(set(vpart[i] for i in tri.vertices), key=[vpart[i] for i in tri.vertices].count)
        P = co[list(tri.vertices)]
        UV = np.array([uvl[l].uv[:] for l in tri.loops], np.float32)
        area = 0.5 * np.linalg.norm(np.cross(P[1] - P[0], P[2] - P[0]))
        step = VOX[part] / 2.5
        n = max(1, int(math.ceil(area / (step * step))))
        n = min(n, 4000)
        r = np.random.default_rng(tri.index).random((n, 2)).astype(np.float32)
        flip = r.sum(1) > 1
        r[flip] = 1 - r[flip]
        bc = np.stack([1 - r[:, 0] - r[:, 1], r[:, 0], r[:, 1]], 1)
        bc = np.vstack([bc, np.eye(3, dtype=np.float32), [[1 / 3, 1 / 3, 1 / 3]]])
        pos = bc @ P
        uv = bc @ UV
        if arr is not None:
            h, w = arr.shape[:2]
            x = np.clip((uv[:, 0] % 1.0) * w, 0, w - 1).astype(int)
            y = np.clip((uv[:, 1] % 1.0) * h, 0, h - 1).astype(int)
            col = arr[y, x] * fac
        else:
            col = np.tile(fac, (len(pos), 1))
        keep = col[:, 3] > 0.5
        for p_, c_ in zip(pos[keep], col[keep]):
            samples[part].append((p_, c_, pr))

out = {"palette": [], "parts": {}}
all_cols = []
vox = {}
for part, S in samples.items():
    if not S:
        continue
    pv, R, s = PIVOT[part], ROT[part], VOX[part]
    P = np.array([p for p, _, _ in S]); C = np.array([c for _, c, _ in S]); PR = np.array([q for _, _, q in S])
    rel = (P - np.array(pv)) @ np.array(R).T  # rotate about pivot
    idx = np.floor(rel / s).astype(int)
    cells = {}
    for k, c, q in zip(map(tuple, idx), C, PR):
        e = cells.get(k)
        if e is None or q > e[1]:
            cells[k] = [c[:3].copy(), q, 1]
        elif q == e[1]:
            e[0] += c[:3]; e[2] += 1
    vox[part] = {k: v[0] / v[2] for k, v in cells.items()}
    all_cols += list(vox[part].values())
    print(part, "voxels", len(cells))

# palette (<=255 colors) by quantizing with PIL
from PIL import Image
cols = np.clip(np.array(all_cols), 0, 1)
img = Image.fromarray((cols[None] * 255).astype(np.uint8), "RGB")
q = img.quantize(colors=255, method=Image.Quantize.MEDIANCUT)
pal = np.array(q.getpalette()[:255 * 3]).reshape(-1, 3)
qi = np.array(q)[0]
out["palette"] = pal.tolist()
i0 = 0
for part, cells in vox.items():
    keys = list(cells.keys())
    lab = {k: int(qi[i0 + j]) for j, k in enumerate(keys)}
    i0 += len(keys)
    cellsout = [[int(k[0]), int(k[1]), int(k[2]), lab[k]] for k in keys]
    pv = PIVOT[part]
    out["parts"][part] = {"voxel": VOX[part], "pivot": list(pv), "cells": cellsout}
    
json.dump(out, open(os.path.join(OUT, "parts.json"), "w"))
