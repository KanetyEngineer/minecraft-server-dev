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
  bot.on('spawn', () => tuneMovementsForDimension(bot));
  tuneMovementsForDimension(bot);
  // 掘削・塔積み込みの経路探索は範囲を絞らないとノードが膨れ、ヒープ不足で落ちる。
  // 長距離は travelTo が 64 ブロックずつ区切るので、半径 128 で足りる。
  bot.pathfinder.thinkTimeout = 5000;
  bot.pathfinder.searchRadius = 128;

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

  // 掘っている最中に食事で持ち物を持ち替えると採掘が中断されるので、掘っている間は自動で食べない
  const dig = bot.dig.bind(bot);
  bot.dig = async (...args) => {
    const wasOn = bot.autoEat.enabled;
    if (wasOn) bot.autoEat.disableAuto();
    try {
      return await dig(...args);
    } finally {
      if (wasOn) bot.autoEat.enableAuto();
    }
  };

  // 泳ぐ:
  // - 頭まで水に浸かったら浮き上がる（溺れない・沈まない）
  // - 移動中に水に触れたら、必ずダッシュ泳ぎで進む
  let floating = false;
  let swimSprint = false;
  // pathfinder は水中で毎ティック sprint=false にするので、泳いでいる間はそれを無視する
  const setCS = bot.setControlState.bind(bot);
  bot.setControlState = (ctl, state) => {
    if (ctl === 'sprint' && !state && swimSprint) return;
    setCS(ctl, state);
  };
  bot.on('physicsTick', () => {
    if (!bot.entity || bot.vehicle) return;
    const head = bot.blockAt(bot.entity.position.offset(0, 1.6, 0));
    const under = !!head && head.name === 'water';
    const moving = bot.getControlState('forward') || bot.pathfinder?.isMoving?.();
    // 移動中に水に入ったら必ず泳ぐ
    const longSwim = bot.entity.isInWater && moving;
    if (longSwim) {
      if (!swimSprint) setCS('sprint', true); // 水中でのダッシュ = 泳ぎ
      swimSprint = true;
      // prismarine-physics は泳ぎの速さを計算しないので、バニラ（減速 0.9 / 通常 0.8）に合わせて補正
      bot.entity.velocity.x *= 1.125;
      bot.entity.velocity.z *= 1.125;
    } else if (swimSprint) {
      swimSprint = false;
      setCS('sprint', false);
    }
    // 泳いでいる間は水面近くを保ち、息が減ったら必ず浮上する
    const needAir = bot.oxygenLevel !== undefined && bot.oxygenLevel < 10;
    if (under && (!longSwim || needAir)) { bot.setControlState('jump', true); floating = true; }
    else if (floating) { bot.setControlState('jump', false); floating = false; }
  });
  return mv;
}

// 次元ごとの移動ルール。ネザーでは落下と溶岩が最大の死因なので、崖を降りず、液体を強く避け、
// 少し遠回りでも平らで開けた地形を通る（RTA 走者の定石）。
export function tuneMovementsForDimension(bot) {
  const mv = bot.pathfinder?.movements;
  if (!mv) return;
  const nether = bot.game?.dimension?.includes('nether');
  mv.maxDropDown = nether ? 3 : 4;
  mv.infiniteLiquidDropdownDistance = !nether; // ネザーの液体は溶岩なので「水に落ちれば安全」を無効化
  mv.liquidCost = nether ? 50 : 1;
  const magma = bot.registry.blocksByName.magma_block?.id;
  if (magma !== undefined) { if (nether) mv.blocksToAvoid.add(magma); else mv.blocksToAvoid.delete(magma); }
}
