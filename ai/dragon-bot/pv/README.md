# PROJECT DRAGONFALL（PV 素材）

エンドラ RTA の PV 用のプロジェクト名・ロゴ・オープニング。英語のみ、ほぼ黒の背景に白い文字、差し色は紫 1 色のシンプルで現代的なデザイン。

- `assets/dragonfall_opening.mp4` オープニング（8 秒、1920x1080、60fps、効果音付き）。PV の頭にそのままつなぐ
- `assets/dragonfall_logo.png` ロゴ（透明 PNG）、`dragonfall_logo_dark.png` 暗い背景つき（サムネイル素材）、`dragonfall_icon.png` マーク（エンダードラゴンの目）
- 作り直し: `./fetch_fonts.sh` でフォントを入れてから `python3 brand.py <出力先>`、`python3 opening.py <出力先>`（Pillow・numpy・ffmpeg が必要）
- フォント: Inter（Google Fonts、SIL Open Font License）
- 前の版（ドット風 039d694、アニメ風「竜墜」f69642b）は Git の履歴に残っている
