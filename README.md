# minecraft-server-dev

Velocity プロキシと Fabric サーバー4台（lobby / s1 / c1 / dev）で動く Minecraft ネットワーク。
Windows 11 の PC 1台で動かし、playit.gg 経由で外部に公開する。

| 鯖 | 稼働 | 内容 |
|---|---|---|
| lobby | 常時（プロキシと一緒に起動） | 入口。void ワールドの足場、アドベンチャーモード |
| s1 | 接続時に起動・無人5分で停止 | 通常サバイバル |
| c1 | 接続時に起動・無人5分で停止 | クリエイティブ。初期リスの足場以外は奈落 |
| dev | 管理者が任意で起動 | 開発用。管理者だけが入れる |

どの鯖からでも `/lobby` `/s1` `/c1` `/dev` で移動できる。止まっている鯖は自動で起動し、準備ができたら移動する。

## 構成

```
proxy/plugin/   NetworkCore（Velocity プラグイン: 移動コマンド・自動起動/停止）
proxy/config/   velocity.toml
servers/<鯖>/   各鯖の server.properties と FabricProxy-Lite 設定のテンプレート
scripts/        Windows 用のセットアップ・起動スクリプト
run/            実際に動かすフォルダ（setup.ps1 が作る。Git 管理外）
```

## セットアップ（Windows 11）

1. [Temurin](https://adoptium.net/) の JDK 25 以上をインストールする（Minecraft 26.x と Velocity 4.x が Java 25 を要求する。プラグインのビルドだけなら JDK 21 でもよい）
2. このリポジトリを clone する
3. プラグインをビルドする
   ```powershell
   cd proxy\plugin
   .\gradlew.bat build
   ```
   ビルドせずに、GitHub の Actions タブにある最新の実行から `network-core` の jar をダウンロードし、`proxy\plugin\build\libs\` に置いてもよい。
4. サーバー一式を用意する（EULA への同意を聞かれる）
   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts\setup.ps1
   ```
   Minecraft のバージョンは、Fabric API と FabricProxy-Lite が対応している最新のリリース版が自動で選ばれる。固定したいときは `-McVersion 26.3` のように指定する。
5. `run\proxy\plugins\network-core\config.json` の `admins` に自分の UUID を入れる（初回起動後に作られる）
6. `scripts\start-network.bat` で起動する。止めるときはそのウィンドウで `end` と打つ（全鯖を保存してから止まる）

PC にサインインしたとき自動で起動したい場合は `scripts\install-autostart.ps1` を実行する。PC がスリープすると全鯖が止まるので、電源設定でスリープを無効にしておく。

## 外部への公開（playit.gg）

1. [playit.gg](https://playit.gg/) で無料アカウントを作り、Windows 版のエージェントをインストールする
2. トンネルを作る。種類は「Minecraft Java」、ローカルのアドレスは `127.0.0.1:25565`
3. 表示されたアドレスを友だちに教える

独自ドメインを使う場合は、Cloudflare の DNS に playit.gg のアドレスを指す SRV レコード（`_minecraft._tcp.<サブドメイン>`）を追加する。

## 管理者コマンド

| コマンド | 内容 |
|---|---|
| `/network status` | 各鯖の状態と人数 |
| `/network start <鯖>` | 鯖を起動 |
| `/network stop <鯖>` | 鯖を停止（中にいる人は lobby に移る） |
| `/network cmd <鯖> <コマンド>` | 鯖のコンソールにコマンドを送る（例: `network cmd lobby whitelist add steve`）。結果は数秒間 Velocity の画面に出る |

Velocity のコンソールからも同じコマンドが使える。

## 各鯖へのコマンド送信（RCON）

各鯖は RCON を 127.0.0.1 だけで待ち受けている（lobby=31001, s1=31002, c1=31003, dev=31004。パスワードは `run\rcon.secret`）。
コマンドプロンプトから `scripts\mc.bat` で送れる。先頭の `/` は不要。

```bat
scripts\mc.bat lobby whitelist add <名前>
scripts\mc.bat all whitelist add <名前>
scripts\mc.bat s1
```

`all` にすると動いている鯖すべてに送る。コマンドを付けないと続けて入力できるモードになる（`exit` で終了）。
止まっている鯖には送れないので、先に Velocity のコンソールで `network start <鯖>` する。

## c1 と lobby の奈落ワールド

どちらも超平坦の「The Void」と同じ設定で生成するので、MOD なしで中央 (0, 0) 付近に 33×33 の石の足場だけができる。
Minecraft 26.x では、この足場だけだとスポーン地点が足場の下になり奈落に落ちる。初回起動後に次を実行して、足場を置き直してスポーン地点を固定する（lobby は足場を y=-51 に上げてある）。

```bat
scripts\mc.bat c1 forceload add -8 -8 24 24
scripts\mc.bat c1 clone -8 -61 -8 24 -61 24 -8 -51 -8
scripts\mc.bat c1 fill -8 -61 -8 24 -61 24 minecraft:air
scripts\mc.bat c1 setworldspawn 8 -50 8
scripts\mc.bat c1 gamerule respawn_radius 0
scripts\mc.bat c1 forceload remove -8 -8 24 24
```
