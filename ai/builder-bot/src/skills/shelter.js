// 夜をやり過ごす: 地面に 2 マスの穴を掘ってこもり、頭上をふさいで朝を待つ。
// DragonBot の shelterForNight（skills/overworld.js）から、ベッドで寝る部分を除いて流用。
import { abortable, digOrRetry, isNextToLiquid, cheapBlock, goals, Vec3 } from './common.js';
import { sleep } from '../body/humanize.js';

export async function shelterForNight(ctx, { untilHealed = false } = {}) {
  const { bot } = ctx;
  // untilHealed: 体力が少ないときに、昼でも穴にこもって回復を待つ（弱ったまま掘ったり戦ったりして死んでいた）
  if (bot.time.isDay && !untilHealed) return 'もう朝';
  const keepWaiting = untilHealed
    ? (start) => bot.health < 16 && Date.now() - start < 3 * 60_000
    : (start) => !bot.time.isDay && Date.now() - start < 9 * 60_000;
  bot.pathfinder.stop();
  const solidSafe = (b) => b && b.boundingBox === 'block' && bot.canDigBlock(b) && !isNextToLiquid(bot, b.position);
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
    const findCoverItem = () => cheapBlock(bot) ?? bot.inventory.items().find((i) => i.name.endsWith('_log')); // 丸石は最後（cheapBlock の順）
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
