import test from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import { chooseExploreHeading } from '../src/skills/common.js';

// 東（+x）は海、西（-x）は森、ほかは草地の世界
function world() {
  return {
    entity: { position: new Vec3(0, 64, 0) },
    blockAt: (p) => {
      if (p.y > 63) return { name: 'air', boundingBox: 'empty' };
      if (p.y < 63) return { name: 'stone', boundingBox: 'block' };
      if (p.x > 4) return { name: 'water', boundingBox: 'empty' };
      if (p.x < -4) return { name: 'oak_leaves', boundingBox: 'block' };
      return { name: 'grass_block', boundingBox: 'block' };
    },
  };
}

test('探索の向きは海を避け、木の葉の多い方を選ぶ', () => {
  const h = chooseExploreHeading(world(), 0); // 今は東（海）を向いている
  assert.ok(Math.cos(h) < -0.5, `西寄りを選ぶはず（h=${h}）`);
});
test('経路探索が「着いた」と返して動かないときは探索を失敗にし、回数を数える', async () => {
  const { explore } = await import('../src/skills/general.js');
  const bot = world();
  bot.pathfinder = { goto: async () => {} }; // 壊れた経路探索: すぐ終わるが一歩も動かない
  const ctx = { bot, state: {}, log: { info() {}, warn() {} } };
  await assert.rejects(explore(ctx, { steps: 2 }), /動けなかった/);
  assert.equal(ctx.state.stuckExplores, 2);

  // 動けたら成功で、回数はリセットされる
  bot.pathfinder = { goto: async () => { bot.entity.position = bot.entity.position.offset(20, 0, 0); } };
  assert.match(await explore(ctx, { steps: 1 }), /探索した/);
  assert.equal(ctx.state.stuckExplores, 0);
});

test('ディープダークの危険地帯は通常より広く（半径 48）避ける', async () => {
  const { nearDanger } = await import('../src/skills/common.js');
  const zone = new Vec3(0, -30, 0); zone.r = 48;
  const ctx = { state: { dangerZones: [zone] } };
  assert.equal(nearDanger(ctx, new Vec3(40, -30, 0)), true);
  assert.equal(nearDanger(ctx, new Vec3(60, -30, 0)), false);
  const mine = new Vec3(0, 20, 0); // 廃坑はこれまでどおり 24
  assert.equal(nearDanger({ state: { dangerZones: [mine] } }, new Vec3(30, 20, 0)), false);
});
