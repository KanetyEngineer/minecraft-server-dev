// スキル同士で共有する基本動作（移動・採掘・クラフト・精錬・設置・探索）。
// どれも既存プラグイン（pathfinder / collectblock / tool / pvp）の上に薄く書いている。
import pathfinderPkg from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import { findVisibleBlocks, sleep, smoothLookAt } from '../body/humanize.js';
import { count, findItem, isLog, isPlanks, LOGS } from '../util/items.js';
import { dimensionOf } from '../brain/progress.js';

const { goals } = pathfinderPkg;

export class SkillError extends Error {}

export function abortable(ctx) {
  if (ctx.signal?.aborted) {
    const e = new Error('中断された');
    e.name = 'AbortError';
    throw e;
  }
}

// ---------- 移動 ----------

export async function goTo(ctx, x, y, z, range = 1) {
  abortable(ctx);
  const goal = y === null || y === undefined ? new goals.GoalNearXZ(x, z, range) : new goals.GoalNear(x, y, z, range);
  await ctx.bot.pathfinder.goto(goal);
}

export async function goNearBlock(ctx, block, range = 2) {
  const p = block.position;
  await goTo(ctx, p.x, p.y, p.z, range);
}

// 長距離移動: 一度に遠くを目指すと経路計算が重いので、64 ブロックずつ区切って進む。
export async function travelTo(ctx, x, z, { step = 64, range = 3 } = {}) {
  const { bot } = ctx;
  for (let i = 0; i < 200; i++) {
    abortable(ctx);
    const p = bot.entity.position;
    const dx = x - p.x;
    const dz = z - p.z;
    const d = Math.hypot(dx, dz);
    if (d <= range + 1) return;
    const k = Math.min(1, step / d);
    try {
      await bot.pathfinder.goto(new goals.GoalNearXZ(p.x + dx * k, p.z + dz * k, range));
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      // 行けなかったら少し横にずらして再挑戦
      const side = (Math.random() < 0.5 ? -1 : 1) * 16;
      await bot.pathfinder.goto(new goals.GoalNearXZ(p.x + dz / d * side, p.z - dx / d * side, 4)).catch(() => {});
    }
  }
}

// 探索: 前回と近い向きに 24〜40 ブロック歩く。行き止まりなら向きを変える。
export async function exploreStep(ctx, distance = 32) {
  const { bot } = ctx;
  ctx.state.heading = (ctx.state.heading ?? Math.random() * Math.PI * 2) + (Math.random() - 0.5) * 0.8;
  const p = bot.entity.position;
  const d = distance * (0.75 + Math.random() * 0.5);
  const tx = p.x + Math.cos(ctx.state.heading) * d;
  const tz = p.z + Math.sin(ctx.state.heading) * d;
  try {
    await bot.pathfinder.goto(new goals.GoalNearXZ(tx, tz, 4));
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    ctx.state.heading += Math.PI / 2 + Math.random() * Math.PI;
  }
}

// ---------- 採掘 ----------

// 見えているブロックを掘って集める。見つからなければ探索する。
export async function mineBlocks(ctx, names, n, { maxDistance = 40, explore = true, maxExplore = 12 } = {}) {
  const { bot, cfg } = ctx;
  let mined = 0;
  let explored = 0;
  while (mined < n) {
    abortable(ctx);
    const blocks = findVisibleBlocks(bot, names, { maxDistance, count: 4, visibleOnly: cfg.human.visibleOnly });
    if (blocks.length === 0) {
      if (!explore || explored >= maxExplore) break;
      explored++;
      await exploreStep(ctx);
      continue;
    }
    try {
      await bot.collectBlock.collect(blocks[0], { ignoreNoPath: true });
      mined++;
    } catch (e) {
      if (e.name === 'AbortError' || ctx.signal?.aborted) throw e;
      ctx.log.warn(`採掘失敗 ${blocks[0].name}: ${e.message}`);
      if (/tool|harvest/i.test(e.message)) throw new SkillError(`${blocks[0].name} を掘る道具がない`);
      await exploreStep(ctx, 12);
    }
  }
  return mined;
}

// 指定の高さまで階段状に掘り下がる（真下には掘らない）
export async function descendTo(ctx, targetY) {
  const { bot } = ctx;
  for (let i = 0; i < 200 && bot.entity.position.y > targetY + 1; i++) {
    abortable(ctx);
    const p = bot.entity.position.floored();
    const dir = ctx.state.stairDir ?? (ctx.state.stairDir = [[1, 0], [-1, 0], [0, 1], [0, -1]][Math.floor(Math.random() * 4)]);
    const next = p.offset(dir[0], -1, dir[1]);
    // 前方の頭・体・足元の 3 ブロックを掘る
    for (const dy of [2, 1, 0]) {
      const b = bot.blockAt(next.offset(0, dy, 0));
      if (b && b.boundingBox === 'block' && bot.canDigBlock(b)) {
        if (isNextToLiquid(bot, b.position)) {
          ctx.state.stairDir = [dir[1], -dir[0]]; // 液体があれば向きを変える
          break;
        }
        await bot.tool.equipForBlock(b, {});
        await bot.dig(b);
      }
    }
    const floor = bot.blockAt(next.offset(0, -1, 0));
    if (!floor || floor.boundingBox !== 'block') {
      // 足場が無い（洞窟など）→ pathfinder に任せる
      await bot.pathfinder.goto(new goals.GoalY(targetY)).catch(() => {});
      return;
    }
    await bot.pathfinder.goto(new goals.GoalBlock(next.x, next.y, next.z)).catch(() => {});
  }
}

export function isNextToLiquid(bot, pos) {
  for (const [x, y, z] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, 0, 1], [0, 0, -1]]) {
    const b = bot.blockAt(pos.offset(x, y, z));
    if (b && (b.name === 'lava' || b.name === 'water')) return true;
  }
  return false;
}

// ブランチマイニング: 指定の高さで横穴を掘り進み、壁に見えた鉱石を掘る。
export async function branchMine(ctx, ores, n, y, { length = 60 } = {}) {
  const { bot } = ctx;
  if (Math.abs(bot.entity.position.y - y) > 3) await descendTo(ctx, y);
  let got = 0;
  const start = count(bot, ores[0]);
  const dirs = [[1, 0], [0, 1], [-1, 0], [0, -1]];
  let di = Math.floor(Math.random() * 4);
  for (let leg = 0; leg < 6 && got < n; leg++) {
    const [dx, dz] = dirs[di % 4];
    for (let s = 0; s < length && got < n; s += 4) {
      abortable(ctx);
      const p = bot.entity.position.floored();
      try {
        await bot.pathfinder.goto(new goals.GoalBlock(p.x + dx * 4, p.y, p.z + dz * 4));
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        break;
      }
      const seen = findVisibleBlocks(bot, ores, { maxDistance: 8, count: 4, visibleOnly: true });
      for (const b of seen) {
        abortable(ctx);
        await bot.collectBlock.collect(b, { ignoreNoPath: true }).catch((e) => ctx.log.warn(e.message));
        got++;
      }
    }
    di += Math.random() < 0.5 ? 1 : 3; // 左右どちらかに曲がる
  }
  return Math.max(got, count(bot, ores[0]) - start);
}

// ---------- アイテム回収 ----------

export async function pickUpItems(ctx, radius = 8) {
  const { bot } = ctx;
  for (let i = 0; i < 10; i++) {
    abortable(ctx);
    const item = bot.nearestEntity((e) => e.name === 'item' && e.position.distanceTo(bot.entity.position) < radius);
    if (!item) return;
    await bot.pathfinder.goto(new goals.GoalNear(item.position.x, item.position.y, item.position.z, 0.8)).catch(() => {});
    await sleep(250);
  }
}

// ---------- 設置 ----------

// 足元周辺の置ける場所を探してブロックを置く
export async function placeNear(ctx, itemName) {
  const { bot } = ctx;
  const item = findItem(bot, itemName);
  if (!item) throw new SkillError(`${itemName} を持っていない`);
  const base = bot.entity.position.floored();
  for (const [x, z] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [2, 0], [0, 2], [-2, 0], [0, -2]]) {
    const target = base.offset(x, 0, z);
    const at = bot.blockAt(target);
    const below = bot.blockAt(target.offset(0, -1, 0));
    if (at && at.name === 'air' && below && below.boundingBox === 'block') {
      await bot.equip(item, 'hand');
      await smoothLookAt(bot, target.offset(0.5, 0, 0.5), ctx.cfg.human.turnSpeed);
      try {
        await bot.placeBlock(below, new Vec3(0, 1, 0));
        return bot.blockAt(target);
      } catch (e) {
        ctx.log.warn(`設置失敗: ${e.message}`);
      }
    }
  }
  throw new SkillError(`${itemName} を置ける場所がない`);
}

// ---------- クラフト ----------

async function nearbyBlock(ctx, name, dist = 6) {
  const b = findVisibleBlocks(ctx.bot, [name], { maxDistance: 24, count: 1, visibleOnly: false })[0];
  if (!b) return null;
  if (b.position.distanceTo(ctx.bot.entity.position) > dist) await goNearBlock(ctx, b, 2);
  return ctx.bot.blockAt(b.position);
}

export async function ensureCraftingTable(ctx) {
  const near = await nearbyBlock(ctx, 'crafting_table');
  if (near) return near;
  if (!findItem(ctx.bot, 'crafting_table')) await craftItem(ctx, 'crafting_table', 1, { noTable: true });
  return placeNear(ctx, 'crafting_table');
}

// 材料が足りなければ中間素材（板材・棒など）も作る簡易レシピ解決
export async function craftItem(ctx, name, n = 1, { noTable = false, depth = 0 } = {}) {
  const { bot } = ctx;
  abortable(ctx);
  const item = bot.registry.itemsByName[name];
  if (!item) throw new SkillError(`不明なアイテム: ${name}`);
  if (count(bot, name) >= n) return;

  const tryCraft = async (table) => {
    for (let guard = 0; guard < 64 && count(bot, name) < n; guard++) {
      const r = bot.recipesFor(item.id, null, 1, table)[0];
      if (!r) return false;
      await bot.craft(r, 1, table ?? undefined);
    }
    return true;
  };

  if (await tryCraft(null)) { if (count(bot, name) >= n) return; }
  let table = null;
  if (!noTable) {
    table = await ensureCraftingTable(ctx);
    if (await tryCraft(table)) { if (count(bot, name) >= n) return; }
  }
  if (depth >= 4) throw new SkillError(`${name} の材料が足りない`);

  // 材料の不足分を数えて、作れるものは作る
  const all = bot.recipesAll(item.id, null, table ?? null);
  if (all.length === 0) throw new SkillError(`${name} のレシピが見つからない`);
  const missingOf = (r) => {
    const times = Math.ceil((n - count(bot, name)) / r.result.count);
    return r.delta.filter((d) => d.count < 0).map((d) => {
      const nm = bot.registry.items[d.id].name;
      return { name: nm, need: -d.count * times, have: count(bot, nm) };
    }).filter((m) => m.have < m.need);
  };
  const recipe = all
    .map((r) => ({ r, miss: missingOf(r) }))
    .sort((a, b) => a.miss.reduce((s, m) => s + m.need - m.have, 0) - b.miss.reduce((s, m) => s + m.need - m.have, 0))[0];
  for (const m of recipe.miss) {
    if (isPlanks(m.name)) {
      await ensurePlanks(ctx, m.need, m.name);
    } else {
      await craftItem(ctx, m.name, m.need, { noTable, depth: depth + 1 });
    }
  }
  if (!(await tryCraft(table)) || count(bot, name) < n) {
    if (count(bot, name) < n) throw new SkillError(`${name} を ${n} 個作れなかった（現在 ${count(bot, name)}）`);
  }
}

// 板材は木の種類が何でもよい場面が多いので、持っている原木から作る
export async function ensurePlanks(ctx, n, preferred) {
  const { bot } = ctx;
  const plankTotal = () => bot.inventory.items().filter((i) => isPlanks(i.name)).reduce((s, i) => s + i.count, 0);
  if (preferred && count(bot, preferred) >= n) return;
  for (let g = 0; g < 20 && plankTotal() < n; g++) {
    const log = bot.inventory.items().find((i) => isLog(i.name));
    if (!log) throw new SkillError('原木が足りない');
    const plank = log.name.replace(/_(log|stem)$/, '_planks');
    const r = bot.recipesFor(bot.registry.itemsByName[plank].id, null, 1, null)[0];
    if (!r) throw new SkillError(`${plank} のレシピがない`);
    await bot.craft(r, 1);
  }
}

// ---------- 精錬 ----------

const FUELS = [['coal', 8], ['charcoal', 8], ['coal_block', 80], ['blaze_rod', 12]];

export async function ensureFurnace(ctx) {
  const near = await nearbyBlock(ctx, 'furnace');
  if (near) return near;
  if (!findItem(ctx.bot, 'furnace')) await craftItem(ctx, 'furnace', 1);
  return placeNear(ctx, 'furnace');
}

export async function smelt(ctx, input, n) {
  const { bot } = ctx;
  const inItem = bot.registry.itemsByName[input];
  const have = count(bot, input);
  n = Math.min(n, have);
  if (n <= 0) throw new SkillError(`${input} を持っていない`);
  const furnaceBlock = await ensureFurnace(ctx);
  const furnace = await bot.openFurnace(furnaceBlock);
  try {
    // 燃料: 石炭類 → 板材 → 原木 の順に使う
    let fuel = FUELS.find(([f, per]) => count(bot, f) >= Math.ceil(n / per));
    let fuelName; let fuelCount;
    if (fuel) {
      fuelName = fuel[0];
      fuelCount = Math.ceil(n / fuel[1]);
    } else {
      const planks = bot.inventory.items().find((i) => isPlanks(i.name));
      const log = bot.inventory.items().find((i) => isLog(i.name) && i.name !== input);
      const pick = planks ?? log;
      if (!pick) throw new SkillError('燃料がない（石炭か木材が必要）');
      fuelName = pick.name;
      fuelCount = Math.min(pick.count, Math.ceil(n / 1.5));
    }
    if (!furnace.fuelItem() || furnace.fuelItem().count < fuelCount) {
      await furnace.putFuel(bot.registry.itemsByName[fuelName].id, null, fuelCount);
    }
    await furnace.putInput(inItem.id, null, n);
    let taken = 0;
    const deadline = Date.now() + (n * 10 + 20) * 1000;
    while (taken < n && Date.now() < deadline) {
      abortable(ctx);
      await sleep(1500);
      if (furnace.outputItem()) {
        const out = await furnace.takeOutput();
        taken += out?.count ?? 0;
      }
    }
    return taken;
  } finally {
    furnace.close();
  }
}

// ---------- 戦闘 ----------

export async function attackEntity(ctx, entity, { timeoutMs = 30000 } = {}) {
  const { bot } = ctx;
  const sword = ['netherite_sword', 'diamond_sword', 'iron_sword', 'stone_sword', 'wooden_sword']
    .map((n) => findItem(bot, n)).find(Boolean)
    ?? ['diamond_axe', 'iron_axe', 'stone_axe'].map((n) => findItem(bot, n)).find(Boolean);
  if (sword) await bot.equip(sword, 'hand');
  bot.pvp.attack(entity);
  const start = Date.now();
  while (entity.isValid && Date.now() - start < timeoutMs) {
    if (ctx.signal?.aborted) { bot.pvp.stop(); abortable(ctx); }
    await sleep(250);
  }
  bot.pvp.stop();
  return !entity.isValid;
}

export function nearestEntityNamed(bot, names, maxDist = 32) {
  const set = new Set(Array.isArray(names) ? names : [names]);
  return bot.nearestEntity((e) => set.has(e.name) && e.position.distanceTo(bot.entity.position) <= maxDist);
}

export function dim(ctx) {
  return dimensionOf(ctx.bot);
}

export { goals, LOGS, Vec3 };
