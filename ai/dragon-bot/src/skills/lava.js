// 溶岩対策の小道具。溶岩に入ったときの脱出そのものは agent.js の escapeLava（反射）が行う。
// ここは: 燃えているときに水で消す、経路探索で溶岩のとなりを避ける、溶岩・燃焼の判定。
import { Vec3 } from 'vec3';
import { findItem } from '../util/items.js';
import { dimensionOf } from '../brain/progress.js';

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
