// 町の「公開情報」と、住人ひとりひとりの人間関係の記憶。
//
// 公開情報（町の台帳）: 住人ごとに SOCIETY_DIR/<名前>.json へ自分の情報を書き、ほかの住人のファイルを読む
//（1 ファイルを 1 人だけが書くので、書き込みがぶつからない。team.js と同じ作り）。
// 書くのは「表札や看板で誰でも見られること」だけにする: 家の場所、仕事、広場の掲示板への貼り紙、共同倉庫の場所と中身（最後に見たとき）。
// 心の中（好き嫌い・日記）は各自の memory.json（data/）にだけ残す。
//
// 町の出来事（会話・贈り物・集会・家の完成など）は SOCIETY_DIR/events.jsonl に 1 行ずつ追記する（観察用のダッシュボードが読む）。
import fs from 'node:fs';
import path from 'node:path';
import { compatibility, personaByName } from './personas.js';

// 家の区画: 広場を中心に、住人の番号ごとに 36 度ずつずらした円周上（半径 PLOT_RADIUS）に並べる
export const PLOT_RADIUS = 22;
// 共同倉庫は広場の中心から少しずらす（広場の真ん中は集会で人が立つ）
export const STORAGE_OFFSET = { x: 3, z: 3 };
// 掲示板を読めるのは広場のそば（この距離以内）にいるときだけ
export const NOTICE_RANGE = 24;

export function plotCenter(plaza, id, { radius = PLOT_RADIUS, shift = 0 } = {}) {
  const a = ((id - 1) * 36) * (Math.PI / 180);
  const r = radius + shift;
  return { x: Math.round(plaza.x + Math.cos(a) * r), z: Math.round(plaza.z + Math.sin(a) * r) };
}

export class Town {
  constructor({ dir = 'society', name, persona }) {
    this.dir = path.resolve(dir);
    this.name = name;
    this.persona = persona;
    this.profile = { name, mbti: persona?.mbti, title: persona?.title, job: null, home: null, plaza: null,
      storage: null, storageSeen: null, notices: [], wants: [], meeting: null, house: null };
    try { fs.mkdirSync(this.dir, { recursive: true }); } catch {}
    // 前回の自分の公開情報を引き継ぐ（再起動しても家や仕事を忘れない）
    try {
      const old = JSON.parse(fs.readFileSync(this.file(name), 'utf8'));
      this.profile = { ...this.profile, ...old, name, mbti: persona?.mbti, title: persona?.title };
    } catch {}
  }

  file(name) {
    return path.join(this.dir, `${name}.json`);
  }

  // 自分の公開情報を書く
  publish(bot) {
    const p = bot?.entity?.position;
    const body = { ...this.profile, at: Date.now(),
      pos: p ? { x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) } : this.profile.pos ?? null,
      health: Math.round(bot?.health ?? 0), food: Math.round(bot?.food ?? 0) };
    this.profile.pos = body.pos;
    try {
      fs.writeFileSync(`${this.file(this.name)}.tmp`, JSON.stringify(body, null, 1));
      fs.renameSync(`${this.file(this.name)}.tmp`, this.file(this.name));
    } catch {}
  }

  // ほかの住人の公開情報（offlineMs より古いものは「留守」として online=false）
  residents({ offlineMs = 90_000 } = {}) {
    let files = [];
    try { files = fs.readdirSync(this.dir).filter((f) => f.endsWith('.json')); } catch { return []; }
    const out = [];
    for (const f of files) {
      try {
        const s = JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf8'));
        if (!s.name || s.name === this.name) continue;
        s.online = Date.now() - (s.at ?? 0) < offlineMs;
        out.push(s);
      } catch {}
    }
    return out;
  }

  resident(name) {
    return this.residents().find((r) => r.name === name) ?? null;
  }

  // 広場: 最初に誰かが決めた場所（いちばん古い記録）に全員が合わせる。誰も決めていなければ自分の値
  plaza() {
    const all = [this.profile, ...this.residents()].filter((r) => r.plaza);
    all.sort((a, b) => (a.plaza.at ?? 0) - (b.plaza.at ?? 0));
    return all[0]?.plaza ?? null;
  }

  setPlaza(pos) {
    if (this.plaza()) return this.plaza();
    this.profile.plaza = { x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z), at: Date.now() };
    return this.profile.plaza;
  }

  // 共同倉庫: 誰かが置いた場所（いちばん古いもの）
  storage() {
    const all = [this.profile, ...this.residents()].filter((r) => r.storage);
    all.sort((a, b) => (a.storage.at ?? 0) - (b.storage.at ?? 0));
    return all[0]?.storage ?? null;
  }

  // 倉庫の中身（誰かが最後に開けて見たときのもの）
  storageContents() {
    const all = [this.profile, ...this.residents()].filter((r) => r.storageSeen);
    all.sort((a, b) => (b.storageSeen.at ?? 0) - (a.storageSeen.at ?? 0));
    return all[0]?.storageSeen ?? null;
  }

  // 掲示板の貼り紙（新しい順）。広場のそばにいるときだけ読める
  notices(bot, { limit = 8 } = {}) {
    const plaza = this.plaza();
    const p = bot?.entity?.position;
    if (!plaza || !p || Math.hypot(p.x - plaza.x, p.z - plaza.z) > NOTICE_RANGE) return null;
    const all = [this.profile, ...this.residents()].flatMap((r) => (r.notices ?? []).map((n) => ({ ...n, by: r.name })));
    return all.sort((a, b) => b.at - a.at).slice(0, limit);
  }

  postNotice(text) {
    this.profile.notices = [...(this.profile.notices ?? []), { at: Date.now(), text: String(text).slice(0, 120) }].slice(-5);
  }

  // 開かれている（予定の）集会。開いた人の公開情報に書かれる
  meetings({ maxAgeMs = 6 * 60_000 } = {}) {
    return [this.profile, ...this.residents()].filter((r) => r.meeting && Date.now() - r.meeting.at < maxAgeMs)
      .map((r) => ({ ...r.meeting, by: r.name }));
  }

  // 町の出来事を残す（観察用）
  event(kind, text, extra = {}) {
    const line = JSON.stringify({ at: new Date().toISOString(), by: this.name, kind, text, ...extra });
    try { fs.appendFileSync(path.join(this.dir, 'events.jsonl'), `${line}\n`); } catch {}
  }
}

// 人間関係の記憶（memory.data.social に保存）。好感度は -100〜100
export class Relations {
  constructor(memory, persona) {
    this.memory = memory;
    this.persona = persona;
    memory.data.social ??= { relations: {}, diary: [], lastTalkAt: 0, lastExploreAt: 0, lastWorkAt: 0, lastMeetingAt: 0 };
    this.data = memory.data.social;
  }

  get(name) {
    let r = this.data.relations[name];
    if (!r) {
      // 初対面の印象は性格の相性で少しだけ決まる
      const other = personaByName(name);
      const base = other && this.persona ? Math.round(compatibility(this.persona.mbti, other.mbti) * 15) : 0;
      r = this.data.relations[name] = { affinity: base, talks: 0, giftsGiven: 0, giftsReceived: 0, lastTalkAt: 0, notes: [] };
    }
    return r;
  }

  // 好感度を変える（理由はメモとして残す）
  adjust(name, delta, why) {
    const r = this.get(name);
    r.affinity = Math.max(-100, Math.min(100, Math.round((r.affinity + delta) * 10) / 10));
    if (why) r.notes = [...r.notes, `${new Date().toISOString().slice(5, 16)} ${why}`].slice(-6);
    this.memory.save();
    return r.affinity;
  }

  talked(name) {
    const r = this.get(name);
    r.talks++;
    r.lastTalkAt = Date.now();
    this.data.lastTalkAt = Date.now();
    this.memory.save();
  }

  // 好きな順（好感度が高い順）
  ranked() {
    return Object.entries(this.data.relations).map(([name, r]) => ({ name, ...r })).sort((a, b) => b.affinity - a.affinity);
  }

  diary(text) {
    this.data.diary = [...this.data.diary, { at: new Date().toISOString(), text }].slice(-40);
    this.memory.save();
  }

  mark(key) {
    this.data[key] = Date.now();
    this.memory.save();
  }

  since(key) {
    return (Date.now() - (this.data[key] ?? 0)) / 60_000;
  }
}

// 関係の言い方（好感度 → ことば）
export function relationLabel(a) {
  if (a >= 60) return '親友';
  if (a >= 30) return '友だち';
  if (a >= 10) return '顔なじみ';
  if (a > -10) return '知り合い';
  if (a > -30) return '苦手';
  return '嫌い';
}
