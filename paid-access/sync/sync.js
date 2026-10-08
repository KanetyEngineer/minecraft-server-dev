// 参加券を買った人を、各ゲーム鯖のホワイトリストとロビーの購入者リストに反映する（PC で常時動かす）。
// 使い方: node sync.js [config.json]   1回だけ: node sync.js --once
// 依存なし（Node 18 以上）。設定は config.example.json を config.json にコピーして書き換える。
//
// - whitelist.json は「このスクリプトが足した人」だけを足し引きする。手で足した人や OP には触らない
// - API が失敗したときは何もしない（全員を外してしまわないため）
// - enforce が true の鯖だけ "whitelist on" を送る。false の間は名簿だけ用意して、まだ誰でも入れる（ゲームごとに切り替えられる）
// - 参加券はゲームごと。各鯖には、その鯖の id（servers[].id）を games に持つ人だけを入れる

"use strict";
const fs = require("fs");
const path = require("path");
const net = require("net");

const args = process.argv.slice(2);
const once = args.includes("--once");
const cfgPath = path.resolve(args.find((a) => !a.startsWith("--")) || path.join(__dirname, "config.json"));
const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
const statePath = path.join(path.dirname(cfgPath), "sync-state.json");

function log(...a) {
  console.log(new Date().toISOString(), ...a);
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(statePath, "utf8"));
  } catch {
    return { managed: {} };
  }
}

// 普段は Worker の一覧（KV を1回読むだけ）を使い、fullEveryMinutes ごとに KV を list して一覧を作り直させる。
// KV の list は無料枠が 1日1000回しかないので、毎回 list すると枠が尽きる
let lastFull = 0;

async function fetchPlayers() {
  const full = Date.now() - lastFull >= (cfg.fullEveryMinutes || 60) * 60000;
  if (!full) return fetchPlayersOnce(false);
  try {
    const players = await fetchPlayersOnce(true);
    lastFull = Date.now();
    return players;
  } catch (e) {
    // list の枠が尽きたときなど。作り直しは次の機会にして、いつもの一覧を使う
    log("一覧の作り直しに失敗（いつもの一覧を使います）:", e.message);
    lastFull = Date.now();
    return fetchPlayersOnce(false);
  }
}

async function fetchPlayersOnce(full) {
  const r = await fetch(cfg.api.replace(/\/$/, "") + "/api/players" + (full ? "?full=1" : ""), { headers: { authorization: `Bearer ${cfg.token}` } });
  if (!r.ok) throw new Error(`api ${r.status}`);
  const j = await r.json();
  if (!Array.isArray(j.players)) throw new Error("api: no players array");
  return j.players
    .filter((p) => /^[0-9a-f-]{36}$/.test(p.uuid) && /^[A-Za-z0-9_]{1,16}$/.test(p.name))
    .map((p) => ({ uuid: p.uuid, name: p.name, games: Array.isArray(p.games) ? p.games.filter((g) => /^[a-z0-9-]+$/.test(g)) : null }));
}

/** games が無いのは前の版（全ゲーム共通の参加券）の Worker。 */
function hasGame(p, id) {
  return p.games === null || p.games.includes(id);
}

function writeJsonAtomic(file, data) {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

/** Returns true when whitelist.json changed. */
function syncWhitelist(server, paid, state) {
  const file = path.join(server.dir, "whitelist.json");
  let list = [];
  try {
    list = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {}
  const managed = new Set(state.managed[server.id] || []);
  const want = new Map(paid.filter((p) => hasGame(p, server.id)).map((p) => [p.uuid, p.name]));
  const before = JSON.stringify(list);

  // 外す: 自分が足した人で、もう購入者でない人
  list = list.filter((e) => !(managed.has(e.uuid) && !want.has(e.uuid)));
  for (const u of [...managed]) if (!want.has(u)) managed.delete(u);
  // 足す・名前の更新
  const have = new Map(list.map((e) => [e.uuid, e]));
  for (const [uuid, name] of want) {
    const e = have.get(uuid);
    if (!e) {
      list.push({ uuid, name });
      managed.add(uuid);
    } else if (managed.has(uuid) && e.name !== name) {
      e.name = name;
    }
  }
  state.managed[server.id] = [...managed];
  if (JSON.stringify(list) === before) return false;
  writeJsonAtomic(file, list);
  return true;
}

// ---------- RCON ----------

function rcon(port, password, commands, host = "127.0.0.1") {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, host);
    const out = [];
    let buf = Buffer.alloc(0);
    let id = 1;
    let authed = false;
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error(`rcon ${port}: timeout`));
    }, 8000);
    const send = (type, body) => {
      const b = Buffer.from(body, "utf8");
      const p = Buffer.alloc(14 + b.length);
      p.writeInt32LE(10 + b.length, 0);
      p.writeInt32LE(id++, 4);
      p.writeInt32LE(type, 8);
      b.copy(p, 12);
      sock.write(p);
    };
    const next = () => {
      if (!commands.length) {
        clearTimeout(timer);
        sock.end();
        return resolve(out);
      }
      send(2, commands.shift());
    };
    sock.on("connect", () => send(3, password));
    sock.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 4 && buf.length >= buf.readInt32LE(0) + 4) {
        const len = buf.readInt32LE(0);
        const rid = buf.readInt32LE(4);
        const body = buf.toString("utf8", 12, 4 + len - 2);
        buf = buf.subarray(4 + len);
        if (!authed) {
          if (rid === -1) {
            clearTimeout(timer);
            sock.destroy();
            return reject(new Error(`rcon ${port}: wrong password`));
          }
          authed = true;
        } else {
          out.push(body);
        }
        next();
      }
    });
    sock.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

// ---------- main loop ----------

async function tick(state) {
  let paid;
  try {
    paid = await fetchPlayers();
  } catch (e) {
    log("参加券の一覧を取れませんでした（今回は何も変えません）:", e.message);
    return;
  }
  for (const s of cfg.servers) {
    try {
      const changed = syncWhitelist(s, paid, state);
      if (changed) state.pending = { ...state.pending, [s.id]: true };
      const cmds = [];
      if (s.enforce && !state.enforced?.[s.id]) cmds.push("whitelist on");
      if (!s.enforce && state.enforced?.[s.id]) cmds.push("whitelist off");
      if (state.pending?.[s.id] || cmds.length) cmds.push("whitelist reload");
      if (cmds.length) {
        await rcon(s.rconPort, s.rconPassword, cmds);
        state.enforced = { ...state.enforced, [s.id]: !!s.enforce };
        state.pending = { ...state.pending, [s.id]: false };
        log(`${s.id}: ${changed ? "名簿を更新" : ""} ${cmds.join(" / ")}`);
      }
    } catch (e) {
      // 鯖が止まっているときは名簿だけ更新して、次に動いたときに反映する（起動時に whitelist.json は読み直される）
      log(`${s.id}: ${e.message}`);
    }
  }
  if (cfg.lobbyPaidFile) {
    // 1行に「uuid ゲーム,ゲーム」。ロビーはゲートの行き先 id がその人の行にあるときだけ通す
    const ids = cfg.servers.map((s) => s.id);
    const text = paid
      .map((p) => `${p.uuid} ${ids.filter((id) => hasGame(p, id)).join(",")}`)
      .sort()
      .join("\n") + "\n";
    let old = "";
    try {
      old = fs.readFileSync(cfg.lobbyPaidFile, "utf8");
    } catch {}
    if (old !== text) {
      fs.writeFileSync(cfg.lobbyPaidFile, text);
      log(`ロビーの契約者リストを更新（${paid.length}人）`);
    }
  }
  writeJsonAtomic(statePath, state);
}

(async () => {
  const state = loadState();
  log(`開始: ${cfg.servers.map((s) => `${s.id}${s.enforce ? "(制限中)" : "(名簿のみ)"}`).join(", ")}`);
  await tick(state);
  if (once) return;
  setInterval(() => tick(state).catch((e) => log("error", e.message)), (cfg.intervalSeconds || 30) * 1000);
})();
