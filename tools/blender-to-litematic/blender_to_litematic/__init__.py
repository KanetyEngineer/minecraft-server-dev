"""Blender -> Litematica 変換アドオン

選んだメッシュをブロックに変換し、Litematica の設計図 (.litematic) として書き出す。
3D ビューのサイドバー (N キー) の「Litematic」タブから使う。
"""

bl_info = {
    "name": "Blender to Litematic",
    "author": "kanety",
    "version": (1, 0, 0),
    "blender": (4, 2, 0),
    "location": "3D ビュー > サイドバー > Litematic",
    "description": "メッシュを Minecraft のブロックに変換して .litematic で書き出す",
    "category": "Import-Export",
}

import os
import time

import bpy
import numpy as np
from bpy.props import (BoolProperty, EnumProperty, FloatProperty, IntProperty,
                       PointerProperty, StringProperty)
from bpy_extras.io_utils import ExportHelper, ImportHelper

from . import blender_source, converter, litematic, palette, preview
from .blocks import CATEGORIES

DEFAULT_CATEGORIES = {"concrete", "wool", "terracotta", "wood", "stone", "nature", "mineral"}

_palette_cache = {}


_VERSION_ITEMS = [(k, f"Minecraft {k}", f"Data Version {v}") for k, v in litematic.DATA_VERSIONS.items()]


class LitematicSettings(bpy.types.PropertyGroup):
    selected_only: BoolProperty(
        name="選択中のみ", default=True,
        description="選択しているオブジェクトだけを変換する (オフなら表示中のメッシュすべて)")
    size_mode: EnumProperty(
        name="大きさ", default="FIT",
        items=[("FIT", "ブロック数で指定", "一番長い辺が指定したブロック数になるよう拡大縮小する"),
               ("SCALE", "1 ブロックの大きさで指定", "Blender の何 m を 1 ブロックにするか")])
    fit_blocks: IntProperty(name="長辺のブロック数", default=64, min=1, max=2048)
    block_size: FloatProperty(name="1 ブロック", default=1.0, min=0.001, unit="LENGTH",
                              description="この長さが 1 ブロックになる")
    mc_version: EnumProperty(name="バージョン", items=_VERSION_ITEMS, default=litematic.DEFAULT_MC_VERSION,
                             description="書き出す設計図の Minecraft バージョン")
    color_mode: EnumProperty(
        name="色の決め方", default="MODE",
        items=[("MODE", "最頻", "ブロック内で一番多い色。色の境目がくっきりする"),
               ("AVERAGE", "平均", "ブロック内の色の平均。グラデーションがなめらかになる")])
    fill_interior: BoolProperty(name="中を埋める", default=False,
                                description="閉じた形の内側をブロックで埋める (オフなら外殻だけ)")
    interior_block: StringProperty(name="中身のブロック", default="minecraft:stone")
    allow_light: BoolProperty(name="光るブロックも使う", default=False)
    exclude_blocks: StringProperty(
        name="使わないブロック", default="",
        description="カンマ区切りのブロック ID (例: minecraft:sponge, minecraft:obsidian)")
    texture_source: StringProperty(
        name="色の元", subtype="FILE_PATH", default="",
        description="空なら同梱の色 (26.2 のバニラ)。クライアント jar やリソースパック zip を指定すると、その見た目で色を計算する")
    author: StringProperty(name="作者", default="")
    make_preview: BoolProperty(name="プレビューも作る", default=True,
                               description="書き出し後、変換結果をブロックの形で Blender に表示する")


for _key, _label in CATEGORIES:
    LitematicSettings.__annotations__[f"cat_{_key}"] = BoolProperty(
        name=_label, default=_key in DEFAULT_CATEGORIES)


def _settings(context):
    return context.scene.litematic_settings


def _target_objects(context, s):
    if s.selected_only:
        objs = context.selected_objects
    else:
        objs = [o for o in context.visible_objects]
    return [o for o in objs if o.type in {"MESH", "CURVE", "SURFACE", "META", "FONT"}]


def _colors(s):
    path = bpy.path.abspath(s.texture_source) if s.texture_source else ""
    if not path:
        return palette.load_builtin()
    key = (path, os.path.getmtime(path))
    if key not in _palette_cache:
        colors, _missing = palette.compute_from_textures(path)
        # jar に無いブロック (古いバージョンなど) は同梱の色で補う
        merged = palette.load_builtin()
        merged.update(colors)
        _palette_cache.clear()
        _palette_cache[key] = merged
    return _palette_cache[key]


def _matcher(s, colors):
    cats = {k for k, _ in CATEGORIES if getattr(s, f"cat_{k}")}
    exclude = [b.strip() if ":" in b else "minecraft:" + b.strip()
               for b in s.exclude_blocks.split(",") if b.strip()]
    ids = palette.select_blocks(colors, categories=cats, allow_gravity="gravity" in cats,
                                allow_light=s.allow_light, allow_glass="glass" in cats,
                                exclude=exclude)
    return palette.Matcher(colors, ids)


def estimate_dims(objs, s):
    """オブジェクトの外接箱から、変換後のおおよそのブロック数を出す"""
    pts = []
    for o in objs:
        mw = np.array(o.matrix_world)
        bb = np.array([list(c) for c in o.bound_box])
        pts.append(bb @ mw[:3, :3].T + mw[:3, 3])
    if not pts:
        return None
    pts = np.concatenate(pts) @ blender_source.AXIS.T
    ext = pts.max(axis=0) - pts.min(axis=0)
    if s.size_mode == "FIT":
        scale = s.fit_blocks / max(float(ext.max()), 1e-9)
    else:
        scale = 1.0 / s.block_size
    return tuple(max(1, int(np.ceil(v * scale - 1e-7))) for v in ext)


class LITEMATIC_OT_export(bpy.types.Operator, ExportHelper):
    """選んだメッシュをブロックに変換して .litematic に書き出す"""
    bl_idname = "litematic.export"
    bl_label = "Litematic に書き出す"
    bl_options = {"REGISTER"}

    filename_ext = ".litematic"
    filter_glob: StringProperty(default="*.litematic", options={"HIDDEN"})

    def invoke(self, context, event):
        objs = _target_objects(context, _settings(context))
        if not self.filepath:
            base = objs[0].name if objs else "model"
            blend_dir = os.path.dirname(bpy.data.filepath) if bpy.data.filepath else os.path.expanduser("~")
            self.filepath = os.path.join(blend_dir, bpy.path.clean_name(base) + self.filename_ext)
        return ExportHelper.invoke(self, context, event)

    def execute(self, context):
        s = _settings(context)
        objs = _target_objects(context, s)
        if not objs:
            self.report({"ERROR"}, "変換するメッシュがありません。オブジェクトを選択してください。")
            return {"CANCELLED"}
        t0 = time.time()
        try:
            colors = _colors(s)
            matcher = _matcher(s, colors)
            blender_source.clear_cache()
            parts = blender_source.collect(objs, context.evaluated_depsgraph_get())
            if not parts:
                self.report({"ERROR"}, "面のあるメッシュがありません。")
                return {"CANCELLED"}
            tris, color_fn, block_m, origin = blender_source.to_voxel_space(
                parts, s.size_mode, s.block_size, s.fit_blocks)
            dims = converter.grid_dims(tris)
            if max(dims) > 2048:
                self.report({"ERROR"}, f"大きすぎます ({dims[0]}×{dims[1]}×{dims[2]})。大きさの設定を見直してください。")
                return {"CANCELLED"}
            name = os.path.splitext(os.path.basename(self.filepath))[0]
            opts = converter.Options(
                color_mode=s.color_mode,
                fill_interior=s.fill_interior,
                interior_block=s.interior_block,
                data_version=litematic.DATA_VERSIONS[s.mc_version],
                name=name, author=s.author,
                description=f"Blender から変換 ({', '.join(o.name for o in objs)[:200]})",
            )
            wm = context.window_manager
            wm.progress_begin(0, 100)
            step = [0]

            def tick():
                step[0] += 1
                wm.progress_update(step[0] % 100)
            try:
                result = converter.convert(tris, color_fn, matcher, self.filepath, opts, tick)
            finally:
                wm.progress_end()
        except Exception as e:  # noqa: BLE001 - ユーザーに理由を見せる
            self.report({"ERROR"}, f"変換に失敗しました: {e}")
            import traceback
            traceback.print_exc()
            return {"CANCELLED"}
        finally:
            blender_source.clear_cache()

        if s.make_preview:
            grid, names, _root = litematic.read(self.filepath)
            # 元のモデルの右隣 (+X) に、少し間をあけて置く
            loc = origin @ blender_source.AXIS
            loc[0] += (grid.shape[0] + 2) * block_m
            preview.create_preview_object(context, grid, names, f"{name} (プレビュー)",
                                          colors, block_m, location=tuple(loc))
        top = sorted(result.block_counts.items(), key=lambda kv: -kv[1])[:5]
        top_text = "、".join(f"{k.split(':')[-1]} {v}" for k, v in top)
        self.report({"INFO"},
                    f"{result.dims[0]}×{result.dims[1]}×{result.dims[2]}、{result.total_blocks} ブロック "
                    f"({time.time() - t0:.1f} 秒) 多い順: {top_text}")
        return {"FINISHED"}


class LITEMATIC_OT_import_preview(bpy.types.Operator, ImportHelper):
    """.litematic を読み込んで、色付きブロックとして表示する (確認用)"""
    bl_idname = "litematic.import_preview"
    bl_label = "Litematic をプレビュー表示"

    filename_ext = ".litematic"
    filter_glob: StringProperty(default="*.litematic", options={"HIDDEN"})

    def execute(self, context):
        s = _settings(context)
        grid, names, _root = litematic.read(self.filepath)
        name = os.path.splitext(os.path.basename(self.filepath))[0]
        preview.create_preview_object(context, grid, names, f"{name} (プレビュー)", _colors(s))
        self.report({"INFO"}, f"{grid.shape[0]}×{grid.shape[1]}×{grid.shape[2]} を読み込みました")
        return {"FINISHED"}


class LITEMATIC_PT_panel(bpy.types.Panel):
    bl_label = "Litematic 変換"
    bl_space_type = "VIEW_3D"
    bl_region_type = "UI"
    bl_category = "Litematic"

    def draw(self, context):
        s = _settings(context)
        layout = self.layout

        col = layout.column(align=True)
        col.prop(s, "selected_only")
        col.prop(s, "size_mode", text="")
        if s.size_mode == "FIT":
            col.prop(s, "fit_blocks")
        else:
            col.prop(s, "block_size")
        objs = _target_objects(context, s)
        dims = estimate_dims(objs, s)
        if dims:
            layout.label(text=f"およそ 幅{dims[0]} × 高さ{dims[1]} × 奥行{dims[2]}", icon="MESH_CUBE")
        else:
            layout.label(text="メッシュを選択してください", icon="INFO")

        box = layout.box()
        box.label(text="ブロックの種類")
        grid = box.grid_flow(columns=2, align=True)
        for key, _label in CATEGORIES:
            grid.prop(s, f"cat_{key}")
        box.prop(s, "allow_light")
        box.prop(s, "exclude_blocks", text="除外")
        box.prop(s, "texture_source")

        col = layout.column()
        col.prop(s, "color_mode")
        col.prop(s, "fill_interior")
        if s.fill_interior:
            col.prop(s, "interior_block")
        col.prop(s, "mc_version")
        col.prop(s, "author")
        col.prop(s, "make_preview")

        layout.operator(LITEMATIC_OT_export.bl_idname, icon="EXPORT")
        layout.operator(LITEMATIC_OT_import_preview.bl_idname, icon="IMPORT")


def _menu_export(self, context):
    self.layout.operator(LITEMATIC_OT_export.bl_idname, text="Litematica (.litematic)")


_classes = (LitematicSettings, LITEMATIC_OT_export, LITEMATIC_OT_import_preview, LITEMATIC_PT_panel)


def register():
    for cls in _classes:
        bpy.utils.register_class(cls)
    bpy.types.Scene.litematic_settings = PointerProperty(type=LitematicSettings)
    bpy.types.TOPBAR_MT_file_export.append(_menu_export)


def unregister():
    bpy.types.TOPBAR_MT_file_export.remove(_menu_export)
    del bpy.types.Scene.litematic_settings
    for cls in reversed(_classes):
        bpy.utils.unregister_class(cls)
