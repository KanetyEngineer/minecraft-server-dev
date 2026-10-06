import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Vec3 } from 'vec3';
import mcData from 'minecraft-data';
import { clickPoint, seesFace, orientOk, placeCandidates, legitPlacement } from '../src/building/sight.js';

// 本物の当たり判定で目から面が見えるかを試すための、小さな世界
const require = createRequire(import.meta.url);
const VERSION = '1.21.11';
const reg = mcData(VERSION);
const World = require('prismarine-world')(VERSION);
const Chunk = require('prismarine-chunk')(VERSION);
function makeWorld(blocks) {
  const world = new World(null).sync;
  for (const cx of [-1, 0]) for (const cz of [-1, 0]) world.setColumn(cx, cz, new Chunk({ minY: -64, worldHeight: 384 }));
  for (const [x, y, z, name, props] of blocks) {
    const b = reg.blocksByName[name];
    let state = b.defaultState;
    if (props?.type && name.endsWith('_slab')) state = b.minStateId + ['top', 'bottom', 'double'].indexOf(props.type) * 2 + 1; // waterlogged=false
    world.setBlockStateId(new Vec3(x, y, z), state);
  }
  const bot = { world, blockAt: (p) => world.getBlock(p) };
  return bot;
}

test('クリックする点: 上の面・横の面の上半分・下付きハーフの横には上半分が無い', () => {
  const bot = makeWorld([[0, 64, 0, 'stone'], [2, 64, 0, 'stone_slab', { type: 'bottom' }]]);
  assert.deepEqual(clickPoint(bot.blockAt(new Vec3(0, 64, 0)), 'up').delta.toArray(), [0.5, 1, 0.5]);
  assert.equal(clickPoint(bot.blockAt(new Vec3(0, 64, 0)), 'east', 'top').delta.y, 0.75);
  assert.equal(clickPoint(bot.blockAt(new Vec3(2, 64, 0)), 'east', 'top'), null);
  assert.equal(clickPoint(bot.blockAt(new Vec3(2, 64, 0)), 'up').delta.y, 0.5); // 下付きハーフの上面は高さ 0.5
});

test('目から見えない面（壁越し・裏側・遠すぎ）には置けない', () => {
  const bot = makeWorld([[0, 64, 0, 'stone']]);
  const ref = bot.blockAt(new Vec3(0, 64, 0));
  const top = clickPoint(ref, 'up').point; // (0.5, 65, 0.5)
  assert.ok(seesFace(bot.world, new Vec3(0.5, 66.62, 2.5), ref, 'up', top)); // 2 マス離れて上から見下ろす
  assert.ok(!seesFace(bot.world, new Vec3(0.5, 63.62, 2.5), ref, 'up', top)); // 下からは上の面が見えない
  assert.ok(!seesFace(bot.world, new Vec3(0.5, 66.62, 6.5), ref, 'up', top)); // 遠すぎる（4.5 マスより先）
  const walled = makeWorld([[0, 64, 0, 'stone'], [0, 65, 1, 'stone'], [0, 66, 1, 'stone']]);
  const ref2 = walled.blockAt(new Vec3(0, 64, 0));
  assert.ok(!seesFace(walled.world, new Vec3(0.5, 66.62, 2.5), ref2, 'up', top)); // 間の壁越しには置けない
});

test('階段は、クリックする点を見たときの向きが設計図の向きになる所からだけ置く', () => {
  const stairs = { name: 'oak_stairs', props: { facing: 'north', half: 'bottom', shape: 'straight' } };
  const point = new Vec3(0.5, 65, 0.5);
  assert.ok(orientOk(stairs, new Vec3(0.5, 66.62, 2.5), point)); // 南から北を見る
  assert.ok(!orientOk(stairs, new Vec3(0.5, 66.62, -1.5), point)); // 北から南を見る
  assert.ok(!orientOk(stairs, new Vec3(2.5, 66.62, 2.5), point)); // ちょうど斜め 45 度は避ける
});

test('上を向くピストンは、上から見下ろして置く', () => {
  const piston = { name: 'piston', props: { facing: 'up', extended: 'false' } };
  const point = new Vec3(0.5, 65, 0.5);
  assert.ok(orientOk(piston, new Vec3(0.7, 67.62, 0.9), point));
  assert.ok(!orientOk(piston, new Vec3(0.5, 65.62, 3.5), point)); // 横から見ると横向きになる
});

test('置ける候補: 見える面だけを選ぶ', () => {
  const bot = makeWorld([[0, 64, 0, 'stone'], [1, 65, 0, 'stone']]); // 置くマス (0,65,0) の下と東にブロック
  const p = new Vec3(0, 65, 0);
  const cands = placeCandidates(bot, p, { name: 'stone', props: {} });
  assert.deepEqual([...new Set(cands.map((c) => c.face))].sort(), ['up', 'west']);
  // 西側の下から見上げると、下のブロックの上面は見えず、東のブロックの西の面だけが見える
  const c = legitPlacement(bot, new Vec3(-1.5, 64.62, 0.5), null, cands);
  assert.equal(c?.face, 'west');
});
