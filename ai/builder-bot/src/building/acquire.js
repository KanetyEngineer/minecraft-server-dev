// 素材の調達: 手持ち → 近くのチェスト → 精錬 → 採掘（自然にあるブロック）→ 動物 → クラフト の中から、
// いちばん手間の少ない方法を選んで、必要な数をそろえる。レシピの材料も同じ方法で再帰的にそろえる。
import { Vec3 } from 'vec3';
import {
  SkillError, abortable, mineBlocks, branchMine, craftItem, smelt, attackEntity, pickUpItems,
  exploreStep, goNearBlock, goals, ensurePickaxe, equipCheapestTool, isNextToLiquid, ensureCraftingTable,
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

// 足場にしてよい安いブロック（チェストから借りるときに選ぶ順）
// 足場ブロック（scaffolding）があれば最初に使う（下を壊すと上までまとめて崩れるので、片付けが速い）
export const SCAFFOLD_BLOCKS = ['scaffolding', 'dirt', 'coarse_dirt', 'netherrack', 'cobblestone', 'cobbled_deepslate', 'andesite', 'diorite', 'granite', 'tuff', 'stone'];
// 中身を読める入れ物（設置したシュルカーボックスも開ける）
const CONTAINER_RE = /^(chest|trapped_chest|barrel|(\w+_)?shulker_box)$/;

export class Supplier {
  // mode: 'gather' … 足りなければ自分で集める・焼く・作る
  //       'stocked' … 素材は手持ちとチェストに用意してある前提。チェストから取るのと、手元の材料でのクラフトだけ
  constructor(ctx, { home, chestRadius = 24, mode = 'gather', yRange = null } = {}) {
    this.ctx = ctx;
    this.home = home; // 設計図の近く（チェストを探す中心）
    this.chestRadius = chestRadius;
    // チェストを探す高さの範囲 [下, 上]。地下の廃坑・ダンジョンのチェストまで取りに行かない
    // （試験でダンジョンのチェストを開けに行き、クモに何度も倒された）
    this.yRange = yRange;
    this.mode = mode;
    this.chests = new Map(); // "x,y,z" -> { pos, items: Map, free: 空きスロット数, at: 調べた時刻 }
    // reserve(name): この先の建築でまだ使う数（Builder が付ける）。素材を用意してもらうときは、これを材料にしてクラフトしない
    this.reserve = null;
    this.failed = new Map(); // アイテム名 -> 失敗した時刻（しばらく同じ方法を試さない）
  }

  get bot() { return this.ctx.bot; }
  get log() { return this.ctx.log; }
  get stocked() { return this.mode === 'stocked'; }

  // ---------- チェスト ----------

  // 近くのチェストの中身を調べる。refreshMs を渡すと、それより前に調べたチェストも調べ直す
  // （建築中にプレイヤーが素材を足したのに気づけるように）
  async scanChests({ refreshMs = Infinity } = {}) {
    const { bot } = this;
    const ids = bot.registry.blocksArray.filter((b) => CONTAINER_RE.test(b.name)).map((b) => b.id);
    const center = this.home ?? bot.entity.position;
    const found = bot.findBlocks({ matching: ids, maxDistance: this.chestRadius + center.distanceTo(bot.entity.position), count: 64 })
      .filter((p) => p.distanceTo(center) <= this.chestRadius && !(this.ctx.isBuildPos?.(p)))
      .filter((p) => !this.yRange || (p.y >= this.yRange[0] && p.y <= this.yRange[1]))
      .sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position));
    this.unreadable = 0; // 今回開けられなかったチェストの数（近づけないなど）
    // 壊されたチェストは忘れる
    for (const [key, c] of this.chests) if (!CONTAINER_RE.test(bot.blockAt(c.pos)?.name ?? 'chest')) this.chests.delete(key);
    for (const pos of found) {
      const key = `${pos.x},${pos.y},${pos.z}`;
      const known = this.chests.get(key);
      if (known && Date.now() - known.at < refreshMs) continue;
      // ラージチェストの片割れ（もう片方で中身を読んだもの）は飛ばす
      if (!known && this.#otherHalf(pos)) continue;
      try {
        const { items, free } = await this.#withChest(pos, async (win) => this.#readWindow(win));
        this.chests.set(key, { pos, items, free, at: Date.now() });
        const summary = [...items.entries()].slice(0, 8).map(([n, c]) => `${n}×${c}`).join(', ');
        this.log.info(`チェスト (${key}) の中身: ${summary || '空'}${items.size > 8 ? ' ほか' : ''}`);
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        this.unreadable++;
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
      // 近づけなかったときの理由（経路探索の結果）を残す
      const seen = { n: 0, status: '', len: 0, resets: [] };
      const from = bot.entity.position.floored();
      const onUpdate = (r) => { seen.n++; seen.status = r.status; seen.len = r.path.length; };
      const onReset = (why) => { if (seen.resets.length < 5) seen.resets.push(why); };
      bot.on('path_update', onUpdate);
      bot.on('path_reset', onReset);
      // 建物の中に閉じ込められているなら、ドアや壁を壊してでもチェストへ行く（BuilderBot があとで置き直す）
      const escape = !!this.ctx.isEnclosed?.();
      if (escape) this.ctx.allowEscape = true;
      try {
        await Promise.race([
          goNearBlock(this.ctx, block, 2),
          new Promise((_, rej) => {
            timer = setTimeout(() => {
              try { bot.pathfinder.setGoal(null); } catch {}
              if (seen.n === 0) this.ctx.onPathStall?.();
              rej(new Error(`チェストに近づけない（${from} から、経路 ${seen.n} 回: ${seen.status} 長さ ${seen.len}、やり直し: ${seen.resets.join('/') || 'なし'}）`));
            }, 30_000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
        bot.off('path_update', onUpdate);
        bot.off('path_reset', onReset);
        if (escape) this.ctx.allowEscape = false;
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

  #readWindow(win) {
    const m = new Map();
    const items = win.containerItems();
    for (const it of items) m.set(it.name, (m.get(it.name) ?? 0) + it.count);
    return { items: m, free: win.inventoryStart - items.length };
  }

  // ラージチェストのもう半分が、もう調べてあるか
  #otherHalf(pos) {
    const b = this.bot.blockAt(pos);
    const type = b?.getProperties?.().type;
    if (!type || type === 'single') return false;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const q = pos.offset(dx, 0, dz);
      if (this.chests.has(`${q.x},${q.y},${q.z}`) && this.bot.blockAt(q)?.name === b.name) return true;
    }
    return false;
  }

  chestCount(name) {
    let n = 0;
    for (const c of this.chests.values()) n += c.items.get(name) ?? 0;
    return n;
  }

  // 手持ちとチェストを合わせた数
  available(name) {
    return count(this.bot, name) + this.chestCount(name);
  }

  // 建築に使う分を除いた余り（建築に使わない物はそのまま）
  spare(name) {
    return this.available(name) - (this.reserve?.(name) ?? 0);
  }

  // 素材を用意してもらうとき、このレシピの材料を使ってよいか（建築に使う素材を、ほかの物を作るのに使わない。
  // 例: 板材がちょうどの数しか無いのに、はしごの棒を作るのに板材を使っていた）
  #canUse(r, times = 1) {
    if (!this.stocked) return true;
    return r.ingredients.every(([ing, q]) => !(this.reserve?.(ing) > 0) || this.spare(ing) >= q * times);
  }

  // 条件に合うアイテムの中から、チェストにある物を 1 種類選んで n 個まで取る（道具・ベッド・食べ物・足場用）
  async takeAnyFromChests(names, n) {
    for (const name of names) {
      if (this.chestCount(name) <= 0) continue;
      const got = await this.takeFromChests(name, n);
      if (got > 0) return name;
    }
    return null;
  }

  // 持ち物の一部をチェストへ戻す。同じ物が入っているチェスト → 空きのあるチェスト の順に入れる。入れた数を返す
  async depositToChests(name, n) {
    const { bot } = this;
    const id = bot.registry.itemsByName[name]?.id;
    if (id === undefined) return 0;
    const start = count(bot, name);
    const order = [...this.chests.values()]
      .filter((c) => c.free > 0 || (c.items.get(name) ?? 0) > 0)
      .sort((a, b) => ((b.items.get(name) ?? 0) > 0) - ((a.items.get(name) ?? 0) > 0)
        || a.pos.distanceTo(bot.entity.position) - b.pos.distanceTo(bot.entity.position));
    for (const c of order) {
      const done = start - count(bot, name);
      if (done >= n) break;
      try {
        await this.#withChest(c.pos, async (win) => {
          const put = Math.min(n - done, count(bot, name));
          if (put > 0) await win.deposit(id, null, put).catch((e) => { if (!/full|space/i.test(e.message)) throw e; });
          Object.assign(c, this.#readWindow(win), { at: Date.now() });
        });
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        this.log.warn(`チェストに ${name} を入れられなかった: ${e.message}`);
      }
    }
    const put = start - count(bot, name);
    if (put > 0) this.log.info(`${name} を ${put} 個チェストに戻した`);
    return put;
  }

  // ツルハシが無くなったとき（使い潰した）に用意する。チェストにあれば取り、無ければ
  // 用意された素材には手を付けず、手持ちの余っている物（どけた地形の丸石・切った木など）だけで作る。
  // 作れなければ false（素手で掘り続け、チャットで頼む）。木を探して遠くまで歩き回ると現場に戻れなくなったので、木は切りに行かない
  // spareInv(name): 手持ちのうち、建築に使う分を除いた数
  async ensurePickaxeStocked(spareInv) {
    const { bot, ctx } = this;
    const PICKS = ['stone_pickaxe', 'iron_pickaxe', 'diamond_pickaxe', 'netherite_pickaxe', 'golden_pickaxe', 'wooden_pickaxe'];
    const has = () => PICKS.some((n) => count(bot, n) > 0);
    if (has()) return true;
    // 用意できなかったときは 5 分あける（チェストを何度も見に行かない）
    if (Date.now() - (this.pickFailedAt ?? 0) < 5 * 60_000) return false;
    await this.scanChests({ refreshMs: 60_000 }).catch(() => {});
    const got = await this.takeAnyFromChests(PICKS, 1);
    if (got) { this.log.info(`ツルハシが無くなったので、チェストの ${got} を持った`); return true; }
    const names = (re) => bot.registry.itemsArray.map((i) => i.name).filter((n) => re.test(n));
    const planks = names(/_planks$/);
    const sparePlanks = () => planks.reduce((s, n) => s + Math.max(0, spareInv(n)), 0);
    const want = ['cobblestone', 'cobbled_deepslate', 'blackstone'].some((n) => spareInv(n) >= 3) ? 'stone_pickaxe' : 'wooden_pickaxe';
    const tableNear = () => count(bot, 'crafting_table') > 0
      || !!bot.findBlock({ matching: bot.registry.blocksByName.crafting_table.id, maxDistance: 16 });
    // 余っている物だけを材料にするレシピで、list のどれかを 1 回作る（作業台の窓のずれは 2 回までやり直す）
    const craftSpare = async (list, table = null) => {
      for (const n of list) {
        const id = bot.registry.itemsByName[n]?.id;
        if (id === undefined) continue;
        const r = bot.recipesFor(id, null, 1, table).find((x) => x.delta.filter((d) => d.count < 0)
          .every((d) => spareInv(bot.registry.items[d.id].name) >= -d.count));
        if (!r) continue;
        for (let tries = 0; ; tries++) {
          try {
            await sleep(300);
            await bot.craft(r, 1, table);
            return true;
          } catch (e) {
            if (!/updateSlot|windowOpen/i.test(e.message) || tries >= 2) throw e;
            try { if (bot.currentWindow) bot.closeWindow(bot.currentWindow); } catch {}
            await sleep(1000);
          }
        }
      }
      return false;
    };
    try {
      const plankNeed = () => (count(bot, 'stick') >= 2 ? 0 : 2) + (tableNear() ? 0 : 4) + (want === 'wooden_pickaxe' ? 3 : 0);
      while (sparePlanks() < plankNeed() && (await craftSpare(planks))) { /* 余っている原木を板材にする */ }
      if (sparePlanks() >= plankNeed()) {
        if (count(bot, 'stick') < 2) await craftSpare(['stick']);
        if (!tableNear()) await craftSpare(['crafting_table']);
        const table = await ensureCraftingTable(ctx);
        if (await craftSpare([want], table)) this.log.info(`ツルハシが無くなったので、余っている物で ${want} を作った`);
        // 置いた作業台は持ち帰る
        if (ctx.state?.placedTable) {
          const b = bot.blockAt(ctx.state.placedTable);
          ctx.state.placedTable = null;
          if (b?.name === 'crafting_table') { await bot.dig(b, true).catch(() => {}); await pickUpItems(ctx, 4).catch(() => {}); }
        }
      }
    } catch (e) {
      if (e.name === 'AbortError' || ctx.signal?.aborted) throw e;
      this.log.warn(`ツルハシを作れなかった: ${e.message}`);
    }
    if (!has()) {
      this.pickFailedAt = Date.now();
      this.ctx.notify?.('ツルハシが無くなりました。チェストに入れてもらえると速く掘れます（それまでは素手で掘ります）');
    }
    return has();
  }

  // 仮の足場にするブロックを n 個用意する。建築に使う素材（needed）はなるべく借りない
  async ensureScaffold(n, needed = new Set()) {
    const { bot } = this;
    const have = () => SCAFFOLD_BLOCKS.reduce((s, x) => s + (needed.has(x) ? 0 : count(bot, x)), 0);
    if (have() >= n) return true;
    const spare = SCAFFOLD_BLOCKS.filter((x) => !needed.has(x));
    await this.takeAnyFromChests(spare, n - have());
    if (have() > 0) return true;
    // チェストにも無ければ、近くの土を掘る（用意してもらうのは建築の素材だけで、足場までは頼まない）
    this.log.info(`足場にするブロックが無いので、近くの土を ${n} 個掘る`);
    try {
      await this.#mine('dirt', this.naturalSources('dirt'), n);
    } catch (e) {
      if (e.name === 'AbortError' || this.ctx.signal?.aborted) throw e;
      this.log.warn(`足場用の土を掘れなかった: ${e.message}`);
    }
    return have() > 0;
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
          Object.assign(c, this.#readWindow(win), { at: Date.now() });
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
    if (best > 0.1 && this.stocked) {
      // 用意された物だけで作れるか（板材をチェストの原木から、など）
      for (const r of this.recipes(name)) {
        if (!this.#canUse(r)) continue;
        let c = 0.3;
        for (const [ing, qty] of r.ingredients) {
          c += (this.estimate(ing, depth + 1, visiting, memo) * qty) / r.resultCount;
          if (c >= best) break;
        }
        best = Math.min(best, c);
      }
    } else if (best > 0.1) {
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
    const src = this.stocked ? [] : this.naturalSources(name);
    if (src.length) options.push({ kind: 'mine', cost: this.estimate(name, 0, new Set(), memo) });
    if (!this.stocked) {
      if (SMELT[name]) options.push({ kind: 'smelt', cost: 1 + this.estimate(SMELT[name], 1, new Set([name]), memo) });
      if (/_concrete$/.test(name)) options.push({ kind: 'concrete', cost: 1 + this.estimate(`${name}_powder`, 1, new Set([name]), memo) });
      if (huntable(name)) options.push({ kind: 'mob', cost: UNIT_COST.mob });
    }
    const recipes = this.recipes(name)
      .filter((r) => this.#canUse(r))
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
        else if (opt.kind === 'craft' && this.stocked) await this.#craftStocked(name, n, opt.recipes, depth, stack);
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
    // 建物の上や中から掘り始めると、掘り下がり・横掘りで建てた所を壊すので、範囲の外へ出てから掘る
    await ctx.leaveBuildArea?.();
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

  // 素材を用意してもらうときのクラフト。使うレシピを自分で選び、建築に使う分の素材は材料にしない
  // （craftItem は持っている物から勝手にレシピを選ぶので、床に使う板材で棒を作ることがあった）
  async #craftStocked(name, n, recipes, depth, stack) {
    const { bot, ctx } = this;
    const id = bot.registry.itemsByName[name].id;
    const reservedInv = (x) => Math.max(0, (this.reserve?.(x) ?? 0) - this.chestCount(x));
    const spareInv = (x) => count(bot, x) - reservedInv(x);
    const ok = (r) => r.delta.filter((d) => d.count < 0).every((d) => spareInv(bot.registry.items[d.id].name) >= -d.count);
    let lastErr = null;
    for (const { r } of recipes.slice(0, 4)) {
      abortable(ctx);
      const missing = n - count(bot, name);
      if (missing <= 0) return;
      const times = Math.ceil(missing / r.resultCount);
      if (!this.#canUse(r, times)) continue;
      try {
        for (const [ing, q] of r.ingredients) {
          await this.ensure(ing, reservedInv(ing) + q * times, depth + 1, [...stack, name]);
        }
        let table = null;
        if (r.raw.requiresTable) {
          const tableId = bot.registry.blocksByName.crafting_table.id;
          if (count(bot, 'crafting_table') === 0 && !bot.findBlock({ matching: tableId, maxDistance: 16 })) {
            await this.ensure('crafting_table', 1, depth + 1, [...stack, name]);
          }
          table = await ensureCraftingTable(ctx);
        }
        try {
          for (let g = 0; g < times * 2 && count(bot, name) < n; g++) {
            const rr = bot.recipesFor(id, null, 1, table).find(ok);
            if (!rr) throw new SkillError(`${name} を作る材料が足りない（建築に使う分は使わない）`);
            try {
              await bot.craft(rr, 1, table);
            } catch (e) {
              // 作業台の窓の同期ずれ（updateSlot が来ない）は、窓を閉じてやり直す
              if (!/updateSlot|windowOpen/i.test(e.message)) throw e;
              try { if (bot.currentWindow) bot.closeWindow(bot.currentWindow); } catch {}
              await sleep(1000);
            }
          }
        } finally {
          // 自分で置いた作業台は持ち帰る
          if (ctx.state?.placedTable) {
            const b = bot.blockAt(ctx.state.placedTable);
            ctx.state.placedTable = null;
            if (b?.name === 'crafting_table') { await bot.dig(b, true).catch(() => {}); await pickUpItems(ctx, 4).catch(() => {}); }
          }
        }
        if (count(bot, name) >= n) return;
      } catch (e) {
        if (e.name === 'AbortError' || ctx.signal?.aborted) throw e;
        lastErr = e;
        this.log.warn(`${name} のレシピ（${r.ingredients.map(([i, q]) => `${i}×${q}`).join(' ')}）で作れなかった: ${e.message}`);
      }
    }
    if (count(bot, name) < n) throw lastErr ?? new SkillError(`${name} を作れなかった（材料は建築に使う分しか無い）`);
  }

  async #craft(name, n, recipes, depth, stack) {
    const { bot, ctx } = this;
    let lastErr = null;
    for (const { r } of recipes.slice(0, 4)) {
      abortable(ctx);
      const missing = n - count(bot, name);
      if (missing <= 0) return;
      const times = Math.ceil(missing / r.resultCount);
      if (!this.#canUse(r, times)) { lastErr = new SkillError(`${name} の材料は建築に使う分しか無い`); continue; }
      try {
        for (const [ing, q] of r.ingredients) {
          await this.ensure(ing, q * times, depth + 1, [...stack, name]);
        }
        // 用意された素材で作るときは、作業台もチェストにあればそれを使う（板材を作業台に使ってしまわない）
        if (this.stocked && r.raw.requiresTable && count(bot, 'crafting_table') === 0
          && !bot.findBlock({ matching: bot.registry.blocksByName.crafting_table.id, maxDistance: 16 })) {
          await this.takeAnyFromChests(['crafting_table'], 1);
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
