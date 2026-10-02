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

// 持ち物がいっぱいのときに捨てる物と、残す数
const JUNK_KEEP = {
  cobblestone: 64, cobbled_deepslate: 32, dirt: 32, netherrack: 64, andesite: 0, diorite: 0, granite: 0, tuff: 0, calcite: 0,
  gravel: 8, sand: 8, red_sand: 0, deepslate: 0, blackstone: 32, basalt: 0, rotten_flesh: 8, poisonous_potato: 0, wheat_seeds: 0,
  red_tulip: 0, dandelion: 0, poppy: 0, leaf_litter: 0, birch_button: 0, flint: 8, raw_copper: 0, copper_ingot: 0,
};
export function dropPlan(items) {
  const totals = new Map();
  for (const i of items) totals.set(i.name, (totals.get(i.name) ?? 0) + i.count);
  const out = [];
  for (const [name, total] of totals) {
    const keep = JUNK_KEEP[name] ?? (/_sapling$/.test(name) ? 0 : undefined);
    if (keep === undefined || total <= keep) continue;
    out.push({ name, count: total - keep });
  }
  return out;
}


// 落ちている物を拾うか: 捨てる物の一覧にあって、すでに残す数以上持っている物は拾わない（捨てた物を拾い直さない）
export function wantsPickup(bot, name) {
  const keep = JUNK_KEEP[name] ?? (/_sapling$/.test(name) ? 0 : undefined);
  if (keep === undefined) return true;
  return count(bot, name) < keep;
}
