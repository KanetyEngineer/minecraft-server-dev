// 序盤〜中盤（オーバーワールド）のスキル
import {
  SkillError, abortable, mineBlocks, branchMine, craftItem, ensurePlanks, smelt, attackEntity,
  pickUpItems, exploreStep, placeNear, goNearBlock, goTo, nearestEntityNamed, goals, Vec3, LOGS, dim,
} from './common.js';
import { count, findItem, countMatching, isLog } from '../util/items.js';
import { findVisibleBlocks, smoothLookAt, sleep } from '../body/humanize.js';

const STONE = ['stone', 'cobblestone', 'deepslate', 'cobbled_deepslate', 'andesite', 'diorite', 'granite', 'tuff'];
// 掘ると丸石（深層岩の丸石）になるもの。花崗岩などはそのまま落ちるので丸石集めには使わない。
const COBBLE_SOURCES = ['stone', 'cobblestone', 'deepslate', 'cobbled_deepslate'];
const PICKAXES = ['wooden_pickaxe', 'stone_pickaxe', 'iron_pickaxe', 'diamond_pickaxe', 'netherite_pickaxe'];
const IRON_ORE = ['iron_ore', 'deepslate_iron_ore'];
const COAL_ORE = ['coal_ore', 'deepslate_coal_ore'];
const DIAMOND_ORE = ['diamond_ore', 'deepslate_diamond_ore'];
const cobbleCount = (bot) => count(bot, 'cobblestone') + count(bot, 'cobbled_deepslate');

export async function gatherWood(ctx, { logs = 8 } = {}) {
  const { bot } = ctx;
  const have = () => countMatching(bot, isLog);
  const target = have() + logs;
  await mineBlocks(ctx, LOGS, logs, { maxDistance: 48, maxExplore: 20 });
  if (have() < Math.min(target, 4)) throw new SkillError('木が見つからなかった');
  // 作業台と木のツルハシまで作っておく（普通のプレイヤーの最初の流れ）
  if (!findItem(bot, 'wooden_pickaxe') && !findItem(bot, 'stone_pickaxe')) {
    await ensurePlanks(ctx, 8);
    await craftItem(ctx, 'wooden_pickaxe', 1);
  }
  return `原木 ${have()} 本`;
}

export async function getCobblestone(ctx, n) {
  const { bot } = ctx;
  if (cobbleCount(bot) >= n) return;
  // ツルハシなしで石を掘っても何も落ちず、経路探索も膨れるので先に止める
  if (!PICKAXES.some((p) => findItem(bot, p))) throw new SkillError('ツルハシが無いので丸石を掘れない');
  // 見えている石を掘る。無ければ少し掘り下がる。
  await mineBlocks(ctx, COBBLE_SOURCES, n - cobbleCount(bot), { maxDistance: 24, maxExplore: 2 });
  if (cobbleCount(bot) < n && PICKAXES.some((p) => findItem(bot, p))) {
    const y = Math.floor(bot.entity.position.y);
    await branchMine(ctx, COBBLE_SOURCES, n - cobbleCount(bot), y - 8, { length: 12 });
  }
  if (cobbleCount(bot) < n) throw new SkillError(`丸石が足りない（${cobbleCount(bot)}/${n}）`);
}

export async function makeTools(ctx, { tier = 'stone' } = {}) {
  const { bot } = ctx;
  if (tier === 'wooden') {
    await ensurePlanks(ctx, 6);
    await craftItem(ctx, 'wooden_pickaxe', 1);
    await craftItem(ctx, 'wooden_sword', 1);
    return '木のツール完成';
  }
  if (tier === 'stone') {
    if (!findItem(bot, 'wooden_pickaxe') && !findItem(bot, 'stone_pickaxe')) await makeTools(ctx, { tier: 'wooden' });
    await getCobblestone(ctx, 16);
    for (const t of ['stone_pickaxe', 'stone_sword', 'stone_axe', 'stone_shovel']) {
      if (countMatching(bot, (n) => n.endsWith(t.split('_')[1]) && !n.startsWith('wooden')) === 0) {
        await craftItem(ctx, t, 1);
      }
    }
    if (!findItem(bot, 'furnace')) await craftItem(ctx, 'furnace', 1);
    return '石のツールとかまど完成';
  }
  throw new SkillError(`tier=${tier} は getIronGear / mineDiamonds を使う`);
}

const ANIMALS = ['cow', 'pig', 'sheep', 'chicken', 'rabbit', 'mooshroom'];
const RAW = { beef: 'cooked_beef', porkchop: 'cooked_porkchop', mutton: 'cooked_mutton', chicken: 'cooked_chicken', rabbit: 'cooked_rabbit' };

export async function gatherFood(ctx, { amount = 12 } = {}) {
  const { bot } = ctx;
  const rawCount = () => Object.keys(RAW).reduce((s, n) => s + count(bot, n), 0);
  const cookedCount = () => Object.values(RAW).reduce((s, n) => s + count(bot, n), 0) + count(bot, 'bread');
  let tries = 0;
  while (rawCount() + cookedCount() < amount && tries < 25) {
    abortable(ctx);
    const a = nearestEntityNamed(bot, ANIMALS, 40);
    if (!a) { tries++; await exploreStep(ctx); continue; }
    await attackEntity(ctx, a, { timeoutMs: 20000 });
    await pickUpItems(ctx, 6);
  }
  // 生肉は焼く
  for (const raw of Object.keys(RAW)) {
    // 焼けなくても生肉は食べられるので、失敗しても集めた分は成果とする
    if (count(bot, raw) > 0) await smelt(ctx, raw, count(bot, raw)).catch((e) => ctx.log.warn(`焼けなかった: ${e.message}`));
  }
  if (cookedCount() === 0 && rawCount() === 0) throw new SkillError('動物が見つからなかった');
  return `食料 ${cookedCount()} 個（生 ${rawCount()}）`;
}

async function ensureIronIngots(ctx, n) {
  const { bot } = ctx;
  const ingots = () => count(bot, 'iron_ingot');
  if (ingots() >= n) return;
  const needRaw = n - ingots() - count(bot, 'raw_iron');
  if (needRaw > 0) {
    // まず見えている鉄鉱石、無ければ Y=16 付近でブランチマイニング
    await mineBlocks(ctx, IRON_ORE, needRaw, { maxDistance: 32, maxExplore: 3 });
    if (n - ingots() - count(bot, 'raw_iron') > 0) {
      await branchMine(ctx, [...IRON_ORE, ...COAL_ORE], (n - ingots() - count(bot, 'raw_iron')) * 2, 16);
    }
  }
  // 燃料に石炭を少し確保
  if (count(bot, 'coal') + count(bot, 'charcoal') < Math.ceil(n / 8)) {
    await mineBlocks(ctx, COAL_ORE, 3, { maxDistance: 32, maxExplore: 2 }).catch(() => {});
  }
  if (count(bot, 'raw_iron') > 0) await smelt(ctx, 'raw_iron', count(bot, 'raw_iron'));
  if (ingots() < n) throw new SkillError(`鉄インゴットが足りない（${ingots()}/${n}）`);
}

export async function getIronGear(ctx, { armor = false } = {}) {
  const { bot } = ctx;
  if (!findItem(bot, 'stone_pickaxe') && !findItem(bot, 'iron_pickaxe') && !findItem(bot, 'diamond_pickaxe')) {
    await makeTools(ctx, { tier: 'stone' });
  }
  const want = [];
  if (!findItem(bot, 'iron_pickaxe') && !findItem(bot, 'diamond_pickaxe')) want.push(['iron_pickaxe', 3]);
  if (!findItem(bot, 'iron_sword') && !findItem(bot, 'diamond_sword')) want.push(['iron_sword', 2]);
  if (!findItem(bot, 'bucket') && !findItem(bot, 'water_bucket') && !findItem(bot, 'lava_bucket')) want.push(['bucket', 3]);
  if (armor) {
    for (const [p, c] of [['iron_chestplate', 8], ['iron_leggings', 7], ['iron_helmet', 5], ['iron_boots', 4], ['shield', 1]]) {
      const worn = bot.inventory.slots.some((s) => s && s.name.endsWith(p.split('_')[1]) && !s.name.startsWith('leather'));
      if (!worn) want.push([p, c]);
    }
  }
  if (want.length === 0) return '鉄装備はそろっている';
  const total = want.reduce((s, [, c]) => s + c, 0);
  await ensureIronIngots(ctx, total);
  for (const [name] of want) {
    if (name === 'shield') await ensurePlanks(ctx, 6);
    await craftItem(ctx, name, 1);
  }
  await bot.armorManager.equipAll();
  const shield = findItem(bot, 'shield');
  if (shield) await bot.equip(shield, 'off-hand');
  return `作成: ${want.map(([n]) => n).join(', ')}`;
}

export async function mineDiamonds(ctx, { count: n = 3 } = {}) {
  const { bot } = ctx;
  if (!findItem(bot, 'iron_pickaxe') && !findItem(bot, 'diamond_pickaxe')) throw new SkillError('鉄のツルハシが必要');
  const start = count(bot, 'diamond');
  await mineBlocks(ctx, DIAMOND_ORE, n, { maxDistance: 24, explore: false });
  if (count(bot, 'diamond') - start < n) await branchMine(ctx, DIAMOND_ORE, n - (count(bot, 'diamond') - start), -58, { length: 80 });
  const got = count(bot, 'diamond') - start;
  if (count(bot, 'diamond') >= 3 && !findItem(bot, 'diamond_pickaxe')) await craftItem(ctx, 'diamond_pickaxe', 1);
  if (count(bot, 'diamond') >= 2 && !findItem(bot, 'diamond_sword')) await craftItem(ctx, 'diamond_sword', 1);
  if (got === 0 && !findItem(bot, 'diamond_pickaxe')) throw new SkillError('ダイヤが見つからなかった');
  return `ダイヤ ${got} 個入手`;
}

export async function makeBowAndArrows(ctx, { arrows = 32 } = {}) {
  const { bot } = ctx;
  const night = !bot.time.isDay;
  // 糸: 夜ならクモ、昼ならクモの巣（剣で切る）
  if (!findItem(bot, 'bow') && count(bot, 'string') < 3) {
    for (let t = 0; t < 15 && count(bot, 'string') < 3; t++) {
      abortable(ctx);
      const spider = nearestEntityNamed(bot, ['spider', 'cave_spider'], 32);
      if (spider) { await attackEntity(ctx, spider); await pickUpItems(ctx); continue; }
      const web = findVisibleBlocks(bot, ['cobweb'], { maxDistance: 32, count: 1 })[0];
      if (web) { await bot.collectBlock.collect(web, { ignoreNoPath: true }).catch(() => {}); continue; }
      const skel = night && nearestEntityNamed(bot, ['skeleton'], 24);
      if (skel) { await attackEntity(ctx, skel); await pickUpItems(ctx); if (findItem(bot, 'bow')) break; continue; }
      await exploreStep(ctx);
    }
    if (!findItem(bot, 'bow')) await craftItem(ctx, 'bow', 1);
  }
  // 矢: 火打石（砂利）＋羽（ニワトリ）＋棒
  const batches = Math.ceil(Math.max(0, arrows - count(bot, 'arrow')) / 4);
  for (let t = 0; t < 40 && count(bot, 'flint') < batches; t++) {
    abortable(ctx);
    const got = await mineBlocks(ctx, ['gravel'], 1, { maxDistance: 32, maxExplore: 1 });
    if (got === 0) break;
  }
  for (let t = 0; t < 30 && count(bot, 'feather') < batches; t++) {
    abortable(ctx);
    const ch = nearestEntityNamed(bot, ['chicken'], 40);
    if (!ch) { await exploreStep(ctx); continue; }
    await attackEntity(ctx, ch);
    await pickUpItems(ctx);
  }
  const can = Math.min(count(bot, 'flint'), count(bot, 'feather'));
  if (can > 0) await craftItem(ctx, 'arrow', count(bot, 'arrow') + can * 4);
  if (!findItem(bot, 'bow')) throw new SkillError('弓を作れなかった');
  return `弓あり、矢 ${count(bot, 'arrow')} 本`;
}

export async function fillWaterBucket(ctx) {
  const { bot } = ctx;
  if (findItem(bot, 'water_bucket')) return 'すでに水入りバケツがある';
  if (!findItem(bot, 'bucket')) await craftItem(ctx, 'bucket', 1);
  const src = () => findVisibleBlocks(bot, ['water'], { maxDistance: 48, count: 1, extra: (b) => b.metadata === 0 })[0];
  for (let t = 0; t < 10 && !src(); t++) await exploreStep(ctx);
  const water = src();
  if (!water) throw new SkillError('水源が見つからない');
  await goNearBlock(ctx, water, 3);
  await bot.equip(findItem(bot, 'bucket'), 'hand');
  await smoothLookAt(bot, water.position.offset(0.5, 0.8, 0.5), ctx.cfg.human.turnSpeed);
  bot.activateItem();
  await sleep(500);
  if (!findItem(bot, 'water_bucket')) throw new SkillError('水をくめなかった');
  return '水入りバケツ入手';
}

// 溶岩溜まりに水をかけて黒曜石にし、ダイヤのツルハシで掘る
export async function collectObsidian(ctx, { count: n = 10 } = {}) {
  const { bot } = ctx;
  if (!findItem(bot, 'diamond_pickaxe')) throw new SkillError('ダイヤのツルハシが必要');
  if (!findItem(bot, 'water_bucket')) await fillWaterBucket(ctx);
  let guard = 0;
  while (count(bot, 'obsidian') < n && guard++ < 60) {
    abortable(ctx);
    // すでに黒曜石が見えていればそれを掘る
    const obs = findVisibleBlocks(bot, ['obsidian'], { maxDistance: 24, count: 1 })[0];
    if (obs) { await bot.collectBlock.collect(obs, { ignoreNoPath: true }).catch((e) => ctx.log.warn(e.message)); continue; }
    const lava = findVisibleBlocks(bot, ['lava'], { maxDistance: 48, count: 1, extra: (b) => b.metadata === 0 })[0];
    if (!lava) {
      // 洞窟の溶岩を探して少し下へ
      if (bot.entity.position.y > 0) await branchMine(ctx, ['lava'], 1, -40, { length: 30 }).catch(() => {});
      else await exploreStep(ctx, 24);
      continue;
    }
    await goNearBlock(ctx, lava, 3);
    await bot.equip(findItem(bot, 'water_bucket'), 'hand');
    await smoothLookAt(bot, lava.position.offset(0.5, 1, 0.5), ctx.cfg.human.turnSpeed);
    bot.activateItem(); // 水をかける
    await sleep(800);
    // 水をバケツに戻す
    const water = findVisibleBlocks(bot, ['water'], { maxDistance: 5, count: 1, extra: (b) => b.metadata === 0, visibleOnly: false })[0];
    if (water && findItem(bot, 'bucket')) {
      await bot.equip(findItem(bot, 'bucket'), 'hand');
      await smoothLookAt(bot, water.position.offset(0.5, 0.5, 0.5), ctx.cfg.human.turnSpeed);
      bot.activateItem();
      await sleep(400);
    }
  }
  if (count(bot, 'obsidian') < n) throw new SkillError(`黒曜石が足りない（${count(bot, 'obsidian')}/${n}）`);
  return `黒曜石 ${count(bot, 'obsidian')} 個`;
}

// 4x5 の枠（角は丸石）を建てて火打石で着火する
export async function buildNetherPortal(ctx) {
  const { bot, memory } = ctx;
  if (count(bot, 'obsidian') < 10) throw new SkillError('黒曜石が 10 個必要');
  if (!findItem(bot, 'flint_and_steel')) await craftItem(ctx, 'flint_and_steel', 1);
  if (count(bot, 'cobblestone') < 4) await mineBlocks(ctx, COBBLE_SOURCES, 4, { maxExplore: 2 });

  const origin = findPortalSite(bot);
  if (!origin) throw new SkillError('ポータルを建てる平らな場所がない');
  const { x: ox, y: oy, z: oz } = origin;
  // 立ち位置: 枠の正面 3 ブロック手前
  await goTo(ctx, ox + 1, oy, oz + 3, 0.5);

  const frame = [];
  for (let x = 0; x < 4; x++) {
    for (let y = 0; y < 5; y++) {
      const edgeX = x === 0 || x === 3;
      const edgeY = y === 0 || y === 4;
      if (!edgeX && !edgeY) continue;
      frame.push({ x, y, block: edgeX && edgeY ? 'cobblestone' : 'obsidian' });
    }
  }
  frame.sort((a, b) => a.y - b.y || a.x - b.x); // 下から順に積む
  for (const f of frame) {
    abortable(ctx);
    const target = new Vec3(ox + f.x, oy + f.y, oz);
    const cur = bot.blockAt(target);
    if (cur && cur.name === f.block) continue;
    if (cur && cur.name !== 'air') await bot.dig(cur).catch(() => {});
    const ref = [[0, -1, 0], [-1, 0, 0], [1, 0, 0], [0, 0, 1]].map(([x, y, z]) => bot.blockAt(target.offset(x, y, z)))
      .find((b) => b && b.boundingBox === 'block');
    if (!ref) throw new SkillError('枠を置く足場がない');
    await bot.equip(findItem(bot, f.block), 'hand');
    await smoothLookAt(bot, target.offset(0.5, 0.5, 0.5), ctx.cfg.human.turnSpeed);
    await bot.placeBlock(ref, target.minus(ref.position));
  }
  // 着火
  await bot.equip(findItem(bot, 'flint_and_steel'), 'hand');
  const bottom = bot.blockAt(new Vec3(ox + 1, oy, oz));
  await smoothLookAt(bot, bottom.position.offset(0.5, 1, 0.5), ctx.cfg.human.turnSpeed);
  await bot.activateBlock(bottom, new Vec3(0, 1, 0));
  await sleep(1000);
  const portal = bot.blockAt(new Vec3(ox + 1, oy + 1, oz));
  if (!portal || portal.name !== 'nether_portal') throw new SkillError('ポータルに火が付かなかった');
  memory.setPlace('overworld_portal', portal.position, 'overworld');
  return `ネザーポータル完成 (${ox + 1}, ${oy + 1}, ${oz})`;
}

function findPortalSite(bot) {
  const p = bot.entity.position.floored();
  for (let r = 2; r < 10; r++) {
    for (const [dx, dz] of [[r, 0], [-r, 0], [0, r], [0, -r], [r, r], [-r, -r]]) {
      const ox = p.x + dx; const oy = p.y; const oz = p.z + dz;
      let ok = true;
      for (let x = 0; x < 4 && ok; x++) {
        const ground = bot.blockAt(new Vec3(ox + x, oy - 1, oz));
        if (!ground || ground.boundingBox !== 'block') ok = false;
        for (let y = 0; y < 5 && ok; y++) {
          const b = bot.blockAt(new Vec3(ox + x, oy + y, oz));
          if (!b || !['air', 'short_grass', 'tall_grass', 'grass', 'fern', 'snow'].includes(b.name)) ok = false;
        }
      }
      // 正面の立ち位置も空いていること
      const stand = bot.blockAt(new Vec3(ox + 1, oy, oz + 3));
      if (ok && stand && stand.name === 'air') return { x: ox, y: oy, z: oz };
    }
  }
  return null;
}

export async function makeBed(ctx) {
  const { bot } = ctx;
  if (bot.inventory.items().some((i) => i.name.endsWith('_bed'))) return 'ベッドを持っている';
  for (let t = 0; t < 20 && countMatching(bot, (n) => n.endsWith('_wool')) < 3; t++) {
    abortable(ctx);
    const sheep = nearestEntityNamed(bot, ['sheep'], 40);
    if (!sheep) { await exploreStep(ctx); continue; }
    await attackEntity(ctx, sheep);
    await pickUpItems(ctx);
  }
  const wool = bot.inventory.items().find((i) => i.name.endsWith('_wool') && i.count >= 3);
  if (!wool) throw new SkillError('羊毛が 3 つそろわない');
  await ensurePlanks(ctx, 3);
  await craftItem(ctx, wool.name.replace('_wool', '_bed'), 1);
  return 'ベッド完成';
}

export async function sleepInBed(ctx) {
  const { bot, memory } = ctx;
  if (bot.time.isDay) return 'まだ昼なので寝られない';
  let bed = findVisibleBlocks(bot, Object.keys(bot.registry.blocksByName).filter((n) => n.endsWith('_bed')), { maxDistance: 32, count: 1, visibleOnly: false })[0];
  if (!bed) {
    const item = bot.inventory.items().find((i) => i.name.endsWith('_bed'));
    if (!item) throw new SkillError('ベッドがない（makeBed で作る）');
    bed = await placeNear(ctx, item.name);
  }
  memory.setPlace('bed', bed.position, dim(ctx));
  await goNearBlock(ctx, bed, 2);
  await bot.sleep(bot.blockAt(bed.position));
  await new Promise((r) => bot.once('wake', r));
  return 'おはよう';
}

export async function gatherBlocks(ctx, { count: n = 64 } = {}) {
  await getCobblestone(ctx, n);
  return `足場ブロック ${cobbleCount(ctx.bot)} 個`;
}

export { STONE, IRON_ORE, DIAMOND_ORE, goals };
