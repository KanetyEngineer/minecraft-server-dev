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
let webhookUpdates = 0;
let n = 0;
globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  if (url.startsWith("https://api.mojang.com/")) {
    return /\/notch$/i.test(url) ? Response.json({ id: UUID.replaceAll("-", ""), name: "Notch" }) : new Response("", { status: 404 });
  }
  assert.equal(init.headers.authorization, "Bearer sk_test_x");
  const p = Object.fromEntries(new URLSearchParams(init.body || ""));
  if (url.endsWith("/products")) return Response.json({ id: `prod_${++n}` });
  if (url.endsWith("/prices")) {
    assert.equal(p["recurring[interval]"], "month");
    prices.push(Number(p.unit_amount));
    return Response.json({ id: `price_${p.unit_amount}_${++n}` });
  }
  if (url.endsWith("/webhook_endpoints")) { assert.equal(p["enabled_events[3]"], "customer.subscription.deleted"); return Response.json({ id: "we_1", secret: "whsec_test" }); }
  if (url.endsWith("/webhook_endpoints/we_1")) { webhookUpdates++; return Response.json({ id: "we_1" }); }
  if (url.endsWith("/checkout/sessions") && init.method === "POST") {
    assert.equal(p.mode, "subscription");
    assert.equal(p["subscription_data[metadata][mc_uuid]"], UUID);
    const id = `cs_test_${++n}`;
    const s = { id, url: `https://checkout.stripe.com/c/pay/${id}`, mode: "subscription", status: "open", metadata: { mc_uuid: UUID, mc_name: "Notch", plan: p["metadata[plan]"] }, payment_status: "unpaid", subscription: `sub_${n}`, created: 1790000000, livemode: false, price: p["line_items[0][price]"] };
    sessions[id] = s;
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
const home = await (await call("/?plan=clash-royale")).text();
assert.match(home, /8,000円/);
assert.match(home, /1,500円/);
assert.match(home, /自動更新/);
assert.ok(home.indexOf('id="clash-royale"') < home.indexOf('id="complete"'), "選んだプランが先頭");
assert.match(home, /billing\.stripe\.com/);
// 2回目のセットアップは webhook を作らず、イベントを入れ替える
await call("/admin/setup", { method: "POST", headers: admin, body: JSON.stringify({ plans: { halloween: 1200 } }) });
assert.equal(webhookUpdates, 1);
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
console.log("worker: all tests passed");
