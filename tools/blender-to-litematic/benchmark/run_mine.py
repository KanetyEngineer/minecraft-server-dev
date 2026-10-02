"""アドオンで各モデルを各サイズに変換し、時間を記録する。"""
import json, os, sys, time
import bpy
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, "/home/claude/minecraft-server-dev/tools/blender-to-litematic")
import blender_to_litematic as addon
addon.register()
OUT = os.path.join(HERE, "out")

for model in ("skull", "scene"):
    for size in (64, 128, 256):
        bpy.ops.wm.read_factory_settings(use_empty=True)
        t0 = time.perf_counter()
        bpy.ops.import_scene.gltf(filepath=os.path.join(HERE, "models", model + ".glb"))
        t_import = time.perf_counter() - t0
        objs = [o for o in bpy.context.scene.objects if o.type == "MESH"]
        for o in bpy.context.scene.objects:
            o.select_set(o in objs)
        zs = []
        for o in objs:
            for c in o.bound_box:
                zs.append((o.matrix_world @ __import__("mathutils").Vector(c)).z)
        height = max(zs) - min(zs)
        s = bpy.context.scene.litematic_settings
        s.size_mode = "SCALE"; s.block_size = height / size; s.make_preview = False
        path = os.path.join(OUT, f"mine_{model}_{size}.litematic")
        t0 = time.perf_counter()
        assert bpy.ops.litematic.export(filepath=path) == {"FINISHED"}
        t_conv = time.perf_counter() - t0
        rec = {"times_ms": {"import": t_import * 1000, "convert": t_conv * 1000}, "block_size": height / size}
        json.dump(rec, open(path.replace(".litematic", ".json"), "w"))
        print(model, size, rec)
