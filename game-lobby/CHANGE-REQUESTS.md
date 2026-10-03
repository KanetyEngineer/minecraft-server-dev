# ロビーから移動させるために、各サーバーに必要な変更

ロビー: `Documents\ClaudeCode\game-lobby\server`（Paper 26.2 + ViaVersion/ViaBackwards、ポート 25576、online-mode=true）。
移動は Minecraft 標準の「転送（transfer）」で行う。プロキシ（Velocity）は使わないので、各サーバーの online-mode や UUID はそのままでよい。
転送ではプレイヤーのクライアントが行き先へ自分でつなぎ直すため、行き先ごとに **プレイヤーから届く公開アドレス** が必要。

## 1. ハロウィン play-server（halloween-map\play-server, 26.2）

- 必須: `server.properties` の `accepts-transfers=false` を `accepts-transfers=true` にして再起動。
  - これが false のままだと、ロビーから来た人は「転送は受け付けていません」で弾かれる。
  - 公開中の入口（rails-backups.tun.ply.gg:5858）とホームページの案内はそのまま。直接入る人には影響なし。
- 任意（ロビーへ戻る導線）: 戻るボタン等で `transfer <ロビーの公開ホスト> <ポート> @s` を実行する。
  `/transfer` は権限レベル 3 が必要なので、データパックの関数から実行するなら `function-permission-level=3` も必要。ロビーの公開アドレスが決まってからでよい。

## 2. 銃MOD TikTok Defense（tiktok-defense\server, Fabric 26.1.2）

- 必須: `server.properties` に `accepts-transfers=true`。
- 必須: プレイヤーから届く公開アドレス（playit のトンネル等 → 127.0.0.1:25574）。決まったらロビーの `plugins/GameLobby/config.yml` の `tiktok-defense.host/port` に書いて `enabled: true`。
- 版について: ロビーは 26.2 だが ViaBackwards で 26.1.2 のクライアントも入れる。銃の行き先は「26.1.2 かつ Fabric クライアント」の人だけ転送し、それ以外（バニラ 26.2 の人など）には MOD パックが必要という案内と直接アドレスを出す。
  - 銃鯖の版を変えたら config の `version` を合わせる。

## 3. クラロワ MC（clash-royale-mc\server, 26.2 バニラ, 25580）

- accepts-transfers=true は設定済みとのこと。
- 必須: 公開アドレス（トンネル → 127.0.0.1:25580）。決まったら config の `clash-royale.host/port` に書く（enabled は true 済み、host が空の間は「準備中」表示）。

## 4. アニメ技 埋め立て（anime-umetate\server, 26.2 バニラ, 25590）

- accepts-transfers=true は設定済みとのこと。
- 必須: 公開アドレス（トンネル → 127.0.0.1:25590）。決まったら config の `anime-umetate.host/port` に書く（enabled は true 済み）。

## 5. ロビー自体の公開

- 必須: playit.gg で新しいトンネル（Minecraft Java / TCP）を追加し、宛先を `127.0.0.1:25576` にする。ハロウィンの既存トンネルは変更しない。
  - トンネル追加は playit.gg のダッシュボードでの操作（アカウント操作なのでユーザーかハロウィン担当のスレッドで）。
- 公開アドレスが決まったら、ロビーの config の `lobby-address` に書き、ホームページに「ロビー」として載せるかは別途判断。

## 反映方法（ロビー側）

`server/plugins/GameLobby/config.yml` を書き換えて保存するだけ。動いているロビーが数秒で読み直し、ゲートと表示を作り直す。
