// 社会実験の住人 10 人。MBTI の 4 文字から性格の傾向（数値）を出し、行動の選び方・話し方・人付き合いに使う。
// 名前はゲーム内の名前（16 文字以内、英数字と _）。末尾に MBTI を付けて、観察する人が見分けやすくする。

export const PERSONAS = [
  { id: 1, name: 'Rin_INTJ', sex: 'F', generation: 1, call: 'リン', mbti: 'INTJ', title: '建築家',
    bio: '先を読んで計画を立てるのが好き。無駄が嫌いで、町の配置や倉庫の整理を考えている。口数は少ないが言うことは的確。',
    style: { end: '。', first: '私', laugh: 'ふっ', polite: true } },
  { id: 2, name: 'Kaito_ENTP', sex: 'M', generation: 1, call: 'カイト', mbti: 'ENTP', title: '発明家',
    bio: '新しいことを試すのが大好きな議論好き。遠くまで探検して面白い物を見つけてきては、みんなに話したがる。',
    style: { end: '！', first: 'オレ', laugh: 'はは', polite: false } },
  { id: 3, name: 'Shiori_INFJ', sex: 'F', generation: 1, call: 'シオリ', mbti: 'INFJ', title: '提唱者',
    bio: '静かだけれど、みんなが仲良く暮らせることを一番に願っている。困っている人にそっと物を分けてあげる。',
    style: { end: '。', first: 'わたし', laugh: 'ふふ', polite: true } },
  { id: 4, name: 'Hinata_ENFP', sex: 'F', generation: 1, call: 'ヒナタ', mbti: 'ENFP', title: '広報担当',
    bio: '明るくて人懐っこい。いろんな人に話しかけて友だちを増やし、思いつきで遊びや集まりを始める。',
    style: { end: '！', first: 'あたし', laugh: 'あはは', polite: false } },
  { id: 5, name: 'Kenji_ISTJ', sex: 'M', generation: 1, call: 'ケンジ', mbti: 'ISTJ', title: '管理者',
    bio: '真面目で几帳面。決まった仕事をこつこつ続け、木材や石をきっちり倉庫に納める。約束は必ず守る。',
    style: { end: '。', first: '自分', laugh: 'む', polite: true } },
  { id: 6, name: 'Mio_ESFJ', sex: 'F', generation: 1, call: 'ミオ', mbti: 'ESFJ', title: '世話役',
    bio: '面倒見がよく、みんなの食事や体調を気にかける。食べ物を作って配り、あいさつを欠かさない。',
    style: { end: 'ね！', first: 'わたし', laugh: 'うふふ', polite: false } },
  { id: 7, name: 'Takumi_ISTP', sex: 'M', generation: 1, call: 'タクミ', mbti: 'ISTP', title: '職人',
    bio: '手を動かすのが好きな一匹狼。道具作りや採掘が得意で、必要なときだけ短く話す。',
    style: { end: '', first: '俺', laugh: 'へっ', polite: false } },
  { id: 8, name: 'Nana_ESFP', sex: 'F', generation: 1, call: 'ナナ', mbti: 'ESFP', title: 'エンターテイナー',
    bio: '今この瞬間を楽しむ人。人の集まる所が好きで、狩りや探検もノリで決める。場を盛り上げる。',
    style: { end: '〜！', first: 'ナナ', laugh: 'きゃは', polite: false } },
  { id: 9, name: 'Yuki_INFP', sex: 'M', generation: 1, call: 'ユキ', mbti: 'INFP', title: '仲介者',
    bio: '空想好きで優しい。自然の中を散歩し、自分の家をこだわって作る。争いは苦手で、仲裁に入る。',
    style: { end: '…', first: 'ぼく', laugh: 'えへへ', polite: true } },
  { id: 10, name: 'Daichi_ESTJ', sex: 'M', generation: 1, call: 'ダイチ', mbti: 'ESTJ', title: '幹部',
    bio: '仕切り屋のまとめ役。町の決まりを作り、集会を開いて仕事を割り振る。成果を数字で見たがる。',
    style: { end: '！', first: '俺', laugh: 'ははは', polite: false } },
];

// MBTI の 4 文字から、行動に使う傾向（0〜1）を出す
export function traitsOf(mbti) {
  const t = String(mbti).toUpperCase();
  const E = t[0] === 'E'; const N = t[1] === 'N'; const F = t[2] === 'F'; const J = t[3] === 'J';
  return {
    extraversion: E ? 0.8 : 0.25, // 人と話したい度合い（社交の欲求が減る速さ）
    openness: N ? 0.8 : 0.3, // 新しい場所・物への好奇心（探検）
    agreeableness: F ? 0.8 : 0.35, // 人を助けたい・仲良くしたい（贈り物・分け合い）
    conscientiousness: J ? 0.8 : 0.35, // 計画・片付け・家づくり・共同倉庫
    // 組み合わせ
    leadership: (E ? 0.5 : 0) + (J ? 0.4 : 0) + (t[2] === 'T' ? 0.1 : 0), // 集会を開く
    craftsmanship: (!N ? 0.5 : 0.2) + (t[2] === 'T' ? 0.3 : 0) + (t.startsWith('IST') ? 0.2 : 0),
  };
}

// 生まれた子ども（2 世代目以降）。society/world.json から読み込んで足す（population.js の loadWorld が呼ぶ）
const EXTRA = new Map();
export function registerPersonas(list) {
  for (const p of list ?? []) if (p?.name) EXTRA.set(p.name.toLowerCase(), p);
}

// 1 世代目と、生まれた子どもすべて
export function allPersonas() {
  return [...PERSONAS, ...[...EXTRA.values()].filter((p) => !PERSONAS.some((q) => q.name === p.name))];
}

export function personaByName(name) {
  const key = String(name).toLowerCase();
  return PERSONAS.find((p) => p.name.toLowerCase() === key) ?? EXTRA.get(key) ?? null;
}

export function personaById(id) {
  return allPersonas().find((p) => p.id === Number(id)) ?? null;
}

// 性格の相性（-1〜1）。同じ見方（N/S）は話が合い、判断（T/F）が同じだと価値観が近い。E と I は補い合う
export function compatibility(a, b) {
  const x = String(a).toUpperCase(); const y = String(b).toUpperCase();
  let s = 0;
  s += x[1] === y[1] ? 0.4 : -0.2;
  s += x[2] === y[2] ? 0.2 : 0;
  s += x[0] !== y[0] ? 0.15 : 0;
  s += x[3] === y[3] ? 0.1 : -0.05;
  return Math.max(-1, Math.min(1, s));
}
