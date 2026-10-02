// Litematica の設計図（.litematic）の読み書き。
// 中身は gzip 圧縮した NBT で、領域（Region）ごとに「ブロック状態のパレット」と、
// パレット番号を詰めた long 配列（1 個あたり max(2, ceil(log2(パレット数))) ビット、long をまたいで詰める）を持つ。
// 並び順は index = (y * sizeZ + z) * sizeX + x。Size が負の軸は Position から負の向きに伸びる。
import zlib from 'node:zlib';
import nbt from 'prismarine-nbt';

const AIR = new Set(['air', 'cave_air', 'void_air']);
const strip = (n) => String(n).replace(/^minecraft:/, '');

// prismarine-nbt の long は [上位 32 ビット, 下位 32 ビット] の組（BigInt で来る場合もある）
function toBig(v) {
  if (typeof v === 'bigint') return BigInt.asUintN(64, v);
  return BigInt.asUintN(64, (BigInt(v[0]) << 32n) | BigInt(v[1] >>> 0));
}

export function bitsFor(paletteSize) {
  return Math.max(2, Math.ceil(Math.log2(Math.max(1, paletteSize))));
}

export function unpackStates(longs, bits, count) {
  const big = longs.map(toBig);
  const mask = (1n << BigInt(bits)) - 1n;
  const out = new Uint32Array(count);
  for (let i = 0; i < count; i++) {
    const start = i * bits;
    const li = Math.floor(start / 64);
    const off = BigInt(start % 64);
    let v = big[li] >> off;
    if (Number(off) + bits > 64) v |= big[li + 1] << (64n - off);
    out[i] = Number(v & mask);
  }
  return out;
}

export function packStates(values, bits) {
  const n = Math.ceil((values.length * bits) / 64);
  const big = new Array(n).fill(0n);
  for (let i = 0; i < values.length; i++) {
    const v = BigInt(values[i]);
    const start = i * bits;
    const li = Math.floor(start / 64);
    const off = BigInt(start % 64);
    big[li] = BigInt.asUintN(64, big[li] | (v << off));
    if (Number(off) + bits > 64) big[li + 1] = BigInt.asUintN(64, big[li + 1] | (v >> (64n - off)));
  }
  // [上位, 下位] の符号付き 32 ビットに戻す
  return big.map((b) => [Number(BigInt.asIntN(32, b >> 32n)), Number(BigInt.asIntN(32, b & 0xffffffffn))]);
}

// 読み込み: 空気以外のブロックを、設計図全体の最小角を (0,0,0) とした相対座標で返す
export async function parseLitematic(buffer) {
  const { parsed } = await nbt.parse(buffer);
  const root = nbt.simplify(parsed);
  const regions = [];
  for (const [name, r] of Object.entries(root.Regions ?? {})) {
    const size = { x: r.Size.x, y: r.Size.y, z: r.Size.z };
    const abs = { x: Math.abs(size.x), y: Math.abs(size.y), z: Math.abs(size.z) };
    const min = {
      x: r.Position.x + (size.x < 0 ? size.x + 1 : 0),
      y: r.Position.y + (size.y < 0 ? size.y + 1 : 0),
      z: r.Position.z + (size.z < 0 ? size.z + 1 : 0),
    };
    const palette = r.BlockStatePalette.map((p) => ({ name: strip(p.Name), props: p.Properties ?? {} }));
    const states = unpackStates(r.BlockStates, bitsFor(palette.length), abs.x * abs.y * abs.z);
    regions.push({ name, min, size: abs, palette, states });
  }
  if (regions.length === 0) throw new Error('設計図に領域がない');
  const lo = { x: Infinity, y: Infinity, z: Infinity };
  const hi = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const r of regions) {
    for (const k of ['x', 'y', 'z']) {
      lo[k] = Math.min(lo[k], r.min[k]);
      hi[k] = Math.max(hi[k], r.min[k] + r.size[k] - 1);
    }
  }
  const blocks = [];
  for (const r of regions) {
    const { x: sx, z: sz } = r.size;
    for (let i = 0; i < r.states.length; i++) {
      const st = r.palette[r.states[i]];
      if (!st || AIR.has(st.name)) continue;
      const x = i % sx;
      const z = Math.floor(i / sx) % sz;
      const y = Math.floor(i / (sx * sz));
      blocks.push({ x: r.min.x + x - lo.x, y: r.min.y + y - lo.y, z: r.min.z + z - lo.z, name: st.name, props: st.props });
    }
  }
  return {
    name: root.Metadata?.Name ?? regions[0].name,
    size: { x: hi.x - lo.x + 1, y: hi.y - lo.y + 1, z: hi.z - lo.z + 1 },
    blocks,
  };
}

// 書き出し（試験用の設計図を作るため）。blocks は {x,y,z,name,props}（0 以上の相対座標）
export function writeLitematic({ name, author = 'BuilderBot', blocks, size, dataVersion = 4903 }) {
  const paletteKey = (b) => `${b.name}|${JSON.stringify(b.props ?? {})}`;
  const palette = [{ name: 'air', props: {} }];
  const index = new Map([[paletteKey(palette[0]), 0]]);
  const values = new Array(size.x * size.y * size.z).fill(0);
  for (const b of blocks) {
    const k = paletteKey(b);
    if (!index.has(k)) { index.set(k, palette.length); palette.push({ name: b.name, props: b.props ?? {} }); }
    values[(b.y * size.z + b.z) * size.x + b.x] = index.get(k);
  }
  const vec = (v) => nbt.comp({ x: nbt.int(v.x), y: nbt.int(v.y), z: nbt.int(v.z) });
  const now = Date.now();
  const long = (ms) => nbt.long([Math.floor(ms / 2 ** 32), ms % 2 ** 32 | 0]);
  const root = nbt.comp({
    MinecraftDataVersion: nbt.int(dataVersion),
    Version: nbt.int(7),
    SubVersion: nbt.int(1),
    Metadata: nbt.comp({
      Name: nbt.string(name),
      Author: nbt.string(author),
      Description: nbt.string(''),
      RegionCount: nbt.int(1),
      TotalVolume: nbt.int(values.length),
      TotalBlocks: nbt.int(blocks.length),
      TimeCreated: long(now),
      TimeModified: long(now),
      EnclosingSize: vec(size),
    }),
    Regions: nbt.comp({
      [name]: nbt.comp({
        Position: vec({ x: 0, y: 0, z: 0 }),
        Size: vec(size),
        BlockStatePalette: nbt.list(nbt.comp(palette.map((p) => {
          const c = { Name: nbt.string(`minecraft:${p.name}`) };
          if (Object.keys(p.props).length) c.Properties = nbt.comp(Object.fromEntries(Object.entries(p.props).map(([k, v]) => [k, nbt.string(String(v))])));
          return c;
        }))),
        BlockStates: { type: 'longArray', value: packStates(values, bitsFor(palette.length)) },
        TileEntities: nbt.list(nbt.comp([])),
        Entities: nbt.list(nbt.comp([])),
        PendingBlockTicks: nbt.list(nbt.comp([])),
        PendingFluidTicks: nbt.list(nbt.comp([])),
      }),
    }),
  }, '');
  return zlib.gzipSync(nbt.writeUncompressed(root, 'big'));
}
