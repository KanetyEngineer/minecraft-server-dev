// Minimal Minecraft RCON client (Source RCON protocol), reconnects on demand.
import net from 'node:net';

const AUTH = 3;
const COMMAND = 2;

export class Rcon {
  constructor({ host = '127.0.0.1', port = 25575, password = '' }) {
    this.host = host;
    this.port = port;
    this.password = password;
    this.socket = null;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = Buffer.alloc(0);
    this.connecting = null;
  }

  get connected() {
    return this.socket !== null && !this.connecting;
  }

  connect() {
    if (this.socket && !this.connecting) return Promise.resolve();
    if (this.connecting) return this.connecting;
    this.connecting = new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.host, port: this.port });
      socket.setTimeout(10000);
      socket.once('connect', async () => {
        socket.setTimeout(0);
        this.socket = socket;
        try {
          const id = await this.#send(AUTH, this.password, true);
          if (id === -1) throw new Error('RCON のパスワードが違います');
          this.connecting = null;
          resolve();
        } catch (err) {
          this.close();
          this.connecting = null;
          reject(err);
        }
      });
      socket.on('data', (chunk) => this.#onData(chunk));
      socket.on('timeout', () => socket.destroy(new Error('RCON 接続がタイムアウトしました')));
      socket.on('error', (err) => {
        if (this.connecting) {
          this.connecting = null;
          reject(err);
        }
        this.close(err);
      });
      socket.on('close', () => this.close());
    });
    return this.connecting;
  }

  close(err = new Error('RCON 接続が切れました')) {
    if (this.socket) this.socket.destroy();
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    for (const { reject } of this.pending.values()) reject(err);
    this.pending.clear();
  }

  async command(cmd) {
    await this.connect();
    return this.#send(COMMAND, cmd);
  }

  #send(type, body, auth = false) {
    const id = this.nextId++;
    const payload = Buffer.from(body, 'utf8');
    const packet = Buffer.alloc(14 + payload.length);
    packet.writeInt32LE(10 + payload.length, 0);
    packet.writeInt32LE(id, 4);
    packet.writeInt32LE(type, 8);
    payload.copy(packet, 12);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('RCON の応答がありません'));
      }, 10000);
      this.pending.set(id, {
        auth,
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.socket.write(packet);
    });
  }

  #onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const len = this.buffer.readInt32LE(0);
      if (this.buffer.length < len + 4) return;
      const id = this.buffer.readInt32LE(4);
      const body = this.buffer.toString('utf8', 12, len + 2);
      this.buffer = this.buffer.subarray(len + 4);
      if (id === -1) {
        // failed auth: answer the oldest pending auth request
        for (const [pid, p] of this.pending) {
          if (p.auth) { this.pending.delete(pid); p.resolve(-1); break; }
        }
        continue;
      }
      const p = this.pending.get(id);
      if (!p) continue;
      this.pending.delete(id);
      p.resolve(p.auth ? id : body);
    }
  }
}
