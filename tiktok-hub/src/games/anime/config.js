// config.json: load, validate (everything edited from the panel goes through here) and save,
// plus the one-click Minecraft server setup (RCON + data pack).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';


const int = (v, min, max, def) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
};
const str = (v, max = 200) => String(v ?? '').trim().slice(0, max);

// returns a clean config or throws an Error with a message for the panel
const cleanTikTok = (v) => str(v, 64).replace(/^https?:\/\/(www\.)?tiktok\.com\//, '').replace(/^@/, '').replace(/\/live\/?$/, '').replace(/\/$/, '');

// fieldIds: the field numbers the data pack has (streamers are assigned to one of them)
export function validateConfig(input, actions, fieldIds = [1]) {
  const isAction = (a) => typeof a === 'string' && Object.hasOwn(actions, a);
  const optAction = (a, what) => {
    if (a === '' || a == null) return '';
    if (!isAction(a)) throw new Error(`${what} のアクション "${a}" がありません`);
    return a;
  };
  const c = input ?? {};
  const out = {
    tiktokUsername: '',
    streamers: [],
    signApiKey: str(c.signApiKey, 200),
    rcon: {
      host: str(c.rcon?.host, 100) || '127.0.0.1',
      port: int(c.rcon?.port, 1, 65535, 25591),
      password: str(c.rcon?.password, 200),
    },
    panelPort: int(c.panelPort, 1024, 65535, 8790),
    queue: { intervalMs: int(c.queue?.intervalMs, 300, 10000, 1500), maxLength: int(c.queue?.maxLength, 1, 500, 40) },
    giftRules: { byName: {}, tiers: [], repeatSmallUpTo: int(c.giftRules?.repeatSmallUpTo, 1, 50, 5) },
    follow: optAction(c.follow, 'フォロー'),
    share: optAction(c.share, 'シェア'),
    subscribe: optAction(c.subscribe, 'サブスク'),
    likes: { every: int(c.likes?.every, 0, 10000000, 1000), action: optAction(c.likes?.action, 'いいね') },
    chatCommands: {
      enabled: Boolean(c.chatCommands?.enabled),
      cooldownSec: int(c.chatCommands?.cooldownSec, 0, 3600, 30),
      commands: {},
    },
    cooldownSec: {},
    fallbackAction: isAction(c.fallbackAction) ? c.fallbackAction : 'firework',
  };
  // streamers: one per field (Minecraft name + TikTok ID). An old config with only tiktokUsername = field 1.
  const list = Array.isArray(c.streamers) ? c.streamers : (c.tiktokUsername ? [{ field: 1, minecraft: '', tiktok: c.tiktokUsername }] : []);
  const used = new Set();
  for (const s of list) {
    const field = int(s?.field, 1, 999, 1);
    const minecraft = str(s?.minecraft, 16);
    const tiktok = cleanTikTok(s?.tiktok);
    if (!minecraft && !tiktok) continue;
    if (!fieldIds.includes(field)) throw new Error(`フィールド ${field} はありません`);
    if (used.has(field)) throw new Error(`フィールド ${field} に配信者が2人います（1フィールド1人）`);
    if (minecraft && !/^[A-Za-z0-9_]{1,16}$/.test(minecraft)) throw new Error(`Minecraft の名前「${minecraft}」に使えない文字があります`);
    if (!/^[\w.]*$/.test(tiktok)) throw new Error(`TikTok の ID「${tiktok}」に使えない文字があります`);
    used.add(field);
    out.streamers.push({ field, minecraft, tiktok });
  }
  out.streamers.sort((a, b) => a.field - b.field);
  // kept for older tools that read it: the field 1 streamer's TikTok ID
  out.tiktokUsername = out.streamers.find((s) => s.field === 1)?.tiktok ?? '';
  for (const [name, a] of Object.entries(c.giftRules?.byName ?? {})) {
    const n = str(name, 64);
    if (!n) continue;
    if (!isAction(a)) throw new Error(`ギフト「${n}」のアクションを選んでください`);
    out.giftRules.byName[n] = a;
  }
  for (const t of c.giftRules?.tiers ?? []) {
    const acts = (t.actions ?? []).filter(isAction);
    if (!acts.length) throw new Error(`${t.minCoins} コインの段階にアクションを1つ以上選んでください`);
    out.giftRules.tiers.push({ minCoins: int(t.minCoins, 1, 1000000, 1), pick: t.pick === 'all' ? 'all' : 'random', actions: acts });
  }
  out.giftRules.tiers.sort((a, b) => a.minCoins - b.minCoins);
  if (!out.giftRules.tiers.length) throw new Error('コインの段階を1つ以上作ってください');
  for (const [word, a] of Object.entries(c.chatCommands?.commands ?? {})) {
    const w = str(word, 32);
    if (!w) continue;
    if (!isAction(a)) throw new Error(`コメント「${w}」のアクションを選んでください`);
    out.chatCommands.commands[w] = a;
  }
  for (const [a, sec] of Object.entries(c.cooldownSec ?? {})) {
    if (isAction(a) && Number(sec) > 0) out.cooldownSec[a] = int(sec, 0, 3600, 0);
  }
  return out;
}


// ---------------------------------------------------------------- server setup
function readProps(file) {
  return fs.readFileSync(file, 'utf8');
}

function setProp(text, key, value) {
  const re = new RegExp(`^${key.replace('.', '\\.')}=.*$`, 'm');
  return re.test(text) ? text.replace(re, `${key}=${value}`) : `${text.replace(/\s*$/, '')}\n${key}=${value}\n`;
}

// Enables RCON in <serverDir>/server.properties (keeps an existing password) and copies the data pack
// into the world's datapacks folder. Returns { password, port, world, changed } for the panel.
export function setupServer(packZip, serverDir, wantPort) {
  const dir = str(serverDir, 500).replace(/^"|"$/g, '');
  const propsFile = path.join(dir, 'server.properties');
  if (!dir || !fs.existsSync(propsFile)) throw new Error('そのフォルダに server.properties がありません（サーバーのフォルダを指定してください）');
  let text = readProps(propsFile);
  const get = (k) => (text.match(new RegExp(`^${k.replace('.', '\\.')}=(.*)$`, 'm')) ?? [])[1]?.trim() ?? '';
  const port = int(wantPort || get('rcon.port'), 1, 65535, 25591);
  const password = get('rcon.password') || crypto.randomBytes(18).toString('base64url');
  const before = text;
  text = setProp(text, 'enable-rcon', 'true');
  text = setProp(text, 'rcon.port', String(port));
  text = setProp(text, 'rcon.password', password);
  if (text !== before) {
    fs.copyFileSync(propsFile, `${propsFile}.bak`);
    fs.writeFileSync(propsFile, text, 'utf8');
  }
  const world = get('level-name') || 'world';
  const packDir = path.join(dir, world, 'datapacks');
  fs.mkdirSync(packDir, { recursive: true });
  fs.copyFileSync(packZip, path.join(packDir, 'anime_umetate_datapack.zip'));
  return { password, port, world, changed: text !== before };
}
