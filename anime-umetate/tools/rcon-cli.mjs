// node tools/rcon-cli.mjs "cmd1" "cmd2" ...  (reads RCON port/password from server/server.properties)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Rcon } from '../tiktok-live/src/rcon.js';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const props = fs.readFileSync(path.join(root, process.env.RCON_DIR || 'server', 'server.properties'), 'utf8');
const get = (k) => (props.match(new RegExp(`^${k.replace('.', '\.')}=(.*)$`, 'm')) ?? [])[1]?.trim();
const r = new Rcon({ host: '127.0.0.1', port: Number(get('rcon.port')), password: get('rcon.password') });
for (const c of process.argv.slice(2)) console.log(`> ${c}\n${await r.command(c)}`);
r.close();
