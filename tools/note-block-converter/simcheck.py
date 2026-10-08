"""装置の簡易レッドストーン試算: ボタンを押してから各音ブロックが鳴るまでの時間を計算し、
曲の予定どおりか確かめる（開発用）。使い方: python simcheck.py 曲.mid [oto2noteblock と同じオプション]"""
import heapq
import sys

import oto2noteblock as o

DIRS6 = [(1, 0, 0), (-1, 0, 0), (0, 1, 0), (0, -1, 0), (0, 0, 1), (0, 0, -1)]
H = {"north": (0, 0, -1), "south": (0, 0, 1), "west": (-1, 0, 0), "east": (1, 0, 0)}


def add(a, b):
    return (a[0] + b[0], a[1] + b[1], a[2] + b[2])


def simulate(b):
    blk = b.blocks
    name = lambda p: blk.get(p, ("minecraft:air", {}))[0]
    props = lambda p: blk.get(p, ("", {}))[1]
    solid = lambda p: o._solid(b, p)

    def wire_links(p):
        x, y, z = p
        out = []
        for dn, (dx, _, dz) in H.items():
            v = props(p).get(dn, "none")
            if v == "none":
                continue
            for dy in (0, 1, -1):
                q = (x + dx, y + dy, z + dz)
                if name(q) == "minecraft:redstone_wire":
                    out.append(q)
        return out

    def wire_points(p):
        pr = props(p)
        ds = [H[d] for d in H if pr.get(d, "none") != "none"]
        return ds or list(H.values())

    best = {}
    pq = []

    def push(t, kind, p):
        if (kind, p) not in best or best[(kind, p)] > t:
            best[(kind, p)] = t
            heapq.heappush(pq, (t, kind, p))

    for p, (n, _) in blk.items():
        if n.endswith("_button"):
            push(0, "src", p)
    while pq:
        t, kind, p = heapq.heappop(pq)
        if best[(kind, p)] < t:
            continue
        if kind == "src":  # ボタン: 隣と下の部品を動かす
            for d in DIRS6:
                q = add(p, d)
                if name(q) == "minecraft:redstone_wire":
                    push(t, "wire", q)
        elif kind == "wire":
            for q in wire_links(p):
                push(t, "wire", q)
            for d in wire_points(p) + [(0, -1, 0)]:
                q = add(p, d)
                if name(q) == "minecraft:repeater" and add(q, H[props(q)["facing"]]) == p:
                    push(t, "rep_in", q)
                elif name(q) == "minecraft:note_block":
                    push(t, "note", q)
                if solid(q):
                    push(t, "weak", q)
        elif kind == "rep_in":
            push(t + int(props(p)["delay"]), "rep_out", p)
        elif kind == "rep_out":
            f = H[props(p)["facing"]]
            q = (p[0] - f[0], p[1] - f[1], p[2] - f[2])
            n = name(q)
            if n == "minecraft:redstone_wire":
                push(t, "wire", q)
            elif n == "minecraft:repeater" and add(q, H[props(q)["facing"]]) == p:
                push(t, "rep_in", q)
            elif solid(q):
                push(t, "strong", q)
                if n == "minecraft:note_block":
                    push(t, "note", q)
        elif kind in ("strong", "weak"):
            for d in DIRS6:
                q = add(p, d)
                n = name(q)
                if n == "minecraft:repeater" and add(q, H[props(q)["facing"]]) == p:
                    push(t, "rep_in", q)
                elif n == "minecraft:note_block":
                    push(t, "note", q)
                elif n == "minecraft:redstone_wire" and kind == "strong":
                    push(t, "wire", q)
    return {p: t for (k, p), t in best.items() if k == "note"}


def check(b):
    got = simulate(b)
    exp = dict(b.notes_at)
    offs = {got.get(p, None) - t for p, t in exp.items() if p in got}
    missing = [p for p in exp if p not in got]
    extra = [p for p in got if p not in exp]
    print(f"音ブロック {len(exp)} 個 / 鳴らない {len(missing)} / ずれの種類 {sorted(offs)} / 予定外 {len(extra)}")
    return not missing and len(offs) == 1 and not extra


if __name__ == "__main__":
    b, _ = o.main(sys.argv[1:] + ["--formats", ""])
    sys.exit(0 if check(b) else 1)
