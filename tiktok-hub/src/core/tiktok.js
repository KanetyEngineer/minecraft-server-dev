// One TikTok LIVE connection per streamer (TikTok ID). The connection does not know about games:
// every event is routed at the moment it arrives to the game + field the streamer is assigned to,
// so moving a streamer to another game or field needs no reconnect.
import { TikTokLiveConnection, WebcastEvent, ControlEvent } from 'tiktok-live-connector';

// hooks: { signApiKey(), route(streamerId) -> { game, field } | null, event(streamerId, type, data),
//          log(kind, text, streamerId), changed() }
export class TikTokManager {
  constructor(hooks) {
    this.hooks = hooks;
    this.conns = new Map(); // streamer id -> runtime record
  }

  get(id) {
    return this.conns.get(id) ?? null;
  }

  // keep exactly the wanted connections: [{ id, tiktok }] (only streamers that are assigned and switched on)
  sync(wanted) {
    const keep = new Set();
    for (const w of wanted) {
      if (!w.tiktok) continue;
      keep.add(w.id);
      const c = this.conns.get(w.id);
      if (!c) this.connect(w.id, w.tiktok);
      else if (c.tiktok !== w.tiktok) this.connect(w.id, w.tiktok);
    }
    for (const id of [...this.conns.keys()]) if (!keep.has(id)) this.remove(id);
  }

  remove(id) {
    const c = this.conns.get(id);
    if (!c) return;
    c.stopping = true;
    c.generation++;
    if (c.connection) c.connection.disconnect().catch(() => {});
    this.conns.delete(id);
    this.hooks.changed();
  }

  async disconnect(id, detail = '手動で切断しました') {
    const c = this.conns.get(id);
    if (!c) return;
    c.stopping = true;
    c.generation++;
    const old = c.connection;
    c.connection = null;
    c.status = 'off';
    c.detail = detail;
    if (old) await old.disconnect().catch(() => {});
    this.hooks.changed();
  }

  set(c, status, detail) {
    c.status = status;
    c.detail = detail;
    this.hooks.changed();
  }

  async connect(id, tiktok) {
    let c = this.conns.get(id);
    if (!c) {
      c = { id, tiktok, status: 'off', detail: '', connection: null, generation: 0, stopping: false, totalLikes: 0, roomId: null, since: null };
      this.conns.set(id, c);
    }
    if (tiktok) c.tiktok = tiktok;
    const gen = ++c.generation;
    if (c.connection) { const old = c.connection; c.connection = null; old.disconnect().catch(() => {}); }
    c.stopping = false;
    c.totalLikes = 0;
    this.set(c, 'connecting', '');
    const user = c.tiktok;
    const connection = new TikTokLiveConnection(user, {
      signApiKey: this.hooks.signApiKey() || undefined,
      processInitialData: false,
      // the gift-list lookup needs a paid Euler Stream plan; gift name/coins already come with each gift event
      enableExtendedGiftInfo: false,
    });
    c.connection = connection;
    const alive = () => gen === c.generation && this.conns.get(id) === c;
    const fwd = (type) => (d) => {
      if (!alive()) return;
      if (type === 'like') c.totalLikes = Number(d.totalLikeCount) || c.totalLikes + (Number(d.likeCount) || 0);
      try { this.hooks.event(id, type, d); } catch (err) { this.hooks.log('error', `イベントの処理に失敗: ${err.message}`, id); }
    };
    connection.on(WebcastEvent.GIFT, fwd('gift'));
    connection.on(WebcastEvent.FOLLOW, fwd('follow'));
    connection.on(WebcastEvent.SHARE, fwd('share'));
    connection.on(WebcastEvent.SUBSCRIBE ?? 'subscribe', fwd('subscribe'));
    connection.on(WebcastEvent.LIKE, fwd('like'));
    connection.on(WebcastEvent.CHAT, fwd('chat'));
    connection.on(ControlEvent.DISCONNECTED, () => {
      if (c.stopping || !alive()) return;
      this.set(c, 'connecting', '切断されたので30秒後に再接続します');
      this.hooks.log('warn', 'TikTok との接続が切れました。30秒後に再接続します', id);
      setTimeout(() => { if (!c.stopping && alive()) this.connect(id); }, 30000);
    });
    connection.on(WebcastEvent.STREAM_END, () => {
      if (!alive()) return;
      this.set(c, 'offline', '配信が終了しました');
      this.hooks.log('info', '配信が終了しました', id);
    });
    try {
      const s = await connection.connect();
      if (!alive()) return;
      c.roomId = s.roomId;
      c.since = Date.now();
      this.set(c, 'connected', `@${user}（roomId ${s.roomId}）`);
      this.hooks.log('info', `TikTok LIVE に接続しました: @${user}`, id);
    } catch (err) {
      if (!alive()) return;
      const offline = /offline|not live|UserOffline/i.test(`${err?.name} ${err?.message}`);
      this.set(c, offline ? 'offline' : 'error', offline ? '配信していません。60秒ごとに再確認します' : String(err?.message ?? err));
      this.hooks.log(offline ? 'info' : 'error', `TikTok @${user}: ${c.detail}`, id);
      setTimeout(() => { if (!c.stopping && alive()) this.connect(id); }, 60000);
    }
  }

  // the API key changed: reconnect everything that is not switched off
  reconnectAll() {
    for (const c of this.conns.values()) if (!c.stopping) this.connect(c.id);
  }
}
