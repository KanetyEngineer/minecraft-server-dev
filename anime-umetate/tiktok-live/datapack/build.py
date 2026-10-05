"""Anime Umetate (アニメ技の埋め立て) x TikTok LIVE: build the game data pack.

usage: python build.py [out.zip]

Several independent fields (pits) in one world, plus a waiting area (hub) where players pick one.
Every field has its own state, timer, boss bar, harassment ranking, clones and round restart, so
several games run at the same time. Two players can also race on two fields of the same preset (versus).

Two namespaces:
  umetate     the game itself: hub, fields (umetate:f<N>/...), moves, records, versus
  anime_live  what the TikTok bridge app calls through RCON:
                  function anime_live:f<N>/act/<action> {name:"<viewer>",gift:"<gift label>",rname:"<viewer without spaces>"}
              act/<action> announces who sent it (to that field's players), then runs f<N>/do/<action>,
              which only touches field N's pit and players. anime_live:act/<action> is kept as field 1.

Field N (origin ox, oz): pit x ox..ox+w-1, z oz..oz+w-1, y (120-depth)..119, bedrock floor below, glass walls,
platform at y 120 around it. Every destructive move removes blocks from the top surface down, so 100 % is always reachable.

Per field: objective um.f<N> (#state #ticks #pct ...), team um.f<N> (its sidebar colour shows um.rank<N>),
boss bar umetate:f<N>, entity tag um.f<N> on the move markers and clones.
Players: um.fld = the field they are in (0 = hub). um.home = field a streamer goes to directly when joining.
Records: um.lb<P> (per preset, per player, stored as -ticks so the sidebar sorts fastest first),
storage umetate:lb p<P> [{name,t,f}] and vslog for the panel.
"""
import json
import sys
import zipfile

NS = "umetate"
LIVE = "anime_live"
DATA_FORMAT = (107, 1)  # Minecraft 26.2

# ------------------------------------------------------------------ layout (edit here to add fields)
PRESETS = {  # id: name, pit width, depth
    1: {"name": "標準", "w": 5, "depth": 20},
    2: {"name": "ミニ", "w": 4, "depth": 12},
}
# (field id, preset id, origin x, origin z); field 1 stays where the single pit used to be
FIELDS = [(1, 1, 0, 0), (2, 1, 600, 0), (3, 1, 1200, 0), (4, 1, 1800, 0), (5, 2, 2400, 0), (6, 2, 3000, 0)]
# team colour (sidebar slot) and pedestal wool per field
FIELD_COLORS = [("aqua", "light_blue"), ("green", "lime"), ("yellow", "yellow"), ("light_purple", "magenta"),
                ("gold", "orange"), ("red", "red"), ("blue", "blue"), ("dark_aqua", "cyan"), ("dark_green", "green"),
                ("dark_purple", "purple"), ("dark_red", "brown"), ("gray", "gray"), ("dark_blue", "black"), ("dark_gray", "light_gray")]
HX, HZ = 0, -600            # waiting area centre (floor at y 120)
HUB_SPAWN = f"{HX + 0.5} 121 {HZ - 7.5} 0 5"
HUB_BOX = f"x={HX - 24},y=100,z={HZ - 13},dx=48,dy=60,dz=28"
LOOT_BOX = f"{HX} 112 {HZ}"  # a barrel under the hub, used to read player names
LAYOUT = 2                   # bump to rebuild everything on the next /reload

COLORS = ["white", "lime", "light_blue", "pink", "yellow"]
FILL_BLOCK = "minecraft:lime_concrete"
assert len(FIELDS) <= len(FIELD_COLORS)


def j(obj):
    return json.dumps(obj, ensure_ascii=False)


def txt(text, color="white", bold=False):
    d = {"text": text, "color": color}
    if bold:
        d["bold"] = True
    return d


def click(text, color, command, hover):
    return j({"text": text, "color": color, "bold": True,
              "click_event": {"action": "run_command", "command": command},
              "hover_event": {"action": "show_text", "value": hover}})


def sphere(color, scale, spread, count, at="~ ~ ~"):
    r, g, b = color
    return f"particle minecraft:dust{{color:[{r},{g},{b}],scale:{scale}}} {at} {spread} {spread} {spread} 0 {count} force"


def rep(prefix, text):
    """put an 'execute if ... run ' prefix in front of every line of a multi-line snippet"""
    return text.replace("\n", "\n" + prefix)


def firework_cmd(at, colors, shape, flight=1):
    return (f"summon minecraft:firework_rocket {at} {{LifeTime:{18 + flight * 6},FireworksItem:{{id:\"minecraft:firework_rocket\",count:1,"
            f"components:{{\"minecraft:fireworks\":{{flight_duration:{flight}b,explosions:[{{shape:\"{shape}\",colors:{colors},has_twinkle:true,has_trail:true}}]}}}}}}}}")


def give_blocks():
    out = []
    for i, c in enumerate(COLORS):
        # concrete powder: falls like sand until it lands, so the pit fills from the bottom without gaps
        out.append(f'item replace entity @s hotbar.{i} with minecraft:{c}_concrete_powder[can_place_on=[{{blocks:"#{NS}:placeable"}}],'
                   f'item_name={j(txt("埋め立てブロック", "green"))}] 64')
    return "\n".join(out)


def avatar_display(tags, y, scale, translation="0f,0f,0f"):
    return ("summon minecraft:text_display ~ ~%s ~ {Tags:%s,billboard:\"center\",background:0,shadow:0b,"
            "transformation:{left_rotation:[0f,0f,0f,1f],right_rotation:[0f,0f,0f,1f],translation:[%s],scale:[%sf,%sf,%sf]},text:{text:\"\"}}"
            % (y, json.dumps(tags), translation, scale, scale, scale))


BEAMS = {
    # style: particle lines drawn every 0.5 block
    "kame": [sphere((0.45, 0.85, 1.0), 3.0, 0.3, 5), "particle minecraft:end_rod ~ ~ ~ 0.15 0.15 0.15 0.01 2 force"],
    "biju": [sphere((0.15, 0.0, 0.2), 3.5, 0.35, 6), sphere((0.6, 0.1, 0.8), 1.5, 0.2, 2)],
    "gomu": [sphere((0.95, 0.75, 0.55), 2.5, 0.1, 2), sphere((0.85, 0.1, 0.1), 1.2, 0.15, 1)],
    "bolt": ["particle minecraft:electric_spark ~ ~ ~ 0.1 0.1 0.1 0.05 3 force", sphere((1.0, 0.95, 0.3), 1.6, 0.05, 2)],
}
BEAM_FILES = {
    style: "\n".join(lines) + f"\nscoreboard players remove #steps um.tmp 1\nexecute if score #steps um.tmp matches 1.. positioned ^ ^ ^0.5 run function {NS}:fx/beam/{style}\n"
    for style, lines in BEAMS.items()
}

# id: (label, target, needsGame); target: random = one random player of the field, all = every player, server = once (the pit)
ACTION_META = {
    "taiyoken": ("太陽拳（目くらまし）", "random", False),
    "gomu_pistol": ("ゴムゴムのピストル（吹っ飛ばし＋足元2個）", "random", False),
    "chidori": ("千鳥（周りを1段崩す）", "random", False),
    "rasengan": ("螺旋丸（足元3×3を4段掘る）", "random", False),
    "kienzan": ("気円斬（上2段を切る）", "server", False),
    "kage_bunshin": ("影分身の術（分身が邪魔をする）", "random", True),
    "aka": ("術式反転「赫」（上空へ吹っ飛ばす）", "random", False),
    "kamehameha": ("かめはめ波（上3段を吹き飛ばす）", "server", False),
    "ao": ("術式順転「蒼」（足元3×3を6段・引きずり込む）", "random", False),
    "amaterasu": ("天照（黒い炎が2段焼く）", "server", False),
    "hekireki": ("霹靂一閃（雷の一閃で2段）", "server", False),
    "murasaki": ("虚式「茈」（上8段を消し飛ばす）", "server", False),
    "fukuma": ("領域展開「伏魔御廚子」（斬撃で穴だらけ）", "server", False),
    "bijudama": ("尾獣玉（大爆発で6段）", "server", False),
    "muryokusho": ("領域展開「無量空処」（8秒動けない＋4段）", "server", False),
    "genkidama": ("元気玉（上12段を消し飛ばす）", "server", False),
    "senzu": ("仙豆（穴を埋めて1段足す）", "server", True),
    "ouen": ("みんなの応援（穴を埋めて3段足す）", "server", True),
    "firework": ("花火", "server", False),
}


class Field:
    def __init__(self, n, preset, ox, oz):
        p = PRESETS[preset]
        self.n, self.preset, self.ox, self.oz = n, preset, ox, oz
        self.w, self.depth = p["w"], p["depth"]
        self.X0, self.X1, self.Z0, self.Z1 = ox, ox + self.w - 1, oz, oz + self.w - 1
        self.Y1 = 119
        self.Y0 = 120 - self.depth
        self.TOTAL = self.w * self.w * self.depth
        self.CX, self.CZ = ox + self.w / 2, oz + self.w / 2
        self.ST = f"um.f{n}"
        self.TAG = f"um.f{n}"
        self.FN = f"{NS}:f{n}"
        self.LV = f"{LIVE}:f{n}"
        self.PL = f"@a[scores={{um.fld={n}}}]"
        self.PLA = f"@a[scores={{um.fld={n}}},gamemode=adventure]"
        self.RND = f"@r[scores={{um.fld={n}}},gamemode=adventure]"
        self.color, self.wool = FIELD_COLORS[n - 1]
        self.size = f"{self.w}×{self.w}×{self.depth}"
        self.label = f"フィールド{n}"
        self.pname = p["name"]


FS = [Field(*f) for f in FIELDS]


# ------------------------------------------------------------------ one field: every function under umetate:f<N>/ and anime_live:f<N>/
def field_files(F, f):
    n, ST, FN, LV, PL, PLA, TAG = F.n, F.ST, F.FN, F.LV, F.PL, F.PLA, F.TAG
    X0, X1, Z0, Z1, Y0, Y1, CX, CZ, TOTAL = F.X0, F.X1, F.Z0, F.Z1, F.Y0, F.Y1, F.CX, F.CZ, F.TOTAL
    ox, oz = F.ox, F.oz
    PX, PZ = ox + F.w // 2 + 0.5, oz + F.w // 2 + 0.5  # a block centre in the middle of the pit (where players are put)
    PIT = f"{X0} {Y0} {Z0} {X1} {Y1} {Z1}"
    IN_PIT = f"x={X0},y={Y0 - 1},z={Z0},dx={X1 - X0 + 0.99},dy={Y1 - Y0 + 3},dz={Z1 - Z0 + 0.99}"
    SPAWN = f"{CX} 121 {oz - 5.5} 0 10"
    SCRATCH = f"{X0} 60 {Z0}"            # clone target used for counting
    AIR_REF = f"{X0} 50 {Z0}"            # one layer that always stays air
    CASTERS = [(ox - 6, 126, oz - 6), (ox + 11, 126, oz - 6), (ox - 6, 126, oz + 11), (ox + 11, 126, oz + 11)]
    BOX = f"x={ox - 10},y=94,z={oz - 10},dx=24,dy=70,dz=24"
    KILL_LOCAL = (f"kill @e[tag=um.mob,tag={TAG}]\nkill @e[type=marker,tag=um.fx,tag={TAG}]\n"
                  f"execute positioned {CX} 120 {CZ} run kill @e[tag=al.av,distance=..40]")

    def title(main, color, sub=None, sub_color="white"):
        out = [f"title {PL} times 5 40 15", f"title {PL} title {j(txt(main, color, True))}"]
        if sub:
            out.append(f"title {PL} subtitle {j(txt(sub, sub_color))}")
        return "\n".join(out)

    def carve_all(depth):
        return f"scoreboard players set #depth um.tmp {depth}\nfunction {FN}/carve/all"

    def carve_col(depth, r=1):
        # run at a position: removes an r-radius column from the surface down
        return f"scoreboard players set #depth um.tmp {depth}\nscoreboard players set #r um.tmp {r}\nfunction {FN}/carve/col"

    def fx(move, here="caster"):
        """summon the effect marker for a timed move.
        here = caster: one of the four corners above the platform; col: at the target column; center: above the pit"""
        tags = j(["um.fx", TAG, f"um.m.{move}", "um.new"])
        if here == "caster":
            return f"function {FN}/fx/caster_spot\nexecute positioned as @e[type=marker,tag=um.spot,limit=1] run summon minecraft:marker ~ ~ ~ {{Tags:{tags}}}\nkill @e[type=marker,tag=um.spot]\nfunction {NS}:fx/new_avatar"
        if here == "center":
            return f"summon minecraft:marker {CX} 128 {CZ} {{Tags:{tags}}}\nfunction {NS}:fx/new_avatar"
        # col: at the executing player if they are over the pit, else at the pit centre
        return (f"execute if entity @s[{IN_PIT}] run summon minecraft:marker ~ ~ ~ {{Tags:{tags}}}\n"
                f"execute unless entity @s[{IN_PIT}] run summon minecraft:marker {CX} ~ {CZ} {{Tags:{tags}}}\n"
                f"tag @e[tag=um.new] remove um.new")

    def marker(move, y):
        return f"summon minecraft:marker {CX} {y} {CZ} {{Tags:[\"um.fx\",\"{TAG}\",\"um.m.{move}\"]}}\nfunction {NS}:fx/new_avatar"

    def beam(style, steps=52):
        return f"scoreboard players set #steps um.tmp {steps}\nexecute facing {CX} 106 {CZ} run function {NS}:fx/beam/{style}"

    clone_cmds = chr(10).join(
        f'summon minecraft:husk ~{dx} ~0.5 ~{dz} {{Tags:["um.mob","um.clone","{TAG}","al.new"],PersistenceRequired:1b,Silent:1b,attributes:[{{id:"minecraft:attack_damage",base:0d}},{{id:"minecraft:movement_speed",base:0.33d}},{{id:"minecraft:knockback_resistance",base:1d}}],equipment:{{chest:{{id:"minecraft:leather_chestplate",count:1,components:{{"minecraft:dyed_color":16744448}}}},legs:{{id:"minecraft:leather_leggings",count:1,components:{{"minecraft:dyed_color":16744448}}}}}},drop_chances:{{chest:0.0f,legs:0.0f}}}}'
        for dx, dz in ((1, 0), (-1, 0), (0, 1), (0, -1)))

    # ---------------------------------------------------------------- the moves (do/<id>)
    DO = {
        # ---------------- 1 coin
        "taiyoken": f"""
{title("太陽拳！", "yellow")}
particle minecraft:flash{{color:[1.0,1.0,0.9,1.0]}} ~ ~1.6 ~ 0 0 0 0 1 force
particle minecraft:end_rod ~ ~1.6 ~ 0.6 0.6 0.6 0.25 60 force
playsound minecraft:entity.firework_rocket.blast master @a ~ ~ ~ 1 2
playsound minecraft:block.beacon.power_select master @a ~ ~ ~ 1 2
effect give @s minecraft:blindness 3 0 true
""",
        "gomu_pistol": f"""
{title("ゴムゴムの…ピストル！", "red")}
execute positioned ~-9 ~1 ~ facing entity @s eyes run scoreboard players set #steps um.tmp 18
execute positioned ~-9 ~1 ~ facing entity @s eyes run function {NS}:fx/beam/gomu
playsound minecraft:entity.breeze.wind_burst master @a ~ ~ ~ 1 0.8
playsound minecraft:entity.player.attack.knockback master @a ~ ~ ~ 1 0.6
particle minecraft:explosion ~ ~1 ~ 0.3 0.3 0.3 0 2 force
effect give @s minecraft:levitation 1 12 true
{carve_col(2, 0)}
""",
        "chidori": f"""
{title("千鳥！", "aqua")}
particle minecraft:electric_spark ~ ~1 ~ 0.8 0.8 0.8 0.4 120 force
particle minecraft:flash{{color:[0.5,0.8,1.0,1.0]}} ~ ~1 ~ 0 0 0 0 1 force
{sphere((0.55, 0.8, 1.0), 1.5, 0.6, 40, "~ ~1 ~")}
playsound minecraft:entity.lightning_bolt.thunder master @a ~ ~ ~ 0.6 2
playsound minecraft:block.note_block.chime master @a ~ ~ ~ 1 2
playsound minecraft:entity.parrot.ambient master @a ~ ~ ~ 1 2
{carve_col(1, 1)}
""",
        # ---------------- 5 coins
        "rasengan": f"""
{title("螺旋丸！", "aqua")}
{fx("rasengan", "col")}
""",
        "kienzan": f"""
{title("気円斬！", "yellow")}
{marker("kienzan", 128)}
""",
        "kage_bunshin": f"""
{title("影分身の術！", "gold")}
execute store result score #n um.tmp if entity @e[tag=um.clone,tag={TAG}]
execute if score #n um.tmp matches 12.. run return run function {NS}:fx/firework
particle minecraft:poof ~ ~1 ~ 1.2 1 1.2 0.05 80 force
particle minecraft:cloud ~ ~1 ~ 1 1 1 0.02 40 force
playsound minecraft:entity.illusioner.mirror_move master @a ~ ~ ~ 1 1
playsound minecraft:entity.puffer_fish.blow_up master @a ~ ~ ~ 1 0.6
{clone_cmds}
""",
        "aka": f"""
{title("術式反転「赫」", "red")}
{sphere((1.0, 0.1, 0.1), 3.0, 0.5, 60, "~ ~1 ~")}
particle minecraft:explosion_emitter ~ ~1 ~ 0 0 0 0 1 force
playsound minecraft:entity.generic.explode master @a ~ ~ ~ 1 1.2
playsound minecraft:entity.warden.sonic_boom master @a ~ ~ ~ 0.6 1.6
effect give @s minecraft:levitation 1 24 true
{carve_col(2, 1)}
""",
        # ---------------- 20 coins
        "kamehameha": f"""
{title("かめはめ波", "aqua")}
{fx("kamehameha")}
""",
        "ao": f"""
{title("術式順転「蒼」", "blue")}
{fx("ao", "col")}
""",
        "amaterasu": f"""
{title("天照", "dark_purple")}
{marker("amaterasu", 121)}
""",
        "hekireki": f"""
{title("雷の呼吸 壱ノ型「霹靂一閃」", "yellow")}
execute positioned {ox - 7} 121 {oz - 1} facing {ox + 12} 121 {oz + 2} run scoreboard players set #steps um.tmp 40
execute positioned {ox - 7} 121 {oz - 1} facing {ox + 12} 121 {oz + 2} run function {NS}:fx/beam/bolt
execute positioned {ox + 12} 121 {oz + 2} facing {ox - 7} 121 {oz + 5} run scoreboard players set #steps um.tmp 40
execute positioned {ox + 12} 121 {oz + 2} facing {ox - 7} 121 {oz + 5} run function {NS}:fx/beam/bolt
particle minecraft:flash{{color:[1.0,0.95,0.4,1.0]}} {CX} 118 {CZ} 0 0 0 0 1 force
playsound minecraft:item.trident.thunder master @a {CX} 115 {CZ} 1.2 1.3
playsound minecraft:entity.player.attack.sweep master @a {CX} 115 {CZ} 1 0.7
{carve_all(2)}
""",
        # ---------------- 99+ coins
        "murasaki": f"""
{title("虚式「茈」", "light_purple")}
{fx("murasaki", "center")}
""",
        "fukuma": f"""
{title("領域展開", "dark_red", "伏魔御廚子", "red")}
{marker("fukuma", 121)}
""",
        "bijudama": f"""
{title("尾獣玉", "dark_purple")}
{fx("bijudama")}
""",
        # ---------------- 500 / 1000 coins
        "muryokusho": f"""
{title("領域展開", "white", "無量空処", "aqua")}
{marker("muryokusho", 121)}
""",
        "genkidama": f"""
{title("元気玉", "aqua", "みんな、オラに元気をわけてくれ！", "yellow")}
{marker("genkidama", 150)}
""",
        # ---------------- support
        "senzu": f"""
{title("仙豆！", "green", "埋め立てを手伝ってくれた！", "green")}
scoreboard players set #add um.tmp 1
function {FN}/support
""",
        "ouen": f"""
{title("みんなの応援！", "green", "3段ぶん埋まった！", "green")}
scoreboard players set #add um.tmp 3
function {FN}/support
""",
        "firework": f"""
function {NS}:fx/firework
""",
    }
    assert set(DO) == set(ACTION_META)

    # ---------------------------------------------------------------- timed effects (as/at the fx marker every tick, @s um.t = age)
    FX = {
        "rasengan": f"""
tp @s ~ ~ ~ ~24 ~
{sphere((0.6, 0.85, 1.0), 2.0, 0.25, 8, "~ ~1.2 ~")}
particle minecraft:dust{{color:[0.9,0.97,1.0],scale:1.2}} ^0.6 ^1.2 ^ 0 0 0 0 1 force
particle minecraft:dust{{color:[0.9,0.97,1.0],scale:1.2}} ^-0.6 ^1.2 ^ 0 0 0 0 1 force
particle minecraft:dust{{color:[0.3,0.6,1.0],scale:1.2}} ^ ^1.2 ^0.6 0 0 0 0 1 force
particle minecraft:dust{{color:[0.3,0.6,1.0],scale:1.2}} ^ ^1.2 ^-0.6 0 0 0 0 1 force
execute if score @s um.t matches 1 run playsound minecraft:item.trident.riptide_1 master @a ~ ~ ~ 1 1.4
execute if score @s um.t matches 10 run playsound minecraft:item.trident.riptide_2 master @a ~ ~ ~ 1 1.6
execute if score @s um.t matches 20 run particle minecraft:explosion ~ ~ ~ 1 0.5 1 0 6 force
execute if score @s um.t matches 20 run particle minecraft:cloud ~ ~ ~ 1 1 1 0.2 60 force
execute if score @s um.t matches 20 run playsound minecraft:entity.generic.explode master @a ~ ~ ~ 1 1.3
execute if score @s um.t matches 20 run {rep('execute if score @s um.t matches 20 run ', carve_col(4, 1))}
execute if score @s um.t matches 22.. run kill @s
""",
        "kienzan": f"""
tp @s ~ ~ ~ ~20 ~
execute if score @s um.t matches 1 run function {FN}/surface
execute if score @s um.t matches 1 store result storage {NS}:arg y int 1 run scoreboard players get #surf um.tmp
execute if score @s um.t matches 1 run function {NS}:fx/to_surface with storage {NS}:arg
particle minecraft:dust{{color:[1.0,0.95,0.3],scale:1.5}} ^ ^ ^3.5 0 0 0 0 1 force
particle minecraft:dust{{color:[1.0,0.95,0.3],scale:1.5}} ^ ^ ^-3.5 0 0 0 0 1 force
particle minecraft:dust{{color:[1.0,1.0,0.7],scale:1.0}} ^3.5 ^ ^ 0 0 0 0 1 force
particle minecraft:dust{{color:[1.0,1.0,0.7],scale:1.0}} ^-3.5 ^ ^ 0 0 0 0 1 force
particle minecraft:end_rod ^ ^ ^3 0 0 0 0 1 force
execute if score @s um.t matches 1 run playsound minecraft:item.trident.riptide_3 master @a ~ ~ ~ 1 1.8
execute if score @s um.t matches 12 run playsound minecraft:entity.player.attack.sweep master @a ~ ~ ~ 1.2 0.6
execute if score @s um.t matches 12 run particle minecraft:sweep_attack {CX} ~ {CZ} 2 0.2 2 0 20 force
execute if score @s um.t matches 12 run {rep('execute if score @s um.t matches 12 run ', carve_all(2))}
execute if score @s um.t matches 18.. run kill @s
""",
        "ao": f"""
particle minecraft:reverse_portal ~ ~1 ~ 2 2 2 0.6 40 force
{sphere((0.15, 0.35, 1.0), 2.5, 0.3, 10, "~ ~1 ~")}
execute as @e[tag=um.mob,tag={TAG},distance=..12] at @s facing entity @e[type=marker,tag=um.m.ao,tag={TAG},limit=1,sort=nearest] feet run tp @s ^ ^ ^0.5
execute if score @s um.t matches 1 run playsound minecraft:block.portal.trigger master @a ~ ~ ~ 0.8 1.6
execute if score @s um.t matches 1 run playsound minecraft:entity.warden.sonic_charge master @a ~ ~ ~ 0.8 1.4
execute if score @s um.t matches 25 run particle minecraft:explosion ~ ~ ~ 1 2 1 0 8 force
execute if score @s um.t matches 25 run playsound minecraft:entity.generic.explode master @a ~ ~ ~ 1 0.7
execute if score @s um.t matches 25 run {rep('execute if score @s um.t matches 25 run ', carve_col(6, 1))}
execute if score @s um.t matches 28.. run kill @s
""",
        "amaterasu": f"""
execute if score @s um.t matches 1 run playsound minecraft:item.firecharge.use master @a {CX} 115 {CZ} 1.5 0.5
execute if score @s um.t matches 1..60 run function {FN}/surface
execute if score @s um.t matches 1..60 store result storage {NS}:arg y int 1 run scoreboard players get #surf um.tmp
execute if score @s um.t matches 1..60 run function {FN}/fx/black_flame with storage {NS}:arg
execute if score @s um.t matches 10 run {rep('execute if score @s um.t matches 10 run ', carve_all(1))}
execute if score @s um.t matches 30 run {rep('execute if score @s um.t matches 30 run ', carve_all(1))}
execute if score @s um.t matches 10 run playsound minecraft:block.fire.extinguish master @a {CX} 115 {CZ} 1 0.5
execute if score @s um.t matches 30 run playsound minecraft:block.fire.extinguish master @a {CX} 115 {CZ} 1 0.5
execute if score @s um.t matches 50 run playsound minecraft:block.fire.extinguish master @a {CX} 115 {CZ} 1 0.5
execute if score @s um.t matches 62.. run kill @s
""",
        "kamehameha": f"""
execute if score @s um.t matches 1 run title {PL} actionbar {j(txt("か…", "aqua", True))}
execute if score @s um.t matches 7 run title {PL} actionbar {j(txt("か…め…", "aqua", True))}
execute if score @s um.t matches 13 run title {PL} actionbar {j(txt("か…め…は…", "aqua", True))}
execute if score @s um.t matches 19 run title {PL} actionbar {j(txt("か…め…は…め…", "aqua", True))}
execute if score @s um.t matches 28 run title {PL} actionbar {j(txt("波ーーーッ！！", "aqua", True))}
execute if score @s um.t matches 1 run playsound minecraft:entity.warden.sonic_charge master @a ~ ~ ~ 2 1.2
execute if score @s um.t matches 10 run playsound minecraft:block.beacon.activate master @a ~ ~ ~ 2 1.5
execute if score @s um.t matches 1..27 run {sphere((0.45, 0.85, 1.0), 2.5, 0.25, 6)}
execute if score @s um.t matches 14..27 run {sphere((0.8, 0.95, 1.0), 3.5, 0.45, 8)}
execute if score @s um.t matches 1..27 run particle minecraft:end_rod ~ ~ ~ 1.2 1.2 1.2 0.05 3 force
execute if score @s um.t matches 28 run playsound minecraft:entity.warden.sonic_boom master @a ~ ~ ~ 2 0.8
execute if score @s um.t matches 28 run playsound minecraft:entity.warden.sonic_boom master @a {CX} 112 {CZ} 2 0.8
execute if score @s um.t matches 28..44 run {rep('execute if score @s um.t matches 28..44 run ', beam("kame"))}
execute if score @s um.t matches 31 run particle minecraft:explosion_emitter {CX} 114 {CZ} 1 1 1 0 2 force
execute if score @s um.t matches 31 run playsound minecraft:entity.generic.explode master @a {CX} 112 {CZ} 2 0.8
execute if score @s um.t matches 31 run {rep('execute if score @s um.t matches 31 run ', carve_all(3))}
execute if score @s um.t matches 46.. run kill @s
""",
        "bijudama": f"""
tp @s ~ ~ ~ ~30 ~
execute if score @s um.t matches 1 run playsound minecraft:entity.ender_dragon.growl master @a ~ ~ ~ 2 0.6
execute if score @s um.t matches 1..30 run particle minecraft:dust{{color:[0.1,0.0,0.15],scale:3.5}} ^2 ^ ^ 0.1 0.1 0.1 0 2 force
execute if score @s um.t matches 1..30 run particle minecraft:dust{{color:[0.5,0.1,0.7],scale:2.5}} ^-2 ^ ^ 0.1 0.1 0.1 0 2 force
execute if score @s um.t matches 1..30 run particle minecraft:reverse_portal ~ ~ ~ 2 2 2 0.4 20 force
execute if score @s um.t matches 10..30 run {sphere((0.08, 0.0, 0.12), 4.0, 0.6, 10)}
execute if score @s um.t matches 10 run playsound minecraft:block.respawn_anchor.charge master @a ~ ~ ~ 2 0.5
execute if score @s um.t matches 20 run playsound minecraft:block.respawn_anchor.charge master @a ~ ~ ~ 2 0.7
execute if score @s um.t matches 31 run playsound minecraft:entity.warden.sonic_boom master @a ~ ~ ~ 2 0.5
execute if score @s um.t matches 31..40 run {rep('execute if score @s um.t matches 31..40 run ', beam("biju"))}
execute if score @s um.t matches 34 run particle minecraft:explosion_emitter {CX} 114 {CZ} 2 2 2 0 4 force
execute if score @s um.t matches 34 run playsound minecraft:entity.generic.explode master @a {CX} 112 {CZ} 3 0.5
execute if score @s um.t matches 34 run playsound minecraft:entity.dragon_fireball.explode master @a {CX} 112 {CZ} 2 0.6
execute if score @s um.t matches 34 run effect give @a[{IN_PIT}] minecraft:levitation 1 10 true
execute if score @s um.t matches 34 run {rep('execute if score @s um.t matches 34 run ', carve_all(6))}
execute if score @s um.t matches 42.. run kill @s
""",
        "murasaki": f"""
execute if score @s um.t matches 1 run playsound minecraft:entity.illusioner.cast_spell master @a ~ ~ ~ 2 0.6
execute if score @s um.t matches 1..12 run {sphere((1.0, 0.1, 0.1), 2.5, 0.3, 6, "~-4 ~ ~")}
execute if score @s um.t matches 1..12 run {sphere((0.1, 0.3, 1.0), 2.5, 0.3, 6, "~4 ~ ~")}
execute if score @s um.t matches 13..22 run {sphere((1.0, 0.1, 0.1), 2.5, 0.3, 6, "~-1.5 ~ ~")}
execute if score @s um.t matches 13..22 run {sphere((0.1, 0.3, 1.0), 2.5, 0.3, 6, "~1.5 ~ ~")}
execute if score @s um.t matches 13 run playsound minecraft:block.beacon.power_select master @a ~ ~ ~ 2 0.5
execute if score @s um.t matches 23 run playsound minecraft:block.end_portal.spawn master @a ~ ~ ~ 1.5 1.5
execute if score @s um.t matches 23..34 run {sphere((0.65, 0.15, 0.95), 4.0, 0.9, 20)}
execute if score @s um.t matches 23..34 run particle minecraft:dust_color_transition{{from_color:[1.0,0.1,0.2],to_color:[0.2,0.3,1.0],scale:2}} ~ ~ ~ 1 1 1 0 10 force
execute if score @s um.t matches 35 run playsound minecraft:entity.warden.sonic_boom master @a {CX} 112 {CZ} 2 0.6
execute if score @s um.t matches 35 run playsound minecraft:entity.generic.explode master @a {CX} 112 {CZ} 2 0.6
execute if score @s um.t matches 35..45 run {sphere((0.65, 0.15, 0.95), 4.0, 1.4, 60, f"{CX} 113 {CZ}").replace(" 1.4 1.4 1.4 ", " 1.6 8 1.6 ")}
execute if score @s um.t matches 37 run particle minecraft:explosion_emitter {CX} 112 {CZ} 1 4 1 0 4 force
execute if score @s um.t matches 37 run {rep('execute if score @s um.t matches 37 run ', carve_all(8))}
execute if score @s um.t matches 47.. run kill @s
""",
        "fukuma": f"""
execute if score @s um.t matches 1 run playsound minecraft:entity.elder_guardian.curse master @a {CX} 118 {CZ} 1.5 0.5
execute if score @s um.t matches 1 run playsound minecraft:block.end_portal.spawn master @a {CX} 118 {CZ} 1 0.6
execute if score @s um.t matches 1 run effect give {PL} minecraft:darkness 4 0 true
execute if score @s um.t matches 1..60 run particle minecraft:dust{{color:[0.6,0.0,0.0],scale:3.0}} {CX} 122 {CZ} 9 4 9 0 25 force
execute if score @s um.t matches 1..60 run particle minecraft:sweep_attack {CX} 116 {CZ} 3 4 3 0 4 force
execute if score @s um.t matches 1..60 run particle minecraft:crit {CX} 116 {CZ} 3 4 3 0.4 10 force
execute if score @s um.t matches 8..56 run scoreboard players operation #m um.tmp = @s um.t
execute if score @s um.t matches 8..56 run scoreboard players operation #m um.tmp %= #4 um.st
execute if score @s um.t matches 8..56 if score #m um.tmp matches 0 run function {FN}/fx/slash
execute if score @s um.t matches 64.. run kill @s
""",
        "muryokusho": f"""
execute if score @s um.t matches 1 run playsound minecraft:block.end_portal.spawn master @a {CX} 118 {CZ} 1.5 1.2
execute if score @s um.t matches 1 run playsound minecraft:entity.elder_guardian.curse master @a {CX} 118 {CZ} 1.5 1.4
execute if score @s um.t matches 1 as {PLA} run function {NS}:player/freeze
execute if score @s um.t matches 1..160 run particle minecraft:end_rod {CX} 124 {CZ} 10 6 10 0.02 30 force
execute if score @s um.t matches 1..160 run particle minecraft:dust{{color:[0.02,0.02,0.08],scale:4.0}} {CX} 124 {CZ} 10 6 10 0 20 force
execute if score @s um.t matches 1..160 as {PLA} at @s run particle minecraft:enchant ~ ~1.5 ~ 0.6 0.6 0.6 1 15 force
execute if score @s um.t matches 20 run {rep('execute if score @s um.t matches 20 run ', carve_all(4))}
execute if score @s um.t matches 20 run playsound minecraft:entity.warden.sonic_boom master @a {CX} 112 {CZ} 1 1.6
execute if score @s um.t matches 162.. run kill @s
""",
        "genkidama": f"""
execute if score @s um.t matches 1 run playsound minecraft:block.beacon.activate master @a ~ ~ ~ 3 0.6
execute if score @s um.t matches 1..40 run particle minecraft:end_rod ~ ~ ~ 12 6 12 0.05 20 force
execute if score @s um.t matches 1..80 run {sphere((0.75, 0.95, 1.0), 4.0, 2.5, 30)}
execute if score @s um.t matches 1..80 run {sphere((1.0, 1.0, 1.0), 3.0, 1.5, 15)}
execute if score @s um.t matches 20 run playsound minecraft:block.beacon.power_select master @a ~ ~ ~ 3 0.5
execute if score @s um.t matches 40 run playsound minecraft:block.conduit.activate master @a ~ ~ ~ 3 0.6
execute if score @s um.t matches 41..80 run tp @s ~ ~-0.6 ~
execute if score @s um.t matches 82 run particle minecraft:explosion_emitter {CX} 112 {CZ} 2 5 2 0 8 force
execute if score @s um.t matches 82 run particle minecraft:flash{{color:[0.8,0.95,1.0,1.0]}} {CX} 112 {CZ} 0 0 0 0 1 force
execute if score @s um.t matches 82 run playsound minecraft:entity.generic.explode master @a {CX} 112 {CZ} 3 0.4
execute if score @s um.t matches 82 run playsound minecraft:entity.warden.sonic_boom master @a {CX} 112 {CZ} 3 0.5
execute if score @s um.t matches 82 run {rep('execute if score @s um.t matches 82 run ', carve_all(12))}
execute if score @s um.t matches 82 positioned {CX} 121 {CZ} run function {NS}:fx/firework
execute if score @s um.t matches 84.. run kill @s
""",
    }

    # ---------------------------------------------------------------- pit helpers
    def surface_fn():
        # #surf = the highest y in the pit that is at least half full, so a lone pillar doesn't soak up a move
        # (moves always clear from the top of the pit down to there, pillar included).
        # Falls back to the highest y with any block, and Y0 - 1 when the pit is empty.
        half = (X1 - X0 + 1) * (Z1 - Z0 + 1) // 2 + 1
        lines = []
        for y in range(Y1, Y0 - 1, -1):
            lines.append(f"execute unless blocks {X0} {y} {Z0} {X1} {y} {Z1} {AIR_REF} all store result score #c um.tmp run clone {X0} {y} {Z0} {X1} {y} {Z1} {SCRATCH} masked")
            lines.append(f"execute unless blocks {X0} {y} {Z0} {X1} {y} {Z1} {AIR_REF} all run fill {X0} 60 {Z0} {X1} 60 {Z1} minecraft:air")
            lines.append(f"execute unless blocks {X0} {y} {Z0} {X1} {y} {Z1} {AIR_REF} all if score #c um.tmp matches {half}.. run return run scoreboard players set #surf um.tmp {y}")
        lines.append(f"scoreboard players set #surf um.tmp {Y0 - 1}")
        for y in range(Y1, Y0 - 1, -1):
            lines.append(f"execute unless blocks {X0} {y} {Z0} {X1} {y} {Z1} {AIR_REF} all run return run scoreboard players set #surf um.tmp {y}")
        return "\n".join(lines) + "\n"

    def carve_lo():
        # #lo = lowest y removed: the top #depth layers from the surface
        return "\n".join([
            f"function {FN}/surface",
            f"execute if score #surf um.tmp matches ..{Y0 - 1} run return 0",
            "scoreboard players operation #lo um.tmp = #surf um.tmp",
            "scoreboard players operation #lo um.tmp -= #depth um.tmp",
            "scoreboard players add #lo um.tmp 1",
            f"execute if score #lo um.tmp matches ..{Y0 - 1} run scoreboard players set #lo um.tmp {Y0}",
            f"execute store result storage {NS}:arg lo int 1 run scoreboard players get #lo um.tmp",
        ])

    def build_arena():
        L = []
        L.append(f"execute unless loaded {ox - 10} 120 {oz - 10} run return run schedule function {FN}/build 20t")
        L.append(f"execute unless loaded {ox + 14} 120 {oz + 14} run return run schedule function {FN}/build 20t")
        L.append(f"fill {ox - 10} 98 {oz - 10} {ox + 14} 120 {oz + 14} minecraft:air")
        L.append(f"fill {ox - 10} 121 {oz - 10} {ox + 14} 145 {oz + 14} minecraft:air")
        # pit: glass walls, bedrock floor, glowing base under it
        L.append(f"fill {X0 - 1} {Y0 - 2} {Z0 - 1} {X1 + 1} {Y0 - 2} {Z1 + 1} minecraft:sea_lantern")
        L.append(f"fill {X0 - 1} {Y0 - 1} {Z0 - 1} {X1 + 1} {Y1} {Z1 + 1} minecraft:glass")
        L.append(f"fill {X0} {Y0 - 1} {Z0} {X1} {Y0 - 1} {Z1} minecraft:bedrock")
        L.append(f"fill {PIT} minecraft:air")
        # depth marks on the glass every quarter (25 %, 50 %, 75 %)
        for k in (1, 2, 3):
            y = Y0 + F.depth * k // 4 - 1
            L.append(f"fill {X0 - 1} {y} {Z0 - 1} {X1 + 1} {y} {Z1 + 1} minecraft:yellow_stained_glass replace minecraft:glass")
        # platform around it with a gold rim
        L.append(f"fill {ox - 9} 120 {oz - 9} {ox + 13} 120 {oz + 13} minecraft:polished_blackstone_bricks")
        L.append(f"fill {X0 - 1} 120 {Z0 - 1} {X1 + 1} 120 {Z1 + 1} minecraft:gold_block")
        L.append(f"fill {X0} 120 {Z0} {X1} 120 {Z1} minecraft:air")
        L.append(f"fill {ox - 9} 120 {oz - 9} {ox + 13} 120 {oz - 9} minecraft:crying_obsidian")
        L.append(f"fill {ox - 9} 120 {oz + 13} {ox + 13} 120 {oz + 13} minecraft:crying_obsidian")
        L.append(f"fill {ox - 9} 120 {oz - 9} {ox - 9} 120 {oz + 13} minecraft:crying_obsidian")
        L.append(f"fill {ox + 13} 120 {oz - 9} {ox + 13} 120 {oz + 13} minecraft:crying_obsidian")
        # invisible walls so nobody falls into the void
        for a in ((-10, -10, 14, -10), (-10, 14, 14, 14), (-10, -10, -10, 14), (14, -10, 14, 14)):
            L.append(f"fill {ox + a[0]} 121 {oz + a[1]} {ox + a[2]} 145 {oz + a[3]} minecraft:barrier")
        # corner pillars and the four casting pedestals
        for x, z in ((-8, -8), (12, -8), (-8, 12), (12, 12)):
            L.append(f"fill {ox + x} 121 {oz + z} {ox + x} 127 {oz + z} minecraft:quartz_pillar")
            L.append(f"setblock {ox + x} 128 {oz + z} minecraft:sea_lantern")
        for x, _, z in CASTERS:
            L.append(f"setblock {x} 121 {z} minecraft:chiseled_quartz_block")
            L.append(f"setblock {x} 122 {z} minecraft:soul_lantern")
        # lanterns along the edge, in the field's colour
        for k in range(-7, 13, 4):
            for x, z in ((k, -9), (k, 13), (-9, k), (13, k)):
                L.append(f"setblock {ox + x} 121 {oz + z} minecraft:lantern")
        L.append(f"fill {ox - 9} 119 {oz - 9} {ox + 13} 119 {oz - 9} minecraft:{F.wool}_wool")
        # floating title and rules
        L.append(f"execute positioned {CX} 128 {CZ} run kill @e[type=text_display,tag=um.deco,distance=..30]")
        L.append(f"summon minecraft:text_display {CX} 133 {CZ} {{Tags:[\"um.deco\"],billboard:\"center\",background:1073741824,"
                 f"transformation:{{left_rotation:[0f,0f,0f,1f],right_rotation:[0f,0f,0f,1f],translation:[0f,0f,0f],scale:[4f,4f,4f]}},"
                 f"text:[{j(txt('アニメ技の埋め立て', 'gold', True))},{{text:\"\\n\"}},{j(txt(f'{F.label}（{F.pname} {F.size}）', F.color, True))}]}}")
        L.append(f"summon minecraft:text_display {CX} 122.5 {oz - 8.4} {{Tags:[\"um.deco\"],billboard:\"fixed\",Rotation:[0f,0f],background:1426063360,line_width:260,"
                 f"transformation:{{left_rotation:[0f,0f,0f,1f],right_rotation:[0f,0f,0f,1f],translation:[0f,0f,0f],scale:[0.9f,0.9f,0.9f]}},"
                 f"text:[{j(txt('ルール', 'gold', True))},{{text:\"\\n\"}},"
                 f"{j(txt(f'穴（{TOTAL}ブロック）を下から埋めて100%にしたらクリア。ブロックは自動で補充されます。', 'white'))},{{text:\"\\n\"}},"
                 f"{j(txt('ギフトでアニメの技が飛んできて、埋めたブロックが崩されます。いいね・シェアは助けてくれます。', 'yellow'))},{{text:\"\\n\"}},"
                 f"{j(txt('待機所へ戻る: /trigger leave', 'gray'))}]}}")
        L.append(f"scoreboard players set #built {ST} {LAYOUT}")
        L.append(f'tellraw @a[scores={{um.fld={n}}}] {j(txt(f"[埋め立て] {F.label}の会場を作りました", "gray"))}')
        return "\n".join(L) + "\n"

    def act(aid):
        label, target, needs_game = ACTION_META[aid]
        lines = [
            f'$tellraw {PL} [{{"text":"[LIVE] ","color":"light_purple","bold":true}},{{"text":"$(name)","color":"yellow"}},'
            '{"text":" さんの $(gift)！ → ","color":"white"},{"text":"' + label + '","color":"gold","bold":true}]',
            f'$title {PL} actionbar [{{"text":"$(name)","color":"yellow"}},' + '{"text":" → ' + label + '","color":"gold"}]',
            f'$data modify storage {LIVE}:cur label set value {{text:"$(name)",color:"yellow",bold:true}}',
            f'$data modify storage {LIVE}:cur mobname set value {{text:"$(name)の影分身",color:"gold",bold:true}}',
        ]
        if aid not in ("senzu", "ouen", "firework"):
            lines.append(f"$scoreboard players add $(rname) um.rank{n} 1")
        if needs_game:
            lines.append(f"execute unless score #state {ST} matches 1 positioned {CX} 121 {CZ} run return run function {NS}:fx/firework")
        lines.append("tag @a remove al.target")
        if target == "server":
            lines.append(f"execute positioned {CX} 124 {CZ} run function {LIVE}:avatar/pop")
            lines.append(f"execute positioned {CX} 121 {CZ} run function {LV}/do/{aid}")
        else:
            sel = F.RND if target == "random" else PLA
            lines.append(f"tag {sel} add al.target")
            lines.append(f"execute at @a[tag=al.target] run function {LIVE}:avatar/pop")
            # nobody in the field: still show the move over the pit
            lines.append(f"execute unless entity @a[tag=al.target] positioned {CX} 121 {CZ} run function {LIVE}:avatar/pop")
            lines.append(f"execute unless entity @a[tag=al.target] positioned {CX} 121 {CZ} run return run function {LV}/do/{aid}")
            lines.append(f"execute as @a[tag=al.target] at @s run function {LV}/do/{aid}")
        return "\n".join(lines) + "\n"

    # time as storage umetate:time {m, s, pad} from #min/#s of this field
    time_to_storage = f"""
execute store result storage {NS}:time m int 1 run scoreboard players get #min {ST}
execute store result storage {NS}:time s int 1 run scoreboard players get #s {ST}
execute store result storage {NS}:time t int 1 run scoreboard players get #ticks {ST}
data modify storage {NS}:time pad set value ""
execute if score #s {ST} matches ..9 run data modify storage {NS}:time pad set value "0"
data modify storage {NS}:time f set value {n}
"""
    time_json = (f'{{score:{{name:"#min",objective:"{ST}"}},color:"yellow"}},{j(txt("分", "white"))},'
                 f'{{score:{{name:"#s",objective:"{ST}"}},color:"yellow"}},{j(txt("秒", "white"))}')
    same_preset = [g for g in FS if g.preset == F.preset and g.n != n]

    # ---------------------------------------------------------------- files
    f(f"{FN}/build", build_arena())
    f(f"{FN}/tick", f"""
execute as {PLA} unless entity @s[{BOX}] run tp @s {SPAWN}
execute as @e[type=marker,tag=um.fx,tag={TAG}] at @s run function {FN}/fx/tick
execute if score #state {ST} matches 1 if entity {PLA} run scoreboard players add #ticks {ST} 1
execute if score #state {ST} matches 2..3 run function {FN}/countdown
""")
    f(f"{FN}/slow", f"""
fill {X0} 120 {Z0} {X1} 140 {Z1} minecraft:air replace #{NS}:fillable
function {FN}/count
execute as {PLA} run function {NS}:player/refill
execute if score #state {ST} matches 1 if score #filled {ST} >= #total {ST} run function {FN}/win
execute if score #state {ST} matches 0 if entity {PLA} run function {FN}/start
execute if entity {PL} run scoreboard players set #empty {ST} 0
execute unless entity {PL} run scoreboard players add #empty {ST} 1
execute if score #empty {ST} matches 60 run function {FN}/idle
function {FN}/status
""")
    f(f"{FN}/count", f"""
execute store result score #filled {ST} run clone {PIT} {SCRATCH} masked
fill {X0} 60 {Z0} {X1} {60 + Y1 - Y0} {Z1} minecraft:air
scoreboard players operation #pct {ST} = #filled {ST}
scoreboard players operation #pct {ST} *= #100 um.st
scoreboard players operation #pct {ST} /= #total {ST}
execute store result bossbar {NS}:f{n} value run scoreboard players get #filled {ST}
scoreboard players operation #sec {ST} = #ticks {ST}
scoreboard players operation #sec {ST} /= #20 um.st
scoreboard players operation #min {ST} = #sec {ST}
scoreboard players operation #min {ST} /= #60 um.st
scoreboard players operation #s {ST} = #sec {ST}
scoreboard players operation #s {ST} %= #60 um.st
bossbar set {NS}:f{n} name [{j(txt(f"{F.label} ", F.color, True))},{j(txt("埋め立て ", "white", True))},{{score:{{name:"#pct",objective:"{ST}"}},color:"yellow",bold:true}},{j(txt("%", "yellow", True))},{j(txt("   ⏱ ", "gray"))},{{score:{{name:"#min",objective:"{ST}"}},color:"white"}},{j(txt("分", "gray"))},{{score:{{name:"#s",objective:"{ST}"}},color:"white"}},{j(txt("秒", "gray"))}]
bossbar set {NS}:f{n} players {PL}
""")
    # hub sign / chat menu / panel report
    f(f"{FN}/status", f"""
execute store result score #np {ST} if entity {PLA}
data modify storage {NS}:arg col set value "green"
data modify storage {NS}:arg stxt set value "空き"
execute if score #np {ST} matches 1.. run data modify storage {NS}:arg stxt set value "待機中"
execute if score #state {ST} matches 3 run data modify storage {NS}:arg stxt set value "カウントダウン"
execute if score #state {ST} matches 1 run data modify storage {NS}:arg stxt set value "プレイ中"
execute if score #state {ST} matches 2 run data modify storage {NS}:arg stxt set value "クリア！"
execute if score #state {ST} matches 4 run data modify storage {NS}:arg stxt set value "一時停止"
execute if score #np {ST} matches 1.. run data modify storage {NS}:arg col set value "yellow"
execute if score #state {ST} matches 2 run data modify storage {NS}:arg col set value "gold"
execute if score #state {ST} matches 4 run data modify storage {NS}:arg col set value "gray"
data modify storage {NS}:arg vs set value ""
execute if score #vs {ST} matches 1.. run data modify storage {NS}:arg vs set value "・対戦中"
execute if score #reserved {ST} matches 1 run data modify storage {NS}:arg vs set value "・配信者用"
execute if score #vs {ST} matches 1.. run data modify storage {NS}:arg col set value "red"
execute store result storage {NS}:arg pct int 1 run scoreboard players get #pct {ST}
execute store result storage {NS}:arg np int 1 run scoreboard players get #np {ST}
execute store result storage {NS}:arg m int 1 run scoreboard players get #min {ST}
execute store result storage {NS}:arg s int 1 run scoreboard players get #s {ST}
data modify storage {NS}:arg pad set value ""
execute if score #s {ST} matches ..9 run data modify storage {NS}:arg pad set value "0"
data modify storage {NS}:arg best set value "まだなし"
scoreboard players operation #bs um.tmp = #best {ST}
scoreboard players operation #bs um.tmp /= #20 um.st
scoreboard players operation #bm um.tmp = #bs um.tmp
scoreboard players operation #bm um.tmp /= #60 um.st
scoreboard players operation #bs um.tmp %= #60 um.st
execute store result storage {NS}:arg bm int 1 run scoreboard players get #bm um.tmp
execute store result storage {NS}:arg bs int 1 run scoreboard players get #bs um.tmp
data modify storage {NS}:arg bpad set value ""
execute if score #bs um.tmp matches ..9 run data modify storage {NS}:arg bpad set value "0"
execute if score #best {ST} matches 1.. run function {NS}:hub/best_m with storage {NS}:arg
function {FN}/status_m with storage {NS}:arg
execute store result storage {NS}:report f{n}.state int 1 run scoreboard players get #state {ST}
execute store result storage {NS}:report f{n}.pct int 1 run scoreboard players get #pct {ST}
execute store result storage {NS}:report f{n}.filled int 1 run scoreboard players get #filled {ST}
execute store result storage {NS}:report f{n}.total int 1 run scoreboard players get #total {ST}
execute store result storage {NS}:report f{n}.ticks int 1 run scoreboard players get #ticks {ST}
execute store result storage {NS}:report f{n}.best int 1 run scoreboard players get #best {ST}
execute store result storage {NS}:report f{n}.np int 1 run scoreboard players get #np {ST}
execute store result storage {NS}:report f{n}.vs int 1 run scoreboard players get #vs {ST}
""")
    f(f"{FN}/status_m", f"""
$data modify storage {NS}:status f{n} set value [{{text:"$(stxt)$(vs)",color:"$(col)",bold:true}},{{text:"  $(pct)%  ⏱$(m):$(pad)$(s)  $(np)人  最速 $(best)",color:"gray"}}]
$data modify entity @e[type=text_display,tag=um.klbl.f{n},limit=1] text set value [{j(txt(F.label, F.color, True))},"\\n",{j(txt(f"{F.pname} {F.size}（{TOTAL}個）", "white"))},"\\n",{{text:"$(stxt)$(vs)",color:"$(col)",bold:true}},"\\n",{{text:"$(pct)%  ⏱$(m):$(pad)$(s)  $(np)人",color:"white"}},"\\n",{{text:"最速 $(best)",color:"gray"}},"\\n",{j(txt("右クリックで参加", "green"))}]
""")
    f(f"{FN}/surface", surface_fn())
    f(f"{FN}/carve/all", carve_lo() + f"\nfunction {FN}/carve/all_m with storage {NS}:arg\n")
    f(f"{FN}/carve/all_m", f"""
$fill {X0} $(lo) {Z0} {X1} {Y1} {Z1} minecraft:air replace #{NS}:fillable
$particle minecraft:block{{block_state:"minecraft:lime_concrete"}} {CX} $(lo) {CZ} 2 1.5 2 0 160 force
$particle minecraft:explosion {CX} $(lo) {CZ} 2 1 2 0 6 force
$playsound minecraft:block.stone.break master @a {CX} $(lo) {CZ} 1.5 0.7
""")
    f(f"{FN}/carve/col", carve_lo() + f"""
execute store result storage {NS}:arg r int 1 run scoreboard players get #r um.tmp
function {FN}/carve/col_m with storage {NS}:arg
""")
    # clamp the column to this pit (a player standing on the rim must not dig the glass)
    f(f"{FN}/carve/col_m", f"""
$fill ~-$(r) $(lo) ~-$(r) ~$(r) {Y1} ~$(r) minecraft:air replace #{NS}:fillable
$particle minecraft:block{{block_state:"minecraft:white_concrete"}} ~ $(lo) ~ 1 1.5 1 0 80 force
$playsound minecraft:block.stone.break master @a ~ $(lo) ~ 1.5 0.7
""")
    # support: fill every hole up to surface + #add (and lift anyone who would end up inside blocks)
    f(f"{FN}/support", f"""
function {FN}/surface
scoreboard players operation #top um.tmp = #surf um.tmp
scoreboard players operation #top um.tmp += #add um.tmp
execute if score #top um.tmp matches {Y1 + 1}.. run scoreboard players set #top um.tmp {Y1}
execute store result storage {NS}:arg top int 1 run scoreboard players get #top um.tmp
scoreboard players add #top um.tmp 1
execute store result storage {NS}:arg top1 int 1 run scoreboard players get #top um.tmp
function {FN}/support_m with storage {NS}:arg
""")
    f(f"{FN}/support_m", f"""
$fill {X0} {Y0} {Z0} {X1} $(top) {Z1} {FILL_BLOCK} replace minecraft:air
$execute as @a[{IN_PIT}] at @s if entity @s[y=0,dy=$(top)] run tp @s ~ $(top1) ~
$particle minecraft:happy_villager {CX} $(top) {CZ} 2 0.5 2 0 60 force
$particle minecraft:totem_of_undying {CX} $(top) {CZ} 2 1 2 0.3 60 force
playsound minecraft:entity.player.levelup master @a {CX} 115 {CZ} 1 1.4
playsound minecraft:item.totem.use master @a {CX} 115 {CZ} 0.6 1.6
""")
    f(f"{FN}/start", f"""
scoreboard players set #state {ST} 3
scoreboard players set #cd {ST} 70
scoreboard players set #ticks {ST} 0
scoreboard players set #empty {ST} 0
{KILL_LOCAL}
fill {X0} {Y0} {Z0} {X1} 140 {Z1} minecraft:air
tp {PLA} {PX} {Y0} {PZ}
execute as {PL} run function {NS}:player/unfreeze
{title("埋め立て開始", "gold", f"{F.label}：穴を{TOTAL}ブロックで埋めきろう！", "yellow")}
execute if score #vs {ST} matches 1.. run title {PL} subtitle {j(txt("対戦！ 先に100%にしたほうの勝ち", "red"))}
playsound minecraft:block.bell.use master @a {CX} 110 {CZ} 2 0.8
""")
    f(f"{FN}/countdown", f"""
scoreboard players remove #cd {ST} 1
execute if score #state {ST} matches 3 if score #cd {ST} matches 60 run title {PL} title {j(txt("3", "yellow", True))}
execute if score #state {ST} matches 3 if score #cd {ST} matches 40 run title {PL} title {j(txt("2", "yellow", True))}
execute if score #state {ST} matches 3 if score #cd {ST} matches 20 run title {PL} title {j(txt("1", "yellow", True))}
execute if score #state {ST} matches 3 if score #cd {ST} matches 60 run playsound minecraft:block.note_block.pling master @a {CX} 110 {CZ} 2 1
execute if score #state {ST} matches 3 if score #cd {ST} matches 40 run playsound minecraft:block.note_block.pling master @a {CX} 110 {CZ} 2 1
execute if score #state {ST} matches 3 if score #cd {ST} matches 20 run playsound minecraft:block.note_block.pling master @a {CX} 110 {CZ} 2 1
execute if score #state {ST} matches 3 if score #cd {ST} matches ..0 run title {PL} title {j(txt("スタート！", "green", True))}
execute if score #state {ST} matches 3 if score #cd {ST} matches ..0 run playsound minecraft:block.note_block.pling master @a {CX} 110 {CZ} 2 2
execute if score #state {ST} matches 3 if score #cd {ST} matches ..0 run return run scoreboard players set #state {ST} 1
scoreboard players operation #m um.tmp = #cd {ST}
scoreboard players operation #m um.tmp %= #20 um.st
execute if score #state {ST} matches 2 if score #m um.tmp matches 0 positioned {CX} 121 {CZ} run function {NS}:fx/firework
execute if score #state {ST} matches 2 if score #cd {ST} matches ..0 run scoreboard players set #state {ST} 0
""")
    pbest = f"#best{F.preset}"
    f(f"{FN}/win", f"""
scoreboard players set #state {ST} 2
scoreboard players set #cd {ST} 300
kill @e[tag=um.mob,tag={TAG}]
kill @e[type=marker,tag=um.fx,tag={TAG}]
execute as {PL} run function {NS}:player/unfreeze
title {PL} times 10 80 20
title {PL} title {j(txt("埋め立て完了！", "gold", True))}
title {PL} subtitle [{j(txt("タイム ", "white"))},{time_json}]
execute if score #best {ST} matches 1.. if score #ticks {ST} < #best {ST} run tellraw {PL} {j(txt(f"[埋め立て] {F.label}の新記録！", "gold", True))}
execute unless score #best {ST} matches 1.. run scoreboard players operation #best {ST} = #ticks {ST}
execute if score #ticks {ST} < #best {ST} run scoreboard players operation #best {ST} = #ticks {ST}
execute if score {pbest} um.st matches 1.. if score #ticks {ST} < {pbest} um.st run tellraw @a [{j(txt(f"[埋め立て] {F.pname}の最速記録更新！ ", "gold", True))},{{selector:"{PLA}"}},{j(txt(" ", "white"))},{time_json}]
execute unless score {pbest} um.st matches 1.. run scoreboard players operation {pbest} um.st = #ticks {ST}
execute if score #ticks {ST} < {pbest} um.st run scoreboard players operation {pbest} um.st = #ticks {ST}
tellraw {PL} [{j(txt(f"[埋め立て] {F.label} クリア！ ", "gold", True))},{time_json},{j(txt("。15秒後に次のラウンドが始まります（待機所へは /trigger leave）。", "white"))}]
{time_to_storage}
execute as {PLA} run function {NS}:lb/record{F.preset}
execute if score #vs {ST} matches 1.. run function {FN}/vs_win
playsound minecraft:ui.toast.challenge_complete master @a {CX} 115 {CZ} 2 1
playsound minecraft:entity.player.levelup master @a {CX} 115 {CZ} 2 1
""")
    # ---------------------------------------------------------------- versus
    f(f"{FN}/vs_win", "\n".join([
        f"scoreboard players add {PLA} um.vswin 1",
        f"tellraw @a [{j(txt('[対戦] ', 'red', True))},{{selector:\"{PLA}\"}},{j(txt(f' の勝ち！（{F.label}・', 'gold', True))},{time_json},{j(txt('）', 'gold', True))}]",
        f"execute as {PLA} run function {NS}:lb/vslog",
    ] + [f"execute if score #vs {ST} matches {g.n} run function {g.FN}/vs_lose" for g in same_preset] + [
        f"scoreboard players set #vs {ST} 0",
        f"title {PL} subtitle {j(txt('対戦に勝った！', 'gold', True))}",
    ]) + "\n")
    f(f"{FN}/vs_lose", f"""
scoreboard players set #vs {ST} 0
scoreboard players set #state {ST} 2
scoreboard players set #cd {ST} 300
kill @e[tag=um.mob,tag={TAG}]
kill @e[type=marker,tag=um.fx,tag={TAG}]
execute as {PL} run function {NS}:player/unfreeze
title {PL} times 10 80 20
title {PL} title {j(txt("負け…", "gray", True))}
title {PL} subtitle {j(txt("相手が先に埋めきった", "white"))}
playsound minecraft:entity.villager.no master @a {CX} 115 {CZ} 2 0.8
""")
    # someone left a versus field that is now empty: the other side wins by default and keeps playing solo
    f(f"{FN}/vs_forfeit", "\n".join(
        [f"tellraw @a [{j(txt('[対戦] ', 'red', True))},{j(txt(f'{F.label}のプレイヤーが抜けたので、相手の不戦勝です', 'white'))}]"]
        + [f"execute if score #vs {ST} matches {g.n} run function {g.FN}/vs_bye" for g in same_preset]
        + [f"scoreboard players set #vs {ST} 0"]) + "\n")
    f(f"{FN}/vs_bye", f"""
scoreboard players set #vs {ST} 0
scoreboard players add {PLA} um.vswin 1
title {PL} title {j(txt("不戦勝！", "gold", True))}
title {PL} subtitle {j(txt("このまま続けて記録をねらおう", "white"))}
""")
    # free for a versus match: nobody there, not reserved for a streamer, not in a match
    f(f"{FN}/free", f"""
execute if entity {PL} run return 0
execute if score #vs {ST} matches 1.. run return 0
execute if score #reserved {ST} matches 1 run return 0
return 1
""")
    # ---------------------------------------------------------------- players coming and going
    f(f"{FN}/enter", f"""
scoreboard players set @s um.fld {n}
tag @s remove um.vq1
tag @s remove um.vq2
tag @s remove um.vqw
team join {TAG} @s
clear @s
function {NS}:player/unfreeze
scoreboard players set #empty {ST} 0
execute if score #state {ST} matches 1 run tp @s {PX} {Y1 + 1} {PZ}
execute if score #state {ST} matches 3 run tp @s {PX} {Y0} {PZ}
execute unless score #state {ST} matches 1 unless score #state {ST} matches 3 run tp @s {SPAWN}
function {NS}:player/refill
bossbar set {NS}:f{n} players {PL}
tellraw @s [{j(txt(f"[埋め立て] {F.label}（{F.pname} {F.size}）", F.color, True))},{j(txt(f" 穴（{TOTAL}ブロック）を下から埋めきったらクリア！ ブロックは自動で補充されます。", "white"))}]
tellraw @s [{j(txt("待機所へ戻る: ", "gray"))},{click("[待機所へ]", "aqua", "/trigger leave", "フィールドを選び直す")},{j(txt("  ロビーへ: /trigger lobby", "gray"))}]
""")
    # picked from the menu / a sign
    f(f"{FN}/pick", f"""
execute if score @s um.fld matches {n} run return run tellraw @s {j(txt(f"すでに{F.label}にいます", "gray"))}
execute if score #vs {ST} matches 1.. run return run tellraw @s {j(txt(f"{F.label}は対戦中なので入れません。ほかのフィールドを選んでください", "red"))}
function {NS}:player/leave_field
function {FN}/enter
""")
    # @s is leaving this field (to the hub or another field, or by logging out)
    f(f"{FN}/left", f"""
tag @s add um.leaving
execute if score #vs {ST} matches 1.. unless entity @a[scores={{um.fld={n}}},tag=!um.leaving] run function {FN}/vs_forfeit
tag @s remove um.leaving
team leave @s
""")
    # nobody here for 30 s: back to an empty pit
    f(f"{FN}/idle", f"""
execute if score #vs {ST} matches 1.. run function {FN}/vs_forfeit
scoreboard players set #state {ST} 0
scoreboard players set #ticks {ST} 0
{KILL_LOCAL}
fill {X0} {Y0} {Z0} {X1} 140 {Z1} minecraft:air
""")
    f(f"{FN}/rank_reset", f"scoreboard players reset * um.rank{n}")
    f(f"{FN}/stop", f"""
scoreboard players set #state {ST} 4
kill @e[tag=um.mob,tag={TAG}]
kill @e[type=marker,tag=um.fx,tag={TAG}]
execute as {PL} run function {NS}:player/unfreeze
tellraw {PL} {j(txt(f"[埋め立て] {F.label}を一時停止しました（パネルの「新しいラウンド」で再開）", "gray"))}
""")
    f(f"{FN}/load", f"""
scoreboard objectives add {ST} dummy
scoreboard objectives add um.rank{n} dummy [{j(txt("妨害ランキング ", "light_purple", True))},{j(txt(F.label, F.color, True))}]
scoreboard objectives setdisplay sidebar.team.{F.color} um.rank{n}
scoreboard players set #total {ST} {TOTAL}
execute unless score #state {ST} matches 0.. run scoreboard players set #state {ST} 0
execute unless score #vs {ST} matches 0.. run scoreboard players set #vs {ST} 0
execute unless score #reserved {ST} matches 0.. run scoreboard players set #reserved {ST} 0
team add {TAG} {j(txt(F.label, F.color))}
team modify {TAG} color {F.color}
team modify {TAG} prefix {j(txt(f"[{n}] ", F.color))}
team modify {TAG} collisionRule never
team modify {TAG} friendlyFire false
bossbar add {NS}:f{n} {j(txt(F.label, F.color))}
bossbar set {NS}:f{n} max {TOTAL}
bossbar set {NS}:f{n} color green
bossbar set {NS}:f{n} style notched_10
forceload add {ox - 16} {oz - 16} {ox + 31} {oz + 31}
execute unless score #built {ST} matches {LAYOUT} run schedule function {FN}/build 40t
""")
    # ---------------------------------------------------------------- fx
    f(f"{FN}/fx/tick", "\n".join(
        f"execute if entity @s[tag=um.m.{m}] run return run function {FN}/fx/{m}" for m in FX) + "\nkill @s\n")
    for m, body in FX.items():
        f(f"{FN}/fx/{m}", body)
    caster_lines = ["execute store result score #r um.tmp run random value 1..4"]
    for i, (x, y, z) in enumerate(CASTERS, 1):
        caster_lines.append(f"execute if score #r um.tmp matches {i} run summon minecraft:marker {x + 0.5} {y} {z + 0.5} {{Tags:[\"um.spot\"]}}")
    f(f"{FN}/fx/caster_spot", "\n".join(caster_lines))
    f(f"{FN}/fx/black_flame", f"""
$particle minecraft:dust{{color:[0.05,0.0,0.06],scale:3.0}} {CX} $(y).8 {CZ} 2 0.5 2 0 25 force
$particle minecraft:soul_fire_flame {CX} $(y).8 {CZ} 2 0.4 2 0.02 6 force
$particle minecraft:large_smoke {CX} $(y).8 {CZ} 2 0.4 2 0.02 6 force
""")
    # one slash of the shrine: a random column from the surface down 3..8 blocks
    f(f"{FN}/fx/slash", f"""
execute store result storage {NS}:arg x int 1 run random value {X0}..{X1}
execute store result storage {NS}:arg z int 1 run random value {Z0}..{Z1}
execute store result score #depth um.tmp run random value 3..8
function {FN}/surface
execute if score #surf um.tmp matches ..{Y0 - 1} run return 0
scoreboard players operation #lo um.tmp = #surf um.tmp
scoreboard players operation #lo um.tmp -= #depth um.tmp
execute if score #lo um.tmp matches ..{Y0 - 1} run scoreboard players set #lo um.tmp {Y0}
execute store result storage {NS}:arg lo int 1 run scoreboard players get #lo um.tmp
function {FN}/fx/slash_m with storage {NS}:arg
""")
    f(f"{FN}/fx/slash_m", f"""
$fill $(x) $(lo) $(z) $(x) {Y1} $(z) minecraft:air replace #{NS}:fillable
$particle minecraft:sweep_attack $(x).5 {Y1} $(z).5 0.3 3 0.3 0 6 force
$particle minecraft:dust{{color:[0.8,0.0,0.0],scale:2.0}} $(x).5 {Y1} $(z).5 0.2 4 0.2 0 30 force
$playsound minecraft:entity.player.attack.sweep master @a $(x) {Y1} $(z) 1.2 0.6
""")
    # ---------------------------------------------------------------- anime_live side of this field
    f(f"{LV}/clear", f"{KILL_LOCAL}\nexecute as {PL} run function {NS}:player/unfreeze")
    mob_tail = f"\nexecute as @e[tag=al.new] run function {LIVE}:mob/decorate\n"
    for aid in ACTION_META:
        body = DO[aid]
        f(f"{LV}/do/{aid}", body.strip() + "\n" + (mob_tail if "al.new" in body else ""))
        f(f"{LV}/act/{aid}", act(aid))


# ------------------------------------------------------------------ the waiting area (hub)
KIOSKS = ([(f"f{F.n}", F.wool) for F in FS] + [(f"vs{p}", "red") for p in PRESETS] + [("rec", "white")])


def kiosk_x(i):
    return HX + int((i - (len(KIOSKS) - 1) / 2) * 5)


def build_hub():
    L = []
    L.append(f"execute unless loaded {HX - 24} 120 {HZ - 13} run return run schedule function {NS}:hub/build 20t")
    L.append(f"execute unless loaded {HX + 24} 120 {HZ + 15} run return run schedule function {NS}:hub/build 20t")
    L.append(f"fill {HX - 25} 108 {HZ - 14} {HX + 25} 150 {HZ + 16} minecraft:air")
    L.append(f"fill {HX - 24} 120 {HZ - 13} {HX + 24} 120 {HZ + 15} minecraft:smooth_quartz")
    L.append(f"fill {HX - 24} 120 {HZ - 13} {HX + 24} 120 {HZ - 13} minecraft:crying_obsidian")
    L.append(f"fill {HX - 24} 120 {HZ + 15} {HX + 24} 120 {HZ + 15} minecraft:crying_obsidian")
    L.append(f"fill {HX - 24} 120 {HZ - 13} {HX - 24} 120 {HZ + 15} minecraft:crying_obsidian")
    L.append(f"fill {HX + 24} 120 {HZ - 13} {HX + 24} 120 {HZ + 15} minecraft:crying_obsidian")
    L.append(f"fill {HX - 2} 120 {HZ - 9} {HX + 2} 120 {HZ - 6} minecraft:gold_block")
    for a in ((-25, -14, 25, -14), (-25, 16, 25, 16), (-25, -14, -25, 16), (25, -14, 25, 16)):
        L.append(f"fill {HX + a[0]} 121 {HZ + a[1]} {HX + a[2]} 150 {HZ + a[3]} minecraft:barrier")
    for k in range(-22, 23, 6):
        for z in (-13, 15):
            L.append(f"setblock {HX + k} 121 {HZ + z} minecraft:lantern")
    # a barrel under the floor: player names are read from a player head made there
    L.append(f"setblock {LOOT_BOX} minecraft:barrel")
    L.append(f"kill @e[tag=um.hubdeco]")
    for i, (kid, wool) in enumerate(KIOSKS):
        x = kiosk_x(i)
        z = HZ + 5
        L.append(f"fill {x - 1} 120 {z - 1} {x + 1} 120 {z + 1} minecraft:{wool}_wool")
        L.append(f"setblock {x} 121 {z} minecraft:{'beacon' if kid.startswith('f') else 'lodestone' if kid.startswith('vs') else 'bookshelf'}")
        L.append(f"summon minecraft:interaction {x + 0.5} 121 {z + 0.5} {{Tags:[\"um.hubdeco\",\"um.kiosk\",\"um.k.{kid}\"],width:1.8f,height:2.6f,response:1b}}")
        L.append(f"summon minecraft:text_display {x + 0.5} 123.9 {z + 0.5} {{Tags:[\"um.hubdeco\",\"um.klbl.{kid}\"],billboard:\"center\",background:1426063360,line_width:150,"
                 f"transformation:{{left_rotation:[0f,0f,0f,1f],right_rotation:[0f,0f,0f,1f],translation:[0f,0f,0f],scale:[0.8f,0.8f,0.8f]}},text:{{text:\"…\"}}}}")
    L.append(f"summon minecraft:text_display {HX + 0.5} 131 {HZ + 12} {{Tags:[\"um.hubdeco\"],billboard:\"center\",background:1073741824,"
             f"transformation:{{left_rotation:[0f,0f,0f,1f],right_rotation:[0f,0f,0f,1f],translation:[0f,0f,0f],scale:[4f,4f,4f]}},"
             f"text:[{j(txt('アニメ技の埋め立て', 'gold', True))},{{text:\"\\n\"}},{j(txt('待機所：遊ぶフィールドを選ぼう', 'aqua'))}]}}")
    L.append(f"summon minecraft:text_display {HX + 0.5} 127.6 {HZ + 12} {{Tags:[\"um.hubdeco\"],billboard:\"center\",background:1426063360,line_width:400,"
             f"transformation:{{left_rotation:[0f,0f,0f,1f],right_rotation:[0f,0f,0f,1f],translation:[0f,0f,0f],scale:[1.2f,1.2f,1.2f]}},"
             f"text:[{j(txt('看板を右クリック、またはチャットのメニュー（/trigger menu）で参加', 'white'))},{{text:\"\\n\"}},"
             f"{j(txt('対戦：同じ種類の2人がそろうと2つのフィールドで同時スタート。先に100%で勝ち', 'red'))},{{text:\"\\n\"}},"
             f"{j(txt('右のサイドバーは最速ランキング。フィールドから戻る: /trigger leave', 'gray'))}]}}")
    L.append(f"setworldspawn {HX} 121 {HZ - 8}")
    L.append(f"scoreboard players set #hubbuilt um.st {LAYOUT}")
    L.append(f"function {NS}:hub/signs")
    L.append('tellraw @a {"text":"[埋め立て] 待機所を作りました","color":"gray"}')
    return "\n".join(L) + "\n"


def build(path):
    files = {}

    def f(name, text):
        ns, rest = name.split(":", 1)
        files[f"data/{ns}/function/{rest}.mcfunction"] = text.strip() + "\n"

    files["pack.mcmeta"] = json.dumps({"pack": {
        "description": [{"text": "アニメ技の埋め立て × TikTok LIVE", "color": "gold"}],
        "min_format": list(DATA_FORMAT), "max_format": [DATA_FORMAT[0], 999]}}, ensure_ascii=False, indent=2)
    files["data/minecraft/tags/function/load.json"] = j({"values": [f"{NS}:load", f"{LIVE}:load"]})
    files["data/minecraft/tags/function/tick.json"] = j({"values": [f"{NS}:tick", f"{LIVE}:tick"]})
    fillable = [f"minecraft:{c}_concrete" for c in COLORS] + [f"minecraft:{c}_concrete_powder" for c in COLORS] + [FILL_BLOCK]
    files[f"data/{NS}/tags/block/fillable.json"] = j({"values": sorted(set(fillable))})
    files[f"data/{NS}/tags/block/placeable.json"] = j({"values": [f"#{NS}:fillable", "minecraft:bedrock", "minecraft:glass", "minecraft:yellow_stained_glass"]})

    for F in FS:
        field_files(F, f)

    def dispatch(score, fn, fields=FS, prefix="execute if score"):
        return "\n".join(f"{prefix} {score} matches {F.n} run return run function {F.FN}/{fn}" for F in fields)

    # ---------------------------------------------------------------- game (global)
    f(f"{NS}:load", "\n".join([
        "scoreboard objectives add um.st dummy",
        "scoreboard objectives add um.tmp dummy",
        "scoreboard objectives add um.t dummy",
        "scoreboard objectives add um.frz dummy",
        "scoreboard objectives add um.leave minecraft.custom:minecraft.leave_game",
        "scoreboard objectives add um.fld dummy",
        "scoreboard objectives add um.home dummy",
        "scoreboard objectives add um.vswin dummy",
        f"scoreboard objectives add menu trigger {j(txt('メニュー'))}",
        f"scoreboard objectives add field trigger {j(txt('フィールドを選ぶ'))}",
        f"scoreboard objectives add leave trigger {j(txt('待機所へ戻る'))}",
        f"scoreboard objectives add versus trigger {j(txt('対戦'))}",
        f"scoreboard objectives add records trigger {j(txt('記録'))}",
    ] + [f"scoreboard objectives add um.lb{p} dummy [{j(txt('最速ランキング ', 'gold', True))},{j(txt(P['name'] + ' ' + str(P['w']) + '×' + str(P['w']) + '×' + str(P['depth']), 'yellow', True))}]"
         for p, P in PRESETS.items()] + [
        f"scoreboard objectives setdisplay sidebar um.lb{min(PRESETS)}",
        "scoreboard players set #100 um.st 100",
        "scoreboard players set #60 um.st 60",
        "scoreboard players set #20 um.st 20",
        "scoreboard players set #4 um.st 4",
        "scoreboard players set #-1 um.st -1",
        # the single-pit version's boss bar would otherwise stay on everyone's screen
        f"bossbar remove {NS}:progress",
        "gamerule fall_damage false",
        "gamerule keep_inventory true",
        "gamerule advance_time false",
        "gamerule advance_weather false",
        "gamerule spawn_mobs false",
        "gamerule spawn_monsters false",
        "gamerule immediate_respawn true",
        "gamerule show_advancement_messages false",
        "gamerule show_death_messages false",
        "gamerule mob_griefing false",
        "gamerule mob_drops false",
        "gamerule block_drops false",
        "gamerule respawn_radius 0",
        "gamerule max_command_sequence_length 1000000",
        "gamerule max_block_modifications 1000000",
        "time set 14000",
        "weather clear",
        f"forceload add {HX - 32} {HZ - 16} {HX + 32} {HZ + 31}",
        f"execute unless data storage {NS}:lb vslog run data modify storage {NS}:lb vslog set value []",
    ] + [f"execute unless data storage {NS}:lb p{p} run data modify storage {NS}:lb p{p} set value []" for p in PRESETS]
      + [f"function {F.FN}/load" for F in FS] + [
        f"execute unless score #hubbuilt um.st matches {LAYOUT} run schedule function {NS}:hub/build 40t",
    ]))
    f(f"{NS}:hub/build", build_hub())
    # rebuild everything (panel button "all")
    f(f"{NS}:build", f"function {NS}:hub/build\n" + "\n".join(f"function {F.FN}/build" for F in FS))
    trig = ["menu", "field", "leave", "versus", "records"]
    f(f"{NS}:tick", "\n".join([
        f"execute as @a[tag=!um.seen] run function {NS}:player/join",
        f"execute as @a[scores={{um.leave=1..}}] run function {NS}:player/join",
    ] + [f"scoreboard players enable @a {t}" for t in trig] + [
        f"execute as @a[scores={{{t}=1..}}] run function {NS}:menu/t_{t}" for t in trig] + [
        f"execute as @a[scores={{um.fld=0}},gamemode=adventure] unless entity @s[{HUB_BOX}] run tp @s {HUB_SPAWN}",
        f"execute as @a[scores={{um.frz=1..}}] run function {NS}:player/freeze_tick",
        "scoreboard players add @e[type=marker,tag=um.fx] um.t 1",
    ] + [f"function {F.FN}/tick" for F in FS] + [
        "scoreboard players add #clock um.st 1",
        f"execute if score #clock um.st matches 10.. run function {NS}:slow",
    ]))
    f(f"{NS}:slow", "\n".join([
        "scoreboard players set #clock um.st 0",
        "effect give @a minecraft:night_vision infinite 0 true",
        "effect give @a minecraft:resistance infinite 4 true",
        "effect give @a minecraft:saturation infinite 0 true",
    ] + [f"function {F.FN}/slow" for F in FS] + [f"function {NS}:hub/slow"]))
    # ---------------------------------------------------------------- hub: versus matching, sign texts, sidebar rotation
    f(f"{NS}:hub/slow", "\n".join(
        [f"execute store result score #nq um.tmp if entity @a[tag=um.vq{p}]\nexecute if score #nq um.tmp matches 2.. run function {NS}:vs/try{p}" for p in PRESETS]
        + [f"function {NS}:hub/signs",
           "scoreboard players add #hubclock um.st 1",
           "execute if score #hubclock um.st matches 20.. run function umetate:hub/rotate"]))
    rot = ["scoreboard players set #hubclock um.st 0", "scoreboard players add #lbshow um.st 1",
           f"execute if score #lbshow um.st matches {max(PRESETS) + 1}.. run scoreboard players set #lbshow um.st {min(PRESETS)}"]
    rot += [f"execute if score #lbshow um.st matches {p} run scoreboard objectives setdisplay sidebar um.lb{p}" for p in PRESETS]
    f(f"{NS}:hub/rotate", "\n".join(rot))
    signs = []
    for p, P in PRESETS.items():
        signs.append(f"execute store result storage {NS}:arg q int 1 if entity @a[tag=um.vq{p}]")
        signs.append(f"function {NS}:hub/vs_sign{p} with storage {NS}:arg")
        f(f"{NS}:hub/vs_sign{p}", f"$data modify entity @e[type=text_display,tag=um.klbl.vs{p},limit=1] text set value "
          f"[{j(txt('対戦', 'red', True))},\"\\n\",{j(txt(P['name'] + ' ' + str(P['w']) + '×' + str(P['w']) + '×' + str(P['depth']), 'white'))},\"\\n\","
          f"{j(txt('2人そろうと同時スタート', 'gray'))},\"\\n\",{{text:\"待っている人: $(q)人\",color:\"yellow\"}},\"\\n\",{j(txt('右クリックで受付', 'green'))}]")
    signs.append(f"data modify entity @e[type=text_display,tag=um.klbl.rec,limit=1] text set value "
                 f"[{j(txt('記録', 'gold', True))},\"\\n\",{j(txt('最速タイムと自己ベスト', 'white'))},\"\\n\",{j(txt('右クリックで表示', 'green'))}]")
    f(f"{NS}:hub/signs", "\n".join(signs))
    f(f"{NS}:hub/best_m", '$data modify storage umetate:arg best set value "$(bm):$(bpad)$(bs)"')
    # ---------------------------------------------------------------- menu (triggers) and kiosks
    menu = [f"tellraw @s {j(txt('===== アニメ技の埋め立て：フィールドを選ぶ =====', 'gold', True))}"]
    for F in FS:
        menu.append(f"tellraw @s [{click('[参加]', 'green', f'/trigger field set {F.n}', f'{F.label}に入る')},"
                    f"{j(txt(f' {F.label} ', F.color, True))},{j(txt(f'{F.pname} {F.size}  ', 'gray'))},"
                    f"{{nbt:\"f{F.n}\",storage:\"{NS}:status\",interpret:true}}]")
    menu.append("tellraw @s [" + ",".join(
        [click(f"[対戦 {P['name']}]", "red", f"/trigger versus set {p}", f"{P['name']}のフィールドで2人同時スタート。先に100%で勝ち") + ',{"text":" "}' for p, P in PRESETS.items()]
        + [click("[記録]", "gold", "/trigger records", "最速タイムと自己ベスト"), '{"text":" "}',
           click("[待機所へ]", "aqua", "/trigger leave", "待機所へ戻る")]) + "]")
    f(f"{NS}:menu/show", "\n".join(menu))
    f(f"{NS}:menu/t_menu", f"scoreboard players set @s menu 0\nfunction {NS}:menu/show")
    f(f"{NS}:menu/t_field", "\n".join([
        "execute store result score #v um.tmp run scoreboard players get @s field",
        "scoreboard players set @s field 0",
        dispatch("#v um.tmp", "pick"),
        f"tellraw @s {j(txt('そのフィールドはありません', 'red'))}",
        f"function {NS}:menu/show"]))
    f(f"{NS}:menu/t_leave", "\n".join([
        "scoreboard players set @s leave 0",
        f"execute if score @s um.fld matches 0 run tag @s remove um.vqw",
        f"execute if score @s um.fld matches 0 if entity @s[tag=um.vq1] run return run function {NS}:vs/cancel",
        f"execute if score @s um.fld matches 0 if entity @s[tag=um.vq2] run return run function {NS}:vs/cancel",
        f"execute if score @s um.fld matches 0 run return run function {NS}:menu/show",
        f"function {NS}:player/to_hub"]))
    f(f"{NS}:menu/t_versus", "\n".join([
        "execute store result score #v um.tmp run scoreboard players get @s versus",
        "scoreboard players set @s versus 0",
    ] + [f"execute if score #v um.tmp matches {p} run return run function {NS}:vs/queue{p}" for p in PRESETS] + [
        f"function {NS}:vs/cancel"]))
    f(f"{NS}:menu/t_records", f"scoreboard players set @s records 0\nfunction {NS}:menu/records")
    rec = [f"tellraw @s {j(txt('===== 記録 =====', 'gold', True))}"]
    for p, P in PRESETS.items():
        rec += [
            f"scoreboard players operation #s um.tmp = #best{p} um.st",
            "scoreboard players operation #s um.tmp /= #20 um.st",
            "scoreboard players operation #m um.tmp = #s um.tmp",
            "scoreboard players operation #m um.tmp /= #60 um.st",
            "scoreboard players operation #s um.tmp %= #60 um.st",
            f"execute if score #best{p} um.st matches 1.. run tellraw @s [{j(txt(P['name'] + ' 最速: ', 'yellow', True))},{{score:{{name:\"#m\",objective:\"um.tmp\"}}}},{j(txt('分'))},{{score:{{name:\"#s\",objective:\"um.tmp\"}}}},{j(txt('秒'))}]",
            f"execute unless score #best{p} um.st matches 1.. run tellraw @s {j(txt(P['name'] + ' 最速: まだなし', 'yellow', True))}",
            f"scoreboard players operation #s um.tmp = @s um.lb{p}",
            "scoreboard players operation #s um.tmp *= #-1 um.st",
            "scoreboard players operation #s um.tmp /= #20 um.st",
            "scoreboard players operation #m um.tmp = #s um.tmp",
            "scoreboard players operation #m um.tmp /= #60 um.st",
            "scoreboard players operation #s um.tmp %= #60 um.st",
            f"execute if score @s um.lb{p} matches ..-1 run tellraw @s [{j(txt('  あなたの自己ベスト: ', 'white'))},{{score:{{name:\"#m\",objective:\"um.tmp\"}}}},{j(txt('分'))},{{score:{{name:\"#s\",objective:\"um.tmp\"}}}},{j(txt('秒'))}]",
        ]
    rec.append("scoreboard players add @s um.vswin 0")
    rec.append(f"tellraw @s [{j(txt('対戦の勝ち数: ', 'red'))},{{score:{{name:\"@s\",objective:\"um.vswin\"}}}}]")
    rec.append(f"tellraw @s {j(txt('待機所のサイドバーに最速ランキングが出ます（10秒ごとに切り替え）', 'gray'))}")
    f(f"{NS}:menu/records", "\n".join(rec))
    # right-clicking a sign (interaction entity): one advancement for any interaction; the clicked sign is the
    # nearest kiosk that has fresh "interaction" data (it is removed after use)
    files[f"data/{NS}/advancement/kiosk.json"] = j({
        "criteria": {"click": {"trigger": "minecraft:player_interacted_with_entity"}},
        "rewards": {"function": f"{NS}:kiosk/click"}})
    kl = [f"advancement revoke @s only {NS}:kiosk",
          "tag @e[tag=um.kpick] remove um.kpick",
          "tag @e[type=interaction,tag=um.kiosk,distance=..8,sort=nearest,limit=1,nbt={interaction:{}}] add um.kpick",
          "data remove entity @e[type=interaction,tag=um.kpick,limit=1] interaction"]
    for kid, _ in KIOSKS:
        if kid.startswith("f"):
            action = f"function {NS}:{kid}/pick"
        elif kid.startswith("vs"):
            action = f"function {NS}:vs/queue{kid[2:]}"
        else:
            action = f"function {NS}:menu/records"
        kl.append(f"execute if entity @e[type=interaction,tag=um.kpick,tag=um.k.{kid}] run {action}")
    kl.append("tag @e[tag=um.kpick] remove um.kpick")
    f(f"{NS}:kiosk/click", "\n".join(kl))
    # ---------------------------------------------------------------- versus
    for p, P in PRESETS.items():
        pf = [F for F in FS if F.preset == p]
        others = [q for q in PRESETS if q != p]
        pname = P["name"]
        f(f"{NS}:vs/queue{p}", "\n".join([
            f"execute if entity @s[tag=um.vq{p}] run return run tellraw @s {j(txt('もう受付しています。相手を待っています…', 'gray'))}",
            f"execute unless score @s um.fld matches 0 run function {NS}:player/to_hub",
        ] + [f"tag @s remove um.vq{q}" for q in others] + [
            f"tag @s add um.vq{p}",
            f"tellraw @s [{j(txt(f'[対戦] {pname}の対戦を受付しました。相手を待っています… ', 'red', True))},{click('[取り消す]', 'gray', '/trigger leave', '受付をやめる')}]",
            f"tellraw @a[tag=!um.vq{p}] [{j(txt('[対戦] ', 'red', True))},{{selector:\"@s\"}},{j(txt(f' が{pname}で対戦相手を募集中！ ', 'white'))},{click('[受けて立つ]', 'red', f'/trigger versus set {p}', '対戦に参加')}]",
        ]))
        # two players waiting: find two free fields of this preset and start both at the same moment
        lines = ["scoreboard players set #a um.tmp 0", "scoreboard players set #b um.tmp 0"]
        for F in pf:
            lines.append(f"execute if score #a um.tmp matches 0 if function {F.FN}/free run scoreboard players set #a um.tmp {F.n}")
        for F in pf:
            lines.append(f"execute if score #b um.tmp matches 0 unless score #a um.tmp matches {F.n} if function {F.FN}/free run scoreboard players set #b um.tmp {F.n}")
        lines += [
            f"execute if score #b um.tmp matches 0 run tellraw @a[tag=um.vq{p},tag=!um.vqw] {j(txt('[対戦] 空いているフィールドが2つそろうまで待っています…', 'gray'))}",
            f"execute if score #b um.tmp matches 0 run return run tag @a[tag=um.vq{p}] add um.vqw",
            f"tag @a[tag=um.vq{p},limit=1,sort=arbitrary] add um.vsA",
            f"tag @a[tag=um.vq{p},tag=!um.vsA,limit=1,sort=arbitrary] add um.vsB",
        ]
        for F in pf:
            lines.append(f"execute if score #a um.tmp matches {F.n} as @a[tag=um.vsA] run function {F.FN}/enter")
            lines.append(f"execute if score #b um.tmp matches {F.n} as @a[tag=um.vsB] run function {F.FN}/enter")
            lines.append(f"execute if score #a um.tmp matches {F.n} run scoreboard players operation #vs {F.ST} = #b um.tmp")
            lines.append(f"execute if score #b um.tmp matches {F.n} run scoreboard players operation #vs {F.ST} = #a um.tmp")
        for F in pf:
            lines.append(f"execute if score #a um.tmp matches {F.n} run function {F.FN}/start")
            lines.append(f"execute if score #b um.tmp matches {F.n} run function {F.FN}/start")
        lines += [
            f"tellraw @a [{j(txt('[対戦] ', 'red', True))},{{selector:\"@a[tag=um.vsA]\"}},{j(txt(' vs ', 'gold', True))},{{selector:\"@a[tag=um.vsB]\"}},"
            f"{j(txt(' スタート！ 先に100%にしたほうの勝ち（', 'white'))},{{score:{{name:\"#a\",objective:\"um.tmp\"}},color:\"aqua\"}},{j(txt(' 対 ', 'white'))},{{score:{{name:\"#b\",objective:\"um.tmp\"}},color:\"aqua\"}},{j(txt(' 番フィールド）', 'white'))}]",
            "tag @a remove um.vsA",
            "tag @a remove um.vsB",
        ]
        f(f"{NS}:vs/try{p}", "\n".join(lines))
    f(f"{NS}:vs/cancel", "\n".join([f"tag @s remove um.vq{p}" for p in PRESETS] + ["tag @s remove um.vqw",
                                    f"tellraw @s {j(txt('[対戦] 受付を取り消しました', 'gray'))}", f"function {NS}:menu/show"]))
    # ---------------------------------------------------------------- records (per preset leaderboard)
    for p in PRESETS:
        f(f"{NS}:lb/record{p}", f"""
execute store result score #neg um.tmp run data get storage {NS}:time t
scoreboard players operation #neg um.tmp *= #-1 um.st
execute if score @s um.lb{p} matches ..-1 if score @s um.lb{p} >= #neg um.tmp run return 0
scoreboard players operation @s um.lb{p} = #neg um.tmp
function {NS}:lb/fmt{p} with storage {NS}:time
tellraw @s {j(txt("[埋め立て] 自己ベスト更新！", "aqua", True))}
function {NS}:lb/name
function {NS}:lb/save{p} with storage {NS}:time
""")
        f(f"{NS}:lb/fmt{p}", f'$scoreboard players display numberformat @s um.lb{p} fixed {{text:"$(m):$(pad)$(s)",color:"yellow"}}')
        f(f"{NS}:lb/save{p}", f"""
$data remove storage {NS}:lb p{p}[{{name:"$(name)"}}]
$data modify storage {NS}:lb p{p} append value {{name:"$(name)",t:$(t),f:$(f)}}
""")
    # @s's name into storage umetate:time name (a player head made in a barrel under the hub carries it)
    f(f"{NS}:lb/name", f"""
data modify storage {NS}:time name set value "?"
loot replace block {LOOT_BOX} container.0 loot {{pools:[{{rolls:1,entries:[{{type:"minecraft:item",name:"minecraft:player_head",functions:[{{function:"minecraft:fill_player_head",entity:"this"}}]}}]}}]}}
data modify storage {NS}:time name set from block {LOOT_BOX} Items[0].components."minecraft:profile".name
""")
    f(f"{NS}:lb/vslog", f"""
function {NS}:lb/name
function {NS}:lb/vslog_m with storage {NS}:time
execute if data storage {NS}:lb vslog[30] run data remove storage {NS}:lb vslog[0]
""")
    f(f"{NS}:lb/vslog_m", f'$data modify storage {NS}:lb vslog append value {{name:"$(name)",t:$(t),f:$(f)}}')
    # ---------------------------------------------------------------- players
    f(f"{NS}:player/join", "\n".join([
        "tag @s add um.seen",
        "scoreboard players reset @s um.leave",
        "gamemode adventure @s",
        f"function {NS}:player/unfreeze",
    ] + [f"tag @s remove um.vq{p}" for p in PRESETS] + [
        "tag @s remove um.vqw",
        "execute unless score @s um.fld matches 0.. run scoreboard players set @s um.fld 0",
        # a streamer assigned to a field in the panel goes straight there
        dispatch("@s um.home", "enter"),
        # came back while their round is still running
        "\n".join(f"execute if score @s um.fld matches {F.n} if score #state {F.ST} matches 1 run return run function {F.FN}/enter\n"
                  f"execute if score @s um.fld matches {F.n} if score #state {F.ST} matches 3 run return run function {F.FN}/enter" for F in FS),
        f"function {NS}:player/to_hub",
    ]))
    f(f"{NS}:player/leave_field", dispatch("@s um.fld", "left").replace("return run ", ""))
    f(f"{NS}:player/to_hub", f"""
function {NS}:player/leave_field
scoreboard players set @s um.fld 0
team leave @s
clear @s
function {NS}:player/unfreeze
tp @s {HUB_SPAWN}
tellraw @s [{j(txt("[埋め立て] ", "gold", True))},{j(txt("待機所です。看板を右クリックするか、下のメニューで遊ぶフィールドを選んでください。", "white"))}]
function {NS}:menu/show
tellraw @s {j(txt("ロビーへ戻るには /trigger lobby", "gray"))}
""")
    f(f"{NS}:player/refill", give_blocks())
    f(f"{NS}:player/freeze", f"""
function {NS}:player/unfreeze
scoreboard players set @s um.frz 160
attribute @s minecraft:movement_speed modifier add {NS}:freeze -1 add_multiplied_total
attribute @s minecraft:jump_strength modifier add {NS}:freeze -1 add_multiplied_total
attribute @s minecraft:block_interaction_range modifier add {NS}:freeze -1 add_multiplied_total
effect give @s minecraft:darkness 9 0 true
""")
    f(f"{NS}:player/freeze_tick", f"""
scoreboard players remove @s um.frz 1
title @s actionbar {j(txt("無量空処：情報が流れ込んで動けない…", "aqua"))}
execute if score @s um.frz matches ..0 run function {NS}:player/unfreeze
""")
    f(f"{NS}:player/unfreeze", f"""
scoreboard players set @s um.frz 0
attribute @s minecraft:movement_speed modifier remove {NS}:freeze
attribute @s minecraft:jump_strength modifier remove {NS}:freeze
attribute @s minecraft:block_interaction_range modifier remove {NS}:freeze
""")
    # ---------------------------------------------------------------- shared fx
    for style, body in BEAM_FILES.items():
        f(f"{NS}:fx/beam/{style}", body)
    # the viewer's avatar floats at the new fx marker for 6 seconds
    f(f"{NS}:fx/new_avatar", f"""
execute at @e[type=marker,tag=um.new,limit=1] run function {LIVE}:avatar/pop_big
tag @e[tag=um.new] remove um.new
""")
    f(f"{NS}:fx/to_surface", "$tp @s ~ $(y).5 ~")
    fw = [firework_cmd("~3 ~ ~", "[I;16711680,16776960]", "large_ball"), firework_cmd("~-3 ~ ~", "[I;65535,16777215]", "star"),
          firework_cmd("~ ~ ~3", "[I;16744448,16711935]", "burst"), firework_cmd("~ ~ ~-3", "[I;65280,255]", "large_ball", 2)]
    f(f"{NS}:fx/firework", "\n".join(fw))
    # ---------------------------------------------------------------- old single-field names (field 1)
    F1 = FS[0]
    f(f"{NS}:start", f"function {F1.FN}/start")
    f(f"{NS}:stop", f"function {F1.FN}/stop")
    f(f"{NS}:rank_reset", f"function {F1.FN}/rank_reset")

    # ---------------------------------------------------------------- anime_live (called by the app)
    f(f"{LIVE}:load", "scoreboard objectives add al.age dummy")
    f(f"{LIVE}:ping", 'tellraw @a {"text":"[LIVE] TikTok 連携アプリと接続しました","color":"light_purple"}')
    f(f"{LIVE}:clear", "\n".join(f"function {F.LV}/clear" for F in FS))
    f(f"{LIVE}:avatar/pop", "\n".join([
        avatar_display(["al.av", "al.avpop", "al.avnew"], 3.1, 0.16),
        f"data modify entity @e[type=minecraft:text_display,tag=al.avnew,limit=1] text set from storage {LIVE}:av text",
        "tag @e[tag=al.avnew] remove al.avnew",
        avatar_display(["al.av", "al.avpop", "al.avnew"], 2.75, 1.0),
        f"data modify entity @e[type=minecraft:text_display,tag=al.avnew,limit=1] text set from storage {LIVE}:cur label",
        "tag @e[tag=al.avnew] remove al.avnew",
    ]))
    f(f"{LIVE}:avatar/pop_big", "\n".join([
        avatar_display(["al.av", "al.avpop", "al.avnew"], 1.2, 0.3),
        f"data modify entity @e[type=minecraft:text_display,tag=al.avnew,limit=1] text set from storage {LIVE}:av text",
        "tag @e[tag=al.avnew] remove al.avnew",
        avatar_display(["al.av", "al.avpop", "al.avnew"], 0.6, 1.6),
        f"data modify entity @e[type=minecraft:text_display,tag=al.avnew,limit=1] text set from storage {LIVE}:cur label",
        "tag @e[tag=al.avnew] remove al.avnew",
    ]))
    f(f"{LIVE}:mob/decorate", "\n".join([
        "tag @s remove al.new",
        f"data modify entity @s CustomName set from storage {LIVE}:cur mobname",
        "data modify entity @s CustomNameVisible set value 1b",
        "execute at @s run " + avatar_display(["al.av", "al.avmob", "al.avnew"], 0, 0.07, "0f,0.55f,0f"),
        f"data modify entity @e[type=minecraft:text_display,tag=al.avnew,limit=1] text set from storage {LIVE}:av text",
        "ride @e[type=minecraft:text_display,tag=al.avnew,limit=1] mount @s",
        "tag @e[tag=al.avnew] remove al.avnew",
    ]))
    # pop-ups last 6 s, clones 20 s
    f(f"{LIVE}:tick", "\n".join([
        "scoreboard players add @e[tag=al.avpop] al.age 1",
        "kill @e[tag=al.avpop,scores={al.age=120..}]",
        "scoreboard players add @e[tag=um.mob] al.age 1",
        "execute as @e[tag=um.mob,scores={al.age=400..}] at @s run particle minecraft:poof ~ ~1 ~ 0.3 0.6 0.3 0.02 20 force",
        "kill @e[tag=um.mob,scores={al.age=400..}]",
        "scoreboard players add #t al.age 1",
        f"execute if score #t al.age matches 10.. run function {LIVE}:avatar/cleanup",
    ]))
    f(f"{LIVE}:avatar/cleanup", "\n".join([
        "scoreboard players set #t al.age 0",
        "tag @e[tag=al.avmob] add al.orphan",
        "execute as @e[tag=um.mob] on passengers run tag @s remove al.orphan",
        "kill @e[tag=al.orphan]",
    ]))
    # old name = field 1
    for aid in ACTION_META:
        f(f"{LIVE}:act/{aid}", f'$function {FS[0].LV}/act/{aid} {{name:"$(name)",gift:"$(gift)",rname:"$(rname)"}}')

    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        for name, data in files.items():
            z.writestr(name, data.encode("utf-8"))
    # the app reads the labels and the fields from here
    with open(path.replace(".zip", ".actions.json"), "w", encoding="utf-8") as fh:
        json.dump({k: {"label": v[0], "target": v[1], "needsGame": v[2]} for k, v in ACTION_META.items()}, fh, ensure_ascii=False, indent=2)
    with open(path.replace(".zip", ".fields.json"), "w", encoding="utf-8") as fh:
        json.dump({"presets": {str(p): {"name": P["name"], "size": f"{P['w']}×{P['w']}×{P['depth']}", "total": P["w"] * P["w"] * P["depth"]} for p, P in PRESETS.items()},
                   "fields": [{"n": F.n, "preset": F.preset, "x": F.ox, "z": F.oz, "w": F.w, "presetName": F.pname, "size": F.size, "total": F.TOTAL, "color": F.color} for F in FS]},
                  fh, ensure_ascii=False, indent=2)
    print("ok:", path, len(ACTION_META), "actions,", len(FS), "fields,", len(files), "files")


if __name__ == "__main__":
    build(sys.argv[1] if len(sys.argv) > 1 else "anime_umetate_datapack.zip")
