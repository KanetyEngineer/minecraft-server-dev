# DragonBot 試験記録（2026-10-02）

試験サーバー: `dragon-bot-test`（25570、RCON 25579）。途中でバニラから Paper に切り替え。ティックレートは 20 のまま。
22:32 にサーバー停止（オーナーが停止）、22:35 にボット全停止。

## 多数同時起動の負荷試験

| サーバー | 体数 | 結果 |
|---|---|---|
| バニラ | 30 | 1 ティック 40 ms |
| バニラ | 40 | 67 ms |
| バニラ | 50 | 74 ms（20 TPS を割る） |
| Paper | 50 | 20 TPS、11〜14 ms |
| Paper | 70 | 20 TPS、15〜17 ms、CPU 100% |
| Paper | 100 | 19.4〜20 TPS、27 ms、メモリ合計 約 29.6 GB |

- ボット 1 体あたり CPU 約 0.25 コア、メモリ約 0.3 GB（`--max-old-space-size=1536`）。
- CPU 100% のときは、ボット側で待ち時間切れが増える → プロセス全体のエラーで落ちないようにした（0ec650a）。
- Paper の軽量化設定: bukkit.yml（敵のスポーン上限 30、2 ティックごと）、spigot.yml（mob-spawn-range 5、活動範囲を縮小、アイテム結合半径 3.0 / 経験値 4.0）、
  paper-world-defaults（敵の消滅距離 64 / 32）、paper-global（チャンク送信 75）。描画・演算距離 6。
- 起動・停止: `scripts/start-team.sh N solo` ／ `add 11 20 solo` ／ `stop` ／ `stop 11 100`。名前は DragonBot01〜（2 桁）。

## この日に入れた主な改善

Discord 思考ログ、溺死・ドラウンド対策と泳ぎ、廃坑（毒グモ・クモの巣）対策、夜でも動ける時は籠らない、地下は昼夜問わず活動、
黒い羊、`/ai` コマンド、人間らしいチャット、半シフト橋、溶岩遊泳対策、チーム／独立（solo）モード、ボットごとの進め方（4 種）と散らばる向き、
酸素の誤読（他エンティティの値）修正、ボート設置のパケット不具合回避、塔積みの窒息対策、海で陸が見えないときの泳ぎ、森の木の下を地下と誤判定しない。

## 未解決: ほとんど動かないボットが多い（最優先）

最後の 10 体（DragonBot01〜10、solo）の最後の起動以降の集計:

- 「20 秒動けなかった（フリーズ回避）」が 1 体あたり 37〜45 回。スキル成功は 0〜1 回。死亡 0。

切り分け（BridgeTest ボット、平らな石の足場、20 マス先へ GoalNear）:

| 構成 | 結果 |
|---|---|
| 素の mineflayer-pathfinder（既定の Movements） | 3.5 秒で到着 |
| `loadPlugins` + `configureBody`（本番と同じ） | 20 秒で 8.2 マスしか進まず、`path_reset` stuck ×2 |
| 前後・ダッシュの操作だけ（経路探索なし） | 3 秒で 12.9 マス（物理・サーバーは正常） |

→ 原因はサーバーではなく、`src/body/plugins.js` の `configureBody`（またはそこで読み込むプラグイン）。

疑わしい順:

1. `mv.exclusionAreasStep.push(lavaEdgeCost)`（3f37d71 で追加）。経路の 1 マスごとに周囲 8 ブロックを読むので探索が重くなり、
   探索で物理ティックが詰まって「stuck」になっている可能性。
2. `digCost = 4` / `placeCost = 3`、`blocksToAvoid`（クモの巣）、`thinkTimeout` / `searchRadius`。
3. `bot.setControlState` の差し替え・`physicsTick` の泳ぎ処理、`bestHarvestTool` / `equipForBlock` の差し替え。
4. 追加プラグイン（pvp・collectblock・tool・armor-manager・hawkeye・auto-eat）。

次にやること: 試験用スクリプト（loadPlugins だけ＋既定の Movements → configureBody から 1 つずつ外す）で原因を特定し、直してから 10 体で確かめる。

## 後片付けが残っているもの

- whitelist.json の BridgeTest（試験用ボット）を外す。
- 古いデータ（`data*_old_*`、`team_old_*`）と 11〜100 番のデータ・ログは残したまま（削除はオーナーの許可が要る）。
