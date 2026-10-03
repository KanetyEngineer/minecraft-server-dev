// 家族のスキル: プロポーズ・子どもを授かる・子どもの世話。
// 結婚と出産は町の管理役（scripts/society-world.mjs）が戸籍に反映する。ここでは相手のそばへ行って申し出るだけ。
import fs from 'node:fs';
import path from 'node:path';
import { SkillError, abortable, travelTo, goTo } from '../skills/common.js';
import { sleep } from '../body/humanize.js';
import { personaByName } from './personas.js';
import { request, readWorld, canHaveChild } from './population.js';
import { voice } from './dialogue.js';

const S = (ctx) => { if (!ctx.society) throw new SkillError('社会モードではない'); return ctx.society; };

async function approach(ctx, name) {
  const { bot } = ctx;
  const soc = S(ctx);
  let e = bot.players[name]?.entity;
  if (!e) {
    const r = soc.town.resident(name);
    if (!r?.online || !r.pos) throw new SkillError(`${name} の居場所が分からない`);
    await travelTo(ctx, r.pos.x, r.pos.z, { range: 4, step: 32 });
    e = bot.players[name]?.entity;
  }
  if (!e) throw new SkillError(`${name} が見当たらない`);
  await goTo(ctx, e.position.x, e.position.y, e.position.z, 2).catch(() => {});
  await bot.lookAt(e.position.offset(0, 1.6, 0), true).catch(() => {});
}

// 管理役の返事（answers.jsonl）を待つ
async function waitAnswer(ctx, from, since, ms = 30_000) {
  const f = path.join(S(ctx).town.dir, 'answers.jsonl');
  for (let t = 0; t < ms / 2000; t++) {
    abortable(ctx);
    ctx.state.holdStillUntil = Date.now() + 5000;
    try {
      const lines = fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      const a = lines.reverse().find((x) => x.from === from && x.at >= since);
      if (a) return a;
    } catch {}
    await sleep(2000);
  }
  return null;
}

export async function propose(ctx, { to } = {}) {
  const soc = S(ctx);
  const me = soc.persona.name;
  if (!to) throw new SkillError('相手が無い');
  const other = personaByName(to);
  await approach(ctx, to);
  ctx.say?.(voice(soc.persona, `💍 ${other?.call ?? to}、{I}と結婚してください。`));
  const since = Date.now();
  request(soc.town.dir, 'propose', { from: me, to });
  const ans = await waitAnswer(ctx, me, since);
  soc.flags.proposedAt = Date.now();
  if (!ans) throw new SkillError('返事が来なかった（町の管理役が動いていない？）');
  if (ans.yes) {
    soc.rel.adjust(to, 15, '結婚した');
    return `${other?.call ?? to}と結婚した`;
  }
  soc.rel.adjust(to, -5, 'プロポーズを断られた');
  soc.rel.diary(`${other?.call ?? to}にプロポーズしたが断られた。`);
  ctx.say?.(voice(soc.persona, 'そっか…。また頑張るね。'));
  return `${other?.call ?? to}にプロポーズしたが断られた`;
}

// 配偶者のそばへ行き、子どもを授かることを申し出る（条件がそろえば管理役が子どもを生まれさせる）
export async function haveChild(ctx) {
  const soc = S(ctx);
  const me = soc.persona.name;
  const world = readWorld(soc.town.dir);
  const person = world?.people?.[me];
  if (!person?.spouse) throw new SkillError('結婚していない');
  if (!canHaveChild(world, person)) throw new SkillError('今は子どもを授かれない（年齢・前の子から 3 年・子は 4 人まで・町の人数の上限）');
  const spouse = personaByName(person.spouse);
  await approach(ctx, person.spouse);
  ctx.say?.(voice(soc.persona, `${spouse?.call ?? person.spouse}、そろそろ家族を増やさない？`));
  const before = person.children.length;
  soc.flags.childAskAt = Date.now();
  request(soc.town.dir, 'birth', { from: me });
  for (let t = 0; t < 15; t++) {
    abortable(ctx);
    ctx.state.holdStillUntil = Date.now() + 5000;
    await sleep(2000);
    const w = readWorld(soc.town.dir);
    if ((w?.people?.[me]?.children.length ?? 0) > before) return `子どもの${personaByName(w.people[me].children.at(-1))?.call ?? ''}が生まれた`;
  }
  throw new SkillError('子どもは生まれなかった');
}

// 子ども・孫のそばへ行って話しかけ、食べ物があれば分ける（子育て）
export async function careForChild(ctx, { child } = {}) {
  const { bot } = ctx;
  const soc = S(ctx);
  if (!child) throw new SkillError('子どもが無い');
  const c = personaByName(child);
  await approach(ctx, child);
  const food = bot.inventory.items().filter((i) => /^(bread|cooked_|baked_potato|apple|carrot)/.test(i.name)).sort((a, b) => b.count - a.count)[0];
  ctx.say?.(voice(soc.persona, food ? `${c?.call ?? child}、ご飯だよ。しっかり食べて大きくなってね。` : `${c?.call ?? child}、今日は何をしてたの？`));
  if (food && food.count >= 2) {
    const tp = bot.players[child]?.entity?.position;
    if (tp) await bot.lookAt(tp.offset(0, 1, 0), true).catch(() => {});
    await bot.toss(food.type, null, Math.min(4, Math.floor(food.count / 2))).catch(() => {});
  }
  soc.rel.adjust(child, 3, '世話をした');
  soc.rel.talked(child);
  soc.town.event('care', `${soc.persona.call}が${c?.call ?? child}の世話をした`, { child });
  await sleep(4000);
  return `${c?.call ?? child}の世話をした`;
}
