// 「体」の部分。基本操作はすべて既存の Mineflayer プラグインに任せる。
import pathfinderPkg from 'mineflayer-pathfinder';
import pvpPkg from 'mineflayer-pvp';
import collectPkg from 'mineflayer-collectblock';
import toolPkg from 'mineflayer-tool';
import armorManager from 'mineflayer-armor-manager';
import hawkeyePkg from 'minecrafthawkeye';
import { loader as autoEat } from 'mineflayer-auto-eat';
import { lavaEdgeCost } from '../skills/lava.js';

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
  trackOwnAir(bot);
}

// 自分の酸素だけを見る。
// mineflayer は、どのエンティティの air_supply を受け取っても bot.oxygenLevel を書き換える（陸に上がった魚や
// 溺れているゾンビなどの値が入る）。そのため陸の上でも「酸素 0/20」になり、息継ぎの反射が誤って働いて作業が止まっていた。
// 自分のエンティティの値（メタデータ 1 番 = air_supply）だけを使い、mineflayer からの書き込みは無視する
export function trackOwnAir(bot) {
  let air = 20;
  bot._client.on('entity_metadata', (packet) => {
    if (!bot.entity || packet.entityId !== bot.entity.id) return;
    for (const m of packet.metadata) if (m.key === 1 && typeof m.value === 'number') air = Math.round(m.value / 15);
  });
  bot.on('respawn', () => { air = 20; });
  Object.defineProperty(bot, 'oxygenLevel', { configurable: true, enumerable: true, get: () => air, set: () => {} });
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
  // 掘る・置くは歩くより高コストにして、少し遠回りでも道があれば歩く（掘りながら進むと動きがぎこちなく、時間もかかる）
  mv.digCost = 4;
  mv.placeCost = 3;
  mv.scafoldingBlocks = SCAFFOLD_BLOCKS
    .map((n) => bot.registry.itemsByName[n]?.id)
    .filter((id) => id !== undefined);
  // 溶岩の近くや奈落ギリギリは避ける
  mv.maxDropDown = 4;
  // 溶岩のとなりを通るマスは高コストにして、少し遠回りでも溶岩から離れた道を選ぶ（滑り・ノックバックで落ちない）
  mv.exclusionAreasStep.push((block) => lavaEdgeCost(bot, block));
  // クモの巣は通らない（廃坑の毒グモスポナーの周りに多く、はまると毒グモに囲まれる）
  const cobweb = bot.registry.blocksByName.cobweb?.id;
  if (cobweb !== undefined) mv.blocksToAvoid.add(cobweb);
  bot.pathfinder.setMovements(mv);
  // 経路の途中で掘るときも、掘れるうちで一番安い道具を使う（pathfinder は一番速い道具＝鉄のツルハシを選び、
  // 移動中に石を掘って鉄のツルハシを使い潰していた）
  const fastestTool = bot.pathfinder.bestHarvestTool;
  const TIERS = ['wooden', 'stone', 'golden', 'iron', 'diamond', 'netherite'];
  bot.pathfinder.bestHarvestTool = (block) => {
    const items = bot.inventory.items();
    const hand = block.digTime(null, false, false, false);
    for (const tier of TIERS) {
      for (const kind of ['pickaxe', 'shovel', 'axe']) {
        const it = items.find((i) => i.name === `${tier}_${kind}`);
        if (it && block.canHarvest(it.type) && block.digTime(it.type, false, false, false) < hand) return it;
      }
    }
    return fastestTool(block);
  };
  // 採掘プラグイン（collectblock）や各スキルが使う bot.tool.equipForBlock も、掘れるうちで一番安い道具を持つようにする
  //（一番速い鉄のツルハシで石を掘り続けて使い潰し、鉄のツルハシを失っていた）。
  // ダイヤが要る黒曜石などは、安い道具では掘れない（canHarvest が false）ので、自然に鉄・ダイヤが選ばれる
  if (bot.tool?.equipForBlock) {
    const bestTool = bot.tool.equipForBlock.bind(bot.tool);
    bot.tool.equipForBlock = async (block, opts = {}) => {
      const cheap = block ? bot.pathfinder.bestHarvestTool(block) : null;
      if (cheap && block.canHarvest(cheap.type)) {
        if (bot.heldItem?.name !== cheap.name) await bot.equip(cheap, 'hand');
        return;
      }
      return bestTool(block, opts);
    };
  }
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
  // - 水面で上下に揺れて「水に入った・出た」が毎ティック切り替わると、ダッシュが入ったり切れたりしてぎこちないので、
  //   水から出て 10 ティックたつまでは泳ぎ続ける
  // - pathfinder は水中では常にジャンプ（浮上）するので、下の足場へ向かうときは沈めず止まっていた。次の地点が下なら沈む
  let floating = false;
  let swimSprint = false;
  let wetTicks = 0;
  let livePath = [];
  bot.on('path_update', (r) => { livePath = r?.path ?? []; });
  bot.on('goal_reached', () => { livePath = []; });
  bot.on('path_reset', () => { livePath = []; });
  // pathfinder は水中で毎ティック sprint=false にするので、泳いでいる間はそれを無視する
  const setCS = bot.setControlState.bind(bot);
  bot.setControlState = (ctl, state) => {
    if (ctl === 'sprint' && !state && swimSprint) return;
    setCS(ctl, state);
  };
  const WET = new Set(['water', 'kelp', 'kelp_plant', 'seagrass', 'tall_seagrass', 'bubble_column']);
  const isWet = (b) => !!b && (WET.has(b.name) || b.getProperties?.().waterlogged === true);
  bot.on('physicsTick', () => {
    if (!bot.entity || bot.vehicle) { wetTicks = 0; return; }
    const head = bot.blockAt(bot.entity.position.offset(0, 1.6, 0));
    const under = isWet(head);
    const inWater = bot.entity.isInWater;
    if (inWater) wetTicks = 10; else if (wetTicks > 0) wetTicks--;
    const moving = bot.getControlState('forward') || bot.pathfinder?.isMoving?.();
    // 移動中に水に入ったら必ず泳ぐ
    const longSwim = wetTicks > 0 && moving;
    if (longSwim) {
      if (!swimSprint) setCS('sprint', true); // 水中でのダッシュ = 泳ぎ
      swimSprint = true;
      if (inWater) {
        // prismarine-physics は泳ぎの速さを計算しないので、バニラ（減速 0.9 / 通常 0.8）に合わせて補正
        bot.entity.velocity.x *= 1.125;
        bot.entity.velocity.z *= 1.125;
      }
    } else if (swimSprint) {
      swimSprint = false;
      setCS('sprint', false);
    }
    const needAir = bot.oxygenLevel !== undefined && bot.oxygenLevel < 12;
    // 移動中: 次の地点が 1 マス以上下なら沈んで向かい、それ以外は水面近くを保つ（息が減ったら必ず浮上）
    if (longSwim && inWater) {
      const next = livePath[0];
      const diving = !needAir && next && next.y < bot.entity.position.y - 0.6;
      setCS('jump', !diving);
      floating = false;
      return;
    }
    // 止まっているときは、頭まで沈んだら浮く
    if (under) { setCS('jump', true); floating = true; }
    else if (floating) { setCS('jump', false); floating = false; }
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
  mv.allowParkour = !nether; // ネザーのすき間の下は溶岩が多いので、飛び越えずに回り道する
  mv.infiniteLiquidDropdownDistance = !nether; // ネザーの液体は溶岩なので「水に落ちれば安全」を無効化
  // 水の中は遅く、溺れやすく、ドラウンドもいるので、陸の道が少し遠いだけなら陸を通る
  mv.liquidCost = nether ? 50 : 3;
  const magma = bot.registry.blocksByName.magma_block?.id;
  if (magma !== undefined) { if (nether) mv.blocksToAvoid.add(magma); else mv.blocksToAvoid.delete(magma); }
}
