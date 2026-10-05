// the panels' RCON connection test (same for every game)
import { Rcon } from './rcon.js';
import { json } from './util.js';

export async function rconTest(res, b, defPort) {
  const r = new Rcon({ host: String(b.host || '127.0.0.1'), port: Number(b.port) || defPort, password: String(b.password || '') });
  try {
    const out = await r.command('list');
    return json(res, { ok: true, message: `接続できました: ${out}` });
  } catch (err) {
    return json(res, { ok: false, message: `接続できません: ${err.message}（サーバーが起動しているか、RCON が有効か、パスワードが合っているか確認）` });
  } finally {
    r.close();
  }
}
