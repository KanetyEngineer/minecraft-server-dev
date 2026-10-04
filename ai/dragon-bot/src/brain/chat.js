// 他のプレイヤーとのチャット。普通のプレイヤーのように、短く自然に返す。
// - Claude が使えるとき（ANTHROPIC_API_KEY あり）: 直近の会話の流れと今の状況を渡して、自由に会話する。
//   方針判断はルールベースのまま、チャットだけ Claude にすることもできる（LLM_ENABLED=false、LLM_CHAT=true）。
// - 使えないとき: よくある話しかけ（あいさつ・調子・何してる・お礼・誘い など）に、言い回しを変えながら返す。
// どちらも、打っているように少し間を置いてから送る（呼び出し側で typingDelay を使う）。
import Anthropic from '@anthropic-ai/sdk';
import { CHAT_SYSTEM } from './prompts.js';
import { log } from '../log.js';
import { isLiteModel } from '../config.js';

// 今の作業を、会話で言うときの言い方に
const DOING = {
  gatherWood: '木を切ってる', makeTools: '道具作ってる', gatherFood: 'ご飯集めてる', getIronGear: '鉄掘ってる',
  mineDiamonds: 'ダイヤ探してる', makeBowAndArrows: '弓矢の材料集めてる', fillWaterBucket: '水くんでる',
  collectObsidian: '黒曜石掘ってる', castNetherPortal: 'ネザーゲート作ってる', buildNetherPortal: 'ネザーゲート作ってる',
  useRuinedPortal: '廃ポータル直してる', lootVillage: '村で物資集めてる', makeBed: 'ベッド作ってる', shelterForNight: '夜をしのいでる',
  enterNether: 'ネザー行くとこ', huntBlazes: 'ブレイズ狩ってる', huntEndermen: 'エンダーマン狩ってる',
  barterWithPiglins: 'ピグリンと取引してる', raidBastionGold: '砦で金集めてる', locateStronghold: '要塞探してる',
  findEndPortal: 'エンドポータル探してる', activateEndPortal: 'エンドに入るとこ', destroyEndCrystals: 'クリスタル壊してる',
  fightDragon: 'ドラゴンと戦ってる', recoverItems: '死んだとこに荷物取りに戻ってる', explore: 'うろうろ探索中',
};
export const doingPhrase = (skill) => DOING[skill] ?? (skill ? '作業中' : 'ちょっと考え中');

const pick = (a) => a[Math.floor(Math.random() * a.length)];

// Claude を使わないときの返事。返事が要らなければ null
export function cannedReply(message, { current, username, mentioned } = {}) {
  const m = String(message).toLowerCase();
  const doing = doingPhrase(current);
  if (/おはよ|こんにち|こんばん|やあ|hello|\bhi\b|hey|よろしく|はじめまして/.test(m)) {
    return pick([`${username}さんこんにちは！`, 'やっほー', 'よろしくー！', `どうもー、いま${doing}`]);
  }
  if (/おやすみ|落ちる|またね|ばいばい|bye|おつ/.test(m)) return pick(['おつかれー！', 'またねー', 'おやすみ～']);
  if (/ありがと|thx|thanks|thank/.test(m)) return pick(['いえいえ！', 'どういたしまして～', 'こちらこそ！']);
  if (/元気|調子|大丈夫|how are you|どうした/.test(m)) return pick([`元気！いま${doing}`, `ぼちぼち。${doing}とこ`, '大丈夫、ありがと！']);
  if (/何して|なにして|何やって|what.*doing|今なに/.test(m)) return pick([`いま${doing}`, `${doing}よ`, `${doing}。ドラゴン倒すのが目標`]);
  if (/寝|sleep|ベッド/.test(m)) return pick(['夜になったら寝るよ', 'ベッドあるから夜は寝る！', '眠くはないけど夜は寝とく']);
  if (/ドラゴン|エンドラ|dragon/.test(m)) return pick(['エンドラ倒すまでがんばる', 'ドラゴン戦はベッド爆破でいく予定', 'まだ準備中、もうちょい']);
  if (/すご|うま|上手|ナイス|nice|gg|やるじゃん/.test(m)) return pick(['えへへ', 'ありがと！', 'でしょ？']);
  if (/ai|ボット|bot|人間/.test(m)) return pick(['AIで動いてるボットだよ', '中身はAIです'] );
  if (/手伝|help|一緒/.test(m)) return pick(['助かる！鉄とか見つけたら教えて', 'いいね、一緒にやろ', 'ありがと！']);
  if (/[?？]$/.test(m)) return pick(['うーん、どうだろ', 'わかんないｗ', 'たぶん？']);
  if (/[wｗ笑草]$/.test(m)) return pick(['ｗ', 'それな', 'ｗｗ']);
  return mentioned ? pick(['ん？', 'なにー？', `いま${doing}`]) : null;
}

// 打っているような間（文字数に応じて 0.8〜4 秒）
export const typingDelay = (text) => Math.min(4000, 800 + String(text).length * 60);

export class ChatResponder {
  constructor(cfg, client) {
    this.cfg = cfg;
    const hasKey = !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
    // 方針判断が LLM でなくても、チャットだけ Claude にできる
    this.client = client ?? (cfg.llm.chat && hasKey ? new Anthropic() : null);
    this.lastReplyAt = 0;
    this.history = []; // 会話の流れ { role, content }
  }

  get usingLLM() {
    return !!this.client && this.cfg.llm.chat;
  }

  // 返事が要らなければ null。force はチャットの「ai 〜」など、必ず返したいとき
  async reply(bot, username, message, context, { force = false, current } = {}) {
    if (!force && Date.now() - this.lastReplyAt < 2500) return null;
    const mentioned = message.toLowerCase().includes(bot.username.toLowerCase());
    const fewPlayers = Object.keys(bot.players).length <= 2;
    // 人が多いときは、名前を呼ばれたときだけ返す（2 人だけなら普通に会話する）
    if (!force && !mentioned && !fewPlayers) return null;
    this.remember('user', `${username}: ${message}`);

    let text = null;
    if (!this.usingLLM) {
      text = cannedReply(message, { current, username, mentioned: mentioned || force });
    } else {
      try {
        const res = await this.client.messages.create({
          model: this.cfg.llm.model,
          max_tokens: 1000,
          ...(isLiteModel(this.cfg.llm.model) ? {} : { output_config: { effort: 'low' } }),
          system: `${CHAT_SYSTEM}\n今の状況: ${context}`,
          messages: this.conversation(),
        });
        if (res.stop_reason !== 'refusal') text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim() || null;
      } catch (e) {
        log.warn(`チャット返事に失敗: ${e.message}`);
        text = cannedReply(message, { current, username, mentioned: true });
      }
    }
    if (!text) return null;
    text = text.replace(/^["「]|["」]$/g, '').slice(0, 120);
    this.remember('assistant', text);
    this.lastReplyAt = Date.now();
    return text;
  }

  remember(role, content) {
    this.history.push({ role, content, at: Date.now() });
    // 10 分以内・直近 12 発言だけを覚えておく
    this.history = this.history.filter((h) => Date.now() - h.at < 10 * 60_000).slice(-12);
  }

  // Claude に渡す会話（user から始まり、user と assistant が交互になるようにまとめる）
  conversation() {
    const out = [];
    for (const h of this.history) {
      if (out.length && out.at(-1).role === h.role) out.at(-1).content += `\n${h.content}`;
      else out.push({ role: h.role, content: h.content });
    }
    while (out.length && out[0].role !== 'user') out.shift();
    return out;
  }
}
