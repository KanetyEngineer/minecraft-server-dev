// 建築エージェント: チャットの指示（または起動時の設定）で設計図を読み込み、建て終わるまで Builder を回す。
// 敵が近づいたら建築をいったん止めて戦う／離れる（反射）。建築は世界の状態を見て続きから再開できる。
import fs from 'node:fs';
import path from 'node:path';
import { Vec3 } from 'vec3';
import pathfinderPkg from 'mineflayer-pathfinder';
import { parseLitematic } from './building/litematic.js';
import { Builder } from './building/builder.js';
import { materialList } from './building/blocks.js';
import { Supplier } from './building/acquire.js';
import { attackEntity, ensurePickaxe, pickUpItems, ascendToSurface } from './skills/common.js';
import { shelterForNight } from './skills/shelter.js';
import { gatherFood } from './skills/gather.js';
import { FOODS as FOOD } from './util/items.js';
import { dimensionOf } from './util/dim.js';
import { sleep } from './body/humanize.js';
import { findItem } from './util/items.js';
import { log } from './log.js';

const { goals } = pathfinderPkg;

// signal が中断されたら AbortError で終わる Promise
function aborted(signal) {
  return new Promise((_, reject) => {
    const fail = () => { const e = new Error('中断された'); e.name = 'AbortError'; reject(e); };
    if (signal.aborted) fail(); else signal.addEventListener('abort', fail, { once: true });
  });
}

const HOSTILE = new Set(['zombie', 'husk', 'drowned', 'skeleton', 'stray', 'bogged', 'spider', 'cave_spider', 'creeper',
  'witch', 'pillager', 'vindicator', 'slime', 'phantom', 'zombie_villager', 'silverfish', 'breeze', 'parched']);

export class Agent {
  constructor({ bot, cfg }) {
    this.bot = bot;
    this.cfg = cfg;
    this.ctx = { bot, cfg, log, state: {}, signal: null };
    this.job = null; // { file, origin }
    this.builder = null;
    this.status = '待機中';
    this.controller = null;
    this.stopped = false;
    this.threat = null;
    this.jobFile = path.join(cfg.dataDir, 'job.json');
  }

  // ---------- 仕事の保存・読み込み ----------

  loadJob() {
    try {
      const j = JSON.parse(fs.readFileSync(this.jobFile, 'utf8'));
      if (j && j.file && j.origin && !j.finished) return { file: j.file, origin: new Vec3(j.origin.x, j.origin.y, j.origin.z) };
    } catch {}
    return null;
  }

  saveJob(extra = {}) {
    try {
      fs.mkdirSync(this.cfg.dataDir, { recursive: true });
      fs.writeFileSync(this.jobFile, JSON.stringify({ ...this.job, ...extra, updatedAt: new Date().toISOString() }, null, 2));
    } catch (e) {
      log.warn(`仕事の保存に失敗: ${e.message}`);
    }
  }

  resolveSchematic(name) {
    const candidates = [name, `${name}.litematic`].flatMap((n) => [path.resolve(n), path.resolve(this.cfg.schematicDir, n)]);
    const hit = candidates.find((p) => fs.existsSync(p) && fs.statSync(p).isFile());
    if (!hit) throw new Error(`設計図 ${name} が見つからない（${this.cfg.schematicDir} に置いてください）`);
    return hit;
  }

  // ---------- チャット ----------

  say(msg) {
    log.info(`💬 ${msg}`);
    try { this.bot.chat(msg.slice(0, 250)); } catch {}
  }

  onChat(username, message, { console = false } = {}) {
    if (username === this.bot.username) return;
    const m = message.trim().match(/^!(\w+)\s*(.*)$/);
    if (!m) return;
    if (!console && !this.cfg.owners.includes(username)) { this.say(`${username} さんの指示は受け付けていません`); return; }
    const [, cmd, rest] = m;
    const args = rest.split(/\s+/).filter(Boolean);
    try {
      if (cmd === 'build') this.cmdBuild(username, args);
      else if (cmd === 'stop') { this.job = null; this.saveJob({ finished: true }); this.abort('止めるよう言われた'); this.say('建築を止めました'); }
      else if (cmd === 'status') this.cmdStatus();
      else if (cmd === 'materials') this.cmdMaterials(args).catch((e) => this.say(`エラー: ${e.message}`));
      else if (cmd === 'come') this.cmdCome(username);
      else if (cmd === 'list') this.say(`設計図: ${this.listSchematics().join(', ') || 'なし'}`);
      else this.say('使えるコマンド: !build <設計図> [x y z | here], !stop, !status, !materials <設計図>, !list, !come');
    } catch (e) {
      this.say(`エラー: ${e.message}`);
    }
  }

  // サーバーの管理者がファイルで指示する（data/control.txt に「!build 名前 here」などを 1 行ずつ書く）
  watchControlFile() {
    const file = path.join(this.cfg.dataDir, 'control.txt');
    this.controlTimer = setInterval(() => {
      let text = '';
      try { text = fs.readFileSync(file, 'utf8'); } catch { return; }
      if (!text.trim()) return;
      try { fs.writeFileSync(file, ''); } catch { return; }
      for (const line of text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
        log.info(`ファイルからの指示: ${line}`);
        this.onChat('console', line, { console: true });
      }
    }, 2000);
  }

  listSchematics() {
    try { return fs.readdirSync(this.cfg.schematicDir).filter((f) => f.endsWith('.litematic')); } catch { return []; }
  }

  cmdBuild(username, args) {
    if (args.length === 0) throw new Error('!build <設計図> [x y z | here]');
    const file = this.resolveSchematic(args[0]);
    let origin;
    if (args.length >= 4) origin = new Vec3(Number(args[1]), Number(args[2]), Number(args[3]));
    else if (args[1] === 'here') origin = this.groundAt(this.bot.entity.position.floored().offset(3, 0, 3));
    else {
      const player = this.bot.players[username]?.entity;
      if (!player) throw new Error('あなたの位置が見えないので、座標を指定してください（!build 名前 x y z）');
      origin = this.groundAt(player.position.floored());
    }
    if ([origin.x, origin.y, origin.z].some((v) => !Number.isFinite(v))) throw new Error('座標が数字ではない');
    this.job = { file: path.relative(process.cwd(), file), origin: { x: origin.x, y: origin.y, z: origin.z } };
    this.saveJob({ requestedBy: username, finished: false });
    this.builder = null;
    this.abort('新しい建築の指示');
    this.say(`${path.basename(file)} を (${origin.x}, ${origin.y}, ${origin.z}) に建てます`);
  }

  // その列の地面のすぐ上（空中や水中で指示されても、地面に建てる）
  groundAt(p) {
    for (let y = p.y + 4; y > p.y - 24; y--) {
      const b = this.bot.blockAt(new Vec3(p.x, y, p.z));
      if (b && b.boundingBox === 'block' && !b.name.endsWith('_leaves') && !/_log$/.test(b.name)) return new Vec3(p.x, y + 1, p.z);
    }
    return p;
  }

  cmdStatus() {
    if (!this.builder) { this.say(`状態: ${this.status}`); return; }
    const p = this.builder.progress();
    const miss = [...this.builder.missing.entries()].map(([n, c]) => `${n}×${c}`).join(', ');
    this.say(`${this.status} / ${p.ok}/${p.total} ブロック、段 ${this.builder.layer + 1}/${this.builder.size.y}${miss ? ` / 不足: ${miss}` : ''}`);
  }

  async cmdMaterials(args) {
    const file = args[0] ? this.resolveSchematic(args[0]) : this.job?.file;
    if (!file) throw new Error('!materials <設計図>');
    const s = await parseLitematic(fs.readFileSync(file));
    // 必要な数の多い順（建築中の Builder には触らない）
    const need = [...materialList(this.bot.registry, s.blocks).need.entries()].sort((a, b) => b[1] - a[1]);
    this.say(`${s.name}（${s.size.x}×${s.size.y}×${s.size.z}）: ${need.slice(0, 12).map(([n, c]) => `${n}×${c}`).join(', ')}${need.length > 12 ? ' ほか' : ''}`);
  }

  cmdCome(username) {
    const p = this.bot.players[username]?.entity?.position;
    if (!p) throw new Error('あなたの位置が見えない');
    this.abort('呼ばれた');
    this.bot.pathfinder.goto(new goals.GoalNear(p.x, p.y, p.z, 2)).catch(() => {});
  }

  // ---------- 反射（敵） ----------

  abort(reason) {
    if (this.controller && !this.controller.signal.aborted) {
      log.info(`作業を中断: ${reason}`);
      this.controller.abort();
      try { this.bot.pathfinder.setGoal(null); } catch {}
      try { this.bot.stopDigging(); } catch {}
    }
  }

  watchThreats() {
    const { bot } = this;
    this.threatTimer = setInterval(() => {
      if (!bot.entity || this.threat || this.ctx.state.sheltered) return;
      // 建築の途中で夜になったら、区切りを待たずに止めて穴にこもる（夜も建て続けて倒されていた）
      if (this.job && !this.resting && this.needsShelter()) { this.abort('夜になった'); return; }
      const me = bot.entity.position;
      const e = bot.nearestEntity((x) => HOSTILE.has(x.name) && x.position.distanceTo(me) < (x.name === 'creeper' ? 7 : 5)
        && Math.abs(x.position.y - me.y) < 4);
      if (!e) return;
      this.threat = e;
      this.abort(`${e.name} が近い`);
    }, 400);
  }

  async handleThreat() {
    const { bot } = this;
    const e = this.threat;
    try {
      if (!e?.isValid) return;
      // クリーパーと、体力が少ないときは戦わずに離れる（夜にスケルトンと撃ち合って倒されていた）
      if (e.name === 'creeper' || bot.health < 10) {
        log.info(`${e.name} から離れる（体力 ${Math.round(bot.health)}）`);
        const p = bot.entity.position; const d = p.minus(e.position); const n = Math.hypot(d.x, d.z) || 1;
        await Promise.race([bot.pathfinder.goto(new goals.GoalNearXZ(p.x + (d.x / n) * 14, p.z + (d.z / n) * 14, 2)).catch(() => {}), sleep(8000)]);
        try { bot.pathfinder.setGoal(null); } catch {}
        return;
      }
      log.info(`${e.name} と戦う`);
      await attackEntity({ ...this.ctx, signal: null }, e, { timeoutMs: 20_000 }).catch(() => {});
    } finally {
      this.threat = null;
    }
  }

  // 死んだら、落とした物（チェストから出した素材など）を 5 分で消える前に拾いに戻る
  watchDeath() {
    const { bot } = this;
    bot.on('death', () => {
      if (bot.entity?.position) this.deathAt = { pos: bot.entity.position.clone(), time: Date.now() };
      this.abort('死んだ');
    });
  }

  async recoverDrops() {
    const { bot } = this;
    const d = this.deathAt;
    this.deathAt = null;
    if (!d || Date.now() - d.time > 4 * 60_000) return;
    for (let i = 0; i < 20 && !bot.entity?.isValid; i++) await sleep(250);
    log.info(`死んだ場所 (${d.pos.floored()}) に落とした物を拾いに戻る`);
    await Promise.race([
      bot.pathfinder.goto(new goals.GoalNear(d.pos.x, d.pos.y, d.pos.z, 2)).catch((e) => log.warn(`戻れなかった: ${e.message}`)),
      sleep(90_000),
    ]);
    try { bot.pathfinder.setGoal(null); } catch {}
    await pickUpItems({ ...this.ctx, signal: null }, 10).catch(() => {});
    // 拾った素材の分、チェストの中身の記録を読み直す
    this.builder?.supplier?.chests.clear();
  }

  // 見張り: 建築中に 2 分間、位置も持ち物も変わらなければ、固まったとみなしてやり直す
  watchStuck() {
    const { bot } = this;
    let last = ''; let since = Date.now();
    this.stuckTimer = setInterval(() => {
      if (!bot.entity || !this.job || this.threat || this.resting) { since = Date.now(); return; }
      const p = bot.entity.position;
      const sig = `${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)}|${bot.inventory.items().reduce((s, i) => s + i.count, 0)}|${this.builder?.placed ?? 0}`;
      if (sig !== last) { last = sig; since = Date.now(); return; }
      if (Date.now() - since > 120_000) {
        since = Date.now();
        this.abort('2 分間動きが無いので、やり直す');
      }
    }, 5000);
  }

  // ---------- メインループ ----------

  stop() {
    this.stopped = true;
    clearInterval(this.threatTimer);
    clearInterval(this.controlTimer);
    clearInterval(this.stuckTimer);
    this.abort('終了');
  }

  async run() {
    const { bot, cfg } = this;
    this.watchThreats();
    this.watchControlFile();
    this.watchDeath();
    this.watchStuck();
    this.job = this.loadJob();
    if (!this.job && cfg.buildFile && cfg.buildOrigin) {
      if (cfg.buildOrigin === 'here') for (let i = 0; i < 40 && !bot.entity.onGround; i++) await sleep(250); // 着地を待つ
      const origin = cfg.buildOrigin === 'here' ? this.groundAt(bot.entity.position.floored().offset(3, 0, 3)) : cfg.buildOrigin;
      this.job = { file: path.relative(process.cwd(), this.resolveSchematic(cfg.buildFile)), origin: { x: origin.x, y: origin.y, z: origin.z } };
      this.saveJob({ finished: false });
    }
    if (this.job) log.info(`前回の続き／設定の建築: ${this.job.file} @ (${this.job.origin.x}, ${this.job.origin.y}, ${this.job.origin.z})`);
    else log.info(`指示待ち: チャットで「!build 設計図名」と送ってください（受け付ける人: ${cfg.owners.join(', ')}）`);
    let fails = 0;
    while (!this.stopped) {
      if (this.threat) { await this.handleThreat(); continue; }
      if (this.deathAt) { await this.recoverDrops(); continue; }
      if (this.job && this.needsHunting()) {
        await this.settlePending();
        await this.getFood();
        continue;
      }
      if (this.job && this.needsShelter()) {
        await this.settlePending();
        await this.shelter();
        continue;
      }
      if (!this.job) { this.status = '待機中'; await sleep(1000); continue; }
      await this.settlePending();
      this.controller = new AbortController();
      const { signal } = this.controller;
      this.ctx.signal = signal;
      // 建築は中断の合図と競争させる。途中の処理が応答しないまま固まっても、反射（戦う・逃げる）や次の周回に進める。
      // 固まっていた処理が後で動き出しても、合図が中断のままなので次の確認で止まる（settlePending で決着を待つ）
      const work = (async () => {
        if (!this.builder) await this.prepare();
        await this.ensureBed();
        this.status = `建築中: ${path.basename(this.job.file)}`;
        return this.builder.run();
      })();
      this.pending = work.catch(() => {});
      try {
        const result = await Promise.race([work, aborted(signal)]);
        const miss = result.missing.map(([n, c]) => `${n}×${c}`).join(', ');
        if (result.ok >= result.total) {
          this.say(`完成しました（${result.ok}/${result.total}${result.orientationOff ? `、向き違い ${result.orientationOff}` : ''}）`);
          this.saveJob({ finished: true, result });
          this.job = null;
          this.builder = null;
        } else {
          this.say(`${result.ok}/${result.total} まで建てました。足りない素材: ${miss || '不明'}。チェストに入れてもらえれば続けます`);
          this.status = `素材待ち: ${miss}`;
          this.builder.missing.clear();
          this.builder.supplier.chests.clear();
          await this.waitFor(cfg.retryWaitSec * 1000);
        }
        fails = 0;
      } catch (e) {
        if (e.name === 'AbortError' || signal.aborted) continue;
        fails++;
        log.warn(`建築が止まった（${fails} 回目）: ${e.stack ?? e.message}`);
        this.builder?.supplier?.chests.clear();
        await this.waitFor(Math.min(30_000, 2000 * fails));
      }
    }
  }

  // 前の周回の処理（中断したもの）が終わるのを、最大 30 秒待つ。中断の合図は残したままにして、
  // 遅れて動き出した処理が次の確認で止まるようにする
  async settlePending() {
    if (!this.pending) return;
    const p = this.pending;
    this.pending = null;
    if (this.controller && !this.controller.signal.aborted) this.controller.abort();
    await Promise.race([p, sleep(30_000)]);
  }

  needsShelter() {
    const { bot, cfg } = this;
    if (!cfg.shelterAtNight || dimensionOf(bot) !== 'overworld') return false;
    // 体力の回復は満腹度 18 以上でないと起きないので、そうでなければ休んでも無駄（食べ物を探す方に回す）
    return !bot.time.isDay || (bot.health < 8 && bot.food >= 18);
  }

  // 昼で、お腹が減っていて食べ物を持っていなければ、動物を狩って焼く（5 分おきに試す）
  needsHunting() {
    const { bot } = this;
    if (!bot.time.isDay || bot.food >= 14) return false;
    if (bot.inventory.items().some((i) => bot.autoEat?.foodsByName?.[i.name] || FOOD.has(i.name))) return false;
    return !this.foodTriedAt || Date.now() - this.foodTriedAt > 5 * 60_000;
  }

  async getFood() {
    this.foodTriedAt = Date.now();
    this.status = '食べ物を集める';
    this.controller = new AbortController();
    const ctx = { ...this.ctx, signal: this.controller.signal };
    log.info(`お腹が減って（満腹度 ${this.bot.food}）食べ物が無いので、動物を狩る`);
    try {
      log.info(await gatherFood(ctx, { amount: 8 }));
    } catch (e) {
      if (e.name !== 'AbortError') log.warn(`食べ物を集められなかった: ${e.message}`);
    }
  }

  // 夜（または体力が少ないとき）は穴にこもって待つ（防具なしで夜に建てていると、スケルトンに倒されて素材を落としていた）
  async shelter() {
    const { bot } = this;
    const healing = bot.time.isDay;
    this.status = healing ? '体力が回復するまで休む' : '夜なので穴にこもって朝を待つ';
    this.controller = new AbortController();
    const ctx = { ...this.ctx, signal: this.controller.signal };
    this.resting = true;
    try {
      const r = await shelterForNight(ctx, { untilHealed: healing });
      log.info(r);
      // 穴から出る（ふたは掘ってある。足元にブロックを積んで上がる）
      if (bot.time.isDay && bot.health >= 8) await ascendToSurface(ctx).catch(() => {});
    } catch (e) {
      if (e.name !== 'AbortError') { log.warn(`穴にこもれなかった: ${e.message}`); await sleep(5000); }
    } finally {
      this.resting = false;
    }
  }

  // 昼のうちにベッドを用意しておく（夜は穴の中で寝て朝にする。羊が見つからなければ 10 分おきに試す）
  async ensureBed() {
    const { bot, cfg } = this;
    if (!cfg.useBed || !bot.time.isDay || bot.inventory.items().some((i) => i.name.endsWith('_bed'))) return;
    if (this.bedTriedAt && Date.now() - this.bedTriedAt < 10 * 60_000) return;
    this.bedTriedAt = Date.now();
    log.info('夜に寝るためのベッドを用意する');
    await this.builder.supplier.ensure('white_bed', 1).catch((e) => {
      if (e.name === 'AbortError') throw e;
      log.warn(`ベッドを用意できなかった: ${e.message}`);
    });
  }

  async waitFor(ms) {
    const until = Date.now() + ms;
    while (Date.now() < until && !this.stopped && !this.threat && this.job) await sleep(500);
  }

  async prepare() {
    const { bot, cfg } = this;
    const file = this.resolveSchematic(this.job.file);
    const schematic = await parseLitematic(fs.readFileSync(file));
    const origin = new Vec3(this.job.origin.x, this.job.origin.y, this.job.origin.z);
    const center = origin.offset(schematic.size.x / 2, 0, schematic.size.z / 2);
    const supplier = new Supplier(this.ctx, { home: center, chestRadius: cfg.chestRadius + Math.max(schematic.size.x, schematic.size.z) / 2 });
    this.builder = new Builder(this.ctx, { schematic, origin, supplier, clear: cfg.clearArea });
    const { need, unplaceable } = this.builder.materialSummary();
    log.info(`設計図 ${schematic.name}: ${schematic.size.x}×${schematic.size.y}×${schematic.size.z}、${schematic.blocks.length} ブロック`);
    log.info(`必要な素材: ${need.map(([n, c]) => `${n}×${c}`).join(', ')}`);
    if (unplaceable.length) log.warn(`置かないブロック: ${unplaceable.map(([n, c]) => `${n}×${c}`).join(', ')}`);
    // 建築現場へ向かう
    if (bot.entity.position.distanceTo(center) > 48) {
      log.info('建築現場へ移動する');
      await bot.pathfinder.goto(new goals.GoalNearXZ(center.x, center.z, 8)).catch(() => {});
    }
    // 道具が無ければ最初に作っておく（普通のプレイヤーの最初の流れ）
    if (cfg.prepareTools && !findItem(bot, 'stone_pickaxe') && !findItem(bot, 'iron_pickaxe') && !findItem(bot, 'diamond_pickaxe')) {
      await supplier.scanChests().catch(() => {});
      try {
        await supplier.ensure('stone_pickaxe', 1);
        await supplier.ensure('stone_axe', 1).catch(() => {});
        await supplier.ensure('stone_sword', 1).catch(() => {});
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        log.warn(`道具を用意できなかった: ${e.message}`);
        await ensurePickaxe(this.ctx).catch(() => {});
      }
    }
  }
}
