// Anime Umetate (アニメ技の埋め立て) — several fields (pits) in one server.
// Each field can have a streamer (Minecraft name: joins straight into that field; TikTok ID: its events hit that field)
//   -> "function anime_live:f<N>/act/<action> {name:..,gift:..,rname:..}".
// Ported from anime-umetate/tiktok-live.
import { Rcon } from '../../core/rcon.js';
import { createAvatar } from '../../core/avatar.js';
import { createEventHandler } from '../../core/events.js';
import { rconTest } from '../../core/rcon-test.js';
import { json, readBody, clean, actionsForGift, readJson, pushQueued } from '../../core/util.js';
import { validateConfig, setupServer } from './config.js';

export const meta = {
  id: 'anime', title: 'アニメ技の埋め立て', short: 'アニメ埋め立て', icon: '🌀', fieldWord: 'フィールド',
  legacyPort: 8790, rconPort: 25591,
  oldApp: 'anime-umetate/tiktok-live',
  sources: {
    'anime_umetate_datapack.actions.json': 'anime-umetate/tiktok-live/datapack',
    'anime_umetate_datapack.fields.json': 'anime-umetate/tiktok-live/datapack',
    'anime_umetate_datapack.zip': 'anime-umetate/tiktok-live/datapack',
    'anime_umetate_resourcepack.zip': 'anime-umetate/resourcepack',
  },
};

const BALL_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
<rect width="24" height="24" fill="#101a3a"/>
<circle cx="12" cy="12" r="10" fill="#1e5bd8"/>
<circle cx="12" cy="12" r="7" fill="#4fb3ff"/>
<circle cx="12" cy="12" r="4" fill="#d9f3ff"/>
<circle cx="10" cy="10" r="1.5" fill="#ffffff"/>
</svg>`;

function load(ctx) {
  const ACTIONS = readJson(ctx.data('anime_umetate_datapack.actions.json'), {});
  const LAYOUT = readJson(ctx.data('anime_umetate_datapack.fields.json'), { presets: {}, fields: [{ n: 1 }] });
  return { ACTIONS, LAYOUT, FIELDS: LAYOUT.fields, FIELD_IDS: LAYOUT.fields.map((f) => f.n) };
}

export function validate(raw, ctx) {
  const { ACTIONS, FIELD_IDS } = load(ctx);
  return validateConfig(raw, ACTIONS, FIELD_IDS);
}

export function streamersOf(cfg) {
  const out = {};
  for (const s of cfg.streamers ?? []) out[s.field] = { tiktok: s.tiktok || '', mc: s.minecraft || '' };
  return out;
}

export function createGame(ctx) {
  const { ACTIONS, LAYOUT, FIELDS, FIELD_IDS } = load(ctx);
  const { avatarRows, avatarCommands } = createAvatar({ storage: 'umetate:av', font: 'umetate:px', svg: BALL_SVG, bg: '#101a3a' });
  const hasField = (n) => FIELD_IDS.includes(Number(n));
  const fieldOf = (v) => (hasField(v) ? Number(v) : 1);
  let config = validateConfig(ctx.config(), ACTIONS, FIELD_IDS);

  const state = { rcon: 'unknown', rconDetail: '', coins: 0, log: [], last: null };
  const F = Object.fromEntries(FIELDS.map((f) => [f.n, {
    info: f, game: null, players: [], queue: [], lastRun: 0, cooldownUntil: {}, coins: 0,
    tt: { status: 'off', detail: '', username: '', totalLikes: 0, likeMarks: null },
  }]));
  let overlaySeq = 0;
  const overlayItems = [];
  let lastRconError = '';
  let lastRconErrorAt = 0;
  const recentGifts = new Map();
  let leaderboard = { presets: {}, vslog: [], vsWins: [], fieldBest: [], at: 0 };

  function log(kind, text, field = null) {
    const entry = { t: new Date().toLocaleTimeString('ja-JP'), kind, text: field ? `[F${field}] ${text}` : text, field };
    state.log.unshift(entry);
    state.log.length = Math.min(state.log.length, 300);
    ctx.print(kind, entry.text);
  }

  function enqueue(field, action, name, label, source, avatar = null, coins = 0) {
    if (!ACTIONS[action]) {
      log('warn', `未定義のアクション "${action}"（${label}）`, field);
      return;
    }
    const q = F[field].queue;
    const max = config.queue?.maxLength ?? 40;
    if (q.length >= max) {
      const drop = q.shift();
      log('warn', `キューがいっぱいなので「${drop.label}」を捨てました`, field);
    }
    pushQueued(q, { field, action, name: clean(name), label: clean(label, 32), source, avatar }, coins >= ctx.firstCoins());
  }

  let running = false;
  async function pump() {
    if (running) return;
    running = true;
    try {
      for (const n of FIELD_IDS) {
        const f = F[n];
        if (!f.queue.length || Date.now() - f.lastRun < (config.queue?.intervalMs ?? 1500)) continue;
        f.lastRun = Date.now();
        await runOne(f.queue.shift());
      }
    } finally { running = false; }
  }

  async function runOne(item) {
    const f = F[item.field];
    let { action } = item;
    const now = Date.now();
    if (f.cooldownUntil[action] > now) {
      log('info', `${ACTIONS[action].label} はクールダウン中 → ${config.fallbackAction}`, item.field);
      action = config.fallbackAction;
    } else if (config.cooldownSec?.[action]) {
      f.cooldownUntil[action] = now + config.cooldownSec[action] * 1000;
    }
    const rname = item.name.replace(/[\s@#*]/g, '_').slice(0, 24);
    const cmd = `function anime_live:f${item.field}/act/${action} {name:"${item.name}",gift:"${item.label}",rname:"${rname}"}`;
    try {
      for (const c of avatarCommands(await avatarRows(item.avatar))) await rcon.command(c);
      const res = await rcon.command(cmd);
      state.rcon = 'connected';
      state.rconDetail = '';
      if (res && /Unknown|Incorrect|error|Can't/i.test(res)) log('error', `サーバーがエラーを返しました: ${res}`, item.field);
      state.last = { id: ++overlaySeq, field: item.field, name: item.name, gift: item.label, action: ACTIONS[action].label, avatar: item.avatar, at: Date.now() };
      overlayItems.push(state.last);
      if (overlayItems.length > 60) overlayItems.shift();
      log('action', `${item.name}「${item.label}」→ ${ACTIONS[action].label}`, item.field);
    } catch (err) {
      state.rcon = 'error';
      state.rconDetail = err.message;
      f.queue.unshift(item);
      if (err.message !== lastRconError || Date.now() - lastRconErrorAt > 60000) {
        log('error', `RCON: ${err.message}${/パスワード/.test(err.message) ? '（「接続設定」タブの「サーバーの自動設定」で直せます）' : ''}`);
        lastRconError = err.message;
        lastRconErrorAt = Date.now();
      }
      f.lastRun = Date.now() + 3500;
    }
  }

  let rcon = new Rcon(config.rcon);
  async function checkRcon() {
    const was = state.rcon;
    try {
      await rcon.command('list');
      state.rcon = 'connected';
      state.rconDetail = '';
      if (was !== 'connected') await syncStreamers().catch((err) => log('error', `配信者の割り当てを送れませんでした: ${err.message}`));
    } catch (err) {
      state.rcon = 'error';
      state.rconDetail = err.message;
    }
  }

  const streamerOf = (field) => config.streamers.find((s) => s.field === field) ?? null;

  // streamers' Minecraft names go straight to their field when they join; their fields are kept out of versus
  async function syncStreamers() {
    await rcon.command('scoreboard players reset * um.home');
    for (const n of FIELD_IDS) {
      const s = streamerOf(n);
      await rcon.command(`scoreboard players set #reserved um.f${n} ${s ? 1 : 0}`);
      if (s?.minecraft) await rcon.command(`scoreboard players set ${s.minecraft} um.home ${n}`);
    }
  }

  const onEvent = createEventHandler({
    log, enqueue: (field, ...rest) => { if (F[field]) enqueue(field, ...rest); }, config: (f) => ctx.rules(f, config), recentGifts,
    addCoins: (n, c) => { state.coins += c; if (F[n]) F[n].coins += c; },
    likeState: (n) => F[n]?.tt ?? { totalLikes: 0, likeMarks: null },
  });

  async function applyConfig(next) {
    const prev = config;
    config = next;
    if (JSON.stringify(prev.rcon) !== JSON.stringify(next.rcon)) {
      rcon.close();
      rcon = new Rcon(next.rcon);
      state.rcon = 'unknown';
      checkRcon();
    }
    if (prev.likes.every !== next.likes.every) for (const n of FIELD_IDS) F[n].tt.likeMarks = null;
    if (JSON.stringify(prev.streamers) !== JSON.stringify(next.streamers) && state.rcon === 'connected') {
      await syncStreamers().catch((err) => log('error', `配信者の割り当てを送れませんでした: ${err.message}`));
    }
  }

  async function store(next, fromPanel) {
    if (fromPanel && next.signApiKey !== ctx.signApiKey()) ctx.setSignApiKey(next.signApiKey);
    ctx.save({ ...next, signApiKey: '' });
    await applyConfig(next);
    if (fromPanel) await ctx.fieldsEdited();
  }

  const GAME_CMDS = {
    start: ['start', '新しいラウンドを始めました'],
    stop: ['stop', 'ゲームを一時停止しました'],
    rebuild: ['build', '会場を作り直しました'],
    rank_reset: ['rank_reset', '妨害ランキングを消しました'],
    hub: ['', 'フィールドの全員を待機所へ戻しました'],
  };

  function fieldsPayload() {
    return FIELD_IDS.map((n) => {
      const f = F[n];
      const s = streamerOf(n);
      return {
        ...f.info, game: f.game, players: f.players, queue: f.queue.length, coins: f.coins,
        streamer: s ? { minecraft: s.minecraft, tiktok: s.tiktok } : null,
        tiktok: { status: f.tt.status, detail: f.tt.detail, likes: f.tt.totalLikes },
      };
    });
  }

  // ------------------------------------------------------------------ reading the game
  const score = (s) => Number(String(s).match(/ has (-?\d+) \[/)?.[1] ?? NaN);
  const num = (s) => Number(String(s).match(/contents: (-?\d+)[a-zA-Z]?\s*$/)?.[1] ?? NaN);
  const GAME_STATES = ['待機中', 'プレイ中', 'クリア！', 'カウントダウン', '一時停止'];
  async function readGame() {
    if (state.rcon !== 'connected') return;
    try {
      const online = new Set([...(await rcon.command('list uuids')).matchAll(/([A-Za-z0-9_]{1,16}) \(/g)].map((m) => m[1]));
      for (const n of FIELD_IDS) {
        const get = async (k) => score(await rcon.command(`scoreboard players get #${k} um.f${n}`)) || 0;
        const [st, pct, filled, total, ticks, best, vs] = [await get('state'), await get('pct'), await get('filled'), await get('total'), await get('ticks'), await get('best'), await get('vs')];
        const members = (await rcon.command(`team list um.f${n}`)).split(': ')[1];
        F[n].players = members ? members.split(',').map((s) => s.trim()).filter((s) => online.has(s)) : [];
        const stateName = st === 0 && !F[n].players.length ? '空き' : (GAME_STATES[st] ?? '?');
        F[n].game = {
          field: n, state: stateName, stateId: st, pct, filled, total, sec: Math.floor(ticks / 20), best: best ? Math.floor(best / 20) : null,
          vs: vs || null, players: F[n].players, preset: F[n].info.presetName, size: F[n].info.size,
        };
      }
    } catch { /* next time */ }
  }

  async function readList(pathName) {
    const out = [];
    await rcon.command(`execute store result score #app_n um.tmp run data get storage umetate:lb ${pathName}`);
    const n = score(await rcon.command('scoreboard players get #app_n um.tmp')) || 0;
    for (let i = 0; i < Math.min(n, 300); i++) {
      const name = (await rcon.command(`data get storage umetate:lb ${pathName}[${i}].name`)).match(/contents: "(.*)"\s*$/)?.[1] ?? '?';
      const t = num(await rcon.command(`data get storage umetate:lb ${pathName}[${i}].t`));
      const f = num(await rcon.command(`data get storage umetate:lb ${pathName}[${i}].f`));
      out.push({ name, sec: Math.floor(t / 20), ticks: t, field: f });
    }
    return out;
  }
  async function readLeaderboard() {
    if (state.rcon !== 'connected') return;
    const presets = {};
    for (const [p, info] of Object.entries(LAYOUT.presets)) {
      const list = (await readList(`p${p}`)).sort((a, b) => a.ticks - b.ticks);
      presets[p] = { ...info, top: list.slice(0, 20) };
    }
    const vslog = (await readList('vslog')).reverse();
    const wins = {};
    for (const v of vslog) wins[v.name] = (wins[v.name] ?? 0) + 1;
    leaderboard = {
      presets, vslog: vslog.slice(0, 15),
      vsWins: Object.entries(wins).map(([name, w]) => ({ name, wins: w })).sort((a, b) => b.wins - a.wins),
      fieldBest: FIELD_IDS.map((n) => ({ field: n, preset: F[n].info.presetName, best: F[n].game?.best ?? null })),
      at: Date.now(),
    };
  }

  async function handle(req, res, url) {
    const p = url.pathname;
    if (req.method === 'GET' && p === '/api/overlay') {
      const since = Number(url.searchParams.get('since')) || 0;
      const field = fieldOf(url.searchParams.get('field') || 1);
      return json(res, {
        latest: overlaySeq, field,
        items: overlayItems.filter((i) => i.id > since && i.field === field),
        game: state.rcon === 'connected' ? F[field].game : null,
      });
    }
    if (req.method === 'GET' && p === '/api/config') {
      return json(res, { config: { ...config, signApiKey: ctx.signApiKey() }, actions: ACTIONS, fields: FIELDS, presets: LAYOUT.presets, recentGifts: [...recentGifts.values()], configFile: ctx.configFile() });
    }
    if (req.method === 'POST' && p === '/api/config') {
      try {
        const next = validateConfig(await readBody(req), ACTIONS, FIELD_IDS);
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
        const s = setupServer(ctx.data('anime_umetate_datapack.zip'), b.serverDir, b.port);
        const next = validateConfig({ ...config, rcon: { host: '127.0.0.1', port: s.port, password: s.password } }, ACTIONS, FIELD_IDS);
        await store(next, false);
        log('info', `サーバーを設定しました（ワールド ${s.world}）`);
        return json(res, { ok: true, message: `RCON を有効にし、ワールド「${s.world}」にデータパックを入れました。パスワードもこのアプリに保存しました。${s.changed ? 'サーバーを再起動してください（server.properties を変更しました。元のファイルは server.properties.bak）。' : 'サーバーで /reload を実行すると反映されます。'}` });
      } catch (err) {
        return json(res, { ok: false, message: err.message }, 400);
      }
    }
    if (req.method === 'POST' && p === '/api/game') {
      const b = await readBody(req);
      const c = GAME_CMDS[b.cmd];
      if (!c) return json(res, { ok: false, message: '不明な操作です' }, 400);
      let cmds;
      if (b.cmd === 'rebuild' && b.field === 'hub') cmds = ['function umetate:hub/build'];
      else if (b.cmd === 'rebuild' && b.field === 'all') cmds = ['function umetate:build'];
      else {
        const targets = b.field === 'all' ? FIELD_IDS : hasField(b.field ?? 1) ? [Number(b.field ?? 1)] : null;
        if (!targets) return json(res, { ok: false, message: 'フィールドを選んでください' }, 400);
        cmds = targets.map((n) => (b.cmd === 'hub'
          ? `execute as @a[scores={um.fld=${n}}] run function umetate:player/to_hub`
          : `function umetate:f${n}/${c[0]}`));
      }
      try {
        for (const cmd of cmds) await rcon.command(cmd);
        log('info', `${c[1]}（${b.field === 'all' ? '全フィールド' : b.field === 'hub' ? '待機所' : `フィールド${b.field ?? 1}`}）`);
        return json(res, { ok: true });
      } catch (err) {
        return json(res, { ok: false, message: `RCON: ${err.message}` });
      }
    }
    if (req.method === 'GET' && p === '/api/leaderboard') {
      if (Date.now() - leaderboard.at > 5000) await readLeaderboard().catch(() => {});
      return json(res, leaderboard);
    }
    if (req.method === 'GET' && p === '/api/state') {
      const fields = fieldsPayload();
      const tt = fields.filter((f) => f.streamer?.tiktok);
      const on = tt.filter((f) => f.tiktok.status === 'connected').length;
      return json(res, {
        ...state,
        fields,
        game: F[FIELD_IDS[0]].game,
        tiktok: !tt.length ? 'off' : on === tt.length ? 'connected' : tt.some((f) => f.tiktok.status === 'error') ? 'error' : 'connecting',
        tiktokDetail: tt.length ? `${on} / ${tt.length} 接続中` : 'TikTok の ID が未設定',
        totalLikes: fields.reduce((a, f) => a + (f.tiktok.likes || 0), 0),
        queue: fields.reduce((a, f) => a + f.queue, 0),
        username: config.tiktokUsername,
        actions: ACTIONS, tiers: config.giftRules.tiers,
      });
    }
    if (req.method === 'POST' && p === '/api/test') {
      const b = await readBody(req);
      const targets = b.field === 'all' ? FIELD_IDS : [fieldOf(b.field ?? 1)];
      for (const field of targets) {
        if (b.action) {
          enqueue(field, String(b.action), b.name || 'テスト', 'テスト', 'test', b.avatar || null);
        } else {
          const coins = Math.max(1, Number(b.coins) || 1);
          const repeat = Math.max(1, Number(b.repeat) || 1);
          const giftName = String(b.gift || 'テストギフト');
          state.coins += coins * repeat;
          F[field].coins += coins * repeat;
          log('gift', `[テスト] ${b.name || 'テスト'} → ${giftName} ×${repeat}（${coins * repeat}コイン）`, field);
          for (const a of actionsForGift(ctx.rules(field, config).giftRules, giftName, coins, repeat)) enqueue(field, a, b.name || 'テスト', `${giftName}×${repeat}`, 'test', b.avatar || null);
        }
      }
      return json(res, { ok: true, field: targets.length === 1 ? targets[0] : 'all' });
    }
    if (req.method === 'POST' && p === '/api/tiktok') {
      const b = await readBody(req);
      await ctx.tiktokControl(hasField(b.field) ? Number(b.field) : null, Boolean(b.connect));
      return json(res, { ok: true });
    }
    if (req.method === 'POST' && p === '/api/clear') {
      const b = await readBody(req);
      const one = hasField(b.field) ? Number(b.field) : null;
      for (const n of one ? [one] : FIELD_IDS) F[n].queue.length = 0;
      await rcon.command(one ? `function anime_live:f${one}/clear` : 'function anime_live:clear').catch(() => {});
      log('info', 'キューを空にして、影分身と技の演出を消しました', one);
      return json(res, { ok: true });
    }
    return false;
  }

  return {
    meta,
    fields: () => [...FIELD_IDS],
    fieldStreamers: () => streamersOf(config),
    async setStreamers(map) {
      const list = [];
      for (const n of FIELD_IDS) {
        const s = map[n];
        if (s && (s.tiktok || s.mc)) list.push({ field: n, minecraft: s.mc || '', tiktok: s.tiktok || '' });
      }
      if (JSON.stringify(list) === JSON.stringify(config.streamers)) return;
      await store(validateConfig({ ...config, streamers: list }, ACTIONS, FIELD_IDS), false);
    },
    setConn(field, c) {
      const f = F[field];
      if (!f) return;
      f.tt.status = c.status;
      f.tt.detail = c.detail;
      f.tt.username = c.username ?? '';
      if (c.reset) { f.tt.likeMarks = null; f.tt.totalLikes = 0; }
    },
    onEvent,
    // the hub's stream tools (gift wheel): run one of this game's actions on a field
    runAction: (field, action, name, label, avatar = null) => enqueue(field, action, name, label, 'wheel', avatar),
    handle,
    actions: () => ACTIONS,
    rulesConfig: () => config,
    log,
    resourcePack: () => ctx.data('anime_umetate_resourcepack.zip'),
    status: () => ({
      rcon: state.rcon, rconDetail: state.rconDetail, port: config.rcon.port,
      fields: FIELD_IDS.map((n) => ({ n, queue: F[n].queue.length, state: F[n].game?.state ?? null, people: F[n].players.length, label: `${F[n].info.presetName ?? ''}` })),
    }),
    legacyPort: () => config.panelPort,
    start() {
      setInterval(pump, 200);
      setInterval(() => { if (state.rcon !== 'connected') checkRcon(); }, 10000);
      setInterval(readGame, 2000);
      setInterval(() => readLeaderboard().catch(() => {}), 30000);
      checkRcon().then(() => {
        if (state.rcon === 'connected') rcon.command('function anime_live:ping').catch(() => {});
        log(state.rcon === 'connected' ? 'info' : 'error',
          state.rcon === 'connected' ? 'Minecraft サーバー（RCON）に接続しました' : `RCON に接続できません: ${state.rconDetail}（「接続設定」タブで設定してください）`);
        readGame().then(() => readLeaderboard()).catch(() => {});
      });
    },
  };
}
