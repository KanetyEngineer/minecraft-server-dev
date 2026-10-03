"""Voxel-aware command builder: emits fill/setblock commands and keeps a numpy model for previews."""
import json
import math
import numpy as np

XMIN, XMAX = -112, 112
ZMIN, ZMAX = -160, 112
YMIN, YMAX = 50, 125
MAX_FILL = 32768


def T(text, color=None, bold=False, italic=None, extra=None):
    d = {"text": text}
    if color:
        d["color"] = color
    if bold:
        d["bold"] = True
    if italic is not None:
        d["italic"] = italic
    if extra:
        d.update(extra)
    return json.dumps(d, ensure_ascii=False)


def J(obj):
    return json.dumps(obj, ensure_ascii=False)


class Builder:
    def __init__(self):
        self.stages = {}
        self.order = []
        self.cur = None
        self.palette = ["air"]
        self.pidx = {"air": 0}
        self.vox = np.zeros((XMAX - XMIN + 1, YMAX - YMIN + 1, ZMAX - ZMIN + 1), dtype=np.uint16)
        self.labels = []  # (x, z, text) for preview

    # ---- stage handling
    def stage(self, name):
        if name not in self.stages:
            self.stages[name] = []
            self.order.append(name)
        self.cur = name

    def cmd(self, c):
        self.stages[self.cur].append(c)

    def label(self, x, z, text):
        self.labels.append((x, z, text))

    # ---- voxel model
    def _pid(self, block):
        b = block.replace("minecraft:", "")
        if b not in self.pidx:
            self.pidx[b] = len(self.palette)
            self.palette.append(b)
        return self.pidx[b]

    def _sl(self, x1, y1, z1, x2, y2, z2):
        return (slice(x1 - XMIN, x2 - XMIN + 1), slice(y1 - YMIN, y2 - YMIN + 1), slice(z1 - ZMIN, z2 - ZMIN + 1))

    def get(self, x, y, z):
        return self.palette[self.vox[x - XMIN, y - YMIN, z - ZMIN]]

    # ---- primitives
    def fill(self, x1, y1, z1, x2, y2, z2, block, mode=None):
        x1, x2 = sorted((x1, x2)); y1, y2 = sorted((y1, y2)); z1, z2 = sorted((z1, z2))
        vol = (x2 - x1 + 1) * (y2 - y1 + 1) * (z2 - z1 + 1)
        if vol > MAX_FILL:
            # split along the longest axis
            dx, dy, dz = x2 - x1, y2 - y1, z2 - z1
            if dx >= dy and dx >= dz:
                m = (x1 + x2) // 2
                self.fill(x1, y1, z1, m, y2, z2, block, mode); self.fill(m + 1, y1, z1, x2, y2, z2, block, mode)
            elif dz >= dy:
                m = (z1 + z2) // 2
                self.fill(x1, y1, z1, x2, y2, m, block, mode); self.fill(x1, y1, m + 1, x2, y2, z2, block, mode)
            else:
                m = (y1 + y2) // 2
                self.fill(x1, y1, z1, x2, m, z2, block, mode); self.fill(x1, m + 1, z1, x2, y2, z2, block, mode)
            return
        if vol == 1 and mode is None:
            return self.setblock(x1, y1, z1, block)
        b = block if block.startswith("minecraft:") else "minecraft:" + block
        self.cmd(f"fill {x1} {y1} {z1} {x2} {y2} {z2} {b}" + (f" {mode}" if mode else ""))
        pid = self._pid(block)
        s = self._sl(x1, y1, z1, x2, y2, z2)
        if mode in (None, "replace", "destroy", "strict"):
            self.vox[s] = pid
        elif mode == "keep":
            v = self.vox[s]; v[v == 0] = pid
        elif mode in ("hollow", "outline"):
            inner = self._sl(x1 + 1, y1 + 1, z1 + 1, x2 - 1, y2 - 1, z2 - 1) if (x2 - x1 > 1 and y2 - y1 > 1 and z2 - z1 > 1) else None
            if inner:
                saved = self.vox[inner].copy()
            self.vox[s] = pid
            if inner:
                self.vox[inner] = 0 if mode == "hollow" else saved

    def setblock(self, x, y, z, block):
        b = block if block.startswith("minecraft:") else "minecraft:" + block
        self.cmd(f"setblock {x} {y} {z} {b}")
        self.vox[x - XMIN, y - YMIN, z - ZMIN] = self._pid(block)

    def column_fill_set(self, cells, y1, y2, block):
        """cells: set of (x,z). emits row fills along x."""
        rows = {}
        for (x, z) in cells:
            rows.setdefault(z, []).append(x)
        for z, xs in sorted(rows.items()):
            xs.sort()
            start = prev = xs[0]
            for x in xs[1:] + [None]:
                if x is not None and x == prev + 1:
                    prev = x
                    continue
                self.fill(start, y1, z, prev, y2, z, block)
                if x is not None:
                    start = prev = x

    def disk(self, cx, cz, r, y1, y2, block, ring=None):
        cells = set()
        for x in range(math.floor(cx - r), math.ceil(cx + r) + 1):
            for z in range(math.floor(cz - r), math.ceil(cz + r) + 1):
                d = math.hypot(x - cx, z - cz)
                if d <= r and (ring is None or d > r - ring):
                    cells.add((x, z))
        self.column_fill_set(cells, y1, y2, block)
        return cells

    def door(self, x, y, z, kind, facing, hinge="left", open_=False):
        o = "true" if open_ else "false"
        self.setblock(x, y, z, f"{kind}[facing={facing},half=lower,hinge={hinge},open={o}]")
        self.setblock(x, y + 1, z, f"{kind}[facing={facing},half=upper,hinge={hinge},open={o}]")

    def bed(self, x, y, z, color, facing):
        dx, dz = {"north": (0, -1), "south": (0, 1), "east": (1, 0), "west": (-1, 0)}[facing]
        self.setblock(x, y, z, f"{color}_bed[facing={facing},part=foot]")
        self.setblock(x + dx, y, z + dz, f"{color}_bed[facing={facing},part=head]")

    def fence_line(self, x1, z1, x2, z2, y, kind="dark_oak_fence", h=1):
        """straight fence line along x or z with explicit connections"""
        if x1 == x2:
            z1, z2 = sorted((z1, z2))
            for yy in range(y, y + h):
                if z2 > z1:
                    self.fill(x1, yy, z1 + 1, x2, yy, z2 - 1, f"{kind}[north=true,south=true]")
                self.setblock(x1, yy, z1, f"{kind}[south=true]" if z2 > z1 else kind)
                if z2 > z1:
                    self.setblock(x1, yy, z2, f"{kind}[north=true]")
        else:
            x1, x2 = sorted((x1, x2))
            for yy in range(y, y + h):
                if x2 > x1:
                    self.fill(x1 + 1, yy, z1, x2 - 1, yy, z2, f"{kind}[east=true,west=true]")
                self.setblock(x1, yy, z1, f"{kind}[east=true]" if x2 > x1 else kind)
                if x2 > x1:
                    self.setblock(x2, yy, z1, f"{kind}[west=true]")

    def gable_roof(self, x1, x2, z1, z2, ybase, stair, solid, slab):
        """roof ridge along x; z1<z2 are the overhang rows."""
        k = 0
        while True:
            zs, zn = z2 - k, z1 + k
            y = ybase + k
            if zs < zn:
                break
            if zs == zn:
                self.fill(x1, y, zs, x2, y, zs, f"{slab}[type=bottom]")
                break
            self.fill(x1, y, zs, x2, y, zs, f"{stair}[facing=north,half=bottom]")
            self.fill(x1, y, zn, x2, y, zn, f"{stair}[facing=south,half=bottom]")
            if k >= 2:
                self.fill(x1 + 1, y - 1, zs, x2 - 1, y - 1, zs, solid)
                self.fill(x1 + 1, y - 1, zn, x2 - 1, y - 1, zn, solid)
            # gable end walls
            if zs - zn >= 2 and k >= 1:
                self.fill(x1 + 1, y, zn + 1, x1 + 1, y, zs - 1, solid)
                self.fill(x2 - 1, y, zn + 1, x2 - 1, y, zs - 1, solid)
            k += 1
        return ybase + k

    def fillbiome(self, x1, y1, z1, x2, y2, z2, biome):
        x1, x2 = sorted((x1, x2)); y1, y2 = sorted((y1, y2)); z1, z2 = sorted((z1, z2))
        area = (x2 - x1 + 1) * (z2 - z1 + 1)
        dy = max(4, (MAX_FILL // area) // 4 * 4)
        y = y1
        while y <= y2:
            ye = min(y2, y + dy - 1)
            self.cmd(f"fillbiome {x1} {y} {z1} {x2} {ye} {z2} minecraft:{biome}")
            y = ye + 1
