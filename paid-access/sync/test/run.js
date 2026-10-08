// sync.js の通しテスト（偽の API と偽の RCON 鯖）。node test/run.js
"use strict";
const assert = require("assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const net = require("net");
const { execFileSync } = require("child_process");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paidsync-"));
let players = [{ uuid: "11111111-1111-1111-1111-111111111111", name: "Alice", games: ["a", "down"] }];
let apiDown = false;
const api = http.createServer((req, res) => {
  if (req.headers.authorization !== "Bearer tok") return res.writeHead(401).end();
  if (apiDown) return res.writeHead(500).end();
  res.end(JSON.stringify({ players }));
});
const got = [];
const rconSrv = net.createServer((s) => {
  let buf = Buffer.alloc(0);
  s.on("data", (d) => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 4 && buf.length >= buf.readInt32LE(0) + 4) {
      const len = buf.readInt32LE(0), id = buf.readInt32LE(4), type = buf.readInt32LE(8);
      const body = buf.toString("utf8", 12, 4 + len - 2);
      buf = buf.subarray(4 + len);
      const ok = type === 3 ? body === "pw" : true;
      if (type === 2) got.push(body);
      const out = Buffer.from(type === 2 ? "ok" : "");
      const p = Buffer.alloc(14 + out.length);
      p.writeInt32LE(10 + out.length, 0); p.writeInt32LE(ok ? id : -1, 4); p.writeInt32LE(2, 8); out.copy(p, 12);
      s.write(p);
    }
  });
});

(async () => {
  await new Promise((r) => api.listen(0, r));
  await new Promise((r) => rconSrv.listen(0, r));
  const srvDir = path.join(dir, "srv"); fs.mkdirSync(srvDir);
  const wl = path.join(srvDir, "whitelist.json");
  fs.writeFileSync(wl, JSON.stringify([{ uuid: "99999999-9999-9999-9999-999999999999", name: "Manual" }]));
  const downDir = path.join(dir, "down"); fs.mkdirSync(downDir);
  const wlDown = path.join(downDir, "whitelist.json");
  const lobby = path.join(dir, "paid-players.txt");
  const cfg = path.join(dir, "config.json");
  const write = (enforce, enforceDown = enforce) => fs.writeFileSync(cfg, JSON.stringify({
    api: `http://127.0.0.1:${api.address().port}`, token: "tok", lobbyPaidFile: lobby,
    servers: [
      { id: "a", dir: srvDir, rconPort: rconSrv.address().port, rconPassword: "pw", enforce },
      { id: "down", dir: downDir, rconPort: 1, rconPassword: "pw", enforce: enforceDown },
    ],
  }));
  const run = () => new Promise((res, rej) => require("child_process").execFile(process.execPath, [path.join(__dirname, "../sync.js"), cfg, "--once"], (e, out) => (e ? rej(e) : res(out))));
  const names = (f = wl) => JSON.parse(fs.readFileSync(f, "utf8")).map((e) => e.name).sort();

  // 名簿のみ（enforce false）: 足すが whitelist on は送らない
  write(false);
  await run();
  assert.deepEqual(names(), ["Alice", "Manual"]);
  assert.deepEqual(got, ["whitelist reload"]);
  assert.equal(fs.readFileSync(lobby, "utf8"), "11111111-1111-1111-1111-111111111111 a,down\n");
  // 止まっている鯖も名簿のファイルだけは用意される
  assert.deepEqual(names(wlDown), ["Alice"]);

  // 変化なし → 何も送らない
  got.length = 0; await run(); assert.deepEqual(got, []);

  // 制限開始（ゲームごと: a だけ）
  write(true, false); await run();
  assert.deepEqual(got, ["whitelist on", "whitelist reload"]);

  // 契約者が増える・名前が変わる。Bob は down だけ契約
  got.length = 0;
  players = [{ uuid: "11111111-1111-1111-1111-111111111111", name: "Alice2", games: ["a", "down"] }, { uuid: "22222222-2222-2222-2222-222222222222", name: "Bob", games: ["down"] }];
  await run();
  assert.deepEqual(names(), ["Alice2", "Manual"]);
  assert.deepEqual(names(wlDown), ["Alice2", "Bob"]);
  assert.deepEqual(got, ["whitelist reload"]);
  assert.match(fs.readFileSync(lobby, "utf8"), /^22222222-2222-2222-2222-222222222222 down$/m);

  // Bob が a も契約
  got.length = 0;
  players[1].games = ["a", "down"];
  await run();
  assert.deepEqual(names(), ["Alice2", "Bob", "Manual"]);
  assert.deepEqual(got, ["whitelist reload"]);

  // API が落ちていたら何も変えない
  apiDown = true; got.length = 0; await run();
  assert.deepEqual(names(), ["Alice2", "Bob", "Manual"]); assert.deepEqual(got, []);
  apiDown = false;

  // 解約で外れる。手で足した Manual は残る。Bob が a だけ解約
  players = [{ uuid: "22222222-2222-2222-2222-222222222222", name: "Bob", games: ["down"] }];
  await run();
  assert.deepEqual(names(), ["Manual"]);
  assert.deepEqual(names(wlDown), ["Bob"]);

  // games が無い（前の版の Worker）は全ゲーム扱い
  players = [{ uuid: "22222222-2222-2222-2222-222222222222", name: "Bob" }];
  await run();
  assert.deepEqual(names(), ["Bob", "Manual"]);

  // 制限解除
  got.length = 0; write(false); await run();
  assert.deepEqual(got, ["whitelist off", "whitelist reload"]);

  console.log("sync: all tests passed");
  api.close(); rconSrv.close();
})().catch((e) => { console.error(e); process.exit(1); });
