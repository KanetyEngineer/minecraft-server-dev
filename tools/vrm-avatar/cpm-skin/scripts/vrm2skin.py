"""VRM (T-pose) -> Minecraft 64x64 skin by orthographic projection per box face.

usage: python vrm2skin.py model.vrm out_dir
Coordinates: Blender, character faces -Y, character's right = -X.
"""
import bpy, sys, os, math
import numpy as np
from mathutils import Vector, Matrix
from PIL import Image

SRC, OUT = sys.argv[-2], sys.argv[-1]
os.makedirs(OUT, exist_ok=True)
RAW = os.path.join(OUT, "raw"); os.makedirs(RAW, exist_ok=True)
SS = 16  # supersampling per skin pixel

bpy.ops.wm.read_factory_settings(use_empty=True)
glb = os.path.join(OUT, "model.glb")
if not os.path.exists(glb):
    import shutil; shutil.copy(SRC, glb)
bpy.ops.import_scene.gltf(filepath=glb)
sc = bpy.context.scene
for o in bpy.data.objects:
    if o.type == "MESH" and o.name not in ("Body", "Face", "Hair"):
        o.hide_render = True

# --- flat (unlit) materials: emission = base color, keep alpha
for mt in bpy.data.materials:
    if not mt.node_tree:
        continue
    nt = mt.node_tree
    bsdf = next((n for n in nt.nodes if n.type == "BSDF_PRINCIPLED"), None)
    outn = next((n for n in nt.nodes if n.type == "OUTPUT_MATERIAL"), None)
    if not bsdf or not outn:
        continue
    em = nt.nodes.new("ShaderNodeEmission")
    tr = nt.nodes.new("ShaderNodeBsdfTransparent")
    mix = nt.nodes.new("ShaderNodeMixShader")
    bc = bsdf.inputs["Base Color"]
    if bc.is_linked:
        nt.links.new(bc.links[0].from_socket, em.inputs["Color"])
    else:
        em.inputs["Color"].default_value = bc.default_value
    al = bsdf.inputs["Alpha"]
    if al.is_linked:
        # alpha clip at 0.5 so hashed hair edges don't turn into noise
        gt = nt.nodes.new("ShaderNodeMath"); gt.operation = "GREATER_THAN"
        gt.inputs[1].default_value = 0.5
        nt.links.new(al.links[0].from_socket, gt.inputs[0])
        nt.links.new(gt.outputs[0], mix.inputs[0])
    else:
        mix.inputs[0].default_value = al.default_value
    nt.links.new(tr.outputs[0], mix.inputs[1])
    nt.links.new(em.outputs[0], mix.inputs[2])
    nt.links.new(mix.outputs[0], outn.inputs["Surface"])

# material groups we can toggle per pass
HAIR_MATS = {"Hair_00_HAIR"}
orig_out = {}
def set_visible(mat_names_hidden, holdout=()):
    for mt in bpy.data.materials:
        if not mt.node_tree:
            continue
        outn = next((n for n in mt.node_tree.nodes if n.type == "OUTPUT_MATERIAL"), None)
        if outn is None:
            continue
        mix = next(n for n in mt.node_tree.nodes if n.type == "MIX_SHADER")
        tr = next(n for n in mt.node_tree.nodes if n.type == "BSDF_TRANSPARENT")
        src = tr.outputs[0] if mt.name in mat_names_hidden else mix.outputs[0]
        if mt.name in holdout:
            ho = next((n for n in mt.node_tree.nodes if n.type == "HOLDOUT"), None) or mt.node_tree.nodes.new("ShaderNodeHoldout")
            src = ho.outputs[0]
        mt.node_tree.links.new(src, outn.inputs["Surface"])

sc.render.engine = "CYCLES"
sc.cycles.device = "CPU"
sc.cycles.samples = 8
sc.cycles.use_denoising = False
sc.cycles.max_bounces = 0
sc.cycles.transparent_max_bounces = 32
sc.render.film_transparent = True
sc.render.filter_size = 0.5
sc.view_settings.view_transform = "Standard"
sc.render.image_settings.file_format = "PNG"
sc.render.image_settings.color_mode = "RGBA"
sc.world = bpy.data.worlds.new("W")
sc.world.use_nodes = True
sc.world.node_tree.nodes["Background"].inputs[1].default_value = 0

cam = bpy.data.objects.new("Cam", bpy.data.cameras.new("Cam"))
cam.data.type = "ORTHO"
sc.collection.objects.link(cam)
sc.camera = cam

def rotY(deg):
    return Matrix.Rotation(math.radians(deg), 3, "Y")

# Parts. center (T-pose world), half extents in the "hanging" frame (x,y,z),
# R = rotation hanging-frame -> T-pose frame (identity except arms).
# box px size (w,h,d) and uv origin as in the vanilla skin layout.
def P(name, uv, size, center, half, R=Matrix.Identity(3), hide=(), overlay=False):
    return dict(name=name, uv=uv, size=size, c=Vector(center), h=Vector(half), R=R, hide=set(hide), overlay=overlay)

HEAD_C, HEAD_H = (0, 0.02, 1.48), (0.115, 0.115, 0.12)
PARTS = [
    P("head", (0, 0), (8, 8, 8), HEAD_C, HEAD_H, hide=HAIR_MATS),
    P("hat", (32, 0), (8, 8, 8), HEAD_C, tuple(x * 1.15 for x in HEAD_H), overlay=True),
    P("body", (16, 16), (8, 12, 4), (0, 0, 1.11), (0.13, 0.13, 0.25)),
    P("leg_r", (0, 16), (4, 12, 4), (-0.065, -0.01, 0.43), (0.065, 0.125, 0.43)),
    P("leg_l", (16, 48), (4, 12, 4), (0.065, -0.01, 0.43), (0.065, 0.125, 0.43)),
    # arms: T-pose along X; hanging frame z (down) maps to +-X
    P("arm_r", (40, 16), (4, 12, 4), (-0.41, 0.0, 1.275), (0.07, 0.07, 0.28), R=rotY(90)),
    P("arm_l", (32, 48), (4, 12, 4), (0.41, 0.0, 1.275), (0.07, 0.07, 0.28), R=rotY(-90)),
]

# faces in hanging frame: view dir (camera looks along), up, right axis, depth axis
FACES = {
    "front": (Vector((0, 1, 0)), Vector((0, 0, 1))),
    "back": (Vector((0, -1, 0)), Vector((0, 0, 1))),
    "right": (Vector((1, 0, 0)), Vector((0, 0, 1))),
    "left": (Vector((-1, 0, 0)), Vector((0, 0, 1))),
    "top": (Vector((0, 0, -1)), Vector((0, 1, 0))),
    # rendered from below with front at top, flipped later to the skin convention
    "bottom": (Vector((0, 0, 1)), Vector((0, -1, 0))),
}

def ext(h, axis):
    return abs(axis.x) * h.x + abs(axis.y) * h.y + abs(axis.z) * h.z

def render_face(part, face):
    v_h, u_h = FACES[face]
    r_h = v_h.cross(u_h)
    h = part["h"]
    W = 2 * ext(h, r_h); H = 2 * ext(h, u_h); D = ext(h, v_h)
    R = part["R"]
    v, u = R @ v_h, R @ u_h
    margin = 0.3
    cam.location = part["c"] - v * (D + margin)
    cam.rotation_euler = (v).to_track_quat("-Z", "Y").to_euler()
    # make sure camera up == u
    q = v.to_track_quat("-Z", "Y")
    cur_up = q @ Vector((0, 1, 0))
    m = Matrix((v.cross(u), u, -v)).transposed()
    cam.rotation_euler = m.to_euler()
    cam.data.ortho_scale = max(W, H)
    cam.data.clip_start = margin
    cam.data.clip_end = margin + 2 * D
    w, hh, d = part["size"]
    pw = {"front": w, "back": w, "right": d, "left": d, "top": w, "bottom": w}[face]
    ph = {"front": hh, "back": hh, "right": hh, "left": hh, "top": d, "bottom": d}[face]
    big = SS * max(pw, ph) * 2
    sc.render.resolution_x = max(8, round(big * W / max(W, H)))
    sc.render.resolution_y = max(8, round(big * H / max(W, H)))
    cam.data.sensor_fit = "AUTO"
    path = os.path.join(RAW, f"{part['name']}_{face}.png")
    sc.render.filepath = path
    bpy.ops.render.render(write_still=True)
    im = Image.open(path).convert("RGBA").resize((pw * SS, ph * SS), Image.BOX)
    if face == "bottom":
        im = im.transpose(Image.FLIP_TOP_BOTTOM)
    return im, pw, ph

def downsample(im, pw, ph, overlay, features=False):
    a = np.asarray(im).astype(np.float32) / 255.0
    a = a.reshape(ph, SS, pw, SS, 4)
    alpha = a[..., 3]
    rgb = (a[..., :3] * alpha[..., None]).sum((1, 3))
    asum = alpha.sum((1, 3))
    cov = asum / (SS * SS)
    col = rgb / np.maximum(asum, 1e-6)[..., None]
    if features:
        # keep small dark details (eyes, brows, mouth) that plain averaging washes out
        lum = a[..., :3] @ np.array([0.3, 0.59, 0.11], np.float32)
        for y in range(ph):
            for x in range(pw):
                L = lum[y, :, x, :]; A = alpha[y, :, x, :] > 0.5
                if A.sum() < 8:
                    continue
                med = np.median(L[A])
                dark = A & (L < med - 0.2)
                if dark.sum() > 0.1 * A.sum():
                    col[y, x] = a[y, :, x, :, :3][dark].mean(0)
    out = np.zeros((ph, pw, 4), np.float32)
    out[..., :3] = col
    out[..., 3] = (cov > (0.45 if overlay else 0.02)).astype(np.float32)
    if not overlay:
        # fill holes with nearest filled pixel
        filled = out[..., 3] > 0
        if not filled.any():
            out[..., :3] = 0.5; out[..., 3] = 1
        else:
            ys, xs = np.nonzero(filled)
            for y in range(ph):
                for x in range(pw):
                    if not filled[y, x]:
                        k = np.argmin((ys - y) ** 2 + (xs - x) ** 2)
                        out[y, x, :3] = out[ys[k], xs[k], :3]
            out[..., 3] = 1
    return Image.fromarray((np.clip(out, 0, 1) * 255).round().astype(np.uint8), "RGBA")

skin = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
for part in PARTS:
    if part["overlay"]:
        set_visible((), holdout={m.name for m in bpy.data.materials} - HAIR_MATS - {"HairBack_00_HAIR"})
    else:
        set_visible(part["hide"])
    u0, v0 = part["uv"]; w, hh, d = part["size"]
    pos = {"right": (u0, v0 + d), "front": (u0 + d, v0 + d), "left": (u0 + d + w, v0 + d),
           "back": (u0 + 2 * d + w, v0 + d), "top": (u0 + d, v0), "bottom": (u0 + d + w, v0)}
    for face in FACES:
        im, pw, ph = render_face(part, face)
        feat = part["name"] == "head" and face == "front"
        skin.paste(downsample(im, pw, ph, part["overlay"], feat), pos[face])
skin.save(os.path.join(OUT, "skin.png"))
skin.resize((512, 512), Image.NEAREST).save(os.path.join(OUT, "skin_x8.png"))
print("done")
