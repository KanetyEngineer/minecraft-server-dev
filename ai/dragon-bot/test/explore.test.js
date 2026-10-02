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