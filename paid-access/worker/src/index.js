// SharyTech Games の参加券（Stripe の月額サブスクリプション）を受け付ける Cloudflare Worker。
// 契約中のプレイヤーを KV に記録し、PC の sync スクリプトが /api/players を読んで、そのゲーム鯖のホワイトリストに入れる。
//
// プラン: ゲームごと（id は sync の servers[].id・ロビーの行き先 id と同じ）と、全ゲームの "complete"。
//
// KV (PASS):
//   p:<plan>:<uuid> → {"uuid","name","plan","sub","status","since","mode","note"}
//   sub:<id>        → "<plan>:<uuid>"（解約・支払い失敗のときに消すため）
//   cfg:<mode>      → {"currency","webhookId","webhookSecret","plans":{"<plan>":{"priceId","amount"}}}（mode は test / live）
//   idx:players     → [{"uuid","name","games":["<game>",…]}]（契約者の一覧。p: を足し引きするたびに書き直す）
//
// KV の無料枠は list・書き込み・削除が合わせて 1日1000回しかないので、sync が毎回 list すると枠が尽きる。
// sync は普段 idx:players を1回読むだけにし、取りこぼしの直しとして ?full=1（list して一覧を作り直す）をたまに呼ぶ
// Secrets: STRIPE_SECRET_KEY（sk_test_… か sk_live_…）, ADMIN_TOKEN（PC の sync と管理用）
// Vars: SITE_URL, GAMES_URL, PRODUCT_NAME, PORTAL_URL（Stripe のカスタマーポータルのログインリンク）, SELLER_*（特定商取引法の表記）

const STRIPE = "https://api.stripe.com/v1";
const NAME_RE = /^[A-Za-z0-9_]{3,16}$/;
const GAMES = [
  { id: "halloween", name: "Halloween Night", desc: "カボチャ王の夜をめぐる配布マップ（3〜4人向け）" },
  { id: "tiktok-defense", name: "TikTok Defense", desc: "銃でウェーブを守り抜くディフェンス（Fabric 26.1.2＋専用 MOD パック）" },
  { id: "clash-royale", name: "Clash Royale MC", desc: "AI や友達とタワーを攻め合う対戦" },
  { id: "anime-umetate", name: "アニメ技 埋め立て", desc: "アニメの技で妨害される埋め立てチャレンジ" },
];
const COMPLETE = { id: "complete", name: "コンプリートプラン", desc: "上の全ゲームに入れます（ゲームが増えたら追加料金なしで含まれます）" };
const PLANS = [COMPLETE, ...GAMES];
const PLAN = Object.fromEntries(PLANS.map((p) => [p.id, p]));
const DEFAULT_AMOUNT = { complete: 8000, game: 1500 };
// この状態のあいだは入れる。past_due（支払いの再試行中）は猶予として入れたままにする
const ACTIVE = new Set(["active", "trialing", "past_due"]);
const EVENTS = ["checkout.session.completed", "customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted"];

const gamesOf = (plan) => (plan === COMPLETE.id ? GAMES.map((g) => g.id) : [plan]);

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
        if (req.method === "GET" && url.pathname === "/api/players") return json({ players: await players(env, url.searchParams.get("full") === "1") });
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
  const sel = PLAN[url.searchParams.get("plan")] ? url.searchParams.get("plan") : "";
  const name = esc(url.searchParams.get("name") || "");
  const card = (p) => {
    const c = cfg?.plans?.[p.id];
    return `
<div class="card${sel === p.id ? " sel" : ""}${p.id === COMPLETE.id ? " complete" : ""}" id="${p.id}">
  <h2>${esc(p.name)}</h2>
  <p class="small">${esc(p.desc)}</p>
  <div class="price">${c ? yen(c.amount, cfg.currency) : "準備中"}<span> / 月（税込・自動更新）</span></div>
  <form method="post" action="/checkout">
    <input type="hidden" name="plan" value="${p.id}">
    <label>Minecraft Java 版のユーザー名
      <input name="name" required pattern="[A-Za-z0-9_]{3,16}" maxlength="16" autocomplete="off" placeholder="例: kanetyyy" value="${name}">
    </label>
    <label class="agree"><input type="checkbox" name="agree" value="1" required> <a href="/legal">特定商取引法に基づく表記</a>と、毎月自動で更新され、解約はいつでもでき次の更新日から止まることに同意します</label>
    <button ${c ? "" : "disabled"}>${esc(p.name)} を申し込む（Stripe）</button>
  </form>
</div>`;
  };
  const order = sel ? [PLAN[sel], ...PLANS.filter((p) => p.id !== sel)] : PLANS;
  return `
<h1>${esc(env.PRODUCT_NAME)}</h1>
<p class="lead">ゲームロビーから入るゲーム鯖の月額参加券です。遊びたいゲームだけ、または全ゲームのコンプリートプランを選べます。</p>
<ul class="small">
  <li>申し込むと1分ほどで、そのゲーム鯖のホワイトリストに自動で入ります</li>
  <li>毎月自動で更新されます。解約すると、支払い済みの期間が終わった時点で入れなくなります</li>
  <li>Kanety SMP は今まで通り無料です（参加券は要りません）</li>
  <li>Minecraft Java 版の正規アカウントが必要です</li>
</ul>
${mode(env) === "test" ? `<p class="test">テストモードです。実際のお金は動きません（カード 4242 4242 4242 4242）。</p>` : ""}
${err ? `<p class="err">${esc(err)}</p>` : ""}
${order.map(card).join("")}
<p class="small"><a href="/check">契約中か確かめる</a>${env.PORTAL_URL ? ` · <a href="${esc(env.PORTAL_URL)}">解約・カードの変更（Stripe）</a>` : ""}</p>`;
}

async function checkout(req, env, url) {
  const form = await req.formData();
  const name = String(form.get("name") || "").trim();
  const plan = String(form.get("plan") || "");
  const back = (msg) => Response.redirect(`${url.origin}/?error=${encodeURIComponent(msg)}&name=${encodeURIComponent(name)}&plan=${encodeURIComponent(plan)}`, 303);
  if (!PLAN[plan]) return back("プランを選んでください");
  if (!form.get("agree")) return back("表記と自動更新の条件への同意が必要です");
  if (!NAME_RE.test(name)) return back("ユーザー名は英数字と _ の3〜16文字です");
  const cfg = await config(env);
  const price = cfg?.plans?.[plan];
  if (!price) return back(`${PLAN[plan].name} はまだ準備中です`);
  const prof = await mojang(name);
  if (!prof) return back(`「${name}」という Java 版のアカウントが見つかりませんでした`);
  if (await env.PASS.get(`p:${plan}:${prof.uuid}`)) return back(`${prof.name} さんは ${PLAN[plan].name} を契約中です`);
  if (plan !== COMPLETE.id && (await env.PASS.get(`p:${COMPLETE.id}:${prof.uuid}`))) return back(`${prof.name} さんはコンプリートプランを契約中なので、${PLAN[plan].name} にも入れます`);

  const meta = { mc_uuid: prof.uuid, mc_name: prof.name, plan };
  const params = {
    mode: "subscription",
    "line_items[0][price]": price.priceId,
    "line_items[0][quantity]": "1",
    client_reference_id: prof.uuid,
    locale: "ja",
    success_url: `${url.origin}/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${url.origin}/?name=${encodeURIComponent(prof.name)}&plan=${plan}#${plan}`,
  };
  for (const [k, v] of Object.entries(meta)) {
    params[`metadata[${k}]`] = v;
    params[`subscription_data[metadata][${k}]`] = v;
  }
  params["subscription_data[description]"] = `${env.PRODUCT_NAME} ${PLAN[plan].name} (${prof.name})`;
  const s = await stripe(env, "POST", "/checkout/sessions", params);
  return Response.redirect(s.url, 303);
}

async function success(env, url) {
  const id = url.searchParams.get("session_id") || "";
  let name = "";
  let plan = null;
  if (/^cs_[A-Za-z0-9_]+$/.test(id)) {
    const s = await stripe(env, "GET", `/checkout/sessions/${id}`);
    name = s.metadata?.mc_name || "";
    plan = PLAN[s.metadata?.plan] || null;
    // webhook より先に戻ってきたときのため、支払い済みならここでも登録する
    if (s.status === "complete" && s.payment_status === "paid") await recordSession(env, s);
  }
  const what = plan ? (plan.id === COMPLETE.id ? "全ゲーム" : plan.name) : "";
  return `
<h1>お申し込みありがとうございます</h1>
<div class="card">
  <p>${name ? `<b>${esc(name)}</b> さんを` : ""}${what ? `${esc(what)} の` : ""}ホワイトリストに登録しました。1分ほどでゲーム鯖に反映されます。</p>
  <p>ゲームロビーに入って、遊びたいゲームのゲートに乗ってください。</p>
  <p><a class="btn" href="${esc(env.GAMES_URL)}">入り方を見る（games.sharytech.com）</a></p>
  <p class="small">解約やカードの変更は ${env.PORTAL_URL ? `<a href="${esc(env.PORTAL_URL)}">こちら（Stripe）</a>から` : "Stripe から届くメールのリンクから"}できます。入れないときは Discord SharyTech でお知らせください。</p>
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
${row("販売価格", "プランごとに申し込みページに表示（月額・税込）")}
${row("商品代金以外の必要料金", "インターネット接続料金・通信料金はお客様の負担となります")}
${row("支払方法", "クレジットカードほか Stripe が対応する方法")}
${row("支払時期", "申し込み時に初月分、以後は毎月の更新日に自動で請求")}
${row("引渡時期", "決済完了後すぐ（通常1分以内に該当するゲーム鯖のホワイトリストへ登録）")}
${row("契約期間・解約", "1か月ごとの自動更新。解約はいつでもでき、支払い済みの期間の終わりまで利用できます。日割りの返金はありません")}
${row("返品・キャンセル", "デジタルサービスの性質上、支払い済みの期間の返金はお受けできません。ただしサービスを提供できない場合は個別に対応します")}
${row("動作環境", "Minecraft: Java Edition の正規アカウント（各ゲームが指定する版）")}
</table>
<p class="small">NOT AN OFFICIAL MINECRAFT PRODUCT. NOT APPROVED BY OR ASSOCIATED WITH MOJANG OR MICROSOFT.</p>
<p><a href="/">戻る</a></p></div>`;
}

async function check(env, url) {
  const name = String(url.searchParams.get("name") || "").trim();
  if (!NAME_RE.test(name)) return page(env, `<h1>契約の確認</h1><div class="card"><form><input name="name" placeholder="ユーザー名" required> <button>確認</button></form></div>`);
  const prof = await mojang(name);
  const games = new Set(prof ? (await playerOf(env, prof.uuid))?.games || [] : []);
  const rows = GAMES.map((g) => `<li>${esc(g.name)}: ${games.has(g.id) ? "契約中（入れます）" : `未契約（<a href="/?plan=${g.id}&name=${encodeURIComponent(name)}#${g.id}">申し込む</a>）`}</li>`);
  return page(env, `<h1>契約の確認</h1><div class="card"><p>${esc(prof?.name || name)}</p><ul>${rows.join("")}</ul><p><a href="/">参加券のページへ</a></p></div>`);
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
.sel{border-color:var(--accent)}h2{font-size:20px;margin:0}.sel,.complete{border-color:var(--accent)}h2{font-size:20px;margin:0}.err{color:#f87171}.test{color:#facc15;font-size:14px}.legal{border-collapse:collapse;width:100%;font-size:14px}
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
  if (ev.type === "checkout.session.completed") {
    if (o.mode === "subscription" && o.payment_status === "paid") await recordSession(env, o);
  } else if (ev.type.startsWith("customer.subscription.")) {
    // 解約（期間の終わり）・支払い失敗で止まったら外す。再開したら戻す
    if (ev.type !== "customer.subscription.deleted" && ACTIVE.has(o.status)) await recordSubscription(env, o);
    else await dropSubscription(env, o.id);
  }
  return json({ received: true });
}

async function recordSession(env, s) {
  const sub = typeof s.subscription === "string" ? s.subscription : s.subscription?.id;
  if (!sub) return;
  await recordSubscription(env, { id: sub, status: "active", metadata: s.metadata, livemode: s.livemode, created: s.created });
}

async function recordSubscription(env, sub) {
  const { mc_uuid: uuid, mc_name: name, plan } = sub.metadata || {};
  if (!uuid || !PLAN[plan]) return;
  const key = `p:${plan}:${uuid}`;
  const prev = await env.PASS.get(key, "json");
  if (prev?.sub === sub.id && prev.status === sub.status) return;
  await env.PASS.put(key, JSON.stringify({
    uuid, name, plan, sub: sub.id, status: sub.status, since: prev?.since || new Date((sub.created || Date.now() / 1000) * 1000).toISOString(),
    mode: sub.livemode ? "live" : "test",
  }));
  if (prev?.sub !== sub.id) await env.PASS.put(`sub:${sub.id}`, `${plan}:${uuid}`);
  if (!prev) await reindex(env, uuid, name);
}

async function dropSubscription(env, subId) {
  const ref = await env.PASS.get(`sub:${subId}`);
  if (!ref) return;
  const [plan, uuid] = ref.split(":");
  const rec = await env.PASS.get(`p:${plan}:${uuid}`, "json");
  // 同じプランを契約し直した後に古い契約の終了が届いたときは消さない
  if (rec && rec.sub === subId) await env.PASS.delete(`p:${plan}:${uuid}`);
  await env.PASS.delete(`sub:${subId}`);
  await reindex(env, uuid, rec?.name);
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

async function players(env, full) {
  if (!full) {
    const idx = await env.PASS.get("idx:players", "json");
    if (Array.isArray(idx) && idx.every((p) => Array.isArray(p.games))) return idx;
  }
  const by = new Map();
  let cursor;
  do {
    const r = await env.PASS.list({ prefix: "p:", cursor });
    for (const k of r.keys) {
      const [, plan, uuid] = k.name.split(":");
      if (!PLAN[plan] || !uuid) continue;
      const v = await env.PASS.get(k.name, "json");
      if (!v) continue;
      const p = by.get(uuid) || { uuid, name: v.name, games: [] };
      p.games = [...new Set([...p.games, ...gamesOf(plan)])];
      by.set(uuid, p);
    }
    cursor = r.list_complete ? undefined : r.cursor;
  } while (cursor);
  const out = [...by.values()];
  await writeIndex(env, out);
  return out;
}

async function writeIndex(env, list) {
  const old = await env.PASS.get("idx:players");
  const text = JSON.stringify(list);
  if (old !== text) await env.PASS.put("idx:players", text);
}

async function playerOf(env, uuid) {
  return (await players(env, false)).find((p) => p.uuid === uuid) || null;
}

/** p:<plan>:<uuid> を読み直して、その人の idx:players の行を作り直す（list を使わない）。 */
async function reindex(env, uuid, name) {
  const games = new Set();
  for (const p of PLANS) {
    const v = await env.PASS.get(`p:${p.id}:${uuid}`, "json");
    if (v) {
      name = v.name;
      gamesOf(p.id).forEach((g) => games.add(g));
    }
  }
  const idx = (await players(env, false)).filter((p) => p.uuid !== uuid);
  if (games.size) idx.push({ uuid, name, games: GAMES.map((g) => g.id).filter((g) => games.has(g)) });
  await writeIndex(env, idx);
}

// プランごとの月額の商品・価格と webhook を Stripe に作って KV に保存する。
// body: {} で既定（コンプリート 8000円・各ゲーム 1500円）。{"plans":{"complete":8000,"halloween":1500}} で書いたプランだけ作り直す
async function setup(req, env, url) {
  const b = await req.json().catch(() => ({}));
  const currency = String(b.currency || "jpy");
  const want = b.plans && typeof b.plans === "object"
    ? b.plans
    : Object.fromEntries(PLANS.map((p) => [p.id, p.id === COMPLETE.id ? DEFAULT_AMOUNT.complete : DEFAULT_AMOUNT.game]));
  const cfg = (await config(env)) || {};
  cfg.plans = cfg.plans || {};
  for (const [id, amount] of Object.entries(want)) {
    const p = PLAN[id];
    if (!p || !(Number(amount) > 0)) return json({ error: `bad plan or amount: ${id}` }, 400);
    const product = await stripe(env, "POST", "/products", { name: `${env.PRODUCT_NAME}（${p.name}）`, description: p.desc });
    const price = await stripe(env, "POST", "/prices", { product: product.id, unit_amount: String(Number(amount)), currency, "recurring[interval]": "month" });
    cfg.plans[id] = { priceId: price.id, amount: Number(amount) };
  }
  const events = {};
  EVENTS.forEach((e, i) => (events[`enabled_events[${i}]`] = e));
  if (!cfg.webhookId) {
    const wh = await stripe(env, "POST", "/webhook_endpoints", { url: `${url.origin}/webhook`, description: "SharyTech Games pass", ...events });
    cfg.webhookId = wh.id;
    cfg.webhookSecret = wh.secret;
  } else {
    // 前の版（買い切り）で作った webhook の受け取るイベントを月額用に入れ替える
    await stripe(env, "POST", `/webhook_endpoints/${cfg.webhookId}`, events);
  }
  cfg.currency = currency;
  for (const k of ["priceId", "amount", "games"]) delete cfg[k];
  await env.PASS.put(`cfg:${mode(env)}`, JSON.stringify(cfg));
  return json({ mode: mode(env), currency, plans: cfg.plans, webhookId: cfg.webhookId });
}

// 手動で入れる・外す（配信者の招待やテスト用）。body: {"name":"kanetyyy","plan":"halloween","note":"..."}。plan を省くと complete
async function grant(req, env) {
  const b = await req.json();
  const plan = b.plan || COMPLETE.id;
  if (!PLAN[plan]) return json({ error: "unknown plan" }, 400);
  const prof = await mojang(String(b.name || ""));
  if (!prof) return json({ error: "unknown player" }, 404);
  await env.PASS.put(`p:${plan}:${prof.uuid}`, JSON.stringify({ uuid: prof.uuid, name: prof.name, plan, sub: null, status: "manual", since: new Date().toISOString(), mode: "manual", note: b.note || "" }));
  await reindex(env, prof.uuid, prof.name);
  return json({ granted: prof, plan });
}

// 手で入れた分を外す（Stripe の契約は Stripe で解約する）。plan を省くと全部
async function revoke(req, env) {
  const b = await req.json();
  if (b.plan && !PLAN[b.plan]) return json({ error: "unknown plan" }, 400);
  const prof = await mojang(String(b.name || ""));
  if (!prof) return json({ error: "unknown player" }, 404);
  for (const p of b.plan ? [PLAN[b.plan]] : PLANS) await env.PASS.delete(`p:${p.id}:${prof.uuid}`);
  await reindex(env, prof.uuid, prof.name);
  return json({ revoked: prof, plan: b.plan || "all" });
}

// ---------- helpers ----------

async function mojang(name) {
  if (!NAME_RE.test(name)) return null;
  const n = encodeURIComponent(name);
  // Mojang は Cloudflare の IP からだと 403/429 を返すことがあるので、だめなら次の窓口を試す
  const sources = [
    [`https://api.mojang.com/users/profiles/minecraft/${n}`, (j) => j],
    [`https://api.minecraftservices.com/minecraft/profile/lookup/name/${n}`, (j) => j],
    [`https://playerdb.co/api/player/minecraft/${n}`, (j) => j.success && { id: j.data.player.raw_id, name: j.data.player.username }],
  ];
  for (const [url, pick] of sources) {
    try {
      const r = await fetch(url, { headers: { "user-agent": "sharytech-pass (+https://pass.sharytech.com)" } });
      if (r.status === 204 || r.status === 404) return null; // その名前のアカウントは無い
      if (r.status !== 200) {
        console.warn(`lookup ${new URL(url).host}: ${r.status}`);
        continue;
      }
      const p = pick(await r.json());
      const h = p && String(p.id || "").replace(/-/g, "");
      if (!/^[0-9a-f]{32}$/.test(h)) continue;
      return { uuid: `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`, name: p.name };
    } catch (e) {
      console.warn(`lookup ${new URL(url).host}: ${e.message}`);
    }
  }
  throw new Error("Minecraft のユーザー名を確かめられませんでした");
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
