// Worker の通しテスト（Stripe と Mojang は偽物）。node test/run.mjs
import assert from "node:assert/strict";
import crypto from "node:crypto";
import worker from "../src/index.js";

const store = new Map();
const PASS = {
  async get(k, t) { const v = store.get(k); return v == null ? null : t === "json" ? JSON.parse(v) : v; },
  async put(k, v) { store.set(k, v); },
  async delete(k) { store.delete(k); },
  async list({ prefix }) { return { keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }; },
};
const env = { PASS, STRIPE_SECRET_KEY: "sk_test_x", ADMIN_TOKEN: "tok", PRODUCT_NAME: "SharyTech Games 参加券", GAMES_URL: "https://games.sharytech.com/" };
const UUID = "069a79f4-44e9-4726-a5be-fca90e38aaf5";
const sessions = {};
globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  if (url.startsWith("https://api.mojang.com/")) {
    return url.endsWith("/Notch") || url.endsWith("/notch") ? Response.json({ id: UUID.replaceAll("-", ""), name: "Notch" }) : new Response("", { status: 404 });
  }
  assert.equal(init.headers.authorization, "Bearer sk_test_x");
  const p = Object.fromEntries(new URLSearchParams(init.body || ""));
  if (url.endsWith("/products")) return Response.json({ id: "prod_1" });
  if (url.endsWith("/prices")) { assert.equal(p.unit_amount, "500"); return Response.json({ id: "price_1" }); }
  if (url.endsWith("/webhook_endpoints")) { assert.equal(p["enabled_events[0]"], "checkout.session.completed"); return Response.json({ id: "we_1", secret: "whsec_test" }); }
  if (url.endsWith("/checkout/sessions") && init.method === "POST") {
    assert.equal(p["line_items[0][price]"], "price_1");
    assert.equal(p["metadata[mc_uuid]"], UUID);
    const s = { id: "cs_test_1", url: "https://checkout.stripe.com/c/pay/cs_test_1", metadata: { mc_uuid: UUID, mc_name: "Notch" }, payment_status: "unpaid", payment_intent: "pi_1", amount_total: 500, created: 1790000000, livemode: false };
    sessions[s.id] = s;
    return Response.json(s);
  }
  const m = url.match(/\/checkout\/sessions\/(cs_\w+)$/);
  if (m) return Response.json(sessions[m[1]]);
  throw new Error("unexpected fetch " + url);
};
const call = (path, init = {}) => worker.fetch(new Request("https://pass.sharytech.com" + path, init), env);
const admin = { authorization: "Bearer tok", "content-type": "application/json" };
const sign = (body, secret = "whsec_test", t = Math.floor(Date.now() / 1000)) =>
  `t=${t},v1=${crypto.createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;
const form = (o) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };

// 準備前: 買えない
let r = await call("/");
assert.match(await r.text(), /準備中/);
assert.equal((await call("/api/players")).status, 401);
assert.equal((await call("/api/players", { headers: { authorization: "Bearer nope" } })).status, 401);

// セットアップ
r = await call("/admin/setup", { method: "POST", headers: admin, body: JSON.stringify({ amount: 500 }) });
assert.deepEqual(await r.json(), { mode: "test", priceId: "price_1", amount: 500, currency: "jpy", webhookId: "we_1" });
r = await call("/");
const home = await r.text();
assert.match(home, /500円/);
assert.match(home, /テストモード/);
assert.match(home, /NOT AN OFFICIAL MINECRAFT PRODUCT/);

// 入力ミス
r = await call("/checkout", { method: "POST", body: form({ name: "Notch" }) });
assert.match(decodeURIComponent(r.headers.get("location")), /同意/);
r = await call("/checkout", { method: "POST", body: form({ name: "ghost_user", agree: "1" }) });
assert.match(decodeURIComponent(r.headers.get("location")), /見つかりません/);
r = await call("/checkout", { method: "POST", body: form({ name: "a<b>", agree: "1" }) });
assert.match(decodeURIComponent(r.headers.get("location")), /英数字/);

// 購入 → Stripe へ
r = await call("/checkout", { method: "POST", body: form({ name: "notch", agree: "1" }) });
assert.equal(r.status, 303);
assert.equal(r.headers.get("location"), "https://checkout.stripe.com/c/pay/cs_test_1");

// 署名が違う webhook は拒否
const done = JSON.stringify({ type: "checkout.session.completed", data: { object: { ...sessions.cs_test_1, payment_status: "paid" } } });
assert.equal((await call("/webhook", { method: "POST", body: done, headers: { "stripe-signature": sign(done, "whsec_wrong") } })).status, 400);
assert.equal((await call("/webhook", { method: "POST", body: done, headers: { "stripe-signature": sign(done, "whsec_test", 1000) } })).status, 400);
assert.equal((await (await call("/api/players", { headers: admin })).json()).players.length, 0);

// 正しい webhook → 一覧に載る
assert.equal((await call("/webhook", { method: "POST", body: done, headers: { "stripe-signature": sign(done) } })).status, 200);
assert.deepEqual((await (await call("/api/players", { headers: admin })).json()).players, [{ uuid: UUID, name: "Notch" }]);
assert.match(await (await call("/check?name=Notch")).text(), /購入済み/);

// 2回目は買わせない
r = await call("/checkout", { method: "POST", body: form({ name: "Notch", agree: "1" }) });
assert.match(decodeURIComponent(r.headers.get("location")), /購入済み/);

// success ページ（webhook 前に戻ってきた場合も登録される）
store.clear(); await call("/admin/setup", { method: "POST", headers: admin, body: JSON.stringify({ amount: 500 }) });
sessions.cs_test_1.payment_status = "paid";
assert.match(await (await call("/success?session_id=cs_test_1")).text(), /Notch/);
assert.equal((await (await call("/api/players", { headers: admin })).json()).players.length, 1);

// 一部返金はそのまま、全額返金で外れる
const refund = (amt) => JSON.stringify({ type: "charge.refunded", data: { object: { payment_intent: "pi_1", amount: 500, amount_refunded: amt } } });
let b = refund(100);
await call("/webhook", { method: "POST", body: b, headers: { "stripe-signature": sign(b) } });
assert.equal((await (await call("/api/players", { headers: admin })).json()).players.length, 1);
b = refund(500);
await call("/webhook", { method: "POST", body: b, headers: { "stripe-signature": sign(b) } });
assert.equal((await (await call("/api/players", { headers: admin })).json()).players.length, 0);

// 手動の追加・削除
r = await call("/admin/grant", { method: "POST", headers: admin, body: JSON.stringify({ name: "Notch", note: "test" }) });
assert.equal((await r.json()).granted.uuid, UUID);
assert.equal((await (await call("/api/players", { headers: admin })).json()).players.length, 1);
await call("/admin/revoke", { method: "POST", headers: admin, body: JSON.stringify({ name: "Notch" }) });
assert.equal((await (await call("/api/players", { headers: admin })).json()).players.length, 0);

assert.match(await (await call("/legal")).text(), /請求があった場合は遅滞なく開示します/);
console.log("worker: all tests passed");
