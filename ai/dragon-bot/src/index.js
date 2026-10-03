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
import { Team, ROLES, strategyFor } from './team.js';
import { setTeamContext } from './brain/progress.js';

const cfg = loadConfig();
// MBTI 社会実験と同じ使い方にする: 同じ .env の ANTHROPIC_API_KEY で、速くて安い Sonnet を low で使い、
// 順調なときは進捗表どおりに動いて、困ったときだけ相談する（毎回 Opus に聞くと 1 回ごとに長く立ち止まっていた）。
// 変えたいときは .env に CLAUDE_MODEL_DRAGON / CLAUDE_EFFORT_DRAGON / LLM_MODE を書く
cfg.llm.model = process.env.CLAUDE_MODEL_DRAGON || 'claude-sonnet-5-5';
cfg.llm.effort = process.env.CLAUDE_EFFORT_DRAGON || 'low';
cfg.llm.mode = process.env.LLM_MODE || 'assist';
// 待ち時間切れ（CPU が混んで「2 ティック待ったが来ない」など）の取りこぼしたエラーで、ボットごと落ちないようにする。
// 記録だけして動き続ける（100 体の試験で、CPU 100% のときに 2 体がこれで落ちた）
process.on('unhandledRejection', (e) => { try { log.warn(`処理されなかったエラー（続行）: ${e?.message ?? e}`); } catch {} });
process.on('uncaughtException', (e) => { try { log.warn(`想定外のエラー（続行）: ${e?.message ?? e}`); } catch {} });
startLogFile(cfg.logDir);
if (startDiscordLog({ botToken: process.env.DISCORD_BOT_TOKEN, channelId: process.env.DISCORD_CHANNEL_ID, prefix: process.env.MC_USERNAME || 'DragonBot' })) log.info('AI の思考ログを Discord へ送る');
const memory = new Memory(cfg.dataDir);
const planner = new Planner(cfg);
// チーム（TEAM_DIR のフォルダで仲間と状態を共有する）。役割は ROLE（leader / food / iron）
// ROLE=solo のときは独立して動く（チームの情報を共有せず、1 体でエンドラ討伐を目指す）
const team = cfg.role === 'solo' ? null : new Team({ dir: cfg.teamDir, name: cfg.username, role: cfg.role });
// 番号ごとの進め方（定石 / 防具優先 / 探索優先 / ダイヤ掘り）。何体いても同じ動きにならないようにする
const strategy = strategyFor(cfg.username);
setTeamContext({ role: cfg.role === 'solo' ? 'leader' : cfg.role, team, strategy });
log.info(`役割: ${cfg.role}（${cfg.role === 'solo' ? '独立して動く' : ROLES[cfg.role] ?? '不明'}）、進め方: ${strategy.name}（${strategy.description}）`);
const chat = new ChatResponder(cfg, planner.client);
let agent = null;
let stopping = false;

startStatusServer(cfg.statusPort, () => agent);
log.info(`方針判断: ${planner.usingLLM ? `Claude (${cfg.llm.model}, effort ${cfg.llm.effort}, ${cfg.llm.mode === 'assist' ? '困ったときだけ相談' : '毎回相談'})` : 'ルールベース（ANTHROPIC_API_KEY 未設定）'}`);
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
    const a = new Agent({ bot, cfg, memory, planner, chat, team });
    agent = a;
    await bot.waitForChunksToLoad().catch(() => {});
    // メインループが止まったのに接続だけ残ると、ボットはその場に立ったままになる。止まったら入り直す
    a.run().catch((e) => log.error(e.stack ?? e.message)).finally(() => {
      if (stopping || agent !== a || !a.running) return;
      log.warn('メインループが止まったので、いったん入り直す');
      a.running = false;
      try { bot.quit('メインループが止まった'); } catch {}
    });
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
