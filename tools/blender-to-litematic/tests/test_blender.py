"""bpy (pip の Blender モジュール) でアドオン全体を動かすテスト。"""
import os, sys, tempfile
import numpy as np
import bpy

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import blender_to_litematic as addon
from blender_to_litematic import litematic

addon.register()
out_dir = tempfile.mkdtemp()


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    if not hasattr(bpy.context.scene, "litematic_settings"):
        pass


def select_only(objs):
    for o in bpy.context.view_layer.objects:
        o.select_set(o in objs)
    bpy.context.view_layer.objects.active = objs[0]


def test_image_texture():
    reset()
    bpy.ops.mesh.primitive_uv_sphere_add(radius=1, segments=64, ring_count=32)
    sph = bpy.context.active_object
    img = bpy.data.images.new("tex", 64, 64, alpha=True)
    px = np.zeros((64, 64, 4), dtype=np.float32); px[..., 3] = 1
    px[:, :32, 0] = 0.8   # u < 0.5 -> 赤
    px[:, 32:, 2] = 0.8   # u >= 0.5 -> 青
    img.pixels.foreach_set(px.reshape(-1))
    mat = bpy.data.materials.new("m")
    if hasattr(mat, "use_nodes"):
        mat.use_nodes = True
    nt = mat.node_tree
    bsdf = next(n for n in nt.nodes if n.type == "BSDF_PRINCIPLED")
    tex = nt.nodes.new("ShaderNodeTexImage"); tex.image = img
    nt.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
    sph.data.materials.append(mat)
    select_only([sph])
    s = bpy.context.scene.litematic_settings
    s.fit_blocks = 32
    s.cat_wool = s.cat_terracotta = s.cat_wood = s.cat_stone = s.cat_nature = s.cat_mineral = False
    path = os.path.join(out_dir, "sphere.litematic")
    assert bpy.ops.litematic.export(filepath=path) == {"FINISHED"}
    grid, pal, root = litematic.read(path)
    print("sphere", grid.shape, pal)
    assert set(pal) == {"minecraft:air", "minecraft:red_concrete", "minecraft:blue_concrete"}, pal
    # UV 球の u は経度。u<0.5 は Blender の -Y 側 ... どちらか半分が赤、残りが青になっていれば良い
    assert grid.shape == (32, 32, 32)
    prev = [o for o in bpy.data.objects if o.name.endswith("(プレビュー)")]
    assert prev and len(prev[0].data.polygons) > 0
    print("preview faces", len(prev[0].data.polygons))


def test_vertex_color_and_fill():
    reset()
    bpy.ops.mesh.primitive_cube_add(size=2)
    cube = bpy.context.active_object
    me = cube.data
    attr = me.color_attributes.new("Col", "BYTE_COLOR", "POINT")
    cols = np.zeros((len(me.vertices), 4), dtype=np.float32); cols[:, 3] = 1
    z = np.array([v.co.z for v in me.vertices])
    cols[z > 0] = (1, 1, 0, 1)  # 上の頂点は黄
    cols[z < 0] = (0, 0.5, 0, 1)  # 下は緑
    attr.data.foreach_set("color_srgb", cols.reshape(-1))
    mat = bpy.data.materials.new("vc")
    if hasattr(mat, "use_nodes"):
        mat.use_nodes = True
    nt = mat.node_tree
    bsdf = next(n for n in nt.nodes if n.type == "BSDF_PRINCIPLED")
    vc = nt.nodes.new("ShaderNodeVertexColor"); vc.layer_name = "Col"
    nt.links.new(vc.outputs["Color"], bsdf.inputs["Base Color"])
    me.materials.append(mat)
    # 2 つ目: マテリアルの色だけのモンキー
    bpy.ops.mesh.primitive_monkey_add(location=(4, 0, 0))
    monkey = bpy.context.active_object
    m2 = bpy.data.materials.new("plain")
    if hasattr(m2, "use_nodes"):
        m2.use_nodes = True
    b2 = next(n for n in m2.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    b2.inputs["Base Color"].default_value = (0.0, 0.0, 0.0, 1)
    monkey.data.materials.append(m2)
    select_only([cube, monkey])
    s = bpy.context.scene.litematic_settings
    s.size_mode = "SCALE"; s.block_size = 0.25; s.fill_interior = True; s.make_preview = False
    path = os.path.join(out_dir, "cube.litematic")
    assert bpy.ops.litematic.export(filepath=path) == {"FINISHED"}
    grid, pal, root = litematic.read(path)
    pal = np.array(pal)
    print("cube+monkey", grid.shape, sorted(set(pal)))
    # 立方体は x 0..7 (2m / 0.25)。中心は stone で埋まる
    assert pal[grid[4, 4, 4]] == "minecraft:stone"
    top = set(pal[grid[1:7, 7, 1:7]].ravel()); bottom = set(pal[grid[1:7, 0, 1:7]].ravel())
    print("top", top, "bottom", bottom)
    assert top <= {"minecraft:yellow_concrete", "minecraft:yellow_wool", "minecraft:gold_block"}, top
    assert all("green" in b for b in bottom), bottom
    assert grid.shape[1] == 8
    monkey_blocks = set(pal[grid[12:, :, :][grid[12:, :, :] > 0]])
    print("monkey", monkey_blocks)
    assert monkey_blocks & {"minecraft:black_concrete", "minecraft:black_wool", "minecraft:coal_block", "minecraft:stone"}
    assert root["MinecraftDataVersion"].value == 4903


def test_preview_import():
    reset()
    path = os.path.join(out_dir, "cube.litematic")
    assert bpy.ops.litematic.import_preview(filepath=path) == {"FINISHED"}
    o = bpy.data.objects[0]
    print("import preview", o.name, len(o.data.polygons))


for k, f in list(globals().items()):
    if k.startswith("test_"):
        f(); print("ok", k)
