// Clash Royale MC (マイクラ版クラロワ) — several arenas.
// Each arena can have its own streamer; their events only affect that arena:
//   -> "execute in <arena dimension> run function crmc:<arena>/live/act/<action> {name:..,gift:..}".
// The per-arena "game" settings (bot difficulty, match length, decks, ...) are pushed to the server as scores/storage.
// Ported from clash-royale-mc/tiktok-live.
import { Rcon } from '../../core/rcon.js';
import { createAvatar } from '../../core/avatar.js';
import { createEventHandler } from '../../core/events.js';
import { rconTest } from '../../core/rcon-test.js';
import { json, readBody, clean, actionsForGift, readJson } from '../../core/util.js';
import { validateConfig, setupServer } from './config.js';

export const meta = {
  id: 'clash', title: 'マイクラ版クラロワ', short: 'クラロワ', icon: '👑', fieldWord: 'アリーナ',
  legacyPort: 8789, rconPort: 25581,
  oldApp: 'clash-royale-mc/tiktok-live',
  sources: {
    'crmc_datapack.actions.json': 'clash-royale-mc/tiktok-live/datapack',
    'crmc_datapack.cards.json': 'clash-royale-mc/tiktok-live/datapack',
    'crmc_datapack.arenas.json': 'clash-royale-mc/tiktok-live/datapack',
    'crmc_datapack.zip': 'clash-royale-mc/tiktok-live/datapack',
    'crmc_resourcepack.zip': 'clash-royale-mc/tiktok-live/resourcepack',
  },
};

const CROWN_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
<rect width="24" height="24" fill="#1e3a8a"/>
<polygon points="3,18 3,8 8,12 12,5 16,12 21,8 21,18" fill="#facc15"/>
<rect x="3" y="18" width="18" height="2.5" fill="#eab308"/>
<circle cx="12" cy="13" r="1.6" fill="#ef4444"/><circle cx="7" cy="15" r="1.1" fill="#38bdf8"/><circle cx="17" cy="15" r="1.1" fill="#38bdf8"/>
</svg>`;

function load(ctx) {
  return {
    ACTIONS: readJson(ctx.data('crmc_datapack.actions.json'), {}),
    CARDS: readJson(ctx.data('crmc_datapack.cards.json'), []),
    ARENA_INFO: readJson(ctx.data('crmc_datapack.arenas.json'),
      [{ id: 1, dim: 'minecraft:overworld', fn: 'crmc:', obj: 'cr', cfg: 'crmc:cfg', tag: 'cr' }]),
  };
}

export function validate(raw, ctx) {
  const { ACTIONS, CARDS, ARENA_INFO } = load(ctx);
  return validateConfig(raw, ACTIONS, CARDS, ARENA_INFO.length);
}

export function streamersOf(cfg) {
  const out = {};
  (cfg.arenas ?? []).forEach((a, i) => { out[i + 1] = { tiktok: a.tiktokUsername || '', mc: a.player || '' }; });
  return out;
}

export function createGame(ctx) {
  const { ACTIONS, CARDS, ARENA_INFO } = load(ctx);
  const { avatarRows, avatarCommands } = createAvatar({ storage: 'crmc:av', font: 'crmc:px', svg: CROWN_SVG, bg: '#1e3a8a' });
  let config = ctx.config();
  try { config = validateConfig(config, ACTIONS, CARDS, ARENA_INFO.length); } catch { /* keep as loaded */ }
  const reval = (c) => validateConfig(c, ACTIONS, CARDS, ARENA_INFO.length);

  const state = { rcon: 'unknown', rconDetail: '', log: [], last: null, race: 0, players: 0 };
  const arenas = ARENA_INFO.map((info) => ({
    id: info.id, info,
    tiktok: 'off', tiktokDetail: '', totalLikes: 0, likeMarks: null, coins: 0, username: '',
    game: null,
  }));
  const arenaById = (id) => arenas.find((a) => a.id === Number(id)) ?? null;
  const arenaCfg = (a) => config.arenas?.[a.id - 1] ?? {};
  const cooldownUntil = {};
  let overlaySeq = 0;
  const overlayItems = [];
  let lastRconError = '';
  let lastRconErrorAt = 0;
  const recentGifts = new Map();
  const queue = [];
  let leaderboard = { updated: 0, rows: [] };

  function log(kind, text, arena = null) {
    const entry = { t: new Date().toLocaleTimeString('ja-JP'), kind, text: arena ? `[アリーナ${arena}] ${text}` : text, arena };
    state.log.unshift(entry);
    state.log.length = Math.min(state.log.length, 300);
    ctx.print(kind, entry.text);
  }

  function enqueue(arena, action, name, label, source, avatar = null) {
    if (!ACTIONS[action]) {
      log('warn', `未定義のアクション "${action}"（${label}）`, arena);
      return;
    }
    const max = config.queue?.maxLength ?? 40;
    const mine = queue.filter((q) => q.arena === arena);
    if (mine.length >= max) {
      queue.splice(queue.indexOf(mine[0]), 1);
      log('warn', `キューがいっぱいなので「${mine[0].label}」を捨てました`, arena);
    }
    queue.push({ arena, action, name: clean(name), label: clean(label, 32), source, avatar });
  }

  let running = false;
  let rr = 0;
  async function runNext() {
    if (running || !queue.length) return;
    running = true;
    try {
      let idx = -1;
      for (let k = 0; k < arenas.length && idx < 0; k++) {
        const id = arenas[(rr + k) % arenas.length].id;
        idx = queue.findIndex((q) => q.arena === id);
      }
      if (idx < 0) idx = 0;
      rr = (arenas.findIndex((a) => a.id === queue[idx].arena) + 1) % arenas.length;
      const [item] = queue.splice(idx, 1);
      await runOne(item);
    } finally { running = false; }
  }

  async function runOne(item) {
    let { action } = item;
    const a = arenaById(item.arena) ?? arenas[0];
    const key = `${a.id}:${action}`;
    const now = Date.now();
    if (cooldownUntil[key] > now) {
      log('info', `${ACTIONS[action].label} はクールダウン中 → ${config.fallbackAction}`, a.id);
      action = config.fallbackAction;
    } else if (config.cooldownSec?.[action]) {
      cooldownUntil[key] = now + config.cooldownSec[action] * 1000;
    }
    const cmd = `execute in ${a.info.dim} positioned 0.5 64 0.5 run function ${a.info.fn}live/act/${action} {name:"${item.name}",gift:"${item.label}"}`;
    try {
      for (const c of avatarCommands(await avatarRows(item.avatar))) await rcon.command(c);
      const res = await rcon.command(cmd);
      state.rcon = 'connected';
      state.rconDetail = '';
      if (res && /Unknown|Incorrect|error|Can't/i.test(res)) log('error', `サーバーがエラーを返しました: ${res}`, a.id);
      state.last = { id: ++overlaySeq, arena: a.id, name: item.name, gift: item.label, action: ACTIONS[action].label, avatar: item.avatar, at: Date.now() };
      overlayItems.push(state.last);
      if (overlayItems.length > 40) overlayItems.shift();
      log('action', `${item.name}「${item.label}」→ ${ACTIONS[action].label}`, a.id);
    } catch (err) {
      state.rcon = 'error';
      state.rconDetail = err.message;
      queue.unshift(item);
      if (err.message !== lastRconError || Date.now() - lastRconErrorAt > 60000) {
        log('error', `RCON: ${err.message}${/パスワード/.test(err.message) ? '（「接続設定」タブの「サーバーの自動設定」で直せます）' : ''}`);
        lastRconError = err.message;
        lastRconErrorAt = Date.now();
      }
      await new Promise((r) => setTimeout(r, 5000));
    }
  }

  let rcon = new Rcon(config.rcon);
  let gameApplied = false;
  async function checkRcon() {
    try {
      await rcon.command('list');
      state.rcon = 'connected';
      state.rconDetail = '';
      if (!gameApplied) await applyGame().catch(() => {});
    } catch (err) {
      state.rcon = 'error';
      state.rconDetail = err.message;
      gameApplied = false;
    }
  }

  function arenaLabel(g) {
    if (g.label) return g.label;
    if (g.tiktokUsername) return `配信 @${g.tiktokUsername}`;
    return g.player ? `配信 ${g.player}` : '';
  }

  async function applyGame() {
    for (const a of arenas) {
      const g = arenaCfg(a);
      const { obj, cfg } = a.info;
      const cmds = [
        `scoreboard players set #bot ${obj}.cfg ${g.bot ?? 2}`,
        `scoreboard players set #len ${obj}.cfg ${g.len ?? 3}`,
        `scoreboard players set #auto ${obj}.cfg ${g.auto ? 1 : 0}`,
        `scoreboard players set #hs ${obj}.cfg ${g.harass === 'red' ? 2 : 1}`,
        `scoreboard players set #vcap ${obj}.cfg ${g.viewerCap ?? 40}`,
        `scoreboard players set #own ${obj}.cfg ${g.player || g.tiktokUsername ? 1 : 0}`,
        `data modify storage ${cfg} label set value "${clean(arenaLabel(g), 30).replace(/^視聴者$/, '')}"`,
      ];
      if (g.deckB) cmds.push(`data modify storage ${cfg} deck_b set value ${JSON.stringify(g.deckB)}`);
      if (g.deckR) cmds.push(`data modify storage ${cfg} deck_r set value ${JSON.stringify(g.deckR)}`);
      for (const c of cmds) await rcon.command(c);
    }
    gameApplied = true;
  }

  async function gameCommand(cmd, arenaId) {
    if (cmd === 'menu') return rcon.command('execute as @a run function crmc:hub/menu');
    const a = arenaById(arenaId ?? 1);
    if (!a) throw new Error('そのアリーナはありません');
    const p = arenaCfg(a).player;
    const at = `execute in ${a.info.dim} positioned 0.5 64 0.5`;
    const map = {
      solo: `${at} as ${p || '@a[limit=1,sort=random]'} run function ${a.info.fn}menu/solo`,
      test: `${at} run function ${a.info.fn}admin/test_start`,
      stop: `${at} run function ${a.info.fn}admin/stop`,
      build: `${at} run function ${a.info.fn}admin/build`,
      spectate: p ? `${at} as ${p} run function ${a.info.fn}player/spectate` : null,
    };
    if (!map[cmd]) throw new Error(cmd === 'spectate' ? '配信者のマイクラ名を入れてください' : 'unknown command');
    return rcon.command(map[cmd]);
  }

  const num = (s) => { const m = /has (-?\d+)/.exec(s ?? ''); return m ? Number(m[1]) : null; };
  const count = (s) => { const m = /Count: (\d+)/.exec(s ?? ''); return m ? Number(m[1]) : 0; };
  async function pollStatus() {
    if (state.rcon !== 'connected') return;
    try {
      for (const a of arenas) {
        const { obj, tag } = a.info;
        const get = (k, o = 'st') => rcon.command(`scoreboard players get ${k} ${obj}.${o}`).then(num);
        const st = await get('#state');
        const time = await get('#time');
        a.game = {
          state: st ?? 0,
          timeSec: time === null ? null : Math.ceil(time / 20),
          overtime: (await get('#ot')) === 1,
          blue: await get('#b', 'crown'), red: await get('#r', 'crown'),
          mode: await get('#mode'), race: (await get('#race')) === 1, test: (await get('#dbg')) === 1,
          elixirB: await get('#b', 'elx'), elixirR: await get('#r', 'elx'),
          units: count(await rcon.command(`execute if entity @e[tag=${tag}_unit]`)),
          towers: count(await rcon.command(`execute if entity @e[tag=${tag}_tower]`)),
          people: count(await rcon.command(`execute if entity @a[scores={cr.ar=${a.id}}]`)),
          win: await get('#win'),
        };
      }
      state.race = num(await rcon.command('scoreboard players get #race cr.hub')) ?? 0;
      state.players = num((await rcon.command('list')).replace(/There are (\d+)/, 'has $1')) ?? 0;
    } catch { /* checkRcon reports it */ }
  }

  const LB_KEYS = ['lwin', 'lw1', 'lw2', 'lw3', 'lstk', 'lbest', 'lcrown', 'lpvp', 'lrace', 'lplay'];
  async function pollLeaderboard() {
    if (state.rcon !== 'connected') return;
    try {
      const list = await rcon.command('scoreboard players list');
      const names = (list.split(':').slice(1).join(':') || '').split(',').map((x) => x.trim())
        .filter((x) => /^[A-Za-z0-9_]{1,16}$/.test(x)).slice(0, 60);
      const rows = [];
      for (const name of names) {
        const row = { name };
        for (const k of LB_KEYS) row[k] = num(await rcon.command(`scoreboard players get ${name} cr.${k}`)) ?? 0;
        if (LB_KEYS.some((k) => row[k])) rows.push(row);
      }
      rows.sort((x, y) => y.lwin - x.lwin || y.lbest - x.lbest || y.lcrown - x.lcrown);
      leaderboard = { updated: Date.now(), rows };
    } catch { /* try again later */ }
  }

  const onEvent = createEventHandler({
    log, enqueue, config: () => config, recentGifts,
    addCoins: (id, n) => { const a = arenaById(id); if (a) a.coins += n; },
    likeState: (id) => arenaById(id) ?? { totalLikes: 0, likeMarks: null },
  });

  let queueTimer = null;
  async function applyConfig(next) {
    const prev = config;
    config = next;
    if (JSON.stringify(prev.rcon) !== JSON.stringify(next.rcon)) {
      rcon.close();
      rcon = new Rcon(next.rcon);
      state.rcon = 'unknown';
      checkRcon();
    }
    if (prev.queue.intervalMs !== next.queue.intervalMs && queueTimer) {
      clearInterval(queueTimer);
      queueTimer = setInterval(runNext, next.queue.intervalMs);
    }
    if (prev.likes.every !== next.likes.every) for (const a of arenas) a.likeMarks = null;
  }

  async function store(next, fromPanel) {
    if (fromPanel && next.signApiKey !== ctx.signApiKey()) ctx.setSignApiKey(next.signApiKey);
    ctx.save({ ...next, signApiKey: '' });
    await applyConfig(next);
    await applyGame().catch(() => { gameApplied = false; });
    if (fromPanel) await ctx.fieldsEdited();
  }

  const arenaOf = (b) => {
    const a = arenaById(b?.arena ?? b?.field ?? 1);
    if (!a) throw new Error('そのアリーナはありません');
    return a;
  };

  async function handle(req, res, url) {
    const p = url.pathname;
    if (req.method === 'GET' && p === '/api/overlay') {
      const since = Number(url.searchParams.get('since')) || 0;
      const only = Number(url.searchParams.get('arena') || url.searchParams.get('field')) || 0;
      return json(res, { latest: overlaySeq, items: overlayItems.filter((i) => i.id > since && (!only || i.arena === only)) });
    }
    if (req.method === 'GET' && p === '/api/config') {
      return json(res, { config: { ...config, signApiKey: ctx.signApiKey() }, actions: ACTIONS, cards: CARDS, arenas: ARENA_INFO, recentGifts: [...recentGifts.values()], configFile: ctx.configFile() });
    }
    if (req.method === 'POST' && p === '/api/config') {
      try {
        const next = reval(await readBody(req));
        await store(next, true);
        log('info', '設定を保存しました');
        return json(res, { ok: true, message: '保存して反映しました。' });
      } catch (err) {
        return json(res, { ok: false, message: err.message }, 400);
      }
    }
    if (req.method === 'POST' && p === '/api/rcon-test') return rconTest(res, await readBody(req), meta.rconPort);
    if (req.method === 'POST' && p === '/api/server-setup') {
      const b = await readBody(req);
      try {
        const s = setupServer(ctx.data('crmc_datapack.zip'), b.serverDir, b.port);
        const next = reval({ ...config, rcon: { host: '127.0.0.1', port: s.port, password: s.password } });
        await store(next, false);
        log('info', `サーバーを設定しました（ワールド ${s.world}）`);
        return json(res, { ok: true, message: `RCON を有効にし、ワールド「${s.world}」にデータパックを入れました。パスワードもこのアプリに保存しました。${s.changed ? 'サーバーを再起動してください（server.properties を変更しました。元のファイルは server.properties.bak）。' : 'サーバーを再起動すると反映されます（アリーナ2以降の追加にはサーバーの再起動が必要です）。'}` });
      } catch (err) {
        return json(res, { ok: false, message: err.message }, 400);
      }
    }
    if (req.method === 'GET' && p === '/api/state') {
      const a1 = arenas[0];
      return json(res, {
        rcon: state.rcon, rconDetail: state.rconDetail, log: state.log, last: state.last, race: state.race, players: state.players,
        queue: queue.length, actions: ACTIONS, tiers: config.giftRules.tiers,
        tiktok: a1.tiktok, tiktokDetail: a1.tiktokDetail, totalLikes: a1.totalLikes, coins: arenas.reduce((s, a) => s + a.coins, 0),
        username: a1.username,
        arenas: arenas.map((a) => ({
          id: a.id, dim: a.info.dim, tiktok: a.tiktok, tiktokDetail: a.tiktokDetail, username: a.username,
          totalLikes: a.totalLikes, coins: a.coins, queue: queue.filter((q) => q.arena === a.id).length,
          player: arenaCfg(a).player ?? '', label: arenaLabel(arenaCfg(a)), game: a.game,
        })),
      });
    }
    if (req.method === 'GET' && p === '/api/leaderboard') return json(res, leaderboard);
    if (req.method === 'POST' && p === '/api/test') {
      const b = await readBody(req);
      let a;
      try { a = arenaOf(b); } catch (err) { return json(res, { ok: false, message: err.message }, 400); }
      if (b.action) {
        enqueue(a.id, String(b.action), b.name || 'テスト', 'テスト', 'test', b.avatar || null);
      } else {
        const coins = Math.max(1, Number(b.coins) || 1);
        const repeat = Math.max(1, Number(b.repeat) || 1);
        const giftName = String(b.gift || 'テストギフト');
        a.coins += coins * repeat;
        log('gift', `[テスト] ${b.name || 'テスト'} → ${giftName} ×${repeat}（${coins * repeat}コイン）`, a.id);
        for (const act of actionsForGift(config.giftRules, giftName, coins, repeat)) enqueue(a.id, act, b.name || 'テスト', `${giftName}×${repeat}`, 'test', b.avatar || null);
      }
      return json(res, { ok: true, arena: a.id, field: a.id });
    }
    if (req.method === 'POST' && p === '/api/tiktok') {
      const b = await readBody(req);
      await ctx.tiktokControl(b.arena ? Number(b.arena) : null, Boolean(b.connect));
      return json(res, { ok: true });
    }
    if (req.method === 'POST' && p === '/api/game') {
      const b = await readBody(req);
      try {
        const r = await gameCommand(String(b.cmd), b.arena);
        log('info', `ゲーム操作: ${b.cmd}${r ? ` → ${r}` : ''}`, b.cmd === 'menu' ? null : Number(b.arena ?? 1));
        setTimeout(pollStatus, 300);
        return json(res, { ok: true, result: r });
      } catch (err) {
        return json(res, { ok: false, message: err.message }, 400);
      }
    }
    if (req.method === 'POST' && p === '/api/clear') {
      const b = await readBody(req);
      const list = b.arena ? [arenaById(b.arena)].filter(Boolean) : arenas;
      for (const a of list) {
        for (let i = queue.length - 1; i >= 0; i--) if (queue[i].arena === a.id) queue.splice(i, 1);
        await rcon.command(`execute in ${a.info.dim} run function ${a.info.fn}live/clear`).catch(() => {});
      }
      log('info', `キューを空にして、視聴者が出したモブを消しました（${b.arena ? `アリーナ${b.arena}` : '全アリーナ'}）`);
      return json(res, { ok: true });
    }
    return false;
  }

  return {
    meta,
    fields: () => arenas.map((a) => a.id),
    fieldStreamers: () => streamersOf(config),
    async setStreamers(map) {
      let changed = false;
      const list = config.arenas.map((g, i) => {
        const s = map[i + 1] ?? { tiktok: '', mc: '' };
        const player = s.mc || '';
        if (g.tiktokUsername !== s.tiktok || g.player !== player) changed = true;
        return { ...g, tiktokUsername: s.tiktok, player };
      });
      if (!changed) return;
      await store(reval({ ...config, arenas: list }), false);
    },
    setConn(field, c) {
      const a = arenaById(field);
      if (!a) return;
      a.tiktok = c.status;
      a.tiktokDetail = c.detail;
      a.username = c.username ?? '';
      if (c.reset) { a.likeMarks = null; a.totalLikes = 0; }
    },
    onEvent,
    handle,
    log,
    resourcePack: () => ctx.data('crmc_resourcepack.zip'),
    status: () => ({
      rcon: state.rcon, rconDetail: state.rconDetail, port: config.rcon.port, players: state.players,
      fields: arenas.map((a) => ({ n: a.id, queue: queue.filter((q) => q.arena === a.id).length, state: a.game ? ({ 0: '空き', 1: '開始前', 2: '試合中', 3: '試合終了' })[a.game.state] ?? String(a.game.state) : null, people: a.game?.people ?? null })),
    }),
    legacyPort: () => config.panelPort,
    start() {
      queueTimer = setInterval(runNext, config.queue?.intervalMs ?? 1500);
      setInterval(() => { if (state.rcon !== 'connected') checkRcon(); }, 10000);
      setInterval(pollStatus, 2000);
      setInterval(pollLeaderboard, 15000);
      checkRcon().then(() => {
        if (state.rcon === 'connected') rcon.command('function crmc:hub/ping').catch(() => {});
        log(state.rcon === 'connected' ? 'info' : 'error',
          state.rcon === 'connected' ? `Minecraft サーバー（RCON）に接続しました（アリーナ ${arenas.length} 面）` : `RCON に接続できません: ${state.rconDetail}（「接続設定」タブで設定してください）`);
        pollStatus();
        pollLeaderboard();
      });
    },
  };
}
