"""Build the client side of TikTok Defense.

usage: python scripts/build_client.py [pack-version]

1. resourcepack/tiktok_defense_rp.zip   the pixel font (td:px) used for the viewer icons above enemies
2. Prism Launcher instance "TikTok Defense 26.1.2" (created once; mods / shader / resource pack refreshed every run,
   options.txt and the shader settings only written the first time so your own changes are kept)
3. dist/tiktok-defense-26.1.2-<ver>.mrpack   the same setup as a Modrinth pack for other players
   (Prism: Add Instance -> Import -> pick this file)
"""
import io
import json
import os
import shutil
import struct
import sys
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOCK = json.load(open(os.path.join(ROOT, "mods.lock.json"), encoding="utf-8"))
MC, LOADER = LOCK["minecraft"], LOCK["fabric-loader"]
RP_FORMAT = 84  # Minecraft 26.1.2
RP_NAME = "tiktok_defense_rp.zip"
INSTANCE = "TikTok Defense 26.1.2"
PRISM = os.path.join(os.environ.get("APPDATA", ""), "PrismLauncher", "instances")
SERVER = ("TikTok Defense", "localhost:25574")

def px_png():
    """a 10x10 white square: glyph U+E000 of td:px (U+E001 is a -1 space so the squares touch)"""
    import zlib
    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
    raw = bytes([0] + [255] * 40) * 10
    return (bytes([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]) + chunk(b"IHDR", struct.pack(">IIBBBBB", 10, 10, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))


def build_resourcepack():
    out = os.path.join(ROOT, "resourcepack", RP_NAME)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("pack.mcmeta", json.dumps({"pack": {
            "description": [{"text": "TikTok Defense", "color": "gold"}],
            "min_format": [RP_FORMAT, 0], "max_format": [RP_FORMAT + 20, 999]}}, ensure_ascii=False, indent=2))
        z.writestr("assets/td/textures/font/px.png", px_png())
        z.writestr("assets/td/font/px.json", json.dumps({"providers": [
            {"type": "bitmap", "file": "td:font/px.png", "ascent": 8, "height": 10, "chars": [""]},
            {"type": "space", "advances": {"": -1}}]}))
    return out


# Iris reloads shaders on R by default, which is also the gun reload key of Point Blank: unbind the Iris one
OPTIONS = f"""lang:ja_jp
resourcePacks:["vanilla","fabric","file/{RP_NAME}"]
renderDistance:16
simulationDistance:12
fov:0.0
guiScale:3
graphicsMode:1
maxFps:144
enableVsync:false
entityShadows:true
biomeBlendRadius:5
mipmapLevels:4
particles:0
renderClouds:"true"
key_iris.keybind.reload:key.keyboard.unknown
"""
IRIS = "enableShaders=true\nshaderPack={shader}\n"


def nbt_servers():
    """servers.dat (uncompressed NBT) with the game server."""
    def s(v):
        b = v.encode("utf-8")
        return struct.pack(">H", len(b)) + b
    entry = (b"\x08" + s("name") + s(SERVER[0]) + b"\x08" + s("ip") + s(SERVER[1])
             + b"\x01" + s("acceptTextures") + b"\x01" + b"\x00")
    return b"\x0a" + s("") + b"\x09" + s("servers") + b"\x0a" + struct.pack(">i", 1) + entry + b"\x00"


def shader_file():
    return next(f["path"].split("/")[1] for f in LOCK["files"] if f["side"] == "shader")


def build_instance(rp):
    if not os.path.isdir(PRISM):
        print("Prism Launcher が見つからないのでインスタンスは作りません")
        return
    inst = os.path.join(PRISM, INSTANCE)
    mc = os.path.join(inst, "minecraft")
    first = not os.path.exists(inst)
    for d in ("mods", "shaderpacks", "resourcepacks", "config"):
        os.makedirs(os.path.join(mc, d), exist_ok=True)
    # mods: remove the jars this script put there last time (older versions), keep anything you added yourself
    manifest = os.path.join(inst, "td-managed.json")
    if os.path.exists(manifest):
        for rel in json.load(open(manifest, encoding="utf-8")):
            if os.path.exists(os.path.join(mc, rel)):
                os.remove(os.path.join(mc, rel))
    for f in LOCK["files"]:
        src = os.path.join(ROOT, "client", f["path"])
        shutil.copy2(src, os.path.join(mc, f["path"]))
    shutil.copy2(rp, os.path.join(mc, "resourcepacks", RP_NAME))
    with open(manifest, "w", encoding="utf-8") as fh:
        json.dump([f["path"] for f in LOCK["files"]], fh)
    if first:
        with open(os.path.join(inst, "instance.cfg"), "w", encoding="utf-8") as fh:
            fh.write(f"[General]\nConfigVersion=1.3\nInstanceType=OneSix\nname={INSTANCE}\niconKey=default\n"
                     "AutomaticJava=true\nOverrideMemory=true\nMinMemAlloc=2048\nMaxMemAlloc=8192\n")
        with open(os.path.join(mc, "options.txt"), "w", encoding="utf-8") as fh:
            fh.write(OPTIONS)
        with open(os.path.join(mc, "config", "iris.properties"), "w", encoding="utf-8") as fh:
            fh.write(IRIS.format(shader=shader_file()))
        with open(os.path.join(mc, "servers.dat"), "wb") as fh:
            fh.write(nbt_servers())
    with open(os.path.join(inst, "mmc-pack.json"), "w", encoding="utf-8") as fh:
        json.dump({"components": [
            {"uid": "net.minecraft", "version": MC, "important": True},
            {"uid": "net.fabricmc.intermediary", "version": MC, "dependencyOnly": True},
            {"uid": "net.fabricmc.fabric-loader", "version": LOADER},
        ], "formatVersion": 1}, fh, indent=2)
    print(("作成" if first else "更新") + ":", inst)


def build_mrpack(rp, ver):
    os.makedirs(os.path.join(ROOT, "dist"), exist_ok=True)
    out = os.path.join(ROOT, "dist", f"tiktok-defense-{MC}-{ver}.mrpack")
    if os.path.exists(out):
        raise SystemExit(f"{out} は既にあります（上書きしません）。バージョンを上げてください。")
    index = {
        "formatVersion": 1, "game": "minecraft", "versionId": ver, "name": f"TikTok Defense {MC}",
        "summary": "銃MOD（Point Blank）で関門を守る TikTok LIVE 連動ディフェンス。シェーダー入り",
        "files": [{
            "path": f["path"], "hashes": {"sha1": f["sha1"], "sha512": f["sha512"]},
            "env": {"client": "required", "server": "required" if f["side"] == "both" else "unsupported"},
            "downloads": [f["url"]], "fileSize": f["size"],
        } for f in LOCK["files"] if f["side"] in ("both", "client", "shader")],
        "dependencies": {"minecraft": MC, "fabric-loader": LOADER},
    }
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("modrinth.index.json", json.dumps(index, ensure_ascii=False, indent=2))
        z.write(rp, f"overrides/resourcepacks/{RP_NAME}")
        z.writestr("overrides/options.txt", OPTIONS)
        z.writestr("overrides/config/iris.properties", IRIS.format(shader=shader_file()))
        z.writestr("overrides/servers.dat", nbt_servers())
    print("作成:", out)


if __name__ == "__main__":
    rp = build_resourcepack()
    print("リソースパック:", rp)
    build_instance(rp)
    build_mrpack(rp, sys.argv[1] if len(sys.argv) > 1 else "1.0.0")
