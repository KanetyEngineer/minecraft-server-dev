"""Preview tri_models.json: rebuild every element as Minecraft would (rotation x->y->z about origin)."""
import bpy, json, sys, os, math
from mathutils import Vector, Matrix, Euler

MODELS, ATLAS, OUT = sys.argv[-3:]
os.makedirs(OUT, exist_ok=True)
data = json.load(open(MODELS))
bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene
img = bpy.data.images.load(ATLAS)
mat = bpy.data.materials.new("atlas"); mat.use_nodes = True
nt = mat.node_tree; bs = nt.nodes["Principled BSDF"]
tx = nt.nodes.new("ShaderNodeTexImage"); tx.image = img; tx.interpolation = "Closest"
nt.links.new(tx.outputs[0], bs.inputs["Base Color"])
gt = nt.nodes.new("ShaderNodeMath"); gt.operation = "GREATER_THAN"; gt.inputs[1].default_value = 0.5
nt.links.new(tx.outputs[1], gt.inputs[0]); nt.links.new(gt.outputs[0], bs.inputs["Alpha"])
bs.inputs["Roughness"].default_value = 1
# shade:false -> flat unlit colour; back faces culled like Minecraft
em = nt.nodes.new("ShaderNodeEmission"); nt.links.new(tx.outputs[0], em.inputs[0])
trn = nt.nodes.new("ShaderNodeBsdfTransparent"); geo = nt.nodes.new("ShaderNodeNewGeometry")
mx1 = nt.nodes.new("ShaderNodeMixShader"); nt.links.new(gt.outputs[0], mx1.inputs[0]); nt.links.new(trn.outputs[0], mx1.inputs[1]); nt.links.new(em.outputs[0], mx1.inputs[2])
mx2 = nt.nodes.new("ShaderNodeMixShader"); nt.links.new(geo.outputs["Backfacing"], mx2.inputs[0]); nt.links.new(mx1.outputs[0], mx2.inputs[1]); nt.links.new(trn.outputs[0], mx2.inputs[2])
nt.links.new(mx2.outputs[0], nt.nodes["Material Output"].inputs[0])

def mc2b(p):
    return Vector(((p[0] - 8) / 16, -(p[2] - 8) / 16, (p[1] - 8) / 16))

objs = {}
for part, m in data["models"].items():
    verts, faces, uvs = [], [], []
    for e in m["elements"]:
        f, t, r = Vector(e["from"]), Vector(e["to"]), e["rotation"]
        o = Vector(r["origin"])
        R = Euler((math.radians(r["x"]), math.radians(r["y"]), math.radians(r["z"])), "XYZ").to_matrix()
        # flat in local XY (z = from.z): corners bl, br, tr, tl seen from +Z (south)
        cs = [Vector((f.x, f.y, f.z)), Vector((t.x, f.y, f.z)), Vector((t.x, t.y, f.z)), Vector((f.x, t.y, f.z))]
        cs = [o + R @ (c - o) for c in cs]
        for fname, fd in e["faces"].items():
            u0, v0, u1, v1 = fd["uv"]
            quv = [(u0, v1), (u1, v1), (u1, v0), (u0, v0)]  # bl, br, tr, tl
            idx = [0, 1, 2, 3]
            if fname == "north":
                idx = [1, 0, 3, 2]  # seen from the back; uv already mirrored
            b = len(verts)
            verts += [mc2b(cs[k]) for k in idx]
            faces.append([b, b + 1, b + 2, b + 3])
            uvs.append([(u / 16, 1 - v / 16) for u, v in quv])
    me = bpy.data.meshes.new(part); me.from_pydata([tuple(v) for v in verts], [], faces); me.update()
    ul = me.uv_layers.new()
    for poly, u in zip(me.polygons, uvs):
        for li, tt in zip(poly.loop_indices, u):
            ul.data[li].uv = tt
    me.materials.append(mat)
    ob = bpy.data.objects.new(part, me); sc.collection.objects.link(ob)
    ob.location = Vector(data["pivots"][part])
    objs[part] = ob

sc.render.engine = "CYCLES"; sc.cycles.device = "CPU"; sc.cycles.samples = 24
sc.render.resolution_x, sc.render.resolution_y = 600, 800
sc.view_settings.view_transform = "Standard"
sc.world = bpy.data.worlds.new("W"); sc.world.use_nodes = True
sc.world.node_tree.nodes["Background"].inputs[0].default_value = (0.85, 0.88, 0.92, 1)
sun = bpy.data.objects.new("Sun", bpy.data.lights.new("Sun", "SUN")); sun.data.energy = 2.5
sun.rotation_euler = Euler((math.radians(50), 0, math.radians(-30))); sc.collection.objects.link(sun)
cam = bpy.data.objects.new("Cam", bpy.data.cameras.new("Cam")); cam.data.type = "ORTHO"
sc.collection.objects.link(cam); sc.camera = cam

def shot(name, yaw, pitch=8, target=(0, 0, 0.85), scale=2.0):
    target = Vector(target); cam.data.ortho_scale = scale
    d = 6; y, p = math.radians(yaw), math.radians(pitch)
    cam.location = target + Vector((math.sin(y) * math.cos(p) * d, -math.cos(y) * math.cos(p) * d, math.sin(p) * d))
    cam.rotation_euler = (target - cam.location).to_track_quat("-Z", "Y").to_euler()
    sc.render.filepath = os.path.join(OUT, name); bpy.ops.render.render(write_still=True)

shot("front.png", 0); shot("back.png", 180); shot("side.png", -35, 15)
shot("face.png", 0, 0, (0, 0, 1.47), 0.45)
objs["arm_r"].rotation_euler = (math.radians(-35), 0, 0)
objs["arm_l"].rotation_euler = (math.radians(35), 0, 0)
objs["leg_r"].rotation_euler = (math.radians(30), 0, 0)
objs["leg_l"].rotation_euler = (math.radians(-30), 0, 0)
objs["head"].rotation_euler = (math.radians(-10), 0, math.radians(25))
shot("walk.png", -30, 12)
