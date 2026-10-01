// 頭（方針判断）と体（スキル実行）をつなぐループ。
// 1. 状況をまとめる → 2. 次のスキルを決める（Claude or ルール）→ 3. スキルを実行 → 繰り返し
// 実行中も「反射」（危ないときの防御・逃走）を監視し、必要なら割り込む。
import { snapshot, isHostile } from './world/perception.js';
import { SKILL_MAP } from './skills/index.js';
import { attackEntity, goals, pillarUp, pillarDown, fightFromAbove } from './skills/common.js';
import { sleep, jitter } from './body/humanize.js';
import { dimensionOf } from './brain/progress.js';
import { log } from './log.js';

const ZOMBIES = new Set(['zombie', 'husk', 'drowned', 'zombie_villager']);
const COMBAT_SKILLS = new Set(['fightDragon', 'destroyEndCrystals', 'huntBlazes', 'huntEndermen', 'attack', 'gatherFood']);

export class Agent {
  constructor({ bot, cfg, memory, planner, chat }) {
    Object.assign(this, { bot, cfg, memory, planner, chat });
    this.history = [];
    this.chatLog = [];
    this.current = null; // { name, controller, startedAt }
    this.lastHurtAt = 0;
    this.running = false;
    this.state = {}; // スキルをまたいで覚えておく小さな状態（探索の向きなど）
    this.lastDecision = null;
  }

  say(text) {
    if (!text) return;
    log.info(`💬 ${text}`);
    this.bot.chat(String(text).slice(0, 250));
  }

  attachEvents() {
    const { bot } = this;
    bot.on('entityHurt', (e) => { if (e === bot.entity) this.lastHurtAt = Date.now(); });
    bot.on('death', () => {
      const p = bot.entity.position;
      this.memory.data.deaths.push({ x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z),
        dimension: dimensionOf(bot), at: new Date().toISOString(), during: this.current?.name ?? null });
      this.memory.save();
      log.warn('死んでしまった。リスポーンして立て直す');
      this.interrupt('死亡');
    });
    bot.on('chat', async (username, message) => {
      if (username === bot.username) return;
      this.chatLog.push({ username, message, at: Date.now() });
      this.chatLog = this.chatLog.slice(-10);
      const ctx = `${dimensionOf(bot)}にいる。いまの作業: ${this.current?.name ?? '考え中'}`;
      const r = await this.chat.reply(bot, username, message, ctx);
      if (r) this.say(r);
    });
  }

  interrupt(reason) {
    if (!this.current) return;
    log.warn(`中断: ${this.current.name}（${reason}）`);
    this.current.controller.abort(reason);
    this.stopBody();
  }

  stopBody() {
    const { bot } = this;
    try { bot.pathfinder.stop(); } catch {}
    try { bot.pvp.stop(); } catch {}
    try { bot.collectBlock.cancelTask?.(); } catch {}
    try { bot.hawkEye.stop(); } catch {}
    bot.clearControlStates();
  }

  // ---------- 反射 ----------
  async reflexTick() {
    const { bot } = this;
    if (!bot.entity || this.reflexBusy) return;
    const pos = bot.entity.position;
    const threat = bot.nearestEntity((e) => isHostile(e) && e.name !== 'ender_dragon' && e.position.distanceTo(pos) < 5);
    const creeper = bot.nearestEntity((e) => e.name === 'creeper' && e.position.distanceTo(pos) < 4);
    const recentlyHurt = Date.now() - this.lastHurtAt < 2500;
    const inCombat = this.current && COMBAT_SKILLS.has(this.current.name);

    let action = null;
    if (creeper && !inCombat) action = { kind: 'flee', from: creeper };
    else if (threat && recentlyHurt && bot.health <= 6) action = { kind: 'flee', from: threat };
    else if (threat && recentlyHurt && ZOMBIES.has(threat.name) && !bot.entity.isInWater && dimensionOf(bot) !== 'the_end') action = { kind: 'pillar', target: threat };
    else if (threat && recentlyHurt && !inCombat) action = { kind: 'fight', target: threat };
    if (!action) return;

    this.reflexBusy = true;
    try {
      this.interrupt(action.kind === 'flee' ? `${action.from.name} から逃げる` : `${action.target.name} に攻撃された`);
      const ctx = this.makeCtx(new AbortController());
      if (action.kind === 'pillar') {
        // ゾンビ系: 2 ブロック積んで上から倒し、終わったら降りる
        const placed = await pillarUp(ctx, 2).catch(() => 0);
        if (placed >= 2) {
          await fightFromAbove(ctx, [...ZOMBIES], { timeoutMs: 40000 });
          await pillarDown(ctx, placed);
        } else {
          await attackEntity(ctx, action.target, { timeoutMs: 15000 }).catch(() => {});
        }
      } else if (action.kind === 'fight') {
        await attackEntity(ctx, action.target, { timeoutMs: 15000 }).catch(() => {});
      } else {
        const p = bot.entity.position; const f = action.from.position;
        const d = Math.hypot(p.x - f.x, p.z - f.z) || 1;
        bot.setControlState('sprint', true);
        await bot.pathfinder.goto(new goals.GoalNearXZ(p.x + ((p.x - f.x) / d) * 14, p.z + ((p.z - f.z) / d) * 14, 3)).catch(() => {});
        bot.setControlState('sprint', false);
      }
      this.history.push({ skill: `反射:${action.kind}`, args: {}, ok: true, result: action.kind !== 'flee' ? `${action.target.name} と戦った` : '逃げた' });
    } finally {
      this.reflexBusy = false;
    }
  }

  makeCtx(controller) {
    return { bot: this.bot, cfg: this.cfg, memory: this.memory, log, signal: controller.signal, state: this.state, say: (t) => this.say(t) };
  }

  // ---------- メインループ ----------
  async run() {
    this.running = true;
    this.attachEvents();
    const reflexTimer = setInterval(() => this.reflexTick().catch((e) => log.warn(e.message)), 500);
    try {
      while (this.running) {
        if (this.reflexBusy || !this.bot.entity || this.bot.health <= 0) { await sleep(500); continue; }
        if (this.memory.flag('dragonDefeated') && this.memory.flag('celebrated')) {
          log.info('🎉 エンダードラゴン討伐済み。待機します');
          await sleep(60_000);
          continue;
        }
        const snap = snapshot(this.bot, this.memory, this.cfg);
        const decision = await this.planner.decide({
          bot: this.bot, memory: this.memory, snapshot: snap, history: this.history.slice(-12), chatLog: this.chatLog.slice(-5),
        });
        this.lastDecision = { ...decision, at: new Date().toISOString() };
        log.brain(`[${decision.source}] ${decision.skill}(${JSON.stringify(decision.args)}) ${decision.thought ?? ''}`);
        await this.runSkill(decision.skill, decision.args);
        if (decision.skill === 'celebrate') this.memory.setFlag('celebrated');
        await sleep(jitter(this.cfg.human.thinkDelayMs));
      }
    } finally {
      clearInterval(reflexTimer);
    }
  }

  async runSkill(name, args) {
    const skill = SKILL_MAP[name];
    if (!skill) {
      this.history.push({ skill: name, args, ok: false, result: '存在しないスキル' });
      return;
    }
    const controller = new AbortController();
    const limitSec = name === 'fightDragon' ? (args.minutes ?? 15) * 60 + 30 : this.cfg.skillTimeoutSec;
    const timer = setTimeout(() => { controller.abort('時間切れ'); this.stopBody(); }, limitSec * 1000);
    this.current = { name, controller, startedAt: Date.now() };
    log.skill(`開始 ${name} ${JSON.stringify(args)}`);
    let entry;
    try {
      const result = await skill.run(this.makeCtx(controller), args);
      entry = { skill: name, args, ok: true, result: String(result ?? '完了') };
    } catch (e) {
      const reason = controller.signal.aborted ? `中断（${controller.signal.reason}）` : e.message;
      entry = { skill: name, args, ok: false, result: reason };
    } finally {
      clearTimeout(timer);
      this.current = null;
    }
    log.skill(`${entry.ok ? '成功' : '失敗'} ${name}: ${entry.result}`);
    this.history.push(entry);
    this.history = this.history.slice(-30);
  }

  stop() {
    this.running = false;
    this.interrupt('停止');
  }
}
