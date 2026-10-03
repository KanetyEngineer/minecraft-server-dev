// 住人ひとりの「社会的な頭」: 性格・町の台帳・人間関係をまとめ、会話（チャット）を受け答えし、集会の仕事の割り振りを決める。
// Claude（ANTHROPIC_API_KEY）があれば会話を性格どおりに自由に作り、無ければ dialogue.js の決まった言い回しで返す。
import { traitsOf, personaByName, PERSONAS } from './personas.js';
import { relationLabel, isHouseShell, isInsideHouse } from './town.js';
import * as D from './dialogue.js';
import { foodPoints, FOODS, isPlanks, isLog } from '../util/items.js';
import { log } from '../log.js';
import { isLiteModel } from '../config.js';

// 集会で割り振る仕事。skills はその仕事に当たるスキル（割り振られた人はしばらくこれを優先する）
export const TASKS = {
  food: { label: '食料集め', skills: ['gatherFood', 'tendFarm'] },
  wood: { label: '木材集め', skills: ['gatherWood', 'depositToStorage'] },
  stone: { label: '石集め', skills: ['gatherBlocks', 'depositToStorage'] },
  explore: { label: '周りの探検', skills: ['explore'] },
  care: { label: 'みんなの世話', skills: ['giveGift', 'socialize'] },
  build: { label: '自分の家づくり', skills: ['buildHouse'] },
  storage: { label: '倉庫の整理', skills: ['depositToStorage'] },
};

// 性格ごとの仕事（名乗る肩書き）
export const JOBS = {
  INTJ: '大工', ENTP: '探検家', INFJ: '相談役', ENFP: '広報係', ISTJ: '倉庫番', ESFJ: '料理係',
  ISTP: '鍛冶屋', ESFP: '狩人', INFP: '庭師', ESTJ: '町長候補',
};

// 性格に向いた仕事（集会で割り振るとき）
function taskFor(mbti) {
  const t = mbti.toUpperCase();
  if (t[1] === 'S' && t[2] === 'F') return 'food';
  if (t[1] === 'S' && t[2] === 'T') return t[0] === 'I' ? 'stone' : 'wood';
  if (t[1] === 'N' && t[2] === 'T') return 'explore';
  return 'care';
}

export function personaPrompt(persona, traits) {
  return `あなたは Minecraft（Java 版サバイバル）の小さな町で暮らす住人「${persona.call}」（ゲーム内の名前 ${persona.name}）です。
性格は MBTI の ${persona.mbti}（${persona.title}）。${persona.bio}
一人称は「${persona.style.first}」。${persona.style.polite ? '丁寧な' : 'くだけた'}口調で話します。
町にはあなたを含めて MBTI の違う 10 人の住人（AI）がいます: ${PERSONAS.map((p) => `${p.call}(${p.mbti})`).join('、')}。
それぞれが自分の考えで行動し、家を建て、食べ物を作り、助け合ったり意見がぶつかったりしながら町（社会）を作っていきます。
誰かに命令されて動くのではなく、あなた自身の性格・好き嫌い・その場の状況から、自分がしたいことを選んでください。
傾向（0〜1）: 外向性 ${traits.extraversion} / 好奇心 ${traits.openness} / 協調性 ${traits.agreeableness} / 計画性 ${traits.conscientiousness}。
サバイバルの知識（覚えておくこと）:
- 畑（耕地）は水から 4 マス以内でないと乾いて土に戻り、作物も育たない。真ん中に水を入れるか水辺に作る（水を運ぶにはバケツ＝鉄 3 個）。作物は明るさ 9 以上で育つ
- 敵は明るさ 0 の暗い所にしか湧かない。家の中と家のまわりを松明で明るくすれば安全になる。松明は石炭か木炭（原木を焼く）と棒で作る
- 夜は家の中にいれば安全（壁・屋根・扉がある）。夜の外出・夜の洞窟は危ない。ベッドで寝れば夜を飛ばせて、復活地点も家になる
- 羊はハサミ（鉄 2 個）で毛を刈れば倒さずに羊毛が取れ、毛はまた生える。牛・羊は小麦、豚はニンジン・ジャガイモ、ニワトリは種で繁殖する
- 体力は満腹度 18 以上で自然に回復する。焼いた肉（ステーキ・豚肉）がいちばん腹持ちがよく、パンも良い。走ると早くお腹がすく
- クリーパーには近づかない。高い所からの落下・溶岩・水中での息切れに気をつける
ルール: 普通のプレイヤーと同じ。コマンド・チートは使わない。荒らし・他人の家を壊すこと・盗みはしない。`;
}

const CHAT_RULES = `ゲーム内のチャットで話します。返事は日本語で 1 文、40 文字くらいまで。説明口調・箇条書き・絵文字の多用はしない。
相手を名前（カタカナの呼び名）で呼んでよい。返事が要らなければ何も書かずに空で返す。`;

export class Society {
  constructor({ persona, town, rel, cfg, client = null }) {
    this.persona = persona;
    this.traits = traitsOf(persona.mbti);
    this.town = town;
    this.rel = rel;
    this.cfg = cfg;
    this.client = client;
    this.flags = {};
    this.heard = []; // 最近聞いたチャット { username, message, at }
    this.exchanges = new Map(); // 相手ごとの直近のやり取りの回数（会話が延々と続かないように）
    this.lastSpokeAt = 0;
    this.bot = null;
    this.currentSkill = () => null;
    town.profile.job ??= JOBS[persona.mbti] ?? persona.title;
  }

  get usingLLM() {
    // 失敗が続いたら（残高切れなど）10 分は決まった言い回しで話す
    return !!this.client && this.cfg.llm.chat && Date.now() > (this.llmOffUntil ?? 0);
  }

  // API の節約: Claude で会話を作るのは SOCIETY_LLM_CHAT_SEC 秒（既定 60 秒）に 1 回まで
  chatBudget() {
    if (!this.usingLLM) return false;
    if (Date.now() - (this.lastLlmChatAt ?? 0) < (Number(process.env.SOCIETY_LLM_CHAT_SEC) || 60) * 1000) return false;
    this.lastLlmChatAt = Date.now();
    return true;
  }

  get assignment() {
    const a = this.rel.data.assignment;
    return a && a.until > Date.now() ? a : null;
  }

  // ---------- 公開情報（5 秒ごとに Agent のチームタイマーから呼ばれる）----------
  publish(bot) {
    this.bot = bot;
    if (bot?.entity && !this.town.plaza()) {
      // 広場はワールドの初期スポーン地点（全員が同じ場所に湧くので自然に一致する）
      const sp = bot.spawnPoint ?? bot.entity.position;
      this.town.setPlaza(sp);
    }
    this.town.profile.wants = this.wants(bot);
    this.town.profile.doing = this.currentSkill();
    this.town.publish(bot);
  }

  importPlaces() { return []; }

  // 壁のできた家（自分の家も含む）。10 秒ごとに台帳から読み直す
  houses() {
    if (!this.housesCache || Date.now() - this.housesCache.at > 10_000) {
      const list = [this.town.profile, ...this.town.residents()].map((r) => r.house)
        .filter((h) => h && ['roof', 'door', 'done'].includes(h.stage));
      this.housesCache = { at: Date.now(), list };
    }
    return this.housesCache.list;
  }

  isHouseShell(p) { return isHouseShell(this.houses(), p); }

  isIndoors(p) { return isInsideHouse(this.houses(), p); }

  wants(bot) {
    if (!bot?.inventory) return [];
    const w = [];
    if (foodPoints(bot) < 3) w.push('food');
    const house = this.town.profile.house;
    const blocks = bot.inventory.items().filter((i) => isPlanks(i.name) || isLog(i.name) || i.name === 'cobblestone').reduce((s, i) => s + i.count, 0);
    if (house && house.stage !== 'done' && blocks < 20) w.push('planks');
    if (house?.stage === 'done' && !house.bed && !bot.inventory.items().some((i) => i.name.endsWith('_bed'))) w.push('wool');
    return w;
  }

  // ---------- 発言を作る ----------
  async speak(kind, v = {}) {
    const p = this.persona;
    const canned = () => {
      if (kind === 'greet') return D.greet(p, v.call, v.affinity ?? 0);
      if (kind === 'smalltalk') return D.smalltalk(p, v.call, v.state ?? {});
      if (kind === 'gift') return D.giftLine(p, v.call, v.what);
      if (kind === 'meetingCall') return D.meetingCall(p, v.topic);
      return D.voice(p, v.text ?? '');
    };
    // 決まった形のもの（集会の呼びかけ）と自由発言はそのまま。会話の出だしと世間話だけ Claude に作らせる
    // 会話の出だしと世間話を Claude に作らせるのは 3 回に 1 回だけ（API の節約）
    if (!this.chatBudget() || !['greet', 'smalltalk'].includes(kind) || Math.random() > 0.35) return canned();
    const rel = v.to ? this.rel.get(v.to) : null;
    const intent = kind === 'greet'
      ? `${v.call} に会ったので話しかける（あなたから見て ${relationLabel(rel?.affinity ?? 0)}、好感度 ${rel?.affinity ?? 0}）。`
      : `${v.call} との世間話をひとつ振る。話題の材料: ${JSON.stringify(v.state ?? {})}`;
    return (await this.llmLine(intent)) ?? canned();
  }

  async llmLine(intent, { conversation = [] } = {}) {
    try {
      const recent = this.heard.slice(-8).map((h) => `${h.username}: ${h.message}`).join('\n');
      const rels = this.rel.ranked().slice(0, 6).map((r) => `${personaByName(r.name)?.call ?? r.name}=${relationLabel(r.affinity)}(${r.affinity})`).join('、');
      const res = await this.client.messages.create({
        model: this.cfg.llm.model,
        max_tokens: 1000,
        // Haiku は effort を受け付けない（送ると 400 になる）
        ...(isLiteModel(this.cfg.llm.model) ? {} : { output_config: { effort: 'low' } }),
        system: [{ type: 'text', text: `${personaPrompt(this.persona, this.traits)}\n${CHAT_RULES}`, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: `最近のチャット:\n${recent || '（なし）'}\n人間関係: ${rels || 'まだ誰とも話していない'}\nいまやっていること: ${D.doing(this.currentSkill())}\n\n${intent}\n発言だけを書いてください。` }, ...conversation],
      });
      this.llmFails = 0;
      if (res.stop_reason === 'refusal') return null;
      const t = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
      return t ? t.replace(/^["「]|["」]$/g, '').slice(0, 100) : null;
    } catch (e) {
      log.warn(`会話の生成に失敗: ${e.message}`);
      this.llmFails = (this.llmFails ?? 0) + 1;
      if (this.llmFails >= 3) { this.llmOffUntil = Date.now() + 10 * 60_000; this.llmFails = 0; }
      return null;
    }
  }

  // ---------- 聞いたチャットへの反応（Agent の chat から呼ばれる）。返事が要らなければ null ----------
  async onChat(bot, username, message) {
    this.bot = bot;
    if (username === bot.username) return null;
    this.heard = [...this.heard, { username, message, at: Date.now() }].slice(-20);
    const from = personaByName(username);
    const call = from?.call ?? username;
    const me = this.persona;
    const direct = message.includes(me.call) || message.toLowerCase().includes(me.name.toLowerCase());
    const rel = this.rel.get(username);

    // 集会の仕事の割り振り（「📋 シオリは食料集めをお願い。」）
    if (message.includes('📋') && direct) return this.answerAssignment(username, call, message);
    // 集会の呼びかけ
    if (message.includes('📢')) { this.flags.meetingHeardAt = Date.now(); return null; }
    // 贈り物をもらった
    if (direct && /どうぞ|持ってきた|使って/.test(message) && from) {
      rel.giftsReceived++;
      this.rel.adjust(username, 6 + this.traits.agreeableness * 4, '贈り物をもらった');
      this.rel.diary(`${call}から贈り物をもらった。`);
      return this.say(D.thanksLine(me, call), username);
    }
    // 会話が延々と続かないように: 同じ相手とは 3 分に 3 往復まで、全体でも 15 秒は間を空ける。
    // 名指しされていない話への口出しは、外向的な人がたまに（2 分に 1 回まで）だけ
    //（10 人が同じ場所にいると、全員が全員の発言に返事をしてチャットが埋まった）
    const ex = (this.exchanges.get(username) ?? []).filter((t) => Date.now() - t < 180_000);
    if (ex.length >= 3 || Date.now() - this.lastSpokeAt < 15_000) return null;
    const near = bot.players[username]?.entity?.position?.distanceTo(bot.entity.position) ?? 999;
    if (!direct) {
      if (Date.now() - (this.lastChimeInAt ?? 0) < 120_000) return null;
      const chance = /みんな|皆|全員/.test(message) ? 0.1 + this.traits.extraversion * 0.25 : near < 12 ? this.traits.extraversion * 0.1 : 0;
      if (Math.random() >= chance) return null;
      this.lastChimeInAt = Date.now();
    }

    // 話しかけられると少し親しくなる（相性が悪いと、たまに気に障る）
    if (from) {
      const cold = rel.affinity < -10 || (Math.random() < 0.08 && this.traits.agreeableness < 0.5);
      this.rel.adjust(username, cold ? -2 : 1, cold ? `${call}の言い方が気に障った` : null);
      this.rel.talked(username);
    }
    // 食べ物を頼まれたら、分けられるなら届ける予定を立てる
    const canShareFood = bot.inventory.items().filter((i) => FOODS.has(i.name)).reduce((s, i) => s + i.count, 0) >= 6;
    if (direct && /お腹|食べ物|余って/.test(message) && canShareFood && Math.random() < 0.3 + this.traits.agreeableness * 0.6) {
      this.flags.pendingGift = { to: username, item: 'food', count: 3, at: Date.now() };
    }
    let text = null;
    // 名指しされたときだけ Claude で返事を作る（口出しは決まった言い回し。API の節約）
    if (direct && this.chatBudget()) {
      text = await this.llmLine(`${call} がチャットで「${message}」と言った（${direct ? 'あなたに向けて' : '近くで'}）。`
        + `あなたから見た ${call} は ${relationLabel(rel.affinity)}（好感度 ${rel.affinity}）。返事をする。`);
    }
    text ??= D.replyTo(me, call, message, { affinity: rel.affinity, doing: D.doing(this.currentSkill()), job: this.town.profile.job, canShareFood });
    if (!text) return null;
    ex.push(Date.now());
    this.exchanges.set(username, ex);
    return this.say(text, username);
  }

  say(text, to) {
    this.lastSpokeAt = Date.now();
    if (to) this.town.event('chat', `${this.persona.call}: ${text}`, { to });
    return text;
  }

  answerAssignment(username, call, message) {
    const task = Object.entries(TASKS).find(([, t]) => message.includes(t.label));
    if (!task) return null;
    const rel = this.rel.get(username);
    // 引き受けるか: 計画性・協調性が高く、相手が好きなほど引き受ける
    const p = 0.25 + this.traits.conscientiousness * 0.3 + this.traits.agreeableness * 0.2 + rel.affinity / 150;
    if (Math.random() < p) {
      this.rel.data.assignment = { task: task[0], by: username, at: Date.now(), until: Date.now() + 30 * 60_000 };
      this.rel.adjust(username, 2, `${task[1].label}を任された`);
      this.rel.diary(`${call}に${task[1].label}を任された。`);
      this.town.event('assign-accept', `${this.persona.call}が${call}から${task[1].label}を引き受けた`, { by: username, task: task[0] });
      return this.say(D.meetingAgree(this.persona, call), username);
    }
    this.rel.adjust(username, -2, `${task[1].label}を頼まれたが断った`);
    this.town.event('assign-decline', `${this.persona.call}が${call}の頼み（${task[1].label}）を断った`, { by: username, task: task[0] });
    return this.say(D.meetingDisagree(this.persona, call), username);
  }

  // ---------- 集会・掲示板 ----------
  meetingTopic() {
    const st = this.town.storageContents();
    const food = st ? Object.entries(st.items).filter(([n]) => FOODS.has(n)).reduce((s, [, c]) => s + c, 0) : 0;
    const homeless = this.town.residents().filter((r) => r.house?.stage !== 'done').length;
    if (!this.town.storage()) return '共同倉庫と役割分担';
    if (food < 10) return '食料の確保';
    if (homeless >= 3) return '家づくりの助け合い';
    return 'これからの町づくり';
  }

  // 集まった人に仕事を割り振るセリフ（📋 で始まり、相手の呼び名と仕事名を含む）
  assignTasks(names) {
    const st = this.town.storageContents();
    const food = st ? Object.entries(st.items).filter(([n]) => FOODS.has(n)).reduce((s, [, c]) => s + c, 0) : 0;
    const lines = [];
    for (const name of names) {
      const r = this.town.resident(name);
      const p = personaByName(name);
      if (!p) continue;
      let task = taskFor(p.mbti);
      if (r?.house?.stage !== 'done' && Math.random() < 0.5) task = 'build';
      else if (food < 10 && task !== 'food' && Math.random() < 0.3) task = 'food';
      lines.push(D.voice(this.persona, `📋 ${p.call}は${TASKS[task].label}をお願い。`));
    }
    return lines;
  }

  noticeText() {
    const w = this.town.profile.wants ?? [];
    const label = { food: '食べ物', planks: '板材', wool: '羊毛（ベッド用）' };
    if (w.length) return `【募集】${w.map((x) => label[x] ?? x).join('・')}がほしい。${this.persona.call}まで。`;
    if (this.town.profile.house?.stage === 'done') return `【おしらせ】${this.persona.call}の家は (${this.town.profile.house.x}, ${this.town.profile.house.z})。遊びに来てね。`;
    return `【自己紹介】${this.persona.call}（${this.persona.mbti}）。仕事は${this.town.profile.job}。よろしく。`;
  }
}
