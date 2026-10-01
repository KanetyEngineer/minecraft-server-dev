"""Litematica (.litematic) 形式の書き出しと読み込み。

形式は Litematica 本体 (sakura-ryoko/litematica, LTS/26.2) の
LitematicaSchematic#writeToNBT に合わせている:
  Version 7 / SubVersion 1 / MinecraftDataVersion = 対象バージョンの Data Version
"""

import time

import numpy as np

from . import nbt

SCHEMATIC_VERSION = 7
SCHEMATIC_SUBVERSION = 1

# https://minecraft.wiki/w/Data_version
DATA_VERSIONS = {
    "1.21.4": 4189,
    "1.21.5": 4325,
    "1.21.8": 4440,
    "1.21.10": 4556,
    "1.21.11": 4671,
    "26.1": 4786,
    "26.2": 4903,
    "26.3": 5023,
}
DEFAULT_MC_VERSION = "26.2"


def parse_block_state(text):
    """"minecraft:oak_log[axis=x]" -> {"Name": ..., "Properties": {...}}"""
    text = text.strip()
    props = {}
    if "[" in text:
        name, rest = text.split("[", 1)
        for pair in rest.rstrip("]").split(","):
            if pair.strip():
                k, v = pair.split("=", 1)
                props[k.strip()] = v.strip()
    else:
        name = text
    if ":" not in name:
        name = "minecraft:" + name
    entry = {"Name": name}
    if props:
        entry["Properties"] = props
    return entry


def format_block_state(entry):
    props = entry.get("Properties")
    if not props:
        return entry["Name"]
    return entry["Name"] + "[" + ",".join(f"{k}={v}" for k, v in props.items()) + "]"


def bits_for_palette(n):
    return max(2, (n - 1).bit_length())


def pack_indices(flat, bits):
    """Litematica の LitematicaBitArray と同じ詰め方 (値が long の境界をまたぐ)。"""
    flat = np.asarray(flat, dtype=np.uint64)
    n = flat.size
    nlongs = (n * bits + 63) // 64
    out = np.zeros(nlongs + 1, dtype=np.uint64)
    start = np.arange(n, dtype=np.uint64) * np.uint64(bits)
    word = (start >> np.uint64(6)).astype(np.int64)
    off = start & np.uint64(63)
    np.bitwise_or.at(out, word, flat << off)
    spill = (off + np.uint64(bits)) > np.uint64(64)
    if spill.any():
        shift = np.uint64(64) - off[spill]
        np.bitwise_or.at(out, word[spill] + 1, flat[spill] >> shift)
    return out[:nlongs].view(np.int64)


def unpack_indices(longs, bits, n):
    arr = np.asarray(longs, dtype=np.int64).view(np.uint64)
    arr = np.concatenate([arr, np.zeros(1, dtype=np.uint64)])
    start = np.arange(n, dtype=np.uint64) * np.uint64(bits)
    word = (start >> np.uint64(6)).astype(np.int64)
    off = start & np.uint64(63)
    mask = np.uint64((1 << bits) - 1)
    val = arr[word] >> off
    spill = (off + np.uint64(bits)) > np.uint64(64)
    if spill.any():
        shift = np.uint64(64) - off[spill]
        val[spill] |= arr[word[spill] + 1] << shift
    return (val & mask).astype(np.int64)


def _pos(x, y, z):
    return {"x": nbt.Int(int(x)), "y": nbt.Int(int(y)), "z": nbt.Int(int(z))}


def build_nbt(grid, palette, name="Schematic", author="", description="",
              data_version=DATA_VERSIONS[DEFAULT_MC_VERSION], region_name=None):
    """grid: shape (X, Y, Z) の整数配列 (palette のインデックス、0 は空気)。
    palette: ブロック状態文字列のリスト。palette[0] は minecraft:air。"""
    grid = np.asarray(grid)
    if grid.ndim != 3 or min(grid.shape) < 1:
        raise ValueError("grid は (X, Y, Z) の 3 次元配列である必要があります")
    if palette[0] != "minecraft:air":
        raise ValueError("palette[0] は minecraft:air にしてください")
    sx, sy, sz = (int(v) for v in grid.shape)
    # Litematica の並び順: index = (y * sizeZ + z) * sizeX + x
    flat = np.transpose(grid, (1, 2, 0)).reshape(-1)
    bits = bits_for_palette(len(palette))
    longs = pack_indices(flat, bits)

    now = int(time.time() * 1000)
    total_blocks = int(np.count_nonzero(grid))
    region_name = region_name or name
    region = {
        "Position": _pos(0, 0, 0),
        "Size": _pos(sx, sy, sz),
        "BlockStatePalette": nbt.List([_palette_entry(p) for p in palette], nbt.TAG_COMPOUND),
        "BlockStates": nbt.LongArray(int(v) for v in longs),
        "TileEntities": nbt.List([], nbt.TAG_COMPOUND),
        "Entities": nbt.List([], nbt.TAG_COMPOUND),
        "PendingBlockTicks": nbt.List([], nbt.TAG_COMPOUND),
        "PendingFluidTicks": nbt.List([], nbt.TAG_COMPOUND),
    }
    return {
        "MinecraftDataVersion": nbt.Int(int(data_version)),
        "Version": nbt.Int(SCHEMATIC_VERSION),
        "SubVersion": nbt.Int(SCHEMATIC_SUBVERSION),
        "Metadata": {
            "Name": name,
            "Author": author,
            "Description": description,
            "RegionCount": nbt.Int(1),
            "TotalVolume": nbt.Int(sx * sy * sz),
            "TotalBlocks": nbt.Int(total_blocks),
            "TimeCreated": nbt.Long(now),
            "TimeModified": nbt.Long(now),
            "EnclosingSize": _pos(sx, sy, sz),
        },
        "Regions": {region_name: region},
    }


def _palette_entry(text):
    entry = parse_block_state(text)
    out = {"Name": entry["Name"]}
    if "Properties" in entry:
        out["Properties"] = dict(entry["Properties"])
    return out


def write(path, grid, palette, **kwargs):
    nbt.save(path, build_nbt(grid, palette, **kwargs))


def read(path):
    """(grid, palette, root) を返す。最初のリージョンのみ。"""
    root = nbt.load(path)
    region = next(iter(root["Regions"].values()))
    size = region["Size"]
    sx, sy, sz = (abs(size[k].value) for k in ("x", "y", "z"))
    palette = [format_block_state({
        "Name": e["Name"],
        "Properties": {k: v for k, v in e.get("Properties", {}).items()},
    }) for e in region["BlockStatePalette"]]
    bits = bits_for_palette(len(palette))
    flat = unpack_indices(region["BlockStates"], bits, sx * sy * sz)
    grid = flat.reshape(sy, sz, sx).transpose(2, 0, 1)
    return grid, palette, root
