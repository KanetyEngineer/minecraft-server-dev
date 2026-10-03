// 試験鯖に RCON でコマンドを送る（server.properties で enable-rcon=true にしたときだけ使える）。
// 使い方: node scripts/rcon.js "time set day" "give BuilderBot oak_log 16"
// 接続先は RCON_HOST / RCON_PORT / RCON_PASSWORD（既定 127.0.0.1:25582）
import net from 'node:net';

const host = process.env.RCON_HOST || '127.0.0.1';
const port = Number(process.env.RCON_PORT || 25582);
const password = process.env.RCON_PASSWORD || '';

function packet(id, type, body) {
  const b = Buffer.from(body, 'utf8');
  const buf = Buffer.alloc(14 + b.length);
  buf.writeInt32LE(10 + b.length, 0);
  buf.writeInt32LE(id, 4);
  buf.writeInt32LE(type, 8);
  b.copy(buf, 12);
  return buf;
}

export async function rcon(commands) {
  const sock = net.connect(port, host);
  let data = Buffer.alloc(0);
  const waiters = [];
  sock.on('data', (d) => {
    data = Buffer.concat([data, d]);
    while (data.length >= 4 && data.length >= data.readInt32LE(0) + 4) {
      const len = data.readInt32LE(0);
      const id = data.readInt32LE(4);
      const body = data.subarray(12, 4 + len - 2).toString('utf8');
      data = data.subarray(4 + len);
      waiters.shift()?.({ id, body });
    }
  });
  const send = (id, type, body) => new Promise((res) => { waiters.push(res); sock.write(packet(id, type, body)); });
  await new Promise((res, rej) => { sock.once('connect', res); sock.once('error', rej); });
  const auth = await send(1, 3, password);
  if (auth.id === -1) throw new Error('RCON のパスワードが違う');
  const out = [];
  for (const [i, c] of commands.entries()) out.push((await send(i + 2, 2, c)).body);
  sock.end();
  return out;
}

if (process.argv[1]?.endsWith('rcon.js')) {
  rcon(process.argv.slice(2)).then((out) => out.forEach((o) => console.log(o)), (e) => { console.error(e.message); process.exit(1); });
}
