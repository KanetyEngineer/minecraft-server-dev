"""Resource pack for Anime Umetate: only the pixel font used to draw viewer avatars (font umetate:px).
usage: python build.py [out.zip]   (the TikTok app serves it at http://127.0.0.1:8790/resourcepack.zip)"""
import json
import os
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))


def build(path):
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("pack.mcmeta", json.dumps({"pack": {
            "description": [{"text": "アニメ技の埋め立て", "color": "gold"}],
            "min_format": [88, 0], "max_format": [88, 999]}}, ensure_ascii=False, indent=2))
        # U+E000 = 10x10 white square, U+E001 = -1 space so the squares touch
        z.writestr("assets/umetate/font/px.json", json.dumps({"providers": [
            {"type": "bitmap", "file": "umetate:font/px.png", "ascent": 8, "height": 10, "chars": [""]},
            {"type": "space", "advances": {"": -1}}]}))
        z.write(os.path.join(HERE, "px.png"), "assets/umetate/textures/font/px.png")
    print("ok:", path)


if __name__ == "__main__":
    build(sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "anime_umetate_resourcepack.zip"))
