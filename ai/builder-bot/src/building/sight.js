// 普通のプレイヤーと同じ条件で置く・掘るための判定。
// - 手が届く: 目からクリックする点まで 4.5 マス以内（サバイバルの手の届く距離）
// - 面が見える: クリックする面が目の方を向いていて、目からその点までの間にほかのブロックが無い（壁越し・床越しに置かない）
// - 向き: 階段・ドアなど「見ている向き」で向きが決まるブロックは、クリックする点を見たときの向きが設計図どおりになる所に立つ
// mineflayer はサーバーが許す範囲なら見えない面にも置けてしまうので、ここで普通のプレイヤーにできることだけに絞る。
import { Vec3 } from 'vec3';
import { DIRS, placementHint } from './blocks.js';

export const REACH = 4.5;
export const EYE_HEIGHT = 1.62;

// prismarine-world の raycast が返す面の番号
const FACE_ID = { down: 0, up: 1, north: 2, south: 3, west: 4, east: 5 };
const FACE_ORDER = ['up', 'north', 'south', 'east', 'west', 'down'];
// クリックすると開いてしまう（置けない）ブロック。参照には使わない
export const INTERACTIVE = /(chest|barrel|furnace|smoker|crafting_table|_door|_trapdoor|_bed|_button|lever|anvil|_shulker_box|hopper|dispenser|dropper|enchanting_table|brewing_stand|loom|stonecutter|grindstone|smithing_table|cartography_table|fletching_table|_sign|lectern|bell|repeater|comparator|note_block|jukebox|beacon|_fence_gate|cake|composter|cauldron|crafter|decorated_pot|chiseled_bookshelf)/;
// 見ている向き（上下も含めていちばん近い向き）で向きが決まるブロック
const LOOK3D = /^(piston|sticky_piston|observer|dispenser|dropper|barrel|crafter|command_block|chain_command_block|repeating_command_block)$/;

// ノード（足の位置のブロック座標）に立ったときの目の位置
export function eyeAt(node) {
  return new Vec3(node.x + 0.5, node.y + EYE_HEIGHT, node.z + 0.5);
}

// ブロックの当たり判定をまとめた箱 [x0, y0, z0, x1, y1, z1]（ブロック内の座標）
function shapeBox(block) {
  const shapes = block.shapes?.length ? block.shapes : [[0, 0, 0, 1, 1, 1]];
  return shapes.reduce((a, s) => [Math.min(a[0], s[0]), Math.min(a[1], s[1]), Math.min(a[2], s[2]),
    Math.max(a[3], s[3]), Math.max(a[4], s[4]), Math.max(a[5], s[5])], [1, 1, 1, 0, 0, 0]);
}

// 参照ブロックの face の面のうち、クリックする点（ブロック内の座標 delta と、世界の座標 point）。
// half: 'top' / 'bottom' は横の面の上半分・下半分（ハーフブロック・階段の上下）。その高さが面に無ければ null
export function clickPoint(ref, face, half) {
  const [x0, y0, z0, x1, y1, z1] = shapeBox(ref);
  const d = DIRS[face];
  const cx = d[0] > 0 ? x1 : d[0] < 0 ? x0 : (x0 + x1) / 2;
  let cy = d[1] > 0 ? y1 : d[1] < 0 ? y0 : (y0 + y1) / 2;
  const cz = d[2] > 0 ? z1 : d[2] < 0 ? z0 : (z0 + z1) / 2;
  if (d[1] === 0 && half) {
    // バニラは「置くブロックのマスの中で、クリックした高さが半分より上か」で上下を決める
    cy = half === 'top' ? 0.75 : 0.25;
    if (cy < y0 || cy > y1) return null;
  }
  const delta = new Vec3(cx, cy, cz);
  return { delta, point: ref.position.plus(delta) };
}

// 目から、参照ブロックの face の面の point が見えて、手が届くか
export function seesFace(world, eye, ref, face, point) {
  const dir = point.minus(eye);
  const dist = dir.norm();
  if (dist > REACH || dist < 1e-6) return false;
  const n = DIRS[face];
  // 面の表側（外側）に目がある
  if ((eye.x - point.x) * n[0] + (eye.y - point.y) * n[1] + (eye.z - point.z) * n[2] <= 1e-3) return false;
  const hit = world.raycast(eye, dir.normalize(), dist + 0.05);
  return !!hit && hit.position.equals(ref.position) && hit.face === FACE_ID[face];
}

// 目から、掘るブロックのどれかの面が見えて、手が届くか
export function seesBlock(world, eye, block) {
  const [x0, y0, z0, x1, y1, z1] = shapeBox(block);
  const c = block.position.offset((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  const pts = [c];
  for (const f of FACE_ORDER) pts.push(clickPoint(block, f)?.point);
  for (const p of pts) {
    if (!p) continue;
    const dir = p.minus(eye);
    const dist = dir.norm();
    if (dist > REACH || dist < 1e-6) continue;
    const hit = world.raycast(eye, dir.normalize(), dist + 0.05);
    if (hit && hit.position.equals(block.position)) return true;
  }
  return false;
}

// クリックする点を見たときの向きで、設計図どおりの向きに置けるか
export function orientOk(t, eye, point, hint = placementHint(t)) {
  const v = point.minus(eye);
  const ax = Math.abs(v.x); const az = Math.abs(v.z); const ay = Math.abs(v.y);
  const horiz = ax > az ? (v.x > 0 ? 'east' : 'west') : (v.z > 0 ? 'south' : 'north');
  if (hint.look) {
    if (horiz !== hint.look) return false;
    // 上下も含めていちばん近い向きで決まるもの（ピストンなど）は、上下より水平の方が大きくないといけない
    if (LOOK3D.test(t.name) && ay >= Math.max(ax, az)) return false;
    // 区切りぎりぎり（斜め 45 度）はサーバーと判断がずれることがあるので避ける
    if (Math.abs(ax - az) < 0.15) return false;
  }
  if (hint.vertical) {
    if (ay <= Math.max(ax, az) + 0.1) return false;
    if ((v.y > 0) !== (hint.vertical === 'up')) return false;
  }
  if (hint.yaw !== undefined) {
    const yaw = Math.atan2(-v.x, -v.z);
    let diff = (yaw - hint.yaw) % (2 * Math.PI);
    if (diff > Math.PI) diff -= 2 * Math.PI;
    if (diff < -Math.PI) diff += 2 * Math.PI;
    if (Math.abs(diff) > Math.PI / 16 - 0.02) return false;
  }
  return true;
}

// 面の中の、クリックしてよい点（真ん中と、その周り 4 つ）。プレイヤーは面のどこをクリックしてもよいので、
// 真ん中が見えなくても端が見えれば置ける（斜めから穴をのぞくときなど、真ん中だけ見ていると置けないことがあった）
function facePoints(ref, face, half) {
  const base = clickPoint(ref, face, half);
  if (!base) return [];
  const [x0, y0, z0, x1, y1, z1] = shapeBox(ref);
  const lo = { x: x0, y: y0, z: z0 };
  const hi = { x: x1, y: y1, z: z1 };
  const d = DIRS[face];
  // 面に沿った 2 つの軸（上下の半分が決まっているときは、上下にはずらさない）
  const axes = d[0] !== 0 ? ['z', 'y'] : d[2] !== 0 ? ['x', 'y'] : ['x', 'z'];
  const out = [base];
  for (const ax of axes) {
    if (ax === 'y' && half) continue;
    for (const o of [0.3, -0.3]) {
      const delta = base.delta.clone();
      delta[ax] += o;
      if (delta[ax] < lo[ax] + 0.05 || delta[ax] > hi[ax] - 0.05) continue;
      out.push({ delta, point: ref.position.plus(delta) });
    }
  }
  return out;
}

// p に t を置くときに、クリックしてよい参照ブロックと面と点の候補（見えるかどうかはまだ見ない）
export function placeCandidates(bot, p, t) {
  const hint = t ? placementHint(t) : {};
  let faces = hint.faces ?? FACE_ORDER;
  if (hint.half === 'top') faces = faces.filter((f) => f !== 'up');
  if (hint.half === 'bottom' && !hint.faces) faces = faces.filter((f) => f !== 'down');
  const out = [];
  for (const f of faces) {
    const d = DIRS[f];
    const ref = bot.blockAt(p.offset(-d[0], -d[1], -d[2]));
    if (!ref || ref.boundingBox !== 'block' || INTERACTIVE.test(ref.name)) continue;
    for (const c of facePoints(ref, f, d[1] === 0 ? hint.half : undefined)) {
      out.push({ ref, face: f, faceVec: new Vec3(d[0], d[1], d[2]), delta: c.delta, point: c.point, hint });
    }
  }
  return out;
}

// 立ち位置を決めるときは、マスの真ん中の目だけでなく、少しずれた目（前後左右 0.15）からも見えることを求める。
// 実際に立つと真ん中から少しずれるので、ぎりぎり見える所を選ぶと、着いてから見えなくなっていた
function eyesAround(eye, robust) {
  if (!robust) return [eye];
  return [eye, eye.offset(0.15, 0, 0), eye.offset(-0.15, 0, 0), eye.offset(0, 0, 0.15), eye.offset(0, 0, -0.15)];
}

// eye から置ける候補（見えて、届いて、向きも合う）を 1 つ返す。無ければ null
export function legitPlacement(bot, eye, t, cands, { robust = false } = {}) {
  const eyes = eyesAround(eye, robust);
  for (const c of cands) {
    if (!eyes.every((e) => seesFace(bot.world, e, c.ref, c.face, c.point))) continue;
    if (t && !eyes.every((e) => orientOk(t, e, c.point, c.hint))) continue;
    return c;
  }
  return null;
}

// eye から掘るブロックが見えるか（robust: 少しずれた目からも）
export function legitDig(bot, eye, block, { robust = false } = {}) {
  return eyesAround(eye, robust).every((e) => seesBlock(bot.world, e, block));
}
