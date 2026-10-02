// Paper 鯖の設定ファイル（bukkit.yml / spigot.yml / config/paper-world-defaults.yml / config/paper-global.yml）に、
// ボットを何十体も動かすための軽量化の値を書き込む。
// 使い方: node scripts/paper-tune.mjs <鯖のフォルダ> [--dry-run]
//   Paper を一度起動して設定ファイルが生成されたあとに実行する（無いファイルは最小限の内容で新しく作る）。
//   既にある行は値だけ書き換え、無いキーは追記する。コメントや他の設定はそのまま残す。何度実行しても同じ結果になる。
// YAML ライブラリを使わず、字下げを見て行単位で書き換える（Paper が生成する「2 文字字下げ・ブロック形式」の YAML 向け）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 値の決め方: 負荷の限界はエンティティ数（50 体で約 2,660 体、敵は参加人数に比例して湧く）だったので、
// 2026-10-02 に試験鯖で実際に効いた値（50 体で 20 TPS・エンティティ約 410 体）に合わせている。
// 「湧く数」「湧いたものが動く範囲」「落ちた物の寿命」を絞る。ボットの行動に必要な物（近くの敵・動物・自分の掘った物）は残す。
// パスの配列は「どれか存在する方へ書く」（Paper の版でキー名が変わったものの両対応）。{ onlyIfExists: true } は無ければ作らない。
export const TUNING = {
  'bukkit.yml': {
    // 1 人あたりの湧き上限（Paper は per-player-mob-spawns で人数ぶんに配分する）。既定 70/10/5/20/5/5/15
    'spawn-limits.monsters': 30,
    'spawn-limits.animals': 6,
    'spawn-limits.water-animals': 2,
    'spawn-limits.water-ambient': 3,
    'spawn-limits.water-underground-creature': 2,
    'spawn-limits.axolotls': 2,
    'spawn-limits.ambient': 1,
    // 湧き判定の間隔（tick）。既定 1/400/1/1/1/1/1
    'ticks-per.monster-spawns': 2,
    'ticks-per.animal-spawns': 400,
    'ticks-per.water-spawns': 11,
    'ticks-per.water-ambient-spawns': 21,
    'ticks-per.water-underground-creature-spawns': 11,
    'ticks-per.axolotl-spawns': 21,
    'ticks-per.ambient-spawns': 31,
  },
  'spigot.yml': {
    // 湧く範囲（チャンク、既定 8）。処理距離 6 より小さくする
    'world-settings.default.mob-spawn-range': 5,
    // この距離（ブロック）より遠いエンティティは AI を間引く。既定 32/32/48/16/16/32/32
    'world-settings.default.entity-activation-range.animals': 16,
    'world-settings.default.entity-activation-range.monsters': 24,
    'world-settings.default.entity-activation-range.raiders': 32,
    'world-settings.default.entity-activation-range.misc': 8,
    'world-settings.default.entity-activation-range.water': 8,
    'world-settings.default.entity-activation-range.villagers': 16,
    'world-settings.default.entity-activation-range.flying-monsters': 32,
    // クライアント（ボット）に送る範囲（ブロック）。ボットが戦う相手は 32 以内なので 48 で足りる。既定 48/48/48/32/128/64
    'world-settings.default.entity-tracking-range.players': 48,
    'world-settings.default.entity-tracking-range.animals': 48,
    'world-settings.default.entity-tracking-range.monsters': 48,
    'world-settings.default.entity-tracking-range.misc': 32,
    'world-settings.default.entity-tracking-range.display': 32,
    'world-settings.default.entity-tracking-range.other': 32,
    // 落ちた物と経験値をまとめる半径。既定 0.5 / -1
    'world-settings.default.merge-radius.item': 3.5,
    'world-settings.default.merge-radius.exp': 4.0,
    // スポナーの敵は AI なし（ボットはスポナーを使わない）
    'world-settings.default.nerf-spawner-mobs': true,
    // 刺さった矢の寿命（tick）。既定 1200
    'world-settings.default.arrow-despawn-rate': 300,
  },
  'config/paper-world-defaults.yml': {
    'chunks.prevent-moving-into-unloaded-chunks': true,
    'chunks.max-auto-save-chunks-per-tick': 8,
    'collisions.max-entity-collisions': 2,
    'collisions.fix-climbing-bypassing-cramming-rule': true,
    'entities.armor-stands.tick': false,
    'entities.armor-stands.do-collision-entity-lookups': false,
    // 略奪隊は参加人数ぶん出てくるので止める
    'entities.behavior.pillager-patrols.disable': true,
    'entities.spawning.per-player-mob-spawns': true,
    // 人から 64 ブロック以上離れた敵は必ず消す（既定 128。soft の 32 はそのまま）。1.21 系で despawn-ranges → despawn-range に変わったので両対応
    ...despawn('monster', 64),
    // ボットが掘って放置する石や土は 30 秒（600 tick）で消す（既定は 5 分）。鉄・ダイヤなどは触らない
    'entities.spawning.alt-item-despawn-rate.enabled': true,
    ...Object.fromEntries(['cobblestone', 'cobbled_deepslate', 'netherrack', 'dirt', 'gravel', 'sand', 'andesite', 'diorite', 'granite', 'tuff', 'rotten_flesh', 'kelp', 'seagrass', 'bamboo']
      .map((item) => [`entities.spawning.alt-item-despawn-rate.items.${item}`, 600])),
    // スケルトンの矢は 15 秒で消す（既定はバニラの 1 分）
    'entities.spawning.non-player-arrow-despawn-rate': 300,
    'entities.spawning.creative-arrow-despawn-rate': 300,
    'environment.optimize-explosions': true,
    'hopper.ignore-occluding-blocks': true,
    'hopper.cooldown-when-full': true,
    'misc.redstone-implementation': 'ALTERNATE_CURRENT',
    'tick-rates.grass-spread': 4,
    'tick-rates.mob-spawner': 2,
    'tick-rates.sensor.villager.secondarypoisensor': 80,
    'tick-rates.sensor.villager.nearestbedsensor': 160,
    'tick-rates.sensor.villager.villagerbabiesensor': 80,
    'tick-rates.sensor.villager.playersensor': 80,
    'tick-rates.sensor.villager.nearestlivingentitysensor': 80,
    'tick-rates.behavior.villager.validatenearbypoi': 120,
    'tick-rates.behavior.villager.acquirepoi': 120,
  },
  'config/paper-global.yml': {
    // timings は計測そのものが負荷になる（新しい Paper には無いので、ある時だけ）
    'timings.enabled': { value: false, onlyIfExists: true },
  },
};

function despawn(category, hard, soft) {
  const out = { [`entities.spawning.despawn-range.${category}.hard|entities.spawning.despawn-ranges.${category}.hard`]: hard };
  if (soft !== undefined) out[`entities.spawning.despawn-range.${category}.soft|entities.spawning.despawn-ranges.${category}.soft`] = soft;
  return out;
}

// ---- 行単位の YAML 書き換え ----
const KEY_RE = /^(\s*)([^\s#][^:]*?):(?:\s+(.*?))?\s*$/; // 「  key: value」「  key:」

function formatValue(v) {
  if (typeof v !== 'string') return String(v);
  // 数・真偽・null に読めてしまう文字列と、記号を含む文字列だけ引用符で囲む（10s や ALTERNATE_CURRENT はそのまま）
  const looksSpecial = /^(true|false|null|yes|no|on|off|~)$/i.test(v) || /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(v) || !/^[A-Za-z0-9_./+-]+$/.test(v);
  return looksSpecial ? JSON.stringify(v) : v;
}

// 親ブロック内で、字下げ depth のキー key がある行番号を返す（無ければ -1）
function findKey(lines, start, end, depth, key) {
  for (let i = start; i < end; i++) {
    const m = KEY_RE.exec(lines[i]);
    if (!m || m[1].length !== depth) continue;
    if (unquote(m[2]) === key) return i;
  }
  return -1;
}

function unquote(k) {
  const t = k.trim();
  return /^(['"]).*\1$/.test(t) ? t.slice(1, -1) : t;
}

// 行 i のキーに属するブロックの終わり（その行の字下げ以下の、空行・コメント以外の行が現れる手前）
function blockEnd(lines, i, depth) {
  let end = i + 1;
  let last = i + 1;
  while (end < lines.length) {
    const line = lines[end];
    const blank = line.trim() === '';
    const comment = line.trim().startsWith('#');
    const ind = line.length - line.trimStart().length;
    if (!blank && !comment && ind <= depth) break;
    if (!blank && ind > depth) last = end + 1;
    end++;
  }
  return last; // 末尾の空行・親の高さのコメントは含めない
}

// path（a.b.c）に value を書く。lines を書き換えて、変えたかどうかを返す
function setPath(lines, segments, value, indentWidth, { createMissing = true } = {}) {
  let start = 0; let end = lines.length; let depth = 0;
  for (let s = 0; s < segments.length; s++) {
    const key = segments[s];
    const i = findKey(lines, start, end, depth, key);
    const last = s === segments.length - 1;
    if (i >= 0) {
      if (last) {
        const m = KEY_RE.exec(lines[i]);
        const current = (m[3] ?? '').trim();
        const next = formatValue(value);
        if (current === next) return false;
        // 値の行なら差し替える。ブロック（値なし）だったら、そのブロックごと 1 行の値に置き換える
        const bEnd = current === '' ? blockEnd(lines, i, depth) : i + 1;
        lines.splice(i, bEnd - i, `${' '.repeat(depth)}${key}: ${next}`);
        return true;
      }
      const m = KEY_RE.exec(lines[i]);
      if ((m[3] ?? '').trim() !== '' && !/^\{\s*\}$/.test((m[3] ?? '').trim())) {
        // 途中のキーがスカラー値なら、ブロックにしてから続ける
        lines[i] = `${' '.repeat(depth)}${key}:`;
      } else if (/^\{\s*\}$/.test((m[3] ?? '').trim())) {
        lines[i] = `${' '.repeat(depth)}${key}:`;
      }
      start = i + 1; end = blockEnd(lines, i, depth); depth += indentWidth;
      continue;
    }
    if (!createMissing) return false;
    // 無いキーは親ブロックの末尾に、残りのパスをまとめて追記する
    const rest = segments.slice(s);
    const add = rest.map((k, j) => `${' '.repeat(depth + j * indentWidth)}${k}:${j === rest.length - 1 ? ` ${formatValue(value)}` : ''}`);
    lines.splice(end, 0, ...add);
    return true;
  }
  return false;
}

// パスの先頭から何段まで存在するか（全部あれば segments.length）
function existingDepth(lines, segments, indentWidth) {
  let start = 0; let end = lines.length; let depth = 0; let n = 0;
  for (const key of segments) {
    const i = findKey(lines, start, end, depth, key);
    if (i < 0) break;
    n++;
    start = i + 1; end = blockEnd(lines, i, depth); depth += indentWidth;
  }
  return n;
}

function detectIndent(lines) {
  for (const line of lines) {
    const ind = line.length - line.trimStart().length;
    if (ind > 0 && line.trim() !== '' && !line.trim().startsWith('#')) return ind;
  }
  return 2;
}

// text に overrides を当てた新しい文章と、変えたキーの一覧を返す
export function patchYaml(text, overrides) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const indentWidth = detectIndent(lines);
  const changed = [];
  for (const [spec, raw] of Object.entries(overrides)) {
    const opt = raw && typeof raw === 'object' ? raw : { value: raw };
    const candidates = spec.split('|').map((p) => p.split('.'));
    // 「どこまで存在するか」が一番深い候補に書く（同じなら先に書いた方）。全部あるものが無く onlyIfExists なら飛ばす
    const depths = candidates.map((segs) => existingDepth(lines, segs, indentWidth));
    const best = depths.indexOf(Math.max(...depths));
    const target = candidates[best];
    if (depths[best] < target.length && opt.onlyIfExists) continue;
    if (setPath(lines, target, opt.value, indentWidth)) changed.push(target.join('.'));
  }
  return { text: lines.join(eol) + eol, changed };
}

export function tuneServer(dir, { dryRun = false, tuning = TUNING, log = console.log } = {}) {
  const summary = [];
  for (const [rel, overrides] of Object.entries(tuning)) {
    const file = path.join(dir, rel);
    const exists = fs.existsSync(file);
    const before = exists ? fs.readFileSync(file, 'utf8') : '';
    const { text, changed } = patchYaml(before, overrides);
    if (!exists) log(`${rel}: 無いので新しく作る（Paper を起動すると残りの既定値が足される）`);
    if (changed.length) {
      log(`${rel}: ${changed.length} 件${dryRun ? '（dry-run: 書き込まない）' : ''}`);
      for (const c of changed) log(`  ${c}`);
      if (!dryRun) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, text);
      }
    } else log(`${rel}: 変更なし`);
    summary.push({ file: rel, changed });
  }
  return summary;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const dir = args.find((a) => !a.startsWith('--'));
  if (!dir) { console.error('使い方: node scripts/paper-tune.mjs <鯖のフォルダ> [--dry-run]'); process.exit(2); }
  tuneServer(dir, { dryRun });
}
