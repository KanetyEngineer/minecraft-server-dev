import test from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import { isGroundedLog, addConnectedLogs } from '../src/skills/overworld.js';

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
test('切った原木につながる原木（斜めの枝も）をたどり、別の木や地面は含めない', () => {
  const logs = new Set(['0,65,0', '0,66,0', '1,67,0', '2,68,1', '9,65,9']);
  const bot = { blockAt: (p) => ({ name: logs.has(`${p.x},${p.y},${p.z}`) ? 'acacia_log' : 'air' }) };
  const tree = addConnectedLogs(bot, new Vec3(0, 64, 0), new Map());
  assert.deepEqual([...tree.keys()].sort(), ['0,65,0', '0,66,0', '1,67,0', '2,68,1']);
});