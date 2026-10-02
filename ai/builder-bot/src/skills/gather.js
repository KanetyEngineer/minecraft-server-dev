// 素材集めの基本スキル（DragonBot の overworld.js から、木・丸石・道具・食料・鉄の部分を流用）
import {
  SkillError, abortable, mineBlocks, branchMine, craftItem, ensurePlanks, smelt, attackEntity,
  pickUpItems, exploreStep, placeNear, goNearBlock, goTo, nearestEntityNamed, goals, Vec3, LOGS, dim,
  pillarUp, pillarDown, isNextToLiquid, collectWithTimeout, cheapBlock, ascendToSurface, ensurePickaxe, digOrRetry,
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
      if (!(await digOrRetry(bot, b, true))) continue;
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
  await ascendToSurface(ctx); // 地上でやる作業なので、地下にいたらまず地上へ
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
  const hasPick = () => PICKAXES.some((p) => findItem(bot, p));
  // 木のツルハシは 59 回で壊れるので、途中で壊れたらその場で作り直して続ける（木集めからやり直さない）
  const ensurePick = async () => {
    if (hasPick()) return true;
    ctx.log.info('ツルハシが壊れたので木のツルハシを作り直す');
    try {
      await ensurePlanks(ctx, 3);
      await craftItem(ctx, 'stick', 2);
      await craftItem(ctx, 'wooden_pickaxe', 1);
    } catch (e) {
      ctx.log.warn(`ツルハシを作り直せなかった: ${e.message}`);
    }
    return hasPick();
  };
  for (let round = 0; round < 3 && cobbleCount(bot) < n; round++) {
    abortable(ctx);
    // ツルハシなしで石を掘っても何も落ちず、経路探索も膨れるので先に止める
    if (!(await ensurePick())) throw new SkillError('ツルハシが無いので丸石を掘れない');
    // 見えている石を掘る。無ければ少し掘り下がる。
    ctx.log.info(`丸石集め ${round + 1} 回目: 見えている石を掘る（${cobbleCount(bot)}/${n}）`);
    await mineBlocks(ctx, COBBLE_SOURCES, n - cobbleCount(bot), { maxDistance: 24, maxExplore: 2 });
    if (cobbleCount(bot) < n && (await ensurePick())) {
      const y = Math.floor(bot.entity.position.y);
      ctx.log.info(`丸石集め: 足りないので y=${y - 8} まで掘り下がって横に掘る（${cobbleCount(bot)}/${n}）`);
      await branchMine(ctx, COBBLE_SOURCES, n - cobbleCount(bot), y - 8, { length: 12 });
    }
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
        // 必須はツルハシだけ。剣・斧・シャベルは材料が足りなければ後回しにする（全部そろわないと失敗にしていた）
        if (t === 'stone_pickaxe') await craftItem(ctx, t, 1);
        else await craftItem(ctx, t, 1).catch((e) => ctx.log.warn(`${t} は後回し: ${e.message}`));
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
  await ascendToSurface(ctx); // 地上でやる作業なので、地下にいたらまず地上へ
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
  // 生肉は焼く。燃料（石炭・木炭・木材）が無ければ先に原木を少し集める
  // （燃料もかまども無いまま「焼けなかった」→成功扱い→同じ作業を 3 秒ごとに繰り返していた）
  const hasFuel = () => count(bot, 'coal') + count(bot, 'charcoal') > 0
    || countMatching(bot, (n) => isLog(n) || n.endsWith('_planks')) > 0;
  if (rawCount() > 0 && !hasFuel()) {
    ctx.log.info('肉を焼く燃料が無いので原木を集める');
    await gatherWood(ctx, { logs: 3 }).catch((e) => ctx.log.warn(`燃料用の木を集められなかった: ${e.message}`));
  }
  // かまどが無く丸石も 8 個無ければ、かまど用の丸石を掘る（死んで丸石を失った後に焼けなかった）
  if (rawCount() > 0 && !findItem(bot, 'furnace') && cobbleCount(bot) < 8) {
    await getCobblestone(ctx, 8).catch((e) => ctx.log.warn(`かまど用の丸石を集められなかった: ${e.message}`));
  }
  for (const raw of Object.keys(RAW)) {
    // 焼けなくても生肉は食べられるので、失敗しても集めた分は成果とする
    if (count(bot, raw) > 0) await smelt(ctx, raw, count(bot, raw)).catch((e) => ctx.log.warn(`焼けなかった: ${e.message}`));
  }
  abortable(ctx); // 焼いている途中で中断されたら、成功扱いにせず中断として返す
  if (cookedCount() === 0 && rawCount() === 0) throw new SkillError('動物が見つからなかった');
  // 焼けずに食料が目標に届かないときは失敗として返す（成功扱いだと同じ作業を延々と繰り返す）
  if (rawCount() > 0 && cookedCount() < amount && !hasFuel()) {
    throw new SkillError(`肉を焼けない（燃料が無い）。食料 ${cookedCount()} 個（生 ${rawCount()}）`);
  }
  return `食料 ${cookedCount()} 個（生 ${rawCount()}）`;
}

// そのブロックの下（または手前の足場）が 4 マス以上の空洞なら、渓谷や大きな洞窟の壁にあるとみなす
function overVoid(bot, pos) {
  for (const [dx, dz] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
    let air = 0;
    for (let dy = 1; dy <= 5; dy++) {
      const b = bot.blockAt(pos.offset(dx, -dy, dz));
      if (!b || b.boundingBox !== 'empty') break;
      air++;
    }
    if (air >= 4) return true;
  }
  return false;
}

async function ensureIronIngots(ctx, n) {
  const { bot } = ctx;
  const ingots = () => count(bot, 'iron_ingot');
  if (ingots() >= n) return;
  const needRaw = n - ingots() - count(bot, 'raw_iron');
  if (needRaw > 0) {
    // 鉄鉱石は石のツルハシ以上でないと掘れない
    if (!(await ensurePickaxe(ctx, { minTier: 'stone' }))) throw new SkillError('石のツルハシが無くて鉄を掘れない');
    // 洞窟や渓谷で転落・溺死・挟み撃ちが多かったので、鉄掘りの間は高い所から降りない。
    // 見えている鉄鉱石は、近くて足元より大きく低くなく、下が深い空洞（渓谷の壁）でないものだけ狙う。
    // 無ければ自分で掘った坑道（Y=16 付近のブランチマイニング）で探す
    const mv = bot.pathfinder.movements;
    const prevDrop = mv?.maxDropDown;
    if (mv) mv.maxDropDown = 2;
    try {
      const me = bot.entity.position;
      const safeOre = (b) => b.position.distanceTo(me) <= 16 && b.position.y >= me.y - 4 && !overVoid(bot, b.position);
      await mineBlocks(ctx, IRON_ORE, needRaw, { maxDistance: 16, maxExplore: 1, filter: safeOre });
      if (n - ingots() - count(bot, 'raw_iron') > 0) {
        // 長い掘り下がりの途中でツルハシが壊れても作り直せるよう、棒と予備の石のツルハシを用意してから潜る
        //（地下で木が無くなりツルハシを作れず、時間切れになったことがある）
        // 地下でツルハシを作り直すには棒と作業台（木材）が要る。木材が少なければ、潜る前に地上で原木を集めておく
        //（丸石は 400 個あるのに木が無く、地下でツルハシを作れずに失敗した）
        const woodNow = countMatching(bot, isLog) * 4 + countMatching(bot, (n) => n.endsWith('_planks'));
        if (woodNow < 16) await gatherWood(ctx, { logs: Math.ceil((16 - woodNow) / 4) + 1 }).catch((e) => ctx.log.warn(`潜る前の木集めに失敗: ${e.message}`));
        await craftItem(ctx, 'stick', 8).catch(() => {});
        if (count(bot, 'cobblestone') + count(bot, 'cobbled_deepslate') >= 6) await craftItem(ctx, 'stone_pickaxe', 2).catch(() => {});
        // y=16 まで降りると 50 段以上かかり 10 分の制限に届くので、鉄がまだ多い y=24 で掘る
        await branchMine(ctx, [...IRON_ORE, ...COAL_ORE], (n - ingots() - count(bot, 'raw_iron')) * 2, 24);
      }
    } finally {
      if (mv && prevDrop !== undefined) mv.maxDropDown = prevDrop;
    }
  }
  // 燃料に石炭を少し確保
  if (count(bot, 'coal') + count(bot, 'charcoal') < Math.ceil(n / 8)) {
    await mineBlocks(ctx, COAL_ORE, 3, { maxDistance: 32, maxExplore: 2 }).catch(() => {});
  }
  if (count(bot, 'raw_iron') > 0) await smelt(ctx, 'raw_iron', count(bot, 'raw_iron'));
  if (ingots() < n) throw new SkillError(`鉄インゴットが足りない（${ingots()}/${n}）`);
}

export { ensureIronIngots, STONE, COBBLE_SOURCES, IRON_ORE, COAL_ORE };
