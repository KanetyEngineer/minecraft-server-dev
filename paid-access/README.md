# 参加券（Stripe 決済 → ホワイトリスト）

games.sharytech.com のゲーム鯖（ハロウィン・TikTok Defense・Clash Royale MC・アニメ技 埋め立て）を、参加券を買った人だけ入れるようにする仕組み。Kanety SMP は対象外で、今まで通り誰でも入れる。

```
プレイヤー ─▶ pass.sharytech.com（worker/）─▶ Stripe Checkout
                     ▲   │ webhook で購入者を KV に記録
                     │   ▼
PC の sync/sync.js ──┘ 30秒ごとに /api/players を読む
   ├─ 各ゲーム鯖の whitelist.json に足し引き → RCON で whitelist reload
   └─ ロビーの plugins/GameLobby/paid-players.txt を書く → 未購入の人はゲートで購入ページを案内
```

## worker/（Cloudflare Worker `sharytech-pass`）

| パス | 内容 |
| --- | --- |
| `/` | 購入ページ。Java 版のユーザー名を入れると Mojang で実在を確かめてから Stripe へ |
| `/success` | 購入完了。webhook より先に戻ってきても、ここで支払い済みなら登録する |
| `/legal` | 特定商取引法に基づく表記（`SELLER_*` が空の項目は「請求があれば開示」） |
| `/check?name=` | 購入済みか確かめる |
| `/webhook` | Stripe から。署名を確かめ、購入で登録、全額返金・チャージバックで削除 |
| `/api/players` | 購入者一覧（`Authorization: Bearer ADMIN_TOKEN`） |
| `/admin/setup` | Stripe に商品・価格・webhook を作る。`{"amount":500}`。価格を変えるときも同じ |
| `/admin/grant` `/admin/revoke` | 手動で入れる・外す。`{"name":"…"}` |

最初の設定（PC の `paid-access\worker` で）:

1. `npm install`
2. `npx wrangler kv namespace create PASS` → 出た id を `wrangler.toml` に書く
3. `npx wrangler secret put ADMIN_TOKEN`（長いランダム文字列）
4. `npx wrangler secret put STRIPE_SECRET_KEY`（まずテスト用 `sk_test_…`）
5. `npx wrangler deploy`
6. `curl -X POST https://pass.sharytech.com/admin/setup -H "Authorization: Bearer <ADMIN_TOKEN>" -d "{\"amount\":500}"`

本番に切り替えるときは 4 で `sk_live_…` を入れ直して 6 をもう一度（テストと本番で設定は別々に保存される）。

テスト: `npm test`（Stripe と Mojang は偽物）

## sync/（PC で常時動かす）

`config.example.json` を `config.json` にコピーし、`token`（ADMIN_TOKEN）、各鯖のフォルダ・RCON ポート・パスワードを書いて `start-sync.bat`。

- `enforce: false` の鯖は名簿を用意するだけで、まだ誰でも入れる。`true` にすると次の周回で `whitelist on`
- 足し引きするのは自分で足した人だけ（`sync-state.json` に記録）。手で足した人と OP には触らない
- API が失敗したときは何も変えない

テスト: `node test/run.js`（偽の API と RCON 鯖）

## ロビー（game-lobby）

`config.yml` の行き先に `paid: true` を付けると、`paid-players.txt` に載っていない人（OP は除く）をそのゲートで止め、購入ページのリンクを出す。ファイルが無い間は誰も止めない。SMP には付けない。

直接アドレス（rails-backups.tun.ply.gg など）で入ろうとした未購入の人は、バニラの「ホワイトリストに登録されていません」で切断される。
