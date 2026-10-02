import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { trackOwnAir } from '../src/body/plugins.js';

test('酸素は自分のエンティティの値だけを使い、ほかのエンティティの値で書き換わらない', () => {
  const bot = new EventEmitter();
  bot._client = new EventEmitter();
  bot.entity = { id: 7 };
  trackOwnAir(bot);
  assert.equal(bot.oxygenLevel, 20);
  bot._client.emit('entity_metadata', { entityId: 99, metadata: [{ key: 1, value: 0 }] }); // 陸の魚など
  bot.oxygenLevel = 0; // mineflayer の書き込み
  assert.equal(bot.oxygenLevel, 20);
  bot._client.emit('entity_metadata', { entityId: 7, metadata: [{ key: 1, value: 105 }] });
  assert.equal(bot.oxygenLevel, 7);
  bot.emit('respawn');
  assert.equal(bot.oxygenLevel, 20);
});
