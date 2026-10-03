"""Game logic mcfunctions for Halloween Night."""
from builder import T, J
from mapgen import P, G, HOUSES

NS = "halloween"
F = {}


def fn(name, body):
    lines = [l.rstrip() for l in body.strip("\n").split("\n")]
    F[name] = [l.strip() if not l.startswith("#") else l for l in lines]


def tj(*parts):
    """build a JSON text array from (text,color) tuples or dicts"""
    out = []
    for p in parts:
        if isinstance(p, dict):
            out.append(p)
        elif isinstance(p, tuple):
            d = {"text": p[0]}
            if len(p) > 1 and p[1]:
                d["color"] = p[1]
            if len(p) > 2 and p[2]:
                d["bold"] = True
            out.append(d)
        else:
            out.append({"text": p})
    return J(out)


def sc(name, obj, color=None):
    d = {"score": {"name": name, "objective": obj}}
    if color:
        d["color"] = color
    return d


PREFIX = ("[ハロウィン] ", "gold")
SPAWN = "0.5 64 12.5 180 0"
ARENA_SEL = "x=-30,y=40,z=-152,dx=60,dy=60,dz=50"
PLAYERS = "@a[tag=hw.player]"

OBJECTIVES = [
    ("hw.candy", "dummy", T("★ お菓子 ★", "gold", True)),
    ("hw.total", "dummy", None), ("hw.id", "dummy", None), ("hw.tmp", "dummy", None), ("hw.st", "dummy", None),
    ("hw.c", "dummy", None), ("hw.init", "dummy", None), ("hw.age", "dummy", None), ("hw.vy", "dummy", None),
    ("hw.cp", "dummy", None), ("hw.pk", "dummy", None), ("hw.chest", "dummy", None), ("hw.ccd", "dummy", None),
    ("hw.left", "minecraft.custom:minecraft.leave_game", None), ("hw.dead", "deathCount", None),
    ("hw.kz", "minecraft.killed:minecraft.zombie", None), ("hw.ks", "minecraft.killed:minecraft.skeleton", None),
    ("hw.kv", "minecraft.killed:minecraft.vex", None), ("hw.kb", "minecraft.killed:minecraft.wither_skeleton", None),
    ("hw.gk", "minecraft.killed:minecraft.vex", None),
] + [(f"hw.h{i}", "dummy", None) for i in range(1, 7)] + [(f"hw.sc{i}", "dummy", None) for i in range(1, 5)]

CONSTS = [2, 3, 5, 10, 20, 60, 100, 1200]


def build_logic(stage_names):
    # ------------------------------------------------------------------ load / tick
    load = []
    for (o, crit, disp) in OBJECTIVES:
        load.append(f"scoreboard objectives add {o} {crit}" + (f" {disp}" if disp else ""))
    load.append("scoreboard objectives setdisplay sidebar hw.candy")
    for c in CONSTS:
        load.append(f"scoreboard players set #{c} hw.c {c}")
    load += [
        "execute unless score #timecfg hw.st matches 1.. run scoreboard players set #timecfg hw.st 40",
        "execute unless score #state hw.st matches 0.. run scoreboard players set #state hw.st 0",
        "execute unless score #boss hw.st matches 0.. run scoreboard players set #boss hw.st 0",
        "execute unless score #lanterns hw.st matches 0.. run scoreboard players set #lanterns hw.st 0",
        f"bossbar add {NS}:timer {T('残り時間', 'light_purple')}",
        f"bossbar add {NS}:boss {T('パンプキン・キング', 'gold', True)}",
        f"bossbar set {NS}:timer color purple",
        f"bossbar set {NS}:boss color red",
        f"bossbar set {NS}:boss style notched_10",
        "tellraw @a " + tj(PREFIX, ("データパックを読み込みました。管理メニュー: ", "gray"),
                          {"text": "/function halloween:admin/menu", "color": "yellow",
                           "click_event": {"action": "suggest_command", "command": "/function halloween:admin/menu"}}),
    ]
    F["load"] = load

    fn("tick", f"""
scoreboard players add #t hw.st 1
execute as @a unless score @s hw.init matches 1 run function {NS}:player/init
execute as @a[scores={{hw.left=1..}}] run function {NS}:player/rejoin
execute as @e[type=minecraft:interaction,tag=hw.click] if data entity @s interaction run function {NS}:click/use
execute as @e[type=minecraft:interaction,tag=hw.click] if data entity @s attack run function {NS}:click/hit
execute as @a[scores={{hw.kz=1..}}] run function {NS}:reward/zombie
execute as @a[scores={{hw.ks=1..}}] run function {NS}:reward/skeleton
execute as @a[scores={{hw.kv=1..}}] run function {NS}:reward/vex
execute as @a[scores={{hw.kb=1..}}] run function {NS}:reward/boss
scoreboard players remove @a[scores={{hw.ccd=1..}}] hw.ccd 1
function {NS}:mansion/tick
function {NS}:maze/tick
function {NS}:tower/tick
execute if score #pk hw.st matches 1.. run function {NS}:patch/tick
execute if score #gal hw.st matches 1.. run function {NS}:gallery/tick
execute if score #state hw.st matches 1 run function {NS}:game/tick
function {NS}:fx/tick
""")

    # ------------------------------------------------------------------ players
    fn("player/init", f"""
scoreboard players set @s hw.init 1
gamemode adventure @s[gamemode=survival]
tp @s {SPAWN}
function {NS}:player/welcome
function {NS}:player/book
""")
    fn("player/welcome", "tellraw @s " + tj(("\n★ ハロウィン・ナイト 〜パンプキン王の呪い〜 ★\n", "gold", True),
                                          ("お菓子をいちばん多く集めた人が優勝！ 広場の「ゲームスタート」台から始めよう。\n", "yellow"),
                                          ("ルールは手帳（本）と広場の掲示板を見てね。", "gray")))
    fn("player/rejoin", f"""
scoreboard players reset @s hw.left
tellraw @s {tj(PREFIX, ("おかえりなさい！", "yellow"))}
execute unless score #state hw.st matches 1 run tp @s {SPAWN}
""")
    pages = [
        "§6§lハロウィン・ナイト§r\n〜パンプキン王の呪い〜\n\nお菓子をいちばん多く集めた人が優勝！\n\n右クリック（または左クリック）で看板や物を調べられるよ。",
        "§l集め方§r\n・村の家をノック\n・カボチャ狩り\n・ゴースト射的\n・魔女の塔の宝箱\n・隠しお菓子（20個）\n・おばけを倒す\n・ボスを倒す",
        "§l目的§r\n屋敷・墓地迷路・カボチャ畑で「魂のランタン」を見つけて祭壇へ。3つ揃うと北の城門がひらき、パンプキン・キングとの決戦！",
        "§lヒント§r\n・ショップでお菓子を使うと装備が買える（ランキングからは減る）\n・魔女の大釜は運だめし\n・残り5分はお菓子2倍！",
    ]
    pages = [p.replace("§6§l", "").replace("§l", "").replace("§r", "") for p in pages]
    fn("player/book", "give @s minecraft:written_book[written_book_content={title:\"ハロウィンの手帳\",author:\"パンプキン・キング\",pages:["
       + ",".join(J(p) for p in pages) + "]}]")
    fn("player/starter", f"""
give @s minecraft:wooden_sword[unbreakable={{}}]
give @s minecraft:pumpkin_pie 8
function {NS}:player/book
""")

    # ------------------------------------------------------------------ clicks
    fn("click/use", f"""
tag @s add hw.this
execute on target run function {NS}:click/route
tag @s remove hw.this
data remove entity @s interaction
""")
    fn("click/hit", f"""
tag @s add hw.this
execute on attacker run function {NS}:click/route
tag @s remove hw.this
data remove entity @s attack
""")
    THIS = "@e[type=minecraft:interaction,tag=hw.this,limit=1"
    free_actions = [("costume", "plaza/costume"), ("note", "mansion/note"), ("start", "game/start_button"),
                    ("tower_down", "tower/down"), ("tower_reset", "tower/reset_cp")]
    game_actions = [("shop", "shop/buy"), ("house", "village/knock"), ("cauldron", "village/cauldron"),
                    ("pk_start", "patch/start"), ("pt", "patch/hit"), ("gal_start", "gallery/start"),
                    ("tower_chest", "tower/chest"), ("lantern", "lantern/take"), ("candy", "hidden/take")]
    route = [f"scoreboard players operation #id hw.tmp = {THIS}] hw.id"]
    for tag, f in free_actions:
        route.append(f"execute if entity {THIS},tag=hw.c.{tag}] run return run function {NS}:{f}")
    route.append(f"execute unless score #state hw.st matches 1 run return run function {NS}:click/not_started")
    for tag, f in game_actions:
        route.append(f"execute if entity {THIS},tag=hw.c.{tag}] run return run function {NS}:{f}")
    F["click/route"] = route
    fn("click/not_started", f"""
tellraw @s {tj(PREFIX, ("まだゲームが始まっていません。広場の「ゲームスタート」台をクリック！", "yellow"))}
execute at @s run playsound minecraft:block.note_block.bass master @s ~ ~ ~ 1 0.8
""")

    # ------------------------------------------------------------------ candy
    fn("candy/add", f"""
execute unless score #state hw.st matches 1 run return 0
execute if score #double hw.st matches 1 run scoreboard players operation #gain hw.tmp *= #2 hw.c
scoreboard players operation @s hw.candy += #gain hw.tmp
scoreboard players operation @s hw.total += #gain hw.tmp
title @s actionbar {tj(("+", "gold", True), sc("#gain", "hw.tmp", "gold"), (" お菓子", "gold"))}
execute at @s run playsound minecraft:entity.experience_orb.pickup master @s ~ ~ ~ 0.8 1.3
""")
    for k, mult, obj in [("zombie", 2, "hw.kz"), ("skeleton", 2, "hw.ks"), ("vex", 1, "hw.kv")]:
        fn(f"reward/{k}", f"""
scoreboard players operation #gain hw.tmp = @s {obj}
scoreboard players set #k hw.tmp {mult}
scoreboard players operation #gain hw.tmp *= #k hw.tmp
scoreboard players set @s {obj} 0
function {NS}:candy/add
""")
    fn("reward/boss", f"""
scoreboard players set @s hw.kb 0
scoreboard players set #gain hw.tmp 30
function {NS}:candy/add
tellraw @a {tj(PREFIX, {"selector": "@s", "color": "yellow"}, (" がパンプキン・キングにとどめを刺した！ ボーナス +30", "gold"))}
""")

    # ------------------------------------------------------------------ plaza: costume / shop
    cos = P["costumes"]
    lines = [
        "execute if score #id hw.tmp matches 0 run item replace entity @s armor.head with minecraft:air",
        f"execute if score #id hw.tmp matches 0 run tellraw @s {tj(('仮装を脱いだ', 'gray'))}",
    ]
    for i, (it, nm) in enumerate(cos):
        lines.append(f"execute if score #id hw.tmp matches {i+1} run item replace entity @s armor.head with minecraft:{it}")
        lines.append(f"execute if score #id hw.tmp matches {i+1} run tellraw @s {tj(('「' + nm + '」に変身した！', 'light_purple'))}")
    lines += ["execute at @s run playsound minecraft:item.armor.equip_leather master @s ~ ~ ~ 1 1",
              "execute at @s run particle minecraft:witch ~ ~1.2 ~ 0.3 0.6 0.3 0.05 20"]
    F["plaza/costume"] = lines

    shop_give = {
        "iron_sword": ["give @s minecraft:iron_sword"],
        "bow": ["give @s minecraft:bow", "give @s minecraft:arrow 16"],
        "golden_apple": ["give @s minecraft:golden_apple"],
        "iron_chestplate": ["item replace entity @s armor.chest with minecraft:iron_chestplate"],
        "potion": ["give @s minecraft:splash_potion[potion_contents={potion:\"minecraft:healing\"}]"],
    }
    buy = []
    for i, (it, nm, price) in enumerate(P["shop"]):
        buy.append(f"execute if score #id hw.tmp matches {i+1} run return run function {NS}:shop/item{i+1}")
        fn(f"shop/item{i+1}", f"""
execute unless score @s hw.candy matches {price}.. run return run function {NS}:shop/poor
scoreboard players remove @s hw.candy {price}
""" + "\n".join(shop_give[it]) + f"""
tellraw @s {tj(PREFIX, ('「' + nm + '」を買った！（お菓子 -' + str(price) + '）', 'green'))}
execute at @s run playsound minecraft:entity.villager.yes master @s ~ ~ ~ 1 1
""")
    F["shop/buy"] = buy
    fn("shop/poor", f"""
tellraw @s {tj(PREFIX, ("お菓子が足りないよ！", "red"))}
execute at @s run playsound minecraft:entity.villager.no master @s ~ ~ ~ 1 1
""")

    # ------------------------------------------------------------------ mansion
    notes = [
        "日記 その1『……燭台の1番目には、いつも火を灯しておくこと。』",
        "日記 その2『2番目の燭台だけは、決して灯してはならない。あの子が目を覚ますから。』",
        "日記 その3『3番目と4番目にも火を。そうすれば天井裏への道がひらく。』",
    ]
    F["mansion/note"] = [f"execute if score #id hw.tmp matches {i+1} run tellraw @s {tj(('📖 ', 'gray'), (n, 'light_purple'))}".replace("📖 ", "") for i, n in enumerate(notes)] + [
        "execute at @s run playsound minecraft:item.book.page_turn master @s ~ ~ ~ 1 1"]
    lv = P["levers"]
    pattern = [True, False, True, True]
    cond = " ".join(f"if block {x} {y} {z+1} minecraft:lever[powered={'true' if p else 'false'}]" for (x, y, z), p in zip(lv, pattern))
    scares = [
        (1, "x=-4,y=64,z=-50,dx=8,dy=3,dz=4"),
        (2, "x=-4,y=71,z=-63,dx=8,dy=3,dz=4"),
        (3, "x=-14,y=71,z=-64,dx=8,dy=3,dz=5"),
        (4, "x=-5,y=77,z=-58,dx=10,dy=4,dz=6"),
    ]
    mt = [f"execute if score #mansion hw.st matches 0 {cond} run function {NS}:mansion/solve"]
    for n, box in scares:
        mt.append(f"execute as @a[{box},gamemode=!spectator] unless score @s hw.sc{n} matches 1 run function {NS}:mansion/scare{n}")
        fn(f"mansion/scare{n}", f"""
scoreboard players set @s hw.sc{n} 1
function {NS}:fx/jumpscare
""")
    F["mansion/tick"] = mt
    ladder = "\n".join(f"setblock {x} {y} {z} minecraft:ladder[facing=north]" for (x, y, z) in P["ladder"])
    hx, hy, hz = P["hatch"]
    fn("mansion/solve", f"""
scoreboard players set #mansion hw.st 1
{ladder}
setblock {hx} {hy} {hz} minecraft:ladder[facing=north]
playsound minecraft:block.wooden_trapdoor.open master @a 0 72 -58 2 0.6
playsound minecraft:entity.ghast.ambient master @a 0 72 -58 2 0.5
tellraw @a[x=-16,y=60,z=-66,dx=32,dy=30,dz=22] {tj(('ガタン……！ 2階の天井から梯子が下りてきた。', 'light_purple'))}
title @a[x=-16,y=60,z=-66,dx=32,dy=30,dz=22] actionbar {tj(('天井裏への道がひらいた', 'light_purple'))}
""")
    fn("fx/jumpscare", f"""
effect give @s minecraft:darkness 3 0 true
effect give @s minecraft:slowness 2 2 true
execute at @s run playsound minecraft:entity.ghast.scream master @s ~ ~ ~ 1 0.6
execute at @s run playsound minecraft:entity.creaking.activate master @s ~ ~ ~ 1 0.8
execute at @s anchored eyes positioned ^ ^ ^1.6 run summon minecraft:creaking ~ ~-1.5 ~ {{NoAI:1b,Silent:1b,Invulnerable:1b,PersistenceRequired:1b,Tags:["hw.ghost","hw.tmpent"]}}
execute at @s as @e[type=minecraft:creaking,tag=hw.ghost,distance=..4,sort=nearest,limit=1] at @s run tp @s ~ ~ ~ facing entity @p eyes
schedule function {NS}:fx/ghost_clear 25t append
""")
    fn("fx/ghost_clear", """
execute as @e[type=minecraft:creaking,tag=hw.ghost] at @s run particle minecraft:large_smoke ~ ~1 ~ 0.3 0.8 0.3 0.02 30
kill @e[type=minecraft:creaking,tag=hw.ghost]
""")

    # ------------------------------------------------------------------ lanterns
    lanterns = [("L1", "① 屋敷の魂のランタン"), ("L2", "② 墓地の魂のランタン"), ("L3", "③ カボチャ畑の魂のランタン")]
    take = [f"kill {THIS}]"]
    for i, (key, nm) in enumerate(lanterns):
        take.append(f"execute if score #id hw.tmp matches {i+1} run function {NS}:lantern/got{i+1}")
        x, y, z = P[key]
        ax, az = P["altar"][i]
        fn(f"lantern/got{i+1}", f"""
setblock {x} {y} {z} minecraft:air
setblock {ax} {G+3} {az} minecraft:soul_lantern
scoreboard players set #l{i+1} hw.st 1
scoreboard players add #lanterns hw.st 1
kill @e[type=minecraft:text_display,tag=hw.ltext{i+1}]
scoreboard players set #gain hw.tmp 10
function {NS}:candy/add
tellraw @a {tj(PREFIX, {"selector": "@s", "color": "yellow"}, (" が ", "white"), (nm, "aqua", True), (" を手に入れた！ (", "white"), sc("#lanterns", "hw.st", "aqua"), ("/3)", "white"))}
playsound minecraft:ui.toast.challenge_complete master @a ~ ~ ~ 1 1
particle minecraft:soul_fire_flame {ax} {G+3.5} {az} 0.3 0.5 0.3 0.05 40 force
""")
    take.append(f"execute if score #lanterns hw.st matches 3.. run function {NS}:lantern/all")
    F["lantern/take"] = take
    gx1, gy1, gz, gx2, gy2, _ = P["gate"]
    fn("lantern/all", f"""
fill {gx1} {gy1} {gz} {gx2} {gy2} {gz} minecraft:air
title @a times 10 60 20
title @a title {T("城門がひらいた！", "gold", True)}
title @a subtitle {T("北のパンプキン城へ向かえ", "red")}
playsound minecraft:block.iron_door.open master @a 0 65 {gz} 3 0.5
playsound minecraft:entity.wither.ambient master @a ~ ~ ~ 0.6 0.5
summon minecraft:lightning_bolt 0 64 -146
""")

    def lantern_spawn(key, i):
        x, y, z = P[key]
        return [f"setblock {x} {y} {z} minecraft:soul_lantern",
                f"summon minecraft:interaction {x+0.5} {y} {z+0.5} {{width:0.9f,height:1.0f,response:1b,Tags:[\"hw.click\",\"hw.c.lantern\",\"hw.tmpent\",\"hw.new\"]}}",
                f"scoreboard players set @e[type=minecraft:interaction,tag=hw.new,limit=1] hw.id {i}",
                "tag @e[type=minecraft:interaction,tag=hw.new] remove hw.new"]

    # ------------------------------------------------------------------ maze
    mt = []
    for i, (x, z) in enumerate(P["traps"]):
        n = i + 1
        mt.append(f"execute if score #trap{n} hw.st matches 1.. run scoreboard players remove #trap{n} hw.st 1")
        mt.append(f"execute if block {x} 64 {z} minecraft:polished_blackstone_pressure_plate[powered=true] unless score #trap{n} hw.st matches 1.. run function {NS}:maze/trap{n}")
        fn(f"maze/trap{n}", f"""
scoreboard players set #trap{n} hw.st 300
execute positioned {x+0.5} 64 {z+0.5} run function {NS}:maze/ambush
""")
    F["maze/tick"] = mt
    fn("maze/ambush", f"""
execute unless score #state hw.st matches 1 run return 0
execute store result score #n hw.tmp if entity @e[type=minecraft:zombie,tag=hw.mob]
execute if score #n hw.tmp matches 12.. run return 0
particle minecraft:soul ~ ~0.5 ~ 0.8 0.3 0.8 0.02 40
particle minecraft:block{{block_state:{{Name:"minecraft:podzol"}}}} ~ ~0.2 ~ 0.6 0.1 0.6 0.1 30
playsound minecraft:entity.zombie.ambient hostile @a ~ ~ ~ 1.5 0.6
summon minecraft:zombie ~ ~ ~ {{Tags:["hw.mob"],PersistenceRequired:1b,CustomName:{T("墓場のゾンビ", "dark_green")},equipment:{{head:{{id:"minecraft:carved_pumpkin",count:1}}}},drop_chances:{{head:0.0f}}}}
summon minecraft:zombie ~ ~ ~ {{Tags:["hw.mob"],PersistenceRequired:1b,CustomName:{T("墓場のゾンビ", "dark_green")},equipment:{{head:{{id:"minecraft:jack_o_lantern",count:1}}}},drop_chances:{{head:0.0f}}}}
tellraw @a[distance=..10] {tj(('墓の下から何かが……！', 'dark_green'))}
""")

    # ------------------------------------------------------------------ patch minigame
    px1, px2, pz1, pz2 = P["patch_area"]
    fn("patch/start", f"""
execute if score #pk hw.st matches 1.. run return run tellraw @s {tj(PREFIX, ('カボチャ狩りは進行中！', 'yellow'))}
scoreboard players set #pk hw.st 1200
scoreboard players set #pk_total hw.st 0
scoreboard players set @a hw.pk 0
tellraw @a {tj(PREFIX, {"selector": "@s", "color": "yellow"}, (" がカボチャ狩りを始めた！ 60秒間、光るカボチャを叩け（金色は3点）", "gold"))}
title @a[x=-84,y=60,z=-24,dx=48,dy=20,dz=48] title {T("カボチャ狩り！", "gold", True)}
title @a[x=-84,y=60,z=-24,dx=48,dy=20,dz=48] subtitle {T("みんなで20個たたけば ③ ランタン", "yellow")}
playsound minecraft:event.raid.horn master @a -60 64 0 3 1.2
""")
    fn("patch/tick", f"""
scoreboard players remove #pk hw.st 1
scoreboard players operation #s hw.tmp = #pk hw.st
scoreboard players operation #s hw.tmp %= #10 hw.c
execute if score #s hw.tmp matches 0 store result score #n hw.tmp if entity @e[type=minecraft:interaction,tag=hw.pt]
execute if score #s hw.tmp matches 0 if score #n hw.tmp matches ..9 run function {NS}:patch/spawn
execute if score #s hw.tmp matches 5 if score #n hw.tmp matches ..5 run function {NS}:patch/spawn
scoreboard players add @e[tag=hw.ptall] hw.age 1
execute as @e[type=minecraft:interaction,tag=hw.pt,scores={{hw.age=110..}}] at @s run particle minecraft:smoke ~ ~0.4 ~ 0.2 0.2 0.2 0.01 6
kill @e[tag=hw.ptall,scores={{hw.age=110..}}]
scoreboard players operation #s hw.tmp = #pk hw.st
scoreboard players operation #s hw.tmp %= #20 hw.c
execute if score #s hw.tmp matches 0 run function {NS}:patch/bar
execute if score #pk hw.st matches 0 run function {NS}:patch/end
""")
    fn("patch/bar", f"""
scoreboard players operation #sec hw.tmp = #pk hw.st
scoreboard players operation #sec hw.tmp /= #20 hw.c
title @a[x=-84,y=60,z=-24,dx=48,dy=20,dz=48] actionbar {tj(('カボチャ狩り 残り ', 'gold'), sc('#sec', 'hw.tmp', 'white'), ('秒 ／ 合計 ', 'gold'), sc('#pk_total', 'hw.st', 'white'), ('/20', 'gold'))}
""")
    fn("patch/spawn", f"""
execute store result storage {NS}:tmp x int 1 run random value {px1}..{px2}
execute store result storage {NS}:tmp z int 1 run random value {pz1}..{pz2}
execute store result score #g hw.tmp run random value 1..8
function {NS}:patch/spawn_at with storage {NS}:tmp
""")
    disp = ("{{block_state:{{Name:\"minecraft:{blk}\"{props}}},Tags:[\"hw.ptall\",\"hw.ptd\",\"hw.tmpent\"],brightness:{{sky:15,block:15}},"
            "Glowing:1b,glow_color_override:{glow},transformation:{{left_rotation:[0f,0f,0f,1f],right_rotation:[0f,0f,0f,1f],"
            "translation:[0.1f,0.0f,0.1f],scale:[0.8f,0.8f,0.8f]}}}}")
    F["patch/spawn_at"] = [
        "$execute unless block $(x) 64 $(z) minecraft:air run return 0",
        "$execute unless block $(x) 65 $(z) minecraft:air run return 0",
        f"execute if score #g hw.tmp matches 1 run return run function {NS}:patch/spawn_gold with storage {NS}:tmp",
        "$summon minecraft:block_display $(x) 64 $(z) " + disp.format(blk="jack_o_lantern", props=",Properties:{facing:\"south\"}", glow=16744448),
        "$execute positioned $(x) 64 $(z) align xyz positioned ~0.5 ~ ~0.5 run summon minecraft:interaction ~ ~ ~ {width:0.95f,height:0.95f,response:1b,Tags:[\"hw.click\",\"hw.c.pt\",\"hw.pt\",\"hw.ptall\",\"hw.tmpent\"]}",
        "$particle minecraft:flame $(x) 64.5 $(z) 0.3 0.3 0.3 0.02 8",
    ]
    F["patch/spawn_gold"] = [
        "$summon minecraft:block_display $(x) 64 $(z) " + disp.format(blk="raw_gold_block", props="", glow=16766720),
        "$execute positioned $(x) 64 $(z) align xyz positioned ~0.5 ~ ~0.5 run summon minecraft:interaction ~ ~ ~ {width:0.95f,height:0.95f,response:1b,Tags:[\"hw.click\",\"hw.c.pt\",\"hw.pt\",\"hw.gold\",\"hw.ptall\",\"hw.tmpent\"]}",
    ]
    fn("patch/hit", f"""
execute unless score #pk hw.st matches 1.. run return 0
scoreboard players set #gain hw.tmp 1
execute if entity {THIS},tag=hw.gold] run scoreboard players set #gain hw.tmp 3
scoreboard players operation @s hw.pk += #gain hw.tmp
scoreboard players operation #pk_total hw.st += #gain hw.tmp
execute as {THIS}] at @s run function {NS}:patch/pop
function {NS}:candy/add
""")
    fn("patch/pop", """
particle minecraft:block{block_state:{Name:"minecraft:pumpkin"}} ~ ~0.4 ~ 0.3 0.3 0.3 0.1 25
particle minecraft:flame ~ ~0.4 ~ 0.2 0.2 0.2 0.05 10
playsound minecraft:block.wood.break master @a ~ ~ ~ 1 0.8
playsound minecraft:entity.chicken.egg master @a ~ ~ ~ 1 0.6
kill @e[type=minecraft:block_display,tag=hw.ptd,distance=..1.2]
kill @s
""")
    l3 = "\n".join(lantern_spawn("L3", 3))
    fn("patch/end", f"""
kill @e[tag=hw.ptall]
scoreboard players set #max hw.tmp 0
execute as @a run scoreboard players operation #max hw.tmp > @s hw.pk
tellraw @a {tj(PREFIX, ('カボチャ狩り終了！ みんなの合計: ', 'gold'), sc('#pk_total', 'hw.st', 'yellow'), (' 個', 'gold'))}
execute if score #max hw.tmp matches 1.. as @a if score @s hw.pk = #max hw.tmp run tellraw @a {tj(('  いちばん叩いた人: ', 'gray'), {"selector": "@s", "color": "yellow"}, ('（', 'gray'), sc('#max', 'hw.tmp', 'yellow'), ('個）', 'gray'))}
execute if score #pk_total hw.st matches 20.. if score #pk_done hw.st matches 0 run function {NS}:patch/success
execute if score #pk_total hw.st matches ..19 if score #pk_done hw.st matches 0 run tellraw @a {tj(PREFIX, ('あと少し！ 合計20個で ③ ランタンが現れる。もう一度挑戦しよう', 'yellow'))}
""")
    fn("patch/success", f"""
scoreboard players set #pk_done hw.st 1
{l3}
tellraw @a {tj(PREFIX, ('大収穫！ 畑の西のワラ山のそばに ③ 魂のランタンが現れた！', 'aqua', True))}
playsound minecraft:block.respawn_anchor.charge master @a -74 65 0 3 1
particle minecraft:soul_fire_flame -73.5 65.5 0.5 0.3 0.6 0.3 0.05 60 force
""")

    # ------------------------------------------------------------------ gallery
    fn("gallery/start", f"""
execute if score #gal hw.st matches 1.. run return run tellraw @s {tj(PREFIX, ('ゴースト射的は進行中！', 'yellow'))}
scoreboard players set #gal hw.st 900
scoreboard players set @a hw.gk 0
tag @a[x=-48,y=62,z=52,dx=10,dy=6,dz=16,gamemode=!spectator] add hw.gal
tag @s add hw.gal
give @a[tag=hw.gal] minecraft:bow[custom_data={{hw:"gal"}},enchantments={{"minecraft:infinity":1}},unbreakable={{}},custom_name={T("射的の弓", "aqua", italic=False)}]
give @a[tag=hw.gal] minecraft:arrow[custom_data={{hw:"gal"}}] 1
title @a[tag=hw.gal] title {T("ゴースト射的！", "aqua", True)}
title @a[tag=hw.gal] subtitle {T("45秒間 撃ちまくれ", "white")}
tellraw @a {tj(PREFIX, {"selector": "@a[tag=hw.gal]", "color": "yellow"}, (" がゴースト射的に挑戦中！", "aqua"))}
playsound minecraft:event.raid.horn master @a -60 64 60 3 1.5
""")
    fn("gallery/tick", f"""
scoreboard players remove #gal hw.st 1
scoreboard players operation #s hw.tmp = #gal hw.st
scoreboard players operation #s hw.tmp %= #10 hw.c
execute if score #s hw.tmp matches 0 store result score #n hw.tmp if entity @e[type=minecraft:vex,tag=hw.gv]
execute if score #s hw.tmp matches 0 if score #n hw.tmp matches ..6 run function {NS}:gallery/spawn
execute as @e[type=minecraft:vex,tag=hw.gv] at @s run tp @s ^ ^ ^0.13
scoreboard players add @e[type=minecraft:vex,tag=hw.gv] hw.age 1
execute as @e[type=minecraft:vex,tag=hw.gv,scores={{hw.age=100..}}] at @s run particle minecraft:poof ~ ~0.5 ~ 0.2 0.2 0.2 0.02 8
kill @e[type=minecraft:vex,tag=hw.gv,scores={{hw.age=100..}}]
scoreboard players operation #s hw.tmp = #gal hw.st
scoreboard players operation #s hw.tmp %= #20 hw.c
scoreboard players operation #sec hw.tmp = #gal hw.st
scoreboard players operation #sec hw.tmp /= #20 hw.c
execute if score #s hw.tmp matches 0 run title @a[tag=hw.gal] actionbar {tj(('ゴースト射的 残り ', 'aqua'), sc('#sec', 'hw.tmp', 'white'), ('秒', 'aqua'))}
execute if score #gal hw.st matches 0 run function {NS}:gallery/end
""")
    fn("gallery/spawn", f"""
execute store result storage {NS}:tmp x int 1 run random value -78..-56
execute store result storage {NS}:tmp y int 1 run random value 65..70
execute store result score #d hw.tmp run random value 0..1
execute if score #d hw.tmp matches 0 store result storage {NS}:tmp z int 1 run random value 49..58
execute if score #d hw.tmp matches 1 store result storage {NS}:tmp z int 1 run random value 62..71
execute if score #d hw.tmp matches 0 run function {NS}:gallery/spawn_s with storage {NS}:tmp
execute if score #d hw.tmp matches 1 run function {NS}:gallery/spawn_n with storage {NS}:tmp
""")
    vex = ("{NoAI:1b,PersistenceRequired:1b,Glowing:1b,Rotation:[@YAW@f,0f],Health:1.0f,"
           "attributes:[{id:\"minecraft:max_health\",base:1.0d}],CustomName:" + T("ゴースト", "aqua") + ","
           "Tags:[\"hw.gv\",\"hw.mob\",\"hw.tmpent\"]}")
    F["gallery/spawn_s"] = ["$summon minecraft:vex $(x) $(y) $(z) " + vex.replace("@YAW@", "0.0"),
                            "$particle minecraft:soul $(x) $(y) $(z) 0.3 0.3 0.3 0.02 10"]
    F["gallery/spawn_n"] = ["$summon minecraft:vex $(x) $(y) $(z) " + vex.replace("@YAW@", "180.0"),
                            "$particle minecraft:soul $(x) $(y) $(z) 0.3 0.3 0.3 0.02 10"]
    fn("gallery/end", f"""
kill @e[type=minecraft:vex,tag=hw.gv]
kill @e[type=minecraft:arrow,x=-90,y=50,z=40,dx=56,dy=40,dz=40]
clear @a minecraft:bow[minecraft:custom_data={{hw:"gal"}}]
clear @a minecraft:arrow[minecraft:custom_data={{hw:"gal"}}]
scoreboard players set #max hw.tmp 0
execute as @a[tag=hw.gal] run scoreboard players operation #max hw.tmp > @s hw.gk
tellraw @a {tj(PREFIX, ('ゴースト射的 終了！', 'aqua'))}
execute as @a[tag=hw.gal] run tellraw @a {tj(('  ', 'gray'), {"selector": "@s", "color": "yellow"}, (': ', 'gray'), sc('@s', 'hw.gk', 'white'), (' 体', 'gray'))}
execute if score #max hw.tmp matches 1.. as @a[tag=hw.gal] if score @s hw.gk = #max hw.tmp run function {NS}:gallery/top
tag @a remove hw.gal
""")
    fn("gallery/top", f"""
tellraw @a {tj(('  トップ賞 ', 'gold'), {"selector": "@s", "color": "yellow"}, (' お菓子 +5', 'gold'))}
scoreboard players set #gain hw.tmp 5
function {NS}:candy/add
""")

    # ------------------------------------------------------------------ village
    knock = []
    for i, h in enumerate(P["houses"]):
        n = i + 1
        name = h[3]
        knock.append(f"execute if score #id hw.tmp matches {n} if score @s hw.h{n} matches 1 run return run function {NS}:village/already")
        knock.append(f"execute if score #id hw.tmp matches {n} run scoreboard players set @s hw.h{n} 1")
        knock.append(f"execute if score #id hw.tmp matches {n} run tellraw @s {tj(('[' + name + '] ', 'yellow'), ('「はーい、トリック・オア・トリート？」', 'white'))}")
    knock += [
        "execute at @s run playsound minecraft:entity.zombie.attack_wooden_door master @a ~ ~ ~ 0.6 1.4",
        "execute store result score #r hw.tmp run random value 1..10",
        f"execute if score #r hw.tmp matches 1..5 run function {NS}:village/treat",
        f"execute if score #r hw.tmp matches 6 run function {NS}:village/trick_float",
        f"execute if score #r hw.tmp matches 7 run function {NS}:village/trick_dark",
        f"execute if score #r hw.tmp matches 8 run function {NS}:village/trick_bats",
        f"execute if score #r hw.tmp matches 9 run function {NS}:village/trick_pumpkin",
        f"execute if score #r hw.tmp matches 10 run function {NS}:village/jackpot",
    ]
    F["village/knock"] = knock
    fn("village/already", f"""
tellraw @s {tj(('「もうお菓子はあげたでしょ！ 他の家へどうぞ」', 'gray'))}
execute at @s run playsound minecraft:entity.villager.no master @s ~ ~ ~ 1 1
""")
    fn("village/treat", f"""
execute store result score #gain hw.tmp run random value 2..6
tellraw @s {tj(('TREAT！ ', 'gold', True), ('お菓子をもらった！ +', 'yellow'), sc('#gain', 'hw.tmp', 'yellow'))}
execute at @s run particle minecraft:happy_villager ~ ~1 ~ 0.5 0.5 0.5 0.1 20
function {NS}:candy/add
""")
    fn("village/trick_float", f"""
tellraw @s {tj(('TRICK！ ', 'dark_purple', True), ('いたずらだ！ ふわふわ〜', 'light_purple'))}
effect give @s minecraft:levitation 2 1 true
execute at @s run playsound minecraft:entity.witch.celebrate master @a ~ ~ ~ 1 1
""")
    fn("village/trick_dark", f"""
tellraw @s {tj(('TRICK！ ', 'dark_purple', True), ('目の前が真っ暗に……！', 'light_purple'))}
effect give @s minecraft:darkness 5 0 true
execute at @s run playsound minecraft:entity.ghast.scream master @s ~ ~ ~ 1 0.7
""")
    fn("village/trick_bats", f"""
tellraw @s {tj(('TRICK！ ', 'dark_purple', True), ('コウモリの大群だ！', 'light_purple'))}
execute at @s run summon minecraft:bat ~ ~1 ~ {{Tags:["hw.mob","hw.tmpent"]}}
execute at @s run summon minecraft:bat ~ ~1 ~ {{Tags:["hw.mob","hw.tmpent"]}}
execute at @s run summon minecraft:bat ~ ~1 ~ {{Tags:["hw.mob","hw.tmpent"]}}
execute at @s run summon minecraft:bat ~ ~1 ~ {{Tags:["hw.mob","hw.tmpent"]}}
execute at @s run summon minecraft:bat ~ ~1 ~ {{Tags:["hw.mob","hw.tmpent"]}}
execute at @s run summon minecraft:bat ~ ~1 ~ {{Tags:["hw.mob","hw.tmpent"]}}
execute at @s run playsound minecraft:entity.bat.takeoff master @a ~ ~ ~ 1 0.8
""")
    fn("village/trick_pumpkin", f"""
tellraw @s {tj(('TRICK！ ', 'dark_purple', True), ('カボチャ頭の呪い！（広場のクローゼットで脱げる）', 'light_purple'))}
item replace entity @s armor.head with minecraft:carved_pumpkin
execute at @s run playsound minecraft:block.pumpkin.carve master @a ~ ~ ~ 1 0.8
""")
    fn("village/jackpot", f"""
tellraw @s {tj(('大当たり！！ ', 'gold', True), ('袋いっぱいのお菓子をもらった！', 'yellow'))}
scoreboard players set #gain hw.tmp 12
function {NS}:candy/add
execute at @s run function {NS}:fx/firework
execute at @s run playsound minecraft:ui.toast.challenge_complete master @a ~ ~ ~ 1 1.2
""")
    buffs = [("speed", 60, 1, "スピードアップ！"), ("strength", 60, 0, "ちからがみなぎる！"), ("regeneration", 30, 1, "体力がぐんぐん回復！"),
             ("jump_boost", 60, 1, "ジャンプ力アップ！"), ("night_vision", 180, 0, "暗いところがよく見える！"),
             ("invisibility", 40, 0, "透明になった！"), ("resistance", 60, 0, "からだが固くなった！")]
    cau = [
        f"execute if score @s hw.ccd matches 1.. run return run tellraw @s {tj(('大釜がまだぐつぐつしている……', 'gray'))}",
        f"execute unless score @s hw.candy matches 3.. run return run function {NS}:shop/poor",
        "scoreboard players remove @s hw.candy 3",
        "scoreboard players set @s hw.ccd 60",
        "playsound minecraft:block.brewing_stand.brew master @a 0 65 74 1 1",
        "particle minecraft:witch 0.5 65.2 74.5 0.4 0.4 0.4 0.1 40",
        f"execute store result score #r hw.tmp run random value 1..{len(buffs)+1}",
    ]
    for i, (eff, sec, amp, msg) in enumerate(buffs):
        cau.append(f"execute if score #r hw.tmp matches {i+1} run effect give @s minecraft:{eff} {sec} {amp}")
        cau.append(f"execute if score #r hw.tmp matches {i+1} run tellraw @s {tj(('魔女の大釜：', 'light_purple'), (msg, 'green'))}")
    k = len(buffs) + 1
    cau.append(f"execute if score #r hw.tmp matches {k} run effect give @s minecraft:slowness 10 1")
    cau.append(f"execute if score #r hw.tmp matches {k} run effect give @s minecraft:nausea 6 0")
    cau.append(f"execute if score #r hw.tmp matches {k} run tellraw @s {tj(('魔女の大釜：', 'light_purple'), ('ハズレ！ ネバネバのスライム汁……', 'red'))}")
    cau.append(f"execute if score #r hw.tmp matches {k} at @s run playsound minecraft:entity.slime.squish master @a ~ ~ ~ 1 0.6")
    F["village/cauldron"] = cau

    # ------------------------------------------------------------------ tower
    tt = []
    cps = P["checkpoints"]
    for i, (x, y, z) in enumerate(cps):
        n = i + 1
        tt.append(f"execute as @a[x={x},y={y},z={z},dx=0,dy=0,dz=0,gamemode=!spectator] unless score @s hw.cp matches {n}.. run function {NS}:tower/cp{n}")
        fn(f"tower/cp{n}", f"""
scoreboard players set @s hw.cp {n}
title @s actionbar {tj(('チェックポイント ' + str(n) + ' ！', 'green', True))}
execute at @s run playsound minecraft:block.note_block.chime master @s ~ ~ ~ 1 1.5
""")
        fn(f"tower/back{n}", f"""
effect give @s minecraft:slow_falling 1 0 true
tp @s {x+0.5} {y} {z+0.5}
title @s actionbar {tj(('チェックポイントに戻った', 'yellow'))}
execute at @s run playsound minecraft:entity.enderman.teleport master @s ~ ~ ~ 1 1
""")
    tt.append(f"execute as @a[scores={{hw.cp=1..}},x=46,y=60,z=46,dx=28,dy=50,dz=28] run function {NS}:tower/fall")
    F["tower/tick"] = tt
    fall = ["execute store result score @s hw.vy run data get entity @s Motion[1] 100"]
    for i, (x, y, z) in enumerate(cps):
        fall.append(f"execute if score @s hw.vy matches ..-65 if score @s hw.cp matches {i+1} if entity @s[y=0,dy={y-3}] run return run function {NS}:tower/back{i+1}")
    F["tower/fall"] = fall
    fn("tower/chest", f"""
execute if score @s hw.chest matches 1 run return run tellraw @s {tj(('宝箱はもう空っぽだ', 'gray'))}
scoreboard players set @s hw.chest 1
scoreboard players set @s hw.cp 0
scoreboard players set #gain hw.tmp 15
function {NS}:candy/add
tellraw @a {tj(PREFIX, {"selector": "@s", "color": "yellow"}, (' が魔女の塔を制覇した！ お菓子 +15', 'light_purple'))}
execute at @s run function {NS}:fx/firework
execute at @s run playsound minecraft:block.chest.open master @a ~ ~ ~ 1 0.8
""")
    bx, by, bz = P["tower_base"]
    fn("tower/down", f"""
scoreboard players set @s hw.cp 0
effect give @s minecraft:slow_falling 3 0 true
tp @s {bx} {by} {bz+1}
execute at @s run playsound minecraft:entity.phantom.flap master @a ~ ~ ~ 1 1
""")
    fn("tower/reset_cp", f"""
scoreboard players set @s hw.cp 0
tellraw @s {tj(('チェックポイントをリセットした', 'gray'))}
""")

    # ------------------------------------------------------------------ hidden candies
    hc = P["hidden"]
    items = ["cookie", "pumpkin_pie", "honey_bottle", "glow_berries", "cake", "sweet_berries", "golden_carrot"]
    hsum = []
    for i, (x, y, z) in enumerate(hc):
        it = items[i % len(items)]
        hsum.append(f"summon minecraft:item_display {x+0.5} {y+0.35} {z+0.5} {{item:{{id:\"minecraft:{it}\",count:1}},billboard:\"vertical\",brightness:{{sky:15,block:12}},transformation:{{left_rotation:[0f,0f,0f,1f],right_rotation:[0f,0f,0f,1f],translation:[0f,0f,0f],scale:[0.55f,0.55f,0.55f]}},Tags:[\"hw.hcd\",\"hw.tmpent\"]}}")
        hsum.append(f"summon minecraft:interaction {x+0.5} {y} {z+0.5} {{width:0.8f,height:0.8f,response:1b,Tags:[\"hw.click\",\"hw.c.candy\",\"hw.hc\",\"hw.tmpent\"]}}")
    F["hidden/spawn"] = hsum
    fn("hidden/take", f"""
execute as {THIS}] at @s run kill @e[type=minecraft:item_display,tag=hw.hcd,distance=..1]
execute as {THIS}] at @s run particle minecraft:totem_of_undying ~ ~0.5 ~ 0.2 0.3 0.2 0.2 20
kill {THIS}]
scoreboard players add #hidden hw.st 1
scoreboard players set #gain hw.tmp 5
function {NS}:candy/add
tellraw @a {tj(PREFIX, {"selector": "@s", "color": "yellow"}, (' が隠しお菓子を見つけた！ +5 (', 'white'), sc('#hidden', 'hw.st', 'aqua'), ('/' + str(len(hc)) + ')', 'white'))}
execute at @s run playsound minecraft:entity.player.levelup master @s ~ ~ ~ 0.7 1.6
""")

    # ------------------------------------------------------------------ boss
    bx, by, bz = P["boss_spawn"]
    BOSS = "@e[type=minecraft:wither_skeleton,tag=hw.boss,limit=1]"
    fn("boss/intro", f"""
scoreboard players set #boss hw.st 1
title @a times 10 70 20
title @a title {T("パンプキン・キング", "gold", True)}
title @a subtitle {T("が目を覚ました……！", "red")}
weather thunder
playsound minecraft:entity.wither.spawn master @a[{ARENA_SEL}] {bx} {by} {bz} 1 0.7
summon minecraft:lightning_bolt 0 65 -147
schedule function {NS}:boss/spawn 60t
""")
    boss_nbt = ("{Tags:[\"hw.boss\",\"hw.mob\"],PersistenceRequired:1b,CustomNameVisible:1b,CustomName:" + T("パンプキン・キング", "gold", True) + ","
                "Health:300.0f,attributes:[{id:\"minecraft:max_health\",base:300.0d},{id:\"minecraft:scale\",base:2.0d},"
                "{id:\"minecraft:movement_speed\",base:0.3d},{id:\"minecraft:attack_damage\",base:7.0d},"
                "{id:\"minecraft:knockback_resistance\",base:0.7d},{id:\"minecraft:follow_range\",base:64.0d}],"
                "equipment:{head:{id:\"minecraft:jack_o_lantern\",count:1},mainhand:{id:\"minecraft:netherite_hoe\",count:1},"
                "chest:{id:\"minecraft:leather_chestplate\",count:1,components:{\"minecraft:dyed_color\":3029569}},"
                "legs:{id:\"minecraft:leather_leggings\",count:1,components:{\"minecraft:dyed_color\":16744448}}},"
                "drop_chances:{head:0.0f,mainhand:0.0f,chest:0.0f,legs:0.0f}}")
    fn("boss/spawn", f"""
summon minecraft:wither_skeleton {bx} {by} {bz} {boss_nbt}
scoreboard players set #boss hw.st 2
scoreboard players set #bphase hw.st 1
scoreboard players set #bt hw.st 0
bossbar set {NS}:boss name {T("パンプキン・キング", "gold", True)}
bossbar set {NS}:boss color red
bossbar set {NS}:boss max 300
bossbar set {NS}:boss value 300
bossbar set {NS}:boss players @a
bossbar set {NS}:boss visible true
execute at {BOSS} run particle minecraft:explosion_emitter ~ ~1 ~ 0 0 0 0 1
execute at {BOSS} run playsound minecraft:entity.wither.ambient master @a ~ ~ ~ 2 0.5
tellraw @a {tj(('パンプキン・キング「わが眠りを妨げるのは誰だ……お菓子はすべて私のものだ！」', 'gold'))}
""")
    fn("boss/tick", f"""
execute unless entity {BOSS} run return run function {NS}:boss/defeat
execute store result bossbar {NS}:boss value run data get entity {BOSS} Health
scoreboard players add #bt hw.st 1
execute if score #bt hw.st matches 160.. run function {NS}:boss/ability
execute if score #bphase hw.st matches 1 store result score #hp hw.tmp run data get entity {BOSS} Health
execute if score #bphase hw.st matches 1 if score #hp hw.tmp matches ..150 run function {NS}:boss/phase2
scoreboard players operation #s hw.tmp = #bt hw.st
scoreboard players operation #s hw.tmp %= #5 hw.c
execute if score #s hw.tmp matches 0 at {BOSS} run particle minecraft:flame ~ ~4.6 ~ 0.4 0.3 0.4 0.02 4
execute as {BOSS} unless entity @s[x=-27,y=40,z=-152,dx=54,dy=60,dz=50] run tp @s {bx} {by} {bz}
""")
    fn("boss/ability", f"""
scoreboard players set #bt hw.st 0
execute if score #bphase hw.st matches 2 run scoreboard players set #bt hw.st 60
execute if score #bphase hw.st matches 1 store result score #r hw.tmp run random value 1..4
execute if score #bphase hw.st matches 2 store result score #r hw.tmp run random value 1..5
execute if score #r hw.tmp matches 1 run function {NS}:boss/a_minions
execute if score #r hw.tmp matches 2 run function {NS}:boss/a_ghosts
execute if score #r hw.tmp matches 3 run function {NS}:boss/a_shockwave
execute if score #r hw.tmp matches 4 run function {NS}:boss/a_blink
execute if score #r hw.tmp matches 5 run function {NS}:boss/a_bombs
""")
    skel = ("{Tags:[\"hw.mob\"],PersistenceRequired:1b,CustomName:" + T("カボチャ兵", "gold") + ","
            "equipment:{head:{id:\"minecraft:carved_pumpkin\",count:1},mainhand:{id:\"minecraft:bow\",count:1}},drop_chances:{head:0.0f,mainhand:0.0f}}")
    say = lambda s: f"title @a[{ARENA_SEL}] actionbar {tj(('パンプキン・キング「' + s + '」', 'gold'))}"
    fn("boss/a_minions", f"""
execute store result score #n hw.tmp if entity @e[type=minecraft:skeleton,tag=hw.mob]
execute if score #n hw.tmp matches 8.. run return run function {NS}:boss/a_shockwave
{say('出でよ、カボチャ兵たち！')}
execute at {BOSS} run summon minecraft:skeleton ~3 ~ ~ {skel}
execute at {BOSS} run summon minecraft:skeleton ~-3 ~ ~ {skel}
execute at {BOSS} run summon minecraft:skeleton ~ ~ ~3 {skel}
execute at {BOSS} run particle minecraft:large_smoke ~ ~1 ~ 3 0.5 3 0.02 60
execute at {BOSS} run playsound minecraft:entity.evoker.prepare_summon master @a ~ ~ ~ 2 0.8
""")
    fn("boss/a_ghosts", f"""
{say('さまよえる魂よ、来たれ！')}
execute at @r[tag=hw.player,{ARENA_SEL}] run summon minecraft:vex ~ ~4 ~ {{Tags:["hw.mob"],PersistenceRequired:1b,CustomName:{T("さまよう魂", "aqua")}}}
execute at @r[tag=hw.player,{ARENA_SEL}] run summon minecraft:vex ~ ~4 ~ {{Tags:["hw.mob"],PersistenceRequired:1b,CustomName:{T("さまよう魂", "aqua")}}}
execute at {BOSS} run playsound minecraft:entity.vex.charge master @a ~ ~ ~ 2 0.6
""")
    fn("boss/a_shockwave", f"""
{say('カボチャ・インパクト！')}
execute at {BOSS} run particle minecraft:explosion ~ ~0.5 ~ 4 0.2 4 0 25
execute at {BOSS} run particle minecraft:flame ~ ~0.3 ~ 5 0.1 5 0.05 120
execute at {BOSS} run playsound minecraft:entity.generic.explode master @a ~ ~ ~ 2 0.7
execute at {BOSS} as @a[tag=hw.player,distance=..7] run damage @s 5 minecraft:magic
execute at {BOSS} as @a[tag=hw.player,distance=..7] run effect give @s minecraft:levitation 1 4 true
""")
    fn("boss/a_blink", f"""
{say('どこへ逃げても無駄だ！')}
execute at {BOSS} run particle minecraft:large_smoke ~ ~2 ~ 0.6 1.5 0.6 0.05 60
execute as @r[tag=hw.player,{ARENA_SEL}] at @s rotated ~ 0 run tp {BOSS} ^ ^ ^-2.5
execute at {BOSS} run particle minecraft:large_smoke ~ ~2 ~ 0.6 1.5 0.6 0.05 60
execute at {BOSS} run playsound minecraft:entity.enderman.teleport master @a ~ ~ ~ 2 0.5
execute at {BOSS} run effect give @a[tag=hw.player,distance=..6] minecraft:darkness 3 0 true
""")
    fn("boss/a_bombs", f"""
{say('カボチャ爆弾をくらえ！')}
execute at @r[tag=hw.player,{ARENA_SEL}] run summon minecraft:creeper ~2 ~ ~ {{Tags:["hw.mob"],Fuse:40s,ignited:1b,ExplosionRadius:2b,CustomName:{T("かぼちゃボム", "gold")}}}
execute at @r[tag=hw.player,{ARENA_SEL}] run summon minecraft:creeper ~-2 ~ ~1 {{Tags:["hw.mob"],Fuse:40s,ignited:1b,ExplosionRadius:2b,CustomName:{T("かぼちゃボム", "gold")}}}
""")
    fn("boss/phase2", f"""
scoreboard players set #bphase hw.st 2
effect give {BOSS} minecraft:speed infinite 0 true
effect give {BOSS} minecraft:fire_resistance infinite 0 true
bossbar set {NS}:boss color purple
bossbar set {NS}:boss name {T("パンプキン・キング（怒り）", "red", True)}
title @a[{ARENA_SEL}] title {T("怒り状態！", "red", True)}
title @a[{ARENA_SEL}] subtitle {T("攻撃が激しくなる……", "gold")}
summon minecraft:lightning_bolt 18 64 -126
summon minecraft:lightning_bolt -18 64 -126
execute at {BOSS} run playsound minecraft:entity.ravager.roar master @a ~ ~ ~ 2 0.6
""")
    fn("boss/defeat", f"""
scoreboard players set #boss hw.st 3
bossbar set {NS}:boss visible false
kill @e[tag=hw.mob]
weather clear
title @a times 10 80 20
title @a title {T("パンプキン・キングを倒した！", "gold", True)}
title @a subtitle {T("村にお菓子が戻ってきた！ 全員 +20", "yellow")}
tellraw @a {tj(('パンプキン・キング「ぐぬぬ……来年のハロウィンこそは……！」', 'gold'))}
scoreboard players set #gain hw.tmp 20
execute as {PLAYERS} run function {NS}:candy/add
scoreboard players set #fw hw.st 12
function {NS}:fx/finale
schedule function {NS}:game/end 200t
""")
    fn("fx/finale", f"""
execute positioned 0 66 -126 run function {NS}:fx/firework_random
execute positioned 0 64 12 run function {NS}:fx/firework_random
scoreboard players remove #fw hw.st 1
execute if score #fw hw.st matches 1.. run schedule function {NS}:fx/finale 10t
""")
    fn("fx/firework_random", f"""
execute store result score #r hw.tmp run random value 1..4
execute if score #r hw.tmp matches 1 run summon minecraft:firework_rocket ~3 ~ ~2 {fw(16744448, 8388736, "large_ball")}
execute if score #r hw.tmp matches 2 run summon minecraft:firework_rocket ~-3 ~ ~-1 {fw(8388736, 65280, "star")}
execute if score #r hw.tmp matches 3 run summon minecraft:firework_rocket ~1 ~ ~-3 {fw(16766720, 16744448, "burst")}
execute if score #r hw.tmp matches 4 run summon minecraft:firework_rocket ~-1 ~ ~3 {fw(65280, 16744448, "creeper")}
""")
    fn("fx/firework", f"""
summon minecraft:firework_rocket ~ ~1 ~ {fw(16744448, 8388736, "small_ball", 0)}
""")

    # ------------------------------------------------------------------ game flow
    fn("game/start_button", f"""
execute if score #state hw.st matches 1 run return run tellraw @s {tj(PREFIX, ('ゲームはもう始まっているよ！', 'yellow'))}
execute if score #state hw.st matches 3 run return 0
function {NS}:game/start
""")
    fn("game/start", f"""
function {NS}:admin/reset_world
tag @a remove hw.player
tag @a[gamemode=!spectator] add hw.player
scoreboard players reset * hw.candy
scoreboard players set {PLAYERS} hw.candy 0
scoreboard players set {PLAYERS} hw.total 0
scoreboard players set @a hw.dead 0
scoreboard players set @a hw.kz 0
scoreboard players set @a hw.ks 0
scoreboard players set @a hw.kv 0
scoreboard players set @a hw.kb 0
clear {PLAYERS}
effect clear {PLAYERS}
gamemode adventure {PLAYERS}
tp {PLAYERS} {SPAWN}
execute as {PLAYERS} run function {NS}:player/starter
effect give {PLAYERS} minecraft:saturation 5 4 true
effect give {PLAYERS} minecraft:instant_health 1 4 true
scoreboard players operation #time hw.st = #timecfg hw.st
scoreboard players operation #time hw.st *= #1200 hw.c
scoreboard players operation #half hw.st = #time hw.st
scoreboard players operation #half hw.st /= #2 hw.c
execute store result bossbar {NS}:timer max run scoreboard players get #time hw.st
execute store result bossbar {NS}:timer value run scoreboard players get #time hw.st
bossbar set {NS}:timer players @a
bossbar set {NS}:timer color purple
bossbar set {NS}:timer visible true
scoreboard players set #state hw.st 3
function {NS}:game/rules
title @a times 0 25 5
schedule function {NS}:game/cd5 40t
""")
    for n in range(5, 0, -1):
        nxt = f"game/cd{n-1}" if n > 1 else "game/go"
        fn(f"game/cd{n}", f"""
title @a title {T(str(n), "gold", True)}
execute as @a at @s run playsound minecraft:block.note_block.hat master @s ~ ~ ~ 1 1
schedule function {NS}:{nxt} 20t
""")
    fn("game/go", f"""
scoreboard players set #state hw.st 1
title @a times 5 40 15
title @a title {T("スタート！", "gold", True)}
title @a subtitle {T("お菓子を集めろ！ ハッピーハロウィン！", "yellow")}
execute as @a at @s run playsound minecraft:entity.wither.spawn master @s ~ ~ ~ 0.4 1.5
execute as @a at @s run playsound minecraft:event.raid.horn master @s ~ ~ ~ 1 1
""")
    rules_text = ("お菓子をいちばん多く集めた人が優勝！\n\n"
                  "・村の家をノック／カボチャ狩り／ゴースト射的／魔女の塔／隠しお菓子(20個)／敵を倒す\n"
                  "・屋敷・墓地迷路・カボチャ畑で「魂のランタン」を探して祭壇へ\n"
                  "・3つ揃うと北の城門がひらき、パンプキン・キングと決戦（倒すと全員+20、とどめ+30）\n"
                  "・ショップで装備を買える（使った分は減る）\n"
                  "・後半に「ゴーストの襲来」、残り5分は「お菓子2倍タイム」！")
    fn("game/rules", "dialog show @a {type:\"minecraft:notice\",title:" + T("ハロウィン・ナイト 〜パンプキン王の呪い〜", "gold", True)
       + ",body:[{type:\"minecraft:plain_message\",contents:" + T(rules_text) + ",width:320}],action:{label:" + T("はじめる！", "green", True) + "}}")
    fn("game/tick", f"""
scoreboard players remove #time hw.st 1
execute store result bossbar {NS}:timer value run scoreboard players get #time hw.st
scoreboard players operation #s hw.tmp = #time hw.st
scoreboard players operation #s hw.tmp %= #20 hw.c
execute if score #s hw.tmp matches 0 run function {NS}:game/timer_name
execute if score #s hw.tmp matches 0 if score #time hw.st matches 1..200 as @a at @s run playsound minecraft:block.note_block.hat master @s ~ ~ ~ 1 2
execute if score #raid hw.st matches 0 if score #time hw.st <= #half hw.st run function {NS}:event/raid
execute if score #double hw.st matches 0 if score #time hw.st matches ..6000 run function {NS}:event/double
execute if score #boss hw.st matches 0 if score #lanterns hw.st matches 3.. if entity @a[tag=hw.player,{ARENA_SEL}] run function {NS}:boss/intro
execute if score #boss hw.st matches 2 run function {NS}:boss/tick
scoreboard players operation #s hw.tmp = #t hw.st
scoreboard players operation #s hw.tmp %= #20 hw.c
execute if score #s hw.tmp matches 0 as @e[type=minecraft:interaction,tag=hw.hc] at @s run particle minecraft:end_rod ~ ~0.5 ~ 0.15 0.15 0.15 0.01 1
execute if score #time hw.st matches ..0 run function {NS}:game/timeout
""")
    tn = []
    for dbl in (0, 1):
        for lz in (0, 1):
            pre = ("お菓子2倍タイム！ 残り ", "yellow") if dbl else ("残り時間 ", "light_purple")
            mid = (":0" if lz else ":", "white")
            cond = f"if score #double hw.st matches {dbl} if score #sec hw.tmp matches {'..9' if lz else '10..'}"
            tn.append(f"execute {cond} run bossbar set {NS}:timer name {tj(pre, sc('#m', 'hw.tmp', 'white'), mid, sc('#sec', 'hw.tmp', 'white'))}")
    F["game/timer_name"] = [
        "scoreboard players operation #m hw.tmp = #time hw.st",
        "scoreboard players operation #m hw.tmp /= #1200 hw.c",
        "scoreboard players operation #sec hw.tmp = #time hw.st",
        "scoreboard players operation #sec hw.tmp /= #20 hw.c",
        "scoreboard players operation #sec hw.tmp %= #60 hw.c",
    ] + tn
    fn("event/raid", f"""
scoreboard players set #raid hw.st 1
execute if score #boss hw.st matches 1.. run return 0
title @a times 10 50 15
title @a title {T("ゴーストの襲来！", "aqua", True)}
title @a subtitle {T("倒すとお菓子がもらえるぞ", "white")}
execute as @a at @s run playsound minecraft:entity.vex.ambient master @s ~ ~ ~ 1 0.5
execute at {PLAYERS} run summon minecraft:vex ~2 ~4 ~ {{Tags:["hw.mob"],PersistenceRequired:1b,CustomName:{T("さまようゴースト", "aqua")}}}
execute at {PLAYERS} run summon minecraft:vex ~-2 ~4 ~ {{Tags:["hw.mob"],PersistenceRequired:1b,CustomName:{T("さまようゴースト", "aqua")}}}
execute at {PLAYERS} run summon minecraft:bat ~ ~3 ~ {{Tags:["hw.mob","hw.tmpent"]}}
""")
    fn("event/double", f"""
scoreboard players set #double hw.st 1
bossbar set {NS}:timer color yellow
title @a times 10 50 15
title @a title {T("お菓子2倍タイム！", "yellow", True)}
title @a subtitle {T("残り5分、もらえるお菓子が2倍！", "gold")}
execute as @a at @s run playsound minecraft:ui.toast.challenge_complete master @s ~ ~ ~ 1 1.4
""")
    fn("game/timeout", f"""
tellraw @a {tj(PREFIX, ('時間切れ！', 'red', True))}
function {NS}:game/end
""")
    fn("game/end", f"""
execute unless score #state hw.st matches 1 run return 0
scoreboard players set #state hw.st 2
schedule clear {NS}:game/end
bossbar set {NS}:timer visible false
bossbar set {NS}:boss visible false
kill @e[tag=hw.mob]
scoreboard players set #pk hw.st 0
scoreboard players set #gal hw.st 0
kill @e[tag=hw.ptall]
clear @a minecraft:bow[minecraft:custom_data={{hw:"gal"}}]
clear @a minecraft:arrow[minecraft:custom_data={{hw:"gal"}}]
weather clear
tp {PLAYERS} {SPAWN}
effect clear {PLAYERS}
effect give {PLAYERS} minecraft:resistance 30 4 true
title @a times 10 50 20
title @a title {T("ゲーム終了！", "gold", True)}
title @a subtitle {T("結果発表……", "yellow")}
execute as @a at @s run playsound minecraft:block.bell.use master @s ~ ~ ~ 1 0.8
schedule function {NS}:game/results 80t
""")
    rank_colors = ["gold", "white", "#cd7f32", "gray", "gray", "gray"]
    res = [
        "tag @a remove hw.ranked",
    ] + [f"tag @a remove hw.r{i}" for i in range(1, 7)] + [
        "tellraw @a " + tj(("\n========== 結果発表 ==========", "gold", True)),
    ]
    for r in range(1, 7):
        res += [
            "scoreboard players set #max hw.tmp -1",
            f"execute as {PLAYERS[:-1]},tag=!hw.ranked] run scoreboard players operation #max hw.tmp > @s hw.candy",
            f"execute if score #max hw.tmp matches 0.. as {PLAYERS[:-1]},tag=!hw.ranked] if score @s hw.candy = #max hw.tmp run tag @s add hw.r{r}",
            f"tag @a[tag=hw.r{r}] add hw.ranked",
            f"execute if entity @a[tag=hw.r{r}] run tellraw @a " + tj((f" 第{r}位  ", rank_colors[r - 1], True), {"selector": f"@a[tag=hw.r{r}]", "color": "yellow"},
                                                                       ("  お菓子 ", "white"), sc("#max", "hw.tmp", "gold"), (" 個", "white")),
        ]
    res += [
        "tellraw @a " + tj(("\n—— みんなの記録 ——", "gray")),
        f"execute as {PLAYERS} run tellraw @a " + tj(("  ", "white"), {"selector": "@s", "color": "yellow"}, ("  稼いだお菓子 ", "gray"), sc("@s", "hw.total", "white"),
                                                     ("  ／ やられた回数 ", "gray"), sc("@s", "hw.dead", "white")),
        "tellraw @a " + tj(("  見つけた隠しお菓子: ", "gray"), sc("#hidden", "hw.st", "white"), (f"/{len(hc)}", "gray")),
        "execute if score #boss hw.st matches 3 run tellraw @a " + tj(("  パンプキン・キング: ", "gray"), ("討伐成功！", "green", True)),
        "execute unless score #boss hw.st matches 3 run tellraw @a " + tj(("  パンプキン・キング: ", "gray"), ("討伐ならず……", "red")),
        "title @a times 10 100 30",
        "title @a title " + J([{"selector": "@a[tag=hw.r1]", "color": "gold", "bold": True}]),
        "title @a subtitle " + T("優勝！ ハッピーハロウィン！", "yellow", True),
        f"item replace entity @a[tag=hw.r1] armor.head with minecraft:golden_helmet[custom_name={T('パンプキン王の冠', 'gold', True, italic=False)},enchantment_glint_override=true]",
        "execute as @a at @s run playsound minecraft:ui.toast.challenge_complete master @s ~ ~ ~ 1 1",
        "scoreboard players set #fw hw.st 10",
        f"function {NS}:fx/winner_fw",
        "tellraw @a " + tj(PREFIX, ("もう一度遊ぶときは広場の「ゲームスタート」台をクリック！", "gray")),
    ]
    F["game/results"] = res
    fn("fx/winner_fw", f"""
execute at @a[tag=hw.r1] run function {NS}:fx/firework_random
scoreboard players remove #fw hw.st 1
execute if score #fw hw.st matches 1.. run schedule function {NS}:fx/winner_fw 12t
""")

    # ------------------------------------------------------------------ ambience
    fn("fx/tick", f"""
scoreboard players operation #m hw.tmp = #t hw.st
scoreboard players operation #m hw.tmp %= #100 hw.c
execute if score #m hw.tmp matches 0 as @a at @s run function {NS}:fx/ambient
execute if score #m hw.tmp matches 0 run particle minecraft:flame -3 73 7.4 0.5 0.4 0.05 0.01 4
execute if score #m hw.tmp matches 50 run particle minecraft:flame 4 73 7.4 0.5 0.4 0.05 0.01 4
execute if score #m hw.tmp matches 25 run function {NS}:fx/altar
""")
    fn("fx/ambient", """
execute store result score #r hw.tmp run random value 1..12
execute if score #r hw.tmp matches 1 run playsound minecraft:ambient.cave ambient @s ~ ~ ~ 0.6 1
execute if score #r hw.tmp matches 2 run playsound minecraft:entity.witch.celebrate ambient @s ~8 ~ ~5 0.5 0.8
execute if score #r hw.tmp matches 3 run playsound minecraft:entity.bat.ambient ambient @s ~ ~2 ~ 0.6 0.9
execute if score #r hw.tmp matches 4 run playsound minecraft:block.bell.resonate ambient @s ~ ~ ~ 0.3 0.6
execute if score #r hw.tmp matches 5 run playsound minecraft:entity.wolf_big.growl ambient @s ~-10 ~ ~10 0.5 0.6
execute if score #r hw.tmp matches 6 run playsound minecraft:entity.ghast.ambient ambient @s ~ ~10 ~ 0.2 0.6
""")
    altar = []
    for i, (ax, az) in enumerate(P["altar"]):
        altar.append(f"execute if score #l{i+1} hw.st matches 1 run particle minecraft:soul_fire_flame {ax+0.5} {G+3.6} {az+0.5} 0.15 0.2 0.15 0.01 3")
    for (x, z) in P["traps"][:3]:
        altar.append(f"particle minecraft:soul {x+0.5} 64.3 {z+0.5} 0.4 0.1 0.4 0.01 1")
    F["fx/altar"] = altar

    # ------------------------------------------------------------------ admin
    l1 = "\n".join(lantern_spawn("L1", 1))
    l2 = "\n".join(lantern_spawn("L2", 2))
    lx3, ly3, lz3 = P["L3"]
    lev = "\n".join(f"setblock {x} {y} {z+1} minecraft:lever[face=wall,facing=south,powered=false]" for (x, y, z) in P["levers"])
    lad = "\n".join(f"setblock {x} {y} {z} minecraft:air" for (x, y, z) in P["ladder"][1:])
    fx_, fy_, fz_ = P["ladder"][0]
    alt = "\n".join(f"setblock {ax} {G+3} {az} minecraft:air" for (ax, az) in P["altar"])
    fn("admin/reset_world", f"""
kill @e[tag=hw.mob]
kill @e[tag=hw.tmpent]
schedule clear {NS}:game/end
schedule clear {NS}:boss/spawn
fill {gx1} {gy1} {gz} {gx2} {gy2} {gz} minecraft:iron_bars[east=true,west=true]
{alt}
{lev}
{lad}
setblock {fx_} {fy_} {fz_} minecraft:purple_carpet
setblock {hx} {hy} {hz} minecraft:dark_oak_planks
setblock {lx3} {ly3} {lz3} minecraft:air
kill @e[type=minecraft:text_display,tag=hw.ltext1]
kill @e[type=minecraft:text_display,tag=hw.ltext2]
{l1}
{l2}
summon minecraft:text_display {P['L1'][0]+0.5} {P['L1'][1]+1.6} {P['L1'][2]+0.5} {{text:{T("① 屋敷の魂のランタン", "aqua", True)},billboard:"center",Tags:["hw.deco","hw.ltext1"],transformation:{{left_rotation:[0f,0f,0f,1f],right_rotation:[0f,0f,0f,1f],translation:[0f,0f,0f],scale:[0.8f,0.8f,0.8f]}}}}
summon minecraft:text_display {P['L2'][0]+0.5} {P['L2'][1]+1.6} {P['L2'][2]+0.5} {{text:{T("② 墓地の魂のランタン", "aqua", True)},billboard:"center",Tags:["hw.deco","hw.ltext2"],transformation:{{left_rotation:[0f,0f,0f,1f],right_rotation:[0f,0f,0f,1f],translation:[0f,0f,0f],scale:[0.8f,0.8f,0.8f]}}}}
function {NS}:hidden/spawn
scoreboard players set #state hw.st 0
scoreboard players set #lanterns hw.st 0
scoreboard players set #l1 hw.st 0
scoreboard players set #l2 hw.st 0
scoreboard players set #l3 hw.st 0
scoreboard players set #boss hw.st 0
scoreboard players set #bphase hw.st 0
scoreboard players set #pk hw.st 0
scoreboard players set #pk_done hw.st 0
scoreboard players set #gal hw.st 0
scoreboard players set #mansion hw.st 0
scoreboard players set #double hw.st 0
scoreboard players set #raid hw.st 0
scoreboard players set #hidden hw.st 0
""" + "\n".join(f"scoreboard players reset * hw.h{i}" for i in range(1, 7)) + "\n"
       + "\n".join(f"scoreboard players reset * hw.sc{i}" for i in range(1, 5)) + f"""
scoreboard players reset * hw.chest
scoreboard players reset * hw.cp
scoreboard players reset * hw.pk
tag @a remove hw.gal
bossbar set {NS}:boss visible false
bossbar set {NS}:timer visible false
weather clear
time set 18000
""")
    fn("admin/stop", f"""
execute if score #state hw.st matches 1 run function {NS}:game/end
execute if score #state hw.st matches 3 run function {NS}:admin/reset_world
""")
    fn("admin/reset", f"""
schedule clear {NS}:game/cd5
schedule clear {NS}:game/cd4
schedule clear {NS}:game/cd3
schedule clear {NS}:game/cd2
schedule clear {NS}:game/cd1
schedule clear {NS}:game/go
schedule clear {NS}:game/results
function {NS}:admin/reset_world
tag @a remove hw.player
tp @a {SPAWN}
tellraw @a {tj(PREFIX, ('マップをリセットしました', 'gray'))}
""")
    for m in (10, 20, 30, 40, 60):
        fn(f"admin/time_{m}", f"""
scoreboard players set #timecfg hw.st {m}
tellraw @s {tj(PREFIX, (f'制限時間を {m} 分にしました（次のゲームから）', 'gray'))}
""")
    fn("admin/give_lanterns", f"""
execute if score #l1 hw.st matches 0 run function {NS}:lantern/got1
execute if score #l2 hw.st matches 0 run function {NS}:lantern/got2
execute if score #l3 hw.st matches 0 run function {NS}:lantern/got3
kill @e[type=minecraft:interaction,tag=hw.c.lantern]
execute if score #lanterns hw.st matches 3.. run function {NS}:lantern/all
""")
    warps = [("広場", "0.5 64 12.5 180 0"), ("屋敷", "0.5 64 -38.5 180 0"), ("迷路", "40.5 64 0.5 -90 0"), ("畑", "-38.5 64 0.5 90 0"),
             ("村", "0.5 64 60.5 0 0"), ("塔", f"{bx if False else 60.5} 64 72.5 180 0"), ("射的", "-40.5 64 60.5 90 0"), ("城", "0.5 64 -100.5 180 0"),
             ("空撮", "40.5 110 40.5 135 35")]
    for i, (nm, pos) in enumerate(warps):
        fn(f"admin/warp{i}", f"tp @s {pos}")
    fn("admin/nv", """
execute if entity @s[tag=hw.nv] run return run function halloween:admin/nv_off
tag @s add hw.nv
effect give @s minecraft:night_vision infinite 0 true
""")
    fn("admin/nv_off", """
tag @s remove hw.nv
effect clear @s minecraft:night_vision
""")

    def btn(label, cmd, color="aqua", hover=None):
        d = {"text": f"[{label}]", "color": color, "click_event": {"action": "run_command", "command": f"/function {NS}:{cmd}"}}
        if hover:
            d["hover_event"] = {"action": "show_text", "value": hover}
        return d
    sp = {"text": " "}
    menu = [
        "tellraw @s " + tj(("\n===== ハロウィン・ナイト 管理メニュー =====", "gold", True)),
        "tellraw @s " + J([{"text": "ゲーム: ", "color": "gray"}, btn("開始", "game/start", "green"), sp, btn("終了して結果発表", "admin/stop", "yellow"), sp,
                           btn("リセット", "admin/reset", "red", "マップの状態とスコアを初期化")]),
        "tellraw @s " + J([{"text": "制限時間: ", "color": "gray"}] + sum([[btn(f"{m}分", f"admin/time_{m}"), sp] for m in (10, 20, 30, 40, 60)], [])
                          + [{"text": "現在 ", "color": "gray"}, sc("#timecfg", "hw.st", "white"), {"text": "分", "color": "gray"}]),
        "tellraw @s " + J([{"text": "ワープ: ", "color": "gray"}] + sum([[btn(nm, f"admin/warp{i}", "aqua"), sp] for i, (nm, _) in enumerate(warps)], [])),
        "tellraw @s " + J([{"text": "撮影: ", "color": "gray"}, btn("暗視 ON/OFF", "admin/nv", "light_purple"), sp,
                           btn("ボス戦テスト(ランタン3つ)", "admin/give_lanterns", "red", "ゲーム中にランタン3つを入手済みにする")]),
        "tellraw @s " + J([{"text": "建築: ", "color": "gray"}, btn("マップを建築(最初の1回)", "admin/build", "dark_red", "空のワールドにマップ全体を建てる。数十秒かかります")]),
    ]
    F["admin/menu"] = menu

    # build chain
    fn("admin/build", f"""
tellraw @a {tj(PREFIX, ('マップの建築を開始します。チャンクを読み込み中……（動かずに待ってね）', 'yellow'))}
gamerule max_block_modifications 1000000
gamerule max_command_sequence_length 1000000
forceload add -112 -160 -1 112
forceload add 0 -160 112 112
schedule function {NS}:build/wait 40t
""")
    fn("build/wait", f"""
execute unless loaded -100 63 -85 run return run schedule function {NS}:build/wait 20t
execute unless loaded 100 63 100 run return run schedule function {NS}:build/wait 20t
execute unless loaded -100 63 100 run return run schedule function {NS}:build/wait 20t
execute unless loaded 100 63 -85 run return run schedule function {NS}:build/wait 20t
execute unless loaded 0 63 -152 run return run schedule function {NS}:build/wait 20t
function {NS}:build/setup
""")
    fn("build/setup", f"""
kill @e[tag=hw.deco]
kill @e[tag=hw.click]
kill @e[tag=hw.tmpent]
kill @e[type=minecraft:item]
setworldspawn 0 64 12
gamerule advance_time false
gamerule advance_weather false
gamerule spawn_mobs false
gamerule spawn_monsters false
gamerule spawn_phantoms false
gamerule spawn_patrols false
gamerule spawn_wandering_traders false
gamerule mob_griefing false
gamerule keep_inventory true
gamerule immediate_respawn true
gamerule random_tick_speed 0
gamerule fire_spread_radius_around_player 0
gamerule mob_drops false
gamerule block_drops false
gamerule command_block_output false
gamerule respawn_radius 0
gamerule show_advancement_messages false
gamerule players_sleeping_percentage 101
gamerule pvp false
difficulty normal
time set 18000
weather clear
worldborder center 0 -25
worldborder set 270
schedule function {NS}:{stage_names[0]} 5t
""")
    return F


def fw(c1, c2, shape, lt=30):
    lt_s = f"LifeTime:{lt}," if lt else "LifeTime:1,"
    return ("{" + lt_s + "FireworksItem:{id:\"minecraft:firework_rocket\",count:1,components:{\"minecraft:fireworks\":{flight_duration:1b,"
            f"explosions:[{{shape:\"{shape}\",colors:[I;{c1}],fade_colors:[I;{c2}],has_trail:true,has_twinkle:true}}]}}}}}}}}")
