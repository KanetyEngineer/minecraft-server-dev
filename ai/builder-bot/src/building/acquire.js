// 素材の調達: 手持ち → 近くのチェスト → 精錬 → 採掘（自然にあるブロック）→ 動物 → クラフト の中から、
// いちばん手間の少ない方法を選んで、必要な数をそろえる。レシピの材料も同じ方法で再帰的にそろえる。
import { Vec3 } from 'vec3';
import {
  SkillError, abortable, mineBlocks, branchMine, craftItem, smelt, attackEntity, pickUpItems,
  exploreStep, goNearBlock, goals, ensurePickaxe, equipCheapestTool, isNextToLiquid,
} from '../skills/common.js';
import { gatherWood, getCobblestone } from '../skills/gather.js';
import { count, countMatching, isLog, isPlanks } from '../util/items.js';
import { findVisibleBlocks, sleep } from '../body/humanize.js';

// 精錬で作るもの（出来上がり → 材料）
export const SMELT = {
  stone: 'cobblestone', smooth_stone: 'stone', glass: 'sand', terracotta: 'clay', brick: 'clay_ball',
  iron_ingot: 'raw_iron', gold_ingot: 'raw_gold', copper_ingot: 'raw_copper', charcoal: 'oak_log',
  cracked_stone_bricks: 'stone_bricks', smooth_sandstone: 'sandstone', smooth_red_sandstone: 'red_sandstone',
  deepslate: 'cobbled_deepslate', smooth_quartz: 'quartz_block', green_dye: 'cactus', lime_dye: 'sea_pickle',
  sponge: 'wet_sponge', cracked_deepslate_bricks: 'deepslate_bricks', cracked_deepslate_tiles: 'deepslate_tiles',
  cracked_nether_bricks: 'nether_bricks', cracked_polished_blackstone_bricks: 'polished_blackstone_bricks',
  netherite_scrap: 'ancient_debris', popped_chorus_fruit: 'chorus_fruit', nether_brick: 'netherrack',
};

const FLOWERS = ['dandelion', 'poppy', 'blue_orchid', 'allium', 'azure_bluet', 'red_tulip', 'orange_tulip', 'white_tulip',
  'pink_tulip', 'oxeye_daisy', 'cornflower', 'lily_of_the_valley', 'sunflower', 'lilac', 'rose_bush', 'peony', 'pink_petals',
  'wildflowers', 'cactus_flower', 'open_eyeblossom', 'closed_eyeblossom'];
// 採掘して手に入れてよい「自然にある」ブロック（村の建物などを壊さない）
const NATURAL = new Set([
  'dirt', 'grass_block', 'coarse_dirt', 'rooted_dirt', 'podzol', 'mycelium', 'sand', 'red_sand', 'gravel', 'clay', 'mud',
  'stone', 'deepslate', 'cobblestone', 'andesite', 'diorite', 'granite', 'tuff', 'calcite', 'dripstone_block',
  'sandstone', 'red_sandstone', 'terracotta', 'snow_block', 'snow', 'ice', 'packed_ice', 'blue_ice', 'pumpkin', 'melon',
  'sugar_cane', 'cactus', 'bamboo', 'kelp', 'kelp_plant', 'red_mushroom', 'brown_mushroom', 'moss_block', 'obsidian',
  'amethyst_cluster', 'sea_pickle', 'short_grass', 'fern', 'vine', 'lily_pad', 'glow_lichen', 'netherrack',
  ...FLOWERS,
]);
const isNatural = (n) => NATURAL.has(n) || /(_log|_stem|_ore|_leaves)$/.test(n) || /_terracotta$/.test(n);

// 鉱石ごとの、ブランチマイニングで狙う高さ
const ORE_Y = { coal: 48, copper: 48, iron: 16, gold: -16, redstone: -54, lapis: 0, diamond: -54, emerald: 100 };

// 動物から手に入るもの
const MOB_DROPS = [
  { re: /_wool$/, mobs: ['sheep'] }, { re: /^leather$/, mobs: ['cow', 'mooshroom'] },
  { re: /^feather$/, mobs: ['chicken'] }, { re: /^(beef|porkchop|mutton|chicken|rabbit)$/, mobs: ['cow', 'pig', 'sheep', 'chicken', 'rabbit'] },
];

// 色付きの羊毛は白い羊毛＋染料で作る（羊の色を探して回らない）
const huntable = (name) => name === 'white_wool' || (!name.endsWith('_wool') && MOB_DROPS.some((m) => m.re.test(name)));

const UNIT_COST = { have: 0, chest: 0.1, natural: 1, naturalFar: 4, ore: 3, mob: 3 };

export class Supplier {
  constructor(ctx, { home, chestRadius = 24 } = {}) {
    this.ctx = ctx;
    this.home = home; // 設計図の近く（チェストを探す中心）
    this.chestRadius = chestRadius;
    this.chests = new Map(); // "x,y,z" -> { pos, items: Map }
    this.failed = new Map(); // アイテム名 -> 失敗した時刻（しばらく同じ方法を試さない）
  }

  get bot() { return this.ctx.bot; }
  get log() { return this.ctx.log; }

  // ---------- チェスト ----------

  async scanChests() {
    const { bot } = this;
    const ids = ['chest', 'trapped_chest', 'barrel'].map((n) => bot.registry.blocksByName[n]?.id).filter((x) => x !== undefined);
    const center = this.home ?? bot.entity.position;
    const found = bot.findBlocks({ matching: ids, maxDistance: this.chestRadius + center.distanceTo(bot.entity.position), count: 64 })
      .filter((p) => p.distanceTo(center) <= this.chestRadius && !(this.ctx.isBuildPos?.(p)));
    for (const pos of found) {
      const key = `${pos.x},${pos.y},${pos.z}`;
      if (this.chests.has(key)) continue;
      try {
        const items = await this.#withChest(pos, async (win) => {
          const m = new Map();
          for (const it of win.containerItems()) m.set(it.name, (m.get(it.name) ?? 0) + it.count);
          return m;
        });
        this.chests.set(key, { pos, items });
        const summary = [...items.entries()].slice(0, 8).map(([n, c]) => `${n}×${c}`).join(', ');
        this.log.info(`チェスト (${key}) の中身: ${summary || '空'}${items.size > 8 ? ' ほか' : ''}`);
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        this.log.warn(`チェスト (${key}) を開けなかった: ${e.message}`);
      }
    }
  }

  async #withChest(pos, fn) {
    const { bot } = this;
    const block = bot.blockAt(pos);
    if (!block) throw new Error('チェストが読み込まれていない');
    if (bot.entity.position.offset(0, 1.6, 0).distanceTo(pos.offset(0.5, 0.5, 0.5)) > 4) {
      // 行けないチェストの前で考え続けて止まらないよう、30 秒で打ち切る
      let timer;
      try {
        await Promise.race([
          goNearBlock(this.ctx, block, 2),
          new Promise((_, rej) => { timer = setTimeout(() => { try { bot.pathfinder.setGoal(null); } catch {} rej(new Error('チェストに近づけない')); }, 30_000); }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    }
    const win = await bot.openContainer(bot.blockAt(pos));
    try {
      return await fn(win);
    } finally {
      win.close();
      await sleep(200);
    }
  }

  chestCount(name) {
    let n = 0;
    for (const c of this.chests.values()) n += c.items.get(name) ?? 0;
    return n;
  }

  async takeFromChests(name, n) {
    const { bot } = this;
    const start = count(bot, name);
    for (const c of this.chests.values()) {
      if (count(bot, name) - start >= n) break;
      const have = c.items.get(name) ?? 0;
      if (have <= 0) continue;
      const want = Math.min(have, n - (count(bot, name) - start));
      try {
        await this.#withChest(c.pos, async (win) => {
          // 実際の中身で数え直す（ほかのプレイヤーが出し入れしているかもしれない）
          const real = win.containerItems().filter((i) => i.name === name).reduce((s, i) => s + i.count, 0);
          const take = Math.min(real, want, bot.inventory.emptySlotCount() * 64);
          if (take > 0) await win.withdraw(bot.registry.itemsByName[name].id, null, take);
          c.items.set(name, real - take);
        });
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        this.log.warn(`チェストから ${name} を取れなかった: ${e.message}`);
      }
    }
    const got = count(bot, name) - start;
    if (got > 0) this.log.info(`チェストから ${name} を ${got} 個取った`);
    return got;
  }

  // ---------- 手間の見積もり ----------

  // 1 個あたりの手間（大きいほど大変、Infinity は手に入れる方法が無い）
  estimate(name, depth = 0, visiting = new Set(), memo = new Map()) {
    if (memo.has(name)) return memo.get(name);
    if (visiting.has(name) || depth > 6) return Infinity;
    visiting.add(name);
    let best = Infinity;
    if (count(this.bot, name) > 0) best = UNIT_COST.have;
    if (this.chestCount(name) > 0) best = Math.min(best, UNIT_COST.chest);
    if (best > 0.1) {
      const src = this.naturalSources(name);
      if (src.length) {
        const ore = src.some((s) => s.endsWith('_ore'));
        const near = !ore && findVisibleBlocks(this.bot, src, { maxDistance: 48, count: 1, visibleOnly: false }).length > 0;
        best = Math.min(best, ore ? UNIT_COST.ore : near ? UNIT_COST.natural : UNIT_COST.naturalFar);
      }
      if (SMELT[name]) best = Math.min(best, 1 + this.estimate(SMELT[name], depth + 1, visiting, memo));
      if (huntable(name)) best = Math.min(best, UNIT_COST.mob);
      if (/_concrete$/.test(name)) best = Math.min(best, 1 + this.estimate(`${name}_powder`, depth + 1, visiting, memo));
      for (const r of this.recipes(name)) {
        let c = 0.3; // クラフトの手間
        for (const [ing, qty] of r.ingredients) {
          c += (this.estimate(ing, depth + 1, visiting, memo) * qty) / r.resultCount;
          if (c >= best) break;
        }
        best = Math.min(best, c);
      }
    }
    visiting.delete(name);
    memo.set(name, best);
    return best;
  }

  naturalSources(name) {
    const reg = this.bot.registry;
    const id = reg.itemsByName[name]?.id;
    if (id === undefined) return [];
    const out = [];
    for (const b of reg.blocksArray) {
      if (!isNatural(b.name)) continue;
      const drops = (b.drops ?? []).map((d) => (typeof d === 'object' ? d.drop?.id ?? d.id : d));
      if (drops.includes(id)) out.push(b.name);
    }
    return out;
  }

  recipes(name) {
    const { bot } = this;
    const item = bot.registry.itemsByName[name];
    if (!item) return [];
    const list = [...bot.recipesAll(item.id, null, true)];
    // 染め直しのレシピ（染料＋羊毛）は「どの色の羊毛でもよい」が、レシピの一覧には黒い羊毛の形しか無い。
    // 手に入れやすい白い羊毛に置き換えた形も足す（色付き羊毛が「作り方が無い」になっていた）
    const white = bot.registry.itemsByName.white_wool?.id;
    for (const r of [...list]) {
      const wool = r.delta.find((d) => d.count < 0 && /_wool$/.test(bot.registry.items[d.id].name) && d.id !== white);
      const hasDye = r.delta.some((d) => d.count < 0 && /_dye$/.test(bot.registry.items[d.id].name));
      if (!wool || !hasDye || white === undefined || name === 'white_wool') continue;
      const swap = (x) => (x && x.id === wool.id ? { ...x, id: white } : x);
      const v = Object.assign(Object.create(Object.getPrototypeOf(r)), r, {
        delta: r.delta.map(swap),
        ingredients: r.ingredients ? r.ingredients.map(swap) : r.ingredients,
        inShape: r.inShape ? r.inShape.map((row) => row.map(swap)) : r.inShape,
      });
      v.custom = true;
      list.unshift(v);
    }
    return list.map((r) => ({
      raw: r,
      custom: !!r.custom,
      resultCount: r.result.count,
      ingredients: r.delta.filter((d) => d.count < 0).map((d) => [bot.registry.items[d.id].name, -d.count]),
    })).filter((r) => !r.ingredients.some(([n]) => n === name)); // 自分自身が材料のもの（染め直しなど）は使わない
  }

  // ---------- 調達 ----------

  // name を合計 n 個持っている状態にする。そろった数を返す（足りなければ SkillError）
  async ensure(name, n, depth = 0, stack = []) {
    const { bot } = this;
    abortable(this.ctx);
    if (count(bot, name) >= n) return count(bot, name);
    if (stack.includes(name) || depth > 6) throw new SkillError(`${name} の作り方が循環している`);
    const need = () => n - count(bot, name);
    if (this.chestCount(name) > 0) await this.takeFromChests(name, need());
    if (need() <= 0) return count(bot, name);

    // 方法の候補を手間の少ない順に試す
    const memo = new Map();
    const options = [];
    const src = this.naturalSources(name);
    if (src.length) options.push({ kind: 'mine', cost: this.estimate(name, 0, new Set(), memo) });
    if (SMELT[name]) options.push({ kind: 'smelt', cost: 1 + this.estimate(SMELT[name], 1, new Set([name]), memo) });
    if (/_concrete$/.test(name)) options.push({ kind: 'concrete', cost: 1 + this.estimate(`${name}_powder`, 1, new Set([name]), memo) });
    if (huntable(name)) options.push({ kind: 'mob', cost: UNIT_COST.mob });
    const recipes = this.recipes(name)
      .map((r) => ({ r, cost: r.ingredients.reduce((s, [ing, q]) => s + (this.estimate(ing, 1, new Set([name]), memo) * q) / r.resultCount, 0.3) }))
      .filter((x) => Number.isFinite(x.cost))
      .sort((a, b) => a.cost - b.cost);
    if (recipes.length) options.push({ kind: 'craft', cost: recipes[0].cost, recipes });
    options.sort((a, b) => a.cost - b.cost);
    if (options.length === 0 || !Number.isFinite(options[0].cost)) {
      throw new SkillError(`${name} を手に入れる方法が無い（チェストに入れてください）`);
    }
    let lastErr = null;
    for (const opt of options) {
      if (!Number.isFinite(opt.cost)) break;
      try {
        if (opt.kind === 'mine') await this.#mine(name, src, need());
        else if (opt.kind === 'smelt') await this.#smelt(name, need(), depth, stack);
        else if (opt.kind === 'concrete') await this.#concrete(name, need(), depth, stack);
        else if (opt.kind === 'mob') await this.#hunt(name, need());
        else if (opt.kind === 'craft') await this.#craft(name, n, opt.recipes, depth, stack);
      } catch (e) {
        if (e.name === 'AbortError' || this.ctx.signal?.aborted) throw e;
        lastErr = e;
        this.log.warn(`${name}: ${opt.kind} で手に入らなかった（${e.message}）`);
      }
      if (need() <= 0) return count(bot, name);
    }
    throw lastErr ?? new SkillError(`${name} が ${need()} 個足りない`);
  }

  async #mine(name, sources, n) {
    const { bot, ctx } = this;
    const before = count(bot, name);
    const got = () => count(bot, name) - before;
    // 掘るのに道具が要るブロックなら、その道具をそろえる（鉄鉱石なら石のツルハシ以上）
    const reg = bot.registry;
    const tools = sources.map((s) => reg.blocksByName[s]?.harvestTools).filter(Boolean);
    if (tools.length) {
      const names = Object.keys(tools[0]).map((id) => reg.items[id].name);
      if (!names.some((t) => count(bot, t) > 0)) {
        const cheapest = ['wooden_pickaxe', 'stone_pickaxe', 'iron_pickaxe', 'diamond_pickaxe'].find((t) => names.includes(t));
        if (!cheapest) throw new SkillError(`${sources[0]} を掘る道具が分からない`);
        this.log.info(`${sources[0]} を掘るため ${cheapest} を用意する`);
        if (cheapest === 'wooden_pickaxe' || cheapest === 'stone_pickaxe') {
          await ensurePickaxe(ctx, { minTier: cheapest.split('_')[0] });
          if (!names.some((t) => count(bot, t) > 0)) await this.ensure(cheapest, 1);
        } else {
          await this.ensure(cheapest, 1);
        }
      }
    }
    if (name === 'cobblestone' || name === 'cobbled_deepslate') {
      await getCobblestone(ctx, count(bot, 'cobblestone') + count(bot, 'cobbled_deepslate') + n);
      return;
    }
    if (sources.some((s) => /(_log|_stem)$/.test(s)) && isLog(name)) {
      // 木は 1 本ずつ最後まで切る（ほかの種類の原木も取れるが、燃料や板材に使える）
      for (let round = 0; round < 4 && got() < n; round++) {
        await gatherWood(ctx, { logs: Math.max(3, n - got() + 1) }).catch((e) => {
          if (e.name === 'AbortError' || ctx.signal?.aborted) throw e;
          this.log.warn(`木集め: ${e.message}`);
        });
      }
      if (got() < n) throw new SkillError(`${name} を集めきれなかった（${got()}/${n}）`);
      return;
    }
    // シャベルがあると土・砂・砂利が速い
    if (sources.some((s) => /^(dirt|grass_block|sand|red_sand|gravel|clay|mud)$/.test(s)) && countMatching(bot, (x) => x.endsWith('_shovel')) === 0) {
      await this.ensure('wooden_shovel', 1).catch(() => {});
    }
    for (let round = 0; round < 6 && got() < n; round++) {
      abortable(ctx);
      const before2 = got();
      await mineBlocks(ctx, sources, n - got(), { maxDistance: 48, maxExplore: 10 });
      await pickUpItems(ctx, 6).catch(() => {});
      if (got() < n && sources.some((s) => s.endsWith('_ore'))) {
        const kind = Object.keys(ORE_Y).find((k) => sources.some((s) => s.includes(`${k}_ore`)));
        const y = ORE_Y[kind] ?? 16;
        this.log.info(`${name} の鉱石が見えないので y=${y} で横掘りする`);
        await branchMine(ctx, sources, n - got(), y);
      }
      if (got() === before2) break;
    }
    if (got() < n) throw new SkillError(`${name} を集めきれなかった（${got()}/${n}）`);
  }

  async #smelt(name, n, depth, stack) {
    const { bot, ctx } = this;
    let input = SMELT[name];
    if (name === 'charcoal') input = bot.inventory.items().find((i) => isLog(i.name))?.name ?? 'oak_log';
    await this.ensure(input, count(bot, input) + n, depth + 1, [...stack, name]);
    // 燃料（石炭・木炭・木材）を用意する。1 個の板材で 1.5 個焼ける
    const fuel = () => (count(bot, 'coal') + count(bot, 'charcoal')) * 8
      + countMatching(bot, (x) => isPlanks(x)) * 1.5 + countMatching(bot, (x) => isLog(x) && x !== input) * 1.5;
    if (fuel() < n) {
      this.log.info(`${name} を焼く燃料が足りないので木を集める`);
      await gatherWood(ctx, { logs: Math.ceil((n - fuel()) / 1.5) + 1 });
    }
    let left = n;
    for (let i = 0; i < 6 && left > 0; i++) {
      const batch = Math.min(left, 64);
      const got = await smelt(ctx, input, batch);
      left -= got;
      if (got === 0) break;
    }
    if (count(bot, name) <= 0) throw new SkillError(`${name} を焼けなかった`);
  }

  // コンクリートパウダーを水に触れさせて固め、掘って回収する
  async #concrete(name, n, depth, stack) {
    const { bot, ctx } = this;
    const powder = `${name}_powder`;
    await this.ensure(powder, count(bot, powder) + n, depth + 1, [...stack, name]);
    if (!(await ensurePickaxe(ctx))) throw new SkillError('コンクリートを掘るツルハシが無い');
    const start = count(bot, name);
    for (let tries = 0; count(bot, name) - start < n && tries < n * 2 + 10; tries++) {
      abortable(ctx);
      // 水源の縁: 隣が陸（足場にする）の水源ブロック
      const water = findVisibleBlocks(bot, ['water'], {
        maxDistance: 48, count: 24, visibleOnly: true,
        extra: (b) => b.metadata === 0 && ['air', 'cave_air'].includes(bot.blockAt(b.position.offset(0, 1, 0))?.name)
          && !(ctx.isBuildPos?.(b.position)),
      });
      let target = null; let ref = null;
      for (const w of water) {
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const r = bot.blockAt(w.position.offset(dx, 0, dz));
          if (r && r.boundingBox === 'block' && r.name !== powder) { target = w; ref = r; break; }
        }
        if (target) break;
      }
      if (!target) {
        if (tries > 4) throw new SkillError('コンクリートを固める水辺が見つからない');
        this.log.info('コンクリートを固める水辺を探して歩く');
        await exploreStep(ctx);
        continue;
      }
      const p = target.position;
      await bot.pathfinder.goto(new goals.GoalNear(ref.position.x, ref.position.y + 1, ref.position.z, 2)).catch(() => {});
      const item = bot.inventory.items().find((i) => i.name === powder);
      if (!item) break;
      await bot.equip(item, 'hand');
      try {
        await bot.placeBlock(bot.blockAt(ref.position), p.minus(ref.position));
      } catch (e) {
        this.log.warn(`パウダーを水に置けなかった: ${e.message}`);
      }
      await bot.waitForTicks(4);
      const b = bot.blockAt(p);
      if (b && (b.name === name || b.name === powder)) {
        await equipCheapestTool(bot, b).catch(() => {});
        await bot.dig(b, true).catch(() => {});
        await bot.waitForTicks(10);
        await pickUpItems(ctx, 5).catch(() => {});
      }
    }
    if (count(bot, name) - start <= 0) throw new SkillError(`${name} を作れなかった`);
  }

  async #hunt(name, n) {
    const { bot, ctx } = this;
    const mobs = MOB_DROPS.find((m) => m.re.test(name))?.mobs ?? [];
    const start = count(bot, name);
    let explored = 0;
    while (count(bot, name) - start < n && explored < 8) {
      abortable(ctx);
      // 白い羊毛は白い羊だけを狙う（羊の色はメタデータ 17 番の下位 4 ビット、0x10 は毛を刈られた印）
      const woolOk = (e) => name !== 'white_wool' || e.name !== 'sheep' || typeof e.metadata?.[17] !== 'number' || (e.metadata[17] & 0x1f) === 0;
      const target = bot.nearestEntity((e) => mobs.includes(e.name) && woolOk(e) && e.position.distanceTo(bot.entity.position) < 48);
      if (!target) { explored++; this.log.info(`${mobs[0]} を探して歩く（${explored}/8）`); await exploreStep(ctx); continue; }
      await attackEntity(ctx, target, { timeoutMs: 20_000 });
      await pickUpItems(ctx, 6).catch(() => {});
    }
    if (count(bot, name) - start <= 0) throw new SkillError(`${name} が手に入らなかった`);
  }

  async #craft(name, n, recipes, depth, stack) {
    const { bot, ctx } = this;
    let lastErr = null;
    for (const { r } of recipes.slice(0, 4)) {
      abortable(ctx);
      const missing = n - count(bot, name);
      if (missing <= 0) return;
      const times = Math.ceil(missing / r.resultCount);
      try {
        for (const [ing, q] of r.ingredients) {
          await this.ensure(ing, q * times, depth + 1, [...stack, name]);
        }
        if (r.custom) {
          // 置き換えた形のレシピは craftItem が選ばないので、そのまま作る（2×2 なので作業台は要らない）
          for (let g = 0; g < times * 2 && count(bot, name) < n; g++) await bot.craft(r.raw, 1, null);
          if (count(bot, name) < n) throw new SkillError(`${name} を ${n} 個作れなかった`);
          return;
        }
        // craftItem は 1 回の呼び出しで最大 64 回クラフトするので、多いときは分けて呼ぶ
        for (let g = 0; g < 20 && count(bot, name) < n; g++) {
          const step = Math.min(n, count(bot, name) + r.resultCount * 64);
          await craftItem(ctx, name, step);
        }
        return;
      } catch (e) {
        if (e.name === 'AbortError' || ctx.signal?.aborted) throw e;
        lastErr = e;
        this.log.warn(`${name} のレシピ（${r.ingredients.map(([i, q]) => `${i}×${q}`).join(' ')}）で作れなかった: ${e.message}`);
      }
    }
    throw lastErr ?? new SkillError(`${name} を作れなかった`);
  }
}

export { Vec3, isNextToLiquid };
