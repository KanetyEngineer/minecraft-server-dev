# Solaria Carpet

Solaria SMP（Minecraft 1.21.11 / Fabric）向けの Carpet 拡張。サーバーにだけ入れる（fabric-carpet が必要）。
ポーション複製と光抑制を Carpet のルールとして切り替える。どのルールも初期値は OFF。

## ルール（カテゴリー `solaria`）

| ルール | 初期値 | 内容 |
|---|---|---|
| `potionDupe` | false | 1.21.1 までのポーション複製を復活させる（ネザーゲートを通った投げポーションが元の次元でも割れる） |
| `potionDupeScope` | potions | 対象。`potions` はスプラッシュ・残留ポーションだけ、`all` はエンダーパール以外の投擲物すべて |
| `potionDupeHitAfterPortal` | true | ゲートを通った tick にも当たり判定をする |
| `potionDupeLegacyPortalCooldown` | true | 投擲物のゲート待ち時間を 300 tick にする（1.21.2 以降は 2） |
| `potionDupeLegacyPhysics` | true | 投擲物の処理順・ハチミツブロックの滑り・当たり判定の幅を 1.21.1 にする |
| `lightSuppression` | false | 昔の光抑制装置が使えるようにする（1 tick に処理する光の更新に上限を設ける） |
| `lightSuppressionTasksPerTick` | 2000 | 光抑制中に 1 tick で処理する光の更新の数（1000 単位で切り上げ） |
| `lightSuppressionMaxQueue` | 300000 | 光抑制中に溜まる処理待ちの上限（超えた分は全力で処理、0 で無制限） |
| `voidTrading` | false | 虚空取引の復活。村人がアンロードされたりポータルをくぐったりしても取引画面が閉じない |

```
/carpet potionDupe true
/carpet setDefault potionDupe true      # 再起動後も有効にする
/carpet lightSuppression true
/carpet list solaria                    # ルールの一覧
```

### 光抑制について
1.21.11 の光エンジンは 1 回で最大 1000 件をまとめて処理し、溜まりそうになるとすぐ処理するため、昔の光抑制装置（光の更新を大量に出し続けて処理待ちを溜める装置）が効かなくなっている。
`lightSuppression` を true にすると、1 tick に処理する量が `lightSuppressionTasksPerTick` までに制限されるので、昔と同じように処理待ちが溜まる。サーバーを止めたときに残っていた光の更新は昔と同じく消える。処理待ちが溜まっている間に新しいチャンクを読み込むと、処理待ちが片付くまでサーバーが止まる（30万件で約8秒）。止まりすぎないよう、処理待ちは `lightSuppressionMaxQueue` 件までに抑える。
古い光エンジンをそのまま再現したものではないので、装置によっては挙動が違うことがある。

Potion Dupe Restore とは同時に入れられない（同じ処理を書き換えるため）。

### 虚空取引について
1.20.5 以降のバニラでは、取引中の村人がアンロードされたりポータルで別のディメンションへ移ったりすると取引画面が閉じる。`voidTrading` を true にすると、その場合も画面が開いたままになり、昔のように世界から消えた村人と取引を続けられる。この間の取引は村人に保存されないので、取引はロックされず、割引（治療・村の英雄）もリセットされない。村人が倒されたときや消されたときは今までどおり閉じる。

## ビルド
GitHub Actions（`.github/workflows/solaria-carpet.yml`）でビルドする。
