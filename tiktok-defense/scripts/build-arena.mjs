// dev: build the arena with default field settings through RCON and print errors
import fs from 'node:fs';
import { Rcon } from '../app/src/rcon.js';
import { arenaCommands } from '../app/src/arena.js';
const props = fs.readFileSync(new URL('../server/server.properties', import.meta.url), 'utf8');
const get = (k) => props.match(new RegExp(`^${k}=(.*)$`, 'm'))[1].trim();
const r = new Rcon({ host: '127.0.0.1', port: Number(get('rcon\.port')), password: get('rcon\.password') });
const f = { originX: 0, originY: -58, originZ: 0, length: 120, halfWidth: 4, gates: 3, timeOfDay: 13500, trees: true };
const { pre, commands, gates } = arenaCommands(f);
for (const c of pre) console.log(await r.command(c));
await new Promise((res) => setTimeout(res, 3000));
let bad = 0;
for (const c of commands) {
  const out = await r.command(c);
  if (/Unknown|Incorrect|Expected|not loaded|Invalid|Could not|Failed|error/i.test(out)) { bad++; console.log('!!', c.slice(0, 120), '\n   ', out.slice(0, 200)); }
}
console.log('commands', commands.length, 'bad', bad, 'gates', gates);
r.close();
