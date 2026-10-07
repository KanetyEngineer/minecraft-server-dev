"""実際の鯖で確かめる（開発用）: RCON で装置を置き、各音ブロックが鳴ったゲームティックを記録して予定と比べる。

前もって鯖のワールドに記録用データパックを入れておく必要があるので、手順は 2 段階:
  1) python ingame_test.py prepare 曲.mid --world <鯖のworldフォルダ> --origin X Y Z [--pack-format N] [変換オプション]
     （1.19.4 は --pack-format 12）
     → world/datapacks/nbtest を書く。鯖を起動（起動中なら /reload）。
     /datapack list で nbtest が無効なら /datapack enable "file/nbtest"。
  2) python ingame_test.py run 曲.mid --rcon 127.0.0.1:25616 --rcon-password PW --origin X Y Z [変換オプション]
     → 設置・スタート・記録の読み出し・判定。
"""
import json
import os
import sys
import time

import oto2noteblock as o


def build(args_rest, origin):
    b, slots = o.main(args_rest + ["--formats", ""])
    mn, _ = o.normalized(b)
    ox, oy, oz = origin
    world = lambda p: (ox + p[0] - mn[0], oy + p[1] - mn[1], oz + p[2] - mn[2])
    return b, slots, world


def main():
    mode = sys.argv[1]
    rest = sys.argv[2:]
    def take(flag, n=1):
        i = rest.index(flag)
        v = rest[i + 1:i + 1 + n]
        del rest[i:i + 1 + n]
        return v if n > 1 else v[0]
    origin = tuple(int(v) for v in take("--origin", 3))
    if mode == "prepare":
        wdir = take("--world")
        fmt = int(take("--pack-format")) if "--pack-format" in rest else 99
        b, slots, world = build(rest, origin)
        d = os.path.join(wdir, "datapacks", "nbtest")
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, "pack.mcmeta"), "w") as f:
            json.dump({"pack": {"description": "note block timing test", "pack_format": fmt, "min_format": 1, "max_format": 999, "supported_formats": [1, 999]}}, f)
        lines = ["scoreboard objectives add nb dummy\n"]
        for i, (p, _) in enumerate(b.notes_at):
            x, y, z = world(p)
            lines.append(f"execute unless score #n{i} nb matches 0.. if block {x} {y} {z} minecraft:note_block[powered=true] "
                         f"store result score #n{i} nb run time query gametime\n")
        # 1.21 からフォルダ名が単数形になったので両方に置く
        for fn, tg in (("function", "function"), ("functions", "functions")):
            os.makedirs(os.path.join(d, "data", "nbtest", fn), exist_ok=True)
            os.makedirs(os.path.join(d, "data", "minecraft", "tags", tg), exist_ok=True)
            with open(os.path.join(d, "data", "minecraft", "tags", tg, "tick.json"), "w") as f:
                json.dump({"values": ["nbtest:tick"]}, f)
            with open(os.path.join(d, "data", "nbtest", fn, "tick.mcfunction"), "w") as f:
                f.writelines(lines)
        print("データパックを書きました:", d)
        return
    rcon = take("--rcon"); pw = take("--rcon-password")
    b, slots, world = build(rest, origin)
    rc, _ = o.place_rcon(b, rcon, pw, origin, keep_loaded=True)
    rc.cmd("scoreboard objectives add nb dummy")
    rc.cmd("scoreboard players reset * nb")
    time.sleep(2)
    bx, by, bz = world((-6, 2, -1))
    rc.cmd(f"setblock {bx} {by} {bz} minecraft:redstone_block")
    secs = slots[-1][0] / 10
    print(f"演奏中… {secs:.1f} 秒")
    time.sleep(secs + 5)
    res = []
    for i, (p, t) in enumerate(b.notes_at):
        r = rc.cmd(f"scoreboard players get #n{i} nb")
        try:
            g = int(r.strip().split(" has ")[1].split(" ")[0])
        except Exception:
            g = None
        res.append((t, g))
    ok = [(t, g) for t, g in res if g is not None]
    offs = sorted({g - 2 * t for t, g in ok})
    print(f"音ブロック {len(res)} 個 / 鳴った {len(ok)} / ずれ（ゲームティック）の種類 {offs[:10]}")
    for t, g in res[:5]:
        print("  予定", t, "実際", g)
    rc.cmd(f"setblock {bx} {by} {bz} minecraft:air")
    sys.exit(0 if len(ok) == len(res) and len(offs) == 1 else 1)


if __name__ == "__main__":
    main()
