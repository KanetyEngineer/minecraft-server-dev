import test from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import { armorRequired, nextStep, milestones } from '../src/brain/progress.js';
import { SKILL_MAP } from '../src/skills/index.js';
import { fakeBot, fakeMemory } from './fakebot.js';

test('何も持っていなければ木を集める', () => {
  assert.equal(nextStep(fakeBot(), fakeMemory()).skill, 'gatherWood');
});

test('木のツルハシがあれば石の道具へ', () => {
  assert.equal(nextStep(fakeBot({ wooden_pickaxe: 1 }), fakeMemory()).skill, 'makeTools');
});

test('ダイヤのツルハシまであれば水入りバケツへ（RTA に合わせ、弓はネザーの後）', () => {
  const bot = fakeBot({ diamond_pickaxe: 1, iron_sword: 1, bucket: 1, cooked_beef: 20, shield: 1, white_bed: 1 });
  bot.inventory.slots = [{ name: 'iron_helmet' }, { name: 'iron_chestplate' }, { name: 'iron_leggings' }];
  assert.equal(nextStep(bot, fakeMemory()).skill, 'fillWaterBucket');
});

test('ポータルを作ったらネザーへ、ロッドが集まったらパール集め', () => {
  const base = { diamond_pickaxe: 1, iron_sword: 1, water_bucket: 1, cooked_beef: 20, shield: 1, bow: 1, arrow: 64, white_bed: 1 };
  const mem = fakeMemory({ overworld_portal: { x: 0, y: 64, z: 0 } });
  const armored = (b) => { b.inventory.slots = [{ name: 'iron_helmet' }, { name: 'iron_chestplate' }, { name: 'iron_leggings' }]; return b; };
  assert.equal(nextStep(armored(fakeBot(base)), mem).skill, 'enterNether');
  // 昼のオーバーワールドにはエンダーマンがいないので、ネザーへパールを探しに行く
  assert.equal(nextStep(armored(fakeBot({ ...base, blaze_rod: 6 })), mem).skill, 'enterNether');
  const s = nextStep(armored(fakeBot({ ...base, blaze_rod: 6, ender_pearl: 12 })), mem);
  assert.deepEqual([s.skill, s.args], ['craftTo', { item: 'ender_eye', count: 12 }]);
});

test('エンドではクリスタル → ドラゴン', () => {
  assert.equal(nextStep(fakeBot({ bow: 1, arrow: 32 }, { dimension: 'minecraft:the_end' }), fakeMemory()).skill, 'destroyEndCrystals');
  // 弓が無ければクリスタルは壊さずにドラゴン戦（ベッド爆破）
  assert.equal(nextStep(fakeBot({}, { dimension: 'minecraft:the_end' }), fakeMemory()).skill, 'fightDragon');
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
test('RTA の流れ: エンダーアイがそろってから弓と矢、夜は防具があればエンダーマン狩り', () => {
  const armored = (b) => { b.inventory.slots = [{ name: 'iron_helmet' }, { name: 'iron_chestplate' }, { name: 'iron_leggings' }]; return b; };
  const mem = fakeMemory({ overworld_portal: { x: 0, y: 64, z: 0 } });
  const base = { diamond_pickaxe: 1, iron_sword: 1, water_bucket: 1, cooked_beef: 20, shield: 1, white_bed: 1 };
  assert.equal(nextStep(armored(fakeBot({ ...base, ender_eye: 12 })), mem).skill, 'makeBowAndArrows');
  assert.equal(nextStep(armored(fakeBot({ ...base, blaze_rod: 6 }, { isDay: false })), mem).skill, 'huntEndermen');
  assert.equal(nextStep(fakeBot({ ...base, blaze_rod: 6 }, { isDay: false }), mem).skill, 'shelterForNight');
});
test('エンドポータルが見つかったら、ベッドを 7 個持ってから入る（ベッド爆破用）', () => {
  const armored = (b) => { b.inventory.slots = [{ name: 'iron_helmet' }, { name: 'iron_chestplate' }, { name: 'iron_leggings' }]; return b; };
  const mem = fakeMemory({ overworld_portal: { x: 0, y: 64, z: 0 }, end_portal: { x: 9, y: 30, z: 9 } });
  const base = { diamond_pickaxe: 1, iron_sword: 1, water_bucket: 1, cooked_beef: 20, shield: 1, bow: 1, arrow: 64, ender_eye: 12 };
  const s = nextStep(armored(fakeBot({ ...base, white_bed: 1 })), mem);
  assert.deepEqual([s.skill, s.args], ['makeBed', { count: 7 }]);
  assert.equal(nextStep(armored(fakeBot({ ...base, white_bed: 7 })), mem).skill, 'activateEndPortal');
});
test('ゲートを作る前にボートを 1 つ作る（原木が無ければ木集め）', () => {
  const armored = (b) => { b.inventory.slots = [{ name: 'iron_helmet' }, { name: 'iron_chestplate' }, { name: 'iron_leggings' }]; return b; };
  const base = { diamond_pickaxe: 1, iron_sword: 1, water_bucket: 1, cooked_beef: 20, shield: 1, white_bed: 1 };
  const s = nextStep(armored(fakeBot({ ...base, acacia_log: 3 })), fakeMemory());
  assert.deepEqual([s.skill, s.args], ['craftTo', { item: 'acacia_boat', count: 1 }]);
  assert.equal(nextStep(armored(fakeBot(base)), fakeMemory()).skill, 'gatherWood');
  assert.equal(nextStep(armored(fakeBot({ ...base, oak_boat: 1 })), fakeMemory()).skill, 'mineBlock'); // 2 個目のバケツ用の鉄
});

test('ネザーで歪んだ森を知っていてボートがあれば、ロッドより先にエンダーマン狩り', () => {
  const nether = { dimension: 'the_nether' };
  const mem = fakeMemory({ warped_forest: { x: 5, y: 70, z: 5, dimension: 'the_nether' } });
  assert.equal(nextStep(fakeBot({ oak_boat: 1 }, nether), mem).skill, 'huntEndermen');
  assert.equal(nextStep(fakeBot({}, nether), mem).skill, 'huntBlazes');
  assert.equal(nextStep(fakeBot({ oak_boat: 1 }, nether), fakeMemory()).skill, 'huntBlazes');
});
test('ゲートは RTA 式（溶岩と水バケツ）。3 回失敗したらダイヤで黒曜石を掘る方式へ', () => {
  const armored = (b) => { b.inventory.slots = [{ name: 'iron_helmet' }, { name: 'iron_chestplate' }, { name: 'iron_leggings' }]; return b; };
  const base = { iron_pickaxe: 1, iron_sword: 1, water_bucket: 1, bucket: 1, cooked_beef: 20, shield: 1, white_bed: 1, oak_boat: 1 };
  assert.equal(nextStep(armored(fakeBot(base)), fakeMemory()).skill, 'castNetherPortal');
  assert.equal(nextStep(armored(fakeBot({ ...base, bucket: 0, iron_ingot: 3 })), fakeMemory()).skill, 'craftTo');
  const failed = fakeMemory({}, { castNetherPortalFails: 3 });
  assert.equal(nextStep(armored(fakeBot(base)), failed).skill, 'mineDiamonds');
  assert.equal(nextStep(armored(fakeBot({ ...base, diamond_pickaxe: 1 })), failed).skill, 'collectObsidian');
});
test('ツルハシを失っても原木が 3 本以上あれば、木集めに戻らず道具を作る', () => {
  assert.equal(nextStep(fakeBot({ oak_log: 14 }), fakeMemory()).skill, 'makeTools');
  assert.equal(nextStep(fakeBot({ oak_log: 2 }), fakeMemory()).skill, 'gatherWood');
});
test('体力が 8 以下なら、昼でも穴で休んで回復する', () => {
  const b = fakeBot({ stone_pickaxe: 1, stone_sword: 1, cooked_beef: 20 });
  b.health = 6;
  assert.deepEqual(nextStep(b, fakeMemory()), { skill: 'shelterForNight', args: { untilHealed: true } });
  b.health = 18;
  assert.notEqual(nextStep(b, fakeMemory()).skill, 'shelterForNight');
});
test('防具の無い夜は、死亡地点の回収より穴にこもるのが先', () => {
  const m = fakeMemory(); m.data.deaths = [{ x: 0, y: 64, z: 0, dimension: 'overworld', at: new Date().toISOString() }];
  assert.equal(nextStep(fakeBot({}, { isDay: false }), m).skill, 'shelterForNight');
  assert.equal(nextStep(fakeBot({}, { isDay: true }), m).skill, 'recoverItems');
});
test('ネザーでロッドがそろったら、パールは 交易 → エンダーマン狩り → 廃要塞の金、の順。最近失敗したものは飛ばす', () => {
  const nether = { dimension: 'the_nether' };
  const now = Date.now();
  assert.equal(nextStep(fakeBot({ blaze_rod: 6, gold_ingot: 10 }, nether), fakeMemory()).skill, 'barterWithPiglins');
  assert.equal(nextStep(fakeBot({ blaze_rod: 6 }, nether), fakeMemory()).skill, 'huntEndermen');
  assert.equal(nextStep(fakeBot({ blaze_rod: 6 }, nether), fakeMemory({}, { huntEndermenFailAt: now })).skill, 'raidBastionGold');
  assert.equal(nextStep(fakeBot({ blaze_rod: 6 }, nether), fakeMemory({}, { huntEndermenFailAt: now, raidBastionGoldFailAt: now })).skill, 'returnThroughPortal');
  assert.equal(nextStep(fakeBot({ blaze_rod: 6, ender_pearl: 12 }, nether), fakeMemory()).skill, 'returnThroughPortal');
});

test('弓と矢が集まらなければ、30 分は弓なしで要塞探しへ進む', () => {
  const armored = (b) => { b.inventory.slots = [{ name: 'iron_helmet' }, { name: 'iron_chestplate' }, { name: 'iron_leggings' }]; return b; };
  const base = { diamond_pickaxe: 1, iron_sword: 1, water_bucket: 1, cooked_beef: 20, shield: 1, white_bed: 1, ender_eye: 12 };
  const mem = (flags) => fakeMemory({ overworld_portal: { x: 0, y: 64, z: 0 } }, flags);
  assert.equal(nextStep(armored(fakeBot(base)), mem({})).skill, 'makeBowAndArrows');
  assert.equal(nextStep(armored(fakeBot(base)), mem({ makeBowAndArrowsFailAt: Date.now() })).skill, 'locateStronghold');
});
test('夜でも寝られないとき、石の道具と体力があれば穴にこもらず作業を続ける', () => {
  const night = { isDay: false };
  const tools = { stone_pickaxe: 1, stone_sword: 1 };
  // ベッドがあれば穴で寝る
  assert.equal(nextStep(fakeBot({ ...tools, white_bed: 1 }, night), fakeMemory()).skill, 'shelterForNight');
  // 寝られなかった直後はベッドがあっても作業へ
  assert.equal(nextStep(fakeBot({ ...tools, white_bed: 1 }, night), fakeMemory({}, { sleepFailAt: Date.now() })).skill, 'gatherFood');
  // ベッドが無くても道具と体力があれば作業へ
  assert.equal(nextStep(fakeBot(tools, night), fakeMemory({}, { bedRetryAt: Date.now() + 60_000 })).skill, 'gatherFood');
  // 体力が少なければ穴にこもる
  const weak = fakeBot(tools, night); weak.health = 10;
  assert.equal(nextStep(weak, fakeMemory()).skill, 'shelterForNight');
  // 道具が無ければ穴にこもる
  assert.equal(nextStep(fakeBot({}, night), fakeMemory()).skill, 'shelterForNight');
});

test('直前に「原木が足りない」で失敗していたら、道具があっても木集めを選ぶ', () => {
  const bot = fakeBot({ stone_pickaxe: 1, stone_sword: 1, cooked_beef: 20, white_wool: 3 });
  assert.equal(nextStep(bot, fakeMemory({}, { needWoodAt: Date.now() })).skill, 'gatherWood');
  assert.equal(nextStep(bot, fakeMemory()).skill, 'makeBed');
});

test('地下にいるときは、夜でも穴にこもらず作業を続ける', () => {
  const mk = (skyLight) => {
    const b = fakeBot({ stone_pickaxe: 1, stone_sword: 1, cooked_beef: 20, white_bed: 1 }, { isDay: false });
    b.entity = { position: new Vec3(0, 20, 0) };
    b.blockAt = (q) => (q.y >= 22 ? { skyLight, boundingBox: 'block', name: 'stone' } : { skyLight, boundingBox: 'empty', name: 'cave_air' });
    return b;
  };
  assert.equal(nextStep(mk(15), fakeMemory()).skill, 'shelterForNight'); // 地上の夜
  assert.notEqual(nextStep(mk(0), fakeMemory()).skill, 'shelterForNight'); // 地下の夜
});

test('夜・防具なしで地下にいるときは、地上に出る食料集めを選ばず、地下でできる鉄集めをする（体力が少なければ穴で休む）', () => {
  const b = fakeBot({ stone_pickaxe: 1, stone_sword: 1 }, { isDay: false });
  b.entity = { position: new Vec3(0, 20, 0) };
  b.blockAt = (q) => (q.y >= 22 ? { skyLight: 0, boundingBox: 'block', name: 'stone' } : { skyLight: 0, boundingBox: 'empty', name: 'cave_air' });
  assert.equal(nextStep(b, fakeMemory()).skill, 'getIronGear');
  b.health = 12;
  assert.equal(nextStep(b, fakeMemory()).skill, 'shelterForNight');
});

test('このランで 2 回以上死んでいたら、鉄の防具を必須にする（それまでは盾だけ）', () => {
  const geared = { iron_pickaxe: 1, iron_sword: 1, bucket: 1, cooked_beef: 20, shield: 1, white_bed: 1 };
  const deaths = (n) => ({ ...fakeMemory(), data: { places: {}, notes: [], flags: {}, deaths: Array.from({ length: n }, () => ({ at: new Date(Date.now() - 10 * 60_000).toISOString(), dimension: 'overworld', recovered: true })) } });
  assert.equal(armorRequired(deaths(1)), false);
  assert.equal(armorRequired(deaths(2)), true);
  assert.equal(nextStep(fakeBot(geared), deaths(1)).skill, 'fillWaterBucket');
  assert.deepEqual(nextStep(fakeBot(geared), deaths(2)), { skill: 'getIronGear', args: { armor: true } });
  // 鉄の道具を作る段階から、防具の分まで鉄を集める
  assert.deepEqual(nextStep(fakeBot({ stone_pickaxe: 1, stone_sword: 1, cooked_beef: 20, white_bed: 1 }), deaths(2)), { skill: 'getIronGear', args: { armor: true } });
  // 1 時間より前の死亡は数えない
  const old = deaths(0); old.data.deaths = [{ at: new Date(Date.now() - 2 * 3600_000).toISOString() }, { at: new Date(Date.now() - 2 * 3600_000).toISOString() }];
  assert.equal(armorRequired(old), false);
});

test('体力が少なくても、食べ物が無く満腹度 18 未満なら休んでも戻らないので、昼は食料集めへ', () => {
  const b = fakeBot({ stone_pickaxe: 1, stone_sword: 1 });
  b.health = 6; b.food = 17;
  assert.equal(nextStep(b, fakeMemory()).skill, 'gatherFood');
  const b2 = fakeBot({ stone_pickaxe: 1, stone_sword: 1, cooked_beef: 3 });
  b2.health = 6; b2.food = 17;
  assert.equal(nextStep(b2, fakeMemory()).skill, 'shelterForNight');
});

test('食料集めが目標に届かなかった直後は、蓄えが 5 以上なら先へ進む', () => {
  const b = fakeBot({ stone_pickaxe: 1, stone_sword: 1, cooked_mutton: 8 });
  assert.equal(nextStep(b, fakeMemory()).skill, 'gatherFood');
  assert.notEqual(nextStep(b, fakeMemory({}, { foodRetryAt: Date.now() + 60_000 })).skill, 'gatherFood');
});

test('ベッドを持っていて復活地点が未設定か遠ければ、昼のうちにベッドで復活地点を設定する', () => {
  const base = { stone_pickaxe: 1, stone_sword: 1, cooked_beef: 20, white_bed: 1 };
  const at = (bot, x, z) => Object.assign(bot, { entity: { position: { x, y: 64, z } } });
  assert.equal(nextStep(at(fakeBot(base), 0, 0), fakeMemory()).skill, 'setRespawnPoint');
  assert.ok(SKILL_MAP.setRespawnPoint);
  // 近く（96 マス以内）に設定済みなら、ふだんの流れ（鉄集め）
  const near = { respawn: { x: 30, y: 64, z: 10, dimension: 'overworld' } };
  assert.equal(nextStep(at(fakeBot(base), 0, 0), fakeMemory(near)).skill, 'getIronGear');
  assert.equal(nextStep(at(fakeBot(base), 200, 0), fakeMemory(near)).skill, 'setRespawnPoint');
  // 夜は寝る流れに任せる。ベッドが無ければ先にベッド作り。失敗直後は飛ばす
  assert.equal(nextStep(at(fakeBot(base, { isDay: false }), 0, 0), fakeMemory()).skill, 'shelterForNight');
  const { white_bed: _bed, ...noBed } = base;
  assert.equal(nextStep(at(fakeBot(noBed), 0, 0), fakeMemory()).skill, 'makeBed');
  assert.equal(nextStep(at(fakeBot(base), 0, 0), fakeMemory({}, { respawnRetryAt: Date.now() + 60_000 })).skill, 'getIronGear');
});

test('鉄インゴットがあれば、食料より先に鉄の道具と防具を作る', () => {
  const b = fakeBot({ stone_pickaxe: 1, stone_sword: 1, iron_ingot: 40 });
  const s = nextStep(b, fakeMemory());
  assert.deepEqual([s.skill, s.args], ['getIronGear', { armor: false }]);
});

test('森の木の下（空の光は弱いが、上は葉だけ）は地下とみなさない', async () => {
  const { isUnderground } = await import('../src/brain/progress.js');
  const b = fakeBot({});
  b.entity = { position: new Vec3(0, 70, 0) };
  b.blockAt = (q) => (q.y >= 74 && q.y <= 76 ? { skyLight: 2, boundingBox: 'block', name: 'dark_oak_leaves' } : { skyLight: 2, boundingBox: 'empty', name: 'air' });
  assert.equal(isUnderground(b), false);
});
