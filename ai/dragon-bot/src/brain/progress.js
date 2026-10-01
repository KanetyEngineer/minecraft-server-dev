// エンダードラゴン討伐までの道のり（技術ツリー）を、インベントリと記憶から判定する。
// LLM にはこの進捗を「参考情報」として渡し、ルールベース（LLM なし）ではこの順に進める。
import { count, countMatching, foodPoints, findItem } from '../util/items.js';

const has = (bot, n, c = 1) => count(bot, n) >= c;
const anyOf = (bot, names) => names.some((n) => has(bot, n));

export function milestones(bot, memory) {
  const eyes = count(bot, 'ender_eye');
  const placedEyes = memory.flag('eyesPlaced') ?? 0;
  const eyesNeeded = Math.max(0, 12 - placedEyes);
  const rods = count(bot, 'blaze_rod') + Math.floor(count(bot, 'blaze_powder') / 2);
  const pearls = count(bot, 'ender_pearl');
  const dim = dimensionOf(bot);
  const armorPieces = ['helmet', 'chestplate', 'leggings', 'boots']
    .filter((p) => bot.inventory.slots.some((s) => s && /^(iron|diamond|netherite)_/.test(s.name) && s.name.endsWith(p)))
    .length;

  return {
    woodenTools: anyOf(bot, ['wooden_pickaxe', 'stone_pickaxe', 'iron_pickaxe', 'diamond_pickaxe']),
    stoneTools: anyOf(bot, ['stone_pickaxe', 'iron_pickaxe', 'diamond_pickaxe'])
      && anyOf(bot, ['stone_sword', 'iron_sword', 'diamond_sword']),
    food: foodPoints(bot) >= 10,
    ironPickaxe: anyOf(bot, ['iron_pickaxe', 'diamond_pickaxe']),
    ironSword: anyOf(bot, ['iron_sword', 'diamond_sword']),
    shield: has(bot, 'shield'),
    armor: armorPieces >= 3,
    bucket: anyOf(bot, ['bucket', 'water_bucket', 'lava_bucket']),
    waterBucket: has(bot, 'water_bucket'),
    diamondPickaxe: has(bot, 'diamond_pickaxe'),
    bow: has(bot, 'bow'),
    arrows: count(bot, 'arrow') >= 32,
    obsidian: count(bot, 'obsidian') >= 10 || !!memory.getPlace('overworld_portal'),
    flintAndSteel: has(bot, 'flint_and_steel') || !!memory.getPlace('overworld_portal'),
    netherPortal: !!memory.getPlace('overworld_portal'),
    blazeRods: rods >= Math.ceil(eyesNeeded / 2) || eyes >= eyesNeeded,
    enderPearls: pearls + eyes >= eyesNeeded,
    enderEyes: eyes >= eyesNeeded,
    strongholdLocated: !!memory.getPlace('stronghold_estimate') || !!memory.getPlace('end_portal'),
    endPortalFound: !!memory.getPlace('end_portal'),
    inEnd: dim === 'the_end',
    crystalsDestroyed: !!memory.flag('crystalsDestroyed'),
    dragonDefeated: !!memory.flag('dragonDefeated'),
    // 補足の数字
    _counts: { eyes, eyesNeeded, rods, pearls, arrows: count(bot, 'arrow'), obsidian: count(bot, 'obsidian'),
      diamonds: count(bot, 'diamond'), iron: count(bot, 'iron_ingot') + count(bot, 'raw_iron'),
      food: foodPoints(bot), logs: countMatching(bot, (n) => n.endsWith('_log')) },
  };
}

export function dimensionOf(bot) {
  return String(bot.game?.dimension ?? 'overworld').replace('minecraft:', '');
}

// ルールベースの進め方: 上から順に、まだ満たしていない最初の項目に対応するスキルを返す。
// skill と args は skills/index.js に登録された名前と同じ。
export function nextStep(bot, memory) {
  const m = milestones(bot, memory);
  const dim = dimensionOf(bot);
  const c = m._counts;
  const night = bot.time && !bot.time.isDay;

  if (m.dragonDefeated) return { skill: 'celebrate', args: {} };
  // 死んだら、落とした物が消える（5 分）前に拾いに戻る
  const death = memory.data?.deaths?.at(-1);
  if (death && !death.recovered && death.dimension === dim && Date.now() - Date.parse(death.at) < 4 * 60_000) {
    return { skill: 'recoverItems', args: {} };
  }
  if (dim === 'the_end') {
    if (!m.crystalsDestroyed) return { skill: 'destroyEndCrystals', args: {} };
    return { skill: 'fightDragon', args: {} };
  }
  if (dim === 'the_nether') {
    // 歪んだ森が先に見つかったら、そこでエンダーマンをボートに乗せて倒してパールを集める（huntEndermen 内）
    noteWarpedForest(bot, memory);
    if (!m.enderPearls && memory.getPlace('warped_forest') && hasBoat(bot)) {
      return { skill: 'huntEndermen', args: { pearls: c.eyesNeeded - c.pearls - c.eyes } };
    }
    if (!m.blazeRods) return { skill: 'huntBlazes', args: { rods: Math.ceil(c.eyesNeeded / 2) } };
    if (!m.enderPearls && count(bot, 'gold_ingot') >= 8) return { skill: 'barterWithPiglins', args: { pearls: c.eyesNeeded - c.pearls - c.eyes } };
    return { skill: 'returnThroughPortal', args: {} };
  }

  // 流れはエンドラ RTA を参考にする（https://minecraft-rta.playing.wiki の「エンドラRTAの流れ」）:
  //   オーバーワールドの準備は最小限 → ネザーでブレイズロッド（金があればピグリン交易でパール）
  //   → 戻って夜にエンダーマン狩りでパール → エンダーアイ → 要塞 → エンド。弓は最後（エンドの前）でよい。
  //   ただしボットの生存のため、鉄の防具と盾はネザーの前にそろえる。黒曜石を掘るためダイヤのツルハシも作る。

  // 夜は穴にこもる（ベッドがあれば中で寝る）。ただし防具があってパール集めの段階なら、夜はエンダーマン狩りの時間
  if (night) {
    if (m.armor && m.blazeRods && !m.enderPearls) return { skill: 'huntEndermen', args: { pearls: c.eyesNeeded - c.pearls - c.eyes } };
    return { skill: 'shelterForNight', args: {} };
  }
  if (!m.woodenTools) return { skill: 'gatherWood', args: { logs: 8 } };
  if (!m.stoneTools) return { skill: 'makeTools', args: { tier: 'stone' } };
  if (!m.food) return { skill: 'gatherFood', args: { amount: 12 } };
  // 昼のうちにベッドを作っておく（羊が見つからなければしばらく飛ばす）
  const hasBed = bot.inventory.items().some((i) => i.name.endsWith('_bed'));
  if (!hasBed && !((memory.flag('bedRetryAt') ?? 0) > Date.now())) return { skill: 'makeBed', args: {} };
  if (!m.ironPickaxe || !m.ironSword || !m.bucket) return { skill: 'getIronGear', args: { armor: false } };
  if (!m.armor || !m.shield) return { skill: 'getIronGear', args: { armor: true } };
  if (!m.waterBucket) return { skill: 'fillWaterBucket', args: {} };
  if (!m.netherPortal) {
    // ネザーの板材ではボートを作れないので、歪んだ森でのエンダーマン捕獲用に 1 つ持っていく
    if (!hasBoat(bot)) {
      const boat = boatRecipeFor(bot);
      return boat ? { skill: 'craftTo', args: { item: boat, count: 1 } } : { skill: 'gatherWood', args: { logs: 4 } };
    }
    // RTA 式: ダイヤを使わず、溶岩溜まりで溶岩バケツと水バケツから黒曜石を作ってゲートを建てる（castNetherPortal）。
    // 水入りバケツのほかに空のバケツがもう 1 つ要るので、鉄 3 個を先に用意する。
    // 3 回続けて失敗したら、従来どおりダイヤのツルハシで黒曜石を掘る方式に切り替える。
    if ((memory.flag('castNetherPortalFails') ?? 0) < 3 && !m.obsidian) {
      const buckets = count(bot, 'bucket') + count(bot, 'water_bucket') + count(bot, 'lava_bucket');
      if (buckets < 2) {
        if (count(bot, 'iron_ingot') >= 3) return { skill: 'craftTo', args: { item: 'bucket', count: 1 } };
        if (count(bot, 'raw_iron') + count(bot, 'iron_ingot') >= 3) return { skill: 'smeltItem', args: { item: 'raw_iron', count: 3 - count(bot, 'iron_ingot') } };
        return { skill: 'mineBlock', args: { block: 'iron_ore,deepslate_iron_ore', count: 3 - count(bot, 'raw_iron') - count(bot, 'iron_ingot') } };
      }
      return { skill: 'castNetherPortal', args: {} };
    }
    if (!m.obsidian && !m.diamondPickaxe) return { skill: 'mineDiamonds', args: { count: 3 } };
    if (!m.obsidian) return { skill: 'collectObsidian', args: { count: 10 } };
    if (!m.flintAndSteel) return { skill: 'craftTo', args: { item: 'flint_and_steel', count: 1 } };
    return { skill: 'buildNetherPortal', args: {} };
  }
  if (!m.enderEyes) {
    if (!m.blazeRods) return { skill: 'enterNether', args: {} };
    if (!m.enderPearls) return { skill: 'huntEndermen', args: { pearls: c.eyesNeeded - c.pearls - c.eyes } };
    return { skill: 'craftTo', args: { item: 'ender_eye', count: c.eyesNeeded } };
  }
  // 弓と矢はエンドのクリスタル用なので、要塞に向かう前にそろえる
  if (!m.bow || !m.arrows) return { skill: 'makeBowAndArrows', args: { arrows: 32 } };
  if (!m.strongholdLocated) return { skill: 'locateStronghold', args: {} };
  if (!m.endPortalFound) return { skill: 'findEndPortal', args: {} };
  // エンドのドラゴン戦（ベッド爆破）用に、ベッドを 4 個持ってから入る（羊が見つからなければ飛ばす）
  const bedCount = bot.inventory.items().filter((i) => i.name.endsWith('_bed')).reduce((s, i) => s + i.count, 0);
  if (bedCount < 4 && !((memory.flag('bedRetryAt') ?? 0) > Date.now())) return { skill: 'makeBed', args: { count: 4 } };
  return { skill: 'activateEndPortal', args: {} };
}

export function heldSummary(bot) {
  const h = bot.heldItem;
  return h ? h.name : 'なし';
}

export { findItem };

const isBoatItem = (n) => n.endsWith('_boat') && !n.includes('chest');
export const hasBoat = (bot) => bot.inventory.items().some((i) => isBoatItem(i.name));

// 持っている原木・板材から作れるボート名（同じ種類の板材 5 枚 = 原木 2 本）。作れなければ null
export function boatRecipeFor(bot) {
  const items = bot.inventory.items();
  const ok = (type) => !['crimson', 'warped', 'bamboo'].includes(type);
  const planks = items.find((i) => i.name.endsWith('_planks') && i.count >= 5 && ok(i.name.replace('_planks', '')));
  if (planks) return planks.name.replace('_planks', '_boat');
  const log = items.find((i) => /_log$/.test(i.name) && !i.name.startsWith('stripped_') && i.count >= 2 && ok(i.name.replace('_log', '')));
  return log ? log.name.replace('_log', '_boat') : null;
}

// ネザーで歪んだナイリウムがまとまって見えたら歪んだ森として覚える（毎回呼ぶ軽い処理）
export function noteWarpedForest(bot, memory) {
  if (typeof bot.findBlocks !== 'function' || !memory.setPlace || memory.getPlace('warped_forest')) return;
  const id = bot.registry?.blocksByName?.warped_nylium?.id;
  if (id === undefined) return;
  const found = bot.findBlocks({ matching: id, maxDistance: 48, count: 12 });
  if (found.length >= 12) memory.setPlace('warped_forest', found[0], 'the_nether');
}