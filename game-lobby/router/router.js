// ロビーの入口（25576）で、接続先のホスト名を見て振り分ける小さな中継。
// playit の無料トンネルは 4 本までなので、アニメ技の鯖はロビーのトンネルを共用する。
// ロビーはアニメ技へ送るとき、ホスト名の末尾に "." を付けて転送する（DNS 上は同じ名前）。
// 末尾が "." の接続 → アニメ技（25590）、それ以外 → ロビー本体（25579）。
// 中身は素通しなので、online-mode の認証や暗号化はそのまま行き先の鯖とクライアントの間で行われる。
const net = require('net');

const LISTEN = 25576;
const routes = {
  default: { host: '127.0.0.1', port: 25579 },   // ロビー本体（Paper）
  trailingDot: { host: '127.0.0.1', port: 25590 } // アニメ技 埋め立て
};

function readVarInt(buf, off) {
  let v = 0, shift = 0;
  for (let i = 0; i < 5; i++) {
    if (off + i >= buf.length) return null;
    const b = buf[off + i];
    v |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) return { value: v, size: i + 1 };
    shift += 7;
  }
  throw new Error('varint too long');
}

/** Returns the server address from a complete handshake packet, '' for a legacy ping, or null if more bytes are needed. */
function handshakeHost(buf) {
  if (buf.length > 0 && buf[0] === 0xfe) return '';
  const len = readVarInt(buf, 0);
  if (!len) return null;
  if (buf.length < len.size + len.value) return null;
  let off = len.size;
  const id = readVarInt(buf, off); off += id.size;
  if (id.value !== 0) throw new Error('not a handshake');
  const proto = readVarInt(buf, off); off += proto.size;
  const sl = readVarInt(buf, off); off += sl.size;
  return buf.slice(off, off + sl.value).toString('utf8').split('\0')[0];
}

const server = net.createServer(client => {
  let buf = Buffer.alloc(0);
  client.setNoDelay(true);
  const onData = chunk => {
    buf = Buffer.concat([buf, chunk]);
    let host;
    try {
      host = handshakeHost(buf);
    } catch (e) {
      client.destroy();
      return;
    }
    if (host === null) {
      if (buf.length > 4096) client.destroy();
      return;
    }
    client.removeListener('data', onData);
    client.setTimeout(0);
    client.pause();
    const route = host.endsWith('.') ? routes.trailingDot : routes.default;
    const backend = net.connect(route.port, route.host, () => {
      backend.setNoDelay(true);
      backend.write(buf);
      client.pipe(backend);
      backend.pipe(client);
      client.resume();
    });
    if (route !== routes.default) console.log(new Date().toISOString(), 'route', JSON.stringify(host), '->', route.port);
    const close = () => { client.destroy(); backend.destroy(); };
    backend.on('error', close);
    client.on('error', close);
    backend.on('close', close);
    client.on('close', close);
  };
  client.on('data', onData);
  client.setTimeout(15000, () => client.destroy()); // handshake never arrived
});

server.listen(LISTEN, () => console.log('lobby router listening on', LISTEN));
