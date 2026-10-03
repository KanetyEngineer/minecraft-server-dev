// 試験用の小さな小屋の設計図（schematics/sample-hut.litematic）を作る。
// サバイバルで集められる素材だけを使う: 丸石・オークの原木・板材・ハーフブロック・階段・ガラス・ドア・松明。
import fs from 'node:fs';
import { writeLitematic } from '../src/building/litematic.js';

const blocks = [];
const put = (x, y, z, name, props = {}) => blocks.push({ x, y, z, name, props });
const W = 5; const D = 5;
for (let x = 0; x < W; x++) for (let z = 0; z < D; z++) put(x, 0, z, 'cobblestone');
for (let y = 1; y <= 3; y++) {
  for (let x = 0; x < W; x++) {
    for (let z = 0; z < D; z++) {
      const edgeX = x === 0 || x === W - 1; const edgeZ = z === 0 || z === D - 1;
      if (!edgeX && !edgeZ) continue;
      if (edgeX && edgeZ) { put(x, y, z, 'oak_log', { axis: 'y' }); continue; }
      if (z === D - 1 && x === 2 && y <= 2) continue; // 入口
      if (y === 2 && ((x === 0 || x === W - 1) && z === 2)) { put(x, y, z, 'glass'); continue; }
      if (y === 2 && z === 0 && x === 2) { put(x, y, z, 'glass'); continue; }
      put(x, y, z, 'oak_planks');
    }
  }
}
put(2, 1, D - 1, 'oak_door', { facing: 'north', half: 'lower', hinge: 'left', open: 'false', powered: 'false' });
put(2, 2, D - 1, 'oak_door', { facing: 'north', half: 'upper', hinge: 'left', open: 'false', powered: 'false' });
put(2, 2, 1, 'wall_torch', { facing: 'south' });
// 屋根: ふちは板材、内側は上付きハーフブロック
for (let x = 0; x < W; x++) for (let z = 0; z < D; z++) {
  const edge = x === 0 || z === 0 || x === W - 1 || z === D - 1;
  put(x, 4, z, edge ? 'oak_planks' : 'oak_slab', edge ? {} : { type: 'top', waterlogged: 'false' });
}
// 入口の前の階段（外向き = 南から上る）
put(2, 0, D, 'cobblestone_stairs', { facing: 'north', half: 'bottom', shape: 'straight', waterlogged: 'false' });

const size = { x: W, y: 5, z: D + 1 };
fs.mkdirSync('schematics', { recursive: true });
fs.writeFileSync('schematics/sample-hut.litematic', writeLitematic({ name: 'sample-hut', blocks, size }));
console.log(`schematics/sample-hut.litematic: ${blocks.length} ブロック、${size.x}×${size.y}×${size.z}`);
