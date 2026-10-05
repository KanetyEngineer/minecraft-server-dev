"""Write app/src/weapons.json (gun id -> label, ammo, magazine) from the Point Blank jar."""
import glob, json, os, zipfile
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
jar = glob.glob(os.path.join(ROOT, "server", "mods", "pointblank-*.jar"))[0]
z = zipfile.ZipFile(jar)
ja = json.loads(z.read("assets/pointblank/lang/ja_jp.json"))
en = json.loads(z.read("assets/pointblank/lang/en_us.json"))
out = {}
for n in sorted(z.namelist()):
    if not n.startswith("data/pointblank/items/") or not n.endswith(".json"):
        continue
    d = json.loads(z.read(n))
    if d.get("type") not in ("gun", "throwable"):
        continue
    ammo = [a for a in d.get("compatibleAmmo", []) if a != "ammocreative"]
    key = "item.pointblank." + d["name"]
    out["pointblank:" + d["name"]] = {
        "label": ja.get(key) or en.get(key) or d["name"],
        "ammo": ("pointblank:" + ammo[0]) if ammo else None,
        "mag": d.get("maxAmmoCapacity", 1),
        "type": d["type"],
    }
with open(os.path.join(ROOT, "app", "src", "weapons.json"), "w", encoding="utf-8") as f:
    json.dump(out, f, ensure_ascii=False, indent=1)
print(len(out), "weapons")
