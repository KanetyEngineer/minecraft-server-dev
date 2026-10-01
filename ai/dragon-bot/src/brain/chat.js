// 他のプレイヤーに話しかけられたときの返事（通常のプレイヤーらしく短く）
import Anthropic from '@anthropic-ai/sdk';
import { CHAT_SYSTEM } from './prompts.js';
import { log } from '../log.js';

const CANNED = ['こんにちは！', 'いまドラゴン討伐に向けて準備中です', 'よろしく！'];

export class ChatResponder {
  constructor(cfg, client) {
    this.cfg = cfg;
    this.client = client;
    this.lastReplyAt = 0;
  }

  // 返事が要らなければ null
  async reply(bot, username, message, context) {
    if (Date.now() - this.lastReplyAt < 5000) return null;
    const mentioned = message.toLowerCase().includes(bot.username.toLowerCase());
    const fewPlayers = Object.keys(bot.players).length <= 2;
    if (!mentioned && !fewPlayers) return null;
    this.lastReplyAt = Date.now();

    if (!this.client || !this.cfg.llm.chat) {
      return /こんにち|hello|hi\b|やあ/i.test(message) ? CANNED[0] : mentioned ? CANNED[1] : null;
    }
    try {
      const res = await this.client.messages.create({
        model: this.cfg.llm.model,
        max_tokens: 2000,
        output_config: { effort: 'low' },
        system: CHAT_SYSTEM,
        messages: [{ role: 'user', content: `今の状況: ${context}\n${username} の発言: ${message}` }],
      });
      if (res.stop_reason === 'refusal') return null;
      const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
      return text ? text.slice(0, 200) : null;
    } catch (e) {
      log.warn(`チャット返事に失敗: ${e.message}`);
      return null;
    }
  }
}
