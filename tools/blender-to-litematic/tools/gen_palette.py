"""palette_data.py を作り直す開発用スクリプト。

使い方:
    python tools/gen_palette.py <client.jar | リソースパック.zip | 展開済みフォルダ>
"""

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

from blender_to_litematic import palette  # noqa: E402


def main():
    if len(sys.argv) != 2:
        print(__doc__)
        return 2
    colors, missing = palette.compute_from_textures(sys.argv[1])
    out = os.path.join(os.path.dirname(HERE), "blender_to_litematic", "palette_data.py")
    with open(out, "w", encoding="utf-8") as f:
        f.write('"""ブロックの平均色 (sRGB)。tools/gen_palette.py で生成。手で編集しないこと。"""\n\n')
        f.write("COLORS = {\n")
        for k, (r, g, b) in colors.items():
            f.write(f'    "{k}": ({r}, {g}, {b}),\n')
        f.write("}\n")
    print(f"{len(colors)} ブロックを書き出しました -> {out}")
    if missing:
        print("見つからなかったテクスチャ:", ", ".join(missing))
    return 0


if __name__ == "__main__":
    sys.exit(main())
