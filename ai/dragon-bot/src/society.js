// 社会実験モードのエントリポイント: MBTI の性格を持つ住人 1 人を動かす。
// 体（移動・採掘・反射・フリーズ対策）は DragonBot と同じ Agent を使い、頭（方針判断・会話）だけ社会生活用に差し替える。
// 使い方: PERSONA=1〜10 を指定して node --env-file=.env src/society.js（scripts/start-society.sh が 10 人まとめて起動する）
import mineflayer from 'mineflayer';
import Anthropic from '@anthropic-ai/sdk';
import { loadConfig } from './config.js';
import { loadPlugins, configureBody } from './body/plugins.js';
import { Memory } from './world/memory.js';
import { Agent } from './agent.js';
import { startStatusServer } from './status.js';
import { log, startLogFile } from './log.js';
import { setTeamContext } from './brain/progress.js';
import { STRATEGIES } from './team.js';
import { sleep } from './body/humanize.js';
import { personaById, personaByName } from './society/personas.js';
import { Town, Relations } from './society/town.js';
import { Society } from './society/core.js';
import { SocietyPlanner } from './society/planner.js';
import { SOCIETY_SKILL_MAP } from './society/skillset.js';

const persona = personaById(process.env.PERSONA) ?? personaByName(process.env.MC_USERNAME);
if (!persona) {
  console.error('PERSONA（1〜10）か MC_USERNAME（Rin_INTJ など）を指定してください');
  process.exit(1);
}
process.env.MC_USERNAME = persona.name;
const cfg = loadConfig();
cfg.username = persona.name;
cfg.role = 'society';
cfg.port = Number(process.env.MC_PORT || 25573);
// 社会モードは会話も行動も「ほどほどの深さ」で十分。重いと立ち止まる時間が長くなる
cfg.llm.effort = process.env.CLAUDE_EFFORT_SOCIETY || 'low';

process.on('unhandledRejection', (e) => { try { log.warn(`処理されなかったエラー（続行）: ${e?.message ?? e}`); } catch {} });
process.on('uncaughtException', (e) => { try { log.warn(`想定外のエラー（続行）: ${e?.message ?? e}`); } catch {} });
startLogFile(cfg.logDir);
setTeamContext({ role: 'leader', team: null, strategy: STRATEGIES[0] });

const memory = new Memory(cfg.dataDir);
const town = new Town({ dir: process.env.SOCIETY_DIR || 'society/town', name: persona.name, persona });
const rel = new Relations(memory, persona);
const hasKey = !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
const client = cfg.llm.enabled && hasKey ? new Anthropic({ timeout: cfg.llm.timeoutMs ?? 45_000, maxRetries: 1 }) : null;
const society = new Society({ persona, town, rel, cfg, client });
const planner = new SocietyPlanner(cfg, society, { client });

// Agent の chat（ChatResponder と同じ形）: 聞いたチャットを社会の頭に渡す
const chat = {
  usingLLM: society.usingLLM,
  reply: (bot, username, message) => society.onChat(bot, username, message),
};

log.info(`住人 ${persona.call}（${persona.name}、${persona.mbti}・${persona.title}）として動く。仕事: ${town.profile.job}`);
log.info(`方針判断: ${planner.usingLLM ? `Claude (${cfg.llm.model}, effort ${cfg.llm.effort}) ＋ 性格の候補` : '性格と欲求のルール（ANTHROPIC_API_KEY 未設定）'}`);
let agent = null;
let stopping = false;
startStatusServer(cfg.statusPort, () => agent);

// 町の建物は経路探索で壊さない（ほかの住人の家の壁を掘って通り抜けないように）
const PROTECTED = /(_planks|_door|_bed|_stairs|_slab|_fence|glass|glass_pane|torch|chest|crafting_table|furnace|farmland|wheat|cobblestone)$/;

function connect() {
  log.info(`${cfg.host}:${cfg.port} に ${cfg.username} として接続します（${cfg.version}）`);
  const bot = mineflayer.createBot({ host: cfg.host, port: cfg.port, username: cfg.username, auth: cfg.auth, version: cfg.version || false, hideErrors: false });
  loadPlugins(bot);
  bot.once('spawn', async () => {
    configureBody(bot);
    const mv = bot.pathfinder.movements;
    for (const [name, b] of Object.entries(bot.registry.blocksByName)) if (PROTECTED.test(name)) mv.blocksCantBreak.add(b.id);
    // 家の扉を開けて出入りする
    mv.canOpenDoors = true;
    log.info(`スポーンしました (${bot.entity.position.floored()})`);
    society.bot = bot;
    society.publish(bot);
    const a = new Agent({ bot, cfg, memory, planner, chat, team: society, skills: SOCIETY_SKILL_MAP, extraCtx: { society } });
    society.currentSkill = () => a.current?.name ?? null;
    agent = a;
    await bot.waitForChunksToLoad().catch(() => {});
    // 入ってきたら一言（性格で言い方が変わる）
    if (!memory.flag('introduced')) {
      await sleep(2000 + persona.id * 700);
      a.say(society.persona.style.polite ? `${persona.call}です。よろしくお願いします。` : `${persona.call}だよ、よろしく${persona.style.end}`);
      memory.setFlag('introduced', Date.now());
      town.event('join', `${persona.call}（${persona.mbti}）が町にやってきた`);
    }
    a.run().catch((e) => log.error(e.stack ?? e.message)).finally(() => {
      if (stopping || agent !== a || !a.running) return;
      log.warn('メインループが止まったので、いったん入り直す');
      a.running = false;
      try { bot.quit('メインループが止まった'); } catch {}
    });
  });
  bot.on('kicked', (reason) => log.warn(`キックされた: ${typeof reason === 'string' ? reason : JSON.stringify(reason)}`));
  bot.on('error', (e) => log.error(e.message));
  bot.on('death', () => { town.event('death', `${persona.call}が死んでしまった`); rel.diary('死んでしまった。'); });
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
  agent?.stop();
  bot?.quit();
  setTimeout(() => process.exit(0), 500);
});
