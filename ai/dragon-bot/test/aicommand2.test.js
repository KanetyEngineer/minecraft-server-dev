import test from 'node:test';
import assert from 'node:assert/strict';
import { statusLine, planLine } from '../src/brain/aicommand.js';
import { fakeBot, fakeMemory } from './fakebot.js';

test('状況と次の行動を 1 行で返せる', () => {
  const bot = fakeBot({ iron_pickaxe: 1, cooked_beef: 10 });
  const s = statusLine(bot, fakeMemory(), 'getIronGear');
  assert.match(s, /今: getIronGear/);
  assert.match(s, /鉄ツルハシ/);
  assert.match(planLine(bot, fakeMemory()), /^次にやること: /);
});
