import test from 'node:test';
import assert from 'node:assert/strict';
import mcData from 'minecraft-data';
import { itemFor, materialList, placementHint, matches, isSecondaryHalf } from '../src/building/blocks.js';

const reg = mcData('1.21.11');
const b = (name, props = {}) => ({ name, props });

test('アイテムの対応: 壁の松明・草ブロック・2 枚重ねのハーフ', () => {
  assert.deepEqual(itemFor(reg, b('wall_torch', { facing: 'north' })), { item: 'torch', count: 1 });
  assert.deepEqual(itemFor(reg, b('grass_block')), { item: 'dirt', count: 1 });
  assert.deepEqual(itemFor(reg, b('oak_slab', { type: 'double' })), { item: 'oak_slab', count: 2 });
  assert.deepEqual(itemFor(reg, b('oak_wall_sign', { facing: 'east' })), { item: 'oak_sign', count: 1 });
  assert.equal(itemFor(reg, b('water')), null);
});

test('ドアの上半分・ベッドの頭は数えない', () => {
  assert.ok(isSecondaryHalf(b('oak_door', { half: 'upper' })));
  assert.ok(isSecondaryHalf(b('red_bed', { part: 'head' })));
  const { need } = materialList(reg, [b('oak_door', { half: 'lower' }), b('oak_door', { half: 'upper' }), b('red_bed', { part: 'foot' }), b('red_bed', { part: 'head' })]);
  assert.equal(need.get('oak_door'), 1);
  assert.equal(need.get('red_bed'), 1);
});

test('置き方: 原木の軸・階段の向き・かまどの向き・壁の松明', () => {
  assert.deepEqual(placementHint(b('oak_log', { axis: 'x' })).faces, ['east', 'west']);
  const st = placementHint(b('oak_stairs', { facing: 'east', half: 'top' }));
  assert.equal(st.look, 'east');
  assert.equal(st.half, 'top');
  assert.equal(placementHint(b('furnace', { facing: 'north' })).look, 'south');
  assert.deepEqual(placementHint(b('wall_torch', { facing: 'south' })).faces, ['south']);
  assert.deepEqual(placementHint(b('oak_trapdoor', { facing: 'north', half: 'top' })).faces, ['down']);
});

test('出来ているかの判定: 種類と大事な性質だけ見る', () => {
  const world = (name, props) => ({ name, getProperties: () => props });
  assert.ok(matches(b('oak_stairs', { facing: 'east', shape: 'straight' }), world('oak_stairs', { facing: 'east', shape: 'outer_left' })));
  assert.ok(!matches(b('oak_stairs', { facing: 'east' }), world('oak_stairs', { facing: 'west' })));
  assert.ok(matches(b('oak_stairs', { facing: 'east' }), world('oak_stairs', { facing: 'west' }), { checkProps: false }));
  assert.ok(matches(b('grass_block'), world('dirt', {})));
});
