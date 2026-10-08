# Game Lobby

ハロウィン・銃MOD・クラロワ・アニメ技の各ゲーム鯖へ移動できるロビー鯖。

- `server/` … Paper 26.2 + ViaVersion 5.12.0 + ViaBackwards 5.12.0 + GameLobby プラグイン。ロビー本体はポート 25579、online-mode=true、最大 60 人
- `plugin/` … GameLobby プラグインのソース。`sh plugin/build.sh` でビルドして `server/plugins/` に入る（サーバーを一度起動して libraries/ と versions/ ができている必要あり）
- `CHANGE-REQUESTS.md` … 行き先の各サーバー側に必要な変更

## 起動

`start-all.bat` をダブルクリック（入口の中継 `router/` とロビー本体 `server/` の両方が起動する）。

## しくみ

- 移動は Minecraft 標準の転送（`Player#transfer`）。プロキシを使わないので、行き先が バニラ・Fabric・別の版でも、online-mode のままで動く。
  行き先側は `accepts-transfers=true` と、プレイヤーから届く公開アドレスが必要。
- 円形の広場にゲートが行き先の数だけ並ぶ。ゲートの床に乗るとその鯖へ移動。手持ちのコンパス（右クリック）でもメニューから選べる。`/go <id>`、`/menu` もある。
- ViaVersion で 26.2 以外のクライアント（26.1.2 の銃MOD クライアントなど）もロビーに入れる。行き先ごとに必要な版・クライアント（fabric など）を確かめ、合わない人は転送せずに理由と直接アドレスを出す。
- 各ゲートの奥にはテーマ別の浮島（ハロウィン=巨大カボチャと墓地、TikTok Defense=砦と見張り塔、クラロワ=キングタワーとプリンセスタワー、アニメ技=鳥居と桜とエネルギー弾）があり、中央のスポーン地点の下にはビーコンがある。テーマは行き先の id（または config の `theme:`）で決まる。広場の作りを変えたら `BUILD_VERSION` を上げると、次の起動で一度だけ作り直す。
- 動いているロビーのプラグインを差し替えるときは、新しい jar を `server/plugins/update/` に置いて再起動する（使用中の jar を上書きしない）。
- ロビー内はアドベンチャー、ダメージ・空腹・ブロック破壊・アイテム移動なし、落ちたらスポーンに戻る。

## 入口の中継（router/router.js）

playit の無料トンネルは 4 本までなので、アニメ技の鯖はロビーのトンネル（stamina-proves.tun.ply.gg → 127.0.0.1:25576）を共用する。
25576 で待つ中継が、接続のホスト名の末尾が "." ならアニメ技（25590）へ、それ以外はロビー本体（25579）へ素通しで振り分ける。
ロビーはアニメ技へ送るとき `stamina-proves.tun.ply.gg.` に転送する。中身は素通しなので online-mode の認証はそのまま。

## 行き先の追加・変更

`server/plugins/GameLobby/config.yml` の `destinations` を編集して保存すると、数秒で自動的に読み直して広場とゲートを作り直す（手動なら `/lobbyadmin rebuild`）。`/lobbyadmin list` で状態確認。
