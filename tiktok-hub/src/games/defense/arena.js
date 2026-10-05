// The battlefields: straight lanes along +X, one per field, side by side along +Z (field 1 at the configured origin).
//   core (beacon) ── last-stand bridge ── gate 1 ── gate 2 ── ... ── gate N ── enemy spawn
// Everything is built with RCON commands from the "field" settings, so the panel can rebuild it at any size.
// Markers (tags td.field td.fx td.f<n>) tell the data pack where things are: td.core, td.last, td.spawn,
// td.gate (td.idx 1..N). The waiting area (lobby) is built by lobbyCommands, away from every lane.

const MAX_FILL = 32000; // vanilla limit is 32768 blocks per /fill

// /fill split along X so each part stays under the block limit
function fillX(x1, y1, z1, x2, y2, z2, block, mode = '') {
  const [xa, xb] = [Math.min(x1, x2), Math.max(x1, x2)];
  const slice = (Math.abs(y2 - y1) + 1) * (Math.abs(z2 - z1) + 1);
  const step = Math.max(1, Math.floor(MAX_FILL / slice));
  const out = [];
  for (let x = xa; x <= xb; x += step) {
    out.push(`fill ${x} ${y1} ${z1} ${Math.min(xb, x + step - 1)} ${y2} ${z2} ${block}${mode ? ' ' + mode : ''}`);
  }
  return out;
}

// gate X positions (west face), gate 1 nearest the core
export function gatePositions(f) {
  const x0 = f.originX;
  if (f.gates === 1) return [x0 + f.length - 30];
  const first = x0 + 14;
  const last = x0 + f.length - 30;
  return Array.from({ length: f.gates }, (_, i) => Math.round(first + ((last - first) * i) / (f.gates - 1)));
}

// small deterministic pseudo-random, so a rebuild looks the same every time
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

export const FIELD_COLORS = ['red', 'blue', 'green', 'yellow', 'aqua', 'light_purple', 'gold', 'dark_aqua'];

// field n (1-based) uses the shared shape, shifted along Z
export function fieldShape(field, fields, n) {
  return { ...field, originZ: field.originZ + (n - 1) * fields.spacing };
}

// the waiting area: on the -Z side of field 1, far enough that no enemy can see / chase the people there
export function lobbyPos(field, fields) {
  return { x: field.originX + 30, y: field.originY, z: field.originZ - Math.max(170, fields.spacing) };
}

// Commands are split in two: the chunks must be loaded (forceload) before blocks and markers can be placed.
export function arenaCommands(f, n = 1, label = '') {
  const { originX: x0, originY: y0, originZ: z0, length: L, halfWidth: W } = f;
  const zL = z0 - W, zR = z0 + W;
  const xMin = x0 - 12, xMax = x0 + L + 8;
  const T = `"td.field","td.fx","td.f${n}"`;
  const color = FIELD_COLORS[n - 1] ?? 'white';
  const pre = [
    `forceload add ${xMin - 24} ${z0 - W - 24} ${xMax + 24} ${z0 + W + 24}`,
  ];
  const c = [];
  // the old markers of this place (also ones from before fields had numbers) go first
  c.push(`function td:f${n}/stop`, `kill @e[tag=td.field,tag=td.f${n}]`,
    `kill @e[tag=td.field,x=${xMin - 24},y=${y0 - 8},z=${z0 - W - 24},dx=${xMax - xMin + 48},dy=40,dz=${2 * W + 48}]`);
  // wipe the old field (any size up to 12 blocks of margin) and restore the ground
  const m = 14;
  c.push(...fillX(xMin - 12, y0, z0 - W - m, xMax + 12, y0 + 16, z0 + W + m, 'minecraft:air'));
  c.push(...fillX(xMin - 12, y0 - 1, z0 - W - m, xMax + 12, y0 - 1, z0 + W + m, 'minecraft:grass_block'));
  c.push(...fillX(xMin - 12, y0 - 3, z0 - W - m, xMax + 12, y0 - 2, z0 + W + m, 'minecraft:dirt'));

  // lane floor: stone bricks with worn patches and cross stripes
  c.push(...fillX(xMin + 2, y0 - 1, zL, xMax - 2, y0 - 1, zR, 'minecraft:stone_bricks'));
  c.push(...fillX(xMin + 2, y0 - 1, zL, xMax - 2, y0 - 1, zL, 'minecraft:polished_andesite'));
  c.push(...fillX(xMin + 2, y0 - 1, zR, xMax - 2, y0 - 1, zR, 'minecraft:polished_andesite'));
  const r = rng(L * 31 + W);
  for (let x = x0; x < x0 + L; x += 8) c.push(`fill ${x} ${y0 - 1} ${zL + 1} ${x} ${y0 - 1} ${zR - 1} minecraft:chiseled_stone_bricks`);
  for (let i = 0; i < L / 3; i++) {
    const x = Math.floor(x0 + r() * L), z = Math.floor(zL + 1 + r() * (2 * W - 1));
    const b = ['minecraft:mossy_stone_bricks', 'minecraft:cracked_stone_bricks', 'minecraft:gravel', 'minecraft:tuff_bricks'][Math.floor(r() * 4)];
    c.push(`fill ${x} ${y0 - 1} ${z} ${x + 1} ${y0 - 1} ${Math.min(zR - 1, z + 1)} ${b}`);
  }

  // side walls with a cap and lanterns on top, back wall behind the core
  for (const z of [zL - 1, zR + 1]) {
    c.push(...fillX(xMin + 2, y0 - 1, z, xMax - 2, y0 + 3, z, 'minecraft:deepslate_bricks'));
    c.push(...fillX(xMin + 2, y0 + 4, z, xMax - 2, y0 + 4, z, 'minecraft:deepslate_tiles'));
    c.push(...fillX(xMin + 2, y0 + 5, z, xMax - 2, y0 + 5, z, 'minecraft:deepslate_tile_wall'));
    for (let x = xMin + 4; x < xMax - 2; x += 6) {
      c.push(`setblock ${x} ${y0 + 6} ${z} minecraft:lantern`);
      c.push(`setblock ${x} ${y0 + 1} ${z} minecraft:cracked_deepslate_bricks`);
    }
  }
  c.push(`fill ${xMin + 2} ${y0 - 1} ${zL - 1} ${xMin + 2} ${y0 + 5} ${zR + 1} minecraft:deepslate_bricks`);

  // enemy side: a dark portal wall
  const xs = x0 + L;
  c.push(`fill ${xMax - 2} ${y0 - 1} ${zL - 1} ${xMax - 2} ${y0 + 8} ${zR + 1} minecraft:obsidian`);
  c.push(`fill ${xMax - 2} ${y0} ${zL + 1} ${xMax - 2} ${y0 + 6} ${zR - 1} minecraft:crying_obsidian`);
  c.push(`fill ${xMax - 3} ${y0} ${zL + 2} ${xMax - 3} ${y0 + 5} ${zR - 2} minecraft:purple_stained_glass`);
  c.push(`setblock ${xMax - 3} ${y0} ${zL} minecraft:soul_campfire`);
  c.push(`setblock ${xMax - 3} ${y0} ${zR} minecraft:soul_campfire`);
  c.push(`fill ${xs - 2} ${y0 - 1} ${zL} ${xMax - 3} ${y0 - 1} ${zR} minecraft:blackstone`);
  c.push(`summon minecraft:marker ${xs + 0.5} ${y0} ${z0 + 0.5} {Tags:[${T},"td.spawn"]}`);

  // gates
  const gates = gatePositions(f);
  gates.forEach((gx, i) => {
    const data = { x1: gx, x2: gx + 1, y1: y0, y2: y0 + 2, y3: y0 + 3, z1: zL, z2: zR, lx: gx - 1, lz: z0 };
    c.push(`summon minecraft:marker ${gx + 1} ${y0 + 3} ${z0 + 0.5} {Tags:[${T},"td.gate","td.new"],Rotation:[-90f,0f],data:${JSON.stringify(data).replace(/"(\w+)":/g, '$1:')}}`);
    c.push(`scoreboard players set @e[tag=td.new,limit=1] td.idx ${i + 1}`);
    c.push(`scoreboard players set @e[tag=td.new,limit=1] td.x ${gx + 3}`);
    c.push(`tag @e[tag=td.new] remove td.new`);
    for (const z of [zL, zR]) {
      c.push(`summon minecraft:text_display ${gx + 1} ${y0 + 4.6} ${z + 0.5} {Tags:[${T}],billboard:"center",background:1073741824,text:{text:"第${i + 1}関門",color:"gold",bold:true},transformation:{left_rotation:[0f,0f,0f,1f],right_rotation:[0f,0f,0f,1f],translation:[0f,0f,0f],scale:[1.2f,1.2f,1.2f]}}`);
      c.push(`setblock ${gx} ${y0 + 4} ${z} minecraft:lantern`);
    }
    // darker floor in front of the gate, where enemies pile up
    c.push(`fill ${gx + 2} ${y0 - 1} ${zL} ${gx + 4} ${y0 - 1} ${zR} minecraft:polished_blackstone_bricks`);
  });

  // last stand: a bridge over the lane in front of the core
  c.push(`fill ${x0 + 4} ${y0 + 6} ${zL - 1} ${x0 + 6} ${y0 + 6} ${zR + 1} minecraft:dark_oak_planks`);
  c.push(`fill ${x0 + 4} ${y0 + 7} ${zL - 1} ${x0 + 4} ${y0 + 7} ${zR + 1} minecraft:dark_oak_fence`);
  c.push(`setblock ${x0 + 4} ${y0 + 8} ${zL - 1} minecraft:lantern`);
  c.push(`setblock ${x0 + 4} ${y0 + 8} ${zR + 1} minecraft:lantern`);
  c.push(`summon minecraft:marker ${x0 + 5.5} ${y0 + 7} ${z0 + 0.5} {Tags:[${T},"td.last"]}`);

  // core: a beacon (light blue beam) on an iron base
  c.push(`fill ${x0 - 7} ${y0 - 2} ${z0 - 1} ${x0 - 5} ${y0 - 2} ${z0 + 1} minecraft:iron_block`);
  c.push(`fill ${x0 - 8} ${y0 - 1} ${z0 - 2} ${x0 - 4} ${y0 - 1} ${z0 + 2} minecraft:polished_deepslate`);
  c.push(`setblock ${x0 - 6} ${y0 - 1} ${z0} minecraft:beacon`);
  c.push(`setblock ${x0 - 6} ${y0} ${z0} minecraft:light_blue_stained_glass`);
  for (const [dx, dz] of [[-2, -2], [-2, 2], [2, -2], [2, 2]]) c.push(`fill ${x0 - 6 + dx} ${y0} ${z0 + dz} ${x0 - 6 + dx} ${y0 + 1} ${z0 + dz} minecraft:end_rod`);
  c.push(`summon minecraft:marker ${x0 - 5.5} ${y0} ${z0 + 0.5} {Tags:[${T},"td.core","td.new"]}`);
  c.push(`scoreboard players set @e[tag=td.new,limit=1] td.x ${x0 + 3}`);
  c.push(`scoreboard players operation @e[tag=td.new,limit=1] td.hp = #coreHp td.cfg`);
  c.push(`tag @e[tag=td.new] remove td.new`);
  c.push(`summon minecraft:text_display ${x0 - 5.5} ${y0 + 2.6} ${z0 + 0.5} {Tags:[${T}],billboard:"center",background:1073741824,text:{text:"コア",color:"aqua",bold:true},transformation:{left_rotation:[0f,0f,0f,1f],right_rotation:[0f,0f,0f,1f],translation:[0f,0f,0f],scale:[1.5f,1.5f,1.5f]}}`);
  // the field's name, above the core and over the last-stand bridge
  for (const [x, y] of [[x0 - 5.5, y0 + 4.2], [x0 + 5.5, y0 + 10.5]]) {
    c.push(`summon minecraft:text_display ${x} ${y} ${z0 + 0.5} {Tags:[${T},"td.fname"],billboard:"center",background:1073741824,text:{text:"フィールド${n}${label ? ' ' + label : ''}",color:"${color}",bold:true},transformation:{left_rotation:[0f,0f,0f,1f],right_rotation:[0f,0f,0f,1f],translation:[0f,0f,0f],scale:[2f,2f,2f]}}`);
  }

  // scenery: conifers on both sides
  if (f.trees) {
    const tr = rng(7);
    for (let x = xMin; x < xMax; x += 7) {
      for (const side of [-1, 1]) {
        const z = z0 + side * (W + 5 + Math.floor(tr() * 6));
        const feat = tr() < 0.5 ? 'minecraft:spruce' : 'minecraft:pine';
        c.push(`place feature ${feat} ${x + Math.floor(tr() * 4)} ${y0} ${z}`);
      }
    }
  }

  // world rules
  c.push(
    `time set ${f.timeOfDay}`, 'weather clear',
    'gamerule advance_time false', 'gamerule advance_weather false', 'gamerule spawn_mobs false',
    'gamerule spawn_monsters false', 'gamerule mob_griefing false', 'gamerule keep_inventory true',
    'gamerule mob_drops false', 'gamerule block_drops false', 'gamerule fall_damage false',
    'gamerule immediate_respawn true', 'gamerule show_death_messages false', 'gamerule log_admin_commands false',
    'gamerule spawn_phantoms false', 'gamerule spawn_patrols false', 'gamerule spawn_wandering_traders false',
    `execute as @e[tag=td.gate,tag=td.f${n}] run function td:gate/reset`,
    `function td:f${n}/gate/front`,
    `function td:f${n}/gate/moveplayers`,
  );
  return { pre, commands: c, gates };
}

const CONCRETE = { red: 'red', blue: 'blue', green: 'lime', yellow: 'yellow', aqua: 'light_blue', light_purple: 'magenta', gold: 'orange', dark_aqua: 'cyan' };
const TF = 'transformation:{left_rotation:[0f,0f,0f,1f],right_rotation:[0f,0f,0f,1f],translation:[0f,0f,0f],scale:[%s]}';
const tf = (s) => TF.replace('%s', `${s}f,${s}f,${s}f`);

// a waxed wall sign whose click runs a /trigger
function sign(x, y, z, lines, cmd, color = 'black') {
  const msgs = lines.map((l, i) => {
    const t = typeof l === 'string' ? { text: l } : l;
    const ce = i === 0 ? `,click_event:{action:"run_command",command:"${cmd}"}` : '';
    return `{text:${JSON.stringify(t.text)}${t.color ? `,color:"${t.color}"` : ''}${t.bold ? ',bold:true' : ''}${ce}}`;
  });
  while (msgs.length < 4) msgs.push('""');
  return `setblock ${x} ${y} ${z} minecraft:dark_oak_wall_sign[facing=south]{front_text:{messages:[${msgs.join(',')}],color:"${color}",has_glowing_text:1b},back_text:{messages:["","","",""]},is_waxed:1b}`;
}

// The waiting area: a platform with a sign board (one column per field: join / watch), the versus and menu signs,
// a status display per field (td.lstat, updated by the app) and the ranking board (td.board, updated by the app).
export function lobbyCommands(field, fields, labels = []) {
  const { x: lx, y: y0, z: lz } = lobbyPos(field, fields);
  const N = fields.count;
  const pre = [`forceload add ${lx - 40} ${lz - 32} ${lx + 40} ${lz + 32}`];
  const c = [];
  c.push('kill @e[tag=td.lobbyx]');
  c.push(...fillX(lx - 26, y0, lz - 20, lx + 26, y0 + 16, lz + 20, 'minecraft:air'));
  c.push(...fillX(lx - 26, y0 - 1, lz - 20, lx + 26, y0 - 1, lz + 20, 'minecraft:grass_block'));
  c.push(...fillX(lx - 26, y0 - 3, lz - 20, lx + 26, y0 - 2, lz + 20, 'minecraft:dirt'));
  // floor
  c.push(`fill ${lx - 17} ${y0 - 1} ${lz - 11} ${lx + 17} ${y0 - 1} ${lz + 11} minecraft:smooth_stone`);
  c.push(`fill ${lx - 16} ${y0 - 1} ${lz - 10} ${lx + 16} ${y0 - 1} ${lz + 10} minecraft:polished_andesite`);
  for (let x = lx - 14; x <= lx + 14; x += 4) c.push(`fill ${x} ${y0 - 1} ${lz - 9} ${x} ${y0 - 1} ${lz + 9} minecraft:polished_diorite`);
  c.push(`fill ${lx - 2} ${y0 - 1} ${lz + 1} ${lx + 2} ${y0 - 1} ${lz + 5} minecraft:chiseled_quartz_block`);
  // low walls on three sides (too high to jump), the board on the fourth
  c.push(`fill ${lx - 17} ${y0} ${lz + 11} ${lx + 17} ${y0} ${lz + 11} minecraft:stone_brick_wall`);
  c.push(`fill ${lx - 17} ${y0} ${lz - 11} ${lx - 17} ${y0} ${lz + 11} minecraft:stone_brick_wall`);
  c.push(`fill ${lx + 17} ${y0} ${lz - 11} ${lx + 17} ${y0} ${lz + 11} minecraft:stone_brick_wall`);
  for (const [x, z] of [[lx - 17, lz + 11], [lx + 17, lz + 11], [lx - 17, lz], [lx + 17, lz]]) {
    c.push(`fill ${x} ${y0} ${z} ${x} ${y0 + 1} ${z} minecraft:stone_bricks`, `setblock ${x} ${y0 + 2} ${z} minecraft:lantern`);
  }
  // sign board
  c.push(`fill ${lx - 17} ${y0 - 1} ${lz - 11} ${lx + 17} ${y0 + 7} ${lz - 11} minecraft:deepslate_tiles`);
  c.push(`fill ${lx - 17} ${y0 + 8} ${lz - 11} ${lx + 17} ${y0 + 8} ${lz - 11} minecraft:deepslate_tile_slab`);
  c.push(`fill ${lx - 17} ${y0 - 1} ${lz - 12} ${lx + 17} ${y0 + 8} ${lz - 12} minecraft:deepslate_bricks`);
  const step = N > 6 ? 3.5 : 4;
  for (let i = 0; i < N; i++) {
    const n = i + 1;
    const x = lx + Math.round((i - (N - 1) / 2) * step);
    const col = FIELD_COLORS[i];
    c.push(`fill ${x} ${y0} ${lz - 11} ${x} ${y0 + 4} ${lz - 11} minecraft:${CONCRETE[col]}_concrete`);
    c.push(`setblock ${x} ${y0 + 5} ${lz - 11} minecraft:sea_lantern`);
    c.push(sign(x, y0 + 2, lz - 10, [{ text: `フィールド${n}`, bold: true }, '', { text: '▶ 入る', color: 'dark_green', bold: true }, labels[i] ? { text: labels[i].slice(0, 15) } : ''], `/trigger td.menu set 1${n}`, CONCRETE[col]));
    c.push(sign(x, y0 + 1, lz - 10, [{ text: `フィールド${n}`, bold: true }, { text: '観戦する', color: 'dark_aqua', bold: true }], `/trigger td.menu set 2${n}`));
    c.push(`summon minecraft:text_display ${x + 0.5} ${y0 + 6.3} ${lz - 10.4} {Tags:["td.lobbyx","td.lstat","td.f${n}"],billboard:"fixed",background:1073741824,line_width:120,text:{text:"フィールド${n}",color:"${col}",bold:true},${tf(0.6)}}`);
  }
  c.push(sign(lx - 16, y0 + 2, lz - 10, [{ text: 'メニュー', bold: true }, { text: 'フィールドの一覧', color: 'dark_gray' }, { text: '（チャットに出ます）', color: 'dark_gray' }], '/trigger td.menu set 1'));
  c.push(sign(lx - 16, y0 + 1, lz - 10, [{ text: '自分の記録', bold: true }], '/trigger td.menu set 5'));
  c.push(sign(lx + 16, y0 + 2, lz - 10, [{ text: '⚔ 対戦モード', color: 'dark_purple', bold: true }, { text: '2人そろうと' }, { text: '同時にスタート' }, { text: 'もう一度でやめる', color: 'dark_gray' }], '/trigger td.menu set 4'));
  c.push(sign(lx + 16, y0 + 1, lz - 10, [{ text: 'ゲームロビーへ', bold: true }, { text: '（ほかのゲーム）', color: 'dark_gray' }], '/trigger lobby set 1'));
  // titles and boards
  c.push(`summon minecraft:text_display ${lx + 0.5} ${y0 + 10.2} ${lz - 10.4} {Tags:["td.lobbyx"],billboard:"fixed",background:0,text:{text:"TikTok Defense",color:"gold",bold:true},${tf(3)}}`);
  c.push(`summon minecraft:text_display ${lx + 0.5} ${y0 + 9.3} ${lz - 10.4} {Tags:["td.lobbyx"],billboard:"fixed",background:0,text:{text:"看板を右クリックしてフィールドを選ぼう  /trigger td.menu でも選べます",color:"white"},${tf(1)}}`);
  c.push(`summon minecraft:text_display ${lx - 11.5} ${y0 + 1.5} ${lz + 4.5} {Tags:["td.lobbyx","td.board"],billboard:"vertical",background:1610612736,line_width:260,text:{text:"ランキング（準備中）",color:"gold"},${tf(0.9)}}`);
  c.push(`summon minecraft:text_display ${lx + 12.5} ${y0 + 1.5} ${lz + 4.5} {Tags:["td.lobbyx"],billboard:"vertical",background:1610612736,line_width:260,text:{text:"",extra:[` +
    `{text:"遊び方\n",color:"gold",bold:true},{text:"・看板の「▶ 入る」でフィールドへ\n・入ったら「▶ スタート」で開始\n・「観戦する」で見るだけ\n・「⚔ 対戦モード」は2人そろうと\n  空きフィールド2つで同時スタート\n・戻るときは /trigger td.menu set 2\n",color:"white"},` +
    `{text:"どのフィールドも同時に遊べます",color:"aqua"}]},${tf(0.9)}}`);
  c.push(`summon minecraft:marker ${lx + 0.5} ${y0} ${lz + 3.5} {Tags:["td.lobbyx","td.lobby"],Rotation:[180f,0f]}`);
  c.push(
    `setworldspawn ${lx} ${y0} ${lz + 3}`, `time set ${field.timeOfDay}`, 'weather clear',
    'gamerule advance_time false', 'gamerule advance_weather false', 'gamerule spawn_mobs false',
    'gamerule spawn_monsters false', 'gamerule mob_griefing false', 'gamerule keep_inventory true',
    'gamerule mob_drops false', 'gamerule block_drops false', 'gamerule fall_damage false',
    'gamerule immediate_respawn true', 'gamerule show_death_messages false', 'gamerule log_admin_commands false',
    'gamerule spawn_phantoms false', 'gamerule spawn_patrols false', 'gamerule spawn_wandering_traders false',
    // people already waiting go to the new waiting area
    'execute as @a[scores={td.fld=0}] run function td:p/tolobby',
  );
  return { pre, commands: c, pos: { x: lx, y: y0, z: lz } };
}
