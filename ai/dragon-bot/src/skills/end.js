// ジ・エンド: エンドクリスタルを壊し、エンダードラゴンを倒す
import { SkillError, abortable, travelTo, dim, goals, Vec3, pillarUp, pillarDown } from './common.js';
import { shootAt } from './nether.js';
import { count, findItem } from '../util/items.js';
import { findVisibleBlocks, sleep, smoothLookAt } from '../body/humanize.js';

const crystals = (bot) => Object.values(bot.entities).filter((e) => e.name === 'end_crystal');
const dragonOf = (bot) => Object.values(bot.entities).find((e) => e.name === 'ender_dragon');

function fountain(bot) {
  // 中央の岩盤（出口ポータル）の一番上を探す
  for (let y = 80; y > 40; y--) {
    const b = bot.blockAt(new Vec3(0, y, 0));
    if (b && b.name === 'bedrock') return new Vec3(0, y, 0);
  }
  return new Vec3(0, 64, 0);
}

export function dragonDefeated(bot) {
  // ドラゴンを倒すと中央の出口ポータルが開く
  return findVisibleBlocks(bot, ['end_portal'], { maxDistance: 160, count: 1, visibleOnly: false })
    .some((b) => Math.hypot(b.position.x, b.position.z) < 6);
}

async function goToMainIsland(ctx) {
  const { bot } = ctx;
  if (Math.hypot(bot.entity.position.x, bot.entity.position.z) < 50) return;
  // 出現位置の黒曜石の足場から本島まで、必要なら橋をかけて歩く（pathfinder が足場ブロックを置く）
  await travelTo(ctx, 20, 0, { step: 32, range: 4 });
}

export async function destroyEndCrystals(ctx) {
  const { bot, memory } = ctx;
  if (dim(ctx) !== 'the_end') throw new SkillError('エンドにいない');
  await goToMainIsland(ctx);
  if (!findItem(bot, 'bow') || count(bot, 'arrow') < 10) throw new SkillError('弓と矢（10 本以上）が必要');
  let caged = 0;
  for (let round = 0; round < 3; round++) {
    const list = crystals(bot).sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position));
    if (list.length === 0) break;
    for (const c of list) {
      abortable(ctx);
      if (!c.isValid) continue;
      // よく見える距離まで近づいて撃つ（真下は避ける）
      const dx = bot.entity.position.x - c.position.x; const dz = bot.entity.position.z - c.position.z;
      const d = Math.hypot(dx, dz) || 1;
      await bot.pathfinder.goto(new goals.GoalNearXZ(c.position.x + (dx / d) * 18, c.position.z + (dz / d) * 18, 4)).catch(() => {});
      await shootAt(ctx, c, { shots: 3 });
      if (c.isValid) {
        caged++;
        await breakCage(ctx, c);
        await shootAt(ctx, c, { shots: 3 }).catch(() => {});
      }
    }
  }
  const left = crystals(bot).length;
  if (left === 0) {
    memory.setFlag('crystalsDestroyed');
    ctx.say?.('クリスタル全部壊した');
    return 'エンドクリスタルをすべて破壊';
  }
  return `クリスタル残り ${left}（檻付き ${caged}）`;
}

// 檻付きのクリスタル: 柱の横に足場を積んで鉄格子を壊し、降りて離れる
async function breakCage(ctx, crystal) {
  const { bot } = ctx;
  const groundY = Math.floor(bot.entity.position.y);
  await bot.pathfinder.goto(new goals.GoalNear(crystal.position.x + 3, crystal.position.y - 2, crystal.position.z, 1)).catch(() => {});
  const bars = findVisibleBlocks(bot, ['iron_bars'], { maxDistance: 5, count: 12, visibleOnly: false });
  for (const b of bars) {
    abortable(ctx);
    await bot.dig(bot.blockAt(b.position)).catch(() => {});
  }
  await bot.pathfinder.goto(new goals.GoalY(groundY)).catch(() => {});
  const p = bot.entity.position;
  await bot.pathfinder.goto(new goals.GoalNearXZ(p.x + (p.x - crystal.position.x), p.z + (p.z - crystal.position.z) + 12, 3)).catch(() => {});
}

// ベッド爆破（RTA の定番）: 着地中のドラゴンの頭の近くにベッドを置き、間にブロックを挟んでから使う。
// エンドではベッドは使うと爆発する。自分も巻き込まれないよう、体力が十分なときだけ行う。
async function bedBomb(ctx, dragon, center) {
  const { bot } = ctx;
  const bed = bot.inventory.items().find((i) => i.name.endsWith('_bed'));
  if (!bed || bot.health < 14) return false;
  const head = dragon.position;
  // 自分はドラゴンから 4〜5 マス離れた位置に立つ
  const dx = bot.entity.position.x - head.x; const dz = bot.entity.position.z - head.z;
  const d = Math.hypot(dx, dz) || 1;
  await bot.pathfinder.goto(new goals.GoalNear(head.x + (dx / d) * 4.5, center.y + 1, head.z + (dz / d) * 4.5, 1)).catch(() => {});
  // ドラゴン側の 2 マス先の地面にベッドを置く
  const p = bot.entity.position.floored();
  const ux = Math.round(-dx / d); const uz = Math.round(-dz / d);
  const floor = bot.blockAt(p.offset(ux * 2, -1, uz * 2));
  if (!floor || floor.boundingBox !== 'block') return false;
  await bot.equip(bed, 'hand');
  await smoothLookAt(bot, floor.position.offset(0.5, 1, 0.5), 60);
  try { await bot.placeBlock(floor, new Vec3(0, 1, 0)); } catch { return false; }
  const placedBed = bot.blockAt(floor.position.offset(0, 1, 0));
  if (!placedBed || !placedBed.name.endsWith('_bed')) return false;
  // 爆風よけ: 目の高さに 1 ブロック挟む
  const shield = bot.inventory.items().find((i) => ['cobblestone', 'end_stone', 'obsidian', 'cobbled_deepslate'].includes(i.name));
  if (shield) {
    const wallPos = p.offset(ux, 1, uz);
    const ref = bot.blockAt(wallPos.offset(0, -1, 0));
    if (ref && ref.boundingBox === 'block') {
      await bot.equip(shield, 'hand');
      await bot.placeBlock(ref, new Vec3(0, 1, 0)).catch(() => {});
    }
  }
  await bot.activateBlock(placedBed).catch(() => {});
  return true;
}

// ドラゴンの頭（部位エンティティ）を殴る。部位の ID は本体 ID の続き番号。
function hitDragonHead(bot, dragon) {
  bot.attack({ id: dragon.id + 1, position: dragon.position, height: 1, isValid: true });
}

export async function fightDragon(ctx, { minutes = 15 } = {}) {
  const { bot, memory } = ctx;
  if (dim(ctx) !== 'the_end') throw new SkillError('エンドにいない');
  await goToMainIsland(ctx);
  const center = fountain(bot);
  const deadline = Date.now() + minutes * 60_000;
  let seen = false;
  while (Date.now() < deadline) {
    abortable(ctx);
    if (dragonDefeated(bot) && seen) {
      memory.setFlag('dragonDefeated');
      return 'エンダードラゴン討伐！';
    }
    const dragon = dragonOf(bot);
    if (!dragon) {
      await bot.pathfinder.goto(new goals.GoalNearXZ(center.x + 10, center.z, 4)).catch(() => {});
      await sleep(1000);
      continue;
    }
    seen = true;
    // ドラゴンブレスの紫の雲からは離れる
    const cloud = bot.nearestEntity((e) => e.name === 'area_effect_cloud' && e.position.distanceTo(bot.entity.position) < 5);
    if (cloud) {
      // RTA の定石: ブレスの雲からは 2 段積んで上に逃げるのが速くて安全。積めなければ離れる
      const placed = await pillarUp(ctx, 2).catch(() => 0);
      if (placed < 2) {
        const p = bot.entity.position;
        await bot.pathfinder.goto(new goals.GoalNearXZ(p.x + (p.x - cloud.position.x) * 2, p.z + (p.z - cloud.position.z) * 2, 2)).catch(() => {});
      } else {
        await sleep(3000);
        await pillarDown(ctx, placed);
      }
      continue;
    }
    const horiz = Math.hypot(dragon.position.x - center.x, dragon.position.z - center.z);
    const perching = horiz < 8 && dragon.position.y < center.y + 10;
    if (perching && bot.inventory.items().some((i) => i.name.endsWith('_bed')) && bot.health >= 14) {
      // 着地中でベッドがあれば、ベッド爆破で大ダメージを狙う
      await bedBomb(ctx, dragon, center);
      await sleep(500);
    } else if (perching) {
      // 着地中: 近づいて頭を剣で殴る
      const sword = ['netherite_sword', 'diamond_sword', 'iron_sword', 'stone_sword'].map((n) => findItem(bot, n)).find(Boolean);
      if (sword) await bot.equip(sword, 'hand');
      await bot.pathfinder.goto(new goals.GoalNear(dragon.position.x, center.y + 1, dragon.position.z, 3)).catch(() => {});
      await smoothLookAt(bot, dragon.position.offset(0, 2, 0), 60);
      hitDragonHead(bot, dragon);
      await sleep(650); // 攻撃のクールダウン
    } else if (findItem(bot, 'bow') && count(bot, 'arrow') > 0 && dragon.position.distanceTo(bot.entity.position) < 64) {
      await shootAt(ctx, dragon, { shots: 1 }).catch(() => {});
    } else {
      // 待機位置（中央から少し離れた場所）で待つ
      await bot.pathfinder.goto(new goals.GoalNearXZ(center.x + 8, center.z + 8, 3)).catch(() => {});
      await sleep(800);
    }
  }
  return 'まだ討伐できていない（続けて fightDragon を選べる）';
}

export async function celebrate(ctx) {
  const { bot } = ctx;
  ctx.say?.('GG！エンダードラゴン倒した！');
  for (let i = 0; i < 4; i++) {
    bot.setControlState('jump', true);
    await sleep(400);
    bot.setControlState('jump', false);
    await sleep(300);
  }
  return 'お祝いした';
}
