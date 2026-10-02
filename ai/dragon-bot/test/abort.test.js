import test from 'node:test';
import assert from 'node:assert/strict';
import { untilAborted } from '../src/util/abort.js';

const never = () => new Promise(() => {});

test('中断されなければ、スキルの結果をそのまま返す', async () => {
  const c = new AbortController();
  assert.equal(await untilAborted(Promise.resolve('完了'), c.signal, { graceMs: 10 }), '完了');
  await assert.rejects(untilAborted(Promise.reject(new Error('失敗')), c.signal, { graceMs: 10 }), /失敗/);
});

test('中断に応じて終わるスキルは、見切らずにその結果を待つ', async () => {
  const c = new AbortController();
  const p = new Promise((_, reject) => c.signal.addEventListener('abort', () => setTimeout(() => reject(new Error('中断された')), 5)));
  let abandoned = false;
  const r = untilAborted(p, c.signal, { graceMs: 200, onAbandon: () => { abandoned = true; } });
  c.abort('フリーズ回避');
  await assert.rejects(r, /中断された/);
  assert.equal(abandoned, false);
});

test('中断に応じないスキルは、猶予のあとで見切って先に進む（ボットが立ったままにならない）', async () => {
  const c = new AbortController();
  let abandoned = false;
  const r = untilAborted(never(), c.signal, { graceMs: 20, onAbandon: () => { abandoned = true; } });
  setTimeout(() => c.abort('時間切れ'), 5);
  await assert.rejects(r, (e) => e.name === 'AbortError' && /時間切れ/.test(e.message));
  assert.equal(abandoned, true);
});

test('すでに中断済みでも見切る。見切った後のエラーは処理されないエラーにならない', async () => {
  const c = new AbortController();
  c.abort('死亡');
  let late;
  const p = new Promise((_, reject) => { late = reject; });
  const unhandled = [];
  const onUnhandled = (e) => unhandled.push(e);
  process.on('unhandledRejection', onUnhandled);
  await assert.rejects(untilAborted(p, c.signal, { graceMs: 5 }), /死亡/);
  late(new Error('あとから失敗'));
  await new Promise((r) => setTimeout(r, 20));
  process.off('unhandledRejection', onUnhandled);
  assert.deepEqual(unhandled, []);
});

test('合図が無ければ promise をそのまま待つ', async () => {
  assert.equal(await untilAborted(Promise.resolve(3), undefined), 3);
});
