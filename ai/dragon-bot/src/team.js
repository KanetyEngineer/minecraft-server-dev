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

export class Team {
  constructor({ dir = 'team', name, role = 'leader' } = {}) {
    this.dir = path.resolve(dir);
    this.name = name;
    this.role = role;
    this.needs = [];
    try { fs.mkdirSync(this.dir, { recursive: true }); } catch {}
  }

  get enabled() {
    return true;
  }

  // 自分の状態を書く
  publish(bot) {
    if (!bot?.entity) return;
    const p = bot.entity.position;
    const status = {
      name: this.name, role: this.role, at: Date.now(),
      pos: { x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) },
      dimension: String(bot.game?.dimension ?? 'overworld').replace('minecraft:', ''),
      health: Math.round(bot.health ?? 0), food: Math.round(bot.food ?? 0),
      needs: this.needs,
      // 渡しに向かっている最中なら { to, at }（受け取る側はそばに落ちた物を拾いに動く）
      delivering: this.delivering ?? null,
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

  // 自分（係）が渡せる、リーダーのほしい物 [{ item, count, to }]
  deliverable(bot) {
    const leader = this.leader();
    if (!leader || !SUPPLIES[this.role]) return [];
    const have = new Map();
    for (const i of bot.inventory.items()) have.set(i.name, (have.get(i.name) ?? 0) + i.count);
    const out = [];
    for (const need of leader.needs ?? []) {
      // 種類が「どれでもよい」もの（原木・羊毛など）は、正規表現で受け取る
      const re = need.match ? new RegExp(need.match) : null;
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
