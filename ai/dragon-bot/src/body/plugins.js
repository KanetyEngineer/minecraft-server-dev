// 「体」の部分。基本操作はすべて既存の Mineflayer プラグインに任せる。
import pathfinderPkg from 'mineflayer-pathfinder';
import pvpPkg from 'mineflayer-pvp';
import collectPkg from 'mineflayer-collectblock';
import toolPkg from 'mineflayer-tool';
import armorManager from 'mineflayer-armor-manager';
import hawkeyePkg from 'minecrafthawkeye';
import { loader as autoEat } from 'mineflayer-auto-eat';

const { pathfinder, Movements } = pathfinderPkg;

// 足場として置いてよいブロック（通常のプレイヤーが橋や柱に使うもの）
export const SCAFFOLD_BLOCKS = [
  'cobblestone', 'cobbled_deepslate', 'dirt', 'netherrack', 'end_stone',
  'oak_planks', 'spruce_planks', 'birch_planks', 'stone', 'andesite', 'diorite', 'granite', 'blackstone',
];

export function loadPlugins(bot) {
  bot.loadPlugin(pathfinder);
  bot.loadPlugin(pvpPkg.plugin);
  bot.loadPlugin(collectPkg.plugin);
  bot.loadPlugin(toolPkg.plugin);
  loadArmorManagerSafely(bot);
  bot.loadPlugin(hawkeyePkg.default ?? hawkeyePkg);
  bot.loadPlugin(autoEat);
}

// armor-manager はアイテムを拾うたびに中身を読むが、サーバーによっては読み取りで例外が出て
// プロセスごと落ちる。拾ったときの処理だけ try/catch 付きのものに差し替える。
function loadArmorManagerSafely(bot) {
  const before = new Set(bot.listeners('playerCollect'));
  armorManager(bot);
  for (const l of bot.listeners('playerCollect')) {
    if (!before.has(l)) bot.removeListener('playerCollect', l);
  }
  bot.on('playerCollect', (collector) => {
    if (collector !== bot.entity) return;
    setTimeout(() => bot.armorManager.equipAll().catch(() => {}), 200);
  });
}

// spawn 後に呼ぶ。移動ルールを「普通のプレイヤーができること」に合わせる。
export function configureBody(bot) {
  const mv = new Movements(bot);
  mv.canDig = true;
  mv.allowParkour = true;
  mv.allowSprinting = true;
  mv.allow1by1towers = true;
  mv.allowFreeMotion = false;
  mv.dontCreateFlow = true; // 水や溶岩を流さないように掘る
  mv.scafoldingBlocks = SCAFFOLD_BLOCKS
    .map((n) => bot.registry.itemsByName[n]?.id)
    .filter((id) => id !== undefined);
  // 溶岩の近くや奈落ギリギリは避ける
  mv.maxDropDown = 4;
  bot.pathfinder.setMovements(mv);
  bot.pathfinder.thinkTimeout = 10000;

  // pvp プラグインも同じ移動ルールで追いかける
  if (bot.pvp) {
    bot.pvp.movements = mv;
    bot.pvp.followRange = 2.5;
  }
  if (bot.collectBlock) bot.collectBlock.movements = mv;

  // 防具は拾ったら自動で着る（armor-manager）
  // 空腹になったら自動で食べる（auto-eat）
  bot.autoEat.setOpts({
    priority: 'saturation',
    minHunger: 14,
    minHealth: 14,
    bannedFood: ['rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish', 'chorus_fruit', 'suspicious_stew'],
  });
  bot.autoEat.enableAuto();
  return mv;
}
