// 人口: 年齢・寿命・結婚・出産・老衰。
// 町の「戸籍」は society/town/world.json。書くのは管理役（scripts/society-world.mjs）だけで、住人は読むだけ。
// 住人からの申し出（プロポーズ・子どもがほしい）は society/town/requests/ にファイルで出し、管理役が確かめて戸籍に反映する。
//
// 時間: 1 年 = SOCIETY_YEAR_MIN 分（既定 10 分。Minecraft の 1 日は 20 分）。
// 子ども（0〜11 歳）は親の家で暮らし、12〜17 歳は手伝い、18 歳で大人になって自分の家を建て、結婚できる。
// 60 歳から老人。寿命（65〜85 歳）で老衰で亡くなり、家は子が継ぐ。
import fs from 'node:fs';
import path from 'node:path';
import { PERSONAS, registerPersonas, personaByName, traitsOf } from './personas.js';

export const YEAR_MS = (Number(process.env.SOCIETY_YEAR_MIN) || 10) * 60_000;
export const ADULT_AGE = 18;
export const ELDER_AGE = 60;
export const MARRY_MIN_AGE = 18;
export const BIRTH_AGES = [20, 45]; // 子どもを持てる年齢（両親とも）
export const BIRTH_COOLDOWN_YEARS = 3;
export const MAX_CHILDREN = 4;
export const MAX_POPULATION = Number(process.env.SOCIETY_MAX_POP) || 24;

export function worldFile(dir) { return path.join(dir, 'world.json'); }
export function requestDir(dir) { return path.join(dir, 'requests'); }

export function readWorld(dir) {
  try {
    const w = JSON.parse(fs.readFileSync(worldFile(dir), 'utf8'));
    registerPersonas(Object.values(w.people ?? {}).map((p) => p.persona).filter(Boolean));
    return w;
  } catch {
    return null;
  }
}

export function writeWorld(dir, w) {
  fs.mkdirSync(dir, { recursive: true });
  const f = worldFile(dir);
  fs.writeFileSync(`${f}.tmp`, JSON.stringify(w, null, 1));
  fs.renameSync(`${f}.tmp`, f);
}

export function ageOf(person, now = Date.now()) {
  return Math.max(0, Math.floor((now - person.born) / YEAR_MS));
}

export function lifeStage(age) {
  if (age < 12) return 'child';
  if (age < ADULT_AGE) return 'teen';
  if (age < ELDER_AGE) return 'adult';
  return 'elder';
}
export const STAGE_LABEL = { child: '子ども', teen: '若者', adult: '大人', elder: '老人' };

const rand = (a, b) => a + Math.random() * (b - a);

// 最初の 10 人を戸籍に載せる（18〜30 歳、寿命 65〜85 歳）
export function initialWorld(now = Date.now()) {
  const people = {};
  for (const p of PERSONAS) {
    const age = Math.round(rand(18, 30));
    people[p.name] = { name: p.name, id: p.id, sex: p.sex, generation: 1, born: now - age * YEAR_MS, lifespan: Math.round(rand(65, 85)),
      alive: true, spouse: null, children: [], parents: [], lastBirthAt: 0 };
  }
  return { startedAt: now, yearMs: YEAR_MS, nextId: PERSONAS.length + 1, people, marriages: [], births: [], deaths: [] };
}

// ---------- 子どもの性格・名前 ----------

const NAMES = {
  M: [['Sora', 'ソラ'], ['Haru', 'ハル'], ['Ren', 'レン'], ['Riku', 'リク'], ['Yuto', 'ユウト'], ['Sota', 'ソウタ'], ['Kai', 'カイ'], ['Taiga', 'タイガ'],
    ['Minato', 'ミナト'], ['Itsuki', 'イツキ'], ['Asahi', 'アサヒ'], ['Hayato', 'ハヤト'], ['Shun', 'シュン'], ['Ryo', 'リョウ'], ['Akira', 'アキラ']],
  F: [['Aoi', 'アオイ'], ['Hana', 'ハナ'], ['Mei', 'メイ'], ['Sakura', 'サクラ'], ['Yui', 'ユイ'], ['Rio', 'リオ'], ['Akari', 'アカリ'], ['Kaede', 'カエデ'],
    ['Tsumugi', 'ツムギ'], ['Koharu', 'コハル'], ['Emi', 'エミ'], ['Nozomi', 'ノゾミ'], ['Saki', 'サキ'], ['Mana', 'マナ'], ['Ruka', 'ルカ']],
};

// 性格の型ごとの肩書き・ひとこと紹介（16 タイプ）
const TYPES = {
  INTJ: ['建築家', '先を読んで計画を立てるのが好き。'], INTP: ['論理学者', '仕組みを考えるのが好きで、ひとりで工夫を重ねる。'],
  ENTJ: ['指揮官', '人をまとめて大きな目標に向かわせる。'], ENTP: ['発明家', '新しいことを試すのが大好きな議論好き。'],
  INFJ: ['提唱者', '静かだが、みんなが仲良く暮らせることを願っている。'], INFP: ['仲介者', '空想好きで優しく、争いが苦手。'],
  ENFJ: ['主人公', '面倒見がよく、人を励まして引っ張る。'], ENFP: ['広報担当', '明るく人懐っこく、友だちを増やす。'],
  ISTJ: ['管理者', '真面目で几帳面、約束は必ず守る。'], ISFJ: ['擁護者', '控えめで献身的、家族を守る。'],
  ESTJ: ['幹部', '決まりを作って物事を進める仕切り屋。'], ESFJ: ['世話役', 'みんなの食事や体調を気にかける。'],
  ISTP: ['職人', '手を動かすのが好きな一匹狼。'], ISFP: ['冒険家', '自然と美しい物が好きな自由人。'],
  ESTP: ['起業家', '行動が早く、勝負ごとが好き。'], ESFP: ['エンターテイナー', '今を楽しみ、場を盛り上げる。'],
};

function styleFor(mbti, sex) {
  const t = traitsOf(mbti);
  const first = sex === 'M' ? (t.agreeableness > 0.5 ? 'ぼく' : '俺') : (t.extraversion > 0.5 ? 'あたし' : 'わたし');
  const end = t.extraversion > 0.5 ? '！' : (t.agreeableness > 0.5 ? '…' : '。');
  return { end, first, laugh: t.extraversion > 0.5 ? 'あはは' : 'ふふ', polite: t.conscientiousness > 0.5 && t.extraversion < 0.5 };
}

// 両親の MBTI から子どもの MBTI を決める（1 文字ずつ父か母から受け継ぎ、1 割の確率で逆になる）
export function childMbti(a, b) {
  let out = '';
  const pairs = ['EI', 'NS', 'FT', 'JP'];
  for (let i = 0; i < 4; i++) {
    let c = Math.random() < 0.5 ? a[i] : b[i];
    if (Math.random() < 0.1) c = pairs[i].replace(c, '');
    out += c;
  }
  return out;
}

export function makeChild(world, mother, father) {
  const pa = personaByName(mother.name); const pb = personaByName(father.name);
  const mbti = childMbti(pa.mbti, pb.mbti);
  const sex = Math.random() < 0.5 ? 'M' : 'F';
  const used = new Set(Object.keys(world.people).map((n) => n.toLowerCase()));
  const pool = NAMES[sex].filter(([r]) => ![...used].some((u) => u.startsWith(`${r.toLowerCase()}_`)));
  const [romaji, call] = (pool.length ? pool : NAMES[sex])[Math.floor(Math.random() * (pool.length || NAMES[sex].length))];
  let name = `${romaji}_${mbti}`.slice(0, 16);
  for (let k = 2; used.has(name.toLowerCase()); k++) name = `${romaji.slice(0, 9)}${k}_${mbti}`.slice(0, 16);
  const [title, bio] = TYPES[mbti] ?? ['住人', ''];
  const id = world.nextId++;
  const generation = Math.max(mother.generation ?? 1, father.generation ?? 1) + 1;
  const persona = { id, name, call, mbti, sex, generation, title,
    bio: `${pa.call}と${pb.call}の子で、第 ${generation} 世代。${bio}`, style: styleFor(mbti, sex) };
  const person = { name, id, sex, generation, born: Date.now(), lifespan: Math.round(rand(65, 85)), alive: true,
    spouse: null, children: [], parents: [mother.name, father.name], lastBirthAt: 0, persona };
  return person;
}

// ---------- 住人から管理役への申し出 ----------

export function request(dir, kind, body) {
  const d = requestDir(dir);
  fs.mkdirSync(d, { recursive: true });
  const f = path.join(d, `${Date.now()}-${kind}-${body.from}.json`);
  fs.writeFileSync(f, JSON.stringify({ kind, at: Date.now(), ...body }));
}

export function takeRequests(dir) {
  const d = requestDir(dir);
  let files = [];
  try { files = fs.readdirSync(d).filter((f) => f.endsWith('.json')).sort(); } catch { return []; }
  const out = [];
  for (const f of files) {
    try { out.push(JSON.parse(fs.readFileSync(path.join(d, f), 'utf8'))); } catch {}
    try { fs.unlinkSync(path.join(d, f)); } catch {}
  }
  return out;
}

// 結婚・出産の条件（管理役が確かめる）
export function canMarry(a, b, now = Date.now()) {
  return a && b && a.alive && b.alive && a.name !== b.name && !a.spouse && !b.spouse && a.sex !== b.sex
    && ageOf(a, now) >= MARRY_MIN_AGE && ageOf(b, now) >= MARRY_MIN_AGE
    && !a.parents.includes(b.name) && !b.parents.includes(a.name)
    && !(a.parents.length && a.parents.some((p) => b.parents.includes(p))); // きょうだい同士は結婚しない
}

export function canHaveChild(world, a, now = Date.now()) {
  const b = a?.spouse ? world.people[a.spouse] : null;
  if (!a || !b || !a.alive || !b.alive) return false;
  const ok = (p) => ageOf(p, now) >= BIRTH_AGES[0] && ageOf(p, now) <= BIRTH_AGES[1];
  const living = Object.values(world.people).filter((p) => p.alive).length;
  const last = Math.max(a.lastBirthAt ?? 0, b.lastBirthAt ?? 0);
  return ok(a) && ok(b) && a.children.length < MAX_CHILDREN && living < MAX_POPULATION && now - last >= BIRTH_COOLDOWN_YEARS * YEAR_MS;
}
