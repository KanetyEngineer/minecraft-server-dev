import json, sys, zipfile, os
SRC, ATLAS, OUTZIP, NAME = sys.argv[1:5]
NS = "vrmav"
d = json.load(open(SRC))
with zipfile.ZipFile(OUTZIP, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    z.writestr("pack.mcmeta", json.dumps({"pack": {"description": f"VRM avatar: {NAME}", "min_format": 65, "max_format": 999}}))
    z.write(ATLAS, f"assets/{NS}/textures/item/{NAME}_atlas.png")
    for part, m in d["models"].items():
        z.writestr(f"assets/{NS}/models/item/{NAME}_{part}.json", json.dumps(m, separators=(",", ":")))
        z.writestr(f"assets/{NS}/items/{NAME}_{part}.json",
                   json.dumps({"model": {"type": "minecraft:model", "model": f"{NS}:item/{NAME}_{part}"}}))
print(OUTZIP, os.path.getsize(OUTZIP) // 1024, "KB; models json", sum(len(json.dumps(m, separators=(',', ':'))) for m in d["models"].values()) // 1024, "KB")
