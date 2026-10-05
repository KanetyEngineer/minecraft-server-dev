"""TikTok Defense: build the game data pack (namespace td).

usage: python build.py [out.zip]

The game: straight lanes ("fields"). Several fields (up to MAX_FIELDS, the app decides how many are in use with
score #fields td.cfg) run side by side in one world, each with its own state, enemies and players.
In each field enemies appear at the far end (marker td.spawn) and walk toward the core (marker td.core). Gates
(markers td.gate, td.idx 1 = nearest the core) block the lane; players stand on the front-most gate and shoot.
Enemies standing at a gate wear it down (sum of their td.atk per second); a broken gate disappears and players
move back to the next one. Enemies that reach the core damage it; core HP 0 = lose, surviving the time limit = win.
The fields and the waiting area (lobby) are built by the app (src/arena.js).

Per field N:
    entities    markers/displays of the field: tags td.field td.fx td.fN; enemies: td.enemy td.ex td.eN
    scores      fake players in objective td.fN (#state #left #elapsed #kills ...), sidebar objective td.iN
    players     score td.fld = N (0 = waiting area), team td.fN (own sidebar colour), tag td.spec = watching
    functions   td:fN/start, td:fN/stop, td:fN/act/<action> {name,gift}, td:fN/do/<action>, td:fN/weapon {...}
Players choose with /trigger td.menu (clickable chat menu, also the signs in the waiting area):
    1 menu, 2 back to the waiting area, 3 start my field, 4 versus queue on/off, 5 my records,
    1N join field N, 2N watch field N
Versus: td:vs/begin {a,b} starts two fields in the same tick after a countdown; the better one wins.
Records (kept in the world): td.rk best kills, td.rt longest survival, td.rw defence wins, td.rv versus wins.
The app reads everything from storage td:st (per field status) and td:vs last (last versus result).
Old calls (td:start, td:act/<a>, td:do/<a>, td:weapon ...) still work and mean field 1.
"""
import json
import sys
import zipfile

NS = "td"
DATA_FORMAT = (101, 1)  # Minecraft 26.1.2
MAX_FIELDS = 8
FIELD_COLORS = ["red", "blue", "green", "yellow", "aqua", "light_purple", "gold", "dark_aqua"]

# score defaults (#name td.cfg)
CFG_DEFAULTS = {
    "time": 600, "coreHp": 100, "gateHp": 300, "leakMul": 5,
    "waveSec": 6, "waveN": 1, "waveRamp": 60, "waveMax": 6,
    "maxEnemies": 80, "repairPct": 30, "bossMax": 3, "titanMax": 1,
}
FIELDS_DEFAULT = 4

# mob stats (storage td:cfg mobs.<type>): hp, speed, scale, dmg (to players), atk (gate damage per second)
MOB_DEFAULTS = {
    "zombie":   {"hp": 20, "speed": 0.23, "scale": 1.0, "dmg": 3, "atk": 1},
    "runner":   {"hp": 14, "speed": 0.36, "scale": 0.85, "dmg": 2, "atk": 1},
    "skeleton": {"hp": 20, "speed": 0.25, "scale": 1.0, "dmg": 2, "atk": 1},
    "creeper":  {"hp": 20, "speed": 0.26, "scale": 1.0, "dmg": 0, "atk": 6},
    "brute":    {"hp": 60, "speed": 0.2, "scale": 1.35, "dmg": 6, "atk": 3},
    "boss":     {"hp": 300, "speed": 0.28, "scale": 1.0, "dmg": 10, "atk": 12},
    "titan":    {"hp": 500, "speed": 0.17, "scale": 3.0, "dmg": 12, "atk": 20},
}


def snbt(d):
    return "{" + ",".join(f"{k}:{json.dumps(v) if isinstance(v, str) else v}" for k, v in d.items()) + "}"


ATTRS = ('attributes:[{id:"minecraft:max_health",base:$(hp)d},{id:"minecraft:movement_speed",base:$(speed)d},'
         '{id:"minecraft:scale",base:$(scale)d},{id:"minecraft:attack_damage",base:$(dmg)d},'
         '{id:"minecraft:follow_range",base:160d}%s],Health:$(hp)f')
COMMON = 'Tags:["td.enemy","td.ex","td.new","td.%s"],PersistenceRequired:1b,CanPickUpLoot:0b'
HELMET = 'equipment:{head:{id:"minecraft:leather_helmet",count:1,components:{"minecraft:dyed_color":%d}}},drop_chances:{head:0f}'

# type: (entity, extra nbt, extra attributes)
MOBS = {
    "zombie": ("zombie", HELMET % 0x3B3B3B, ""),
    "runner": ("husk", "IsBaby:0b", ""),
    "skeleton": ("skeleton", 'equipment:{head:{id:"minecraft:chainmail_helmet",count:1},mainhand:{id:"minecraft:bow",count:1}},'
                 'drop_chances:{head:0f,mainhand:0f}', ""),
    "creeper": ("creeper", "ExplosionRadius:2b,Fuse:20s", ""),
    "brute": ("zombie", 'equipment:{head:{id:"minecraft:netherite_helmet",count:1},chest:{id:"minecraft:netherite_chestplate",count:1},'
              'legs:{id:"minecraft:iron_leggings",count:1},feet:{id:"minecraft:iron_boots",count:1},mainhand:{id:"minecraft:iron_axe",count:1}},'
              'drop_chances:{head:0f,chest:0f,legs:0f,feet:0f,mainhand:0f}',
              ',{id:"minecraft:knockback_resistance",base:0.8d}'),
    "boss": ("ravager", "Glowing:1b", ',{id:"minecraft:knockback_resistance",base:1d}'),
    "titan": ("zombie", 'Glowing:1b,' + HELMET % 0x8B0000, ',{id:"minecraft:knockback_resistance",base:1d}'),
}

LABEL = {"zombie": "ゾンビ", "runner": "俊足ゾンビ", "skeleton": "スケルトン狙撃兵", "creeper": "クリーパー",
         "brute": "重装ゾンビ", "boss": "ボス・ラヴェジャー", "titan": "巨人タイタン"}

# Field templates use tokens that are replaced per field (see field_text):
#   @@N field number, @@OBJ its objective (td.fN), @@INFO sidebar objective (td.iN), @@FT field tag (td.fN),
#   @@ET enemy tag (td.eN), @@EN all its enemies, @@FP its fighting players, @@FA everyone in it (also watchers),
#   @@COL its colour

# id: (label, kind enemy/help, default count per gift, body of fN/do/<id>)
ACTIONS = {
    "zombie": ("ゾンビ", "enemy", 1, "function td:f@@N/spawn/zombie\n"),
    "runner": ("俊足ゾンビ", "enemy", 1, "function td:f@@N/spawn/runner\n"),
    "skeleton": ("スケルトン狙撃兵", "enemy", 1, "function td:f@@N/spawn/skeleton\n"),
    "creeper": ("クリーパー（関門に大ダメージ）", "enemy", 1, "function td:f@@N/spawn/creeper\n"),
    "brute": ("重装ゾンビ", "enemy", 1, "function td:f@@N/spawn/brute\n"),
    "horde": ("ゾンビの大群", "enemy", 1, "".join(f"function td:f@@N/spawn/{t}\n" for t in
                                              ["zombie"] * 6 + ["runner"] * 2 + ["skeleton"] * 2)),
    "boss": ("ボス・ラヴェジャー", "enemy", 1, """
execute store result score #n td.v if entity @e[tag=td.boss,tag=@@ET]
execute if score #n td.v >= #bossMax td.cfg run return run function td:f@@N/spawn/brute
function td:f@@N/spawn/boss
execute as @@FA at @s run playsound minecraft:entity.ravager.roar hostile @s ~ ~ ~ 1 0.8
"""),
    "titan": ("巨人タイタン", "enemy", 1, """
execute store result score #n td.v if entity @e[tag=td.titan,tag=@@ET]
execute if score #n td.v >= #titanMax td.cfg run return run function td:f@@N/spawn/brute
function td:f@@N/spawn/titan
execute as @@FA at @s run playsound minecraft:entity.wither.spawn hostile @s ~ ~ ~ 0.8 0.6
title @@FA subtitle {text:"巨人タイタンが現れた！",color:"dark_red",bold:true}
title @@FA title {text:"⚠",color:"red"}
"""),
    "airstrike": ("空爆（前にいる敵を一掃）", "help", 1, """
execute at @e[tag=td.core,tag=@@FT,limit=1] as @e[tag=@@ET,sort=nearest,limit=8] at @s run function td:fx/blast
execute as @@FA at @s run playsound minecraft:entity.generic.explode master @s ~ ~ ~ 1 0.7
"""),
    "nuke": ("全滅ボム", "help", 1, """
execute as @@EN at @s run function td:fx/nuke
execute as @@FA at @s run playsound minecraft:entity.generic.explode master @s ~ ~ ~ 1.5 0.5
execute as @@FA at @s run playsound minecraft:item.totem.use master @s ~ ~ ~ 0.6 1.2
"""),
    "freeze": ("敵を凍結（8秒）", "help", 1, """
effect give @@EN minecraft:slowness 8 4 true
effect give @@EN minecraft:weakness 8 4 true
execute as @@EN at @s run particle minecraft:snowflake ~ ~1 ~ 0.4 0.8 0.4 0.02 25
execute as @@FA at @s run playsound minecraft:block.glass.break master @s ~ ~ ~ 1 0.6
"""),
    "repair": ("関門を修理", "help", 1, """
execute as @e[tag=td.front,tag=@@FT,limit=1] run function td:gate/repair
execute unless entity @e[tag=td.front,tag=@@FT] as @e[tag=td.core,tag=@@FT,limit=1] run function td:core/repair
"""),
    "heal": ("全員回復", "help", 1, """
effect give @@FP minecraft:instant_health 1 1 true
effect give @@FP minecraft:regeneration 10 1 true
execute as @@FP at @s run particle minecraft:heart ~ ~1.8 ~ 0.4 0.3 0.4 0 6
execute as @@FA at @s run playsound minecraft:block.amethyst_block.chime master @s ~ ~ ~ 1 1.2
"""),
    "weapon": ("武器支給（ランダム）", "help", 1, """
execute as @@FA at @s run playsound minecraft:item.armor.equip_netherite master @s ~ ~ ~ 1 1
"""),
    "firework": ("花火（何も起きない）", "help", 1, """
execute as @@FP at @s run summon minecraft:firework_rocket ~ ~1 ~ {LifeTime:20,FireworksItem:{id:"minecraft:firework_rocket",count:1,components:{"minecraft:fireworks":{explosions:[{shape:"large_ball",colors:[I;16733525,16777045],has_twinkle:true}]}}}}
"""),
}


def fn(lines):
    return "\n".join(l.strip() for l in lines.strip().splitlines() if l.strip()) + "\n"


def field_text(text, n):
    """Fill the per-field tokens of a template."""
    rep = [
        ("@@INFO", f"td.i{n}"), ("@@OBJ", f"td.f{n}"), ("@@COL", FIELD_COLORS[n - 1]),
        ("@@FP", f"@a[scores={{td.fld={n}}},gamemode=!spectator]"), ("@@FA", f"@a[scores={{td.fld={n}}}]"),
        ("@@EN", f"@e[tag=td.e{n}]"), ("@@ET", f"td.e{n}"), ("@@FT", f"td.f{n}"), ("@@N", str(n)),
    ]
    for k, v in rep:
        text = text.replace(k, v)
    return text


def click(label, cmd, color, hover):
    return ('{text:"%s",color:"%s",bold:true,click_event:{action:"run_command",command:"%s"},'
            'hover_event:{action:"show_text",value:{text:"%s"}}}' % (label, color, cmd, hover))


def spawn_fn(t):
    """fN/spawn/<t>: one enemy of type t at the field's spawn marker (respecting the cap); it keeps td.new."""
    return fn(f"""
execute unless score #state @@OBJ matches 1 run return fail
execute store result score #n td.v if entity @@EN
execute if score #n td.v >= #maxEnemies td.cfg run return fail
execute at @e[tag=td.spawn,tag=@@FT,limit=1] run function td:mob/{t} with storage td:cfg mobs.{t}
tag @e[tag=td.new,tag=!td.placed] add @@ET
execute as @e[tag=td.new,tag=!td.placed] at @s run function td:mob/place with storage td:cfg game
scoreboard players add #spawned @@OBJ 1
""")


def mob_fn(t):
    ent, extra, attrs = MOBS[t]
    return "\n".join([
        f"$summon minecraft:{ent} ~ ~ ~ {{{COMMON % t},{extra},{ATTRS % attrs}}}",
        f"$scoreboard players set @e[tag=td.new,tag=!td.placed,limit=1] td.atk $(atk)",
    ]) + "\n"


def act_fn(label, kind):
    color = "red" if kind == "enemy" else "aqua"
    verb = "が襲来！" if kind == "enemy" else "！"
    return "\n".join([
        "execute unless score #state @@OBJ matches 1 run return fail",
        '$tellraw @@FA [{text:"[LIVE] ",color:"light_purple",bold:true},{text:"$(name)",color:"yellow"},'
        '{text:" さんの $(gift) → ",color:"white"},{text:"' + label + verb + '",color:"' + color + '",bold:true}]',
        '$title @@FA actionbar [{text:"$(name)",color:"yellow"},{text:" → ' + label + '",color:"' + color + '"}]',
        '$data modify storage td:cur mobname set value {text:"$(name)",color:"' + ("light_purple" if kind == "enemy" else "aqua") + '",bold:true}',
        '$data modify storage td:cur label set value {text:"$(name)",color:"yellow",bold:true}',
        "execute as @@FP at @s run function td:avatar/pop" if kind == "help" else
        "execute at @e[tag=td.spawn,tag=@@FT,limit=1] run function td:avatar/spawnpop",
        "return 1",
    ]) + "\n"


def avatar_display(tags, y, scale, ty=0):
    return ("summon minecraft:text_display ~ ~%s ~ {Tags:%s,billboard:\"center\",background:0,shadow:0b,line_width:1000,"
            "transformation:{left_rotation:[0f,0f,0f,1f],right_rotation:[0f,0f,0f,1f],translation:[0f,%sf,0f],scale:[%sf,%sf,%sf]},text:{text:\"\"}}"
            % (y, json.dumps(tags), ty, scale, scale, scale))


# ====================================================================== per-field functions (templates)
def field_templates():
    T = {}
    T["sec"] = fn("""
execute if score #state @@OBJ matches 1 run function td:f@@N/game/second
execute store result score #np @@OBJ if entity @@FP
execute store result score #ns @@OBJ if entity @a[scores={td.fld=@@N},tag=td.spec]
function td:f@@N/status
""")
    T["status"] = fn("""
execute store result storage td:st f@@N.state int 1 run scoreboard players get #state @@OBJ
execute store result storage td:st f@@N.left int 1 run scoreboard players get #left @@OBJ
execute store result storage td:st f@@N.elapsed int 1 run scoreboard players get #elapsed @@OBJ
execute store result storage td:st f@@N.kills int 1 run scoreboard players get #kills @@OBJ
execute store result storage td:st f@@N.enemies int 1 run scoreboard players get #ne @@OBJ
execute store result storage td:st f@@N.front int 1 run scoreboard players get #front @@OBJ
execute store result storage td:st f@@N.core int 1 run scoreboard players get @e[tag=td.core,tag=@@FT,limit=1] td.hp
execute store result storage td:st f@@N.gateHp int 1 run scoreboard players get @e[tag=td.front,tag=@@FT,limit=1] td.hp
execute store result storage td:st f@@N.players int 1 run scoreboard players get #np @@OBJ
execute store result storage td:st f@@N.watchers int 1 run scoreboard players get #ns @@OBJ
execute store result storage td:st f@@N.vs int 1 run scoreboard players get #vs @@OBJ
execute store result storage td:st f@@N.games int 1 run scoreboard players get #games @@OBJ
execute store result storage td:st f@@N.wasvs int 1 run scoreboard players get #wasvs @@OBJ
execute store result storage td:st f@@N.result int 1 run scoreboard players get #result @@OBJ
execute store result storage td:st f@@N.built int 1 if entity @e[tag=td.core,tag=@@FT]
""")
    T["game/second"] = fn("""
scoreboard players add #elapsed @@OBJ 1
execute if score #time td.cfg matches 1.. run scoreboard players remove #left @@OBJ 1
execute as @@EN store result score @s td.x run data get entity @s Pos[0]
function td:f@@N/gate/front
execute as @e[tag=td.front,tag=@@FT,limit=1] run function td:f@@N/gate/hit
execute as @e[tag=td.core,tag=@@FT,limit=1] run function td:f@@N/core/hit
execute if score #state @@OBJ matches 1 run function td:f@@N/wave/second
function td:f@@N/hud
execute if score #state @@OBJ matches 1 if score #time td.cfg matches 1.. if score #left @@OBJ matches ..0 run function td:f@@N/end/win
""")
    # ------------------------------------------------------------- gates
    T["gate/front"] = fn("""
tag @e[tag=td.front,tag=@@FT] remove td.front
scoreboard players set #front @@OBJ 0
execute as @e[tag=td.gate,tag=@@FT,tag=!td.broken] if score @s td.idx > #front @@OBJ run scoreboard players operation #front @@OBJ = @s td.idx
execute as @e[tag=td.gate,tag=@@FT,tag=!td.broken] if score @s td.idx = #front @@OBJ run tag @s add td.front
""")
    T["gate/hit"] = fn("""
scoreboard players operation #fx td.v = @s td.x
scoreboard players set #dmg td.v 0
execute as @@EN if score @s td.x <= #fx td.v run scoreboard players operation #dmg td.v += @s td.atk
execute if score #dmg td.v matches 1.. run function td:f@@N/gate/damaged
""")
    T["gate/damaged"] = fn("""
scoreboard players operation @s td.hp -= #dmg td.v
execute at @s run particle minecraft:block{block_state:"minecraft:polished_blackstone_bricks"} ~1 ~-1.5 ~ 0.4 1 2.5 0 30
execute at @s run playsound minecraft:entity.zombie.attack_wooden_door hostile @@FA ~ ~ ~ 0.8 0.8
execute if score @s td.hp matches ..0 run function td:f@@N/gate/break
""")
    T["gate/break"] = fn("""
scoreboard players set @s td.hp 0
tag @s add td.broken
tag @s remove td.front
execute at @s run function td:gate/clear with entity @s data
execute at @s run particle minecraft:explosion_emitter ~1 ~-1.5 ~ 1 1 3 0 6
execute as @@FA at @s run playsound minecraft:entity.generic.explode master @s ~ ~ ~ 1 0.6
execute as @@FA at @s run playsound minecraft:entity.wither.break_block master @s ~ ~ ~ 0.7 0.8
title @@FA subtitle [{text:"第",color:"red"},{score:{name:"@s",objective:"td.idx"},color:"red"},{text:"関門が突破された！後ろに下がれ！",color:"red"}]
title @@FA title {text:"突破された！",color:"dark_red",bold:true}
function td:f@@N/gate/front
function td:f@@N/gate/moveplayers
""")
    T["gate/moveplayers"] = fn("""
execute at @e[tag=td.front,tag=@@FT,limit=1] run tp @@FP ~ ~ ~ -90 10
execute unless entity @e[tag=td.front,tag=@@FT] at @e[tag=td.last,tag=@@FT,limit=1] run tp @@FP ~ ~ ~ -90 20
""")
    # ------------------------------------------------------------- core
    T["core/hit"] = fn("""
scoreboard players operation #cx td.v = @s td.x
scoreboard players set #dmg td.v 0
execute as @@EN if score @s td.x <= #cx td.v at @s run function td:f@@N/core/leak
scoreboard players operation #dmg td.v *= #leakMul td.cfg
scoreboard players operation @s td.hp -= #dmg td.v
execute if score @s td.hp matches ..-1 run scoreboard players set @s td.hp 0
execute if score #dmg td.v matches 1.. run function td:f@@N/core/alarm
execute if score @s td.hp matches ..0 run function td:f@@N/end/lose
""")
    T["core/leak"] = fn("""
scoreboard players operation #dmg td.v += @s td.atk
scoreboard players add #leaked @@OBJ 1
particle minecraft:soul_fire_flame ~ ~1 ~ 0.3 0.6 0.3 0.05 30
tp @s ~ -400 ~
kill @s
""")
    T["core/alarm"] = fn("""
execute at @s run particle minecraft:angry_villager ~ ~1.5 ~ 1 1 1 0 12
execute as @@FA at @s run playsound minecraft:block.bell.use master @s ~ ~ ~ 1 0.6
title @@FA actionbar {text:"⚠ 敵がコアに到達！",color:"red",bold:true}
""")
    # ------------------------------------------------------------- waves (enemies that come without gifts)
    T["wave/second"] = fn("""
execute unless score #waveSec td.cfg matches 1.. run return 0
scoreboard players add #wt @@OBJ 1
execute if score #wt @@OBJ < #waveSec td.cfg run return 0
scoreboard players set #wt @@OBJ 0
scoreboard players operation #wn td.v = #elapsed @@OBJ
execute if score #waveRamp td.cfg matches 1.. run scoreboard players operation #wn td.v /= #waveRamp td.cfg
execute unless score #waveRamp td.cfg matches 1.. run scoreboard players set #wn td.v 0
scoreboard players operation #wn td.v += #waveN td.cfg
scoreboard players operation #wn td.v < #waveMax td.cfg
function td:f@@N/wave/loop
""")
    T["wave/loop"] = fn("""
execute if score #wn td.v matches ..0 run return 0
scoreboard players remove #wn td.v 1
execute store result score #r td.v run random value 1..100
execute if score #elapsed @@OBJ matches ..90 run scoreboard players set #r td.v 1
execute if score #r td.v matches ..70 run function td:f@@N/spawn/zombie
execute if score #r td.v matches 71..85 run function td:f@@N/spawn/runner
execute if score #r td.v matches 86.. run function td:f@@N/spawn/skeleton
tag @e[tag=td.new] remove td.new
function td:f@@N/wave/loop
""")
    for t in MOBS:
        T[f"spawn/{t}"] = spawn_fn(t)
    # ------------------------------------------------------------- HUD
    T["kills"] = fn("""
scoreboard players operation #kills @@OBJ = #spawned @@OBJ
scoreboard players operation #kills @@OBJ -= #ne @@OBJ
scoreboard players operation #kills @@OBJ -= #leaked @@OBJ
""")
    T["hud"] = fn("""
execute at @e[tag=td.front,tag=@@FT,limit=1] run spawnpoint @@FP ~ ~ ~ -90 0
execute unless entity @e[tag=td.front,tag=@@FT] at @e[tag=td.last,tag=@@FT,limit=1] run spawnpoint @@FP ~ ~ ~ -90 0
execute store result bossbar td:core@@N value run scoreboard players get @e[tag=td.core,tag=@@FT,limit=1] td.hp
execute store result bossbar td:core@@N max run scoreboard players get #coreHp td.cfg
bossbar set td:core@@N players @@FA
execute store result bossbar td:gate@@N max run scoreboard players get #gateHp td.cfg
execute store result bossbar td:gate@@N value run scoreboard players get @e[tag=td.front,tag=@@FT,limit=1] td.hp
bossbar set td:gate@@N name [{text:"第",color:"yellow"},{score:{name:"#front",objective:"@@OBJ"}},{text:"関門"}]
execute if entity @e[tag=td.front,tag=@@FT] run bossbar set td:gate@@N players @@FA
execute unless entity @e[tag=td.front,tag=@@FT] run bossbar set td:gate@@N players
execute store result score #ne @@OBJ if entity @@EN
function td:f@@N/kills
scoreboard players reset * @@INFO
execute if score #time td.cfg matches 1.. run scoreboard players operation 残り秒 @@INFO = #left @@OBJ
scoreboard players operation 敵の数 @@INFO = #ne @@OBJ
scoreboard players operation 撃破数 @@INFO = #kills @@OBJ
scoreboard players operation 残り関門 @@INFO = #front @@OBJ
scoreboard players operation コアHP @@INFO = @e[tag=td.core,tag=@@FT,limit=1] td.hp
""")
    # ------------------------------------------------------------- game control
    T["start"] = fn("""
function td:f@@N/clear
scoreboard players set #state @@OBJ 1
scoreboard players operation #left @@OBJ = #time td.cfg
scoreboard players set #elapsed @@OBJ 0
scoreboard players set #wt @@OBJ 0
scoreboard players set #spawned @@OBJ 0
scoreboard players set #leaked @@OBJ 0
scoreboard players set #kills @@OBJ 0
scoreboard players set #ne @@OBJ 0
scoreboard players set #result @@OBJ 0
scoreboard players operation #wasvs @@OBJ = #vs @@OBJ
scoreboard players operation @e[tag=td.core,tag=@@FT] td.hp = #coreHp td.cfg
execute as @e[tag=td.gate,tag=@@FT] run function td:gate/reset
function td:f@@N/gate/front
gamemode adventure @a[scores={td.fld=@@N},gamemode=!spectator,gamemode=!creative]
effect clear @@FP
effect give @@FP minecraft:instant_health 1 5 true
effect give @@FP minecraft:saturation 5 5 true
function td:f@@N/gate/moveplayers
execute as @@FP run function td:loadout_self
function td:f@@N/hud
title @@FA subtitle {text:"関門を守り抜け！",color:"yellow"}
title @@FA title {text:"防衛開始",color:"gold",bold:true}
execute as @@FA at @s run playsound minecraft:event.raid.horn master @s ~ ~ ~ 1 1
tellraw @a[scores={td.fld=0}] [{text:"[フィールド@@N] ",color:"@@COL",bold:true},{text:"ゲームが始まりました ",color:"gray"},{selector:"@@FP",color:"yellow"}]
""")
    T["stop"] = fn("""
execute if score #vs @@OBJ matches 1 run function td:vs/cancel
scoreboard players set #state @@OBJ 0
function td:f@@N/clear
bossbar set td:gate@@N players
bossbar set td:core@@N players
""")
    # removed enemies are not kills: take them out of the spawned count first
    T["clear"] = fn("""
execute store result score #n td.v if entity @@EN
scoreboard players operation #spawned @@OBJ -= #n td.v
execute as @@EN at @s run tp @s ~ -400 ~
kill @@EN
scoreboard players set #ne @@OBJ 0
function td:avatar/cleanup
""")
    T["loadout"] = "execute as @@FP run function td:loadout_self\n"
    # called by the app for the weapon gift: {id, ammo, n, label}
    T["weapon"] = fn("""
$give @@FP $(id) 1
$give @@FP $(ammo) $(n)
$title @@FA actionbar [{text:"$(label)",color:"gold",bold:true},{text:" が届いた！",color:"white"}]
""")
    T["record"] = fn("""
scoreboard players add #games @@OBJ 1
execute as @@FP run scoreboard players operation @s td.rk > #kills @@OBJ
execute as @@FP run scoreboard players operation @s td.rt > #elapsed @@OBJ
""")
    T["end/win"] = fn("""
scoreboard players set #state @@OBJ 2
scoreboard players set #result @@OBJ 1
execute as @@EN at @s run particle minecraft:poof ~ ~1 ~ 0.3 0.6 0.3 0.02 10
function td:f@@N/clear
scoreboard players set #ne @@OBJ 0
function td:f@@N/kills
function td:f@@N/hud
function td:f@@N/record
execute as @@FP run scoreboard players add @s td.rw 1
title @@FA subtitle [{text:"撃破数 ",color:"yellow"},{score:{name:"#kills",objective:"@@OBJ"},color:"gold",bold:true}]
title @@FA title {text:"防衛成功！",color:"gold",bold:true}
execute as @@FA at @s run playsound minecraft:ui.toast.challenge_complete master @s ~ ~ ~ 1 1
function td:f@@N/do/firework
tellraw @@FA [{text:"[TikTok Defense] ",color:"gold",bold:true},{text:"防衛成功！ 撃破数 ",color:"white"},{score:{name:"#kills",objective:"@@OBJ"},color:"yellow"}]
tellraw @a[scores={td.fld=0}] [{text:"[フィールド@@N] ",color:"@@COL",bold:true},{selector:"@@FP",color:"yellow"},{text:" が防衛成功！ 撃破数 ",color:"white"},{score:{name:"#kills",objective:"@@OBJ"},color:"gold"}]
execute if score #vs @@OBJ matches 1 run function td:vs/ended {f:@@N}
""")
    T["end/lose"] = fn("""
scoreboard players set #state @@OBJ 2
scoreboard players set #result @@OBJ 2
function td:f@@N/clear
scoreboard players set #ne @@OBJ 0
function td:f@@N/kills
function td:f@@N/hud
function td:f@@N/record
execute at @e[tag=td.core,tag=@@FT,limit=1] run particle minecraft:explosion_emitter ~ ~1 ~ 2 2 2 0 10
execute as @@FA at @s run playsound minecraft:entity.wither.death master @s ~ ~ ~ 1 0.8
title @@FA subtitle [{text:"撃破数 ",color:"gray"},{score:{name:"#kills",objective:"@@OBJ"},color:"white"}]
title @@FA title {text:"コア陥落…",color:"dark_red",bold:true}
tellraw @@FA [{text:"[TikTok Defense] ",color:"gold",bold:true},{text:"コアが破壊された… 撃破数 ",color:"white"},{score:{name:"#kills",objective:"@@OBJ"},color:"yellow"},{text:" 生存 ",color:"white"},{score:{name:"#elapsed",objective:"@@OBJ"},color:"yellow"},{text:"秒",color:"white"}]
tellraw @a[scores={td.fld=0}] [{text:"[フィールド@@N] ",color:"@@COL",bold:true},{selector:"@@FP",color:"yellow"},{text:" のコアが陥落（生存 ",color:"gray"},{score:{name:"#elapsed",objective:"@@OBJ"},color:"white"},{text:"秒・撃破 ",color:"gray"},{score:{name:"#kills",objective:"@@OBJ"},color:"white"},{text:"）",color:"gray"}]
execute if score #vs @@OBJ matches 1 run function td:vs/ended {f:@@N}
""")
    # versus: the other field lost first, this one wins without waiting for the timer
    T["end/vsend"] = fn("""
scoreboard players set #state @@OBJ 2
scoreboard players set #result @@OBJ 1
function td:f@@N/clear
scoreboard players set #ne @@OBJ 0
function td:f@@N/kills
function td:f@@N/hud
function td:f@@N/record
execute as @@FA at @s run playsound minecraft:ui.toast.challenge_complete master @s ~ ~ ~ 1 1
function td:f@@N/do/firework
execute if score #vs @@OBJ matches 1 run function td:vs/ended {f:@@N}
""")
    # ------------------------------------------------------------- players
    T["enter"] = fn("""
team join @@FT @s
execute at @e[tag=td.front,tag=@@FT,limit=1] run tp @s ~ ~ ~ -90 10
execute unless entity @e[tag=td.front,tag=@@FT] at @e[tag=td.last,tag=@@FT,limit=1] run tp @s ~ ~ ~ -90 20
execute at @s run spawnpoint @s ~ ~ ~ -90 0
clear @s
execute if score #state @@OBJ matches 1 run function td:loadout_self
execute if score #state @@OBJ matches 1 run effect give @s minecraft:instant_health 1 5 true
""")
    T["join"] = fn(f"""
execute unless score #fields td.cfg matches @@N.. run return run tellraw @s {{text:"フィールド@@N は今は使えません",color:"red"}}
execute unless entity @e[tag=td.core,tag=@@FT] run return run tellraw @s {{text:"フィールド@@N はまだ作られていません（パネルで「フィールドを作り直す」）",color:"red"}}
execute if entity @s[scores={{td.fld=@@N}},tag=!td.spec] run return run function td:f@@N/enter
execute if score #vs @@OBJ matches 1 unless entity @s[tag=td.vsp] run return run tellraw @s [{{text:"フィールド@@N は対戦中です。",color:"red"}},{click('[観戦する]', '/trigger td.menu set 2@@N', 'aqua', 'フィールド@@Nを観戦')}]
execute if score @s td.fld matches 1.. run function td:p/leave
tag @s remove td.spec
tag @s remove td.vsq
scoreboard players set @s td.fld @@N
gamemode adventure @s
function td:f@@N/enter
tellraw @@FA [{{selector:"@s",color:"yellow"}},{{text:" がフィールド@@N に入りました",color:"white"}}]
execute unless score #state @@OBJ matches 1 unless score #vs @@OBJ matches 1 run tellraw @s [{{text:"準備ができたら ",color:"gray"}},{click('[▶ スタート]', '/trigger td.menu set 3', 'green', 'このフィールドでゲームを始める')},{{text:"  "}},{click('[ロビーに戻る]', '/trigger td.menu set 2', 'gray', '待機所に戻る')}]
""")
    T["spectate"] = fn("""
execute unless score #fields td.cfg matches @@N.. run return run tellraw @s {text:"フィールド@@N は今は使えません",color:"red"}
execute unless entity @e[tag=td.core,tag=@@FT] run return run tellraw @s {text:"フィールド@@N はまだ作られていません",color:"red"}
execute if score @s td.fld matches 1.. run function td:p/leave
tag @s remove td.vsq
scoreboard players set @s td.fld @@N
tag @s add td.spec
team join @@FT @s
clear @s
gamemode spectator @s
execute at @e[tag=td.last,tag=@@FT,limit=1] run tp @s ~ ~4 ~ -90 25
tellraw @s [{text:"フィールド@@N を観戦中。",color:"aqua"},{text:"  "},""" + click('[ロビーに戻る]', '/trigger td.menu set 2', 'gray', '待機所に戻る') + """]
""")
    T["leave"] = fn("""
function td:p/tolobby
tellraw @@FA [{selector:"@s",color:"yellow"},{text:" がフィールド@@N を出ました",color:"gray"}]
execute if score #vs @@OBJ matches 1 unless entity @@FP run return run function td:f@@N/abandon_vs
execute if score #state @@OBJ matches 1 unless entity @@FP run function td:f@@N/abandon
""")
    T["abandon"] = fn("""
function td:f@@N/stop
tellraw @@FA {text:"誰もいなくなったのでゲームを止めました",color:"gray"}
""")
    T["abandon_vs"] = fn("""
execute if score #state @@OBJ matches 1 run return run function td:f@@N/end/lose
function td:vs/cancel
""")
    T["pstart"] = fn("""
execute if entity @s[tag=td.spec] run return run tellraw @s {text:"観戦中はスタートできません",color:"red"}
execute if score #state @@OBJ matches 1 run return run tellraw @s {text:"もう始まっています",color:"red"}
execute if score #vs @@OBJ matches 1 run return run tellraw @s {text:"対戦の開始を待っています",color:"red"}
tellraw @@FA [{selector:"@s",color:"yellow"},{text:" がゲームを開始しました",color:"white"}]
function td:f@@N/start
""")
    LEFT = '{score:{name:"#left",objective:"@@OBJ"},color:"white"}'
    T["menu"] = fn(f"""
execute if score #vs @@OBJ matches 1 run return run tellraw @s [{{text:"■ フィールド@@N ",color:"@@COL",bold:true}},{{text:"対戦中 ",color:"light_purple"}},{{selector:"@@FP",color:"yellow"}},{{text:" "}},{click('[観戦]', '/trigger td.menu set 2@@N', 'aqua', 'フィールド@@Nを観戦')}]
execute if score #state @@OBJ matches 1 run tellraw @s [{{text:"■ フィールド@@N ",color:"@@COL",bold:true}},{{text:"ゲーム中 ",color:"red"}},{{text:"残り",color:"gray"}},{LEFT},{{text:"秒 撃破",color:"gray"}},{{score:{{name:"#kills",objective:"@@OBJ"}},color:"white"}},{{text:" ",color:"gray"}},{{selector:"@@FP",color:"yellow"}},{{text:" "}},{click('[参加]', '/trigger td.menu set 1@@N', 'green', 'フィールド@@Nに加わる')},{{text:" "}},{click('[観戦]', '/trigger td.menu set 2@@N', 'aqua', 'フィールド@@Nを観戦')}]
execute unless score #state @@OBJ matches 1 run tellraw @s [{{text:"■ フィールド@@N ",color:"@@COL",bold:true}},{{text:"空き ",color:"green"}},{{selector:"@@FP",color:"yellow"}},{{text:" "}},{click('[入る]', '/trigger td.menu set 1@@N', 'green', 'フィールド@@Nに入る')},{{text:" "}},{click('[観戦]', '/trigger td.menu set 2@@N', 'aqua', 'フィールド@@Nを観戦')}]
execute if data storage td:own f@@N run tellraw @s [{{text:"    配信: ",color:"gray"}},{{nbt:"f@@N",storage:"td:own",color:"light_purple"}}]
""")
    for aid, (label, kind, _n, body) in ACTIONS.items():
        tail = "execute as @e[tag=td.new,tag=@@ET] run function td:mob/decorate\n" if kind == "enemy" else ""
        T[f"do/{aid}"] = ("execute unless score #state @@OBJ matches 1 run return fail\n" if aid != "firework" else "") \
            + fn(body) + tail
        T[f"act/{aid}"] = act_fn(label, kind)
    return T


def build(path):
    F = {}
    NF = MAX_FIELDS
    # ------------------------------------------------------------- load
    load = """
scoreboard objectives add td.v dummy
scoreboard objectives add td.cfg dummy
scoreboard objectives add td.hp dummy
scoreboard objectives add td.idx dummy
scoreboard objectives add td.x dummy
scoreboard objectives add td.atk dummy
scoreboard objectives add td.age dummy
scoreboard objectives add td.fld dummy
scoreboard objectives add td.menu trigger {text:"TikTok Defense メニュー"}
scoreboard objectives add td.left minecraft.custom:minecraft.leave_game
scoreboard objectives add td.rk dummy {text:"🏆 ベスト撃破数",color:"gold",bold:true}
scoreboard objectives add td.rt dummy {text:"🏆 最長生存（秒）",color:"aqua",bold:true}
scoreboard objectives add td.rw dummy {text:"🏆 防衛成功の回数",color:"green",bold:true}
scoreboard objectives add td.rv dummy {text:"🏆 対戦の勝ち数",color:"light_purple",bold:true}
scoreboard objectives setdisplay sidebar td.rk
bossbar remove td:core
bossbar remove td:gate
execute unless score #vsOn td.v = #vsOn td.v run scoreboard players set #vsOn td.v 0
"""
    for n in range(1, NF + 1):
        c = FIELD_COLORS[n - 1]
        load += f"""
scoreboard objectives add td.f{n} dummy
scoreboard objectives add td.i{n} dummy {{text:"フィールド{n}",color:"{c}",bold:true}}
scoreboard objectives modify td.i{n} numberformat styled {{color:"yellow",bold:true}}
team add td.f{n} {{text:"フィールド{n}"}}
team modify td.f{n} color {c}
team modify td.f{n} prefix {{text:"[F{n}] ",color:"{c}"}}
team modify td.f{n} friendlyFire false
scoreboard objectives setdisplay sidebar.team.{c} td.i{n}
bossbar add td:core{n} {{text:"コア（フィールド{n}）"}}
bossbar set td:core{n} color red
bossbar set td:core{n} style notched_10
bossbar add td:gate{n} {{text:"関門"}}
bossbar set td:gate{n} color yellow
bossbar set td:gate{n} style notched_10
execute unless score #state td.f{n} = #state td.f{n} run scoreboard players set #state td.f{n} 0
execute unless score #vs td.f{n} = #vs td.f{n} run scoreboard players set #vs td.f{n} 0
"""
    load += "".join(f"execute unless score #{k} td.cfg = #{k} td.cfg run scoreboard players set #{k} td.cfg {v}\n" for k, v in CFG_DEFAULTS.items())
    load += f"execute unless score #fields td.cfg = #fields td.cfg run scoreboard players set #fields td.cfg {FIELDS_DEFAULT}\n"
    load += f"execute unless data storage td:cfg mobs run data modify storage td:cfg mobs set value {{{','.join(f'{k}:{snbt(v)}' for k, v in MOB_DEFAULTS.items())}}}\n"
    load += "execute unless data storage td:cfg game run data modify storage td:cfg game set value {r:3,avatar:0.12f}\n"
    load += 'execute unless data storage td:cfg loadout run data modify storage td:cfg loadout set value [{id:"pointblank:m4a1",count:1},{id:"pointblank:ammo556",count:240},{id:"pointblank:glock17",count:1},{id:"pointblank:ammo9mm",count:120},{id:"pointblank:grenade",count:4}]\n'
    # the single-field version had no field tags: what is left of it becomes field 1
    load += """
tag @e[tag=td.field,tag=!td.fx] add td.f1
tag @e[tag=td.field,tag=!td.fx] add td.fx
execute as @e[tag=td.enemy,tag=!td.ex] at @s run tp @s ~ -400 ~
kill @e[tag=td.enemy,tag=!td.ex]
"""
    F["load"] = fn(load)

    F["tick"] = fn("""
scoreboard players add @e[tag=td.avpop] td.age 1
kill @e[tag=td.avpop,scores={td.age=100..}]
execute as @a unless score @s td.fld = @s td.fld run function td:p/first
execute as @a[scores={td.left=1..}] run function td:p/rejoin
execute as @a[scores={td.menu=1..}] run function td:p/menu
scoreboard players add #t td.v 1
execute if score #t td.v matches 20.. run function td:second
""")
    F["second"] = fn("".join([
        "scoreboard players set #t td.v 0\n",
        "function td:avatar/cleanup\n",
        "scoreboard players enable @a td.menu\n",
        *[f"execute if score #fields td.cfg matches {n}.. run function td:f{n}/sec\n" for n in range(1, NF + 1)],
        "function td:vs/second\n",
        # the waiting area's sidebar takes turns showing the records
        "scoreboard players add #rot td.v 1\n",
        "execute if score #rot td.v matches 8 run scoreboard objectives setdisplay sidebar td.rt\n",
        "execute if score #rot td.v matches 16 run scoreboard objectives setdisplay sidebar td.rw\n",
        "execute if score #rot td.v matches 24 run scoreboard objectives setdisplay sidebar td.rv\n",
        "execute if score #rot td.v matches 32.. run scoreboard objectives setdisplay sidebar td.rk\n",
        "execute if score #rot td.v matches 32.. run scoreboard players set #rot td.v 0\n",
    ]))

    # ------------------------------------------------------------- shared gate / core helpers (run as the marker)
    F["gate/clear"] = fn("""
$fill $(x1) $(y1) $(z1) $(x2) $(y3) $(z2) minecraft:air
$fill $(lx) $(y1) $(lz) $(lx) $(y2) $(lz) minecraft:air
""")
    F["gate/restore"] = fn("""
$fill $(x1) $(y1) $(z1) $(x2) $(y2) $(z2) minecraft:polished_blackstone_bricks
$fill $(x1) $(y2) $(z1) $(x2) $(y2) $(z2) minecraft:chiseled_polished_blackstone
$setblock $(x1) $(y3) $(z1) minecraft:polished_blackstone_wall
$setblock $(x1) $(y3) $(z2) minecraft:polished_blackstone_wall
$fill $(lx) $(y1) $(lz) $(lx) $(y2) $(lz) minecraft:ladder[facing=west]
""")
    F["gate/reset"] = fn(f"""
tag @s remove td.broken
scoreboard players operation @s td.hp = #gateHp td.cfg
execute at @s run function {NS}:gate/restore with entity @s data
""")
    F["gate/repair"] = fn("""
scoreboard players operation #add td.v = #gateHp td.cfg
scoreboard players operation #add td.v *= #repairPct td.cfg
scoreboard players set #c100 td.v 100
scoreboard players operation #add td.v /= #c100 td.v
scoreboard players operation @s td.hp += #add td.v
scoreboard players operation @s td.hp < #gateHp td.cfg
execute at @s run particle minecraft:wax_on ~1 ~-1.5 ~ 0.5 1 3 0 60
execute at @s run playsound minecraft:block.anvil.use master @a ~ ~ ~ 1 1.2
""")
    F["core/repair"] = fn("""
scoreboard players operation #add td.v = #coreHp td.cfg
scoreboard players operation #add td.v *= #repairPct td.cfg
scoreboard players set #c100 td.v 100
scoreboard players operation #add td.v /= #c100 td.v
scoreboard players operation @s td.hp += #add td.v
scoreboard players operation @s td.hp < #coreHp td.cfg
execute at @s run particle minecraft:wax_on ~ ~1 ~ 0.5 1 0.5 0 40
""")

    # ------------------------------------------------------------- mobs
    for t in MOBS:
        F[f"mob/{t}"] = mob_fn(t)
    F["mob/place"] = fn(f"""
tag @s add td.placed
$execute store result storage td:tmp p.dz int 1 run random value -$(r)..$(r)
execute store result storage td:tmp p.dx int 1 run random value 0..4
function {NS}:mob/tp with storage td:tmp p
particle minecraft:reverse_portal ~ ~1 ~ 0.4 0.8 0.4 0.05 30
""")
    F["mob/tp"] = "$tp @s ~$(dx) ~ ~$(dz)\n"
    # viewer mobs: the viewer's name as the mob name and the avatar riding on its head
    F["mob/decorate"] = fn(f"""
tag @s remove td.new
data modify entity @s CustomName set from storage td:cur mobname
data modify entity @s CustomNameVisible set value 0b
execute at @s run function {NS}:mob/avatar with storage td:cfg game
data modify entity @e[type=minecraft:text_display,tag=td.avnew,limit=1] text set from storage td:av text
ride @e[type=minecraft:text_display,tag=td.avnew,limit=1] mount @s
tag @e[tag=td.avnew] remove td.avnew
execute at @s run summon minecraft:text_display ~ ~ ~ {{Tags:["td.av","td.avmob","td.avnew"],billboard:"center",shadow:1b,line_width:1000,background:1073741824,transformation:{{left_rotation:[0f,0f,0f,1f],right_rotation:[0f,0f,0f,1f],translation:[0f,0.25f,0f],scale:[0.8f,0.8f,0.8f]}},text:{{text:""}}}}
data modify entity @e[type=minecraft:text_display,tag=td.avnew,limit=1] text set from storage td:cur mobname
ride @e[type=minecraft:text_display,tag=td.avnew,limit=1] mount @s
tag @e[tag=td.avnew] remove td.avnew
""")
    F["mob/avatar"] = "$" + avatar_display(["td.av", "td.avmob", "td.avnew"], 0, "$(avatar)", 0.55) + "\n"

    # ------------------------------------------------------------- avatar pop-ups
    F["avatar/pop"] = fn(f"""
{avatar_display(["td.av", "td.avpop", "td.avnew"], 3.1, 0.16)}
data modify entity @e[type=minecraft:text_display,tag=td.avnew,limit=1] text set from storage td:av text
tag @e[tag=td.avnew] remove td.avnew
{avatar_display(["td.av", "td.avpop", "td.avnew"], 2.75, 1.0)}
data modify entity @e[type=minecraft:text_display,tag=td.avnew,limit=1] text set from storage td:cur label
tag @e[tag=td.avnew] remove td.avnew
""")
    F["avatar/spawnpop"] = fn(f"""
{avatar_display(["td.av", "td.avpop", "td.avnew"], 5, 0.4)}
data modify entity @e[type=minecraft:text_display,tag=td.avnew,limit=1] text set from storage td:av text
tag @e[tag=td.avnew] remove td.avnew
{avatar_display(["td.av", "td.avpop", "td.avnew"], 4.2, 2.5)}
data modify entity @e[type=minecraft:text_display,tag=td.avnew,limit=1] text set from storage td:cur label
tag @e[tag=td.avnew] remove td.avnew
""")
    F["avatar/cleanup"] = fn("""
tag @e[tag=td.avmob] add td.orphan
execute as @e[tag=td.enemy] on passengers run tag @s remove td.orphan
kill @e[tag=td.orphan]
""")

    # ------------------------------------------------------------- effects
    F["fx/blast"] = fn("""
particle minecraft:explosion_emitter ~ ~1 ~ 0 0 0 0 1
particle minecraft:lava ~ ~1 ~ 0.5 0.5 0.5 0 10
damage @s 40 minecraft:explosion
""")
    F["fx/nuke"] = fn("""
particle minecraft:explosion_emitter ~ ~1 ~ 0 0 0 0 1
damage @s 200 minecraft:explosion
""")

    # ------------------------------------------------------------- loadout (run as the player)
    F["loadout_self"] = fn(f"""
clear @s
data modify storage td:tmp list set from storage td:cfg loadout
function {NS}:loadout_loop
""")
    F["loadout_loop"] = fn(f"""
execute unless data storage td:tmp list[0] run return 0
function {NS}:give with storage td:tmp list[0]
data remove storage td:tmp list[0]
function {NS}:loadout_loop
""")
    F["give"] = "$give @s $(id) $(count)\n"

    # ------------------------------------------------------------- players: waiting area, menu
    F["p/first"] = fn(f"""
scoreboard players set @s td.fld 0
scoreboard players set @s td.left 0
function {NS}:p/tolobby
tellraw @s [{{text:"ようこそ TikTok Defense へ！ ",color:"gold",bold:true}},{{text:"看板を右クリックするか、下のメニューからフィールドを選んでください。",color:"white"}}]
function {NS}:menu/show
""")
    rejoin = ["scoreboard players set @s td.left 0",
              f"execute if entity @s[tag=td.spec] run return run function {NS}:p/tolobby"]
    rejoin += [f"execute if score @s td.fld matches {n} if score #state td.f{n} matches 1 run return run function {NS}:f{n}/enter"
               for n in range(1, NF + 1)]
    rejoin += [f"function {NS}:p/tolobby",
               'tellraw @s [{text:"待機所にいます。 ",color:"gray"},' + click('[メニューを開く]', '/trigger td.menu set 1', 'gold', 'フィールドを選ぶ') + ']']
    F["p/rejoin"] = fn("\n".join(rejoin))
    F["p/tolobby"] = fn(f"""
tag @s remove td.spec
tag @s remove td.vsq
scoreboard players set @s td.fld 0
team leave @s
gamemode adventure @s
clear @s
effect clear @s
execute at @e[tag=td.lobby,limit=1] rotated as @e[tag=td.lobby,limit=1] run tp @s ~ ~ ~ ~ ~
execute at @e[tag=td.lobby,limit=1] run spawnpoint @s ~ ~ ~
scoreboard players enable @s td.menu
""")
    menu = ["scoreboard players operation #m td.v = @s td.menu",
            "scoreboard players set @s td.menu 0",
            "scoreboard players enable @s td.menu",
            f"execute if score #m td.v matches 1 run return run function {NS}:menu/show",
            f"execute if score #m td.v matches 2 run return run function {NS}:p/leave",
            f"execute if score #m td.v matches 3 run return run function {NS}:p/start",
            f"execute if score #m td.v matches 4 run return run function {NS}:vs/queue",
            f"execute if score #m td.v matches 5 run return run function {NS}:menu/records"]
    for n in range(1, NF + 1):
        menu.append(f"execute if score #m td.v matches 1{n} run return run function {NS}:f{n}/join")
        menu.append(f"execute if score #m td.v matches 2{n} run return run function {NS}:f{n}/spectate")
    F["p/menu"] = fn("\n".join(menu))
    F["p/leave"] = fn("\n".join(
        [f"execute if score @s td.fld matches {n} run return run function {NS}:f{n}/leave" for n in range(1, NF + 1)]
        + [f"function {NS}:p/tolobby"]))
    F["p/start"] = fn("\n".join(
        [f"execute if score @s td.fld matches {n} run return run function {NS}:f{n}/pstart" for n in range(1, NF + 1)]
        + ['tellraw @s [{text:"先にフィールドに入ってください。 ",color:"red"},' + click('[メニュー]', '/trigger td.menu set 1', 'gold', 'フィールドを選ぶ') + ']']))
    F["menu/show"] = fn("\n".join(
        ['tellraw @s ["\\n",{text:"━━━ TikTok Defense フィールド選択 ━━━",color:"gold",bold:true}]']
        + [f"execute if score #fields td.cfg matches {n}.. run function {NS}:f{n}/menu" for n in range(1, NF + 1)]
        + ['tellraw @s [' + click('[▶ スタート]', '/trigger td.menu set 3', 'green', '入っているフィールドでゲームを始める') + ',{text:"  "},'
           + click('[⚔ 対戦モード]', '/trigger td.menu set 4', 'light_purple', '2人そろうと空いているフィールド2つで同時にスタート（もう一度押すとやめる）') + ',{text:"  "},'
           + click('[🏆 記録]', '/trigger td.menu set 5', 'gold', '自分の記録を見る') + ',{text:"  "},'
           + click('[待機所へ]', '/trigger td.menu set 2', 'gray', 'フィールドを出て待機所に戻る') + ']']))
    F["menu/records"] = fn("""
tellraw @s [{text:"━━ あなたの記録 ━━",color:"gold",bold:true}]
tellraw @s [{text:"ベスト撃破数 ",color:"gray"},{score:{name:"@s",objective:"td.rk"},color:"yellow"},{text:"   最長生存 ",color:"gray"},{score:{name:"@s",objective:"td.rt"},color:"yellow"},{text:"秒",color:"gray"}]
tellraw @s [{text:"防衛成功 ",color:"gray"},{score:{name:"@s",objective:"td.rw"},color:"yellow"},{text:"回   対戦の勝ち ",color:"gray"},{score:{name:"@s",objective:"td.rv"},color:"yellow"},{text:"回",color:"gray"}]
tellraw @s {text:"ランキングは待機所の右の画面と、待機所のサイドバーに出ています。",color:"gray"}
""")

    # ------------------------------------------------------------- versus
    F["vs/queue"] = fn(f"""
execute if entity @s[tag=td.vsq] run return run function {NS}:vs/unqueue
execute if score @s td.fld matches 1.. run function {NS}:p/leave
tag @s add td.vsq
tellraw @s [{{text:"[対戦] ",color:"light_purple",bold:true}},{{text:"相手を待っています。そろうと空いているフィールド2つで同時にスタートします。",color:"white"}},{click('[やめる]', '/trigger td.menu set 4', 'gray', '対戦の募集をやめる')}]
tellraw @a[tag=!td.vsq,scores={{td.fld=0}}] [{{text:"[対戦] ",color:"light_purple",bold:true}},{{selector:"@s",color:"yellow"}},{{text:" が対戦相手を募集中！ ",color:"white"}},{click('[受けて立つ]', '/trigger td.menu set 4', 'light_purple', '対戦に参加する')}]
""")
    F["vs/unqueue"] = fn("""
tag @s remove td.vsq
tellraw @s {text:"対戦の募集をやめました",color:"gray"}
""")
    F["vs/second"] = fn(f"""
execute if score #vsOn td.v matches 2 run function {NS}:vs/count
execute if score #vsOn td.v matches 0 run function {NS}:vs/match
execute if score #vsOn td.v matches 1.. run title @a[tag=td.vsq] actionbar {{text:"ほかの対戦が終わるのを待っています…",color:"light_purple"}}
""")
    find = ["scoreboard players set #fa td.v 0", "scoreboard players set #fb td.v 0"]
    for n in range(1, NF + 1):
        find.append(f"execute if score #fields td.cfg matches {n}.. unless score #state td.f{n} matches 1 unless score #vs td.f{n} matches 1 "
                    f"unless score #rsv td.f{n} matches 1 if entity @e[tag=td.core,tag=td.f{n}] unless entity @a[scores={{td.fld={n}}},gamemode=!spectator] "
                    f"run function {NS}:vs/cand {{f:{n}}}")
    F["vs/find"] = fn("\n".join(find))
    F["vs/cand"] = fn("""
$execute if score #fa td.v matches 0 run return run scoreboard players set #fa td.v $(f)
$execute if score #fb td.v matches 0 run scoreboard players set #fb td.v $(f)
""")
    F["vs/match"] = fn(f"""
execute store result score #n td.v if entity @a[tag=td.vsq]
execute if score #n td.v matches ..0 run return 0
execute if score #n td.v matches 1 run return run title @a[tag=td.vsq] actionbar {{text:"⚔ 対戦相手を待っています…",color:"light_purple"}}
function {NS}:vs/find
execute if score #fb td.v matches 0 run return run title @a[tag=td.vsq] actionbar {{text:"⚔ 空いているフィールドを待っています…",color:"light_purple"}}
tag @a[tag=td.vsq,limit=1,sort=arbitrary] add td.vsp1
tag @a[tag=td.vsp1] remove td.vsq
tag @a[tag=td.vsq,limit=1,sort=arbitrary] add td.vsp2
tag @a[tag=td.vsp2] remove td.vsq
execute store result storage td:vs pick.a int 1 run scoreboard players get #fa td.v
execute store result storage td:vs pick.b int 1 run scoreboard players get #fb td.v
function {NS}:vs/pair with storage td:vs pick
""")
    F["vs/pair"] = fn(f"""
tag @a[tag=td.vsp1] add td.vsp
tag @a[tag=td.vsp2] add td.vsp
$execute as @a[tag=td.vsp1] run function {NS}:f$(a)/join
$execute as @a[tag=td.vsp2] run function {NS}:f$(b)/join
tag @a remove td.vsp1
tag @a remove td.vsp2
$function {NS}:vs/begin {{a:$(a),b:$(b)}}
tag @a remove td.vsp
""")
    # the app (or the matchmaking) calls this with two field numbers; starts after a countdown
    F["vs/begin"] = fn(f"""
execute if score #vsOn td.v matches 1.. run return fail
$execute if score #state td.f$(a) matches 1 run function {NS}:f$(a)/stop
$execute if score #state td.f$(b) matches 1 run function {NS}:f$(b)/stop
$scoreboard players set #vs td.f$(a) 1
$scoreboard players set #vs td.f$(b) 1
$scoreboard players set #vsr td.f$(a) 0
$scoreboard players set #vsr td.f$(b) 0
$data modify storage td:vs cur set value {{a:$(a),b:$(b)}}
scoreboard players set #vsOn td.v 2
scoreboard players set #vsT td.v 6
$tellraw @a [{{text:"[対戦] ",color:"light_purple",bold:true}},{{text:"フィールド$(a) ",color:"white"}},{{selector:"@a[scores={{td.fld=$(a)}},gamemode=!spectator]",color:"yellow"}},{{text:"  vs  ",color:"light_purple",bold:true}},{{text:"フィールド$(b) ",color:"white"}},{{selector:"@a[scores={{td.fld=$(b)}},gamemode=!spectator]",color:"yellow"}},{{text:"  まもなく同時スタート！",color:"white"}}]
return 1
""")
    F["vs/count"] = fn(f"""
scoreboard players remove #vsT td.v 1
function {NS}:vs/count_show with storage td:vs cur
execute if score #vsT td.v matches ..0 run function {NS}:vs/go with storage td:vs cur
""")
    F["vs/count_show"] = fn("""
execute if score #vsT td.v matches ..0 run return 0
$title @a[scores={td.fld=$(a)}] times 0 25 5
$title @a[scores={td.fld=$(b)}] times 0 25 5
$title @a[scores={td.fld=$(a)}] subtitle {text:"対戦スタートまで",color:"light_purple"}
$title @a[scores={td.fld=$(b)}] subtitle {text:"対戦スタートまで",color:"light_purple"}
$title @a[scores={td.fld=$(a)}] title {score:{name:"#vsT",objective:"td.v"},color:"gold",bold:true}
$title @a[scores={td.fld=$(b)}] title {score:{name:"#vsT",objective:"td.v"},color:"gold",bold:true}
$execute as @a[scores={td.fld=$(a)}] at @s run playsound minecraft:block.note_block.pling master @s ~ ~ ~ 1 1
$execute as @a[scores={td.fld=$(b)}] at @s run playsound minecraft:block.note_block.pling master @s ~ ~ ~ 1 1
""")
    F["vs/go"] = fn(f"""
scoreboard players set #vsOn td.v 1
$title @a[scores={{td.fld=$(a)}}] times 10 50 20
$title @a[scores={{td.fld=$(b)}}] times 10 50 20
$function {NS}:f$(a)/start
$function {NS}:f$(b)/start
$title @a[scores={{td.fld=$(a)}}] title {{text:"対戦スタート！",color:"light_purple",bold:true}}
$title @a[scores={{td.fld=$(b)}}] title {{text:"対戦スタート！",color:"light_purple",bold:true}}
""")
    F["vs/ended"] = fn(f"""
$execute store result score #vsr td.f$(f) run scoreboard players get #result td.f$(f)
function {NS}:vs/decide with storage td:vs cur
""")
    # results: #vsr 0 still running, 1 survived (or the other one fell), 2 core fell
    F["vs/decide"] = fn(f"""
$scoreboard players operation #ra td.v = #vsr td.f$(a)
$scoreboard players operation #rb td.v = #vsr td.f$(b)
$execute if score #ra td.v matches 2 if score #rb td.v matches 0 run return run function {NS}:f$(b)/end/vsend
$execute if score #rb td.v matches 2 if score #ra td.v matches 0 run return run function {NS}:f$(a)/end/vsend
execute if score #ra td.v matches 0 run return 0
execute if score #rb td.v matches 0 run return 0
scoreboard players set #w td.v 0
execute if score #ra td.v matches 1 if score #rb td.v matches 2 run scoreboard players set #w td.v 1
execute if score #ra td.v matches 2 if score #rb td.v matches 1 run scoreboard players set #w td.v 2
$scoreboard players operation #ka td.v = #kills td.f$(a)
$scoreboard players operation #kb td.v = #kills td.f$(b)
execute if score #w td.v matches 0 if score #ka td.v > #kb td.v run scoreboard players set #w td.v 1
execute if score #w td.v matches 0 if score #ka td.v < #kb td.v run scoreboard players set #w td.v 2
$execute store result score #ca td.v run scoreboard players get @e[tag=td.core,tag=td.f$(a),limit=1] td.hp
$execute store result score #cb td.v run scoreboard players get @e[tag=td.core,tag=td.f$(b),limit=1] td.hp
execute if score #w td.v matches 0 if score #ca td.v > #cb td.v run scoreboard players set #w td.v 1
execute if score #w td.v matches 0 if score #ca td.v < #cb td.v run scoreboard players set #w td.v 2
function {NS}:vs/result with storage td:vs cur
""")
    F["vs/result"] = fn(f"""
$scoreboard players set #vs td.f$(a) 0
$scoreboard players set #vs td.f$(b) 0
scoreboard players set #vsOn td.v 0
$execute if score #w td.v matches 1 run function {NS}:vs/win {{w:$(a),l:$(b)}}
$execute if score #w td.v matches 2 run function {NS}:vs/win {{w:$(b),l:$(a)}}
$execute if score #w td.v matches 0 run tellraw @a [{{text:"[対戦結果] ",color:"light_purple",bold:true}},{{text:"引き分け！ フィールド$(a) と フィールド$(b) は撃破数もコアHPも同じでした",color:"white"}}]
$data modify storage td:vs last set value {{a:$(a),b:$(b)}}
execute store result storage td:vs last.w int 1 run scoreboard players get #w td.v
$execute store result storage td:vs last.ka int 1 run scoreboard players get #kills td.f$(a)
$execute store result storage td:vs last.kb int 1 run scoreboard players get #kills td.f$(b)
$execute store result storage td:vs last.ta int 1 run scoreboard players get #elapsed td.f$(a)
$execute store result storage td:vs last.tb int 1 run scoreboard players get #elapsed td.f$(b)
execute store result storage td:vs last.ra int 1 run scoreboard players get #ra td.v
execute store result storage td:vs last.rb int 1 run scoreboard players get #rb td.v
scoreboard players add #vsN td.v 1
execute store result storage td:vs last.n int 1 run scoreboard players get #vsN td.v
""")
    F["vs/win"] = fn("""
$execute as @a[scores={td.fld=$(w)},gamemode=!spectator] run scoreboard players add @s td.rv 1
$tellraw @a [{text:"[対戦結果] ",color:"light_purple",bold:true},{text:"勝者 ",color:"gold",bold:true},{text:"フィールド$(w) ",color:"white"},{selector:"@a[scores={td.fld=$(w)},gamemode=!spectator]",color:"gold"},{text:"（撃破 ",color:"gray"},{score:{name:"#kills",objective:"td.f$(w)"},color:"white"},{text:"・生存 ",color:"gray"},{score:{name:"#elapsed",objective:"td.f$(w)"},color:"white"},{text:"秒）",color:"gray"},{text:"  敗者 ",color:"gray"},{text:"フィールド$(l) ",color:"white"},{selector:"@a[scores={td.fld=$(l)},gamemode=!spectator]",color:"gray"},{text:"（撃破 ",color:"gray"},{score:{name:"#kills",objective:"td.f$(l)"},color:"white"},{text:"・生存 ",color:"gray"},{score:{name:"#elapsed",objective:"td.f$(l)"},color:"white"},{text:"秒）",color:"gray"}]
$title @a[scores={td.fld=$(w)}] subtitle {text:"対戦の結果",color:"light_purple"}
$title @a[scores={td.fld=$(w)}] title {text:"勝利！",color:"gold",bold:true}
$title @a[scores={td.fld=$(l)}] subtitle {text:"対戦の結果",color:"light_purple"}
$title @a[scores={td.fld=$(l)}] title {text:"敗北…",color:"gray",bold:true}
""")
    F["vs/cancel"] = fn(f"""
execute unless score #vsOn td.v matches 1.. run return 0
scoreboard players set #vsOn td.v 0
function {NS}:vs/cancel_go with storage td:vs cur
""")
    F["vs/cancel_go"] = fn(f"""
$scoreboard players set #vs td.f$(a) 0
$scoreboard players set #vs td.f$(b) 0
$execute if score #state td.f$(a) matches 1 run function {NS}:f$(a)/stop
$execute if score #state td.f$(b) matches 1 run function {NS}:f$(b)/stop
$tellraw @a [{{text:"[対戦] ",color:"light_purple",bold:true}},{{text:"フィールド$(a) と フィールド$(b) の対戦は中止になりました",color:"gray"}}]
""")

    # ------------------------------------------------------------- per field
    tpl = field_templates()
    for n in range(1, NF + 1):
        for name, body in tpl.items():
            F[f"f{n}/{name}"] = field_text(body, n)

    # ------------------------------------------------------------- the single-field names (= field 1)
    F["start"] = f"function {NS}:f1/start\n"
    F["stop"] = f"function {NS}:f1/stop\n"
    F["clear"] = f"function {NS}:f1/clear\n"
    F["loadout"] = f"function {NS}:f1/loadout\n"
    F["hud"] = f"function {NS}:f1/hud\n"
    F["weapon"] = f'$function {NS}:f1/weapon {{id:"$(id)",ammo:"$(ammo)",n:$(n),label:"$(label)"}}\n'
    for aid in ACTIONS:
        F[f"do/{aid}"] = f"function {NS}:f1/do/{aid}\n"
        F[f"act/{aid}"] = f'$return run function {NS}:f1/act/{aid} {{name:"$(name)",gift:"$(gift)"}}\n'
    F["ping"] = 'tellraw @a [{text:"[TikTok Defense] ",color:"gold",bold:true},{text:"TikTok 連携アプリと接続しました",color:"gray"}]\n'

    files = {
        "pack.mcmeta": json.dumps({"pack": {
            "description": [{"text": "TikTok Defense", "color": "gold"}],
            "min_format": list(DATA_FORMAT), "max_format": [DATA_FORMAT[0], 999]}}, ensure_ascii=False, indent=2),
        "data/minecraft/tags/function/load.json": json.dumps({"values": [f"{NS}:load"]}),
        "data/minecraft/tags/function/tick.json": json.dumps({"values": [f"{NS}:tick"]}),
    }
    for name, body in F.items():
        assert "@@" not in body, (name, body)
        files[f"data/{NS}/function/{name}.mcfunction"] = body
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        for name, data in files.items():
            z.writestr(name, data.encode("utf-8"))
    # the app reads labels / kinds / defaults from here
    meta = {
        "actions": {k: {"label": v[0], "kind": v[1], "count": v[2]} for k, v in ACTIONS.items()},
        "mobs": {k: {"label": LABEL[k], **v} for k, v in MOB_DEFAULTS.items()},
        "cfg": CFG_DEFAULTS,
        "maxFields": MAX_FIELDS,
        "fieldColors": FIELD_COLORS,
    }
    with open(path.replace(".zip", ".meta.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)
    print("ok:", path, len(files), "files,", len(ACTIONS), "actions,", MAX_FIELDS, "fields")


if __name__ == "__main__":
    build(sys.argv[1] if len(sys.argv) > 1 else "td_datapack.zip")
