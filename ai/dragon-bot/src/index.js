// エントリポイント: ボットを作って接続し、エージェントを動かす。切断されたら再接続する。
import mineflayer from 'mineflayer';
import { loadConfig } from './config.js';
import { loadPlugins, configureBody } from './body/plugins.js';
import { Memory } from './world/memory.js';
import { Planner } from './brain/planner.js';
import { ChatResponder } from './brain/chat.js';
import { Agent } from './agent.js';
import { startStatusServer } from './status.js';
import { log, startLogFile } from './log.js';
import { startDiscordLog } from './discord.js';

const cfg = loadConfig();
startLogFile(cfg.logDir);
if (startDiscordLog({ botToken: process.env.DISCORD_BOT_TOKEN, channelId: process.env.DISCORD_CHANNEL_ID })) log.info('AI の思考ログを Discord へ送る');
const memory = new Memory(cfg.dataDir);
const planner = new Planner(cfg);
const chat = new ChatResponder(cfg, planner.client);
let agent = null;
let stopping = false;

startStatusServer(cfg.statusPort, () => agent);
log.info(`方針判断: ${planner.usingLLM ? `Claude (${cfg.llm.model})` : 'ルールベース（ANTHROPIC_API_KEY 未設定）'}`);
log.info(`チャット: ${chat.usingLLM ? 'Claude で自由に会話' : '決まった話しかけに返す（自由な会話には ANTHROPIC_API_KEY が必要）'}`);

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
    agent = new Agent({ bot, cfg, memory, planner, chat });
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
