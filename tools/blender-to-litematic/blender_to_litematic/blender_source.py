"""Blender のオブジェクトから、三角形と色の取り方を取り出す。

色の決め方 (マテリアルごと、上から順に):
  1. ベースカラーに画像テクスチャがつながっていれば、UV で画像の色を拾う
  2. カラー属性 (頂点カラー) ノードがつながっていれば、その色
  3. ベースカラーの値 (ノードを使っていなければビューポート表示色)
  マテリアルがなければ、メッシュにカラー属性があればそれ、なければ灰色。
"""

import bpy
import numpy as np

from . import png

GRAY = (0.6, 0.6, 0.6, 1.0)

# Blender (Z が上) -> Minecraft (Y が上)。正面図で見た向きのまま北向きに建つ。
#   MC x = Blender x, MC y = Blender z, MC z = -Blender y
AXIS = np.array([[1.0, 0.0, 0.0],
                 [0.0, 0.0, 1.0],
                 [0.0, -1.0, 0.0]])


# --- マテリアルの解析 --------------------------------------------------------

def _upstream(socket, depth=0):
    """ソケットの上流をたどり、最初に見つかった色の元ノードを返す。"""
    if depth > 8 or not socket.is_linked:
        return None
    node = socket.links[0].from_node
    if node.type in {"TEX_IMAGE", "VERTEX_COLOR", "ATTRIBUTE"}:
        return node
    for name in ("Color", "Color1", "A", "Base Color", "Image", "Fac"):
        inp = node.inputs.get(name)
        if inp is not None and inp.is_linked:
            found = _upstream(inp, depth + 1)
            if found is not None:
                return found
    for inp in node.inputs:
        if inp.is_linked and inp.type in {"RGBA", "SHADER"}:
            found = _upstream(inp, depth + 1)
            if found is not None:
                return found
    return None


def _base_color_socket(mat):
    nt = mat.node_tree
    out = None
    for node in nt.nodes:
        if node.type == "OUTPUT_MATERIAL" and (out is None or node.is_active_output):
            out = node
    candidates = []
    if out is not None and out.inputs["Surface"].is_linked:
        candidates.append(out.inputs["Surface"].links[0].from_node)
    candidates += [n for n in nt.nodes if n.type == "BSDF_PRINCIPLED"]
    candidates += [n for n in nt.nodes if n.type in {"BSDF_DIFFUSE", "EMISSION"}]
    for node in candidates:
        for name in ("Base Color", "Color"):
            sock = node.inputs.get(name)
            if sock is not None:
                return sock
    return None


def _linear_rgba_to_srgb(rgba):
    rgba = np.array(rgba, dtype=np.float64)
    rgba[:3] = png.linear_to_srgb(rgba[:3])
    return rgba


class _Source:
    """1 つのマテリアルの色の取り方"""

    def __init__(self, kind, color=GRAY, image=None, uv_name="", attr_name=""):
        self.kind = kind  # "const" / "image" / "attr"
        self.color = np.asarray(color, dtype=np.float64)
        self.image = image
        self.uv_name = uv_name
        self.attr_name = attr_name


def material_source(mat):
    if mat is None:
        return _Source("attr_or_const")
    if not getattr(mat, "use_nodes", True) or mat.node_tree is None:
        return _Source("const", _linear_rgba_to_srgb(mat.diffuse_color))
    sock = _base_color_socket(mat)
    if sock is None:
        return _Source("const", _linear_rgba_to_srgb(mat.diffuse_color))
    node = _upstream(sock)
    if node is not None and node.type == "TEX_IMAGE" and node.image is not None:
        uv_name = ""
        vec = node.inputs.get("Vector")
        if vec is not None and vec.is_linked:
            src = vec.links[0].from_node
            if src.type == "UVMAP":
                uv_name = src.uv_map
        return _Source("image", image=node.image, uv_name=uv_name)
    if node is not None and node.type == "VERTEX_COLOR":
        return _Source("attr", attr_name=node.layer_name)
    if node is not None and node.type == "ATTRIBUTE":
        return _Source("attr", attr_name=node.attribute_name)
    if sock.type == "RGBA":
        return _Source("const", _linear_rgba_to_srgb(sock.default_value))
    return _Source("const", _linear_rgba_to_srgb(mat.diffuse_color))


_image_cache = {}


def image_pixels(image):
    """(H, W, 4) の sRGB 0..1 配列 (キャッシュ付き)"""
    key = image.name_full
    if key in _image_cache:
        return _image_cache[key]
    w, h = image.size
    if w == 0 or h == 0:
        raise RuntimeError(f"画像「{image.name}」を読み込めません。ファイルの場所を確認してください。")
    buf = np.empty(w * h * image.channels, dtype=np.float32)
    image.pixels.foreach_get(buf)
    px = buf.reshape(h, w, image.channels).astype(np.float64)
    if image.channels < 4:
        alpha = np.ones((h, w, 1))
        if image.channels == 1:
            px = np.repeat(px, 3, axis=2)
        px = np.concatenate([px[..., :3], alpha], axis=2)
    if image.is_float:
        px[..., :3] = png.linear_to_srgb(px[..., :3])
    _image_cache[key] = px
    return px


def clear_cache():
    _image_cache.clear()


# --- メッシュの取り出し ------------------------------------------------------

class MeshPart:
    def __init__(self, obj, depsgraph):
        obj_eval = obj.evaluated_get(depsgraph)
        mesh = obj_eval.to_mesh()
        try:
            mesh.calc_loop_triangles()
            nt = len(mesh.loop_triangles)
            verts = np.empty(len(mesh.vertices) * 3)
            mesh.vertices.foreach_get("co", verts)
            verts = verts.reshape(-1, 3)
            mw = np.array(obj_eval.matrix_world)
            verts = verts @ mw[:3, :3].T + mw[:3, 3]
            tri_verts = np.empty(nt * 3, dtype=np.int64)
            mesh.loop_triangles.foreach_get("vertices", tri_verts)
            self.tri_loops = np.empty(nt * 3, dtype=np.int64)
            mesh.loop_triangles.foreach_get("loops", self.tri_loops)
            self.tri_loops = self.tri_loops.reshape(-1, 3)
            self.tri_vert_idx = tri_verts.reshape(-1, 3)
            self.mat_index = np.empty(nt, dtype=np.int64)
            mesh.loop_triangles.foreach_get("material_index", self.mat_index)
            self.tris = verts[self.tri_vert_idx]  # ワールド座標 (T, 3, 3)

            nloops = len(mesh.loops)
            self.uvs = {}
            for layer in mesh.uv_layers:
                uv = np.empty(nloops * 2)
                layer.data.foreach_get("uv", uv)
                self.uvs[layer.name] = uv.reshape(-1, 2)
            self.active_uv = None
            for layer in mesh.uv_layers:
                if layer.active_render:
                    self.active_uv = layer.name
            if self.active_uv is None and len(mesh.uv_layers):
                self.active_uv = mesh.uv_layers[0].name

            self.attrs = {}
            for attr in getattr(mesh, "color_attributes", []):
                n = len(attr.data)
                col = np.empty(n * 4)
                if hasattr(attr.data[0] if n else None, "color_srgb"):
                    attr.data.foreach_get("color_srgb", col)
                    col = col.reshape(-1, 4)
                else:
                    attr.data.foreach_get("color", col)
                    col = col.reshape(-1, 4)
                    col[:, :3] = png.linear_to_srgb(col[:, :3])
                self.attrs[attr.name] = (attr.domain, col)
            self.default_attr = None
            ca = getattr(mesh, "color_attributes", None)
            if ca is not None and len(ca):
                idx = ca.render_color_index if ca.render_color_index >= 0 else 0
                self.default_attr = ca[idx].name

            mats = [slot.material for slot in obj.material_slots]
            self.sources = [material_source(m) for m in mats] or [material_source(None)]
        finally:
            obj_eval.to_mesh_clear()

    def _corner_values(self, tri_index, table, domain):
        if domain == "CORNER":
            return table[self.tri_loops[tri_index]]
        return table[self.tri_vert_idx[tri_index]]

    def colors(self, tri_index, bary):
        out = np.empty((len(tri_index), 4))
        out[:] = GRAY
        mi = np.clip(self.mat_index[tri_index], 0, len(self.sources) - 1)
        for k, src in enumerate(self.sources):
            sel = np.nonzero(mi == k)[0]
            if len(sel) == 0:
                continue
            ti, b = tri_index[sel], bary[sel]
            kind = src.kind
            attr = src.attr_name or self.default_attr
            if kind == "attr_or_const":
                kind = "attr" if attr else "const"
            if kind == "image":
                uv_name = src.uv_name if src.uv_name in self.uvs else self.active_uv
                if uv_name is None:
                    out[sel] = GRAY
                    continue
                uv = np.einsum("pv,pvc->pc", b, self.uvs[uv_name][self.tri_loops[ti]])
                px = image_pixels(src.image)
                h, w = px.shape[:2]
                x = np.floor(uv[:, 0] * w).astype(np.int64) % w
                y = np.floor(uv[:, 1] * h).astype(np.int64) % h
                out[sel] = px[y, x]
            elif kind == "attr" and attr in self.attrs:
                domain, table = self.attrs[attr]
                if domain in {"CORNER", "POINT"}:
                    out[sel] = np.einsum("pv,pvc->pc", b, self._corner_values(ti, table, domain))
                else:
                    out[sel] = GRAY
            else:
                out[sel] = src.color
        return out


def collect(objects, depsgraph):
    parts = [MeshPart(o, depsgraph) for o in objects if o.type in {"MESH", "CURVE", "SURFACE", "META", "FONT"}]
    return [p for p in parts if len(p.tris)]


def to_voxel_space(parts, size_mode, block_size, fit_blocks):
    """全パーツの三角形を Minecraft 向き・ボクセル単位に変換する。
    戻り値: (tris (T,3,3), color_fn, 1 ブロックあたりの m, 原点 (MC 向きのワールド座標))"""
    tris = np.concatenate([p.tris for p in parts]) @ AXIS.T
    lo = tris.reshape(-1, 3).min(axis=0)
    hi = tris.reshape(-1, 3).max(axis=0)
    extent = float((hi - lo).max())
    if size_mode == "FIT":
        scale = max(fit_blocks, 1) / max(extent, 1e-9)
    else:
        scale = 1.0 / max(block_size, 1e-9)
    tris = (tris - lo) * scale

    offsets = np.cumsum([0] + [len(p.tris) for p in parts])

    def color_fn(tri_index, bary):
        out = np.empty((len(tri_index), 4))
        part_of = np.searchsorted(offsets, tri_index, side="right") - 1
        for k, part in enumerate(parts):
            sel = np.nonzero(part_of == k)[0]
            if len(sel):
                out[sel] = part.colors(tri_index[sel] - offsets[k], bary[sel])
        return out

    return tris, color_fn, 1.0 / scale, lo
