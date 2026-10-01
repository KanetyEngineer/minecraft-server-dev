// ネザー関連とエンダーパール集め
import {
  SkillError, abortable, attackEntity, pickUpItems, exploreStep, travelTo, goTo, nearestEntityNamed, craftItem, dim, goals, placeWallToward,
} from './common.js';
import { count, findItem } from '../util/items.js';
import { findVisibleBlocks, sleep, smoothLookAt } from '../body/humanize.js';
import { Vec3 } from 'vec3';

// ポータルに入り、次元が変わるのを待つ
export async function walkIntoPortal(ctx, place, expectDim) {
  const { bot } = ctx;
  if (dim(ctx) === expectDim) return;
  if (!place) throw new SkillError('ポータルの場所を覚えていない');
  await travelTo(ctx, place.x, place.z, { range: 2 });
  const portal = findVisibleBlocks(bot, ['nether_portal'], { maxDistance: 8, count: 1, visibleOnly: false })[0];
  if (!portal) throw new SkillError('ポータルが見当たらない（壊れた？）');
  await bot.pathfinder.goto(new goals.GoalBlock(portal.position.x, portal.position.y, portal.position.z)).catch(() => {});
  for (let i = 0; i < 40; i++) {
    abortable(ctx);
    if (dim(ctx) === expectDim) {
      await sleep(2000); // チャンク読み込み待ち
      return;
    }
    await sleep(500);
  }
  throw new SkillError('次元が切り替わらなかった');
}

export async function enterNether(ctx) {
  const { bot, memory } = ctx;
  await walkIntoPortal(ctx, memory.getPlace('overworld_portal'), 'the_nether');
  memory.setPlace('nether_portal', bot.entity.position, 'the_nether');
  return 'ネザーに到着';
}

export async function returnThroughPortal(ctx) {
  const { memory } = ctx;
  if (dim(ctx) === 'the_nether') {
    await walkIntoPortal(ctx, memory.getPlace('nether_portal'), 'overworld');
    return 'オーバーワールドに戻った';
  }
  return 'ネザーにいないので何もしない';
}

// 要塞（ネザーレンガ）を見つけて、ブレイズを倒してロッドを集める
export async function huntBlazes(ctx, { rods = 6 } = {}) {
  const { bot, memory } = ctx;
  if (dim(ctx) !== 'the_nether') throw new SkillError('ネザーにいない（enterNether が先）');
  const rodCount = () => count(bot, 'blaze_rod');
  let fortress = memory.getPlace('fortress');
  for (let t = 0; !fortress && t < 60; t++) {
    abortable(ctx);
    const brick = findVisibleBlocks(bot, ['nether_bricks', 'nether_brick_fence'], { maxDistance: 64, count: 1 })[0];
    if (brick) {
      memory.setPlace('fortress', brick.position, 'the_nether');
      fortress = memory.getPlace('fortress');
      ctx.say?.('要塞みつけた！');
      break;
    }
    await exploreStep(ctx, 48);
  }
  if (!fortress) throw new SkillError('要塞が見つからなかった');
  await travelTo(ctx, fortress.x, fortress.z, { range: 4 });

  let cleared = false;
  for (let t = 0; rodCount() < rods && t < 80; t++) {
    abortable(ctx);
    const blaze = nearestEntityNamed(bot, ['blaze'], 32);
    // 体力が少ないときは戦わず、ブレイズとの間に壁を置いて回復を待つ（火の玉は壁で防げる）
    if (blaze && bot.health <= 8) {
      await placeWallToward(ctx, blaze, 2).catch(() => 0);
      ctx.log.info('体力が少ないので壁の裏で回復を待つ');
      for (let w = 0; w < 20 && bot.health < 14; w++) { abortable(ctx); await sleep(1000); }
      continue;
    }
    if (blaze) {
      const reachable = Math.abs(blaze.position.y - bot.entity.position.y) < 3;
      if (!reachable && findItem(bot, 'bow') && count(bot, 'arrow') > 0) {
        await shootAt(ctx, blaze);
      } else {
        await attackEntity(ctx, blaze, { timeoutMs: 15000 });
      }
      await pickUpItems(ctx, 10);
      continue;
    }
    // スポナーを探してその近くで待つ。周りの土・石を壊すと湧く範囲（9×3×9）が広がる
    const spawner = findVisibleBlocks(bot, ['spawner'], { maxDistance: 48, count: 1 })[0];
    if (spawner) {
      memory.setPlace('blaze_spawner', spawner.position, 'the_nether');
      if (!cleared) { await clearAroundSpawner(ctx, spawner.position).catch((e) => ctx.log.warn(`スポナー周りを掘れなかった: ${e.message}`)); cleared = true; }
      await goTo(ctx, spawner.position.x + 3, spawner.position.y, spawner.position.z + 3, 2).catch(() => {});
      await sleep(4000);
    } else {
      // 要塞の中: ネザーウォートのある階段は下り、無い階段は上るとスポナーのある屋外側に出やすい
      const wart = findVisibleBlocks(bot, ['nether_wart'], { maxDistance: 24, count: 1 })[0];
      if (wart) await goTo(ctx, wart.position.x, wart.position.y - 2, wart.position.z, 3).catch(() => {});
      else await exploreStep(ctx, 24);
    }
  }
  if (rodCount() < rods) throw new SkillError(`ブレイズロッド ${rodCount()}/${rods}`);
  return `ブレイズロッド ${rodCount()} 本`;
}

// スポナー周りの地形ブロック（ネザーラック・砂利・ソウルサンド）を壊して湧き場所を増やす。要塞のレンガは壊さない
const SPAWNER_CLUTTER = new Set(['netherrack', 'gravel', 'soul_sand', 'soul_soil', 'blackstone', 'basalt', 'magma_block']);
async function clearAroundSpawner(ctx, pos) {
  const { bot } = ctx;
  let dug = 0;
  for (let dy = 0; dy <= 2 && dug < 24; dy++) {
    for (let dx = -3; dx <= 3; dx++) {
      for (let dz = -3; dz <= 3; dz++) {
        abortable(ctx);
        const b = bot.blockAt(pos.offset(dx, dy, dz));
        if (!b || !SPAWNER_CLUTTER.has(b.name) || !bot.canDigBlock(b)) continue;
        if (b.position.distanceTo(bot.entity.position) > 4.5) {
          await goTo(ctx, b.position.x, b.position.y, b.position.z, 3).catch(() => {});
          if (b.position.distanceTo(bot.entity.position) > 4.5) continue;
        }
        await bot.tool.equipForBlock(b, {}).catch(() => {});
        await bot.dig(b).catch(() => {});
        dug++;
      }
    }
  }
  ctx.log.info(`スポナー周りを ${dug} ブロック掘った`);
}

export async function shootAt(ctx, entity, { shots = 4 } = {}) {
  const { bot } = ctx;
  if (!findItem(bot, 'bow') || count(bot, 'arrow') === 0) throw new SkillError('弓か矢がない');
  for (let i = 0; i < shots && entity.isValid; i++) {
    abortable(ctx);
    await bot.equip(findItem(bot, 'bow'), 'hand');
    bot.hawkEye.oneShot(entity, 'bow');
    await sleep(1600);
  }
  return !entity.isValid;
}

// 金を渡してピグリンと物々交換（エンダーパール狙い）
export async function barterWithPiglins(ctx, { pearls = 12 } = {}) {
  const { bot } = ctx;
  if (dim(ctx) !== 'the_nether') throw new SkillError('ネザーにいない');
  // 金の防具を 1 つ着ていないと襲われる
  const goldArmor = ['golden_helmet', 'golden_boots', 'golden_chestplate', 'golden_leggings'];
  if (!bot.inventory.slots.slice(5, 9).some((s) => s && goldArmor.includes(s.name))) {
    if (!goldArmor.some((n) => findItem(bot, n))) await craftItem(ctx, 'golden_boots', 1);
    const g = goldArmor.map((n) => findItem(bot, n)).find(Boolean);
    await bot.equip(g, g.name.includes('helmet') ? 'head' : g.name.includes('boots') ? 'feet' : g.name.includes('chest') ? 'torso' : 'legs');
  }
  const start = count(bot, 'ender_pearl');
  for (let t = 0; count(bot, 'ender_pearl') - start < pearls && count(bot, 'gold_ingot') > 0 && t < 60; t++) {
    abortable(ctx);
    const piglin = nearestEntityNamed(bot, ['piglin'], 40);
    if (!piglin) { await exploreStep(ctx, 32); continue; }
    await goTo(ctx, piglin.position.x, piglin.position.y, piglin.position.z, 3).catch(() => {});
    await smoothLookAt(bot, piglin.position.offset(0, 1, 0), ctx.cfg.human.turnSpeed);
    // ピグリンが多ければまとめて投げる（1 体につき 1 個ずつ品定めするので、待ち時間を節約できる）
    const nearby = Object.values(bot.entities).filter((e) => e.name === 'piglin' && e.position.distanceTo(bot.entity.position) < 6).length;
    const toss = Math.max(1, Math.min(nearby, 4, count(bot, 'gold_ingot')));
    await bot.toss(bot.registry.itemsByName.gold_ingot.id, null, toss);
    await sleep(7000); // ピグリンが品定めする時間
    await pickUpItems(ctx, 8);
  }
  return `エンダーパール +${count(bot, 'ender_pearl') - start}`;
}

// エンダーマンを倒してパールを集める（夜のオーバーワールドか歪んだ森）
const WARPED = ['warped_nylium', 'warped_stem', 'warped_wart_block'];
const BOATS = ['oak_boat', 'spruce_boat', 'birch_boat', 'jungle_boat', 'acacia_boat', 'dark_oak_boat', 'mangrove_boat', 'cherry_boat', 'pale_oak_boat'];

// エンダーマンを倒してパールを集める。
// ネザーで歪んだ森が見つかっていれば、ボートにエンダーマンを乗せて（ワープできなくして）倒す。
export async function huntEndermen(ctx, { pearls = 12 } = {}) {
  const { bot, memory } = ctx;
  const start = count(bot, 'ender_pearl');
  if (dim(ctx) === 'the_nether') {
    const warped = findVisibleBlocks(bot, WARPED, { maxDistance: 64, count: 1 })[0];
    if (warped && !memory.getPlace('warped_forest')) memory.setPlace('warped_forest', warped.position, 'the_nether');
    const wf = memory.getPlace('warped_forest');
    if (wf) await travelTo(ctx, wf.x, wf.z, { range: 6 }).catch(() => {});
  }
  for (let t = 0; count(bot, 'ender_pearl') - start < pearls && t < 60; t++) {
    abortable(ctx);
    const em = nearestEntityNamed(bot, ['enderman'], 48);
    if (!em) {
      if (dim(ctx) === 'overworld' && bot.time.isDay) return `昼なのでエンダーマンが少ない（+${count(bot, 'ender_pearl') - start}）`;
      await exploreStep(ctx, 40);
      continue;
    }
    const inWarped = dim(ctx) === 'the_nether' && !!memory.getPlace('warped_forest');
    if (inWarped && await boatTrapEnderman(ctx, em)) {
      await pickUpItems(ctx, 8);
      continue;
    }
    // 近づいて目を合わせ、向かってきたところを倒す
    await goTo(ctx, em.position.x, em.position.y, em.position.z, 6).catch(() => {});
    await smoothLookAt(bot, em.position.offset(0, 2.6, 0), ctx.cfg.human.turnSpeed);
    await sleep(600);
    await attackEntity(ctx, em, { timeoutMs: 25000 });
    await pickUpItems(ctx, 8);
  }
  return `エンダーパール ${count(bot, 'ender_pearl')} 個`;
}

// ボート捕獲: 自分とエンダーマンの間にボートを置き、目を合わせて呼び寄せる。
// ボートに乗ったエンダーマンはワープできないので、そのまま剣で倒す。
async function boatTrapEnderman(ctx, em) {
  const { bot } = ctx;
  let boat = bot.inventory.items().find((i) => BOATS.includes(i.name));
  if (!boat) {
    const plank = bot.inventory.items().find((i) => i.name.endsWith('_planks') && i.count >= 5);
    if (!plank) return false;
    const boatName = `${plank.name.replace('_planks', '')}_boat`;
    if (!bot.registry.itemsByName[boatName]) return false; // 歪んだ/真紅の板材ではボートは作れない
    await craftItem(ctx, boatName, 1).catch(() => {});
    boat = bot.inventory.items().find((i) => BOATS.includes(i.name));
    if (!boat) return false;
  }
  // エンダーマンから 8 マスほどの所に立ち、相手側 2 マス先の地面にボートを置く
  const dx = bot.entity.position.x - em.position.x; const dz = bot.entity.position.z - em.position.z;
  const d = Math.hypot(dx, dz) || 1;
  await bot.pathfinder.goto(new goals.GoalNearXZ(em.position.x + (dx / d) * 8, em.position.z + (dz / d) * 8, 2)).catch(() => {});
  const p = bot.entity.position.floored();
  const ux = Math.round(-dx / d); const uz = Math.round(-dz / d);
  const floor = bot.blockAt(p.offset(ux * 2, -1, uz * 2));
  if (!floor || floor.boundingBox !== 'block') return false;
  await bot.equip(boat, 'hand');
  await smoothLookAt(bot, floor.position.offset(0.5, 1, 0.5), ctx.cfg.human.turnSpeed);
  try { await bot.placeEntity(floor, new Vec3(0, 1, 0)); } catch { return false; }
  const vehicle = bot.nearestEntity((e) => e.name && e.name.endsWith('boat') && e.position.distanceTo(bot.entity.position) < 4);
  if (!vehicle) return false;
  // 目を合わせて怒らせ、ボートの方へ来させる（ボートの真後ろに立っておく）
  await smoothLookAt(bot, em.position.offset(0, 2.6, 0), 60);
  let caught = false;
  for (let i = 0; i < 40 && em.isValid; i++) {
    await sleep(250);
    if (em.vehicle === vehicle || em.position.distanceTo(vehicle.position) < 0.8) { caught = true; break; }
  }
  if (caught) {
    ctx.say?.('ボートで捕まえた');
    const sword = ['netherite_sword', 'diamond_sword', 'iron_sword', 'stone_sword'].map((n) => findItem(bot, n)).find(Boolean);
    if (sword) await bot.equip(sword, 'hand');
    for (let i = 0; i < 40 && em.isValid; i++) {
      if (em.position.distanceTo(bot.entity.position) > 3) {
        await bot.pathfinder.goto(new goals.GoalNear(em.position.x, em.position.y, em.position.z, 2)).catch(() => {});
      }
      await bot.lookAt(em.position.offset(0, 1.2, 0), true);
      bot.attack(em);
      await sleep(650);
    }
  } else {
    // 捕まらなければ普通に戦う
    await attackEntity(ctx, em, { timeoutMs: 20000 }).catch(() => {});
  }
  // ボートを壊して回収
  for (let i = 0; vehicle.isValid && i < 6; i++) { bot.attack(vehicle); await sleep(300); }
  return true;
}

// 砦の遺跡（廃要塞）を探して金ブロックを集め、金インゴットにする（RTA の流れ: ピグリン交易の元手）
const BASTION_BLOCKS = ['gilded_blackstone', 'polished_blackstone_bricks', 'cracked_polished_blackstone_bricks', 'chiseled_polished_blackstone', 'gold_block'];

export async function raidBastionGold(ctx, { ingots = 64 } = {}) {
  const { bot, memory } = ctx;
  if (dim(ctx) !== 'the_nether') throw new SkillError('ネザーにいない');
  if (!['iron_pickaxe', 'diamond_pickaxe', 'netherite_pickaxe'].some((n) => findItem(bot, n))) throw new SkillError('鉄以上のツルハシが必要');
  // 金の防具を着てピグリンを怒らせないようにする（金ブロックを掘ると周りのピグリンは怒るので、掘るのは手早く）
  await wearGold(ctx);
  let bastion = memory.getPlace('bastion');
  for (let t = 0; !bastion && t < 50; t++) {
    abortable(ctx);
    const b = findVisibleBlocks(bot, BASTION_BLOCKS, { maxDistance: 64, count: 1 })[0];
    if (b) { memory.setPlace('bastion', b.position, 'the_nether'); bastion = memory.getPlace('bastion'); ctx.say?.('廃要塞みつけた'); break; }
    await exploreStep(ctx, 48);
  }
  if (!bastion) throw new SkillError('廃要塞が見つからなかった');
  await travelTo(ctx, bastion.x, bastion.z, { range: 6 });
  const goldTotal = () => count(bot, 'gold_ingot') + count(bot, 'gold_block') * 9;
  for (let t = 0; goldTotal() < ingots && t < 40; t++) {
    abortable(ctx);
    const g = findVisibleBlocks(bot, ['gold_block', 'gilded_blackstone', 'nether_gold_ore'], { maxDistance: 32, count: 1 })[0];
    if (!g) { await exploreStep(ctx, 16); continue; }
    await bot.collectBlock.collect(g, { ignoreNoPath: true }).catch((e) => ctx.log.warn(e.message));
  }
  // 金ブロックはインゴットに、金塊はインゴットにまとめる
  if (count(bot, 'gold_block') > 0) await craftItem(ctx, 'gold_ingot', count(bot, 'gold_ingot') + count(bot, 'gold_block') * 9).catch(() => {});
  if (count(bot, 'gold_nugget') >= 9) await craftItem(ctx, 'gold_ingot', count(bot, 'gold_ingot') + Math.floor(count(bot, 'gold_nugget') / 9)).catch(() => {});
  return `金インゴット ${count(bot, 'gold_ingot')} 個`;
}

async function wearGold(ctx) {
  const { bot } = ctx;
  const goldArmor = ['golden_helmet', 'golden_boots', 'golden_chestplate', 'golden_leggings'];
  if (bot.inventory.slots.slice(5, 9).some((s) => s && goldArmor.includes(s.name))) return;
  if (!goldArmor.some((n) => findItem(bot, n)) && count(bot, 'gold_ingot') >= 4) await craftItem(ctx, 'golden_boots', 1).catch(() => {});
  const g = goldArmor.map((n) => findItem(bot, n)).find(Boolean);
  if (g) await bot.equip(g, g.name.includes('helmet') ? 'head' : g.name.includes('boots') ? 'feet' : g.name.includes('chest') ? 'torso' : 'legs');
}
