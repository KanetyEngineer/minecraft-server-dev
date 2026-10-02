// 社会実験鯖に RCON でコマンドを送る（鯖のコンソールを開かなくても設定できるように）。
// 使い方:
//   node scripts/society-rcon.mjs setup            ゲームルールを入れる（下の SETUP）
//   node scripts/society-rcon.mjs "list"           任意のコマンド
//   SOCIETY_SERVER_DIR=... で鯖のフォルダを変えられる（既定 Documents\ClaudeCode\society-server。rcon.txt を読む）
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// 1.21.11 からゲームルールの名前は小文字のスネークケース（keep_inventory など）
const SETUP = [
  'gamerule keep_inventory true', // 死んでも持ち物を失わない（社会づくりが死のたびに振り出しに戻らないように）
  'gamerule players_sleeping_percentage 30', // 3 割が寝れば朝になる（全員そろって寝るのは難しい）
  'gamerule spawn_phantoms false', // ファントムを出さない（家の屋根の上から襲ってくる）
  'gamerule respawn_radius 2', // 全員が広場の近くに湧く
  'difficulty easy',
];

export function rcon(host, port, password, commands) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, host);
    const out = [];
    let id = 1;
    let buf = Buffer.alloc(0);
    let queue = [...commands];
    const send = (type, body) => {
      const b = Buffer.from(body, 'utf8');
      const p = Buffer.alloc(14 + b.length);
      p.writeInt32LE(10 + b.length, 0);
      p.writeInt32LE(id++, 4);
      p.writeInt32LE(type, 8);
      b.copy(p, 12);
      sock.write(p);
    };
    const next = () => {
      const c = queue.shift();
      if (c === undefined) { sock.end(); resolve(out); return; }
      send(2, c);
    };
    sock.on('connect', () => send(3, password));
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 4 && buf.length >= 4 + buf.readInt32LE(0)) {
        const len = buf.readInt32LE(0);
        const rid = buf.readInt32LE(4);
        const body = buf.subarray(12, 4 + len - 2).toString('utf8');
        buf = buf.subarray(4 + len);
        if (rid === -1) { reject(new Error('RCON のパスワードが違う')); sock.destroy(); return; }
        if (id > 2) out.push(body);
        next();
      }
    });
    sock.on('error', reject);
    setTimeout(() => { sock.destroy(); reject(new Error('RCON が応答しない')); }, 15_000).unref();
  });
}

const dir = process.env.SOCIETY_SERVER_DIR || path.join(os.homedir(), 'Documents', 'ClaudeCode', 'society-server');
const [addr, password] = fs.readFileSync(path.join(dir, 'rcon.txt'), 'utf8').trim().split(/\r?\n/);
const [host, port] = addr.split(':');
const args = process.argv.slice(2);
const commands = args[0] === 'setup' ? SETUP : args;
if (!commands.length) { console.error('コマンドを指定してください（setup か "list" など）'); process.exit(1); }
const res = await rcon(host, Number(port), password, commands);
commands.forEach((c, i) => console.log(`> ${c}\n${res[i] ?? ''}`));
