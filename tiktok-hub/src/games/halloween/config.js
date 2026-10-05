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
export function validateConfig(input, actions) {
  const isAction = (a) => typeof a === 'string' && Object.hasOwn(actions, a);
  const optAction = (a, what) => {
    if (a === '' || a == null) return '';
    if (!isAction(a)) throw new Error(`${what} のアクション "${a}" がありません`);
    return a;
  };
  const c = input ?? {};
  const out = {
    tiktokUsername: str(c.tiktokUsername, 64).replace(/^https?:\/\/(www\.)?tiktok\.com\//, '').replace(/^@/, '').replace(/\/live\/?$/, ''),
    signApiKey: str(c.signApiKey, 200),
    rcon: {
      host: str(c.rcon?.host, 100) || '127.0.0.1',
      port: int(c.rcon?.port, 1, 65535, 25575),
      password: str(c.rcon?.password, 200),
    },
    panelPort: int(c.panelPort, 1024, 65535, 8787),
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
  if (!/^[\w.]*$/.test(out.tiktokUsername)) throw new Error('TikTok の ID に使えない文字があります');
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
  const port = int(wantPort || get('rcon.port'), 1, 65535, 25575);
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
  fs.copyFileSync(packZip, path.join(packDir, 'halloween_live_datapack.zip'));
  return { password, port, world, changed: text !== before };
}
