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

test('Haiku 4.5 では effort・thinking・fallbacks を送らない（送ると 400 になる）', async () => {
  const seen = [];
  const lite = { ...cfg, llm: { ...cfg.llm, model: 'claude-haiku-4-5', effort: 'low', fallbacks: true } };
  const p = new Planner(lite, { client: mockClient({
    stop_reason: 'tool_use',
    content: [{ type: 'text', text: '木を集める' }, { type: 'tool_use', id: 't1', name: 'gatherWood', input: { logs: 8 } }],
  }, seen) });
  const d = await p.decide(input());
  assert.equal(d.skill, 'gatherWood');
  const req = seen[0];
  assert.equal(req.model, 'claude-haiku-4-5');
  assert.equal(req.thinking, undefined);
  assert.equal(req.output_config, undefined);
  assert.equal(req.fallbacks, undefined);
  assert.equal(req.betas, undefined);
  assert.equal(req.tool_choice.disable_parallel_tool_use, true);
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

const llmPick = (name = 'gatherWood') => ({ stop_reason: 'tool_use', content: [{ type: 'text', text: '相談の答え' }, { type: 'tool_use', id: 't', name, input: {} }] });
const assistCfg = () => ({ ...cfg, llm: { ...cfg.llm, mode: 'assist', checkEveryMs: 5 * 60_000 } });

test('assist: 順調なときは Claude に聞かず進捗表どおり、定期の見直しの時刻になったら聞く', async () => {
  const seen = [];
  const p = new Planner(assistCfg(), { client: mockClient(llmPick(), seen) });
  const first = await p.decide(input());
  assert.equal(first.source, 'llm', '最初の 1 回は見直しとして聞く');
  assert.match(first.thought, /定期の見直し/);
  const ok = [{ skill: 'gatherWood', args: {}, ok: true, result: '完了' }];
  const d = await p.decide({ ...input(), history: ok });
  assert.equal(d.source, 'rules');
  assert.equal(seen.length, 1, '順調な間は聞かない');
  p.lastAskedAt = Date.now() - 6 * 60_000;
  assert.equal((await p.decide({ ...input(), history: ok })).source, 'llm');
  assert.equal(seen.length, 2);
});

test('assist: 失敗が続く・歩き回るだけ・指示がある・ループ検知のときは Claude に聞く', async () => {
  const p = new Planner(assistCfg(), { client: mockClient(llmPick(), []) });
  const fail = (skill) => ({ skill, args: {}, ok: false, result: '失敗' });
  const okStep = (skill) => ({ skill, args: {}, ok: true, result: '完了' });
  const cases = [
    [{ history: [fail('craftTools'), fail('gatherFood')] }, /2 回続けて失敗/],
    [{ history: [fail('gatherWood'), okStep('explore'), fail('gatherWood'), okStep('explore')] }, /gatherWood が最近 2 回失敗/],
    [{ history: ['explore', 'explore', 'explore', 'explore'].map(okStep) }, /歩き回って/],
    [{ instructions: [{ username: 'kanetyyy', text: '村へ行って', at: Date.now() }] }, /指示/],
    [{ banned: ['gatherWood'] }, /ループ検知/],
  ];
  for (const [extra, re] of cases) {
    p.lastAskedAt = Date.now();
    const d = await p.decide({ ...input(), ...extra });
    assert.equal(d.source, 'llm', String(re));
    assert.match(d.thought, re);
  }
});

test('5 回続けて失敗したらルールベースにして、10 分たったら試し直す', async () => {
  let fail = true;
  const create = async () => { if (fail) throw new Error('credit balance is too low'); return llmPick(); };
  const p = new Planner(cfg, { client: { messages: { create }, beta: { messages: { create } } } });
  for (let i = 0; i < 5; i++) assert.equal((await p.decide(input())).source, 'rules');
  assert.equal(p.usingLLM, false, '止めている間は聞かない');
  fail = false;
  assert.equal((await p.decide(input())).source, 'rules');
  p.retryAt = Date.now() - 1;
  assert.equal(p.usingLLM, true);
  assert.equal((await p.decide(input())).source, 'llm');
  assert.equal(p.failStreak, 0);
});
