// 行動のループ防止。
// 同じスキル（同じ引数）が進展なしに続いたら、そのスキルをしばらく禁止して別の行動（探索など）に切り替える。
// 「進展」= 持ち物が変わった / 16 ブロック以上動いた / 成功して結果の文が前回と違う。
// 禁止は 3 分から始め、同じスキルで繰り返すたびに 2 倍（最大 30 分）にする。

const BASE_BAN_MS = 3 * 60_000;
const MAX_BAN_MS = 30 * 60_000;

export class LoopGuard {
  constructor({ maxStreak = 3, now = () => Date.now() } = {}) {
    this.maxStreak = maxStreak;
    this.now = now;
    this.lastKey = null;
    this.lastResult = null;
    this.streak = 0;
    this.bans = new Map(); // skill → { until, times }
    this.recentSkills = []; // 直近の行動（引数違いでも同じスキルの往復を検知する）
  }

  static key(skill, args) {
    return `${skill}(${JSON.stringify(args ?? {})})`;
  }

  // スキル実行後に呼ぶ。ループと判断したら { skill, banMs } を返す
  record({ skill, args, ok, result, progressed }) {
    const key = LoopGuard.key(skill, args);
    const sameAsLast = key === this.lastKey;
    const noProgress = !progressed && (!ok || result === this.lastResult);
    this.streak = sameAsLast && noProgress ? this.streak + 1 : 1;
    this.lastKey = key;
    this.lastResult = result;

    this.recentSkills.push({ skill, progressed: !!progressed });
    this.recentSkills = this.recentSkills.slice(-8);

    if (this.streak >= this.maxStreak) return this.ban(skill);
    // A→B→A→B… のように 2 つのスキルを進展なしに往復するのもループ扱い
    const r = this.recentSkills;
    if (r.length >= 6 && r.slice(-6).every((x) => !x.progressed)) {
      const names = r.slice(-6).map((x) => x.skill);
      if (new Set(names).size === 2 && names[0] === names[2] && names[1] === names[3]) return this.ban(skill);
    }
    return null;
  }

  ban(skill) {
    const prev = this.bans.get(skill);
    const times = (prev?.times ?? 0) + 1;
    const banMs = Math.min(MAX_BAN_MS, BASE_BAN_MS * 2 ** (times - 1));
    this.bans.set(skill, { until: this.now() + banMs, times });
    this.streak = 0;
    this.lastKey = null;
    this.recentSkills = [];
    return { skill, banMs };
  }

  isBanned(skill) {
    const b = this.bans.get(skill);
    if (!b) return false;
    if (b.until <= this.now()) { this.bans.delete(skill); return false; }
    return true;
  }

  bannedSkills() {
    return [...this.bans.keys()].filter((s) => this.isBanned(s));
  }

  // 禁止中のスキルが選ばれたら差し替える。候補（進捗表のおすすめなど）も禁止なら探索に切り替える
  substitute(decision, candidates = []) {
    if (!this.isBanned(decision.skill)) return decision;
    const alt = candidates.find((c) => c && !this.isBanned(c.skill) && c.skill !== decision.skill);
    const picked = alt ?? { skill: 'explore', args: { steps: 2 } };
    return { ...picked, source: 'loopguard', thought: `${decision.skill} はループ中のため一時禁止。代わりに ${picked.skill}` };
  }
}

// 進展の判定に使う、持ち物の要約（種類と数）
export function inventoryKey(bot) {
  try {
    const counts = {};
    for (const it of bot.inventory.items()) counts[it.name] = (counts[it.name] ?? 0) + it.count;
    return JSON.stringify(Object.entries(counts).sort());
  } catch {
    return '';
  }
}
