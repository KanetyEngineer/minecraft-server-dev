// 頭（方針判断）と体（スキル実行）をつなぐループ。
// 1. 状況をまとめる → 2. 次のスキルを決める（Claude or ルール）→ 3. スキルを実行 → 繰り返し
// 実行中も「反射」（危ないときの防御・逃走）を監視し、必要なら割り込む。
import { snapshot, isHostile } from './world/perception.js';
import { SKILL_MAP } from './skills/index.js';
import { attackEntity, goals, pillarUp, pillarDown, fightFromAbove, placeWallToward } from './skills/common.js';
import { sleep, jitter } from './body/humanize.js';
import { dimensionOf } from './brain/progress.js';
import { log } from './log.js';
import { LoopGuard, inventoryKey } from './brain/loopguard.js';

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
    this.loopGuard = new LoopGuard();
    this.thoughts = []; // AI の思考ログ（状態ページ用）
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
    // 穴にこもってふたをしている間は、外の敵に反応して飛び出さない
    if (this.current?.name === 'shelterForNight' && this.state.sheltered) return;
    const pos = bot.entity.position;
    const threat = bot.nearestEntity((e) => isHostile(e) && e.name !== 'ender_dragon' && e.position.distanceTo(pos) < 5);
    // クリーパーには近づかない（6 マス以内なら離れる）
    const creeper = bot.nearestEntity((e) => e.name === 'creeper' && e.position.distanceTo(pos) < 6);
    // 遠くから撃ってくるスケルトン
    const archer = bot.nearestEntity((e) => ['skeleton', 'stray', 'bogged'].includes(e.name) && e.position.distanceTo(pos) < 24);
    const recentlyHurt = Date.now() - this.lastHurtAt < 2500;
    const inCombat = this.current && COMBAT_SKILLS.has(this.current.name);

    let action = null;
    if (creeper) action = { kind: 'creeper', from: creeper };
    else if (archer && recentlyHurt && archer.position.distanceTo(pos) > 4 && !inCombat) action = { kind: 'shield', from: archer };
    else if (threat && recentlyHurt && bot.health <= 6) action = { kind: 'flee', from: threat };
    else if (threat && recentlyHurt && ZOMBIES.has(threat.name) && dimensionOf(bot) !== 'the_end') action = { kind: 'pillar', target: threat };
    else if (threat && recentlyHurt && !inCombat) action = { kind: 'fight', target: threat };
    if (!action) return;

    this.reflexBusy = true;
    try {
      this.interrupt(action.from ? `${action.from.name} を避ける` : `${action.target.name} に攻撃された`);
      const ctx = this.makeCtx(new AbortController());
      const runAway = async (from, dist = 14) => {
        const p = bot.entity.position; const f = from.position;
        const d = Math.hypot(p.x - f.x, p.z - f.z) || 1;
        bot.setControlState('sprint', true);
        await bot.pathfinder.goto(new goals.GoalNearXZ(p.x + ((p.x - f.x) / d) * dist, p.z + ((p.z - f.z) / d) * dist, 2)).catch(() => {});
        bot.setControlState('sprint', false);
      };
      if (action.kind === 'creeper') {
        // 爆発しそうなほど近ければ、間にブロックを置いて爆風を和らげてから離れる
        if (action.from.position.distanceTo(bot.entity.position) < 3.5) {
          const n = await placeWallToward(ctx, action.from, 2).catch(() => 0);
          log.info(`クリーパーとの間にブロックを ${n} 個置いた`);
        }
        await runAway(action.from, 12);
      } else if (action.kind === 'shield') {
        // スケルトン: 矢の飛んでくる方向に壁を置いて盾にし、少し待ってから作業に戻る
        const n = await placeWallToward(ctx, action.from, 2).catch(() => 0);
        log.info(`スケルトンの方向に壁を ${n} 個置いた`);
        if (n === 0) await runAway(action.from, 16);
        else await sleep(3000);
      } else if (action.kind === 'pillar') {
        // 水中（ドラウンドなど）では柱を積めないので、まず陸に上がる
        if (bot.entity.isInWater) {
          const land = this.findLandAwayFrom(action.target.position);
          if (land) {
            bot.setControlState('sprint', true);
            await bot.pathfinder.goto(new goals.GoalBlock(land.x, land.y, land.z)).catch(() => {});
            bot.setControlState('sprint', false);
          }
          if (bot.entity.isInWater) {
            // 陸が見つからなければ、その場で応戦する
            await attackEntity(ctx, action.target, { timeoutMs: 15000 }).catch(() => {});
            return;
          }
        }
        // 追いつかれた状態で積むと殴られるので、まず走って距離を取る
        if (action.target.position.distanceTo(bot.entity.position) < 5) await runAway(action.target, 8);
        if (action.target.isValid && action.target.position.distanceTo(bot.entity.position) < 3) {
          await attackEntity(ctx, action.target, { timeoutMs: 15000 }).catch(() => {});
          return;
        }
        // ゾンビ系: 3 ブロック積んで上から倒し、終わったら降りる
        // 1.21.11 のゾンビは槍を持つことがありリーチが長いので 3 段積む
        const placed = await pillarUp(ctx, 3).catch(() => 0);
        log.info(`柱を ${placed} 段積んだ`);
        if (placed >= 2) {
          await fightFromAbove(ctx, [...ZOMBIES], { timeoutMs: 40000 });
          await pillarDown(ctx, placed);
        } else {
          await attackEntity(ctx, action.target, { timeoutMs: 15000 }).catch(() => {});
        }
      } else if (action.kind === 'fight') {
        await attackEntity(ctx, action.target, { timeoutMs: 15000 }).catch(() => {});
      } else {
        await runAway(action.from, 14);
      }
      this.history.push({ skill: `反射:${action.kind}`, args: {}, ok: true, result: action.target ? `${action.target.name} と戦った` : `${action.from.name} を避けた` });
    } finally {
      this.reflexBusy = false;
    }
  }

  // フリーズ対策: 作業中なのに 20 秒動かず、掘る・食べる・精錬・睡眠もしていなければ作業を切り上げる
  watchdogTick() {
    const { bot } = this;
    if (!bot.entity || !this.current || this.reflexBusy) { this.still = null; return; }
    const busy = bot.targetDigBlock || bot.autoEat?.isEating || bot.isSleeping || bot.currentWindow
      || ['wait', 'sleepInBed', 'fightDragon', 'shelterForNight'].includes(this.current.name);
    const p = bot.entity.position;
    if (busy || !this.still || this.still.pos.distanceTo(p) > 1.5) {
      this.still = { pos: p.clone(), since: Date.now() };
      return;
    }
    // 死亡地点への長い移動は経路計算に時間がかかることがあるので長めに待つ
    const limit = this.current.name === 'recoverItems' ? 45_000 : 20_000;
    if (Date.now() - this.still.since > limit) {
      this.still = null;
      this.interrupt(`${limit / 1000} 秒動けなかった（フリーズ回避）`);
      // 木の上などに取り残されたら、体力が残る範囲で落下ダメージを受け入れて飛び降りる
      const below = bot.blockAt(p.offset(0, -1, 0));
      if (below && /(_leaves|_log|_wood)$/.test(below.name) && bot.pathfinder.movements) {
        const mv = bot.pathfinder.movements;
        // 落下ダメージ = 高さ - 3。体力を 4 以上残す高さまで許可する
        mv.maxDropDown = Math.max(4, Math.min(20, Math.floor(bot.health) - 4 + 3));
        log.info(`木の上で動けないので、最大 ${mv.maxDropDown} マスの飛び降りを許可`);
        clearTimeout(this.dropTimer);
        this.dropTimer = setTimeout(() => { mv.maxDropDown = 4; }, 30_000);
      }
      // 少しランダムに歩いて引っかかりを外す
      const yaw = Math.random() * Math.PI * 2;
      bot.look(yaw, 0, true).catch(() => {});
      bot.setControlState('forward', true);
      bot.setControlState('jump', true);
      setTimeout(() => bot.clearControlStates(), 1200);
    }
  }

  // 敵から離れる向きで、いちばん近い陸（足元が固く、水でない 2 マスの空き）を探す
  findLandAwayFrom(from) {
    const { bot } = this;
    const me = bot.entity.position;
    let best = null;
    for (let dx = -12; dx <= 12; dx += 2) {
      for (let dz = -12; dz <= 12; dz += 2) {
        for (let dy = -2; dy <= 3; dy++) {
          const p = me.floored().offset(dx, dy, dz);
          const g = bot.blockAt(p.offset(0, -1, 0)); const a = bot.blockAt(p); const b = bot.blockAt(p.offset(0, 1, 0));
          if (!g || g.boundingBox !== 'block' || !a || a.boundingBox !== 'empty' || a.name === 'water' || !b || b.boundingBox !== 'empty') continue;
          const score = p.distanceTo(me) - 0.5 * p.distanceTo(from); // 近くて、敵からは遠い
          if (!best || score < best.score) best = { x: p.x, y: p.y, z: p.z, score };
        }
      }
    }
    return best;
  }

  makeCtx(controller) {
    return { bot: this.bot, cfg: this.cfg, memory: this.memory, log, signal: controller.signal, state: this.state, say: (t) => this.say(t) };
  }

  // ---------- メインループ ----------
  async run() {
    this.running = true;
    this.attachEvents();
    const reflexTimer = setInterval(() => this.reflexTick().catch((e) => log.warn(e.message)), 500);
    const watchdog = setInterval(() => this.watchdogTick(), 2000);
    try {
      while (this.running) {
        if (this.reflexBusy || !this.bot.entity || this.bot.health <= 0) { await sleep(500); continue; }
        if (this.memory.flag('dragonDefeated') && this.memory.flag('celebrated')) {
          log.info('🎉 エンダードラゴン討伐済み。待機します');
          await sleep(60_000);
          continue;
        }
        const snap = snapshot(this.bot, this.memory, this.cfg);
        let decision = await this.planner.decide({
          bot: this.bot, memory: this.memory, snapshot: snap, history: this.history.slice(-12), chatLog: this.chatLog.slice(-5),
          banned: this.loopGuard.bannedSkills(),
        });
        // ループ検知で禁止中のスキルが選ばれたら、進捗表の案か探索に差し替える
        decision = this.loopGuard.substitute(decision, [decision.hint]);
        this.lastDecision = { ...decision, at: new Date().toISOString() };
        if (decision.thinking) log.brain(`思考: ${decision.thinking}`);
        log.brain(`[${decision.source}] ${decision.skill}(${JSON.stringify(decision.args)}) ${decision.thought ?? ''}`);
        this.thoughts.push({ at: this.lastDecision.at, source: decision.source, skill: decision.skill, args: decision.args, thinking: decision.thinking ?? null, thought: decision.thought ?? null });
        this.thoughts = this.thoughts.slice(-50);
        await this.runSkill(decision.skill, decision.args);
        if (decision.skill === 'celebrate') this.memory.setFlag('celebrated');
        await sleep(jitter(this.cfg.human.thinkDelayMs));
      }
    } finally {
      clearInterval(reflexTimer);
      clearInterval(watchdog);
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
    const before = { inv: inventoryKey(this.bot), pos: this.bot.entity?.position.clone() };
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
    const moved = before.pos && this.bot.entity ? this.bot.entity.position.distanceTo(before.pos) : 0;
    const progressed = inventoryKey(this.bot) !== before.inv || moved >= 16;
    const loop = this.loopGuard.record({ skill: name, args, ok: entry.ok, result: entry.result, progressed });
    if (loop) {
      const msg = `${loop.skill} が進展なしにくり返されている。${Math.round(loop.banMs / 60_000)} 分間は使わず、別の行動に切り替える`;
      log.warn(msg);
      this.history.push({ skill: 'ループ検知', args: {}, ok: false, result: msg });
      this.state.heading = Math.random() * Math.PI * 2; // 探索の向きも変える
    }
  }

  stop() {
    this.running = false;
    this.interrupt('停止');
  }
}
