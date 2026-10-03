// 社会モードで使うスキルの一覧。DragonBot の基本スキル（木・道具・食料・採掘など）に、社会生活のスキルを足す。
// Claude にはここの説明と引数の形がそのまま「道具」として渡る。
import { SKILL_MAP } from '../skills/index.js';
import * as soc from './skills.js';
import * as animals from './animals.js';

const int = (description, minimum = 1, maximum = 64) => ({ type: 'integer', description, minimum, maximum });
const str = (description) => ({ type: 'string', description });

function def(name, run, description, properties = {}, required = []) {
  return { name, run, description, input_schema: { type: 'object', properties, required, additionalProperties: false } };
}

// DragonBot から借りる基本スキル（エンドラ討伐専用のもの・ネザー関係は使わない）
const BASIC = ['gatherWood', 'makeTools', 'gatherFood', 'getIronGear', 'makeBed', 'shelterForNight', 'gatherBlocks',
  'explore', 'mineBlock', 'craftTo', 'smeltItem', 'attack', 'collectDrops', 'recoverItems', 'comeToPlayer', 'wait', 'fillWaterBucket'];

export const SOCIETY_SKILLS = [
  ...BASIC.map((n) => SKILL_MAP[n]).filter(Boolean),
  def('buildHouse', soc.buildHouse, '広場のまわりの自分の区画に、5×5 の家（壁・屋根・扉・明かり・作業台・チェスト・ベッド）を建てる。材料が足りなければ木を切って板材にする。何回かに分けて進めてよい。'),
  def('goHome', soc.goHome, '自分の家に帰る。夜ならベッドで寝る（ベッドが無ければ家の中で朝を待つ）。'),
  def('tendFarm', soc.tendFarm, '家の裏の 3×3 の畑を世話する: 真ん中に水を引き（畑は水から 4 マス以内でないと乾いて作れないので、水入りバケツか、鉄 3 個で作るバケツが要る）、草を刈って種を集め、鍬で耕して小麦を植え、実ったら収穫してパンを作る。'),
  def('depositToStorage', soc.depositToStorage, '広場の共同倉庫（無ければ作る）に、自分の取り分を残して余った食料・木材・石・鉄などを入れる。'),
  def('takeFromStorage', soc.takeFromStorage, '共同倉庫から物を出す（困ったときだけ）。', { item: str('food / planks / logs / アイテム名'), count: int('数', 1, 32) }),
  def('socialize', soc.socialize, '町の住人のそばへ行って話しかける（あいさつと世間話）。with を省くと、仲の良さと近さから相手を選ぶ。', { with: str('話しかける住人のゲーム内の名前') }),
  def('giveGift', soc.giveGift, '住人のそばへ行って物を渡す（food / planks / logs / アイテム名）。', { to: str('相手のゲーム内の名前'), item: str('渡す物'), count: int('数', 1, 32) }, ['to']),
  def('callMeeting', soc.callMeeting, '広場で集会を開いてみんなを呼び、集まった人に仕事を割り振る（まとめ役向け）。', { topic: str('話し合うこと') }),
  def('attendMeeting', soc.attendMeeting, '誰かが開いている集会に出る（広場へ行き、終わるまでいる）。'),
  def('postNotice', soc.postNotice, '広場の掲示板に貼り紙をする（募集・おしらせ・自己紹介など）。', { text: str('貼り紙の文（60 文字くらいまで）') }),
  def('breedAnimals', animals.breedAnimals, '近くの同じ種類の動物 2 匹に好物をあげて繁殖させる（牛・羊は小麦、豚はニンジン・ジャガイモ、ニワトリは種。5 分は再び繁殖しない）。食料と羊毛を絶やさないため。', { animal: str('cow / sheep / pig / chicken（省略可）') }),
  def('shearSheep', animals.shearSheep, '羊を倒さずにハサミ（鉄 2 個）で毛を刈ってベッドを作る（毛はまた生える）。ハサミも鉄も無ければ羊を倒して羊毛を取る。', { wool: int('集める羊毛の数', 3, 16) }),
  def('lightHome', soc.lightHome, '家の中と家のまわりに松明を置く（暗い所にしか敵は湧かない）。石炭・木炭が無ければ原木を焼いて木炭を作る。'),
  def('goToPlaza', soc.goToPlaza, '広場へ行って掲示板を読む。'),
  def('say', soc.chatSay, 'チャットで発言する（みんなに呼びかける・意見を言うなど）。', { message: str('発言（40 文字くらいまで）') }, ['message']),
];

export const SOCIETY_SKILL_MAP = Object.fromEntries(SOCIETY_SKILLS.map((s) => [s.name, s]));

export function societyToolDefinitions() {
  return SOCIETY_SKILLS.map(({ name, description, input_schema }) => ({ name, description, input_schema }));
}
