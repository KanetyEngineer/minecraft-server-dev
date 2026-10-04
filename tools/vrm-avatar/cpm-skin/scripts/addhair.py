import bpy, sys, json, zipfile
from mathutils import Vector
BLEND, PROJ, OUT = sys.argv[-3], sys.argv[-2], sys.argv[-1]
bpy.ops.wm.open_mainfile(filepath=BLEND)
S = 1/16
cfg = json.loads(zipfile.ZipFile(PROJ).read("config.json"))
rig = bpy.data.objects["MinatoRig"]
bone_of = {"head": "Head", "body": "Body"}
for el in cfg["elements"]:
    for c in el.get("children", []):
        o, sz = c["offset"], c["size"]
        x0, x1 = o["x"], o["x"] + sz["x"]
        y0, y1 = o["z"], o["z"] + sz["z"]
        z0, z1 = 24 - (o["y"] + sz["y"]), 24 - o["y"]
        bpy.ops.mesh.primitive_cube_add(size=1)
        ob = bpy.context.active_object; ob.name = c["name"]
        ob.scale = ((x1-x0)*S, (y1-y0)*S, (z1-z0)*S)
        ob.location = ((x0+x1)/2*S, (y0+y1)/2*S, (z0+z1)/2*S)
        m = bpy.data.materials.new(c["name"]); col = int(c["color"], 16)
        m.use_nodes = True
        bs = m.node_tree.nodes["Principled BSDF"]
        bs.inputs["Base Color"].default_value = tuple(((col >> s) & 255)/255 for s in (16, 8, 0)) + (1,)
        bs.inputs["Roughness"].default_value = 1
        ob.data.materials.append(m)
        bpy.context.view_layer.update()
        mw = ob.matrix_world.copy()
        ob.parent = rig; ob.parent_type = "BONE"; ob.parent_bone = bone_of[el["id"]]
        ob.matrix_world = mw
bpy.ops.wm.save_as_mainfile(filepath=OUT)
