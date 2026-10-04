// 社会実験を「見る側」の Prism Launcher インスタンスを作る（既存のインスタンスには触らない）。
// Fabric 1.21.11 ＋ Sodium・Iris（影 MOD）＋ Complementary Reimagined（影）＋ Replay Mod（録画の再生）＋ Fabric API。
// サーバー一覧に社会実験鯖（127.0.0.1:25573）を入れ、影は最初から有効にしておく。
// 使い方: node scripts/make-viewer-instance.mjs [インスタンス名]   （Prism を開き直すと一覧に出る）
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const MC = '1.21.11';
const LOADER = '0.19.5';
const name = process.argv[2] || 'MBTI社会実験-観察用';
const root = path.join(process.env.APPDATA, 'PrismLauncher', 'instances', name);
if (fs.existsSync(root)) { console.error(`${root} はもうあります（上書きしません）`); process.exit(1); }
const UA = { 'User-Agent': 'society-bot-setup/1.0 (https://github.com/KanetyEngineer/minecraft-server-dev)' };

async function download(slug, dir, loaders) {
  const q = `game_versions=${encodeURIComponent(JSON.stringify([MC]))}&loaders=${encodeURIComponent(JSON.stringify(loaders))}`;
  const v = (await (await fetch(`https://api.modrinth.com/v2/project/${slug}/version?${q}`, { headers: UA })).json())[0];
  if (!v) throw new Error(`${slug} の ${MC} 用が見つからない`);
  const f = v.files.find((x) => x.primary) ?? v.files[0];
  const buf = Buffer.from(await (await fetch(f.url, { headers: UA })).arrayBuffer());
  if (crypto.createHash('sha512').update(buf).digest('hex') !== f.hashes.sha512) throw new Error(`${f.filename} の sha512 が合わない`);
  fs.writeFileSync(path.join(dir, f.filename), buf);
  console.log(`${slug}: ${f.filename}`);
  return f.filename;
}

// servers.dat（圧縮なしの NBT）: { servers: [ { name, ip } ] }
function serversDat(list) {
  const str = (s) => { const b = Buffer.from(s, 'utf8'); const l = Buffer.alloc(2); l.writeUInt16BE(b.length); return Buffer.concat([l, b]); };
  const tag = (type, nm, payload) => Buffer.concat([Buffer.from([type]), str(nm), payload]);
  const entries = list.map((s) => Buffer.concat([tag(8, 'name', str(s.name)), tag(8, 'ip', str(s.ip)), Buffer.from([0])]));
  const len = Buffer.alloc(4); len.writeInt32BE(entries.length);
  return tag(10, '', Buffer.concat([tag(9, 'servers', Buffer.concat([Buffer.from([10]), len, ...entries])), Buffer.from([0])]));
}

const mc = path.join(root, 'minecraft');
for (const d of ['mods', 'shaderpacks', 'config']) fs.mkdirSync(path.join(mc, d), { recursive: true });
for (const slug of ['fabric-api', 'sodium', 'iris', 'replaymod']) await download(slug, path.join(mc, 'mods'), ['fabric']);
const shader = await download('complementary-reimagined', path.join(mc, 'shaderpacks'), ['iris']);
fs.writeFileSync(path.join(mc, 'config', 'iris.properties'), `enableShaders=true\nshaderPack=${shader}\n`);
fs.writeFileSync(path.join(mc, 'servers.dat'), serversDat([{ name: 'MBTI 社会実験', ip: '127.0.0.1:25573' }]));
fs.writeFileSync(path.join(root, 'instance.cfg'), `[General]\nConfigVersion=1.3\nInstanceType=OneSix\nname=${name}\niconKey=default\n`);
fs.writeFileSync(path.join(root, 'mmc-pack.json'), JSON.stringify({
  components: [
    { uid: 'net.minecraft', version: MC, important: true },
    { uid: 'net.fabricmc.intermediary', version: MC, dependencyOnly: true },
    { uid: 'net.fabricmc.fabric-loader', version: LOADER },
  ],
  formatVersion: 1,
}, null, 4));
console.log(`\n作成: ${root}\nPrism Launcher を開き直すと「${name}」が出ます。録画（.mcpr）は ${path.join(mc, 'replay_recordings')} に置くと Replay Viewer で再生できます`);
fs.mkdirSync(path.join(mc, 'replay_recordings'), { recursive: true });
