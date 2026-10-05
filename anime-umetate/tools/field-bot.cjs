// Multi-field playtest bot: joins the offline Paper test copy (25592) as a 26.1.2 client through ViaBackwards,
// picks a field (or queues for versus) from the waiting area, then fills that field's pit with the powder it is given.
// usage: node tools/field-bot.cjs <name> <field N | vs1 | vs2 | hub> [seconds] [placeDelayTicks]
// (mineflayer is borrowed read-only from minecraft-server-dev/ai/builder-bot)
const path = require('path');
const fs = require('fs');
const NM = path.join(__dirname, '..', '..', 'minecraft-server-dev', 'ai', 'builder-bot', 'node_modules');
const mineflayer = require(path.join(NM, 'mineflayer'));
const { Vec3 } = require(path.join(NM, 'vec3'));

const [NAME = 'Bot1', PICK = '1', SEC = '120', DELAY = '4'] = process.argv.slice(2);
const FIELDS = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'tiktok-live', 'datapack', 'anime_umetate_datapack.fields.json'), 'utf8')).fields;
const bot = mineflayer.createBot({ host: '127.0.0.1', port: Number(process.env.PORT || 25592), username: NAME, version: '26.1.2', auth: 'offline' });
const log = (...a) => console.log(`[${new Date().toLocaleTimeString('ja-JP')}] ${NAME}:`, ...a);
let placed = 0, fails = 0;

bot.on('messagestr', (m) => log('chat:', m));
bot.on('title', (t) => log('title:', String(t).slice(0, 100)));
bot.on('kicked', (r) => log('kicked:', JSON.stringify(r)));
bot.on('error', (e) => log('error:', e.message));
bot.on('end', () => { log(`end. placed=${placed} fails=${fails}`); process.exit(0); });

// the field the bot is standing in (by x position)
const fieldAt = (pos) => FIELDS.find((f) => pos.x >= f.x - 12 && pos.x <= f.x + 16 && pos.z >= f.z - 12 && pos.z <= f.z + 16);

bot.once('spawn', async () => {
  log('spawned at', bot.entity.position.floored());
  await bot.waitForTicks(40);
  if (PICK.startsWith('vs')) bot.chat(`/trigger versus set ${PICK.slice(2)}`);
  else if (PICK !== 'hub') bot.chat(`/trigger field set ${PICK}`);
  const end = Date.now() + Number(SEC) * 1000;
  let lastF = null;
  while (Date.now() < end) {
    try {
      const f = fieldAt(bot.entity.position);
      if (f?.n !== lastF?.n) { log('now in field', f?.n ?? 'hub', bot.entity.position.floored()); lastF = f; }
      const item = bot.inventory.items().find((i) => i.name.endsWith('concrete_powder'));
      if (!f || !item) { await bot.waitForTicks(10); continue; }
      await bot.equip(item, 'hand');
      const p = bot.entity.position.floored();
      let target = null;
      for (let dx = -2; dx <= 2 && !target; dx++) for (let dz = -2; dz <= 2 && !target; dz++) {
        for (let dy = -3; dy <= 1 && !target; dy++) {
          const b = bot.blockAt(p.offset(dx, dy, dz));
          const above = bot.blockAt(p.offset(dx, dy + 1, dz));
          const x = p.x + dx, z = p.z + dz;
          if (!b || !above || x < f.x || x > f.x + f.w - 1 || z < f.z || z > f.z + f.w - 1) continue;
          if (b.boundingBox === 'block' && above.name === 'air' && !(dx === 0 && dz === 0 && dy >= -1)) target = b;
        }
      }
      if (!target) { // nothing reachable: jump-place under ourselves (pillar)
        const below = bot.blockAt(p.offset(0, -1, 0));
        bot.setControlState('jump', true);
        await bot.waitForTicks(6);
        await bot.placeBlock(below, new Vec3(0, 1, 0)).then(() => placed++, () => fails++);
        bot.setControlState('jump', false);
      } else {
        await bot.lookAt(target.position.offset(0.5, 1, 0.5));
        await bot.placeBlock(target, new Vec3(0, 1, 0)).then(() => placed++, () => fails++);
      }
      await bot.waitForTicks(Number(DELAY));
    } catch (e) { fails++; await bot.waitForTicks(10); }
  }
  log(`done. placed=${placed} fails=${fails} pos=${bot.entity.position.floored()}`);
  bot.quit();
});
