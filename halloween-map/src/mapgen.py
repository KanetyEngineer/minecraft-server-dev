"""Builds the Halloween map geometry. Every zone is a separate build stage (one mcfunction)."""
import math
import random
from builder import Builder, T, J

G = 63  # ground surface block y (players stand at y=64)
P = {}  # positions shared with game logic
ENT = {}  # stage -> list of summon commands for permanent entities (placed after blocks)

rng = random.Random(20261031)


def ent(b, c):
    b.cmd(c)


def text_display(b, x, y, z, comp, scale=1.0, billboard="center", bg=0x00000000, yaw=None, tags=("hw.deco",), line_width=200):
    tag = ",".join(f'"{t}"' for t in tags)
    rot = f",Rotation:[{yaw}f,0f]" if yaw is not None else ""
    s = f"{scale}f"
    b.cmd(
        f"summon minecraft:text_display {x} {y} {z} {{text:{comp},billboard:\"{billboard}\",background:{bg},shadow:1b,"
        f"line_width:{line_width},see_through:0b,brightness:{{sky:15,block:15}},"
        f"transformation:{{left_rotation:[0f,0f,0f,1f],right_rotation:[0f,0f,0f,1f],translation:[0f,0f,0f],scale:[{s},{s},{s}]}},"
        f"Tags:[{tag}]{rot}}}"
    )


def item_display(b, x, y, z, item, scale=0.6, tags=("hw.deco",), billboard="vertical", extra=""):
    tag = ",".join(f'"{t}"' for t in tags)
    s = f"{scale}f"
    b.cmd(
        f"summon minecraft:item_display {x} {y} {z} {{item:{{id:\"minecraft:{item}\",count:1}},billboard:\"{billboard}\","
        f"brightness:{{sky:15,block:15}},"
        f"transformation:{{left_rotation:[0f,0f,0f,1f],right_rotation:[0f,0f,0f,1f],translation:[0f,0f,0f],scale:[{s},{s},{s}]}},"
        f"Tags:[{tag}]{extra}}}"
    )


def interaction(b, x, y, z, w, h, tags, ident=None):
    tag = ",".join(f'"{t}"' for t in ("hw.click",) + tuple(tags))
    b.cmd(f"summon minecraft:interaction {x} {y} {z} {{width:{w}f,height:{h}f,response:1b,Tags:[{tag},\"hw.new\"]}}")
    if ident is not None:
        b.cmd(f"scoreboard players set @e[type=minecraft:interaction,tag=hw.new,limit=1] hw.id {ident}")
    b.cmd("tag @e[type=minecraft:interaction,tag=hw.new] remove hw.new")


def lamp_post(b, x, z, h=3):
    b.fill(x, G + 1, z, x, G + h, z, "dark_oak_fence")
    b.setblock(x, G + h + 1, z, "jack_o_lantern[facing=south]")


# --------------------------------------------------------------------------------------------
def ground(b):
    b.stage("build/ground")
    b.fill(-20, 60, -20, 20, 72, 20, "air")  # removes the void preset start platform if the world has one
    b.fill(-100, G - 2, -85, 100, G - 1, 100, "dirt")
    b.fill(-100, G, -85, 100, G, 100, "grass_block")
    # bridge to boss island + boss island base
    b.disk(0, -126, 25, G - 2, G - 1, "blackstone")
    b.fill(-3, G - 2, -101, 3, G, -86, "stone_bricks")
    b.stage("build/ground_detail")
    # dirt/podzol variation
    for _ in range(420):
        x, z = rng.randint(-98, 98), rng.randint(-83, 98)
        r = rng.randint(1, 2)
        blk = rng.choice(["podzol", "coarse_dirt", "rooted_dirt", "moss_block", "podzol", "coarse_dirt", "pale_moss_block"])
        b.fill(x - r, G, z - r, x + r, G, z + r, blk)
    # border fence around island, leaving the bridge open
    b.fence_line(-100, -85, -100, 100, G + 1, "dark_oak_fence")
    b.fence_line(100, -85, 100, 100, G + 1, "dark_oak_fence")
    b.fence_line(-100, 100, 100, 100, G + 1, "dark_oak_fence")
    b.fence_line(-100, -85, -4, -85, G + 1, "dark_oak_fence")
    b.fence_line(4, -85, 100, -85, G + 1, "dark_oak_fence")


RESERVED = [  # (x1,z1,x2,z2) areas without random decoration
    (-20, -20, 20, 20), (-20, -70, 20, -16), (-4, -86, 4, -40), (38, -22, 82, 22), (16, -4, 44, 4),
    (-84, -24, -36, 24), (-44, -4, -16, 4), (-40, 40, 40, 82), (-4, 16, 4, 56), (48, 48, 72, 72),
    (36, 54, 52, 64), (-88, 44, -36, 78), (-44, 54, -34, 64),
]


def free(x, z, pad=2):
    if abs(x) > 96 or z < -81 or z > 96:
        return False
    for (x1, z1, x2, z2) in RESERVED:
        if x1 - pad <= x <= x2 + pad and z1 - pad <= z <= z2 + pad:
            return False
    return True


def dead_trees(b):
    b.stage("build/trees")
    placed = []
    tries = 0
    while len(placed) < 34 and tries < 4000:
        tries += 1
        x, z = rng.randint(-96, 96), rng.randint(-80, 96)
        if not free(x, z, 3) or any(abs(x - a) + abs(z - c) < 9 for a, c in placed):
            continue
        placed.append((x, z))
        kind = rng.choice(["dark_oak", "pale_oak", "spruce", "dark_oak"])
        log = f"{kind}_log"
        h = rng.randint(5, 9)
        b.fill(x, G + 1, z, x, G + h, z, log)
        # crooked branches
        for _ in range(rng.randint(2, 4)):
            by = rng.randint(G + 3, G + h)
            dx, dz = rng.choice([(1, 0), (-1, 0), (0, 1), (0, -1)])
            axis = "x" if dx else "z"
            ln = rng.randint(1, 3)
            for i in range(1, ln + 1):
                b.setblock(x + dx * i, by + (i // 2), z + dz * i, f"{log}[axis={axis}]")
            if rng.random() < 0.5:
                b.setblock(x + dx * ln, by + (ln // 2) - 1, z + dz * ln, "cobweb")
        if kind == "pale_oak":
            b.setblock(x, G + h + 1, z, "pale_hanging_moss[tip=true]") if False else None
            b.fill(x - 1, G + h, z - 1, x + 1, G + h, z + 1, "pale_oak_leaves[persistent=true]", "keep")
        if rng.random() < 0.35:
            b.setblock(x + 1, G + 1, z, "carved_pumpkin[facing=east]")
    # gravestones scattered around
    n = 0
    while n < 40:
        x, z = rng.randint(-96, 96), rng.randint(-80, 96)
        if not free(x, z, 1):
            continue
        n += 1
        b.setblock(x, G + 1, z, rng.choice(["cobblestone_wall", "mossy_cobblestone_wall", "stone_brick_wall"]) + "[up=true]")
        if rng.random() < 0.3:
            b.setblock(x, G + 2, z, "skeleton_skull[rotation=8]")
        b.setblock(x, G, z + 1, "rooted_dirt")
    P["trees"] = placed


# --------------------------------------------------------------------------------------------
def plaza(b):
    b.stage("build/plaza")
    b.disk(0, 0, 17.5, G, G, "polished_blackstone_bricks")
    b.disk(0, 0, 13.5, G, G, "orange_terracotta", ring=1)
    b.disk(0, 0, 9.5, G, G, "black_concrete", ring=1)
    b.disk(0, 0, 17.5, G, G, "orange_terracotta", ring=1)
    # pedestal
    b.disk(0, 0, 4.5, G + 1, G + 1, "polished_blackstone")
    b.disk(0, 0, 3.5, G + 2, G + 3, "chiseled_polished_blackstone")
    # giant jack-o'-lantern (ellipsoid), face toward +z (spawn side)
    cx, cy, cz, rx, ry, rz = 0, 71, 0, 7.5, 5.5, 7.5
    face = []
    for y in range(cy - 6, cy + 7):
        for z in range(-8, 9):
            xs = [x for x in range(-8, 9) if ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 + ((z - cz) / rz) ** 2 <= 1]
            if xs:
                b.fill(min(xs), y, z, max(xs), y, z, "orange_concrete")
    # ribs
    for y in range(cy - 6, cy + 7):
        for z in range(-8, 9):
            for x in range(-8, 9):
                v = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 + ((z - cz) / rz) ** 2
                if 0.78 < v <= 1:
                    ang = math.degrees(math.atan2(z, x)) % 45
                    if ang < 7:
                        b.setblock(x, y, z, "orange_terracotta")

    def front(x, y):  # surface z on the +z side
        for z in range(8, -1, -1):
            if ((x / rx) ** 2 + ((y - cy) / ry) ** 2 + (z / rz) ** 2) <= 1:
                return z
        return None
    glow = set()
    for x in range(-6, 7):
        for y in range(cy - 4, cy + 5):
            dy = y - cy
            eye = (dy == 1 and abs(abs(x) - 3) <= 2) or (dy == 2 and abs(abs(x) - 3) <= 1) or (dy == 3 and abs(x) == 3)
            nose = dy == 0 and x == 0
            mouth = (dy == -2 and abs(x) <= 4) or (dy == -3 and abs(x) <= 3 and x % 2 == 0) or (dy == -1 and abs(x) in (4, 1))
            if eye or nose or mouth:
                glow.add((x, y))
    for (x, y) in glow:
        z = front(x, y)
        if z is not None:
            b.setblock(x, y, z, "shroomlight")
            b.setblock(x, y, z - 1, "shroomlight")
    # stem
    b.fill(0, cy + 6, 0, 0, cy + 8, 0, "stripped_dark_oak_log")
    b.setblock(1, cy + 8, 0, "stripped_dark_oak_log[axis=x]")
    b.fill(-1, cy + 6, -1, 1, cy + 6, 1, "moss_block", "keep")
    b.label(0, 0, "巨大ジャック・オ・ランタン")

    # altar for the three soul lanterns (north)
    P["altar"] = [(-4, -13), (0, -13), (4, -13)]
    b.fill(-7, G, -15, 7, G, -11, "polished_blackstone_bricks")
    for (x, z) in P["altar"]:
        b.setblock(x, G + 1, z, "chiseled_stone_bricks")
        b.setblock(x, G + 2, z, "chiseled_polished_blackstone")
    b.label(0, -13, "祭壇")

    # shop (east)
    b.fill(11, G, -5, 16, G, 5, "spruce_planks")
    b.fill(13, G + 1, -4, 13, G + 1, 4, "spruce_slab[type=top]")
    for z in (-5, 5):
        b.fill(11, G + 1, z, 11, G + 4, z, "spruce_log")
        b.fill(16, G + 1, z, 16, G + 4, z, "spruce_log")
    for z in range(-5, 6):
        b.fill(11, G + 5, z, 16, G + 5, z, "orange_wool" if z % 2 == 0 else "black_wool")
    b.fill(16, G + 1, -4, 16, G + 4, 4, "dark_oak_planks")
    b.setblock(15, G + 1, 0, "barrel[facing=up]")
    b.setblock(15, G + 1, -3, "barrel[facing=west]")
    b.label(15, 6, "ショップ")
    # wardrobe (west)
    b.fill(-16, G, -5, -11, G, 5, "dark_oak_planks")
    b.fill(-16, G + 1, -5, -16, G + 5, 5, "purple_terracotta")
    b.fill(-16, G + 6, -5, -11, G + 6, 5, "purple_wool")
    for z in (-5, 5):
        b.fill(-11, G + 1, z, -11, G + 5, z, "dark_oak_log")
    b.label(-15, 6, "仮装")
    # info board (south-west) and start podium (south-east)
    b.fill(-12, G, 10, -6, G, 12, "polished_blackstone")
    b.fill(6, G, 10, 12, G, 12, "polished_blackstone")
    b.setblock(9, G + 1, 11, "lodestone")
    b.label(9, 11, "スタート台")
    # lamp posts around the plaza
    for a in range(0, 360, 30):
        x = round(16 * math.cos(math.radians(a + 15)))
        z = round(16 * math.sin(math.radians(a + 15)))
        if abs(x) <= 3 or abs(z) <= 3:
            continue
        lamp_post(b, x, z, 3)
    P["spawn"] = (0, G + 1, 12)


def plaza_entities(b):
    b.stage("build/plaza_ent")
    text_display(b, 0.5, 86, 0.5, T("HAPPY HALLOWEEN", "gold", True), scale=5.0)
    text_display(b, 0.5, 84.4, 0.5, T("〜 パンプキン王の呪い 〜", "light_purple", True), scale=2.5)
    for i, (x, z) in enumerate(P["altar"]):
        name = ["① 呪われた屋敷", "② 墓地迷路", "③ カボチャ畑"][i]
        text_display(b, x + 0.5, G + 4.4, z + 0.5, T(name, "aqua"), scale=0.8)
    text_display(b, 0.5, G + 6, -13.5, T("魂のランタンを3つ集めると、北の城門がひらく", "yellow"), scale=1.0)
    # shop
    shop = [("iron_sword", "鉄の剣", 8), ("bow", "弓＋矢16本", 10), ("golden_apple", "金のリンゴ", 12),
            ("iron_chestplate", "鉄のチェストプレート", 15), ("potion", "治癒のポーション", 6)]
    P["shop"] = shop
    text_display(b, 11.0, G + 5.6, 0.5, T("★ お菓子ショップ ★", "gold", True), scale=1.4, billboard="vertical")
    text_display(b, 10.9, G + 5.1, 0.5, T("使ったお菓子はランキングから減るので注意！", "gray"), scale=0.6, billboard="vertical")
    for i, (it, nm, price) in enumerate(shop):
        z = -4 + i * 2
        item_display(b, 13.5, G + 2.3, z + 0.5, it, 0.7)
        text_display(b, 13.5, G + 3.0, z + 0.5, T(f"{nm}\n{price}個", "yellow"), scale=0.6)
        interaction(b, 13.5, G + 1, z + 0.5, 1.0, 1.8, ["hw.c.shop"], i + 1)
    # wardrobe
    cos = [("carved_pumpkin", "カボチャ頭"), ("skeleton_skull", "ガイコツ"), ("wither_skeleton_skull", "黒ガイコツ"),
           ("zombie_head", "ゾンビ"), ("creeper_head", "クリーパー"), ("piglin_head", "ピグリン")]
    P["costumes"] = cos
    text_display(b, -10.9, G + 5.6, 0.5, T("★ 仮装クローゼット ★", "light_purple", True), scale=1.4, billboard="vertical")
    for i, (it, nm) in enumerate(cos):
        z = -4.5 + i * 1.8
        item_display(b, -13.5, G + 2.2, z + 0.5, it, 0.8)
        text_display(b, -13.5, G + 3.1, z + 0.5, T(nm, "white"), scale=0.55)
        interaction(b, -13.5, G + 1, z + 0.5, 1.2, 1.8, ["hw.c.costume"], i + 1)
    text_display(b, -12.5, G + 1.6, 6.5, T("[ 仮装を脱ぐ ]", "gray"), scale=0.6)
    interaction(b, -12.5, G + 1, 6.5, 1.0, 1.0, ["hw.c.costume"], 0)
    # info board
    rules = ("§6§lルール§r\n"
             "・お菓子をいちばん多く集めた人が優勝！\n"
             "・家をノック、ミニゲーム、隠しお菓子、敵を倒すとお菓子GET\n"
             "・3つのエリアで「魂のランタン」を探して祭壇へ\n"
             "・ランタンが揃うと北の城でパンプキン・キングと決戦\n"
             "・残り5分は お菓子2倍タイム！")
    text_display(b, -9.0, G + 4.2, 11.5, T(rules.replace("§6§l", "").replace("§r", ""), "white"), scale=0.7, billboard="vertical", bg=-2013265920, line_width=320)
    text_display(b, 9.5, G + 3.3, 11.5, T("▶ ゲームスタート", "green", True), scale=1.2)
    text_display(b, 9.5, G + 2.7, 11.5, T("台をクリックで開始（全員そろってから！）", "gray"), scale=0.6)
    interaction(b, 9.5, G + 1, 11.5, 1.2, 1.2, ["hw.c.start"])
    # bats around the statue
    for i in range(8):
        a = i * 45
        b.cmd(f"summon minecraft:bat {round(9*math.cos(math.radians(a)),1)} 78 {round(9*math.sin(math.radians(a)),1)} {{PersistenceRequired:1b,Tags:[\"hw.deco\"]}}")


# --------------------------------------------------------------------------------------------
def paths(b):
    b.stage("build/paths")
    segs = [  # (x1,z1,x2,z2)
        (-2, -44, 2, -17), (-2, 17, 2, 56), (17, -2, 43, 2), (-43, -2, -17, 2),
        (36, 57, 52, 61), (-44, 57, -36, 61),  # village ends -> tower / gallery
        (-2, -85, 2, -66), (-20, -70, 20, -67), (-20, -70, -17, -45), (17, -70, 20, -45),  # around mansion
    ]
    for (x1, z1, x2, z2) in segs:
        b.fill(x1, G, z1, x2, G, z2, "dirt_path")
        for x in range(x1, x2 + 1):
            for z in range(z1, z2 + 1):
                if rng.random() < 0.18:
                    b.setblock(x, G, z, rng.choice(["gravel", "coarse_dirt", "packed_mud"]))
    # lamp posts
    for z in range(-40, -18, 7):
        lamp_post(b, 3 + 1, z); lamp_post(b, -4, z + 3)
    for z in range(20, 54, 7):
        lamp_post(b, 4, z); lamp_post(b, -4, z + 3)
    for x in range(20, 42, 7):
        lamp_post(b, x, 4); lamp_post(b, x + 3, -4)
    for x in range(-41, -18, 7):
        lamp_post(b, x, 4); lamp_post(b, x + 3, -4)
    for z in range(-82, -68, 6):
        lamp_post(b, 4, z); lamp_post(b, -4, z + 3)
    # signposts
    P["signs"] = [(0.5, G + 4, -20.5, "↑ 呪われた屋敷 / 北の城"), (0.5, G + 4, 20.5, "↓ トリック・オア・トリート村"),
                  (20.5, G + 4, 0.5, "→ 墓地迷路"), (-20.5, G + 4, 0.5, "← カボチャ畑")]


def paths_entities(b):
    b.stage("build/paths_ent")
    for (x, y, z, t) in P["signs"]:
        text_display(b, x, y, z, T(t, "gold", True), scale=1.0)


# --------------------------------------------------------------------------------------------
def mansion(b):
    b.stage("build/mansion")
    x1, x2, z1, z2 = -15, 15, -65, -45
    F1, F2, F3 = G, 70, 76  # floor levels (block y)
    b.fill(x1 - 1, G, z1 - 1, x2 + 1, G, z2 + 1, "cobbled_deepslate")
    b.fill(x1, F1, z1, x2, F1, z2, "dark_oak_planks")
    # outer walls
    b.fill(x1, F1 + 1, z1, x2, F3, z2, "dark_oak_planks", "hollow")
    b.fill(x1 + 1, F1 + 1, z1 + 1, x2 - 1, F3 - 1, z2 - 1, "air")
    b.fill(x1, F2, z1, x2, F2, z2, "dark_oak_planks")
    b.fill(x1, F3, z1, x2, F3, z2, "dark_oak_planks")
    for x in range(x1, x2 + 1, 5):
        for z in (z1, z2):
            b.fill(x, F1 + 1, z, x, F3, z, "dark_oak_log")
    for z in range(z1, z2 + 1, 5):
        for x in (x1, x2):
            b.fill(x, F1 + 1, z, x, F3, z, "dark_oak_log")
    b.fill(x1, F2, z1, x2, F2, z1, "stripped_dark_oak_log[axis=x]")
    b.fill(x1, F2, z2, x2, F2, z2, "stripped_dark_oak_log[axis=x]")
    # windows
    for x in range(x1 + 2, x2 - 1, 5):
        for xx in (x, x + 1):
            for z in (z1, z2):
                if z == z2 and -2 <= xx <= 1:
                    continue
                b.fill(xx, F1 + 2, z, xx, F1 + 3, z, "purple_stained_glass")
                b.fill(xx, F2 + 2, z, xx, F2 + 3, z, "purple_stained_glass")
    for z in range(z1 + 2, z2 - 1, 5):
        for zz in (z, z + 1):
            for x in (x1, x2):
                b.fill(x, F1 + 2, zz, x, F1 + 3, zz, "purple_stained_glass")
                b.fill(x, F2 + 2, zz, x, F2 + 3, zz, "purple_stained_glass")
    # roof
    b.gable_roof(x1 - 1, x2 + 1, z1 - 1, z2 + 1, F3, "deepslate_tile_stairs", "dark_oak_planks", "deepslate_tile_slab")
    # turrets on the two front corners
    for tx in (-17, 17):
        tz = -43
        b.disk(tx, tz, 2.5, G, 86, "deepslate_bricks")
        for y in (68, 74, 80):
            b.disk(tx, tz, 2.5, y, y + 1, "purple_stained_glass", ring=1)
        for k in range(8):
            r = 3.4 - k * 0.42
            b.disk(tx, tz, max(r, 0.5), 87 + k, 87 + k, "deepslate_tiles")
        b.setblock(tx, 95, tz, "lightning_rod")
    # chimney
    b.fill(10, F3, -60, 11, F3 + 12, -59, "bricks")
    b.setblock(10, F3 + 12, -60, "campfire[lit=true]")
    # porch and front door
    b.fill(-3, G, z2 + 1, 2, G, z2 + 3, "dark_oak_planks")
    b.fill(-3, G + 1, z2 + 3, -3, G + 4, z2 + 3, "dark_oak_fence")
    b.fill(2, G + 1, z2 + 3, 2, G + 4, z2 + 3, "dark_oak_fence")
    b.fill(-3, G + 5, z2 + 1, 2, G + 5, z2 + 3, "dark_oak_slab[type=bottom]")
    b.fill(-2, G + 1, z2, 1, G + 4, z2, "dark_oak_log")
    b.door(-1, G + 1, z2, "dark_oak_door", "north", "left")
    b.door(0, G + 1, z2, "dark_oak_door", "north", "right")
    b.setblock(-3, G + 1, z2 + 4, "carved_pumpkin[facing=south]")
    b.setblock(2, G + 1, z2 + 4, "jack_o_lantern[facing=south]")
    b.fill(-2, G + 1, z2 + 1, -2, G + 2, z2 + 1, "cobweb") if False else None
    b.label(0, -55, "呪われた屋敷")

    b.stage("build/mansion_in")
    # interior walls F1 / F2 (x=-5 and x=5) with doorways at z -57..-56
    for fy, top in ((F1, F2 - 1), (F2, F3 - 1)):
        for wx in (-5, 5):
            b.fill(wx, fy + 1, z1 + 1, wx, top, z2 - 1, "spruce_planks")
            b.fill(wx, fy + 1, -57, wx, fy + 3, -56, "air")
    # staircase in hall: x 3..4, from z=-48 up to the F2 floor
    for i in range(7):
        b.fill(3, F1 + 1 + i, -48 - i, 4, F1 + 1 + i, -48 - i, "dark_oak_stairs[facing=north,half=bottom]")
        if i:
            b.fill(3, F1 + 1, -48 - i, 4, F1 + i, -48 - i, "dark_oak_planks")
    b.fill(3, F2, -49, 4, F2, -53, "air")
    b.fill(2, F2 + 1, -49, 2, F2 + 1, -53, "dark_oak_fence[north=true,south=true]")
    b.fill(2, F2 + 1, -48, 4, F2 + 1, -48, "dark_oak_fence[east=true,west=true]")
    # hall decor: red carpet, chandeliers
    b.fill(-1, F1 + 1, -63, 0, F1 + 1, -46, "red_carpet")
    for z in (-50, -58):
        b.setblock(0, F2 - 1, z, "soul_lantern[hanging=true]")
    b.setblock(-4, F1 + 1, -64, "grandfather_clock") if False else None
    b.fill(-4, F1 + 1, -64, -4, F1 + 3, -64, "dark_oak_log")
    b.setblock(-4, F1 + 4, -64, "skeleton_skull[rotation=8]")
    b.fill(-4, F1 + 4, -46, -3, F1 + 5, -46, "cobweb")
    b.fill(3, F1 + 4, -63, 4, F1 + 5, -64, "cobweb")
    # library (west, x -14..-6): bookshelves + four levers on the north wall
    b.fill(-14, F1 + 1, -64, -14, F1 + 5, -46, "bookshelf")
    b.fill(-14, F1 + 1, -64, -6, F1 + 1, -64, "bookshelf")
    b.fill(-14, F1 + 4, -64, -6, F1 + 5, -64, "bookshelf")
    b.fill(-13, F1 + 1, -46, -6, F1 + 5, -46, "bookshelf")
    b.fill(-11, F1 + 1, -54, -9, F1 + 1, -52, "chiseled_bookshelf[facing=east]")
    b.setblock(-10, F1 + 2, -53, "lectern[facing=south]")
    P["levers"] = [(-12, F1 + 2, -64), (-10, F1 + 2, -64), (-8, F1 + 2, -64), (-6, F1 + 2, -64)]
    for (x, y, z) in P["levers"]:
        b.fill(x, y - 1, z, x, y + 1, z, "polished_deepslate")
        b.setblock(x, y, z + 1, "lever[face=wall,facing=south,powered=false]")
        b.setblock(x, y + 2, z + 1, "candle[candles=1,lit=false]") if False else None
    for x in (-13, -7):
        b.setblock(x, F1 + 1, -50, "candle[candles=3,lit=true]")
    b.setblock(-10, F2 - 1, -55, "lantern[hanging=true]")
    # dining (east, x 6..14)
    b.fill(9, F1 + 1, -60, 10, F1 + 1, -50, "dark_oak_fence")
    b.fill(9, F1 + 2, -60, 10, F1 + 2, -50, "dark_oak_slab[type=bottom]") if False else None
    b.fill(9, F1 + 1, -60, 10, F1 + 1, -50, "dark_oak_planks")
    for z in range(-59, -50, 2):
        b.setblock(8, F1 + 1, z, "dark_oak_stairs[facing=east]")
        b.setblock(11, F1 + 1, z, "dark_oak_stairs[facing=west]")
        b.setblock(9, F1 + 2, z, "candle[candles=2,lit=true]" if z % 4 == 1 else "skeleton_skull[rotation=4]")
    b.setblock(10, F1 + 2, -55, "cake")
    b.setblock(10, F1 + 2, -52, "candle[candles=4,lit=true]")
    b.fill(13, F1 + 4, -64, 14, F1 + 5, -62, "cobweb")
    b.setblock(9, F2 - 1, -55, "soul_lantern[hanging=true]")
    # F2: bedroom west, nursery east, corridor center
    b.fill(-1, F2 + 1, -64, 0, F2 + 1, -46, "purple_carpet")
    for cx_ in (-12, -10):  # coffins instead of beds (beds would move the respawn point)
        b.fill(cx_, F2 + 1, -63, cx_, F2 + 1, -62, "dark_oak_trapdoor[facing=north,half=top,open=false]")
        b.setblock(cx_, F2 + 1, -61, "skeleton_skull[rotation=8]") if cx_ == -12 else None
    b.fill(-14, F2 + 1, -48, -13, F2 + 3, -47, "dark_oak_planks")
    b.fill(-14, F2 + 4, -50, -13, F2 + 5, -46, "cobweb")
    b.setblock(-7, F2 + 1, -63, "candle[candles=3,lit=true]")
    b.setblock(-10, F3 - 1, -55, "soul_lantern[hanging=true]")
    b.setblock(12, F2 + 1, -62, "jukebox")
    b.fill(8, F2 + 1, -64, 8, F2 + 1, -63, "white_wool")
    b.fill(8, F2 + 2, -64, 8, F2 + 2, -63, "white_carpet")
    b.fill(13, F2 + 1, -50, 14, F2 + 1, -48, "white_wool")
    b.setblock(13, F2 + 2, -49, "skeleton_skull[rotation=12]")
    b.fill(12, F2 + 4, -64, 14, F2 + 5, -60, "cobweb")
    b.setblock(10, F3 - 1, -55, "lantern[hanging=true]")
    b.setblock(7, F2 + 1, -50, "candle[candles=1,lit=true]")
    # attic hatch (closed until the lever puzzle is solved)
    b.fill(0, F2 + 1, -57, 0, F3 - 1, -57, "dark_oak_log")
    P["ladder"] = [(0, y, -58) for y in range(F2 + 1, F3 + 1)]
    P["hatch"] = (0, F3, -58)
    # attic
    b.fill(-6, F3 + 1, -60, 6, F3 + 2, -60, "cobweb", "keep") if False else None
    for (x, z) in [(-8, -52), (6, -59), (-3, -61), (9, -50)]:
        b.setblock(x, F3 + 1, z, "chest[facing=south]")
    for (x, z) in [(-12, -55), (12, -56), (-5, -50), (4, -51), (-9, -58)]:
        b.fill(x, F3 + 2, z, x + 1, F3 + 3, z, "cobweb")
    b.setblock(0, F3 + 1, -55, "chiseled_polished_blackstone")
    P["L1"] = (0, F3 + 2, -55)
    b.setblock(-2, F3 + 1, -53, "soul_campfire[lit=true]") if False else None
    for x in (-3, 3):
        b.setblock(x, F3 + 1, -55, "candle[candles=4,lit=true]")
    # graveyard behind the mansion
    for i in range(12):
        x = -14 + (i % 6) * 5 + (1 if i >= 6 else 0)
        z = -76 if i < 6 else -81
        if abs(x) <= 3:
            continue
        b.setblock(x, G + 1, z, "mossy_stone_brick_wall[up=true]")
        b.setblock(x, G + 2, z, "stone_brick_wall[up=true]")
        b.setblock(x, G, z + 1, "rooted_dirt")
        b.setblock(x, G, z + 2, "podzol")
    b.label(0, -79, "墓場")


def mansion_entities(b):
    b.stage("build/mansion_ent")
    text_display(b, -0.5, G + 6.5, -42.0, T("呪われた屋敷", "dark_purple", True), scale=1.6)
    for i, (x, y, z) in enumerate(P["levers"]):
        text_display(b, x + 0.5, y + 1.4, z + 1.1, T(f"燭台{i+1}", "yellow"), scale=0.6)
    text_display(b, -10.5, G + 4.8, -63.0, T("4つの燭台に正しく火を灯せ（レバー）", "gray"), scale=0.6)
    P["notes"] = [(12.5, G + 1, -50.5), (-8.5, 71, -61.5), (12.5, 71, -48.5)]
    for i, (x, y, z) in enumerate(P["notes"]):
        item_display(b, x, y + 0.6, z, "writable_book", 0.5)
        interaction(b, x, y, z, 0.9, 1.0, ["hw.c.note"], i + 1)
    text_display(b, 0.5, 74.2, -58.5, T("天井に…何かある？", "gray", italic=True), scale=0.6)
    text_display(b, 0.5, 80.0, -54.5, T("① 屋敷の魂のランタン", "aqua", True), scale=0.8, tags=("hw.deco", "hw.ltext1"))


# --------------------------------------------------------------------------------------------
MAZE = dict(x0=44, z0=-17, n=11)


def maze(b):
    b.stage("build/maze")
    x0, z0, n = MAZE["x0"], MAZE["z0"], MAZE["n"]
    size = n * 3 + 1
    mrng = random.Random(1031)
    walls_v = [[True] * n for _ in range(n + 1)]  # vertical walls between (i-1,j) and (i,j)
    walls_h = [[True] * (n + 1) for _ in range(n)]  # horizontal walls between (i,j-1) and (i,j)
    seen = [[False] * n for _ in range(n)]
    stack = [(0, n // 2)]
    seen[0][n // 2] = True
    while stack:
        i, j = stack[-1]
        nb = [(i + di, j + dj, di, dj) for di, dj in ((1, 0), (-1, 0), (0, 1), (0, -1)) if 0 <= i + di < n and 0 <= j + dj < n and not seen[i + di][j + dj]]
        if not nb:
            stack.pop()
            continue
        ni, nj, di, dj = mrng.choice(nb)
        if di == 1: walls_v[i + 1][j] = False
        if di == -1: walls_v[i][j] = False
        if dj == 1: walls_h[i][j + 1] = False
        if dj == -1: walls_h[i][j] = False
        seen[ni][nj] = True
        stack.append((ni, nj))
    # extra loops
    for _ in range(14):
        i, j = mrng.randint(1, n - 1), mrng.randint(0, n - 1)
        walls_v[i][j] = False
        i, j = mrng.randint(0, n - 1), mrng.randint(1, n - 1)
        walls_h[i][j] = False
    # chamber 4..6
    c0, c1 = 4, 6
    for i in range(c0 + 1, c1 + 1):
        for j in range(c0, c1 + 1):
            walls_v[i][j] = False
    for i in range(c0, c1 + 1):
        for j in range(c0 + 1, c1 + 1):
            walls_h[i][j] = False
    # entrance on west (i=0 left wall) at middle row, and chamber door on west side
    walls_v[0][n // 2] = False
    walls_v[c0][n // 2] = False
    # floor
    for x in range(x0, x0 + size):
        for z in range(z0, z0 + size):
            pass
    b.fill(x0, G, z0, x0 + size - 1, G, z0 + size - 1, "podzol")
    for _ in range(140):
        x, z = mrng.randint(x0, x0 + size - 1), mrng.randint(z0, z0 + size - 1)
        b.setblock(x, G, z, mrng.choice(["soul_soil", "coarse_dirt", "rooted_dirt", "soul_soil"]))
    # walls: grid lines every 3 blocks
    H = 3
    def wall_block():
        return mrng.choice(["dark_oak_leaves[persistent=true]"] * 5 + ["spruce_leaves[persistent=true]"] * 2 + ["mossy_stone_bricks", "mossy_cobblestone"])
    # posts
    for i in range(n + 1):
        for j in range(n + 1):
            b.fill(x0 + 3 * i, G + 1, z0 + 3 * j, x0 + 3 * i, G + H, z0 + 3 * j, "mossy_stone_bricks" if (i + j) % 3 == 0 else "dark_oak_leaves[persistent=true]")
    for i in range(n + 1):
        for j in range(n):
            if walls_v[i][j]:
                b.fill(x0 + 3 * i, G + 1, z0 + 3 * j + 1, x0 + 3 * i, G + H, z0 + 3 * j + 2, wall_block())
    for i in range(n):
        for j in range(n + 1):
            if walls_h[i][j]:
                b.fill(x0 + 3 * i + 1, G + 1, z0 + 3 * j, x0 + 3 * i + 2, G + H, z0 + 3 * j, wall_block())
    # clear the chamber interior completely (posts inside)
    cx1, cz1 = x0 + 3 * c0 + 1, z0 + 3 * c0 + 1
    cx2, cz2 = x0 + 3 * c1 + 2, z0 + 3 * c1 + 2
    b.fill(cx1, G + 1, cz1, cx2, G + H, cz2, "air")
    b.fill(cx1, G, cz1, cx2, G, cz2, "soul_soil")
    ccx, ccz = (cx1 + cx2) // 2, (cz1 + cz2) // 2
    b.fill(ccx - 1, G, ccz - 1, ccx + 1, G, ccz + 1, "polished_blackstone_bricks")
    b.setblock(ccx, G + 1, ccz, "chiseled_polished_blackstone")
    P["L2"] = (ccx, G + 2, ccz)
    for (x, z) in [(cx1, cz1), (cx1, cz2), (cx2, cz1), (cx2, cz2)]:
        b.setblock(x, G + 1, z, "soul_campfire[lit=true]")
    b.label(ccx, ccz, "墓地迷路")
    # dead ends -> gravestones, trap plates in random corridor cells
    dead = []
    for i in range(n):
        for j in range(n):
            if c0 <= i <= c1 and c0 <= j <= c1:
                continue
            open_sides = (not walls_v[i][j]) + (not walls_v[i + 1][j]) + (not walls_h[i][j]) + (not walls_h[i][j + 1])
            if open_sides == 1:
                dead.append((i, j))
    mrng.shuffle(dead)
    P["maze_dead"] = []
    for (i, j) in dead[:16]:
        x, z = x0 + 3 * i + 1, z0 + 3 * j + 1
        b.setblock(x, G + 1, z, "stone_brick_wall[up=true]")
        b.setblock(x, G + 2, z, mrng.choice(["skeleton_skull[rotation=0]", "candle[candles=3,lit=true]", "stone_brick_wall[up=true]"]))
        P["maze_dead"].append((x + 1, z + 1))
    cells = [(i, j) for i in range(1, n - 1) for j in range(n) if not (c0 - 1 <= i <= c1 + 1 and c0 - 1 <= j <= c1 + 1) and (i, j) not in dead]
    mrng.shuffle(cells)
    P["traps"] = []
    for (i, j) in cells[:7]:
        x, z = x0 + 3 * i + 1 + mrng.randint(0, 1), z0 + 3 * j + 1 + mrng.randint(0, 1)
        b.setblock(x, G + 1, z, "polished_blackstone_pressure_plate")
        P["traps"].append((x, z))
    # entrance arch
    ez = z0 + 3 * (n // 2)
    b.fill(x0 - 1, G + 1, ez, x0 - 1, G + 5, ez, "deepslate_bricks")
    b.fill(x0 - 1, G + 1, ez + 3, x0 - 1, G + 5, ez + 3, "deepslate_bricks")
    b.fill(x0 - 1, G + 5, ez, x0 - 1, G + 5, ez + 3, "deepslate_brick_slab[type=bottom]")
    b.setblock(x0 - 1, G + 6, ez, "soul_lantern")
    b.setblock(x0 - 1, G + 6, ez + 3, "soul_lantern")
    P["maze_entrance"] = (x0 - 1, ez + 1.5)
    P["maze_box"] = (x0, z0, size)
    # biome: soul sand valley for blue fog and ash
    b.fillbiome(x0-4, 56, z0-4, x0+size+3, 87, z0+size+3, "soul_sand_valley")


def maze_entities(b):
    b.stage("build/maze_ent")
    x, z = P["maze_entrance"]
    text_display(b, x - 0.5, G + 7, z + 0.5, T("墓地迷路", "aqua", True), scale=1.6)
    text_display(b, x - 0.5, G + 6.3, z + 0.5, T("ランタンは迷路の中心に…足元のワナに注意", "gray"), scale=0.6)
    lx, ly, lz = P["L2"]
    text_display(b, lx + 0.5, ly + 1.6, lz + 0.5, T("② 墓地の魂のランタン", "aqua", True), scale=0.8, tags=("hw.deco", "hw.ltext2"))


# --------------------------------------------------------------------------------------------
def patch(b):
    b.stage("build/patch")
    x1, x2, z1, z2 = -80, -40, -20, 20
    b.fill(x1, G, z1, x2, G, z2, "grass_block")
    for z in range(z1 + 2, z2 - 1, 3):
        b.fill(x1 + 2, G, z, x2 - 2, G, z, "coarse_dirt")
    for x in range(x1 + 3, x2 - 2, 4):
        for z in range(z1 + 2, z2 - 1, 6):
            if rng.random() < 0.75:
                b.setblock(x, G + 1, z, rng.choice(["pumpkin", "pumpkin", "carved_pumpkin[facing=east]", "jack_o_lantern[facing=south]"]))
    # fence with gate gap on east side
    b.fence_line(x1, z1, x2, z1, G + 1, "spruce_fence")
    b.fence_line(x1, z2, x2, z2, G + 1, "spruce_fence")
    b.fence_line(x1, z1, x1, z2, G + 1, "spruce_fence")
    b.fence_line(x2, z1, x2, -3, G + 1, "spruce_fence")
    b.fence_line(x2, 3, x2, z2, G + 1, "spruce_fence")
    b.setblock(x2, G + 1, z1, "spruce_fence[north=false,south=true,west=true]")
    # scarecrows
    for (x, z) in [(-70, -12), (-52, 12), (-66, 9), (-50, -13)]:
        b.fill(x, G + 1, z, x, G + 2, z, "spruce_fence")
        b.setblock(x, G + 3, z, "hay_block")
        b.setblock(x, G + 4, z, "carved_pumpkin[facing=east]")
        b.setblock(x, G + 3, z - 1, "spruce_fence[south=true]")
        b.setblock(x, G + 3, z + 1, "spruce_fence[north=true]")
    # hay stack / shed on the west end with the lantern pedestal
    b.fill(-79, G + 1, -6, -76, G + 1, 6, "hay_block")
    b.fill(-79, G + 2, -5, -78, G + 2, 5, "hay_block")
    b.fill(-79, G + 3, -3, -79, G + 3, 3, "hay_block")
    b.fill(-75, G, -2, -73, G, 2, "spruce_planks")
    b.setblock(-74, G + 1, 0, "chiseled_stone_bricks")
    P["L3"] = (-74, G + 2, 0)
    P["patch_area"] = (-76, -46, -16, 16)
    P["patch_button"] = (-43.5, G + 1, 6.5)
    b.fill(-45, G, 5, -42, G, 8, "smooth_stone")
    b.setblock(-44, G + 1, 8, "composter")
    b.setblock(-42, G + 1, 8, "composter")
    b.label(-60, 0, "カボチャ畑")
    b.fillbiome(-84, 56, -24, -36, 87, 24, "dark_forest")


def patch_entities(b):
    b.stage("build/patch_ent")
    x, y, z = P["patch_button"]
    text_display(b, -40.5, G + 4.5, 0.5, T("カボチャ畑", "gold", True), scale=1.6)
    text_display(b, x, y + 2.2, z, T("▶ カボチャ狩り スタート", "green", True), scale=0.9)
    text_display(b, x, y + 1.7, z, T("60秒間に光るカボチャを叩け！みんなで20個で ③ ランタン出現", "gray"), scale=0.55)
    item_display(b, x, y + 0.8, z, "jack_o_lantern", 0.8)
    interaction(b, x, y, z, 1.2, 1.4, ["hw.c.pk_start"])


# --------------------------------------------------------------------------------------------
HOUSES = [  # (cx, cz, door side, name, wall, accent)
    (-26, 48, "south", "ジャックの家", "spruce_planks", "orange_terracotta"),
    (-14, 48, "south", "魔女ベラの家", "dark_oak_planks", "purple_terracotta"),
    (14, 48, "south", "ドラキュラ伯爵邸", "deepslate_bricks", "red_terracotta"),
    (26, 48, "south", "ミイラのマミー", "smooth_sandstone", "white_terracotta"),
    (-14, 72, "north", "ガイコツ・ボーンズ", "bone_block", "light_gray_terracotta"),
    (14, 72, "north", "黒猫クロの家", "blackstone", "black_terracotta"),
]


def village(b):
    b.stage("build/village")
    b.fill(-40, G, 56, 40, G, 64, "cobblestone")
    for _ in range(220):
        x, z = rng.randint(-40, 40), rng.randint(56, 64)
        b.setblock(x, G, z, rng.choice(["mossy_cobblestone", "gravel", "andesite", "cobblestone"]))
    for x in range(-36, 37, 8):
        lamp_post(b, x, 55, 3)
        lamp_post(b, x + 4, 65, 3)
    P["houses"] = []
    for idx, (cx, cz, side, name, wall, acc) in enumerate(HOUSES):
        x1, x2, z1, z2 = cx - 4, cx + 4, cz - 4, cz + 4
        b.fill(x1, G, z1, x2, G, z2, "spruce_planks")
        b.fill(x1, G + 1, z1, x2, G + 4, z2, wall, "hollow")
        b.fill(x1 + 1, G + 1, z1 + 1, x2 - 1, G + 3, z2 - 1, "air")
        for (x, z) in [(x1, z1), (x1, z2), (x2, z1), (x2, z2)]:
            b.fill(x, G + 1, z, x, G + 4, z, "stripped_dark_oak_log")
        b.fill(x1, G + 1, z1, x2, G + 1, z2, acc, "outline") if False else None
        # windows
        for x in (cx - 2, cx + 2):
            for z in (z1, z2):
                b.setblock(x, G + 2, z, "orange_stained_glass")
                b.setblock(x, G + 3, z, "orange_stained_glass")
        for z in (cz - 1, cz + 1):
            for x in (x1, x2):
                b.fill(x, G + 2, z, x, G + 3, z, "orange_stained_glass")
        b.fill(x1, G + 4, z1, x2, G + 4, z2, acc)
        b.fill(x1 + 1, G + 4, z1 + 1, x2 - 1, G + 4, z2 - 1, wall)
        b.gable_roof(x1 - 1, x2 + 1, z1 - 1, z2 + 1, G + 5, "dark_oak_stairs", "dark_oak_planks", "dark_oak_slab")
        # door
        dz = z2 if side == "south" else z1
        out = 1 if side == "south" else -1
        b.door(cx, G + 1, dz, "spruce_door", "south" if side == "south" else "north")
        b.setblock(cx - 1, G + 1, dz + out, "carved_pumpkin[facing=%s]" % side)
        b.setblock(cx + 1, G + 1, dz + out, "jack_o_lantern[facing=%s]" % side)
        b.setblock(cx - 2, G + 1, dz + out, "hay_block")
        b.setblock(cx - 2, G + 2, dz + out, "carved_pumpkin[facing=%s]" % side)
        b.setblock(cx, G + 4, dz + out, "lantern[hanging=false]") if False else None
        b.setblock(cx, G + 3, dz + out, "soul_lantern[hanging=true]") if False else None
        # interior light
        b.setblock(cx, G + 3, cz, "lantern[hanging=true]")
        b.setblock(cx + 2, G + 1, cz - 2 if side == "south" else cz + 2, "candle[candles=3,lit=true]")
        P["houses"].append((cx + 0.5, G + 1, dz + 0.5 + out * 0.45, name, side))
    # witch cauldron hut (south center)
    b.fill(-5, G, 68, 5, G, 80, "mud_bricks")
    for (x, z) in [(-5, 68), (5, 68), (-5, 80), (5, 80)]:
        b.fill(x, G + 1, z, x, G + 4, z, "mangrove_log")
    b.fill(-5, G + 5, 68, 5, G + 5, 80, "mangrove_planks")
    b.fill(-4, G + 6, 69, 4, G + 6, 79, "dark_oak_slab[type=bottom]")
    b.fill(-5, G + 1, 80, 5, G + 4, 80, "mud_bricks")
    b.setblock(0, G + 1, 74, "water_cauldron[level=3]")
    b.setblock(0, G, 74, "campfire[lit=true]") if False else None
    for (x, z) in [(-2, 73), (2, 73), (-2, 76), (2, 76)]:
        b.setblock(x, G + 1, z, "soul_campfire[lit=true]" if (x + z) % 2 else "candle[candles=4,lit=true]")
    b.setblock(-4, G + 1, 79, "brewing_stand")
    b.setblock(4, G + 1, 79, "bookshelf")
    b.setblock(0, G + 4, 74, "soul_lantern[hanging=true]")
    P["cauldron"] = (0.5, G + 1, 74.5)
    b.label(0, 75, "魔女の大釜")
    b.label(0, 60, "トリック・オア・トリート村")
    # black cat
    b.cmd(f"summon minecraft:cat 15.5 {G+1} 66.5 {{variant:\"minecraft:all_black\",Sitting:1b,PersistenceRequired:1b,Invulnerable:1b,Tags:[\"hw.deco\"]}}")


def village_entities(b):
    b.stage("build/village_ent")
    text_display(b, 0.5, G + 6, 54.5, T("トリック・オア・トリート村", "gold", True), scale=1.8)
    text_display(b, 0.5, G + 5.2, 54.5, T("ドアをノックしてお菓子をもらおう（1軒1回・いたずら注意！）", "gray"), scale=0.6)
    for i, (x, y, z, name, side) in enumerate(P["houses"]):
        text_display(b, x, y + 3.4, z, T(name, "yellow", True), scale=0.8)
        interaction(b, x, y, z, 1.2, 2.2, ["hw.c.house"], i + 1)
    x, y, z = P["cauldron"]
    text_display(b, x, y + 2.4, z, T("魔女の大釜", "light_purple", True), scale=1.0)
    text_display(b, x, y + 1.9, z, T("お菓子3個で運だめし（強化 or ハズレ）", "gray"), scale=0.55)
    interaction(b, x, y, z, 1.2, 1.2, ["hw.c.cauldron"])


# --------------------------------------------------------------------------------------------
TOWER = dict(cx=60, cz=60, steps=36, r=6.0, ang=24)


def tower(b):
    b.stage("build/tower")
    cx, cz = TOWER["cx"], TOWER["cz"]
    b.disk(cx + 0.5, cz + 0.5, 11, G, G, "soul_soil")
    b.disk(cx + 0.5, cz + 0.5, 11, G, G, "podzol", ring=1)
    b.disk(cx + 0.5, cz + 0.5, 2.6, G + 1, 100, "deepslate_bricks")
    for y in range(G + 4, 100, 6):
        b.disk(cx + 0.5, cz + 0.5, 2.6, y, y, "purple_stained_glass", ring=1)
    steps = []
    prev = None
    for i in range(TOWER["steps"]):
        a = math.radians(90 + i * TOWER["ang"])
        x = cx + round(TOWER["r"] * math.cos(a))
        z = cz + round(TOWER["r"] * math.sin(a))
        y = G + 1 + i
        steps.append((x, y, z))
    cps = [12, 24]
    P["checkpoints"] = []
    for i, (x, y, z) in enumerate(steps):
        blk = ["orange_concrete", "black_concrete", "purple_concrete", "dark_oak_planks"][i % 4]
        if i in cps:
            b.fill(x - 1, y, z - 1, x + 1, y, z + 1, "polished_blackstone", "keep")
            b.setblock(x, y + 1, z, "light_weighted_pressure_plate")
            P["checkpoints"].append((x, y + 1, z))
        else:
            b.setblock(x, y, z, blk)
    P["steps"] = steps
    top = G + 1 + TOWER["steps"]
    b.disk(cx, cz, 5, top, top, "polished_blackstone_bricks")
    # witch hat on top center
    for k in range(9):
        r = 2.6 - k * 0.28
        if r < 0.5:
            r = 0.5
        b.disk(cx + 0.5, cz + 0.5, r, top + 1 + k, top + 1 + k, "black_concrete" if k != 1 else "purple_concrete")
    b.disk(cx + 0.5, cz + 0.5, 3.6, top + 1, top + 1, "black_concrete")
    b.setblock(cx + 4, top + 1, cz, "chest[facing=west]")
    P["tower_chest"] = (cx + 4.5, top + 1, cz + 0.5)
    P["tower_down"] = (cx - 3.5, top + 1, cz + 0.5)
    P["tower_top"] = top
    P["tower_base"] = (cx + 0.5, G + 1, cz + 9.5)
    b.label(cx, cz, "魔女の塔")


def tower_entities(b):
    b.stage("build/tower_ent")
    cx, cz = TOWER["cx"], TOWER["cz"]
    x, y, z = P["tower_base"]
    text_display(b, cx + 0.5, G + 4, cz + 8.5, T("魔女の塔（パルクール）", "light_purple", True), scale=1.4)
    text_display(b, cx + 0.5, G + 3.3, cz + 8.5, T("頂上の宝箱でお菓子15個！落ちてもチェックポイントから再開", "gray"), scale=0.6)
    text_display(b, cx + 0.5, G + 2.5, cz + 10.5, T("[ チェックポイントをリセット ]", "gray"), scale=0.6)
    interaction(b, cx + 0.5, G + 1, cz + 10.5, 1.0, 1.4, ["hw.c.tower_reset"])
    for (x, y, z) in P["checkpoints"]:
        text_display(b, x + 0.5, y + 1.3, z + 0.5, T("チェックポイント", "green"), scale=0.6)
    x, y, z = P["tower_chest"]
    text_display(b, x, y + 1.6, z, T("魔女の宝箱", "gold", True), scale=0.8)
    interaction(b, x, y, z, 1.1, 1.1, ["hw.c.tower_chest"])
    x, y, z = P["tower_down"]
    item_display(b, x, y + 0.8, z, "brush", 0.9)
    text_display(b, x, y + 1.6, z, T("ほうきで地上へ", "aqua"), scale=0.7)
    interaction(b, x, y, z, 1.1, 1.5, ["hw.c.tower_down"])


# --------------------------------------------------------------------------------------------
def gallery(b):
    b.stage("build/gallery")
    # booth floor + roof
    b.fill(-47, G, 53, -39, G, 67, "dark_oak_planks")
    b.fill(-47, G + 5, 53, -39, G + 5, 67, "orange_wool")
    for z in range(53, 68, 2):
        b.fill(-47, G + 5, z, -39, G + 5, z, "black_wool")
    for (x, z) in [(-47, 53), (-47, 67), (-39, 53), (-39, 67)]:
        b.fill(x, G + 1, z, x, G + 4, z, "spruce_log")
    b.fill(-39, G + 1, 53, -39, G + 4, 56, "spruce_planks")
    b.fill(-39, G + 1, 62, -39, G + 4, 67, "spruce_planks")
    # range floor and perimeter (players cannot enter)
    b.fill(-84, G, 46, -48, G, 74, "soul_soil")
    for _ in range(60):
        x, z = rng.randint(-82, -50), rng.randint(48, 72)
        b.setblock(x, G, z, rng.choice(["soul_sand", "podzol", "coarse_dirt"]))
    b.fence_line(-48, 46, -48, 74, G + 1, "dark_oak_fence", h=1)
    b.fence_line(-84, 46, -48, 46, G + 1, "dark_oak_fence", h=2)
    b.fence_line(-84, 74, -48, 74, G + 1, "dark_oak_fence", h=2)
    # backstop wall with an orange moon
    b.fill(-85, G + 1, 46, -85, G + 14, 74, "blackstone")
    for y in range(G + 1, G + 15):
        for z in range(46, 75):
            if math.hypot(y - (G + 9), z - 60) <= 4.2:
                b.setblock(-85, y, z, "orange_concrete" if math.hypot(y - (G + 9), z - 60) <= 3.2 else "orange_terracotta")
    for z in range(48, 73, 4):
        b.setblock(-84, G + 1, z, "carved_pumpkin[facing=east]")
        b.setblock(-80 + (z % 8), G + 1, z + 1, "mossy_cobblestone_wall[up=true]")
    P["gallery_button"] = (-42.5, G + 1, 55.5)
    P["gallery_area"] = (-47, 53, -39, 67)
    b.label(-66, 60, "ゴースト射的")
    b.fillbiome(-88, 56, 42, -36, 87, 78, "soul_sand_valley")


def gallery_entities(b):
    b.stage("build/gallery_ent")
    x, y, z = P["gallery_button"]
    text_display(b, -43.0, G + 6.6, 60.5, T("ゴースト射的", "aqua", True), scale=1.6)
    text_display(b, x, y + 2.2, z, T("▶ ゴースト射的 スタート", "green", True), scale=0.9)
    text_display(b, x, y + 1.7, z, T("45秒間、弓でゴーストを撃ち落とせ！1体=お菓子1個、トップに+5", "gray"), scale=0.55)
    item_display(b, x, y + 0.8, z, "bow", 0.8)
    interaction(b, x, y, z, 1.2, 1.4, ["hw.c.gal_start"])


# --------------------------------------------------------------------------------------------
def arena(b):
    b.stage("build/arena")
    cz = -126
    b.disk(0, cz, 25, G, G, "polished_blackstone")
    for _ in range(90):
        a = rng.random() * math.tau
        r = rng.random() * 23
        x, z = round(r * math.cos(a)), round(cz + r * math.sin(a))
        b.setblock(x, G, z, rng.choice(["crimson_nylium", "netherrack", "blackstone", "gilded_blackstone", "cracked_polished_blackstone_bricks"]))
    b.disk(0, cz, 25.5, G + 1, G + 7, "blackstone", ring=1.2)
    b.disk(0, cz, 25.5, G + 8, G + 8, "blackstone_slab[type=bottom]", ring=1)
    # entrance gap at south (bridge side)
    b.fill(-2, G + 1, -102, 2, G + 8, -99, "air")
    # pillars with soul fire
    for k in range(8):
        a = math.radians(k * 45 + 22.5)
        x, z = round(17 * math.cos(a)), round(cz + 17 * math.sin(a))
        b.fill(x, G + 1, z, x, G + 6, z, "polished_blackstone_bricks")
        b.setblock(x, G + 7, z, "soul_soil")
        b.setblock(x, G + 8, z, "soul_fire")
    # lava pools (fenced)
    for (x, z) in [(-14, cz - 10), (14, cz - 10), (-14, cz + 10), (14, cz + 10)]:
        b.fill(x - 1, G, z - 1, x + 1, G, z + 1, "lava")
        b.fence_line(x - 2, z - 2, x + 2, z - 2, G + 1, "nether_brick_fence")
        b.fence_line(x - 2, z + 2, x + 2, z + 2, G + 1, "nether_brick_fence")
        b.fence_line(x - 2, z - 1, x - 2, z + 1, G + 1, "nether_brick_fence")
        b.fence_line(x + 2, z - 1, x + 2, z + 1, G + 1, "nether_brick_fence")
    # throne
    b.fill(-3, G + 1, cz - 22, 3, G + 1, cz - 18, "polished_blackstone_bricks")
    b.fill(-1, G + 2, cz - 22, 1, G + 6, cz - 22, "gilded_blackstone")
    b.setblock(0, G + 7, cz - 22, "jack_o_lantern[facing=south]")
    b.fill(-1, G + 2, cz - 21, 1, G + 2, cz - 21, "polished_blackstone_stairs[facing=north]")
    P["boss_spawn"] = (0.5, G + 2, cz - 17.5)
    P["arena_c"] = (0, cz)
    b.fence_line(-3, -101, -3, -86, G + 1, "nether_brick_fence")
    b.fence_line(3, -101, 3, -86, G + 1, "nether_brick_fence")
    gz = -93
    b.fill(-5, G + 1, gz, 5, G + 8, gz, "polished_blackstone_bricks")
    b.fill(-2, G + 1, gz, 2, G + 5, gz, "iron_bars[east=true,west=true]")
    b.fill(-1, G + 9, gz, 1, G + 9, gz, "polished_blackstone_brick_slab[type=bottom]")
    b.setblock(-4, G + 9, gz, "jack_o_lantern[facing=south]")
    b.setblock(4, G + 9, gz, "jack_o_lantern[facing=south]")
    # re-open the bridge lane (fence must not block the path) - lane is x -2..2
    P["gate"] = (-2, G + 1, gz, 2, G + 5, gz)
    b.label(0, -126, "パンプキン城（ボス）")
    b.fillbiome(-30, 56, -156, 30, 95, -96, "crimson_forest")


def arena_entities(b):
    b.stage("build/arena_ent")
    text_display(b, 0.5, G + 11, -92.5, T("パンプキン城", "red", True), scale=2.0)
    text_display(b, 0.5, G + 10, -91.0, T("3つの魂のランタンが揃うと門がひらく", "gray"), scale=0.7)


def build_all():
    b = Builder()
    ground(b); dead_trees(b); plaza(b); paths(b); mansion(b); maze(b); patch(b); village(b); tower(b); gallery(b); arena(b)
    plaza_entities(b); paths_entities(b); mansion_entities(b); maze_entities(b); patch_entities(b); village_entities(b)
    tower_entities(b); gallery_entities(b); arena_entities(b)
    return b
