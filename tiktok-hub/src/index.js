// SharyTech TikTok Hub: every game's TikTok LIVE link in one app.
//   TikTok LIVE (one connection per streamer) ──> hub ──> the streamer's game + field ──(RCON)──> that game's server
// One panel at http://127.0.0.1:8800/ (game tabs, streamers page, status). Each game keeps its own panel, API and
// OBS overlay under /g/<game>/ , and the hub also answers on each game's old port (8787-8790) so OBS sources and
// server.properties resource-pack URLs keep working. A busy old port is retried every 30 s.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { TikTokManager } from './core/tiktok.js';
import { send, json, readBody, readJson, cleanTikTok } from './core/util.js';
import * as defense from './games/defense/index.js';
import * as clash from './games/clash/index.js';
import * as anime from './games/anime/index.js';
import * as halloween from './games/halloween/index.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const WORK = path.dirname(ROOT); // the folder with the old per-game apps (only on the developer's PC)
const MODULES = [defense, clash, anime, halloween];
const CONFIG_FILE = process.env.HUB_CONFIG || path.join(ROOT, 'config.json');
const STATE_DIR = path.join(ROOT, 'state');
const VERSION = readJson(path.join(ROOT, 'package.json'), {}).version ?? '';
fs.mkdirSync(STATE_DIR, { recursive: true });

// ------------------------------------------------------------------ log
const hubLog = [];
function print(kind, text, prefix = '') {
  const t = new Date().toLocaleTimeString('ja-JP');
  console.log(`[${t}] ${prefix ? `${prefix} ` : ''}${kind}: ${text}`);
}
function log(kind, text) {
  hubLog.unshift({ t: new Date().toLocaleTimeString('ja-JP'), kind, text });
  hubLog.length = Math.min(hubLog.length, 300);
  print(kind, text, '[hub]');
}

// ------------------------------------------------------------------ config
// { hubPort, signApiKey, streamers: [{ id, tiktok, mc, game, field, enabled, note }], games: { <id>: <that game's config> },
//   serverDirs: { <id>: dir }, primaryGame }
const dataFile = (mod, name) => {
  const src = mod.meta.sources?.[name];
  if (src) {
    const original = path.join(WORK, src, name);
    if (fs.existsSync(original)) return original; // the developer's PC: always the game's newest build
  }
  return path.join(ROOT, 'data', mod.meta.id, name);
};

let hub = readJson(CONFIG_FILE, null);
const firstRun = !hub;
if (firstRun) hub = importOldConfigs();
hub.hubPort ??= 8800;
hub.signApiKey ??= '';
hub.streamers ??= [];
hub.games ??= {};
hub.serverDirs ??= {};
hub.disabledGames ??= [];
if (process.env.HUB_PORT) hub.hubPort = Number(process.env.HUB_PORT); // for trying a second copy
const saveHub = () => {
  const tmp = `${CONFIG_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(hub, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, CONFIG_FILE);
};

function baseCtx(mod) {
  return { data: (name) => dataFile(mod, name) };
}

// first start: read every old app's config.json (RCON, gift rules, per-field streamers) next to this folder
function importOldConfigs() {
  const out = { hubPort: 8800, signApiKey: '', streamers: [], games: {}, serverDirs: {}, imported: { at: new Date().toISOString(), from: [] } };
  const kit = readJson(path.join(ROOT, 'kit.json'), null); // game sets ship { game, serverDir }
  if (kit?.game) {
    // a game set: only its own game is switched on (the others can be turned on in the settings)
    out.primaryGame = kit.game;
    out.serverDirs[kit.game] = kit.serverDir || '../server';
    out.disabledGames = MODULES.map((m) => m.meta.id).filter((id) => id !== kit.game);
  }
  for (const mod of MODULES) {
    const id = mod.meta.id;
    const oldFile = path.join(WORK, mod.meta.oldApp, 'config.json');
    let raw = readJson(oldFile, null);
    if (raw) out.imported.from.push(oldFile);
    else raw = readJson(dataFile(mod, 'config.example.json'), {});
    let cfg;
    try { cfg = mod.validate(raw, baseCtx(mod)); } catch (err) {
      print('warn', `${id}: 古い設定を読めませんでした（${err.message}）。初期設定にします`, '[hub]');
      cfg = mod.validate(readJson(dataFile(mod, 'config.example.json'), {}), baseCtx(mod));
    }
    if (!out.signApiKey && cfg.signApiKey) out.signApiKey = cfg.signApiKey;
    for (const [field, s] of Object.entries(mod.streamersOf(cfg))) {
      if (!s.tiktok && !s.mc) continue;
      if (s.tiktok && out.streamers.some((x) => x.tiktok === s.tiktok)) continue; // one connection per TikTok ID
      out.streamers.push({ id: newId(), tiktok: s.tiktok, mc: s.mc, game: id, field: Number(field), enabled: true, note: '' });
    }
    out.games[id] = { ...cfg, signApiKey: '' };
  }
  // the defense ranking lives in a file next to its app
  const rec = path.join(WORK, 'tiktok-defense', 'app', 'records.json');
  const dst = path.join(STATE_DIR, 'defense-records.json');
  if (fs.existsSync(rec) && !fs.existsSync(dst)) fs.copyFileSync(rec, dst);
  return out;
}

function newId() {
  return 's' + crypto.randomBytes(4).toString('hex');
}

// a game set (kit.json) or a configured server folder: take RCON port + password from its server.properties
function rconFromServerDir(id) {
  const dir = hub.serverDirs?.[id];
  const g = hub.games[id];
  if (!dir || !g || g.rcon?.password) return;
  const props = path.resolve(ROOT, dir, 'server.properties');
  if (!fs.existsSync(props)) return;
  const text = fs.readFileSync(props, 'utf8');
  const get = (k) => (text.match(new RegExp(`^${k.replace('.', '\\.')}=(.*)$`, 'm')) ?? [])[1]?.trim() ?? '';
  if (get('enable-rcon') !== 'true' || !get('rcon.password')) return;
  g.rcon = { host: '127.0.0.1', port: Number(get('rcon.port')) || g.rcon?.port, password: get('rcon.password') };
  log('info', `${id}: ${props} から RCON の設定を読み込みました`);
}
for (const mod of MODULES) rconFromServerDir(mod.meta.id);
saveHub();
if (firstRun && hub.imported?.from?.length) log('info', `最初の起動: 古いアプリの設定を読み込みました（${hub.imported?.from?.length ?? 0} 件）`);

// ------------------------------------------------------------------ games
const games = new Map(); // id -> game api
let tiktok;

function makeCtx(mod) {
  const id = mod.meta.id;
  return {
    data: (name) => dataFile(mod, name),
    stateFile: (name) => path.join(STATE_DIR, name),
    config: () => hub.games[id] ?? readJson(dataFile(mod, 'config.example.json'), {}),
    configFile: () => `${CONFIG_FILE}（games.${id}）`,
    save: (cfg) => { hub.games[id] = cfg; saveHub(); },
    print: (kind, text) => print(kind, text, `[${id}]`),
    signApiKey: () => hub.signApiKey,
    setSignApiKey: (k) => setSignApiKey(k),
    fieldsEdited: () => reconcileFromGame(id),
    tiktokControl: (field, connect) => tiktokControl(id, field, connect),
  };
}

for (const mod of MODULES) {
  if (hub.disabledGames.includes(mod.meta.id)) continue;
  try {
    games.set(mod.meta.id, mod.createGame(makeCtx(mod)));
  } catch (err) {
    log('error', `${mod.meta.title} を読み込めませんでした: ${err.stack ?? err.message}`);
  }
}

// ------------------------------------------------------------------ streamers
const assigned = (s) => s.game && games.has(s.game) && games.get(s.game).fields().includes(s.field);
const streamerAt = (gameId, field) => hub.streamers.find((s) => s.game === gameId && s.field === field) ?? null;

// streamers -> each game's own per-field settings (TikTok ID + Minecraft name), so the game logic is unchanged
async function pushMirrors() {
  for (const [id, g] of games) {
    const map = {};
    for (const n of g.fields()) {
      const s = streamerAt(id, n);
      map[n] = s ? { tiktok: s.tiktok, mc: s.mc } : { tiktok: '', mc: '' };
    }
    await g.setStreamers(map).catch((err) => log('error', `${id}: 配信者を反映できませんでした: ${err.message}`));
  }
}

// a game's own panel changed its per-field TikTok ID / Minecraft name: update the streamer list to match
async function reconcileFromGame(id) {
  const g = games.get(id);
  const map = g.fieldStreamers();
  for (const n of g.fields()) {
    const want = map[n] ?? { tiktok: '', mc: '' };
    const cur = streamerAt(id, n);
    if (!want.tiktok && !want.mc) { if (cur) { cur.game = ''; cur.field = 0; } continue; }
    if (cur && cur.tiktok === want.tiktok) { cur.mc = want.mc; continue; }
    // a different TikTok ID: an existing entry with that ID moves here, otherwise this field's entry is renamed
    const other = want.tiktok ? hub.streamers.find((x) => x.tiktok.toLowerCase() === want.tiktok.toLowerCase()) : null;
    if (other) {
      if (cur && cur !== other) { cur.game = ''; cur.field = 0; }
      Object.assign(other, { game: id, field: n, mc: want.mc });
    } else if (cur) {
      Object.assign(cur, { tiktok: want.tiktok, mc: want.mc });
    } else {
      hub.streamers.push({ id: newId(), tiktok: want.tiktok, mc: want.mc, game: id, field: n, enabled: true, note: '' });
    }
  }
  await streamersChanged();
}

async function streamersChanged() {
  saveHub();
  await pushMirrors();
  syncConnections();
}

function syncConnections() {
  tiktok.sync(hub.streamers.filter((s) => s.enabled !== false && s.tiktok && assigned(s)).map((s) => ({ id: s.id, tiktok: s.tiktok })));
  refreshConnStates();
}

const lastAt = new Map(); // "<game>:<field>" -> streamer id, to reset like counters when someone else takes the field
function refreshConnStates() {
  for (const [id, g] of games) {
    for (const n of g.fields()) {
      const s = streamerAt(id, n);
      const c = s ? tiktok.get(s.id) : null;
      let st;
      if (!s) st = { status: 'off', detail: 'TikTok の ID が未設定（テストのみ）', username: '' };
      else if (!s.tiktok) st = { status: 'off', detail: `${s.mc} の TikTok ID が未設定（テストのみ）`, username: '' };
      else if (s.enabled === false) st = { status: 'off', detail: `@${s.tiktok} はハブの「配信者」でオフ`, username: s.tiktok };
      else st = { status: c?.status ?? 'off', detail: c?.detail ?? '', username: s.tiktok };
      const key = `${id}:${n}`;
      const who = s?.id ?? '';
      if (lastAt.get(key) !== who) { st.reset = true; lastAt.set(key, who); }
      g.setConn(n, st);
    }
  }
}

async function tiktokControl(gameId, field, connect) {
  const list = hub.streamers.filter((s) => s.game === gameId && (field == null || s.field === field) && s.tiktok);
  for (const s of list) {
    if (connect) {
      if (s.enabled === false) { s.enabled = true; saveHub(); syncConnections(); }
      tiktok.connect(s.id, s.tiktok);
    } else {
      await tiktok.disconnect(s.id);
    }
  }
}

function setSignApiKey(k) {
  const v = String(k ?? '').trim().slice(0, 200);
  if (v === hub.signApiKey) return;
  hub.signApiKey = v;
  saveHub();
  log('info', 'Euler Stream の API キーを変更しました。接続し直します');
  tiktok.reconnectAll();
}

function streamerLabel(s) {
  return s.tiktok ? `@${s.tiktok}` : s.mc || '?';
}

tiktok = new TikTokManager({
  signApiKey: () => hub.signApiKey,
  event: (sid, type, d) => {
    const s = hub.streamers.find((x) => x.id === sid);
    if (!s || !assigned(s)) return;
    games.get(s.game).onEvent(s.field, type, d);
  },
  log: (kind, text, sid) => {
    const s = hub.streamers.find((x) => x.id === sid);
    log(kind, `${s ? streamerLabel(s) : sid}: ${text}`);
    if (s && assigned(s)) games.get(s.game).log(kind, text, s.field);
  },
  changed: () => refreshConnStates(),
});

// validated streamer from the panel; throws with a message for the panel
function cleanStreamer(b, existing) {
  const tiktokId = cleanTikTok(b.tiktok);
  const mc = String(b.mc ?? '').trim().slice(0, 16);
  if (!/^[\w.]*$/.test(tiktokId)) throw new Error('TikTok の ID に使えない文字があります');
  if (mc && !/^\w{1,16}$/.test(mc)) throw new Error('Minecraft の名前に使えない文字があります（英数字と _ だけ）');
  if (!tiktokId && !mc) throw new Error('TikTok の ID か Minecraft の名前を入れてください');
  if (tiktokId && hub.streamers.some((x) => x !== existing && x.tiktok.toLowerCase() === tiktokId.toLowerCase())) throw new Error(`@${tiktokId} はもう登録されています`);
  let game = String(b.game ?? '');
  let field = Math.round(Number(b.field)) || 0;
  if (game && !games.has(game)) throw new Error('そのゲームはありません');
  if (game && !games.get(game).fields().includes(field)) throw new Error(`${games.get(game).meta.title} に ${field} 番はありません`);
  if (!game) field = 0;
  return { tiktok: tiktokId, mc, game, field, enabled: b.enabled !== false, note: String(b.note ?? '').trim().slice(0, 60) };
}

// ------------------------------------------------------------------ status
function overlayUrl(gameId, field) {
  return `http://127.0.0.1:${hub.hubPort}/overlay?game=${gameId}&field=${field}`;
}

function streamersJson() {
  return hub.streamers.map((s) => {
    const c = tiktok.get(s.id);
    return {
      ...s, assigned: assigned(s),
      status: !s.tiktok ? 'none' : s.enabled === false ? 'disabled' : !assigned(s) ? 'idle' : c?.status ?? 'off',
      detail: c?.detail ?? '', likes: c?.totalLikes ?? 0,
      overlay: assigned(s) ? overlayUrl(s.game, s.field) : '',
    };
  });
}

function statusJson() {
  const all = streamersJson();
  return {
    version: VERSION, hubPort: hub.hubPort, signApiKey: hub.signApiKey ? '設定済み' : '', primaryGame: hub.primaryGame ?? '',
    allGames: MODULES.map((m) => ({ id: m.meta.id, title: m.meta.title, icon: m.meta.icon, on: !hub.disabledGames.includes(m.meta.id), running: games.has(m.meta.id) })),
    games: [...games.values()].map((g) => {
      const st = g.status();
      const lp = legacy.get(g.meta.id);
      return {
        id: g.meta.id, title: g.meta.title, short: g.meta.short, icon: g.meta.icon, fieldWord: g.meta.fieldWord,
        rcon: st.rcon, rconDetail: st.rconDetail, rconPort: st.port,
        fields: st.fields.map((f) => {
          const s = streamerAt(g.meta.id, f.n);
          return { ...f, streamer: s ? { id: s.id, tiktok: s.tiktok, mc: s.mc, status: all.find((x) => x.id === s.id)?.status } : null, overlay: overlayUrl(g.meta.id, f.n) };
        }),
        legacy: lp ? { port: lp.port, bound: lp.bound, error: lp.error } : null,
      };
    }),
    streamers: all,
    log: hubLog.slice(0, 120),
  };
}

// ------------------------------------------------------------------ HTTP
const PANEL_INJECT_HEAD = '<script>window.OVL_BASE = location.origin + location.pathname.replace(/[^/]*$/, \'\');</script>';
function panelBanner() {
  return `<div id="hub-banner" style="background:#0f172a;color:#cbd5e1;border-bottom:1px solid #334155;padding:6px 18px;font:13px 'Yu Gothic UI',Meiryo,sans-serif">` +
    `SharyTech TikTok Hub の一部です。配信者の割り当て・ほかのゲームは <a style="color:#7dd3fc" href="http://127.0.0.1:${hub.hubPort}/" target="_top">ハブのパネル（http://127.0.0.1:${hub.hubPort}/）</a></div>` +
    '<script>if (window.top !== window) document.getElementById(\'hub-banner\').remove();</script>';
}

function htmlFile(gameId, name) {
  return fs.readFileSync(path.join(ROOT, 'games', gameId, name), 'utf8');
}

function servePanel(res, gameId) {
  let html = htmlFile(gameId, 'panel.html');
  html = html.replace(/<head>/i, (m) => `${m}\n${PANEL_INJECT_HEAD}`).replace(/<body>/i, (m) => `${m}\n${panelBanner()}`);
  send(res, 200, 'text/html; charset=utf-8', html);
}

function serveOverlay(res, gameId, base) {
  let html = htmlFile(gameId, 'overlay.html');
  if (base) html = html.replace(/<head>/i, (m) => `${m}\n<base href="${base}">`);
  send(res, 200, 'text/html; charset=utf-8', html);
}

// requests for one game: its panel, overlay, resource pack and API (the same paths as the old app)
async function gameRoute(g, req, res, url) {
  const p = url.pathname;
  if (req.method === 'GET' && (p === '/' || p === '/index.html')) return servePanel(res, g.meta.id);
  if (req.method === 'GET' && p === '/overlay') return serveOverlay(res, g.meta.id, null);
  if (req.method === 'GET' && p === '/resourcepack.zip') {
    const file = g.resourcePack();
    if (!file || !fs.existsSync(file)) return send(res, 404, 'text/plain', 'not found');
    return send(res, 200, 'application/zip', fs.readFileSync(file));
  }
  if (p.startsWith('/api/')) {
    await g.handle(req, res, url);
    if (!res.writableEnded && !res.headersSent) send(res, 404, 'text/plain', 'not found');
    return;
  }
  send(res, 404, 'text/plain', 'not found');
}

function hubPanelFile() {
  return fs.readFileSync(path.join(ROOT, 'public', 'index.html'));
}

async function hubRoute(req, res, url) {
  const p = url.pathname;
  const m = p.match(/^\/g\/([a-z]+)(\/.*)?$/);
  if (m) {
    const g = games.get(m[1]);
    if (!g) return send(res, 404, 'text/plain', 'no such game');
    if (!m[2]) { res.writeHead(302, { Location: `/g/${m[1]}/${url.search}` }); return res.end(); }
    const sub = new URL(m[2] + url.search, 'http://localhost');
    return gameRoute(g, req, res, sub);
  }
  if (req.method === 'GET' && (p === '/' || p === '/index.html')) return send(res, 200, 'text/html; charset=utf-8', hubPanelFile());
  if (req.method === 'GET' && p === '/overlay') {
    const id = url.searchParams.get('game');
    if (id && games.has(id)) return serveOverlay(res, id, `/g/${id}/`);
    const list = [...games.values()].map((g) => `<li>${g.meta.title}: ${g.fields().map((n) => `<a href="/overlay?game=${g.meta.id}&field=${n}">${g.meta.fieldWord}${n}</a>`).join(' ')}</li>`).join('');
    return send(res, 200, 'text/html; charset=utf-8', `<!doctype html><meta charset="utf-8"><title>OBS オーバーレイ</title><body style="font-family:sans-serif"><h1>OBS 用オーバーレイ</h1><p>/overlay?game=ゲーム&field=番号</p><ul>${list}</ul></body>`);
  }
  if (req.method === 'GET' && p === '/api/status') return json(res, statusJson());
  if (req.method === 'GET' && p === '/api/streamers') return json(res, { streamers: streamersJson() });
  if (req.method === 'POST' && p === '/api/streamers') {
    const b = await readBody(req);
    try {
      const s = b.id ? hub.streamers.find((x) => x.id === b.id) : null;
      if (b.id && !s) throw new Error('その配信者はいません');
      if (b.op === 'delete') {
        hub.streamers.splice(hub.streamers.indexOf(s), 1);
        log('info', `配信者 ${streamerLabel(s)} を消しました`);
      } else if (b.op === 'test') {
        // a fake gift that goes through exactly the same routing as a real one from this streamer's LIVE
        if (!assigned(s)) throw new Error('ゲームと番号を割り当ててください');
        const coins = Math.max(1, Math.min(100000, Math.round(Number(b.coins)) || 1));
        const gift = String(b.gift || 'テストギフト').slice(0, 40);
        const name = String(b.name || 'テスト視聴者').slice(0, 24);
        log('info', `${streamerLabel(s)} にテストギフト「${gift}」${coins}コイン → ${games.get(s.game).meta.short} ${games.get(s.game).meta.fieldWord}${s.field}`);
        games.get(s.game).onEvent(s.field, 'gift', { user: { nickname: name, uniqueId: 'test' }, gift: { name: gift, diamondCount: coins, type: 0 }, repeatCount: 1, repeatEnd: true });
        return json(res, { ok: true, game: s.game, field: s.field });
      } else if (b.op === 'connect' || b.op === 'disconnect') {
        if (!s.tiktok) throw new Error('TikTok の ID がありません');
        if (b.op === 'connect') { s.enabled = true; saveHub(); syncConnections(); tiktok.connect(s.id, s.tiktok); }
        else await tiktok.disconnect(s.id);
        return json(res, { ok: true });
      } else {
        const v = cleanStreamer(b.streamer ?? {}, s);
        // one streamer per field: whoever was there is moved out
        if (v.game) for (const x of hub.streamers) if (x !== s && x.game === v.game && x.field === v.field) { x.game = ''; x.field = 0; }
        if (s) Object.assign(s, v); else hub.streamers.push({ id: newId(), ...v });
        log('info', `配信者 ${streamerLabel(v)} → ${v.game ? `${games.get(v.game).meta.short} ${games.get(v.game).meta.fieldWord}${v.field}` : '割り当てなし'}`);
      }
      await streamersChanged();
      return json(res, { ok: true, streamers: streamersJson() });
    } catch (err) {
      return json(res, { ok: false, message: err.message }, 400);
    }
  }
  if (req.method === 'POST' && p === '/api/settings') {
    const b = await readBody(req);
    if (typeof b.signApiKey === 'string') setSignApiKey(b.signApiKey);
    if (Array.isArray(b.enabledGames)) {
      hub.disabledGames = MODULES.map((m) => m.meta.id).filter((id) => !b.enabledGames.includes(id));
      saveHub();
      log('info', `使うゲームを変更しました（${b.enabledGames.join(', ') || 'なし'}）。ハブを起動し直すと反映されます`);
      return json(res, { ok: true, message: 'ハブを起動し直すと反映されます' });
    }
    return json(res, { ok: true });
  }
  send(res, 404, 'text/plain', 'not found');
}

// only this PC's own pages may change things: a custom header forces a CORS preflight that other sites can't pass
const allowed = (req) => req.method !== 'POST' || req.headers['x-hl-panel'] === '1' || req.headers['x-td-panel'] === '1';

function makeServer(route) {
  return http.createServer((req, res) => {
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch { return send(res, 400, 'text/plain', 'bad request'); }
    if (!allowed(req)) return send(res, 403, 'text/plain', 'forbidden');
    route(req, res, url).catch((err) => {
      log('error', `パネル: ${err.message}`);
      if (!res.headersSent) send(res, 500, 'text/plain', 'error');
    });
  });
}

const main = makeServer(hubRoute);
main.on('error', (err) => {
  print('error', `ハブのポート ${hub.hubPort} を使えません: ${err.message}（ハブがもう起動していませんか？）`, '[hub]');
  process.exit(1);
});
main.listen(hub.hubPort, '127.0.0.1', () => {
  log('info', `ハブのパネル: http://127.0.0.1:${hub.hubPort}/   OBS: http://127.0.0.1:${hub.hubPort}/overlay?game=<ゲーム>&field=<番号>`);
});

// ------------------------------------------------------------------ legacy ports (8787-8790)
const legacy = new Map(); // game id -> { port, server, bound, error, warned }
function bindLegacy() {
  for (const [id, g] of games) {
    const want = g.legacyPort();
    let l = legacy.get(id);
    if (l && l.port !== want && l.server) { l.server.close(); l.server = null; l.bound = false; }
    if (!l || l.port !== want) { l = { port: want, server: null, bound: false, error: '', warned: false }; legacy.set(id, l); }
    if (l.bound || l.server || !want || want === hub.hubPort) continue;
    const srv = makeServer((req, res, url) => gameRoute(g, req, res, url));
    l.server = srv;
    srv.once('error', (err) => {
      l.server = null;
      l.bound = false;
      l.error = err.code === 'EADDRINUSE' ? '古いアプリなどが使用中（30秒ごとに再試行）' : err.message;
      if (!l.warned) { log('warn', `${g.meta.title}: 旧ポート ${want} は使用中なので後で再試行します（${err.code ?? err.message}）`); l.warned = true; }
    });
    srv.listen(want, '127.0.0.1', () => {
      l.bound = true;
      l.error = '';
      log('info', `${g.meta.title}: 旧ポート http://127.0.0.1:${want}/ でも受け付けます（パネル・/overlay・/resourcepack.zip）`);
    });
  }
}

// ------------------------------------------------------------------ start
for (const g of games.values()) g.start();
await pushMirrors();
syncConnections();
bindLegacy();
setInterval(bindLegacy, 30000);
setInterval(refreshConnStates, 3000);

process.on('unhandledRejection', (err) => log('error', `内部エラー: ${err?.stack ?? err}`));
process.on('uncaughtException', (err) => log('error', `内部エラー: ${err?.stack ?? err}`));
