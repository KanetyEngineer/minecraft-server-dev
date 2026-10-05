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
// ドア（トラップドアは含まない）。経路探索はドアを通れないので、ドアは最後に置く
const isDoor = (t) => /_door$/.test(t.name);
// 掘っても自分自身を落とさない（壊すと素材がなくなる）ブロック
const FRAGILE = /(glass|ice$|_leaves$|glowstone|sea_lantern|bookshelf|_coral|turtle_egg|beehive|bee_nest)/;
// 建てたブロックを経路探索が壊すときの手間。ふつうは壊さない（Infinity）。建物の中に閉じ込められて外へ歩いて出られない
// ときだけ（ctx.allowEscape）、ドア → 壁の順に壊して外へ出る（壊したマスは、あとの見直しで置き直す）
const escapeCost = (t) => (isDoor(t) ? 30 : FRAGILE.test(t.name) ? Infinity : 90);

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
    this.protectedKeys = new Set(); // 経路探索で壊さないマス（リスポーン地点のベッドなど）
    this.missing = new Map(); // 手に入らなかったアイテム -> 個数
    this.orientationOff = 0;
    this.placed = 0;
    this.layer = 0;
    this.selfPlacing = false;
    ctx.isBuildPos = (p) => this.inBox(p);
    // 建物の真下（と周り 2 マス）。穴ごもりの穴をここに掘ると、朝に建物の床の下から出られなくなった
    ctx.isUnderBuild = (p) => {
      const o = this.origin;
      return p.x >= o.x - 2 && p.z >= o.z - 2 && p.x < o.x + this.size.x + 2 && p.z < o.z + this.size.z + 2
        && p.y < o.y + this.size.y && p.y >= o.y - 8;
    };
    ctx.isEnclosed = () => this.isEnclosed();
    // 素材を用意してもらったときは、柱上り・穴のふた・松明などで建築の素材を使わない
    ctx.bot.keepForBuild = supplier?.stocked ? (name) => this.needed.has(name) : undefined;
    ctx.leaveBuildArea = () => this.leaveArea();
    if (supplier) supplier.reserve = (name) => (this.needed.has(name) ? this.remaining().get(name) ?? 0 : 0);
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

  // 経路探索に「建てた所を壊さない」「建物の中に勝手に足場を置かない」を教える。
  // ルールは Movements に 1 回だけ足し、中身はいま建てている Builder（mv._builder）を見る
  // （前は最初の Builder を見続けていたので、同じ起動のまま 2 つ目の建物を建てると、建てたブロックを経路探索が壊せた）
  installPathRules() {
    const mv = this.bot.pathfinder.movements;
    if (!mv) return;
    mv._builder = this;
    if (this.stocked) {
      // 用意してもらった建築素材を、移動の足場に使ってしまわない
      mv.scafoldingBlocks = SCAFFOLD_BLOCKS.filter((n) => !this.needed.has(n))
        .map((n) => this.bot.registry.itemsByName[n]?.id).filter((id) => id !== undefined);
    }
    if (mv._builderRules) return;
    mv._builderRules = true;
    if (process.env.BUILD_DEBUG) {
      // 経路探索が足場を置けない（place_error）理由を見るため、置けなかったときの理由を出す
      const orig = this.bot.placeBlock.bind(this.bot);
      this.bot.placeBlock = async (ref, face) => {
        try { return await orig(ref, face); } catch (e) { this.log.info(`[置けない] ${ref?.name} ${ref?.position} 面 ${face}: ${e.message}`); throw e; }
      };
    }
    // はしごは経路探索に使わせる（使えないと、はしごのマスを壊して通っていた）。建てかけのはしごの上で
    // 行き止まりになって「stuck」が続くときは、pathTo が早めにあきらめて、柱を積んで登る方に切り替える
    mv.exclusionAreasBreak.push((block) => {
      const b = mv._builder;
      if (!b) return 0;
      if (b.protectedKeys.has(key(block.position))) return Infinity;
      const t = b.targets.get(key(block.position));
      if (t && matches(t, block, { checkProps: false })) {
        // 道具が無いと何も落とさないブロック（ツルハシの無いときの石レンガなど）も壊さない
        const tools = block.harvestTools ? Object.keys(block.harvestTools).map(Number) : null;
        if (tools && !b.bot.inventory.items().some((i) => tools.includes(i.type))) return Infinity;
        return b.ctx.allowEscape ? escapeCost(t) : Infinity;
      }
      return 0;
    });
    mv.exclusionAreasPlace.push((block) => {
      const b = mv._builder;
      if (!b || !b.inBox(block.position)) return 0;
      return b.targets.has(key(block.position)) ? 0 : 20; // 空気のはずの所に置くのは、他に道が無いときだけ
    });
    // 自分の設置以外（経路探索の足場・柱）で置いたものは、最後に片付ける対象として覚える
    this.bot.on('blockPlaced', (_old, nb) => {
      const b = mv._builder;
      if (!b || b.selfPlacing || !nb || !b.nearBox(nb.position)) return;
      const t = b.targets.get(key(nb.position));
      if (!t || t.name !== nb.name) b.addScaffold(key(nb.position));
    });
  }

  async run() {
    const { bot, ctx } = this;
    this.installPathRules();
    // 経路探索の「その場で跳んで足元に置く」柱上りは、この鯖ではサーバーに断られて（the block is still air）
    // 失敗を繰り返すことが多かった。建てている間は使わせず、高い所へは climbNear の柱上り（確実に置ける）で登る
    const mv = bot.pathfinder.movements;
    const towers = mv?.allow1by1towers;
    if (mv) mv.allow1by1towers = false;
    try {
      return await this.runInner();
    } finally {
      if (mv) mv.allow1by1towers = towers;
    }
  }

  async runInner() {
    const { bot, ctx } = this;
    await this.returnToSite();
    const ys = this.size.y;
    for (let y = 0; y < ys; y++) {
      abortable(ctx);
      this.layer = y;
      const wy = this.origin.y + y;
      const layer = [...this.targets.values()].filter((t) => t.pos.y === wy && !this.done(t) && !isDoor(t));
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
    await this.placeDoors();
    if (this.stocked) await this.returnLeftovers().catch((e) => { if (e.name === 'AbortError') throw e; this.log.warn(`余りを戻せなかった: ${e.message}`); });
    // 途中で一度取れなかった（チェストに近づけなかった など）だけで、いまは手持ちとチェストにそろっている素材は「足りない」としない
    if (this.supplier && this.missing.size) {
      const remain = this.remainingNeed();
      for (const item of [...this.missing.keys()]) {
        const lack = (remain.get(item) ?? 0) - this.supplier.available(item);
        if (lack <= 0) this.missing.delete(item); else this.missing.set(item, lack);
      }
    }
    const p = this.progress();
    return { ...p, missing: [...this.missing.entries()], orientationOff: this.orientationOff };
  }

  // ドアを置く。建物の中に閉じ込められないよう、ほかを全部建てて足場も片付けてから、なるべく外に立って置く
  async placeDoors() {
    const doors = [...this.targets.values()].filter((t) => isDoor(t) && !this.done(t));
    if (doors.length === 0) return;
    this.log.info(`最後にドア ${doors.length} 枚を置く`);
    this.layer = this.size.y - 1;
    this.preferOutside = true;
    try {
      await this.buildLayer(doors);
    } finally {
      this.preferOutside = false;
    }
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
        const t = this.targets.get(key(p));
        // ドアのマスは最後まで空けておく（出入り口にする）ので、地形があればどける
        if (t && !(isDoor(t) && !/_door$/.test(bot.blockAt(p)?.name ?? ''))) continue;
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
    // 丸ごとのスタックは 1 回に 4 つまで（たくさん持ち歩くと、倒されたときに失う量も増える）
    let spare = Math.min(4, Math.max(0, bot.inventory.emptySlotCount() - 8));
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
      if (this.preferOutside) {
        // ドアは建物の外に立って置く（中から置くと閉じ込められる）。外から届かなければ中からでもよい
        try {
          await this.pathTo(p, range, (node) => this.inBox(node));
          return;
        } catch (e) {
          if (e.name === 'AbortError' || this.ctx.signal?.aborted) throw e;
        }
      }
      await this.pathTo(p, range);
    } catch (e) {
      if (e.name === 'AbortError' || this.ctx.signal?.aborted) throw e;
      // はしごの上の端で止まっている（経路探索は、はしごの上から床へ移る動きができない）なら、跳びながら床へ移る
      if (p.y - Math.floor(bot.entity.position.y) >= 1 && (await this.stepOffLadder())) {
        if (eye().distanceTo(p.offset(0.5, 0.5, 0.5)) <= range && !inside()) return;
        try { await this.pathTo(p, range); return; } catch (e2) {
          if (e2.name === 'AbortError' || this.ctx.signal?.aborted) throw e2;
          this.log.warn(`はしごから移ったあとも近づけない（いま ${bot.entity.position.floored()}）: ${e2.message}`);
        }
      }
      // 建物の中に閉じ込められて外へ歩いて出られないなら、ドアや壁を壊してでも行く（あとで置き直す）
      if (this.isEnclosed()) {
        this.log.info('建物の中に閉じ込められたので、ドアか壁を壊して出る（あとで置き直す）');
        this.ctx.allowEscape = true;
        try { await this.pathTo(p, range); return; } catch (e2) {
          if (e2.name === 'AbortError' || this.ctx.signal?.aborted) throw e2;
        } finally { this.ctx.allowEscape = false; }
      }
      // 高い所（塔の壁の上の段など）は、近くに仮の柱を積んで、その上から置く
      if (p.y - Math.floor(bot.entity.position.y) >= 2 && (await this.climbNear(p, range))) return;
      // 建物の中の低い所に閉じ込められていたら、頭の上を掘って柱で上がる（掘ったマスはあとで置き直す）
      if (p.y - Math.floor(bot.entity.position.y) >= 2 && this.inBox(bot.entity.position.floored()) && this.isEnclosed()
        && (await this.escapeUp(p.y))) {
        await this.pathTo(p, range);
        return;
      }
      throw e;
    }
  }

  async pathTo(p, range, also = null) {
    const { bot } = this;
    // 建物の中では、いま建てている段より 2 段以上低い所には立たない（はしごや下の階に立って床を張り、
    // 床の下に閉じ込められていた）。1 段目・2 段目は地面や床の上でよい
    const forbid = (node) => (this.layer >= 2 && this.inBox(node) && node.y < this.origin.y + this.layer - 1) || !!also?.(node);
    let timer;
    let fail;
    // 近づけなかったときに理由が分かるよう、経路探索の結果を覚えておく。
    // 経路はあるのに動けない（stuck・足場を置けない・掘れない）が続くときは、25 秒待たずにあきらめる
    const seen = { updates: 0, status: '', len: 0, resets: [] };
    const from = bot.entity.position.floored();
    const why = () => `近づけない（${from} から、経路 ${seen.updates} 回: ${seen.status} 長さ ${seen.len}、やり直し: ${seen.resets.join('/') || 'なし'}）`;
    const onUpdate = (r) => { seen.updates++; seen.status = r.status; seen.len = r.path.length; };
    const onReset = (reason) => {
      if (seen.resets.length < 6) seen.resets.push(reason);
      seen.bad = (seen.bad ?? 0) + (/^(stuck|place_error|dig_error|no_scaffolding_blocks)$/.test(reason) ? 1 : 0);
      if (seen.bad >= 3) fail?.(new Error(why()));
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

  // はしごを登りきった所で、隣の床の上へ移る（上を押しながら床の方へ進む。プレイヤーがはしごから降りるときと同じ）
  async stepOffLadder() {
    const { bot } = this;
    const feet = bot.entity.position.floored();
    if (!/(ladder|vine)/.test(bot.blockAt(feet)?.name ?? '') && !/(ladder|vine)/.test(bot.blockAt(feet.offset(0, -1, 0))?.name ?? '')) return false;
    // はしごのまま登って、隣の床（上が 2 マス空いている）の上に出られる所を探す
    let dest = null;
    for (let k = 0; k <= 2 && !dest; k++) {
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const floor = feet.offset(dx, k, dz);
        const b = bot.blockAt(floor);
        if (!b || b.boundingBox !== 'block' || /(ladder|vine)/.test(b.name)) continue;
        if (bot.blockAt(floor.offset(0, 1, 0))?.boundingBox !== 'empty' || bot.blockAt(floor.offset(0, 2, 0))?.boundingBox !== 'empty') continue;
        dest = floor.offset(0, 1, 0);
        break;
      }
    }
    if (!dest) return false;
    this.log.info(`はしごの上から (${key(dest)}) へ移る`);
    await bot.lookAt(dest.offset(0.5, 0.5, 0.5), true);
    bot.setControlState('jump', true);
    bot.setControlState('forward', true);
    try {
      for (let t = 0; t < 60; t++) {
        await bot.waitForTicks(1);
        const f = bot.entity.position.floored();
        if (f.x === dest.x && f.z === dest.z && bot.entity.position.y >= dest.y - 0.1) break;
      }
    } finally {
      bot.setControlState('jump', false);
      bot.setControlState('forward', false);
    }
    await bot.waitForTicks(4);
    const f = bot.entity.position.floored();
    return f.x === dest.x && f.z === dest.z && f.y === dest.y;
  }

  // 建物の外まで歩いて出られないか（経路探索で確かめる）。大きな像の範囲の中にいるだけなら出られるので、掘って上がらない
  isEnclosed() {
    const { bot } = this;
    const mv = bot.pathfinder.movements;
    if (!mv?.getNeighbors) return false;
    const self = this;
    const goal = new (class extends goals.Goal {
      // 範囲（周り 2 マス込み）の外までの、いちばん近い辺への距離
      heuristic(n) {
        const o = self.origin; const s = self.size;
        return Math.max(0, Math.min(n.x - (o.x - 3), o.x + s.x + 2 - n.x, n.z - (o.z - 3), o.z + s.z + 2 - n.z));
      }
      isEnd(n) { return !self.nearBox(n, 2); }
    })();
    try {
      const r = bot.pathfinder.getPathTo(mv, goal, 3000);
      return r.status === 'noPath';
    } catch {
      return false;
    }
  }

  // 建物の中で上の階の床などに閉じ込められたとき、頭の上のブロックを掘っては柱で 1 段ずつ上がる。
  // はしごのマスにいるときは、まず隣の床の上へ移る
  async escapeUp(targetY) {
    const { bot } = this;
    const feet = () => bot.entity.position.floored();
    if (/ladder|vine/.test(bot.blockAt(feet())?.name ?? '')) {
      // はしごの横の床へ出る。床の上が天井（屋根）で 1 マスしか空いていなければ、天井を 1 つ掘って出られるようにする
      const f = feet();
      let moved = false;
      for (let k = 0; k <= 1 && !moved; k++) {
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const floor = f.offset(dx, k, dz);
          const fb = bot.blockAt(floor);
          if (!fb || fb.boundingBox !== 'block' || /(ladder|vine)/.test(fb.name)) continue;
          if (bot.blockAt(floor.offset(0, 1, 0))?.boundingBox !== 'empty') continue;
          const ceil = bot.blockAt(floor.offset(0, 2, 0));
          if (ceil && ceil.boundingBox === 'block') {
            const t = this.targets.get(key(ceil.position));
            if (t && FRAGILE.test(t.name)) continue;
            this.log.info(`はしごの横の天井 (${key(ceil.position)}) を掘って出る（あとで置き直す）`);
            await equipCheapestTool(bot, ceil).catch(() => {});
            await this.dig(ceil);
          }
          moved = await this.stepOffLadder();
          break;
        }
      }
    }
    this.log.info(`建物の中に閉じ込められたので、頭の上を掘って上がる（y=${feet().y} → ${targetY}）`);
    for (let i = 0; i < 24 && feet().y < targetY; i++) {
      abortable(this.ctx);
      for (const up of [feet().offset(0, 2, 0), feet().offset(0, 1, 0)]) {
        const b = bot.blockAt(up);
        if (!b || b.boundingBox !== 'block') continue;
        const t = this.targets.get(key(up));
        if (t && FRAGILE.test(t.name)) return false;
        await equipCheapestTool(bot, b).catch(() => {});
        await this.dig(b);
      }
      if (this.spareScaffold() < 1 && this.stocked) await this.supplier.ensureScaffold(8, this.needed).catch(() => {});
      if ((await pillarUp(this.ctx, 1)) === 0) return false;
    }
    return feet().y >= targetY - 1;
  }

  // p の横（手の届く 4 マス以内）に仮の柱を積み、p と同じ高さに立つ。柱は足場として記録され、最後に片付ける。
  // 屋根の真ん中のように建物の外から遠い所にも届くよう、4 マス先まで探す（近い柱ほど優先）
  async climbNear(p, range) {
    const { bot } = this;
    const center = p.offset(0.5, 0.5, 0.5);
    const free = (b) => b && b.boundingBox === 'empty' && !/(water|lava|ladder|vine|scaffolding|fire)/.test(b.name);
    const cands = [];
    for (let dx = -4; dx <= 4; dx++) {
      for (let dz = -4; dz <= 4; dz++) {
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
        // 柵・塀の上には立てない（経路探索も立てる所と見ない）
        if (/(_fence|_wall|_gate|_pane|bars)$/.test(bot.blockAt(new Vec3(c.x, g, c.z))?.name ?? '')) continue;
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
    for (const { c, g, h } of cands.slice(0, 3)) {
      abortable(this.ctx);
      if (this.stocked && this.spareScaffold() < h) await this.supplier.ensureScaffold(h + 8, this.needed);
      const base = new Vec3(c.x, g + 1, c.z);
      this.log.info(h > 0 ? `(${key(p)}) に届かないので、(${key(base)}) に ${h} 段の柱を積んで登る` : `(${key(p)}) に届かないので、(${key(base)}) に立って置く`);
      try {
        const f = bot.entity.position.floored();
        if (f.x !== base.x || f.z !== base.z || f.y !== base.y) {
          let timer;
          try {
            await Promise.race([
              bot.pathfinder.goto(new goals.GoalBlock(base.x, base.y, base.z)),
              new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('柱の場所へ行けない')), 12_000); }),
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

  // remainingNeed を 5 秒だけ使い回す（クラフトの判断で何度も呼ぶので）
  remaining() {
    if (!this.remainCache || Date.now() - this.remainCache.at > 5000) this.remainCache = { at: Date.now(), need: this.remainingNeed() };
    return this.remainCache.need;
  }

  // 手持ちのうち、建築に使う分（チェストに残っている分を除く）を差し引いた余り
  spareInv(name) {
    const have = count(this.bot, name);
    if (!this.needed.has(name)) return have;
    const need = this.remaining().get(name) ?? 0;
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
    // 2 枚重ねのハーフブロックで、1 枚目がもう置いてあるなら、掘らずに 2 枚目だけ重ねる
    const halfDone = t.props?.type === 'double' && cur?.name === t.name;
    if (cur && !halfDone && !REPLACEABLE.test(cur.name) && !matches(t, cur, { checkProps: false })) {
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
    if (!halfDone) await this.ensureSupport(p, t);
    try {
      if (!halfDone) await this.placeAt(p, t, it.item);
    } catch (e) {
      // 落ち葉など、上書きできると思っていたものに断られたら、掘ってから置き直す
      const still = /the block is still (\w+)/.exec(e.message)?.[1];
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

  // 仮の足場を片付ける。柱ごとにまとめて高い柱から、柱の上に立てたら足元を掘りながら降りる
  // （上から 1 個ずつ掘っていたら、高い所に取り残されて、降りるために建てた壁を壊していた）
  async cleanupScaffolds() {
    const { bot } = this;
    for (let pass = 0; pass < 3; pass++) {
      const list = [...this.scaffolds].map((k) => { const [x, y, z] = k.split(',').map(Number); return new Vec3(x, y, z); })
        .filter((p) => { const t = this.targets.get(key(p)); const b = bot.blockAt(p); return b && b.boundingBox === 'block' && !(t && matches(t, b, { checkProps: false })); });
      if (list.length === 0) return;
      this.log.info(`仮の足場 ${list.length} 個を片付ける`);
      const before = this.scaffolds.size;
      const cols = new Map();
      for (const p of list) {
        const k = `${p.x},${p.z}`;
        if (!cols.has(k)) cols.set(k, []);
        cols.get(k).push(p);
      }
      const order = [...cols.values()].map((ps) => ps.sort((a, b) => b.y - a.y)).sort((a, b) => b[0].y - a[0].y);
      for (const col of order) {
        abortable(this.ctx);
        const top = col[0];
        // 高い柱は、上に立って足元を掘りながら降りる
        if (col.length >= 3) await this.digDownColumn(top).catch((e) => { if (e.name === 'AbortError' || this.ctx.signal?.aborted) throw e; });
        for (const p of col) {
          abortable(this.ctx);
          const b = bot.blockAt(p);
          if (!b || b.boundingBox !== 'block' || !this.scaffolds.has(key(p))) continue;
          try {
            await this.reach(p);
            await equipCheapestTool(bot, b).catch(() => {});
            await this.dig(bot.blockAt(p));
            this.dropScaffold(key(p));
          } catch (e) {
            if (e.name === 'AbortError' || this.ctx.signal?.aborted) throw e;
            this.log.warn(`足場 (${key(p)}) を片付けられなかった: ${e.message}`);
          }
        }
      }
      await pickUpItems(this.ctx, 8).catch(() => {});
      if (this.scaffolds.size >= before) return;
    }
  }

  // 柱 (top から下) の上に立ち、足元の足場を掘っては落ちる、を繰り返して降りる
  async digDownColumn(top) {
    const { bot } = this;
    const stand = top.offset(0, 1, 0);
    const at = () => bot.entity.position.floored();
    if (!at().equals(stand)) {
      let timer;
      try {
        await Promise.race([
          bot.pathfinder.goto(new goals.GoalBlock(stand.x, stand.y, stand.z)),
          new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('柱の上へ行けない')), 15_000); }),
        ]);
      } finally {
        clearTimeout(timer);
        try { bot.pathfinder.setGoal(null); } catch {}
      }
    }
    if (!at().equals(stand)) return;
    for (let i = 0; i < 64; i++) {
      abortable(this.ctx);
      const below = at().offset(0, -1, 0);
      const b = bot.blockAt(below);
      if (!b || b.boundingBox !== 'block' || !this.scaffolds.has(key(below))) break;
      await equipCheapestTool(bot, b).catch(() => {});
      const y0 = bot.entity.position.y;
      await this.dig(b);
      this.dropScaffold(key(below));
      for (let t = 0; t < 30 && !(bot.entity.onGround && bot.entity.position.y <= y0 - 0.9); t++) await bot.waitForTicks(1);
    }
  }
}
