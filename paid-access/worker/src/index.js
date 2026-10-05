// SharyTech Games の参加券（Stripe 決済）を受け付ける Cloudflare Worker。
// 決済が終わったプレイヤーを KV に記録し、PC の sync スクリプトが /api/players を読んで各ゲーム鯖のホワイトリストに入れる。
//
// KV (PASS):
//   p:<uuid>      → {"uuid","name","paidAt","session","pi","amount","mode","note"}
//   pi:<id>       → uuid（返金・チャージバックのときに消すため）
//   cfg:<mode>    → {"priceId","amount","currency","webhookId","webhookSecret"}（mode は test / live）
// Secrets: STRIPE_SECRET_KEY（sk_test_… か sk_live_…）, ADMIN_TOKEN（PC の sync と管理用）
// Vars: SITE_URL, GAMES_URL, PRODUCT_NAME, SELLER_*（特定商取引法の表記）

const STRIPE = "https://api.stripe.com/v1";
const NAME_RE = /^[A-Za-z0-9_]{3,16}$/;
const EVENTS = ["checkout.session.completed", "checkout.session.async_payment_succeeded", "charge.refunded", "charge.dispute.created"];

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    try {
      if (req.method === "GET" && url.pathname === "/") return page(env, await home(env, url));
      if (req.method === "POST" && url.pathname === "/checkout") return await checkout(req, env, url);
      if (req.method === "GET" && url.pathname === "/success") return page(env, await success(env, url));
      if (req.method === "GET" && url.pathname === "/legal") return page(env, legal(env));
      if (req.method === "GET" && url.pathname === "/check") return await check(env, url);
      if (req.method === "POST" && url.pathname === "/webhook") return await webhook(req, env);
      if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/admin/")) {
        if (!authorized(req, env)) return json({ error: "unauthorized" }, 401);
        if (req.method === "GET" && url.pathname === "/api/players") return json({ players: await players(env) });
        if (req.method === "POST" && url.pathname === "/admin/setup") return await setup(req, env, url);
        if (req.method === "POST" && url.pathname === "/admin/grant") return await grant(req, env);
        if (req.method === "POST" && url.pathname === "/admin/revoke") return await revoke(req, env);
      }
      return new Response("Not found", { status: 404 });
    } catch (e) {
      console.error(e.stack || e);
      return page(env, `<h1>エラーが起きました</h1><p>時間をおいてもう一度お試しください。</p>`, 500);
    }
  },
};

// ---------- pages ----------

function mode(env) {
  return String(env.STRIPE_SECRET_KEY || "").startsWith("sk_live_") ? "live" : "test";
}

async function config(env) {
  return (await env.PASS.get(`cfg:${mode(env)}`, "json")) || null;
}

function yen(amount, currency) {
  return currency === "jpy" ? `${amount.toLocaleString("ja-JP")}円` : `${(amount / 100).toFixed(2)} ${currency.toUpperCase()}`;
}

async function home(env, url) {
  const cfg = await config(env);
  const err = url.searchParams.get("error");
  const price = cfg ? yen(cfg.amount, cfg.currency) : "準備中";
  return `
<h1>${esc(env.PRODUCT_NAME)}</h1>
<p class="lead">ゲームロビーからハロウィン・ナイト、TikTok Defense、Clash Royale MC、アニメ技 埋め立てに入るための参加券です。</p>
<div class="card">
  <div class="price">${price}<span>（買い切り・税込）</span></div>
  <ul>
    <li>1回の購入で、上の4つのゲーム鯖にずっと入れます</li>
    <li>決済が終わると1分ほどで自動的にホワイトリストに入ります</li>
    <li>Kanety SMP は今まで通り無料です（参加券は要りません）</li>
    <li>Minecraft Java 版の正規アカウントが必要です</li>
  </ul>
  ${mode(env) === "test" ? `<p class="test">テストモードです。実際のお金は動きません（カード 4242 4242 4242 4242）。</p>` : ""}
  ${err ? `<p class="err">${esc(err)}</p>` : ""}
  <form method="post" action="/checkout">
    <label>Minecraft Java 版のユーザー名
      <input name="name" required pattern="[A-Za-z0-9_]{3,16}" maxlength="16" autocomplete="off" placeholder="例: kanetyyy" value="${esc(url.searchParams.get("name") || "")}">
    </label>
    <label class="agree"><input type="checkbox" name="agree" value="1" required> <a href="/legal">特定商取引法に基づく表記</a>と、デジタル商品のため購入後の返金は原則できないことに同意します</label>
    <button ${cfg ? "" : "disabled"}>購入へ進む（Stripe）</button>
  </form>
  <p class="small">購入済みか確かめる: <a href="/check?name=">/check?name=ユーザー名</a></p>
</div>`;
}

async function checkout(req, env, url) {
  const form = await req.formData();
  const name = String(form.get("name") || "").trim();
  const back = (msg) => Response.redirect(`${url.origin}/?error=${encodeURIComponent(msg)}&name=${encodeURIComponent(name)}`, 303);
  if (!form.get("agree")) return back("表記と返金の条件への同意が必要です");
  if (!NAME_RE.test(name)) return back("ユーザー名は英数字と _ の3〜16文字です");
  const cfg = await config(env);
  if (!cfg) return back("まだ販売の準備中です");
  const prof = await mojang(name);
  if (!prof) return back(`「${name}」という Java 版のアカウントが見つかりませんでした`);
  if (await env.PASS.get(`p:${prof.uuid}`)) return back(`${prof.name} さんは購入済みです。そのままゲームに入れます`);

  const s = await stripe(env, "POST", "/checkout/sessions", {
    mode: "payment",
    "line_items[0][price]": cfg.priceId,
    "line_items[0][quantity]": "1",
    client_reference_id: prof.uuid,
    "metadata[mc_uuid]": prof.uuid,
    "metadata[mc_name]": prof.name,
    "payment_intent_data[metadata][mc_uuid]": prof.uuid,
    "payment_intent_data[metadata][mc_name]": prof.name,
    "payment_intent_data[description]": `${env.PRODUCT_NAME} (${prof.name})`,
    locale: "ja",
    success_url: `${url.origin}/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${url.origin}/?name=${encodeURIComponent(prof.name)}`,
  });
  return Response.redirect(s.url, 303);
}

async function success(env, url) {
  const id = url.searchParams.get("session_id") || "";
  let name = "";
  if (/^cs_[A-Za-z0-9_]+$/.test(id)) {
    const s = await stripe(env, "GET", `/checkout/sessions/${id}`);
    name = s.metadata?.mc_name || "";
    // webhook より先に戻ってきたときのため、支払い済みならここでも登録する
    if (s.payment_status === "paid") await record(env, s);
  }
  return `
<h1>ご購入ありがとうございます</h1>
<div class="card">
  <p>${name ? `<b>${esc(name)}</b> さんを` : ""}ホワイトリストに登録しました。1分ほどで各ゲーム鯖に反映されます。</p>
  <p>ゲームロビーに入って、遊びたいゲームのゲートに乗ってください。</p>
  <p><a class="btn" href="${esc(env.GAMES_URL)}">入り方を見る（games.sharytech.com）</a></p>
  <p class="small">入れないときは Discord SharyTech でお知らせください。</p>
</div>`;
}

function legal(env) {
  const row = (k, v) => `<tr><th>${k}</th><td>${esc(v)}</td></tr>`;
  const ask = "請求があった場合は遅滞なく開示します";
  return `
<h1>特定商取引法に基づく表記</h1>
<div class="card"><table class="legal">
${row("販売事業者", env.SELLER_NAME || ask)}
${row("運営責任者", env.SELLER_MANAGER || env.SELLER_NAME || ask)}
${row("所在地", env.SELLER_ADDRESS || ask)}
${row("電話番号", env.SELLER_PHONE || ask)}
${row("メールアドレス", env.SELLER_EMAIL || ask)}
${row("販売価格", "購入ページに表示（税込）")}
${row("商品代金以外の必要料金", "インターネット接続料金・通信料金はお客様の負担となります")}
${row("支払方法", "クレジットカードほか Stripe が対応する方法")}
${row("支払時期", "購入手続きの完了時")}
${row("引渡時期", "決済完了後すぐ（通常1分以内にホワイトリストへ登録）")}
${row("返品・キャンセル", "デジタル商品の性質上、購入後の返金・キャンセルはお受けできません。ただしサービスを提供できない場合は個別に対応します")}
${row("動作環境", "Minecraft: Java Edition の正規アカウント（各ゲームが指定する版）")}
</table>
<p class="small">NOT AN OFFICIAL MINECRAFT PRODUCT. NOT APPROVED BY OR ASSOCIATED WITH MOJANG OR MICROSOFT.</p>
<p><a href="/">戻る</a></p></div>`;
}

async function check(env, url) {
  const name = String(url.searchParams.get("name") || "").trim();
  if (!NAME_RE.test(name)) return page(env, `<h1>購入確認</h1><div class="card"><form><input name="name" placeholder="ユーザー名" required> <button>確認</button></form></div>`);
  const prof = await mojang(name);
  const ok = prof && (await env.PASS.get(`p:${prof.uuid}`));
  return page(env, `<h1>購入確認</h1><div class="card"><p>${esc(prof?.name || name)}: ${ok ? "購入済みです（ゲーム鯖に入れます）" : "まだ購入されていません"}</p><p><a href="/">参加券のページへ</a></p></div>`);
}

function page(env, body, status = 200) {
  const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(env.PRODUCT_NAME)}</title><style>
:root{--bg:#0f1115;--fg:#e8e8ea;--muted:#9aa0aa;--card:#181b22;--line:#2a2f3a;--accent:#4ade80}
@media (prefers-color-scheme:light){:root{--bg:#f6f7f9;--fg:#15171c;--muted:#5b6170;--card:#fff;--line:#dde1e8;--accent:#16a34a}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.7 system-ui,"Hiragino Sans","Noto Sans JP",sans-serif}
main{max-width:640px;margin:0 auto;padding:32px 16px}h1{font-size:24px;margin:0 0 12px}.lead{color:var(--muted)}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:20px;margin-top:16px}
.price{font-size:32px;font-weight:700}.price span{font-size:14px;color:var(--muted);font-weight:400}
label{display:block;margin:14px 0}input[name=name]{display:block;width:100%;box-sizing:border-box;margin-top:6px;padding:10px;border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--fg);font-size:16px}
.agree{font-size:14px}button,.btn{display:inline-block;background:var(--accent);color:#000;border:0;border-radius:8px;padding:12px 20px;font-size:16px;font-weight:700;cursor:pointer;text-decoration:none}
button[disabled]{opacity:.5;cursor:default}a{color:var(--accent)}.small{font-size:13px;color:var(--muted)}
.err{color:#f87171}.test{color:#facc15;font-size:14px}.legal{border-collapse:collapse;width:100%;font-size:14px}
.legal th,.legal td{border-bottom:1px solid var(--line);padding:8px;text-align:left;vertical-align:top}.legal th{white-space:nowrap;color:var(--muted)}
footer{margin-top:32px;font-size:12px;color:var(--muted)}</style></head><body><main>${body}
<footer><a href="/legal">特定商取引法に基づく表記</a> · <a href="${esc(env.GAMES_URL)}">SharyTech Games</a><br>NOT AN OFFICIAL MINECRAFT PRODUCT. NOT APPROVED BY OR ASSOCIATED WITH MOJANG OR MICROSOFT.</footer>
</main></body></html>`;
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

// ---------- webhook ----------

async function webhook(req, env) {
  const cfg = await config(env);
  const body = await req.text();
  if (!cfg?.webhookSecret || !(await verify(body, req.headers.get("stripe-signature") || "", cfg.webhookSecret))) {
    return json({ error: "bad signature" }, 400);
  }
  const ev = JSON.parse(body);
  const o = ev.data.object;
  if (ev.type === "checkout.session.completed" || ev.type === "checkout.session.async_payment_succeeded") {
    if (o.payment_status === "paid") await record(env, o);
  } else if (ev.type === "charge.refunded" || ev.type === "charge.dispute.created") {
    // 全額返金とチャージバックのときだけ外す（一部返金はそのまま）
    const full = ev.type === "charge.dispute.created" || o.amount_refunded >= o.amount;
    const uuid = o.payment_intent && (await env.PASS.get(`pi:${o.payment_intent}`));
    if (full && uuid) await env.PASS.delete(`p:${uuid}`);
  }
  return json({ received: true });
}

async function record(env, s) {
  const uuid = s.metadata?.mc_uuid;
  if (!uuid) return;
  const pi = typeof s.payment_intent === "string" ? s.payment_intent : s.payment_intent?.id;
  const prev = await env.PASS.get(`p:${uuid}`, "json");
  if (prev?.session === s.id) return;
  await env.PASS.put(`p:${uuid}`, JSON.stringify({
    uuid, name: s.metadata.mc_name, paidAt: new Date((s.created || Date.now() / 1000) * 1000).toISOString(),
    session: s.id, pi: pi || null, amount: s.amount_total, mode: s.livemode ? "live" : "test",
  }));
  if (pi) await env.PASS.put(`pi:${pi}`, uuid);
}

async function verify(body, header, secret) {
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=")).filter((p) => p.length === 2).map(([k, v]) => [k, v]));
  const sigs = header.split(",").filter((p) => p.startsWith("v1=")).map((p) => p.slice(3));
  const t = Number(parts.t);
  if (!t || !sigs.length || Math.abs(Date.now() / 1000 - t) > 300) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${body}`)));
  const hex = [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
  return sigs.some((s) => timingSafeEqual(s, hex));
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// ---------- admin ----------

function authorized(req, env) {
  const h = req.headers.get("authorization") || "";
  return !!env.ADMIN_TOKEN && timingSafeEqual(h, `Bearer ${env.ADMIN_TOKEN}`);
}

async function players(env) {
  const out = [];
  let cursor;
  do {
    const r = await env.PASS.list({ prefix: "p:", cursor });
    for (const k of r.keys) {
      const v = await env.PASS.get(k.name, "json");
      if (v) out.push({ uuid: v.uuid, name: v.name });
    }
    cursor = r.list_complete ? undefined : r.cursor;
  } while (cursor);
  return out;
}

// 商品・価格・webhook を Stripe に作って KV に保存する。body: {"amount":500,"currency":"jpy"}。価格を変えるときも同じ呼び出しで新しい価格を作る
async function setup(req, env, url) {
  const b = await req.json().catch(() => ({}));
  const amount = Number(b.amount || 500);
  const currency = String(b.currency || "jpy");
  const cfg = (await config(env)) || {};
  const product = await stripe(env, "POST", "/products", { name: env.PRODUCT_NAME, description: "ハロウィン・ナイト / TikTok Defense / Clash Royale MC / アニメ技 埋め立て に入れる参加券（買い切り）" });
  const price = await stripe(env, "POST", "/prices", { product: product.id, unit_amount: String(amount), currency });
  if (!cfg.webhookId) {
    const params = { url: `${url.origin}/webhook`, description: "SharyTech Games pass" };
    EVENTS.forEach((e, i) => (params[`enabled_events[${i}]`] = e));
    const wh = await stripe(env, "POST", "/webhook_endpoints", params);
    cfg.webhookId = wh.id;
    cfg.webhookSecret = wh.secret;
  }
  Object.assign(cfg, { priceId: price.id, amount, currency });
  await env.PASS.put(`cfg:${mode(env)}`, JSON.stringify(cfg));
  return json({ mode: mode(env), priceId: cfg.priceId, amount, currency, webhookId: cfg.webhookId });
}

// 手動で入れる・外す（返金の手作業や配信者の招待用）。body: {"name":"kanetyyy","note":"..."}
async function grant(req, env) {
  const b = await req.json();
  const prof = await mojang(String(b.name || ""));
  if (!prof) return json({ error: "unknown player" }, 404);
  await env.PASS.put(`p:${prof.uuid}`, JSON.stringify({ uuid: prof.uuid, name: prof.name, paidAt: new Date().toISOString(), session: null, pi: null, amount: 0, mode: "manual", note: b.note || "" }));
  return json({ granted: prof });
}

async function revoke(req, env) {
  const b = await req.json();
  const prof = await mojang(String(b.name || ""));
  if (!prof) return json({ error: "unknown player" }, 404);
  await env.PASS.delete(`p:${prof.uuid}`);
  return json({ revoked: prof });
}

// ---------- helpers ----------

async function mojang(name) {
  if (!NAME_RE.test(name)) return null;
  const r = await fetch(`https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(name)}`);
  if (r.status !== 200) return null;
  const j = await r.json();
  const h = j.id;
  return { uuid: `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`, name: j.name };
}

async function stripe(env, method, path, params) {
  const r = await fetch(STRIPE + path, {
    method,
    headers: { authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, "content-type": "application/x-www-form-urlencoded" },
    body: params ? new URLSearchParams(params) : undefined,
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`Stripe ${path}: ${j.error?.message || r.status}`);
  return j;
}

function json(o, status = 200) {
  return new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
