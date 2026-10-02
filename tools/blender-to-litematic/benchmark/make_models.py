import bpy, math, os, numpy as np
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "models")
O2S = os.path.join(os.path.dirname(OUT), "..", "o2s", "res", "samples")

def clear():
    bpy.ops.wm.read_factory_settings(use_empty=True)

def textured_mat(img):
    m = bpy.data.materials.new("mat"); nt = m.node_tree
    bsdf = next(n for n in nt.nodes if n.type == "BSDF_PRINCIPLED")
    t = nt.nodes.new("ShaderNodeTexImage"); t.image = img
    nt.links.new(t.outputs["Color"], bsdf.inputs["Base Color"])
    return m

def export(name):
    bpy.ops.object.select_all(action="SELECT")
    bpy.context.view_layer.objects.active = bpy.context.selected_objects[0]
    # ObjToSchematic はノードの移動・回転を読まないので、頂点に焼き込んでおく
    bpy.ops.object.convert(target="MESH")
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    bpy.ops.export_scene.gltf(filepath=os.path.join(OUT, name + ".glb"), export_format="GLB",
                              export_apply=True, export_yup=True)

# 1. skull (ObjToSchematic のサンプル)
clear()
bpy.ops.wm.obj_import(filepath=os.path.abspath(os.path.join(O2S, "skull.obj")))
img = bpy.data.images.load(os.path.abspath(os.path.join(O2S, "skull.jpg")))
for o in bpy.context.scene.objects:
    o.data.materials.clear(); o.data.materials.append(textured_mat(img))
export("skull")

# 2. 細い部品と斜めの面: スザンヌ + 細い棒 + 45度の板、カラフルなテクスチャ
clear()
W = 256
u, v = np.meshgrid(np.arange(W) / W, np.arange(W) / W)
import colorsys
hue = (u * 6).astype(int) / 6.0
rgb = np.array([colorsys.hsv_to_rgb(h, 0.85, 0.95) for h in hue.ravel()]).reshape(W, W, 3)
rgb[(v * 8).astype(int) % 2 == 1] *= 0.45
px = np.concatenate([rgb, np.ones((W, W, 1))], axis=2).astype(np.float32)
img = bpy.data.images.new("stripes", W, W); img.pixels.foreach_set(px.ravel())
img.filepath_raw = os.path.join(OUT, "stripes.png"); img.file_format = "PNG"; img.save()
mat = textured_mat(img)
bpy.ops.mesh.primitive_monkey_add(location=(0, 0, 1.0))
m = bpy.context.active_object
mod = m.modifiers.new("s", "SUBSURF"); mod.levels = 2
bpy.ops.mesh.primitive_cylinder_add(radius=0.012, depth=2.0, location=(1.5, 0, 1.0), vertices=12)
bpy.ops.mesh.primitive_plane_add(size=1.4, location=(-1.6, 0, 1.0), rotation=(0, math.radians(45), math.radians(30)))
bpy.ops.mesh.primitive_plane_add(size=4.5, location=(0, 0, 0))
for o in bpy.context.scene.objects:
    if o.type == "MESH":
        if not o.data.uv_layers:
            o.data.uv_layers.new()
        o.data.materials.append(mat)
export("scene")
print("models:", os.listdir(OUT))
