// Worker の通しテスト（Stripe と Mojang は偽物）。node test/run.mjs
import assert from "node:assert/strict";
import crypto from "node:crypto";
import worker from "../src/index.js";

const store = new Map();
let lists = 0;
const PASS = {
  async get(k, t) { const v = store.get(k); return v == null ? null : t === "json" ? JSON.parse(v) : v; },
  async put(k, v) { store.set(k, v); },
  async delete(k) { store.delete(k); },
  async list({ prefix }) { lists++; return { keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }; },
};
const env = { PASS, STRIPE_SECRET_KEY: "sk_test_x", ADMIN_TOKEN: "tok", PRODUCT_NAME: "SharyTech Games 参加券", GAMES_URL: "https://games.sharytech.com/", PORTAL_URL: "https://billing.stripe.com/p/login/test" };
const UUID = "069a79f4-44e9-4726-a5be-fca90e38aaf5";
const sessions = {};
const prices = [];
const itemPrices = [];
let webhookUpdates = 0;
const subs = {};
const canceled = [];
let n = 0;
globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  if (url.startsWith("https://api.mojang.com/")) {
    return /\/notch$/i.test(url) ? Response.json({ id: UUID.replaceAll("-", ""), name: "Notch" }) : new Response("", { status: 404 });
  }
  assert.equal(init.headers.authorization, "Bearer sk_test_x");
  const p = Object.fromEntries(new URLSearchParams(init.body || ""));
  if (url.endsWith("/products")) return Response.json({ id: `prod_${++n}` });
  if (url.endsWith("/prices") && !p["recurring[interval]"]) { itemPrices.push(Number(p.unit_amount)); return Response.json({ id: `price_item_${p.unit_amount}_${++n}` }); }
  if (url.endsWith("/prices")) {
    assert.equal(p["recurring[interval]"], "month");
    prices.push(Number(p.unit_amount));
    return Response.json({ id: `price_${p.unit_amount}_${++n}` });
  }
  if (url.endsWith("/webhook_endpoints")) { assert.equal(p["enabled_events[3]"], "customer.subscription.deleted"); assert.equal(p["enabled_events[4]"], "charge.refunded"); return Response.json({ id: "we_1", secret: "whsec_test" }); }
  if (url.endsWith("/webhook_endpoints/we_1")) { webhookUpdates++; return Response.json({ id: "we_1" }); }
  if (url.endsWith("/checkout/sessions") && init.method === "POST" && p.mode === "payment") {
    assert.equal(p["metadata[item]"], "koma-battle");
    assert.match(p.success_url, /\/download\?session_id=\{CHECKOUT_SESSION_ID\}$/);
    const id = `cs_test_${++n}`;
    sessions[id] = { id, url: `https://checkout.stripe.com/c/pay/${id}`, mode: "payment", status: "open", payment_status: "unpaid", metadata: { item: "koma-battle" }, payment_intent: null };
    return Response.json(sessions[id]);
  }
  if (url.endsWith("/checkout/sessions") && init.method === "POST") {
    assert.equal(p.mode, "subscription");
    assert.equal(p["subscription_data[metadata][mc_uuid]"], UUID);
    const id = `cs_test_${++n}`;
    const s = { id, url: `https://checkout.stripe.com/c/pay/${id}`, mode: "subscription", status: "open", metadata: { mc_uuid: UUID, mc_name: "Notch", plan: p["metadata[plan]"] }, payment_status: "unpaid", subscription: `sub_${n}`, created: 1790000000, livemode: false, price: p["line_items[0][price]"] };
    sessions[id] = s;
    return Response.json(s);
  }
  if (url.includes("/charges/ch_")) return Response.json({ id: "ch_1", customer: "cus_1", payment_intent: "pi_1", amount: 1500, amount_refunded: 1500 });
  if (url.includes("/subscriptions?customer=cus_1")) return Response.json({ data: Object.values(subs) });
  const inv = url.match(/\/invoices\/(in_\w+)/);
  if (inv) {
    if (url.includes("expand")) return Response.json({ error: { message: "This property cannot be expanded (payments)." } }, { status: 400 });
    return Response.json({ id: inv[1], payment_intent: inv[1] === "in_1" ? "pi_1" : "pi_other" });
  }
  const del = url.match(/\/subscriptions\/(sub_\w+)$/);
  if (del && init.method === "DELETE") { subs[del[1]].status = "canceled"; canceled.push(del[1]); return Response.json(subs[del[1]]); }
  const m = url.match(/\/checkout\/sessions\/(cs_\w+)(\?|$)/);
  if (m) return Response.json(sessions[m[1]]);
  throw new Error("unexpected fetch " + url);
};
const call = (path, init = {}) => worker.fetch(new Request("https://pass.sharytech.com" + path, init), env);
const admin = { authorization: "Bearer tok", "content-type": "application/json" };
const sign = (body, secret = "whsec_test", t = Math.floor(Date.now() / 1000)) =>
  `t=${t},v1=${crypto.createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;
const hook = (type, object, secret) => { const b = JSON.stringify({ type, data: { object } }); return call("/webhook", { method: "POST", body: b, headers: { "stripe-signature": sign(b, secret) } }); };
const form = (o) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };
const list = async () => (await (await call("/api/players", { headers: admin })).json()).players;
const buy = async (plan) => {
  const r = await call("/checkout", { method: "POST", body: form({ name: "notch", plan, agree: "1" }) });
  assert.equal(r.status, 303, plan);
  return sessions[r.headers.get("location").split("/").pop()];
};
const paid = (s) => ({ ...s, status: "complete", payment_status: "paid" });
const sub = (s, status) => ({ id: s.subscription, status, metadata: s.metadata, livemode: false, created: 1790000000 });

// 準備前
assert.match(await (await call("/")).text(), /準備中/);
assert.equal((await call("/api/players")).status, 401);

// セットアップ（既定: コンプリート 8000・各ゲーム 1500、月額）
let r = await call("/admin/setup", { method: "POST", headers: admin, body: "{}" });
const setup = await r.json();
assert.equal(setup.plans.complete.amount, 8000);
assert.equal(setup.plans.halloween.amount, 1500);
assert.equal(Object.keys(setup.plans).length, 6);
assert.deepEqual(prices, [8000, 1500, 1500, 1500, 1500, 1500]);
assert.deepEqual(itemPrices, [2000]);
assert.equal(setup.items["koma-battle"].amount, 2000);
const home = await (await call("/?plan=clash-royale")).text();
assert.match(home, /8,000円/);
assert.match(home, /1,500円/);
assert.match(home, /自動更新/);
assert.ok(home.indexOf('id="clash-royale"') < home.indexOf('id="complete"'), "選んだプランが先頭");
assert.match(home, /billing\.stripe\.com/);
// 2回目のセットアップは webhook を作らず、イベントを入れ替える
await call("/admin/setup", { method: "POST", headers: admin, body: JSON.stringify({ plans: { halloween: 1200 } }) });
assert.equal(webhookUpdates, 1);
assert.deepEqual(itemPrices, [2000], "作ってある買い切り商品は作り直さない");
r = await call("/admin/setup", { method: "POST", headers: admin, body: JSON.stringify({ plans: { nope: 100 } }) });
assert.equal(r.status, 400);

// 入力ミス
const loc = async (f) => decodeURIComponent((await call("/checkout", { method: "POST", body: form(f) })).headers.get("location"));
assert.match(await loc({ name: "Notch", plan: "halloween" }), /同意/);
assert.match(await loc({ name: "Notch", plan: "minecraft", agree: "1" }), /プランを選んで/);
assert.match(await loc({ name: "ghost_user", plan: "halloween", agree: "1" }), /見つかりません/);

// ハロウィンだけ契約 → 署名が違う webhook は拒否 → 正しい webhook で一覧に載る
const s1 = await buy("halloween");
assert.equal((await hook("checkout.session.completed", paid(s1), "whsec_wrong")).status, 400);
assert.equal((await list()).length, 0);
assert.equal((await hook("checkout.session.completed", paid(s1))).status, 200);
assert.deepEqual(await list(), [{ uuid: UUID, name: "Notch", games: ["halloween"] }]);
assert.match(await loc({ name: "Notch", plan: "halloween", agree: "1" }), /契約中/);
const chk = await (await call("/check?name=Notch")).text();
assert.match(chk, /Halloween Night: 契約中/);
assert.match(chk, /Clash Royale MC: 未契約/);

// コンプリートも契約（success ページ経由で webhook より先に登録される場合）
const s2 = await buy("complete");
sessions[s2.id] = paid(s2);
assert.match(await (await call(`/success?session_id=${s2.id}`)).text(), /全ゲーム/);
assert.deepEqual((await list())[0].games, ["halloween", "tiktok-defense", "clash-royale", "anime-umetate", "attack-on-titan"]);
// コンプリート契約中は単品を買わせない
assert.match(await loc({ name: "Notch", plan: "anime-umetate", agree: "1" }), /コンプリートプランを契約中/);

// 支払いの再試行中（past_due）は入れたまま、unpaid になったら外れる
await hook("customer.subscription.updated", sub(s2, "past_due"));
assert.equal((await list())[0].games.length, 5);
await hook("customer.subscription.updated", sub(s2, "unpaid"));
assert.deepEqual((await list())[0].games, ["halloween"]);
// 支払いが戻ったら復活
await hook("customer.subscription.updated", sub(s2, "active"));
assert.equal((await list())[0].games.length, 5);

// コンプリートを解約（期間が終わって deleted）→ ハロウィンだけ残る
await hook("customer.subscription.deleted", sub(s2, "canceled"));
assert.deepEqual(await list(), [{ uuid: UUID, name: "Notch", games: ["halloween"] }]);
// ハロウィンも解約 → 誰もいない
await hook("customer.subscription.deleted", sub(s1, "canceled"));
assert.deepEqual(await list(), []);
// 知らない契約の終了は無視
assert.equal((await hook("customer.subscription.deleted", { id: "sub_unknown", status: "canceled" })).status, 200);

// 全額返金で、その支払いの契約だけ Stripe 側でも解約して外す
const s3 = await buy("halloween");
await hook("checkout.session.completed", paid(s3));
const s4 = await buy("clash-royale");
await hook("checkout.session.completed", paid(s4));
subs[s3.subscription] = { id: s3.subscription, status: "active", metadata: s3.metadata, latest_invoice: "in_1" };
subs[s4.subscription] = { id: s4.subscription, status: "active", metadata: s4.metadata, latest_invoice: "in_2" };
assert.deepEqual((await list())[0].games, ["halloween", "clash-royale"]);
// 一部返金はそのまま
await hook("charge.refunded", { id: "ch_1", customer: "cus_1", payment_intent: "pi_1", amount: 1500, amount_refunded: 500 });
assert.deepEqual(canceled, []);
await hook("charge.refunded", { id: "ch_1", customer: "cus_1", payment_intent: "pi_1", amount: 1500, amount_refunded: 1500 });
assert.deepEqual(canceled, [s3.subscription]);
assert.deepEqual((await list())[0].games, ["clash-royale"]);
// チャージバックも同じ（dispute は charge の id を持つ）
subs[s4.subscription].latest_invoice = "in_1";
await hook("charge.dispute.created", { id: "dp_1", charge: "ch_1" });
assert.deepEqual(canceled, [s3.subscription, s4.subscription]);
assert.deepEqual(await list(), []);

// 手動の追加・削除
assert.equal((await (await call("/admin/grant", { method: "POST", headers: admin, body: JSON.stringify({ name: "Notch", plan: "clash-royale" }) })).json()).plan, "clash-royale");
assert.deepEqual((await list())[0].games, ["clash-royale"]);
await call("/admin/revoke", { method: "POST", headers: admin, body: JSON.stringify({ name: "Notch" }) });
assert.deepEqual(await list(), []);

// 普段の一覧は list を使わない。?full=1 だけが list する
const before = lists;
await list(); await list();
assert.equal(lists, before);
await call("/api/players?full=1", { headers: admin });
assert.equal(lists, before + 1);

assert.match(await (await call("/legal")).text(), /1か月ごとの自動更新/);

// ---------- 買い切りのダウンロード（コマバトル） ----------
const files = { "/koma-battle/koma-battle-rpg-1.0.1.zip.001": "AAA", "/koma-battle/koma-battle-rpg-1.0.1.zip.002": "BB", "/koma-battle/koma-battle-rpg-1.0.1.zip.003": "C" };
env.ASSETS = { fetch: async (req) => { const b = files[new URL(req.url).pathname]; return b ? new Response(b, { headers: { "content-length": String(b.length) } }) : new Response("", { status: 404 }); } };
const bp = await (await call("/buy?item=koma-battle")).text();
assert.match(bp, /2,000円/);
assert.match(bp, /返品・返金はできません/);
assert.match(decodeURIComponent((await call("/buy", { method: "POST", body: form({ item: "koma-battle" }) })).headers.get("location")), /同意/);
r = await call("/buy", { method: "POST", body: form({ item: "koma-battle", agree: "1" }) });
assert.equal(r.status, 303);
const ks = sessions[r.headers.get("location").split("/").pop()];
// 未払いではリンクを出さない
assert.match(await (await call(`/download?session_id=${ks.id}`)).text(), /ダウンロードできません/);
assert.match(await (await call(`/download?session_id=cs_bad'x`)).text(), /ダウンロードできません/);
// 支払い済み → 署名付きリンク → 分割をつなげて返す
sessions[ks.id] = { ...ks, status: "complete", payment_status: "paid", payment_intent: { latest_charge: { id: "ch_k", refunded: false, disputed: false } } };
const dl = await (await call(`/download?session_id=${ks.id}`)).text();
const link = dl.match(/href="(\/file\/[^"]+)"/)[1].replaceAll("&amp;", "&");
r = await call(link);
assert.equal(r.status, 200);
assert.equal(await r.text(), "AAABBC");
assert.equal(r.headers.get("content-length"), "6");
assert.match(r.headers.get("content-disposition"), /koma-battle-rpg-1\.0\.1\.zip/);
// 署名なし・改ざん・期限切れは拒否。アセットへの直接アクセスも Worker が 404
assert.equal((await call("/file/koma-battle/x.zip")).status, 403);
assert.equal((await call(link.replace(/sig=./, "sig=0"))).status, 403);
assert.equal((await call(link.replace(/exp=\d+/, "exp=1000"))).status, 403);
assert.equal((await call("/koma-battle/koma-battle-rpg-1.0.1.zip.001")).status, 404);
// 返金・チャージバックされたら出さない
sessions[ks.id].payment_intent.latest_charge.refunded = true;
assert.match(await (await call(`/download?session_id=${ks.id}`)).text(), /ダウンロードできません/);
// 分割していないファイルならそのまま
files["/koma-battle/koma-battle-rpg-1.0.1.zip"] = "WHOLE";
assert.equal(await (await call(link)).text(), "WHOLE");
// 月額の webhook の流れに買い切りの完了が来ても名簿は変わらない
await hook("checkout.session.completed", { ...sessions[ks.id], mode: "payment" });
assert.deepEqual(await list(), []);
console.log("worker: all tests passed");
