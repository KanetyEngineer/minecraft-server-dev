// 夜をやり過ごす: 地面に 2 マスの穴を掘ってこもり、頭上をふさいで朝を待つ。
// ベッドを持っていれば穴の底に置いて寝る（夜が明け、リスポーン地点も建築現場の近くになる）。
// DragonBot の shelterForNight（skills/overworld.js）から流用。
import { abortable, digOrRetry, isNextToLiquid, cheapBlock, pickUpItems, goals, Vec3 } from './common.js';
import { sleep } from '../body/humanize.js';

export async function shelterForNight(ctx, { untilHealed = false } = {}) {
  const { bot } = ctx;
  // untilHealed: 体力が少ないときに、昼でも穴にこもって回復を待つ（弱ったまま掘ったり戦ったりして死んでいた）
  if (bot.time.isDay && !untilHealed) return 'もう朝';
  const keepWaiting = untilHealed
    ? (start) => bot.health < 16 && Date.now() - start < 3 * 60_000
    : (start) => !bot.time.isDay && Date.now() - start < 9 * 60_000;
  bot.pathfinder.stop();
  // 建築範囲（BuilderBot が ctx.isBuildPos を付ける）のブロックは掘らない（建てた床に穴を開けていた）
  const solidSafe = (b) => b && b.boundingBox === 'block' && bot.canDigBlock(b) && !isNextToLiquid(bot, b.position)
    && !ctx.isBuildPos?.(b.position);
  // 足元から 4 段下まで固くて液体の無い場所か（木の上や洞窟の天井では掘らない）
  const diggableAt = (feet) => [1, 2, 3].every((d) => solidSafe(bot.blockAt(feet.offset(0, -d, 0))))
    && bot.blockAt(feet.offset(0, -4, 0))?.boundingBox === 'block';
  if (!diggableAt(bot.entity.position.floored())) {
    const ground = ['grass_block', 'dirt', 'stone', 'sand', 'coarse_dirt', 'podzol', 'deepslate', 'andesite', 'diorite', 'granite']
      .map((n) => bot.registry.blocksByName[n]?.id).filter((id) => id !== undefined);
    const spot = bot.findBlocks({ matching: ground, maxDistance: 16, count: 64 })
      .map((p) => p.offset(0, 1, 0))
      .find((f) => bot.blockAt(f)?.boundingBox === 'empty' && bot.blockAt(f.offset(0, 1, 0))?.boundingBox === 'empty' && diggableAt(f));
    if (spot) await bot.pathfinder.goto(new goals.GoalBlock(spot.x, spot.y, spot.z)).catch(() => {});
  }
  for (let i = 0; i < 3; i++) {
    abortable(ctx);
    const below = bot.blockAt(bot.entity.position.floored().offset(0, -1, 0));
    const under = below && bot.blockAt(below.position.offset(0, -1, 0));
    // 下が空洞・液体なら掘らない（洞窟や溶岩に落ちない）
    if (!solidSafe(below) || !under || under.boundingBox !== 'block' || under.name === 'lava') break;
    await bot.tool.equipForBlock(below, {}).catch(() => {});
    const y0 = bot.entity.position.y;
    if (!(await digOrRetry(bot, below, true))) continue;
    // 掘った直後はまだ落ちていないので、1 マス下に着地するまで待つ（待たないと次の「足元」が今掘った穴になる）
    for (let t = 0; t < 30 && !(bot.entity.onGround && bot.entity.position.y <= y0 - 0.9); t++) await bot.waitForTicks(1);
    if (bot.entity.position.y > y0 - 0.9) break;
  }
  // 頭上（足元 +2）を、穴の壁を足場にしてふさぐ
  const feet = bot.entity.position.floored();
  const cover = feet.offset(0, 2, 0);
  if (bot.blockAt(cover)?.boundingBox !== 'block') {
    const findCoverItem = () => cheapBlock(bot) ?? bot.inventory.items().find((i) => i.name.endsWith('_log') && !bot.keepForBuild?.(i.name)); // 丸石は最後（cheapBlock の順）
    let item = findCoverItem();
    // ふたにするブロックが無ければ、穴の壁（頭の高さ）を 1 つ掘って手に入れる
    if (!item) {
      const side = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([x, z]) => bot.blockAt(feet.offset(x, 1, z)))
        .find((b) => b && b.boundingBox === 'block' && bot.canDigBlock(b) && !isNextToLiquid(bot, b.position));
      if (side) {
        await bot.tool.equipForBlock(side, {}).catch(() => {});
        await bot.dig(side, true).catch(() => {});
        await sleep(1500); // 落ちたブロックを拾う
        item = findCoverItem();
      }
    }
    if (!item) ctx.log.warn('ふたにするブロックが無い');
    // 壁は上段（ふたの横）→ 下段（頭の横、上面に置く）の順に試す
    const walls = [
      ...[[1, 0], [-1, 0], [0, 1], [0, -1]].map(([x, z]) => ({ b: bot.blockAt(cover.offset(x, 0, z)), face: (b) => cover.minus(b.position) })),
      ...[[1, 0], [-1, 0], [0, 1], [0, -1]].map(([x, z]) => ({ b: bot.blockAt(cover.offset(x, -1, z)), face: () => new Vec3(0, 1, 0) })),
    ].filter(({ b }) => b && b.boundingBox === 'block');
    if (item && walls.length === 0) ctx.log.warn('ふたを支える壁が無い');
    for (const { b, face } of walls) {
      if (!item || bot.blockAt(cover)?.boundingBox === 'block') break;
      try {
        await bot.equip(item, 'hand');
        await bot.look(bot.entity.yaw, Math.PI / 2 * (face(b).y > 0 ? 0.5 : 0), true).catch(() => {});
        await bot.placeBlock(b, face(b));
      } catch (e) {
        ctx.log.warn(`ふたを置けなかった（${b.name} 側）: ${e.message}`);
      }
      // 下段の上面に置くと頭の高さに入るので、その場合はさらにその上がふたになる
      await bot.waitForTicks(4);
    }
  }
  const covered = bot.blockAt(cover)?.boundingBox === 'block';
  ctx.log.info(`🌙 穴にこもって朝を待つ（ふた ${covered ? 'あり' : 'なし'}）`);
  ctx.state.sheltered = covered; // ふたがある間は反射で飛び出さない（agent.js）
  const start = Date.now();

  try {
    const bedItem = bot.inventory.items().find((i) => i.name.endsWith('_bed'));
    if (bedItem && !untilHealed) {
      const slept = await sleepInShelter(ctx, feet, bedItem).catch((e) => {
        if (e.name === 'AbortError' || ctx.signal?.aborted) throw e;
        ctx.log.warn(`寝られなかった、朝まで待つ: ${e.message}`);
        return false;
      });
      if (slept) ctx.log.info('🛏 ベッドで寝て朝になった');
    }
    while (keepWaiting(start)) {
      abortable(ctx);
      await sleep(2000);
    }
  } finally {
    ctx.state.sheltered = false;
  }
  // ふたを掘って出る（出るのは次のスキルの移動に任せる）
  const lid = bot.blockAt(cover);
  if (covered && lid && bot.canDigBlock(lid)) {
    await bot.tool.equipForBlock(lid, {}).catch(() => {});
    await bot.dig(lid, true).catch(() => {});
  }
  if (untilHealed) return `穴で休んで体力 ${Math.round(bot.health)}/20 まで回復`;
  return bot.time.isDay ? '朝まで穴で過ごした' : '待ちきれず出た';
}

// 穴の底の横に 2 マス空けてベッドを置き、寝る。起きたらベッドを掘って持ち帰る。寝られたら true（DragonBot から流用）
async function sleepInShelter(ctx, feet, bedItem) {
  const { bot } = ctx;
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const a = feet.offset(dx, 0, dz);
    const b = feet.offset(dx * 2, 0, dz * 2);
    const floors = [a, b].map((q) => bot.blockAt(q.offset(0, -1, 0)));
    if (!floors.every((f) => f && f.boundingBox === 'block')) continue;
    if ([a, b].some((q) => isNextToLiquid(bot, q))) continue;
    for (const q of [a, b]) {
      const blk = bot.blockAt(q);
      if (blk && blk.boundingBox === 'block' && bot.canDigBlock(blk)) {
        await bot.tool.equipForBlock(blk, {}).catch(() => {});
        await bot.dig(blk, true).catch(() => {});
      }
    }
    if (![a, b].every((q) => bot.blockAt(q)?.boundingBox === 'empty')) continue;
    // ベッドは向いている方向に頭が伸びるので、穴の横方向を向いてから置く
    await bot.look(Math.atan2(-dx, -dz), -0.6, true);
    await bot.equip(bedItem, 'hand');
    await bot.placeBlock(floors[0], new Vec3(0, 1, 0));
    // 置いた直後は、ベッドのもう半分がまだ届いていないことがある（「there's only half bed」で寝られなかった）。
    // 両方そろうまで少し待ってから、頭の側のブロックで寝る
    let bed = null;
    for (let t = 0; t < 20; t++) {
      const blocks = [bot.blockAt(a), bot.blockAt(b)].filter((x) => x?.name?.endsWith('_bed'));
      if (blocks.length === 2) { bed = blocks.find((x) => x.getProperties?.().part === 'head') ?? blocks[0]; break; }
      await bot.waitForTicks(1);
    }
    bed ??= bot.blockAt(a);
    if (!bed || !bed.name.endsWith('_bed')) continue;
    try {
      await bot.sleep(bed);
      const t0 = Date.now();
      while (bot.isSleeping && Date.now() - t0 < 9 * 60_000) {
        abortable(ctx);
        await sleep(1000);
      }
      return true;
    } finally {
      // 寝られても寝られなくても、ベッドは回収して持ち歩く
      const placed = bot.blockAt(a);
      if (placed && placed.name.endsWith('_bed')) {
        await bot.dig(placed, true).catch(() => {});
        await sleep(400);
        await pickUpItems(ctx, 4).catch(() => {});
      }
    }
  }
  return false;
}