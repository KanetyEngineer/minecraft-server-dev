# Potion Dupe Restore（1.21.11 用 Fabric MOD）

1.21.1 で動いていた「投げたポーションのネザーゲート複製」（流云の蝙蝠药水复制、乌_龙_茶の 10gt 复合药水复制机 など）を 1.21.11 でも動くようにするサーバー側 MOD です。

## 何が変わったのか（1.21.1 → 1.21.11）

| 項目 | 1.21.1 | 1.21.2 以降 | この MOD |
| --- | --- | --- | --- |
| ゲートを通った tick の当たり判定 | ゲートで別ディメンションへ移った「元の」実体も同じ tick に当たり判定をして割れる（＝割れた効果＋向こう側のコピー） | `isAlive()` の条件が付き、移った元実体は割れない | 元実体が `CHANGED_DIMENSION` で消えた場合だけ当たり判定を通す |
| 投擲物のゲート待ち時間 | 300 tick | 2 tick | 300 tick に戻す |
| 投擲物の tick の順番 | ゲート処理 → 当たり判定 → ブロック効果（移動前の位置）→ 移動 → 減速 → 重力 | 重力 → 減速 → 当たり判定 → 移動 → ブロック効果 → ゲート処理 → 当たり判定 | 1.21.1 の順番で動かす |
| ハチミツブロックの滑り | 落下速度 -0.08 未満で -0.05 に固定 | 生物用の換算式（重力0.08）を通すため、ポーションは約3.5倍速く滑る | 1.21.1 の式に戻す |
| 実体への当たり判定の余白 | 常に 0.3 | 出てから数 tick は 0 から徐々に 0.3 | 常に 0.3 |

対象は既定でスプラッシュ／残留ポーションだけです（ほかの投擲物はバニラのまま）。

## 導入

1. Minecraft 1.21.11 の Fabric サーバーに Fabric API（1.21.11 版）を入れる
2. `potion-dupe-1.0.0+mc1.21.11.jar` を `mods/` に入れる
3. 起動すると `config/potiondupe.json` ができる

クライアントには不要です。

## コマンド（OP レベル2）

| コマンド | 内容 |
| --- | --- |
| `/potiondupe` | 現在の設定を表示 |
| `/potiondupe on` / `off` | まとめてオン／オフ（オフで完全にバニラ） |
| `/potiondupe scope potions` / `all` | 対象をポーションだけ／エンダーパール以外の全投擲物に |
| `/potiondupe hitAfterPortal true\|false` | 複製そのもの |
| `/potiondupe legacyPortalCooldown true\|false` | ゲート待ち時間 300 tick |
| `/potiondupe legacyPhysics true\|false` | tick 順・ハチミツ・当たり余白を 1.21.1 に |
| `/potiondupe reload` | 設定ファイルを読み直す |

## 動作確認・注意

- Minecraft 1.21.11 + Fabric Loader 0.19.5 + Fabric API 0.141.6 で、ゲートに入った tick に床へ当たるポーションが「こちらで割れる＋向こうにコピー」になることを確認済み（オフでは向こうへ移るだけ）。farm ワールドのコピーも 1.21.11 で読み込め、投げたポーション 680 個が残っていた。
- 1.21.2 以降は無人だと 60 秒で tick が止まる（`pause-when-empty-seconds`）。無人で動かすなら `-1` に。
- 公開版: https://github.com/KanetyEngineer/potion-dupe-restore/releases/latest

## ビルド

GitHub Actions（`.github/workflows/potion-dupe.yml`）でビルドし、jar を `potion-dupe-dist` ブランチに置きます。手元では Gradle 9.2 以上で `gradle build`。
