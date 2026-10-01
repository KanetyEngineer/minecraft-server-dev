// スキル一覧。LLM にはここの説明と引数の形がそのまま「道具」として渡る。
import * as ow from './overworld.js';
import * as nether from './nether.js';
import * as sh from './stronghold.js';
import * as end from './end.js';
import * as gen from './general.js';

const int = (description, minimum = 1, maximum = 640) => ({ type: 'integer', description, minimum, maximum });
const str = (description) => ({ type: 'string', description });

function def(name, run, description, properties = {}, required = []) {
  return { name, run, description, input_schema: { type: 'object', properties, required, additionalProperties: false } };
}

export const SKILLS = [
  // --- 大きな目標（中身は既存プラグインの組み合わせ）---
  def('gatherWood', ow.gatherWood, '木を切って原木を集める。最初なら作業台と木のツルハシも作る。', { logs: int('集める原木の数', 1, 64) }),
  def('makeTools', ow.makeTools, '木または石の道具一式（ツルハシ・剣・斧・シャベル）とかまどを作る。', { tier: { type: 'string', enum: ['wooden', 'stone'] } }),
  def('gatherFood', ow.gatherFood, '動物を狩って肉を集め、かまどで焼く。', { amount: int('目標の食料数', 1, 64) }),
  def('getIronGear', ow.getIronGear, '鉄を掘って精錬し、鉄のツルハシ・剣・バケツ（armor=true なら防具一式と盾も）を作る。', { armor: { type: 'boolean' } }),
  def('mineDiamonds', ow.mineDiamonds, 'Y=-58 付近でブランチマイニングしてダイヤを掘り、ダイヤのツルハシ（余れば剣）を作る。', { count: int('掘るダイヤの数', 1, 20) }),
  def('makeBowAndArrows', ow.makeBowAndArrows, 'クモ/クモの巣から糸、砂利から火打石、ニワトリから羽を集めて弓と矢を作る。エンドクリスタル破壊に必須。', { arrows: int('目標の矢の数', 4, 128) }),
  def('fillWaterBucket', ow.fillWaterBucket, '水源をバケツでくむ。'),
  def('collectObsidian', ow.collectObsidian, '溶岩溜まりに水をかけて黒曜石を作り、ダイヤのツルハシで掘る。', { count: int('黒曜石の数', 1, 20) }),
  def('buildNetherPortal', ow.buildNetherPortal, '黒曜石 10 個で近くにネザーポータルを建てて火打石で着火する。'),
  def('gatherBlocks', ow.gatherBlocks, '橋や柱に使う丸石を集める（エンドに行く前に 64 個以上推奨）。', { count: int('個数', 8, 256) }),
  def('makeBed', ow.makeBed, '羊を倒して羊毛を集め、ベッドを作る（count 個持つまで。エンドのベッド爆破用に 3〜5 個）。', { count: int('持っておくベッドの数', 1, 8) }),
  def('shelterForNight', ow.shelterForNight, '夜、防具が無いうちはその場で 3 マス掘り下がって頭上をふさぎ、朝まで待つ。'),
  def('sleepInBed', ow.sleepInBed, '夜にベッドで寝て朝にする（ベッドの場所も覚える）。'),
  def('enterNether', nether.enterNether, '覚えているネザーポータルからネザーへ入る。'),
  def('returnThroughPortal', nether.returnThroughPortal, 'ネザーからポータルを通ってオーバーワールドに戻る。'),
  def('huntBlazes', nether.huntBlazes, 'ネザー要塞を探し、ブレイズを倒してブレイズロッドを集める。', { rods: int('目標のロッド数', 1, 16) }),
  def('raidBastionGold', nether.raidBastionGold, '砦の遺跡（廃要塞）を探し、金ブロックや金を掘って金インゴットを集める（ピグリン交易の元手）。', { ingots: int('目標の金インゴット数', 8, 128) }),
  def('barterWithPiglins', nether.barterWithPiglins, '金インゴットを投げてピグリンと物々交換し、エンダーパールを狙う。', { pearls: int('目標のパール数', 1, 16) }),
  def('huntEndermen', nether.huntEndermen, 'エンダーマンを倒してエンダーパールを集める。ネザーで歪んだ森が見つかっていれば、ボートに乗せて捕まえてから倒す。', { pearls: int('目標のパール数', 1, 16) }),
  def('locateStronghold', sh.locateStronghold, 'エンダーアイを 2〜3 回投げて三角測量し、要塞の位置を推定する（オーバーワールド）。'),
  def('findEndPortal', sh.findEndPortal, '推定位置まで移動し、掘り下がって要塞とエンドポータルの部屋を探す。'),
  def('activateEndPortal', sh.activateEndPortal, 'エンドポータルの枠にエンダーアイをはめて起動し、ジ・エンドへ入る。'),
  def('destroyEndCrystals', end.destroyEndCrystals, 'エンドの柱の上のクリスタルを弓で壊す。檻付きは足場を積んで鉄格子を壊してから撃つ。'),
  def('fightDragon', end.fightDragon, 'エンダードラゴンと戦う。飛行中は弓、中央に着地したらベッド爆破（ベッドがあれば）か剣で頭を攻撃。', { minutes: int('戦う最大分数', 1, 30) }),
  def('celebrate', end.celebrate, '討伐をお祝いする。'),

  // --- 細かい操作 ---
  def('goToPlace', gen.goToPlace, '覚えている場所（place）または座標へ歩いて行く。', {
    place: str('覚えている場所の名前（knownPlaces のキー）'), x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' },
  }),
  def('mineBlock', gen.mineBlock, '見えている指定ブロックを掘る（カンマ区切りで複数可、例 "coal_ore,deepslate_coal_ore"）。', { block: str('ブロック名'), count: int('個数', 1, 64) }, ['block']),
  def('craft', gen.craft, 'アイテムを追加で作る（必要なら板材・棒・作業台も自動）。', { item: str('アイテム名（英語 ID）'), count: int('作る数', 1, 64) }, ['item']),
  def('craftTo', gen.craftTo, '所持数が count 個になるまでアイテムを作る（すでにあれば何もしない）。', { item: str('アイテム名（英語 ID）'), count: int('目標の所持数', 1, 64) }, ['item']),
  def('smeltItem', gen.smeltItem, 'かまどで精錬・調理する。', { item: str('材料のアイテム名'), count: int('数', 1, 64) }, ['item']),
  def('explore', gen.explore, '新しい場所を探して歩く。', { steps: int('歩く回数（1 回 約 40 ブロック）', 1, 10) }),
  def('attack', gen.attack, '近くの指定モブを倒す（カンマ区切り可）。', { mob: str('モブ名') }, ['mob']),
  def('collectDrops', gen.collectDrops, '近くに落ちているアイテムを拾う。'),
  def('recoverItems', gen.recoverItems, '最後に死んだ場所へ戻ってアイテムを回収する。'),
  def('remember', gen.remember, '今いる場所に名前を付けて覚える、またはメモを残す。', { name: str('場所の名前'), note: str('メモ') }),
  def('wait', gen.wait, '少し待つ（夜が明けるのを待つなど）。', { seconds: int('秒', 1, 120) }),
];

export const SKILL_MAP = Object.fromEntries(SKILLS.map((s) => [s.name, s]));

// Claude API の tools 形式
export function toolDefinitions() {
  return SKILLS.map(({ name, description, input_schema }) => ({ name, description, input_schema }));
}

// LLM から来た引数を軽く検査する（型違い・範囲外は直すか捨てる）
export function sanitizeArgs(skill, args) {
  const out = {};
  const props = skill.input_schema.properties;
  for (const [k, v] of Object.entries(args ?? {})) {
    const p = props[k];
    if (!p || v === null || v === undefined) continue;
    if (p.type === 'integer' || p.type === 'number') {
      const n = Number(v);
      if (!Number.isFinite(n)) continue;
      const r = p.type === 'integer' ? Math.round(n) : n;
      out[k] = Math.max(p.minimum ?? -Infinity, Math.min(p.maximum ?? Infinity, r));
    } else if (p.type === 'boolean') {
      out[k] = Boolean(v);
    } else if (p.type === 'string') {
      const s = String(v);
      if (p.enum && !p.enum.includes(s)) continue;
      out[k] = s;
    }
  }
  for (const r of skill.input_schema.required) {
    if (!(r in out)) throw new Error(`${skill.name} の引数 ${r} が無い`);
  }
  return out;
}
