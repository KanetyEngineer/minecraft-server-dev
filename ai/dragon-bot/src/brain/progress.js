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
    if (!m.blazeRods) return { skill: 'huntBlazes', args: { rods: Math.ceil(c.eyesNeeded / 2) } };
    if (!m.enderPearls && count(bot, 'gold_ingot') >= 8) return { skill: 'barterWithPiglins', args: { pearls: c.eyesNeeded - c.pearls - c.eyes } };
    return { skill: 'returnThroughPortal', args: {} };
  }

  if (!m.woodenTools) return { skill: 'gatherWood', args: { logs: 8 } };
  if (!m.stoneTools) return { skill: 'makeTools', args: { tier: 'stone' } };
  if (!m.food) return { skill: 'gatherFood', args: { amount: 12 } };
  if (night && memory.getPlace('bed')) return { skill: 'sleepInBed', args: {} };
  if (!m.ironPickaxe || !m.ironSword || !m.bucket) return { skill: 'getIronGear', args: { armor: false } };
  if (!m.armor || !m.shield) return { skill: 'getIronGear', args: { armor: true } };
  if (!m.diamondPickaxe) return { skill: 'mineDiamonds', args: { count: 3 } };
  if (!m.bow || !m.arrows) return { skill: 'makeBowAndArrows', args: { arrows: 32 } };
  if (!m.waterBucket) return { skill: 'fillWaterBucket', args: {} };
  if (!m.netherPortal) {
    if (!m.obsidian) return { skill: 'collectObsidian', args: { count: 10 } };
    if (!m.flintAndSteel) return { skill: 'craftTo', args: { item: 'flint_and_steel', count: 1 } };
    return { skill: 'buildNetherPortal', args: {} };
  }
  if (!m.enderEyes) {
    if (!m.blazeRods) return { skill: 'enterNether', args: {} };
    if (!m.enderPearls) return { skill: 'huntEndermen', args: { pearls: c.eyesNeeded - c.pearls - c.eyes } };
    return { skill: 'craftTo', args: { item: 'ender_eye', count: c.eyesNeeded } };
  }
  if (!m.strongholdLocated) return { skill: 'locateStronghold', args: {} };
  if (!m.endPortalFound) return { skill: 'findEndPortal', args: {} };
  return { skill: 'activateEndPortal', args: {} };
}

export function heldSummary(bot) {
  const h = bot.heldItem;
  return h ? h.name : 'なし';
}

export { findItem };
