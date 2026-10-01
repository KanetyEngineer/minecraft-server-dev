// 序盤〜中盤（オーバーワールド）のスキル
import {
  SkillError, abortable, mineBlocks, branchMine, craftItem, ensurePlanks, smelt, attackEntity,
  pickUpItems, exploreStep, placeNear, goNearBlock, goTo, nearestEntityNamed, goals, Vec3, LOGS, dim,
  pillarUp, pillarDown, isNextToLiquid, collectWithTimeout,
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

// 幹が地面までつながっている原木だけを狙う。切り残しで宙に浮いた枝や葉の中の原木は
// 地上から届かず、その下をぐるぐる回り続けてしまう。
export function isGroundedLog(bot, block) {
  let p = block.position;
  for (let i = 0; i < 12; i++) {
    p = p.offset(0, -1, 0);
    const b = bot.blockAt(p);
    if (!b) return false;
    if (isLog(b.name)) continue;
    return b.boundingBox === 'block' && !b.name.endsWith('_leaves');
  }
  return false;
}

const posKey = (p) => `${p.x},${p.y},${p.z}`;

// from の周り（斜めも含む 26 方向）につながる原木をたどって tree に足す。アカシアの斜めの枝も拾える。
export function addConnectedLogs(bot, from, tree, { limit = 48, radius = 6 } = {}) {
  const queue = [from];
  const seen = new Set([posKey(from)]);
  while (queue.length > 0 && tree.size < limit) {
    const p = queue.shift();
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const q = p.offset(dx, dy, dz);
          const k = posKey(q);
          if (seen.has(k)) continue;
          seen.add(k);
          if (Math.abs(q.x - from.x) > radius || Math.abs(q.z - from.z) > radius || q.y < from.y - 1) continue;
          const b = bot.blockAt(q);
          if (!b || !isLog(b.name)) continue;
          tree.set(k, q);
          queue.push(q);
        }
      }
    }
  }
  return tree;
}

// 届かない原木: 近くまで歩き、届く高さまでブロックを積んで登り、届く範囲の原木をまとめて切って降りる。
// 積むブロックが無ければ、持っている原木から板材を作って使う（降りるときに掘って回収する）。
async function cutFromPillar(ctx, block, tree, onMined) {
  const { bot } = ctx;
  const p = block.position;
  await bot.pathfinder.goto(new goals.GoalNearXZ(p.x + 0.5, p.z + 0.5, 1.5)).catch(() => {});
  const feetY = Math.floor(bot.entity.position.y);
  const need = p.y - feetY - 3; // 足元から 3〜4 段上までは手が届く
  if (need > 8) return false;
  let placed = 0;
  if (need > 0) {
    const blocks = bot.inventory.items()
      .filter((i) => ['cobblestone', 'cobbled_deepslate', 'dirt', 'netherrack', 'stone', 'andesite', 'diorite', 'granite'].includes(i.name) || i.name.endsWith('_planks'))
      .reduce((s, i) => s + i.count, 0);
    if (blocks < need) await ensurePlanks(ctx, need + 4);
    placed = await pillarUp(ctx, need);
  }
  try {
    // 登った位置から届く原木を近い順に切る（狙いの原木も含む）
    const eye = () => bot.entity.position.offset(0, 1.62, 0);
    const reach = [...tree.values(), p]
      .filter((q) => eye().distanceTo(q.offset(0.5, 0.5, 0.5)) <= 4.5)
      .sort((a, b) => eye().distanceTo(a) - eye().distanceTo(b));
    let cut = false;
    for (const q of reach) {
      const b = bot.blockAt(q);
      if (!b || !isLog(b.name)) { tree.delete(`${q.x},${q.y},${q.z}`); continue; }
      await bot.tool.equipForBlock(b, {}).catch(() => {});
      await bot.dig(b, true);
      onMined(b);
      if (q.equals(p)) cut = true;
    }
    return cut;
  } finally {
    if (placed > 0) await pillarDown(ctx, placed);
    await pickUpItems(ctx, 8).catch(() => {});
  }
}

export async function gatherWood(ctx, { logs = 8 } = {}) {
  const { bot } = ctx;
  const have = () => countMatching(bot, isLog);
  const target = have() + logs;
  // 切り始めた木は残さず切る: 切った原木につながる原木を覚えておき、新しい木より先に切る
  const tree = new Map(); // key -> Vec3
  const onMined = (b) => { tree.delete(posKey(b.position)); addConnectedLogs(bot, b.position, tree); };
  const finishTree = async (limit) => {
    for (let n = 0; n < limit && tree.size > 0; n++) {
      abortable(ctx);
      const me = bot.entity.position;
      const [k, pos] = [...tree.entries()].sort((a, b) => a[1].distanceTo(me) - b[1].distanceTo(me))[0];
      const block = bot.blockAt(pos);
      if (!block || !isLog(block.name)) { tree.delete(k); continue; }
      try {
        await collectWithTimeout(ctx, block);
        onMined(block);
      } catch (e) {
        if (e.name === 'AbortError' || ctx.signal?.aborted) throw e;
        ctx.log.warn(`木の残りに届かない、ブロックを積んで切る: ${e.message}`);
        const ok = await cutFromPillar(ctx, block, tree, onMined).catch((err) => {
          if (err.name === 'AbortError' || ctx.signal?.aborted) throw err;
          ctx.log.warn(`積んでも切れなかった: ${err.message}`);
          return false;
        });
        if (!ok) tree.delete(k); // 積んでも届かない枝だけあきらめる
      }
    }
  };
  for (let guard = 0; guard < logs * 3 + 10 && have() < target; guard++) {
    abortable(ctx);
    if (tree.size > 0) { await finishTree(1); continue; }
    // 次の木: 幹が地面につながっている原木から切り始める
    const got = await mineBlocks(ctx, LOGS, 1, { maxDistance: 48, maxExplore: 20, filter: (b) => isGroundedLog(bot, b), onMined });
    if (got === 0) break;
  }
  await finishTree(24); // 目標数に届いても、切りかけの木は最後まで切る
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
      if (web) { await collectWithTimeout(ctx, web).catch(() => {}); continue; }
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
    if (obs) { await collectWithTimeout(ctx, obs).catch((e) => ctx.log.warn(e.message)); continue; }
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

export async function makeBed(ctx, { count: want = 1 } = {}) {
  const { bot } = ctx;
  const beds = () => countMatching(bot, (n) => n.endsWith('_bed'));
  if (beds() >= want) return `ベッドを ${beds()} 個持っている`;
  // 必要なベッドの数 × 3 枚の羊毛を集める（エンドのベッド爆破用に複数作ることもある）
  const woolNeed = (want - beds()) * 3;
  for (let t = 0; t < 20 + woolNeed * 2 && countMatching(bot, (n) => n.endsWith('_wool')) < woolNeed; t++) {
    abortable(ctx);
    const sheep = nearestEntityNamed(bot, ['sheep'], 40);
    if (!sheep) { await exploreStep(ctx); continue; }
    await attackEntity(ctx, sheep);
    await pickUpItems(ctx);
  }
  const wool = bot.inventory.items().find((i) => i.name.endsWith('_wool') && i.count >= 3);
  if (!wool) {
    // 羊が見つからないときは、しばらくベッド作りを飛ばして先へ進む（進行表が繰り返し選ばないように）
    ctx.memory.setFlag('bedRetryAt', Date.now() + 10 * 60_000);
    throw new SkillError('羊毛が 3 つそろわない');
  }
  // 色ごとに 3 枚ずつそろっている分だけ作る
  for (const w of bot.inventory.items().filter((i) => i.name.endsWith('_wool'))) {
    for (let k = 0; k < Math.floor(w.count / 3) && beds() < want; k++) {
      await ensurePlanks(ctx, 3);
      const bedName = w.name.replace('_wool', '_bed');
      await craftItem(ctx, bedName, count(bot, bedName) + 1);
    }
  }
  return `ベッド ${beds()} 個`;
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

// 夜の避難: その場で 3 マス掘り下がって頭上をふさぐ（普通のプレイヤーの「穴にこもる」）。
// ベッドを持っていれば穴の横に 2 マス空けて置いて寝る（起きたら回収）。寝られなければ朝まで待つ。
export async function shelterForNight(ctx) {
  const { bot } = ctx;
  if (bot.time.isDay) return 'もう朝';
  bot.pathfinder.stop();
  const solidSafe = (b) => b && b.boundingBox === 'block' && bot.canDigBlock(b) && !isNextToLiquid(bot, b.position);
  // 足元から 4 段下まで固くて液体の無い場所か（木の上や洞窟の天井では掘らない）
  const diggableAt = (feet) => [1, 2, 3].every((d) => solidSafe(bot.blockAt(feet.offset(0, -d, 0))))
    && bot.blockAt(feet.offset(0, -4, 0))?.boundingBox === 'block';
  if (!diggableAt(bot.entity.position.floored())) {
    const ground = ['grass_block', 'dirt', 'stone', 'sand', 'coarse_dirt', 'podzol', 'deepslate', 'andesite', 'diorite', 'granite']
      .map((n) => bot.registry.blocksByName[n]?.id).filter((id) => id !== undefined);
    const spot = bot.findBlocks({ matching: ground, maxDistance: 16, count: 64 })
      .map((p) => p.offset(0, 1, 0))
      .find((f) => bot.blockAt(f)?.boundingBox === 'empty' && bot.blockAt(f.offset(0, 1, 0))?.boundingBox === 'empty' && diggableAt(f));
    if (spot) await bot.pathfinder.goto(new goals.GoalBlock(spot.x, spot.y, spot.z)).catch(() => {});
  }
  for (let i = 0; i < 3; i++) {
    abortable(ctx);
    const below = bot.blockAt(bot.entity.position.floored().offset(0, -1, 0));
    const under = below && bot.blockAt(below.position.offset(0, -1, 0));
    // 下が空洞・液体なら掘らない（洞窟や溶岩に落ちない）
    if (!solidSafe(below) || !under || under.boundingBox !== 'block' || under.name === 'lava') break;
    await bot.tool.equipForBlock(below, {}).catch(() => {});
    const y0 = bot.entity.position.y;
    await bot.dig(below, true);
    // 掘った直後はまだ落ちていないので、1 マス下に着地するまで待つ（待たないと次の「足元」が今掘った穴になる）
    for (let t = 0; t < 30 && !(bot.entity.onGround && bot.entity.position.y <= y0 - 0.9); t++) await bot.waitForTicks(1);
    if (bot.entity.position.y > y0 - 0.9) break;
  }
  // 頭上（足元 +2）を、穴の壁を足場にしてふさぐ
  const feet = bot.entity.position.floored();
  const cover = feet.offset(0, 2, 0);
  if (bot.blockAt(cover)?.boundingBox !== 'block') {
    const findCoverItem = () => bot.inventory.items().find((i) => ['dirt', 'cobblestone', 'cobbled_deepslate', 'stone', 'andesite', 'diorite', 'granite', 'sand', 'gravel', 'netherrack'].includes(i.name) || i.name.endsWith('_planks') || i.name.endsWith('_log'));
    let item = findCoverItem();
    // ふたにするブロックが無ければ、穴の壁（頭の高さ）を 1 つ掘って手に入れる
    if (!item) {
      const side = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([x, z]) => bot.blockAt(feet.offset(x, 1, z)))
        .find((b) => b && b.boundingBox === 'block' && bot.canDigBlock(b) && !isNextToLiquid(bot, b.position));
      if (side) {
        await bot.tool.equipForBlock(side, {}).catch(() => {});
        await bot.dig(side, true).catch(() => {});
        await sleep(1500); // 落ちたブロックを拾う
        item = findCoverItem();
      }
    }
    if (!item) ctx.log.warn('ふたにするブロックが無い');
    // 壁は上段（ふたの横）→ 下段（頭の横、上面に置く）の順に試す
    const walls = [
      ...[[1, 0], [-1, 0], [0, 1], [0, -1]].map(([x, z]) => ({ b: bot.blockAt(cover.offset(x, 0, z)), face: (b) => cover.minus(b.position) })),
      ...[[1, 0], [-1, 0], [0, 1], [0, -1]].map(([x, z]) => ({ b: bot.blockAt(cover.offset(x, -1, z)), face: () => new Vec3(0, 1, 0) })),
    ].filter(({ b }) => b && b.boundingBox === 'block');
    if (item && walls.length === 0) ctx.log.warn('ふたを支える壁が無い');
    for (const { b, face } of walls) {
      if (!item || bot.blockAt(cover)?.boundingBox === 'block') break;
      try {
        await bot.equip(item, 'hand');
        await bot.look(bot.entity.yaw, Math.PI / 2 * (face(b).y > 0 ? 0.5 : 0), true).catch(() => {});
        await bot.placeBlock(b, face(b));
      } catch (e) {
        ctx.log.warn(`ふたを置けなかった（${b.name} 側）: ${e.message}`);
      }
      // 下段の上面に置くと頭の高さに入るので、その場合はさらにその上がふたになる
      await bot.waitForTicks(4);
    }
  }
  const covered = bot.blockAt(cover)?.boundingBox === 'block';
  ctx.log.info(`🌙 穴にこもって朝を待つ（ふた ${covered ? 'あり' : 'なし'}）`);
  ctx.state.sheltered = covered; // ふたがある間は反射で飛び出さない（agent.js）
  const start = Date.now();
  try {
    const bedItem = bot.inventory.items().find((i) => i.name.endsWith('_bed'));
    if (bedItem && covered) {
      const slept = await sleepInShelter(ctx, feet, bedItem).catch((e) => {
        if (e.name === 'AbortError' || ctx.signal?.aborted) throw e;
        ctx.log.warn(`寝られなかった、朝まで待つ: ${e.message}`);
        return false;
      });
      if (slept) ctx.log.info('🛏 ベッドで寝て朝になった');
    }
    while (!bot.time.isDay && Date.now() - start < 9 * 60_000) {
      abortable(ctx);
      await sleep(2000);
    }
  } finally {
    ctx.state.sheltered = false;
  }
  // ふたを掘って出る（出るのは次のスキルの移動に任せる）
  const lid = bot.blockAt(cover);
  if (covered && lid && bot.canDigBlock(lid)) {
    await bot.tool.equipForBlock(lid, {}).catch(() => {});
    await bot.dig(lid, true).catch(() => {});
  }
  return bot.time.isDay ? '朝まで穴で過ごした' : '待ちきれず出た';
}

// 穴の底の横に 2 マス空けてベッドを置き、寝る。起きたらベッドを掘って持ち帰る。寝られたら true。
async function sleepInShelter(ctx, feet, bedItem) {
  const { bot } = ctx;
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const a = feet.offset(dx, 0, dz);
    const b = feet.offset(dx * 2, 0, dz * 2);
    const floors = [a, b].map((q) => bot.blockAt(q.offset(0, -1, 0)));
    if (!floors.every((f) => f && f.boundingBox === 'block')) continue;
    if ([a, b].some((q) => isNextToLiquid(bot, q))) continue;
    for (const q of [a, b]) {
      const blk = bot.blockAt(q);
      if (blk && blk.boundingBox === 'block' && bot.canDigBlock(blk)) {
        await bot.tool.equipForBlock(blk, {}).catch(() => {});
        await bot.dig(blk, true).catch(() => {});
      }
    }
    if (![a, b].every((q) => bot.blockAt(q)?.boundingBox === 'empty')) continue;
    // ベッドは向いている方向に頭が伸びるので、穴の横方向を向いてから置く
    await bot.look(Math.atan2(-dx, -dz), -0.6, true);
    await bot.equip(bedItem, 'hand');
    await bot.placeBlock(floors[0], new Vec3(0, 1, 0));
    const bed = bot.blockAt(a);
    if (!bed || !bed.name.endsWith('_bed')) continue;
    try {
      await bot.sleep(bed);
      const t0 = Date.now();
      while (bot.isSleeping && Date.now() - t0 < 9 * 60_000) {
        abortable(ctx);
        await sleep(1000);
      }
      return true;
    } finally {
      // 寝られても寝られなくても、ベッドは回収して持ち歩く
      const placed = bot.blockAt(a);
      if (placed && placed.name.endsWith('_bed')) {
        await bot.dig(placed, true).catch(() => {});
        await sleep(400);
        await pickUpItems(ctx, 4).catch(() => {});
      }
    }
  }
  return false;
}