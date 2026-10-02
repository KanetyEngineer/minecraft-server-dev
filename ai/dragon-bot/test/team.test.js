import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Team } from '../src/team.js';
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
