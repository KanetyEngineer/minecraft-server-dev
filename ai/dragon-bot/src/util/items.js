// インベントリ関連の小さな道具

export function count(bot, name) {
  return bot.inventory.items().filter((i) => i.name === name).reduce((s, i) => s + i.count, 0);
}

export function countMatching(bot, pred) {
  return bot.inventory.items().filter((i) => pred(i.name)).reduce((s, i) => s + i.count, 0);
}

export function has(bot, name, n = 1) {
  return count(bot, name) >= n;
}

export function findItem(bot, name) {
  return bot.inventory.items().find((i) => i.name === name);
}

export async function equipByName(bot, name, dest = 'hand') {
  const it = findItem(bot, name);
  if (!it) throw new Error(`${name} を持っていない`);
  await bot.equip(it, dest);
  return it;
}

const TIERS = ['netherite', 'diamond', 'iron', 'stone', 'golden', 'wooden'];

export function bestTool(bot, kind) {
  for (const t of TIERS) {
    const it = findItem(bot, `${t}_${kind}`);
    if (it) return it;
  }
  return null;
}

export function toolTier(bot, kind) {
  const it = bestTool(bot, kind);
  return it ? it.name.split('_')[0] : null;
}

export const LOGS = ['oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'mangrove_log', 'cherry_log'];
export const PLANKS = LOGS.map((l) => l.replace('_log', '_planks')).concat(['crimson_planks', 'warped_planks', 'bamboo_planks', 'pale_oak_planks']);
export const isLog = (n) => n.endsWith('_log') || n.endsWith('_stem');
export const isPlanks = (n) => n.endsWith('_planks');

export const FOODS = new Set([
  'cooked_beef', 'cooked_porkchop', 'cooked_mutton', 'cooked_chicken', 'cooked_rabbit', 'cooked_cod', 'cooked_salmon',
  'bread', 'baked_potato', 'golden_carrot', 'apple', 'carrot', 'beef', 'porkchop', 'mutton', 'chicken', 'rabbit',
  'cod', 'salmon', 'sweet_berries', 'melon_slice', 'cookie', 'pumpkin_pie', 'golden_apple',
]);
export const COOKED = new Set(['cooked_beef', 'cooked_porkchop', 'cooked_mutton', 'cooked_chicken', 'cooked_rabbit',
  'cooked_cod', 'cooked_salmon', 'bread', 'baked_potato', 'golden_carrot', 'pumpkin_pie']);

export function foodPoints(bot) {
  // 大まかな「食料の蓄え」。焼いた肉は 1 個 = 1、それ以外は 0.5。
  let s = 0;
  for (const i of bot.inventory.items()) {
    if (COOKED.has(i.name)) s += i.count;
    else if (FOODS.has(i.name)) s += i.count * 0.5;
  }
  return s;
}

export function emptySlots(bot) {
  return bot.inventory.emptySlotCount();
}
