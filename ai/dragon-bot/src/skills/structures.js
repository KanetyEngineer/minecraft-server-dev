// 構造物の活用（エンドラ RTA の定石）:
//   村      … ベッドを壊して回収（羊を探さない）、干し草 → パン、チェストの鉄とパン、アイアンゴーレムから鉄 3〜5 個
//   廃ポータル … チェストの黒曜石と火打石で枠の足りない分を埋めて着火（溶岩から黒曜石を作る工程を丸ごと省ける）
//   溶岩溜まり … 見かけたら場所を覚えておき、ゲート作り（castNetherPortal）で探し回らない
import {
  SkillError, abortable, goTo, goNearBlock, travelTo, mineBlocks, craftItem, pickUpItems, pillarUp, pillarDown,
  equipCheapestTool, nearestEntityNamed, dim, Vec3,
} from './common.js';
import { count, countMatching, findItem, foodPoints } from '../util/items.js';
import { findVisibleBlocks, sleep, smoothLookAt } from '../body/humanize.js';

const BED_NAMES = (bot) => Object.keys(bot.registry.blocksByName).filter((n) => n.endsWith('_bed'));
const BASTION_BLOCKS = ['gilded_blackstone', 'polished_blackstone_bricks', 'cracked_polished_blackstone_bricks', 'chiseled_polished_blackstone', 'gold_block'];

// チェストから持ち出す物（RTA で役に立つものだけ。村の鍛冶屋・廃ポータルのチェストが対象）
const LOOT = new Set([
  'iron_ingot', 'iron_nugget', 'raw_iron', 'gold_ingot', 'gold_nugget', 'diamond', 'obsidian', 'flint_and_steel', 'fire_charge', 'flint',
  'bread', 'apple', 'golden_apple', 'enchanted_golden_apple', 'carrot', 'potato', 'baked_potato', 'cooked_beef', 'cooked_porkchop', 'cooked_cod', 'cooked_salmon', 'wheat',
  'golden_helmet', 'golden_boots', 'golden_chestplate', 'golden_leggings',
  'iron_helmet', 'iron_boots', 'iron_chestplate', 'iron_leggings', 'iron_pickaxe', 'iron_sword', 'iron_axe',
  'string', 'arrow', 'bow', 'ender_pearl', 'coal', 'torch', 'feather', 'bucket', 'water_bucket', 'lava_bucket', 'shield',
]);

const isSolid = (b) => !!b && b.boundingBox === 'block';
const isAir = (b) => !b || ['air', 'cave_air'].includes(b.name);
const posKey = (p) => `${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)}`;

// ---------- 見かけた構造物を覚える（判断のたびに呼ばれる軽い処理）----------

export function noteStructures(bot, memory) {
  if (typeof bot.findBlocks !== 'function' || !bot.registry || !memory?.setPlace) return;
  const d = String(bot.game?.dimension ?? 'overworld').replace('minecraft:', '');
  const first = (names, { maxDistance = 48, extra } = {}) => {
    const ids = names.map((n) => bot.registry.blocksByName[n]?.id).filter((id) => id !== undefined);
    if (ids.length === 0) return null;
    for (const p of bot.findBlocks({ matching: ids, maxDistance, count: extra ? 12 : 1 })) {
      if (!extra || extra(bot.blockAt(p), p)) return p;
    }
    return null;
  };
  const near = (name, p, r) => { const k = memory.getPlace(name); return k && Math.hypot(k.x - p.x, k.z - p.z) < r; };
  if (d === 'overworld') {
    if (!memory.getPlace('village')) {
      const villager = Object.values(bot.entities ?? {}).find((e) => e.name === 'villager');
      // ベッドだけで判断するときは、自分の置いたベッドと間違えないよう、離れた場所に 2 つ以上あることを確かめる
      const own = memory.getPlace('bed');
      const bedIds = BED_NAMES(bot).map((n) => bot.registry.blocksByName[n]?.id).filter((id) => id !== undefined);
      const beds = bedIds.length ? bot.findBlocks({ matching: bedIds, maxDistance: 48, count: 8 })
        .filter((q) => !(own && Math.hypot(own.x - q.x, own.y - q.y, own.z - q.z) < 4)) : [];
      const twoBeds = beds.find((q) => beds.some((r) => Math.hypot(q.x - r.x, q.z - r.z) > 3));
      const p = villager?.position ?? first(['bell', 'hay_bale']) ?? twoBeds;
      if (p) memory.setPlace('village', p, d);
    }
    if (!memory.getPlace('ruined_portal')) {
      const p = first(['crying_obsidian'])
        ?? first(['obsidian'], { extra: (_, q) => first(['netherrack', 'magma_block'], { maxDistance: 48 })?.distanceTo(q) < 8 });
      if (p) memory.setPlace('ruined_portal', p, d);
    }
    if (!memory.getPlace('lava_pool')) {
      // 地表の溶岩溜まり（源が 3 つ以上）。地下の溶岩は危ないので覚えない
      const ids = [bot.registry.blocksByName.lava?.id].filter((id) => id !== undefined);
      const srcs = ids.length ? bot.findBlocks({ matching: ids, maxDistance: 48, count: 24 }).filter((p) => p.y >= 50 && bot.blockAt(p)?.metadata === 0) : [];
      if (srcs.length >= 3) memory.setPlace('lava_pool', srcs[0], d);
    }
  } else if (d === 'the_nether') {
    if (!memory.getPlace('bastion')) { const p = first(BASTION_BLOCKS, { maxDistance: 64 }); if (p && !near('bastion', p, 100)) memory.setPlace('bastion', p, d); }
    if (!memory.getPlace('fortress')) { const p = first(['nether_bricks', 'nether_brick_fence'], { maxDistance: 64 }); if (p) memory.setPlace('fortress', p, d); }
  }
}

// ---------- チェスト ----------

async function lootChests(ctx, radius = 48, limit = 8) {
  const { bot } = ctx;
  const looted = (ctx.state.lootedChests ??= new Set());
  const chests = findVisibleBlocks(bot, ['chest', 'barrel'], { maxDistance: radius, count: limit, visibleOnly: false })
    .filter((c) => !looted.has(posKey(c.position)));
  const got = [];
  for (const c of chests) {
    abortable(ctx);
    try {
      await goNearBlock(ctx, c, 2);
      const w = await bot.openContainer(bot.blockAt(c.position));
      try {
        for (const it of w.containerItems()) {
          if (!LOOT.has(it.name)) continue;
          await w.withdraw(it.type, null, it.count).catch(() => {});
          got.push(`${it.name}x${it.count}`);
        }
      } finally {
        w.close();
      }
      looted.add(posKey(c.position));
    } catch (e) {
      if (e.name === 'AbortError' || ctx.signal?.aborted) throw e;
      ctx.log.warn(`チェスト (${c.position}) を開けなかった: ${e.message}`);
      looted.add(posKey(c.position));
    }
  }
  return got;
}

// ---------- 村 ----------

// 村で RTA の定石どおり物資を集める。順に、ベッド → チェスト → 干し草からパン → アイアンゴーレムの鉄
export async function lootVillage(ctx, { beds = 7, bread = 12 } = {}) {
  const { bot, memory } = ctx;
  if (dim(ctx) !== 'overworld') throw new SkillError('オーバーワールドにいない');
  noteStructures(bot, memory);
  const village = memory.getPlace('village');
  if (!village) throw new SkillError('村を見つけていない（探索中に見かけたら覚える）');
  try {
    await travelTo(ctx, village.x, village.z, { range: 12 });
  } catch (e) {
    if (e.name === 'AbortError' || ctx.signal?.aborted) throw e;
    memory.setFlag('villageRetryAt', Date.now() + 10 * 60_000);
    throw new SkillError(`村までたどり着けなかった: ${e.message}`);
  }
  const summary = [];

  // 1. ベッドを壊して回収（どちらの半分を壊しても 1 つ落ちる）
  const bedCount = () => countMatching(bot, (n) => n.endsWith('_bed'));
  const tried = new Set();
  for (let t = 0; bedCount() < beds && t < beds + 4; t++) {
    abortable(ctx);
    const b = findVisibleBlocks(bot, BED_NAMES(bot), { maxDistance: 48, count: 12, visibleOnly: false })
      .find((x) => !tried.has(posKey(x.position)));
    if (!b) { memory.setFlag('villageBedsTaken', true); break; }
    tried.add(posKey(b.position));
    const before = bedCount();
    try {
      await goNearBlock(ctx, b, 2);
      await bot.dig(bot.blockAt(b.position));
      await pickUpItems(ctx, 6);
    } catch (e) {
      if (e.name === 'AbortError' || ctx.signal?.aborted) throw e;
      ctx.log.warn(`ベッド (${b.position}) を回収できなかった: ${e.message}`);
    }
    if (bedCount() > before) summary.push('ベッド');
  }

  // 2. チェスト（鍛冶屋の鉄・パンなど）
  const got = await lootChests(ctx, 48, 8);
  if (got.length) summary.push(`チェスト: ${got.join(' ')}`);

  // 3. 干し草 → 小麦 9 個 → パン（小麦 3 個で 1 個）
  if (foodPoints(bot) < bread) {
    const need = Math.ceil(((bread - foodPoints(bot)) * 3 - count(bot, 'wheat')) / 9);
    for (let t = 0; t < need + 2 && count(bot, 'hay_bale') < need; t++) {
      abortable(ctx);
      const hay = findVisibleBlocks(bot, ['hay_bale'], { maxDistance: 48, count: 1, visibleOnly: false })[0];
      if (!hay) break;
      try {
        await goNearBlock(ctx, hay, 2);
        await equipCheapestTool(bot, bot.blockAt(hay.position)).catch(() => {});
        await bot.dig(bot.blockAt(hay.position));
        await pickUpItems(ctx, 6);
      } catch (e) {
        if (e.name === 'AbortError' || ctx.signal?.aborted) throw e;
        ctx.log.warn(`干し草を取れなかった: ${e.message}`);
        break;
      }
    }
    if (count(bot, 'hay_bale') > 0) await craftItem(ctx, 'wheat', count(bot, 'wheat') + count(bot, 'hay_bale') * 9).catch((e) => ctx.log.warn(e.message));
    if (count(bot, 'wheat') >= 3) {
      await craftItem(ctx, 'bread', count(bot, 'bread') + Math.floor(count(bot, 'wheat') / 3)).catch((e) => ctx.log.warn(e.message));
      summary.push(`パン ${count(bot, 'bread')}`);
    }
  }

  // 4. アイアンゴーレム（鉄 3〜5 個）: 3 段の柱の上からなら殴られない（ゴーレムの攻撃範囲は高さ 2.7 まで）
  const golem = nearestEntityNamed(bot, ['iron_golem'], 48);
  if (golem && count(bot, 'iron_ingot') < 12) {
    const ok = await killIronGolem(ctx, golem).catch((e) => { if (e.name === 'AbortError') throw e; ctx.log.warn(`ゴーレム: ${e.message}`); return false; });
    if (ok) summary.push(`ゴーレムの鉄（鉄 ${count(bot, 'iron_ingot')} 個）`);
  }

  memory.setFlag('villageLooted', true);
  return summary.length ? `村で回収: ${summary.join('、')}` : '村に回収できる物が無かった';
}

async function killIronGolem(ctx, golem) {
  const { bot } = ctx;
  const sword = ['netherite_sword', 'diamond_sword', 'iron_sword', 'stone_sword'].map((n) => findItem(bot, n)).find(Boolean)
    ?? ['diamond_axe', 'iron_axe', 'stone_axe'].map((n) => findItem(bot, n)).find(Boolean);
  if (!sword || bot.health < 14) return false;
  await goTo(ctx, golem.position.x, golem.position.y, golem.position.z, 2).catch(() => {});
  if (golem.position.distanceTo(bot.entity.position) > 4) return false;
  const placed = await pillarUp(ctx, 3);
  if (placed < 3) { await pillarDown(ctx, placed); ctx.log.warn('柱を 3 段積めないのでゴーレムは狙わない'); return false; }
  ctx.state.holdStillUntil = Date.now() + 120_000; // 柱の上で動かないのはフリーズではない
  try {
    await bot.equip(sword, 'hand');
    const start = Date.now();
    while (golem.isValid && Date.now() - start < 90_000) {
      abortable(ctx);
      if (golem.position.distanceTo(bot.entity.position) <= 4.5) {
        await bot.lookAt(golem.position.offset(0, 2.0, 0), true);
        bot.attack(golem);
      }
      await sleep(650);
    }
    // 怒ったまま降りると殴られるので、死ぬか離れるまで待ってから降りる
    for (let t = 0; golem.isValid && golem.position.distanceTo(bot.entity.position) < 8 && t < 40; t++) await sleep(500);
  } finally {
    ctx.state.holdStillUntil = 0;
    await pillarDown(ctx, placed);
  }
  await pickUpItems(ctx, 8);
  return !golem.isValid;
}

// ---------- 廃ポータル ----------

// 黒曜石・泣く黒曜石の並びから、4×5 の枠の位置を推定する（純粋関数、テストあり）。
// axis: 枠の横方向（'x' なら x 方向に 4 つ並ぶ）。required は角を除く 10 か所。
// blocked: 泣く黒曜石が必要位置にある（ダイヤのツルハシが無いと外せない）か、枠の中に黒曜石がある。
export function inferPortalFrame(blocks) {
  const key = (x, y, z) => `${x},${y},${z}`;
  const map = new Map(blocks.map((b) => [key(b.x, b.y, b.z), b.name]));
  let best = null;
  for (const axis of ['x', 'z']) {
    for (const b of blocks) {
      for (let i = 0; i < 4; i++) {
        for (let j = 0; j < 5; j++) {
          const ox = axis === 'x' ? b.x - i : b.x;
          const oz = axis === 'z' ? b.z - i : b.z;
          const oy = b.y - j;
          const required = []; const corners = []; const interior = [];
          for (let u = 0; u < 4; u++) {
            for (let v = 0; v < 5; v++) {
              const p = { x: axis === 'x' ? ox + u : ox, y: oy + v, z: axis === 'z' ? oz + u : oz };
              const eu = u === 0 || u === 3; const ev = v === 0 || v === 4;
              if (eu && ev) corners.push(p); else if (eu || ev) required.push(p); else interior.push(p);
            }
          }
          const inRect = (q) => (axis === 'x' ? q.z === oz && q.x >= ox && q.x < ox + 4 : q.x === ox && q.z >= oz && q.z < oz + 4) && q.y >= oy && q.y < oy + 5;
          const present = required.filter((p) => map.get(key(p.x, p.y, p.z)) === 'obsidian');
          const blocked = required.filter((p) => map.get(key(p.x, p.y, p.z)) === 'crying_obsidian')
            .concat(interior.filter((p) => map.has(key(p.x, p.y, p.z))));
          const stray = blocks.filter((q) => !inRect(q)).length;
          const score = present.length * 2 - blocked.length * 3 - stray;
          if (!best || score > best.score) {
            best = { score, axis, origin: { x: ox, y: oy, z: oz }, required, interior, blocked,
              missing: required.filter((p) => map.get(key(p.x, p.y, p.z)) !== 'obsidian') };
          }
        }
      }
    }
  }
  return best;
}

async function ensureIgniter(ctx) {
  const { bot } = ctx;
  if (findItem(bot, 'flint_and_steel') || findItem(bot, 'fire_charge')) return;
  if (count(bot, 'iron_ingot') < 1 && count(bot, 'raw_iron') < 1) throw new SkillError('火打石と打ち金に鉄が 1 個要る');
  for (let t = 0; t < 15 && count(bot, 'flint') < 1; t++) {
    abortable(ctx);
    const got = await mineBlocks(ctx, ['gravel'], 1, { maxDistance: 32, maxExplore: 1 });
    if (got === 0) break;
  }
  await craftItem(ctx, 'flint_and_steel', 1);
}

async function placeObsidianAt(ctx, p, standY) {
  const { bot } = ctx;
  const target = new Vec3(p.x, p.y, p.z);
  const obs = findItem(bot, 'obsidian');
  if (!obs) return false;
  const refs = [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]]
    .map(([x, y, z]) => bot.blockAt(target.offset(x, y, z)))
    .filter((b) => isSolid(b));
  if (refs.length === 0) return false;
  const raise = p.y - standY >= 3;
  let placed = 0;
  if (raise) placed = await pillarUp(ctx, 1);
  try {
    for (const ref of refs) {
      await bot.equip(obs, 'hand');
      await smoothLookAt(bot, target.offset(0.5, 0.5, 0.5), 60);
      try {
        await bot.placeBlock(ref, target.minus(ref.position));
        if (bot.blockAt(target)?.name === 'obsidian') return true;
      } catch {
        // 別の面から試す
      }
    }
  } finally {
    if (placed) await pillarDown(ctx, placed);
  }
  return false;
}

// 廃ポータルのチェストを漁り、黒曜石が足りれば枠を完成させて着火する
export async function useRuinedPortal(ctx) {
  const { bot, memory } = ctx;
  if (dim(ctx) !== 'overworld') throw new SkillError('オーバーワールドにいない');
  if (memory.getPlace('overworld_portal')) return 'ゲートはもうある';
  noteStructures(bot, memory);
  const rp = memory.getPlace('ruined_portal');
  if (!rp) throw new SkillError('廃ポータルを見つけていない');
  const giveUp = (msg) => { memory.setFlag('ruinedPortalUnusable', true); return new SkillError(msg); };
  try {
    await travelTo(ctx, rp.x, rp.z, { range: 8 });
  } catch (e) {
    if (e.name === 'AbortError' || ctx.signal?.aborted) throw e;
    throw giveUp(`廃ポータルまでたどり着けなかった: ${e.message}`);
  }
  const got = await lootChests(ctx, 20, 3);
  if (got.length) ctx.log.info(`廃ポータルのチェスト: ${got.join(' ')}`);

  const blocks = findVisibleBlocks(bot, ['obsidian', 'crying_obsidian'], { maxDistance: 16, count: 40, visibleOnly: false })
    .map((b) => ({ x: b.position.x, y: b.position.y, z: b.position.z, name: b.name }));
  const frame = inferPortalFrame(blocks);
  if (!frame || frame.required.length - frame.missing.length < 4) throw giveUp('枠の形が分からない');
  if (frame.blocked.length > 0) throw giveUp(`泣く黒曜石が枠の必要位置にある（${frame.blocked.length} 個、ダイヤのツルハシが無いと外せない）`);
  if (frame.missing.length > count(bot, 'obsidian')) {
    throw giveUp(`黒曜石があと ${frame.missing.length - count(bot, 'obsidian')} 個足りない（溶岩と水で作る方式へ）`);
  }
  await ensureIgniter(ctx);

  // 枠の正面に立つ（横方向の反対側の 2 マス先）
  const o = frame.origin;
  const front = frame.axis === 'x' ? [new Vec3(o.x + 1, o.y, o.z + 2), new Vec3(o.x + 1, o.y, o.z - 2)] : [new Vec3(o.x + 2, o.y, o.z + 1), new Vec3(o.x - 2, o.y, o.z + 1)];
  for (const f of front) { try { await goTo(ctx, f.x, f.y, f.z, 1); break; } catch { /* 反対側へ */ } }
  const standY = Math.floor(bot.entity.position.y);

  // 足りない所を、置ける所（隣に固いブロックがある）から順に埋める
  let left = frame.missing.slice();
  for (let pass = 0; pass < 6 && left.length; pass++) {
    const rest = [];
    for (const p of left) {
      abortable(ctx);
      if (bot.blockAt(new Vec3(p.x, p.y, p.z))?.name === 'obsidian') continue;
      if (!(await placeObsidianAt(ctx, p, standY))) rest.push(p);
    }
    if (rest.length === left.length) break;
    left = rest;
  }
  if (left.length) throw new SkillError(`黒曜石を ${left.length} か所に置けなかった`);

  // 枠の中を片付ける（ネザーラックなど。溶岩には触れない）
  for (const p of frame.interior) {
    const b = bot.blockAt(new Vec3(p.x, p.y, p.z));
    if (isAir(b) || !b || b.name === 'lava' || b.name === 'water' || b.name === 'nether_portal') continue;
    if (!bot.canDigBlock(b)) throw giveUp(`枠の中の ${b.name} を壊せない`);
    await equipCheapestTool(bot, b).catch(() => {});
    await bot.dig(b).catch(() => {});
  }

  // 着火: いちばん下の枠の上面に火を付ける
  const bottom = bot.blockAt(new Vec3(frame.interior[0].x, frame.interior[0].y - 1, frame.interior[0].z));
  const igniter = findItem(bot, 'flint_and_steel') ?? findItem(bot, 'fire_charge');
  await bot.equip(igniter, 'hand');
  await bot.lookAt(bottom.position.offset(0.5, 1, 0.5), true);
  await bot.activateBlock(bottom, new Vec3(0, 1, 0));
  await sleep(1000);
  const portal = frame.interior.map((p) => bot.blockAt(new Vec3(p.x, p.y, p.z))).find((b) => b?.name === 'nether_portal');
  if (!portal) throw new SkillError('ゲートに火が付かなかった');
  memory.setPlace('overworld_portal', portal.position, 'overworld');
  ctx.say?.('廃ポータル直した！');
  return `廃ポータルを完成させてネザーゲートにした (${portal.position})`;
}
