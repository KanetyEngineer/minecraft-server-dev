// コマバトルRPG (Unity) — one board.
// TikTok events -> JSON over a local WebSocket (default ws://127.0.0.1:8810/) -> the Unity game, which connects as a client.
// The game sends its own status back ({type:"status", ...}) so the panel can show the phase, boss and players.
// Unlike the Minecraft games there is no RCON: "server connected" here means "the Unity game is connected".
import { WebSocketServer } from 'ws';
import { json, readBody } from '../../core/util.js';
import { avatarUrl } from '../../core/avatar.js';

export const meta = {
  id: 'koma', title: 'コマバトルRPG（Unity）', short: 'コマバトル', icon: '♟️', fieldWord: '盤',
  legacyPort: 0, rconPort: 0, oldApp: '', sources: {},
};

const HOLD_MS = 60000; // events that arrive while the game is not connected are kept this long
const HOLD_MAX = 200;

export function validate(raw) {
  const r = raw ?? {};
  const port = Math.round(Number(r.wsPort)) || 8810;
  if (port < 1024 || port > 65535) throw new Error('WebSocket のポートは 1024〜65535 にしてください');
  return {
    tiktokUsername: String(r.tiktokUsername ?? '').trim().replace(/^@/, '').slice(0, 64),
    wsPort: port,
  };
}

export function streamersOf(cfg) {
  return { 1: { tiktok: cfg.tiktokUsername || '', mc: '' } };
}

const PHASES = { Story: '物語', Battle: 'バトル', Result: 'リザルト' };

export function createGame(ctx) {
  let config = validate(ctx.config());

  const state = { tiktok: 'off', tiktokDetail: '', log: [], coins: 0, likes: 0, counts: { comment: 0, like: 0, gift: 0, follow: 0, share: 0 }, game: null, gameAt: 0 };
  const clients = new Set();
  const held = [];
  const overlayItems = [];
  let overlaySeq = 0;
  let wss = null;
  let wsError = '';

  function log(kind, text) {
    state.log.unshift({ t: new Date().toLocaleTimeString('ja-JP'), kind, text });
    state.log.length = Math.min(state.log.length, 200);
    ctx.print(kind, text);
  }

  // ---------------------------------------------------------------- WebSocket
  function startWs() {
    if (wss) { for (const c of clients) c.terminate(); clients.clear(); wss.close(); wss = null; }
    wsError = '';
    const server = new WebSocketServer({ host: '127.0.0.1', port: config.wsPort });
    wss = server;
    server.on('listening', () => log('info', `Unity の接続を ws://127.0.0.1:${config.wsPort}/ で待っています`));
    server.on('error', (err) => {
      wsError = err.code === 'EADDRINUSE' ? `ポート ${config.wsPort} は使用中です` : err.message;
      log('error', `WebSocket を開けません: ${wsError}`);
    });
    server.on('connection', (ws) => {
      clients.add(ws);
      log('info', `Unity のゲームが接続しました（${clients.size}）`);
      const now = Date.now();
      const pending = held.splice(0).filter((h) => now - h.at < HOLD_MS);
      if (pending.length) log('info', `待っていたイベント ${pending.length} 件を送りました`);
      for (const h of pending) ws.send(h.text);
      ws.on('message', (buf) => {
        let m;
        try { m = JSON.parse(String(buf)); } catch { return; }
        if (m?.type === 'status') { state.game = m; state.gameAt = Date.now(); }
      });
      ws.on('close', () => {
        clients.delete(ws);
        log('warn', `Unity のゲームが切断しました（${clients.size}）`);
        if (!clients.size) state.game = null;
      });
      ws.on('error', () => {});
    });
  }

  function broadcast(obj) {
    const text = JSON.stringify(obj);
    let sent = 0;
    for (const c of clients) if (c.readyState === 1) { c.send(text); sent++; }
    if (!sent && obj.type !== 'control') {
      held.push({ at: Date.now(), text });
      if (held.length > HOLD_MAX) held.shift();
    }
    return sent;
  }

  // ---------------------------------------------------------------- TikTok -> game
  function userOf(d) {
    const u = d.user ?? {};
    const id = String(u.uniqueId || u.userId || d.uniqueId || '').slice(0, 64);
    return { userId: id || 'unknown', nickname: String(u.nickname || id || '?').slice(0, 32), avatarUrl: avatarUrl(u) || '' };
  }

  function onEvent(_field, type, d) {
    const who = userOf(d);
    switch (type) {
      case 'chat': {
        const comment = String(d.comment ?? '').slice(0, 200);
        state.counts.comment++;
        broadcast({ type: 'comment', ...who, comment });
        return;
      }
      case 'like': {
        const n = Math.max(1, Number(d.likeCount) || 1);
        state.counts.like++;
        state.likes = Number(d.totalLikeCount) || state.likes + n;
        broadcast({ type: 'like', ...who, likeCount: n });
        return;
      }
      case 'gift': {
        const g = d.gift ?? d.giftDetails ?? {};
        if ((g.type ?? g.giftType) === 1 && !d.repeatEnd) return; // combo still running: wait for the final event
        const giftName = String(g.name ?? g.giftName ?? d.extendedGiftInfo?.name ?? `gift ${d.giftId}`).slice(0, 40);
        const diamondCount = Number(g.diamondCount ?? d.extendedGiftInfo?.diamond_count ?? 1) || 1;
        const repeatCount = Math.max(1, Number(d.repeatCount) || 1);
        state.counts.gift++;
        state.coins += diamondCount * repeatCount;
        log('gift', `${who.nickname} → ${giftName} ×${repeatCount}（${diamondCount * repeatCount}コイン）`);
        overlayItems.push({ id: ++overlaySeq, name: who.nickname, gift: giftName, coins: diamondCount * repeatCount, avatar: who.avatarUrl, at: Date.now() });
        if (overlayItems.length > 20) overlayItems.shift();
        broadcast({ type: 'gift', ...who, giftName, diamondCount, repeatCount });
        return;
      }
      case 'follow':
      case 'subscribe':
        state.counts.follow++;
        log(type, `${who.nickname} が${type === 'follow' ? 'フォロー' : 'サブスク'}`);
        broadcast({ type: 'follow', ...who });
        return;
      case 'share':
        state.counts.share++;
        log('share', `${who.nickname} がシェア`);
        broadcast({ type: 'share', ...who });
        return;
      default:
    }
  }

  // a fake TikTok event from the panel, shaped like tiktok-live-connector's data so it takes the same path
  function testEvent(b) {
    const name = String(b.name || 'テスト視聴者').slice(0, 24);
    const user = { nickname: name, uniqueId: String(b.userId || `test_${name}`).slice(0, 40) };
    switch (b.type) {
      case 'comment': return onEvent(1, 'chat', { user, comment: String(b.comment ?? '参加') });
      case 'like': return onEvent(1, 'like', { user, likeCount: Math.max(1, Math.min(10000, Number(b.likes) || 20)) });
      case 'gift': return onEvent(1, 'gift', { user, gift: { name: String(b.gift || 'テストギフト'), diamondCount: Math.max(1, Math.min(100000, Number(b.coins) || 1)), type: 0 }, repeatCount: 1, repeatEnd: true });
      case 'follow': return onEvent(1, 'follow', { user });
      case 'share': return onEvent(1, 'share', { user });
      default: throw new Error('知らない種類です');
    }
  }

  // ---------------------------------------------------------------- panel API
  function gameJson() {
    const g = state.game;
    if (!g || Date.now() - state.gameAt > 10000) return null;
    return { ...g, phaseLabel: PHASES[g.phase] ?? g.phase };
  }

  async function handle(req, res, url) {
    const p = url.pathname;
    if (req.method === 'GET' && p === '/api/state') {
      return json(res, {
        tiktok: state.tiktok, tiktokDetail: state.tiktokDetail, username: config.tiktokUsername,
        unity: clients.size, wsPort: config.wsPort, wsError, held: held.length,
        coins: state.coins, likes: state.likes, counts: state.counts, game: gameJson(), log: state.log.slice(0, 120),
      });
    }
    if (req.method === 'GET' && p === '/api/config') return json(res, { config, configFile: ctx.configFile() });
    if (req.method === 'POST' && p === '/api/config') {
      try {
        const next = validate(await readBody(req));
        const portChanged = next.wsPort !== config.wsPort;
        const idChanged = next.tiktokUsername !== config.tiktokUsername;
        config = next;
        ctx.save(config);
        if (portChanged) startWs();
        if (idChanged) await ctx.fieldsEdited();
        log('info', '設定を保存しました');
        return json(res, { ok: true, message: portChanged ? `保存しました。Unity 側の URL も ws://127.0.0.1:${config.wsPort}/ にしてください。` : '保存しました。' });
      } catch (err) {
        return json(res, { ok: false, message: err.message }, 400);
      }
    }
    if (req.method === 'POST' && p === '/api/test') {
      try {
        testEvent(await readBody(req));
        return json(res, { ok: true, unity: clients.size });
      } catch (err) {
        return json(res, { ok: false, message: err.message }, 400);
      }
    }
    if (req.method === 'POST' && p === '/api/control') {
      const b = await readBody(req);
      const command = String(b.command ?? '');
      if (!['skip', 'damage'].includes(command)) return json(res, { ok: false, message: '知らない操作です' }, 400);
      const sent = broadcast({ type: 'control', command });
      return json(res, sent ? { ok: true } : { ok: false, message: 'Unity のゲームが接続していません' });
    }
    if (req.method === 'POST' && p === '/api/tiktok') {
      const b = await readBody(req);
      await ctx.tiktokControl(null, Boolean(b.connect));
      return json(res, { ok: true });
    }
    if (req.method === 'GET' && p === '/api/overlay') {
      const since = Number(url.searchParams.get('since')) || 0;
      return json(res, { latest: overlaySeq, items: overlayItems.filter((i) => i.id > since) });
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
      config = { ...config, tiktokUsername: tiktok };
      ctx.save(config);
    },
    setConn(_field, c) {
      state.tiktok = c.status;
      state.tiktokDetail = c.detail;
    },
    onEvent,
    handle,
    log: (kind, text) => log(kind, text),
    resourcePack: () => null,
    status: () => {
      const g = gameJson();
      return {
        rcon: clients.size ? 'connected' : 'error',
        rconDetail: clients.size ? '' : wsError || 'Unity のゲームが接続していません（再生してください）',
        port: config.wsPort,
        serverLabel: `Unity（WebSocket ${config.wsPort}）`,
        fields: [{ n: 1, queue: held.length, state: g ? `${g.phaseLabel} ${g.chapterTitle ?? ''}`.trim() : null, people: g?.participants ?? 0 }],
      };
    },
    legacyPort: () => 0,
    start() {
      startWs();
    },
  };
}
