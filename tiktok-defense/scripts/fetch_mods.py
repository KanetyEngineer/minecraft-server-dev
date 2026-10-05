"""Download the mods / shader / server jar for TikTok Defense from Modrinth and Fabric meta.

usage: python scripts/fetch_mods.py
Writes server/mods/*.jar, client/mods/*.jar, client/shaderpacks/*.zip and mods.lock.json
(mods.lock.json is what build_client_pack.py puts into the .mrpack).
"""
import hashlib
import json
import os
import urllib.request

MC = "26.1.2"
LOADER = "0.19.5"
INSTALLER = "1.1.2"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# slug: (side, loader[, pinned version]) ; side = both / server / client / shader
MODS = {
    "fabric-api": ("both", "fabric"),
    "vics-point-blank": ("both", "fabric"),
    "geckolib": ("both", "fabric"),
    "lithium": ("both", "fabric"),
    "ferrite-core": ("both", "fabric"),
    "sodium": ("client", "fabric"),
    "iris": ("client", "fabric"),
    "entityculling": ("client", "fabric"),
    "modmenu": ("client", "fabric"),
    # r5.9.x uses the 26.2 sulfur caves biome and fails to load on 26.1.2 (Iris: Unknown variable BIOME_SULFUR_CAVES)
    "complementary-reimagined": ("shader", "iris", "r5.8"),
}


def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "kanety/tiktok-defense (fetch_mods.py)"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read()


def latest(slug, loader, pin=None):
    q = f"?game_versions=%5B%22{MC}%22%5D&loaders=%5B%22{loader}%22%5D"
    versions = json.loads(get(f"https://api.modrinth.com/v2/project/{slug}/version{q}"))
    if pin:
        versions = [v for v in versions if v["version_number"] == pin]
    if not versions:
        raise SystemExit(f"{slug}: {MC} / {loader} 向けがありません")
    v = versions[0]
    f = next(x for x in v["files"] if x["primary"])
    return v, f


def save(data, path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as fh:
        fh.write(data)


def main():
    lock = {"minecraft": MC, "fabric-loader": LOADER, "files": []}
    for slug, (side, loader, *pin) in MODS.items():
        v, f = latest(slug, loader, *pin)
        data = get(f["url"])
        if hashlib.sha1(data).hexdigest() != f["hashes"]["sha1"]:
            raise SystemExit(f"{slug}: ハッシュが合いません")
        dirs = {"both": ["server/mods", "client/mods"], "server": ["server/mods"],
                "client": ["client/mods"], "shader": ["client/shaderpacks"]}[side]
        for d in dirs:
            save(data, os.path.join(ROOT, d, f["filename"]))
        lock["files"].append({
            "slug": slug, "version": v["version_number"], "side": side,
            "path": ("shaderpacks/" if side == "shader" else "mods/") + f["filename"],
            "url": f["url"], "sha1": f["hashes"]["sha1"], "sha512": f["hashes"]["sha512"], "size": f["size"],
        })
        print(f"{slug:26} {v['version_number']:28} {f['filename']}")
    jar = get(f"https://meta.fabricmc.net/v2/versions/loader/{MC}/{LOADER}/{INSTALLER}/server/jar")
    save(jar, os.path.join(ROOT, "server", "fabric-server-launch.jar"))
    print("fabric server launcher", len(jar), "bytes")
    with open(os.path.join(ROOT, "mods.lock.json"), "w", encoding="utf-8") as fh:
        json.dump(lock, fh, indent=2)


if __name__ == "__main__":
    main()
