// 社会生活のためのスキル（家を建てる・畑・共同倉庫・会話・贈り物・集会・掲示板）。
// 体の動き（移動・採掘・クラフト）は DragonBot の common.js をそのまま使う。
// ctx.society = { persona, traits, town, rel, flags } が入っている（society.js で Agent に渡す）。
import { Vec3 } from 'vec3';
import {
  SkillError, abortable, goTo, travelTo, goals, craftItem, ensurePlanks, mineBlocks, pickUpItems, placeNear, cheapBlock,
  equipCheapestTool, ensureCraftingTable, smelt,
} from '../skills/common.js';
import { gatherWood } from '../skills/overworld.js';
import { deliverItems } from '../skills/general.js';
import { count, countMatching, findItem, foodPoints, isLog, isPlanks, FOODS } from '../util/items.js';
import { sleep } from '../body/humanize.js';
import { plotCenter, STORAGE_OFFSET } from './town.js';
import { personaByName } from './personas.js';
import * as say from './dialogue.js';

const AIR = new Set(['air', 'cave_air', 'void_air']);
const SOFT = /^(short_grass|grass|tall_grass|fern|large_fern|dead_bush|snow|.*_flower|dandelion|poppy|.*_tulip|cornflower|oxeye_daisy|azure_bluet|allium|blue_orchid|sweet_berry_bush|bush|firefly_bush|leaf_litter|short_dry_grass|tall_dry_grass|vine|.*_sapling|.*_mushroom|sugar_cane|kelp|kelp_plant|seagrass|tall_seagrass)$/;
// 右クリックで開いてしまうので、設置の足がかりにしないブロック
const INTERACTIVE = /(crafting_table|chest|furnace|smoker|barrel|_bed|_door|trapdoor|fence_gate|anvil|lever|_button|loom|smithing_table|grindstone|stonecutter|enchanting_table|brewing_stand|cartography_table|hopper|dispenser|dropper|note_block|bell)$/;
const DIRS = [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]];
const isAir = (b) => !b || AIR.has(b.name);
const isSolid = (b) => !!b && b.boundingBox === 'block' && !/_leaves$/.test(b.name);
const isFluid = (b) => !!b && (b.name === 'water' || b.name === 'lava');

const S = (ctx) => {
  if (!ctx.society) throw new SkillError('社会モードではない');
  return ctx.society;
};

function here(bot) {
  const p = bot.entity.position;
  return { x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) };
}

// (x, z) の地面の高さ（いちばん上の固いブロックの y）。葉・木・草は地面としない。読み込まれていなければ null
export function groundY(bot, x, z, yHint) {
  for (let y = yHint + 10; y >= yHint - 14; y--) {
    const b = bot.blockAt(new Vec3(x, y, z));
    if (!b) return null;
    if (isFluid(b)) return { y, water: true };
    if (b.boundingBox === 'block' && !/(_leaves|_log|_wood)$/.test(b.name)) return { y, water: false };
  }
  return null;
}

// ---------- 建築の部品 ----------

// 壁や床に使えるブロック（板材 → 丸石 → 石 → 土の順で使う）
const BUILD_PREF = [(n) => isPlanks(n), (n) => n === 'cobblestone', (n) => n === 'cobbled_deepslate', (n) => n === 'stone', (n) => n === 'dirt'];
export function buildingItem(bot) {
  const items = bot.inventory.items();
  for (const ok of BUILD_PREF) {
    const it = items.find((i) => ok(i.name));
    if (it) return it;
  }
  return null;
}
export const buildingCount = (bot) => countMatching(bot, (n) => BUILD_PREF.some((ok) => ok(n)));

// 自分の体がそのマスにかかっているか（自分のいる所には置けない）
function occupies(bot, pos) {
  const p = bot.entity.position;
  return Math.abs(p.x - (pos.x + 0.5)) < 0.8 && Math.abs(p.z - (pos.z + 0.5)) < 0.8 && pos.y >= Math.floor(p.y) - 0.01 && pos.y <= p.y + 1.8;
}

// pos にブロックを置く。すでに固いブロックがあれば何もしない。置けたら true
export async function placeAt(ctx, pos, pickItem = buildingItem) {
  const { bot } = ctx;
  abortable(ctx);
  let b = bot.blockAt(pos);
  if (!b) return false;
  if (isSolid(b)) return true;
  if (/_leaves$/.test(b.name) || SOFT.test(b.name)) {
    await goTo(ctx, pos.x, pos.y, pos.z, 3).catch(() => {});
    await equipCheapestTool(bot, b).catch(() => {});
    await bot.dig(b, true).catch(() => {});
    b = bot.blockAt(pos);
  }
  // 足がかり: 隣の固いブロック（開けるブロックは右クリックで開いてしまうので使わない）
  let ref = null; let face = null;
  for (const [dx, dy, dz] of DIRS) {
    const r = bot.blockAt(pos.offset(dx, dy, dz));
    if (r && r.boundingBox === 'block' && !INTERACTIVE.test(r.name)) { ref = r; face = new Vec3(-dx, -dy, -dz); break; }
  }
  if (!ref) return false;
  const eye = () => bot.entity.position.offset(0, 1.62, 0);
  if (eye().distanceTo(pos.offset(0.5, 0.5, 0.5)) > 4.2) {
    await goTo(ctx, pos.x, pos.y, pos.z, 3).catch(() => {});
  }
  if (occupies(bot, pos)) {
    await bot.pathfinder.goto(new goals.GoalInvert(new goals.GoalNear(pos.x, pos.y, pos.z, 1.5))).catch(() => {});
    try { bot.pathfinder.setGoal(null); } catch {}
  }
  if (occupies(bot, pos) || eye().distanceTo(pos.offset(0.5, 0.5, 0.5)) > 5) return false;
  const item = typeof pickItem === 'string' ? findItem(bot, pickItem) : pickItem(bot);
  if (!item) throw new SkillError('置くブロックが無い');
  try {
    await bot.equip(item, 'hand');
    await bot._placeBlockWithOptions(ref, face, { swingArm: 'right', forceLook: true });
  } catch {
    // 置けたのに確認が来なかっただけのこともあるので、下で確かめる
  }
  await bot.waitForTicks(2);
  return isSolid(bot.blockAt(pos)) || (typeof pickItem === 'string' && bot.blockAt(pos)?.name !== b.name);
}

async function clearAt(ctx, pos) {
  const { bot } = ctx;
  const b = bot.blockAt(pos);
  if (!b || isAir(b) || isFluid(b)) return;
  if (b.boundingBox !== 'block' && !SOFT.test(b.name) && !/_leaves$/.test(b.name)) return;
  if (!bot.canDigBlock(b) && b.position.distanceTo(bot.entity.position) > 4) await goTo(ctx, pos.x, pos.y, pos.z, 3).catch(() => {});
  const b2 = bot.blockAt(pos);
  if (!b2 || !bot.canDigBlock(b2)) return;
  await equipCheapestTool(bot, b2).catch(() => {});
  await bot.dig(b2, true).catch(() => {});
}

// ---------- 家 ----------

// 家の設計（5×5、壁の高さ 3、平らな屋根）。door は広場の方を向いた辺の真ん中
export function housePlan(house) {
  const { x, y, z } = house;
  const [ddx, ddz] = house.door;
  const floor = []; const walls = []; const roof = []; const inside = []; const doorCells = [];
  for (let dx = -2; dx <= 2; dx++) {
    for (let dz = -2; dz <= 2; dz++) {
      floor.push(new Vec3(x + dx, y - 1, z + dz));
      const edge = Math.abs(dx) === 2 || Math.abs(dz) === 2;
      const isDoor = dx === ddx * 2 && dz === ddz * 2;
      for (let dy = 0; dy <= 2; dy++) {
        const p = new Vec3(x + dx, y + dy, z + dz);
        if (!edge) inside.push(p);
        else if (isDoor && dy <= 1) doorCells.push(p);
        else walls.push(p);
      }
      roof.push({ p: new Vec3(x + dx, y + 3, z + dz), ring: Math.max(Math.abs(dx), Math.abs(dz)) });
    }
  }
  // 壁は下から、屋根は外側から内側へ（隣が置いてあれば足がかりにできる）
  walls.sort((a, b) => a.y - b.y);
  roof.sort((a, b) => b.ring - a.ring);
  return { floor, walls, roof: roof.map((r) => r.p), inside, doorCells };
}

// 区画を決める: 広場を中心にした円周上の自分の区画。でこぼこや水が多ければ外側へずらす
async function choosePlot(ctx) {
  const { bot } = ctx;
  const { town, persona } = S(ctx);
  if (town.profile.house?.y !== undefined) return town.profile.house;
  const plaza = town.plaza() ?? town.setPlaza(bot.entity.position);
  // たどり着けなかった区画（崖の上など。経路が見つからず立ち止まってフリーズ回避で中断される）は 2 回で諦めて外側を探す
  const fails = (S(ctx).flags.plotFails ??= {});
  for (let shift = 0; shift <= 30; shift += 6) {
    abortable(ctx);
    if ((fails[shift] ?? 0) >= 2) continue;
    const c = plotCenter(plaza, persona.id, { shift });
    fails[shift] = (fails[shift] ?? 0) + 1;
    await travelTo(ctx, c.x, c.z, { range: 3 });
    if (Math.hypot(bot.entity.position.x - c.x, bot.entity.position.z - c.z) > 8) { ctx.log.info(`区画 (${c.x}, ${c.z}) にたどり着けない`); continue; }
    fails[shift] = 0;
    const hint = Math.round(bot.entity.position.y);
    const ys = [];
    let water = 0;
    for (let dx = -2; dx <= 2; dx++) {
      for (let dz = -2; dz <= 2; dz++) {
        const g = groundY(bot, c.x + dx, c.z + dz, hint);
        if (!g) continue;
        if (g.water) water++;
        ys.push(g.y);
      }
    }
    if (ys.length < 20 || water > 3) { ctx.log.info(`区画 (${c.x}, ${c.z}) は水が多いので外側を探す`); continue; }
    ys.sort((a, b) => a - b);
    const base = ys[Math.floor(ys.length / 2)];
    if (ys.at(-1) - ys[0] > 4) { ctx.log.info(`区画 (${c.x}, ${c.z}) はでこぼこが大きいので外側を探す`); continue; }
    // 玄関は広場の方を向ける
    const vx = plaza.x - c.x; const vz = plaza.z - c.z;
    const door = Math.abs(vx) > Math.abs(vz) ? [Math.sign(vx), 0] : [0, Math.sign(vz) || 1];
    town.profile.house = { x: c.x, y: base + 1, z: c.z, door, stage: 'foundation', startedAt: Date.now() };
    town.publish(bot);
    town.event('plot', `${persona.call}が家の場所を (${c.x}, ${c.z}) に決めた`);
    return town.profile.house;
  }
  throw new SkillError('家を建てられる平らな場所が見つからない');
}

// 建築に使うブロックを n 個そろえる（原木を板材にし、足りなければ木を切る）
async function ensureBuildingBlocks(ctx, n) {
  const { bot } = ctx;
  for (let round = 0; round < 3 && buildingCount(bot) < n; round++) {
    const logs = countMatching(bot, isLog);
    if (logs > 1) {
      const planks = countMatching(bot, isPlanks);
      await ensurePlanks(ctx, Math.min(planks + (logs - 1) * 4, planks + 64)).catch(() => {});
      continue;
    }
    const need = Math.min(24, Math.ceil((n - buildingCount(bot)) / 4) + 2);
    await gatherWood(ctx, { logs: need });
  }
  return buildingCount(bot);
}

export async function buildHouse(ctx) {
  const { bot } = ctx;
  const soc = S(ctx);
  const { town, persona, rel } = soc;
  const house = await choosePlot(ctx);
  if (house.stage === 'done') return '家はもう完成している';
  const plan = housePlan(house);
  const remaining = () => [...plan.walls, ...plan.roof].filter((p) => !isSolid(bot.blockAt(p))).length;
  // 材料: 残りの壁と屋根 + 床の穴埋めの分
  const need = Math.max(8, Math.min(90, remaining() + 6));
  if (buildingCount(bot) < Math.min(need, 40)) await ensureBuildingBlocks(ctx, need);
  if (buildingCount(bot) < 8) throw new SkillError('建築に使うブロックが足りない');
  await travelTo(ctx, house.x, house.z, { range: 4 });

  // 1) 敷地をならす: 中と壁の位置の邪魔な物を取り除き、床の穴を埋める
  if (house.stage === 'foundation') {
    for (const p of [...plan.inside, ...plan.doorCells]) await clearAt(ctx, p);
    for (const p of plan.walls) { const b = bot.blockAt(p); if (b && (/_leaves$/.test(b.name) || SOFT.test(b.name))) await clearAt(ctx, p); }
    for (const p of plan.floor) {
      abortable(ctx);
      if (isSolid(bot.blockAt(p))) continue;
      // 1〜3 マスの穴は下から埋める
      for (let d = 3; d >= 0; d--) {
        const q = p.offset(0, -d, 0);
        if (!isSolid(bot.blockAt(q))) await placeAt(ctx, q).catch(() => false);
      }
    }
    house.stage = 'walls';
    town.publish(bot);
  }
  // 2) 壁
  let placed = 0;
  if (house.stage === 'walls') {
    for (const p of plan.walls) {
      if (!buildingItem(bot)) break;
      if (isSolid(bot.blockAt(p))) continue;
      if (await placeAt(ctx, p).catch((e) => { if (e.name === 'AbortError') throw e; return false; })) placed++;
    }
    const left = plan.walls.filter((p) => !isSolid(bot.blockAt(p))).length;
    if (left > 2) { town.publish(bot); return `壁を ${placed} 個積んだ（残り ${left}）`; }
    house.stage = 'roof';
    town.publish(bot);
  }
  // 3) 屋根: 家の中に入って、外側から内側へ置く
  if (house.stage === 'roof') {
    await goTo(ctx, house.x, house.y, house.z, 0.8).catch(() => {});
    for (const p of plan.roof) {
      if (!buildingItem(bot)) break;
      if (isSolid(bot.blockAt(p))) continue;
      if (await placeAt(ctx, p).catch((e) => { if (e.name === 'AbortError') throw e; return false; })) placed++;
    }
    const left = plan.roof.filter((p) => !isSolid(bot.blockAt(p))).length;
    if (left > 1) { town.publish(bot); return `屋根を張っている（残り ${left}）`; }
    house.stage = 'door';
    town.publish(bot);
  }
  // 4) 扉・明かり・家具
  if (house.stage === 'door') {
    await furnish(ctx, house, plan).catch((e) => { if (e.name === 'AbortError') throw e; ctx.log.warn(`家具: ${e.message}`); });
    house.stage = 'done';
    house.doneAt = Date.now();
    ctx.memory.setPlace('home', new Vec3(house.x, house.y, house.z), 'overworld');
    town.publish(bot);
    town.event('house', `${persona.call}（${persona.mbti}）の家が完成した`, { pos: { x: house.x, y: house.y, z: house.z } });
    rel.diary('自分の家が完成した。');
    ctx.say?.(say.voice(persona, `{I}の家が完成した！ (${house.x}, ${house.z}) にあるよ。`));
    return '家が完成した';
  }
  return `家づくり（${house.stage}）`;
}

async function furnish(ctx, house, plan) {
  const { bot } = ctx;
  // 扉: 持っている板材の木の種類の扉を作る
  const planks = bot.inventory.items().find((i) => isPlanks(i.name));
  const doorName = planks ? planks.name.replace('_planks', '_door') : 'oak_door';
  if (!countMatching(bot, (n) => n.endsWith('_door')) && bot.registry.itemsByName[doorName]) {
    await ensurePlanks(ctx, 6, planks?.name).catch(() => {});
    await craftItem(ctx, doorName, 1).catch((e) => ctx.log.warn(`扉を作れなかった: ${e.message}`));
  }
  const doorItem = bot.inventory.items().find((i) => i.name.endsWith('_door'));
  const doorPos = plan.doorCells.sort((a, b) => a.y - b.y)[0];
  if (doorItem && doorPos && isAir(bot.blockAt(doorPos))) {
    const floor = bot.blockAt(doorPos.offset(0, -1, 0));
    // 家の中から外を向いて置く
    await goTo(ctx, house.x, house.y, house.z, 0.8).catch(() => {});
    try {
      await bot.equip(doorItem, 'hand');
      await bot.lookAt(doorPos.offset(0.5, 0.5, 0.5), true);
      await bot._placeBlockWithOptions(floor, new Vec3(0, 1, 0), { swingArm: 'right', forceLook: true });
    } catch (e) {
      ctx.log.warn(`扉を置けなかった: ${e.message}`);
    }
  }
  // 明かり（暗い家の中ではモンスターが湧くので、松明を 1 本）
  if (!findItem(bot, 'torch')) {
    if (!count(bot, 'coal') && !count(bot, 'charcoal') && countMatching(bot, isLog) >= 2) {
      const log = bot.inventory.items().find((i) => isLog(i.name));
      await smelt(ctx, log.name, 1).catch(() => {});
    }
    if (count(bot, 'coal') + count(bot, 'charcoal') > 0) await craftItem(ctx, 'torch', 4).catch(() => {});
  }
  const torch = findItem(bot, 'torch');
  if (torch) {
    const [ddx, ddz] = house.door;
    // 扉の向かいの壁の内側に付ける
    const wall = bot.blockAt(new Vec3(house.x - ddx * 2, house.y + 1, house.z - ddz * 2));
    if (wall && wall.boundingBox === 'block') {
      try {
        await bot.equip(torch, 'hand');
        await bot._placeBlockWithOptions(wall, new Vec3(ddx, 0, ddz), { swingArm: 'right', forceLook: true });
      } catch {}
    }
  }
  // 家具: 作業台・チェスト・ベッドを家の中に置く
  await goTo(ctx, house.x, house.y, house.z, 0.8).catch(() => {});
  for (const name of ['crafting_table', 'chest']) {
    if (!findItem(bot, name)) {
      await ensurePlanks(ctx, name === 'chest' ? 8 : 4).catch(() => {});
      await craftItem(ctx, name, 1, name === 'crafting_table' ? { noTable: true } : {}).catch(() => {});
    }
    if (findItem(bot, name)) await placeNear(ctx, name).catch((e) => ctx.log.warn(`${name} を置けなかった: ${e.message}`));
  }
  const bed = bot.inventory.items().find((i) => i.name.endsWith('_bed'));
  if (bed) await placeBed(ctx, house).catch(() => {});
}

async function placeBed(ctx, house) {
  const { bot } = ctx;
  const bed = bot.inventory.items().find((i) => i.name.endsWith('_bed'));
  if (!bed) return false;
  await goTo(ctx, house.x, house.y, house.z, 0.8).catch(() => {});
  const placed = await placeNear(ctx, bed.name).catch(() => null);
  if (placed) {
    ctx.memory.setPlace('bed', placed.position, 'overworld');
    ctx.society.town.event('bed', `${ctx.society.persona.call}が家にベッドを置いた`);
  }
  return !!placed;
}

// 家に帰る（夜はベッドがあれば寝る）
export async function goHome(ctx) {
  const { bot } = ctx;
  const house = S(ctx).town.profile.house;
  if (!house || house.stage !== 'done') throw new SkillError('まだ家が無い');
  await travelTo(ctx, house.x, house.z, { range: 3 });
  await goTo(ctx, house.x, house.y, house.z, 1).catch(() => {});
  // 持っているベッドを家に置く
  const bedItem = bot.inventory.items().find((i) => i.name.endsWith('_bed'));
  if (bedItem && !ctx.memory.getPlace('bed')) await placeBed(ctx, house);
  if (!bot.time.isDay) {
    const bedPos = ctx.memory.getPlace('bed');
    const bed = bedPos ? bot.blockAt(new Vec3(bedPos.x, bedPos.y, bedPos.z)) : null;
    if (bed && bed.name.endsWith('_bed')) {
      try {
        await goTo(ctx, bed.position.x, bed.position.y, bed.position.z, 2).catch(() => {});
        await bot.sleep(bed);
        await Promise.race([new Promise((r) => bot.once('wake', r)), sleep(5 * 60_000)]);
        return '家のベッドで寝た';
      } catch (e) {
        ctx.log.info(`寝られなかった: ${e.message}`);
      }
    }
    // 寝られなければ朝まで家の中で過ごす（壁と屋根があるので安全）
    for (let i = 0; i < 24 && !bot.time.isDay; i++) { abortable(ctx); await sleep(5000); }
    return '家で夜を過ごした';
  }
  return '家に帰った';
}

// ---------- 畑 ----------

export function farmCells(house) {
  const [ddx, ddz] = house.door;
  // 家の裏（扉の反対側）に 3×3
  const cx = house.x - ddx * 5; const cz = house.z - ddz * 5;
  const cells = [];
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) cells.push({ x: cx + dx, z: cz + dz, center: dx === 0 && dz === 0 });
  return { cx, cz, cells };
}

export async function tendFarm(ctx) {
  const { bot } = ctx;
  const { town, persona } = S(ctx);
  const house = town.profile.house;
  if (!house) throw new SkillError('先に家の場所を決める（buildHouse）');
  const farm = farmCells(house);
  const did = { tilled: 0, planted: 0, harvested: 0 };
  // 種: 無ければ草を刈って集める
  if (count(bot, 'wheat_seeds') < 3) {
    await mineBlocks(ctx, ['short_grass', 'tall_grass'], 14, { maxDistance: 32, maxExplore: 3 }).catch(() => {});
    await pickUpItems(ctx, 8).catch(() => {});
  }
  // 鍬
  if (!bot.inventory.items().some((i) => i.name.endsWith('_hoe'))) {
    const tier = count(bot, 'cobblestone') >= 2 ? 'stone_hoe' : 'wooden_hoe';
    await ensurePlanks(ctx, 4).catch(() => {});
    await craftItem(ctx, tier, 1).catch((e) => { throw new SkillError(`鍬を作れない: ${e.message}`); });
  }
  await travelTo(ctx, farm.cx, farm.cz, { range: 2 });
  const hint = house.y - 1;
  for (const c of farm.cells) {
    abortable(ctx);
    const g = groundY(bot, c.x, c.z, hint);
    if (!g || g.water) continue;
    const soil = bot.blockAt(new Vec3(c.x, g.y, c.z));
    const above = bot.blockAt(new Vec3(c.x, g.y + 1, c.z));
    if (!soil || !above) continue;
    // 実った小麦を刈る
    if (above.name === 'wheat') {
      if (above.getProperties?.().age === 7) {
        await goTo(ctx, c.x, g.y + 1, c.z, 2).catch(() => {});
        await bot.dig(above, true).catch(() => {});
        did.harvested++;
      } else continue;
    }
    if (SOFT.test(above.name)) { await clearAt(ctx, above.position); }
    let s = bot.blockAt(soil.position);
    // 耕す
    if (['dirt', 'grass_block', 'dirt_path', 'coarse_dirt', 'rooted_dirt'].includes(s.name) && isAir(bot.blockAt(s.position.offset(0, 1, 0)))) {
      const hoe = bot.inventory.items().find((i) => i.name.endsWith('_hoe'));
      await goTo(ctx, c.x, g.y + 1, c.z, 2.5).catch(() => {});
      try {
        await bot.equip(hoe, 'hand');
        await bot.lookAt(s.position.offset(0.5, 1, 0.5), true);
        await bot.activateBlock(s);
        await bot.waitForTicks(3);
        did.tilled++;
      } catch {}
      s = bot.blockAt(soil.position);
    }
    // 植える
    if (s?.name === 'farmland' && isAir(bot.blockAt(s.position.offset(0, 1, 0))) && findItem(bot, 'wheat_seeds')) {
      await goTo(ctx, c.x, g.y + 1, c.z, 2.5).catch(() => {});
      try {
        await bot.equip(findItem(bot, 'wheat_seeds'), 'hand');
        await bot._placeBlockWithOptions(s, new Vec3(0, 1, 0), { swingArm: 'right', forceLook: true });
        did.planted++;
      } catch {}
    }
  }
  await pickUpItems(ctx, 8).catch(() => {});
  // 小麦が 3 つあればパンにする
  const breads = Math.floor(count(bot, 'wheat') / 3);
  if (breads > 0) await craftItem(ctx, 'bread', count(bot, 'bread') + breads).catch((e) => ctx.log.warn(`パンを作れなかった: ${e.message}`));
  if (did.harvested) town.event('farm', `${persona.call}が小麦を ${did.harvested} 株収穫した`);
  town.profile.farm = { x: farm.cx, z: farm.cz, at: Date.now() };
  return `畑: 耕した ${did.tilled}、植えた ${did.planted}、収穫 ${did.harvested}、パン ${count(bot, 'bread')}`;
}

// ---------- 共同倉庫 ----------

// 自分の取り分として残す数（これを超えた分を倉庫へ）
const KEEP = (name, soc) => {
  if (FOODS.has(name)) return soc.traits.agreeableness > 0.5 ? 4 : 8;
  if (isLog(name)) return 6;
  if (isPlanks(name)) return 24;
  if (['cobblestone', 'cobbled_deepslate'].includes(name)) return 32;
  if (['coal', 'charcoal'].includes(name)) return 4;
  if (name === 'wheat_seeds') return 8;
  if (['iron_ingot', 'raw_iron', 'wheat', 'string', 'feather', 'leather', 'bone', 'arrow', 'gunpowder'].includes(name) || name.endsWith('_wool')) return 0;
  return null; // それ以外（道具・防具など）は納めない
};

export function surplus(bot, soc) {
  const totals = new Map();
  for (const i of bot.inventory.items()) totals.set(i.name, (totals.get(i.name) ?? 0) + i.count);
  const out = [];
  for (const [name, n] of totals) {
    const keep = KEEP(name, soc);
    if (keep === null || n <= keep) continue;
    out.push({ name, count: n - keep });
  }
  return out;
}

async function ensureStorage(ctx) {
  const { bot } = ctx;
  const { town, persona } = S(ctx);
  const known = town.storage();
  if (known) {
    const b = bot.blockAt(new Vec3(known.x, known.y, known.z));
    if (!b || b.name === 'chest') return known;
    // 誰かが壊した？ 置き直す
  }
  const plaza = town.plaza() ?? town.setPlaza(bot.entity.position);
  if (!findItem(bot, 'chest')) {
    await ensurePlanks(ctx, 8).catch(() => {});
    await craftItem(ctx, 'chest', 1);
  }
  const x = plaza.x + STORAGE_OFFSET.x; const z = plaza.z + STORAGE_OFFSET.z;
  await travelTo(ctx, x, z, { range: 2 });
  const g = groundY(bot, x, z, Math.round(bot.entity.position.y));
  if (!g) throw new SkillError('倉庫の場所の地面が分からない');
  const pos = new Vec3(x, g.y + 1, z);
  await clearAt(ctx, pos);
  const ok = await placeAt(ctx, pos, 'chest');
  const placed = bot.blockAt(pos);
  if (!ok || placed?.name !== 'chest') throw new SkillError('倉庫のチェストを置けなかった');
  town.profile.storage = { x, y: pos.y, z, at: Date.now() };
  town.publish(bot);
  town.event('storage', `${persona.call}が広場に共同倉庫を作った`);
  ctx.say?.(say.voice(persona, '広場に共同倉庫を作ったよ。余った物はここに入れて、困ったら使ってね。'));
  return town.profile.storage;
}

async function openStorage(ctx) {
  const { bot } = ctx;
  const st = await ensureStorage(ctx);
  await travelTo(ctx, st.x, st.z, { range: 2 });
  await goTo(ctx, st.x, st.y, st.z, 2).catch(() => {});
  const block = bot.blockAt(new Vec3(st.x, st.y, st.z));
  if (!block || block.name !== 'chest') throw new SkillError('倉庫のチェストが無い');
  const win = await bot.openContainer(block);
  return win;
}

function noteContents(soc, win) {
  const items = {};
  for (const i of win.containerItems()) items[i.name] = (items[i.name] ?? 0) + i.count;
  soc.town.profile.storageSeen = { at: Date.now(), items };
  return items;
}

export async function depositToStorage(ctx) {
  const { bot } = ctx;
  const soc = S(ctx);
  const plan = surplus(bot, soc);
  if (plan.length === 0) throw new SkillError('倉庫に納める余りが無い');
  const win = await openStorage(ctx);
  const given = [];
  try {
    for (const { name, count: n } of plan) {
      const id = bot.registry.itemsByName[name]?.id;
      if (id === undefined) continue;
      try { await win.deposit(id, null, n); given.push(`${name}×${n}`); } catch (e) { ctx.log.warn(`${name} を入れられなかった: ${e.message}`); }
    }
    noteContents(soc, win);
  } finally {
    win.close();
  }
  if (!given.length) throw new SkillError('何も入れられなかった');
  soc.town.profile.contributed = (soc.town.profile.contributed ?? 0) + given.length;
  soc.town.publish(bot);
  soc.town.event('deposit', `${soc.persona.call}が倉庫に ${given.join('、')} を入れた`);
  return `倉庫に ${given.join('、')} を入れた`;
}

export async function takeFromStorage(ctx, { item = 'food', count: n = 4 } = {}) {
  const { bot } = ctx;
  const soc = S(ctx);
  const win = await openStorage(ctx);
  const got = [];
  try {
    const want = (name) => (item === 'food' ? FOODS.has(name) : name === item || (item === 'planks' && isPlanks(name)) || (item === 'logs' && isLog(name)));
    let left = n;
    for (const it of win.containerItems()) {
      if (left <= 0) break;
      if (!want(it.name)) continue;
      const k = Math.min(left, it.count);
      try { await win.withdraw(it.type, null, k); got.push(`${it.name}×${k}`); left -= k; } catch {}
    }
    noteContents(soc, win);
  } finally {
    win.close();
  }
  soc.town.publish(bot);
  if (!got.length) throw new SkillError(`倉庫に ${item} が無かった`);
  soc.town.event('withdraw', `${soc.persona.call}が倉庫から ${got.join('、')} を出した`);
  return `倉庫から ${got.join('、')} を出した`;
}

// ---------- 人付き合い ----------

// 相手の居場所（見えていれば実際の位置、見えなければ町の台帳の位置）
function whereIs(bot, town, name) {
  const e = bot.players[name]?.entity;
  if (e) return e.position;
  const r = town.resident(name);
  return r?.online && r.pos ? new Vec3(r.pos.x, r.pos.y, r.pos.z) : null;
}

async function approach(ctx, name, range = 3) {
  const { bot } = ctx;
  const { town } = S(ctx);
  let p = whereIs(bot, town, name);
  if (!p) throw new SkillError(`${name} の居場所が分からない`);
  if (p.distanceTo(bot.entity.position) > 160) throw new SkillError(`${name} は遠すぎる`);
  await travelTo(ctx, p.x, p.z, { range: 4 });
  const e = bot.players[name]?.entity;
  if (!e) throw new SkillError(`${name} が見当たらない`);
  p = e.position;
  await goTo(ctx, p.x, p.y, p.z, range).catch(() => {});
  await bot.lookAt(e.position.offset(0, 1.6, 0), true).catch(() => {});
  return e;
}

// 誰と話すか: 好きな相手ほど選ばれやすいが、知らない相手にも時々話しかける
export function chooseCompanion(bot, soc, { exclude = [] } = {}) {
  const online = soc.town.residents().filter((r) => r.online && !exclude.includes(r.name));
  if (!online.length) return null;
  const me = bot.entity.position;
  const scored = online.map((r) => {
    const rel = soc.rel.get(r.name);
    const d = r.pos ? Math.hypot(r.pos.x - me.x, r.pos.z - me.z) : 999;
    const recent = Date.now() - rel.lastTalkAt < 5 * 60_000 ? -40 : 0;
    const w = 50 + rel.affinity * (0.5 + soc.traits.agreeableness) + recent - d * 0.2 + Math.random() * 40 * soc.traits.openness;
    return { r, w };
  });
  scored.sort((a, b) => b.w - a.w);
  return scored[0].r.name;
}

export async function socialize(ctx, { with: target } = {}) {
  const { bot } = ctx;
  const soc = S(ctx);
  const name = target || chooseCompanion(bot, soc);
  if (!name) throw new SkillError('話し相手がいない');
  const other = personaByName(name);
  const call = other?.call ?? name;
  await approach(ctx, name, 3);
  const rel = soc.rel.get(name);
  const opener = await soc.speak('greet', { to: name, call, affinity: rel.affinity });
  ctx.say?.(opener);
  await sleep(6000 + Math.random() * 3000);
  // 世間話をひとつ（相手の返事は相手のチャットの処理で返ってくる）
  const third = soc.rel.ranked().filter((r) => r.name !== name && Math.abs(r.affinity) >= 15)[0];
  const state = {
    houseDone: soc.town.profile.house?.stage === 'done', houseStarted: !!soc.town.profile.house,
    hungry: foodPoints(bot) < 4, night: !bot.time.isDay || bot.time.timeOfDay > 11500, storage: !!soc.town.storage(),
    job: soc.town.profile.job, explored: soc.rel.since('lastExploreAt') < 15,
    gossip: third && Math.random() < 0.4 ? { call: personaByName(third.name)?.call ?? third.name, good: third.affinity > 0 } : null,
  };
  const topic = await soc.speak('smalltalk', { to: name, call, state });
  if (topic) ctx.say?.(topic);
  soc.rel.talked(name);
  soc.rel.adjust(name, 1 + soc.traits.agreeableness, '話をした');
  soc.town.event('talk', `${soc.persona.call}が${call}と話した`, { with: name, text: topic ?? opener });
  await sleep(5000 + Math.random() * 4000);
  return `${call}と話した`;
}

// 贈り物: 相手のそばへ行って、持ち物を投げて渡す
export async function giveGift(ctx, { to, item, count: n = 4 } = {}) {
  const { bot } = ctx;
  const soc = S(ctx);
  if (!to) throw new SkillError('渡す相手が無い');
  let name = item;
  if (!name || name === 'food') name = bot.inventory.items().filter((i) => FOODS.has(i.name)).sort((a, b) => b.count - a.count)[0]?.name;
  if (name === 'planks') name = bot.inventory.items().find((i) => isPlanks(i.name))?.name;
  if (name === 'logs') name = bot.inventory.items().find((i) => isLog(i.name))?.name;
  if (!name || !count(bot, name)) throw new SkillError(`渡せる ${item ?? '物'} を持っていない`);
  const other = personaByName(to);
  await approach(ctx, to, 2);
  const k = Math.min(n, count(bot, name));
  ctx.say?.(await soc.speak('gift', { to, call: other?.call ?? to, what: `${name}×${k}` }));
  const r = await deliverItems({ ...ctx, team: null, say: () => {} }, { to, items: [{ item: name, count: k }] });
  const rel = soc.rel.get(to);
  rel.giftsGiven++;
  soc.rel.adjust(to, 3, `${name}を${k}個あげた`);
  soc.town.event('gift', `${soc.persona.call}が${other?.call ?? to}に${name}×${k}を贈った`, { to, item: name, count: k });
  return r;
}

// 集会を開く: 広場で呼びかけ、集まった人に仕事を割り振る
export async function callMeeting(ctx, { topic } = {}) {
  const { bot } = ctx;
  const soc = S(ctx);
  const plaza = soc.town.plaza() ?? soc.town.setPlaza(bot.entity.position);
  await travelTo(ctx, plaza.x, plaza.z, { range: 2 });
  topic ||= soc.meetingTopic();
  soc.town.profile.meeting = { at: Date.now(), topic, x: plaza.x, y: plaza.y, z: plaza.z };
  soc.town.publish(bot);
  ctx.say?.(await soc.speak('meetingCall', { topic }));
  soc.town.event('meeting', `${soc.persona.call}が集会を開いた: ${topic}`);
  // 集まるのを待つ（最大 90 秒）
  const attendees = () => soc.town.residents().filter((r) => r.online && bot.players[r.name]?.entity
    && bot.players[r.name].entity.position.distanceTo(bot.entity.position) < 14).map((r) => r.name);
  for (let t = 0; t < 18 && attendees().length < 4; t++) { abortable(ctx); await sleep(5000); }
  const who = attendees();
  if (!who.length) {
    soc.town.profile.meeting = null;
    soc.town.publish(bot);
    soc.rel.diary('集会を開いたが誰も来なかった。');
    ctx.say?.(await soc.speak('free', { text: '……誰も来なかった。また今度にしよう。' }));
    soc.rel.mark('lastMeetingAt');
    return '集会を開いたが誰も来なかった';
  }
  // 仕事の割り振り（一人ずつ、名前を呼んで）
  const lines = soc.assignTasks(who);
  for (const line of lines) { abortable(ctx); ctx.say?.(line); await sleep(3500); }
  await sleep(15_000); // 返事を聞く
  ctx.say?.(await soc.speak('free', { text: 'じゃあ、みんなよろしく。解散！' }));
  soc.town.profile.meeting = null;
  soc.town.publish(bot);
  soc.rel.mark('lastMeetingAt');
  for (const n of who) soc.rel.adjust(n, 2, '集会に来てくれた');
  soc.town.event('meeting-end', `${soc.persona.call}の集会に ${who.length} 人が集まった`, { attendees: who });
  return `集会に ${who.length} 人が来た`;
}

// 開かれている集会に行く
export async function attendMeeting(ctx) {
  const { bot } = ctx;
  const soc = S(ctx);
  const m = soc.town.meetings()[0];
  if (!m) throw new SkillError('開かれている集会が無い');
  await travelTo(ctx, m.x, m.z, { range: 4 });
  ctx.say?.(await soc.speak('free', { text: say.arriveLine(soc.persona) }));
  soc.flags.attendedMeetingAt = Date.now();
  // 集会が終わるまで（最大 2 分）そこにいる。割り振りへの返事はチャットの処理で行う
  for (let t = 0; t < 24 && soc.town.meetings().some((x) => x.by === m.by); t++) { abortable(ctx); await sleep(5000); }
  soc.rel.adjust(m.by, 1, '集会に出た');
  return `${personaByName(m.by)?.call ?? m.by}の集会に出た`;
}

// 掲示板（広場）に貼り紙をする
export async function postNotice(ctx, { text } = {}) {
  const { bot } = ctx;
  const soc = S(ctx);
  const plaza = soc.town.plaza() ?? soc.town.setPlaza(bot.entity.position);
  await travelTo(ctx, plaza.x, plaza.z, { range: 4 });
  text ||= soc.noticeText();
  if (!text) throw new SkillError('貼り紙に書くことが無い');
  soc.town.postNotice(text);
  soc.town.publish(bot);
  soc.town.event('notice', `${soc.persona.call}の貼り紙: ${text}`);
  return `掲示板に「${text}」と貼った`;
}

// 広場へ行く（掲示板を読む・人に会う）
export async function goToPlaza(ctx) {
  const { bot } = ctx;
  const soc = S(ctx);
  const plaza = soc.town.plaza() ?? soc.town.setPlaza(bot.entity.position);
  await travelTo(ctx, plaza.x, plaza.z, { range: 4 });
  const ns = soc.town.notices(bot) ?? [];
  soc.flags.readNotices = ns;
  return ns.length ? `掲示板: ${ns.slice(0, 4).map((n) => `${personaByName(n.by)?.call ?? n.by}「${n.text}」`).join(' / ')}` : '広場に来た（貼り紙なし）';
}

export async function chatSay(ctx, { message } = {}) {
  if (!message) throw new SkillError('言うことが無い');
  ctx.say?.(message);
  return '発言した';
}

export { here };
