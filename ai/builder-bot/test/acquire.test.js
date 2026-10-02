import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import mcData from 'minecraft-data';
import { Supplier } from '../src/building/acquire.js';

// 本物の接続なしで、レシピと手間の見積もりだけを試すための小さな偽ボット
const require = createRequire(import.meta.url);
const registry = mcData('1.21.11');
const { Recipe } = require('prismarine-recipe')(registry);
function fakeSupplier(items = []) {
  const bot = {
    registry,
    inventory: { items: () => items },
    recipesAll: (id, meta, table) => Recipe.find(id, meta).filter((r) => table || !r.requiresTable),
    findBlocks: () => [],
    blockAt: () => null,
    entity: { position: { distanceTo: () => 0 } },
  };
  return new Supplier({ bot, log: { info() {}, warn() {} } });
}

test('色付き羊毛は白い羊毛＋染料で作れる（レシピの黒い羊毛を置き換える）', () => {
  const s = fakeSupplier();
  assert.ok(Number.isFinite(s.estimate('lime_wool')));
  assert.deepEqual(s.recipes('lime_wool')[0].ingredients, [['lime_dye', 1], ['white_wool', 1]]);
  assert.ok(s.recipes('lime_wool')[0].custom);
});

test('採掘・精錬・クラフトの見積もり', () => {
  const s = fakeSupplier();
  assert.deepEqual(s.naturalSources('cobblestone').sort(), ['cobblestone', 'stone']);
  assert.ok(Number.isFinite(s.estimate('glass'))); // 砂を焼く
  assert.ok(Number.isFinite(s.estimate('oak_door'))); // 原木 → 板材 → ドア
  assert.ok(Number.isFinite(s.estimate('yellow_concrete'))); // パウダーを水で固める
  assert.equal(s.estimate('sponge'), Infinity); // サバイバルでは集められない（チェスト頼み）
  assert.equal(s.estimate('diamond_block') < Infinity, true); // ダイヤ鉱石を掘ればいつかは作れる
});

test('手持ちにあれば手間は 0', () => {
  const s = fakeSupplier([{ name: 'oak_planks', count: 10 }]);
  assert.equal(s.estimate('oak_planks'), 0);
});
