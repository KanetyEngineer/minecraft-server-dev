# PROJECT 竜墜 DRAGONFALL（PV 素材）

エンドラ RTA の PV 用のプロジェクト名・ロゴ・オープニング。アニメのタイトルロゴ風（鋭い明朝の「竜墜」、金属の質感、斬撃の線）。

- `assets/dragonfall_opening.mp4` オープニング（8.5 秒、1920x1080、60fps、効果音付き）。PV の頭にそのままつなぐ
- `assets/dragonfall_logo.png` ロゴ（透明 PNG）、`dragonfall_logo_dark.png` 暗い背景つき（サムネイル素材）、`dragonfall_icon.png` 目のアイコン
- 作り直し: `./fetch_fonts.sh` でフォントを入れてから `python3 brand.py <出力先>`、`python3 opening.py <出力先>`（Pillow・numpy・ffmpeg が必要）
- フォント（Google Fonts、SIL Open Font License）: しっぽり明朝 B1（竜墜・副題）、Orbitron（DRAGONFALL）、Michroma（PROJECT・英字）、Dela Gothic One（帯）
