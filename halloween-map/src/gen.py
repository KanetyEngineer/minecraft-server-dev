import json, os, shutil, sys, zipfile
from mapgen import build_all, P, G
import logic

OUT = sys.argv[1] if len(sys.argv) > 1 else "out"
NS = "halloween"
PACK_FORMAT = (107, 1)

b = build_all()

# hidden candies: validated against the voxel model (air at spot & above, solid below)
cand = [
    (0, 65, -4), (12, 64, -60), (-14, 71, -50), (12, 77, -50),
    (-70, 64, -11), (-79, 67, 0), (-26, 64, 42), (26, 64, 42), (-14, 64, 78), (-4, 64, 70),
    (-46, 64, 66), (10, 64, -79), (-95, 64, 95), (95, 64, 95), (14, 64, 3),
]
st = P["steps"][18]
cand.append((st[0], st[1] + 1, st[2]))
cand += [(x, 64, z) for (x, z) in P["maze_dead"][:4]]
NONSOLID = ("air", "cobweb", "carpet", "candle", "lantern", "pressure_plate", "skeleton_skull", "fence", "torch")
ok = []
for (x, y, z) in cand:
    at, above, below = b.get(x, y, z), b.get(x, y + 1, z), b.get(x, y - 1, z)
    if at == "air" and above in ("air",) and below != "air" and not any(n in below for n in NONSOLID):
        ok.append((x, y, z))
    else:
        print("hidden candy rejected", (x, y, z), at, above, below)
P["hidden"] = ok[:20]
print("hidden candies:", len(P["hidden"]))

stages = b.order
F = logic.build_logic(stages)
total = len(stages)
for i, s in enumerate(stages):
    cmds = list(b.stages[s])
    short = s.split("/")[-1]
    msg = json.dumps([{"text": "[建築] ", "color": "gold"}, {"text": f"{i+1}/{total} {short}", "color": "gray"}], ensure_ascii=False)
    cmds.append(f"tellraw @a {msg}")
    if i + 1 < total:
        cmds.append(f"schedule function {NS}:{stages[i+1]} 3t")
    else:
        cmds.append(f"function {NS}:build/done")
    F[s] = cmds
logic.fn("build/done", f"""
function {NS}:admin/reset_world
tp @a 0.5 64 12.5 180 0
tellraw @a {json.dumps([{'text': '[ハロウィン] ', 'color': 'gold'}, {'text': 'マップが完成しました！ /function halloween:admin/menu で管理メニュー', 'color': 'green', 'bold': True}], ensure_ascii=False)}
playsound minecraft:ui.toast.challenge_complete master @a 0 64 12 1 1
""")

# ---- write pack
root = os.path.join(OUT, "halloween_night")
if os.path.exists(root):
    shutil.rmtree(root)
os.makedirs(root)
mc = {"pack": {"description": [{"text": "ハロウィン・ナイト ", "color": "gold"}, {"text": "〜パンプキン王の呪い〜", "color": "light_purple"}],
               "min_format": list(PACK_FORMAT), "max_format": [PACK_FORMAT[0], 999]}}
json.dump(mc, open(os.path.join(root, "pack.mcmeta"), "w", encoding="utf-8"), ensure_ascii=False, indent=2)
for name, lines in F.items():
    p = os.path.join(root, "data", NS, "function", name + ".mcfunction")
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
for tag, fnm in (("load", "load"), ("tick", "tick")):
    p = os.path.join(root, "data", "minecraft", "tags", "function", tag + ".json")
    os.makedirs(os.path.dirname(p), exist_ok=True)
    json.dump({"values": [f"{NS}:{fnm}"]}, open(p, "w"), indent=2)

zp = os.path.join(OUT, "halloween_night_datapack.zip")
with zipfile.ZipFile(zp, "w", zipfile.ZIP_DEFLATED) as z:
    for dp, dn, fns in os.walk(root):
        for fnm in fns:
            full = os.path.join(dp, fnm)
            z.write(full, os.path.relpath(full, root))
print("functions:", len(F), "stages:", total)
for s in stages:
    print(f"  {s}: {len(b.stages[s])} cmds")
json.dump({k: v for k, v in P.items()}, open(os.path.join(OUT, "positions.json"), "w"), ensure_ascii=False, default=str)

# keep the builder for the preview renderer
import pickle
pickle.dump({"vox": b.vox, "palette": b.palette, "labels": b.labels}, open(os.path.join(OUT, "model.pkl"), "wb"))
