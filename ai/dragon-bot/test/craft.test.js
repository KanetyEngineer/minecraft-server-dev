import test from 'node:test';
import assert from 'node:assert/strict';
import { ensurePlanks } from '../src/skills/common.js';

// 板材を作るたびに原木 1 → 板材 4 になる、にせボット
function craftBot(inv) {
  const items = () => Object.entries(inv).filter(([, c]) => c > 0).map(([name, count]) => ({ name, count }));
  const byName = {};
  for (const n of ['acacia_planks', 'oak_planks']) byName[n] = { id: n };
  return {
    inventory: { items },
    registry: { itemsByName: byName },
    recipesFor: (id) => [{ out: id }],
    craft: async (r) => {
      const log = r.out.replace('_planks', '_log');
      inv[log] -= 1;
      inv[r.out] = (inv[r.out] ?? 0) + 4;
    },
  };
}

test('種類指定の板材は、その種類で数えて足りなければ同じ種類の原木から作る', async () => {
  const inv = { acacia_planks: 1, oak_planks: 1, acacia_log: 3, oak_log: 2 };
  await ensurePlanks({ bot: craftBot(inv) }, 2, 'acacia_planks');
  assert.equal(inv.acacia_planks, 5);
  assert.equal(inv.oak_log, 2);
});

test('種類指定が無くても、1 種類で数がそろうように作る（混ざった板材ではレシピがそろわない）', async () => {
  const inv = { acacia_planks: 1, oak_planks: 1, acacia_log: 3 };
  await ensurePlanks({ bot: craftBot(inv) }, 2);
  assert.equal(inv.acacia_log, 2);
  assert.equal(inv.acacia_planks, 5);
});

test('どの種類でも足りないときは合計で数える', async () => {
  const inv = { acacia_planks: 1, oak_planks: 1 };
  await ensurePlanks({ bot: craftBot(inv) }, 2);
  assert.equal(inv.acacia_planks, 1);
});
test('持っていない種類の板材を指定されても、手持ちの原木を全部板材にしない', async () => {
  const inv = { oak_planks: 1, oak_log: 10 };
  await ensurePlanks({ bot: craftBot(inv) }, 3, 'acacia_planks');
  assert.equal(inv.oak_planks, 5);
  assert.equal(inv.oak_log, 9);
});