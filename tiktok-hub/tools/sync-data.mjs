// Copies each game's newest data files (actions / fields / datapack zip / resource pack) from the game folders next to
// this one into data/<game>/, so a copy of the hub without those folders (the downloadable zip) is up to date.
//   node tools/sync-data.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as defense from '../src/games/defense/index.js';
import * as clash from '../src/games/clash/index.js';
import * as anime from '../src/games/anime/index.js';
import * as halloween from '../src/games/halloween/index.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const WORK = path.dirname(ROOT);
let n = 0;
for (const mod of [defense, clash, anime, halloween]) {
  for (const [name, dir] of Object.entries(mod.meta.sources ?? {})) {
    const src = path.join(WORK, dir, name);
    const dst = path.join(ROOT, 'data', mod.meta.id, name);
    if (!fs.existsSync(src)) { console.log(`skip (no source): ${src}`); continue; }
    const same = fs.existsSync(dst) && Buffer.compare(fs.readFileSync(src), fs.readFileSync(dst)) === 0;
    if (!same) { fs.copyFileSync(src, dst); console.log(`updated data/${mod.meta.id}/${name}`); n++; }
  }
}
console.log(`${n} file(s) updated`);
