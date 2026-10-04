// 社会実験鯖への RCON（鯖のコンソールにコマンドを送る）。scripts/society-rcon.mjs と人口の管理役が使う
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const serverDir = () => process.env.SOCIETY_SERVER_DIR || path.join(os.homedir(), 'Documents', 'ClaudeCode', 'society-server');

export function rcon(host, port, password, commands) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, host);
    const out = [];
    let id = 1;
    let buf = Buffer.alloc(0);
    const queue = [...commands];
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

// rcon.txt（鯖を用意したときに作られる。SOCIETY_RCON_FILE で別のファイルにできる）を読んでコマンドを送る
export async function rconSend(commands) {
  const [addr, password] = fs.readFileSync(path.join(serverDir(), process.env.SOCIETY_RCON_FILE || 'rcon.txt'), 'utf8').trim().split(/\r?\n/);
  const [host, port] = addr.split(':');
  return rcon(host, Number(port), password, commands);
}
