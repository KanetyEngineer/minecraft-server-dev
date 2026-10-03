import bpy, math, os, sys
sys.path.insert(0, "/home/claude/minecraft-server-dev/tools/blender-to-litematic")
from blender_to_litematic import litematic, preview, palette
sys.path.insert(0, os.path.dirname(__file__)); import evaluate as E
model, size, outpng = sys.argv[1], int(sys.argv[2]), sys.argv[3]
D = os.path.join(os.path.dirname(__file__), "out")
bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene
colors = {}
for i, f in enumerate([f"mine_{model}_{size}", f"o2s_{model}_{size}_ray-based"]):
    g, p, _ = litematic.read(os.path.join(D, f + ".litematic"))
    cols = {litematic.parse_block_state(n)["Name"]: E.block_color(n) for n in p if n != "minecraft:air"}
    preview.create_preview_object(bpy.context, g, p, f, cols, 1.0, location=(i * (g.shape[0] + 10), 0, 0))
sc.render.engine = "CYCLES"; sc.cycles.device = "CPU"; sc.cycles.samples = 16
w = bpy.data.worlds.new("w"); sc.world = w; w.color = (0.9, 0.9, 0.9)
sun = bpy.data.objects.new("sun", bpy.data.lights.new("sun", "SUN")); sc.collection.objects.link(sun)
sun.rotation_euler = (math.radians(45), math.radians(15), math.radians(35)); sun.data.energy = 3
sc.render.resolution_x, sc.render.resolution_y = 1600, 700
cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam")); sc.collection.objects.link(cam); sc.camera = cam
cam.data.type = "ORTHO"
bpy.context.view_layer.update()
objs = [o for o in sc.objects if o.type == "MESH"]
import numpy as np
from mathutils import Vector
pts = np.array([list(o.matrix_world @ Vector(c)) for o in objs for c in o.bound_box])
lo, hi = pts.min(0), pts.max(0); ctr = (lo + hi) / 2
print("bbox", lo, hi, len(objs))
cam.data.ortho_scale = (hi[0] - lo[0]) * 1.08; cam.data.clip_end = 1e6
d = 5 * (hi - lo).max()
cam.location = (ctr[0], ctr[1] - d * math.cos(math.radians(35)), ctr[2] + d * math.sin(math.radians(35)))
cam.rotation_euler = (math.radians(55), 0, 0)
sc.render.filepath = outpng
bpy.ops.render.render(write_still=True)
