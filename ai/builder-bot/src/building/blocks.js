// 設計図のブロック状態と、それを置くのに要るアイテム・置き方・「置けている」の判定。

// 置かない（ほかの半分と一緒に自動でできる、またはサバイバルで置けない）もの
const SKIP = new Set(['water', 'lava', 'bubble_column', 'fire', 'soul_fire', 'piston_head', 'moving_piston',
  'nether_portal', 'end_portal', 'end_gateway', 'barrier', 'light', 'structure_void', 'tripwire', 'frosted_ice']);

// アイテム名がブロック名と違うもの
const ITEM_OF = {
  wall_torch: 'torch', soul_wall_torch: 'soul_torch', redstone_wall_torch: 'redstone_torch', copper_wall_torch: 'copper_torch',
  redstone_wire: 'redstone', tripwire: 'string', cocoa: 'cocoa_beans', carrots: 'carrot', potatoes: 'potato',
  wheat: 'wheat_seeds', beetroots: 'beetroot_seeds', pumpkin_stem: 'pumpkin_seeds', melon_stem: 'melon_seeds',
  sweet_berry_bush: 'sweet_berries', cave_vines: 'glow_berries', cave_vines_plant: 'glow_berries',
  kelp_plant: 'kelp', twisting_vines_plant: 'twisting_vines', weeping_vines_plant: 'weeping_vines', bamboo_sapling: 'bamboo',
};

// シルクタッチが無いと手に入らないブロックは、置いたら同じ見た目に育つ／近いものに置き換える
const SUBSTITUTE = { grass_block: 'dirt', mycelium: 'dirt', podzol: 'dirt', dirt_path: 'dirt', farmland: 'dirt' };

// 置けていれば「済み」とみなす別名（草ブロックの所の土は、いずれ草が広がる）
const ACCEPT = { grass_block: ['dirt'], mycelium: ['dirt'], podzol: ['dirt'], dirt_path: ['dirt'], farmland: ['dirt'] };

// 向きが合っていなくても置き直さない（見た目にほとんど影響しない／自動で決まる）性質
const IGNORED_PROPS = new Set(['waterlogged', 'powered', 'open', 'lit', 'distance', 'persistent', 'snowy', 'shape',
  'north', 'south', 'east', 'west', 'up', 'down', 'attached', 'occupied', 'triggered', 'age', 'stage', 'moisture',
  'level', 'note', 'instrument', 'power', 'hinge', 'has_book', 'has_bottle_0', 'has_bottle_1', 'has_bottle_2', 'in_wall',
  'unstable', 'bottom', 'drag', 'enabled', 'locked', 'delay', 'mode', 'extended', 'short', 'inverted', 'conditional',
  'honey_level', 'bites', 'charges', 'eggs', 'hatch', 'pickles', 'layers', 'candles', 'flower_amount', 'segment_amount',
  'tip', 'thickness', 'vertical_direction', 'berries', 'leaves', 'hanging', 'signal_fire', 'tilt', 'cracked', 'natural',
  'crafting', 'orientation', 'ominous', 'trial_spawner_state', 'vault_state', 'sculk_sensor_phase', 'bloom', 'can_summon', 'shrieking']);

export function isAirName(n) {
  return n === 'air' || n === 'cave_air' || n === 'void_air';
}

// 2 マスで 1 つのブロック（ドア・ベッド・背の高い草花）の、自分では置かない側か
export function isSecondaryHalf(b) {
  const p = b.props ?? {};
  if (b.name.endsWith('_bed')) return p.part === 'head';
  if (p.half === 'upper') return true; // ドア・背の高い花・小さなドリップリーフなど
  return false;
}

// そのブロックを置くのに要るアイテムと個数。置かないものは null
export function itemFor(registry, b) {
  if (SKIP.has(b.name) || isAirName(b.name) || isSecondaryHalf(b)) return null;
  let name = SUBSTITUTE[b.name] ?? ITEM_OF[b.name] ?? b.name;
  name = name
    .replace(/_wall_hanging_sign$/, '_hanging_sign')
    .replace(/_wall_sign$/, '_sign')
    .replace(/_wall_banner$/, '_banner')
    .replace(/_wall_fan$/, '_fan')
    .replace(/^potted_(.+)$/, 'flower_pot'); // 植木鉢は鉢だけ（中身は別に入れる必要がある）
  if (name.endsWith('_wall_head') || name.endsWith('_wall_skull')) name = name.replace('_wall_', '_');
  if (!registry.itemsByName[name]) return null;
  const p = b.props ?? {};
  let count = 1;
  if (p.type === 'double' && name.endsWith('_slab')) count = 2;
  for (const k of ['candles', 'pickles', 'eggs', 'flower_amount', 'segment_amount']) if (p[k]) count = Number(p[k]);
  if (p.layers && name === 'snow') count = Number(p.layers);
  return { item: name, count };
}

// 設計図全体の必要数（アイテム名 → 個数）
export function materialList(registry, blocks) {
  const need = new Map();
  const unplaceable = new Map();
  for (const b of blocks) {
    const it = itemFor(registry, b);
    if (!it) {
      if (!isSecondaryHalf(b) && !isAirName(b.name)) unplaceable.set(b.name, (unplaceable.get(b.name) ?? 0) + 1);
      continue;
    }
    need.set(it.item, (need.get(it.item) ?? 0) + it.count);
  }
  return { need, unplaceable };
}

// 世界のブロックが設計図どおりか。checkProps=false なら種類だけ見る
export function matches(target, world, { checkProps = true } = {}) {
  if (!world) return false;
  if (world.name !== target.name && !(ACCEPT[target.name] ?? []).includes(world.name)) return false;
  if (world.name !== target.name) return true;
  // ハーフブロックの上下・2 枚重ねは形（と使う数）が変わるので、向きを見ないときでも合わせる
  // （隣に置こうとして下付きの上に重ね、2 枚重ねにしてしまったのを「できている」と数えていた）
  if (!checkProps) {
    const want = target.props?.type;
    return !(want && target.name.endsWith('_slab') && String(world.getProperties?.().type ?? want) !== String(want));
  }
  const have = world.getProperties?.() ?? {};
  for (const [k, v] of Object.entries(target.props ?? {})) {
    if (IGNORED_PROPS.has(k)) continue;
    if (have[k] !== undefined && String(have[k]) !== String(v)) return false;
  }
  return true;
}

// ---------- 置き方（向き） ----------
// バニラの「置いたときの向き」の決まり方に合わせて、どの面をクリックし、どちらを向いて置くかを決める。

const DIRS = {
  north: [0, 0, -1], south: [0, 0, 1], west: [-1, 0, 0], east: [1, 0, 0], up: [0, 1, 0], down: [0, -1, 0],
};
const OPP = { north: 'south', south: 'north', west: 'east', east: 'west', up: 'down', down: 'up' };
// mineflayer の yaw: 0 が北（-z）向き、π/2 が西（-x）向き
const YAW = { north: 0, west: Math.PI / 2, south: Math.PI, east: -Math.PI / 2 };

// facing が「プレイヤーが見ている向き」になるもの（それ以外の向き付きブロックは、プレイヤーの方を向く＝見ている向きの逆）
const FACING_IS_LOOK = /(_stairs|_door|_bed|_fence_gate|^observer|^repeater|^comparator|^lectern$|_glazed_terracotta$)/;

export { DIRS, OPP };

// 置き方の希望: { look: 'north' など（見る水平の向き）, vertical: 'up' / 'down'（見る上下の向き）, yaw: 16 方向の向き,
//                faces: クリックしてよい面（参照ブロックから見た向き）, half: 横の面の上半分・下半分 }
export function placementHint(b) {
  const p = b.props ?? {};
  const hint = {};
  if (p.axis) {
    // 原木・柱: クリック面の軸がそのまま axis になる
    hint.faces = p.axis === 'y' ? ['down', 'up'] : p.axis === 'x' ? ['east', 'west'] : ['north', 'south'];
  }
  if (p.facing && b.name.endsWith('_trapdoor')) {
    // 上下の面をクリックしたときは見ている向きの逆が facing
    hint.look = OPP[p.facing];
    hint.faces = p.half === 'top' ? ['down'] : ['up'];
  } else if (p.facing && /(wall_torch|_wall_sign|_wall_banner|_wall_head|_wall_skull|_wall_fan|ladder|^tripwire_hook$|_button$|^lever$|^end_rod$|^lightning_rod$)/.test(b.name)) {
    // end_rod・lightning_rod もクリックした面の向きになる
    // 壁に付けるもの: 付けたい壁のブロックの、facing の向きの面をクリックする
    hint.faces = [p.facing];
    if (p.face === 'floor') hint.faces = ['up'];
    if (p.face === 'ceiling') hint.faces = ['down'];
  } else if (p.facing && ['up', 'down'].includes(p.facing)) {
    // 上下を向くもの（ピストン・観察者など）は見ている上下の向きで決まる。観察者は見ている向き、ほかはその逆
    hint.vertical = FACING_IS_LOOK.test(b.name) ? p.facing : OPP[p.facing];
  } else if (p.facing) {
    hint.look = FACING_IS_LOOK.test(b.name) ? p.facing : OPP[p.facing];
  }
  if (p.rotation !== undefined && !p.facing) {
    // 看板・旗・頭（16 方向）: プレイヤーの向きの逆が rotation（0 = 南向き）
    const r = Number(p.rotation);
    hint.yaw = Math.PI - (r * Math.PI) / 8 + Math.PI;
  }
  if (b.name.endsWith('_slab')) {
    if (p.type === 'top') hint.half = 'top';
    else if (p.type === 'bottom') hint.half = 'bottom';
  }
  if (b.name.endsWith('_stairs')) hint.half = p.half === 'top' ? 'top' : 'bottom';
  return hint;
}

export function yawFor(dir) {
  return YAW[dir];
}
