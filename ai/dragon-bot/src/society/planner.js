// 社会モードの方針判断。
// 1) 欲求と性格から、やりたいことに点数をつける（ルールベース。API キーが無くてもこれで動く）
//    欲求: 空腹・夜の安全・家・人と話したい・新しい物を見たい・町の役に立ちたい（集会で任された仕事も）
// 2) Claude が使えるときは、点数の高い候補と状況・人間関係を渡し、性格どおりに 1 つ選ばせる
import Anthropic from '@anthropic-ai/sdk';
import { SOCIETY_SKILL_MAP, societyToolDefinitions } from './skillset.js';
import { sanitizeArgs } from '../skills/index.js';
import { personaPrompt, TASKS } from './core.js';
import { surplus, buildingCount } from './skills.js';
import { relationLabel } from './town.js';
import { personaByName } from './personas.js';
import { foodPoints, FOODS, countMatching, isLog, isPlanks } from '../util/items.js';
import { log } from '../log.js';

const has = (bot, re) => bot.inventory.items().some((i) => re.test(i.name));

// 最近このスキルを何回、どの結果で使ったか
function recent(history, skill, n = 6) {
  const h = history.slice(-n).filter((x) => x.skill === skill);
  return { count: h.length, fails: h.filter((x) => !x.ok).length };
}

// やりたいことの候補と点数。[{ skill, args, score, why }]（点数の高い順）
export function options(bot, soc, history = []) {
  const t = soc.traits;
  const town = soc.town;
  const out = [];
  const add = (skill, score, why, args = {}) => out.push({ skill, args, score, why });
  const house = town.profile.house;
  const houseDone = house?.stage === 'done';
  const food = foodPoints(bot);
  const tod = bot.time?.timeOfDay ?? 6000;
  const night = !bot.time?.isDay || tod > 12300;
  const online = town.residents().filter((r) => r.online);
  const wood = countMatching(bot, isLog) * 4 + countMatching(bot, isPlanks);
  const pick = has(bot, /_pickaxe$/);
  const stored = town.storageContents()?.items ?? {};
  const storedFood = Object.entries(stored).filter(([n]) => FOODS.has(n)).reduce((s, [, c]) => s + c, 0);
  const minutes = (key) => soc.rel.since(key);

  // 夜: 家があれば帰って寝る。無ければ穴を掘って朝を待つ
  if (night) {
    if (houseDone) add('goHome', 95, '夜になったので家に帰って休む');
    else add('shelterForNight', 75, '夜なのにまだ家が無いので、穴にこもって朝を待つ');
  } else if (houseDone && (tod > 9000 || Math.hypot((bot.entity?.position.x ?? house.x) - house.x, (bot.entity?.position.z ?? house.z) - house.z) > 150)) {
    // 遠出しすぎ（羊や動物を追って数百マス離れ、夜に帰れなくなっていた）か夕方なら、町へ戻る
    // 夕方: 家から遠ければ暗くなる前に帰り始める（夜道でゾンビやスケルトンに倒されることが多かった）
    const p = bot.entity?.position;
    const far = p ? Math.hypot(p.x - house.x, p.z - house.z) : 0;
    if (far > 150) add('goHome', 70 + Math.min(20, far / 40), '町から離れすぎたので家へ戻る');
    else if (far > 24 && tod > 9000) add('goHome', 60 + Math.min(30, far / 4), '日が暮れる前に家へ帰る');
  }
  // 空腹
  if (bot.food <= 8 && food < 2) {
    if (storedFood > 0 && town.storage()) add('takeFromStorage', 85, 'お腹がすいたので共同倉庫から食べ物をもらう', { item: 'food', count: 4 });
    add('gatherFood', 78, 'お腹がすいたので食べ物を取りに行く', { amount: 8 });
  } else if (food < 4) {
    add('gatherFood', 40 + (1 - t.openness) * 10, '食べ物の蓄えが少ない', { amount: 10 });
  }
  // 道具
  if (!pick) {
    if (wood < 12) add('gatherWood', 72, 'まずは木を切って道具を作る', { logs: 8 });
    else add('makeTools', 74, '石の道具をそろえる', { tier: 'stone' });
  }
  // 家
  if (!houseDone) {
    const r = recent(history, 'buildHouse');
    add('buildHouse', 38 + t.conscientiousness * 35 + (pick ? 5 : -20) - r.fails * 15, house ? '家づくりの続き' : '自分の家を建てたい');
  } else {
    // 扉の無い家は夜に敵が入ってくるので、昼のうちに付けに帰る
    if (house.doorOk !== true && !night && minutes('lastHomeAt') > 8) add('goHome', 55, '家に扉を付ける');
    // 家具: ベッド
    // 夜はベッドで寝たいので、ベッドが無ければ昼のうちに用意する（倉庫に羊毛やベッドがあればもらう）
    const bedPlaced = !!house.bed;
    const storedWool = Object.entries(stored).filter(([n]) => n.endsWith('_wool')).reduce((s2, [, c]) => Math.max(s2, c), 0);
    const storedBed = Object.entries(stored).some(([n, c]) => n.endsWith('_bed') && c > 0);
    if (house.bed === undefined && !night) add('goHome', 50, '家のベッドを確かめに帰る');
    else if (!bedPlaced && has(bot, /_bed$/)) add('goHome', 65, '作ったベッドを家に置く');
    else if (!bedPlaced && !night) {
      if (storedBed) add('takeFromStorage', 60, '倉庫のベッドをもらう', { item: 'bed', count: 1 });
      else if (storedWool >= 3 && countMatching(bot, (n) => n.endsWith('_wool')) < 3) add('takeFromStorage', 55, '倉庫の羊毛でベッドを作る', { item: 'wool', count: 3 });
      else if (minutes('lastBedTryAt') > 6) add('makeBed', 48 + t.conscientiousness * 15, '夜に寝るベッドがほしい', { count: 1 });
    }
    // 畑
    if (minutes('lastFarmAt') > 6) add('tendFarm', 22 + (1 - t.openness) * 18 + t.conscientiousness * 8, '畑の世話をする');
  }
  // 共同倉庫に余りを納める
  const extra = surplus(bot, soc);
  if (extra.length && pick) add('depositToStorage', 12 + t.conscientiousness * 25 + t.agreeableness * 12 + extra.length * 2, '余った物を町の倉庫に納める');
  // 人と話す（外向的な人ほど、話さないでいると話したくなる）
  if (online.length && !night) {
    const lonely = minutes('lastTalkAt');
    add('socialize', Math.min(70, 8 + lonely * (0.6 + t.extraversion * 3)), '誰かと話したい');
  }
  // 贈り物（頼まれた／困っている人がいる）
  const pending = soc.flags.pendingGift;
  if (pending && Date.now() - pending.at < 10 * 60_000) add('giveGift', 55 + t.agreeableness * 30, `${personaByName(pending.to)?.call ?? pending.to}に頼まれた物を届ける`, { to: pending.to, item: pending.item, count: pending.count });
  if (food >= 8 && t.agreeableness > 0.5) {
    const hungry = online.find((r) => (r.wants ?? []).includes('food'));
    if (hungry) add('giveGift', 30 + t.agreeableness * 30 + Math.max(0, soc.rel.get(hungry.name).affinity) / 3, `${personaByName(hungry.name)?.call ?? hungry.name}が食べ物に困っている`, { to: hungry.name, item: 'food', count: 4 });
  }
  const myWool = bot.inventory.items().filter((i) => i.name.endsWith('_wool')).sort((a, b) => b.count - a.count)[0];
  if (myWool && myWool.count >= 3 && houseDone && house.bed) {
    const needy = online.find((r) => (r.wants ?? []).includes('wool'));
    if (needy) add('giveGift', 30 + t.agreeableness * 30, `${personaByName(needy.name)?.call ?? needy.name}がベッドの羊毛に困っている`, { to: needy.name, item: myWool.name, count: 3 });
  }
  if (wood >= 40 && t.agreeableness > 0.5) {
    const builder = online.find((r) => (r.wants ?? []).includes('planks'));
    if (builder) add('giveGift', 25 + t.agreeableness * 25, `${personaByName(builder.name)?.call ?? builder.name}が家の材料に困っている`, { to: builder.name, item: 'planks', count: 16 });
  }
  // 集会
  const meeting = town.meetings().find((m) => m.by !== bot.username);
  if (meeting && (soc.flags.attendedMeetingAt ?? 0) < meeting.at && !night) {
    add('attendMeeting', 35 + t.agreeableness * 20 + t.conscientiousness * 15 + soc.rel.get(meeting.by).affinity / 3, `${personaByName(meeting.by)?.call ?? meeting.by}の集会に出る`);
  }
  if (t.leadership >= 0.8 && minutes('lastMeetingAt') > 25 && online.length >= 3 && !night && !meeting && pick) {
    add('callMeeting', 25 + t.leadership * 30, '町のみんなで話し合いたい');
  }
  // 探検（好奇心）
  if (!night) add('explore', Math.min(55, 4 + minutes('lastExploreAt') * t.openness * 1.5), '新しい場所を見てみたい', { steps: 3 });
  // 掲示板
  if (minutes('lastNoticeAt') > 20 && !night) add('postNotice', 8 + t.extraversion * 10 + ((town.profile.wants ?? []).length ? 10 : 0), '掲示板に貼り紙をする');
  if (minutes('lastPlazaAt') > 15 && !night) add('goToPlaza', 6 + t.openness * 6, '広場の掲示板を見に行く');
  // 職人気質: 鉄と石
  if (pick && minutes('lastIronAt') > 30 && !night) add('getIronGear', 10 + t.craftsmanship * 25, '鉄の道具を作りたい', { armor: false });
  if (!houseDone && buildingCount(bot) < 30 && pick) add('gatherBlocks', 8 + t.craftsmanship * 15, '家の材料に石を集める', { count: 32 });

  // 集会で任された仕事はしばらく優先する
  const a = soc.assignment;
  if (a) {
    for (const o of out) if (TASKS[a.task]?.skills.includes(o.skill)) { o.score += 30; o.why += `（${personaByName(a.by)?.call ?? a.by}に${TASKS[a.task].label}を任されている）`; }
    if (!out.some((o) => TASKS[a.task]?.skills.includes(o.skill)) && !night) {
      const s = TASKS[a.task].skills[0];
      if (s !== 'giveGift') add(s, 45, `${personaByName(a.by)?.call ?? a.by}に${TASKS[a.task].label}を任されている`);
    }
  }
  // 同じ失敗を続けない・気まぐれ
  for (const o of out) {
    const r = recent(history, o.skill, 4);
    if (r.fails >= 2) o.score -= 40;
    o.score += Math.random() * (6 + (1 - t.conscientiousness) * 14);
  }
  return out.sort((a, b) => b.score - a.score);
}

// スキルが終わったときに、欲求の「最後にやった時刻」を進める
const MARKS = { socialize: 'lastTalkAt', explore: 'lastExploreAt', tendFarm: 'lastFarmAt', postNotice: 'lastNoticeAt',
  goToPlaza: 'lastPlazaAt', getIronGear: 'lastIronAt', makeBed: 'lastBedTryAt', callMeeting: 'lastMeetingAt', goHome: 'lastHomeAt' };

export class SocietyPlanner {
  constructor(cfg, soc, { client } = {}) {
    this.cfg = cfg;
    this.soc = soc;
    const hasKey = !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
    this.client = client ?? (cfg.llm.enabled && hasKey ? new Anthropic({ timeout: cfg.llm.timeoutMs ?? 45_000, maxRetries: 1 }) : null);
    this.tools = societyToolDefinitions();
    this.failStreak = 0;
  }

  get usingLLM() {
    // 5 回続けて失敗したら（残高切れなど）しばらく性格ルールだけで動き、10 分ごとに Claude を試し直す
    if (this.failStreak >= 5 && Date.now() - (this.lastFailAt ?? 0) > 10 * 60_000) this.failStreak = 4;
    return !!this.client && this.failStreak < 5;
  }

  noteHistory(history) {
    // 前回の判断から増えた分だけ見る（前回見た最後の記録より後ろ）
    const i = this.lastEntry ? history.lastIndexOf(this.lastEntry) : -1;
    for (const h of history.slice(i + 1)) {
      const key = MARKS[h.skill];
      // 失敗しても「やろうとした」ので、同じことをすぐ繰り返さないよう時刻は進める
      if (key) this.soc.rel.mark(key);
      if (h.skill === 'goHome' && /ベッドで寝た/.test(h.result)) this.soc.flags.hasBed = true;
    }
    this.lastEntry = history.at(-1) ?? null;
  }

  async decide({ bot, history = [], chatLog = [], banned = [], instructions = [] }) {
    this.noteHistory(history);
    if (this.soc.flags.pendingGift && history.at(-1)?.skill === 'giveGift') this.soc.flags.pendingGift = null;
    const opts = options(bot, this.soc, history).filter((o) => !banned.includes(o.skill));
    const top = opts[0] ?? { skill: 'wait', args: { seconds: 20 }, why: 'することが無い' };
    const hint = { skill: top.skill, args: top.args };
    // API の節約: Claude に聞くのは SOCIETY_LLM_DECIDE_SEC 秒（既定 180 秒）に 1 回まで。
    // その間と、夜に家へ帰る・空腹・道具が無いなど性格で迷わない場面は性格ルールで決める
    const obvious = top.score >= 70 || (opts[1] && top.score - opts[1].score > 25);
    const due = Date.now() - (this.lastAskAt ?? 0) > (Number(process.env.SOCIETY_LLM_DECIDE_SEC) || 180) * 1000;
    if (!this.usingLLM || obvious || !due) return { ...hint, hint, source: 'rules', thought: `（${this.soc.persona.mbti} の気分）${top.why}` };
    this.lastAskAt = Date.now();
    try {
      const d = await this.askClaude({ bot, opts: opts.slice(0, 7), history, chatLog, banned, instructions });
      d.hint = hint;
      this.failStreak = 0;
      return d;
    } catch (e) {
      this.failStreak++;
      this.lastFailAt = Date.now();
      log.warn(`LLM 判断に失敗（${this.failStreak} 回目）: ${e.message}。性格ルールで続行`);
      return { ...hint, hint, source: 'rules', thought: top.why };
    }
  }

  buildRequest({ bot, opts, history, chatLog, banned, instructions = [] }) {
    const soc = this.soc;
    const inv = {};
    for (const i of bot.inventory.items()) inv[i.name] = (inv[i.name] ?? 0) + i.count;
    const p = bot.entity.position;
    const state = {
      position: { x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) },
      health: Math.round(bot.health), food: bot.food, timeOfDay: bot.time?.timeOfDay, isDay: bot.time?.isDay,
      inventory: inv, job: soc.town.profile.job, house: soc.town.profile.house ?? null,
      plaza: soc.town.plaza(), storage: soc.town.storage(), storageContents: soc.town.storageContents()?.items ?? null,
      assignment: soc.assignment, meetings: soc.town.meetings(),
      noticeBoard: soc.town.notices(bot) ?? '（広場から離れているので見えない）',
    };
    const residents = soc.town.residents().map((r) => {
      const rel = soc.rel.get(r.name);
      return `- ${personaByName(r.name)?.call ?? r.name}（${r.name}, ${r.mbti}, ${r.job ?? '?'}）${r.online ? '' : '［留守］'} 家:${r.house?.stage === 'done' ? '完成' : r.house ? '建設中' : 'なし'} ほしい物:${(r.wants ?? []).join('・') || 'なし'} / あなたから見て ${relationLabel(rel.affinity)}（${rel.affinity}）${rel.notes.length ? ` メモ: ${rel.notes.slice(-2).join('；')}` : ''}`;
    }).join('\n');
    const text = [
      '## 今の状況', '```json', JSON.stringify(state), '```',
      '## 町の住人とあなたの関係', residents || '- まだ誰の情報も無い',
      '## 最近やったこと（古い順）',
      history.length ? history.slice(-10).map((h) => `- ${h.skill}(${JSON.stringify(h.args)}) → ${h.ok ? '成功' : '失敗'}: ${h.result}`).join('\n') : '- まだ何もしていない',
      '## 最近のチャット', chatLog.length ? chatLog.map((c) => `- ${c.username}: ${c.message}`).join('\n') : '- なし',
      '## 日記（最近）', soc.rel.data.diary.slice(-5).map((d) => `- ${d.text}`).join('\n') || '- なし',
      instructions.length ? `## プレイヤーからの頼み（できれば応える）\n${instructions.map((i) => `- ${i.username}: ${i.text}`).join('\n')}` : '',
      '## あなたの気持ち（欲求と性格からの候補。点数が高いほどやりたい）',
      opts.map((o) => `- ${o.skill}(${JSON.stringify(o.args)}) ${Math.round(o.score)}点: ${o.why}`).join('\n'),
      banned.length ? `## 今は使えないスキル\n${banned.join(', ')}` : '',
      '',
      'あなたの性格として自然な行動を 1 つ選んでください。候補以外のスキルでもかまいません。先に理由を 1〜2 文で書いてから、スキルを 1 つ呼んでください。',
    ].join('\n');
    const req = {
      model: this.cfg.llm.model,
      max_tokens: 4000,
      system: [{ type: 'text', text: `${personaPrompt(soc.persona, soc.traits)}\n夜は家に帰る・お腹がすいたら食べる、など生活の基本は守ってください。死ぬと持ち物を失います。`, cache_control: { type: 'ephemeral' } }],
      tools: this.tools,
      tool_choice: { type: 'auto', disable_parallel_tool_use: true },
      output_config: { effort: this.cfg.llm.effort },
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
    const res = req.betas ? await this.client.beta.messages.create(req) : await this.client.messages.create(req);
    if (res.stop_reason === 'refusal') throw new Error('リクエストが拒否された');
    const thought = res.content.filter((b) => b.type === 'text').map((b) => b.text).join(' ').trim();
    const call = res.content.find((b) => b.type === 'tool_use');
    if (!call) throw new Error(`スキルが選ばれなかった: ${thought.slice(0, 80)}`);
    const skill = SOCIETY_SKILL_MAP[call.name];
    if (!skill) throw new Error(`未知のスキル ${call.name}`);
    return { skill: call.name, args: sanitizeArgs(skill, call.input), thought, source: 'llm' };
  }
}
