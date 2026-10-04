# BlockMotion（マイクラ3Dアニメ自動生成）

スキン画像を選んで、モーションを並べて、ボタンを押すだけで、マイクラ風の 3D アニメーション動画と Blender ファイル（.blend）を作る Windows 用デスクトップアプリです。PC にインストールされた Blender を裏で動かします。

## 必要なもの

- Windows 10 / 11
- Blender 4.2 以降（5.0 で確認）。https://www.blender.org/download/ からインストールしてください。Steam 版や Microsoft Store 版も自動で見つけます。

## 使い方

1. `BlockMotion-windows.zip` を展開して、`BlockMotion\BlockMotion.exe` を起動します。
2. 一番上の「Blender」欄に blender.exe の場所が入っていることを確認します（空なら「自動検出」か「参照…」）。
3. ① スキン画像（64×64 または 64×32 の PNG）を選びます。腕の太さ（Steve 型 / Alex 型）は自動で判定します。持ち物も選べます。
4. ② 左の一覧からモーションを選んで「追加 →」。上から順に再生され、つなぎ目は自動でなめらかにつながります。行を選ぶと秒数を変えられます。
5. ③ 背景とカメラを選びます。
6. ④ サイズ（TikTok 用の縦長もあります）と画質を選びます。
7. 「プレビュー」で 1 コマだけ描いて確認し、良ければ「▶ アニメを生成」。

できあがるもの（保存先フォルダ）:

| ファイル | 中身 |
| --- | --- |
| `名前.mp4` | 動画（H.264） |
| `名前.blend` | Blender ファイル。リグ（ボーン）とキーフレーム付きなので、Blender で開いて手直しできます |
| `名前_frames\` | 背景「透過」のときの PNG 連番（背景なし） |
| `名前_preview.png` | プレビュー画像 |

## モーション

歩く / 走る / 待機 / 手を振る / 採掘 / 剣を振る / ジャンプ / バンザイ / ダンス / スニーク / 見回す / 座る / お辞儀 / くるっと回る

「歩く・走るで前に進む」をオフにすると、その場で足踏みします。

## 背景

昼の草原（木と花）/ 夜の草原 / 洞窟（鉱石と松明）/ スタジオ（好きな単色）/ グリーンバック（動画編集アプリで切り抜き用）/ 透過（PNG 連番）

## カメラ

ななめ前 / 正面 / 真横 / 後ろ / アップ / ローアングル / 見下ろし / ぐるっと回る。「カメラがキャラについていく」をオフにすると、カメラは止まったままキャラを目で追います。

## 画質の目安

- 標準（EEVEE）: GPU で速く描きます。ふだんはこれ。
- 高画質（Cycles）: 光と影がきれいですが時間がかかります。NVIDIA / AMD / Intel の GPU があれば自動で使います。
- 下書き（Workbench）: 最速。動きの確認用です。

## exe が開けないとき

Windows の「スマート アプリ コントロール」や SmartScreen が署名のない exe を止めることがあります。その場合は、ダウンロードした zip を右クリック →「プロパティ」→「許可する」にチェックしてから展開するか、Python 3.10 以降を入れて `run_source.bat` から起動してください（ソース一式はリポジトリの `tools/blockmotion/`）。

## コマンドラインで使う

GUI なしでも動きます。設定 JSON の例:

```json
{
  "skin": "C:/Users/me/skin.png",
  "motions": [{"id": "walk", "seconds": 4}, {"id": "wave", "seconds": 3}],
  "item": "diamond_sword",
  "background": "grass",
  "camera": "diagonal",
  "resolution": [1080, 1920],
  "engine": "eevee",
  "output_dir": "C:/Users/me/Videos/BlockMotion",
  "name": "test"
}
```

```
blender -b --factory-startup -P blender/generate.py -- config.json
```

## 補足

- 背景とアイテムのテクスチャは Minecraft のものです（Mojang Studios）。作った動画の公開は Minecraft の利用ガイドラインの範囲で行ってください。
- 設定は `%APPDATA%\BlockMotion\settings.json` に保存されます。
