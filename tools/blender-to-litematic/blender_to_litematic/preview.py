"""変換結果 (.litematic) を Blender 上に色付きブロックとして表示する。

見えている面だけをメッシュにするので、大きな建物でも軽い。
"""

import bpy
import numpy as np

from . import blender_source, litematic, palette

ATTR = "block_color"

# (方向, 面の 4 頂点のオフセット) Minecraft 座標
_FACES = [
    ((1, 0, 0), [(1, 0, 0), (1, 1, 0), (1, 1, 1), (1, 0, 1)]),
    ((-1, 0, 0), [(0, 0, 0), (0, 0, 1), (0, 1, 1), (0, 1, 0)]),
    ((0, 1, 0), [(0, 1, 0), (0, 1, 1), (1, 1, 1), (1, 1, 0)]),
    ((0, -1, 0), [(0, 0, 0), (1, 0, 0), (1, 0, 1), (0, 0, 1)]),
    ((0, 0, 1), [(0, 0, 1), (1, 0, 1), (1, 1, 1), (0, 1, 1)]),
    ((0, 0, -1), [(0, 0, 0), (0, 1, 0), (1, 1, 0), (1, 0, 0)]),
]


def build_faces(grid):
    """grid (X, Y, Z) -> (quad の頂点 (F, 4, 3), 各面のブロック番号 (F,))"""
    solid = grid > 0
    padded = np.pad(solid, 1)
    quads, ids = [], []
    for (dx, dy, dz), corners in _FACES:
        neighbor = padded[1 + dx:padded.shape[0] - 1 + dx,
                          1 + dy:padded.shape[1] - 1 + dy,
                          1 + dz:padded.shape[2] - 1 + dz]
        exposed = solid & ~neighbor
        pos = np.argwhere(exposed)
        if len(pos) == 0:
            continue
        quads.append(pos[:, None, :] + np.array(corners)[None, :, :])
        ids.append(grid[exposed])
    if not quads:
        return np.zeros((0, 4, 3)), np.zeros(0, dtype=np.int64)
    return np.concatenate(quads).astype(np.float64), np.concatenate(ids)


def _block_rgb(names, colors):
    out = np.zeros((len(names), 4))
    out[:, 3] = 1.0
    for i, n in enumerate(names):
        base = litematic.parse_block_state(n)["Name"]
        rgb = colors.get(base, (150, 150, 150))
        out[i, :3] = np.asarray(rgb) / 255.0
    return out


def create_preview_object(context, grid, names, name, colors=None, block_size=1.0, location=(0, 0, 0)):
    colors = colors or palette.load_builtin()
    quads, ids = build_faces(np.asarray(grid))
    # Minecraft -> Blender の向きに戻す (MC z = -Blender y)
    verts = quads.reshape(-1, 3) @ blender_source.AXIS * block_size
    nf = len(quads)
    mesh = bpy.data.meshes.new(name)
    mesh.vertices.add(len(verts))
    mesh.vertices.foreach_set("co", verts.astype(np.float32).reshape(-1))
    mesh.loops.add(nf * 4)
    mesh.loops.foreach_set("vertex_index", np.arange(nf * 4, dtype=np.int32))
    mesh.polygons.add(nf)
    mesh.polygons.foreach_set("loop_start", (np.arange(nf) * 4).astype(np.int32))
    mesh.polygons.foreach_set("loop_total", np.full(nf, 4, dtype=np.int32))
    mesh.update()
    mesh.validate()

    rgba = _block_rgb(names, colors)
    corner = np.repeat(rgba[ids], 4, axis=0)
    attr = mesh.color_attributes.new(ATTR, "BYTE_COLOR", "CORNER")
    attr.data.foreach_set("color_srgb", corner.astype(np.float32).reshape(-1))
    mesh.color_attributes.active_color = attr
    mesh.color_attributes.render_color_index = mesh.color_attributes.active_color_index

    mat = _preview_material()
    mesh.materials.append(mat)
    obj = bpy.data.objects.new(name, mesh)
    obj.location = location
    context.collection.objects.link(obj)
    return obj


def _preview_material():
    mat = bpy.data.materials.get("Litematic Preview")
    if mat is not None:
        return mat
    mat = bpy.data.materials.new("Litematic Preview")
    if hasattr(mat, "use_nodes"):
        mat.use_nodes = True
    nt = mat.node_tree
    bsdf = next(n for n in nt.nodes if n.type == "BSDF_PRINCIPLED")
    attr = nt.nodes.new("ShaderNodeAttribute")
    attr.attribute_name = ATTR
    attr.location = (-300, 300)
    nt.links.new(attr.outputs["Color"], bsdf.inputs["Base Color"])
    return mat
