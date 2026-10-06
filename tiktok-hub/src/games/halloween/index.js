// Halloween Night (ハロウィン・ナイト) — one field.
// Events -> action queue -> RCON "function halloween_live:act/<action> {name:..,gift:..}" on play-server.
// Ported from halloween-map/tiktok-live (the standalone app stays as it is for its own distribution).
import { Rcon } from '../../core/rcon.js';
import { createAvatar } from '../../core/avatar.js';
import { createEventHandler } from '../../core/events.js';
import { json, readBody, clean, actionsForGift, readJson, pushQueued } from '../../core/util.js';
import { validateConfig, setupServer } from './config.js';
import { rconTest } from '../../core/rcon-test.js';

export const meta = {
  id: 'halloween', title: 'ハロウィン・ナイト', short: 'ハロウィン', icon: '🎃', fieldWord: 'フィールド',
  legacyPort: 8787, rconPort: 25575,
  oldApp: 'halloween-map/tiktok-live',
  sources: { 'halloween_live_datapack.actions.json': 'halloween-map/tiktok-live/datapack', 'halloween_live_datapack.zip': 'halloween-map/tiktok-live/datapack' },
};

const PUMPKIN_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
<rect width="24" height="24" fill="#2a1840"/>
<rect x="11" y="2" width="2" height="4" fill="#3f7a2a"/>
<ellipse cx="12" cy="14" rx="10" ry="8" fill="#f97316"/>
<polygon points="6,11 9,11 7.5,8" fill="#2a1200"/><polygon points="15,11 18,11 16.5,8" fill="#2a1200"/>
<path d="M6 15 L18 15 L16 19 L8 19 Z" fill="#2a1200"/>
<rect x="10" y="15" width="1.5" height="1.5" fill="#f97316"/><rect x="13" y="17.5" width="1.5" height="1.5" fill="#f97316"/>
</svg>`;

export function validate(raw, ctx) {
  const ACTIONS = readJson(ctx.data('halloween_live_datapack.actions.json'), {});
  return validateConfig(raw, ACTIONS);
}

// old config -> { field: { tiktok, mc } }
export function streamersOf(cfg) {
  return { 1: { tiktok: cfg.tiktokUsername || '', mc: '' } };
}

export function createGame(ctx) {
  const ACTIONS = readJson(ctx.data('halloween_live_datapack.actions.json'), {});
  const { avatarRows, avatarCommands } = createAvatar({ storage: 'halloween_live:av', font: 'halloween:px', svg: PUMPKIN_SVG, bg: '#2a1840' });
  let config = validateConfig(ctx.config(), ACTIONS);

  const state = {
    tiktok: 'off', tiktokDetail: '', rcon: 'unknown', rconDetail: '',
    totalLikes: 0, likeMarks: null, coins: 0, log: [], last: null,
  };
  const like = { totalLikes: 0, likeMarks: null };
  const cooldownUntil = {};
  let overlaySeq = 0;
  const overlayItems = [];
  let lastRconError = '';
  let lastRconErrorAt = 0;
  const recentGifts = new Map();
  const queue = [];

  function log(kind, text) {
    const entry = { t: new Date().toLocaleTimeString('ja-JP'), kind, text };
    state.log.unshift(entry);
    state.log.length = Math.min(state.log.length, 200);
    ctx.print(kind, text);
  }

  function enqueue(_field, action, name, label, source, avatar = null, coins = 0) {
    if (!ACTIONS[action]) {
      log('warn', `未定義のアクション "${action}"（${label}）`);
      return;
    }
    const max = config.queue?.maxLength ?? 40;
    if (queue.length >= max) {
      const drop = queue.shift();
      log('warn', `キューがいっぱいなので「${drop.label}」を捨てました`);
    }
    pushQueued(queue, { action, name: clean(name), label: clean(label, 32), source, avatar }, coins >= ctx.firstCoins());
  }

  let running = false;
  async function runNext() {
    if (running || !queue.length) return;
    running = true;
    try { await runOne(queue.shift()); } finally { running = false; }
  }

  async function runOne(item) {
    let { action } = item;
    const now = Date.now();
    if (cooldownUntil[action] > now) {
      log('info', `${ACTIONS[action].label} はクールダウン中 → ${config.fallbackAction}`);
      action = config.fallbackAction;
    } else if (config.cooldownSec?.[action]) {
      cooldownUntil[action] = now + config.cooldownSec[action] * 1000;
    }
    const cmd = `function halloween_live:act/${action} {name:"${item.name}",gift:"${item.label}"}`;
    try {
      for (const c of avatarCommands(await avatarRows(item.avatar))) await rcon.command(c);
      const res = await rcon.command(cmd);
      state.rcon = 'connected';
      state.rconDetail = '';
      if (res && /Unknown|Incorrect|error|Can't/i.test(res)) log('error', `サーバーがエラーを返しました: ${res}`);
      state.last = { id: ++overlaySeq, field: 1, name: item.name, gift: item.label, action: ACTIONS[action].label, avatar: item.avatar, at: Date.now() };
      overlayItems.push(state.last);
      if (overlayItems.length > 20) overlayItems.shift();
      log('action', `${item.name}「${item.label}」→ ${ACTIONS[action].label}`);
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
  async function checkRcon() {
    try {
      await rcon.command('list');
      state.rcon = 'connected';
      state.rconDetail = '';
    } catch (err) {
      state.rcon = 'error';
      state.rconDetail = err.message;
    }
  }

  const onEvent = createEventHandler({
    log: (k, t) => log(k, t), enqueue, config: (f) => ctx.rules(f, config), recentGifts,
    addCoins: (_f, n) => { state.coins += n; },
    likeState: () => like,
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
    if (prev.likes.every !== next.likes.every) like.likeMarks = null;
  }

  // saves the config (the TikTok key lives in the hub) and tells the hub about streamer changes
  async function store(next, fromPanel) {
    if (fromPanel && next.signApiKey !== ctx.signApiKey()) ctx.setSignApiKey(next.signApiKey);
    ctx.save({ ...next, signApiKey: '' });
    await applyConfig(next);
    if (fromPanel) await ctx.fieldsEdited();
  }

  async function handle(req, res, url) {
    const p = url.pathname;
    if (req.method === 'GET' && p === '/api/overlay') {
      const since = Number(url.searchParams.get('since')) || 0;
      return json(res, { latest: overlaySeq, items: overlayItems.filter((i) => i.id > since) });
    }
    if (req.method === 'GET' && p === '/api/config') {
      return json(res, { config: { ...config, signApiKey: ctx.signApiKey() }, actions: ACTIONS, recentGifts: [...recentGifts.values()], configFile: ctx.configFile() });
    }
    if (req.method === 'POST' && p === '/api/config') {
      try {
        const next = validateConfig(await readBody(req), ACTIONS);
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
        const s = setupServer(ctx.data('halloween_live_datapack.zip'), b.serverDir, b.port);
        const next = validateConfig({ ...config, rcon: { host: '127.0.0.1', port: s.port, password: s.password } }, ACTIONS);
        await store(next, false);
        log('info', `サーバーを設定しました（ワールド ${s.world}）`);
        return json(res, { ok: true, message: `RCON を有効にし、ワールド「${s.world}」にデータパックを入れました。パスワードもこのアプリに保存しました。${s.changed ? 'サーバーを再起動してください（server.properties を変更しました。元のファイルは server.properties.bak）。' : 'サーバーで /reload を実行すると反映されます。'}` });
      } catch (err) {
        return json(res, { ok: false, message: err.message }, 400);
      }
    }
    if (req.method === 'GET' && p === '/api/state') {
      return json(res, {
        ...state, queue: queue.length, username: config.tiktokUsername, totalLikes: like.totalLikes,
        actions: ACTIONS, tiers: config.giftRules.tiers,
      });
    }
    if (req.method === 'POST' && p === '/api/test') {
      const b = await readBody(req);
      if (b.action) {
        enqueue(1, String(b.action), b.name || 'テスト', 'テスト', 'test', b.avatar || null);
      } else {
        const coins = Math.max(1, Number(b.coins) || 1);
        const repeat = Math.max(1, Number(b.repeat) || 1);
        const giftName = String(b.gift || 'テストギフト');
        state.coins += coins * repeat;
        log('gift', `[テスト] ${b.name || 'テスト'} → ${giftName} ×${repeat}（${coins * repeat}コイン）`);
        for (const a of actionsForGift(ctx.rules(1, config).giftRules, giftName, coins, repeat)) enqueue(1, a, b.name || 'テスト', `${giftName}×${repeat}`, 'test', b.avatar || null);
      }
      return json(res, { ok: true, field: 1 });
    }
    if (req.method === 'POST' && p === '/api/tiktok') {
      const b = await readBody(req);
      await ctx.tiktokControl(null, Boolean(b.connect));
      return json(res, { ok: true });
    }
    if (req.method === 'POST' && p === '/api/clear') {
      queue.length = 0;
      await rcon.command('function halloween_live:clear').catch(() => {});
      log('info', 'キューを空にして、視聴者が出したモブを消しました');
      return json(res, { ok: true });
    }
    return false;
  }

  return {
    meta,
    fields: () => [1],
    fieldStreamers: () => streamersOf(config),
    async setStreamers(map) {
      const tiktok = map[1]?.tiktok ?? '';
      if (tiktok === config.tiktokUsername) return;
      await store(validateConfig({ ...config, tiktokUsername: tiktok }, ACTIONS), false);
    },
    setConn(_field, c) {
      state.tiktok = c.status;
      state.tiktokDetail = c.detail;
      if (c.reset) like.likeMarks = null;
    },
    onEvent,
    // the hub's stream tools (gift wheel): run one of this game's actions on a field
    runAction: (field, action, name, label, avatar = null) => enqueue(field, action, name, label, 'wheel', avatar),
    handle,
    actions: () => ACTIONS,
    rulesConfig: () => config,
    log: (kind, text) => log(kind, text),
    resourcePack: () => null,
    status: () => ({
      rcon: state.rcon, rconDetail: state.rconDetail, port: config.rcon.port, legacyPort: config.panelPort,
      fields: [{ n: 1, queue: queue.length, state: null }],
    }),
    legacyPort: () => config.panelPort,
    start() {
      queueTimer = setInterval(runNext, config.queue?.intervalMs ?? 1500);
      setInterval(() => { if (state.rcon !== 'connected') checkRcon(); }, 10000);
      checkRcon().then(() => {
        if (state.rcon === 'connected') rcon.command('function halloween_live:ping').catch(() => {});
        log(state.rcon === 'connected' ? 'info' : 'error',
          state.rcon === 'connected' ? 'Minecraft サーバー（RCON）に接続しました' : `RCON に接続できません: ${state.rconDetail}（「接続設定」タブで設定してください）`);
      });
    },
  };
}
