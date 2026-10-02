// RTA 式: 溶岩と水バケツでネザーゲートの黒曜石を「その場で作る」（ダイヤのツルハシ不要）。
//
// やり方（1 ブロックずつ）:
//   1. 枠の後ろに丸石の「背板」を立てる（バケツを使うときに狙う面になる）
//   2. 枠の位置 T に溶岩を置き、すぐ上 T+1 に水を置く → 水が溶岩の源に流れて黒曜石になる
//   3. 水をバケツで回収し、溶岩溜まりで溶岩をくみ直して次のブロックへ
// 溶岩は 1.5 秒ほどで流れ始めるので、溶岩を置いたらすぐに水を置く。
// 角の 4 つは何のブロックでもよいので丸石を置く。最後に中の丸石などを片付けて火打石で着火する。
import {
  SkillError, abortable, goTo, travelTo, mineBlocks, craftItem, placeNear, pillarUp, pillarDown, Vec3,
} from './common.js';
import { count, findItem } from '../util/items.js';
import { findVisibleBlocks, sleep } from '../body/humanize.js';

const COBBLE = ['cobblestone', 'cobbled_deepslate'];
const cobbleItem = (bot) => bot.inventory.items().find((i) => COBBLE.includes(i.name));
const isAir = (b) => !b || ['air', 'cave_air', 'short_grass', 'tall_grass', 'fern', 'snow'].includes(b.name);

// 溶岩溜まり（源が 3 つ以上）の近くで、4x6 の平らな場所を探す
function findSite(bot, pool) {
  for (let r = 3; r <= 8; r++) {
    for (const [dx, dz] of [[r, 0], [-r, 0], [0, r], [0, -r], [r, r], [-r, r], [r, -r], [-r, -r]]) {
      const ox = pool.x + dx; const oy = pool.y + 1; const oz = pool.z + dz;
      let ok = true;
      for (let x = -1; x <= 4 && ok; x++) {
        for (let z = -1; z <= 2 && ok; z++) {
          const g = bot.blockAt(new Vec3(ox + x, oy - 1, oz + z));
          if (!g || g.boundingBox !== 'block' || g.name === 'lava') ok = false;
          for (let y = 0; y <= 5 && ok; y++) if (!isAir(bot.blockAt(new Vec3(ox + x, oy + y, oz + z))) && z >= 0) ok = false;
        }
      }
      if (ok) return new Vec3(ox, oy, oz);
    }
  }
  return null;
}

async function placeAgainst(bot, item, refPos, face) {
  await bot.equip(item, 'hand');
  const ref = bot.blockAt(refPos);
  await bot.lookAt(refPos.offset(0.5 + face.x * 0.5, 0.5 + face.y * 0.5, 0.5 + face.z * 0.5), true);
  await bot.placeBlock(ref, face);
}

// バケツを使う: 背板の面（+z 側）を狙って使うと、その手前の位置に液体が置かれる
async function pourAt(bot, bucketName, backing) {
  const b = findItem(bot, bucketName);
  if (!b) throw new SkillError(`${bucketName} がない`);
  await bot.equip(b, 'hand');
  await bot.lookAt(backing.offset(0.5, 0.5, 1.0), true);
  bot.activateItem();
  await bot.waitForTicks(2);
}

async function scoop(ctx, liquid, pos) {
  const { bot } = ctx;
  const b = findItem(bot, 'bucket');
  if (!b) throw new SkillError('空のバケツがない');
  await bot.equip(b, 'hand');
  await bot.lookAt(pos.offset(0.5, 0.5, 0.5), true);
  bot.activateItem();
  await bot.waitForTicks(4);
  return !!findItem(bot, `${liquid}_bucket`);
}

async function refillLava(ctx, stand) {
  const { bot } = ctx;
  if (findItem(bot, 'lava_bucket')) return;
  const src = findVisibleBlocks(bot, ['lava'], { maxDistance: 16, count: 6, visibleOnly: true, extra: (b) => b.metadata === 0 })
    .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0];
  if (!src) throw new SkillError('溶岩の源が無くなった');
  await goTo(ctx, src.position.x, src.position.y + 1, src.position.z, 3).catch(() => {});
  if (!(await scoop(ctx, 'lava', src.position))) throw new SkillError('溶岩をくめなかった');
  await goTo(ctx, stand.x, stand.y, stand.z, 0.5);
}

export async function castNetherPortal(ctx) {
  const { bot, memory } = ctx;
  if (memory.getPlace('overworld_portal')) return 'ゲートはもうある';
  if (!findItem(bot, 'water_bucket')) throw new SkillError('水入りバケツが必要（fillWaterBucket）');
  if (!findItem(bot, 'bucket') && !findItem(bot, 'lava_bucket')) await craftItem(ctx, 'bucket', 1);
  if (!findItem(bot, 'flint_and_steel')) await craftItem(ctx, 'flint_and_steel', 1);
  const cobbleCount = () => COBBLE.reduce((s, n) => s + count(bot, n), 0);
  if (cobbleCount() < 34) await mineBlocks(ctx, ['stone', 'cobblestone', 'deepslate'], 34 - cobbleCount(), { maxExplore: 4 });
  if (cobbleCount() < 30) throw new SkillError('丸石が足りない（30 個必要）');

  // 1. 溶岩溜まりを探す（探索中に見かけて覚えた地表の溶岩溜まりがあれば、まずそこへ行く）
  const findPool = () => findVisibleBlocks(bot, ['lava'], { maxDistance: 48, count: 12, extra: (b) => b.metadata === 0 });
  let pool = findPool();
  const known = memory.getPlace('lava_pool');
  if (pool.length < 3 && known) {
    ctx.log.info(`覚えている溶岩溜まり (${known.x}, ${known.z}) へ向かう`);
    await travelTo(ctx, known.x, known.z, { range: 6 }).catch((e) => { if (e.name === 'AbortError') throw e; });
    pool = findPool();
  }
  if (pool.length < 3) throw new SkillError('溶岩溜まり（源 3 つ以上）が見つからない');
  const origin = findSite(bot, pool[0].position);
  if (!origin) throw new SkillError('溶岩溜まりの近くに平らな場所がない');
  const { x: ox, y: oy, z: oz } = origin;
  const stand = new Vec3(ox + 1, oy, oz + 2);
  await goTo(ctx, stand.x, stand.y, stand.z, 0.5);

  // 2. 背板（z = oz-1, x 0..3, y 0..5）を立てる
  for (let y = 0; y <= 5; y++) {
    for (let x = 0; x <= 3; x++) {
      abortable(ctx);
      const pos = new Vec3(ox + x, oy + y, oz - 1);
      if (!isAir(bot.blockAt(pos))) continue;
      const below = bot.blockAt(pos.offset(0, -1, 0));
      const side = bot.blockAt(pos.offset(-1, 0, 0));
      if (y >= 3 && !ctx.state.raised) { await pillarUp(ctx, 1); ctx.state.raised = true; }
      if (below && below.boundingBox === 'block') await placeAgainst(bot, cobbleItem(bot), below.position, new Vec3(0, 1, 0)).catch(() => {});
      else if (side && side.boundingBox === 'block') await placeAgainst(bot, cobbleItem(bot), side.position, new Vec3(1, 0, 0)).catch(() => {});
    }
  }
  if (ctx.state.raised) { await pillarDown(ctx, 1); ctx.state.raised = false; }

  // 3. 角は丸石、それ以外は溶岩＋水で黒曜石（下から順に）
  const frame = [];
  for (let y = 0; y <= 4; y++) {
    for (let x = 0; x <= 3; x++) {
      const edgeX = x === 0 || x === 3; const edgeY = y === 0 || y === 4;
      if (edgeX || edgeY) frame.push({ x, y, corner: edgeX && edgeY });
    }
  }
  for (const f of frame) {
    abortable(ctx);
    const T = new Vec3(ox + f.x, oy + f.y, oz);
    const cur = bot.blockAt(T);
    if (cur && (cur.name === 'obsidian' || (f.corner && COBBLE.includes(cur.name)))) continue;
    if (f.y >= 3 && !ctx.state.raised) { await pillarUp(ctx, 1); ctx.state.raised = true; }
    if (f.corner) {
      await placeAgainst(bot, cobbleItem(bot), new Vec3(T.x, T.y, oz - 1), new Vec3(0, 0, 1)).catch(() => {});
      continue;
    }
    await refillLava(ctx, ctx.state.raised ? stand.offset(0, 1, 0) : stand).catch(async (e) => {
      if (ctx.state.raised) { await pillarDown(ctx, 1); ctx.state.raised = false; await refillLava(ctx, stand); } else throw e;
    });
    if (f.y >= 3 && !ctx.state.raised) { await pillarUp(ctx, 1); ctx.state.raised = true; }
    await pourAt(bot, 'lava_bucket', new Vec3(T.x, T.y, oz - 1)); // T に溶岩
    await pourAt(bot, 'water_bucket', new Vec3(T.x, T.y + 1, oz - 1)); // T の上に水
    await sleep(700);
    // 水を回収
    const water = bot.blockAt(T.offset(0, 1, 0));
    if (water && water.name === 'water') await scoop(ctx, 'water', water.position);
    const made = bot.blockAt(T);
    if (!made || made.name !== 'obsidian') ctx.log.warn(`(${T}) が黒曜石にならなかった: ${made?.name}`);
  }
  if (ctx.state.raised) { await pillarDown(ctx, 1); ctx.state.raised = false; }

  // 4. 枠の中（x 1..2, y 1..3）を片付ける（溶岩と水でできた丸石など）
  for (let y = 1; y <= 3; y++) {
    for (let x = 1; x <= 2; x++) {
      const b = bot.blockAt(new Vec3(ox + x, oy + y, oz));
      if (b && !isAir(b) && b.name !== 'water') { await bot.tool.equipForBlock(b, {}).catch(() => {}); await bot.dig(b).catch(() => {}); }
    }
  }
  const missing = frame.filter((f) => !f.corner && bot.blockAt(new Vec3(ox + f.x, oy + f.y, oz))?.name !== 'obsidian').length;
  if (missing > 0) throw new SkillError(`黒曜石があと ${missing} 個足りない（やり直すと続きから作る）`);

  // 5. 着火
  await bot.equip(findItem(bot, 'flint_and_steel'), 'hand');
  const bottom = bot.blockAt(new Vec3(ox + 1, oy, oz));
  await bot.lookAt(bottom.position.offset(0.5, 1, 0.5), true);
  await bot.activateBlock(bottom, new Vec3(0, 1, 0));
  await sleep(1000);
  const portal = bot.blockAt(new Vec3(ox + 1, oy + 1, oz));
  if (!portal || portal.name !== 'nether_portal') throw new SkillError('ゲートに火が付かなかった');
  memory.setPlace('overworld_portal', portal.position, 'overworld');
  ctx.say?.('ゲートできた！');
  return `溶岩と水でネザーゲート完成 (${portal.position})`;
}

export { placeNear };
