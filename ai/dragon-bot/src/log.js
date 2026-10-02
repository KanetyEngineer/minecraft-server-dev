// ログはコンソールに出すのに加えて、logs/bot.log に追記し、直近分をメモリに保持する。
// 直近分は状態ページ（http://localhost:3007/）の下部と /log.txt で見られる。
import fs from 'node:fs';
import path from 'node:path';
import { queueDiscord } from './discord.js';

const t = () => new Date().toISOString().slice(11, 19);
const RECENT_MAX = 400;
const recent = [];
let stream = null;

export function startLogFile(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    stream = fs.createWriteStream(path.join(dir, 'bot.log'), { flags: 'a' });
    stream.on('error', () => { stream = null; });
  } catch {
    stream = null;
  }
}

export function recentLog(n = RECENT_MAX) {
  return recent.slice(-n);
}

const fmt = (a) => a.map((x) => (x instanceof Error ? (x.stack ?? x.message) : typeof x === 'string' ? x : JSON.stringify(x))).join(' ');

function emit(method, prefix, a, toDiscord = false) {
  const line = `[${t()}] ${prefix}${fmt(a)}`;
  console[method](line);
  recent.push(line);
  if (recent.length > RECENT_MAX) recent.splice(0, recent.length - RECENT_MAX);
  stream?.write(`${new Date().toISOString().slice(0, 10)} ${line}\n`);
}

export const log = {
  info: (...a) => emit('log', '', a),
  warn: (...a) => emit('warn', '警告: ', a, true),
  error: (...a) => emit('error', 'エラー: ', a, true),
  brain: (...a) => emit('log', '🧠 ', a, true),
  skill: (...a) => emit('log', '🛠 ', a, true),
};
