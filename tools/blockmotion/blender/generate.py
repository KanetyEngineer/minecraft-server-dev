"""BlockMotion: Minecraft-style 3D animation generator (runs inside Blender 4.2+ / 5.x).

Usage:
    blender -b --factory-startup -P generate.py -- config.json

The config is written by the desktop app (see app/blockmotion.py) but can be
hand-written too. Progress is printed on stdout as lines starting with "BM_".
"""
import bpy, os, sys, json, math, random
from mathutils import Vector, Matrix, Euler, Quaternion

HERE = os.path.dirname(os.path.abspath(__file__))
S = 1 / 16  # 1 skin pixel = 1/16 m (a player is 2 blocks tall)


def log(*a):
    print(*a, flush=True)


def stage(text):
    log("BM_STAGE", text)


# --------------------------------------------------------------------------
# config
# --------------------------------------------------------------------------
DEFAULTS = {
    "skin": "",
    "arms": "auto",            # auto | classic | slim
    "motions": [{"id": "walk", "seconds": 4}],
    "move": True,              # locomotion moves the character forward
    "item": "none",
    "camera": "diagonal",      # front | diagonal | side | back | closeup | low | high | orbit
    "follow": True,
    "zoom": 1.0,
    "background": "grass",     # grass | night | cave | studio | greenscreen | transparent
    "bg_color": [0.85, 0.87, 0.9],
    "resolution": [1920, 1080],
    "fps": 30,
    "engine": "eevee",         # eevee | cycles | workbench
    "samples": 32,
    "output_dir": "",
    "name": "blockmotion",
    "video": True,
    "save_blend": True,
    "preview_frame": None,     # render only this frame (1-based) to <name>_preview.png
    "assets": os.path.join(HERE, "..", "assets"),
    "seed": 7,
}


def load_config():
    argv = sys.argv
    args = argv[argv.index("--") + 1:] if "--" in argv else []
    cfg = dict(DEFAULTS)
    if args:
        with open(args[0], encoding="utf-8") as f:
            cfg.update(json.load(f))
    if not cfg["output_dir"]:
        cfg["output_dir"] = os.path.join(os.path.expanduser("~"), "BlockMotion")
    os.makedirs(cfg["output_dir"], exist_ok=True)
    return cfg


CFG = load_config()
TEX = os.path.join(CFG["assets"], "textures")
random.seed(CFG["seed"])

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
coll = scene.collection


# --------------------------------------------------------------------------
# materials / images
# --------------------------------------------------------------------------
_imgs = {}


def image(path):
    if path not in _imgs:
        im = bpy.data.images.load(path)
        im.pack()
        _imgs[path] = im
    return _imgs[path]


def tinted(path, tint):
    """Copy of an image multiplied by an sRGB tint (grass / leaves are grey in the files)."""
    key = (path, tuple(tint))
    if key not in _imgs:
        src = image(path)
        w, h = src.size
        im = bpy.data.images.new(os.path.basename(path).replace(".png", "_tinted"), w, h, alpha=True)
        px = list(src.pixels)
        for i in range(0, len(px), 4):
            px[i] *= tint[0]; px[i + 1] *= tint[1]; px[i + 2] *= tint[2]
        im.pixels = px
        im.pack()
        _imgs[key] = im
    return _imgs[key]


def tex_path(name):
    return os.path.join(TEX, name + ".png")


def alpha_clip(nt, alpha_socket, bsdf, m):
    # 1 - (alpha < 0.5): hard cut-out, understood by every engine and glTF
    lt = nt.nodes.new("ShaderNodeMath"); lt.operation = "LESS_THAN"
    lt.inputs[1].default_value = 0.5
    sub = nt.nodes.new("ShaderNodeMath"); sub.operation = "SUBTRACT"
    sub.inputs[0].default_value = 1.0
    nt.links.new(alpha_socket, lt.inputs[0])
    nt.links.new(lt.outputs[0], sub.inputs[1])
    nt.links.new(sub.outputs[0], bsdf.inputs["Alpha"])
    try:
        m.surface_render_method = "DITHERED"
    except Exception:
        pass
    try:
        m.blend_method = "CLIP"
    except Exception:
        pass
    m.use_backface_culling = False


_mats = {}


def tex_mat(name, img_path, tint=None, clip=False, hide_backface=False, emission=0.0):
    key = name
    if key in _mats:
        return _mats[key]
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    bsdf = nt.nodes["Principled BSDF"]
    bsdf.inputs["Roughness"].default_value = 1.0
    bsdf.inputs["Specular IOR Level"].default_value = 0.0
    t = nt.nodes.new("ShaderNodeTexImage")
    t.image = tinted(img_path, tint) if tint else image(img_path)
    t.interpolation = "Closest"
    color = t.outputs["Color"]
    nt.links.new(color, bsdf.inputs["Base Color"])
    if emission:
        nt.links.new(color, bsdf.inputs["Emission Color"])
        bsdf.inputs["Emission Strength"].default_value = emission
    if clip:
        alpha_clip(nt, t.outputs["Alpha"], bsdf, m)
    if hide_backface:
        # walls that face away from the camera become see-through (works in all engines)
        geo = nt.nodes.new("ShaderNodeNewGeometry")
        tr = nt.nodes.new("ShaderNodeBsdfTransparent")
        mixs = nt.nodes.new("ShaderNodeMixShader")
        out = nt.nodes["Material Output"]
        nt.links.new(geo.outputs["Backfacing"], mixs.inputs[0])
        nt.links.new(bsdf.outputs[0], mixs.inputs[1])
        nt.links.new(tr.outputs[0], mixs.inputs[2])
        nt.links.new(mixs.outputs[0], out.inputs["Surface"])
        try:
            m.surface_render_method = "DITHERED"
        except Exception:
            pass
        m.use_backface_culling = True
    _mats[key] = m
    return m


def color_mat(name, rgb, rough=1.0, emission=0.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (*rgb, 1)
    b.inputs["Roughness"].default_value = rough
    b.inputs["Specular IOR Level"].default_value = 0.0
    if emission:
        b.inputs["Emission Color"].default_value = (*rgb, 1)
        b.inputs["Emission Strength"].default_value = emission
    m.diffuse_color = (*rgb, 1)
    return m


# --------------------------------------------------------------------------
# skin -> character mesh
# --------------------------------------------------------------------------
def load_skin():
    path = CFG["skin"]
    if not path or not os.path.exists(path):
        path = os.path.join(CFG["assets"], "default_skin.png")
    img = image(path)
    img.name = "skin_" + os.path.basename(path)
    w, h = img.size
    legacy = (h == w // 2)
    arms = CFG["arms"]
    if arms == "auto":
        arms = "classic"
        if not legacy:
            # slim skins leave the 4th column of the right arm front empty
            px = list(img.pixels)
            sx = w / 64

            def alpha(x, y):  # x,y in 64-space, origin top-left
                ix = int(x * sx); iy = h - 1 - int(y * sx)
                return px[(iy * w + ix) * 4 + 3]
            if alpha(54, 20) < 0.5 and alpha(55, 31) < 0.5:
                arms = "slim"
    log("BM_INFO skin", os.path.basename(path), f"{w}x{h}", "arms=" + arms, "legacy" if legacy else "")
    return img, arms, legacy


SKIN_IMG, ARMS, LEGACY = load_skin()
TW = 64
TH = 32 if LEGACY else 64


def skin_mat(name, overlay):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    bsdf = nt.nodes["Principled BSDF"]
    bsdf.inputs["Roughness"].default_value = 1.0
    bsdf.inputs["Specular IOR Level"].default_value = 0.0
    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.image = SKIN_IMG
    tex.interpolation = "Closest"
    nt.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
    if overlay:
        alpha_clip(nt, tex.outputs["Alpha"], bsdf, m)
    return m


AW = 3 if ARMS == "slim" else 4
# name, bone, base uv, size (w,h,d), min corner (px), overlay uv, inflate
# Character faces -Y, its right side is -X.
PARTS = [
    ("Head", "Head", (0, 0), (8, 8, 8), (-4, -4, 24), (32, 0), 0.5),
    ("Body", "Body", (16, 16), (8, 12, 4), (-4, -2, 12), (16, 32), 0.25),
    ("Arm.R", "Arm.R", (40, 16), (AW, 12, 4), (-4 - AW, -2, 12), (40, 32), 0.25),
    ("Arm.L", "Arm.L", (32, 48), (AW, 12, 4), (4, -2, 12), (48, 48), 0.25),
    ("Leg.R", "Leg.R", (0, 16), (4, 12, 4), (-4, -2, 0), (0, 32), 0.25),
    ("Leg.L", "Leg.L", (16, 48), (4, 12, 4), (0, -2, 0), (0, 48), 0.25),
]
if LEGACY:  # 64x32 skins: left limbs reuse the right ones, only the hat layer exists
    PARTS[3] = ("Arm.L", "Arm.L", (40, 16), (AW, 12, 4), (4, -2, 12), None, 0)
    PARTS[5] = ("Leg.L", "Leg.L", (0, 16), (4, 12, 4), (0, -2, 0), None, 0)
    PARTS = [p if p[0] == "Head" or p[5] is None else (*p[:5], None, 0) for p in PARTS]


def uvp(px, py):
    return (px / TW, 1 - py / TH)


def add_box(acc, mn, size, uv, inflate, group, mat_index, mirror=False):
    verts, faces, uvs, groups, mats = acc
    w, h, d = size
    u, v = uv
    x0, y0, z0 = mn[0] - inflate, mn[1] - inflate, mn[2] - inflate
    x1, y1, z1 = mn[0] + w + inflate, mn[1] + d + inflate, mn[2] + h + inflate
    F = {
        "front": ([(x0, y0, z0), (x1, y0, z0), (x1, y0, z1), (x0, y0, z1)], (u + d, v + d, w, h)),
        "back": ([(x1, y1, z0), (x0, y1, z0), (x0, y1, z1), (x1, y1, z1)], (u + 2 * d + w, v + d, w, h)),
        "right": ([(x0, y1, z0), (x0, y0, z0), (x0, y0, z1), (x0, y1, z1)], (u, v + d, d, h)),
        "left": ([(x1, y0, z0), (x1, y1, z0), (x1, y1, z1), (x1, y0, z1)], (u + d + w, v + d, d, h)),
        "top": ([(x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1)], (u + d, v, w, d)),
        "bottom": ([(x0, y1, z0), (x1, y1, z0), (x1, y0, z0), (x0, y0, z0)], (u + d + w, v, w, d)),
    }
    if mirror:  # legacy left limbs: swap the side faces' texture
        F["right"], F["left"] = (F["right"][0], F["left"][1]), (F["left"][0], F["right"][1])
    for name, (corners, (L, T, W, H)) in F.items():
        base = len(verts)
        for c in corners:
            verts.append(Vector(c) * S)
        faces.append([base, base + 1, base + 2, base + 3])
        if name == "bottom":
            tuv = [uvp(L, T), uvp(L + W, T), uvp(L + W, T + H), uvp(L, T + H)]
        else:
            tuv = [uvp(L, T + H), uvp(L + W, T + H), uvp(L + W, T), uvp(L, T)]
        if mirror:
            tuv = [tuv[1], tuv[0], tuv[3], tuv[2]]
        uvs.append(tuv)
        groups.append(group)
        mats.append(mat_index)


def build_character():
    acc = ([], [], [], [], [])
    for name, bone, uv, size, mn, ouv, inf in PARTS:
        add_box(acc, mn, size, uv, 0.0, bone, 0, mirror=LEGACY and name.endswith(".L"))
    for name, bone, uv, size, mn, ouv, inf in PARTS:
        if ouv is not None:
            add_box(acc, mn, size, ouv, inf, bone, 1)
    verts, faces, uvs, groups, mats = acc
    mesh = bpy.data.meshes.new("Player")
    mesh.from_pydata([tuple(v) for v in verts], [], faces)
    mesh.update()
    uvl = mesh.uv_layers.new(name="UVMap")
    for poly, tuv in zip(mesh.polygons, uvs):
        for li, t in zip(poly.loop_indices, tuv):
            uvl.data[li].uv = t
    for poly, mi in zip(mesh.polygons, mats):
        poly.material_index = mi
    mesh.materials.append(skin_mat("Skin_Base", False))
    mesh.materials.append(skin_mat("Skin_Overlay", True))
    obj = bpy.data.objects.new("Player", mesh)
    coll.objects.link(obj)
    for p in PARTS:
        obj.vertex_groups.new(name=p[1])
    for poly, g in zip(mesh.polygons, groups):
        obj.vertex_groups[g].add(list(poly.vertices), 1.0, "REPLACE")

    arm = bpy.data.armatures.new("PlayerRig")
    rig = bpy.data.objects.new("PlayerRig", arm)
    coll.objects.link(rig)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.mode_set(mode="EDIT")
    eb = arm.edit_bones

    def nb(name, head, tail, parent=None):
        b = eb.new(name)
        b.head = Vector(head) * S
        b.tail = Vector(tail) * S
        b.roll = 0
        if parent:
            b.parent = eb[parent]
    ax = 4 + AW / 2
    nb("Root", (0, 0, 0), (0, 4, 0))
    nb("Body", (0, 0, 12), (0, 0, 24), "Root")
    nb("Head", (0, 0, 24), (0, 0, 32), "Body")
    nb("Arm.R", (-(ax - 1), 0, 22), (-ax, 0, 12), "Body")
    nb("Arm.L", (ax - 1, 0, 22), (ax, 0, 12), "Body")
    nb("Leg.R", (-2, 0, 12), (-2, 0, 0), "Root")
    nb("Leg.L", (2, 0, 12), (2, 0, 0), "Root")
    bpy.ops.object.mode_set(mode="OBJECT")
    arm.display_type = "STICK"
    rig.show_in_front = True
    obj.parent = rig
    mod = obj.modifiers.new("Armature", "ARMATURE")
    mod.object = rig
    for pb in rig.pose.bones:
        pb.rotation_mode = "QUATERNION"
    return rig, obj


RIG, PLAYER = build_character()


# --------------------------------------------------------------------------
# held item (voxelised 16x16 sprite)
# --------------------------------------------------------------------------
ITEMS = {
    # texture, grip pixel (x, y from top-left), tilt (deg)
    "iron_sword": ("iron_sword", (2.5, 12.5), 25),
    "diamond_sword": ("diamond_sword", (2.5, 12.5), 25),
    "iron_pickaxe": ("iron_pickaxe", (3.5, 11.5), 25),
    "diamond_pickaxe": ("diamond_pickaxe", (3.5, 11.5), 25),
    "iron_axe": ("iron_axe", (3.5, 11.5), 25),
    "iron_shovel": ("iron_shovel", (3.5, 11.5), 25),
    "torch": ("torch", (7.5, 13.5), 75),
}


def build_item(key):
    texname, grip, tilt = ITEMS[key]
    img = image(tex_path(texname))
    w, h = img.size
    px = list(img.pixels)
    size = 0.6  # metres for the whole 16px sprite
    p = size / w
    verts, faces, uvs = [], [], []
    for y in range(h):
        for x in range(w):
            iy = h - 1 - y
            if px[(iy * w + x) * 4 + 3] < 0.5:
                continue
            # sprite plane = YZ: texture +x -> -Y (forward), texture up -> +Z
            cy = -(x + 0.5 - grip[0]) * p
            cz = -(y + 0.5 - grip[1]) * p
            uv = ((x + 0.5) / w, (iy + 0.5) / h)
            b = len(verts)
            for dx in (-0.5, 0.5):
                for dy in (-0.5, 0.5):
                    for dz in (-0.5, 0.5):
                        verts.append((dx * p, cy + dy * p, cz + dz * p))
            for f in ((0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)):
                faces.append([b + i for i in f])
                uvs.append(uv)
    mesh = bpy.data.meshes.new("Item_" + key)
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    uvl = mesh.uv_layers.new(name="UVMap")
    for poly, uv in zip(mesh.polygons, uvs):
        for li in poly.loop_indices:
            uvl.data[li].uv = uv
    mesh.materials.append(tex_mat("M_item_" + texname, tex_path(texname), emission=1.0 if key == "torch" else 0.0))
    ob = bpy.data.objects.new("Item", mesh)
    coll.objects.link(ob)
    # rest pose in armature space: grip in the right hand, blade pointing forward / up
    hand = Vector((-(4 + AW / 2), -1.0, 13.5)) * S
    W = Matrix.Translation(hand) @ Matrix.Rotation(math.radians(tilt), 4, "X")
    ob.parent = RIG
    ob.parent_type = "BONE"
    ob.parent_bone = "Arm.R"
    bone = RIG.data.bones["Arm.R"]
    tail = bone.matrix_local @ Matrix.Translation((0, bone.length, 0))
    ob.matrix_parent_inverse = Matrix.Identity(4)
    ob.matrix_basis = tail.inverted() @ W
    if key == "torch":
        lamp = bpy.data.lights.new("TorchLight", "POINT")
        lamp.energy = 25
        lamp.color = (1.0, 0.75, 0.4)
        lamp.shadow_soft_size = 0.1
        lo = bpy.data.objects.new("TorchLight", lamp)
        coll.objects.link(lo)
        lo.parent = ob
        lo.location = (0, 0, 0.15)
    return ob


if CFG["item"] in ITEMS:
    build_item(CFG["item"])


# --------------------------------------------------------------------------
# motions: each returns a pose in character space
#   bones: {bone: (x, y, z) degrees}  X = pitch, Y = roll (sideways), Z = yaw
#   "lift": vertical offset of the whole body (m), "speed": forward speed (m/s)
# Sign conventions (character faces -Y):
#   legs / arms: x < 0 swings forward      body / head: x > 0 leans / looks down
#   Arm.R: y > 0 raises it sideways        Arm.L: y < 0 raises it sideways
#   z > 0 turns to the character's left
# --------------------------------------------------------------------------
def sm(x):
    x = max(0.0, min(1.0, x))
    return x * x * (3 - 2 * x)


def m_idle(t):
    return {"Arm.R": (0, 3 + 2 * math.sin(t * 1.3), 0), "Arm.L": (0, -3 - 2 * math.sin(t * 1.3), 0),
            "Head": (4 * math.sin(t * 0.7), 0, 14 * math.sin(t * 0.45)),
            "Body": (1.0 * math.sin(t * 1.3), 0, 0)}


def walk_like(t, period, leg, arm, speed, bob=0.0, lean=0.0):
    ph = 2 * math.pi * t / period
    s = math.sin(ph)
    return {"Leg.R": (-leg * s, 0, 0), "Leg.L": (leg * s, 0, 0),
            "Arm.R": (arm * s, 2, 0), "Arm.L": (-arm * s, -2, 0),
            "Body": (lean, 0, 0), "Head": (-lean * 0.8, 0, 0),
            "lift": bob * abs(math.cos(ph)), "speed": speed}


def m_walk(t):
    return walk_like(t, 1.0, 34, 30, 1.7, bob=0.015)


def m_run(t):
    return walk_like(t, 0.62, 52, 58, 4.0, bob=0.05, lean=8)


def m_sneak(t):
    p = walk_like(t, 1.3, 20, 12, 0.8)
    p["Body"] = (28, 0, 0)
    p["Head"] = (-22, 0, 0)
    p["Arm.R"] = (p["Arm.R"][0] - 14, 3, 0)
    p["Arm.L"] = (p["Arm.L"][0] - 14, -3, 0)
    p["lift"] = -0.12
    return p


def m_wave(t):
    w = math.sin(2 * math.pi * t * 1.8)
    p = m_idle(t)
    p["Arm.R"] = (-15, 150 + 22 * w, 0)
    p["Head"] = (-4, -6, 8)
    return p


def m_look(t):
    k = (t % 4.0) / 4.0
    yaw = 55 * math.sin(2 * math.pi * k)
    p = m_idle(t)
    p["Head"] = (6 * math.sin(4 * math.pi * k), 0, yaw)
    p["Body"] = (0, 0, yaw * 0.15)
    return p


def swing(t, period):
    k = (t % period) / period
    if k < 0.45:  # wind-up
        return sm(k / 0.45)
    return 1 - sm((k - 0.45) / 0.3)  # strike, then hold low


def m_mine(t):
    a = swing(t, 0.42)
    return {"Arm.R": (-(25 + 95 * a), 4, 4), "Arm.L": (-10, -3, 0),
            "Head": (22, 0, 4), "Body": (4 + 4 * (1 - a), 0, 6 - 6 * a)}


def m_attack(t):
    a = swing(t, 0.6)
    return {"Arm.R": (-(15 + 100 * a), 10 + 20 * a, -25 + 50 * a), "Arm.L": (-8, -6, 0),
            "Head": (6, 0, -10 + 20 * a), "Body": (3, 0, -18 + 36 * a)}


def m_jump(t):
    period = 1.1
    k = (t % period) / period
    lift, crouch, arms = 0.0, 0.0, 0.0
    if k < 0.2:
        crouch = sm(k / 0.2)
    elif k < 0.8:
        u = (k - 0.2) / 0.6
        lift = 1.25 * 4 * u * (1 - u)
        crouch = 1 - sm(u / 0.25)
        arms = math.sin(math.pi * u)
    else:
        crouch = math.sin(math.pi * (k - 0.8) / 0.2) * 0.6
    return {"Body": (14 * crouch, 0, 0), "Head": (-10 * crouch, 0, 0),
            "Arm.R": (20 * crouch - 30 * arms, 25 * arms, 0), "Arm.L": (20 * crouch - 30 * arms, -25 * arms, 0),
            "Leg.R": (-25 * crouch - 15 * arms, 0, 0), "Leg.L": (-25 * crouch + 15 * arms, 0, 0),
            "lift": lift - 0.08 * crouch}


def m_cheer(t):
    p = m_jump(t * 1.4)
    p["lift"] *= 0.45
    sh = 12 * math.sin(2 * math.pi * t * 3)
    p["Arm.R"] = (-10, 160 + sh, 0)
    p["Arm.L"] = (-10, -160 + sh, 0)
    p["Head"] = (-15, 0, 0)
    return p


def m_dance(t):
    ph = 2 * math.pi * t / 0.5
    s = math.sin(ph)
    return {"Arm.R": (-20, 90 + 65 * s, 0), "Arm.L": (-20, -(90 - 65 * s), 0),
            "Body": (0, 8 * math.sin(ph / 2), 15 * math.sin(ph / 2)),
            "Head": (10 * math.sin(2 * ph), -8 * math.sin(ph / 2), 0),
            "Leg.R": (-18 * max(0, s), 0, 0), "Leg.L": (-18 * max(0, -s), 0, 0),
            "lift": 0.05 * abs(s)}


def m_sit(t):
    p = m_idle(t)
    p["Leg.R"] = (-90, 0, 8)
    p["Leg.L"] = (-90, 0, -8)
    p["Arm.R"] = (-28, 4, 0)
    p["Arm.L"] = (-28, -4, 0)
    p["lift"] = -0.62
    return p


def m_bow(t):
    k = (t % 2.5) / 2.5
    a = sm(k / 0.3) if k < 0.6 else 1 - sm((k - 0.6) / 0.3)
    return {"Body": (45 * a, 0, 0), "Head": (10 * a, 0, 0),
            "Arm.R": (-8 * a, 2, 0), "Arm.L": (-8 * a, -2, 0)}


def m_spin(t):
    p = m_idle(t)
    p["Arm.R"] = (0, 70, 0)
    p["Arm.L"] = (0, -70, 0)
    return p


MOTIONS = {
    "idle": m_idle, "walk": m_walk, "run": m_run, "sneak": m_sneak, "wave": m_wave,
    "look": m_look, "mine": m_mine, "attack": m_attack, "jump": m_jump, "cheer": m_cheer,
    "dance": m_dance, "sit": m_sit, "bow": m_bow, "spin": m_spin,
}
BONES = ["Body", "Head", "Arm.R", "Arm.L", "Leg.R", "Leg.L"]
BLEND_S = 0.35


def lerp_pose(a, b, f):
    out = {}
    for k in BONES:
        va, vb = a.get(k, (0, 0, 0)), b.get(k, (0, 0, 0))
        out[k] = tuple(x + (y - x) * f for x, y in zip(va, vb))
    for k in ("lift", "speed", "turn"):
        out[k] = a.get(k, 0.0) + (b.get(k, 0.0) - a.get(k, 0.0)) * f
    return out


SEGMENTS = []
_t = 0.0
for m in CFG["motions"]:
    if m["id"] not in MOTIONS:
        continue
    d = max(0.2, float(m.get("seconds", 3)))
    SEGMENTS.append((m["id"], _t, d))
    _t += d
if not SEGMENTS:
    SEGMENTS = [("idle", 0.0, 3.0)]
    _t = 3.0
TOTAL = _t


def pose_at(t):
    for i, (mid, start, d) in enumerate(SEGMENTS):
        if t < start + d or i == len(SEGMENTS) - 1:
            local = t - start
            p = lerp_pose(MOTIONS[mid](local), {}, 0)
            if mid == "spin":  # whole turns only, so the next motion faces forward again
                p["turn"] = 360.0 * max(1, round(d / 1.2)) * min(1.0, local / d)
            if i > 0 and local < BLEND_S:
                pm, ps, pd = SEGMENTS[i - 1]
                prev = MOTIONS[pm](pd + local)
                if pm == "spin":  # a spin always ends facing forward
                    prev["turn"] = 0.0
                p = lerp_pose(lerp_pose(prev, {}, 0), p, sm(local / BLEND_S))
            return p
    return {}


def bone_quat(rig, name, vec):
    """Character-space rotation (degrees, see conventions above) -> bone-local quaternion."""
    x, y, z = (math.radians(a) for a in vec)
    Q = Matrix.Rotation(z, 3, "Z") @ Matrix.Rotation(y, 3, "Y") @ Matrix.Rotation(x, 3, "X")
    rest = rig.data.bones[name].matrix_local.to_3x3()
    return (rest.inverted() @ Q @ rest).to_quaternion()


# --------------------------------------------------------------------------
# bake animation
# --------------------------------------------------------------------------
FPS = int(CFG["fps"])
scene.render.fps = FPS
FRAMES = max(1, int(round(TOTAL * FPS)))
scene.frame_start = 1
scene.frame_end = FRAMES
stage("animating %d frames" % FRAMES)

distance = 0.0
prev_q = {}
PATH = []  # (frame, y position)
dt = 1.0 / FPS
for f in range(1, FRAMES + 1):
    t = (f - 1) * dt
    p = pose_at(t)
    if CFG["move"]:
        distance += p.get("speed", 0.0) * dt
    yaw = math.radians(p.get("turn", 0.0) % 360.0)
    RIG.location = (0, -distance, p.get("lift", 0.0))
    RIG.rotation_euler = (0, 0, yaw)
    RIG.keyframe_insert("location", frame=f)
    RIG.keyframe_insert("rotation_euler", frame=f)
    PATH.append((f, -distance))
    for name in BONES:
        pb = RIG.pose.bones[name]
        q = bone_quat(RIG, name, p.get(name, (0, 0, 0)))
        if name in prev_q and prev_q[name].dot(q) < 0:
            q.negate()
        prev_q[name] = q
        pb.rotation_quaternion = q
        pb.keyframe_insert("rotation_quaternion", frame=f)

# per-frame keys: linear avoids overshoot between samples; the spin wrap must not interpolate
try:
    fcurves = RIG.animation_data.action.fcurves
except AttributeError:  # Blender 5 slotted actions
    fcurves = []
    act = RIG.animation_data.action
    for layer in act.layers:
        for strip in layer.strips:
            for cb in strip.channelbags:
                fcurves.extend(cb.fcurves)
for fc in fcurves:
    for kp in fc.keyframe_points:
        kp.interpolation = "LINEAR"
    if fc.data_path == "rotation_euler":
        for a, b in zip(fc.keyframe_points, list(fc.keyframe_points)[1:]):
            if abs(b.co[1] - a.co[1]) > math.pi:
                a.interpolation = "CONSTANT"

TRAVEL = distance
log("BM_INFO duration %.2fs frames %d travel %.2fm" % (TOTAL, FRAMES, TRAVEL))


# --------------------------------------------------------------------------
# world / background
# --------------------------------------------------------------------------
def world_gradient(horizon, zenith, strength=1.0, camera_color=None, light_color=None):
    w = bpy.data.worlds.new("World")
    scene.world = w
    w.use_nodes = True
    nt = w.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputWorld")
    bg = nt.nodes.new("ShaderNodeBackground")
    bg.inputs["Strength"].default_value = strength
    tc = nt.nodes.new("ShaderNodeTexCoord")
    sep = nt.nodes.new("ShaderNodeSeparateXYZ")
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    ramp.color_ramp.elements[0].position = 0.0
    ramp.color_ramp.elements[0].color = (*horizon, 1)
    ramp.color_ramp.elements[1].position = 0.6
    ramp.color_ramp.elements[1].color = (*zenith, 1)
    nt.links.new(tc.outputs["Generated"], sep.inputs[0])
    nt.links.new(sep.outputs["Z"], ramp.inputs["Fac"])
    nt.links.new(ramp.outputs["Color"], bg.inputs["Color"])
    nt.links.new(bg.outputs[0], out.inputs["Surface"])
    w.color = horizon
    return w


def world_split(camera_rgb, light_rgb, light_strength=1.0):
    """Camera sees camera_rgb exactly, but the scene is lit by a neutral light_rgb."""
    w = bpy.data.worlds.new("World")
    scene.world = w
    w.use_nodes = True
    nt = w.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputWorld")
    lp = nt.nodes.new("ShaderNodeLightPath")
    cam = nt.nodes.new("ShaderNodeBackground")
    cam.inputs["Color"].default_value = (*camera_rgb, 1)
    lit = nt.nodes.new("ShaderNodeBackground")
    lit.inputs["Color"].default_value = (*light_rgb, 1)
    lit.inputs["Strength"].default_value = light_strength
    mix = nt.nodes.new("ShaderNodeMixShader")
    nt.links.new(lp.outputs["Is Camera Ray"], mix.inputs[0])
    nt.links.new(lit.outputs[0], mix.inputs[1])
    nt.links.new(cam.outputs[0], mix.inputs[2])
    nt.links.new(mix.outputs[0], out.inputs["Surface"])
    w.color = camera_rgb
    return w


def sun(energy, rot, color=(1, 1, 1), angle=3.0):
    l = bpy.data.lights.new("Sun", "SUN")
    l.energy = energy
    l.color = color
    l.angle = math.radians(angle)
    o = bpy.data.objects.new("Sun", l)
    coll.objects.link(o)
    o.rotation_euler = [math.radians(a) for a in rot]
    return o


def point(name, loc, energy, color, radius=0.1):
    l = bpy.data.lights.new(name, "POINT")
    l.energy = energy
    l.color = color
    l.shadow_soft_size = radius
    o = bpy.data.objects.new(name, l)
    coll.objects.link(o)
    o.location = loc
    return o


def tiled_plane(name, mat, x0, x1, y0, y1, z=0.0, axis="Z", normal_sign=1):
    """Axis-aligned rectangle with 1 texture repeat per metre."""
    if axis == "Z":
        vs = [(x0, y0, z), (x1, y0, z), (x1, y1, z), (x0, y1, z)]
        uv = [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]
    elif axis == "X":  # wall at x=z, spanning y in [x0,x1], z in [y0,y1]
        vs = [(z, x0, y0), (z, x1, y0), (z, x1, y1), (z, x0, y1)]
        uv = [(-x0, y0), (-x1, y0), (-x1, y1), (-x0, y1)]
    else:  # axis Y: wall at y=z, x in [x0,x1], z in [y0,y1]
        vs = [(x0, z, y0), (x1, z, y0), (x1, z, y1), (x0, z, y1)]
        uv = [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]
    face = [0, 1, 2, 3] if normal_sign > 0 else [3, 2, 1, 0]
    me = bpy.data.meshes.new(name)
    me.from_pydata(vs, [], [face])
    me.update()
    uvl = me.uv_layers.new(name="UVMap")
    for li, vi in zip(me.polygons[0].loop_indices, face):
        uvl.data[li].uv = uv[vi]
    me.materials.append(mat)
    ob = bpy.data.objects.new(name, me)
    coll.objects.link(ob)
    return ob


_cube_cache = {}


def block(name, loc, mats, size=1.0):
    """A 1m block. mats = material, or (top, side, bottom)."""
    if not isinstance(mats, tuple):
        mats = (mats, mats, mats)
    key = (mats, size)
    if key not in _cube_cache:
        h = size / 2
        vs = [(x, y, z) for x in (-h, h) for y in (-h, h) for z in (-h, h)]
        fs = [(1, 5, 7, 3), (0, 2, 6, 4), (0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6)]
        fm = [0, 2, 1, 1, 1, 1]  # top, bottom, sides
        me = bpy.data.meshes.new("block")
        me.from_pydata(vs, [], fs)
        me.update()
        uvl = me.uv_layers.new(name="UVMap")
        quad = [(0, 0), (1, 0), (1, 1), (0, 1)]
        for poly, mi in zip(me.polygons, fm):
            poly.material_index = mi
            for li, q in zip(poly.loop_indices, quad):
                uvl.data[li].uv = q
        for m in mats:
            me.materials.append(m)
        # fix the side UVs so textures stand upright
        for poly in me.polygons:
            if abs(poly.normal.z) < 0.5:
                vz = [me.vertices[me.loops[li].vertex_index].co for li in poly.loop_indices]
                horiz = Vector((-poly.normal.y, poly.normal.x, 0))
                for li, co in zip(poly.loop_indices, vz):
                    uvl.data[li].uv = (horiz.dot(co) / size + 0.5, co.z / size + 0.5)
        _cube_cache[key] = me
    ob = bpy.data.objects.new(name, _cube_cache[key])
    coll.objects.link(ob)
    ob.location = loc
    return ob


GRASS_TINT = (0.475, 0.753, 0.353)
LEAF_TINT = (0.467, 0.671, 0.184)
Y_MIN = -TRAVEL - 30
Y_MAX = 30


def tree(x, y, h=None):
    h = h or random.choice((4, 5, 5, 6))
    log_m = (tex_mat("M_oak_top", tex_path("oak_log_top")), tex_mat("M_oak_log", tex_path("oak_log")),
             tex_mat("M_oak_top", tex_path("oak_log_top")))
    leaf = tex_mat("M_leaves", tex_path("oak_leaves"), tint=LEAF_TINT, clip=True)
    for z in range(h):
        block("log", (x, y, z + 0.5), log_m)
    for dz in (-2, -1, 0, 1):
        r = 2 if dz < 0 else 1
        for dx in range(-r, r + 1):
            for dy in range(-r, r + 1):
                if dx == 0 and dy == 0 and dz < 1:
                    continue
                if abs(dx) == r and abs(dy) == r and (dz == 1 or random.random() < 0.5):
                    continue
                block("leaf", (x + dx, y + dy, h + dz + 0.5), leaf)


def cross_plant(name, texname, loc, tint=None):
    m = tex_mat("M_" + texname, tex_path(texname), tint=tint, clip=True,
                emission=2.0 if texname == "torch" else 0.0)
    vs, fs = [], []
    for a in (45, 135):
        c, s = math.cos(math.radians(a)) * 0.45, math.sin(math.radians(a)) * 0.45
        b = len(vs)
        vs += [(-c, -s, 0), (c, s, 0), (c, s, 0.9), (-c, -s, 0.9)]
        fs.append((b, b + 1, b + 2, b + 3))
    me = bpy.data.meshes.new(name)
    me.from_pydata(vs, [], fs)
    me.update()
    uvl = me.uv_layers.new(name="UVMap")
    for poly in me.polygons:
        for li, q in zip(poly.loop_indices, [(0, 0), (1, 0), (1, 1), (0, 1)]):
            uvl.data[li].uv = q
    me.materials.append(m)
    ob = bpy.data.objects.new(name, me)
    coll.objects.link(ob)
    ob.location = loc
    return ob


def scatter_outdoor():
    ground = tex_mat("M_grass", tex_path("grass_block_top"), tint=GRASS_TINT)
    tiled_plane("Ground", ground, -60, 60, Y_MIN - 40, Y_MAX + 40)
    # trees and flowers, kept off the walking lane
    y = Y_MAX
    while y > Y_MIN:
        for side in (-1, 1):
            if random.random() < 0.55:
                tree(side * random.randint(6, 16), round(y + random.uniform(-3, 3)))
        y -= random.uniform(5, 9)
    for _ in range(int((Y_MAX - Y_MIN) * 3)):
        x = random.randint(-14, 14)
        if -2 < x < 8:  # keep the walking lane and the usual camera side clear
            continue
        yy = random.randint(int(Y_MIN), int(Y_MAX))
        r = random.random()
        if r < 0.7:
            cross_plant("grass", "short_grass", (x, yy, 0), GRASS_TINT)
        elif r < 0.85:
            cross_plant("poppy", "poppy", (x, yy, 0))
        else:
            cross_plant("dandelion", "dandelion", (x, yy, 0))


def build_cave():
    stone = tex_mat("M_stone_floor", tex_path("stone"))
    wall = tex_mat("M_stone_wall", tex_path("stone"), hide_backface=True)
    half, hgt = 4, 5
    y0, y1 = Y_MIN, Y_MAX
    tiled_plane("Floor", stone, -half, half, y0, y1)
    tiled_plane("Ceiling", wall, -half, half, y0, y1, z=hgt, normal_sign=-1)
    # wall normals point inwards; seen from outside they are back faces and vanish
    tiled_plane("WallR", wall, y0, y1, 0, hgt, z=-half, axis="X", normal_sign=1)
    tiled_plane("WallL", wall, y0, y1, 0, hgt, z=half, axis="X", normal_sign=-1)
    tiled_plane("WallBack", wall, -half, half, 0, hgt, z=y1, axis="Y", normal_sign=1)
    tiled_plane("WallFront", wall, -half, half, 0, hgt, z=y0, axis="Y", normal_sign=-1)
    ores = [tex_mat("M_" + n, tex_path(n), hide_backface=True) for n in ("coal_ore", "iron_ore", "diamond_ore")]
    y = y1 - 1
    while y > y0 + 1:
        for side in (-1, 1):
            if random.random() < 0.6:
                z = random.randint(0, hgt - 1)
                yy = round(y)
                tiled_plane("Ore", random.choice(ores), yy, yy + 1, z, z + 1,
                            z=side * (half - 0.002), axis="X", normal_sign=-side)
        y -= random.uniform(1.5, 4)
    y = y1 - 3
    while y > y0 + 2:
        for side in (-1, 1):
            point("CaveTorch", (side * (half - 0.4), y, 2.8), 60, (1.0, 0.7, 0.35), 0.15)
            cross_plant("torch", "torch", (side * (half - 0.25), y, 2.2))
        y -= 7


BG = CFG["background"]
stage("building background: " + BG)
scene.render.film_transparent = False
if BG == "grass":
    world_gradient((0.78, 0.87, 1.0), (0.36, 0.56, 0.96), 1.0)
    sun(3.2, (50, 0, 35))
    scatter_outdoor()
elif BG == "night":
    world_gradient((0.05, 0.07, 0.16), (0.005, 0.008, 0.03), 1.0)
    sun(0.35, (55, 0, -40), (0.6, 0.7, 1.0), 1.0)
    scatter_outdoor()
elif BG == "cave":
    world_gradient((0.02, 0.02, 0.025), (0.01, 0.01, 0.012), 1.0)
    build_cave()
elif BG == "studio":
    c = tuple(CFG["bg_color"])
    world_split(c, (1, 1, 1), 0.45)
    floor = color_mat("M_floor", c)
    tiled_plane("Floor", floor, -200, 200, -200 - TRAVEL, 200)
    sun(2.4, (45, 0, 30))
elif BG == "greenscreen":
    world_split((0.0, 1.0, 0.0), (1, 1, 1), 0.45)
    sun(2.4, (45, 0, 30))
else:  # transparent
    world_split((0, 0, 0), (1, 1, 1), 0.45)
    scene.render.film_transparent = True
    sun(2.4, (45, 0, 30))


# --------------------------------------------------------------------------
# camera
# --------------------------------------------------------------------------
cam_data = bpy.data.cameras.new("Camera")
cam_data.lens = 50
cam_data.sensor_fit = "VERTICAL"
cam_data.sensor_height = 24
cam_data.clip_end = 500
cam = bpy.data.objects.new("Camera", cam_data)
coll.objects.link(cam)
scene.camera = cam

pivot = bpy.data.objects.new("CameraPivot", None)
coll.objects.link(pivot)
target = bpy.data.objects.new("CameraTarget", None)
coll.objects.link(target)
cam.parent = pivot

CAM = CFG["camera"]
zoom = float(CFG.get("zoom", 1.0)) or 1.0
dist = 7.0 / zoom
if CFG["resolution"][1] > CFG["resolution"][0]:  # portrait frames need more headroom
    dist *= 1.35
look_h = 1.05
presets = {
    "front": (0, -dist, 1.3),
    "diagonal": (dist * 0.68, -dist * 0.72, 1.6),
    "side": (dist, 0, 1.2),
    "back": (0, dist, 1.6),
    "closeup": (dist * 0.25, -dist * 0.42, 1.65),
    "low": (dist * 0.45, -dist * 0.7, 0.25),
    "high": (dist * 0.5, -dist * 0.55, 4.5),
}
if CAM == "closeup":
    look_h = 1.5
if CAM == "low":
    look_h = 1.25

follow = bool(CFG["follow"])
# the pivot rides along with the character (or stays at the start)
if follow:
    c = pivot.constraints.new("COPY_LOCATION")
    c.target = RIG
    c.use_z = False
tc = target.constraints.new("COPY_LOCATION")
tc.target = RIG
tc.use_z = False
target.location = (0, 0, 0)
tc.use_offset = False
tz = target.constraints.new("COPY_LOCATION")  # follow jumps / sitting halfway
tz.target = RIG
tz.use_x = tz.use_y = False
tz.influence = 0.5
target_off = bpy.data.objects.new("CameraLook", None)
coll.objects.link(target_off)
target_off.parent = target
target_off.location = (0, 0, look_h)

if CAM == "orbit":
    turns = max(0.5, min(1.0, TOTAL / 8))
    step = max(1, FRAMES // 48)
    for f in list(range(1, FRAMES + 1, step)) + [FRAMES]:
        k = (f - 1) / max(1, FRAMES - 1)
        a = math.radians(-60) + 2 * math.pi * turns * k
        cam.location = (math.sin(a) * dist, -math.cos(a) * dist, 1.5)
        cam.keyframe_insert("location", frame=f)
else:
    cam.location = presets.get(CAM, presets["diagonal"])

if BG in ("cave", "night"):
    fill = point("CameraFill", (0, 0, 0), 120 if BG == "cave" else 40, (1.0, 0.92, 0.82), 1.5)
    fill.parent = cam
    fill.location = (0.8, 0.6, 0)

trk = cam.constraints.new("TRACK_TO")
trk.target = target_off
trk.track_axis = "TRACK_NEGATIVE_Z"
trk.up_axis = "UP_Y"
if not follow and TRAVEL > 0.5:
    # a fixed camera framed on the middle of the walk
    pivot.location = (0, -TRAVEL / 2, 0)
    cam.location = Vector(cam.location) * (1 + TRAVEL / 12)


# --------------------------------------------------------------------------
# render settings
# --------------------------------------------------------------------------
r = scene.render
r.resolution_x, r.resolution_y = int(CFG["resolution"][0]), int(CFG["resolution"][1])
r.resolution_percentage = 100
try:
    scene.view_settings.view_transform = "Standard"
except Exception:
    pass

ENGINE = CFG["engine"]


def set_engine():
    samples = int(CFG["samples"])
    if ENGINE == "cycles":
        r.engine = "CYCLES"
        scene.cycles.samples = samples
        scene.cycles.use_denoising = True
        scene.cycles.max_bounces = 6
        # use the GPU when the user has one
        try:
            prefs = bpy.context.preferences.addons["cycles"].preferences
            for dev_type in ("OPTIX", "CUDA", "HIP", "ONEAPI", "METAL"):
                try:
                    prefs.compute_device_type = dev_type
                except TypeError:
                    continue
                prefs.get_devices()
                gpus = [d for d in prefs.devices if d.type == dev_type]
                if gpus:
                    for d in prefs.devices:
                        d.use = d.type == dev_type
                    scene.cycles.device = "GPU"
                    log("BM_INFO cycles device", dev_type)
                    break
        except Exception as e:
            log("BM_INFO gpu setup skipped:", e)
    elif ENGINE == "workbench":
        r.engine = "BLENDER_WORKBENCH"
        sh = scene.display.shading
        sh.light = "STUDIO"
        sh.color_type = "TEXTURE"
        sh.show_shadows = True
        scene.display.render_aa = "8"
        scene.view_settings.exposure = 0.5
    else:
        for name in ("BLENDER_EEVEE", "BLENDER_EEVEE_NEXT"):
            try:
                r.engine = name
                break
            except TypeError:
                continue
        ee = scene.eevee
        ee.taa_render_samples = samples
        for attr, val in (("use_shadows", True), ("use_soft_shadows", True), ("use_gtao", True)):
            if hasattr(ee, attr):
                setattr(ee, attr, val)
    log("BM_INFO engine", r.engine)


set_engine()

# viewport shows textures when the .blend is opened
for scr in bpy.data.screens:
    for area in scr.areas:
        if area.type == "VIEW_3D":
            for sp in area.spaces:
                if sp.type == "VIEW_3D":
                    try:
                        sp.shading.type = "MATERIAL"
                    except TypeError:  # workbench has no material preview
                        sp.shading.type = "SOLID"
                        sp.shading.color_type = "TEXTURE"

OUT = CFG["output_dir"]
NAME = CFG["name"]
for im in bpy.data.images:
    if im.source == "FILE" and not im.packed_file:
        try:
            im.pack()
        except Exception:
            pass

if CFG["save_blend"] and CFG.get("preview_frame") is None:
    path = os.path.join(OUT, NAME + ".blend")
    bpy.ops.wm.save_as_mainfile(filepath=path, compress=True)
    log("BM_FILE blend", path)

_done = [0]


def on_frame(sc, *_):
    _done[0] += 1
    log("BM_PROGRESS %d %d" % (_done[0], TOTAL_RENDER))


bpy.app.handlers.render_post.append(on_frame)

img_settings = r.image_settings


def set_image(fmt, color="RGB"):
    if hasattr(img_settings, "media_type"):
        img_settings.media_type = "IMAGE"
    img_settings.file_format = fmt
    img_settings.color_mode = color


if CFG.get("preview_frame") is not None:
    TOTAL_RENDER = 1
    f = max(1, min(FRAMES, int(CFG["preview_frame"])))
    scene.frame_set(f)
    set_image("PNG", "RGBA" if r.film_transparent else "RGB")
    r.filepath = os.path.join(OUT, NAME + "_preview.png")
    stage("rendering preview frame %d" % f)
    bpy.ops.render.render(write_still=True)
    log("BM_FILE preview", r.filepath)
elif CFG["video"]:
    TOTAL_RENDER = FRAMES
    if r.film_transparent:
        set_image("PNG", "RGBA")
        frames_dir = os.path.join(OUT, NAME + "_frames")
        os.makedirs(frames_dir, exist_ok=True)
        r.filepath = os.path.join(frames_dir, "frame_")
        stage("rendering %d frames (transparent PNG)" % FRAMES)
        bpy.ops.render.render(animation=True)
        log("BM_FILE frames", frames_dir)
    else:
        if hasattr(img_settings, "media_type"):
            img_settings.media_type = "VIDEO"
        img_settings.file_format = "FFMPEG"
        ff = r.ffmpeg
        ff.format = "MPEG4"
        ff.codec = "H264"
        ff.constant_rate_factor = "HIGH"
        ff.ffmpeg_preset = "GOOD"
        ff.audio_codec = "NONE"
        path = os.path.join(OUT, NAME + ".mp4")
        r.filepath = path
        r.use_file_extension = False
        stage("rendering %d frames (MP4)" % FRAMES)
        bpy.ops.render.render(animation=True)
        log("BM_FILE video", path)

log("BM_DONE")
