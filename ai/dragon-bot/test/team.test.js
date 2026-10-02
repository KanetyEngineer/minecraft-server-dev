import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Team, indexOf, strategyFor } from '../src/team.js';
import { nextStep, setTeamContext } from '../src/brain/progress.js';
import { fakeBot, fakeMemory } from './fakebot.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'team-'));

test('係は、リーダーのほしい物のうち担当の物を、自分の分を残して渡す', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'DragonBot.json'), JSON.stringify({ name: 'DragonBot', role: 'leader', at: Date.now(), pos: { x: 0, y: 64, z: 0 },
    needs: [{ item: 'iron_ingot', count: 10 }, { match: '_log$', item: '原木', count: 8 }, { match: '^(cooked_|bread$)', item: '食料', count: 6 }] }));
  const iron = new Team({ dir, name: 'DragonBot3', role: 'iron' });
  const food = new Team({ dir, name: 'DragonBot2', role: 'food' });
  const bot = fakeBot({ iron_ingot: 7, oak_log: 10, cooked_beef: 9, iron_pickaxe: 1, iron_sword: 1 });
  assert.deepEqual(iron.deliverable(bot), [{ item: 'iron_ingot', count: 7, to: 'DragonBot' }]);
  const f = food.deliverable(bot);
  assert.deepEqual(f.map((x) => [x.item, x.count]), [['oak_log', 6], ['cooked_beef', 5]]);
});

test('係はリーダーのほしい物を持っていれば渡しに行き、無ければ担当の物を集める', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'DragonBot.json'), JSON.stringify({ name: 'DragonBot', role: 'leader', at: Date.now(), pos: { x: 0, y: 64, z: 0 },
    needs: [{ match: '_log$', item: '原木', count: 8 }] }));
  const team = new Team({ dir, name: 'DragonBot2', role: 'food' });
  setTeamContext({ role: 'food', team });
  try {
    const base = { stone_pickaxe: 1, stone_sword: 1, cooked_beef: 30, white_bed: 1 };
    assert.equal(nextStep(fakeBot({ ...base, oak_log: 10 }), fakeMemory()).skill, 'deliverItems');
    assert.equal(nextStep(fakeBot({ ...base }), fakeMemory()).skill, 'gatherWood');
  } finally {
    setTeamContext({ role: 'leader', team: null });
  }
});

test('鉄係は、自分の鉄のツルハシと剣の分（3＋2）を残してから鉄を渡す', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'DragonBot.json'), JSON.stringify({ name: 'DragonBot', role: 'leader', at: Date.now(), pos: { x: 0, y: 64, z: 0 },
    needs: [{ item: 'iron_ingot', count: 16 }] }));
  const iron = new Team({ dir, name: 'DragonBot3', role: 'iron' });
  assert.deepEqual(iron.deliverable(fakeBot({ iron_ingot: 3 })), [], 'ツルハシ分の 3 個は渡さない');
  assert.deepEqual(iron.deliverable(fakeBot({ iron_ingot: 7 })), [{ item: 'iron_ingot', count: 4, to: 'DragonBot' }]);
  assert.deepEqual(iron.deliverable(fakeBot({ iron_ingot: 7, iron_pickaxe: 1 })), [{ item: 'iron_ingot', count: 5, to: 'DragonBot' }], '剣の分 2 個を残す');
  assert.deepEqual(iron.deliverable(fakeBot({ iron_ingot: 7, iron_pickaxe: 1, iron_sword: 1 })), [{ item: 'iron_ingot', count: 7, to: 'DragonBot' }]);
});

test('仲間が渡しに来ていたら、リーダーはそばの落とし物を拾う', () => {
  const dir = tmp();
  const write = (delivering, pos = { x: 3, y: 64, z: 0 }, at = Date.now()) => fs.writeFileSync(path.join(dir, 'DragonBot3.json'),
    JSON.stringify({ name: 'DragonBot3', role: 'iron', at: Date.now(), pos, dimension: 'overworld', delivering: delivering ? { to: 'DragonBot', at } : null }));
  const team = new Team({ dir, name: 'DragonBot', role: 'leader' });
  const bot = Object.assign(fakeBot({ stone_pickaxe: 1, stone_sword: 1, cooked_beef: 10 }), { entity: { position: { x: 0, y: 64, z: 0 } } });
  write(true);
  assert.equal(team.incomingDelivery(bot)?.name, 'DragonBot3');
  write(true, { x: 40, y: 64, z: 0 });
  assert.equal(team.incomingDelivery(bot), null, '遠ければ対象外');
  write(true, { x: 3, y: 64, z: 0 }, Date.now() - 60_000);
  assert.equal(team.incomingDelivery(bot), null, '古い情報は対象外');
  write(false);
  assert.equal(team.incomingDelivery(bot), null);
  setTeamContext({ role: 'leader', team });
  try {
    write(true);
    assert.equal(nextStep(bot, fakeMemory()).skill, 'collectDrops');
  } finally {
    setTeamContext({ role: 'leader', team: null });
  }
});

test('ほかの係が運んでいる途中の物は差し引いて、重ねて運ばない', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'DragonBot.json'), JSON.stringify({ name: 'DragonBot', role: 'leader', at: Date.now(), pos: { x: 0, y: 64, z: 0 },
    needs: [{ item: 'iron_ingot', count: 10 }, { match: '_log$', item: '原木', count: 8 }] }));
  fs.writeFileSync(path.join(dir, 'DragonBot6.json'), JSON.stringify({ name: 'DragonBot6', role: 'iron', at: Date.now(), pos: { x: 5, y: 64, z: 0 },
    delivering: { to: 'DragonBot', at: Date.now(), items: [{ item: 'iron_ingot', count: 10 }] } }));
  fs.writeFileSync(path.join(dir, 'DragonBot2.json'), JSON.stringify({ name: 'DragonBot2', role: 'food', at: Date.now(), pos: { x: 5, y: 64, z: 0 },
    delivering: { to: 'DragonBot', at: Date.now(), items: [{ item: 'birch_log', count: 5 }] } }));
  const iron = new Team({ dir, name: 'DragonBot7', role: 'iron' });
  assert.deepEqual(iron.deliverable(fakeBot({ iron_ingot: 20, iron_pickaxe: 1, iron_sword: 1 })), [], '鉄 10 個は 6 番が運んでいる');
  const food = new Team({ dir, name: 'DragonBot3', role: 'food' });
  assert.deepEqual(food.deliverable(fakeBot({ oak_log: 20 })), [{ item: 'oak_log', count: 3, to: 'DragonBot' }], '原木は 8−5 の 3 本だけ');
});

test('仲間が見つけた場所を取り込む（ベッドなど 1 体ごとの物は取り込まない）', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'DragonBot4.json'), JSON.stringify({ name: 'DragonBot4', role: 'food', at: Date.now(), pos: { x: 0, y: 64, z: 0 },
    places: { village: { x: 100, y: 64, z: -50, dimension: 'overworld' }, bed: { x: 1, y: 64, z: 1, dimension: 'overworld' } } }));
  const team = new Team({ dir, name: 'DragonBot', role: 'leader' });
  const places = { lava_pool: { x: 9, y: 60, z: 9, dimension: 'overworld' } };
  const memory = { data: { places }, getPlace: (n) => places[n], setPlace: (n, p, d) => { places[n] = { x: p.x, y: p.y, z: p.z, dimension: d }; } };
  assert.deepEqual(team.importPlaces(memory), ['village']);
  assert.deepEqual(places.village, { x: 100, y: 64, z: -50, dimension: 'overworld' });
  assert.equal(places.bed, undefined);
  assert.deepEqual(team.importPlaces(memory), [], '2 回目は何も取り込まない');
  // 自分の共有する場所だけを書く
  const bot = Object.assign(fakeBot({}), { entity: { position: { x: 0, y: 64, z: 0 } } });
  team.publish(bot, { data: { places: { ...places, respawn: { x: 0, y: 64, z: 0 } } } });
  const written = JSON.parse(fs.readFileSync(path.join(dir, 'DragonBot.json'), 'utf8'));
  assert.deepEqual(Object.keys(written.places).sort(), ['lava_pool', 'village']);
});

test('係は番号ごとに違う向きへ散らばり、仲間が固まっていれば先に探索する', () => {
  const dir = tmp();
  const t2 = new Team({ dir, name: 'DragonBot2', role: 'food' });
  const t6 = new Team({ dir, name: 'DragonBot6', role: 'iron' });
  assert.equal(t2.index, 2);
  assert.equal(new Team({ dir, name: 'DragonBot', role: 'leader' }).index, 1);
  assert.notEqual(t2.homeHeading(), t6.homeHeading());
  for (const n of [3, 4]) fs.writeFileSync(path.join(dir, `DragonBot${n}.json`), JSON.stringify({ name: `DragonBot${n}`, role: 'food', at: Date.now(), pos: { x: n, y: 64, z: 0 }, dimension: 'overworld' }));
  const bot = Object.assign(fakeBot({ cooked_beef: 10 }), { entity: { position: { x: 0, y: 64, z: 0 } } });
  assert.equal(t2.crowded(bot, 12), 2);
  setTeamContext({ role: 'food', team: t2 });
  try {
    const flags = {};
    const memory = Object.assign(fakeMemory({}, flags), { setFlag: (k, v) => { flags[k] = v; } });
    assert.equal(nextStep(bot, memory).skill, 'explore');
    assert.notEqual(nextStep(bot, memory).skill, 'explore', '10 分以内は繰り返さない');
  } finally {
    setTeamContext({ role: 'leader', team: null });
  }
});

test('独立して動くとき、番号ごとに進め方が変わる（防具優先・探索優先・ダイヤ掘り）', () => {
  const dir = tmp();
  const strat = (n) => new Team({ dir, name: n === 1 ? 'DragonBot' : `DragonBot${n}`, role: 'leader' }).strategy();
  assert.equal(strat(1).name, '定石');
  assert.equal(strat(2).armorEarly, true);
  assert.equal(strat(3).exploreFirst, true);
  assert.equal(strat(4).portalByDiamonds, true);
  assert.equal(strat(5).name, '定石');
  const armored = (b) => { b.inventory.slots = [{ name: 'iron_helmet' }, { name: 'iron_chestplate' }, { name: 'iron_leggings' }]; return b; };
  const base = { iron_pickaxe: 1, iron_sword: 1, water_bucket: 1, bucket: 1, cooked_beef: 20, shield: 1, white_bed: 1, oak_boat: 1 };
  try {
    setTeamContext({ role: 'leader', team: null, strategy: strat(4) });
    assert.equal(nextStep(armored(fakeBot(base)), fakeMemory()).skill, 'mineDiamonds', 'ダイヤ掘りの体は溶岩鋳造を使わない');
    setTeamContext({ role: 'leader', team: null, strategy: strat(1) });
    assert.equal(nextStep(armored(fakeBot(base)), fakeMemory()).skill, 'castNetherPortal');
    setTeamContext({ role: 'leader', team: null, strategy: strat(2) });
    assert.deepEqual(nextStep(fakeBot(base), fakeMemory()), { skill: 'getIronGear', args: { armor: true } }, '防具優先の体は死ぬ前から防具を作る');
    setTeamContext({ role: 'leader', team: null, strategy: strat(3) });
    const flags = {};
    const memory = Object.assign(fakeMemory({}, flags), { setFlag: (k, v) => { flags[k] = v; } });
    assert.equal(nextStep(armored(fakeBot(base)), memory).skill, 'explore', '探索優先の体はまず歩き回る');
    assert.equal(flags.exploreFirstCount, 1);
    flags.exploreFirstCount = 3;
    assert.equal(nextStep(armored(fakeBot(base)), memory).skill, 'castNetherPortal', '3 回歩いたら本筋へ');
  } finally {
    setTeamContext({ role: 'leader', team: null });
  }
});

test('番号を 2 桁にした名前（DragonBot01 ...）でも番号・進め方・向きは 1 桁名と同じ', () => {
  assert.equal(indexOf('DragonBot01'), 1);
  assert.equal(indexOf('DragonBot07'), 7);
  assert.equal(indexOf('DragonBot10'), 10);
  assert.equal(indexOf('DragonBot50'), 50);
  for (let n = 1; n <= 50; n++) {
    const two = `DragonBot${String(n).padStart(2, '0')}`;
    const one = n === 1 ? 'DragonBot' : `DragonBot${n}`;
    assert.equal(indexOf(two), indexOf(one), two);
    assert.equal(strategyFor(two), strategyFor(one), two);
  }
  const dir = tmp();
  assert.equal(new Team({ dir, name: 'DragonBot01', role: 'leader' }).index, 1);
  assert.equal(new Team({ dir, name: 'DragonBot09', role: 'leader' }).homeHeading(), new Team({ dir, name: 'DragonBot9', role: 'leader' }).homeHeading());
});
