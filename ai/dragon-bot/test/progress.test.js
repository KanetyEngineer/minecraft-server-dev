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
  const bot = fakeBot({ diamond_pickaxe: 1, iron_sword: 1, bucket: 1, cooked_beef: 20, shield: 1, white_bed: 1 });
  bot.inventory.slots = [{ name: 'iron_helmet' }, { name: 'iron_chestplate' }, { name: 'iron_leggings' }];
  assert.equal(nextStep(bot, fakeMemory()).skill, 'makeBowAndArrows');
});

test('ポータルを作ったらネザーへ、ロッドが集まったらパール集め', () => {
  const base = { diamond_pickaxe: 1, iron_sword: 1, water_bucket: 1, cooked_beef: 20, shield: 1, bow: 1, arrow: 64, white_bed: 1 };
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
  const base = { diamond_pickaxe: 1, iron_sword: 1, water_bucket: 1, cooked_beef: 20, shield: 1, bow: 1, arrow: 64 };
  const armored = (b) => { b.inventory.slots = [{ name: 'iron_helmet' }, { name: 'iron_chestplate' }, { name: 'iron_leggings' }]; return b; };
  cases.push(
    [armored(fakeBot({ ...base, obsidian: 10 })), fakeMemory()],
    [armored(fakeBot({ ...base, blaze_rod: 6, ender_pearl: 12 })), fakeMemory({ overworld_portal: { x: 0, y: 64, z: 0 } })],
  );
  for (const [b, m] of cases) {
    const s = nextStep(b, m).skill;
    assert.ok(SKILL_MAP[s], `${s} が未登録`);
  }
});

test('エンダーアイ 12 個で要塞探しへ', () => {
  const m = milestones(fakeBot({ ender_eye: 12 }), fakeMemory());
  assert.equal(m.enderEyes, true);
});

test('死んで 4 分以内ならアイテム回収、回収済みや古い死亡なら通常どおり', () => {
  const mem = (d) => { const m = fakeMemory(); m.data.deaths = [d]; return m; };
  const now = new Date().toISOString();
  const old = new Date(Date.now() - 10 * 60_000).toISOString();
  assert.equal(nextStep(fakeBot(), mem({ x: 0, y: 64, z: 0, dimension: 'overworld', at: now })).skill, 'recoverItems');
  assert.equal(nextStep(fakeBot(), mem({ x: 0, y: 64, z: 0, dimension: 'overworld', at: now, recovered: true })).skill, 'gatherWood');
  assert.equal(nextStep(fakeBot(), mem({ x: 0, y: 64, z: 0, dimension: 'overworld', at: old })).skill, 'gatherWood');
  assert.equal(nextStep(fakeBot(), mem({ x: 0, y: 64, z: 0, dimension: 'the_nether', at: now })).skill, 'gatherWood');
});

test('夜は穴にこもる（ベッドの有無や防具に関係なく、寝るかどうかはスキルの中で決める）', () => {
  const s = nextStep(fakeBot({}, { isDay: false }), fakeMemory());
  assert.equal(s.skill, 'shelterForNight');
  assert.ok(SKILL_MAP[s.skill]);
  assert.equal(nextStep(fakeBot({ white_bed: 1 }, { isDay: false }), fakeMemory()).skill, 'shelterForNight');
  assert.equal(nextStep(fakeBot({}, { isDay: true }), fakeMemory()).skill, 'gatherWood');
});

test('食料の次はベッド作り、羊が見つからなかった直後は飛ばす', () => {
  const base = { stone_pickaxe: 1, stone_sword: 1, cooked_beef: 20 };
  assert.equal(nextStep(fakeBot(base), fakeMemory()).skill, 'makeBed');
  assert.equal(nextStep(fakeBot(base), fakeMemory({}, { bedRetryAt: Date.now() + 60_000 })).skill, 'getIronGear');
  assert.equal(nextStep(fakeBot({ ...base, red_bed: 1 }), fakeMemory()).skill, 'getIronGear');
});