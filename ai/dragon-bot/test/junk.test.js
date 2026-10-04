import test from 'node:test';
import assert from 'node:assert/strict';
import { dropPlan } from '../src/util/items.js';

test('持ち物がいっぱいのとき、丸石などは決めた数だけ残し、いらない石は捨てる', () => {
  const plan = dropPlan([
    { name: 'cobblestone', count: 64 }, { name: 'cobblestone', count: 64 }, { name: 'cobblestone', count: 10 },
    { name: 'andesite', count: 84 }, { name: 'dirt', count: 20 }, { name: 'raw_iron', count: 5 }, { name: 'oak_sapling', count: 2 },
  ]);
  const m = Object.fromEntries(plan.map((p) => [p.name, p.count]));
  assert.equal(m.cobblestone, 74);
  assert.equal(m.andesite, 84);
  assert.equal(m.dirt, undefined); // 残す数以下
  assert.equal(m.raw_iron, undefined); // 大事な物は捨てない
  assert.equal(m.oak_sapling, 2);
});
