# 参加券（Stripe の月額サブスクリプション → ホワイトリスト）

games.sharytech.com のゲーム鯖（ハロウィン・TikTok Defense・Clash Royale MC・アニメ技 埋め立て・巨人討伐）を、月額の参加券を契約中の人だけ入れるようにする仕組み。Kanety SMP は対象外で、今まで通り誰でも入れる。

プランは各ゲーム（既定 月1,500円）と、全ゲームのコンプリートプラン（既定 月8,000円）。制限もゲームごとにかける（sync の `enforce` とロビーの `paid` を行き先ごとに）。

```
プレイヤー ─▶ pass.sharytech.com（worker/）─▶ Stripe Checkout（月額）
                     ▲   │ webhook で契約・解約・支払い失敗を KV に反映
                     │   ▼
PC の sync/sync.js ──┘ 30秒ごとに /api/players（uuid・名前・入れるゲーム）を読む
   ├─ 各ゲーム鯖の whitelist.json に、その鯖を契約している人だけ足し引き → RCON で whitelist reload
   └─ ロビーの plugins/GameLobby/paid-players.txt（「uuid ゲーム,ゲーム」）を書く → 未契約のゲートでは申し込みページを案内
```

## worker/（Cloudflare Worker `sharytech-pass`）

| パス | 内容 |
| --- | --- |
| `/` | 申し込みページ。`?plan=<id>` でそのプランを先頭に出す。Java 版のユーザー名を Mojang で確かめてから Stripe へ |
| `/success` | 申し込み完了。webhook より先に戻ってきても、ここで支払い済みなら登録する |
| `/legal` | 特定商取引法に基づく表記（自動更新・解約の条件入り。`SELLER_*` が空の項目は「請求があれば開示」） |
| `/check?name=` | ゲームごとの契約状況 |
| `/webhook` | Stripe から。署名を確かめ、契約で登録、解約（期間終了）・支払い失敗（unpaid など）で削除、再開で復活。past_due（再試行中）は入れたまま。全額返金・チャージバックはその支払いの契約を Stripe 側でも今すぐ解約して削除 |
| `/api/players` | 契約者一覧 `[{uuid,name,games}]`（`Authorization: Bearer ADMIN_TOKEN`） |
| `/admin/setup` | Stripe に月額の商品・価格と webhook を作る。`{}` で既定の値段、`{"plans":{"complete":8000,"halloween":1500}}` で書いたプランだけ作り直す |
| `/admin/grant` `/admin/revoke` | 手動で入れる・外す。`{"name":"…","plan":"halloween"}`（plan を省くと grant は complete、revoke は全部） |

最初の設定（PC の `paid-access\worker` で）:

1. `npm install`
2. `npx wrangler kv namespace create PASS` → 出た id を `wrangler.toml` に書く
3. `npx wrangler secret put ADMIN_TOKEN`（長いランダム文字列）
4. `powershell -ExecutionPolicy Bypass -File .\set-stripe-key.ps1`（Stripe のシークレットキー。まずテスト用 `sk_test_…`）
5. `npx wrangler deploy`
6. `curl -X POST https://pass.sharytech.com/admin/setup -H "Authorization: Bearer <ADMIN_TOKEN>" -d "{}"`
7. Stripe の 設定 → Billing → カスタマーポータル を有効にし、ログインリンクを `wrangler.toml` の `PORTAL_URL` に書いて再デプロイ（利用者が自分で解約・カード変更できるように）

ゲームを足すときは `worker/src/index.js` の `GAMES` に足して（id はロビーの行き先と sync の `servers[].id` に揃える）デプロイし、`{"plans":{"<id>":1500}}` で setup を呼ぶ。コンプリートには自動で含まれる。

本番に切り替えるときは 4 で `sk_live_…` を入れ直して 6・7 をもう一度（テストと本番で設定は別々に保存される）。全額返金すると、その支払いの契約は自動で今すぐ解約され名簿から外れる（一部返金はそのまま）。受け取るイベントを変えたあとは `{"plans":{}}` で setup を呼ぶと、価格を作らずに webhook のイベントだけ入れ替えられる。

テスト: `npm test`（Stripe と Mojang は偽物）

## sync/（PC で常時動かす）

`config.example.json` を `config.json` にコピーし、`token`（ADMIN_TOKEN）、各鯖のフォルダ・RCON ポート・パスワードを書いて `start-sync.bat`。

- 各鯖には、その鯖の `id` を契約している人（コンプリートを含む）だけを入れる
- `enforce: false` の鯖は名簿を用意するだけで、まだ誰でも入れる。`true` にすると次の周回で `whitelist on`。ゲームごとに切り替えられる
- 足し引きするのは自分で足した人だけ（`sync-state.json` に記録）。手で足した人と OP には触らない
- API が失敗したときは何も変えない

テスト: `node test/run.js`（偽の API と RCON 鯖）

## ロビー（game-lobby）

`config.yml` の行き先に `paid: true` を付けると、`paid-players.txt` でその行き先を契約していない人（OP は除く）をそのゲートで止め、そのゲームのプランを先頭にした申し込みページのリンクを出す。ファイルが無い間は誰も止めない。SMP には付けない。sync の `enforce` と同じゲームに付ける。

直接アドレス（rails-backups.tun.ply.gg など）で入ろうとした未契約の人は、バニラの「ホワイトリストに登録されていません」で切断される。
