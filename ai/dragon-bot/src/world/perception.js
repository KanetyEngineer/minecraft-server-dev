// 今の状況を、LLM が読める短いテキスト/JSON にまとめる。
import { milestones, dimensionOf } from '../brain/progress.js';
import { findVisibleBlocks } from '../body/humanize.js';

const HOSTILE = new Set(['zombie', 'skeleton', 'creeper', 'spider', 'cave_spider', 'enderman', 'witch', 'drowned',
  'husk', 'stray', 'slime', 'magma_cube', 'blaze', 'ghast', 'piglin_brute', 'hoglin', 'zoglin', 'wither_skeleton',
  'phantom', 'pillager', 'vindicator', 'silverfish', 'endermite', 'ender_dragon', 'guardian', 'bogged', 'breeze']);
const ANIMALS = new Set(['cow', 'pig', 'sheep', 'chicken', 'rabbit', 'mooshroom', 'goat']);

export function isHostile(e) {
  return e && HOSTILE.has(e.name);
}

const NOTABLE = ['oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'cherry_log', 'mangrove_log',
  'coal_ore', 'iron_ore', 'deepslate_iron_ore', 'diamond_ore', 'deepslate_diamond_ore', 'gold_ore', 'deepslate_gold_ore',
  'lava', 'water', 'obsidian', 'gravel', 'crafting_table', 'furnace', 'chest', 'nether_bricks', 'spawner',
  'end_portal_frame', 'stone_bricks', 'nether_portal', 'red_bed', 'white_bed', 'cobweb'];

function rounded(p) {
  return { x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) };
}

export function snapshot(bot, memory, cfg) {
  const pos = bot.entity.position;
  const inv = {};
  for (const i of bot.inventory.items()) inv[i.name] = (inv[i.name] ?? 0) + i.count;

  const entities = Object.values(bot.entities)
    .filter((e) => e !== bot.entity && e.position && e.position.distanceTo(pos) < 32)
    .map((e) => ({ name: e.name ?? e.username ?? e.type, dist: Math.round(e.position.distanceTo(pos)),
      kind: e.type === 'player' ? 'player' : isHostile(e) ? 'hostile' : ANIMALS.has(e.name) ? 'animal' : 'other' }))
    .filter((e) => e.kind !== 'other' || ['item', 'end_crystal', 'eye_of_ender', 'piglin'].includes(e.name))
    .sort((a, b) => a.dist - b.dist)
    .slice(0, 15);

  const seen = {};
  for (const b of findVisibleBlocks(bot, NOTABLE, { maxDistance: 32, count: 60, visibleOnly: cfg.human.visibleOnly })) {
    if (seen[b.name]) continue;
    seen[b.name] = { ...rounded(b.position), dist: Math.round(b.position.distanceTo(pos)) };
  }

  const m = milestones(bot, memory);
  const { _counts, ...flags } = m;
  return {
    position: rounded(pos),
    dimension: dimensionOf(bot),
    health: Math.round(bot.health),
    food: bot.food,
    timeOfDay: bot.time?.timeOfDay,
    isDay: bot.time?.isDay,
    holding: bot.heldItem?.name ?? null,
    armor: [5, 6, 7, 8].map((s) => bot.inventory.slots[s]?.name).filter(Boolean),
    inventory: inv,
    emptySlots: bot.inventory.emptySlotCount(),
    nearbyEntities: entities,
    visibleBlocks: seen,
    knownPlaces: memory.data.places,
    notes: memory.data.notes.slice(-8).map((n) => n.text),
    lastDeath: memory.data.deaths.at(-1) ?? null,
    milestones: flags,
    counts: _counts,
  };
}
