// 溶岩対策。
// 入ってしまったとき（溶岩遊泳）: 溶岩の中は 1 秒に 8 近く減り、3〜4 秒で死ぬので、考えずに即脱出する。
//   - オーバーワールドで水入りバケツがあれば、真下を見て水を置く（足元の溶岩が黒曜石/丸石になり、水で火も消える。RTA の定石）
//   - それ以外（ネザーなど）は、いちばん近い足場に向かってジャンプしながら泳ぐ（溶岩の中はジャンプし続けると浮く）
// 出た後: 燃えていれば水で消す（オーバーワールド）。
// 落ちないために: 経路探索で溶岩のとなりを通るマスを高コストにし（plugins.js）、ネザーではパルクールをしない。
import { Vec3 } from 'vec3';
import pathfinderPkg from 'mineflayer-pathfinder';
import { findItem } from '../util/items.js';
import { dimensionOf } from '../brain/progress.js';

const { goals } = pathfinderPkg;

const LAVA = new Set(['lava', 'flowing_lava']);
export const isLava = (b) => !!b && LAVA.has(b.name);

// 溶岩の中にいるか（物理の判定か、足・頭の位置のブロック）
export function inLava(bot) {
  if (!bot.entity?.position) return false;
  if (bot.entity.isInLava) return true;
  const p = bot.entity.position;
  return isLava(bot.blockAt(p.offset(0, 0.2, 0))) || isLava(bot.blockAt(p.offset(0, 1.4, 0)));
}

// 燃えているか（エンティティのフラグのビット 0）
export function isBurning(bot) {
  const f = bot.entity?.metadata?.[0];
  return typeof f === 'number' && (f & 0x01) !== 0;
}

// pos（足の位置）のまわり（横 4 方向と、その 1 段下）に溶岩があるか
export function lavaBeside(bot, pos) {
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    if (isLava(bot.blockAt(new Vec3(pos.x + dx, pos.y, pos.z + dz)))) return true;
    if (isLava(bot.blockAt(new Vec3(pos.x + dx, pos.y - 1, pos.z + dz)))) return true;
  }
  return false;
}

// 経路探索の追加コスト: 溶岩のとなりを通るマスは、少し遠回りしてでも避ける（ノックバックや滑りで落ちる）
export function lavaEdgeCost(bot, block) {
  if (!block?.position) return 0;
  return lavaBeside(bot, block.position) ? 25 : 0;
}

// いちばん近い脱出先: 溶岩でない足場の上で、体の 2 マスが空いていて、となりに溶岩が無いほうを優先
export function findLavaEscape(bot, radius = 5) {
  const me = bot.entity.position;
  const feet = me.floored();
  const standable = (p) => {
    const g = bot.blockAt(p.offset(0, -1, 0)); const a = bot.blockAt(p); const b = bot.blockAt(p.offset(0, 1, 0));
    return g && g.boundingBox === 'block' && !isLava(g) && a && a.boundingBox === 'empty' && !isLava(a) && b && b.boundingBox === 'empty' && !isLava(b);
  };
  let best = null;
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dz = -radius; dz <= radius; dz++) {
      for (const dy of [0, 1, -1]) {
        const p = feet.offset(dx, dy, dz);
        if (!standable(p)) continue;
        // 横の距離を主に、下りは少し嫌う。溶岩に接したマスはさらに嫌う
        const score = Math.hypot(dx, dz) + (dy < 0 ? 1 : 0) + (lavaBeside(bot, p) ? 0.5 : 0);
        if (!best || score < best.score) best = { pos: p, score };
      }
    }
  }
  return best?.pos ?? null;
}

// 真下を見てバケツを使う（水入りバケツなら水を置く、空のバケツなら回収）
export async function useBucketDown(bot, name) {
  const b = findItem(bot, name);
  if (!b) return false;
  await bot.equip(b, 'hand');
  await bot.look(bot.entity.yaw, -Math.PI / 2, true);
  bot.activateItem();
  await bot.waitForTicks(3);
  return true;
}

// 溶岩から脱出する。出られたら true
export async function escapeLava(ctx, { timeoutMs = 8000 } = {}) {
  const { bot } = ctx;
  const log = ctx.log;
  try { bot.pathfinder.setGoal(null); } catch { /* 経路探索を止めるだけ */ }
  bot.clearControlStates();
  bot.setControlState('jump', true); // 溶岩の中は飛び続けると浮く
  // 1. 水で消す（オーバーワールドのみ。ネザーでは水は置けない）
  if (dimensionOf(bot) === 'overworld' && findItem(bot, 'water_bucket')) {
    log?.warn('溶岩に入った。足元に水を置く');
    await useBucketDown(bot, 'water_bucket').catch(() => false);
    await bot.waitForTicks(4);
    if (!inLava(bot)) {
      // 置いた水は後で回収する（まず脱出）
      ctx.state.pouredWaterAt = bot.entity.position.floored();
    }
  }
  // 2. いちばん近い足場へ泳ぐ（ジャンプしながら全力で）
  const deadline = Date.now() + timeoutMs;
  let target = null;
  let t = 0;
  while (inLava(bot) && Date.now() < deadline) {
    if (!target || t % 10 === 0) target = findLavaEscape(bot, 5) ?? target;
    if (target) {
      const p = bot.entity.position;
      const dx = target.x + 0.5 - p.x; const dz = target.z + 0.5 - p.z;
      await bot.look(Math.atan2(-dx, -dz), 0, true);
    }
    bot.setControlState('jump', true);
    bot.setControlState('sprint', true);
    bot.setControlState('forward', true);
    await bot.waitForTicks(1);
    t++;
  }
  // 出たら、乗った勢いでまた落ちないよう、もう 1 マス進んでから止まる
  if (!inLava(bot) && target) {
    for (let i = 0; i < 10 && bot.entity.position.floored().distanceTo(target) > 0.9; i++) await bot.waitForTicks(1);
  }
  bot.clearControlStates();
  return !inLava(bot);
}

// 燃えているとき、水入りバケツがあれば足元に水を置いて消し、すぐ回収する（オーバーワールドのみ）
export async function extinguish(ctx) {
  const { bot } = ctx;
  if (dimensionOf(bot) !== 'overworld' || !findItem(bot, 'water_bucket') || !bot.entity.onGround) return false;
  if (!(await useBucketDown(bot, 'water_bucket').catch(() => false))) return false;
  await bot.waitForTicks(10);
  // 置いた水を回収（自分の足元の水源）
  await useBucketDown(bot, 'bucket').catch(() => false);
  return !isBurning(bot);
}

// 脱出で置いた水を、落ち着いてから回収する（水源のそばに行って、水源を見てバケツを使う）
export async function recoverPouredWater(ctx) {
  const { bot } = ctx;
  const at = ctx.state.pouredWaterAt;
  if (!at) return false;
  ctx.state.pouredWaterAt = null;
  if (findItem(bot, 'water_bucket') || !findItem(bot, 'bucket')) return false;
  const src = [at, at.offset(0, 1, 0), at.offset(0, -1, 0)].map((p) => bot.blockAt(p)).find((b) => b?.name === 'water' && b.metadata === 0);
  if (!src) return false;
  const stand = src.position.offset(0, 1, 0);
  if (lavaBeside(bot, stand)) return false; // まだ溶岩に接しているなら近づかない
  await Promise.race([
    bot.pathfinder.goto(new goals.GoalNear(stand.x, stand.y, stand.z, 1)).catch(() => {}),
    new Promise((r) => setTimeout(r, 8000)),
  ]);
  try { bot.pathfinder.setGoal(null); } catch { /* 止めるだけ */ }
  const b = findItem(bot, 'bucket');
  if (!b) return false;
  await bot.equip(b, 'hand');
  await bot.lookAt(src.position.offset(0.5, 0.5, 0.5), true);
  bot.activateItem();
  await bot.waitForTicks(4);
  return !!findItem(bot, 'water_bucket');
}
