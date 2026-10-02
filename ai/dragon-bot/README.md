# DragonBot（エンダードラゴン討伐 AI）

普通のプレイヤーと同じようにサバイバルで遊び、エンダードラゴン討伐を目指すボットです。

- **体（基本操作）**: 既存の Mineflayer プラグインを使います。移動は pathfinder、戦闘は pvp、採掘は collectblock と tool、弓は minecrafthawkeye、防具は armor-manager、食事は auto-eat です。
- **頭（方針）**: Claude（既定 `claude-opus-5-5`）が状況を読み、次にやるスキルを 1 つ選びます。API キーが無いときや失敗したときは、進捗表に沿ったルールベースで続行します。
- **反射**: 攻撃されたら反撃し、クリーパーや瀕死のときは逃げます。これは LLM を待たずに動きます。
- **普通のプレイヤーらしさ**: コマンドやチートは使いません。鉱石は「見えている」ブロックだけを狙います（透視しない）。視点はなめらかに動き、話しかけられたら短く返事をします。

## 流れ（スキル 34 個、`src/skills/index.js`）
木 → 石の道具 → 食料 → 鉄装備・バケツ → ダイヤのツルハシ → 弓と矢 → 黒曜石 → ネザーポータル → ブレイズロッド → エンダーパール → エンダーアイ → 三角測量で要塞 → エンドポータル → クリスタル破壊 → ドラゴン戦

## 動かし方（Windows）
1. 試験鯖を用意します: `powershell -ExecutionPolicy Bypass -File scripts\setup-test-server.ps1`。作成先は `Documents\ClaudeCode\dragon-bot-test`（127.0.0.1:25570）です。その後 `start.bat` で起動します。
2. `npm install`
3. `.env.example` を `.env` にコピーします。Claude を使う場合は `ANTHROPIC_API_KEY` を書きます。
4. `node --env-file=.env src/index.js`
5. 状態は http://localhost:3007/ で見られます。記憶は `data/memory.json` に残ります。
6. 何体もまとめて動かすときは `bash scripts/start-team.sh 10 solo`（10 体が独立して動く）。名前は番号を 2 桁にした DragonBot01〜DragonBot50 で、記憶・ログ・状態ページは 1 体ずつ分かれます（1 体目は `data/`・`logs/`・3007、2 体目以降は `data2/`・`logs2/`・3008 ...）。動かしたまま足すときは `bash scripts/start-team.sh add 11 20`、全部止めるときは `bash scripts/start-team.sh stop`。鯖のホワイトリストには DragonBot01〜DragonBot50 を登録しておきます。

## 試験鯖を Paper で軽量化する（ボットが 30 体を超えるとき）
バニラ鯖は 50 体で 1 ティック 74 ms（上限 50 ms）まで落ちました。限界は CPU やメモリではなく、参加人数に比例して湧く敵などのエンティティ数（50 体で約 2,660 体）です。
鯖を止めてから `powershell -ExecutionPolicy Bypass -File scripts\setup-paper.ps1` を実行すると、試験鯖を Paper に替えて（設定と start.bat は `backup_before_paper_<日時>\` に写してから）、`scripts/paper-tune.mjs` の値（湧き数・AI を動かす距離・落ちた物の寿命など。2026-10-02 に 50 体で 20 TPS・エンティティ約 410 体になった設定）を書き込みます。終わったら `start.bat` で起動します。値だけ入れ直すときは `node scripts/paper-tune.mjs <鯖のフォルダ>`（`--dry-run` で確認だけ）。

## バージョン
Mineflayer は Minecraft 26.1 までの対応なので、試験鯖は 1.21.11 にしています。

## テスト
`npm test` で単体テストが走ります。
