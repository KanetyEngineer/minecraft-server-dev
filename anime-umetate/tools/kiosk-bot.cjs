// Test the waiting-area signs and triggers: joins the test server (25592), right-clicks the nearest sign
// (interaction entity) after being teleported next to it by RCON, then tries /trigger records and /trigger leave.
// usage: node tools/kiosk-bot.cjs <name>
const path = require('path');
const NM = path.join(__dirname, '..', '..', 'minecraft-server-dev', 'ai', 'builder-bot', 'node_modules');
const mineflayer = require(path.join(NM, 'mineflayer'));

const NAME = process.argv[2] || 'Frank';
const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25592, username: NAME, version: '26.1.2', auth: 'offline' });
const log = (...a) => console.log(`[${new Date().toLocaleTimeString('ja-JP')}] ${NAME}:`, ...a);
bot.on('messagestr', (m) => log('chat:', m));
bot.on('error', (e) => log('error:', e.message));
bot.on('end', () => process.exit(0));
bot.once('spawn', async () => {
  log('spawned at', bot.entity.position.floored());
  await bot.waitForTicks(100); // the test runner teleports us next to a sign meanwhile
  const sign = bot.nearestEntity((e) => e.name === 'interaction');
  log('nearest interaction', sign?.position, 'me', bot.entity.position.floored());
  if (sign) { await bot.lookAt(sign.position.offset(0, 1, 0)); bot.activateEntity(sign); }
  await bot.waitForTicks(40);
  log('after click at', bot.entity.position.floored());
  bot.chat('/trigger records');
  await bot.waitForTicks(30);
  bot.chat('/trigger leave');
  await bot.waitForTicks(40);
  log('after leave at', bot.entity.position.floored());
  bot.quit();
});
