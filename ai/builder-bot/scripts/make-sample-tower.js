// 試験用: 高さ 13 の見張り塔（schematics/sample-tower.litematic）を作る。
// 素材の種類が多く（チェスト 2 個に分けて入れる）、はしご・窓・張り出したバルコニー・柵があり、
// 素材を用意してもらう建築（BUILD_SUPPLY=stocked）で、チェストとの往復・高い所の足場・壁に付けるブロックを確かめる。
import fs from 'node:fs';
import { writeLitematic } from '../src/building/litematic.js';

const blocks = [];
const put = (x, y, z, name, props = {}) => blocks.push({ x, y, z, name, props });
const N = 9; // バルコニーまで含めた幅。塔の本体は 1..7
const lo = 1; const hi = 7;
const mid = 4;
for (let x = lo; x <= hi; x++) for (let z = lo; z <= hi; z++) put(x, 0, z, 'polished_andesite');
for (let y = 1; y <= 9; y++) {
  for (let x = lo; x <= hi; x++) {
    for (let z = lo; z <= hi; z++) {
      const ex = x === lo || x === hi; const ez = z === lo || z === hi;
      if (!ex && !ez) continue;
      if (ex && ez) { put(x, y, z, 'stripped_spruce_log', { axis: 'y' }); continue; }
      if (z === hi && x === mid && y <= 2) continue; // 入口
      const window = (y === 3 || y === 4 || y === 7 || y === 8) && (x === mid || z === mid);
      put(x, y, z, window ? 'glass_pane' : 'stone_bricks');
    }
  }
  // 北の壁の内側のはしご（南向き = 北の壁に付く。窓ガラスには付かないので窓の隣の列）
  put(mid - 1, y, lo + 1, 'ladder', { facing: 'south', waterlogged: 'false' });
}
put(mid, 1, hi, 'spruce_door', { facing: 'north', half: 'lower', hinge: 'left', open: 'false', powered: 'false' });
put(mid, 2, hi, 'spruce_door', { facing: 'north', half: 'upper', hinge: 'left', open: 'false', powered: 'false' });
put(mid, 1, mid, 'lantern', { hanging: 'false', waterlogged: 'false' });
// 10 段目: 塔の床（はしごの上は穴）と、1 マス張り出したバルコニー
for (let x = 0; x < N; x++) {
  for (let z = 0; z < N; z++) {
    const inside = x >= lo && x <= hi && z >= lo && z <= hi;
    if (inside) {
      // はしごの上は床に穴を開け、穴の中まではしごを伸ばす（はしごが床の下で終わっていると、上がって出られない）
      if (x === mid - 1 && z === lo + 1) put(x, 10, z, 'ladder', { facing: 'south', waterlogged: 'false' });
      else put(x, 10, z, 'spruce_planks');
      continue;
    }
    put(x, 10, z, 'spruce_slab', { type: 'bottom', waterlogged: 'false' });
  }
}
// 11 段目: バルコニーの柵
for (let x = 0; x < N; x++) for (let z = 0; z < N; z++) {
  if (x === 0 || z === 0 || x === N - 1 || z === N - 1) put(x, 11, z, 'spruce_fence', { north: 'false', south: 'false', east: 'false', west: 'false', waterlogged: 'false' });
}
// 12 段目: 屋根（塔の上だけ）
for (let x = lo; x <= hi; x++) for (let z = lo; z <= hi; z++) put(x, 12, z, 'stone_brick_slab', { type: 'bottom', waterlogged: 'false' });
const size = { x: N, y: 13, z: N };
fs.mkdirSync('schematics', { recursive: true });
fs.writeFileSync('schematics/sample-tower.litematic', writeLitematic({ name: 'sample-tower', blocks, size }));
console.log(`schematics/sample-tower.litematic: ${blocks.length} ブロック、${size.x}×${size.y}×${size.z}`);
