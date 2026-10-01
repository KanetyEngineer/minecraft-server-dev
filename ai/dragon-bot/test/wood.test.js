import test from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import { isGroundedLog } from '../src/skills/overworld.js';

// y ごとのブロック名を持つ 1 列だけの世界
const column = (byY) => ({
  blockAt: (p) => {
    const name = byY[p.y] ?? 'air';
    return { name, boundingBox: name === 'air' ? 'empty' : 'block' };
  },
});
const log = (y) => ({ name: 'acacia_log', position: new Vec3(0, y, 0) });

test('幹が地面につながっている原木は対象', () => {
  const bot = column({ 63: 'grass_block', 64: 'acacia_log', 65: 'acacia_log', 66: 'acacia_log' });
  assert.equal(isGroundedLog(bot, log(66)), true);
});

test('宙に浮いた枝や葉の上の原木は対象外', () => {
  assert.equal(isGroundedLog(column({ 63: 'grass_block' }), log(70)), false);
  assert.equal(isGroundedLog(column({ 63: 'grass_block', 69: 'acacia_leaves' }), log(70)), false);
});