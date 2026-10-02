// AI の思考ログ（🧠 判断、🛠 スキルの開始と結果、警告）を Discord のチャンネルへ送る。
// .env の DISCORD_BOT_TOKEN と DISCORD_CHANNEL_ID が両方あるときだけ動く。
// ログが出るたびにすぐ送り、同じ行の連続は回数だけ数える（レート制限と通知の洪水を避ける）。
const API = 'https://discord.com/api/v10';
const FLUSH_MS = 1000; // ログが出たらすぐ送る（1 秒以内に出た行は 1 通にまとめ、Discord の送信制限を超えないようにする）
const MAX_LEN = 1900; // Discord の上限 2000 文字からコードブロック分を引いた値
const MAX_QUEUE = 300;

let token = null;
let channel = null;
let queue = [];
let lastBody = null;
let repeats = 0;
let timer = null;
let sending = false;

let prefix = '';
export function startDiscordLog({ botToken, channelId, prefix: name } = {}) {
  if (!botToken || !channelId) return false;
  // 複数のボットが同じチャンネルに送るので、行の頭に名前を付けて見分ける
  prefix = name ? `${name} ` : '';
  token = botToken;
  channel = channelId;
  timer = setInterval(() => { flush().catch(() => {}); }, FLUSH_MS);
  timer.unref?.();
  return true;
}

export function discordEnabled() {
  return Boolean(token && channel);
}

// line は "[hh:mm:ss] 本文"。時刻を除いた本文が直前と同じなら回数だけ数える
// DISCORD_LEVEL=important のときは大事な行（スキルの成功・死亡・受け渡し・キック・エラー）だけ送る（ボットが多いとき用）
const IMPORTANT = /🛠 成功|死んで|渡した|キック|エラー|ゲート|ネザー|ポータル/;
export function queueDiscord(line) {
  if (!discordEnabled()) return;
  if (process.env.DISCORD_LEVEL === 'important' && !IMPORTANT.test(line)) return;
  const body = line.replace(/^\[[\d:]+\] /, '');
  if (body === lastBody) { repeats++; return; }
  closeRepeats();
  lastBody = body;
  const l = prefix + line;
  queue.push(l.length > 400 ? `${l.slice(0, 400)}…` : l);
  if (queue.length > MAX_QUEUE) queue.splice(0, queue.length - MAX_QUEUE, '…（送りきれない分を省略）');
}

function closeRepeats() {
  if (repeats > 0) queue.push(`  （上と同じ行がさらに ${repeats} 回）`);
  repeats = 0;
}

// 1 通に収まるだけ行を取り出す
function takeChunk() {
  const lines = [];
  let len = 0;
  while (queue.length && len + queue[0].length + 1 <= MAX_LEN) {
    const l = queue.shift();
    lines.push(l);
    len += l.length + 1;
  }
  return lines.join('\n').replaceAll('```', "'''");
}

async function post(content) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`${API}/channels/${channel}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '```\n' + content + '\n```', allowed_mentions: { parse: [] } }),
    });
    if (res.status === 429) {
      const j = await res.json().catch(() => ({}));
      await new Promise((r) => setTimeout(r, Math.ceil((j.retry_after ?? 2) * 1000)));
      continue;
    }
    if (res.status === 401 || res.status === 403 || res.status === 404) {
      // トークンかチャンネル ID が違う。以後は送らない
      console.warn(`Discord への送信をやめる（HTTP ${res.status}）。DISCORD_BOT_TOKEN と DISCORD_CHANNEL_ID、ボットの権限を確認`);
      token = null;
    }
    return;
  }
}

export async function flush() {
  if (sending || !discordEnabled()) return;
  closeRepeats();
  lastBody = null;
  sending = true;
  try {
    // 1 回の flush で送るのは最大 5 通（溜まっていれば次の回へ）
    for (let i = 0; i < 5 && queue.length && discordEnabled(); i++) await post(takeChunk());
  } catch {
    // ネットワークの失敗はログを止めない
  } finally {
    sending = false;
  }
}
