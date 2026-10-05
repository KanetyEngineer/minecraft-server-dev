// quick RCON helper for development: node scripts/rc.mjs "cmd1" "cmd2" ...
import fs from 'node:fs';
import { Rcon } from '../app/src/rcon.js';
const props = fs.readFileSync(new URL('../server/server.properties', import.meta.url), 'utf8');
const get = (k) => props.match(new RegExp(`^${k}=(.*)$`, 'm'))[1].trim();
const r = new Rcon({ host: '127.0.0.1', port: Number(get('rcon\.port')), password: get('rcon\.password') });
for (const c of process.argv.slice(2)) console.log('>', c, '\n', await r.command(c));
r.close();
