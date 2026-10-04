import test from 'node:test';
import assert from 'node:assert/strict';
import { inferPortalFrame, noteStructures } from '../src/skills/structures.js';
import { nextStep, elapsedMinutes } from '../src/brain/progress.js';
import { SKILL_MAP } from '../src/skills/index.js';
import { fakeBot, fakeMemory } from './fakebot.js';

// 4×5 の枠（x 方向、原点 (10, 64, 20)）の必要位置 10 か所
function fullFrame(ox = 10, oy = 64, oz = 20, axis = 'x') {
  const out = [];
  for (let u = 0; u < 4; u++) {
    for (let v = 0; v < 5; v++) {
      const eu = u === 0 || u === 3; const ev = v === 0 || v === 4;
      if ((eu || ev) && !(eu && ev)) out.push({ x: axis === 'x' ? ox + u : ox, y: oy + v, z: axis === 'z' ? oz + u : oz, name: 'obsidian' });
    }
  }
  return out;
}

test('廃ポータル: 欠けた枠から原点と足りない位置を推定する', () => {
  const full = fullFrame();
  const broken = full.filter((b) => !(b.x === 10 && b.y === 66) && !(b.x === 11 && b.y === 68) && !(b.x === 13 && b.y === 65));
  const f = inferPortalFrame(broken);
  assert.deepEqual(f.origin, { x: 10, y: 64, z: 20 });
  assert.equal(f.axis, 'x');
  assert.equal(f.blocked.length, 0);
  assert.deepEqual(f.missing.map((p) => `${p.x},${p.y}`).sort(), ['10,66', '11,68', '13,65']);
  assert.equal(f.interior.length, 6);
});

test('廃ポータル: z 方向の枠と、泣く黒曜石が必要位置にある場合', () => {
  const z = fullFrame(5, 70, 5, 'z');
  const f = inferPortalFrame(z.slice(0, 7));
  assert.equal(f.axis, 'z');
  assert.deepEqual(f.origin, { x: 5, y: 70, z: 5 });
  assert.equal(f.missing.length, 3);
  // 角の泣く黒曜石は問題ない
  const withCorner = z.concat([{ x: 5, y: 70, z: 5, name: 'crying_obsidian' }]);
  assert.equal(inferPortalFrame(withCorner).blocked.length, 0);
  // 必要位置の泣く黒曜石は blocked
  const bad = z.filter((b) => !(b.z === 6 && b.y === 70)).concat([{ x: 5, y: 70, z: 6, name: 'crying_obsidian' }]);
  assert.equal(inferPortalFrame(bad).blocked.length, 1);
});

test('見かけた構造物を覚える（村・廃ポータル・地表の溶岩溜まり）', () => {
  const places = {};
  const mem = { ...fakeMemory(places), setPlace: (n, p, d) => { places[n] = { x: p.x, y: p.y, z: p.z, dimension: d }; } };
  const V = (x, y, z) => ({ x, y, z, distanceTo: (q) => Math.hypot(q.x - x, q.y - y, q.z - z) });
  const world = { bell: [V(100, 64, 100)], crying_obsidian: [V(200, 65, 200)], lava: [V(0, 63, 0), V(1, 63, 0), V(2, 63, 0)] };
  const names = { 1: 'bell', 2: 'crying_obsidian', 3: 'lava' };
  const bot = {
    ...fakeBot(),
    entities: {},
    registry: { blocksByName: { bell: { id: 1 }, crying_obsidian: { id: 2 }, lava: { id: 3 }, obsidian: { id: 4 }, hay_bale: { id: 5 } } },
    findBlocks: ({ matching }) => [].concat(...[].concat(matching).map((id) => world[names[id]] ?? [])),
    blockAt: (p) => ({ name: 'lava', metadata: 0, position: p }),
  };
  noteStructures(bot, mem);
  assert.deepEqual(places.village, { x: 100, y: 64, z: 100, dimension: 'overworld' });
  assert.deepEqual(places.ruined_portal, { x: 200, y: 65, z: 200, dimension: 'overworld' });
  assert.equal(places.lava_pool.x, 0);
  // にせボットに findBlocks が無くても落ちない
  noteStructures(fakeBot(), fakeMemory());
});

test('村を知っていれば、食料・ベッドの前に村で集める（集め終わったら通常どおり）', () => {
  const base = { stone_pickaxe: 1, stone_sword: 1 };
  const village = { village: { x: 100, y: 64, z: 100, dimension: 'overworld' } };
  const s = nextStep(fakeBot(base), fakeMemory(village));
  assert.deepEqual([s.skill, s.args], ['lootVillage', { beds: 7, bread: 12 }]);
  assert.ok(SKILL_MAP.lootVillage);
  assert.equal(nextStep(fakeBot(base), fakeMemory(village, { villageLooted: true })).skill, 'gatherFood');
  assert.equal(nextStep(fakeBot(base), fakeMemory(village, { villageRetryAt: Date.now() + 60_000 })).skill, 'gatherFood');
  assert.equal(nextStep(fakeBot(base), fakeMemory()).skill, 'gatherFood');
});

test('鉄の防具は必須ではない（盾があれば水入りバケツへ進む）', () => {
  const bot = fakeBot({ iron_pickaxe: 1, iron_sword: 1, bucket: 1, cooked_beef: 20, shield: 1, white_bed: 1 });
  assert.equal(nextStep(bot, fakeMemory()).skill, 'fillWaterBucket');
  const noShield = fakeBot({ iron_pickaxe: 1, iron_sword: 1, bucket: 1, cooked_beef: 20, white_bed: 1 });
  assert.deepEqual(nextStep(noShield, fakeMemory()), { skill: 'getIronGear', args: { armor: false } });
});

test('廃ポータルを知っていれば、溶岩方式より先にそれを使う（使えないと分かったら溶岩方式へ）', () => {
  const base = { iron_pickaxe: 1, iron_sword: 1, water_bucket: 1, bucket: 1, cooked_beef: 20, shield: 1, white_bed: 1, oak_boat: 1 };
  const rp = { ruined_portal: { x: 50, y: 64, z: 50, dimension: 'overworld' } };
  assert.equal(nextStep(fakeBot(base), fakeMemory(rp)).skill, 'useRuinedPortal');
  assert.ok(SKILL_MAP.useRuinedPortal);
  assert.equal(nextStep(fakeBot(base), fakeMemory(rp, { ruinedPortalUnusable: true })).skill, 'castNetherPortal');
});

test('ネザーで砦の遺跡を知っていて金が無ければ、ロッドより先に金集め', () => {
  const nether = { dimension: 'the_nether' };
  const bastion = { bastion: { x: 0, y: 70, z: 0, dimension: 'the_nether' } };
  assert.equal(nextStep(fakeBot({ iron_pickaxe: 1 }, nether), fakeMemory(bastion)).skill, 'raidBastionGold');
  assert.equal(nextStep(fakeBot({ iron_pickaxe: 1, gold_ingot: 10 }, nether), fakeMemory(bastion)).skill, 'huntBlazes');
  assert.equal(nextStep(fakeBot({ stone_pickaxe: 1 }, nether), fakeMemory(bastion)).skill, 'huntBlazes');
});

test('経過時間は最初の判断で開始時刻を覚えてから数える', () => {
  const flags = {};
  const mem = { ...fakeMemory({}, flags), setFlag: (n, v) => { flags[n] = v; } };
  assert.equal(elapsedMinutes(mem), 0);
  assert.ok(flags.runStartedAt > 0);
  flags.runStartedAt = Date.now() - 5 * 60_000;
  assert.equal(elapsedMinutes(mem), 5);
  assert.equal(elapsedMinutes(fakeMemory()), 0); // setFlag の無いにせ記憶でも落ちない
});
