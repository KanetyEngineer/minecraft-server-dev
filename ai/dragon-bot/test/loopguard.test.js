import test from 'node:test';
import assert from 'node:assert/strict';
import { LoopGuard } from '../src/brain/loopguard.js';

test('同じスキルが進展なしに 3 回続いたら禁止して差し替える', () => {
  let now = 0;
  const g = new LoopGuard({ now: () => now });
  const rec = () => g.record({ skill: 'mineBlock', args: { block: 'iron_ore' }, ok: false, result: '見つからない', progressed: false });
  assert.equal(rec(), null);
  assert.equal(rec(), null);
  const loop = rec();
  assert.equal(loop.skill, 'mineBlock');
  assert.equal(loop.banMs, 3 * 60_000);
  assert.ok(g.isBanned('mineBlock'));
  const d = g.substitute({ skill: 'mineBlock', args: {} }, [{ skill: 'gatherWood', args: { logs: 4 } }]);
  assert.equal(d.skill, 'gatherWood');
  assert.equal(d.source, 'loopguard');
  // 候補も禁止なら探索へ
  assert.equal(g.substitute({ skill: 'mineBlock', args: {} }, [{ skill: 'mineBlock', args: {} }]).skill, 'explore');
  // 時間が過ぎたら解除、再発時は禁止時間が 2 倍
  now = 4 * 60_000;
  assert.equal(g.isBanned('mineBlock'), false);
  rec(); rec();
  assert.equal(rec().banMs, 6 * 60_000);
});

test('進展（持ち物や位置の変化）があればループとみなさない', () => {
  const g = new LoopGuard();
  for (let i = 0; i < 6; i++) {
    assert.equal(g.record({ skill: 'gatherWood', args: {}, ok: true, result: '完了', progressed: true }), null);
  }
  assert.equal(g.bannedSkills().length, 0);
});

test('2 つのスキルの往復も進展がなければループ扱い', () => {
  const g = new LoopGuard();
  let loop = null;
  for (let i = 0; i < 6; i++) {
    loop = g.record({ skill: i % 2 ? 'craftTo' : 'makeTools', args: {}, ok: false, result: `x${i}`, progressed: false });
  }
  assert.ok(loop);
});
