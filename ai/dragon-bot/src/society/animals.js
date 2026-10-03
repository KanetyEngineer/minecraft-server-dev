// 動物との付き合い（ネットで集めたサバイバルの知識から足したもの）。
// - 羊は倒さずにハサミで毛を刈る（1〜3 枚取れ、草を食べるとまた生える）。ハサミは鉄 2 個
// - 動物は好物で繁殖する: 牛・羊・ヤギは小麦、豚はニンジン・ジャガイモ・ビートルート、ニワトリは種。繁殖のあと 5 分は繁殖しない
import { SkillError, abortable, goTo, craftItem, pickUpItems, exploreStep } from '../skills/common.js';
import { count, findItem } from '../util/items.js';
import { makeBed } from '../skills/overworld.js';
import { sleep } from '../body/humanize.js';

export const BREED_FOOD = {
  cow: ['wheat'], sheep: ['wheat'], goat: ['wheat'], mooshroom: ['wheat'],
  pig: ['carrot', 'potato', 'beetroot'], chicken: ['wheat_seeds', 'beetroot_seeds', 'melon_seeds', 'pumpkin_seeds'],
};

const near = (bot, name, r) => Object.values(bot.entities)
  .filter((e) => e.name === name && e.position.distanceTo(bot.entity.position) < r)
  .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position));

async function useOn(ctx, entity, item) {
  const { bot } = ctx;
  await goTo(ctx, entity.position.x, entity.position.y, entity.position.z, 2).catch(() => {});
  if (!entity.isValid || entity.position.distanceTo(bot.entity.position) > 4) return false;
  await bot.equip(item, 'hand');
  await bot.lookAt(entity.position.offset(0, entity.height ?? 1, 0), true).catch(() => {});
  await bot.activateEntity(entity).catch(() => {});
  await bot.waitForTicks(4);
  return true;
}

// 好物を 2 匹にあげて繁殖させる（同じ種類の動物が 2 匹以上近くにいるとき）
export async function breedAnimals(ctx, { animal } = {}) {
  const { bot } = ctx;
  const kinds = animal ? [animal] : Object.keys(BREED_FOOD);
  ctx.state.bredAt ??= {};
  for (const kind of kinds) {
    abortable(ctx);
    const food = (BREED_FOOD[kind] ?? []).map((n) => findItem(bot, n)).find((i) => i && i.count >= 2);
    if (!food) continue;
    if (Date.now() - (ctx.state.bredAt[kind] ?? 0) < 5 * 60_000) continue;
    const herd = near(bot, kind, 32);
    if (herd.length < 2) continue;
    let fed = 0;
    for (const e of herd.slice(0, 2)) if (await useOn(ctx, e, findItem(bot, food.name))) fed++;
    ctx.state.bredAt[kind] = Date.now();
    if (fed === 2) {
      ctx.society?.town.event('breed', `${ctx.society.persona.call}が${kind}を繁殖させた`);
      await sleep(3000);
      return `${kind} 2 匹に ${food.name} をあげて繁殖させた`;
    }
  }
  throw new SkillError('繁殖させられる動物と好物の組が近くに無い（牛・羊は小麦、豚はニンジン等、ニワトリは種を 2 個以上）');
}

// 羊の毛を刈ってベッドを作る（ハサミが無ければ鉄 2 個で作る。鉄も無ければ、いままでどおり羊を倒して羊毛を取る）
export async function shearSheep(ctx, { wool = 3 } = {}) {
  const { bot } = ctx;
  if (!findItem(bot, 'shears')) {
    if (count(bot, 'iron_ingot') >= 2) await craftItem(ctx, 'shears', 1).catch(() => {});
  }
  if (!findItem(bot, 'shears')) {
    await makeBed(ctx, { count: 1 });
    return 'ハサミが無いので羊を倒してベッドを作った';
  }
  const woolCount = () => Math.max(0, ...bot.inventory.items().filter((i) => i.name.endsWith('_wool')).map((i) => i.count));
  const done = new Set();
  for (let t = 0; t < 14 && woolCount() < wool; t++) {
    abortable(ctx);
    // 毛のある羊（刈ったばかりの羊は飛ばす）
    const sheep = near(bot, 'sheep', 40).find((e) => !done.has(e.id));
    if (!sheep) { await exploreStep(ctx, 32); continue; }
    done.add(sheep.id);
    await useOn(ctx, sheep, findItem(bot, 'shears'));
    await pickUpItems(ctx, 6).catch(() => {});
  }
  if (woolCount() < 3) throw new SkillError(`羊毛が 3 枚そろわない（${woolCount()} 枚）`);
  if (!bot.inventory.items().some((i) => i.name.endsWith('_bed'))) {
    const w = bot.inventory.items().filter((i) => i.name.endsWith('_wool')).sort((a, b) => b.count - a.count)[0];
    await craftItem(ctx, w.name.replace('_wool', '_bed'), 1).catch((e) => { throw new SkillError(`ベッドを作れなかった: ${e.message}`); });
  }
  return `羊の毛を刈ってベッドを作った（羊毛 ${woolCount()}）`;
}

