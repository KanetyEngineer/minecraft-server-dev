// エントリポイント: ボットを作って接続し、建築エージェントを動かす。切断されたら再接続する。
import mineflayer from 'mineflayer';
import { loadConfig } from './config.js';
import { loadPlugins, configureBody } from './body/plugins.js';
import { Agent } from './agent.js';
import { startStatusServer } from './status.js';
import { log, startLogFile } from './log.js';

const cfg = loadConfig();
startLogFile(cfg.logDir);
let agent = null;
let stopping = false;

startStatusServer(cfg.statusPort, () => agent);

function connect() {
  log.info(`${cfg.host}:${cfg.port} に ${cfg.username} として接続します（${cfg.version || '自動判別'}）`);
  const bot = mineflayer.createBot({
    host: cfg.host,
    port: cfg.port,
    username: cfg.username,
    auth: cfg.auth,
    version: cfg.version || false,
    hideErrors: false,
  });
  loadPlugins(bot);

  bot.once('spawn', async () => {
    configureBody(bot);
    log.info(`スポーンしました (${bot.entity.position.floored()})`);
    agent = new Agent({ bot, cfg });
    bot.on('chat', (username, message) => agent?.onChat(username, message));
    bot.on('death', () => log.warn('死んでしまった。リスポーンして続ける'));
    await bot.waitForChunksToLoad().catch(() => {});
    agent.run().catch((e) => log.error(e.stack ?? e.message));
  });
  bot.on('kicked', (reason) => log.warn(`キックされた: ${typeof reason === 'string' ? reason : JSON.stringify(reason)}`));
  bot.on('error', (e) => log.error(e.message));
  bot.on('end', (reason) => {
    log.warn(`切断: ${reason}`);
    agent?.stop();
    agent = null;
    if (!stopping) setTimeout(connect, 10_000);
  });
  return bot;
}

let bot = connect();
process.on('SIGINT', () => {
  stopping = true;
  log.info('終了します');
  agent?.stop();
  bot?.quit();
  setTimeout(() => process.exit(0), 500);
});
