import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { patchYaml, tuneServer, TUNING } from '../scripts/paper-tune.mjs';

const BUKKIT = `# This is the main configuration file for Bukkit.
# As you can see, there's tons to configure.

settings:
  allow-end: true
  warn-on-overload: true
spawn-limits:
  monsters: 70
  animals: 10
  water-animals: 5
  water-ambient: 20
  water-underground-creature: 5
  axolotls: 5
  ambient: 15
chunk-gc:
  period-in-ticks: 600
ticks-per:
  animal-spawns: 400
  monster-spawns: 1
  water-spawns: 1
  water-ambient-spawns: 1
  water-underground-creature-spawns: 1
  axolotl-spawns: 1
  ambient-spawns: 1
  autosave: 6000
aliases: now-in-commands.yml
`;

const SPIGOT = `# This is the main configuration file for Spigot.
settings:
  debug: false
  timeout-time: 60
  attribute:
    maxHealth:
      max: 1024.0
world-settings:
  default:
    view-distance: default
    mob-spawn-range: 8
    arrow-despawn-rate: 1200
    nerf-spawner-mobs: false
    merge-radius:
      exp: -1
      item: 0.5
    entity-activation-range:
      animals: 32
      monsters: 32
      raiders: 48
      misc: 16
      water: 16
      villagers: 32
      flying-monsters: 32
      wake-up-inactive:
        animals-max-per-tick: 4
      ignore-spectators: false
    entity-tracking-range:
      players: 128
      animals: 96
      monsters: 96
      misc: 96
      display: 128
      other: 64
    verbose: false
config-version: 12
`;

const WORLD = `# This is the main configuration file for Paper.
# These are the default world settings.

_version: 31
chunks:
  auto-save-interval: default
  delay-chunk-unloads-by: 10s
  entity-per-chunk-save-limit:
    arrow: -1
    ender_pearl: -1
  max-auto-save-chunks-per-tick: 24
  prevent-moving-into-unloaded-chunks: false
collisions:
  allow-player-cramming-damage: false
  fix-climbing-bypassing-cramming-rule: false
  max-entity-collisions: 8
entities:
  armor-stands:
    do-collision-entity-lookups: true
    tick: true
  behavior:
    allow-spider-world-border-climbing: true
    pillager-patrols:
      disable: false
      spawn-chance: 0.2
      spawn-delay:
        per-player: false
        ticks: 12000
    zombies-target-turtle-eggs: true
  spawning:
    all-chunks-are-slime-chunks: false
    alt-item-despawn-rate:
      enabled: false
      items:
        cobblestone: 300
    creative-arrow-despawn-rate: default
    despawn-range:
      ambient:
        hard: default
        soft: default
      monster:
        hard: default
        soft: default
    non-player-arrow-despawn-rate: default
    per-player-mob-spawns: true
environment:
  optimize-explosions: false
hopper:
  cooldown-when-full: true
  disable-move-event: false
  ignore-occluding-blocks: false
misc:
  redstone-implementation: VANILLA
tick-rates:
  behavior:
    villager:
      validatenearbypoi: -1
      acquirepoi: -1
  container-update: 1
  grass-spread: 1
  mob-spawner: 1
  sensor:
    villager:
      secondarypoisensor: 40
      nearestbedsensor: 80
`;

const lineOf = (text, re) => text.split('\n').find((l) => re.test(l));

test('bukkit.yml: ある値は書き換え、コメントと他の設定はそのまま', () => {
  const { text, changed } = patchYaml(BUKKIT, TUNING['bukkit.yml']);
  assert.equal(lineOf(text, /^  monsters:/), '  monsters: 30');
  assert.equal(lineOf(text, /^  monster-spawns:/), '  monster-spawns: 2');
  assert.equal(lineOf(text, /^  animal-spawns:/), '  animal-spawns: 400', '同じ値は触らない');
  assert.ok(text.startsWith('# This is the main configuration file for Bukkit.'));
  assert.ok(text.includes('aliases: now-in-commands.yml'));
  assert.ok(text.includes('  autosave: 6000'));
  assert.ok(!changed.includes('ticks-per.animal-spawns'));
  assert.ok(changed.includes('spawn-limits.monsters'));
});

test('spigot.yml: 3 段の深さの値も書き換え、同じ名前の別ブロック（settings.timeout-time 等）は触らない', () => {
  const { text } = patchYaml(SPIGOT, TUNING['spigot.yml']);
  assert.equal(lineOf(text, /^    mob-spawn-range:/), '    mob-spawn-range: 5');
  assert.equal(lineOf(text, /^      monsters:/), '      monsters: 24', 'entity-activation-range.monsters');
  assert.equal(lineOf(text, /^      players:/), '      players: 48');
  assert.equal(lineOf(text, /^      item:/), '      item: 3.5');
  assert.equal(lineOf(text, /^      exp:/), '      exp: 4');
  assert.equal(lineOf(text, /^    nerf-spawner-mobs:/), '    nerf-spawner-mobs: true');
  assert.ok(text.includes('  timeout-time: 60'));
  assert.ok(text.includes('        animals-max-per-tick: 4'), '深いブロックは残る');
  assert.ok(text.endsWith('config-version: 12\n'));
});

test('paper-world-defaults.yml: despawn-range（新）の monster.hard だけ書き、soft は触らず、無いアイテムは追記、文字列はそのまま', () => {
  const { text } = patchYaml(WORLD, TUNING['config/paper-world-defaults.yml']);
  const lines = text.split('\n');
  const i = lines.indexOf('      monster:');
  assert.ok(i > 0);
  assert.equal(lines[i + 1], '        hard: 64');
  assert.equal(lines[i + 2], '        soft: default', 'soft はそのまま');
  assert.ok(!text.includes('despawn-ranges:'), '古い名前のブロックは作らない');
  assert.ok(!text.includes('      creature:'), '書かないカテゴリは作らない');
  const a = lines.indexOf('      ambient:');
  assert.equal(lines[a + 1], '        hard: default', 'ambient は触らない');
  // 無いカテゴリを足すときは despawn-range ブロックの中に入る
  const { text: t2 } = patchYaml(WORLD, { 'entities.spawning.despawn-range.creature.hard|entities.spawning.despawn-ranges.creature.hard': 48 });
  const l2 = t2.split('\n');
  const c = l2.indexOf('      creature:');
  assert.ok(c > l2.indexOf('    despawn-range:') && c < l2.indexOf('    non-player-arrow-despawn-rate: default'), 'despawn-range ブロックの中に入っている');
  assert.equal(l2[c + 1], '        hard: 48');
  assert.ok(text.includes('        cobblestone: 600'));
  assert.ok(text.includes('        netherrack: 600'));
  assert.equal(lineOf(text, /^      enabled:/), '      enabled: true');
  assert.equal(lineOf(text, /^  redstone-implementation:/), '  redstone-implementation: ALTERNATE_CURRENT');
  assert.equal(lineOf(text, /^      disable:/), '      disable: true');
  assert.equal(lineOf(text, /^    tick:/), '    tick: false');
  assert.ok(text.includes('  delay-chunk-unloads-by: 10s'));
  assert.ok(text.includes('_version: 31'));
  assert.ok(text.includes('      villagerbabiesensor: 80'), '無いセンサーは追記');
  assert.ok(text.includes('      validatenearbypoi: 120'));
});

test('古い Paper（despawn-ranges）にはそちらへ書く', () => {
  const old = WORLD.replace('despawn-range:', 'despawn-ranges:');
  const { text } = patchYaml(old, TUNING['config/paper-world-defaults.yml']);
  assert.ok(text.includes('    despawn-ranges:'));
  assert.ok(!text.includes('    despawn-range:\n'), '新しい名前のブロックは作らない');
  const lines = text.split('\n');
  const i = lines.indexOf('      monster:');
  assert.equal(lines[i + 1], '        hard: 64');
});

test('onlyIfExists のキーは無ければ作らない。2 回目は何も変わらない（冪等）', () => {
  const global = `_version: 29\nchunk-system:\n  io-threads: -1\nmisc:\n  use-dimension-type-for-custom-spawners: false\n`;
  const r1 = patchYaml(global, TUNING['config/paper-global.yml']);
  assert.equal(r1.text, global);
  assert.deepEqual(r1.changed, []);
  const withTimings = `_version: 29\ntimings:\n  enabled: true\n  verbose: true\n`;
  const r2 = patchYaml(withTimings, TUNING['config/paper-global.yml']);
  assert.ok(r2.text.includes('  enabled: false'));
  assert.ok(r2.text.includes('  verbose: true'));
  for (const [file, src] of [['bukkit.yml', BUKKIT], ['spigot.yml', SPIGOT], ['config/paper-world-defaults.yml', WORLD]]) {
    const once = patchYaml(src, TUNING[file]);
    const twice = patchYaml(once.text, TUNING[file]);
    assert.equal(twice.text, once.text, `${file} は 2 回目で変わらない`);
    assert.deepEqual(twice.changed, []);
  }
});

test('空のファイル・途中が無いファイルには入れ子ごと作る。文字列の引用', () => {
  const { text } = patchYaml('', { 'a.b.c': 1, 'a.b.d': 'x y', 'a.e': '10s', 'f': 'true' });
  assert.equal(text, 'a:\n  b:\n    c: 1\n    d: "x y"\n  e: 10s\nf: "true"\n');
  const { text: t2 } = patchYaml('a:\n  b: 5\n', { 'a.b.c': 1 });
  assert.equal(t2, 'a:\n  b:\n    c: 1\n', 'スカラーだったキーはブロックにする');
  const { text: t3 } = patchYaml('a:\r\n  b: 5\r\n', { 'a.b': 6 });
  assert.equal(t3, 'a:\r\n  b: 6\r\n', 'CRLF はそのまま');
});

test('tuneServer: フォルダの 4 ファイルを書き換え、dry-run では書かない', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-'));
  fs.writeFileSync(path.join(dir, 'bukkit.yml'), BUKKIT);
  fs.writeFileSync(path.join(dir, 'spigot.yml'), SPIGOT);
  fs.mkdirSync(path.join(dir, 'config'));
  fs.writeFileSync(path.join(dir, 'config', 'paper-world-defaults.yml'), WORLD);
  const logs = [];
  tuneServer(dir, { dryRun: true, log: (l) => logs.push(l) });
  assert.equal(fs.readFileSync(path.join(dir, 'bukkit.yml'), 'utf8'), BUKKIT);
  assert.ok(!fs.existsSync(path.join(dir, 'config', 'paper-global.yml')));
  const summary = tuneServer(dir, { log: () => {} });
  assert.ok(fs.readFileSync(path.join(dir, 'bukkit.yml'), 'utf8').includes('  monsters: 30'));
  assert.ok(fs.readFileSync(path.join(dir, 'spigot.yml'), 'utf8').includes('    mob-spawn-range: 5'));
  assert.ok(fs.readFileSync(path.join(dir, 'config', 'paper-world-defaults.yml'), 'utf8').includes('        hard: 64'));
  assert.ok(!fs.existsSync(path.join(dir, 'config', 'paper-global.yml')), 'onlyIfExists だけのファイルは作らない');
  assert.deepEqual(tuneServer(dir, { log: () => {} }).map((s) => s.changed.length), [0, 0, 0, 0]);
  assert.equal(summary.length, 4);
});
