// 複数のボットの協力（チーム）。
// ボットごとに team/<名前>.json に自分の状態（場所・体力・役割・ほしい物）を書き、ほかのボットのファイルを読む。
// 1 ファイルを 1 体だけが書くので、書き込みがぶつからない。
import fs from 'node:fs';
import path from 'node:path';

export const ROLES = {
  leader: 'リーダー（エンドラ討伐の本筋を進める）',
  food: '食料・木材係（木・食料・羊毛を集めてリーダーに渡す）',
  iron: '鉄・鉱石係（鉄・石炭を掘って精錬し、リーダーに渡す）',
};

// 係ごとに、渡す担当の品物
export const SUPPLIES = {
  food: (name) => /^(cooked_|bread$|baked_potato$|apple$|golden_carrot$)/.test(name) || /_log$|_planks$/.test(name) || /_wool$|_bed$/.test(name),
  iron: (name) => ['iron_ingot', 'raw_iron', 'coal', 'charcoal', 'iron_pickaxe', 'iron_sword', 'bucket', 'obsidian', 'flint', 'flint_and_steel', 'diamond'].includes(name),
};

// チーム全員で共有する場所（村・溶岩溜まり・ゲートなど）。ベッドや復活地点は 1 体ごとの物なので共有しない
export const SHARED_PLACES = ['village', 'ruined_portal', 'lava_pool', 'overworld_portal', 'nether_portal', 'fortress', 'bastion',
  'warped_forest', 'stronghold_estimate', 'stronghold', 'end_portal'];

// 独立して動くとき、全員が同じ動きにならないよう番号ごとに進め方を少し変える（番号を 4 で割った余りで決まる）
export const STRATEGIES = [
  { name: '定石', description: 'RTA の定石どおり（盾だけで進み、溶岩と水でゲート）' },
  { name: '防具優先', description: '鉄の防具をそろえてからネザーへ', armorEarly: true },
  { name: '探索優先', description: '村・廃ポータル・溶岩溜まりを見つけるまで先に歩き回る', exploreFirst: true },
  { name: 'ダイヤ掘り', description: 'ダイヤのツルハシで黒曜石を掘ってゲートを建てる', portalByDiamonds: true },
];

// 名前の末尾の番号（DragonBot → 1、DragonBot7 → 7）
export function indexOf(name) {
  const m = /(\d+)$/.exec(name ?? '');
  return m ? Number(m[1]) : 1;
}

// 名前（番号）から進め方を決める。チームを組まない solo でも使う
export function strategyFor(name) {
  return STRATEGIES[(indexOf(name) - 1) % STRATEGIES.length];
}

export class Team {
  constructor({ dir = 'team', name, role = 'leader' } = {}) {
    this.dir = path.resolve(dir);
    this.name = name;
    this.role = role;
    this.needs = [];
    this.lastPlaces = {};
    try { fs.mkdirSync(this.dir, { recursive: true }); } catch {}
  }

  // 名前の末尾の番号（DragonBot → 1、DragonBot7 → 7）
  get index() {
    return indexOf(this.name);
  }

  // 自分の進め方（番号ごとに違う）
  strategy() {
    return strategyFor(this.name);
  }

  // 散らばるときの自分の向き（番号ごとに 45 度ずつ違う方角）。全員が同じ木や動物を取り合わないようにする
  homeHeading() {
    return ((this.index - 1) % 8) * (Math.PI / 4);
  }

  // 同じ次元で r マス以内にいる仲間の数
  crowded(bot, r = 12) {
    const p = bot?.entity?.position;
    if (!p) return 0;
    const dim = String(bot.game?.dimension ?? 'overworld').replace('minecraft:', '');
    return this.members().filter((m) => (m.dimension ?? 'overworld') === dim && m.pos
      && Math.hypot(m.pos.x - p.x, m.pos.z - p.z) < r).length;
  }

  // 仲間が見つけた場所（村・溶岩溜まり・ゲートなど）を、自分の記憶に無ければ取り込む。取り込んだ名前を返す
  importPlaces(memory) {
    if (!memory?.setPlace || !memory.getPlace) return [];
    const got = [];
    for (const m of this.members()) {
      for (const [name, p] of Object.entries(m.places ?? {})) {
        if (!SHARED_PLACES.includes(name) || memory.getPlace(name) || !p) continue;
        memory.setPlace(name, p, p.dimension);
        got.push(name);
      }
    }
    return got;
  }

  get enabled() {
    return true;
  }

  // 自分の状態を書く（memory を渡すと、共有する場所も一緒に書く）
  publish(bot, memory) {
    if (!bot?.entity) return;
    const p = bot.entity.position;
    if (memory?.data?.places) {
      this.lastPlaces = Object.fromEntries(Object.entries(memory.data.places).filter(([n]) => SHARED_PLACES.includes(n)));
    }
    const status = {
      name: this.name, role: this.role, at: Date.now(),
      pos: { x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) },
      dimension: String(bot.game?.dimension ?? 'overworld').replace('minecraft:', ''),
      health: Math.round(bot.health ?? 0), food: Math.round(bot.food ?? 0),
      needs: this.needs,
      // 渡しに向かっている最中なら { to, at, items }（受け取る側はそばに落ちた物を拾いに動き、ほかの係は同じ物を重ねて運ばない）
      delivering: this.delivering ?? null,
      places: this.lastPlaces,
    };
    const file = path.join(this.dir, `${this.name}.json`);
    try {
      fs.writeFileSync(`${file}.tmp`, JSON.stringify(status));
      fs.renameSync(`${file}.tmp`, file);
    } catch {}
  }

  // ほかのボットの状態（1 分以上更新の無いものは除く）
  members() {
    let files = [];
    try { files = fs.readdirSync(this.dir).filter((f) => f.endsWith('.json')); } catch { return []; }
    const out = [];
    for (const f of files) {
      try {
        const s = JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf8'));
        if (s.name !== this.name && Date.now() - s.at < 60_000) out.push(s);
      } catch {}
    }
    return out;
  }

  leader() {
    return this.members().find((m) => m.role === 'leader') ?? null;
  }

  // 自分に物を渡しに来ている仲間（同じ次元で 12 マス以内、40 秒以内の情報）。受け取る側はそばの落とし物を拾う
  incomingDelivery(bot) {
    const p = bot?.entity?.position;
    if (!p) return null;
    const dim = String(bot.game?.dimension ?? 'overworld').replace('minecraft:', '');
    return this.members().find((m) => m.delivering?.to === this.name && Date.now() - (m.delivering.at ?? 0) < 40_000
      && (m.dimension ?? 'overworld') === dim && m.pos && Math.hypot(m.pos.x - p.x, m.pos.y - p.y, m.pos.z - p.z) < 12) ?? null;
  }

  // ほかの係がいま運んでいる途中の物（60 秒以内）。同じ物を何体も重ねて運ばないために差し引く
  inflight(to) {
    const out = [];
    for (const m of this.members()) {
      const d = m.delivering;
      if (!d || d.to !== to || Date.now() - (d.at ?? 0) > 60_000) continue;
      for (const it of d.items ?? []) out.push(it);
    }
    return out;
  }

  // 自分（係）が渡せる、リーダーのほしい物 [{ item, count, to }]
  deliverable(bot) {
    const leader = this.leader();
    if (!leader || !SUPPLIES[this.role]) return [];
    const have = new Map();
    for (const i of bot.inventory.items()) have.set(i.name, (have.get(i.name) ?? 0) + i.count);
    const inflight = this.inflight(leader.name);
    const out = [];
    for (const need0 of leader.needs ?? []) {
      // 種類が「どれでもよい」もの（原木・羊毛など）は、正規表現で受け取る
      const re = need0.match ? new RegExp(need0.match) : null;
      const matches = (name) => (re ? re.test(name) : name === need0.item);
      const carried = inflight.filter((it) => matches(it.item)).reduce((s, it) => s + (it.count ?? 0), 0);
      const need = { ...need0, count: need0.count - carried };
      if (need.count <= 0) continue;
      for (const [name, n] of have) {
        if (!SUPPLIES[this.role](name)) continue;
        if (re ? !re.test(name) : name !== need.item) continue;
        // 自分の分は少し残す（食料は 4、木材は 4）。鉄係は自分の鉄のツルハシ（3）と剣（2）の分だけ先に残す（石のツルハシでは遅い）
        const hasOwn = (n) => bot.inventory.items().some((i) => i.name === n);
        const keep = /^cooked_|bread|apple/.test(name) ? 4 : /_log$|_planks$/.test(name) ? 4
          : name === 'iron_ingot' ? (hasOwn('iron_pickaxe') ? (hasOwn('iron_sword') ? 0 : 2) : 3) : 0;
        const give = Math.min(need.count, n - keep);
        if (give > 0) out.push({ item: name, count: give, to: leader.name });
      }
    }
    return out;
  }
}

// リーダーがほしい物（進み具合から計算する）。係はこれを見て、持っていれば渡しに来る
export function leaderNeeds(bot, m) {
  const c = m._counts;
  const needs = [];
  const ironNeeded = (m.ironPickaxe ? 0 : 3) + (m.ironSword ? 0 : 2) + (m.shield ? 0 : 1) + (m.bucket ? 0 : 3) + (m.armor ? 0 : 24) + 3;
  const ironHave = c.iron;
  if (ironHave < ironNeeded) needs.push({ item: 'iron_ingot', count: Math.min(16, ironNeeded - ironHave) });
  if (c.food < 10) needs.push({ match: '^(cooked_|bread$|baked_potato$|apple$)', item: '食料', count: 12 - Math.floor(c.food) });
  if (c.logs < 6) needs.push({ match: '_log$', item: '原木', count: 8 });
  const beds = bot.inventory.items().filter((i) => i.name.endsWith('_bed')).reduce((s, i) => s + i.count, 0);
  if (beds < 1) needs.push({ match: '_bed$', item: 'ベッド', count: 1 });
  if (count(bot, 'coal') + count(bot, 'charcoal') < 4) needs.push({ match: '^(coal|charcoal)$', item: '石炭', count: 8 });
  return needs;
}

function count(bot, name) {
  return bot.inventory.items().filter((i) => i.name === name).reduce((s, i) => s + i.count, 0);
}
