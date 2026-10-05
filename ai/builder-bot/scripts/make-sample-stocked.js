// 試験用: 自分では集めにくい素材（コンクリート・色付き羊毛・石レンガ・ランタン）を使い、
// チェストに用意した素材だけで建てる確認用の小屋（schematics/sample-stocked.litematic）を作る。
// 壁から突き出た梁（下に支えが無い）があるので、仮の足場を積んで片付ける動きも確かめられる。
import fs from 'node:fs';
import { writeLitematic } from '../src/building/litematic.js';

const blocks = [];
const put = (x, y, z, name, props = {}) => blocks.push({ x, y, z, name, props });
const W = 5; const D = 5;
for (let x = 0; x < W; x++) for (let z = 0; z < D; z++) put(x, 0, z, 'white_concrete');
for (let y = 1; y <= 3; y++) {
  for (let x = 0; x < W; x++) {
    for (let z = 0; z < D; z++) {
      const edgeX = x === 0 || x === W - 1; const edgeZ = z === 0 || z === D - 1;
      if (!edgeX && !edgeZ) continue;
      if (z === D - 1 && x === 2 && y <= 2) continue; // 入口
      if (y === 2 && x === 2 && z === 0) { put(x, y, z, 'glass'); continue; }
      put(x, y, z, edgeX && edgeZ ? 'stone_bricks' : 'red_wool');
    }
  }
}
// 屋根は下付きハーフブロック
for (let x = 0; x < W; x++) for (let z = 0; z < D; z++) put(x, 4, z, 'stone_brick_slab', { type: 'bottom', waterlogged: 'false' });
// 東の壁から突き出た梁（y=3、下は空気）と、その先に載せるランタン
put(W, 3, 2, 'oak_planks');
put(W + 1, 3, 2, 'oak_planks');
put(W + 1, 4, 2, 'lantern', { hanging: 'false', waterlogged: 'false' });
// 入口の前の階段
put(2, 0, D, 'stone_brick_stairs', { facing: 'north', half: 'bottom', shape: 'straight', waterlogged: 'false' });

const size = { x: W + 2, y: 5, z: D + 1 };
fs.mkdirSync('schematics', { recursive: true });
fs.writeFileSync('schematics/sample-stocked.litematic', writeLitematic({ name: 'sample-stocked', blocks, size }));
console.log(`schematics/sample-stocked.litematic: ${blocks.length} ブロック、${size.x}×${size.y}×${size.z}`);
