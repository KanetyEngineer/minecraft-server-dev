import test from 'node:test';
import assert from 'node:assert/strict';
import { Planner } from '../src/brain/planner.js';
import { SKILL_MAP, sanitizeArgs, toolDefinitions } from '../src/skills/index.js';
import { loadConfig } from '../src/config.js';
import { fakeBot, fakeMemory } from './fakebot.js';

const cfg = loadConfig();

function mockClient(response, seen) {
  const create = async (req) => { seen.push(req); return response; };
  return { messages: { create }, beta: { messages: { create } } };
}

const input = () => ({ bot: fakeBot(), memory: fakeMemory(), snapshot: { health: 20 }, history: [], chatLog: [] });

test('Claude が選んだスキルと引数を受け取る', async () => {
  const seen = [];
  const p = new Planner(cfg, { client: mockClient({
    stop_reason: 'tool_use',
    content: [{ type: 'text', text: 'まず木を集める' }, { type: 'tool_use', id: 't1', name: 'gatherWood', input: { logs: 999 } }],
  }, seen) });
  const d = await p.decide(input());
  assert.equal(d.source, 'llm');
  assert.equal(d.skill, 'gatherWood');
  assert.equal(d.args.logs, 64); // 上限に丸める
  const req = seen[0];
  assert.equal(req.model, 'claude-opus-5-5');
  assert.equal(req.tool_choice.type, 'auto');
  assert.equal(req.tool_choice.disable_parallel_tool_use, true);
  assert.equal(req.system[0].cache_control.type, 'ephemeral');
  assert.equal(req.fallbacks, 'default');
  assert.deepEqual(req.betas, ['server-side-fallback-2026-07-01']);
  assert.match(req.messages[0].content, /おすすめの次の一手/);
});

test('拒否・スキル無しのときはルールベースに切り替える', async () => {
  for (const res of [
    { stop_reason: 'refusal', content: [] },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'うーん' }] },
    { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'x', name: 'flyToMoon', input: {} }] },
  ]) {
    const p = new Planner(cfg, { client: mockClient(res, []) });
    const d = await p.decide(input());
    assert.equal(d.source, 'rules');
    assert.equal(d.skill, 'gatherWood');
  }
});

test('API キーが無ければ最初からルールベース', async () => {
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  const p = new Planner(cfg);
  assert.equal(p.usingLLM, false);
  if (saved) process.env.ANTHROPIC_API_KEY = saved;
});

test('ツール定義は API の形になっている', () => {
  for (const t of toolDefinitions()) {
    assert.match(t.name, /^[a-zA-Z0-9_-]{1,64}$/);
    assert.equal(t.input_schema.type, 'object');
    assert.ok(t.description.length > 5);
  }
});

test('必須引数が無ければエラー、enum 外は捨てる', () => {
  assert.throws(() => sanitizeArgs(SKILL_MAP.mineBlock, {}));
  assert.deepEqual(sanitizeArgs(SKILL_MAP.makeTools, { tier: 'netherite' }), {});
  assert.deepEqual(sanitizeArgs(SKILL_MAP.craft, { item: 'bow', count: '3', extra: 1 }), { item: 'bow', count: 3 });
});

test('プレイヤーからの指示は最優先として指示文に入る', async () => {
  const seen = [];
  const p = new Planner(cfg, { client: mockClient({
    stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 't1', name: 'gatherWood', input: { logs: 8 } }],
  }, seen) });
  await p.decide({ ...input(), instructions: [{ username: 'kanetyyy', text: '木を集めて', at: Date.now() }] });
  assert.match(seen[0].messages[0].content, /プレイヤーからの指示/);
  assert.match(seen[0].messages[0].content, /kanetyyy.*木を集めて/);
});
