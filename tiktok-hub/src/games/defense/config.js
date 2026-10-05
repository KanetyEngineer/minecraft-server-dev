// config.json: load, validate (everything edited from the panel goes through here) and save,
// plus the one-click Minecraft server setup (RCON + data pack).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';


const int = (v, min, max, def) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
};
const num = (v, min, max, def) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
};
const str = (v, max = 200) => String(v ?? '').trim().slice(0, max);

// limits for the game numbers (score #<key> td.cfg); [min, max]
export const GAME_LIMITS = {
  time: [0, 7200], coreHp: [1, 100000], gateHp: [1, 100000], leakMul: [0, 1000],
  waveSec: [0, 600], waveN: [0, 50], waveRamp: [0, 3600], waveMax: [0, 100],
  maxEnemies: [1, 400], repairPct: [1, 100], bossMax: [0, 20], titanMax: [0, 10],
};
const MOB_LIMITS = { hp: [1, 5000], speed: [0.05, 1], scale: [0.3, 5], dmg: [0, 100], atk: [0, 1000] };

// returns a clean config or throws an Error with a message for the panel
export function validateConfig(input, meta, weapons) {
  const actions = meta.actions;
  const isAction = (a) => typeof a === 'string' && Object.hasOwn(actions, a);
  const optAction = (a, what) => {
    if (a === '' || a == null) return '';
    if (!isAction(a)) throw new Error(`${what} のアクション "${a}" がありません`);
    return a;
  };
  const c = input ?? {};
  const ttId = (v) => str(v, 64).replace(/^https?:\/\/(www\.)?tiktok\.com\//, '').replace(/^@/, '').replace(/\/live\/?$/, '');
  const out = {
    tiktokUsername: '', // = fields.list[0].tiktokUsername (kept for the single-field config)
    signApiKey: str(c.signApiKey, 200),
    rcon: {
      host: str(c.rcon?.host, 100) || '127.0.0.1',
      port: int(c.rcon?.port, 1, 65535, 25584),
      password: str(c.rcon?.password, 200),
    },
    panelPort: int(c.panelPort, 1024, 65535, 8788),
    queue: { intervalMs: int(c.queue?.intervalMs, 200, 10000, 700), maxLength: int(c.queue?.maxLength, 1, 500, 60) },
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
    actionCounts: {},
    game: {},
    mobs: {},
    field: {
      originX: int(c.field?.originX, -100000, 100000, 0),
      originY: int(c.field?.originY, -60, 250, -58),
      originZ: int(c.field?.originZ, -100000, 100000, 0),
      length: int(c.field?.length, 60, 300, 120),
      halfWidth: int(c.field?.halfWidth, 2, 12, 4),
      gates: int(c.field?.gates, 1, 8, 3),
      timeOfDay: int(c.field?.timeOfDay, 0, 23999, 12300),
      trees: c.field?.trees !== false,
    },
    weapons: {
      loadout: [], grenades: int(c.weapons?.grenades, 0, 64, 4), ammoMags: int(c.weapons?.ammoMags, 1, 64, 8),
      infiniteAmmo: c.weapons?.infiniteAmmo !== false, giftPool: [],
    },
  };
  // fields: how many lanes, how far apart, and who streams on each (field 1 = the old single TikTok ID)
  const maxF = meta.maxFields ?? 8;
  out.fields = {
    count: int(c.fields?.count, 1, maxF, 4),
    spacing: int(c.fields?.spacing, 60, 2000, 200),
    list: [],
  };
  out.fields.spacing = Math.max(out.fields.spacing, out.field.halfWidth * 2 + 32);
  for (let i = 0; i < maxF; i++) {
    const s = c.fields?.list?.[i] ?? {};
    const id = ttId(i === 0 && s.tiktokUsername === undefined ? c.tiktokUsername : s.tiktokUsername);
    if (!/^[\w.]*$/.test(id)) throw new Error(`フィールド${i + 1} の TikTok の ID に使えない文字があります`);
    const mc = str(s.mcName, 16);
    if (!/^\w*$/.test(mc)) throw new Error(`フィールド${i + 1} のマイクラの名前に使えない文字があります`);
    out.fields.list.push({ tiktokUsername: id, mcName: mc });
  }
  out.tiktokUsername = out.fields.list[0].tiktokUsername;
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
  for (const [a, def] of Object.entries(actions)) out.actionCounts[a] = int(c.actionCounts?.[a], 1, 50, def.count);
  for (const [k, [min, max]] of Object.entries(GAME_LIMITS)) out.game[k] = int(c.game?.[k], min, max, meta.cfg[k]);
  out.game.spread = Math.min(int(c.game?.spread, 0, 11, 3), out.field.halfWidth - 1);
  out.game.avatarScale = num(c.game?.avatarScale, 0.03, 0.5, 0.12);
  for (const [m, def] of Object.entries(meta.mobs)) {
    out.mobs[m] = {};
    for (const [k, [min, max]] of Object.entries(MOB_LIMITS)) {
      out.mobs[m][k] = k === 'speed' || k === 'scale' ? num(c.mobs?.[m]?.[k], min, max, def[k]) : int(c.mobs?.[m]?.[k], min, max, def[k]);
    }
  }
  const isWeapon = (w) => typeof w === 'string' && Object.hasOwn(weapons, w);
  out.weapons.loadout = [...new Set((c.weapons?.loadout ?? []).filter(isWeapon))].slice(0, 9);
  out.weapons.giftPool = [...new Set((c.weapons?.giftPool ?? []).filter(isWeapon))];
  return out;
}


// ---------------------------------------------------------------- server setup
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
  let text = fs.readFileSync(propsFile, 'utf8');
  const get = (k) => (text.match(new RegExp(`^${k.replace('.', '\\.')}=(.*)$`, 'm')) ?? [])[1]?.trim() ?? '';
  const port = int(wantPort || get('rcon.port'), 1, 65535, 25584);
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
  fs.copyFileSync(packZip, path.join(packDir, 'td_datapack.zip'));
  return { password, port, world, changed: text !== before };
}
