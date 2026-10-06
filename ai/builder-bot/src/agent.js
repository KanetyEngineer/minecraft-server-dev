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
import { attackEntity, ensurePickaxe, pickUpItems, ascendToSurface, equipCheapestTool } from './skills/common.js';
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
    this.ctx = { bot, cfg, log, state: {}, signal: null, notify: (msg) => this.sayOnce(msg), onPathStall: () => this.pathStalled() };
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
      if (j && j.file && j.origin && !j.finished) {
        return { file: j.file, origin: { x: j.origin.x, y: j.origin.y, z: j.origin.z }, scaffolds: j.scaffolds ?? [], requestedBy: j.requestedBy, homeBed: j.homeBed };
      }
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

  // 足場の記録など、細かく変わるものは 5 秒にまとめて保存する
  saveJobSoon() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = null; if (this.job) this.saveJob({ finished: false }); }, 5000);
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

  // 同じ知らせは 10 分に 1 回だけチャットに出す（素材待ちで 1 分おきに同じことを言わない）
  sayOnce(msg) {
    const now = Date.now();
    if (this.lastNotice?.msg === msg && now - this.lastNotice.at < 10 * 60_000) { log.info(`（同じ知らせ）${msg}`); return; }
    this.lastNotice = { msg, at: now };
    this.say(msg);
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
    this.prepared = false;
    this.stall = null;
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
    // 建築中の設計図なら、手持ちとチェスト（最後に調べた中身）と比べた不足も伝える
    if (this.job && this.builder?.supplier && path.resolve(file) === path.resolve(this.resolveSchematic(this.job.file))) {
      const short = this.builder.shortage();
      this.say(short.length ? `残りに足りない素材: ${short.slice(0, 12).map(([n, c]) => `${n}×${c}`).join(', ')}` : '残りの素材は手持ちとチェストでそろっています');
    }
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
      if (bot.entity?.position) this.deathAt = this.lastDeath = { pos: bot.entity.position.clone(), time: Date.now(), respawned: false };
      this.abort('死んだ');
    });
    // リスポーンの瞬間に経路探索が止められるので、リスポーンし終わってから戻る（すぐ戻ろうとして「Path was stopped」になっていた）
    bot.on('spawn', () => { if (this.lastDeath) this.lastDeath.respawned = true; });
  }

  async recoverDrops() {
    const { bot } = this;
    const d = this.deathAt;
    this.deathAt = null;
    if (!d || Date.now() - d.time > 4 * 60_000) return;
    for (let i = 0; i < 40 && !d.respawned; i++) await sleep(250);
    await sleep(1000);
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

  // 見張り: 体の動き（物理演算）が止まったら接続し直す。足元のチャンクの情報が消えるなどで mineflayer の物理演算が
  // 止まると、経路探索も何もしなくなり、試験では 10 分以上その場で止まり続けた（寝ている間・死んでいる間は除く）
  watchPhysics() {
    const { bot } = this;
    this.lastTick = Date.now();
    bot.on('physicsTick', () => { this.lastTick = Date.now(); });
    this.physicsTimer = setInterval(() => {
      if (!bot.entity || this.stopped || bot.isSleeping || bot.isAlive === false) { this.lastTick = Date.now(); return; }
      if (Date.now() - this.lastTick < 20_000) return;
      const loaded = bot.blockAt(bot.entity.position) ? 'ある' : '無い';
      log.warn(`体の動き（物理演算）が 20 秒止まっている（足元のチャンクの情報が${loaded}）。接続し直す`);
      this.lastTick = Date.now();
      try { bot.quit('物理演算が止まったので接続し直す'); } catch {}
    }, 5000);
  }

  // 見張り: 埋まった（目や足の高さのマスが、詰まったブロックになった。落ちてきた砂利・自分が置いたブロックなど）ら、
  // 作業を止めて掘り出す（そのままだと窒息する）
  watchBurial() {
    const { bot } = this;
    this.burialTimer = setInterval(() => {
      if (!bot.entity || this.buried || bot.isSleeping || bot.isAlive === false) return;
      const cells = this.bodyBlocks();
      if (cells.length === 0) return;
      this.buried = cells;
      log.warn(`ブロックに埋まった（${cells.map((b) => b.name).join(', ')}）。掘って出る`);
      this.abort('ブロックに埋まった');
    }, 500);
  }

  // 体の中（足と目の高さ）にある、詰まったブロック
  bodyBlocks() {
    const { bot } = this;
    const pos = bot.entity.position;
    const out = [];
    for (const dy of [0.1, 1.62]) {
      const b = bot.blockAt(new Vec3(pos.x, pos.y + dy, pos.z).floored());
      if (!b || b.boundingBox !== 'block' || b.name === 'bedrock') continue;
      const full = (b.shapes ?? []).some((s) => s[0] <= 0 && s[1] <= 0 && s[2] <= 0 && s[3] >= 1 && s[4] >= 1 && s[5] >= 1);
      if (full) out.push(b);
    }
    return out;
  }

  async digOut() {
    const { bot } = this;
    try {
      for (let i = 0; i < 6; i++) {
        const cells = this.bodyBlocks();
        if (cells.length === 0) break;
        for (const b of cells) {
          await equipCheapestTool(bot, b).catch(() => {});
          await bot.dig(b, true).catch((e) => log.warn(`掘り出せなかった: ${e.message}`));
        }
        await sleep(300);
      }
    } finally {
      this.buried = null;
    }
  }

  // 経路探索が中で固まった（経路をひとつも探さないまま時間切れ）。2 回続いたら接続し直して、経路探索を作り直す
  pathStalled() {
    const now = Date.now();
    this.stalls = (this.stalls ?? []).filter((t) => now - t < 5 * 60_000);
    this.stalls.push(now);
    log.warn(`経路探索が固まっている（${this.stalls.length} 回目）`);
    if (this.stalls.length >= 2) {
      this.stalls = [];
      log.warn('経路探索が固まったままなので、接続し直す');
      try { this.bot.quit('経路探索が固まったので接続し直す'); } catch {}
    }
  }

  // ---------- メインループ ----------

  stop() {
    this.stopped = true;
    clearInterval(this.threatTimer);
    clearInterval(this.controlTimer);
    clearInterval(this.stuckTimer);
    clearInterval(this.physicsTimer);
    clearInterval(this.burialTimer);
    this.abort('終了');
  }

  async run() {
    const { bot, cfg } = this;
    this.watchThreats();
    this.watchControlFile();
    this.watchDeath();
    this.watchStuck();
    this.watchPhysics();
    this.watchBurial();
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
      if (this.buried) { await this.settlePending(); await this.digOut(); continue; }
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
        if (!this.prepared) { await this.prepare(); this.prepared = true; }
        await this.ensureBed();
        await this.placeHomeBed();
        this.status = `建築中: ${path.basename(this.job.file)}`;
        const r = await this.builder.run();
        if (r.ok >= r.total) await this.removeHomeBed().catch((e) => { if (e.name === 'AbortError') throw e; log.warn(`ベッドを片付けられなかった: ${e.message}`); });
        return r;
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
          this.prepared = false;
        } else if (miss) {
          this.sayOnce(`${result.ok}/${result.total} まで建てました。足りない素材: ${miss}。チェストに入れてもらえれば続けます`);
          this.status = `素材待ち: ${miss}`;
          this.builder.missing.clear();
          this.builder.supplier.chests.clear();
          await this.waitFor(cfg.retryWaitSec * 1000);
        } else {
          // 素材はあるのに置けなかった所（届かない・付ける先が無いなど）。少し待ってやり直す。
          // 3 回やり直しても 1 個も増えなければ、置けない所として報告して終わる
          const stall = this.stall && this.stall.ok === result.ok ? this.stall.passes + 1 : 1;
          this.stall = { ok: result.ok, passes: stall };
          if (stall >= 3) {
            this.say(`${result.ok}/${result.total} で建築を終えます。置けなかった所: ${this.builder.unplaced(5).join(', ')}`);
            this.saveJob({ finished: true, result });
            this.job = null;
            this.builder = null;
            this.prepared = false;
            this.stall = null;
          } else {
            this.sayOnce(`${result.ok}/${result.total} まで建てました。置けなかった ${result.total - result.ok} 個をやり直します`);
            this.status = `やり直し待ち（残り ${result.total - result.ok}）`;
            this.builder.supplier.chests.clear();
            await this.waitFor(15_000);
          }
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
    try {
      // チェストに食べ物があればそれを持つ
      const supplier = this.job ? (await this.ensureBuilder().catch(() => null))?.supplier : null;
      if (supplier) {
        await supplier.scanChests({ refreshMs: 60_000 }).catch(() => {});
        const got = await supplier.takeAnyFromChests([...FOOD].filter((n) => supplier.chestCount(n) > 0), 16);
        if (got) { log.info(`チェストの ${got} を持った`); return; }
      }
      log.info(`お腹が減って（満腹度 ${this.bot.food}）食べ物が無いので、動物を狩る`);
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
      // 現場の近くに置いたベッドで寝られれば、穴は掘らない（敵が近いなどで寝られなければ穴にこもる）
      if (!healing && (await this.sleepInHomeBed(ctx))) return;
      // 建物の上で穴を掘らないよう、範囲の外へ出てからこもる（建てた所に穴を開けていた）
      if (this.builder) await this.builder.leaveArea().catch(() => {});
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

  // 昼のうちにベッドを用意しておく（夜は穴の中で寝て朝にする。羊が見つからなければ 30 分おきに試す）
  async ensureBed() {
    const { bot, cfg } = this;
    if (!cfg.useBed || !bot.time.isDay || bot.inventory.items().some((i) => i.name.endsWith('_bed'))) return;
    if (this.homeBedBlock()) return; // 現場の近くに置いたベッドがある
    if (this.bedTriedAt && Date.now() - this.bedTriedAt < 30 * 60_000) return;
    this.bedTriedAt = Date.now();
    log.info('夜に寝るためのベッドを用意する');
    // 羊を探して現場から遠くまで歩き回らないよう、3 分で打ち切る（建築ごと中断し、30 分間はベッドを探さない）
    const timer = setTimeout(() => this.abort('ベッドの用意に時間がかかるので後回しにする'), 3 * 60_000);
    try {
      const { supplier } = this.builder;
      if (supplier.stocked) {
        await supplier.scanChests({ refreshMs: 60_000 }).catch(() => {});
        const beds = bot.registry.itemsArray.map((i) => i.name).filter((n) => n.endsWith('_bed'));
        if (await supplier.takeAnyFromChests(beds, 1)) return;
      }
      await supplier.ensure('white_bed', 1).catch((e) => {
        if (e.name === 'AbortError') throw e;
        log.warn(`ベッドを用意できなかった: ${e.message}`);
      });
    } finally {
      clearTimeout(timer);
    }
  }

  // 素材を用意してもらう建築の準備: チェストを調べ、道具を持ち、足りない素材を最初に伝える
  async prepareStocked() {
    const { bot } = this;
    const { supplier } = this.builder;
    await supplier.scanChests().catch((e) => log.warn(`チェストを調べられなかった: ${e.message}`));
    log.info(`素材のチェスト ${supplier.chests.size} 個を見つけた`);
    // 道具はチェストにあれば持つ（無くても素手で建てられる。どける地形が硬いと遅いだけ）
    const TIERS = ['netherite', 'diamond', 'iron', 'stone', 'golden', 'wooden'];
    for (const kind of ['pickaxe', 'axe', 'shovel', 'sword']) {
      if (bot.inventory.items().some((i) => i.name.endsWith(`_${kind}`))) continue;
      const got = await supplier.takeAnyFromChests(TIERS.map((t) => `${t}_${kind}`), 1);
      if (got) log.info(`チェストの ${got} を持った`);
    }
    const short = this.builder.shortage();
    // 高い建物は、登るための仮の足場（土など）をたくさん使う。チェストに足りなければ、目安を伝える
    const want = this.builder.scaffoldEstimate();
    const have = this.builder.spareScaffold() + ['dirt', 'coarse_dirt', 'netherrack', 'cobblestone', 'cobbled_deepslate']
      .filter((n) => !this.builder.needed.has(n)).reduce((a, n) => a + supplier.chestCount(n), 0);
    if (want > 0 && have < want) {
      this.sayOnce(`足場用の土（丸石でも可）を ${want} 個ほどチェストに入れておくと、止まらずに建てられます（いま ${have} 個）`);
    }
    if (supplier.chests.size === 0 && supplier.unreadable === 0) {
      // まだ現場から遠くてチェストが見えていないか、チェストが無い。足りないとは言わない
      this.say('建築現場の近くに素材のチェストが見つかりません。手持ちの分から建て始め、チェストが見つかったら使います');
    } else if (supplier.unreadable > 0) {
      // 開けられなかったチェストの中身は分からないので、「足りない」とは言わない
      this.say(`チェスト ${supplier.unreadable} 個にまだ近づけないので、素材の確認は建てながらします`);
    } else if (short.length) {
      const list = short.map(([n, c]) => `${n}×${c}`);
      this.say(`素材が足りません: ${list.slice(0, 10).join(', ')}${list.length > 10 ? ` ほか ${list.length - 10} 種類` : ''}。ある分から建て始めます`);
    } else {
      const p = this.builder.progress();
      this.say(`素材はそろっています（残り ${p.total - p.ok} ブロック）。建て始めます`);
    }
  }

  // ---------- リスポーン地点のベッド ----------
  // 建築現場の近く（チェストのそば）にベッドを置いてクリックし、リスポーン地点にする。
  // 持ち歩いて穴で寝るだけだと、朝にベッドを回収した時点でリスポーン地点が消え、死ぬと遠い初期スポーンに戻されて
  // 落とした素材を拾いに行けなかった。クリックだけでも（昼でも、敵が近くて寝られなくても）リスポーン地点は決まる

  homeBedBlock() {
    const hb = this.job?.homeBed;
    if (!hb) return null;
    const b = this.bot.blockAt(new Vec3(hb.x, hb.y, hb.z));
    if (b === null) return { position: new Vec3(hb.x, hb.y, hb.z), name: 'unloaded' }; // 読み込まれていないだけ
    return b.name.endsWith('_bed') ? b : null;
  }

  async placeHomeBed() {
    const { bot, cfg } = this;
    if (!cfg.useBed || !bot.time.isDay || !this.builder || this.homeBedBlock()) return;
    if (this.homeBedTriedAt && Date.now() - this.homeBedTriedAt < 10 * 60_000) return;
    const item = bot.inventory.items().find((i) => i.name.endsWith('_bed'));
    if (!item) return;
    this.homeBedTriedAt = Date.now();
    const b = this.builder;
    const chest = [...b.supplier.chests.values()][0]?.pos;
    const near = chest ?? b.supplier.home;
    const solid = (p) => { const x = bot.blockAt(p); return x && x.boundingBox === 'block' && !/(leaves|_log|chest|barrel)/.test(x.name); };
    const empty = (p) => bot.blockAt(p)?.boundingBox === 'empty' && !/(water|lava)/.test(bot.blockAt(p).name);
    const spots = [];
    for (let dx = -6; dx <= 6; dx++) for (let dz = -6; dz <= 6; dz++) for (let dy = -3; dy <= 3; dy++) {
      const f = near.offset(dx, dy, dz);
      if (b.nearBox(f, 2) || !solid(f.offset(0, -1, 0)) || !empty(f) || !empty(f.offset(0, 1, 0))) continue;
      for (const [ex, ez] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const g = f.offset(ex, 0, ez); // 頭の側
        const st = f.offset(-ex, 0, -ez); // 立つ所（足の側の後ろ。ベッドのマスに立っていると置けない）
        if (b.nearBox(g, 2) || !solid(g.offset(0, -1, 0)) || !empty(g) || !empty(g.offset(0, 1, 0))) continue;
        if (!solid(st.offset(0, -1, 0)) || !empty(st) || !empty(st.offset(0, 1, 0))) continue;
        spots.push({ f, g, st, ex, ez, d: f.distanceTo(near) });
      }
    }
    spots.sort((a, c) => a.d - c.d);
    for (const { f, g, st, ex, ez } of spots.slice(0, 3)) {
      try {
        let timer;
        try {
          await Promise.race([
            bot.pathfinder.goto(new goals.GoalBlock(st.x, st.y, st.z)),
            new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('ベッドを置く場所へ行けない')), 20_000); }),
          ]);
        } finally {
          clearTimeout(timer);
          try { bot.pathfinder.setGoal(null); } catch {}
        }
        // ベッドは向いている方向に頭が伸びる
        await bot.look(Math.atan2(-ex, -ez), -0.6, true);
        // チェストを閉じた直後などは持ち替えが反映されないことがある（「must be holding an item」）。持てたか確かめる
        for (let t = 0; t < 3 && !bot.heldItem?.name?.endsWith('_bed'); t++) {
          const it = bot.inventory.items().find((i) => i.name.endsWith('_bed'));
          if (!it) break;
          await bot.equip(it, 'hand').catch(() => {});
          await bot.waitForTicks(4);
        }
        if (!bot.heldItem?.name?.endsWith('_bed')) throw new Error('ベッドを手に持てない');
        await bot.placeBlock(bot.blockAt(f.offset(0, -1, 0)), new Vec3(0, 1, 0));
        let head = null;
        for (let t = 0; t < 20 && !head; t++) {
          head = [bot.blockAt(f), bot.blockAt(g)].find((x) => x?.name?.endsWith('_bed') && x.getProperties?.().part === 'head');
          if (!head) await bot.waitForTicks(1);
        }
        if (!head) continue;
        await bot.activateBlock(head);
        this.job.homeBed = { x: head.position.x, y: head.position.y, z: head.position.z };
        this.saveJob({ finished: false });
        for (const q of [f, g]) b.protectedKeys.add(`${q.x},${q.y},${q.z}`);
        log.info(`建築現場の近く (${head.position}) にベッドを置き、リスポーン地点にした`);
        return;
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        log.warn(`ベッドを置けなかった: ${e.message}`);
      }
    }
  }

  // 建て終わったら、置いたベッドを回収してチェストへ戻す
  async removeHomeBed() {
    const { bot } = this;
    const bed = this.homeBedBlock();
    if (!bed || bed.name === 'unloaded') return;
    await bot.pathfinder.goto(new goals.GoalNear(bed.position.x, bed.position.y, bed.position.z, 2)).catch(() => {});
    const b = bot.blockAt(bed.position);
    if (b?.name?.endsWith('_bed')) {
      await bot.dig(b, true);
      await sleep(500);
      await pickUpItems({ ...this.ctx, signal: null }, 4).catch(() => {});
    }
    this.job.homeBed = null;
    const supplier = this.builder?.supplier;
    const item = bot.inventory.items().find((i) => i.name === b?.name);
    if (supplier?.stocked && item) await supplier.depositToChests(item.name, item.count);
  }

  async sleepInHomeBed(ctx) {
    const { bot } = this;
    const bed = this.homeBedBlock();
    if (!bed || bed.name === 'unloaded' || bot.time.isDay) return false;
    const enemy = bot.nearestEntity((x) => HOSTILE.has(x.name) && x.position.distanceTo(bed.position) < 10);
    if (enemy) return false;
    try {
      let timer;
      try {
        await Promise.race([
          bot.pathfinder.goto(new goals.GoalNear(bed.position.x, bed.position.y, bed.position.z, 2)),
          new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('ベッドへ行けない')), 30_000); }),
        ]);
      } finally {
        clearTimeout(timer);
        try { bot.pathfinder.setGoal(null); } catch {}
      }
      await bot.sleep(bot.blockAt(bed.position));
      log.info('🛏 現場の近くのベッドで寝る');
      this.ctx.state.sheltered = true;
      const t0 = Date.now();
      while (bot.isSleeping && !bot.time.isDay && Date.now() - t0 < 9 * 60_000) {
        if (ctx.signal?.aborted) break;
        await sleep(1000);
      }
      if (bot.isSleeping) await bot.wake().catch(() => {});
      await sleep(1500); // 起きた直後は時刻の知らせがまだ来ていない
      return bot.time.isDay;
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      log.warn(`ベッドで寝られなかった、穴にこもる: ${e.message}`);
      return false;
    } finally {
      this.ctx.state.sheltered = false;
    }
  }

  async waitFor(ms) {
    const until = Date.now() + ms;
    while (Date.now() < until && !this.stopped && !this.threat && this.job) await sleep(500);
  }

  // 設計図を読み、Builder と Supplier を作る（移動はしない）。食べ物・ベッドをチェストから取るのにも使う
  async ensureBuilder() {
    if (this.builder) return this.builder;
    const { cfg } = this;
    const file = this.resolveSchematic(this.job.file);
    const schematic = await parseLitematic(fs.readFileSync(file));
    const origin = new Vec3(this.job.origin.x, this.job.origin.y, this.job.origin.z);
    const center = origin.offset(schematic.size.x / 2, 0, schematic.size.z / 2);
    const supplier = new Supplier(this.ctx, {
      home: center, chestRadius: cfg.chestRadius + Math.max(schematic.size.x, schematic.size.z) / 2, mode: cfg.supplyMode,
      yRange: [origin.y - 6, origin.y + schematic.size.y + 6],
    });
    this.builder = new Builder(this.ctx, {
      schematic, origin, supplier, clear: cfg.clearArea, scaffolds: this.job.scaffolds ?? [],
      onScaffolds: (list) => { if (this.job) { this.job.scaffolds = list; this.saveJobSoon(); } },
    });
    // リスポーン地点のベッド（とその隣の足側）は、経路探索で壊さない
    const hb = this.job.homeBed;
    if (hb) for (const [dx, dz] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) this.builder.protectedKeys.add(`${hb.x + dx},${hb.y},${hb.z + dz}`);
    const { need, unplaceable } = this.builder.materialSummary();
    log.info(`設計図 ${schematic.name}: ${schematic.size.x}×${schematic.size.y}×${schematic.size.z}、${schematic.blocks.length} ブロック`);
    log.info(`必要な素材: ${need.map(([n, c]) => `${n}×${c}`).join(', ')}`);
    if (unplaceable.length) log.warn(`置かないブロック: ${unplaceable.map(([n, c]) => `${n}×${c}`).join(', ')}`);
    return this.builder;
  }

  async prepare() {
    const { bot, cfg } = this;
    const { supplier } = await this.ensureBuilder();
    const center = supplier.home;
    // 建築現場へ向かう
    if (bot.entity.position.distanceTo(center) > 48) {
      log.info('建築現場へ移動する');
      await bot.pathfinder.goto(new goals.GoalNearXZ(center.x, center.z, 8)).catch(() => {});
    }
    if (supplier.stocked) {
      await this.prepareStocked();
      return;
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
