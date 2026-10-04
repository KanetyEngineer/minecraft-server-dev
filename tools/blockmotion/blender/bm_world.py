"""Minecraft Java world import for BlockMotion.

Reads Anvil region files (.mca) around a coordinate and turns the blocks into a
Blender mesh using the block models and textures of a Minecraft client jar (or a
resource pack / folder). Pure Python + numpy for reading; bpy only in build_mesh().

Coordinates: Minecraft (X, Y, Z) -> Blender (X - ox, -(Z - oz), Y - oy), so the chosen
coordinate becomes the Blender origin, north (-Z) is +Y and up stays up.
"""
import gzip
import json
import math
import os
import struct
import zipfile
import zlib

import numpy as np

# ---------------------------------------------------------------------------
# NBT
# ---------------------------------------------------------------------------


class _Reader:
    __slots__ = ("b", "i")

    def __init__(self, b):
        self.b = b
        self.i = 0

    def take(self, n):
        v = self.b[self.i:self.i + n]
        self.i += n
        return v

    def u8(self):
        v = self.b[self.i]
        self.i += 1
        return v

    def unpack(self, fmt, n):
        v = struct.unpack_from(fmt, self.b, self.i)
        self.i += n
        return v[0]

    def string(self):
        n = self.unpack(">H", 2)
        return bytes(self.take(n)).decode("utf-8", "replace")

    def payload(self, t):
        if t == 1:
            return self.unpack(">b", 1)
        if t == 2:
            return self.unpack(">h", 2)
        if t == 3:
            return self.unpack(">i", 4)
        if t == 4:
            return self.unpack(">q", 8)
        if t == 5:
            return self.unpack(">f", 4)
        if t == 6:
            return self.unpack(">d", 8)
        if t == 7:
            n = self.unpack(">i", 4)
            return bytes(self.take(n))
        if t == 8:
            return self.string()
        if t == 9:
            et = self.u8()
            n = self.unpack(">i", 4)
            return [self.payload(et) for _ in range(n)]
        if t == 10:
            out = {}
            while True:
                tt = self.u8()
                if tt == 0:
                    return out
                name = self.string()
                out[name] = self.payload(tt)
        if t == 11:
            n = self.unpack(">i", 4)
            return np.frombuffer(bytes(self.take(4 * n)), dtype=">i4")
        if t == 12:
            n = self.unpack(">i", 4)
            return np.frombuffer(bytes(self.take(8 * n)), dtype=">i8")
        raise ValueError("bad NBT tag %d" % t)


def read_nbt(data):
    r = _Reader(memoryview(data))
    t = r.u8()
    r.string()
    return r.payload(t)


# ---------------------------------------------------------------------------
# regions / chunks
# ---------------------------------------------------------------------------
def find_region_dir(world, dimension="overworld"):
    """Accepts a world folder, a dimension folder or a region folder."""
    if os.path.isdir(world) and any(f.endswith(".mca") for f in os.listdir(world)):
        return world
    sub = {"overworld": ["region", os.path.join("dimensions", "minecraft", "overworld", "region")],
           "nether": [os.path.join("DIM-1", "region"), os.path.join("dimensions", "minecraft", "the_nether", "region")],
           "end": [os.path.join("DIM1", "region"), os.path.join("dimensions", "minecraft", "the_end", "region")]}
    for s in sub.get(dimension, sub["overworld"]):
        p = os.path.join(world, s)
        if os.path.isdir(p):
            return p
    # Bobby caches and other layouts: look one level deeper
    for root, dirs, files in os.walk(world):
        if any(f.endswith(".mca") for f in files) and (dimension in root or dimension == "overworld"):
            return root
    raise FileNotFoundError("region フォルダが見つかりません: " + world)


class RegionCache:
    def __init__(self, region_dir):
        self.dir = region_dir
        self.files = {}

    def chunk(self, cx, cz):
        rx, rz = cx >> 5, cz >> 5
        key = (rx, rz)
        if key not in self.files:
            p = os.path.join(self.dir, "r.%d.%d.mca" % (rx, rz))
            self.files[key] = open(p, "rb").read() if os.path.exists(p) else b""
        data = self.files[key]
        if len(data) < 8192:
            return None
        idx = 4 * ((cx & 31) + (cz & 31) * 32)
        off = int.from_bytes(data[idx:idx + 3], "big")
        if off == 0:
            return None
        start = off * 4096
        length = int.from_bytes(data[start:start + 4], "big")
        comp = data[start + 4]
        raw = data[start + 5:start + 4 + length]
        if comp & 0x80:  # stored in an external .mcc file
            p = os.path.join(self.dir, "c.%d.%d.mcc" % (cx, cz))
            raw = open(p, "rb").read()
            comp &= 0x7F
        if comp == 1:
            raw = gzip.decompress(raw)
        elif comp == 2:
            raw = zlib.decompress(raw)
        elif comp == 3:
            pass
        else:
            raise ValueError("unsupported chunk compression %d (LZ4 is not supported)" % comp)
        return read_nbt(raw)


def _unpack_states(longs, n_palette, data_version):
    bits = max(4, (n_palette - 1).bit_length())
    arr = longs.astype(np.int64).view(np.uint64)
    mask = np.uint64((1 << bits) - 1)
    if data_version >= 2566 or data_version == 0:  # 1.16+: entries never span two longs
        per = 64 // bits
        shifts = (np.arange(per, dtype=np.uint64) * np.uint64(bits))
        vals = (arr[:, None] >> shifts[None, :]) & mask
        return vals.reshape(-1)[:4096].astype(np.int32)
    out = np.zeros(4096, dtype=np.int32)  # 1.13 - 1.15: tightly packed bit stream
    big = [int(x) for x in arr]
    for i in range(4096):
        bit = i * bits
        li, off = divmod(bit, 64)
        v = big[li] >> off
        if off + bits > 64:
            v |= big[li + 1] << (64 - off)
        out[i] = v & ((1 << bits) - 1)
    return out


def state_key(entry):
    name = entry.get("Name", "minecraft:air")
    props = entry.get("Properties") or {}
    if props:
        return name + "[" + ",".join("%s=%s" % kv for kv in sorted(props.items())) + "]"
    return name


def parse_state(key):
    if "[" not in key:
        return key, {}
    name, rest = key.split("[", 1)
    props = dict(p.split("=", 1) for p in rest.rstrip("]").split(",") if "=" in p)
    return name, props


def read_blocks(world, dimension, center, radius, down, up, log=print):
    """Returns (grid[x, y, z] of state ids, list of state keys, (x0, y0, z0))."""
    cx, cy, cz = (int(math.floor(v)) for v in center)
    x0, x1 = cx - radius, cx + radius
    z0, z1 = cz - radius, cz + radius
    y0, y1 = cy - down, cy + up
    reg = RegionCache(find_region_dir(world, dimension))
    states = ["minecraft:air"]
    index = {"minecraft:air": 0}
    grid = np.zeros((x1 - x0 + 1, y1 - y0 + 1, z1 - z0 + 1), dtype=np.int32)
    chunks = 0
    for ccx in range(x0 >> 4, (x1 >> 4) + 1):
        for ccz in range(z0 >> 4, (z1 >> 4) + 1):
            try:
                nbt = reg.chunk(ccx, ccz)
            except Exception as e:  # a broken chunk should not stop the whole import
                log("BM_INFO chunk %d,%d skipped: %s" % (ccx, ccz, e))
                continue
            if nbt is None:
                continue
            chunks += 1
            dv = nbt.get("DataVersion", 0)
            if "sections" in nbt:
                secs = nbt["sections"]
                mode = "new"
            else:
                secs = nbt.get("Level", {}).get("Sections", [])
                mode = "old"
            for sec in secs:
                sy = sec.get("Y", 0)
                if sy * 16 + 15 < y0 or sy * 16 > y1:
                    continue
                if mode == "new":
                    bs = sec.get("block_states")
                    if not bs:
                        continue
                    pal = bs.get("palette", [])
                    data = bs.get("data")
                else:
                    pal = sec.get("Palette")
                    data = sec.get("BlockStates")
                    if not pal:
                        continue
                ids = []
                for e in pal:
                    k = state_key(e)
                    if k not in index:
                        index[k] = len(states)
                        states.append(k)
                    ids.append(index[k])
                ids = np.array(ids, dtype=np.int32)
                if data is None or len(pal) == 1:
                    local = np.zeros(4096, dtype=np.int32)
                else:
                    local = _unpack_states(data, len(pal), dv)
                sec_blocks = ids[np.clip(local, 0, len(ids) - 1)].reshape(16, 16, 16)  # [y, z, x]
                # overlap with our box
                bx0, by0, bz0 = ccx * 16, sy * 16, ccz * 16
                gx0, gx1 = max(x0, bx0), min(x1, bx0 + 15)
                gy0, gy1 = max(y0, by0), min(y1, by0 + 15)
                gz0, gz1 = max(z0, bz0), min(z1, bz0 + 15)
                if gx0 > gx1 or gy0 > gy1 or gz0 > gz1:
                    continue
                part = sec_blocks[gy0 - by0:gy1 - by0 + 1, gz0 - bz0:gz1 - bz0 + 1, gx0 - bx0:gx1 - bx0 + 1]
                grid[gx0 - x0:gx1 - x0 + 1, gy0 - y0:gy1 - y0 + 1, gz0 - z0:gz1 - z0 + 1] = part.transpose(2, 0, 1)
    log("BM_INFO world: %d chunks, %d block states" % (chunks, len(states)))
    if chunks == 0:
        raise RuntimeError("指定した座標のまわりにチャンクがありません（まだ生成されていない場所かもしれません）")
    return grid, states, (x0, y0, z0)


# ---------------------------------------------------------------------------
# assets (client jar / resource pack / folder)
# ---------------------------------------------------------------------------
def find_client_jars():
    """Minecraft client jars installed on this PC, newest first."""
    cands = []
    appdata = os.environ.get("APPDATA", "")
    roots = []
    if appdata:
        roots += [os.path.join(appdata, ".minecraft", "versions")]
        for launcher in ("PrismLauncher", "MultiMC", "PolyMC"):
            roots.append(os.path.join(appdata, launcher, "libraries", "com", "mojang", "minecraft"))
    home = os.path.expanduser("~")
    roots += [os.path.join(home, ".minecraft", "versions"),
              os.path.join(home, "Library", "Application Support", "minecraft", "versions")]
    for r in roots:
        if not os.path.isdir(r):
            continue
        for d in os.listdir(r):
            for f in os.listdir(os.path.join(r, d)) if os.path.isdir(os.path.join(r, d)) else []:
                if f.endswith(".jar") and ("client" in f or f == d + ".jar"):
                    cands.append(os.path.join(r, d, f))
    cands.sort(key=lambda p: os.path.getmtime(p), reverse=True)
    return cands


class Assets:
    """Looks things up in several sources in order (resource packs first, jar last)."""

    def __init__(self, sources, cache_dir, fallback_tex_dir=None):
        self.zips, self.dirs = [], []
        for s in sources:
            if not s:
                continue
            if os.path.isdir(s):
                self.dirs.append(s)
            elif os.path.isfile(s) and zipfile.is_zipfile(s):
                self.zips.append(zipfile.ZipFile(s))
        self.cache = cache_dir
        os.makedirs(cache_dir, exist_ok=True)
        self.fallback = fallback_tex_dir
        self._json = {}

    def _read(self, rel):
        for d in self.dirs:
            p = os.path.join(d, rel)
            if os.path.isfile(p):
                return open(p, "rb").read()
        for z in self.zips:
            try:
                return z.read(rel)
            except KeyError:
                continue
        return None

    def json(self, rel):
        if rel not in self._json:
            raw = self._read(rel)
            try:
                self._json[rel] = json.loads(raw.decode("utf-8")) if raw else None
            except ValueError:
                self._json[rel] = None
        return self._json[rel]

    @staticmethod
    def _split(rid):
        ns, _, path = rid.partition(":") if ":" in rid else ("minecraft", "", rid)
        return ns, path

    def blockstate(self, name):
        ns, path = self._split(name)
        return self.json("assets/%s/blockstates/%s.json" % (ns, path))

    def model(self, mid):
        ns, path = self._split(mid)
        return self.json("assets/%s/models/%s.json" % (ns, path))

    def texture(self, tid):
        """Returns a PNG path on disk (first animation frame only), or None."""
        ns, path = self._split(tid)
        out = os.path.join(self.cache, ns + "_" + path.replace("/", "_") + ".png")
        if os.path.exists(out):
            return out
        raw = self._read("assets/%s/textures/%s.png" % (ns, path))
        if raw is None and self.fallback:
            p = os.path.join(self.fallback, os.path.basename(path) + ".png")
            if os.path.exists(p):
                raw = open(p, "rb").read()
        if raw is None:
            return None
        with open(out, "wb") as f:
            f.write(raw)
        return out


# ---------------------------------------------------------------------------
# block models -> face templates
# ---------------------------------------------------------------------------
DIRS = {"down": (0, -1, 0), "up": (0, 1, 0), "north": (0, 0, -1),
        "south": (0, 0, 1), "west": (-1, 0, 0), "east": (1, 0, 0)}
VEC2DIR = {v: k for k, v in DIRS.items()}

GRASS = (0.569, 0.741, 0.349)
FOLIAGE = (0.467, 0.671, 0.184)
TINTS = {
    "birch_leaves": (0.502, 0.655, 0.333), "spruce_leaves": (0.380, 0.600, 0.380),
    "water": (0.247, 0.463, 0.894), "lily_pad": (0.125, 0.502, 0.188),
    "redstone_wire": (0.8, 0.1, 0.05), "attached_melon_stem": (0.6, 0.6, 0.2),
    "attached_pumpkin_stem": (0.6, 0.6, 0.2), "melon_stem": (0.5, 0.7, 0.2), "pumpkin_stem": (0.5, 0.7, 0.2),
}
FOLIAGE_BLOCKS = ("oak_leaves", "jungle_leaves", "acacia_leaves", "dark_oak_leaves", "mangrove_leaves", "vine")
TRANSLUCENT = ("glass", "ice", "slime_block", "honey_block", "water", "bubble_column")
NOT_OCCLUDING = ("leaves", "glass", "ice", "slime", "honey", "barrier", "spawner", "beacon", "water",
                 "lava", "bubble_column", "mangrove_roots", "vault", "trial_spawner")
LIGHTS = {  # name part -> (emission strength, add a point light)
    "torch": (3.0, True), "lantern": (3.0, True), "campfire": (3.0, True), "glowstone": (2.5, False),
    "sea_lantern": (2.5, False), "shroomlight": (2.0, False), "jack_o_lantern": (2.5, True),
    "lava": (3.0, False), "fire": (3.0, True), "froglight": (2.5, False), "end_rod": (2.5, True),
    "magma_block": (1.5, False), "beacon": (3.0, False), "redstone_lamp[lit=true": (2.5, False),
    "crying_obsidian": (1.0, False), "glow_lichen": (1.0, False), "candle[lit=true": (2.0, True),
}
SKIP = ("air", "light", "barrier", "structure_void", "moving_piston")


def _rot(v, axis, deg, origin=(8, 8, 8)):
    a = math.radians(deg)
    c, s = math.cos(a), math.sin(a)
    x, y, z = v[0] - origin[0], v[1] - origin[1], v[2] - origin[2]
    if axis == "x":
        y, z = y * c - z * s, y * s + z * c
    elif axis == "y":
        x, z = x * c + z * s, -x * s + z * c
    else:
        x, y = x * c - y * s, x * s + y * c
    return (x + origin[0], y + origin[1], z + origin[2])


def _rot_variant(v, xr, yr):
    # Minecraft rotates the model clockwise about X, then clockwise about Y (seen from +axis)
    if xr:
        v = _rot(v, "x", -xr)
    if yr:
        v = _rot(v, "y", -yr)
    return v


def _rot_dir(d, xr, yr):
    v = _rot_variant(tuple(8 + 8 * c for c in DIRS[d]), xr, yr)
    vec = tuple(int(round((c - 8) / 8)) for c in v)
    return VEC2DIR.get(vec, d)


class BlockModels:
    def __init__(self, assets, log=print):
        self.a = assets
        self.log = log
        self._resolved = {}
        self.missing = set()

    def resolve(self, mid):
        """Merged textures + elements of a model following its parents."""
        if mid in self._resolved:
            return self._resolved[mid]
        textures, elements, chain = {}, None, []
        cur = mid
        for _ in range(16):
            m = self.a.model(cur if ":" in cur else "minecraft:" + cur)
            if m is None:
                break
            chain.append(cur)
            for k, v in (m.get("textures") or {}).items():
                textures.setdefault(k, v)
            if elements is None and m.get("elements"):
                elements = m["elements"]
            if "parent" not in m:
                break
            cur = m["parent"]
        res = (textures, elements or [], chain)
        self._resolved[mid] = res
        return res

    @staticmethod
    def tex_var(textures, ref):
        for _ in range(8):
            if not ref or not ref.startswith("#"):
                return ref
            ref = textures.get(ref[1:])
        return None

    def variants(self, name, props):
        """[(model id, x rot, y rot)] for a block state."""
        bs = self.a.blockstate(name)
        if not bs:
            return []
        out = []
        if "variants" in bs:
            best = None
            for key, v in bs["variants"].items():
                conds = dict(p.split("=", 1) for p in key.split(",") if "=" in p)
                if all(props.get(k) == val for k, val in conds.items()):
                    best = v
                    break
            if best is None:
                best = next(iter(bs["variants"].values()))
            if isinstance(best, list):
                best = best[0]
            out.append((best.get("model"), best.get("x", 0), best.get("y", 0)))
        elif "multipart" in bs:
            for part in bs["multipart"]:
                when = part.get("when")
                if when is None or self._when(when, props):
                    ap = part["apply"]
                    if isinstance(ap, list):
                        ap = ap[0]
                    out.append((ap.get("model"), ap.get("x", 0), ap.get("y", 0)))
        return out

    def _when(self, when, props):
        if "OR" in when:
            return any(self._when(w, props) for w in when["OR"])
        if "AND" in when:
            return all(self._when(w, props) for w in when["AND"])
        for k, v in when.items():
            if props.get(k) not in str(v).split("|"):
                return False
        return True


def _auto_uv(d, x, y, z):
    if d == "north":
        return 16 - x, 16 - y
    if d == "south":
        return x, 16 - y
    if d == "east":
        return 16 - z, 16 - y
    if d == "west":
        return z, 16 - y
    if d == "up":
        return x, z
    return x, 16 - z


def _face_corners(d, f, t):
    x0, y0, z0 = f
    x1, y1, z1 = t
    return {
        "down": [(x0, y0, z1), (x0, y0, z0), (x1, y0, z0), (x1, y0, z1)],
        "up": [(x0, y1, z0), (x0, y1, z1), (x1, y1, z1), (x1, y1, z0)],
        "north": [(x1, y0, z0), (x0, y0, z0), (x0, y1, z0), (x1, y1, z0)],
        "south": [(x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1)],
        "west": [(x0, y0, z0), (x0, y0, z1), (x0, y1, z1), (x0, y1, z0)],
        "east": [(x1, y0, z1), (x1, y0, z0), (x1, y1, z0), (x1, y1, z1)],
    }[d]


class BlockSpec:
    __slots__ = ("faces", "full", "occludes", "emission", "light", "top", "solid", "name")


def build_spec(models, key):
    """Face templates for one block state: list of (corners16, uvs, texture, tint, cull_dir)."""
    name, props = parse_state(key)
    short = name.split(":")[-1]
    spec = BlockSpec()
    spec.name = short
    spec.faces, spec.full, spec.occludes, spec.emission, spec.light = [], False, False, 0.0, False
    spec.top, spec.solid = 0.0, False
    if short in SKIP or short.endswith("_air"):
        return spec
    for part, (em, lamp) in LIGHTS.items():
        if part in key:
            spec.emission, spec.light = em, lamp
            break
    tint = TINTS.get(short)
    if tint is None:
        tint = FOLIAGE if short in FOLIAGE_BLOCKS else GRASS
    if short in ("water", "bubble_column", "lava"):
        tex = "minecraft:block/" + ("lava_still" if short == "lava" else "water_still")
        h = 14
        for d in DIRS:
            # sides span the whole block so stacked liquid has no seams; the surface sits at 14/16
            f, t = (0, 0, 0), (16, h if d == "up" else 16, 16)
            corners = _face_corners(d, f, t)
            uvs = [_auto_uv(d, *c) for c in corners]
            spec.faces.append((corners, uvs, tex, TINTS["water"] if short != "lava" else None, d, "liquid"))
        spec.top = h / 16
        return spec
    variants = models.variants(name, props)
    if not variants:
        models.missing.add(short)
        return spec
    full_box = False
    for mid, xr, yr in variants:
        if not mid:
            continue
        textures, elements, chain = models.resolve(mid)
        if not elements:
            # entity-rendered blocks (chests, beds, signs...) -> a plain box with the particle texture
            p = models.tex_var(textures, textures.get("particle"))
            if p and any(w in short for w in ("chest", "bed", "shulker_box", "decorated_pot")):
                elements = [{"from": [1, 0, 1], "to": [15, 14, 15],
                             "faces": {d: {"texture": "#particle"} for d in DIRS}}]
            else:
                continue
        for el in elements:
            f, t = el.get("from", [0, 0, 0]), el.get("to", [16, 16, 16])
            if f == [0, 0, 0] and t == [16, 16, 16] and len(elements) == 1:
                full_box = True
            spec.top = max(spec.top, t[1] / 16 if not (xr or yr) else 1.0)
            if t[1] - f[1] >= 2 and (t[0] - f[0]) * (t[2] - f[2]) >= 16:
                spec.solid = True
            rot = el.get("rotation")
            for d, face in (el.get("faces") or {}).items():
                tex = models.tex_var(textures, face.get("texture"))
                if not tex:
                    continue
                corners = _face_corners(d, f, t)
                au = [_auto_uv(d, *c) for c in corners]
                if "uv" in face:
                    u1, v1, u2, v2 = face["uv"]
                    umin, umax = min(a[0] for a in au), max(a[0] for a in au)
                    vmin, vmax = min(a[1] for a in au), max(a[1] for a in au)
                    uvs = []
                    for (u, v) in au:
                        fu = (u - umin) / (umax - umin) if umax > umin else 0
                        fv = (v - vmin) / (vmax - vmin) if vmax > vmin else 0
                        r = face.get("rotation", 0) % 360
                        for _ in range(r // 90):
                            fu, fv = 1 - fv, fu
                        uvs.append((u1 + fu * (u2 - u1), v1 + fv * (v2 - v1)))
                else:
                    uvs = au
                if rot:
                    corners = [_rot(c, rot.get("axis", "y"), rot.get("angle", 0), rot.get("origin", (8, 8, 8)))
                               for c in corners]
                corners = [_rot_variant(c, xr, yr) for c in corners]
                cull = face.get("cullface")
                cull = _rot_dir(cull, xr, yr) if cull else None
                ftint = tint if "tintindex" in face else None
                spec.faces.append((corners, uvs, tex, ftint, cull, "solid"))
    spec.full = full_box and len(variants) == 1
    spec.occludes = spec.full and not any(w in short for w in NOT_OCCLUDING)
    if spec.full:
        spec.solid = True
        spec.top = 1.0
    return spec


# ---------------------------------------------------------------------------
# mesh building
# ---------------------------------------------------------------------------
def build_world(cfg, assets_dir, cache_dir, log=print):
    """Reads the world and returns geometry buffers (no bpy needed)."""
    world = cfg["path"]
    origin = (float(cfg.get("x", 0)), float(cfg.get("y", 64)), float(cfg.get("z", 0)))
    radius = int(cfg.get("radius", 32))
    down, up = int(cfg.get("down", 16)), int(cfg.get("up", 40))
    sources = list(cfg.get("resource_packs") or [])
    jar = cfg.get("client_jar") or ""
    if not jar or not os.path.exists(jar):
        jars = find_client_jars()
        jar = jars[0] if jars else ""
    if jar:
        sources.append(jar)
    log("BM_INFO textures from: " + (", ".join(os.path.basename(s) for s in sources) or "built-in only"))
    assets = Assets(sources, cache_dir, os.path.join(assets_dir, "textures"))
    models = BlockModels(assets, log)
    grid, states, (x0, y0, z0) = read_blocks(world, cfg.get("dimension", "overworld"),
                                             origin, radius, down, up, log)
    specs = [build_spec(models, k) for k in states]
    if models.missing:
        log("BM_INFO no model for: " + ", ".join(sorted(models.missing)[:40]))
    occ = np.array([s.occludes for s in specs], dtype=bool)[grid]
    names = {}
    same = np.array([names.setdefault(s.name, len(names)) for s in specs], dtype=np.int32)[grid]
    nx, ny, nz = grid.shape
    ox, oy, oz = origin

    verts, uvs, mats, faces_mat = [], [], [], []
    mat_index = {}
    lights = []
    nonair = np.argwhere(grid != 0)
    dir_off = {d: v for d, v in DIRS.items()}
    for (ix, iy, iz) in nonair:
        sid = grid[ix, iy, iz]
        sp = specs[sid]
        nid = same[ix, iy, iz]
        if not sp.faces:
            continue
        bx, by, bz = x0 + ix, y0 + iy, z0 + iz
        if sp.light:
            lights.append((bx + 0.5 - ox, -(bz + 0.5 - oz), by + 0.6 - oy, sp.name))
        for corners, fuv, tex, tint, cull, kind in sp.faces:
            if cull:
                dx, dy, dz = dir_off[cull]
                jx, jy, jz = ix + dx, iy + dy, iz + dz
                if 0 <= jx < nx and 0 <= jy < ny and 0 <= jz < nz:
                    if kind == "liquid":
                        if same[jx, jy, jz] == nid or (cull != "up" and occ[jx, jy, jz]):
                            continue
                    elif occ[jx, jy, jz]:
                        continue
                    elif same[jx, jy, jz] == nid and ("glass" in sp.name or "ice" in sp.name):
                        continue
                elif dy < 0:  # the floor of the box is never seen
                    continue
            key = (tex, tint, kind, sp.emission)
            if key not in mat_index:
                mat_index[key] = len(mat_index)
            for (cx, cy, cz), (u, v) in zip(corners, fuv):
                verts.append((bx + cx / 16 - ox, -(bz + cz / 16 - oz), by + cy / 16 - oy))
                uvs.append((u / 16, 1 - v / 16))
            faces_mat.append(mat_index[key])

    # ground height lookup for actors (top of the highest standable block near the origin height)
    solid = np.array([s.solid for s in specs], dtype=bool)[grid]
    tops = np.array([s.top for s in specs], dtype=np.float32)[grid]

    def ground(bx, bz, near_y):
        ix, iz = int(math.floor(bx)) - x0, int(math.floor(bz)) - z0
        if not (0 <= ix < nx and 0 <= iz < nz):
            return near_y
        col_s, col_t = solid[ix, :, iz], tops[ix, :, iz]
        best = None
        for iy in range(ny - 2, -1, -1):
            if col_s[iy] and not solid[ix, iy + 1, iz]:
                h = y0 + iy + float(col_t[iy])
                if best is None or abs(h - near_y) < abs(best - near_y):
                    best = h
        return best if best is not None else near_y

    log("BM_INFO world mesh: %d faces, %d materials" % (len(faces_mat), len(mat_index)))
    return {"verts": verts, "uvs": uvs, "faces_mat": faces_mat, "materials": mat_index,
            "assets": assets, "lights": lights, "ground": ground, "origin": origin}
