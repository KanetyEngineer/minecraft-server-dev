// LLM が細かく組み合わせるための汎用スキル
import {
  SkillError, mineBlocks, craftItem, smelt, attackEntity, pickUpItems, exploreStep, travelTo, goTo, nearestEntityNamed, dim,
} from './common.js';
import { count } from '../util/items.js';
import { sleep } from '../body/humanize.js';

export async function goToPlace(ctx, { place, x, y, z } = {}) {
  if (place) {
    const p = ctx.memory.getPlace(place);
    if (!p) throw new SkillError(`場所「${place}」を知らない`);
    if (p.dimension && p.dimension !== dim(ctx)) throw new SkillError(`「${place}」は ${p.dimension} にある（今は ${dim(ctx)}）`);
    ({ x, y, z } = p);
  }
  if (x === undefined || z === undefined) throw new SkillError('行き先が無い');
  await travelTo(ctx, x, z, { range: 3 });
  if (y !== undefined && y !== null) await goTo(ctx, x, y, z, 2).catch(() => {});
  return `到着 (${Math.round(ctx.bot.entity.position.x)}, ${Math.round(ctx.bot.entity.position.y)}, ${Math.round(ctx.bot.entity.position.z)})`;
}

export async function mineBlock(ctx, { block, count: n = 1 } = {}) {
  const names = block.split(',').map((s) => s.trim());
  const got = await mineBlocks(ctx, names, n);
  if (got === 0) throw new SkillError(`${block} が見つからなかった`);
  return `${block} を ${got} 個掘った`;
}

export async function craft(ctx, { item, count: n = 1 } = {}) {
  await craftItem(ctx, item, count(ctx.bot, item) + n);
  return `${item} を作った（所持 ${count(ctx.bot, item)}）`;
}

export async function craftTo(ctx, { item, count: n = 1 } = {}) {
  await craftItem(ctx, item, n);
  return `${item} 所持 ${count(ctx.bot, item)}`;
}

export async function smeltItem(ctx, { item, count: n = 1 } = {}) {
  const got = await smelt(ctx, item, n);
  return `${item} を ${got} 個精錬した`;
}

export async function explore(ctx, { steps = 3 } = {}) {
  for (let i = 0; i < steps; i++) await exploreStep(ctx, 40);
  return '探索した';
}

export async function attack(ctx, { mob } = {}) {
  const e = nearestEntityNamed(ctx.bot, mob.split(',').map((s) => s.trim()), 32);
  if (!e) throw new SkillError(`${mob} が近くにいない`);
  const killed = await attackEntity(ctx, e);
  await pickUpItems(ctx);
  return killed ? `${mob} を倒した` : `${mob} を倒しきれなかった`;
}

export async function collectDrops(ctx) {
  await pickUpItems(ctx, 12);
  return '落ちているアイテムを拾った';
}

export async function chat(ctx, { message } = {}) {
  ctx.say?.(message);
  return '発言した';
}

export async function remember(ctx, { name, note } = {}) {
  if (name) ctx.memory.setPlace(name, ctx.bot.entity.position, dim(ctx));
  if (note) ctx.memory.note(note);
  return '覚えた';
}

export async function wait(ctx, { seconds = 10 } = {}) {
  await sleep(Math.min(seconds, 120) * 1000);
  return `${seconds} 秒待った`;
}

// 死んだ場所に戻ってアイテムを回収する
export async function recoverItems(ctx) {
  const d = ctx.memory.data.deaths.at(-1);
  if (!d) throw new SkillError('死亡記録がない');
  if (d.dimension !== dim(ctx)) throw new SkillError(`死んだのは ${d.dimension}`);
  // 失敗しても同じ死亡地点を何度も目指さないよう、1 回試したら済みにする
  d.recovered = true;
  ctx.memory.save();
  await travelTo(ctx, d.x, d.z, { range: 2 });
  await goTo(ctx, d.x, d.y, d.z, 1).catch(() => {});
  await pickUpItems(ctx, 10);
  return '死亡地点のアイテムを回収';
}
