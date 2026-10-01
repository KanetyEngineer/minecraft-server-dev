"""Minimal NBT (Named Binary Tag) writer/reader.

Blender 同梱の Python には nbtlib などが入っていないため、.litematic の
読み書きに必要な分だけを自前で実装している。Python の値と NBT 型の対応:

    Byte/Short/Int/Long/Float/Double  -> 下のラッパークラス
    str                               -> TAG_String
    dict                              -> TAG_Compound
    List([...], elem_type)            -> TAG_List
    IntArray / LongArray              -> TAG_Int_Array / TAG_Long_Array
"""

import gzip
import io
import struct

TAG_END, TAG_BYTE, TAG_SHORT, TAG_INT, TAG_LONG = 0, 1, 2, 3, 4
TAG_FLOAT, TAG_DOUBLE, TAG_BYTE_ARRAY, TAG_STRING = 5, 6, 7, 8
TAG_LIST, TAG_COMPOUND, TAG_INT_ARRAY, TAG_LONG_ARRAY = 9, 10, 11, 12


class _Num:
    __slots__ = ("value",)
    tag = None
    fmt = None

    def __init__(self, value):
        self.value = value

    def __eq__(self, other):
        return type(self) is type(other) and self.value == other.value

    def __repr__(self):
        return f"{type(self).__name__}({self.value!r})"


class Byte(_Num):
    tag, fmt = TAG_BYTE, ">b"


class Short(_Num):
    tag, fmt = TAG_SHORT, ">h"


class Int(_Num):
    tag, fmt = TAG_INT, ">i"


class Long(_Num):
    tag, fmt = TAG_LONG, ">q"


class Float(_Num):
    tag, fmt = TAG_FLOAT, ">f"


class Double(_Num):
    tag, fmt = TAG_DOUBLE, ">d"


class IntArray(list):
    tag = TAG_INT_ARRAY


class LongArray(list):
    tag = TAG_LONG_ARRAY


class List(list):
    """TAG_List. 空リストでも型が必要なので elem_type を持つ。"""

    tag = TAG_LIST

    def __init__(self, items=(), elem_type=None):
        super().__init__(items)
        if elem_type is None:
            elem_type = _tag_of(self[0]) if len(self) else TAG_END
        self.elem_type = elem_type


_NUM_BY_TAG = {c.tag: c for c in (Byte, Short, Int, Long, Float, Double)}


def _tag_of(value):
    if isinstance(value, _Num):
        return value.tag
    if isinstance(value, str):
        return TAG_STRING
    if isinstance(value, dict):
        return TAG_COMPOUND
    if isinstance(value, (List, IntArray, LongArray)):
        return value.tag
    if isinstance(value, (bytes, bytearray)):
        return TAG_BYTE_ARRAY
    raise TypeError(f"NBT に変換できない値です: {type(value).__name__}")


def _write_str(out, s):
    data = s.encode("utf-8")
    out.write(struct.pack(">H", len(data)))
    out.write(data)


def _write_payload(out, tag, value):
    if tag in _NUM_BY_TAG:
        out.write(struct.pack(_NUM_BY_TAG[tag].fmt, value.value))
    elif tag == TAG_STRING:
        _write_str(out, value)
    elif tag == TAG_BYTE_ARRAY:
        out.write(struct.pack(">i", len(value)))
        out.write(bytes(value))
    elif tag == TAG_INT_ARRAY:
        out.write(struct.pack(f">i{len(value)}i", len(value), *value))
    elif tag == TAG_LONG_ARRAY:
        out.write(struct.pack(f">i{len(value)}q", len(value), *value))
    elif tag == TAG_LIST:
        out.write(struct.pack(">bi", value.elem_type, len(value)))
        for item in value:
            _write_payload(out, value.elem_type, item)
    elif tag == TAG_COMPOUND:
        for key, item in value.items():
            t = _tag_of(item)
            out.write(struct.pack(">b", t))
            _write_str(out, key)
            _write_payload(out, t, item)
        out.write(b"\x00")
    else:
        raise ValueError(tag)


def dumps(root, name="", compress=True):
    out = io.BytesIO()
    out.write(struct.pack(">b", TAG_COMPOUND))
    _write_str(out, name)
    _write_payload(out, TAG_COMPOUND, root)
    data = out.getvalue()
    return gzip.compress(data) if compress else data


def save(path, root, name=""):
    with open(path, "wb") as f:
        f.write(dumps(root, name))


# --- reader (テストと既存ファイルの確認用) ---------------------------------

def _read(fmt, buf, pos):
    size = struct.calcsize(fmt)
    return struct.unpack_from(fmt, buf, pos), pos + size


def _read_str(buf, pos):
    (n,), pos = _read(">H", buf, pos)
    return buf[pos:pos + n].decode("utf-8"), pos + n


def _read_payload(buf, pos, tag):
    if tag in _NUM_BY_TAG:
        cls = _NUM_BY_TAG[tag]
        (v,), pos = _read(cls.fmt, buf, pos)
        return cls(v), pos
    if tag == TAG_STRING:
        return _read_str(buf, pos)
    if tag == TAG_BYTE_ARRAY:
        (n,), pos = _read(">i", buf, pos)
        return bytes(buf[pos:pos + n]), pos + n
    if tag == TAG_INT_ARRAY:
        (n,), pos = _read(">i", buf, pos)
        vals, pos = _read(f">{n}i", buf, pos)
        return IntArray(vals), pos
    if tag == TAG_LONG_ARRAY:
        (n,), pos = _read(">i", buf, pos)
        vals, pos = _read(f">{n}q", buf, pos)
        return LongArray(vals), pos
    if tag == TAG_LIST:
        (et, n), pos = _read(">bi", buf, pos)
        items = []
        for _ in range(n):
            v, pos = _read_payload(buf, pos, et)
            items.append(v)
        return List(items, et), pos
    if tag == TAG_COMPOUND:
        result = {}
        while True:
            (t,), pos = _read(">b", buf, pos)
            if t == TAG_END:
                return result, pos
            key, pos = _read_str(buf, pos)
            result[key], pos = _read_payload(buf, pos, t)
    raise ValueError(f"未知の NBT タグ {tag}")


def loads(data):
    if data[:2] == b"\x1f\x8b":
        data = gzip.decompress(data)
    (t,), pos = _read(">b", data, 0)
    if t != TAG_COMPOUND:
        raise ValueError("ルートが Compound ではありません")
    _, pos = _read_str(data, pos)
    root, _ = _read_payload(data, pos, TAG_COMPOUND)
    return root


def load(path):
    with open(path, "rb") as f:
        return loads(f.read())
