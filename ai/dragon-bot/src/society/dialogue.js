// 住人の決まった言い回し（Claude を使わないときの会話）。性格（口調・一人称・語尾）で言い方を変える。
// {I} は一人称、文末の「。」は口調の語尾に置き換える。
import { relationLabel } from './town.js';

const pick = (a) => a[Math.floor(Math.random() * a.length)];

// 口調をかける: {I} → 一人称、文末の「。」→ 語尾
export function voice(persona, text) {
  const s = persona?.style ?? {};
  let t = String(text).replaceAll('{I}', s.first ?? '私');
  if (s.end !== undefined) t = t.replace(/。$/, s.end);
  return t;
}

// 今やっていることの言い方
const DOING = {
  gatherWood: '木を切ってる', makeTools: '道具を作ってる', gatherFood: '食べ物を集めてる', getIronGear: '鉄を掘ってる',
  buildHouse: '家を建ててる', tendFarm: '畑の世話をしてる', depositToStorage: '倉庫に物を納めてる', takeFromStorage: '倉庫から物を借りてる',
  socialize: 'みんなと話してる', giveGift: '贈り物を届けてる', callMeeting: '集会を開いてる', attendMeeting: '集会に出てる',
  explore: '探検してる', gatherBlocks: '石を集めてる', makeBed: 'ベッドを作ってる', sleepInBed: '寝るところ',
  goHome: '家に帰るところ', postNotice: '掲示板に貼り紙してる', mineBlock: '採掘してる', wait: 'ひと休みしてる',
};
export const doing = (skill) => DOING[skill] ?? 'ぶらぶらしてる';

// あいさつ（相手との仲で変える）
export function greet(persona, call, affinity) {
  const label = relationLabel(affinity);
  if (label === '親友' || label === '友だち') {
    return voice(persona, pick([`${call}、元気にしてた？`, `あ、${call}！会いたかった。`, `${call}、ちょっと話そうよ。`, `${call}、今日もお疲れさま。`]));
  }
  if (label === '苦手' || label === '嫌い') {
    return voice(persona, pick([`……${call}か。`, `${call}、何か用？`, `${call}、どうも。`]));
  }
  return voice(persona, pick([`${call}、こんにちは。`, `やあ${call}、調子はどう？`, `${call}、はじめまして…じゃないよね。`, `${call}、今なにしてるの？`]));
}

// 話題: 状況から 1 つ選んで話す
export function smalltalk(persona, call, s) {
  const topics = [];
  if (s.houseDone) topics.push(`{I}の家、ついに完成したんだ。今度遊びにきて。`);
  else if (s.houseStarted) topics.push(`いま家を建ててる途中なんだ。材料がまだ足りなくて。`);
  else topics.push(`そろそろ自分の家を建てたいな。`);
  if (s.hungry) topics.push(`お腹すいたなあ。食べ物、余ってない？`);
  if (s.night) topics.push(`もうすぐ夜だね。モンスターに気をつけて。`);
  if (s.storage) topics.push(`広場の共同倉庫、ちょっとずつ物が増えてきたね。`);
  else topics.push(`広場にみんなで使える倉庫があったら便利だと思うんだ。`);
  if (s.job) topics.push(`{I}は${s.job}として町の役に立ちたいと思ってる。`);
  if (s.gossip) topics.push(`そういえば${s.gossip.call}、最近${s.gossip.good ? 'がんばってるよね' : 'ちょっと勝手じゃない？'}。`);
  if (s.explored) topics.push(`この前遠くまで歩いたら、面白い地形があったよ。`);
  topics.push(`${call}は何の仕事をしてるの？`, `この町、どんな町にしたい？`);
  return voice(persona, pick(topics));
}

// 話しかけられたときの返事（決まった形）。返事が要らなければ null
export function replyTo(persona, fromCall, message, ctx) {
  const m = String(message);
  const friendly = ctx.affinity >= 10;
  const cold = ctx.affinity <= -10;
  if (/ありがと|助かる|感謝/.test(m)) return voice(persona, pick(['どういたしまして。', 'いいってことよ。', `${fromCall}の役に立ててうれしい。`]));
  if (/こんにち|こんばん|おはよ|やあ|元気|会いたかった|話そう/.test(m)) {
    if (cold) return voice(persona, pick(['……ああ。', 'まあね。', 'ふつう。']));
    return voice(persona, pick([`${fromCall}、こんにちは。`, `元気だよ。いまは${ctx.doing}。`, `${fromCall}に会えてうれしい。`, `やあ、${ctx.doing}ところ。`]));
  }
  if (/何して|なにして|今なに|何の仕事|仕事/.test(m)) return voice(persona, ctx.job ? `{I}は${ctx.job}。いまは${ctx.doing}。` : `いまは${ctx.doing}。`);
  if (/お腹|食べ物|余って/.test(m)) {
    return ctx.canShareFood
      ? voice(persona, pick([`少しなら分けられるよ。持っていくね。`, `${fromCall}、パンならあるよ。`]))
      : voice(persona, pick(['ごめん、{I}も足りないんだ。', '倉庫を見てみたら？']));
  }
  if (/家.*(完成|建て)/.test(m)) return voice(persona, pick(['すごいね！', 'いいなあ、{I}もがんばろう。', '今度見に行くよ。']));
  if (/倉庫/.test(m)) return voice(persona, pick(['倉庫、大事だよね。', '{I}も余った物を入れておくよ。', 'みんなで使おう。']));
  if (/どんな町/.test(m)) return voice(persona, persona.mbti[2] === 'F' ? 'みんなが仲良く暮らせる町がいいな。' : '効率よく物が回る町にしたい。');
  if (/勝手|ずるい|嫌い/.test(m)) return voice(persona, pick(['まあまあ、落ち着いて。', 'そうかな…。', 'みんな事情があるんだよ。']));
  if (/気をつけ|夜/.test(m)) return voice(persona, pick(['うん、早めに帰るよ。', '{I}も気をつける。']));
  if (/[?？]$/.test(m)) return voice(persona, pick(['うーん、どうだろう。', 'たぶんね。', `${friendly ? 'いい質問！' : ''}考えておく。`]));
  return friendly ? voice(persona, pick(['うんうん。', 'わかる。', `${persona.style.laugh ?? ''}、そうだね。`])) : null;
}

export function giftLine(persona, call, what) {
  return voice(persona, pick([`${call}、これ使って。${what}だよ。`, `${call}に${what}を持ってきた。`, `${what}、よかったらどうぞ。`]));
}

export function thanksLine(persona, call) {
  return voice(persona, pick([`${call}、ありがとう！`, `わあ、${call}ありがとう。大事に使うね。`, `${call}、助かるよ。`]));
}

// 集会
export function meetingCall(persona, topic) {
  return voice(persona, `📢 みんな、広場に集まって！${topic}について話そう。`);
}

export function meetingAgree(persona, leaderCall) {
  return voice(persona, pick([`了解、${leaderCall}。やってみる。`, 'わかった、任せて。', '賛成！']));
}

export function meetingDisagree(persona, leaderCall) {
  return voice(persona, pick([`うーん、${leaderCall}、今は自分のことで手一杯。`, 'それはちょっと…。', '{I}は別のことをしたいな。']));
}

export function arriveLine(persona) {
  return voice(persona, pick(['来たよ。', 'お待たせ。', 'ただいま広場に到着。', 'みんな集まってるね。']));
}
