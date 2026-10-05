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
const DEFAULT_DECK_B = ['knight', 'archers', 'giant', 'mini_pekka', 'musketeer', 'minions', 'fireball', 'arrows'];
const DEFAULT_DECK_R = ['knight', 'archers', 'giant', 'musketeer', 'minions', 'valkyrie', 'hog_rider', 'fireball'];

// one arena's game settings (streamer, AI, decks); `d` = the defaults for this arena
function arenaGame(g, d, deck) {
  const tiktok = str(g?.tiktokUsername, 64).replace(/^https?:\/\/(www\.)?tiktok\.com\//, '').replace(/^@/, '').replace(/\/live\/?$/, '');
  if (!/^[\w.]*$/.test(tiktok)) throw new Error('TikTok の ID に使えない文字があります');
  return {
    player: str(g?.player, 16).replace(/[^\w]/g, ''),
    tiktokUsername: tiktok,
    label: str(g?.label, 24).replace(/["\\$\u0000-\u001f{}]/g, ''),
    bot: int(g?.bot, 1, 3, 2),
    len: int(g?.len, 1, 10, 3),
    auto: g?.auto === undefined ? d.auto : Boolean(g.auto),
    harass: g?.harass === 'red' ? 'red' : 'blue',
    viewerCap: int(g?.viewerCap, 1, 200, 40),
    deckB: deck(g?.deckB, DEFAULT_DECK_B),
    deckR: deck(g?.deckR, DEFAULT_DECK_R),
  };
}

// arenaCount: how many arenas the data pack has (crmc_datapack.arenas.json). Old configs (one "game" + "tiktokUsername")
// become arena 1; config.game / config.tiktokUsername are still written as a copy of arena 1.
export function validateConfig(input, actions, cards = [], arenaCount = 1) {
  const cardIds = new Set(cards.map((x) => x.id));
  // a deck is exactly 8 different known cards; anything else falls back to the default
  const deck = (d, def) => {
    if (d === undefined) return def;
    const ids = [...new Set((Array.isArray(d) ? d : []).filter((x) => cardIds.has(x)))];
    if (ids.length !== 8) throw new Error('デッキはカードをちょうど8枚選んでください');
    return ids;
  };
  const isAction = (a) => typeof a === 'string' && Object.hasOwn(actions, a);
  const optAction = (a, what) => {
    if (a === '' || a == null) return '';
    if (!isAction(a)) throw new Error(`${what} のアクション "${a}" がありません`);
    return a;
  };
  const c = input ?? {};
  const inArenas = Array.isArray(c.arenas) && c.arenas.length ? c.arenas
    : [{ ...(c.game ?? {}), tiktokUsername: c.tiktokUsername ?? '' }];
  const arenas = [];
  for (let i = 0; i < Math.max(1, arenaCount); i++) {
    try {
      arenas.push({ id: i + 1, ...arenaGame(inArenas[i], { auto: i === 0 }, deck) });
    } catch (err) {
      throw new Error(`アリーナ${i + 1}: ${err.message}`);
    }
  }
  const out = {
    tiktokUsername: arenas[0].tiktokUsername,
    signApiKey: str(c.signApiKey, 200),
    rcon: {
      host: str(c.rcon?.host, 100) || '127.0.0.1',
      port: int(c.rcon?.port, 1, 65535, 25581),
      password: str(c.rcon?.password, 200),
    },
    panelPort: int(c.panelPort, 1024, 65535, 8789),
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
    game: (({ id, tiktokUsername, label, ...g }) => g)(arenas[0]),
    arenas,
  };
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
  const port = int(wantPort || get('rcon.port'), 1, 65535, 25581);
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
  fs.copyFileSync(packZip, path.join(packDir, 'crmc_datapack.zip'));
  return { password, port, world, changed: text !== before };
}
