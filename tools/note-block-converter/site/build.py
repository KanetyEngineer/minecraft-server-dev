"""配布ページの組み立て: ブラウザ版が読む oto2noteblock.py をコピーし、Windows 版の zip を作る。
使い方: python build.py → npx wrangler deploy（このフォルダで）
"""
import os
import shutil
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
TOOL = os.path.dirname(HERE)
PUB = os.path.join(HERE, "public")
VERSION = "1.0.0"

shutil.copy(os.path.join(TOOL, "oto2noteblock.py"), os.path.join(PUB, "py", "oto2noteblock.py"))

zpath = os.path.join(PUB, "downloads", f"oto2noteblock-{VERSION}-windows.zip")
with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED) as z:
    root = f"oto2noteblock-{VERSION}/"
    z.write(os.path.join(TOOL, "oto2noteblock.py"), root + "oto2noteblock.py")
    z.write(os.path.join(TOOL, "README.md"), root + "README.md")
    for f in sorted(os.listdir(os.path.join(HERE, "dist-files"))):
        z.write(os.path.join(HERE, "dist-files", f), root + f)
for f in os.listdir(os.path.join(PUB, "downloads")):
    p = os.path.join(PUB, "downloads", f)
    if f.endswith(".zip") and p != zpath:
        print("古い zip が残っています（消していません）:", f)
import json
with open(os.path.join(PUB, "downloads", "latest.json"), "w", encoding="utf-8") as f:
    json.dump({"version": VERSION, "file": os.path.basename(zpath), "size": os.path.getsize(zpath)}, f)
print("できた:", zpath, os.path.getsize(zpath), "bytes")
