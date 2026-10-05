// Playtest bot: joins the offline Paper test copy (25592) as a 26.1.2 client through ViaBackwards,
// fills the pit by placing the powder it is given, and prints what happens.
// usage: node tools/playtest-bot.cjs [seconds]
const path = require('path');
const NM = path.join(__dirname, '..', '..', 'minecraft-server-dev', 'ai', 'builder-bot', 'node_modules');
const mineflayer = require(path.join(NM, 'mineflayer'));
const { Vec3 } = require(path.join(NM, 'vec3'));

const SECONDS = Number(process.argv[2]) || 90;
const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25592, username: 'PlayTester', version: '26.1.2', auth: 'offline' });
const log = (...a) => console.log(`[${new Date().toLocaleTimeString('ja-JP')}]`, ...a);
let placed = 0, fails = 0;

bot.on('messagestr', (m) => log('chat:', m));
bot.on('title', (t) => log('title:', String(t).slice(0, 80)));
bot.on('kicked', (r) => log('kicked:', JSON.stringify(r)));
bot.on('error', (e) => log('error:', e.message));
bot.on('end', () => { log(`end. placed=${placed} fails=${fails}`); process.exit(0); });

bot.once('spawn', async () => {
  log('spawned at', bot.entity.position, 'gamemode', bot.game.gameMode);
  await bot.waitForTicks(100);
  log('pos after round start', bot.entity.position.floored());
  log('hotbar', bot.inventory.slots.slice(36, 41).map((s) => s && `${s.name}x${s.count}`).join(', '));
  const end = Date.now() + SECONDS * 1000;
  while (Date.now() < end) {
    try {
      const item = bot.inventory.items().find((i) => i.name.endsWith('concrete_powder'));
      if (!item) { await bot.waitForTicks(10); continue; }
      await bot.equip(item, 'hand');
      // place on the block under our feet's neighbours: pick any reachable top face in the pit that is open above
      const p = bot.entity.position.floored();
      let target = null;
      for (let dx = -2; dx <= 2 && !target; dx++) for (let dz = -2; dz <= 2 && !target; dz++) {
        for (let dy = -3; dy <= 1 && !target; dy++) {
          const b = bot.blockAt(p.offset(dx, dy, dz));
          const above = bot.blockAt(p.offset(dx, dy + 1, dz));
          const x = p.x + dx, z = p.z + dz;
          if (!b || !above || x < 0 || x > 4 || z < 0 || z > 4) continue;
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
      await bot.waitForTicks(4);
    } catch (e) { fails++; await bot.waitForTicks(10); }
  }
  log(`done. placed=${placed} fails=${fails} pos=${bot.entity.position.floored()}`);
  bot.quit();
});
