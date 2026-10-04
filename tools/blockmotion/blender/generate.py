"""BlockMotion: Minecraft-style 3D animation generator (runs inside Blender 4.2+ / 5.x).

Usage:
    blender -b --factory-startup -P generate.py -- config.json

The config is written by the desktop app (see app/blockmotion.py) but can be
hand-written too (README has an example). Progress is printed on stdout as
lines starting with "BM_".
"""
import bpy, os, sys, json, math, random, tempfile
from mathutils import Vector, Matrix, Quaternion

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import bm_motions as MO  # noqa: E402

S = 1 / 16  # 1 skin pixel = 1/16 m (a player is 2 blocks tall)


def log(*a):
    print(*a, flush=True)


def stage(text):
    log("BM_STAGE", text)


# --------------------------------------------------------------------------
# config
# --------------------------------------------------------------------------
DEFAULTS = {
    "actors": None,            # list of actors (see normalise_actors); None = single actor from the keys below
    "skin": "", "arms": "auto", "item": "none", "motions": [{"id": "walk", "seconds": 4}], "move": True,
    "camera": "diagonal",      # default shot when "shots" is empty
    "shots": [],               # [{"camera": ..., "seconds": ..., "target": "all" | actor index, "zoom": 1}]
    "follow": True,
    "zoom": 1.0,
    "dof": False,              # blur the background (depth of field)
    "background": "grass",     # grass | desert | snow | cave | nether | end | studio | greenscreen | transparent | world
    "time": "day",             # day | sunset | night (outdoor backgrounds and worlds)
    "weather": "clear",        # clear | rain | snow
    "bg_color": [0.85, 0.87, 0.9],
    "world": {},               # {"path", "dimension", "x", "y", "z", "radius", "down", "up", "client_jar", "resource_packs"}
    "title": "", "title_seconds": 2.5,
    "subtitles": [],           # [{"start": s, "end": s, "text": "..."}]
    "letterbox": False,
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
    if cfg["background"] == "night":  # 1.0 configs
        cfg["background"], cfg["time"] = "grass", "night"
    return cfg


CFG = load_config()
TEX = os.path.join(CFG["assets"], "textures")
random.seed(CFG["seed"])

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
coll = scene.collection


def normalise_actors():
    acts = CFG["actors"]
    if not acts:
        acts = [{"skin": CFG["skin"], "arms": CFG["arms"], "item": CFG["item"],
                 "motions": CFG["motions"], "move": CFG["move"]}]
    out = []
    for i, a in enumerate(acts[:8]):
        b = {"name": "Actor%d" % (i + 1), "skin": "", "arms": "auto", "item": "none",
             "motions": [{"id": "idle", "seconds": 3}], "move": True,
             "x": 0.0, "z": 0.0, "yaw": 0.0}
        b.update(a)
        out.append(b)
    return out


ACTORS = normalise_actors()


# --------------------------------------------------------------------------
# materials / images
# --------------------------------------------------------------------------
_imgs = {}


def image(path):
    if path not in _imgs:
        im = bpy.data.images.load(path)
        w, h = im.size
        if h > w and h % w == 0:  # animated strip (water, lava...): keep the first frame
            px = list(im.pixels)
            top = px[(h - w) * w * 4:]
            first = bpy.data.images.new(os.path.basename(path), w, w, alpha=True)
            first.pixels = top
            bpy.data.images.remove(im)
            im = first
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


def image_has_alpha(im):
    px = im.pixels[:]
    return any(px[i] < 0.99 for i in range(3, len(px), 4))


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


def tex_mat(name, img_path, tint=None, clip=False, hide_backface=False, emission=0.0, alpha=None):
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
    if alpha is not None:  # see-through (water, stained glass)
        mul = nt.nodes.new("ShaderNodeMath"); mul.operation = "MULTIPLY"
        mul.inputs[1].default_value = alpha
        nt.links.new(t.outputs["Alpha"], mul.inputs[0])
        nt.links.new(mul.outputs[0], bsdf.inputs["Alpha"])
        try:
            m.surface_render_method = "BLENDED"
        except Exception:
            pass
        m.use_backface_culling = False
    elif clip:
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


def color_mat(name, rgb, rough=1.0, emission=0.0, alpha=1.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (*rgb, 1)
    b.inputs["Roughness"].default_value = rough
    b.inputs["Specular IOR Level"].default_value = 0.0
    if emission:
        b.inputs["Emission Color"].default_value = (*rgb, 1)
        b.inputs["Emission Strength"].default_value = emission
    if alpha < 1:
        b.inputs["Alpha"].default_value = alpha
        try:
            m.surface_render_method = "BLENDED"
        except Exception:
            pass
    m.diffuse_color = (*rgb, 1)
    return m


def flat_mat(name, rgb, alpha=1.0):
    """Unlit colour (overlays, letterbox, subtitles)."""
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    em = nt.nodes.new("ShaderNodeEmission")
    em.inputs["Color"].default_value = (*rgb, 1)
    em.inputs["Strength"].default_value = 1.0
    if alpha < 1:
        tr = nt.nodes.new("ShaderNodeBsdfTransparent")
        mix = nt.nodes.new("ShaderNodeMixShader")
        mix.inputs[0].default_value = alpha
        nt.links.new(tr.outputs[0], mix.inputs[1])
        nt.links.new(em.outputs[0], mix.inputs[2])
        nt.links.new(mix.outputs[0], out.inputs["Surface"])
        try:
            m.surface_render_method = "BLENDED"
        except Exception:
            pass
    else:
        nt.links.new(em.outputs[0], out.inputs["Surface"])
    m.diffuse_color = (*rgb, alpha)
    return m


def camera_only(ob):
    for attr in ("visible_shadow", "visible_diffuse", "visible_glossy", "visible_transmission",
                 "visible_volume_scatter"):
        if hasattr(ob, attr):
            setattr(ob, attr, False)


# --------------------------------------------------------------------------
# skin -> character mesh + rig
# --------------------------------------------------------------------------
def load_skin(path, arms):
    if not path or not os.path.exists(path):
        path = os.path.join(CFG["assets"], "default_skin.png")
    img = image(path)
    w, h = img.size
    legacy = (h == w // 2)
    if arms == "auto":
        arms = "classic"
        if not legacy:
            # slim skins leave the 4th column of the right arm front empty
            px = img.pixels[:]
            sx = w / 64

            def alpha(x, y):  # x,y in 64-space, origin top-left
                ix = int(x * sx); iy = h - 1 - int(y * sx)
                return px[(iy * w + ix) * 4 + 3]
            if alpha(54, 20) < 0.5 and alpha(55, 31) < 0.5:
                arms = "slim"
    log("BM_INFO skin", os.path.basename(path), f"{w}x{h}", "arms=" + arms, "legacy" if legacy else "")
    return img, arms, legacy


def skin_mat(name, img, overlay):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    bsdf = nt.nodes["Principled BSDF"]
    bsdf.inputs["Roughness"].default_value = 1.0
    bsdf.inputs["Specular IOR Level"].default_value = 0.0
    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.image = img
    tex.interpolation = "Closest"
    nt.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
    if overlay:
        alpha_clip(nt, tex.outputs["Alpha"], bsdf, m)
    return m


def add_box(acc, mn, size, uv, inflate, group, mat_index, th, mirror=False):
    verts, faces, uvs, groups, mats = acc
    w, h, d = size
    u, v = uv
    x0, y0, z0 = mn[0] - inflate, mn[1] - inflate, mn[2] - inflate
    x1, y1, z1 = mn[0] + w + inflate, mn[1] + d + inflate, mn[2] + h + inflate

    def uvp(px, py):
        return (px / 64, 1 - py / th)
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


def build_character(name, skin_path, arms_pref):
    img, arms, legacy = load_skin(skin_path, arms_pref)
    aw = 3 if arms == "slim" else 4
    th = 32 if legacy else 64
    # name, bone, base uv, size (w,h,d), min corner (px), overlay uv, inflate
    # Character faces -Y, its right side is -X.
    parts = [
        ("Head", "Head", (0, 0), (8, 8, 8), (-4, -4, 24), (32, 0), 0.5),
        ("Body", "Body", (16, 16), (8, 12, 4), (-4, -2, 12), (16, 32), 0.25),
        ("Arm.R", "Arm.R", (40, 16), (aw, 12, 4), (-4 - aw, -2, 12), (40, 32), 0.25),
        ("Arm.L", "Arm.L", (32, 48), (aw, 12, 4), (4, -2, 12), (48, 48), 0.25),
        ("Leg.R", "Leg.R", (0, 16), (4, 12, 4), (-4, -2, 0), (0, 32), 0.25),
        ("Leg.L", "Leg.L", (16, 48), (4, 12, 4), (0, -2, 0), (0, 48), 0.25),
    ]
    if legacy:  # 64x32 skins: left limbs reuse the right ones, only the hat layer exists
        parts[3] = ("Arm.L", "Arm.L", (40, 16), (aw, 12, 4), (4, -2, 12), None, 0)
        parts[5] = ("Leg.L", "Leg.L", (0, 16), (4, 12, 4), (0, -2, 0), None, 0)
        parts = [p if p[0] == "Head" or p[5] is None else (*p[:5], None, 0) for p in parts]
    acc = ([], [], [], [], [])
    for pname, bone, uv, size, mn, ouv, inf in parts:
        add_box(acc, mn, size, uv, 0.0, bone, 0, th, mirror=legacy and pname.endswith(".L"))
    for pname, bone, uv, size, mn, ouv, inf in parts:
        if ouv is not None:
            add_box(acc, mn, size, ouv, inf, bone, 1, th)
    verts, faces, uvs, groups, mats = acc
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata([tuple(v) for v in verts], [], faces)
    mesh.update()
    uvl = mesh.uv_layers.new(name="UVMap")
    for poly, tuv in zip(mesh.polygons, uvs):
        for li, t in zip(poly.loop_indices, tuv):
            uvl.data[li].uv = t
    for poly, mi in zip(mesh.polygons, mats):
        poly.material_index = mi
    mesh.materials.append(skin_mat(name + "_Skin", img, False))
    mesh.materials.append(skin_mat(name + "_Overlay", img, True))
    obj = bpy.data.objects.new(name, mesh)
    coll.objects.link(obj)
    for p in parts:
        obj.vertex_groups.new(name=p[1])
    for poly, g in zip(mesh.polygons, groups):
        obj.vertex_groups[g].add(list(poly.vertices), 1.0, "REPLACE")

    arm = bpy.data.armatures.new(name + "Rig")
    rig = bpy.data.objects.new(name + "Rig", arm)
    coll.objects.link(rig)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.mode_set(mode="EDIT")
    eb = arm.edit_bones

    def nb(bname, head, tail, parent=None):
        b = eb.new(bname)
        b.head = Vector(head) * S
        b.tail = Vector(tail) * S
        b.roll = 0
        if parent:
            b.parent = eb[parent]
    ax = 4 + aw / 2
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
    return rig, aw


# --------------------------------------------------------------------------
# held items (voxelised 16x16 sprites)
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
    "bow": ("bow", (7.5, 8.5), 45),
}
_item_mesh = {}


def build_item(key, rig, aw):
    texname, grip, tilt = ITEMS[key]
    if key not in _item_mesh:
        img = image(tex_path(texname))
        w, h = img.size
        px = img.pixels[:]
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
        mesh.materials.append(tex_mat("M_item_" + texname, tex_path(texname),
                                      emission=1.0 if key == "torch" else 0.0))
        _item_mesh[key] = mesh
    ob = bpy.data.objects.new(rig.name + "_Item", _item_mesh[key])
    coll.objects.link(ob)
    # rest pose in armature space: grip in the right hand, blade pointing forward / up
    hand = Vector((-(4 + aw / 2), -1.0, 13.5)) * S
    W = Matrix.Translation(hand) @ Matrix.Rotation(math.radians(tilt), 4, "X")
    ob.parent = rig
    ob.parent_type = "BONE"
    ob.parent_bone = "Arm.R"
    bone = rig.data.bones["Arm.R"]
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


# --------------------------------------------------------------------------
# world import (before animation so actors can stand on the terrain)
# --------------------------------------------------------------------------
BG = CFG["background"]
WORLD = None
if BG == "world":
    import bm_world  # noqa: E402
    stage("reading world")
    wcfg = dict(CFG["world"])
    cache = os.path.join(tempfile.gettempdir(), "blockmotion_textures")
    WORLD = bm_world.build_world(wcfg, CFG["assets"], cache, log)


def ground_at(x, y, near):
    """Ground height (Blender z) under Blender (x, y)."""
    if WORLD is None:
        return 0.0
    ox, oy, oz = WORLD["origin"]
    return WORLD["ground"](x + ox, -y + oz, near + oy) - oy


# --------------------------------------------------------------------------
# bake animation for every actor
# --------------------------------------------------------------------------
def bone_quat(rig, name, vec):
    """Character-space rotation (degrees, see bm_motions) -> bone-local quaternion."""
    x, y, z = (math.radians(a) for a in vec)
    Q = Matrix.Rotation(z, 3, "Z") @ Matrix.Rotation(y, 3, "Y") @ Matrix.Rotation(x, 3, "X")
    rest = rig.data.bones[name].matrix_local.to_3x3()
    return (rest.inverted() @ Q @ rest).to_quaternion()


def segments(actor):
    segs, t = [], 0.0
    for m in actor["motions"]:
        if m.get("id") not in MO.MOTIONS:
            continue
        d = max(0.2, float(m.get("seconds", 3)))
        segs.append((m["id"], t, d))
        t += d
    return segs or [("idle", 0.0, 3.0)]


for a in ACTORS:
    a["segs"] = segments(a)
TOTAL = max(sum(d for _, _, d in a["segs"]) for a in ACTORS)


def actor_state(a, t):
    """Pose and heading change (deg) at time t; the last motion holds past its end."""
    segs = a["segs"]
    heading = 0.0
    for i, (mid, start, d) in enumerate(segs):
        last = i == len(segs) - 1
        if t < start + d or last:
            local = min(t - start, d) if mid in MO.TURNS or mid in ("fall_down", "die") else t - start
            p = MO.motion_pose(mid, local, d)
            if mid in MO.TURNS:
                heading += MO.TURNS[mid] * MO.sm(min(1.0, local / d))
            if i > 0 and local < MO.BLEND_S:
                pm, ps, pd = segs[i - 1]
                prev = MO.motion_pose(pm, pd if pm in ("fall_down", "die") else pd + local, pd)
                if pm == "spin":
                    prev["turn"] = 0.0
                p = MO.lerp_pose(prev, p, MO.sm(local / MO.BLEND_S))
            return p, heading
        if mid in MO.TURNS:
            heading += MO.TURNS[mid]
    return {}, heading


FPS = int(CFG["fps"])
scene.render.fps = FPS
FRAMES = max(1, int(round(TOTAL * FPS)))
scene.frame_start = 1
scene.frame_end = FRAMES
stage("animating %d frames, %d actors" % (FRAMES, len(ACTORS)))
dt = 1.0 / FPS


def all_fcurves(obj):
    act = obj.animation_data.action
    try:
        return list(act.fcurves)
    except AttributeError:  # Blender 5 slotted actions
        out = []
        for layer in act.layers:
            for strip in layer.strips:
                for cb in strip.channelbags:
                    out.extend(cb.fcurves)
        return out


for ai, a in enumerate(ACTORS):
    rig, aw = build_character(a["name"], a.get("skin"), a.get("arms", "auto"))
    a["rig"] = rig
    if a.get("item") in ITEMS:
        build_item(a["item"], rig, aw)
    pos = Vector((float(a["x"]), -float(a["z"])))
    base_heading = -float(a["yaw"])  # Minecraft yaw: 0 = south (+Z), 90 = west
    g = ground_at(pos.x, pos.y, 0.0)
    prev_q = {}
    track = []  # per frame: (x, y, ground z, lift, heading deg)
    for f in range(1, FRAMES + 1):
        t = (f - 1) * dt
        p, dh = actor_state(a, t)
        heading = base_heading + dh
        hr = math.radians(heading)
        fwd = Vector((math.sin(hr), -math.cos(hr)))
        if a.get("move", True):
            pos += fwd * (p.get("speed", 0.0) * dt)
        gt = ground_at(pos.x, pos.y, g)
        g += (gt - g) * min(1.0, dt * 14)
        oy = p.get("oy", 0.0)
        off = Matrix.Rotation(hr, 3, "Z") @ Vector((0.0, oy, 0.0))
        lift = p.get("lift", 0.0)
        rig.location = (pos.x + off.x, pos.y + off.y, g + lift)
        rig.rotation_euler = (math.radians(p.get("pitch", 0.0)), math.radians(p.get("roll", 0.0)),
                              hr + math.radians(p.get("turn", 0.0) % 360.0))
        rig.keyframe_insert("location", frame=f)
        rig.keyframe_insert("rotation_euler", frame=f)
        # where the body actually is (lying / flipping moves it away from the feet)
        R = rig.rotation_euler.to_matrix()
        c_off = R @ Vector((0, 0, 1.0)) - Vector((0, 0, 1.0))
        track.append((rig.location.x + c_off.x, rig.location.y + c_off.y, g + c_off.z, lift, heading))
        for name in MO.BONES:
            pb = rig.pose.bones[name]
            q = bone_quat(rig, name, p.get(name, (0, 0, 0)))
            if name in prev_q and prev_q[name].dot(q) < 0:
                q.negate()
            prev_q[name] = q
            pb.rotation_quaternion = q
            pb.keyframe_insert("rotation_quaternion", frame=f)
    a["track"] = track
    # per-frame keys: linear avoids overshoot; angle wraps must not interpolate
    for fc in all_fcurves(rig):
        for kp in fc.keyframe_points:
            kp.interpolation = "LINEAR"
        if fc.data_path == "rotation_euler":
            pts = list(fc.keyframe_points)
            for k0, k1 in zip(pts, pts[1:]):
                if abs(k1.co[1] - k0.co[1]) > math.pi:
                    k0.interpolation = "CONSTANT"

PTS = [(x, y) for a in ACTORS for (x, y, *_r) in a["track"][::max(1, FPS // 4)]]
XMIN, XMAX = min(p[0] for p in PTS), max(p[0] for p in PTS)
YMIN, YMAX = min(p[1] for p in PTS), max(p[1] for p in PTS)
log("BM_INFO duration %.2fs frames %d area %.1fx%.1fm" % (TOTAL, FRAMES, XMAX - XMIN, YMAX - YMIN))


def near_path(x, y, r):
    r2 = r * r
    if any((x - px) ** 2 + (y - py) ** 2 < r2 for px, py in PTS):
        return True
    rc = min(r, 5.0) ** 2
    return any((x - px) ** 2 + (y - py) ** 2 < rc for px, py in CAMPTS)


# --------------------------------------------------------------------------
# camera: baked per frame from the shot list
# --------------------------------------------------------------------------
cam_data = bpy.data.cameras.new("Camera")
cam_data.lens = 50
cam_data.sensor_fit = "VERTICAL"
cam_data.sensor_height = 24
cam_data.clip_start = 0.05
cam_data.clip_end = 600
cam = bpy.data.objects.new("Camera", cam_data)
coll.objects.link(cam)
scene.camera = cam
cam.rotation_mode = "QUATERNION"

PORTRAIT = CFG["resolution"][1] > CFG["resolution"][0]
SHOTS = []
_t = 0.0
for s in (CFG.get("shots") or []):
    d = max(0.2, float(s.get("seconds", 3)))
    SHOTS.append(dict(s, start=_t, end=_t + d))
    _t += d
if not SHOTS:
    SHOTS = [{"camera": CFG["camera"], "target": "all" if len(ACTORS) > 1 else 0,
              "zoom": CFG["zoom"], "follow": CFG["follow"], "start": 0.0, "end": TOTAL}]
else:
    SHOTS[-1]["end"] = max(SHOTS[-1]["end"], TOTAL)


def target_frames(shot):
    tg = shot.get("target", "all")
    if tg == "all" or tg is None:
        return list(range(len(ACTORS)))
    return [max(0, min(len(ACTORS) - 1, int(tg)))]


def actor_point(ai, f):
    x, y, g, lift, heading = ACTORS[ai]["track"][max(0, min(FRAMES - 1, f - 1))]
    return Vector((x, y, g + 0.5 * lift)), heading


def group_point(idx, f):
    pts = [actor_point(i, f)[0] for i in idx]
    c = sum(pts, Vector()) / len(pts)
    spread = max(((p - q).length for p in pts for q in pts), default=0.0)
    return c, spread


def offsets(kind, d, k):
    """Camera offset in the target's frame (facing -Y) and look height, k = 0..1 through the shot."""
    look = 1.05
    if kind == "front":
        return Vector((0, -d, 1.3)), look
    if kind == "side":
        return Vector((d, 0, 1.2)), look
    if kind == "back":
        return Vector((0, d, 1.6)), look
    if kind == "closeup":
        return Vector((d * 0.25, -d * 0.42, 1.65)), 1.5
    if kind == "low":
        return Vector((d * 0.45, -d * 0.7, 0.25)), 1.25
    if kind == "high":
        return Vector((d * 0.5, -d * 0.55, 4.5)), look
    if kind == "wide":
        return Vector((d * 1.15, -d * 1.25, 3.5)), look
    if kind == "top":
        return Vector((0, 0.01, d * 1.6)), 0.5
    if kind == "orbit":
        a = math.radians(-60) + 2 * math.pi * k
        return Vector((math.sin(a) * d, -math.cos(a) * d, 1.5)), look
    if kind == "dolly_in":
        e = MO.sm(k)
        return Vector((d * 0.3, -d * (1.2 - 0.85 * e), 1.4 + 0.2 * e)), 1.05 + 0.4 * e
    if kind == "dolly_out":
        e = MO.sm(k)
        return Vector((d * 0.3, -d * (0.35 + 0.85 * e), 1.6 - 0.2 * e)), 1.45 - 0.4 * e
    if kind == "crane":
        e = MO.sm(k)
        return Vector((d * 0.6, -d * 0.7, 0.4 + 6.0 * e)), look
    if kind == "track":
        return Vector((d, -3.0 + 6.0 * k, 1.3)), look
    return Vector((d * 0.68, -d * 0.72, 1.6)), look  # diagonal


stage("placing camera (%d shots)" % len(SHOTS))
CAMPTS = []
prev_rot = None
cut_frames = []
for si, shot in enumerate(SHOTS):
    f0 = int(round(shot["start"] * FPS)) + 1
    f1 = min(FRAMES, int(round(shot["end"] * FPS)))
    if f0 > FRAMES:
        break
    cut_frames.append(f0)
    kind = shot.get("camera", "diagonal")
    idx = target_frames(shot)
    zoom = float(shot.get("zoom", 1.0)) or 1.0
    follow = shot.get("follow", True)
    h0 = actor_point(idx[0], f0)[1]
    R0 = Matrix.Rotation(math.radians(h0), 3, "Z")
    spread = max(group_point(idx, f)[1] for f in range(f0, f1 + 1, max(1, FPS // 4)))
    d = 7.0 / zoom * (1.35 if PORTRAIT else 1.0) * max(1.0, (spread + 1.5) / 2.5)
    mid = (f0 + f1) // 2
    fixed_c = group_point(idx, mid)[0]
    if not follow:
        span = max((group_point(idx, f)[0] - fixed_c).length for f in (f0, f1))
        d *= 1 + span / 6
    for f in range(f0, f1 + 1):
        k = (f - f0) / max(1, f1 - f0)
        c = group_point(idx, f)[0]
        if kind == "pov":
            p0, hd = actor_point(idx[0], f)
            hr = math.radians(hd)
            fwd = Vector((math.sin(hr), -math.cos(hr), 0))
            pos = p0 + fwd * 0.3 + Vector((0, 0, 1.62))
            look_at = pos + fwd * 5 + Vector((0, 0, -0.35))
        elif kind == "over_shoulder":
            p0, hd = actor_point(idx[0], f)
            others = [actor_point(i, f)[0] for i in range(len(ACTORS)) if i != idx[0]]
            if others:
                other = sum(others, Vector()) / len(others)
                look_at = other + Vector((0, 0, 1.3))
            else:
                hr = math.radians(hd)
                other = p0 + Vector((math.sin(hr), -math.cos(hr), 0)) * 6
                look_at = other + Vector((0, 0, 1.2))
            back = (p0 - other).to_2d()
            back = back.normalized() if back.length > 1e-3 else Vector((0, 1))
            side = Vector((-back.y, back.x))
            pos = p0 + Vector((back.x * 2.3 + side.x * 0.75, back.y * 2.3 + side.y * 0.75, 1.95))
        else:
            off, look_h = offsets(kind, d, k)
            base = c if follow else fixed_c
            off = R0 @ off
            if CFG["background"] == "world":  # stay inside the loaded area so its cut edges stay off screen
                lim = max(4.0, 0.6 * float(CFG["world"].get("radius", 32)))
                hz = off.to_2d()
                if hz.length > lim:
                    hz *= lim / hz.length
                    off = Vector((hz.x, hz.y, off.z))
            pos = base + off
            look_at = c + Vector((0, 0, look_h))
        cam.location = pos
        if f % max(1, FPS // 3) == 0 or f == f0:  # keep scenery out of the camera's way
            for u in (0.0, 0.25, 0.5, 0.75):
                pt = pos.lerp(look_at, u)
                CAMPTS.append((pt.x, pt.y))
        q = (look_at - pos).to_track_quat("-Z", "Y")
        if prev_rot is not None and prev_rot.dot(q) < 0:
            q.negate()
        prev_rot = q
        cam.rotation_quaternion = q
        cam.keyframe_insert("location", frame=f)
        cam.keyframe_insert("rotation_quaternion", frame=f)
        if CFG["dof"]:
            cam_data.dof.focus_distance = (look_at - pos).length
            cam_data.dof.keyframe_insert("focus_distance", frame=f)
for fc in all_fcurves(cam):
    for kp in fc.keyframe_points:
        kp.interpolation = "LINEAR"
    for kp in fc.keyframe_points:  # hard cuts between shots
        if int(round(kp.co[0])) + 1 in cut_frames[1:]:
            kp.interpolation = "CONSTANT"
if CFG["dof"]:
    cam_data.dof.use_dof = True
    cam_data.dof.aperture_fstop = 1.8



# --------------------------------------------------------------------------
# world / sky / lights
# --------------------------------------------------------------------------
def world_gradient(horizon, zenith, strength=1.0):
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


TIME = CFG["time"]
WEATHER = CFG["weather"]


def sky_for_time(day=((0.78, 0.87, 1.0), (0.36, 0.56, 0.96))):
    if TIME == "sunset":
        world_gradient((1.0, 0.55, 0.32), (0.22, 0.27, 0.55))
        sun(2.6, (82, 0, 60), (1.0, 0.62, 0.38), 2.0)
    elif TIME == "night":
        world_gradient((0.05, 0.07, 0.16), (0.005, 0.008, 0.03))
        sun(0.35, (55, 0, -40), (0.6, 0.7, 1.0), 1.0)
    else:
        h, z = day
        if WEATHER != "clear":
            h, z = (0.62, 0.66, 0.72), (0.45, 0.5, 0.58)
        world_gradient(h, z)
        sun(1.6 if WEATHER != "clear" else 3.2, (50, 0, 35), (1, 1, 1), 8.0 if WEATHER != "clear" else 3.0)


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
        for poly, mi in zip(me.polygons, fm):
            poly.material_index = mi
        for m in mats:
            me.materials.append(m)
        for poly in me.polygons:
            vz = [me.vertices[me.loops[li].vertex_index].co for li in poly.loop_indices]
            if abs(poly.normal.z) < 0.5:  # sides: textures stand upright
                horiz = Vector((-poly.normal.y, poly.normal.x, 0))
                for li, co in zip(poly.loop_indices, vz):
                    uvl.data[li].uv = (horiz.dot(co) / size + 0.5, co.z / size + 0.5)
            else:
                for li, co in zip(poly.loop_indices, vz):
                    uvl.data[li].uv = (co.x / size + 0.5, co.y / size + 0.5)
        _cube_cache[key] = me
    ob = bpy.data.objects.new(name, _cube_cache[key])
    coll.objects.link(ob)
    ob.location = loc
    return ob


def cross_plant(name, texname, loc, tint=None, height=0.9, emission=0.0):
    m = tex_mat("M_" + texname + ("_t" if tint else ""), tex_path(texname), tint=tint, clip=True,
                emission=emission)
    vs, fs = [], []
    for a in (45, 135):
        c, s = math.cos(math.radians(a)) * 0.45, math.sin(math.radians(a)) * 0.45
        b = len(vs)
        vs += [(-c, -s, 0), (c, s, 0), (c, s, height), (-c, -s, height)]
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


GRASS_TINT = (0.475, 0.753, 0.353)
LEAF_TINT = (0.467, 0.671, 0.184)
SPRUCE_TINT = (0.380, 0.600, 0.380)
M = 30  # margin around the action
AX0, AX1, AY0, AY1 = XMIN - M, XMAX + M, YMIN - M, YMAX + M


def tree(x, y, h=None, kind="oak"):
    h = h or random.choice((4, 5, 5, 6))
    if kind == "spruce":
        log_m = (tex_mat("M_spruce_top", tex_path("spruce_log_top")), tex_mat("M_spruce_log", tex_path("spruce_log")),
                 tex_mat("M_spruce_top", tex_path("spruce_log_top")))
        leaf = tex_mat("M_spruce_leaves", tex_path("spruce_leaves"), tint=SPRUCE_TINT, clip=True)
        h += 2
        for z in range(h):
            block("log", (x, y, z + 0.5), log_m)
        for z in range(2, h + 1):
            r = max(0, min(2, (h - z) // 2)) if z < h else 0
            for dx in range(-r, r + 1):
                for dy in range(-r, r + 1):
                    if (dx or dy or z >= h) and abs(dx) + abs(dy) <= r + (z % 2):
                        block("leaf", (x + dx, y + dy, z + 0.5), leaf)
        block("leaf", (x, y, h + 0.5), leaf)
        return
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


def scatter(n_trees, tree_fn, n_small, small_fn):
    placed = 0
    for _ in range(n_trees * 6):
        if placed >= n_trees:
            break
        x, y = random.randint(int(AX0), int(AX1)), random.randint(int(AY0), int(AY1))
        if not near_path(x, y, 6):
            tree_fn(x, y)
            placed += 1
    used = set()  # one plant per block: two plants in one cell overlap exactly and EEVEE paints them black
    for _ in range(n_small):
        x, y = random.randint(int(AX0), int(AX1)), random.randint(int(AY0), int(AY1))
        if (x, y) not in used and not near_path(x, y, 2.5):
            used.add((x, y))
            small_fn(x + 0.5, y + 0.5)


def area_trees(density):
    return int((AX1 - AX0) * (AY1 - AY0) * density)


def bg_grass():
    sky_for_time()
    tiled_plane("Ground", tex_mat("M_grass", tex_path("grass_block_top"), tint=GRASS_TINT), AX0 - 40, AX1 + 40, AY0 - 40, AY1 + 40)

    def small(x, y):
        r = random.random()
        if r < 0.7:
            cross_plant("grass", "short_grass", (x, y, 0), GRASS_TINT)
        elif r < 0.85:
            cross_plant("poppy", "poppy", (x, y, 0))
        else:
            cross_plant("dandelion", "dandelion", (x, y, 0))
    scatter(area_trees(0.012), tree, area_trees(0.25), small)


def bg_desert():
    sky_for_time(((0.95, 0.88, 0.75), (0.45, 0.62, 0.95)))
    tiled_plane("Ground", tex_mat("M_sand", tex_path("sand")), AX0 - 40, AX1 + 40, AY0 - 40, AY1 + 40)
    cm = (tex_mat("M_cactus_top", tex_path("cactus_top")), tex_mat("M_cactus_side", tex_path("cactus_side"), clip=True),
          tex_mat("M_cactus_top", tex_path("cactus_top")))

    def cactus(x, y):
        for z in range(random.randint(1, 3)):
            block("cactus", (x, y, z + 0.5), cm, size=0.875)
    scatter(area_trees(0.01), cactus, area_trees(0.03), lambda x, y: cross_plant("dead_bush", "dead_bush", (x, y, 0)))


def bg_snow():
    sky_for_time(((0.85, 0.9, 0.98), (0.55, 0.68, 0.92)))
    tiled_plane("Ground", tex_mat("M_snow", tex_path("snow")), AX0 - 40, AX1 + 40, AY0 - 40, AY1 + 40)
    scatter(area_trees(0.014), lambda x, y: tree(x, y, kind="spruce"), 0, None)


def bg_nether():
    world_gradient((0.22, 0.04, 0.03), (0.06, 0.01, 0.01))
    sun(0.6, (60, 0, 20), (1.0, 0.5, 0.35), 20.0)
    tiled_plane("Ground", tex_mat("M_netherrack", tex_path("netherrack")), AX0 - 40, AX1 + 40, AY0 - 40, AY1 + 40)
    lava = tex_mat("M_lava", tex_path("lava_still"), emission=2.5)

    def pool(x, y):
        w, d = random.randint(2, 5), random.randint(2, 5)
        tiled_plane("Lava", lava, x, x + w, y, y + d, z=0.01)
        point("LavaGlow", (x + w / 2, y + d / 2, 1.0), 120, (1.0, 0.45, 0.15), 1.5)
    gs = tex_mat("M_glowstone", tex_path("glowstone"), emission=2.0)

    def pillar(x, y):
        for z in range(random.randint(2, 6)):
            block("netherrack", (x, y, z + 0.5), tex_mat("M_netherrack", tex_path("netherrack")))
        block("glowstone", (x, y, 6.5), gs)
    scatter(area_trees(0.003), pool, area_trees(0.04),
            lambda x, y: cross_plant("fungus", "crimson_fungus", (x, y, 0)))
    scatter(area_trees(0.004), pillar, 0, None)
    point("Fill", ((XMIN + XMAX) / 2, (YMIN + YMAX) / 2 - 4, 4), 200, (1.0, 0.6, 0.4), 3)


def bg_end():
    world_gradient((0.07, 0.04, 0.1), (0.01, 0.0, 0.02))
    sun(0.8, (40, 0, 30), (0.85, 0.8, 1.0), 10.0)
    tiled_plane("Ground", tex_mat("M_end_stone", tex_path("end_stone")), AX0 - 20, AX1 + 20, AY0 - 20, AY1 + 20)
    obs = tex_mat("M_obsidian", tex_path("obsidian"))
    for i in range(6):
        a = 2 * math.pi * i / 6
        cx = (XMIN + XMAX) / 2 + math.cos(a) * 28
        cy = (YMIN + YMAX) / 2 + math.sin(a) * 28
        h = random.randint(14, 30)
        for z in range(h):
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    if abs(dx) + abs(dy) < 2 or z % 3 == 0:
                        block("obsidian", (round(cx) + dx, round(cy) + dy, z + 0.5), obs)
    point("Fill", ((XMIN + XMAX) / 2, (YMIN + YMAX) / 2 - 4, 4), 150, (0.8, 0.7, 1.0), 3)


def bg_cave():
    world_gradient((0.02, 0.02, 0.025), (0.01, 0.01, 0.012), 1.0)
    stone = tex_mat("M_stone_floor", tex_path("stone"))
    wall = tex_mat("M_stone_wall", tex_path("stone"), hide_backface=True)
    hgt = 5
    x0, x1 = XMIN - 4, XMAX + 4
    y0, y1 = YMIN - 12, YMAX + 12
    tiled_plane("Floor", stone, x0, x1, y0, y1)
    tiled_plane("Ceiling", wall, x0, x1, y0, y1, z=hgt, normal_sign=-1)
    # wall normals point inwards; seen from outside they are back faces and vanish
    tiled_plane("WallR", wall, y0, y1, 0, hgt, z=x0, axis="X", normal_sign=1)
    tiled_plane("WallL", wall, y0, y1, 0, hgt, z=x1, axis="X", normal_sign=-1)
    tiled_plane("WallBack", wall, x0, x1, 0, hgt, z=y1, axis="Y", normal_sign=1)
    tiled_plane("WallFront", wall, x0, x1, 0, hgt, z=y0, axis="Y", normal_sign=-1)
    ores = [tex_mat("M_" + n, tex_path(n), hide_backface=True) for n in ("coal_ore", "iron_ore", "diamond_ore")]
    y = y1 - 1
    while y > y0 + 1:
        for xw, side in ((x0, -1), (x1, 1)):
            if random.random() < 0.6:
                z = random.randint(0, hgt - 1)
                yy = round(y)
                tiled_plane("Ore", random.choice(ores), yy, yy + 1, z, z + 1,
                            z=xw - side * 0.002, axis="X", normal_sign=-side)
        y -= random.uniform(1.5, 4)
    y = y1 - 3
    while y > y0 + 2:
        for xw, side in ((x0, -1), (x1, 1)):
            point("CaveTorch", (xw - side * 0.4, y, 2.8), 60, (1.0, 0.7, 0.35), 0.15)
            cross_plant("torch", "torch", (xw - side * 0.25, y, 2.2), emission=2.0)
        y -= 7


def bg_world():
    dim = CFG["world"].get("dimension", "overworld")
    if dim == "nether":
        world_gradient((0.22, 0.04, 0.03), (0.06, 0.01, 0.01))
        sun(0.4, (60, 0, 20), (1.0, 0.5, 0.35), 20.0)
    elif dim == "end":
        world_gradient((0.07, 0.04, 0.1), (0.01, 0.0, 0.02))
        sun(0.6, (40, 0, 30), (0.85, 0.8, 1.0), 10.0)
    else:
        sky_for_time()
    W = WORLD
    stage("building world mesh")
    mats, keys = [], sorted(W["materials"].items(), key=lambda kv: kv[1])
    for (tex, tint, kind, emission), idx in keys:
        path = W["assets"].texture(tex)
        if path is None:
            m = color_mat("W_missing", (0.6, 0.6, 0.6))
        else:
            name = "W_" + os.path.basename(path)[:-4] + ("_t" if tint else "")
            translucent = any(w in tex for w in ("water", "stained_glass", "ice", "slime", "honey"))
            img = image(path)
            m = tex_mat(name, path, tint=tint, emission=emission,
                        alpha=(0.75 if "water" in tex else 0.85) if translucent else None,
                        clip=(not translucent) and image_has_alpha(img))
        mats.append(m)
    verts, uvs, fm = W["verts"], W["uvs"], W["faces_mat"]
    me = bpy.data.meshes.new("World")
    nf = len(fm)
    me.vertices.add(len(verts))
    me.vertices.foreach_set("co", [c for v in verts for c in v])
    me.loops.add(nf * 4)
    me.loops.foreach_set("vertex_index", list(range(nf * 4)))
    me.polygons.add(nf)
    me.polygons.foreach_set("loop_start", list(range(0, nf * 4, 4)))
    me.polygons.foreach_set("loop_total", [4] * nf)
    me.polygons.foreach_set("material_index", fm)
    uvl = me.uv_layers.new(name="UVMap")
    uvl.data.foreach_set("uv", [c for uv in uvs for c in uv])
    for m in mats:
        me.materials.append(m)
    me.update(calc_edges=True)
    me.validate()
    ob = bpy.data.objects.new("World", me)
    coll.objects.link(ob)
    # lights for torches & co, the ones nearest to the action first
    cx, cy = (XMIN + XMAX) / 2, (YMIN + YMAX) / 2
    lamps = sorted(W["lights"], key=lambda l: (l[0] - cx) ** 2 + (l[1] - cy) ** 2)[:40]
    for (x, y, z, name) in lamps:
        col = (0.45, 0.75, 1.0) if "soul" in name else (1.0, 0.72, 0.4)
        point("BlockLight", (x, y, z), 30 if TIME != "day" or dim != "overworld" else 12, col, 0.2)


BUILDERS = {"grass": bg_grass, "desert": bg_desert, "snow": bg_snow, "nether": bg_nether, "end": bg_end,
            "cave": bg_cave, "world": bg_world}
stage("building background: " + BG)
scene.render.film_transparent = False
if BG in BUILDERS:
    BUILDERS[BG]()
elif BG == "studio":
    c = tuple(CFG["bg_color"])
    world_split(c, (1, 1, 1), 0.45)
    tiled_plane("Floor", color_mat("M_floor", c), AX0 - 200, AX1 + 200, AY0 - 200, AY1 + 200)
    sun(2.4, (45, 0, 30))
elif BG == "greenscreen":
    world_split((0.0, 1.0, 0.0), (1, 1, 1), 0.45)
    sun(2.4, (45, 0, 30))
else:  # transparent
    world_split((0, 0, 0), (1, 1, 1), 0.45)
    scene.render.film_transparent = True
    sun(2.4, (45, 0, 30))


# --------------------------------------------------------------------------
# weather (particles)
# --------------------------------------------------------------------------
def add_weather(kind):
    w, d = (AX1 - AX0) + 20, (AY1 - AY0) + 20
    bpy.ops.mesh.primitive_plane_add(size=1, location=((AX0 + AX1) / 2, (AY0 + AY1) / 2, 18))
    em = bpy.context.active_object
    em.name = "WeatherEmitter"
    em.scale = (w, d, 1)
    if kind == "rain":
        bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0, -50))
        drop = bpy.context.active_object
        drop.scale = (0.015, 0.015, 0.35)
        drop.data.materials.append(flat_mat("M_rain", (0.75, 0.82, 0.95), 0.45))
    else:
        bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0, -50))
        drop = bpy.context.active_object
        drop.scale = (0.1, 0.1, 0.1)
        drop.data.materials.append(flat_mat("M_snowflake", (1, 1, 1), 0.95))
    drop.name = "WeatherDrop"
    camera_only(drop)
    drop.hide_render = False
    ps_mod = em.modifiers.new("Weather", "PARTICLE_SYSTEM")
    ps = ps_mod.particle_system.settings
    life = 40 if kind == "rain" else 400
    ps.count = int(w * d * (3.0 if kind == "rain" else 0.9))
    ps.frame_start = -life
    ps.frame_end = FRAMES + 1
    ps.lifetime = life
    ps.emit_from = "FACE"
    ps.normal_factor = -14.0 if kind == "rain" else -1.2
    ps.effector_weights.gravity = 0.0
    if kind == "snow":
        ps.brownian_factor = 0.6
    ps.render_type = "OBJECT"
    ps.instance_object = drop
    ps.particle_size = 1.0
    ps.use_rotations = kind == "rain"
    if kind == "rain":
        ps.rotation_mode = "VEL"
        ps.rotation_factor_random = 0.0
    em.show_instancer_for_render = False
    em.show_instancer_for_viewport = False
    camera_only(em)


if WEATHER in ("rain", "snow") and BG not in ("cave", "studio", "greenscreen", "transparent"):
    add_weather(WEATHER)


if BG in ("cave",) or TIME == "night" or (BG == "world" and CFG["world"].get("dimension") != "overworld"):
    fill = point("CameraFill", (0, 0, 0), 120 if BG == "cave" else 90, (1.0, 0.92, 0.82), 1.5)
    fill.parent = cam
    fill.location = (0.8, 0.6, 0)
    camera_only(fill)


# --------------------------------------------------------------------------
# overlays: letterbox, title, subtitles (objects in front of the lens)
# --------------------------------------------------------------------------
RW, RH = int(CFG["resolution"][0]), int(CFG["resolution"][1])
OD = 0.5  # overlay distance in front of the lens
HALF_H = OD * (cam_data.sensor_height / 2) / cam_data.lens
HALF_W = HALF_H * RW / RH


def overlay_plane(name, x0, x1, y0, y1, mat):
    me = bpy.data.meshes.new(name)
    me.from_pydata([(x0, y0, -OD), (x1, y0, -OD), (x1, y1, -OD), (x0, y1, -OD)], [], [(0, 1, 2, 3)])
    me.materials.append(mat)
    ob = bpy.data.objects.new(name, me)
    coll.objects.link(ob)
    ob.parent = cam
    camera_only(ob)
    return ob


def find_font():
    cands = [os.path.join(os.environ.get("WINDIR", r"C:\Windows"), "Fonts", f)
             for f in ("YuGothB.ttc", "meiryob.ttc", "meiryo.ttc", "BIZ-UDGothicB.ttc", "msgothic.ttc")]
    cands += ["/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc",
              "/usr/share/fonts/opentype/noto/NotoSerifCJK-Bold.ttc",
              "/System/Library/Fonts/ヒラギノ角ゴシック W6.ttc"]
    for p in cands:
        if os.path.exists(p):
            try:
                return bpy.data.fonts.load(p)
            except Exception:
                continue
    return None


_font = [None, False]


def text_obj(name, body, size, y, start, end, color=(1, 1, 1)):
    if not _font[1]:
        _font[0], _font[1] = find_font(), True
    objs = []
    for shadow in (True, False):
        cu = bpy.data.curves.new(name + ("_shadow" if shadow else ""), "FONT")
        cu.body = body
        if _font[0]:
            cu.font = _font[0]
        cu.align_x = "CENTER"
        cu.align_y = "CENTER"
        cu.size = size
        ob = bpy.data.objects.new(cu.name, cu)
        coll.objects.link(ob)
        ob.parent = cam
        off = size * 0.06 if shadow else 0.0
        ob.location = (off, y - off, -OD + (0.0 if shadow else 0.0005))
        ob.data.materials.append(flat_mat("M_" + cu.name, (0, 0, 0) if shadow else color))
        camera_only(ob)
        # visible only between start and end
        f0, f1 = max(1, int(start * FPS) + 1), int(end * FPS) + 1
        keys = [(1, f0 > 1)] + ([(f0, False)] if f0 > 1 else []) + [(f1, True)]
        for fr, hidden in keys:
            ob.hide_render = hidden
            ob.hide_viewport = hidden
            ob.keyframe_insert("hide_render", frame=fr)
            ob.keyframe_insert("hide_viewport", frame=fr)
        objs.append(ob)
    return objs


bar = 0.0
if CFG["letterbox"]:
    target_h = HALF_W / 2.39
    bar = max(0.0, HALF_H - target_h)
    if bar > 0:
        black = flat_mat("M_letterbox", (0, 0, 0))
        overlay_plane("LetterboxTop", -HALF_W * 1.1, HALF_W * 1.1, HALF_H - bar, HALF_H * 1.1, black)
        overlay_plane("LetterboxBottom", -HALF_W * 1.1, HALF_W * 1.1, -HALF_H * 1.1, -HALF_H + bar, black)
if CFG.get("title"):
    text_obj("Title", CFG["title"], HALF_H * 0.42, 0.0, 0.0, float(CFG.get("title_seconds", 2.5)))
for i, sub in enumerate(CFG.get("subtitles") or []):
    if not sub.get("text"):
        continue
    size = HALF_H * (0.2 if not PORTRAIT else 0.12)
    y = -HALF_H + max(bar, 0) + size * (1.6 if bar else 2.2)
    if bar:
        y = -HALF_H + bar / 2  # inside the bottom bar
    text_obj("Subtitle%d" % i, sub["text"], size, y, float(sub.get("start", 0)), float(sub.get("end", 2)))


# --------------------------------------------------------------------------
# render settings
# --------------------------------------------------------------------------
r = scene.render
r.resolution_x, r.resolution_y = RW, RH
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
TOTAL_RENDER = 1


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
