// 設計図どおりに 1 段ずつ下から建てる。
// 段ごとに: 邪魔なブロックをどける → その段の素材をそろえる（手持ちに入る分ずつ）→ 近い順に置く。
// 毎回いまの世界の状態を見て「設計図どおりか」を確かめるので、中断・再起動しても続きから建てられる。
import pathfinderPkg from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import { SkillError, abortable, equipCheapestTool, pickUpItems, cheapBlock, travelTo, pillarUp, ensurePickaxe } from '../skills/common.js';
import { count } from '../util/items.js';
import { SCAFFOLD_BLOCKS } from './acquire.js';
import { sleep } from '../body/humanize.js';
import { itemFor, matches, isAirName, isSecondaryHalf, placementHint, materialList, DIRS, yawFor } from './blocks.js';

const { goals } = pathfinderPkg;

// クリックすると開いてしまう（置けない）ブロック。しゃがんで置く代わりに、参照に使わない
const INTERACTIVE = /(chest|barrel|furnace|smoker|crafting_table|_door|_trapdoor|_bed|_button|lever|anvil|_shulker_box|hopper|dispenser|dropper|enchanting_table|brewing_stand|loom|stonecutter|grindstone|smithing_table|cartography_table|fletching_table|_sign|lectern|bell|repeater|comparator|note_block|jukebox|beacon|_fence_gate|cake|composter|cauldron|crafter|decorated_pot|chiseled_bookshelf)/;
const REPLACEABLE = /^(air|cave_air|void_air|short_grass|tall_grass|fern|large_fern|dead_bush|snow|water|lava|vine|glow_lichen|seagrass|tall_seagrass|short_dry_grass|tall_dry_grass|structure_void)$/;
const FACE_ORDER = ['up', 'north', 'south', 'east', 'west', 'down'];
const key = (p) => `${p.x},${p.y},${p.z}`;

// 置く位置の近く（手が届く）で、置く位置そのものとその真下には立たないゴール
class GoalPlaceNear extends goals.Goal {
  constructor(pos, range, forbid) {
    super();
    this.p = pos; this.range = range; this.forbid = forbid;
  }
  heuristic(node) {
    const dx = node.x - this.p.x; const dy = node.y - this.p.y; const dz = node.z - this.p.z;
    return Math.sqrt(dx * dx + dz * dz) + Math.abs(dy);
  }
  isEnd(node) {
    const eye = new Vec3(node.x + 0.5, node.y + 1.62, node.z + 0.5);
    if (eye.distanceTo(this.p.offset(0.5, 0.5, 0.5)) > this.range) return false;
    if (node.x === this.p.x && node.z === this.p.z && (node.y === this.p.y || node.y === this.p.y - 1)) return false;
    return !this.forbid?.(node);
  }
}

export class Builder {
  // schematic: parseLitematic の結果、origin: 設計図の最小角を置く世界座標
  // scaffolds / onScaffolds: 仮の足場の位置を仕事のファイルに残し、再起動しても片付けられるようにする
  constructor(ctx, { schematic, origin, supplier, clear = true, scaffolds = [], onScaffolds = null }) {
    this.ctx = ctx;
    this.schematic = schematic;
    this.origin = origin;
    this.supplier = supplier;
    this.clear = clear;
    this.targets = new Map(); // "x,y,z" -> { pos, name, props }
    for (const b of schematic.blocks) {
      const pos = origin.offset(b.x, b.y, b.z);
      this.targets.set(key(pos), { pos, name: b.name, props: b.props });
    }
    this.size = schematic.size;
    // 設計図に使うアイテム（足場に借りたり、捨てたりしない）
    this.needed = new Set();
    for (const t of this.targets.values()) { const it = itemFor(ctx.bot.registry, t); if (it) this.needed.add(it.item); }
    this.scaffolds = new Set(scaffolds); // 建てるために置いた仮の足場 "x,y,z"（最後に片付ける）
    this.onScaffolds = onScaffolds;
    this.deferred = new Map(); // 付ける先がまだ無くて後回しにしたマス "x,y,z" -> pos
    this.missing = new Map(); // 手に入らなかったアイテム -> 個数
    this.orientationOff = 0;
    this.placed = 0;
    this.layer = 0;
    this.selfPlacing = false;
    ctx.isBuildPos = (p) => this.inBox(p);
    // 素材を用意してもらったときは、柱上り・穴のふた・松明などで建築の素材を使わない
    ctx.bot.keepForBuild = supplier?.stocked ? (name) => this.needed.has(name) : undefined;
    ctx.leaveBuildArea = () => this.leaveArea();
  }

  get bot() { return this.ctx.bot; }
  get log() { return this.ctx.log; }

  inBox(p) {
    const o = this.origin;
    return p.x >= o.x && p.y >= o.y && p.z >= o.z && p.x < o.x + this.size.x && p.y < o.y + this.size.y && p.z < o.z + this.size.z;
  }

  // 建築範囲の周り（足場を片付ける範囲）
  nearBox(p, margin = 6) {
    const o = this.origin;
    return p.x >= o.x - margin && p.z >= o.z - margin && p.y >= o.y - margin
      && p.x < o.x + this.size.x + margin && p.z < o.z + this.size.z + margin && p.y < o.y + this.size.y + margin;
  }

  // 設計図の 1 マスが「置かなくてよい」状態か
  done(t) {
    if (isSecondaryHalf(t)) return true; // ドアの上半分・ベッドの頭は、下半分・足と一緒にできる
    if (!itemFor(this.bot.registry, t)) return true; // 置けないもの（水など）は数えない
    return matches(t, this.bot.blockAt(t.pos), { checkProps: false });
  }

  progress() {
    let total = 0; let ok = 0;
    for (const t of this.targets.values()) {
      if (!itemFor(this.bot.registry, t)) continue;
      total++;
      const b = this.bot.blockAt(t.pos);
      if (b ? matches(t, b, { checkProps: false }) : false) ok++;
    }
    return { total, ok };
  }

  get stocked() { return !!this.supplier?.stocked; }

  addScaffold(k) {
    if (this.scaffolds.has(k)) return;
    this.scaffolds.add(k);
    this.onScaffolds?.([...this.scaffolds]);
  }

  dropScaffold(k) {
    if (this.scaffolds.delete(k)) this.onScaffolds?.([...this.scaffolds]);
  }

  // まだ置いていないマスに要るアイテムと個数
  remainingNeed() {
    const need = new Map();
    for (const t of this.targets.values()) {
      if (this.done(t)) continue;
      const it = itemFor(this.bot.registry, t);
      need.set(it.item, (need.get(it.item) ?? 0) + it.count);
    }
    return need;
  }

  // まだ置けていないマス（最大 limit 個）
  unplaced(limit = 5) {
    const out = [];
    for (const t of this.targets.values()) {
      if (out.length >= limit) break;
      if (!this.done(t)) out.push(`${t.name}(${key(t.pos)})`);
    }
    return out;
  }

  // 手持ち＋チェストと比べて足りないもの（作れる物は材料があれば足りる扱い）
  shortage() {
    const out = [];
    for (const [item, n] of this.remainingNeed()) {
      const have = this.supplier ? this.supplier.available(item) : count(this.bot, item);
      if (have >= n) continue;
      // 1 個も無くても、チェストの材料から作れるなら足りる扱い（原木 → 板材 など。数までは見積もらない）
      if (have === 0 && this.supplier && Number.isFinite(this.supplier.estimate(item))) continue;
      out.push([item, n - have]);
    }
    return out.sort((a, b) => b[1] - a[1]);
  }

  materialSummary() {
    const { need, unplaceable } = materialList(this.bot.registry, this.schematic.blocks);
    return { need: [...need.entries()].sort((a, b) => b[1] - a[1]), unplaceable: [...unplaceable.entries()] };
  }

  // 経路探索に「建てた所を壊さない」「建物の中に勝手に足場を置かない」を教える
  installPathRules() {
    const mv = this.bot.pathfinder.movements;
    if (!mv || mv._builderRules) return;
    mv._builderRules = true;
    // はしごを登る経路は使わない（建てかけのはしごの上で行き止まりになり、「stuck」を繰り返して動けなくなった）
    mv.climbables = new Set();
    if (this.stocked) {
      // 用意してもらった建築素材を、移動の足場に使ってしまわない
      mv.scafoldingBlocks = SCAFFOLD_BLOCKS.filter((n) => !this.needed.has(n))
        .map((n) => this.bot.registry.itemsByName[n]?.id).filter((id) => id !== undefined);
    }
    mv.exclusionAreasBreak.push((block) => {
      const t = this.targets.get(key(block.position));
      if (t && matches(t, block, { checkProps: false })) return Infinity; // 建てたブロックは壊さない
      return 0;
    });
    mv.exclusionAreasPlace.push((block) => {
      if (!this.inBox(block.position)) return 0;
      const t = this.targets.get(key(block.position));
      return t ? 0 : 20; // 空気のはずの所に置くのは、他に道が無いときだけ
    });
    // 自分の設置以外（経路探索の足場・柱）で置いたものは、最後に片付ける対象として覚える
    this.bot.on('blockPlaced', (_old, nb) => {
      if (this.selfPlacing || !nb || !this.nearBox(nb.position)) return;
      const t = this.targets.get(key(nb.position));
      if (!t || t.name !== nb.name) this.addScaffold(key(nb.position));
    });
  }

  async run() {
    const { bot, ctx } = this;
    this.installPathRules();
    await this.returnToSite();
    const ys = this.size.y;
    for (let y = 0; y < ys; y++) {
      abortable(ctx);
      this.layer = y;
      const wy = this.origin.y + y;
      const layer = [...this.targets.values()].filter((t) => t.pos.y === wy && !this.done(t));
      if (this.clear) await this.clearLayer(wy);
      if (layer.length === 0) continue;
      const p = this.progress();
      this.log.info(`段 ${y + 1}/${ys}（y=${wy}）: ${layer.length} 個を置く（全体 ${p.ok}/${p.total}）`);
      await this.buildLayer(layer);
    }
    // 後回しにしたもの（上の段ができてから付ける上付きハーフブロック・壁の松明など）を置く
    for (let sweep = 0; sweep < 3 && this.deferred.size > 0; sweep++) {
      const list = [...this.deferred.values()].filter((p) => !this.done(this.targets.get(key(p))));
      this.deferred.clear();
      if (list.length === 0) break;
      this.log.info(`後回しにした ${list.length} 個を置く`);
      this.layer = this.size.y - 1;
      const before = this.placed;
      await this.buildLayer(list.map((p) => this.targets.get(key(p))));
      if (this.placed === before) break;
    }
    await this.cleanupScaffolds();
    if (this.stocked) await this.returnLeftovers().catch((e) => { if (e.name === 'AbortError') throw e; this.log.warn(`余りを戻せなかった: ${e.message}`); });
    const p = this.progress();
    return { ...p, missing: [...this.missing.entries()], orientationOff: this.orientationOff };
  }

  // 現場から離れていたら（死んで初期スポーンに戻った・素材集めで遠出した）、まず戻る
  async returnToSite() {
    const { bot } = this;
    const c = this.origin.offset(this.size.x / 2, 0, this.size.z / 2);
    const far = () => Math.hypot(bot.entity.position.x - c.x, bot.entity.position.z - c.z) > Math.max(this.size.x, this.size.z) / 2 + 16;
    if (!far()) return;
    this.log.info(`建築現場 (${Math.floor(c.x)}, ${Math.floor(c.z)}) へ戻る`);
    await travelTo(this.ctx, c.x, c.z, { range: 6 });
  }

  // 建築範囲（と周り 3 マス）の外の地面へ出る。穴ごもりや採掘で建物を掘らないように使う
  async leaveArea(margin = 3) {
    const { bot } = this;
    const p = bot.entity.position;
    if (!this.nearBox(p.floored(), margin)) return;
    const o = this.origin;
    // いちばん近い辺の外側へ
    const cands = [
      [o.x - margin - 3, p.z], [o.x + this.size.x + margin + 3, p.z],
      [p.x, o.z - margin - 3], [p.x, o.z + this.size.z + margin + 3],
    ].sort((a, b) => Math.hypot(a[0] - p.x, a[1] - p.z) - Math.hypot(b[0] - p.x, b[1] - p.z));
    this.log.info('建築範囲の外へ出る');
    for (const [x, z] of cands.slice(0, 2)) {
      const ok = await Promise.race([
        bot.pathfinder.goto(new goals.GoalNearXZ(x, z, 2)).then(() => true, (e) => { if (e.name === 'AbortError') throw e; return false; }),
        sleep(40_000).then(() => false),
      ]);
      try { bot.pathfinder.setGoal(null); } catch {}
      if (ok && !this.nearBox(bot.entity.position.floored(), margin)) return;
    }
  }

  // 空気のはずのマスにある固いブロック（地形・木）をどける
  async clearLayer(wy) {
    const { bot, ctx } = this;
    const list = [];
    for (let x = 0; x < this.size.x; x++) {
      for (let z = 0; z < this.size.z; z++) {
        const p = new Vec3(this.origin.x + x, wy, this.origin.z + z);
        if (this.targets.has(key(p))) continue;
        const b = bot.blockAt(p);
        // canDigBlock は手が届く距離かどうかも見るので使わない（遠くの邪魔なブロックを見落とし、木の葉が残っていた）
        if (b && b.boundingBox === 'block' && !isAirName(b.name) && b.diggable && b.name !== 'bedrock') list.push(p);
      }
    }
    if (list.length === 0) return;
    this.log.info(`y=${wy} の邪魔なブロック ${list.length} 個をどける`);
    await this.forEachNearest(list, async (p) => {
      const b = bot.blockAt(p);
      if (!b || b.boundingBox !== 'block') return;
      await this.reach(p);
      await equipCheapestTool(bot, b).catch(() => {});
      await this.dig(bot.blockAt(p)).catch((e) => { if (e.name === 'AbortError') throw e; this.log.warn(`どけられなかった (${key(p)}): ${e.message}`); });
      this.dropScaffold(key(p));
    });
    await pickUpItems(ctx, 6).catch(() => {});
  }

  async buildLayer(layer) {
    const { bot } = this;
    // 素材は手持ちに入る分ずつ（1 回に 20 スタック分まで）そろえて置く
    let rest = layer;
    while (rest.length > 0) {
      abortable(this.ctx);
      const chunk = [];
      const stacks = new Map();
      for (const t of rest) {
        const it = itemFor(bot.registry, t);
        if (!it) continue;
        const s = (stacks.get(it.item) ?? 0) + it.count;
        const total = [...stacks.entries()].reduce((a, [n, c]) => a + Math.ceil((n === it.item ? s : c) / 64), 0);
        if (total > 20 && chunk.length > 0) break;
        stacks.set(it.item, s);
        chunk.push(t);
      }
      rest = rest.slice(chunk.length);
      const usable = await this.gather(stacks);
      const todo = chunk.filter((t) => usable.has(itemFor(bot.registry, t).item));
      await this.forEachNearest(todo.map((t) => t.pos), async (p) => {
        const t = this.targets.get(key(p));
        if (!this.done(t)) await this.placeTarget(t);
      }, { supportedFirst: true });
    }
  }

  // 必要な素材をそろえる。そろえられたアイテム名の集合を返す（足りないものは後回しにして記録）
  async gather(stacks) {
    const { bot } = this;
    const usable = new Set();
    await this.tidyInventory(stacks);
    if (this.supplier) await this.supplier.scanChests().catch((e) => this.log.warn(`チェストを調べられなかった: ${e.message}`));
    // 素材が足りなければ、少し前に調べたチェストも見直す（建築中に足してもらった分に気づく）
    if (this.supplier && [...stacks.entries()].some(([item, n]) => this.supplier.available(item) < n)) {
      await this.supplier.scanChests({ refreshMs: this.stocked ? 60_000 : 300_000 }).catch((e) => this.log.warn(`チェストを調べられなかった: ${e.message}`));
    }
    // ある素材を作るときに、同じ段で使う別の素材（板材を作ると原木が減る など）を使ってしまうことがあるので、
    // そろうまで最大 3 周数え直す
    const failed = new Set();
    for (let pass = 0; pass < 3; pass++) {
      const short = [...stacks.entries()].filter(([item, n]) => count(bot, item) < n && !failed.has(item));
      if (short.length === 0) break;
      for (const [item, n] of short.sort((a, b) => a[1] - b[1])) {
        abortable(this.ctx);
        if (count(bot, item) >= n || !this.supplier) continue;
        // 手間が大きすぎるもの（エメラルドブロック 600 個を鉱石から など）は自分では集めず、チェストに入れてもらう
        const lack = n - count(bot, item);
        const effort = this.supplier.estimate(item) * lack;
        const budget = this.ctx.cfg?.gatherBudget ?? 800;
        if (effort > budget && this.supplier.chestCount(item) < lack) {
          failed.add(item);
          this.missing.set(item, Math.max(this.missing.get(item) ?? 0, lack - this.supplier.chestCount(item)));
          if (this.supplier.chestCount(item) > 0) await this.supplier.takeFromChests(item, lack).catch(() => {});
          if (this.stocked) this.log.warn(`${item} が手持ちとチェストに ${n - count(bot, item)} 個足りない。チェストに入れてください`);
          else this.log.warn(`${item} ×${lack} は自分で集めるには多すぎる（手間 ${Math.round(effort)}）。チェストに入れてください`);
          continue;
        }
        try {
          this.log.info(`素材を用意: ${item} ×${n}（手持ち ${count(bot, item)}）`);
          await this.supplier.ensure(item, n);
        } catch (e) {
          if (e.name === 'AbortError' || this.ctx.signal?.aborted) throw e;
          failed.add(item);
          const lack = n - count(bot, item);
          this.missing.set(item, Math.max(this.missing.get(item) ?? 0, lack));
          this.log.warn(`${item} が ${lack} 個足りない（${e.message}）。ある分だけ置いて先に進む`);
        }
      }
    }
    if (this.stocked) {
      await this.topUp(stacks).catch((e) => { if (e.name === 'AbortError') throw e; });
      // 2 段目から上は、登ったり下に支えを作ったりする足場のブロックを持っておく（建築の素材は足場に使わないので）
      if (this.layer >= 1 && this.spareScaffold() < 16) {
        await this.supplier.ensureScaffold(32, this.needed).catch((e) => { if (e.name === 'AbortError') throw e; });
      }
    }
    for (const item of stacks.keys()) if (count(bot, item) > 0) usable.add(item);
    return usable;
  }

  // 素材を用意してもらったときは、チェストとの往復を減らすため、この先の段で使う分も持っていく。
  // まずスタックの端数を埋め（場所を取らない）、持ち物に余裕があれば丸ごとのスタックも足す（8 枠は空けておく）
  async topUp(stacks) {
    const { bot } = this;
    const remain = this.remainingNeed();
    let spare = Math.max(0, bot.inventory.emptySlotCount() - 8);
    for (const item of stacks.keys()) {
      const have = count(bot, item);
      const rest = (remain.get(item) ?? 0) - have;
      if (rest <= 0 || this.supplier.chestCount(item) <= 0) continue;
      const size = bot.registry.itemsByName[item]?.stackSize ?? 64;
      const partial = (size - (have % size)) % size;
      const more = Math.min(spare, Math.ceil(Math.max(0, rest - partial) / size));
      spare -= more;
      const want = Math.min(rest, partial + more * size, this.supplier.chestCount(item));
      if (want > 0) await this.supplier.takeFromChests(item, want);
    }
  }

  // 持ち物がいっぱいなら、建築に使わない物（余った土・石・苗木など）を捨てる
  async tidyInventory(stacks) {
    const { bot } = this;
    if (bot.inventory.emptySlotCount() >= 6) return;
    const needed = new Set([...stacks.keys(), ...this.needed]);
    // 用意された素材のうち、いまの分で使わない物はチェストへ戻して場所を空ける（捨てない）
    if (this.stocked && this.supplier) {
      for (const it of bot.inventory.items()) {
        if (bot.inventory.emptySlotCount() >= 8) break;
        if (!this.needed.has(it.name) || stacks.has(it.name)) continue;
        await this.supplier.depositToChests(it.name, count(bot, it.name));
      }
    }
    const keep = /(_pickaxe|_axe|_shovel|_sword|_hoe|shears|crafting_table|furnace|_log|_planks|stick|coal|charcoal|torch|bucket|helmet|chestplate|leggings|boots|shield)$/;
    const scaffoldKeep = { dirt: 64, cobblestone: 64 };
    for (const it of bot.inventory.items()) {
      if (bot.inventory.emptySlotCount() >= 8) break;
      if (needed.has(it.name) || keep.test(it.name) || bot.autoEat?.foodsByName?.[it.name]) continue;
      const k = scaffoldKeep[it.name];
      if (k !== undefined && count(bot, it.name) <= k) continue;
      this.log.info(`持ち物がいっぱいなので ${it.name} ×${it.count} を捨てる`);
      await bot.tossStack(it).catch(() => {});
    }
  }

  // 近い順（足場がある所を先に）に処理する
  async forEachNearest(positions, fn, { supportedFirst = false } = {}) {
    const { bot } = this;
    const left = new Map(positions.map((p) => [key(p), p]));
    let fails = 0;
    while (left.size > 0) {
      abortable(this.ctx);
      const me = bot.entity.position;
      let best = null; let bestScore = Infinity;
      for (const p of left.values()) {
        let s = p.distanceTo(me);
        if (supportedFirst && !this.findReference(p, this.targets.get(key(p)))) s += 40;
        if (s < bestScore) { bestScore = s; best = p; }
      }
      left.delete(key(best));
      const t0 = Date.now();
      try {
        await fn(best);
        if (process.env.BUILD_DEBUG && Date.now() - t0 > 2000) this.log.info(`[遅い] (${key(best)}) ${Date.now() - t0}ms ${this.lastStep ?? ''}`);
        fails = 0;
      } catch (e) {
        if (e.name === 'AbortError' || this.ctx.signal?.aborted) throw e;
        if (e.deferred) { this.deferred.set(key(best), best); continue; }
        this.log.warn(`(${key(best)}) で失敗: ${e.message}`);
        if (++fails >= 12) throw new SkillError('失敗が続いたので、この段をいったん中断する');
      }
    }
  }

  // 掘る。終わらないまま待ち続けないよう 20 秒で打ち切る（試験で、掘る途中のまま 8 分止まり、
  // 落ち葉の苗木を拾い続けて「動きが無い」の見張りにも引っかからなかった）
  async dig(block) {
    const { bot } = this;
    if (!block || isAirName(block.name)) return;
    // ツルハシで掘るブロック（石など）なのにツルハシが無ければ、先に用意する（使い潰したあと素手で掘ると 10 倍以上遅い）
    if (/pickaxe/.test(block.material ?? '') && !bot.inventory.items().some((i) => i.name.endsWith('_pickaxe'))) {
      if (this.stocked) await this.supplier.ensurePickaxeStocked((n) => this.spareInv(n));
      else await ensurePickaxe(this.ctx).catch(() => {});
      await equipCheapestTool(bot, block).catch(() => {});
    }
    let timer;
    try {
      await Promise.race([
        bot.dig(block, true),
        new Promise((_, rej) => { timer = setTimeout(() => { try { bot.stopDigging(); } catch {} rej(new SkillError(`${block.name} を掘り終わらない`)); }, 20_000); }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  // 置く位置に手が届くところまで行く。経路探索で行けなければ、近くに柱を積んで登る
  async reach(p, range = 4.2) {
    const { bot } = this;
    const t0 = Date.now();
    try { await this.reachInner(p, range); } finally { this.lastStep = `reach ${Date.now() - t0}ms`; }
  }

  async reachInner(p, range) {
    const { bot } = this;
    const eye = () => bot.entity.position.offset(0, 1.62, 0);
    const inside = () => {
      const f = bot.entity.position.floored();
      return f.x === p.x && f.z === p.z && (f.y === p.y || f.y === p.y - 1);
    };
    if (eye().distanceTo(p.offset(0.5, 0.5, 0.5)) <= range && !inside()) return;
    try {
      await this.pathTo(p, range);
    } catch (e) {
      if (e.name === 'AbortError' || this.ctx.signal?.aborted) throw e;
      // 高い所（塔の壁の上の段など）は、近くに仮の柱を積んで、その上から置く
      if (p.y - bot.entity.position.y >= 2 && (await this.climbNear(p, range))) return;
      throw e;
    }
  }

  async pathTo(p, range) {
    const { bot } = this;
    // 建物の中の低い所（空洞）には立たない（閉じ込められないように）
    const forbid = (node) => this.inBox(node) && node.y < this.origin.y + this.layer - 1
      && !this.targets.has(key(new Vec3(node.x, node.y - 1, node.z)));
    let timer;
    let fail;
    // 近づけなかったときに理由が分かるよう、経路探索の結果を覚えておく。
    // 経路はあるのに動けない（stuck）が続くときは、25 秒待たずにあきらめる
    const seen = { updates: 0, status: '', len: 0, resets: [] };
    const from = bot.entity.position.floored();
    const why = () => `近づけない（${from} から、経路 ${seen.updates} 回: ${seen.status} 長さ ${seen.len}、やり直し: ${seen.resets.join('/') || 'なし'}）`;
    const onUpdate = (r) => { seen.updates++; seen.status = r.status; seen.len = r.path.length; };
    const onReset = (reason) => {
      if (seen.resets.length < 6) seen.resets.push(reason);
      if (seen.resets.filter((r) => r === 'stuck').length >= 3) fail?.(new Error(why()));
    };
    bot.on('path_update', onUpdate);
    bot.on('path_reset', onReset);
    try {
      await Promise.race([
        bot.pathfinder.goto(new GoalPlaceNear(p, range, forbid)),
        new Promise((_, rej) => {
          fail = rej;
          timer = setTimeout(() => rej(new Error(why())), 25_000);
        }),
      ]);
    } catch (e) {
      try { bot.pathfinder.setGoal(null); } catch {}
      throw e;
    } finally {
      clearTimeout(timer);
      bot.off('path_update', onUpdate);
      bot.off('path_reset', onReset);
    }
  }

  // p の横（2 マス以内）に仮の柱を積み、p と同じ高さに立つ。柱は足場として記録され、最後に片付ける
  async climbNear(p, range) {
    const { bot } = this;
    const center = p.offset(0.5, 0.5, 0.5);
    const free = (b) => b && b.boundingBox === 'empty' && !/(water|lava|ladder|vine|scaffolding|fire)/.test(b.name);
    const cands = [];
    for (let dx = -2; dx <= 2; dx++) {
      for (let dz = -2; dz <= 2; dz++) {
        if (dx === 0 && dz === 0) continue;
        const c = new Vec3(p.x + dx, p.y, p.z + dz);
        if (new Vec3(c.x + 0.5, c.y + 1.62, c.z + 0.5).distanceTo(center) > range) continue;
        if (!free(bot.blockAt(c)) || !free(bot.blockAt(c.offset(0, 1, 0))) || !free(bot.blockAt(c.offset(0, 2, 0)))) continue;
        // 柱の土台（真下でいちばん上の固いブロック）
        let g = null;
        for (let y = c.y - 1; y >= c.y - 24; y--) {
          const b = bot.blockAt(new Vec3(c.x, y, c.z));
          if (!b || /(water|lava)/.test(b.name)) break;
          if (b.boundingBox === 'block') { g = y; break; }
        }
        if (g === null) continue;
        // 柱を立てるマス・立つマスが、まだ置いていない設計図のマスなら避ける（あとで置けなくなる）
        let blocked = false;
        for (let y = g + 1; y <= c.y + 1 && !blocked; y++) {
          const t = this.targets.get(key(new Vec3(c.x, y, c.z)));
          if (t && !this.done(t)) blocked = true;
        }
        if (blocked) continue;
        const h = c.y - 1 - g;
        cands.push({ c, g, h, score: h * 2 + (this.inBox(c) ? 4 : 0) + Math.hypot(dx, dz) + bot.entity.position.distanceTo(c) / 4 });
      }
    }
    cands.sort((a, b) => a.score - b.score);
    for (const { c, g, h } of cands.slice(0, 4)) {
      abortable(this.ctx);
      if (this.stocked && this.spareScaffold() < h) await this.supplier.ensureScaffold(h + 8, this.needed);
      const base = new Vec3(c.x, g + 1, c.z);
      this.log.info(`(${key(p)}) に届かないので、(${key(base)}) に ${h} 段の柱を積んで登る`);
      try {
        const f = bot.entity.position.floored();
        if (f.x !== base.x || f.z !== base.z || f.y !== base.y) {
          let timer;
          try {
            await Promise.race([
              bot.pathfinder.goto(new goals.GoalBlock(base.x, base.y, base.z)),
              new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('柱の場所へ行けない')), 20_000); }),
            ]);
          } finally {
            clearTimeout(timer);
            try { bot.pathfinder.setGoal(null); } catch {}
          }
        }
        await pillarUp(this.ctx, h);
        await bot.waitForTicks(4);
        if (bot.entity.position.offset(0, 1.62, 0).distanceTo(center) <= range) return true;
        this.log.warn(`柱で登りきれなかった（いま ${bot.entity.position.floored()}）`);
      } catch (e) {
        if (e.name === 'AbortError' || this.ctx.signal?.aborted) throw e;
        this.log.warn(`柱を積めなかった: ${e.message}`);
      }
    }
    return false;
  }

  // 参照にできる隣のブロック（固くて、クリックしても開かないもの）と、その面を探す
  findReference(p, t) {
    const { bot } = this;
    const hint = t ? placementHint(t) : {};
    let faces = hint.faces ?? FACE_ORDER;
    if (hint.half === 'top') faces = faces.filter((f) => f !== 'up');
    if (hint.half === 'bottom' && !hint.faces) faces = faces.filter((f) => f !== 'down');
    for (const f of faces) {
      const d = DIRS[f];
      const ref = bot.blockAt(p.offset(-d[0], -d[1], -d[2]));
      if (!ref || ref.boundingBox !== 'block' || INTERACTIVE.test(ref.name)) continue;
      return { ref, face: new Vec3(d[0], d[1], d[2]), hint };
    }
    return null;
  }

  // 下に足場が無いブロックのために、真下へ地面まで仮の足場を積む
  async ensureSupport(p, t) {
    const { bot } = this;
    if (this.findReference(p, t)) return;
    // 壁に付ける松明・上付きハーフブロックなど、下の面には付けられないものは、下に足場を積んでも置けない。
    // 付ける先のブロック（同じ段の壁や上の段）ができてから置くので、いまは後回しにする
    const hint = t ? placementHint(t) : {};
    const faces = hint.faces ?? FACE_ORDER;
    if (!faces.includes('up') || hint.half === 'top') {
      const e = new SkillError('付ける先のブロックがまだ無いので後回し');
      e.deferred = true;
      throw e;
    }
    const column = [];
    let q = p.offset(0, -1, 0);
    for (let i = 0; i < 64; i++, q = q.offset(0, -1, 0)) {
      const b = bot.blockAt(q);
      if (!b) break;
      if (b.boundingBox === 'block') break;
      column.push(q);
    }
    this.log.info(`(${key(p)}) の下に支えが無いので、仮の足場を ${column.length} 段積む`);
    for (const c of column.reverse()) {
      abortable(this.ctx);
      const item = this.pickScaffold() ?? (await this.scaffoldItem());
      if (!item) throw new SkillError('足場にするブロックが無い');
      await this.placeAt(c, { name: item.name, props: {} }, item.name);
      this.addScaffold(key(c));
    }
  }

  // 手持ちのうち、建築に使う分（チェストに残っている分を除く）を差し引いた余り
  spareInv(name) {
    const have = count(this.bot, name);
    if (!this.needed.has(name)) return have;
    if (!this.remainCache || Date.now() - this.remainCache.at > 5000) this.remainCache = { at: Date.now(), need: this.remainingNeed() };
    const need = this.remainCache.need.get(name) ?? 0;
    return have - Math.max(0, need - (this.supplier?.chestCount(name) ?? 0));
  }

  spareScaffold() {
    return SCAFFOLD_BLOCKS.reduce((s, n) => s + (this.needed.has(n) ? 0 : count(this.bot, n)), 0);
  }

  // 足場にする手持ちのブロック。素材を用意してもらったときは、建築に使う物を避ける
  pickScaffold() {
    if (!this.stocked) return cheapBlock(this.bot);
    const items = this.bot.inventory.items();
    for (const n of SCAFFOLD_BLOCKS) {
      if (this.needed.has(n)) continue;
      const it = items.find((i) => i.name === n);
      if (it) return it;
    }
    return null;
  }

  async scaffoldItem() {
    if (!this.supplier) return null;
    if (this.stocked) {
      await this.supplier.ensureScaffold(16, this.needed);
      return this.pickScaffold() ?? cheapBlock(this.bot);
    }
    await this.supplier.ensure('dirt', 32).catch(() => this.supplier.ensure('cobblestone', 32));
    return cheapBlock(this.bot);
  }

  // 建て終わったら、余った素材と足場のブロックをチェストへ戻す
  async returnLeftovers() {
    const { bot } = this;
    await this.supplier.scanChests().catch(() => {});
    const names = new Set(bot.inventory.items().map((i) => i.name)
      .filter((n) => this.needed.has(n) || SCAFFOLD_BLOCKS.includes(n)));
    if (names.size === 0) return;
    this.log.info(`余った素材をチェストに戻す: ${[...names].map((n) => `${n}×${count(bot, n)}`).join(', ')}`);
    for (const n of names) await this.supplier.depositToChests(n, count(bot, n));
  }

  async placeTarget(t) {
    const { bot } = this;
    const it = itemFor(bot.registry, t);
    if (!it || count(bot, it.item) <= 0) return;
    const p = t.pos;
    // 違うブロックがあればどける（仮の足場・地形・間違えて置いた物）
    const cur = bot.blockAt(p);
    if (cur && !REPLACEABLE.test(cur.name) && !matches(t, cur, { checkProps: false })) {
      await this.reach(p);
      await equipCheapestTool(bot, cur).catch(() => {});
      await this.dig(bot.blockAt(p));
      this.dropScaffold(key(p));
      await bot.waitForTicks(2);
    }
    // ドアなど 2 マスの高さのものは、上のマスも空いていないと置けない（上の段の地形がまだ残っていることがある）
    if (t.props?.half === 'lower') {
      const up = p.offset(0, 1, 0);
      const ub = bot.blockAt(up);
      if (ub && !REPLACEABLE.test(ub.name) && ub.boundingBox === 'block') {
        await this.reach(up);
        await equipCheapestTool(bot, ub).catch(() => {});
        await this.dig(bot.blockAt(up));
        this.dropScaffold(key(up));
        await bot.waitForTicks(2);
      }
    }
    await this.ensureSupport(p, t);
    try {
      await this.placeAt(p, t, it.item);
    } catch (e) {
      // 落ち葉など、上書きできると思っていたものに断られたら、掘ってから置き直す
      const still = /the block is still (w+)/.exec(e.message)?.[1];
      if (!still || isAirName(still)) throw e;
      const b = bot.blockAt(p);
      await equipCheapestTool(bot, b).catch(() => {});
      await this.dig(b);
      await bot.waitForTicks(2);
      await this.placeAt(p, t, it.item);
    }
    // 半ブロック 2 枚重ね
    if (t.props?.type === 'double' && t.name.endsWith('_slab') && bot.blockAt(p)?.getProperties?.().type !== 'double') {
      await this.placeAt(p, { ...t, props: { ...t.props, type: 'top' } }, it.item, { onto: true }).catch(() => {});
    }
    const now = bot.blockAt(p);
    if (matches(t, now, { checkProps: false })) {
      this.placed++;
      if (!matches(t, now)) this.orientationOff++;
    }
  }

  // 1 ブロック置く。向きの希望があれば、その向きを向いてから置く
  async placeAt(p, t, itemName, { onto = false } = {}) {
    const { bot } = this;
    await this.reach(p);
    let r = this.findReference(p, t);
    if (onto) {
      // 半ブロックの上に重ねる: 下半分の半ブロックの上面をクリック
      const below = bot.blockAt(p);
      r = { ref: below, face: new Vec3(0, 1, 0), hint: {} };
    }
    if (!r) throw new SkillError('置くための足場が無い');
    const item = bot.inventory.items().find((i) => i.name === itemName);
    if (!item) throw new SkillError(`${itemName} を持っていない`);
    // 自分の体と重なるなら少しどく
    const f = bot.entity.position.floored();
    if (f.x === p.x && f.z === p.z && (f.y === p.y || f.y + 1 === p.y)) await this.reach(p);
    await bot.equip(item, 'hand');
    const { hint } = r;
    let forceLook = true;
    if (hint.look !== undefined || hint.yaw !== undefined || hint.pitch !== undefined) {
      const yaw = hint.yaw ?? (hint.look ? yawFor(hint.look) : bot.entity.yaw);
      // force=true だと mineflayer は向きをサーバーに送らない（置いたときの向きがずれた）。送り終わるまで待つ
      await bot.look(yaw, hint.pitch ?? 0, false);
      await bot.waitForTicks(1);
      forceLook = 'ignore';
    }
    this.selfPlacing = true;
    try {
      await bot._placeBlockWithOptions(r.ref, r.face, { half: hint.half, swingArm: 'right', forceLook });
    } finally {
      this.selfPlacing = false;
    }
    await sleep(60);
  }

  // 仮の足場を上から順に片付ける
  async cleanupScaffolds() {
    const { bot } = this;
    const list = [...this.scaffolds].map((k) => { const [x, y, z] = k.split(',').map(Number); return new Vec3(x, y, z); })
      .filter((p) => { const t = this.targets.get(key(p)); const b = bot.blockAt(p); return b && b.boundingBox === 'block' && !(t && matches(t, b, { checkProps: false })); })
      .sort((a, b) => b.y - a.y);
    if (list.length === 0) return;
    this.log.info(`仮の足場 ${list.length} 個を片付ける`);
    for (const p of list) {
      abortable(this.ctx);
      try {
        await this.reach(p);
        const b = bot.blockAt(p);
        if (b && b.boundingBox === 'block') {
          await equipCheapestTool(bot, b).catch(() => {});
          await this.dig(b);
        }
        this.dropScaffold(key(p));
      } catch (e) {
        if (e.name === 'AbortError' || this.ctx.signal?.aborted) throw e;
        this.log.warn(`足場 (${key(p)}) を片付けられなかった: ${e.message}`);
      }
    }
    await pickUpItems(this.ctx, 8).catch(() => {});
  }
}
