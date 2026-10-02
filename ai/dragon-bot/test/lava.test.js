import test from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import { lavaEdgeCost, lavaBeside, isBurning, inLava } from '../src/skills/lava.js';

// 小さな世界: y<=63 は石、y>=64 は空気。x -2..1, z -2..2 の y=63 は溶岩溜まり
function world() {
  const lava = new Set();
  for (let x = -2; x <= 1; x++) for (let z = -2; z <= 2; z++) lava.add(`${x},63,${z}`);
  const blockAt = (q) => {
    // 本物の bot.blockAt と同じく、小数の座標はブロックの位置（切り捨て）にする
    const p = { x: Math.floor(q.x), y: Math.floor(q.y), z: Math.floor(q.z) };
    const key = `${p.x},${p.y},${p.z}`;
    const pos = new Vec3(p.x, p.y, p.z);
    if (lava.has(key)) return { name: 'lava', boundingBox: 'empty', position: pos, metadata: 0 };
    if (p.y <= 63) return { name: 'stone', boundingBox: 'block', position: pos, metadata: 0 };
    return { name: 'air', boundingBox: 'empty', position: pos, metadata: 0 };
  };
  return { blockAt, entity: { position: new Vec3(0.5, 63.2, 0.5), isInLava: true, metadata: [1] } };
}

test('溶岩の中にいる・燃えている の判定', () => {
  const bot = world();
  assert.equal(inLava(bot), true);
  bot.entity.isInLava = false;
  assert.equal(inLava(bot), true); // 足の位置のブロックが溶岩
  bot.entity.position = new Vec3(3.5, 64.2, 0.5);
  assert.equal(inLava(bot), false);
  assert.equal(isBurning(bot), true);
  bot.entity.metadata = [0];
  assert.equal(isBurning(bot), false);
  assert.equal(isBurning({ entity: {} }), false);
});

test('経路探索: 溶岩のとなりのマスは高コスト、離れていれば 0', () => {
  const bot = world();
  assert.equal(lavaBeside(bot, new Vec3(2, 64, 0)), true); // 1 段下のとなりが溶岩
  assert.equal(lavaBeside(bot, new Vec3(4, 64, 0)), false);
  assert.equal(lavaEdgeCost(bot, bot.blockAt(new Vec3(2, 64, 0))), 25);
  assert.equal(lavaEdgeCost(bot, bot.blockAt(new Vec3(4, 64, 0))), 0);
  assert.equal(lavaEdgeCost(bot, { safe: false }), 0); // pathfinder のダミーブロック（position 無し）
});

// 経路探索用の速い版: 状態 ID だけを読む小さな世界
function stateWorld() {
  const LAVA_ID = 100; const STONE = 1; const AIR = 0;
  const lava = new Set();
  for (let x = -2; x <= 1; x++) for (let z = -2; z <= 2; z++) lava.add(`${x},63,${z}`);
  let reads = 0;
  const bot = {
    registry: { blocksByName: { lava: { id: 50, minStateId: LAVA_ID, maxStateId: LAVA_ID + 15 } } },
    entity: { position: new Vec3(0.5, 64, 0.5) },
    world: { getBlockStateId: (p) => { reads++; return lava.has(`${p.x},${p.y},${p.z}`) ? LAVA_ID + 3 : (p.y <= 63 ? STONE : AIR); } },
    lavaNear: true,
    findBlocks() { return this.lavaNear ? [new Vec3(0, 63, 0)] : []; },
  };
  return { bot, reads: () => reads };
}

test('経路探索の速い版: 溶岩のとなりは高コスト、同じマスは覚えて読み直さない', async () => {
  const { makeLavaEdgeCost } = await import('../src/skills/lava.js');
  const { bot, reads } = stateWorld();
  let t = 0;
  const cost = makeLavaEdgeCost(bot, { now: () => t });
  assert.equal(cost({ position: new Vec3(2, 64, 0) }), 25);
  assert.equal(cost({ position: new Vec3(4, 64, 0) }), 0);
  assert.equal(cost({ safe: false }), 0);
  const n = reads();
  assert.equal(cost({ position: new Vec3(4, 64, 0) }), 0);
  assert.equal(cost({ position: new Vec3(2, 64, 0) }), 25);
  assert.equal(reads(), n, '2 回目は覚えた答えを使う');
});

test('経路探索の速い版: 近くに溶岩が無ければ、ブロックを 1 つも読まずに 0', async () => {
  const { makeLavaEdgeCost } = await import('../src/skills/lava.js');
  const { bot, reads } = stateWorld();
  bot.lavaNear = false;
  let t = 0;
  const cost = makeLavaEdgeCost(bot, { now: () => t, refreshMs: 1000 });
  assert.equal(cost({ position: new Vec3(2, 64, 0) }), 0);
  assert.equal(reads(), 0);
  // 溶岩が見つかるようになったら、調べ直す時刻のあとから効く
  bot.lavaNear = true;
  assert.equal(cost({ position: new Vec3(2, 64, 0) }), 0, 'まだ調べ直していない');
  t = 1500;
  assert.equal(cost({ position: new Vec3(2, 64, 0) }), 25);
});
