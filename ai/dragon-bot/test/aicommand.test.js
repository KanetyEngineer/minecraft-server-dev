import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAiCommand, classify } from '../src/brain/aicommand.js';

test('チャットの先頭の ai / !ai / /ai を指示として取り出す', () => {
  assert.equal(parseAiCommand('ai 状況'), '状況');
  assert.equal(parseAiCommand('!ai 来て'), '来て');
  assert.equal(parseAiCommand('/ai gatherWood'), 'gatherWood');
  assert.equal(parseAiCommand('AI: 止まれ'), '止まれ');
  assert.equal(parseAiCommand('ai'), '');
  assert.equal(parseAiCommand('aiueo'), null);
  assert.equal(parseAiCommand('こんにちは'), null);
});

test('指示の種類を判定する', () => {
  const skills = ['gatherWood', 'huntBlazes'];
  assert.equal(classify('', skills).kind, 'help');
  assert.equal(classify('進捗報告して', skills).kind, 'status');
  assert.equal(classify('来て', skills).kind, 'come');
  assert.equal(classify('止まれ', skills).kind, 'stop');
  assert.equal(classify('再開', skills).kind, 'resume');
  assert.deepEqual(classify('gatherwood', skills), { kind: 'skill', skill: 'gatherWood' });
  assert.equal(classify('ドラゴン倒せそう？', skills).kind, 'talk');
});
