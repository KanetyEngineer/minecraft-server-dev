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

1. [Temurin](https://adoptium.net/) の JDK 21 以上をインストールする
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
   Minecraft のバージョンは、Fabric API と FabricProxy-Lite が対応している最新のリリース版が自動で選ばれる。固定したいときは `-McVersion 1.21.8` のように指定する。
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

Velocity のコンソールからも同じコマンドが使える。

## c1 と lobby の奈落ワールド

どちらも超平坦の「The Void」と同じ設定で生成するので、MOD なしで中央 (0, 0) 付近に 33×33 の石の足場だけができる。
初回起動後、足場の上で `/setworldspawn` を実行してスポーン地点を合わせる（バックエンドの鯖のコンソールで自分を `op` にしてから）。
