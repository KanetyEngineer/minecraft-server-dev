import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseLitematic, writeLitematic, packStates, unpackStates, bitsFor } from '../src/building/litematic.js';

test('ビット詰め: long をまたぐ値も戻せる', () => {
  for (const bits of [2, 3, 5, 7, 13]) {
    const vals = Array.from({ length: 200 }, (_, i) => (i * 7919) % (1 << bits));
    assert.deepEqual([...unpackStates(packStates(vals, bits), bits, vals.length)], vals);
  }
});

test('パレット数からビット数', () => {
  assert.equal(bitsFor(1), 2);
  assert.equal(bitsFor(4), 2);
  assert.equal(bitsFor(5), 3);
  assert.equal(bitsFor(24), 5);
});

test('Blender から変換した猿の設計図を読める（TotalBlocks と一致）', async () => {
  const s = await parseLitematic(fs.readFileSync('schematics/sample-monkey.litematic'));
  assert.deepEqual(s.size, { x: 48, y: 35, z: 29 });
  assert.equal(s.blocks.length, 4810);
  assert.ok(s.blocks.every((b) => b.x >= 0 && b.y >= 0 && b.z >= 0 && b.x < 48 && b.y < 35 && b.z < 29));
});

test('書き出して読み直すと同じ（性質つき）', async () => {
  const blocks = [
    { x: 0, y: 0, z: 0, name: 'stone', props: {} },
    { x: 2, y: 1, z: 1, name: 'oak_stairs', props: { facing: 'east', half: 'top' } },
    { x: 1, y: 2, z: 0, name: 'oak_log', props: { axis: 'x' } },
  ];
  const s = await parseLitematic(writeLitematic({ name: 't', blocks, size: { x: 3, y: 3, z: 2 } }));
  const sort = (a) => [...a].sort((p, q) => p.y - q.y || p.z - q.z || p.x - q.x);
  assert.deepEqual(sort(s.blocks), sort(blocks));
});
