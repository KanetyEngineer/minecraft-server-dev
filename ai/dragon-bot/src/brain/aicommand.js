// ゲーム内チャットからの指示（「ai メッセージ」「!ai メッセージ」、またはボットへのささやき /msg DragonBot メッセージ）。
// バニラのサーバーでは「/ai」は未知のコマンドとして弾かれ、ボットにもサーバーのログにも届かないので、
// チャットの先頭の「ai」「!ai」「@ai」と、ささやきで受け付ける（Discord 連携などから「/ai」の文字が届いた場合も受け付ける）。
import { milestones, nextStep, dimensionOf } from './progress.js';

const PREFIX = /^\s*(?:\/ai|!ai|@ai|ai)(?:\s+|[:：]\s*|$)(.*)$/i;

// 指示ならその本文（空文字もあり）、指示でなければ null
export function parseAiCommand(message) {
  const m = PREFIX.exec(String(message ?? ''));
  return m ? m[1].trim() : null;
}

export const HELP = 'ai 状況 / ai 来て / ai 止まれ / ai 再開 / ai やること / ai <スキル名>（例: ai gatherWood）';

// 指示の種類を判定する。{ kind, ... } を返す
export function classify(text, skillNames = []) {
  const t = text.trim();
  if (!t || /^(help|ヘルプ|使い方|\?|？)$/i.test(t)) return { kind: 'help' };
  if (/状況|進捗|status|どう|何して|なにして|報告/i.test(t)) return { kind: 'status' };
  if (/^(来て|こい|来い|おいで|come|here)/i.test(t)) return { kind: 'come' };
  if (/^(止まれ|とまれ|止まって|停止|待て|待って|stop|wait)/i.test(t)) return { kind: 'stop' };
  if (/^(再開|続けて|続行|動いて|resume|go)/i.test(t)) return { kind: 'resume' };
  if (/やること|次|予定|plan|next/i.test(t)) return { kind: 'plan' };
  const first = t.split(/\s+/)[0];
  const skill = skillNames.find((n) => n.toLowerCase() === first.toLowerCase());
  if (skill) return { kind: 'skill', skill };
  return { kind: 'talk', text: t };
}

// 状況の一言まとめ（チャット 1 行に収まる長さ）
export function statusLine(bot, memory, current) {
  const m = milestones(bot, memory);
  const c = m._counts;
  const done = [
    m.ironPickaxe && '鉄ツルハシ', m.armor && '防具', m.netherPortal && 'ゲート',
    m.blazeRods && `ロッド${c.rods}`, c.pearls && `パール${c.pearls}`, c.eyes && `アイ${c.eyes}`,
  ].filter(Boolean).join('・') || 'まだ序盤';
  const hp = Math.round(bot.health ?? 0); const food = Math.round(bot.food ?? 0);
  const p = bot.entity?.position;
  const where = p ? `${dimensionOf(bot)} (${Math.round(p.x)}, ${Math.round(p.y)}, ${Math.round(p.z)})` : dimensionOf(bot);
  return `今: ${current ?? '考え中'} / 体力${hp} 満腹${food} / ${where} / そろった物: ${done}`;
}

export function planLine(bot, memory) {
  const s = nextStep(bot, memory);
  return `次にやること: ${s.skill}${Object.keys(s.args ?? {}).length ? ` ${JSON.stringify(s.args)}` : ''}`;
}
