"""Render the generated item models the way the datapack places them (preview only)."""
import bpy, json, sys, os, math
from mathutils import Vector, Matrix, Euler

MODELS, PARTS, PAL, OUT = sys.argv[-4:]
os.makedirs(OUT, exist_ok=True)
models = json.load(open(MODELS)); parts = json.load(open(PARTS))["parts"]
bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene
img = bpy.data.images.load(PAL)
mat = bpy.data.materials.new("pal"); mat.use_nodes = True
nt = mat.node_tree; bs = nt.nodes["Principled BSDF"]
tx = nt.nodes.new("ShaderNodeTexImage"); tx.image = img; tx.interpolation = "Closest"
nt.links.new(tx.outputs[0], bs.inputs["Base Color"]); bs.inputs["Roughness"].default_value = 1

FACEN = {"east": 0, "west": 0, "up": 1, "down": 1, "south": 2, "north": 2}
objs = {}
for part, m in models.items():
    verts, faces, uvs = [], [], []
    for e in m["elements"]:
        (fname, fd), = e["faces"].items()
        a = FACEN[fname]; lo, hi = e["from"], e["to"]
        oa = [i for i in range(3) if i != a]
        c = []
        for du, dv in ((0, 0), (1, 0), (1, 1), (0, 1)):
            p = [0, 0, 0]; p[a] = lo[a]
            p[oa[0]] = hi[oa[0]] if du else lo[oa[0]]
            p[oa[1]] = hi[oa[1]] if dv else lo[oa[1]]
            # MC model -> blender local (pivot at origin)
            c.append(((p[0] - 8) / 16, -(p[2] - 8) / 16, (p[1] - 8) / 16))
        b = len(verts); verts += c; faces.append([b, b + 1, b + 2, b + 3])
        u0, v0, u1, v1 = fd["uv"]
        uv = ((u0 + u1) / 32, 1 - (v0 + v1) / 32)
        uvs.append([uv] * 4)
    me = bpy.data.meshes.new(part); me.from_pydata(verts, [], faces); me.update()
    ul = me.uv_layers.new()
    for poly, u in zip(me.polygons, uvs):
        for li, t in zip(poly.loop_indices, u):
            ul.data[li].uv = t
    me.materials.append(mat)
    ob = bpy.data.objects.new(part, me); sc.collection.objects.link(ob)
    piv = Vector(parts[part]["pivot"])
    if part.startswith("arm"):
        piv = piv + Vector((0, 0, 0))
    ob.location = piv
    objs[part] = ob

sc.render.engine = "CYCLES"; sc.cycles.device = "CPU"; sc.cycles.samples = 16
sc.render.resolution_x, sc.render.resolution_y = 600, 800
sc.view_settings.view_transform = "Standard"
sc.world = bpy.data.worlds.new("W"); sc.world.use_nodes = True
sc.world.node_tree.nodes["Background"].inputs[0].default_value = (0.85, 0.88, 0.92, 1)
sun = bpy.data.objects.new("Sun", bpy.data.lights.new("Sun", "SUN")); sun.data.energy = 2.5
sun.rotation_euler = Euler((math.radians(50), 0, math.radians(-30))); sc.collection.objects.link(sun)
cam = bpy.data.objects.new("Cam", bpy.data.cameras.new("Cam")); cam.data.type = "ORTHO"
cam.data.ortho_scale = 2.0; sc.collection.objects.link(cam); sc.camera = cam
target = Vector((0, 0, 0.85))

def shot(name, yaw, pitch=8):
    d = 6; y, p = math.radians(yaw), math.radians(pitch)
    cam.location = target + Vector((math.sin(y) * math.cos(p) * d, -math.cos(y) * math.cos(p) * d, math.sin(p) * d))
    cam.rotation_euler = (target - cam.location).to_track_quat("-Z", "Y").to_euler()
    sc.render.filepath = os.path.join(OUT, name); bpy.ops.render.render(write_still=True)

shot("front.png", 0); shot("back.png", 180); shot("side.png", -35, 15)
# walking pose: swing about the pivots (X axis), turn head
objs["arm_r"].rotation_euler = (math.radians(-35), 0, 0)
objs["arm_l"].rotation_euler = (math.radians(35), 0, 0)
objs["leg_r"].rotation_euler = (math.radians(30), 0, 0)
objs["leg_l"].rotation_euler = (math.radians(-30), 0, 0)
objs["head"].rotation_euler = (math.radians(-10), 0, math.radians(25))
shot("walk.png", -30, 12)
