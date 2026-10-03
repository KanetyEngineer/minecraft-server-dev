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
    // 判断を待つ間、ボットは何もせず立っている。遅い・混んでいるときは早めにあきらめてルールベースで動く
    //（既定の 10 分待ち・2 回再試行だと、混雑時に 1 回の判断で何分も止まっていた）
    this.client = client ?? (cfg.llm.enabled && hasKey ? new Anthropic({ timeout: cfg.llm.timeoutMs ?? 45_000, maxRetries: 1 }) : null);
    this.tools = toolDefinitions();
    this.failStreak = 0;
  }

  // 5 回続けて失敗したら（クレジット切れ・混雑など）ルールベースに切り替え、10 分ごとに 1 回だけ試し直す
  //（前は再起動するまで二度と使わず、クレジットを足しても戻らなかった）
  get usingLLM() {
    if (!this.client) return false;
    if (this.failStreak < 5) return true;
    return Date.now() >= (this.retryAt ?? 0);
  }

  // 「順調なときは進捗表どおり、困ったときだけ Claude に聞く」かどうかを決める（llm.mode = 'assist'）。
  // 毎回聞くと、1 回ごとに数秒〜数十秒立ち止まり、料金もかかる。進捗表で足りる場面は聞かずにすぐ動く
  needsLLM({ history = [], banned = [], instructions = [], hint }) {
    if (this.cfg.llm.mode !== 'assist') return 'always';
    if (instructions.length) return 'プレイヤーの指示がある';
    if (banned.length) return 'ループ検知で禁止中のスキルがある';
    const recent = history.slice(-6).filter((h) => !/ループ検知/.test(h.skill));
    const last2 = recent.slice(-2);
    if (last2.length === 2 && last2.every((h) => !h.ok)) return '2 回続けて失敗した';
    if (hint && recent.filter((h) => h.skill === hint.skill && !h.ok).length >= 2) return `${hint.skill} が最近 2 回失敗している`;
    const last4 = recent.slice(-4);
    if (last4.length === 4 && last4.every((h) => h.skill === 'explore')) return '目的なく歩き回っている';
    if (Date.now() - (this.lastAskedAt ?? 0) >= (this.cfg.llm.checkEveryMs ?? 5 * 60_000)) return '定期の見直し';
    return null;
  }

  async decide({ bot, memory, snapshot, history, chatLog, banned = [], instructions = [] }) {
    const hint = nextStep(bot, memory);
    if (!this.usingLLM) return { ...hint, hint, source: 'rules', thought: '（ルールベース）進捗表の次の項目' };
    const why = this.needsLLM({ history, banned, instructions, hint });
    if (!why) return { ...hint, hint, source: 'rules', thought: '（ルールベース）順調なので進捗表どおり' };
    this.lastAskedAt = Date.now();
    try {
      const started = Date.now();
      const d = await this.askClaude({ snapshot, history, chatLog, hint, banned, instructions });
      const sec = Math.round((Date.now() - started) / 1000);
      if (sec >= 15) log.warn(`LLM の判断に ${sec} 秒かかった（その間は立ち止まっている）`);
      d.hint = hint;
      if (why !== 'always') d.thought = `（${why}ので Claude に相談）${d.thought ?? ''}`;
      if (this.failStreak >= 5) log.info('LLM がまた使えるようになった');
      this.failStreak = 0;
      return d;
    } catch (e) {
      this.failStreak++;
      if (this.failStreak >= 5) this.retryAt = Date.now() + 10 * 60_000;
      log.warn(`LLM 判断に失敗（${this.failStreak} 回目）: ${e.message}。ルールベースで続行${this.failStreak >= 5 ? '（10 分後に試し直す）' : ''}`);
      return { ...hint, source: 'rules', thought: 'LLM が使えないのでルールベース' };
    }
  }

  buildRequest({ snapshot, history, chatLog, hint, banned, instructions = [] }) {
    const text = [
      '## 今の状況',
      '```json',
      JSON.stringify(snapshot),
      '```',
      '## 最近やったこと（古い順）',
      history.length ? history.map((h) => `- ${h.skill}(${JSON.stringify(h.args)}) → ${h.ok ? '成功' : '失敗'}: ${h.result}`).join('\n') : '- まだ何もしていない',
      '## 最近のチャット',
      chatLog.length ? chatLog.map((c) => `- ${c.username}: ${c.message}`).join('\n') : '- なし',
      instructions.length ? `## プレイヤーからの指示（最優先。指示に合うスキルを選び、やり終えたら通常の流れに戻る）\n${instructions.map((i) => `- ${i.username}（${Math.round((Date.now() - i.at) / 60_000)} 分前）: ${i.text}`).join('\n')}` : '',
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
