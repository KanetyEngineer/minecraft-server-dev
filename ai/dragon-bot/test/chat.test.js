import test from 'node:test';
import assert from 'node:assert/strict';
import { cannedReply, ChatResponder } from '../src/brain/chat.js';

test('Claude なしでも、よくある話しかけに人らしく返す', () => {
  assert.ok(cannedReply('こんにちは', { username: 'kanetyyy' }));
  assert.ok(cannedReply('何してるの？', { current: 'getIronGear' }));
  assert.ok(cannedReply('hey,DragonBot Do you wanna sleep?', {}));
  assert.equal(cannedReply('今日の夕飯なににしよ', {}), null); // 関係ない独り言には返さない
  assert.ok(cannedReply('今日の夕飯なににしよ', { mentioned: true })); // 名前を呼ばれたら返す
});

test('会話の流れは user から始まり、user と assistant が交互になる', () => {
  const c = new ChatResponder({ llm: { chat: false } }, null);
  c.remember('assistant', 'やっほー');
  c.remember('user', 'a: こんにちは');
  c.remember('user', 'a: 元気？');
  c.remember('assistant', '元気！');
  c.remember('user', 'a: よかった');
  const conv = c.conversation();
  assert.equal(conv[0].role, 'user');
  assert.deepEqual(conv.map((m) => m.role), ['user', 'assistant', 'user']);
});
