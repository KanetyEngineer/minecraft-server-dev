import test from 'node:test';
import assert from 'node:assert/strict';
import { makeCheapestTool } from '../src/body/plugins.js';

// 石: 手では掘れない（遅い）。木のツルハシ・石のツルハシ・鉄のツルハシの順に速い
function fakeBot(names) {
  const listeners = {};
  let items = names.map((name, i) => ({ name, type: i + 1 }));
  return {
    inventory: { items: () => items, on: (e, f) => { (listeners[e] ??= []).push(f); } },
    on: (e, f) => { (listeners[e] ??= []).push(f); },
    setItems(n) { items = n.map((name, i) => ({ name, type: i + 1 })); (listeners.updateSlot ?? []).forEach((f) => f()); },
    get items() { return items; },
  };
}
function stone(bot, counter) {
  const speed = { wooden_pickaxe: 1000, stone_pickaxe: 600, iron_pickaxe: 300 };
  return {
    type: 1,
    digTime(type) { counter.n++; const it = bot.items.find((i) => i.type === type); return it ? speed[it.name] ?? 7500 : 7500; },
    canHarvest(type) { return !!bot.items.find((i) => i.type === type && i.name.endsWith('_pickaxe')); },
  };
}

test('掘れるうちで一番安い道具を選び、同じ種類のブロックは覚えておく', () => {
  const bot = fakeBot(['iron_pickaxe', 'stone_pickaxe']);
  const counter = { n: 0 };
  const pick = makeCheapestTool(bot, () => 'fastest');
  const block = stone(bot, counter);
  assert.equal(pick(block).name, 'stone_pickaxe', '鉄ではなく石のツルハシ');
  const n = counter.n;
  assert.equal(pick(block).name, 'stone_pickaxe');
  assert.equal(counter.n, n, '2 回目は調べ直さない');
});

test('持ち物が変わったら忘れて選び直す。読み込まれていないブロックは null', () => {
  const bot = fakeBot(['iron_pickaxe']);
  const counter = { n: 0 };
  const pick = makeCheapestTool(bot, () => null);
  const block = stone(bot, counter);
  assert.equal(pick(block).name, 'iron_pickaxe');
  bot.setItems(['iron_pickaxe', 'wooden_pickaxe']);
  assert.equal(pick(block).name, 'wooden_pickaxe');
  assert.equal(pick(null), null);
  assert.equal(pick({}), null);
});
