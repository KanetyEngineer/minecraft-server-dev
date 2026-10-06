// Stream tools next to the games (the things TikFinity does): text-to-speech of comments, alerts with sounds for
// follow / share / subscribe / gifts / like milestones / joins, goals, a subathon timer, and OBS overlays for
// alerts, chat, recent events, top gifters / likers, live counters and the timer. They work for every streamer,
// whatever game (or none) they are assigned to.
//
// Settings live in config.json "live" (one set for everyone). Counters are per streamer and per LIVE: they start
// again when the streamer's connection lands in a new room (or with the panel's reset button).
// Overlays: /live/<widget>?game=<game>&field=<n> (or ?user=<TikTok ID>), fed by server-sent events.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { avatarUrl } from './avatar.js';
import { send, json, readBody } from './util.js';

export const WIDGETS = [
  { id: 'alerts', title: 'アラート（ポップアップ＋効果音＋読み上げ）', w: 1280, h: 720 },
  { id: 'chat', title: 'チャット欄', w: 420, h: 640 },
  { id: 'events', title: '最近のイベント（フォロー・ギフトなど）', w: 420, h: 420 },
  { id: 'goal', title: 'ゴール（目標バー）', w: 640, h: 110, params: 'n=1' },
  { id: 'top', title: 'ギフトランキング', w: 380, h: 360 },
  { id: 'likers', title: 'いいねランキング', w: 380, h: 360 },
  { id: 'stats', title: 'カウンター（視聴者・いいね・コイン・フォロー）', w: 720, h: 90 },
  { id: 'timer', title: '延長タイマー（サブアソン）', w: 480, h: 150 },
];

const ALERT_TYPES = ['follow', 'share', 'subscribe', 'gift', 'like', 'join'];
const GOAL_TYPES = ['likes', 'coins', 'follows', 'shares', 'subs', 'viewers', 'gifts', 'joins'];
const BUILTIN_SOUNDS = { chime: 'チャイム', coin: 'コイン', fanfare: 'ファンファーレ', levelup: 'レベルアップ', pop: 'ポン', bell: 'ベル', whoosh: 'シュッ' };

export const LIVE_DEFAULTS = {
  tts: {
    engine: 'windows', voice: '', rate: 1, volume: 100,
    chat: true, readName: true, maxLen: 60, who: 'all', skipPrefix: '!', cooldownSec: 0, maxQueue: 6, banned: [],
  },
  alerts: {
    volume: 70, duration: 6,
    follow: { on: true, text: '{name} さんがフォローしてくれました！', sound: 'chime', tts: true },
    share: { on: true, text: '{name} さんがシェアしてくれました！', sound: 'pop', tts: true },
    subscribe: { on: true, text: '{name} さんがサブスクしてくれました！', sound: 'fanfare', tts: true },
    gift: { on: true, text: '{name} さんが {gift} ×{count} をくれました！', sound: 'coin', tts: true, minCoins: 1, bigCoins: 100, bigSound: 'fanfare' },
    like: { on: true, text: 'いいね {likes} 達成！ありがとう！', sound: 'levelup', tts: true, every: 1000 },
    join: { on: false, text: '{name} さん、いらっしゃい！', sound: '', tts: true },
  },
  goals: [
    { type: 'likes', title: 'いいね目標', target: 10000, step: 10000, color: '#fe2c55' },
    { type: 'follows', title: 'フォロー目標', target: 20, step: 10, color: '#25f4ee' },
    { type: 'coins', title: 'ギフト目標', target: 1000, step: 1000, color: '#facc15' },
  ],
  timer: { startMin: 10, maxMin: 0, perCoin: 5, perFollow: 30, perShare: 10, perSub: 300, likeEvery: 100, perLikes: 5 },
  chat: { max: 10, showGifts: true, showJoins: false },
  top: { count: 5 },
};

const num = (v, def, lo, hi) => { const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : def; };
const str = (v, def, max) => (typeof v === 'string' ? v.slice(0, max) : def);
const bool = (v, def) => (typeof v === 'boolean' ? v : def);

// the panel's settings, checked and filled with the defaults
export function cleanLive(raw = {}) {
  const D = LIVE_DEFAULTS;
  const t = raw.tts ?? {};
  const tts = {
    engine: ['windows', 'browser'].includes(t.engine) ? t.engine : D.tts.engine,
    voice: str(t.voice, '', 80), rate: Math.round(num(t.rate, D.tts.rate, -10, 10)), volume: Math.round(num(t.volume, D.tts.volume, 0, 100)),
    chat: bool(t.chat, D.tts.chat), readName: bool(t.readName, D.tts.readName), maxLen: Math.round(num(t.maxLen, D.tts.maxLen, 5, 300)),
    who: ['all', 'followers', 'subs'].includes(t.who) ? t.who : 'all', skipPrefix: str(t.skipPrefix, D.tts.skipPrefix, 5),
    cooldownSec: num(t.cooldownSec, 0, 0, 600), maxQueue: Math.round(num(t.maxQueue, D.tts.maxQueue, 1, 50)),
    banned: (Array.isArray(t.banned) ? t.banned : String(t.banned ?? '').split(/[,、\n]/)).map((w) => String(w).trim()).filter(Boolean).slice(0, 200),
  };
  const a = raw.alerts ?? {};
  const alerts = { volume: Math.round(num(a.volume, D.alerts.volume, 0, 100)), duration: num(a.duration, D.alerts.duration, 2, 30) };
  for (const k of ALERT_TYPES) {
    const d = D.alerts[k];
    const x = a[k] ?? {};
    alerts[k] = { on: bool(x.on, d.on), text: str(x.text, d.text, 120), sound: str(x.sound, d.sound, 120), tts: bool(x.tts, d.tts) };
    if (k === 'gift') Object.assign(alerts[k], { minCoins: Math.round(num(x.minCoins, d.minCoins, 1, 1e6)), bigCoins: Math.round(num(x.bigCoins, d.bigCoins, 0, 1e6)), bigSound: str(x.bigSound, d.bigSound, 120) });
    if (k === 'like') alerts[k].every = Math.round(num(x.every, d.every, 10, 1e7));
  }
  const goals = (Array.isArray(raw.goals) ? raw.goals : D.goals).slice(0, 8).map((g) => ({
    type: GOAL_TYPES.includes(g?.type) ? g.type : 'likes', title: str(g?.title, '目標', 40),
    target: Math.round(num(g?.target, 100, 1, 1e9)), step: Math.round(num(g?.step, 0, 0, 1e9)),
    color: /^#[0-9a-f]{6}$/i.test(g?.color ?? '') ? g.color : '#fe2c55',
  }));
  const m = raw.timer ?? {};
  const timer = {};
  for (const [k, def] of Object.entries(D.timer)) timer[k] = num(m[k], def, 0, k === 'likeEvery' ? 1e6 : 100000);
  const c = raw.chat ?? {};
  const chat = { max: Math.round(num(c.max, D.chat.max, 1, 50)), showGifts: bool(c.showGifts, D.chat.showGifts), showJoins: bool(c.showJoins, D.chat.showJoins) };
  const top = { count: Math.round(num(raw.top?.count, D.top.count, 1, 20)) };
  return { tts, alerts, goals, timer, chat, top };
}

// ------------------------------------------------------------------ sounds (a few made here, plus uploaded files)
function wav(samples, rate = 44100) {
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + samples.length * 2, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((s, i) => buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, s)) * 32000), 44 + i * 2));
  return buf;
}

// notes: [startSec, freq, lengthSec, volume, partials?]
function synth(notes, total, noise = 0) {
  const R = 44100;
  const out = new Float32Array(Math.ceil(total * R));
  for (const [start, f, len, vol, partials = [1]] of notes) {
    const s0 = Math.floor(start * R);
    for (let i = 0; i < len * R && s0 + i < out.length; i++) {
      const t = i / R;
      const env = Math.min(1, t / 0.005) * Math.exp(-t * 4 / len);
      let v = 0;
      partials.forEach((p, k) => { v += Math.sin(2 * Math.PI * f * p * t) / (k + 1); });
      out[s0 + i] += v * env * vol;
    }
  }
  if (noise) {
    let lp = 0;
    for (let i = 0; i < out.length; i++) {
      const t = i / out.length;
      lp += ((Math.random() * 2 - 1) - lp) * (0.02 + 0.3 * t);
      out[i] += lp * Math.sin(Math.PI * t) * noise;
    }
  }
  return Array.from(out);
}

function builtinSound(name) {
  const H = [1, 2, 3];
  switch (name) {
    case 'chime': return synth([[0, 1318.5, 0.9, 0.35, H], [0.16, 1975.5, 1.1, 0.3, H]], 1.4);
    case 'coin': return synth([[0, 987.8, 0.12, 0.3, [1, 3, 5]], [0.08, 1318.5, 0.6, 0.3, [1, 3, 5]]], 0.75);
    case 'fanfare': return synth([[0, 523.3, 0.25, 0.25, H], [0.12, 659.3, 0.25, 0.25, H], [0.24, 784, 0.25, 0.25, H], [0.36, 1046.5, 1.0, 0.3, H], [0.36, 784, 1.0, 0.18, H], [0.36, 659.3, 1.0, 0.15, H]], 1.5);
    case 'levelup': return synth([0, 1, 2, 3, 4, 5].map((i) => [i * 0.07, 523.3 * 2 ** ([0, 4, 7, 12, 16, 19][i] / 12), 0.35, 0.22, [1, 2]]), 0.9);
    case 'pop': {
      const R = 44100; const out = [];
      for (let i = 0; i < R * 0.18; i++) { const t = i / R; out.push(Math.sin(2 * Math.PI * (300 + 900 * Math.exp(-t * 30)) * t) * Math.exp(-t * 22) * 0.6); }
      return out;
    }
    case 'bell': return synth([[0, 880, 1.6, 0.3, [1, 2.76, 5.4, 8.93]]], 1.8);
    case 'whoosh': return synth([], 0.6, 0.6);
    default: return null;
  }
}

// ------------------------------------------------------------------ Windows text-to-speech (SAPI, one PowerShell)
const PS_WORKER = `$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$o = [Console]::Out
function D($x) { if ($x -eq '-') { return '' } return [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($x)) }
while ($true) {
  $l = [Console]::In.ReadLine()
  if ($l -eq $null) { break }
  $p = $l.Split(' ')
  if ($p[0] -eq 'voices') {
    $n = ($s.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object { $_.VoiceInfo.Name + '|' + $_.VoiceInfo.Culture.Name }) -join ';'
    $o.WriteLine('voices ' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($n))); $o.Flush(); continue
  }
  try {
    $voice = D $p[3]
    if ($voice) { try { $s.SelectVoice($voice) } catch {} }
    $s.Rate = [int]$p[4]; $s.Volume = [int]$p[5]
    $s.SetOutputToWaveFile((D $p[2]))
    $s.Speak((D $p[6]))
    $s.SetOutputToNull()
    $o.WriteLine('ok ' + $p[1])
  } catch {
    try { $s.SetOutputToNull() } catch {}
    $o.WriteLine('err ' + $p[1] + ' ' + $_.Exception.Message)
  }
  $o.Flush()
}
`;

function createSapi({ dir, log }) {
  const available = process.platform === 'win32';
  let proc = null;
  let buf = '';
  let seq = 0;
  let failures = 0;
  const pending = new Map(); // id -> { resolve, timer }
  let voiceWaiters = [];
  let voices = null;
  const b64 = (s) => (s ? Buffer.from(String(s), 'utf8').toString('base64') : '-');

  function start() {
    if (proc || !available || failures > 5) return;
    const script = path.join(dir, 'tts-worker.ps1');
    fs.writeFileSync(script, '﻿' + PS_WORKER, 'utf8');
    proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        const [kind, id, ...rest] = line.split(' ');
        if (kind === 'voices') {
          voices = Buffer.from(id ?? '', 'base64').toString('utf8').split(';').filter(Boolean).map((v) => { const [name, lang] = v.split('|'); return { name, lang }; });
          voiceWaiters.forEach((w) => w(voices)); voiceWaiters = [];
          continue;
        }
        const p = pending.get(id);
        if (!p) continue;
        pending.delete(id);
        clearTimeout(p.timer);
        if (kind === 'err') log('warn', `読み上げに失敗: ${rest.join(' ')}`);
        p.resolve(kind === 'ok');
      }
    });
    proc.stderr.on('data', () => {});
    proc.on('error', (err) => { log('warn', `Windows の読み上げを使えません: ${err.message}`); });
    proc.on('exit', () => {
      proc = null;
      failures++;
      for (const p of pending.values()) { clearTimeout(p.timer); p.resolve(false); }
      pending.clear();
      voiceWaiters.forEach((w) => w([])); voiceWaiters = [];
    });
  }

  // -> the wav file name, or null
  function speak(text, { voice, rate, volume }) {
    if (!available) return Promise.resolve(null);
    start();
    if (!proc) return Promise.resolve(null);
    const id = `${Date.now().toString(36)}${(++seq).toString(36)}`;
    const file = path.join(dir, `${id}.wav`);
    return new Promise((resolve) => {
      const timer = setTimeout(() => { pending.delete(id); resolve(false); }, 15000);
      pending.set(id, { resolve, timer });
      proc.stdin.write(`speak ${id} ${b64(file)} ${b64(voice)} ${rate | 0} ${volume | 0} ${b64(text)}\n`);
    }).then((ok) => (ok ? `${id}.wav` : null));
  }

  function listVoices() {
    if (!available) return Promise.resolve([]);
    if (voices) return Promise.resolve(voices);
    start();
    if (!proc) return Promise.resolve([]);
    return new Promise((resolve) => {
      voiceWaiters.push(resolve);
      proc.stdin.write('voices\n');
      setTimeout(() => resolve(voices ?? []), 8000);
    });
  }

  // spoken files are only needed for a minute or two
  setInterval(() => {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.wav')) continue;
      const full = path.join(dir, f);
      try { if (Date.now() - fs.statSync(full).mtimeMs > 10 * 60000) fs.unlinkSync(full); } catch { /* in use */ }
    }
  }, 60000).unref();

  return { available, speak, listVoices, waiting: () => pending.size, stop: () => proc?.kill() };
}

// ------------------------------------------------------------------ text helpers
const EMOJI = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{FE0F}\u{200D}]/gu;
function speakable(s, max) {
  return String(s ?? '')
    .replace(/https?:\/\/\S+/g, 'URL')
    .replace(EMOJI, '')
    .replace(/(.)\1{3,}/gu, '$1$1$1')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}
const fill = (tpl, v) => String(tpl).replace(/\{(\w+)\}/g, (m, k) => (v[k] ?? m));
const nick = (u) => u?.nickname || u?.uniqueId || '視聴者';

// ------------------------------------------------------------------ the tools
// hooks: { stateDir, publicDir, settings(): raw, save(cleaned), log(kind, text),
//          find(params) -> streamer | null (params: URLSearchParams with game/field/user/streamer),
//          byId(id) -> streamer | null, label(streamer), giftImage(giftId, name) -> url | '' }
export function createLive(hooks) {
  const ttsDir = path.join(hooks.stateDir, 'tts');
  const soundDir = path.join(hooks.stateDir, 'sounds');
  const sessionFile = path.join(hooks.stateDir, 'live-sessions.json');
  fs.mkdirSync(ttsDir, { recursive: true });
  fs.mkdirSync(soundDir, { recursive: true });
  const sapi = createSapi({ dir: ttsDir, log: hooks.log });
  const S = () => cleanLive(hooks.settings());

  // ---- per-streamer session (counters of this LIVE)
  const sessions = new Map();
  try {
    for (const [id, s] of Object.entries(JSON.parse(fs.readFileSync(sessionFile, 'utf8')))) sessions.set(id, s);
  } catch { /* first start */ }
  let dirty = false;
  setInterval(() => {
    if (!dirty) return;
    dirty = false;
    const tmp = `${sessionFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(sessions)), 'utf8');
    fs.renameSync(tmp, sessionFile);
  }, 10000).unref();

  function newSession(roomId = null) {
    return {
      roomId, startedAt: Date.now(),
      stats: { viewers: 0, likes: 0, coins: 0, follows: 0, shares: 0, subs: 0, gifts: 0, joins: 0, comments: 0 },
      gifters: {}, likers: {}, chat: [], events: [], likeMark: null,
      timer: { running: false, endAt: 0, left: S().timer.startMin * 60000 },
    };
  }
  function session(sid) {
    let s = sessions.get(sid);
    if (!s) { s = newSession(); sessions.set(sid, s); }
    return s;
  }

  // ---- overlays (server-sent events)
  const clients = new Set(); // { res, params, sid }
  let seq = 0;
  function write(c, obj) {
    try { c.res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch { clients.delete(c); }
  }
  function push(sid, obj) {
    obj.id ??= ++seq;
    for (const c of clients) if (c.sid === sid) write(c, obj);
  }
  const statsTimers = new Map();
  function pushStats(sid) {
    if (statsTimers.has(sid)) return;
    statsTimers.set(sid, setTimeout(() => { statsTimers.delete(sid); push(sid, { kind: 'stats', ...liveStats(sid) }); }, 300));
  }

  const ranked = (m, n) => Object.values(m).sort((a, b) => b.n - a.n).slice(0, n);
  function liveStats(sid) {
    const s = session(sid);
    const set = S();
    return {
      stats: s.stats, timer: { ...s.timer, now: Date.now() },
      gifters: ranked(s.gifters, set.top.count), likers: ranked(s.likers, set.top.count),
    };
  }
  function snapshot(sid) {
    const set = S();
    const st = hooks.byId(sid);
    const s = session(sid);
    return {
      kind: 'snapshot', streamer: st ? { tiktok: st.tiktok, mc: st.mc, label: hooks.label(st) } : null,
      ...liveStats(sid), chat: s.chat.slice(-set.chat.max), events: s.events.slice(-20),
      goals: set.goals, chatSettings: set.chat, ttsEngine: set.tts.engine,
    };
  }
  // overlays follow whoever is on their game + field; when that changes they get a fresh snapshot
  setInterval(() => {
    for (const c of clients) {
      const sid = hooks.find(c.params)?.id ?? '';
      if (sid !== c.sid) { c.sid = sid; write(c, sid ? snapshot(sid) : { kind: 'snapshot', streamer: null, stats: newSession().stats, chat: [], events: [], gifters: [], likers: [], goals: S().goals, chatSettings: S().chat, timer: newSession().timer }); }
      else c.res.write(': ping\n\n');
    }
  }, 3000).unref();

  function addLine(list, item, max) {
    list.push(item);
    if (list.length > max) list.splice(0, list.length - max);
  }

  // ---- speech + alerts
  const lastSpoke = new Map(); // "<sid>:<user>" -> ms
  async function speech(text) {
    const set = S().tts;
    const t = speakable(text, 300);
    if (!t) return null;
    if (set.engine === 'windows' && sapi.available) {
      const file = await sapi.speak(t, set);
      if (file) return { url: `/tts/${file}` };
    }
    return { text: t, rate: set.rate, volume: set.volume }; // the overlay speaks it with the browser's voice
  }

  function soundUrl(name) {
    if (!name) return null;
    if (BUILTIN_SOUNDS[name]) return `/live-sound/${name}.wav`;
    return fs.existsSync(path.join(soundDir, path.basename(name))) ? `/live-sound/${encodeURIComponent(path.basename(name))}` : null;
  }

  async function alert(sid, type, vars, extra = {}) {
    const set = S();
    const a = set.alerts[type];
    if (!a?.on) return;
    const text = fill(a.text, vars);
    let sound = a.sound;
    if (type === 'gift' && a.bigCoins && vars.coins >= a.bigCoins && a.bigSound) sound = a.bigSound;
    const item = { kind: 'alert', type, text, name: vars.name, avatar: vars.avatar ?? null, img: extra.img ?? null, sound: soundUrl(sound), volume: set.alerts.volume, duration: set.alerts.duration };
    if (a.tts) item.tts = await Promise.race([speech(text), new Promise((r) => setTimeout(() => r(null), 5000))]);
    push(sid, item);
  }

  async function readChat(sid, d) {
    const set = S().tts;
    if (!set.chat) return;
    const comment = String(d.comment ?? '').trim();
    if (!comment || (set.skipPrefix && comment.startsWith(set.skipPrefix))) return;
    const lc = comment.toLowerCase();
    if (set.banned.some((w) => lc.includes(w.toLowerCase()))) return;
    const ident = d.userIdentity ?? {};
    if (set.who === 'followers' && !(ident.isFollowerOfAnchor || ident.isSubscriberOfAnchor || ident.isModeratorOfAnchor)) return;
    if (set.who === 'subs' && !(ident.isSubscriberOfAnchor || ident.isModeratorOfAnchor)) return;
    const key = `${sid}:${d.user?.uniqueId ?? '?'}`;
    if (set.cooldownSec && (lastSpoke.get(key) ?? 0) > Date.now() - set.cooldownSec * 1000) return;
    lastSpoke.set(key, Date.now());
    if (lastSpoke.size > 5000) lastSpoke.clear();
    if (sapi.waiting() >= set.maxQueue) return; // chat faster than the voice: skip rather than fall behind
    const body = speakable(comment, set.maxLen);
    if (!body) return;
    const name = speakable(nick(d.user), 20);
    const sp = await speech(set.readName && name ? `${name}、${body}` : body);
    if (sp) push(sid, { kind: 'tts', ...sp, maxQueue: set.maxQueue });
  }

  // ---- timer
  function timerAdd(sid, sec) {
    if (!sec) return;
    const s = session(sid);
    const set = S().timer;
    const t = s.timer;
    const max = set.maxMin ? set.maxMin * 60000 : Infinity;
    if (t.running) t.endAt = Math.min(t.endAt + sec * 1000, Date.now() + max);
    else t.left = Math.max(0, Math.min(t.left + sec * 1000, max));
    dirty = true;
    pushStats(sid);
  }
  function timerOp(sid, op, sec = 0) {
    const s = session(sid);
    const t = s.timer;
    if (op === 'start' && !t.running) { t.running = true; t.endAt = Date.now() + t.left; }
    else if (op === 'pause' && t.running) { t.running = false; t.left = Math.max(0, t.endAt - Date.now()); }
    else if (op === 'reset') s.timer = { running: false, endAt: 0, left: S().timer.startMin * 60000 };
    else if (op === 'add') return timerAdd(sid, Number(sec) || 0);
    else if (op === 'set') { const ms = Math.max(0, Number(sec) || 0) * 1000; if (t.running) t.endAt = Date.now() + ms; else t.left = ms; }
    dirty = true;
    pushStats(sid);
  }

  function event(sid, d, type, text, extra = {}) {
    const s = session(sid);
    const item = { type, text, name: nick(d.user), avatar: avatarUrl(d.user), at: Date.now(), ...extra };
    addLine(s.events, item, 50);
    push(sid, { kind: 'event', ...item });
    return item;
  }

  // ---- every TikTok event of a streamer
  function onEvent(st, type, d = {}) {
    const sid = st.id;
    const s = session(sid);
    const set = S();
    const name = nick(d.user);
    const avatar = avatarUrl(d.user);
    dirty = true;
    switch (type) {
      case 'connected':
        if (d.roomId && s.roomId !== d.roomId) {
          sessions.set(sid, newSession(d.roomId));
          hooks.log('info', `${hooks.label(st)}: 新しい LIVE なので配信ツールの数を 0 から数えます`);
          for (const c of clients) if (c.sid === sid) write(c, snapshot(sid));
        }
        return;
      case 'roomUser':
        s.stats.viewers = Number(d.viewerCount) || 0;
        pushStats(sid);
        return;
      case 'chat': {
        s.stats.comments++;
        const line = { name, avatar, comment: String(d.comment ?? '').slice(0, 200), at: Date.now() };
        addLine(s.chat, line, 50);
        push(sid, { kind: 'chat', ...line });
        readChat(sid, d);
        return;
      }
      case 'member':
        s.stats.joins++;
        if (set.chat.showJoins) push(sid, { kind: 'chat', name, avatar, comment: '入室しました', join: true, at: Date.now() });
        alert(sid, 'join', { name, avatar });
        pushStats(sid);
        return;
      case 'follow':
        s.stats.follows++;
        event(sid, d, 'follow', 'フォロー');
        alert(sid, 'follow', { name, avatar });
        timerAdd(sid, set.timer.perFollow);
        pushStats(sid);
        return;
      case 'share':
        s.stats.shares++;
        event(sid, d, 'share', 'シェア');
        alert(sid, 'share', { name, avatar });
        timerAdd(sid, set.timer.perShare);
        pushStats(sid);
        return;
      case 'subscribe':
        s.stats.subs++;
        event(sid, d, 'subscribe', 'サブスク');
        alert(sid, 'subscribe', { name, avatar });
        timerAdd(sid, set.timer.perSub);
        pushStats(sid);
        return;
      case 'like': {
        const n = Math.max(0, Number(d.likeCount) || 0);
        s.stats.likes = Math.max(Number(d.totalLikeCount) || 0, s.stats.likes + n);
        const uid = d.user?.uniqueId ?? name;
        const l = (s.likers[uid] ??= { name, avatar, n: 0 });
        l.n += n; l.name = name; l.avatar = avatar ?? l.avatar;
        if (set.timer.likeEvery && set.timer.perLikes) {
          const marks = Math.floor(s.stats.likes / set.timer.likeEvery);
          if (s.timerLikeMark == null) s.timerLikeMark = marks;
          else if (marks > s.timerLikeMark) { timerAdd(sid, (marks - s.timerLikeMark) * set.timer.perLikes); s.timerLikeMark = marks; }
        }
        const every = set.alerts.like.every;
        const marks = Math.floor(s.stats.likes / every);
        if (s.likeMark == null) s.likeMark = marks; // likes from before we connected don't count
        else if (marks > s.likeMark) {
          s.likeMark = marks;
          event(sid, { user: { nickname: 'みんな' } }, 'like', `いいね ${marks * every}`);
          alert(sid, 'like', { name: 'みんな', likes: marks * every });
        }
        pushStats(sid);
        return;
      }
      case 'gift': {
        const g = d.gift ?? d.giftDetails ?? {};
        if ((g.type ?? g.giftType) === 1 && !d.repeatEnd) return; // streak still running
        const giftName = g.name ?? g.giftName ?? d.extendedGiftInfo?.name ?? `gift ${d.giftId}`;
        const count = Math.max(1, Number(d.repeatCount) || 1);
        const each = Number(g.diamondCount ?? d.extendedGiftInfo?.diamond_count ?? 1) || 1;
        const coins = each * count;
        s.stats.coins += coins;
        s.stats.gifts += count;
        const uid = d.user?.uniqueId ?? name;
        const r = (s.gifters[uid] ??= { name, avatar, n: 0 });
        r.n += coins; r.name = name; r.avatar = avatar ?? r.avatar;
        const img = hooks.giftImage(d.giftId ?? g.id, giftName) || null;
        event(sid, d, 'gift', `${giftName} ×${count}`, { coins, img });
        if (set.chat.showGifts) push(sid, { kind: 'chat', name, avatar, comment: `${giftName} ×${count} を贈りました`, gift: true, img, at: Date.now() });
        if (coins >= set.alerts.gift.minCoins) alert(sid, 'gift', { name, avatar, gift: giftName, count, coins }, { img });
        timerAdd(sid, coins * set.timer.perCoin);
        pushStats(sid);
        return;
      }
      default:
    }
  }

  // ---- fake events from the panel (the same path as real ones)
  function test(st, type, b = {}) {
    const nickname = String(b.name || 'テスト視聴者').slice(0, 24);
    const user = { nickname, uniqueId: `test_${nickname}` };
    const ident = { isFollowerOfAnchor: true };
    switch (type) {
      case 'chat': return onEvent(st, 'chat', { user, comment: String(b.comment || 'こんにちは！がんばって！').slice(0, 200), userIdentity: ident });
      case 'gift': return onEvent(st, 'gift', { user, gift: { name: String(b.gift || 'Rose').slice(0, 40), diamondCount: Math.max(1, Math.min(100000, Number(b.coins) || 1)), type: 0 }, giftId: Number(b.giftId) || 5655, repeatCount: Math.max(1, Math.min(999, Number(b.count) || 1)), repeatEnd: true });
      case 'like': {
        const s = session(st.id);
        const set = S();
        // a test press counts from here, like a real LIVE counts from the moment we connect
        s.likeMark ??= Math.floor(s.stats.likes / set.alerts.like.every);
        if (set.timer.likeEvery) s.timerLikeMark ??= Math.floor(s.stats.likes / set.timer.likeEvery);
        const n = Math.max(1, Math.min(100000, Number(b.likes) || 100));
        return onEvent(st, 'like', { user, likeCount: n, totalLikeCount: s.stats.likes + n });
      }
      case 'viewers': return onEvent(st, 'roomUser', { viewerCount: Math.max(0, Number(b.viewers) || 120) });
      case 'follow': case 'share': case 'subscribe': case 'member': return onEvent(st, type, { user });
      default: throw new Error('知らない種類です');
    }
  }

  // ---- HTTP
  function streamerFromBody(b) {
    const st = hooks.byId(b.streamer);
    if (!st) throw new Error('配信者を選んでください');
    return st;
  }

  async function settingsJson() {
    const sounds = [
      ...Object.entries(BUILTIN_SOUNDS).map(([id, label]) => ({ id, label, url: `/live-sound/${id}.wav`, builtin: true })),
      ...fs.readdirSync(soundDir).filter((f) => /\.(mp3|wav|ogg|m4a)$/i.test(f)).map((f) => ({ id: f, label: f.replace(/^u-/, ''), url: `/live-sound/${encodeURIComponent(f)}` })),
    ];
    return { settings: S(), defaults: LIVE_DEFAULTS, sounds, voices: await sapi.listVoices(), windowsTts: sapi.available, widgets: WIDGETS, goalTypes: GOAL_TYPES };
  }

  // -> true when the request was one of ours
  async function handle(req, res, url) {
    const p = url.pathname;
    if (req.method === 'GET' && p.startsWith('/live/')) {
      if (!WIDGETS.some((w) => w.id === p.slice(6))) return send(res, 404, 'text/plain', 'no such widget'), true;
      send(res, 200, 'text/html; charset=utf-8', fs.readFileSync(path.join(hooks.publicDir, 'live.html')));
      return true;
    }
    if (req.method === 'GET' && p.startsWith('/live-sound/')) {
      const name = decodeURIComponent(p.slice(12));
      const builtin = builtinSound(name.replace(/\.wav$/, ''));
      if (builtin) return send(res, 200, 'audio/wav', wav(builtin)), true;
      const file = path.join(soundDir, path.basename(name));
      if (!fs.existsSync(file)) return send(res, 404, 'text/plain', 'not found'), true;
      const type = { '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4' }[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
      send(res, 200, type, fs.readFileSync(file));
      return true;
    }
    if (req.method === 'GET' && p.startsWith('/tts/')) {
      const file = path.join(ttsDir, path.basename(p.slice(5)));
      if (!file.endsWith('.wav') || !fs.existsSync(file)) return send(res, 404, 'text/plain', 'not found'), true;
      send(res, 200, 'audio/wav', fs.readFileSync(file));
      return true;
    }
    if (!p.startsWith('/api/live/')) return false;
    const op = p.slice(10);
    if (req.method === 'GET' && op === 'stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      const c = { res, params: url.searchParams, sid: hooks.find(url.searchParams)?.id ?? '' };
      clients.add(c);
      req.on('close', () => clients.delete(c));
      res.write('retry: 2000\n\n');
      write(c, c.sid ? snapshot(c.sid) : { kind: 'snapshot', streamer: null, stats: newSession().stats, chat: [], events: [], gifters: [], likers: [], goals: S().goals, chatSettings: S().chat, timer: newSession().timer });
      return true;
    }
    if (req.method === 'GET' && op === 'state') {
      const st = hooks.find(url.searchParams);
      json(res, st ? { ok: true, ...snapshot(st.id) } : { ok: false, message: 'その番号に配信者がいません' });
      return true;
    }
    if (req.method === 'GET' && op === 'settings') return json(res, { ok: true, ...(await settingsJson()) }), true;
    if (req.method !== 'POST') return false;
    const b = await readBody(req, 12_000_000);
    try {
      if (op === 'settings') {
        const v = cleanLive(b.settings ?? {});
        hooks.save(v);
        hooks.log('info', '配信ツールの設定を保存しました');
        for (const c of clients) if (c.sid) write(c, { kind: 'settings', goals: v.goals, chatSettings: v.chat, ttsEngine: v.tts.engine });
        return json(res, { ok: true, ...(await settingsJson()) }), true;
      }
      if (op === 'test') { test(streamerFromBody(b), String(b.type), b); return json(res, { ok: true }), true; }
      if (op === 'say') {
        const st = streamerFromBody(b);
        const sp = await speech(String(b.text ?? '').slice(0, 200));
        if (!sp) throw new Error('読み上げる文がありません');
        push(st.id, { kind: 'tts', ...sp, maxQueue: 50 });
        return json(res, { ok: true }), true;
      }
      if (op === 'timer') { timerOp(streamerFromBody(b).id, String(b.op), b.sec); return json(res, { ok: true }), true; }
      if (op === 'reset') {
        const st = streamerFromBody(b);
        const old = session(st.id);
        const fresh = newSession(old.roomId);
        if (b.keepTimer) fresh.timer = old.timer;
        sessions.set(st.id, fresh);
        dirty = true;
        for (const c of clients) if (c.sid === st.id) write(c, snapshot(st.id));
        hooks.log('info', `${hooks.label(st)}: 配信ツールの数を 0 に戻しました`);
        return json(res, { ok: true }), true;
      }
      if (op === 'sound') {
        const name = String(b.name ?? '').replace(/[^\w.\-぀-ヿ一-鿿]/g, '_').slice(0, 60);
        if (!/\.(mp3|wav|ogg|m4a)$/i.test(name)) throw new Error('mp3 / wav / ogg / m4a のファイルを選んでください');
        const data = Buffer.from(String(b.data ?? ''), 'base64');
        if (!data.length || data.length > 8_000_000) throw new Error('ファイルが空か大きすぎます（8MB まで）');
        fs.writeFileSync(path.join(soundDir, `u-${name}`), data);
        hooks.log('info', `効果音 ${name} を追加しました`);
        return json(res, { ok: true, file: `u-${name}`, ...(await settingsJson()) }), true;
      }
      if (op === 'sound-delete') {
        const file = path.join(soundDir, path.basename(String(b.file ?? '')));
        if (fs.existsSync(file)) fs.unlinkSync(file);
        return json(res, { ok: true, ...(await settingsJson()) }), true;
      }
      if (op === 'session') {
        const st = streamerFromBody(b);
        return json(res, { ok: true, ...snapshot(st.id) }), true;
      }
    } catch (err) {
      return json(res, { ok: false, message: err.message }, 400), true;
    }
    return false;
  }

  return { onEvent, handle, stop: () => sapi.stop(), forget: (sid) => { sessions.delete(sid); dirty = true; } };
}
