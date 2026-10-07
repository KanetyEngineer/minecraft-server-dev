#!/usr/bin/env python3
"""oto2noteblock - 音源（MIDI / 音声 / .nbs）を Minecraft Java 版の音ブロック演奏装置に変換する。

出力:
  .litematic   Litematica 設計図（既定 26.2 / DataVersion 4903）
  .schem       WorldEdit 設計図（Sponge v2）
  .nbs         Note Block Studio の曲ファイル（試聴・編集、Notica などで再生）
  _place.mcfunction  設置コマンド（データパックの関数として相対座標で設置）
  --rcon を付けると鯖に RCON で直接設置する。

装置のしくみ:
  同時に鳴る音の数だけ「レーン」を並べ、各レーンは 反復装置 → 音ブロック → 反復装置 … の一本道。
  全レーンが同じ並びなので同じタイミングで鳴る。時間の細かさはレッドストーン 1 ティック（0.1 秒）。
  --row-length を付けると、決まった長さで上に折り返して箱形にまとめる（長い曲向け）。
  スタートボタンは装置の左手前（設計図の原点付近）。

必要なもの: Python 3.9+、mido（pip install mido）。
音声（mp3/wav など）を入れるときだけ basic-pitch も必要（README 参照）。
"""
from __future__ import annotations

import argparse
import gzip
import io
import math
import os
import socket
import struct
import sys
import time
from dataclasses import dataclass, field

# ---------------------------------------------------------------------------
# 楽器
# ---------------------------------------------------------------------------
# name: (下に置くブロック, note=0 の MIDI 音高, NBS の楽器番号)
INSTRUMENTS = {
    "harp": ("minecraft:dirt", 54, 0),
    "bass": ("minecraft:oak_planks", 30, 1),
    "basedrum": ("minecraft:stone", 54, 2),
    "snare": ("minecraft:sand", 54, 3),
    "hat": ("minecraft:glass", 54, 4),
    "guitar": ("minecraft:white_wool", 42, 5),
    "flute": ("minecraft:clay", 66, 6),
    "bell": ("minecraft:gold_block", 78, 7),
    "chime": ("minecraft:packed_ice", 78, 8),
    "xylophone": ("minecraft:bone_block", 78, 9),
    "iron_xylophone": ("minecraft:iron_block", 54, 10),
    "cow_bell": ("minecraft:soul_sand", 66, 11),
    "didgeridoo": ("minecraft:pumpkin", 30, 12),
    "bit": ("minecraft:emerald_block", 54, 13),
    "banjo": ("minecraft:hay_block", 54, 14),
    "pling": ("minecraft:glowstone", 54, 15),
}
NBS_ID_TO_NAME = {v[2]: k for k, v in INSTRUMENTS.items()}
GRAVITY_BLOCKS = {"minecraft:sand", "minecraft:gravel"}
DRUMS = {"basedrum", "snare", "hat"}

# 音域の外れた音を逃がす先（低い → 高い の順に試す）
PITCH_LADDER = ["bass", "harp", "bell"]


def program_to_instrument(program: int) -> str:
    """General MIDI の音色番号 → 音ブロックの楽器。"""
    p = program
    if p <= 7:
        return "harp"  # ピアノ
    if p in (8, 9):
        return "bell"  # チェレスタ、グロッケン
    if p == 10:
        return "chime"  # オルゴール
    if p == 11:
        return "iron_xylophone"  # ビブラフォン
    if p in (12, 13):
        return "xylophone"  # マリンバ、木琴
    if p == 14:
        return "chime"  # チューブラーベル
    if p <= 15:
        return "harp"
    if p <= 23:
        return "flute"  # オルガン
    if p <= 31:
        return "guitar"
    if p <= 39:
        return "bass"
    if p <= 55:
        return "harp"  # 弦、アンサンブル
    if p <= 63:
        return "bit"  # 金管
    if p <= 79:
        return "flute"  # 木管、笛
    if p <= 87:
        return "bit"  # シンセリード
    if p <= 103:
        return "pling"  # シンセパッド、効果
    if p in (104, 105, 106, 107):
        return "banjo"  # シタール、バンジョー、三味線、琴
    if p == 112:
        return "bell"
    if p == 113:
        return "cow_bell"
    if p == 114:
        return "iron_xylophone"
    if p == 115:
        return "hat"
    if p in (116, 117, 118):
        return "basedrum"
    if p == 119:
        return "snare"
    if p <= 111:
        return "harp"
    return "hat"


def drum_to_instrument(key: int) -> tuple[str, int]:
    """GM ドラム（10ch）の鍵盤番号 → (楽器, note)。"""
    if key in (35, 36):
        return "basedrum", 10
    if key in (41, 43, 45, 47, 48, 50):  # タム
        return "basedrum", {41: 6, 43: 9, 45: 12, 47: 15, 48: 18, 50: 21}[key]
    if key in (38, 40, 39):
        return "snare", 8
    if key in (49, 52, 55, 57):  # クラッシュ系
        return "snare", 20
    if key == 56:
        return "cow_bell", 12
    if key in (42, 44, 46, 51, 53, 59, 54, 37, 75, 76, 77):
        return "hat", 16
    return "hat", 12


def fit_pitch(inst: str, midi: int, mode: str) -> tuple[str, int]:
    """MIDI 音高を (楽器, note 0..24) に。音域外は別の楽器へ、それでも無理ならオクターブで折る。"""
    if mode.startswith("single:"):
        inst = mode.split(":", 1)[1]
    elif mode == "pitch":
        inst = "harp"
    lo = INSTRUMENTS[inst][1]
    if lo <= midi <= lo + 24:
        return inst, midi - lo
    if not mode.startswith("single:"):
        for alt in PITCH_LADDER:
            alo = INSTRUMENTS[alt][1]
            if alo <= midi <= alo + 24:
                return alt, midi - alo
    n = midi - lo
    while n < 0:
        n += 12
    while n > 24:
        n -= 12
    return inst, n


# ---------------------------------------------------------------------------
# 入力
# ---------------------------------------------------------------------------
@dataclass
class Note:
    time: float  # 秒
    inst: str
    note: int  # 0..24
    vel: int  # 0..127


def load_midi(path: str, mode: str) -> list[Note]:
    try:
        import mido
    except ImportError:
        sys.exit("mido が入っていません: pip install mido")
    mid = mido.MidiFile(path)
    programs = [0] * 16
    notes: list[Note] = []
    t = 0.0
    for msg in mid:  # 全トラックをまとめて時間順（テンポ変化込みの秒）
        t += msg.time
        if msg.type == "program_change":
            programs[msg.channel] = msg.program
        elif msg.type == "note_on" and msg.velocity > 0:
            if msg.channel == 9:
                inst, n = drum_to_instrument(msg.note)
            else:
                inst, n = fit_pitch(program_to_instrument(programs[msg.channel]), msg.note, mode)
            notes.append(Note(t, inst, n, msg.velocity))
    return notes


def suggest_speed(path: str):
    """テンポが 1 つの MIDI なら、8 分音符がちょうど整数のレッドストーンティックになる速さを返す。"""
    import mido
    tempos = {m.tempo for tr in mido.MidiFile(path).tracks for m in tr if m.type == "set_tempo"} or {500000}
    if len(tempos) != 1:
        return None
    bpm = 60_000_000 / tempos.pop()
    eighth = 60 / bpm / 2 * 10  # 8 分音符の長さ（レッドストーンティック）
    n = max(1, round(eighth))
    return bpm, eighth / n


def audio_to_midi(path: str, out_mid: str, args) -> str:
    try:
        from basic_pitch import ICASSP_2022_MODEL_PATH
        from basic_pitch.inference import predict
    except ImportError as e:
        sys.exit(
            f"音声ファイルを MIDI にするには basic-pitch が必要です（読み込めなかったもの: {e}）。\n"
            "README の「準備」の手順で入れてください。pkg_resources が無いと出たら pip install \"setuptools<81\"。\n"
            "または https://basicpitch.spotify.com/ で MIDI にしてから、その .mid を入れてください。"
        )
    model = ICASSP_2022_MODEL_PATH
    onnx = os.path.splitext(model)[0] + ".onnx"
    if os.path.exists(onnx):
        model = onnx
    print(f"音声を解析中（Basic Pitch）: {path}")
    _, midi_data, _ = predict(
        path,
        model,
        onset_threshold=args.onset,
        frame_threshold=args.frame,
        minimum_note_length=args.min_note_ms,
        minimum_frequency=None,
        maximum_frequency=None,
    )
    midi_data.write(out_mid)
    print(f"MIDI を書き出しました: {out_mid}")
    return out_mid


def _rd(f, fmt):
    size = struct.calcsize(fmt)
    data = f.read(size)
    if len(data) < size:
        raise EOFError
    return struct.unpack(fmt, data)[0]


def _rd_str(f):
    n = _rd(f, "<i")
    return f.read(n).decode("utf-8", "replace")


def load_nbs(path: str) -> list[Note]:
    with open(path, "rb") as f:
        first = _rd(f, "<h")
        version = 0
        if first == 0:
            version = _rd(f, "<b")
            _rd(f, "<b")  # vanilla instrument count
            if version >= 3:
                _rd(f, "<h")
        layers = _rd(f, "<h")
        for _ in range(4):
            _rd_str(f)
        tempo = _rd(f, "<h") / 100.0
        _rd(f, "<b"); _rd(f, "<b"); _rd(f, "<b")
        for _ in range(5):
            _rd(f, "<i")
        _rd_str(f)
        if version >= 4:
            _rd(f, "<b"); _rd(f, "<b"); _rd(f, "<h")
        notes = []
        tick = -1
        while True:
            jt = _rd(f, "<h")
            if jt == 0:
                break
            tick += jt
            layer = -1
            while True:
                jl = _rd(f, "<h")
                if jl == 0:
                    break
                layer += jl
                inst = _rd(f, "<B")
                key = _rd(f, "<B")
                vel = 100
                if version >= 4:
                    vel = _rd(f, "<B"); _rd(f, "<B"); _rd(f, "<h")
                name = NBS_ID_TO_NAME.get(inst, "harp")
                n = key - 33
                while n < 0:
                    n += 12
                while n > 24:
                    n -= 12
                notes.append(Note(tick / tempo, name, n, int(vel * 127 / 100)))
    return notes


# ---------------------------------------------------------------------------
# 量子化と同時発音の整理
# ---------------------------------------------------------------------------
def quantize(notes: list[Note], speed: float, max_lanes: int, min_vel: int):
    notes = [n for n in notes if n.vel >= min_vel]
    if not notes:
        sys.exit("音符が見つかりませんでした。")
    t0 = min(n.time for n in notes)
    by_tick: dict[int, dict[tuple[str, int], int]] = {}
    for n in notes:
        tick = int(round((n.time - t0) / speed * 10))
        slot = by_tick.setdefault(tick, {})
        k = (n.inst, n.note)
        slot[k] = max(slot.get(k, 0), n.vel)
    ticks = sorted(by_tick)
    slots = []
    dropped = 0
    for t in ticks:
        items = sorted(by_tick[t].items(), key=lambda kv: -kv[1])
        dropped += max(0, len(items) - max_lanes)
        slots.append((t, [k for k, _ in items[:max_lanes]]))
    return slots, dropped


# ---------------------------------------------------------------------------
# 装置の組み立て
# ---------------------------------------------------------------------------
FACING_OF_INPUT = {(1, 0): "west", (-1, 0): "east"}  # 信号の進む向き → 反復装置の facing（入力側）


@dataclass
class Build:
    blocks: dict = field(default_factory=dict)  # (x,y,z) -> (name, props dict)
    notes_at: list = field(default_factory=list)  # (x,y,z, 期待ティック)

    def set(self, pos, name, props=None):
        self.blocks[pos] = (name, dict(props or {}))

    def base(self, x, y, z, name="minecraft:stone"):
        """(x,y,z) に置く部品の下の土台。重力ブロックならさらに下を支える。"""
        cur = self.blocks.get((x, y - 1, z))
        if cur is None or cur[0] == "minecraft:stone" or name != "minecraft:stone":
            self.set((x, y - 1, z), name)
        if name in GRAVITY_BLOCKS:
            self.set((x, y - 2, z), "minecraft:stone")


def split_delay(gap: int) -> list[int]:
    n = math.ceil(gap / 4)
    base, extra = divmod(gap, n)
    return [base + (1 if i < extra else 0) for i in range(n)]


def build_device(slots, row_length: int | None, button: str = "minecraft:stone_button") -> tuple[Build, int]:
    lanes = max(len(s[1]) for s in slots)
    # 全レーン共通の並び: ("rep", delay) / ("slot", index)
    seq = [("slot", 0)]
    for i in range(1, len(slots)):
        for d in split_delay(slots[i][0] - slots[i - 1][0]):
            seq.append(("rep", d))
        seq.append(("slot", i))

    # 並びを経路に配置: 各要素の (x, 行番号, 向き)
    W = row_length or 10 ** 9
    placed = []  # (x, row, dir)
    turns = []  # (row, dir) 行 row の終わりで折り返し
    row, x, d = 0, 0, 1
    for kind, _ in seq:
        pos_in_row = x if d == 1 else (W - 1 - x)
        if kind == "rep" and pos_in_row >= W - 1:
            last_x = x - d
            turns.append((row, d, last_x))
            row += 1
            d = -d
            x = last_x  # 次の行は折り返しの戻りのすぐ隣から
        placed.append((x, row, d))
        x += d

    b = Build()
    zs = lambda lane, r: 3 * lane + (r % 2)
    hy = lambda r: 3 * r + 2

    for lane in range(lanes):
        # 本体
        for (kind, val), (x, r, dd) in zip(seq, placed):
            z, y = zs(lane, r), hy(r)
            if kind == "rep":
                b.base(x, y, z)
                b.set((x, y, z), "minecraft:repeater",
                      {"delay": str(val), "facing": FACING_OF_INPUT[(dd, 0)], "locked": "false", "powered": "false"})
            else:
                keys = slots[val][1]
                if lane < len(keys):
                    inst, n = keys[lane]
                    b.base(x, y, z, INSTRUMENTS[inst][0])
                    b.set((x, y, z), "minecraft:note_block", {"instrument": inst, "note": str(n), "powered": "false"})
                    b.notes_at.append(((x, y, z), slots[val][0]))
                else:
                    b.base(x, y, z)
                    b.set((x, y, z), "minecraft:stone")
        # 折り返し（レッドストーンの階段、遅れ 0）
        for r, dd, last_x in turns:
            y, z0, z1 = hy(r), zs(lane, r), zs(lane, r + 1)
            xe = last_x + dd
            path = [(xe + dd * k, y + k, z0) for k in range(4)]
            xt = xe + dd * 3
            path.append((xt, y + 3, z1))
            path += [(xt - dd * k, y + 3, z1) for k in range(1, 4)]
            for p in path:
                b.base(*p)
                b.set(p, "minecraft:redstone_wire", {})

    # 頭（全レーン同時スタートのための遅れ合わせ）とスタート線
    trig_x, head = -6, 5
    lane_z = [zs(l, 0) for l in range(lanes)]
    zmax = max(lane_z)
    trig_delay = {}
    delay, strength = 0, 15
    for z in range(0, zmax + 1):
        if strength <= 2 and z % 3 != 0 and z != zmax:
            b.base(trig_x, 2, z)
            b.set((trig_x, 2, z), "minecraft:repeater", {"delay": "1", "facing": "north", "locked": "false", "powered": "false"})
            delay += 1
            strength = 16
        else:
            b.base(trig_x, 2, z)
            b.set((trig_x, 2, z), "minecraft:redstone_wire", {})
        strength -= 1
        trig_delay[z] = delay
    maxd = max(trig_delay[z] for z in lane_z)
    if maxd > head * 4 - head:
        sys.exit("レーンが多すぎます。--max-lanes を減らしてください。")
    for z in lane_z:
        total = head + (maxd - trig_delay[z])
        base, extra = divmod(total, head)
        for i in range(head):
            x = -head + i
            b.base(x, 2, z)
            b.set((x, 2, z), "minecraft:repeater",
                  {"delay": str(base + (1 if i < extra else 0)), "facing": "west", "locked": "false", "powered": "false"})
    b.base(trig_x, 2, -1)
    b.set((trig_x, 2, -1), button, {"face": "floor", "facing": "north", "powered": "false"})
    fix_wire_shapes(b)
    return b, lanes


SOLID_EXCEPT = {"minecraft:redstone_wire", "minecraft:repeater", "minecraft:stone_button", "minecraft:air", "minecraft:glass"}


def _solid(b, p):
    blk = b.blocks.get(p)
    return blk is not None and blk[0] not in SOLID_EXCEPT and not blk[0].endswith("_button")


def fix_wire_shapes(b: Build):
    """設計図の貼り付けでは形が更新されないことがあるので、ダストのつながりを計算して入れておく。"""
    dirs = {"north": (0, -1), "south": (0, 1), "west": (-1, 0), "east": (1, 0)}
    opp = {"north": "south", "south": "north", "west": "east", "east": "west"}
    for p, (name, props) in list(b.blocks.items()):
        if name != "minecraft:redstone_wire":
            continue
        x, y, z = p
        con = {}
        for dn, (dx, dz) in dirs.items():
            q = (x + dx, y, z + dz)
            nb = b.blocks.get(q)
            v = "none"
            if nb:
                if nb[0] == "minecraft:redstone_wire" or nb[0].endswith("_button") or nb[0] == "minecraft:lever":
                    v = "side"
                elif nb[0] == "minecraft:repeater" and nb[1]["facing"] in (dn, opp[dn]):
                    v = "side"
            up = (x + dx, y + 1, z + dz)
            if v == "none" and b.blocks.get(up, ("",))[0] == "minecraft:redstone_wire" and not _solid(b, (x, y + 1, z)):
                v = "up"
            down = (x + dx, y - 1, z + dz)
            if v == "none" and b.blocks.get(down, ("",))[0] == "minecraft:redstone_wire" and not _solid(b, q):
                v = "side"
            con[dn] = v
        used = [k for k, v in con.items() if v != "none"]
        if len(used) == 0:
            con = {k: "side" for k in con}
        elif len(used) == 1:
            o = opp[used[0]]
            con[o] = "side"
        props.update(con)
        props["power"] = "0"


# ---------------------------------------------------------------------------
# 書き出し: NBT
# ---------------------------------------------------------------------------
class NBT:
    END, BYTE, SHORT, INT, LONG, FLOAT, DOUBLE, BYTE_ARRAY, STRING, LIST, COMPOUND, INT_ARRAY, LONG_ARRAY = range(13)


class Tag:
    def __init__(self, t, v, elem=None):
        self.t, self.v, self.elem = t, v, elem


def _w_payload(o: io.BytesIO, t, v, elem=None):
    if t == NBT.BYTE:
        o.write(struct.pack(">b", v))
    elif t == NBT.SHORT:
        o.write(struct.pack(">h", v))
    elif t == NBT.INT:
        o.write(struct.pack(">i", v))
    elif t == NBT.LONG:
        o.write(struct.pack(">q", v))
    elif t == NBT.BYTE_ARRAY:
        o.write(struct.pack(">i", len(v))); o.write(bytes(v))
    elif t == NBT.STRING:
        s = v.encode("utf-8"); o.write(struct.pack(">H", len(s))); o.write(s)
    elif t == NBT.LIST:
        o.write(struct.pack(">bi", elem if v else NBT.END, len(v)))
        for it in v:
            _w_payload(o, it.t, it.v, it.elem)
    elif t == NBT.COMPOUND:
        for k, it in v.items():
            o.write(struct.pack(">b", it.t)); _w_payload(o, NBT.STRING, k); _w_payload(o, it.t, it.v, it.elem)
        o.write(b"\x00")
    elif t == NBT.INT_ARRAY:
        o.write(struct.pack(">i", len(v))); o.write(struct.pack(f">{len(v)}i", *v))
    elif t == NBT.LONG_ARRAY:
        o.write(struct.pack(">i", len(v))); o.write(struct.pack(f">{len(v)}q", *v))


def write_nbt_gz(path, root: dict, name=""):
    o = io.BytesIO()
    o.write(struct.pack(">b", NBT.COMPOUND)); _w_payload(o, NBT.STRING, name); _w_payload(o, NBT.COMPOUND, root)
    with gzip.open(path, "wb") as f:
        f.write(o.getvalue())


C = lambda d: Tag(NBT.COMPOUND, d)
S = lambda s: Tag(NBT.STRING, s)
I = lambda i: Tag(NBT.INT, i)
L = lambda i: Tag(NBT.LONG, i)


def state_str(name, props):
    if not props:
        return name
    return name + "[" + ",".join(f"{k}={v}" for k, v in sorted(props.items())) + "]"


def normalized(b: Build):
    xs = [p[0] for p in b.blocks]; ys = [p[1] for p in b.blocks]; zs_ = [p[2] for p in b.blocks]
    mn = (min(xs), min(ys), min(zs_))
    size = (max(xs) - mn[0] + 1, max(ys) - mn[1] + 1, max(zs_) - mn[2] + 1)
    return mn, size


def write_litematic(path, b: Build, name, author, desc, data_version):
    mn, (sx, sy, sz) = normalized(b)
    palette = [("minecraft:air", {})]
    index = {state_str("minecraft:air", {}): 0}
    vol = sx * sy * sz
    arr = [0] * vol
    for (x, y, z), (bn, props) in b.blocks.items():
        key = state_str(bn, props)
        if key not in index:
            index[key] = len(palette); palette.append((bn, props))
        arr[((y - mn[1]) * sz + (z - mn[2])) * sx + (x - mn[0])] = index[key]
    bits = max(2, (len(palette) - 1).bit_length())
    nlongs = (vol * bits + 63) // 64
    longs = [0] * nlongs
    for i, v in enumerate(arr):
        if not v:
            continue
        bit = i * bits
        li, off = divmod(bit, 64)
        longs[li] |= (v << off) & ((1 << 64) - 1)
        if off + bits > 64:
            longs[li + 1] |= v >> (64 - off)
    longs = [l - (1 << 64) if l >= (1 << 63) else l for l in longs]
    pal_tags = []
    for bn, props in palette:
        d = {"Name": S(bn)}
        if props:
            d["Properties"] = C({k: S(str(v)) for k, v in props.items()})
        pal_tags.append(C(d))
    now = int(time.time() * 1000)
    total = sum(1 for v in arr if v)
    region = {
        "Position": C({"x": I(0), "y": I(0), "z": I(0)}),
        "Size": C({"x": I(sx), "y": I(sy), "z": I(sz)}),
        "BlockStatePalette": Tag(NBT.LIST, pal_tags, NBT.COMPOUND),
        "BlockStates": Tag(NBT.LONG_ARRAY, longs),
        "TileEntities": Tag(NBT.LIST, [], NBT.COMPOUND),
        "Entities": Tag(NBT.LIST, [], NBT.COMPOUND),
        "PendingBlockTicks": Tag(NBT.LIST, [], NBT.COMPOUND),
        "PendingFluidTicks": Tag(NBT.LIST, [], NBT.COMPOUND),
    }
    root = {
        "Version": I(7 if data_version >= 3837 else 6),  # Litematica は 1.20.5 から形式 7
        "SubVersion": I(1),
        "MinecraftDataVersion": I(data_version),
        "Metadata": C({
            "Name": S(name), "Author": S(author), "Description": S(desc),
            "RegionCount": I(1), "TotalBlocks": I(total), "TotalVolume": I(vol),
            "TimeCreated": L(now), "TimeModified": L(now),
            "EnclosingSize": C({"x": I(sx), "y": I(sy), "z": I(sz)}),
        }),
        "Regions": C({name[:40] or "song": C(region)}),
    }
    write_nbt_gz(path, root)


def write_schem(path, b: Build, data_version):
    mn, (sx, sy, sz) = normalized(b)
    pal = {"minecraft:air": 0}
    data = bytearray()
    grid = {}
    for (x, y, z), (bn, props) in b.blocks.items():
        k = state_str(bn, props)
        if k not in pal:
            pal[k] = len(pal)
        grid[(x - mn[0], y - mn[1], z - mn[2])] = pal[k]
    for y in range(sy):
        for z in range(sz):
            for x in range(sx):
                v = grid.get((x, y, z), 0)
                while True:
                    byte = v & 0x7F
                    v >>= 7
                    if v:
                        data.append(byte | 0x80)
                    else:
                        data.append(byte); break
    root = {
        "Version": I(2),
        "DataVersion": I(data_version),
        "Width": Tag(NBT.SHORT, sx), "Height": Tag(NBT.SHORT, sy), "Length": Tag(NBT.SHORT, sz),
        "Offset": Tag(NBT.INT_ARRAY, [0, 0, 0]),
        "PaletteMax": I(len(pal)),
        "Palette": C({k: I(v) for k, v in pal.items()}),
        "BlockData": Tag(NBT.BYTE_ARRAY, list(data)),
        "BlockEntities": Tag(NBT.LIST, [], NBT.COMPOUND),
    }
    write_nbt_gz(path, root, "Schematic")


def write_nbs(path, slots, name):
    def ws(o, s):
        e = s.encode("utf-8"); o.write(struct.pack("<i", len(e))); o.write(e)
    o = io.BytesIO()
    length = slots[-1][0] + 1
    layers = max(len(s[1]) for s in slots)
    o.write(struct.pack("<hbbhh", 0, 5, 16, length, layers))
    ws(o, name); ws(o, "oto2noteblock"); ws(o, ""); ws(o, "")
    o.write(struct.pack("<hbbb", 1000, 0, 10, 4))
    o.write(struct.pack("<iiiii", 0, 0, 0, 0, 0))
    ws(o, "")
    o.write(struct.pack("<bbh", 0, 0, 0))
    prev = -1
    for t, keys in slots:
        o.write(struct.pack("<h", t - prev)); prev = t
        for li, (inst, n) in enumerate(keys):
            o.write(struct.pack("<h", 1))
            o.write(struct.pack("<BBBBh", INSTRUMENTS[inst][2], n + 33, 100, 100, 0))
        o.write(struct.pack("<h", 0))
    o.write(struct.pack("<h", 0))
    for i in range(layers):
        ws(o, f"Lane {i + 1}"); o.write(struct.pack("<bbB", 0, 100, 100))
    o.write(struct.pack("<b", 0))
    with open(path, "wb") as f:
        f.write(o.getvalue())


def place_order(b: Build):
    """下から順に、部品は土台の後に置く（重力ブロックが落ちない・形が崩れない順）。"""
    comp = {"minecraft:redstone_wire", "minecraft:repeater", "minecraft:note_block"}
    items = sorted(b.blocks.items(), key=lambda kv: (kv[0][1], kv[1][0] in comp or kv[1][0].endswith("_button"), kv[0][0], kv[0][2]))
    return items


def write_mcfunction(path, b: Build):
    mn, _ = normalized(b)
    with open(path, "w", encoding="utf-8") as f:
        f.write("# 実行した人の足元を設計図の角として設置します（x+ 方向へ伸びます）\n")
        for (x, y, z), (bn, props) in place_order(b):
            f.write(f"setblock ~{x - mn[0]} ~{y - mn[1]} ~{z - mn[2]} {state_str(bn, props)}\n")


# ---------------------------------------------------------------------------
# RCON
# ---------------------------------------------------------------------------
class Rcon:
    def __init__(self, host, port, password):
        self.s = socket.create_connection((host, port), timeout=10)
        self.rid = 0
        self._send(3, password)
        if self._recv()[0] == -1:
            raise SystemExit("RCON のパスワードが違います。")

    def _send(self, kind, body):
        self.rid += 1
        data = struct.pack("<ii", self.rid, kind) + body.encode("utf-8") + b"\x00\x00"
        self.s.sendall(struct.pack("<i", len(data)) + data)

    def _recv(self):
        def rd(n):
            buf = b""
            while len(buf) < n:
                chunk = self.s.recv(n - len(buf))
                if not chunk:
                    raise ConnectionError("RCON が切れました")
                buf += chunk
            return buf
        n = struct.unpack("<i", rd(4))[0]
        data = rd(n)
        rid, _ = struct.unpack("<ii", data[:8])
        return rid, data[8:-2].decode("utf-8", "replace")

    def cmd(self, c):
        self._send(2, c)
        return self._recv()[1]


def place_rcon(b: Build, rcon_addr, password, origin, keep_loaded):
    host, _, port = rcon_addr.partition(":")
    rc = Rcon(host, int(port or 25575), password)
    mn, (sx, sy, sz) = normalized(b)
    ox, oy, oz = origin
    x0, z0, x1, z1 = ox, oz, ox + sx - 1, oz + sz - 1
    # forceload は 1 回 256 チャンクまで
    chunks = []
    for cx in range(x0 >> 4, (x1 >> 4) + 1):
        for cz in range(z0 >> 4, (z1 >> 4) + 1):
            chunks.append((cx, cz))
    for cx, cz in chunks:
        rc.cmd(f"forceload add {cx * 16} {cz * 16}")
    time.sleep(1.0)
    rc.cmd(f"fill {x0} {oy} {z0} {x1} {oy + sy - 1} {z1} minecraft:air") if sx * sy * sz <= 32768 else None
    items = place_order(b)
    for i, ((x, y, z), (bn, props)) in enumerate(items):
        r = rc.cmd(f"setblock {ox + x - mn[0]} {oy + y - mn[1]} {oz + z - mn[2]} {state_str(bn, props)}")
        if i % 500 == 0:
            print(f"  設置中 {i}/{len(items)} {r.strip()[:60]}")
    if not keep_loaded:
        for cx, cz in chunks:
            rc.cmd(f"forceload remove {cx * 16} {cz * 16}")
    bx, by, bz = -6 - mn[0] + ox, 2 - mn[1] + oy, -1 - mn[2] + oz
    print(f"設置しました。スタートボタン: {bx} {by} {bz}")
    return rc, (ox - mn[0], oy - mn[1], oz - mn[2])


# ---------------------------------------------------------------------------
DATA_VERSIONS = {"26.2": 4903, "1.21.11": 4671, "1.21.4": 4189, "1.21.1": 3955, "1.20.4": 3700, "1.20.1": 3465, "1.19.4": 3337}
AUDIO_EXT = {".mp3", ".wav", ".flac", ".ogg", ".m4a", ".aac", ".opus", ".aiff", ".aif"}


def main(argv=None):
    for st in (sys.stdout, sys.stderr):
        try:
            st.reconfigure(encoding="utf-8")  # Windows のコンソール（cp932）で文字化けしないように
        except Exception:
            pass
    ap = argparse.ArgumentParser(description="音源を Minecraft の音ブロック演奏装置に変換します。")
    ap.add_argument("input", help=".mid / .midi / .nbs / 音声（mp3, wav など）")
    ap.add_argument("-o", "--out", help="出力先（拡張子なし）。既定は入力と同じ場所・同じ名前")
    ap.add_argument("--mc", default="26.2", help="Minecraft のバージョン（26.2 / 1.21.11 / 1.19.4 など、設計図のデータ版に使う）")
    ap.add_argument("--max-lanes", type=int, default=12, help="同時に鳴らす最大の音数（= レーン数）。既定 12")
    ap.add_argument("--fit-tempo", action="store_true", help="MIDI のテンポに合わせて速さを少し変え、リズムを等間隔にする")
    ap.add_argument("--speed", type=float, default=1.0, help="再生速度の倍率。0.8 で遅く、1.2 で速く")
    ap.add_argument("--row-length", type=int, default=0, help="この長さで上に折り返す（0 = 一直線）。長い曲は 64 などがおすすめ")
    ap.add_argument("--instruments", default="auto", help="auto（MIDI の音色から）/ pitch（高さだけで bass・harp・bell）/ single:harp など")
    ap.add_argument("--min-velocity", type=int, default=0, help="この強さ未満の音を捨てる（0〜127）")
    ap.add_argument("--formats", default="litematic,schem,nbs,mcfunction", help="出力する形式をカンマ区切りで")
    ap.add_argument("--onset", type=float, default=0.6, help="音声解析: 音の出だしの判定（大きいほど音が減る）")
    ap.add_argument("--frame", type=float, default=0.3, help="音声解析: 音の続きの判定")
    ap.add_argument("--min-note-ms", type=float, default=100, help="音声解析: これより短い音を捨てる（ミリ秒）")
    ap.add_argument("--rcon", help="鯖に直接設置: host:port")
    ap.add_argument("--rcon-password", default=os.environ.get("RCON_PASSWORD", ""))
    ap.add_argument("--origin", type=int, nargs=3, metavar=("X", "Y", "Z"), help="直接設置の基準座標（設計図の角）")
    ap.add_argument("--keep-loaded", action="store_true", help="直接設置後もチャンクを読み込んだままにする（遠くでも鳴らし続けたいとき）")
    args = ap.parse_args(argv)

    src = args.input
    base_out = args.out or os.path.splitext(src)[0]
    name = os.path.basename(base_out)
    ext = os.path.splitext(src)[1].lower()
    if ext in AUDIO_EXT:
        src = audio_to_midi(src, base_out + "_basicpitch.mid", args)
        ext = ".mid"
    if ext in (".mid", ".midi"):
        notes = load_midi(src, args.instruments)
        fit = suggest_speed(src)
        if fit:
            bpm, sp = fit
            if args.fit_tempo:
                args.speed = sp
                print(f"テンポ {bpm:.0f} BPM を 0.1 秒の刻みに合わせ、速さ {sp:.3f} 倍で作ります")
            elif abs(sp - args.speed) > 0.005:
                print(f"ヒント: テンポ {bpm:.0f} BPM は 0.1 秒の刻みに合わずリズムが少しよれます。"
                      f"--fit-tempo（速さ {sp:.3f} 倍）で等間隔になります")
    elif ext == ".nbs":
        notes = load_nbs(src)
    else:
        sys.exit(f"対応していない形式です: {ext}")

    slots, dropped = quantize(notes, args.speed, args.max_lanes, args.min_velocity)
    dv = DATA_VERSIONS.get(args.mc)
    if dv is None:
        sys.exit(f"--mc は {', '.join(DATA_VERSIONS)} のどれかにしてください")
    b, lanes = build_device(slots, args.row_length or None)
    mn, size = normalized(b)
    secs = slots[-1][0] / 10
    print(f"音符 {sum(len(s[1]) for s in slots)} 個 / 長さ {secs:.1f} 秒 / レーン {lanes} 本 / 大きさ {size[0]}×{size[1]}×{size[2]}（横×高さ×奥）")
    if dropped:
        print(f"  同時発音が多すぎて {dropped} 音を省きました（--max-lanes で増やせます）")
    fmts = set(args.formats.split(","))
    desc = f"{secs:.0f}秒 / {lanes}レーン / スタートボタンは x=0 側の手前"
    outs = []
    if "litematic" in fmts:
        write_litematic(base_out + ".litematic", b, name, "oto2noteblock", desc, dv); outs.append(base_out + ".litematic")
    if "schem" in fmts:
        write_schem(base_out + ".schem", b, dv); outs.append(base_out + ".schem")
    if "nbs" in fmts:
        write_nbs(base_out + ".nbs", slots, name); outs.append(base_out + ".nbs")
    if "mcfunction" in fmts:
        write_mcfunction(base_out + "_place.mcfunction", b); outs.append(base_out + "_place.mcfunction")
    for p in outs:
        print("書き出し:", p)
    if args.rcon:
        if not args.origin:
            sys.exit("--rcon を使うときは --origin X Y Z も指定してください")
        place_rcon(b, args.rcon, args.rcon_password, args.origin, args.keep_loaded)
    return b, slots


if __name__ == "__main__":
    main()
