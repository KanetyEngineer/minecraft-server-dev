# Solaria Tweaks

Solaria SMP（Minecraft 1.21.11 / Fabric）向けの補助 MOD。クライアントとサーバーの両方に同じ jar を入れる。
前の「Solaria Tools」と、別配布だった Potion Dupe Restore をまとめたもの（両方入っていると起動時に止まるので外す）。

## できること

### 1. サーバー共有の地点（Xaero's Minimap / World Map）
サーバーに保存した地点を全員の Xaero の地図・ミニマップに表示する（Xaero の「サードパーティ地点」として出すので、どの地点セットを選んでいても見え、自分の地点ファイルは汚さない）。

- 地図画面の右上「サーバー地点」→ 共有地点の一覧（削除）と「自分の地点を共有」タブ（Xaero に登録済みの地点を選んで共有、まとめて共有）
- 地図で自分の地点を右クリック →「サーバーに共有」、共有地点を右クリック →「共有地点を削除」
- 地図の何もない所を右クリック →「ここをサーバー地点に追加」
- ミニマップの地点一覧（U キー）で地点を選んで「選んだ地点をサーバーに共有」
- 削除は追加した人か OP だけ。MOD なしの人もコマンドで使える

| コマンド | 内容 |
|---|---|
| `/swp` | 共有地点の一覧 |
| `/swp add <名前>` | 今いる場所を共有 |
| `/swp remove <番号>` / `/swp rename <番号> <名前>` | 削除・名前変更（追加した人か OP） |

データはワールドフォルダの `solariatweaks/waypoints.json`。

### 2. 順位表（サイドバー）
統計の順位をサイドバーに出す。表示はプレイヤーごとに別々で、自分の画面だけが変わる。統計が増えたその tick に更新される。サーバー側だけで動くので、MOD なしのクライアントにも出る。

- **ボットは数えない**: Carpet の `/player` で出したボット（GCA などのボットも含む）は自動で外れ、一度見つけたボットは記録されてオフラインでも外れる。それ以外は OP が `/lb bot add <名前>` で外せる
- オフラインの人も `world/stats` の記録から順位に入る

| コマンド | 内容 |
|---|---|
| `/lb` | 項目の一覧と今の表示 |
| `/lb show <項目>` | 自分の順位表を切り替え（例 `mined`、`playtime`、`mined:diamond_ore`、`killed:zombie`、`used:all`） |
| `/lb hide` | 自分の順位表を非表示（サーバーの元のサイドバーがあれば戻る） |
| `/lb top <項目>` | チャットに全順位 |
| `/lb default <項目>\|off` | まだ選んでいない人の表示（OP、最初は `mined` 採掘数） |
| `/lb bot add/remove/list` | ボットとして外す人の管理（OP） |

項目: `mined` 採掘数 / `used` 使用回数 / `crafted` クラフト数 / `kills` モブ討伐 / `deaths` 死亡 / `playtime` プレイ時間 / `walk` 歩いた距離 / `fly` エリトラ / `fish` 釣り / `trades` 取引 / `jumps` / `damage`。ほかに `mined:` `used:` `crafted:` `broken:` `picked_up:` `dropped:` `killed:` `killed_by:` `custom:` の後に ID か `all`。

### 3. Syncmatica 設計図の建築計画
Syncmatica で共有された設計図（placement）ごとに「建築計画」を作り、みんなで分担する。

- **材料**: 設計図から必要数を計算。アイテムごとに担当者を決める（自分で「担当」／作成者が自動割り当て）
- **リアルタイム在庫**: 計画に登録した倉庫（チェスト・樽・シュルカーボックス等。箱の中のシュルカーの中身も数える）と、参加者の手持ちを 2 秒ごとに集計。設置済みのブロックも差し引く
- **建築の区画分け**: 設計図の範囲を 16/32/64 マスの格子か、Litematica のサブリージョンごとに分け、区画ごとに担当者を決める
- **進捗**: ワールドのブロックが設計図どおりか少しずつ照合（読み込まれているチャンクのみ）。材料と建築の進捗を、計画全体・アイテム別・区画別に表示
- 画面: `B` キー（操作設定で変更可）。HUD（画面右側）に自分の担当と進捗を表示
- **Chest Tracker 連携**: Chest Tracker が覚えている容器（登録した倉庫以外）にある材料の数と最寄りの座標を、材料の行（「箱にN」）とツールチップに出す
- MOD なしのプレイヤーもチャットのコマンドで同じことができる

| コマンド | 内容 |
|---|---|
| `/bp` | 建築計画の一覧と進捗 |
| `/bp placements` | Syncmatica で共有中の設計図一覧（番号つき） |
| `/bp create <名前> <番号か設計図名かID>` | 建築計画を作る（作った人が参加者になる） |
| `/bp info / materials / areas <計画>` | 概要・不足材料・区画の進捗 |
| `/bp join / leave <計画>` | 参加・離脱 |
| `/bp claim / unclaim <計画> <アイテム>` | 材料の担当になる・外れる |
| `/bp areaclaim / areaunclaim <計画> <区画>` | 区画の担当になる・外れる |
| `/bp storage <計画> add / remove <座標>` | 倉庫の登録 |
| `/bp assign <計画> <プレイヤー> <アイテム>` | 他人に材料を割り当て（作成者・OP） |
| `/bp areaassign <計画> <区画> <プレイヤー>` | 他人に区画を割り当て（作成者・OP） |
| `/bp autoassign <計画>` | 残りの材料と未完成の区画を参加者に均等に配る（作成者・OP） |
| `/bp areamode <計画> grid <マス> / subregions` | 区画の分け方（作成者・OP） |
| `/bp delete <計画>` | 計画の削除（設計図は消えない、作成者・OP） |

データはワールドフォルダの `solariatweaks/builds.json`（前の `solariatools/builds.json` があれば読み込む）。

### 4. オブザーバー前の誤設置警告（クライアント）
オブザーバーが見ている場所にブロックを置こうとすると、設置を止めて警告する（アクションバー＋音）。3 秒以内にもう一度置くと設置される。モードは 3 つ:

- **設計図と違うものだけ**（既定）: Litematica の設計図と違うブロックのときだけ
- **すべてのブロック**: 何を置くときでも（Litematica なしでも動く）
- **OFF**

切り替え: 建築計画画面（B）右上のボタン、`/observerguard off|diff|all`、操作設定の「オブザーバー警告の切り替え」キー（初期は未割り当て）。設定は `config/solariatweaks-client.json`。

### 5. ポーション複製（Potion Dupe Restore）
1.21.1 のポーション複製（ネザーゲートを通った投げポーションが元の次元でも割れる）を 1.21.11 で戻す。サーバー側で動く。

- `/potiondupe on|off`、`/potiondupe scope potions|all`、細かい設定は `/potiondupe <項目> true|false`（OP）。設定は `config/potiondupe.json`

### 6. 光抑制（/lightsuppress）
サーバーの光の更新を止めて、光抑制装置と同じ状態を作る（止めている間の光の更新は溜まり、OFF にすると処理される）。

- `/lightsuppress on [秒]`、`/lightsuppress off`、`/lightsuppress status`（OP）
- ON の間は新しいチャンクの読み込みも止まる。秒を付けるとその時間で自動 OFF、サーバー停止時も自動 OFF
- Carpet TIS Addition の `lightUpdates suppressed` と同じ考え方で、Carpet なしでも使える

## 依存
- 必須: Fabric API
- 任意: Xaero's Minimap と World Map（共有地点）、Syncmatica（建築計画）、Litematica（誤設置警告）、Chest Tracker（記憶の表示）

## ビルド
GitHub Actions（`.github/workflows/solaria-tweaks.yml`）でビルドし、jar を `solaria-dist` ブランチに置く。
