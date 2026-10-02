// 試験用: 観察用のボットで接続し、設計図と実際のブロックを比べて、違うマスを一覧にする。
// 使い方: node scripts/inspect.js <設計図> <x> <y> <z> [観察ボットの名前]
// 観察ボットは設計図の近くまで行けないので、サーバーの OP 権限で近くへテレポートしてもらうか、近くで実行する
import fs from 'node:fs';
import path from 'node:path';
import mineflayer from 'mineflayer';
import { Vec3 } from 'vec3';
import { parseLitematic } from '../src/building/litematic.js';
import { matches, itemFor } from '../src/building/blocks.js';
import { rcon } from './rcon.js';

const [file, x, y, z, name = 'Inspector'] = process.argv.slice(2);
const p = fs.existsSync(file) ? file : path.join('schematics', file.endsWith('.litematic') ? file : `${file}.litematic`);
const schematic = await parseLitematic(fs.readFileSync(p));
const origin = new Vec3(Number(x), Number(y), Number(z));
const bot = mineflayer.createBot({
  host: process.env.MC_HOST || '127.0.0.1', port: Number(process.env.MC_PORT || 25572), username: name, auth: 'offline', version: '1.21.11',
});
bot.once('spawn', async () => {
  // RCON があれば観察ボットを設計図の上空へ（見るだけ。スペクテイターにして邪魔にならないようにする）
  if (process.env.RCON_PASSWORD) {
    const c = origin.offset(schematic.size.x / 2, schematic.size.y + 4, schematic.size.z / 2);
    await rcon([`gamemode spectator ${name}`, `tp ${name} ${c.x} ${c.y} ${c.z}`]).catch(() => {});
    await new Promise((r) => setTimeout(r, 3000));
  }
  await bot.waitForChunksToLoad();
  let ok = 0; let typeOk = 0; let total = 0;
  const wrong = [];
  for (const b of schematic.blocks) {
    if (!itemFor(bot.registry, b)) continue;
    total++;
    const w = bot.blockAt(origin.offset(b.x, b.y, b.z));
    if (matches(b, w)) ok++;
    if (matches(b, w, { checkProps: false })) typeOk++;
    else wrong.push(`(${b.x},${b.y},${b.z}) ${b.name} → ${w?.name}`);
    if (matches(b, w, { checkProps: false }) && !matches(b, w)) {
      wrong.push(`(${b.x},${b.y},${b.z}) ${b.name} 向き ${JSON.stringify(b.props)} → ${JSON.stringify(w.getProperties())}`);
    }
  }
  console.log(`種類が合っている: ${typeOk}/${total}、向きまで合っている: ${ok}/${total}`);
  for (const l of wrong.slice(0, 40)) console.log(`  ${l}`);
  if (wrong.length > 40) console.log(`  ほか ${wrong.length - 40} 件`);
  bot.quit();
  setTimeout(() => process.exit(0), 500);
});
bot.on('kicked', (r) => { console.error('kicked', r); process.exit(1); });
bot.on('error', (e) => { console.error(e.message); process.exit(1); });
