// TikTok Defense (銃MOD 一直線ディフェンス) — several fields (lanes) in the same world.
// Each field can have its own streamer: events -> that field's action queue -> RCON
//   -> "function td:f<n>/act/<action> {name:..,gift:..}" (announce) + "function td:f<n>/do/<action>" × count.
// Builds the fields, starts/stops games per field, versus matches, ranking (records file), lobby boards.
// Ported from tiktok-defense/app.
import fs from 'node:fs';
import { Rcon } from '../../core/rcon.js';
import { createAvatar } from '../../core/avatar.js';
import { createEventHandler } from '../../core/events.js';
import { rconTest } from '../../core/rcon-test.js';
import { json, readBody, clean, pick, actionsForGift, readJson } from '../../core/util.js';
import { arenaCommands, lobbyCommands, fieldShape, FIELD_COLORS } from './arena.js';
import { validateConfig, setupServer, GAME_LIMITS } from './config.js';
import { presetEntries, presetSummary, ARMOR_MATERIALS, ARMOR_SLOTS, EFFECTS, ITEM_SLOTS, ITEM_SUGGESTIONS, MAX_ITEMS, MAX_EFFECTS, MAX_PRESETS } from './loadout.js';

export const meta = {
  id: 'defense', title: 'TikTok Defense（銃MOD ディフェンス）', short: 'ディフェンス', icon: '🔫', fieldWord: 'フィールド',
  legacyPort: 8788, rconPort: 25584,
  oldApp: 'tiktok-defense/app',
  sources: {
    'td_datapack.meta.json': 'tiktok-defense/datapack',
    'td_datapack.zip': 'tiktok-defense/datapack',
    'weapons.json': 'tiktok-defense/app/src',
  },
  header: 'x-td-panel',
};

const PLACEHOLDER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
<rect width="24" height="24" fill="#1e293b"/>
<circle cx="12" cy="9" r="5" fill="#e2e8f0"/>
<ellipse cx="12" cy="22" rx="9" ry="7" fill="#e2e8f0"/>
<rect x="0" y="0" width="24" height="2" fill="#fe2c55"/><rect x="0" y="22" width="24" height="2" fill="#25f4ee"/>
</svg>`;

function load(ctx) {
  return {
    META: readJson(ctx.data('td_datapack.meta.json'), { actions: {}, mobs: {}, cfg: {}, maxFields: 8 }),
    WEAPONS: readJson(ctx.data('weapons.json'), {}),
  };
}

export function validate(raw, ctx) {
  const { META, WEAPONS } = load(ctx);
  return validateConfig(raw, META, WEAPONS);
}

export function streamersOf(cfg) {
  const out = {};
  for (let i = 0; i < (cfg.fields?.count ?? 1); i++) {
    const s = cfg.fields?.list?.[i] ?? {};
    out[i + 1] = { tiktok: s.tiktokUsername || '', mc: s.mcName || '' };
  }
  return out;
}

export function createGame(ctx) {
  const { META, WEAPONS } = load(ctx);
  const ACTIONS = META.actions;
  const MAXF = META.maxFields ?? 8;
  const RECORDS_FILE = ctx.stateFile('defense-records.json');
  const { avatarRows, avatarCommands } = createAvatar({ storage: 'td:av', font: 'td:px', svg: PLACEHOLDER_SVG, bg: '#1e293b' });
  let config = validateConfig(ctx.config(), META, WEAPONS);

  const fieldIds = () => Array.from({ length: config.fields.count }, (_, i) => i + 1);
  const newField = (n) => ({
    n, tiktok: 'off', tiktokDetail: '', totalLikes: 0, likeMarks: null, coins: 0,
    game: null, queue: [], cooldownUntil: {}, lastGames: null, players: [], watchers: [],
  });
  const F = {};
  for (let n = 1; n <= MAXF; n++) F[n] = newField(n);
  const state = { rcon: 'unknown', rconDetail: '', log: [], versus: { on: 0, last: null } };
  let overlaySeq = 0;
  const overlayItems = [];
  let lastRconError = '';
  let lastRconErrorAt = 0;
  const recentGifts = new Map();

  function log(kind, text, n = 0) {
    const entry = { t: new Date().toLocaleTimeString('ja-JP'), kind, text: n ? `[F${n}] ${text}` : text, field: n || 0 };
    state.log.unshift(entry);
    state.log.length = Math.min(state.log.length, 300);
    ctx.print(kind, entry.text);
  }

  const fieldNum = (v, def = 1) => {
    const n = Math.round(Number(v));
    return n >= 1 && n <= config.fields.count ? n : def;
  };

  function enqueue(n, action, name, label, source, avatar = null) {
    if (!F[n]) return;
    if (!ACTIONS[action]) {
      log('warn', `未定義のアクション "${action}"（${label}）`, n);
      return;
    }
    const q = F[n].queue;
    const max = config.queue?.maxLength ?? 60;
    if (q.length >= max) {
      const drop = q.shift();
      log('warn', `キューがいっぱいなので「${drop.label}」を捨てました`, n);
    }
    q.push({ n, action, name: clean(name), label: clean(label, 32), source, avatar });
  }

  let running = false;
  let turn = 0;
  async function runNext() {
    if (running) return;
    const ids = fieldIds();
    for (let k = 0; k < ids.length; k++) {
      const n = ids[(turn + k) % ids.length];
      if (!F[n].queue.length) continue;
      turn = (turn + k + 1) % ids.length;
      running = true;
      try { await runOne(F[n].queue.shift()); } finally { running = false; }
      return;
    }
  }

  async function runOne(item) {
    const f = F[item.n];
    const n = item.n;
    let { action } = item;
    const now = Date.now();
    if (f.cooldownUntil[action] > now) {
      log('info', `${ACTIONS[action].label} はクールダウン中 → ${ACTIONS[config.fallbackAction].label}`, n);
      action = config.fallbackAction;
    } else if (config.cooldownSec?.[action]) {
      f.cooldownUntil[action] = now + config.cooldownSec[action] * 1000;
    }
    try {
      if (f.game?.state !== 1) await readGame();
      if (f.game && f.game.state !== 1) {
        log('info', `ゲーム中ではないので「${ACTIONS[action].label}」は実行しませんでした（${item.name}）`, n);
        return;
      }
      for (const c of avatarCommands(await avatarRows(item.avatar))) await rcon.command(c);
      await rcon.command(`function td:f${n}/act/${action} {name:"${item.name}",gift:"${item.label}"}`);
      const times = config.actionCounts[action] ?? 1;
      for (let i = 0; i < times; i++) {
        const res = await rcon.command(`function td:f${n}/do/${action}`);
        if (res && /Unknown|Incorrect|error|Can't/i.test(res)) log('error', `サーバーがエラーを返しました: ${res}`, n);
      }
      if (action === 'weapon') await giveWeapon(n);
      state.rcon = 'connected';
      state.rconDetail = '';
      const last = { id: ++overlaySeq, field: n, name: item.name, gift: item.label, action: ACTIONS[action].label, kind: ACTIONS[action].kind, avatar: item.avatar, at: Date.now() };
      overlayItems.push(last);
      if (overlayItems.length > 60) overlayItems.shift();
      log('action', `${item.name}「${item.label}」→ ${ACTIONS[action].label}${times > 1 ? ` ×${times}` : ''}`, n);
    } catch (err) {
      state.rcon = 'error';
      state.rconDetail = err.message;
      f.queue.unshift(item);
      if (err.message !== lastRconError || Date.now() - lastRconErrorAt > 60000) {
        log('error', `RCON: ${err.message}${/パスワード/.test(err.message) ? '（「接続設定」タブの「サーバーの自動設定」で直せます）' : ''}`);
        lastRconError = err.message;
        lastRconErrorAt = Date.now();
      }
      await new Promise((r) => setTimeout(r, 5000));
    }
  }

  // ------------------------------------------------------------------ game settings -> server
  const ammoCount = (w) => Math.max(1, (WEAPONS[w].mag ?? 1) * config.weapons.ammoMags);

  async function giveWeapon(n) {
    const pool = config.weapons.giftPool;
    if (!pool.length) return;
    const w = pick(pool);
    const info = WEAPONS[w];
    const ammo = info.ammo ?? w;
    const cnt = info.ammo ? ammoCount(w) : 4;
    await rcon.command(`function td:f${n}/weapon {id:"${w}",ammo:"${ammo}",n:${cnt},label:"${clean(info.label, 40)}"}`);
  }

  const presetOf = (n) => {
    const ps = config.weapons.presets;
    return ps.find((p) => p.id === config.weapons.fieldPresets[n - 1]) ?? ps[0];
  };

  // writes the field's set to storage td:cfg lo.f<n> (built in pieces: one RCON command must stay short).
  // pushedLoadout remembers what the server has, so starting a game does not resend everything.
  let pushedLoadout = {};
  async function pushLoadout(key, entries) {
    const snbt = `[${entries.join(',')}]`;
    if (pushedLoadout[key] === snbt) return;
    await rcon.command('data modify storage td:tmp lob set value []');
    let chunk = [];
    const flush = async () => {
      if (!chunk.length) return;
      await rcon.command(`data modify storage td:tmp lop set value [${chunk.join(',')}]`);
      await rcon.command('data modify storage td:tmp lob append from storage td:tmp lop[]');
      chunk = [];
    };
    for (const e of entries) {
      if (chunk.join(',').length + e.length > 900) await flush();
      chunk.push(e);
    }
    await flush();
    const out = await rcon.command(`data modify storage td:cfg ${key} set from storage td:tmp lob`);
    if (/Unknown|Incorrect|Expected|Invalid/i.test(out)) throw new Error(`装備セットを送れませんでした: ${out}`);
    pushedLoadout[key] = snbt;
  }

  const streamerLabel = (n) => {
    const s = config.fields.list[n - 1];
    return s?.mcName || (s?.tiktokUsername ? `@${s.tiktokUsername}` : '');
  };

  async function pushGameSettings() {
    const g = config.game;
    for (const k of Object.keys(GAME_LIMITS)) await rcon.command(`scoreboard players set #${k} td.cfg ${g[k]}`);
    await rcon.command(`scoreboard players set #fields td.cfg ${config.fields.count}`);
    const mobs = Object.entries(config.mobs).map(([m, s]) =>
      `${m}:{hp:${s.hp},speed:${s.speed},scale:${s.scale},dmg:${s.dmg},atk:${s.atk}}`).join(',');
    await rcon.command(`data modify storage td:cfg mobs set value {${mobs}}`);
    await rcon.command(`data modify storage td:cfg game set value {r:${g.spread},avatar:${g.avatarScale}f}`);
    for (let n = 1; n <= config.fields.count; n++) await pushLoadout(`lo.f${n}`, presetEntries(presetOf(n), WEAPONS));
    await pushLoadout('loadout', presetEntries(presetOf(1), WEAPONS));
    for (let n = 1; n <= MAXF; n++) {
      const label = n <= config.fields.count ? streamerLabel(n) : '';
      if (label) {
        await rcon.command(`data modify storage td:own f${n} set value "${clean(label, 30)}"`);
        await rcon.command(`scoreboard players set #rsv td.f${n} 1`);
      } else {
        await rcon.command(`data remove storage td:own f${n}`);
        await rcon.command(`scoreboard players set #rsv td.f${n} 0`);
      }
    }
  }

  // asks the server whether every item of the sets can be given (unknown ids / enchantments are skipped by the game)
  async function checkPresetItems() {
    if (state.rcon !== 'connected') return [];
    const bad = [];
    for (const p of config.weapons.presets) {
      for (const it of p.items) {
        const ench = it.ench ? `[enchantments={${it.ench}}]` : '';
        const out = await rcon.command(`give @a[name=td_check_only] ${it.id}${ench} 1`);
        if (!/No player was found/i.test(out)) bad.push(`「${p.name}」の ${it.id}${it.ench ? `（${it.ench}）` : ''}`);
      }
    }
    return bad;
  }

  let building = false;
  async function runBuild(pre, commands, what) {
    for (const c of pre) await rcon.command(c);
    await new Promise((r) => setTimeout(r, 3000));
    let bad = 0;
    for (const c of commands) {
      const out = await rcon.command(c);
      if (/not loaded|Unknown|Incorrect|Expected|Invalid|malformed/i.test(out)) { bad++; if (bad <= 3) log('warn', `${what}: ${out.slice(0, 160)}`); }
    }
    return bad;
  }

  async function buildField(what) {
    if (building) throw new Error('いま作っています');
    building = true;
    try {
      await pushGameSettings();
      const done = [];
      if (what === 'lobby' || what === 'all') {
        const { pre, commands } = lobbyCommands(config.field, config.fields, fieldIds().map(streamerLabel));
        const bad = await runBuild(pre, commands, '待機所');
        log('info', `待機所を作りました${bad ? `（失敗 ${bad} 件）` : ''}`);
        done.push('待機所');
      }
      const list = what === 'all' ? fieldIds() : typeof what === 'number' ? [what] : [];
      for (const n of list) {
        const f = fieldShape(config.field, config.fields, n);
        const { pre, commands, gates } = arenaCommands(f, n, streamerLabel(n));
        const bad = await runBuild(pre, commands, `フィールド${n}`);
        log('info', `フィールドを作りました（z=${f.originZ}、長さ ${f.length}、幅 ${f.halfWidth * 2 + 1}、関門 ${gates.length} 個${bad ? `、失敗 ${bad} 件` : ''}）`, n);
        done.push(`フィールド${n}`);
      }
      await updateLobbyBoards(true).catch(() => {});
      return done;
    } finally {
      building = false;
    }
  }

  async function topUpAmmo() {
    if (!config.weapons.infiniteAmmo || state.rcon !== 'connected') return;
    const types = new Set();
    for (const w of [...config.weapons.presets.flatMap((p) => p.guns), ...config.weapons.giftPool]) if (WEAPONS[w].ammo) types.add(WEAPONS[w].ammo);
    for (const n of fieldIds()) {
      if (F[n].game?.state !== 1) continue;
      const sel = `@a[scores={td.fld=${n}},gamemode=!spectator]`;
      for (const a of types) {
        await rcon.command(`execute as ${sel} store result score @s td.v run clear @s ${a} 0`);
        await rcon.command(`give @a[scores={td.fld=${n},td.v=1..63},gamemode=!spectator] ${a} 128`);
      }
    }
  }

  function parseCompound(out) {
    const res = {};
    for (const m of out.matchAll(/f(\d+): \{([^}]*)\}/g)) {
      const o = {};
      for (const kv of m[2].matchAll(/(\w+): (-?\d+)/g)) o[kv[1]] = Number(kv[2]);
      res[Number(m[1])] = o;
    }
    return res;
  }

  async function readGame() {
    const all = parseCompound(await rcon.command('data get storage td:st'));
    for (const n of fieldIds()) {
      const s = all[n];
      if (!s) continue;
      const prevGames = F[n].lastGames;
      F[n].game = {
        state: s.state, left: s.left, time: config.game.time, core: s.core, coreMax: config.game.coreHp,
        front: s.front, gates: config.field.gates, gateHp: s.gateHp, gateMax: config.game.gateHp,
        enemies: s.enemies, kills: s.kills, elapsed: s.elapsed, players: s.players, watchers: s.watchers,
        vs: s.vs, wasvs: s.wasvs, built: s.built, result: s.result, games: s.games,
      };
      F[n].lastGames = s.games;
      if (prevGames != null && s.games > prevGames) onGameEnded(n, F[n].game).catch((e) => log('warn', `記録できませんでした: ${e.message}`, n));
    }
    const vs = await rcon.command('data get storage td:vs');
    const on = await rcon.command('scoreboard players get #vsOn td.v');
    state.versus.on = Number(on.match(/has (-?\d+)/)?.[1] ?? 0);
    const lm = vs.match(/last: \{([^}]*)\}/);
    if (lm) {
      const o = {};
      for (const kv of lm[1].matchAll(/(\w+): (-?\d+)/g)) o[kv[1]] = Number(kv[2]);
      if (state.versus.lastN != null && o.n > state.versus.lastN) onVersusEnded(o);
      state.versus.lastN = o.n;
      state.versus.lastRaw = o;
    } else if (state.versus.lastN == null) {
      state.versus.lastN = 0;
    }
    const cm = vs.match(/cur: \{a: (\d+), b: (\d+)\}/);
    state.versus.cur = cm ? { a: Number(cm[1]), b: Number(cm[2]) } : null;
  }

  async function readPlayers() {
    const out = await rcon.command('list');
    const names = (out.split(':')[1] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const byField = {};
    for (const name of names) {
      if (!/^\w+$/.test(name)) continue;
      const m = (await rcon.command(`scoreboard players get ${name} td.fld`)).match(/has (-?\d+)/);
      const n = m ? Number(m[1]) : 0;
      if (!n) continue;
      const spec = /passed/i.test(await rcon.command(`execute if entity @a[name=${name},tag=td.spec]`));
      (byField[n] ??= { players: [], watchers: [] })[spec ? 'watchers' : 'players'].push(name);
    }
    for (let n = 1; n <= MAXF; n++) {
      F[n].players = byField[n]?.players ?? [];
      F[n].watchers = byField[n]?.watchers ?? [];
    }
    state.online = names;
  }

  // ------------------------------------------------------------------ records / ranking
  let records = readJson(RECORDS_FILE, []);
  const saveRecords = () => fs.writeFileSync(RECORDS_FILE, JSON.stringify(records, null, 1) + '\n', 'utf8');
  const rulesKey = (g = config.game) => `制限${g.time ? `${Math.round(g.time / 60 * 10) / 10}分` : 'なし'}・コア${g.coreHp}・関門${g.gateHp}・湧き${g.waveSec}秒`;
  const fieldWho = (n) => F[n].players.length ? F[n].players : [streamerLabel(n) || `フィールド${n}`];

  async function onGameEnded(n, g) {
    if (F[n].players.length === 0) await readPlayers().catch(() => {});
    const rec = {
      at: new Date().toISOString(), field: n, result: g.result === 1 ? 'win' : 'lose',
      kills: g.kills, survived: g.elapsed, players: F[n].players.length ? F[n].players : streamerLabel(n) ? [streamerLabel(n)] : [], streamer: streamerLabel(n),
      tiktok: config.fields.list[n - 1]?.tiktokUsername || '', versus: Boolean(g.wasvs),
      rules: rulesKey(), time: config.game.time,
    };
    records.push(rec);
    if (records.length > 5000) records.splice(0, records.length - 5000);
    saveRecords();
    log('info', `ゲーム終了: ${rec.result === 'win' ? '防衛成功' : 'コア陥落'}・撃破 ${rec.kills}・生存 ${rec.survived}秒（${rec.players.join(', ') || 'プレイヤーなし'}）`, n);
    await updateLobbyBoards(true).catch(() => {});
  }

  function onVersusEnded(o) {
    const who = (n) => fieldWho(n).join('・');
    const named = (n) => F[n].players.length ? F[n].players : streamerLabel(n) ? [streamerLabel(n)] : [];
    const res = {
      at: new Date().toISOString(), a: o.a, b: o.b, winner: o.w === 1 ? o.a : o.w === 2 ? o.b : 0,
      aWho: who(o.a), bWho: who(o.b), ka: o.ka, kb: o.kb, ta: o.ta, tb: o.tb, rules: rulesKey(),
    };
    state.versus.last = res;
    records.push({ at: res.at, type: 'versus', ...res, winnerNames: res.winner ? named(res.winner) : [] });
    saveRecords();
    log('info', `対戦結果: フィールド${o.a}（${res.aWho}）撃破${o.ka} vs フィールド${o.b}（${res.bWho}）撃破${o.kb} → ${res.winner ? `フィールド${res.winner} の勝ち` : '引き分け'}`);
  }

  function leaderboard(scope = 'current') {
    const key = rulesKey();
    const games = records.filter((r) => r.type !== 'versus' && (scope === 'all' || r.rules === key));
    const vsRecs = records.filter((r) => r.type === 'versus' && (scope === 'all' || r.rules === key));
    const best = (val) => {
      const m = new Map();
      for (const r of games) for (const p of r.players) {
        const v = val(r);
        if (!m.has(p) || v > m.get(p).value) m.set(p, { name: p, value: v, field: r.field, at: r.at, result: r.result });
      }
      return [...m.values()].sort((a, b) => b.value - a.value).slice(0, 10);
    };
    const count = (list, pred, names) => {
      const m = new Map();
      for (const r of list) if (pred(r)) for (const p of names(r)) m.set(p, (m.get(p) ?? 0) + 1);
      return [...m.entries()].map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value).slice(0, 10);
    };
    return {
      rules: key, scope, games: games.length,
      kills: best((r) => r.kills),
      survival: best((r) => r.survived),
      wins: count(games, (r) => r.result === 'win', (r) => r.players),
      versus: count(vsRecs, (r) => r.winner, (r) => r.winnerNames ?? []),
      recent: records.slice(-15).reverse(),
    };
  }

  // ------------------------------------------------------------------ waiting-area boards (text displays)
  const boardCache = {};
  async function setDisplay(selector, key, text, force) {
    if (!force && boardCache[key] === text) return;
    const out = await rcon.command(`data modify entity @e[${selector},limit=1] text set value ${text}`);
    if (!/No entity|not found|Unknown/i.test(out)) boardCache[key] = text;
  }
  const q = (s) => JSON.stringify(String(s));
  const mmss = (s) => `${Math.floor(Math.max(0, s) / 60)}:${String(Math.max(0, s) % 60).padStart(2, '0')}`;

  async function updateLobbyBoards(force = false) {
    if (state.rcon !== 'connected') return;
    for (const n of fieldIds()) {
      const g = F[n].game;
      const col = FIELD_COLORS[n - 1];
      let line2 = '{text:"空いています",color:"green"}';
      if (g?.vs) line2 = '{text:"対戦中",color:"light_purple"}';
      else if (g?.state === 1) line2 = `{text:${q(`ゲーム中 ${config.game.time ? `残り${mmss(g.left)}` : `${mmss(g.elapsed)}経過`}・撃破${g.kills}`)},color:"red"}`;
      else if (g?.state === 2) line2 = `{text:${q(`終了（${g.result === 1 ? '防衛成功' : 'コア陥落'}・撃破${g.kills}）`)},color:"gray"}`;
      if (g && !g.built) line2 = '{text:"未作成",color:"dark_gray"}';
      const label = streamerLabel(n);
      const text = `{text:"",extra:[{text:${q(`フィールド${n}`)},color:"${col}",bold:true},{text:"\\n"},${line2}` +
        (F[n].players.length ? `,{text:"\\n"},{text:${q(F[n].players.join(', ').slice(0, 40))},color:"yellow"}` : '') +
        (label ? `,{text:"\\n"},{text:${q(`配信: ${label}`)},color:"light_purple"}` : '') + ']}';
      await setDisplay(`tag=td.lstat,tag=td.f${n}`, `lstat${n}`, text, force);
    }
    const lb = leaderboard('current');
    const sec = (title, list, unit, color) => [`{text:${q(`\n${title}\n`)},color:"${color}",bold:true}`,
      list.length ? `{text:${q(list.slice(0, 5).map((e, i) => `${i + 1}. ${e.name}  ${e.value}${unit}`).join('\n'))},color:"white"}` : '{text:"まだ記録がありません",color:"gray"}'];
    const parts = [
      '{text:"🏆 ランキング\\n",color:"gold",bold:true}',
      `{text:${q(lb.rules)},color:"gray"}`,
      ...sec('ベスト撃破数', lb.kills, '体', 'yellow'),
      ...sec('最長生存', lb.survival, '秒', 'aqua'),
      ...sec('防衛成功の回数', lb.wins, '回', 'green'),
      ...sec('対戦の勝ち数', lb.versus, '勝', 'light_purple'),
    ];
    await setDisplay('tag=td.board', 'board', `{text:"",extra:[${parts.join(',')}]}`, force);
  }

  // ------------------------------------------------------------------ RCON
  let rcon = new Rcon(config.rcon);
  async function checkRcon() {
    try {
      await rcon.command('list');
      if (state.rcon !== 'connected') {
        state.rcon = 'connected';
        state.rconDetail = '';
        pushedLoadout = {};
        await pushGameSettings().catch((e) => log('warn', `設定を送れませんでした: ${e.message}`));
      }
    } catch (err) {
      state.rcon = 'error';
      state.rconDetail = err.message;
    }
  }

  const onEvent = createEventHandler({
    log, enqueue, config: () => config, recentGifts,
    addCoins: (n, c) => { if (F[n]) F[n].coins += c; },
    likeState: (n) => F[n] ?? { totalLikes: 0, likeMarks: null },
  });

  let queueTimer = null;
  async function applyConfig(next) {
    const prev = config;
    config = next;
    if (JSON.stringify(prev.rcon) !== JSON.stringify(next.rcon)) {
      rcon.close();
      rcon = new Rcon(next.rcon);
      state.rcon = 'unknown';
      await checkRcon();
    } else if (state.rcon === 'connected') {
      await pushGameSettings().catch((e) => log('warn', `設定を送れませんでした: ${e.message}`));
    }
    if (prev.queue.intervalMs !== next.queue.intervalMs && queueTimer) {
      clearInterval(queueTimer);
      queueTimer = setInterval(runNext, next.queue.intervalMs);
    }
    if (prev.likes.every !== next.likes.every) for (let n = 1; n <= MAXF; n++) F[n].likeMarks = null;
    const fieldChanged = JSON.stringify(prev.field) !== JSON.stringify(next.field)
      || prev.fields.count !== next.fields.count || prev.fields.spacing !== next.fields.spacing;
    return { fieldChanged };
  }

  async function store(next, fromPanel) {
    if (fromPanel && next.signApiKey !== ctx.signApiKey()) ctx.setSignApiKey(next.signApiKey);
    ctx.save({ ...next, signApiKey: '' });
    const r = await applyConfig(next);
    if (fromPanel) await ctx.fieldsEdited();
    return r;
  }

  const GAME_CMDS = {
    start: ['start', 'ゲームを開始しました'],
    stop: ['stop', 'ゲームを止めました'],
    clear: ['clear', '敵を全部消しました'],
    loadout: ['loadout', '装備を配り直しました'],
  };

  function stateJson() {
    const fields = fieldIds().map((n) => {
      const f = F[n];
      const s = config.fields.list[n - 1];
      return {
        n, color: FIELD_COLORS[n - 1], game: f.game, tiktok: f.tiktok, tiktokDetail: f.tiktokDetail,
        username: s.tiktokUsername, mcName: s.mcName, queue: f.queue.length, coins: f.coins, totalLikes: f.totalLikes,
        players: f.players, watchers: f.watchers, preset: { id: presetOf(n).id, name: presetOf(n).name },
      };
    });
    const f1 = fields[0];
    return {
      rcon: state.rcon, rconDetail: state.rconDetail, log: state.log, actions: ACTIONS,
      fields, count: config.fields.count, versus: state.versus, online: state.online ?? [],
      tiktok: f1.tiktok, tiktokDetail: f1.tiktokDetail, username: f1.username, game: f1.game,
      queue: fields.reduce((a, f) => a + f.queue, 0), coins: fields.reduce((a, f) => a + f.coins, 0),
      totalLikes: fields.reduce((a, f) => a + f.totalLikes, 0),
    };
  }

  async function handle(req, res, url) {
    const p = url.pathname;
    if (req.method === 'GET' && p === '/api/overlay') {
      const n = fieldNum(url.searchParams.get('field'));
      const since = Number(url.searchParams.get('since')) || 0;
      return json(res, {
        field: n, color: FIELD_COLORS[n - 1], latest: overlaySeq,
        items: overlayItems.filter((i) => i.id > since && i.field === n), game: F[n].game,
        streamer: streamerLabel(n), players: F[n].players, versus: state.versus,
      });
    }
    if (req.method === 'GET' && p === '/api/config') {
      const loadoutInfo = {
        armorMaterials: ARMOR_MATERIALS, armorSlots: ARMOR_SLOTS.map(([k, , , label]) => [k, label]), effects: EFFECTS,
        itemSlots: ITEM_SLOTS, items: ITEM_SUGGESTIONS, maxItems: MAX_ITEMS, maxEffects: MAX_EFFECTS, maxPresets: MAX_PRESETS,
        summaries: Object.fromEntries(config.weapons.presets.map((p) => [p.id, presetSummary(p, WEAPONS)])),
      };
      return json(res, { config: { ...config, signApiKey: ctx.signApiKey() }, loadoutInfo, actions: ACTIONS, mobs: META.mobs, weapons: WEAPONS, maxFields: MAXF, colors: FIELD_COLORS, recentGifts: [...recentGifts.values()], configFile: ctx.configFile() });
    }
    if (req.method === 'POST' && p === '/api/config') {
      try {
        const next = validateConfig(await readBody(req), META, WEAPONS);
        const { fieldChanged } = await store(next, true);
        log('info', '設定を保存しました');
        const notes = ['保存して反映しました。'];
        const bad = await checkPresetItems().catch(() => []);
        if (bad.length) notes.push(`ただし、サーバーが受け付けないアイテムがあります（配られません）: ${bad.join('、')}`);
        if (fieldChanged) notes.push('フィールドの形・数・間隔は「全フィールドと待機所を作り直す」を押すと変わります。');
        return json(res, { ok: true, message: notes.join('') });
      } catch (err) {
        return json(res, { ok: false, message: err.message }, 400);
      }
    }
    if (req.method === 'POST' && p === '/api/rcon-test') return rconTest(res, await readBody(req), meta.rconPort);
    if (req.method === 'POST' && p === '/api/server-setup') {
      const b = await readBody(req);
      try {
        const s = setupServer(ctx.data('td_datapack.zip'), b.serverDir, b.port);
        const next = validateConfig({ ...config, rcon: { host: '127.0.0.1', port: s.port, password: s.password } }, META, WEAPONS);
        await store(next, false);
        log('info', `サーバーを設定しました（ワールド ${s.world}）`);
        return json(res, { ok: true, message: `RCON を有効にし、ワールド「${s.world}」にデータパックを入れました。パスワードもこのアプリに保存しました。${s.changed ? 'サーバーを再起動してください（server.properties を変更しました。元のファイルは server.properties.bak）。' : 'サーバーで /reload を実行すると反映されます。'}` });
      } catch (err) {
        return json(res, { ok: false, message: err.message }, 400);
      }
    }
    if (req.method === 'POST' && p === '/api/game') {
      const b = await readBody(req);
      try {
        if (b.cmd === 'build') {
          const what = b.field === 'all' || b.field === 'lobby' ? b.field : fieldNum(b.field);
          const done = await buildField(what);
          return json(res, { ok: true, message: `${done.join('・')}を作りました` });
        }
        const g = GAME_CMDS[b.cmd];
        if (!g) return json(res, { ok: false, message: 'unknown command' }, 400);
        const n = fieldNum(b.field);
        if (b.cmd === 'start') { F[n].queue.length = 0; await pushGameSettings(); }
        if (b.cmd === 'loadout') await pushGameSettings();
        const out = await rcon.command(`function td:f${n}/${g[0]}`);
        if (/Unknown|Incorrect/i.test(out)) throw new Error(out);
        if (b.cmd === 'start' || b.cmd === 'stop') F[n].queue.length = 0;
        log('info', g[1], n);
        await readGame().catch(() => {});
        return json(res, { ok: true, message: `フィールド${n}: ${g[1]}` });
      } catch (err) {
        return json(res, { ok: false, message: err.message }, 500);
      }
    }
    if (req.method === 'POST' && p === '/api/loadout') {
      // pick the field's 装備セット (and give it right away when asked)
      const b = await readBody(req);
      const n = fieldNum(b.field);
      const preset = config.weapons.presets.find((x) => x.id === b.preset);
      if (!preset) return json(res, { ok: false, message: 'その装備セットはありません' }, 400);
      try {
        const fieldPresets = [...config.weapons.fieldPresets];
        fieldPresets[n - 1] = preset.id;
        await store(validateConfig({ ...config, weapons: { ...config.weapons, fieldPresets } }, META, WEAPONS), false);
        log('info', `装備セットを「${preset.name}」にしました`, n);
        let note = '';
        if (b.give) {
          if (state.rcon !== 'connected') throw new Error('サーバーにつながっていません');
          await pushGameSettings();
          await rcon.command(`function td:f${n}/loadout`);
          note = '（フィールドにいる人に配り直しました）';
        }
        return json(res, { ok: true, message: `フィールド${n} の装備セット: ${preset.name}${note}` });
      } catch (err) {
        return json(res, { ok: false, message: err.message }, 500);
      }
    }
    if (req.method === 'POST' && p === '/api/assign') {
      const b = await readBody(req);
      const n = fieldNum(b.field);
      const name = String(b.name || config.fields.list[n - 1].mcName || '');
      if (!/^\w{1,16}$/.test(name)) return json(res, { ok: false, message: 'マイクラの名前が未設定です' }, 400);
      try {
        const online = /passed/i.test(await rcon.command(`execute if entity @a[name=${name}]`));
        if (online) await rcon.command(`execute as ${name} run function td:f${n}/join`);
        if (online) log('info', `${name} をフィールド${n} に入れました`, n);
        readPlayers().catch(() => {});
        return json(res, { ok: online, message: online ? `${name} をフィールド${n} に入れました` : `${name} はいまサーバーにいません` });
      } catch (err) {
        return json(res, { ok: false, message: err.message }, 500);
      }
    }
    if (req.method === 'POST' && p === '/api/versus') {
      const b = await readBody(req);
      try {
        if (b.cancel) {
          await rcon.command('function td:vs/cancel');
          log('info', '対戦を中止しました');
          return json(res, { ok: true, message: '対戦を中止しました' });
        }
        const a = fieldNum(b.a, 0), bb = fieldNum(b.b, 0);
        if (!a || !bb || a === bb) return json(res, { ok: false, message: '違う2つのフィールドを選んでください' }, 400);
        await pushGameSettings();
        F[a].queue.length = 0; F[bb].queue.length = 0;
        const before = await rcon.command('scoreboard players get #vsOn td.v');
        if (/has [12]/.test(before)) return json(res, { ok: false, message: 'ほかの対戦が進んでいるので始められません（先に中止してください）' });
        const out = await rcon.command(`function td:vs/begin {a:${a},b:${bb}}`);
        if (/Unknown|Incorrect/i.test(out)) throw new Error(out);
        await readGame().catch(() => {});
        if (!state.versus.on) return json(res, { ok: false, message: 'ほかの対戦が進んでいるので始められません（先に中止してください）' });
        log('info', `対戦: フィールド${a} vs フィールド${bb}（5秒後に同時スタート）`);
        return json(res, { ok: true, message: `フィールド${a} vs フィールド${bb}：5秒後に同時スタートします` });
      } catch (err) {
        return json(res, { ok: false, message: err.message }, 500);
      }
    }
    if (req.method === 'GET' && p === '/api/leaderboard') {
      return json(res, leaderboard(url.searchParams.get('scope') === 'all' ? 'all' : 'current'));
    }
    if (req.method === 'GET' && p === '/api/state') return json(res, stateJson());
    if (req.method === 'POST' && p === '/api/test') {
      const b = await readBody(req);
      const n = fieldNum(b.field);
      if (b.action) {
        enqueue(n, String(b.action), b.name || 'テスト', 'テスト', 'test', b.avatar || null);
      } else {
        const coins = Math.max(1, Number(b.coins) || 1);
        const repeat = Math.max(1, Number(b.repeat) || 1);
        const giftName = String(b.gift || 'テストギフト');
        F[n].coins += coins * repeat;
        log('gift', `[テスト] ${b.name || 'テスト'} → ${giftName} ×${repeat}（${coins * repeat}コイン）`, n);
        for (const a of actionsForGift(config.giftRules, giftName, coins, repeat)) enqueue(n, a, b.name || 'テスト', `${giftName}×${repeat}`, 'test', b.avatar || null);
      }
      return json(res, { ok: true, field: n });
    }
    if (req.method === 'POST' && p === '/api/tiktok') {
      const b = await readBody(req);
      await ctx.tiktokControl(b.field ? fieldNum(b.field) : null, Boolean(b.connect));
      return json(res, { ok: true });
    }
    if (req.method === 'POST' && p === '/api/clear') {
      const b = await readBody(req);
      const n = fieldNum(b.field);
      F[n].queue.length = 0;
      await rcon.command(`function td:f${n}/clear`).catch(() => {});
      log('info', 'キューを空にして、敵を全部消しました', n);
      return json(res, { ok: true });
    }
    return false;
  }

  return {
    meta,
    fields: () => fieldIds(),
    fieldStreamers: () => streamersOf(config),
    async setStreamers(map) {
      let changed = false;
      const list = config.fields.list.map((s, i) => {
        const w = (i < config.fields.count ? map[i + 1] : null) ?? { tiktok: '', mc: '' };
        const mcName = w.mc || '';
        if (s.tiktokUsername !== w.tiktok || s.mcName !== mcName) changed = true;
        return { tiktokUsername: w.tiktok, mcName };
      });
      if (!changed) return;
      await store(validateConfig({ ...config, fields: { ...config.fields, list } }, META, WEAPONS), false);
    },
    setConn(field, c) {
      const f = F[field];
      if (!f) return;
      f.tiktok = c.status;
      f.tiktokDetail = c.detail;
      if (c.reset) { f.likeMarks = null; f.totalLikes = 0; }
    },
    onEvent,
    handle,
    log,
    resourcePack: () => null,
    status: () => ({
      rcon: state.rcon, rconDetail: state.rconDetail, port: config.rcon.port,
      fields: fieldIds().map((n) => ({ n, queue: F[n].queue.length, state: F[n].game ? ({ 0: '待機中', 1: 'ゲーム中', 2: '終了' })[F[n].game.state] ?? '-' : null, people: F[n].players.length })),
    }),
    legacyPort: () => config.panelPort,
    start() {
      queueTimer = setInterval(runNext, config.queue?.intervalMs ?? 700);
      setInterval(() => { if (state.rcon !== 'connected') checkRcon(); }, 10000);
      setInterval(() => { if (state.rcon === 'connected' && !building) readGame().catch(() => {}); }, 1000);
      setInterval(() => { if (state.rcon === 'connected' && !building) readPlayers().catch(() => {}); }, 4000);
      setInterval(() => { if (state.rcon === 'connected' && !building) updateLobbyBoards().catch(() => {}); }, 2000);
      setInterval(() => { if (!building) topUpAmmo().catch(() => {}); }, 8000);
      checkRcon().then(async () => {
        if (state.rcon === 'connected') {
          rcon.command('function td:ping').catch(() => {});
          await readGame().catch(() => {});
          await readPlayers().catch(() => {});
          updateLobbyBoards(true).catch(() => {});
        }
        log(state.rcon === 'connected' ? 'info' : 'error',
          state.rcon === 'connected' ? 'Minecraft サーバー（RCON）に接続しました' : `RCON に接続できません: ${state.rconDetail}（「接続設定」タブで設定してください）`);
      });
    },
  };
}
