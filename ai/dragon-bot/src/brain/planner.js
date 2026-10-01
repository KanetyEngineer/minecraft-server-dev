// 方針判断: 状況を Claude に渡して次のスキルを 1 つ選ばせる。
// API キーが無い・失敗したときはルールベース（progress.js の nextStep）に切り替える。
import Anthropic from '@anthropic-ai/sdk';
import { PLANNER_SYSTEM } from './prompts.js';
import { toolDefinitions, SKILL_MAP, sanitizeArgs } from '../skills/index.js';
import { nextStep } from './progress.js';
import { log } from '../log.js';

export class Planner {
  constructor(cfg, { client } = {}) {
    this.cfg = cfg;
    const hasKey = !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
    this.client = client ?? (cfg.llm.enabled && hasKey ? new Anthropic() : null);
    this.tools = toolDefinitions();
    this.failStreak = 0;
  }

  get usingLLM() {
    return !!this.client && this.failStreak < 5;
  }

  async decide({ bot, memory, snapshot, history, chatLog, banned = [] }) {
    const hint = nextStep(bot, memory);
    if (!this.usingLLM) return { ...hint, hint, source: 'rules', thought: '（ルールベース）進捗表の次の項目' };
    try {
      const d = await this.askClaude({ snapshot, history, chatLog, hint, banned });
      d.hint = hint;
      this.failStreak = 0;
      return d;
    } catch (e) {
      this.failStreak++;
      log.warn(`LLM 判断に失敗（${this.failStreak} 回目）: ${e.message}。ルールベースで続行`);
      return { ...hint, source: 'rules', thought: 'LLM が使えないのでルールベース' };
    }
  }

  buildRequest({ snapshot, history, chatLog, hint, banned }) {
    const text = [
      '## 今の状況',
      '```json',
      JSON.stringify(snapshot),
      '```',
      '## 最近やったこと（古い順）',
      history.length ? history.map((h) => `- ${h.skill}(${JSON.stringify(h.args)}) → ${h.ok ? '成功' : '失敗'}: ${h.result}`).join('\n') : '- まだ何もしていない',
      '## 最近のチャット',
      chatLog.length ? chatLog.map((c) => `- ${c.username}: ${c.message}`).join('\n') : '- なし',
      '## 進捗表からのおすすめの次の一手（参考）',
      `${hint.skill}(${JSON.stringify(hint.args)})`,
      banned?.length ? `## 今は使えないスキル（ループ検知で一時禁止）\n${banned.join(', ')}` : '',
      '',
      '先に「なぜそうするか」を 1〜2 文で書いてから、次に使うスキルを 1 つ呼んでください。',
    ].join('\n');

    const req = {
      model: this.cfg.llm.model,
      max_tokens: 16000,
      // 指示文と道具の定義は毎回同じなのでキャッシュする
      system: [{ type: 'text', text: PLANNER_SYSTEM, cache_control: { type: 'ephemeral' } }],
      tools: this.tools,
      tool_choice: { type: 'auto', disable_parallel_tool_use: true },
      output_config: { effort: this.cfg.llm.effort },
      // 判断の思考過程も受け取り、ログに出す（人が読める要約が返る）
      thinking: { type: 'adaptive' },
      messages: [{ role: 'user', content: text }],
    };
    if (this.cfg.llm.fallbacks) {
      req.betas = ['server-side-fallback-2026-07-01'];
      req.fallbacks = 'default';
    }
    return req;
  }

  async askClaude(input) {
    const req = this.buildRequest(input);
    const res = req.betas
      ? await this.client.beta.messages.create(req)
      : await this.client.messages.create(req);
    return this.parseResponse(res);
  }

  parseResponse(res) {
    if (res.stop_reason === 'refusal') throw new Error('リクエストが拒否された');
    const thought = res.content.filter((b) => b.type === 'text').map((b) => b.text).join(' ').trim();
    const thinking = res.content.filter((b) => b.type === 'thinking').map((b) => b.thinking).join('\n').trim();
    const call = res.content.find((b) => b.type === 'tool_use');
    if (!call) throw new Error(`スキルが選ばれなかった: ${thought.slice(0, 80)}`);
    const skill = SKILL_MAP[call.name];
    if (!skill) throw new Error(`未知のスキル ${call.name}`);
    const args = sanitizeArgs(skill, call.input);
    return { skill: call.name, args, thought, thinking, source: 'llm' };
  }
}
