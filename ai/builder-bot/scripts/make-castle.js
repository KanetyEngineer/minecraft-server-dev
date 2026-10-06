// お城の設計図（schematics/castle-2x2.litematic）を作る。2×2 チャンク（32×32）に収まる。
// - 四隅の塔（6×6・高さ 12）: 中にはしご、2 階・屋上、てっぺんに凸凹の胸壁（狭間）
// - 塔をつなぐ城壁（厚さ 2・高さ 7）: 上を歩ける。外側に胸壁、内側の壁に松明
// - 南の城門（幅 4・高さ 4、上は逆さ階段のアーチ）と、門から本丸への石畳の道
// - 真ん中の本丸（12×12・高さ 13）: 窓、3 階建て、扉、中にはしご、屋上に胸壁とランタン
// 石レンガに苔むした石レンガ・ひび割れた石レンガを少し混ぜる（決まった並びなので、何度作っても同じ）。
import fs from 'node:fs';
import { writeLitematic } from '../src/building/litematic.js';

const S = 32;
const map = new Map();
const put = (x, y, z, name, props = {}) => map.set(`${x},${y},${z}`, { x, y, z, name, props });
const del = (x, y, z) => map.delete(`${x},${y},${z}`);
// 石レンガの壁（少しだけ苔・ひび割れを混ぜる）
const hash = (x, y, z) => (((x * 73856093) ^ (y * 19349663) ^ (z * 83492791)) >>> 0) % 100;
const stone = (x, y, z) => {
  const h = hash(x, y, z);
  return h < 10 ? 'mossy_stone_bricks' : h < 16 ? 'cracked_stone_bricks' : 'stone_bricks';
};
const wall = (x, y, z) => put(x, y, z, stone(x, y, z));
const ladder = (x, y, z, facing) => put(x, y, z, 'ladder', { facing, waterlogged: 'false' });

// ---- 四隅の塔 ----
const T = 6; // 塔の幅
const TH = 11; // 塔の壁の高さ（y=0..10）。屋上は y=11 に立つ
const towers = [[0, 0], [S - T, 0], [0, S - T], [S - T, S - T]];
for (const [ox, oz] of towers) {
  for (let x = 0; x < T; x++) {
    for (let z = 0; z < T; z++) {
      const edge = x === 0 || z === 0 || x === T - 1 || z === T - 1;
      put(ox + x, 0, oz + z, 'stone_bricks');
      for (let y = 1; y < TH; y++) {
        if (edge) wall(ox + x, y, oz + z);
      }
      // 2 階の床と屋上の床
      if (!edge) {
        put(ox + x, 5, oz + z, 'spruce_planks');
        put(ox + x, TH - 1, oz + z, 'stone_bricks');
      }
      // 屋上の胸壁（ふちに 1 つおき）
      if (edge && (x + z) % 2 === 0) wall(ox + x, TH, oz + z);
    }
  }
  // 中庭側の 1 階の入口と、城壁の上へ出る入口（2 マスの高さの穴）
  const inX = ox === 0 ? T - 1 : 0; // 中庭に面した x の面
  const inZ = oz === 0 ? T - 1 : 0; // 中庭に面した z の面
  for (const y of [1, 2]) del(ox + inX, y, oz + 2);
  for (const y of [7, 8]) { del(ox + inX, y, oz + (oz === 0 ? 1 : T - 2)); del(ox + (ox === 0 ? 1 : T - 2), y, oz + inZ); }
  // はしご: 外側の x の壁の内側に沿って、1 階から屋上まで（2 階・屋上の床に穴を開けて、穴の中まで伸ばす）
  const lx = ox === 0 ? 1 : T - 2;
  const lz = oz + 3;
  const facing = ox === 0 ? 'east' : 'west';
  for (let y = 1; y < TH; y++) ladder(ox + lx, y, lz, facing);
  // 窓（矢狭間）: 外側の面の 3 段目と 8 段目
  for (const y of [3, 8]) {
    put(ox + (ox === 0 ? 0 : T - 1), y, oz + 2, 'glass_pane');
    put(ox + 2, y, oz + (oz === 0 ? 0 : T - 1), 'glass_pane');
  }
}

// ---- 城壁（塔と塔のあいだ。厚さ 2、高さ 7 = y 0..6。上が通路）----
const WH = 7;
const curtain = (x, z, outer) => {
  for (let y = 0; y < WH; y++) wall(x, y, z);
  if (outer && (x + z) % 2 === 0) wall(x, WH, z); // 外側のふちに胸壁
};
for (let i = T; i < S - T; i++) {
  curtain(i, 0, true); curtain(i, 1, false); // 北
  curtain(i, S - 1, true); curtain(i, S - 2, false); // 南
  curtain(0, i, true); curtain(1, i, false); // 西
  curtain(S - 1, i, true); curtain(S - 2, i, false); // 東
}
// 中庭側の壁に松明（5 マスおき、3 段目）
for (let i = T + 2; i < S - T; i += 5) {
  put(i, 3, 2, 'wall_torch', { facing: 'south' });
  put(i, 3, S - 3, 'wall_torch', { facing: 'north' });
  put(2, 3, i, 'wall_torch', { facing: 'east' });
  put(S - 3, 3, i, 'wall_torch', { facing: 'west' });
}

// ---- 南の城門（x 14..17、高さ 4）----
const g0 = 14; const g1 = 17;
for (let x = g0; x <= g1; x++) {
  for (const z of [S - 2, S - 1]) {
    for (let y = 1; y <= 4; y++) del(x, y, z);
    put(x, 0, z, 'cobblestone'); // 門の下の石畳
  }
}
// 門の上の角を逆さ階段でアーチにする
for (const z of [S - 2, S - 1]) {
  put(g0, 4, z, 'stone_brick_stairs', { facing: 'west', half: 'top', shape: 'straight', waterlogged: 'false' });
  put(g1, 4, z, 'stone_brick_stairs', { facing: 'east', half: 'top', shape: 'straight', waterlogged: 'false' });
}
// 門の両わきの胸壁の上にランタン
put(g0 - 1, WH + 1, S - 1, 'lantern', { hanging: 'false', waterlogged: 'false' });
put(g1 + 1, WH + 1, S - 1, 'lantern', { hanging: 'false', waterlogged: 'false' });
if (!map.has(`${g0 - 1},${WH},${S - 1}`)) wall(g0 - 1, WH, S - 1);
if (!map.has(`${g1 + 1},${WH},${S - 1}`)) wall(g1 + 1, WH, S - 1);

// ---- 門から本丸への石畳の道 ----
for (let x = g0; x <= g1; x++) for (let z = 22; z <= S - 3; z++) put(x, 0, z, 'cobblestone');

// ---- 本丸（x 10..21、z 10..21、壁は y 1..11、屋上の床 y=11）----
const k0 = 10; const k1 = 21; const KH = 12;
for (let x = k0; x <= k1; x++) {
  for (let z = k0; z <= k1; z++) {
    const ex = x === k0 || x === k1; const ez = z === k0 || z === k1;
    const edge = ex || ez;
    put(x, 0, z, 'polished_andesite');
    for (let y = 1; y < KH; y++) {
      if (!edge) continue;
      // 四隅は磨かれた安山岩の柱、5 段目に 1 周の帯
      put(x, y, z, (ex && ez) || y === 5 ? 'polished_andesite' : stone(x, y, z));
    }
    if (!edge) {
      put(x, 5, z, 'spruce_planks'); // 2 階の床
      put(x, KH - 1, z, 'stone_bricks'); // 屋上の床
    }
    if (edge && (x + z) % 2 === 1) wall(x, KH, z); // 屋上の胸壁
  }
}
// 窓（各面 2 か所、2 段の高さ × 2 階）
for (const y of [2, 3, 7, 8]) {
  for (const a of [k0 + 3, k1 - 3]) {
    put(a, y, k0, 'glass_pane'); put(a, y, k1, 'glass_pane');
    put(k0, y, a, 'glass_pane'); put(k1, y, a, 'glass_pane');
  }
}
// 扉（南の面のまん中。外の南側から北を向いて付ける）
put(15, 1, k1, 'spruce_door', { facing: 'north', half: 'lower', hinge: 'left', open: 'false', powered: 'false' });
put(15, 2, k1, 'spruce_door', { facing: 'north', half: 'upper', hinge: 'left', open: 'false', powered: 'false' });
// はしご: 北の壁の内側、1 階から屋上の床の穴の中まで
for (let y = 1; y < KH; y++) ladder(k0 + 2, y, k0 + 1, 'south');
// 屋上の四隅のランタン（胸壁の上）
for (const [x, z] of [[k0, k0], [k1, k0], [k0, k1], [k1, k1]]) {
  if (!map.has(`${x},${KH},${z}`)) wall(x, KH, z);
  put(x, KH + 1, z, 'lantern', { hanging: 'false', waterlogged: 'false' });
}

const blocks = [...map.values()];
const size = { x: S, y: KH + 2, z: S };
fs.mkdirSync('schematics', { recursive: true });
fs.writeFileSync('schematics/castle-2x2.litematic', writeLitematic({ name: 'castle-2x2', blocks, size }));
const counts = {};
for (const b of blocks) counts[b.name] = (counts[b.name] ?? 0) + 1;
console.log(`schematics/castle-2x2.litematic: ${blocks.length} ブロック、${size.x}×${size.y}×${size.z}`);
console.log(Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([n, c]) => `${n}×${c}`).join(', '));
