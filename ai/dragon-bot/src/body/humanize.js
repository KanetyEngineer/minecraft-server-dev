// 通常のプレイヤーらしく見せるための補助。
// - 視点はなめらかに回す（瞬間的に振り向かない）
// - 行動の合間に少し間を置く
// - ブロック探索は「見えているもの」だけ（透視しない）

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function jitter(ms, ratio = 0.3) {
  return Math.max(0, ms * (1 - ratio + Math.random() * ratio * 2));
}

function angleDiff(a, b) {
  let d = b - a;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

// 目標地点へ数ティックかけて視点を向ける
export async function smoothLookAt(bot, point, degPerTick = 35) {
  const eye = bot.entity.position.offset(0, bot.entity.eyeHeight ?? 1.62, 0);
  const d = point.minus(eye);
  const yaw = Math.atan2(-d.x, -d.z);
  const pitch = Math.atan2(d.y, Math.sqrt(d.x * d.x + d.z * d.z));
  const step = (degPerTick * Math.PI) / 180;
  for (let i = 0; i < 40; i++) {
    const dy = angleDiff(bot.entity.yaw, yaw);
    const dp = pitch - bot.entity.pitch;
    if (Math.abs(dy) <= step && Math.abs(dp) <= step) break;
    await bot.look(
      bot.entity.yaw + Math.sign(dy) * Math.min(Math.abs(dy), step),
      bot.entity.pitch + Math.sign(dp) * Math.min(Math.abs(dp), step),
      true,
    );
    await bot.waitForTicks(1);
  }
  await bot.look(yaw, pitch, true);
}

const SEE_THROUGH = new Set([
  'air', 'cave_air', 'void_air', 'water', 'lava', 'short_grass', 'tall_grass', 'grass', 'fern',
  'snow', 'vine', 'glass', 'torch', 'wall_torch', 'seagrass', 'kelp', 'kelp_plant',
]);

// 6 方向のどれかが透過ブロックなら「見える位置にある」とみなす
export function isExposed(bot, pos) {
  const dirs = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  for (const [x, y, z] of dirs) {
    const b = bot.blockAt(pos.offset(x, y, z), false);
    if (!b || SEE_THROUGH.has(b.name) || b.transparent) return true;
  }
  return false;
}

// bot.findBlocks のラッパー。visibleOnly のときは埋まっているブロックを除外する。
export function findVisibleBlocks(bot, names, { maxDistance = 48, count = 16, visibleOnly = true, extra } = {}) {
  const ids = names
    .map((n) => bot.registry.blocksByName[n]?.id)
    .filter((id) => id !== undefined);
  if (ids.length === 0) return [];
  const positions = bot.findBlocks({ matching: ids, maxDistance, count: count * 8 });
  const out = [];
  for (const p of positions) {
    if (visibleOnly && !isExposed(bot, p)) continue;
    const b = bot.blockAt(p);
    if (!b) continue;
    if (extra && !extra(b)) continue;
    out.push(b);
    if (out.length >= count) break;
  }
  return out;
}
