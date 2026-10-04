# Solaria Tools

Solaria SMP（Minecraft 1.21.11 / Fabric）向けの補助 MOD。クライアントとサーバーの両方に入れる同じ jar。

## できること

### 1. Xaero's World Map からサーバー共有地点を使う
既存 MOD [Server Waypoint](https://modrinth.com/plugin/server_waypoint)（MIT）を使い、その画面を地図から開けるようにする。

- 地図画面の右上に「サーバー地点」ボタン → Server Waypoint の地点一覧（追加・編集・削除）を開く
- 地図を右クリック →「ここをサーバー地点に追加」→ 右クリックした座標が入った追加画面が開く
- 共有地点は Server Waypoint が Xaero's Minimap の地点として配るので、地図とミニマップにも表示される
- サーバーとクライアントの両方に Server Waypoint が必要

### 2. Leaderboard（順位表）
既存 MOD [Stats Scoreboard](https://modrinth.com/mod/stats-scoreboard)（MIT、サーバーのみ）を使う。この MOD 自体は何もしない。

- サイドバーに全員の統計の順位が出る。表示内容はプレイヤーごとに別々
- 表示する統計を変える: `/ssb sidebar add <統計>`（例 `custom.minecraft.play_time`、`block.mined.all`、`entity.killed.all`）
- 外す: `/ssb sidebar remove <統計>`。全部外すと非表示
- 複数選ぶと `/ssb sidebarRotationInterval <秒>` の間隔で切り替わる

### 3. Syncmatica 設計図の建築計画（自作）
Syncmatica で共有された設計図（placement）ごとに「建築計画」を作り、みんなで分担する。

- **材料**: 設計図から必要数を計算。アイテムごとに担当者を決める（自分で「担当」／作成者が自動割り当て）
- **リアルタイム在庫**: 計画に登録した倉庫（チェスト・樽・シュルカーボックス等。箱の中のシュルカーの中身も数える）と、参加者の手持ちを 2 秒ごとに集計。設置済みのブロックも差し引く
- **建築の区画分け**: 設計図の範囲を 16/32/64 マスの格子か、Litematica のサブリージョンごとに分け、区画ごとに担当者を決める
- **進捗**: ワールドのブロックが設計図どおりか少しずつ照合（読み込まれているチャンクのみ）。材料と建築の進捗を、計画全体・アイテム別・区画別に表示
- 画面: `B` キー（操作設定で変更可）。HUD（画面右側）に自分の担当と進捗を表示
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

- **Chest Tracker 連携**: Chest Tracker が覚えている容器（登録した倉庫以外）にある材料の数と最寄りの座標を、材料の行（「箱にN」）とツールチップに出す。各自の記憶なのでサーバーの集計には入らない

### 4. オブザーバー前の誤設置警告（クライアント）
Litematica で建築中、オブザーバーが見ている場所に設計図と違うブロックを置こうとすると、設置を止めて警告（アクションバー＋音）。3 秒以内にもう一度置くと設置される。建築計画画面の「設定」タブか `config/solariatools-client.json` の `observerGuard` で ON/OFF。

データはワールドフォルダの `solariatools/builds.json` に保存される。

## 依存
- 必須: Fabric API
- 任意: Syncmatica（建築計画）、Litematica（誤設置警告）、Chest Tracker（記憶の表示）、Xaero's World Map と Server Waypoint（地点ボタン）

## ビルド
GitHub Actions（`.github/workflows/solaria-tools.yml`）でビルドし、jar を `solaria-dist` ブランチに置く。
