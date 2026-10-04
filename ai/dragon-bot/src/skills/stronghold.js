// エンダーアイで要塞を探し、エンドポータルを起動する
import {
  SkillError, abortable, travelTo, descendTo, exploreStep, goNearBlock, pickUpItems, mineBlocks, dim, goals, Vec3,
} from './common.js';
import { count, findItem } from '../util/items.js';
import { findVisibleBlocks, sleep, smoothLookAt } from '../body/humanize.js';
import { estimateStronghold, rayAngleDeg } from '../util/geometry.js';

// エンダーアイを投げて飛んだ方向を測る。{ x, z, dx, dz, dy } を返す。
export async function throwEye(ctx) {
  const { bot, memory } = ctx;
  if (!findItem(bot, 'ender_eye')) throw new SkillError('エンダーアイがない');
  await bot.equip(findItem(bot, 'ender_eye'), 'hand');
  await smoothLookAt(bot, bot.entity.position.offset(Math.sin(-bot.entity.yaw) * 5, 3, -Math.cos(bot.entity.yaw) * 5), ctx.cfg.human.turnSpeed);
  // 止まった直後はサーバーと位置がずれていることがある（エンダーアイの非同期）。1 秒以上静止してから投げる
  try { bot.pathfinder.stop(); } catch {}
  bot.clearControlStates();
  await bot.waitForTicks(24);
  const from = bot.entity.position.clone();
  const seenIds = new Set(Object.values(bot.entities).filter((e) => e.name === 'eye_of_ender').map((e) => e.id));
  bot.activateItem();
  let eye = null;
  for (let i = 0; i < 20 && !eye; i++) {
    await bot.waitForTicks(1);
    eye = Object.values(bot.entities).find((e) => e.name === 'eye_of_ender' && !seenIds.has(e.id) && e.position.distanceTo(from) < 6);
  }
  if (!eye) throw new SkillError('投げたエンダーアイを見失った');
  const p0 = eye.position.clone();
  let p1 = p0;
  for (let i = 0; i < 40 && eye.isValid; i++) {
    await bot.waitForTicks(1);
    p1 = eye.position.clone();
  }
  const dx = p1.x - p0.x; const dz = p1.z - p0.z;
  const len = Math.hypot(dx, dz);
  // 測定線の起点は、ボットの位置ではなくアイが実際に出現した位置（サーバーが決めた位置）にする
  const result = { x: p0.x, z: p0.z, dx: len ? dx / len : 0, dz: len ? dz / len : 0, dy: p1.y - p0.y, horiz: len };
  memory.data.eyeThrows.push({ ...result, at: new Date().toISOString() });
  memory.save();
  // 割れずに落ちたら拾う
  await sleep(1500);
  await pickUpItems(ctx, 12);
  return result;
}

export async function locateStronghold(ctx) {
  const { bot, memory } = ctx;
  if (dim(ctx) !== 'overworld') throw new SkillError('オーバーワールドで使う');
  if (count(bot, 'ender_eye') < 2) throw new SkillError('エンダーアイが 2 個以上必要');
  const t1 = await throwEye(ctx);
  ctx.say?.('アイ投げた、あっちか');
  // 飛んだ方向と直角に 150 ブロック移動してもう一度投げる
  const side = Math.random() < 0.5 ? 1 : -1;
  await travelTo(ctx, t1.x + -t1.dz * 150 * side, t1.z + t1.dx * 150 * side, { range: 6 });
  const t2 = await throwEye(ctx);
  let throws = [t1, t2];
  if (rayAngleDeg(t1, t2) < 8) {
    // 角度が浅いのでさらに離れて 3 投目
    await travelTo(ctx, t2.x + -t2.dz * 200 * side, t2.z + t2.dx * 200 * side, { range: 6 });
    throws = [...throws, await throwEye(ctx)];
  }
  const est = estimateStronghold(throws);
  if (!est) throw new SkillError('三角測量に失敗（方向がほぼ平行）');
  // アイはチャンクの中心を指すが、スターター階段はチャンク内の (4, 4) にあるので、そこを目指す（RTA Wiki「エンド要塞」）
  const target = toStarterStaircase(est);
  memory.setPlace('stronghold_estimate', { x: target.x, y: 30, z: target.z }, 'overworld');
  return `要塞の推定位置 x=${target.x}, z=${target.z}（スターター階段の位置に補正）`;
}

// 推定位置をチャンク内の (4, 4) に合わせる
export function toStarterStaircase(p) {
  return { x: Math.floor(p.x / 16) * 16 + 4, z: Math.floor(p.z / 16) * 16 + 4 };
}

const STRONGHOLD_BLOCKS = ['stone_bricks', 'mossy_stone_bricks', 'cracked_stone_bricks', 'infested_stone_bricks', 'end_portal_frame'];

export async function findEndPortal(ctx) {
  const { bot, memory } = ctx;
  const est = memory.getPlace('stronghold_estimate');
  if (!est) throw new SkillError('要塞の場所が分からない（locateStronghold が先）');
  // アイはチャンクの中心（4,4）に向かうので、推定地点のチャンク中央に立ってから掘る（起点の螺旋階段に当たりやすい）
  const cx = Math.floor(est.x / 16) * 16 + 4; const cz = Math.floor(est.z / 16) * 16 + 4;
  await travelTo(ctx, cx, cz, { range: 3 });
  // 近くでもう一度投げて、真下に落ちるか確認（真下ならこの下）
  if (count(bot, 'ender_eye') > 1) {
    const t = await throwEye(ctx).catch(() => null);
    if (t && t.horiz > 2 && t.dy >= 0) {
      const nx = bot.entity.position.x + t.dx * 24; const nz = bot.entity.position.z + t.dz * 24;
      await travelTo(ctx, Math.floor(nx / 16) * 16 + 4, Math.floor(nz / 16) * 16 + 4, { range: 3 });
    }
  }
  // 掘り下がりながら石レンガを探す
  for (const y of [40, 30, 20, 10, 0, -10, -20]) {
    abortable(ctx);
    if (bot.entity.position.y > y) await descendTo(ctx, y);
    const frame = findVisibleBlocks(bot, ['end_portal_frame'], { maxDistance: 32, count: 1, visibleOnly: false })[0];
    if (frame) {
      memory.setPlace('end_portal', frame.position, 'overworld');
      return `エンドポータル発見 (${frame.position})`;
    }
    const brick = findVisibleBlocks(bot, STRONGHOLD_BLOCKS, { maxDistance: 24, count: 1 })[0];
    if (brick) {
      memory.setPlace('stronghold', brick.position, 'overworld');
      return await searchInsideStronghold(ctx);
    }
  }
  throw new SkillError('要塞の通路が見つからなかった');
}

// 要塞の中を歩き回ってポータル部屋を探す
async function searchInsideStronghold(ctx) {
  const { bot, memory } = ctx;
  const visited = [];
  for (let t = 0; t < 80; t++) {
    abortable(ctx);
    const frame = findVisibleBlocks(bot, ['end_portal_frame'], { maxDistance: 32, count: 1, visibleOnly: false })[0];
    if (frame) {
      memory.setPlace('end_portal', frame.position, 'overworld');
      return `エンドポータル発見 (${frame.position})`;
    }
    // まだ行っていない石レンガのほうへ進む
    const bricks = findVisibleBlocks(bot, STRONGHOLD_BLOCKS, { maxDistance: 32, count: 40 })
      .filter((b) => visited.every((v) => v.distanceTo(b.position) > 10));
    if (bricks.length === 0) { await exploreStep(ctx, 16); continue; }
    const target = bricks[Math.floor(Math.random() * Math.min(5, bricks.length))];
    visited.push(target.position);
    await bot.pathfinder.goto(new goals.GoalNear(target.position.x, target.position.y + 1, target.position.z, 2)).catch(() => {});
  }
  throw new SkillError('ポータル部屋が見つからなかった');
}

export async function activateEndPortal(ctx) {
  const { bot, memory } = ctx;
  const place = memory.getPlace('end_portal');
  if (!place) throw new SkillError('エンドポータルの場所が分からない');
  if (count(bot, 'cobblestone') + count(bot, 'cobbled_deepslate') < 64) {
    // エンドで橋や柱に使う足場を先に確保
    await mineBlocks(ctx, ['stone', 'cobblestone', 'deepslate', 'stone_bricks'], 64 - count(bot, 'cobblestone') - count(bot, 'cobbled_deepslate'), { maxExplore: 4 });
  }
  await bot.pathfinder.goto(new goals.GoalNear(place.x, place.y, place.z, 3));
  const frames = findVisibleBlocks(bot, ['end_portal_frame'], { maxDistance: 8, count: 12, visibleOnly: false });
  let placed = 0;
  for (const f of frames) {
    abortable(ctx);
    if (f.getProperties().eye) continue;
    if (!findItem(bot, 'ender_eye')) throw new SkillError('エンダーアイが足りない');
    await goNearBlock(ctx, f, 3).catch(() => {});
    await bot.equip(findItem(bot, 'ender_eye'), 'hand');
    await smoothLookAt(bot, f.position.offset(0.5, 1, 0.5), ctx.cfg.human.turnSpeed);
    await bot.activateBlock(bot.blockAt(f.position), new Vec3(0, 1, 0));
    placed++;
    await sleep(300);
  }
  memory.setFlag('eyesPlaced', (memory.flag('eyesPlaced') ?? 0) + placed);
  await sleep(1000);
  const portal = findVisibleBlocks(bot, ['end_portal'], { maxDistance: 10, count: 1, visibleOnly: false })[0];
  if (!portal) throw new SkillError(`ポータルが開かない（アイ ${placed} 個はめた）`);
  ctx.say?.('ポータル開いた！行ってくる');
  await bot.pathfinder.goto(new goals.GoalNear(portal.position.x, portal.position.y + 1, portal.position.z, 0)).catch(() => {});
  bot.setControlState('forward', true);
  for (let i = 0; i < 30 && dim(ctx) !== 'the_end'; i++) await sleep(500);
  bot.setControlState('forward', false);
  if (dim(ctx) !== 'the_end') throw new SkillError('エンドに入れなかった');
  await sleep(3000);
  return 'ジ・エンドに到着';
}
