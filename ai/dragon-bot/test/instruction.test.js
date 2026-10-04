import test from 'node:test';
import assert from 'node:assert/strict';
import { INSTRUCTION_RE } from '../src/agent.js';

test('チャットの指示の書き方: ai / @DragonBot / !ai / /ai', () => {
  for (const [msg, want] of [
    ['ai 村へ行って', '村へ行って'], ['AI: 木を集めて', '木を集めて'], ['@DragonBot こっちに来て', 'こっちに来て'],
    ['!ai 止まって', '止まって'], ['/ai 鉄を掘って', '鉄を掘って'], ['dragonbot、寝て', '寝て'],
  ]) {
    assert.equal(msg.match(INSTRUCTION_RE)?.[1].trim(), want, msg);
  }
  assert.equal('こんにちは'.match(INSTRUCTION_RE), null);
  assert.equal('aiってすごい'.match(INSTRUCTION_RE), null);
});
