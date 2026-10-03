// 試験用: 設計図に要る素材をチェストに入れて、ボットの近くに並べる（RCON を使う。サーバーの OP 操作の代わり）。
// 使い方: RCON_PASSWORD=... node scripts/stock-chests.js <設計図> <基準のプレイヤー名> [dx dz]
// 基準のプレイヤーの位置から (dx, 0, dz)（既定 -3, 0）を先頭に、z 方向へ 1 マスおきにチェストを置く。
// <設計図> の代わりに inspect.js の MISSING_JSON（アイテム名 → 個数）を渡すと、その分だけを入れる。
import fs from 'node:fs';
import path from 'node:path';
import mcData from 'minecraft-data';
import { parseLitematic } from '../src/building/litematic.js';
import { materialList } from '../src/building/blocks.js';
import { rcon } from './rcon.js';

const [file, who, dx = '-3', dz = '0'] = process.argv.slice(2);
if (!file || !who) {
  console.error('使い方: node scripts/stock-chests.js <設計図> <基準のプレイヤー名> [dx dz]');
  process.exit(1);
}
const reg = mcData(process.env.MC_VERSION || '1.21.11');
let need;
if (file.endsWith('.json')) {
  need = new Map(Object.entries(JSON.parse(fs.readFileSync(file, 'utf8'))));
} else {
  const p = fs.existsSync(file) ? file : path.join('schematics', file.endsWith('.litematic') ? file : `${file}.litematic`);
  need = materialList(reg, (await parseLitematic(fs.readFileSync(p))).blocks).need;
}
const stacks = [];
for (const [item, n] of need) {
  const size = reg.itemsByName[item]?.stackSize ?? 64;
  for (let left = n; left > 0; left -= size) stacks.push([item, Math.min(size, left)]);
}
const cmds = [];
const chests = Math.ceil(stacks.length / 27);
for (let c = 0; c < chests; c++) {
  const at = `~${dx} ~ ~${Number(dz) + c * 2}`;
  cmds.push(`execute at ${who} run setblock ${at} chest replace`);
  stacks.slice(c * 27, c * 27 + 27).forEach(([item, n], slot) => {
    cmds.push(`execute at ${who} run item replace block ${at} container.${slot} with ${item} ${n}`);
  });
}
const out = await rcon(cmds);
const errors = out.filter((o) => /Unknown|Incorrect|Could not|No entity|not/.test(o));
console.log(`${[...need.values()].reduce((a, b) => a + b, 0)} 個（${stacks.length} スタック）をチェスト ${chests} 個に入れた`);
if (errors.length) console.log(`エラー: ${errors.slice(0, 5).join(' / ')}`);
