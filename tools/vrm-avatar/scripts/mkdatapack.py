"""Datapack that dresses a player in the voxel avatar (item_display per body part, no mods).

usage: python mkdatapack.py vox/parts.json out_dir avatar_name
In game (op):  /execute as <player> run function vrmav:equip_<name>
               /execute as <player> run function vrmav:unequip
"""
import json, math, os, sys, zipfile

SRC, OUT, NAME = sys.argv[1], sys.argv[2], sys.argv[3]
NS = "vrmav"
parts = json.load(open(SRC))["parts"]
PACK_FORMAT = (107, 1)  # 26.2 (same as the Halloween map)
F = {}

def q_mul(a, b):
    ax, ay, az, aw = a; bx, by, bz, bw = b
    return (aw * bx + ax * bw + ay * bz - az * by,
            aw * by - ax * bz + ay * bw + az * bx,
            aw * bz + ax * by - ay * bx + az * bw,
            aw * bw - ax * bx - ay * by - az * bz)

def q_x(deg):
    h = math.radians(deg) / 2
    return (math.sin(h), 0.0, 0.0, math.cos(h))

FLIP = (0.0, 1.0, 0.0, 0.0)  # item_display renders items turned 180 deg; turn back so the face looks forward

def fl(v):
    return "[" + ",".join(f"{x:.5f}f" for x in v) + "]"

def local(part):
    x, y, z = parts[part]["pivot"]
    return x, z, -y  # ^left ^up ^forward

# --- load / tick
F["load"] = [
    f"scoreboard objectives add {NS}.id dummy",
    f"scoreboard objectives add {NS}.walk minecraft.custom:minecraft.walk_one_cm",
    f"scoreboard objectives add {NS}.sprint minecraft.custom:minecraft.sprint_one_cm",
    f"scoreboard objectives add {NS}.dist dummy",
    f"scoreboard objectives add {NS}.phase dummy",
    f"scoreboard objectives add {NS}.last dummy",
    f"scoreboard players add #next {NS}.id 0",
]
F["tick"] = [
    f"execute as @a[tag={NS}.on] at @s run function {NS}:follow",
]
# --- follow: move this player's parts, update walk phase
follow = [
    f"scoreboard players operation #cur {NS}.id = @s {NS}.id",
    # head pivots at the neck and also takes the pitch
    f"execute rotated ~ 0 positioned ^{local('head')[0]:.4f} ^{local('head')[1]:.4f} ^{local('head')[2]:.4f} rotated as @s as @e[type=item_display,tag={NS}.head] if score @s {NS}.id = #cur {NS}.id run tp @s ~ ~ ~ ~ ~",
]
follow.append(f"execute rotated ~ 0 as @e[type=item_display,tag={NS}.limb] if score @s {NS}.id = #cur {NS}.id run function {NS}:place")
F["place"] = []
for p in ("body", "arm_l", "arm_r", "leg_l", "leg_r"):
    lx, ly, lz = local(p)
    F["place"].append(f"tp @s[tag={NS}.{p}] ^{lx:.4f} ^{ly:.4f} ^{lz:.4f} ~ 0")
# walk cycle: distance walked (cm) -> phase 0..7, idle when not moving this tick
follow += [
    f"scoreboard players operation @s {NS}.walk += @s {NS}.sprint",
    f"scoreboard players set @s[scores={{{NS}.walk=0}}] {NS}.phase -1",
    f"scoreboard players operation @s[scores={{{NS}.walk=1..}}] {NS}.dist += @s {NS}.walk",
    f"execute if score @s {NS}.walk matches 1.. run scoreboard players operation @s {NS}.phase = @s {NS}.dist",
    f"execute if score @s {NS}.walk matches 1.. run scoreboard players operation @s {NS}.phase /= #20 {NS}.id",
    f"execute if score @s {NS}.walk matches 1.. run scoreboard players operation @s {NS}.phase %= #8 {NS}.id",
    f"scoreboard players set @s {NS}.walk 0",
    f"scoreboard players set @s {NS}.sprint 0",
    f"execute unless score @s {NS}.phase = @s {NS}.last run function {NS}:pose",
]
F["follow"] = follow
F["load"] += [f"scoreboard players set #20 {NS}.id 20", f"scoreboard players set #8 {NS}.id 8"]

# pose: apply limb rotations for the current phase (only when the phase changes)
SWING = {"arm_l": 1, "arm_r": -1, "leg_l": -1, "leg_r": 1}
AMP = {"arm": 28, "leg": 32}
pose = [f"scoreboard players operation @s {NS}.last = @s {NS}.phase"]
for ph in range(-1, 8):
    pose.append(f"execute if score @s {NS}.phase matches {ph} run function {NS}:pose/{ph if ph >= 0 else 'idle'}")
F["pose"] = pose
for ph in range(-1, 8):
    s = 0 if ph < 0 else math.sin(ph / 8 * 2 * math.pi)
    lines = []
    for p, sg in SWING.items():
        ang = AMP[p[:3]] * s * sg
        q = q_mul(q_x(ang), FLIP)
        lines.append(f"execute as @e[type=item_display,tag={NS}.{p}] if score @s {NS}.id = #cur {NS}.id run data merge entity @s "
                     f"{{start_interpolation:0,interpolation_duration:3,transformation:{{left_rotation:{fl(q)}}}}}")
    F[f"pose/{ph if ph >= 0 else 'idle'}"] = lines

# equip / unequip
eq = [
    f"execute unless score @s {NS}.id matches 1.. run scoreboard players add #next {NS}.id 1",
    f"execute unless score @s {NS}.id matches 1.. run scoreboard players operation @s {NS}.id = #next {NS}.id",
    f"function {NS}:unequip",
    f"scoreboard players operation #cur {NS}.id = @s {NS}.id",
]
for p in parts:
    tags = ",".join(f'"{t}"' for t in [f"{NS}.part", f"{NS}.{p}", f"{NS}.new"] + ([f"{NS}.limb"] if p != "head" else []))
    item = f'{{id:"minecraft:stick",count:1,components:{{"minecraft:item_model":"{NS}:{NAME}_{p}"}}}}'
    eq.append(
        f"summon item_display ~ ~ ~ {{item:{item},item_display:\"none\",teleport_duration:1,interpolation_duration:3,"
        f"view_range:1.5f,Tags:[{tags}],"
        f"transformation:{{left_rotation:{fl(FLIP)},right_rotation:[0f,0f,0f,1f],translation:[0f,0f,0f],scale:[1f,1f,1f]}}}}")
eq += [
    f"scoreboard players operation @e[type=item_display,tag={NS}.new] {NS}.id = @s {NS}.id",
    f"tag @e[type=item_display,tag={NS}.new] remove {NS}.new",
    "effect give @s minecraft:invisibility infinite 0 true",
    f"tag @s add {NS}.on",
    f"scoreboard players set @s {NS}.last -2",
    f"scoreboard players set @s {NS}.phase -1",
]
F[f"equip_{NAME}"] = eq
F["unequip"] = [
    f"scoreboard players operation #cur {NS}.id = @s {NS}.id",
    f"execute as @e[type=item_display,tag={NS}.part] if score @s {NS}.id = #cur {NS}.id run kill @s",
    f"execute if entity @s[tag={NS}.on] run effect clear @s minecraft:invisibility",
    f"tag @s remove {NS}.on",
]
# parts whose owner is offline: removed every second; owner gets them back on next tick via rejoin check
F["cleanup"] = [
    f"tag @e[type=item_display,tag={NS}.part] add {NS}.orphan",
    f"execute as @a[tag={NS}.on] run function {NS}:cleanup_owner",
    f"kill @e[type=item_display,tag={NS}.orphan]",
    f"schedule function {NS}:cleanup 20t",
]
F["cleanup_owner"] = [
    f"scoreboard players operation #cur {NS}.id = @s {NS}.id",
    f"execute as @e[type=item_display,tag={NS}.orphan] if score @s {NS}.id = #cur {NS}.id run tag @s remove {NS}.orphan",
]
F["load"].append(f"schedule function {NS}:cleanup 20t")
# re-dress players that rejoined (their parts were cleaned up)
F["tick"].insert(0, f"execute as @a[tag={NS}.on] unless function {NS}:has_parts run function {NS}:redress")
F["has_parts"] = [
    f"scoreboard players operation #cur {NS}.id = @s {NS}.id",
    f"execute as @e[type=item_display,tag={NS}.head] if score @s {NS}.id = #cur {NS}.id run return 1",
    "return fail",
]
F["redress"] = [f"execute at @s run function {NS}:equip_{NAME}"]

os.makedirs(OUT, exist_ok=True)
dp = os.path.join(OUT, f"{NAME}_datapack.zip")
with zipfile.ZipFile(dp, "w", zipfile.ZIP_DEFLATED) as z:
    z.writestr("pack.mcmeta", json.dumps({"pack": {"description": f"VRM avatar (no mods): {NAME}",
                                                    "min_format": list(PACK_FORMAT), "max_format": [PACK_FORMAT[0], 999]}}))
    z.writestr("data/minecraft/tags/function/load.json", json.dumps({"values": [f"{NS}:load"]}))
    z.writestr("data/minecraft/tags/function/tick.json", json.dumps({"values": [f"{NS}:tick"]}))
    for name, lines in F.items():
        z.writestr(f"data/{NS}/function/{name}.mcfunction", "\n".join(lines) + "\n")
print("wrote", dp, "functions:", len(F))
