# VRChat/VRM アバター → マイクラスキン 検証（2026-10-04）

素材: VRM1_Constraint_Twist_Sample（(c) 2022 pixiv Inc.、VRM Public License 1.0、改変・再配布可、クレジット表記不要）
https://github.com/vrm-c/vrm-specification/tree/master/samples/VRM1_Constraint_Twist_Sample

## ファイル
- vrm_sample_skin_cpm.png … これをマイクラのスキンに設定する。2D スキン＋CPM の立体髪（箱3つ）入り
- vrm_sample_skin_2d.png … 2D スキンだけ（CPM のデータなし）
- vrm_sample.cpmproject … CPM エディタで開ける元データ（髪の箱の調整用）
- preview/ … 上段: 2D のみ、下段: CPM あり（Blender で描画した見本）

## 仕組み
1. scripts/vrm2skin.py（Blender 5.0 bpy）: T ポーズの VRM を部位ごとに6方向から正投影で撮って 64x64 に縮小。顔は暗い部分（目・眉）を残す縮小。髪は外側レイヤー（帽子）に。
2. scripts/mkcpm.py: 髪の色を拾って CPM プロジェクト（後ろ髪1枚・前の房2本）を作る。
3. scripts/Driver.java: CPM 本体のソースをそのまま使ってヘッドレスで「スキンに保存」書き出し → 書き戻して読み込み確認（ヘッダー・チェックサム OK、箱3つ、見える画素は不変）。

Driver.java の動かし方: CPM リポジトリ（tom5454/CustomPlayerModels）の CustomPlayerModels/src/shared を gson・guava・netty と javac でコンパイル（brigadier を使うファイルは除外）。Editor.java の tags 初期化、Editor.loadDefaultPlayerModel の tags.clear()、Exporter の e.tags、TagsLoaderV1.load を null 許容にして `-Dcpm.notags=1` で実行。
