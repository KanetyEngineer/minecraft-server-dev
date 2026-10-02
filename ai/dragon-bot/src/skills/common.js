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
    if (ctx.allowBoat !== false && waterAhead(bot, dx / d, dz / d, Math.min(d, step)) >= 20) {
      try {
        await crossByBoat(ctx, x, z);
        continue;
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        ctx.log.warn(`ボート移動に失敗: ${e.message}`);
      }
    }
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

// 進む方向の水面ブロックの数（長い水上かどうかの判定）
export function waterAhead(bot, ux, uz, dist) {
  const p = bot.entity.position;
  let n = 0;
  for (let i = 2; i <= dist; i += 2) {
    const x = Math.floor(p.x + ux * i); const z = Math.floor(p.z + uz * i);
    for (let y = Math.floor(p.y) + 3; y > Math.floor(p.y) - 6; y--) {
      const b = bot.blockAt(new Vec3(x, y, z));
      if (!b || b.name === 'air') continue;
      if (b.name === 'water') n += 2;
      break;
    }
  }
  return n;
}

const BOATS = ['oak_boat', 'spruce_boat', 'birch_boat', 'jungle_boat', 'acacia_boat', 'dark_oak_boat', 'mangrove_boat', 'cherry_boat', 'pale_oak_boat'];

// ボートを作って水上を渡る。対岸に着いたら降りて回収する。
export async function crossByBoat(ctx, x, z) {
  const { bot } = ctx;
  let boat = bot.inventory.items().find((i) => BOATS.includes(i.name));
  if (!boat) {
    const plank = bot.inventory.items().find((i) => isPlanks(i.name) && i.count >= 5)
      ?? bot.inventory.items().find((i) => isLog(i.name) && i.count >= 2);
    if (!plank) throw new SkillError('ボートを作る木材がない');
    const wood = plank.name.replace(/_(planks|log)$/, '');
    await craftItem(ctx, `${wood}_boat`, 1);
    boat = bot.inventory.items().find((i) => BOATS.includes(i.name));
  }
  // 水際まで行く
  const water = findVisibleBlocks(bot, ['water'], { maxDistance: 24, count: 1, visibleOnly: true,
    extra: (b) => { const up = bot.blockAt(b.position.offset(0, 1, 0)); return up && up.name === 'air'; } })[0];
  if (!water) throw new SkillError('水面が見つからない');
  await goTo(ctx, water.position.x, water.position.y + 1, water.position.z, 2);
  await bot.equip(boat, 'hand');
  await smoothLookAt(bot, water.position.offset(0.5, 1, 0.5), ctx.cfg.human.turnSpeed);
  await bot.placeEntity(bot.blockAt(water.position), new Vec3(0, 1, 0));
  const vehicle = bot.nearestEntity((e) => e.name && e.name.endsWith('boat') && e.position.distanceTo(bot.entity.position) < 5);
  if (!vehicle) throw new SkillError('ボートを置けなかった');
  bot.mount(vehicle);
  await sleep(800);
  const deadline = Date.now() + 5 * 60_000;
  try {
    while (Date.now() < deadline) {
      abortable(ctx);
      const p = bot.entity.position;
      const d = Math.hypot(x - p.x, z - p.z);
      if (d < 4) break;
      const yaw = Math.atan2(-(x - p.x), -(z - p.z));
      await bot.look(yaw, 0, false);
      bot.moveVehicle(0, 1);
      // 2 ブロック先が陸なら降りる
      const ux = (x - p.x) / d; const uz = (z - p.z) / d;
      const ahead = bot.blockAt(new Vec3(Math.floor(p.x + ux * 2), Math.floor(p.y), Math.floor(p.z + uz * 2)));
      if (ahead && ahead.boundingBox === 'block') break;
      await bot.waitForTicks(2);
    }
  } finally {
    bot.dismount();
  }
  await sleep(500);
  // ボートを壊して回収
  const v = bot.nearestEntity((e) => e.name && e.name.endsWith('boat') && e.position.distanceTo(bot.entity.position) < 5);
  for (let i = 0; v && v.isValid && i < 6; i++) { bot.attack(v); await sleep(300); }
  await pickUpItems(ctx, 6).catch(() => {});
}

// 探索: 前回と近い向きに 24〜40 ブロック歩く。行き止まりなら向きを変える。
// 探索の向きを決める: 8 方向の先（8〜40 マス）の地表を見て、水が少なく木の葉が多い方を選ぶ。
// 今の向きを少し優先して、ふらふらしないようにする（海辺のスポーンで沖へ出ていき、ドラウンドに倒されていた）
export function chooseExploreHeading(bot, current) {
  const p = bot.entity.position.floored();
  const surface = (x, z) => {
    for (let y = p.y + 12; y >= p.y - 8; y--) {
      const b = bot.blockAt(new Vec3(x, y, z));
      if (!b) return null; // 読み込まれていない
      if (b.name === 'air' || b.name === 'cave_air' || b.boundingBox === 'empty' && b.name !== 'water') continue;
      return b;
    }
    return null;
  };
  let best = null;
  for (let k = 0; k < 8; k++) {
    const h = (k / 8) * Math.PI * 2;
    let score = 0;
    for (const dist of [8, 16, 24, 32, 40]) {
      const b = surface(Math.round(p.x + Math.cos(h) * dist), Math.round(p.z + Math.sin(h) * dist));
      if (!b) continue;
      if (b.name === 'water' || b.name === 'kelp' || b.name === 'seagrass' || b.name === 'kelp_plant') score -= 3;
      else if (b.name.endsWith('_leaves') || isLog(b.name)) score += 2;
      else score += 1;
    }
    if (current !== undefined) score += Math.cos(h - current) * 1.5; // 今の向きに近いほど少し得点
    if (!best || score > best.score) best = { h, score };
  }
  return best ? best.h : current;
}

export async function exploreStep(ctx, distance = 32) {
  const { bot } = ctx;
  ctx.state.heading = chooseExploreHeading(bot, ctx.state.heading) + (Math.random() - 0.5) * 0.4;
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

// 行けなかった・開けなかったブロックは数分のあいだ候補から外す（同じ場所で何度も固まらないように）
const SKIP_MS = 3 * 60_000;
const posKey = (p) => `${p.x},${p.y},${p.z}`;
export function markUnreachable(ctx, pos) {
  (ctx.state.unreachable ??= new Map()).set(posKey(pos), Date.now() + SKIP_MS);
}
export function isUnreachable(ctx, pos) {
  const until = ctx.state.unreachable?.get(posKey(pos));
  if (until === undefined) return false;
  if (until < Date.now()) { ctx.state.unreachable.delete(posKey(pos)); return false; }
  return true;
}

// 廃坑など危険な場所（ドクグモのスポナーやクモの巣の多い所）。近くでは掘らない（agent.js が見つけて記録する）
export const DANGER_RADIUS = 24;
export function nearDanger(ctx, pos, r = DANGER_RADIUS) {
  return (ctx.state?.dangerZones ?? []).some((z) => z.distanceTo(pos) < r);
}

// 危険な場所から離れる（遠ざかる向きに探索）
export async function leaveDanger(ctx) {
  const { bot } = ctx;
  for (let k = 0; k < 4 && nearDanger(ctx, bot.entity.position); k++) {
    abortable(ctx);
    const z = ctx.state.dangerZones.reduce((a, b) => (a.distanceTo(bot.entity.position) < b.distanceTo(bot.entity.position) ? a : b));
    const p = bot.entity.position;
    const dx = p.x - z.x; const dz = p.z - z.z; const d = Math.hypot(dx, dz) || 1;
    await bot.pathfinder.goto(new goals.GoalNearXZ(p.x + (dx / d) * 16, p.z + (dz / d) * 16, 3)).catch(() => {});
  }
}

// 見えているブロックを掘って集める。見つからなければ探索する。
//
// 1 ブロックの採掘は自前で行う（collectBlock プラグインは、経路が無い・ドロップを拾えない場所で
// 何分も戻ってこない／途中で止まることがあり、動きがおぼつかなく見える原因だった）:
//   届く位置まで歩く → 道具を持つ → ブロックを見て掘り切る → 落ちた物を拾う。全体を時間で打ち切る。
const COLLECT_TIMEOUT_MS = 40_000;
export async function mineOne(ctx, block, { reach = 4.5 } = {}) {
  const { bot } = ctx;
  const pos = block.position;
  // 届かなければ近づく（真下・真上のブロックは pathfinder に任せず、その場で掘る）
  const eye = () => bot.entity.position.offset(0, 1.6, 0);
  if (eye().distanceTo(pos.offset(0.5, 0.5, 0.5)) > reach) {
    // 見える位置への経路探索は、たどり着けない場所だと何も言わずにその場で考え続けることがある
    // （見張りの「20 秒動けなかった」で切られるまで止まって見えた）。近づくのは 12 秒で打ち切る
    let timer;
    try {
      await Promise.race([
        bot.pathfinder.goto(new goals.GoalLookAtBlock(pos, bot.world, { reach })),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            // stop() は次の goto まで止めてしまう（Path was stopped）ので、目標を外すだけにする
            try { bot.pathfinder.setGoal(null); } catch {}
            reject(new Error(`${block.name} (${pos.x}, ${pos.y}, ${pos.z}) に近づけない`));
          }, 12_000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  const b = bot.blockAt(pos);
  if (!b || b.name !== block.name) throw new Error(`${block.name} が無くなっていた`);
  if (!bot.canDigBlock(b)) throw new Error(`${block.name} は掘れない`);
  await equipCheapestTool(bot, b, { requireHarvest: true });
  // 掘り切るまで待つ。途中で止められたら（持ち替え・押し出し）1 回だけやり直す
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await bot.dig(bot.blockAt(pos), true);
      break;
    } catch (e) {
      if (attempt === 1 || !/abort|interrupt/i.test(e.message)) throw e;
      await bot.waitForTicks(5);
      if (bot.blockAt(pos)?.name !== block.name) break;
    }
  }
  // ドロップを拾う（足元に落ちていれば歩き寄る）。高い所のブロック（トウヒの上の原木など）は
  // ドロップが下まで落ちるので、着地を待ってから、掘った所の真下も含めて広めに探す
  await bot.waitForTicks(12);
  const center = pos.offset(0.5, 0.5, 0.5);
  const near = (e) => Math.hypot(e.position.x - center.x, e.position.z - center.z) < 4 && e.position.y <= center.y + 1 && center.y - e.position.y < 12;
  for (let i = 0; i < 4; i++) {
    const item = bot.nearestEntity((e) => e.name === 'item' && near(e));
    if (!item) break;
    await bot.pathfinder.goto(new goals.GoalNear(item.position.x, item.position.y, item.position.z, 0.5)).catch(() => {});
    await bot.waitForTicks(4);
  }
}

export async function collectWithTimeout(ctx, block, ms = COLLECT_TIMEOUT_MS) {
  const { bot } = ctx;
  let timer;
  try {
    return await Promise.race([
      mineOne(ctx, block),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          try { bot.pathfinder.stop(); } catch {}
          try { bot.stopDigging(); } catch {}
          reject(new Error(`${Math.round(ms / 1000)} 秒たっても掘り終わらない`));
        }, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function mineBlocks(ctx, names, n, { maxDistance = 40, explore = true, maxExplore = 12, filter, onMined, maxFails = 6, avoidLiquid = true } = {}) {
  const { bot, cfg } = ctx;
  let mined = 0;
  let explored = 0;
  let fails = 0;
  while (mined < n) {
    abortable(ctx);
    const blocks = findVisibleBlocks(bot, names, { maxDistance, count: filter ? 24 : 8, visibleOnly: cfg.human.visibleOnly })
      // 水や溶岩に接したブロックは狙わない（水中の鉄鉱石に 40 秒ずつ粘って溺れたことがある）
      .filter((b) => !isUnreachable(ctx, b.position) && (!filter || filter(b)) && !(avoidLiquid && isNextToLiquid(bot, b.position))
        && !nearDanger(ctx, b.position));
    if (blocks.length === 0) {
      if (!explore || explored >= maxExplore) break;
      explored++;
      ctx.log.info(`掘れる ${names[0]} などが見当たらないので探しに歩く（${explored}/${maxExplore}）`);
      await exploreStep(ctx);
      continue;
    }
    try {
      const t = blocks[0].position;
      ctx.log.info(`掘る: ${blocks[0].name} (${t.x}, ${t.y}, ${t.z}) 距離 ${t.distanceTo(bot.entity.position).toFixed(1)}`);
      await collectWithTimeout(ctx, blocks[0], COLLECT_TIMEOUT_MS);
      mined++;
      fails = 0;
      onMined?.(blocks[0]);
      if (mined % 3 === 0) await lightIfDark(ctx).catch(() => {});
    } catch (e) {
      if (e.name === 'AbortError' || ctx.signal?.aborted) {
        // 見張りや反射で中断されたときも、このブロックはしばらく外す（次の判断で同じ届かないブロックを選び直さない）
        markUnreachable(ctx, blocks[0].position);
        throw e;
      }
      ctx.log.warn(`採掘失敗 ${blocks[0].name}: ${e.message}`);
      if (/tool|harvest/i.test(e.message)) throw new SkillError(`${blocks[0].name} を掘る道具がない`);
      // 届かないブロックは外して、すぐ次の候補へ（同じブロックで固まらない）。原木なら同じ幹の上下もまとめて外す
      markUnreachable(ctx, blocks[0].position);
      if (/近づけない|No path|Took to long/.test(e.message)) {
        const b0 = blocks[0].position;
        if (isLog(blocks[0].name)) {
          for (let dy = -4; dy <= 8; dy++) markUnreachable(ctx, b0.offset(0, dy, 0));
        } else {
          // 鉱脈などはまとまっているので、届かなかったブロックの周り 2 マスもまとめて外す
          for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) for (let dz = -2; dz <= 2; dz++) markUnreachable(ctx, b0.offset(dx, dy, dz));
        }
      }
      // 失敗が続く地形（崖の上の石など）では粘らず、呼び出し側の別の方法（掘り下がるなど）に任せる
      if (++fails >= maxFails) {
        ctx.log.warn(`採掘が ${fails} 回続けて失敗したので、この場所での採掘をやめる`);
        break;
      }
    }
  }
  return mined;
}

// 指定の高さまで階段状に掘り下がる（真下には掘らない）
export async function descendTo(ctx, targetY) {
  const { bot } = ctx;
  for (let i = 0; i < 200 && bot.entity.position.y > targetY + 1; i++) {
    abortable(ctx);
    if (i % 10 === 0 && !(await ensurePickaxe(ctx))) throw new SkillError('ツルハシが無くて掘り下がれない');
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
        await equipCheapestTool(bot, b);
        // 「Digging aborted」（ほかの動作に掘削が割り込まれた）でスキル全体を失敗させず、次の周回で掘り直す
        if (!(await digOrRetry(bot, b))) break;
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

// 掘る。ほかの動作に割り込まれて「Digging aborted」になったら false を返す（それ以外のエラーはそのまま投げる）
export async function digOrRetry(bot, block, forceLook = false) {
  try {
    await bot.dig(block, forceLook);
    return true;
  } catch (e) {
    if (/aborted/i.test(String(e?.message))) return false;
    throw e;
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
  if (Math.abs(bot.entity.position.y - y) > 3) {
    ctx.log.info(`ブランチマイニング: y=${Math.floor(bot.entity.position.y)} から y=${y} まで階段状に掘り下がる`);
    await descendTo(ctx, y);
    ctx.log.info(`ブランチマイニング: y=${Math.floor(bot.entity.position.y)} に着いた、横に掘り進む`);
  }
  let got = 0;
  const start = count(bot, ores[0]);
  const dirs = [[1, 0], [0, 1], [-1, 0], [0, -1]];
  let di = Math.floor(Math.random() * 4);
  // 前に水没していた場所の近くなら、離れてから掘る（同じ帯水層に何度も戻って息継ぎを繰り返していた）
  if (ctx.state.floodedAt && ctx.state.floodedAt.distanceTo(bot.entity.position) < 24) {
    ctx.log.info('前に水没していた場所の近くなので、離れてから横掘りする');
    for (let k = 0; k < 3 && ctx.state.floodedAt.distanceTo(bot.entity.position) < 24; k++) await exploreStep(ctx, 24);
  }
  // 廃坑（ドクグモ）の近くなら、離れてから掘る
  if (nearDanger(ctx, bot.entity.position)) {
    ctx.log.info('廃坑の近くなので、離れてから横掘りする');
    await leaveDanger(ctx);
  }
  for (let leg = 0; leg < 6 && got < n; leg++) {
    if (!(await ensurePickaxe(ctx))) break;
    if (nearDanger(ctx, bot.entity.position)) { ctx.log.info('横掘りの先が廃坑の近くなので向きを変える'); await leaveDanger(ctx); }
    if (ctx.state.floodedAt && ctx.state.floodedAt.distanceTo(bot.entity.position) < 6) break;
    const [dx, dz] = dirs[di % 4];
    ctx.log.info(`ブランチマイニング ${leg + 1}/6 本目（y=${Math.floor(bot.entity.position.y)}、ここまで ${got}/${n} 個）`);
    for (let s = 0; s < length && got < n; s += 4) {
      abortable(ctx);
      const p = bot.entity.position.floored();
      try {
        await bot.pathfinder.goto(new goals.GoalBlock(p.x + dx * 4, p.y, p.z + dz * 4));
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        break;
      }
      // 掘り進んだ先が水没していたら（地下の帯水層など）、息が続かないのでこの場所での横掘りをやめる
      if (bot.blockAt(bot.entity.position.offset(0, 1.6, 0))?.name === 'water' || bot.entity.isInWater) {
        ctx.log.warn('横掘りの先が水没しているので、ここでのブランチマイニングをやめる');
        ctx.state.floodedAt = bot.entity.position.clone(); // 次は別の場所で掘る
        return Math.max(got, count(bot, ores[0]) - start);
      }
      await lightIfDark(ctx).catch(() => {});
      const seen = findVisibleBlocks(bot, ores, { maxDistance: 8, count: 4, visibleOnly: true });
      for (const b of seen) {
        abortable(ctx);
        try {
          await collectWithTimeout(ctx, b);
          got++;
        } catch (e) {
          if (e.name === 'AbortError' || ctx.signal?.aborted) throw e;
          ctx.log.warn(e.message);
          // ツルハシが壊れたら、掘れないまま掘り進まずに呼び出し側へ返す（作り直してもらう）
          if (/tool|harvest/i.test(e.message)) return Math.max(got, count(bot, ores[0]) - start);
        }
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

const REPLACEABLE = new Set(['short_grass', 'grass', 'tall_grass', 'fern', 'large_fern', 'dead_bush', 'snow',
  'dandelion', 'poppy', 'blue_orchid', 'allium', 'azure_bluet', 'oxeye_daisy', 'cornflower', 'red_tulip', 'orange_tulip',
  'white_tulip', 'pink_tulip', 'short_dry_grass', 'tall_dry_grass', 'bush', 'firefly_bush', 'leaf_litter']);

// 足元周辺の置ける場所を探してブロックを置く
export async function placeNear(ctx, itemName) {
  const { bot } = ctx;
  const item = findItem(bot, itemName);
  if (!item) throw new SkillError(`${itemName} を持っていない`);
  const base = bot.entity.position.floored();
  for (const [x, z] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [2, 0], [0, 2], [-2, 0], [0, -2]]) {
    const target = base.offset(x, 0, z);
    let at = bot.blockAt(target);
    const below = bot.blockAt(target.offset(0, -1, 0));
    // 草や花は刈ってから置く（サバンナなどは足元が草だらけで、空気の場所がほとんど無い）
    if (at && REPLACEABLE.has(at.name) && below && below.boundingBox === 'block') {
      await bot.dig(at, true).catch(() => {});
      at = bot.blockAt(target);
    }
    if (at && (at.name === 'air' || at.name === 'cave_air') && below && below.boundingBox === 'block') {
      await bot.equip(item, 'hand');
      await smoothLookAt(bot, target.offset(0.5, 0, 0.5), ctx.cfg.human.turnSpeed);
      try {
        await bot.placeBlock(below, new Vec3(0, 1, 0));
        // 置けたことを確かめる（サーバーに戻されて石のままだったのに作業台として開こうとし、止まっていた）
        const placed = bot.blockAt(target);
        if (placed?.name === itemName) return placed;
        ctx.log.warn(`設置したはずの場所が ${placed?.name} のまま`);
      } catch (e) {
        ctx.log.warn(`設置失敗: ${e.message}`);
      }
    }
  }
  // 坑道の中などで周りが全部ふさがっているときは、横のブロックを 1 つ掘って場所を作る
  for (const [x, z] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const target = base.offset(x, 0, z);
    const at = bot.blockAt(target);
    const below = bot.blockAt(target.offset(0, -1, 0));
    if (!at || at.boundingBox !== 'block' || !bot.canDigBlock(at) || !below || below.boundingBox !== 'block') continue;
    if (isNextToLiquid(bot, target)) continue;
    await bot.tool.equipForBlock(at, {}).catch(() => {});
    await bot.dig(at).catch(() => {});
    if (!['air', 'cave_air'].includes(bot.blockAt(target)?.name)) continue;
    await bot.equip(findItem(bot, itemName), 'hand');
    try {
      await bot.placeBlock(below, new Vec3(0, 1, 0));
      const placed = bot.blockAt(target);
      if (placed?.name === itemName) return placed;
      ctx.log.warn(`設置したはずの場所が ${placed?.name} のまま`);
    } catch (e) {
      ctx.log.warn(`設置失敗: ${e.message}`);
    }
  }
  throw new SkillError(`${itemName} を置ける場所がない`);
}

// 置ける場所が無ければ、少し歩いて場所を変えてから置き直す（木の中・水辺・急斜面で何度も失敗しないように）
export async function placeNearOrRelocate(ctx, itemName, tries = 3) {
  const { bot } = ctx;
  let lastErr = null;
  for (let i = 0; i < tries; i++) {
    abortable(ctx);
    try {
      return await placeNear(ctx, itemName);
    } catch (e) {
      if (e.name === 'AbortError' || ctx.signal?.aborted) throw e;
      lastErr = e;
      ctx.log.warn(`${e.message}。場所を変えて置き直す（${i + 1}/${tries}）`);
      const a = Math.random() * Math.PI * 2;
      const p = bot.entity.position;
      await bot.pathfinder.goto(new goals.GoalNearXZ(p.x + Math.cos(a) * 6, p.z + Math.sin(a) * 6, 1)).catch(() => {});
    }
  }
  throw lastErr;
}

// ---------- クラフト ----------

// 近くの作業台・かまどを使う。行けない・手が届かないものは外して null（呼び出し側で新しく置く）。
async function nearbyBlock(ctx, name, dist = 6) {
  const b = findVisibleBlocks(ctx.bot, [name], { maxDistance: 24, count: 4, visibleOnly: false })
    .find((x) => !isUnreachable(ctx, x.position));
  if (!b) return null;
  if (b.position.distanceTo(ctx.bot.entity.position) > dist) {
    try {
      await goNearBlock(ctx, b, 2);
    } catch (e) {
      if (e.name === 'AbortError' || ctx.signal?.aborted) throw e;
      markUnreachable(ctx, b.position);
      return null;
    }
  }
  const eye = ctx.bot.entity.position.offset(0, 1.62, 0);
  if (eye.distanceTo(b.position.offset(0.5, 0.5, 0.5)) > 4.5) { markUnreachable(ctx, b.position); return null; }
  return ctx.bot.blockAt(b.position);
}

// 窓が開かない（届かない・視線が通らない）ときは、その台を外して新しく置き直して 1 回だけやり直す
async function withOpenRetry(ctx, block, ensure, fn) {
  try {
    return await fn(block);
  } catch (e) {
    if (!/windowOpen/.test(e.message)) throw e;
    ctx.log.warn(`${block.name} を開けなかったので置き直す`);
    markUnreachable(ctx, block.position);
    return fn(await ensure(ctx));
  }
}

export async function ensureCraftingTable(ctx) {
  const near = await nearbyBlock(ctx, 'crafting_table');
  if (near) return near;
  if (!findItem(ctx.bot, 'crafting_table')) await craftItem(ctx, 'crafting_table', 1, { noTable: true });
  const placed = await placeNearOrRelocate(ctx, 'crafting_table');
  // 自分で置いた作業台は、作り終わったら回収して持ち歩く（毎回置き去りにして木材を使い切っていた）
  if (placed) ctx.state.placedTable = placed.position.clone();
  return placed;
}

// 材料が足りなければ中間素材（板材・棒など）も作る簡易レシピ解決
export async function craftItem(ctx, name, n = 1, opts = {}) {
  try {
    return await craftItemInner(ctx, name, n, opts);
  } finally {
    // いちばん外側の呼び出しが終わったら、自分で置いた作業台を回収する
    if (!opts.depth && ctx.state?.placedTable) {
      const pos = ctx.state.placedTable;
      ctx.state.placedTable = null;
      const b = ctx.bot.blockAt(pos);
      if (b && b.name === 'crafting_table' && b.position.distanceTo(ctx.bot.entity.position) < 6) {
        await equipCheapestTool(ctx.bot, b).catch(() => {});
        await ctx.bot.dig(b, true).catch(() => {});
        await pickUpItems(ctx, 4).catch(() => {});
      }
    }
  }
}

async function craftItemInner(ctx, name, n = 1, { noTable = false, depth = 0 } = {}) {
  const { bot } = ctx;
  abortable(ctx);
  const item = bot.registry.itemsByName[name];
  if (!item) throw new SkillError(`不明なアイテム: ${name}`);
  if (count(bot, name) >= n) return;

  const tryCraft = async (t) => {
    for (let guard = 0; guard < 64 && count(bot, name) < n; guard++) {
      const r = bot.recipesFor(item.id, null, 1, t)[0];
      if (!r) return false;
      try {
        if (!t) { await bot.craft(r, 1); continue; }
        await withOpenRetry(ctx, t, ensureCraftingTable, async (tb) => { t = tb; table = tb; await bot.craft(r, 1, tb); });
      } catch (e) {
        if (e.name === 'AbortError' || ctx.signal?.aborted) throw e;
        // 柱積みなどで持ち物が変わり、レシピと実際の材料がずれた場合。材料をそろえ直す側に回す
        // 作業台の窓の同期ずれ（updateSlot が来ない）も、窓を閉じて材料をそろえ直す処理に回す（石の道具作りが 4 分失敗し続けた）
        if (/updateSlot|windowOpen/i.test(e.message)) { ctx.log.warn(`${name}: 作業台の窓がずれた、閉じてやり直す`); try { if (bot.currentWindow) bot.closeWindow(bot.currentWindow); } catch {} await sleep(500); return false; }
        if (/missing ingredient/i.test(e.message)) { ctx.log.warn(`${name} の材料がずれた（${e.message}）、そろえ直す`); return false; }
        throw e;
      }
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
  // いちばん不足の少ないレシピ（板材の種類違いなど）を選ぶ。持ち物が変わるので毎回選び直す
  // 材料が作れなかったレシピは外して次の候補を試す（例: 色付きベッドの「白いベッド＋染料」は染料が作れない）
  const badRecipes = new Set();
  const pick = () => all
    .filter((r) => !badRecipes.has(r))
    .map((r) => ({ r, miss: missingOf(r) }))
    .sort((a, b) => a.miss.reduce((s, m) => s + m.need - m.have, 0) - b.miss.reduce((s, m) => s + m.need - m.have, 0))[0];
  // 中間素材を作ると他の材料が減ることがある（棒を作ると板材が減る）ので、そろうまで数え直す
  for (let pass = 0; pass < 3 + all.length; pass++) {
    const chosen = pick();
    if (!chosen) break;
    const { r, miss } = chosen;
    if (miss.length === 0) break;
    try {
      for (const m of miss) {
        if (isPlanks(m.name)) {
          await ensurePlanks(ctx, m.need, m.name);
        } else {
          await craftItem(ctx, m.name, m.need, { noTable, depth: depth + 1 });
        }
      }
    } catch (e) {
      // 「原木が足りない」はどのレシピでも同じなので、他のレシピを試さずにそのまま返す
      if (!(e instanceof SkillError) || /原木が足りない/.test(e.message) || badRecipes.size + 1 >= all.length) throw e;
      ctx.log.warn(`${name}: このレシピの材料が作れない（${e.message}）、別のレシピを試す`);
      badRecipes.add(r);
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
  const plankOf = (logName) => logName.replace(/^stripped_/, '').replace(/_(log|stem)$/, '_planks');
  // 種類の指定があり、その種類の原木を持っていれば、その種類の板材の数で数える
  //（全種類の合計で数えると、アカシア 1・オーク 1 で「2 枚ある」と判断してレシピがそろわない）
  let matching = preferred && bot.inventory.items().find((i) => isLog(i.name) && plankOf(i.name) === preferred);
  // 種類の指定が無いときも、1 種類だけで n 枚そろうようにする（板材＋原木×4 が最多の種類を選ぶ）
  if (!preferred) {
    const score = {};
    for (const i of bot.inventory.items()) {
      if (isPlanks(i.name)) score[i.name] = (score[i.name] ?? 0) + i.count;
      else if (isLog(i.name)) score[plankOf(i.name)] = (score[plankOf(i.name)] ?? 0) + i.count * 4;
    }
    const best = Object.entries(score).sort((a, b) => b[1] - a[1])[0];
    if (best && best[1] >= n) {
      preferred = best[0];
      matching = bot.inventory.items().find((i) => isLog(i.name) && plankOf(i.name) === preferred);
    }
  }
  // その種類の原木を持っているときだけ種類別に数える。持っていない種類（レシピが選んだアカシアなど）で数えると
  // いつまでも 0 のままで、手持ちの原木をすべて別の板材に変えてしまう（オーク板材 62 枚・原木 0 になった）
  const have = () => (matching ? count(bot, preferred) : plankTotal());
  for (let g = 0; g < 20 && have() < n; g++) {
    const log = (matching && bot.inventory.items().find((i) => i.name === matching.name))
      ?? bot.inventory.items().find((i) => isLog(i.name));
    if (!log) throw new SkillError('原木が足りない');
    const plank = plankOf(log.name);
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
  const { bot } = ctx;
  if (!findItem(bot, 'furnace')) {
    // 遠出先でかまどが無いときは、まず丸石を 8 個掘ってから作る
    const cobble = () => count(bot, 'cobblestone') + count(bot, 'cobbled_deepslate');
    if (cobble() < 8) {
      await mineBlocks(ctx, ['stone', 'cobblestone', 'deepslate', 'cobbled_deepslate'], 8 - cobble(), { maxDistance: 24, maxExplore: 4 });
    }
    const kind = count(bot, 'cobblestone') >= 8 ? 'cobblestone' : 'cobbled_deepslate';
    if (count(bot, kind) < 8) throw new SkillError('かまどを作る丸石が足りない');
    const table = await ensureCraftingTable(ctx);
    const r = bot.recipesFor(bot.registry.itemsByName.furnace.id, null, 1, table)[0];
    if (!r) throw new SkillError('かまどのレシピが使えない');
    await bot.craft(r, 1, table);
  }
  return placeNearOrRelocate(ctx, 'furnace');
}

export async function smelt(ctx, input, n) {
  const { bot } = ctx;
  const inItem = bot.registry.itemsByName[input];
  const have = count(bot, input);
  n = Math.min(n, have);
  if (n <= 0) throw new SkillError(`${input} を持っていない`);
  const furnaceBlock = await ensureFurnace(ctx);
  const furnace = await withOpenRetry(ctx, furnaceBlock, ensureFurnace, (b) => bot.openFurnace(b));
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
    // 前回の残り（焼けた物・別の材料・別の燃料）があると入れられない（destination full）ので先に取り出す
    if (furnace.outputItem()) await furnace.takeOutput();
    if (furnace.inputItem() && furnace.inputItem().type !== inItem.id) await furnace.takeInput();
    if (furnace.fuelItem() && furnace.fuelItem().name !== fuelName) await furnace.takeFuel();
    if (!furnace.fuelItem() || furnace.fuelItem().count < fuelCount) {
      await furnace.putFuel(bot.registry.itemsByName[fuelName].id, null, fuelCount);
    }
    await furnace.putInput(inItem.id, null, n);
    let taken = 0;
    const deadline = Date.now() + (n * 10 + 20) * 1000;
    let refills = 0;
    while (taken < n && Date.now() < deadline) {
      abortable(ctx);
      await sleep(1500);
      if (furnace.outputItem()) {
        const out = await furnace.takeOutput();
        taken += out?.count ?? 0;
      }
      // 使用中に燃料が切れたら補充する（燃料欄が空で、燃えている分もほぼ尽き、まだ材料が残っているとき）
      const left = furnace.inputItem()?.count ?? 0;
      if (left > 0 && !furnace.fuelItem() && (furnace.fuel ?? 0) <= 0.05 && refills < 5) {
        const add = pickFuel(bot, input, left);
        if (!add) {
          ctx.log.warn(`かまどの燃料が切れたが、補充する燃料が無い（残り ${left} 個）`);
          break;
        }
        await furnace.putFuel(bot.registry.itemsByName[add.name].id, null, add.count);
        refills++;
        ctx.log.info(`かまどの燃料が切れたので ${add.name} を ${add.count} 個補充した（残り ${left} 個）`);
      }
    }
    return taken;
  } finally {
    // 中断されても、焼けた物と焼き終わっていない材料は必ず持ち帰る（かまどに鉄を置き忘れて、
    // 鉄 7 個を掘ったのにインゴット 1 個しか手元に無くなったことがある）
    try { if (furnace.outputItem()) await furnace.takeOutput(); } catch {}
    try { if (furnace.inputItem()?.type === inItem.id) await furnace.takeInput(); } catch {}
    furnace.close();
    // 普段どおり終わったら、かまども回収して持ち歩く（遠くに置き去りにしない）
    if (!ctx.signal?.aborted) {
      const b = bot.blockAt(furnaceBlock.position);
      if (b && b.name === 'furnace') {
        await equipCheapestTool(bot, b).catch(() => {});
        await bot.dig(b, true).catch(() => {});
        await pickUpItems(ctx, 4).catch(() => {});
      }
    }
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

// ---------- 柱に乗って戦う（ゾンビ対策）----------

// 足場・壁・ふたに使うブロックは、使い道の少ないものから先に使う（丸石は道具やかまど、ゲートに要るので最後）
const PILLAR_BLOCKS = ['dirt', 'coarse_dirt', 'netherrack', 'andesite', 'diorite', 'granite', 'tuff', 'stone', 'cobbled_deepslate', 'cobblestone'];
export function cheapBlock(bot) {
  const items = bot.inventory.items();
  for (const n of PILLAR_BLOCKS) { const it = items.find((i) => i.name === n); if (it) return it; }
  return items.find((i) => isPlanks(i.name)) ?? null;
}

// 真下にブロックを積んで上がる（ジャンプして足元に置く、普通のプレイヤーの「柱上り」）
export async function pillarUp(ctx, height = 2) {
  const { bot } = ctx;
  let placed = 0;
  for (let i = 0; i < height; i++) {
    const item = cheapBlock(bot);
    if (!item) break;
    await bot.equip(item, 'hand');
    await bot.look(bot.entity.yaw, -Math.PI / 2, true);
    const below = bot.blockAt(bot.entity.position.offset(0, -1, 0));
    bot.setControlState('jump', true);
    await bot.waitForTicks(6);
    try {
      await bot.placeBlock(below, new Vec3(0, 1, 0));
      placed++;
    } catch {
      // 置けなかったら打ち切り
    } finally {
      bot.setControlState('jump', false);
    }
    await bot.waitForTicks(4);
  }
  return placed;
}

// 柱を掘って降りる
export async function pillarDown(ctx, placed) {
  const { bot } = ctx;
  for (let i = 0; i < placed; i++) {
    const below = bot.blockAt(bot.entity.position.offset(0, -1, 0));
    if (!below || below.boundingBox !== 'block') break;
    await equipCheapestTool(bot, below).catch(() => {});
    await bot.dig(below).catch(() => {});
    await bot.waitForTicks(8);
  }
}

// 高い所から、届く範囲の敵を殴る（移動はしない）
export async function fightFromAbove(ctx, names, { timeoutMs = 30000 } = {}) {
  const { bot } = ctx;
  const sword = ['netherite_sword', 'diamond_sword', 'iron_sword', 'stone_sword', 'wooden_sword']
    .map((n) => findItem(bot, n)).find(Boolean);
  if (sword) await bot.equip(sword, 'hand');
  const set = new Set(names);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const near = bot.nearestEntity((e) => set.has(e.name) && e.position.distanceTo(bot.entity.position) < 8);
    if (!near) return true;
    if (near.position.distanceTo(bot.entity.position) <= 3.5) {
      await bot.lookAt(near.position.offset(0, (near.height ?? 1.9) * 0.85, 0), true);
      bot.attack(near);
    }
    await sleep(650); // 攻撃のクールダウン
  }
  return false;
}

// 相手の方向に 2 段の壁を置いて盾にする（スケルトンの矢・クリーパーの爆風よけ）
export async function placeWallToward(ctx, entity, height = 2) {
  const { bot } = ctx;
  const p = bot.entity.position.floored();
  const dx = entity.position.x - bot.entity.position.x;
  const dz = entity.position.z - bot.entity.position.z;
  const dir = Math.abs(dx) > Math.abs(dz) ? new Vec3(Math.sign(dx), 0, 0) : new Vec3(0, 0, Math.sign(dz));
  let placed = 0;
  for (let y = 0; y < height; y++) {
    const target = p.plus(dir).offset(0, y, 0);
    const cur = bot.blockAt(target);
    if (cur && cur.boundingBox === 'block') { placed++; continue; }
    const item = cheapBlock(bot);
    if (!item) break;
    const ref = [[0, -1, 0], [-dir.x, 0, -dir.z], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]
      .map(([x, yy, z]) => bot.blockAt(target.offset(x, yy, z)))
      .find((b) => b && b.boundingBox === 'block' && !b.position.equals(p) && !b.position.equals(p.offset(0, 1, 0)));
    if (!ref) continue;
    await bot.equip(item, 'hand');
    await bot.lookAt(target.offset(0.5, 0.5, 0.5), true);
    try {
      await bot.placeBlock(ref, target.minus(ref.position));
      placed++;
    } catch {
      // 置けなければ次の段
    }
  }
  return placed;
}

// 暗い地下（空の光が届かず、松明などの光も弱い）では足元の横に松明を置く。モンスターが湧きにくくなる。
// 松明が無ければ石炭（木炭）と棒から作る。置けたら true
export async function lightIfDark(ctx) {
  const { bot } = ctx;
  const feet = bot.entity.position.floored();
  const here = bot.blockAt(feet);
  if (!here || here.skyLight > 7 || here.light >= 8) return false;
  if (!findItem(bot, 'torch')) {
    if (count(bot, 'coal') + count(bot, 'charcoal') < 1) return false;
    try {
      if (count(bot, 'stick') < 1) await craftItem(ctx, 'stick', 4);
      await craftItem(ctx, 'torch', 4);
    } catch {
      return false;
    }
  }
  const torch = findItem(bot, 'torch');
  if (!torch) return false;
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const target = feet.offset(dx, 0, dz);
    const at = bot.blockAt(target);
    const below = bot.blockAt(target.offset(0, -1, 0));
    if (!at || at.name !== 'air' || !below || below.boundingBox !== 'block' || isNextToLiquid(bot, target)) continue;
    try {
      await bot.equip(torch, 'hand');
      await bot.placeBlock(below, new Vec3(0, 1, 0));
      ctx.log.info(`暗いので松明を置いた (${target.x}, ${target.y}, ${target.z})`);
      return true;
    } catch {
      // 置けなければ次の場所
    }
  }
  return false;
}

// 廃坑の毒グモスポナーなどを無力化する: 近づいてツルハシで壊す（壊すと湧かなくなる）。
// 壊せないとき（ツルハシが無い）は周りに松明を置くだけでも湧かなくなる。処理できたら true
export async function neutralizeSpawner(ctx, spawner) {
  const { bot } = ctx;
  const pick = ['netherite_pickaxe', 'diamond_pickaxe', 'iron_pickaxe', 'stone_pickaxe', 'wooden_pickaxe'].map((n) => findItem(bot, n)).find(Boolean);
  await goNearBlock(ctx, spawner, 2);
  // まず周りを明るくする（壊している間に湧かないように）
  await lightIfDark(ctx).catch(() => {});
  const block = bot.blockAt(spawner.position);
  if (!block || block.name !== 'spawner') return true;
  if (!pick) return false;
  await bot.equip(pick, 'hand');
  await bot.lookAt(block.position.offset(0.5, 0.5, 0.5), true);
  await bot.dig(block);
  return bot.blockAt(spawner.position)?.name !== 'spawner';
}

// 地下（空の光が届かない場所）にいたら、階段状に掘り上がって地上に出る。
// 動物探しや木集めなど地上でやる作業の前に使う（地下から遠くの地上へは経路が見つからず、その場で固まっていた）
export async function ascendToSurface(ctx, { maxSteps = 48 } = {}) {
  const { bot } = ctx;
  const sky = () => bot.blockAt(bot.entity.position.offset(0, 1.6, 0).floored())?.skyLight ?? 15;
  if (sky() >= 12) return false;
  ctx.log.info(`地下にいるので地上へ掘り上がる（y=${Math.floor(bot.entity.position.y)}）`);
  // まず洞窟の通路を歩いて上へ向かう（ツルハシが無いと石を掘るのは非常に遅いので、歩ける道があればそちらが速い）
  {
    const targetY = Math.max(64, Math.floor(bot.entity.position.y) + 20);
    await Promise.race([
      bot.pathfinder.goto(new goals.GoalY(targetY)).catch(() => {}),
      sleep(25_000),
    ]);
    try { bot.pathfinder.setGoal(null); } catch {}
    if (sky() >= 12) {
      ctx.log.info(`洞窟を歩いて地上に出た（y=${Math.floor(bot.entity.position.y)}）`);
      return true;
    }
  }
  let dir = ctx.state.stairDir ?? [1, 0];
  // 渓谷の底などで出られないまま何分も掘り続けないよう、90 秒で打ち切る
  const until = Date.now() + 90_000;
  for (let i = 0; i < maxSteps && sky() < 12 && Date.now() < until; i++) {
    abortable(ctx);
    const p = bot.entity.position.floored();
    const next = p.offset(dir[0], 1, dir[1]);
    // 頭上・次の足元・次の頭の 3 マスを空ける（液体の隣は避けて向きを変える）
    const cells = [p.offset(0, 2, 0), next, next.offset(0, 1, 0)];
    if (cells.some((c) => isNextToLiquid(bot, c))) { dir = [dir[1], -dir[0]]; continue; }
    for (const c of cells) {
      for (let k = 0; k < 4; k++) { // 砂利や砂が落ちてきたら掘り直す
        const b = bot.blockAt(c);
        if (!b || b.boundingBox !== 'block') break;
        if (!bot.canDigBlock(b)) break;
        await equipCheapestTool(bot, b).catch(() => {});
        await bot.dig(b, true).catch(() => {});
        await bot.waitForTicks(4);
      }
    }
    // 次の段に足場が無ければ置く
    const floor = bot.blockAt(next.offset(0, -1, 0));
    if (floor && floor.boundingBox !== 'block') {
      const item = cheapBlock(bot);
      if (item) {
        await bot.equip(item, 'hand').catch(() => {});
        await bot.placeBlock(bot.blockAt(p), new Vec3(dir[0], 0, dir[1])).catch(() => {});
      }
    }
    await Promise.race([
      bot.pathfinder.goto(new goals.GoalBlock(next.x, next.y, next.z)).catch(() => {}),
      sleep(4000),
    ]);
  }
  ctx.log.info(sky() >= 12 ? `地上に出た（y=${Math.floor(bot.entity.position.y)}）` : '地上に出られなかった');
  return sky() >= 12;
}

// ツルハシが無ければ作る（丸石が 3 個あれば石、無ければ木）。石の道具は 131 回、木は 59 回で壊れるので、
// 掘り下がり・鉄掘りの途中でも確認する（石のツルハシが y=65→16 の掘り下がりで壊れ、鉄が掘れなかった）
const PICK_TIERS = ['netherite_pickaxe', 'diamond_pickaxe', 'iron_pickaxe', 'stone_pickaxe', 'wooden_pickaxe'];
export async function ensurePickaxe(ctx, { minTier = 'wooden' } = {}) {
  const { bot } = ctx;
  const okTiers = PICK_TIERS.slice(0, PICK_TIERS.indexOf(`${minTier}_pickaxe`) + 1);
  if (okTiers.some((n) => findItem(bot, n))) return true;
  const cobble = count(bot, 'cobblestone') + count(bot, 'cobbled_deepslate') + count(bot, 'blackstone');
  const want = cobble >= 3 ? 'stone_pickaxe' : 'wooden_pickaxe';
  if (!okTiers.includes(want)) return false;
  ctx.log.info(`ツルハシが無いので ${want} を作る`);
  try {
    if (count(bot, 'stick') < 2) await craftItem(ctx, 'stick', 2);
    await craftItem(ctx, want, 1);
  } catch (e) {
    ctx.log.warn(`ツルハシを作れなかった: ${e.message}`);
  }
  return okTiers.some((n) => findItem(bot, n));
}

// 道具の持ち替え: 掘れるうちで一番安いツルハシ・シャベル・斧を使う（mineflayer-tool は一番速い道具を選ぶので、
// 石や石炭を鉄のツルハシで掘って、鉄のツルハシを使い潰していた）。安い道具で掘れなければ通常の選び方に任せる
const TOOL_TIERS = ['wooden', 'stone', 'golden', 'iron', 'diamond', 'netherite'];
export async function equipCheapestTool(bot, block, { requireHarvest = false } = {}) {
  const kinds = ['pickaxe', 'shovel', 'axe'];
  const items = bot.inventory.items();
  for (const tier of TOOL_TIERS) {
    for (const kind of kinds) {
      const it = items.find((i) => i.name === `${tier}_${kind}`);
      if (!it) continue;
      // その道具で回収できて、素手より速く掘れるなら使う
      if (!block.canHarvest(it.type)) continue;
      if (block.digTime(it.type, false, false, false) >= block.digTime(null, false, false, false)) continue;
      await bot.equip(it, 'hand');
      return it;
    }
  }
  return bot.tool.equipForBlock(block, { requireHarvest });
}

// 補充用の燃料を選ぶ: 石炭・木炭 → 板材 → 原木（焼く材料そのものは除く）。left 個焼ける分の数を返す
function pickFuel(bot, input, left) {
  for (const [name, per] of FUELS) {
    const have = count(bot, name);
    if (have > 0) return { name, count: Math.min(have, Math.ceil(left / per)) };
  }
  const wood = bot.inventory.items().find((i) => isPlanks(i.name))
    ?? bot.inventory.items().find((i) => isLog(i.name) && i.name !== input);
  if (!wood) return null;
  return { name: wood.name, count: Math.min(wood.count, Math.ceil(left / 1.5)) };
}