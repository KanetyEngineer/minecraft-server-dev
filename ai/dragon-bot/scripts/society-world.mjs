// 社会実験の「町の管理役」: 戸籍（年齢・寿命・夫婦・親子）を持ち、住人のプロセスを生まれた人の分だけ動かす。
// - 住人ごとに node src/society.js を起動し、落ちたら 10 秒後に起動し直す（亡くなった人は起動しない）
// - プロポーズ・子どもの申し出（society/town/requests/）を確かめて、結婚・出産を戸籍に反映する
// - 寿命に達した人を老衰で亡くなったことにし、プロセスを止め、家を子に継がせる
// 使い方: node scripts/society-world.mjs（scripts/start-society.sh が起動する）
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readWorld, writeWorld, initialWorld, takeRequests, canMarry, canHaveChild, makeChild, ageOf, YEAR_MS } from '../src/society/population.js';
import { personaByName } from '../src/society/personas.js';
import crypto from 'node:crypto';
import { rconSend, serverDir } from '../src/society/rcon.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
const TOWN = 'society/town';
fs.mkdirSync(TOWN, { recursive: true });
let world = readWorld(TOWN) ?? initialWorld();
writeWorld(TOWN, world);
const procs = new Map(); // 名前 → 子プロセス
let stopping = false;

const now = () => Date.now();
const callOf = (name) => personaByName(name)?.call ?? name;
function event(kind, text, extra = {}) {
  fs.appendFileSync(path.join(TOWN, 'events.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), by: 'world', kind, text, ...extra })}\n`);
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${text}`);
}
async function announce(text) {
  try { await rconSend([`say ${text}`]); } catch {}
}
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
// その人から見た相手への好感度（その人の記憶ファイルから）
const affinity = (from, to) => readJson(path.join('society', 'data', from, 'memory.json'))?.social?.relations?.[to]?.affinity ?? 0;

// ---------- 住人のプロセス ----------
function statusPort(id) { return id <= 10 ? 3200 + id : 3500 + id; }

function start(person) {
  if (procs.has(person.name) || stopping) return;
  const log = fs.openSync(path.join('society', `run-${person.name}.log`), 'a');
  fs.writeSync(log, `=== start ${new Date().toISOString()} (world) ===\n`);
  const env = { ...process.env, PERSONA_NAME: person.name, MC_PORT: process.env.MC_PORT_SOCIETY || '25573',
    DATA_DIR: `society/data/${person.name}`, LOG_DIR: `society/logs/${person.name}`, SOCIETY_DIR: TOWN,
    STATUS_PORT: String(statusPort(person.id)), DISCORD_LEVEL: 'important' };
  const p = spawn(process.execPath, ['--max-old-space-size=1024', '--env-file=.env', 'src/society.js'], { env, stdio: ['ignore', log, log], windowsHide: true });
  procs.set(person.name, p);
  p.on('exit', () => {
    procs.delete(person.name);
    try { fs.closeSync(log); } catch {}
    const me = world.people[person.name];
    if (!stopping && me?.alive) setTimeout(() => start(me), 10_000);
  });
}

function stop(name) {
  const p = procs.get(name);
  if (!p) return;
  procs.delete(name);
  try { p.kill(); } catch {}
}

// ---------- 申し出 ----------
async function handleRequests() {
  for (const r of takeRequests(TOWN)) {
    const a = world.people[r.from];
    if (r.kind === 'propose') {
      const b = world.people[r.to];
      if (!canMarry(a, b)) { event('propose-invalid', `${callOf(r.from)}のプロポーズは成立しない条件だった`, { from: r.from, to: r.to }); continue; }
      // 返事は、相手から見た好感度で決まる（40 以上なら受ける。高いほど確実）
      const aff = affinity(r.to, r.from);
      const yes = aff >= 40 && Math.random() < 0.5 + aff / 200;
      fs.appendFileSync(path.join(TOWN, 'answers.jsonl'), `${JSON.stringify({ at: now(), kind: 'propose', from: r.from, to: r.to, yes, aff })}\n`);
      if (!yes) { event('propose-declined', `${callOf(r.to)}は${callOf(r.from)}のプロポーズを断った（好感度 ${aff}）`, { from: r.from, to: r.to }); continue; }
      a.spouse = b.name; b.spouse = a.name;
      world.marriages.push({ at: now(), a: a.name, b: b.name });
      event('marriage', `💍 ${callOf(a.name)}と${callOf(b.name)}が結婚した`, { a: a.name, b: b.name });
      await announce(`💍 ${callOf(a.name)}と${callOf(b.name)}が結婚しました！`);
    } else if (r.kind === 'birth') {
      if (!canHaveChild(world, a)) { event('birth-invalid', `${callOf(r.from)}の子どもはまだ生まれる条件にない`, { from: r.from }); continue; }
      const b = world.people[a.spouse];
      const [mother, father] = a.sex === 'F' ? [a, b] : [b, a];
      const child = makeChild(world, mother, father);
      world.people[child.name] = child;
      await whitelist([child.name]);
      for (const p of [mother, father]) { p.children.push(child.name); p.lastBirthAt = now(); }
      world.births.push({ at: now(), child: child.name, mother: mother.name, father: father.name });
      event('birth', `👶 ${callOf(mother.name)}と${callOf(father.name)}に子どもの${child.persona.call}（${child.persona.mbti}・第 ${child.generation} 世代）が生まれた`,
        { child: child.name, mother: mother.name, father: father.name });
      await announce(`👶 ${callOf(mother.name)}と${callOf(father.name)}に${child.persona.call}が生まれました！`);
    }
  }
}

// ---------- 老衰 ----------
async function handleAging() {
  for (const p of Object.values(world.people)) {
    if (!p.alive || ageOf(p) < p.lifespan) continue;
    p.alive = false;
    p.diedAt = now();
    world.deaths.push({ at: now(), name: p.name, age: ageOf(p) });
    stop(p.name);
    // 配偶者はひとり身に戻る（再婚できる）
    if (p.spouse && world.people[p.spouse]) { world.people[p.spouse].spouse = null; world.people[p.spouse].widowOf = p.name; }
    // 家は、生きている子のうちいちばん年上が継ぐ
    const house = readJson(path.join(TOWN, `${p.name}.json`))?.house;
    const heir = p.children.map((c) => world.people[c]).filter((c) => c?.alive).sort((x, y) => x.born - y.born)[0];
    if (heir && house?.stage === 'done') heir.inheritHouse = { ...house, from: p.name };
    event('old-age', `🕯 ${callOf(p.name)}が老衰で亡くなった（享年 ${ageOf(p)}）${heir && house ? `。家は${callOf(heir.name)}が継ぐ` : ''}`, { name: p.name, heir: heir?.name ?? null });
    await announce(`🕯 ${callOf(p.name)}が老衰で亡くなりました（享年 ${ageOf(p)}）`);
  }
}

async function tick() {
  try {
    const fresh = readWorld(TOWN);
    if (fresh) world = fresh;
    await handleRequests();
    await handleAging();
    world.updatedAt = now();
    writeWorld(TOWN, world);
    for (const p of Object.values(world.people)) if (p.alive) start(p);
  } catch (e) {
    console.error(`管理役のエラー: ${e.stack ?? e.message}`);
  }
}

// ホワイトリスト: 鯖が white-list=true のときに備え、戸籍の生きている人と観察者を登録する（生まれた子も登録する）
// オフラインの鯖では `whitelist add` が名前を小文字にして別の UUID で登録してしまい、生まれた子が入れなかった。
// whitelist.json に正しい大文字小文字の名前とオフライン UUID（"OfflinePlayer:" + 名前の MD5、版 3）を書いてから読み直させる
function offlineUuid(name) {
  const h = crypto.createHash('md5').update(`OfflinePlayer:${name}`).digest();
  h[6] = (h[6] & 0x0f) | 0x30;
  h[8] = (h[8] & 0x3f) | 0x80;
  const x = h.toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}
async function whitelist(names) {
  try {
    const file = path.join(serverDir(), 'whitelist.json');
    const list = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
    const keep = list.filter((e) => !names.some((n) => n.toLowerCase() === String(e.name).toLowerCase() && n !== e.name));
    for (const n of names) if (!keep.some((e) => e.name === n)) keep.push({ uuid: offlineUuid(n), name: n });
    fs.writeFileSync(file, JSON.stringify(keep, null, 2));
    await rconSend(['whitelist reload']);
  } catch {}
}
whitelist([...Object.values(world.people).filter((p) => p.alive).map((p) => p.name), ...(process.env.SOCIETY_OBSERVERS || 'kanetyyy').split(',')]);
console.log(`町の管理役を開始（1 年 = ${YEAR_MS / 60_000} 分、住人 ${Object.values(world.people).filter((p) => p.alive).length} 人）`);
// 起動は 3 秒ずつずらす（一度に入ると鯖が混む）
let delay = 0;
for (const p of Object.values(world.people)) if (p.alive) { setTimeout(() => start(p), delay); delay += 3000; }
setTimeout(() => setInterval(tick, 10_000), delay);

// 録画の見張り（1 分ごと）: ServerReplay が町を録画していなければ（鯖の再起動などで止まったら）録画を始め直す。
// 録画の範囲は広場のまわり半径 8 チャンク（128 マス）。SOCIETY_RECORD=0 で見張らない
async function watchRecording() {
  try {
    const [st] = await rconSend(['replay status']);
    if (/Currently Recording Chunks/.test(st ?? '') && !/Not Currently Recording Chunks/.test(st ?? '')) return;
    // 録画の中心は広場（住人の公開情報の plaza。まだ無ければ録画しない）
    const plaza = fs.readdirSync(TOWN).filter((f) => f.endsWith('.json') && f !== 'world.json').map((f) => readJson(path.join(TOWN, f))?.plaza).find(Boolean);
    if (!plaza) return;
    const [r] = await rconSend([`replay start chunks around ${Math.floor(plaza.x / 16)} ${Math.floor(plaza.z / 16)} radius 8`]);
    event('record', `録画が止まっていたので始め直した（${String(r ?? '').slice(0, 60)}）`);
  } catch (e) {
    console.error(`録画の確認に失敗: ${e.message}`);
  }
}
if (process.env.SOCIETY_RECORD !== '0') { setTimeout(watchRecording, 20_000); setInterval(watchRecording, 60_000); }
const shutdown = () => { stopping = true; for (const n of [...procs.keys()]) stop(n); setTimeout(() => process.exit(0), 1000); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
