import test from 'node:test';
import assert from 'node:assert/strict';
import { nextStep, milestones } from '../src/brain/progress.js';
import { SKILL_MAP } from '../src/skills/index.js';
import { fakeBot, fakeMemory } from './fakebot.js';

test('何も持っていなければ木を集める', () => {
  assert.equal(nextStep(fakeBot(), fakeMemory()).skill, 'gatherWood');
});

test('木のツルハシがあれば石の道具へ', () => {
  assert.equal(nextStep(fakeBot({ wooden_pickaxe: 1 }), fakeMemory()).skill, 'makeTools');
});

test('ダイヤのツルハシまであれば弓と矢へ', () => {
  const bot = fakeBot({ diamond_pickaxe: 1, iron_sword: 1, bucket: 1, cooked_beef: 20, shield: 1 });
  bot.inventory.slots = [{ name: 'iron_helmet' }, { name: 'iron_chestplate' }, { name: 'iron_leggings' }];
  assert.equal(nextStep(bot, fakeMemory()).skill, 'makeBowAndArrows');
});

test('ポータルを作ったらネザーへ、ロッドが集まったらパール集め', () => {
  const base = { diamond_pickaxe: 1, iron_sword: 1, water_bucket: 1, cooked_beef: 20, shield: 1, bow: 1, arrow: 64 };
  const mem = fakeMemory({ overworld_portal: { x: 0, y: 64, z: 0 } });
  const armored = (b) => { b.inventory.slots = [{ name: 'iron_helmet' }, { name: 'iron_chestplate' }, { name: 'iron_leggings' }]; return b; };
  assert.equal(nextStep(armored(fakeBot(base)), mem).skill, 'enterNether');
  assert.equal(nextStep(armored(fakeBot({ ...base, blaze_rod: 6 })), mem).skill, 'huntEndermen');
  const s = nextStep(armored(fakeBot({ ...base, blaze_rod: 6, ender_pearl: 12 })), mem);
  assert.deepEqual([s.skill, s.args], ['craftTo', { item: 'ender_eye', count: 12 }]);
});

test('エンドではクリスタル → ドラゴン', () => {
  assert.equal(nextStep(fakeBot({}, { dimension: 'minecraft:the_end' }), fakeMemory()).skill, 'destroyEndCrystals');
  assert.equal(nextStep(fakeBot({}, { dimension: 'the_end' }), fakeMemory({}, { crystalsDestroyed: true })).skill, 'fightDragon');
});

test('ネザーではロッドが足りなければブレイズ狩り', () => {
  assert.equal(nextStep(fakeBot({}, { dimension: 'the_nether' }), fakeMemory()).skill, 'huntBlazes');
});

test('ルールベースが返すスキルはすべて登録済み', () => {
  const cases = [
    [fakeBot(), fakeMemory()],
    [fakeBot({ wooden_pickaxe: 1 }), fakeMemory()],
    [fakeBot({}, { dimension: 'the_end' }), fakeMemory()],
    [fakeBot({}, { dimension: 'the_nether' }), fakeMemory()],
    [fakeBot({ ender_eye: 12 }), fakeMemory({ overworld_portal: {} })],
  ];
  for (const [b, m] of cases) {
    const s = nextStep(b, m).skill;
    assert.ok(SKILL_MAP[s], `${s} が未登録`);
  }
});

test('エンダーアイ 12 個で要塞探しへ', () => {
  const m = milestones(fakeBot({ ender_eye: 12 }), fakeMemory());
  assert.equal(m.enderEyes, true);
});
