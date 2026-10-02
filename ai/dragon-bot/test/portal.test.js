import test from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import { fixFailedCast, waitForBlock } from '../src/skills/portal.js';

// バケツの使用を模したにせボット: activateItem のたびに手に持った物に応じて世界を書き換える
function castBot(world, { waterHitsFromTry = 1 } = {}) {
  const items = { water_bucket: 1, bucket: 1 };
  let held = null;
  let waterTries = 0;
  const key = (p) => `${p.x},${p.y},${p.z}`;
  const bot = {
    inventory: { items: () => Object.entries(items).filter(([, c]) => c > 0).map(([name, count]) => ({ name, count })) },
    entity: { position: new Vec3(1.5, 64, 2.5) },
    registry: { blocksByName: { water: { id: 1 }, lava: { id: 2 } } },
    findBlocks: ({ matching }) => Object.entries(world)
      .filter(([, n]) => matching.includes({ water: 1, lava: 2 }[n]))
      .map(([k]) => new Vec3(...k.split(',').map(Number))),
    blockAt: (p) => ({ name: world[key(p.floored())] ?? 'air', position: p.floored(), metadata: 0 }),
    equip: async (item) => { held = item.name; },
    lookAt: async (p) => { bot.looking = p.floored(); },
    waitForTicks: async () => {},
    activateItem: () => {
      if (held === 'water_bucket') {
        waterTries++;
        if (waterTries >= waterHitsFromTry) { world['0,65,0'] = 'water'; if (world['0,64,0'] === 'lava') world['0,64,0'] = 'obsidian'; }
        else world['5,64,5'] = 'water'; // 狙いがずれてよそに置いた
        items.water_bucket = 0; items.bucket += 1;
      } else if (held === 'bucket') {
        // 見ている位置の水源・溶岩源をくむ
        const k = key(bot.looking); const n = world[k];
        if (n === 'water' || n === 'lava') { delete world[k]; items.bucket -= 1; items[`${n}_bucket`] = (items[`${n}_bucket`] ?? 0) + 1; }
      }
    },
  };
  return { bot, items, world };
}
const ctx = (bot) => ({ bot, log: { warn: () => {}, info: () => {} } });
const T = new Vec3(0, 64, 0);

test('fixFailedCast: 2 回目の水で黒曜石になり、水は回収される', async () => {
  const { bot, items, world } = castBot({ '0,64,0': 'lava' }, { waterHitsFromTry: 2 });
  items.water_bucket = 0; items.bucket = 2; world['5,64,5'] = 'water'; // 1 回目はよそに置いた直後の状態
  assert.equal(await fixFailedCast(ctx(bot), T, { settleMs: 0 }), true);
  assert.equal(world['0,64,0'], 'obsidian');
  assert.equal(world['0,65,0'], undefined);
  assert.equal(items.water_bucket, 1);
});

test('fixFailedCast: 水が置けないままなら溶岩をくみ戻す', async () => {
  const { bot, items, world } = castBot({ '0,64,0': 'lava' }, { waterHitsFromTry: 99 });
  assert.equal(await fixFailedCast(ctx(bot), T, { settleMs: 0 }), true);
  assert.equal(world['0,64,0'], undefined);
  assert.equal(items.lava_bucket, 1);
  assert.equal(world['5,64,5'], undefined, 'よそに置いた水もくみ戻す');
  assert.equal(items.water_bucket, 1);
});

test('waitForBlock: 更新が遅れて届いても待つ', async () => {
  let ticks = 0;
  const bot = { blockAt: () => ({ name: ticks >= 3 ? 'lava' : 'air' }), waitForTicks: async () => { ticks++; } };
  assert.equal(await waitForBlock(bot, T, 'lava'), true);
  assert.equal(await waitForBlock({ blockAt: () => ({ name: 'air' }), waitForTicks: async () => {} }, T, 'lava'), false);
});
