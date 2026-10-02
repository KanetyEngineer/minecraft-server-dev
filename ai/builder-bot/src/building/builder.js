// 設計図どおりに 1 段ずつ下から建てる。
// 段ごとに: 邪魔なブロックをどける → その段の素材をそろえる（手持ちに入る分ずつ）→ 近い順に置く。
// 毎回いまの世界の状態を見て「設計図どおりか」を確かめるので、中断・再起動しても続きから建てられる。
import pathfinderPkg from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import { SkillError, abortable, equipCheapestTool, pickUpItems, cheapBlock, travelTo } from '../skills/common.js';
import { count } from '../util/items.js';
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
  constructor(ctx, { schematic, origin, supplier, clear = true }) {
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
    this.scaffolds = new Set(); // 建てるために置いた仮の足場（最後に片付ける）
    this.missing = new Map(); // 手に入らなかったアイテム -> 個数
    this.orientationOff = 0;
    this.placed = 0;
    this.layer = 0;
    this.selfPlacing = false;
    ctx.isBuildPos = (p) => this.inBox(p);
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

  materialSummary() {
    const { need, unplaceable } = materialList(this.bot.registry, this.schematic.blocks);
    return { need: [...need.entries()].sort((a, b) => b[1] - a[1]), unplaceable: [...unplaceable.entries()] };
  }

  // 経路探索に「建てた所を壊さない」「建物の中に勝手に足場を置かない」を教える
  installPathRules() {
    const mv = this.bot.pathfinder.movements;
    if (!mv || mv._builderRules) return;
    mv._builderRules = true;
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
      if (!t || t.name !== nb.name) this.scaffolds.add(key(nb.position));
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
    await this.cleanupScaffolds();
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

  // 空気のはずのマスにある固いブロック（地形・木）をどける
  async clearLayer(wy) {
    const { bot, ctx } = this;
    const list = [];
    for (let x = 0; x < this.size.x; x++) {
      for (let z = 0; z < this.size.z; z++) {
        const p = new Vec3(this.origin.x + x, wy, this.origin.z + z);
        if (this.targets.has(key(p))) continue;
        const b = bot.blockAt(p);
        if (b && b.boundingBox === 'block' && !isAirName(b.name) && bot.canDigBlock(b) && b.name !== 'bedrock') list.push(p);
      }
    }
    if (list.length === 0) return;
    this.log.info(`y=${wy} の邪魔なブロック ${list.length} 個をどける`);
    await this.forEachNearest(list, async (p) => {
      const b = bot.blockAt(p);
      if (!b || b.boundingBox !== 'block') return;
      await this.reach(p);
      await equipCheapestTool(bot, b).catch(() => {});
      await bot.dig(bot.blockAt(p), true).catch((e) => this.log.warn(`どけられなかった (${key(p)}): ${e.message}`));
      this.scaffolds.delete(key(p));
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
          this.log.warn(`${item} ×${lack} は自分で集めるには多すぎる（手間 ${Math.round(effort)}）。チェストに入れてください`);
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
    for (const item of stacks.keys()) if (count(bot, item) > 0) usable.add(item);
    return usable;
  }

  // 持ち物がいっぱいなら、建築に使わない物（余った土・石・苗木など）を捨てる
  async tidyInventory(stacks) {
    const { bot } = this;
    if (bot.inventory.emptySlotCount() >= 6) return;
    const needed = new Set([...stacks.keys()]);
    for (const t of this.targets.values()) { const it = itemFor(bot.registry, t); if (it) needed.add(it.item); }
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
      try {
        await fn(best);
        fails = 0;
      } catch (e) {
        if (e.name === 'AbortError' || this.ctx.signal?.aborted) throw e;
        this.log.warn(`(${key(best)}) で失敗: ${e.message}`);
        if (++fails >= 12) throw new SkillError('失敗が続いたので、この段をいったん中断する');
      }
    }
  }

  // 置く位置に手が届くところまで行く
  async reach(p, range = 4.2) {
    const { bot } = this;
    const eye = () => bot.entity.position.offset(0, 1.62, 0);
    const inside = () => {
      const f = bot.entity.position.floored();
      return f.x === p.x && f.z === p.z && (f.y === p.y || f.y === p.y - 1);
    };
    if (eye().distanceTo(p.offset(0.5, 0.5, 0.5)) <= range && !inside()) return;
    // 建物の中の低い所（空洞）には立たない（閉じ込められないように）
    const forbid = (node) => this.inBox(node) && node.y < this.origin.y + this.layer - 1
      && !this.targets.has(key(new Vec3(node.x, node.y - 1, node.z)));
    let timer;
    try {
      await Promise.race([
        bot.pathfinder.goto(new GoalPlaceNear(p, range, forbid)),
        new Promise((_, rej) => { timer = setTimeout(() => { try { bot.pathfinder.setGoal(null); } catch {} rej(new Error('近づけない')); }, 25_000); }),
      ]);
    } finally {
      clearTimeout(timer);
    }
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
      const item = cheapBlock(bot) ?? (await this.scaffoldItem());
      if (!item) throw new SkillError('足場にするブロックが無い');
      await this.placeAt(c, { name: item.name, props: {} }, item.name);
      this.scaffolds.add(key(c));
    }
  }

  async scaffoldItem() {
    if (!this.supplier) return null;
    await this.supplier.ensure('dirt', 32).catch(() => this.supplier.ensure('cobblestone', 32));
    return cheapBlock(this.bot);
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
      await bot.dig(bot.blockAt(p), true);
      this.scaffolds.delete(key(p));
      await bot.waitForTicks(2);
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
      await bot.dig(b, true);
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
          await bot.dig(b, true);
        }
        this.scaffolds.delete(key(p));
      } catch (e) {
        if (e.name === 'AbortError' || this.ctx.signal?.aborted) throw e;
        this.log.warn(`足場 (${key(p)}) を片付けられなかった: ${e.message}`);
      }
    }
    await pickUpItems(this.ctx, 8).catch(() => {});
  }
}
