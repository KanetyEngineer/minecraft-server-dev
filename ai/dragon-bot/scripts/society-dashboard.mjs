// 社会実験の観察用ダッシュボード（http://localhost:3300/）。
// 町の台帳（society/town/*.json）、出来事（society/town/events.jsonl）、住人ごとの記憶（society/data/<名前>/memory.json の
// 人間関係と日記）を読んで、住人の一覧・好感度の表・出来事の流れを表示する。ローカルからだけ見られる。
// 使い方: node scripts/society-dashboard.mjs [ポート=3300]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PERSONAS } from '../src/society/personas.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'society');
const port = Number(process.argv[2] || 3300);
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

function state() {
  const residents = PERSONAS.map((p) => {
    const pub = readJson(path.join(root, 'town', `${p.name}.json`)) ?? {};
    const mem = readJson(path.join(root, 'data', p.name, 'memory.json')) ?? {};
    const social = mem.social ?? {};
    return {
      name: p.name, call: p.call, mbti: p.mbti, title: p.title, job: pub.job ?? null,
      online: Date.now() - (pub.at ?? 0) < 90_000, doing: pub.doing ?? null, pos: pub.pos ?? null,
      health: pub.health ?? null, food: pub.food ?? null, house: pub.house?.stage ?? null, wants: pub.wants ?? [],
      notices: pub.notices ?? [], assignment: social.assignment ?? null,
      relations: Object.fromEntries(Object.entries(social.relations ?? {}).map(([k, v]) => [k, v.affinity])),
      diary: (social.diary ?? []).slice(-5), deaths: (mem.deaths ?? []).length,
    };
  });
  let events = [];
  try {
    const lines = fs.readFileSync(path.join(root, 'town', 'events.jsonl'), 'utf8').trim().split('\n');
    events = lines.slice(-200).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).reverse();
  } catch {}
  const counts = {};
  for (const e of events) counts[e.kind] = (counts[e.kind] ?? 0) + 1;
  return { at: new Date().toISOString(), residents, events, counts };
}

const PAGE = `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>MBTI 社会実験</title>
<style>
:root{--bg:#f7f7f5;--fg:#1d1d1b;--muted:#6b6b66;--card:#fff;--line:#e3e3de;--pos:#2f7d4f;--neg:#b3412e}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--fg:#ecece8;--muted:#9a9a94;--card:#1e1e1c;--line:#33332f;--pos:#5fbf86;--neg:#e0705c}}
body{margin:0;padding:16px;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,sans-serif}
h1{font-size:20px;margin:0 0 4px}h2{font-size:15px;margin:20px 0 8px}
.muted{color:var(--muted)}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:10px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 12px}
.off{opacity:.55}.tag{display:inline-block;border:1px solid var(--line);border-radius:6px;padding:0 6px;margin-right:4px;font-size:12px}
table{border-collapse:collapse;background:var(--card);font-size:12px}td,th{border:1px solid var(--line);padding:4px 6px;text-align:center;white-space:nowrap}
.wrap{overflow-x:auto}.ev{font-size:13px;padding:3px 0;border-bottom:1px solid var(--line)}
</style>
<h1>MBTI 社会実験</h1><div class="muted" id="at"></div>
<h2>住人</h2><div class="grid" id="res"></div>
<h2>好感度（行の人から見た列の人）</h2><div class="wrap"><table id="rel"></table></div>
<h2>出来事</h2><div id="cnt" class="muted"></div><div id="ev"></div>
<script>
const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]);
const HOUSE={foundation:'整地中',walls:'壁',roof:'屋根',door:'仕上げ',done:'完成'};
function color(v){if(v===undefined)return'';const a=Math.min(1,Math.abs(v)/60);return v>=0?'rgba(47,125,79,'+a*.6+')':'rgba(179,65,46,'+a*.6+')'}
async function tick(){
  const s=await (await fetch('/state.json')).json();
  document.getElementById('at').textContent='更新 '+new Date(s.at).toLocaleTimeString();
  document.getElementById('res').innerHTML=s.residents.map(r=>'<div class="card '+(r.online?'':'off')+'"><b>'+esc(r.call)+'</b> <span class="tag">'+r.mbti+'</span><span class="muted">'+esc(r.job??r.title)+'</span>'
    +'<div>'+(r.online?esc(r.doing??'考え中'):'留守')+'</div>'
    +'<div class="muted">体力 '+(r.health??'-')+' / 満腹 '+(r.food??'-')+' / 家 '+(HOUSE[r.house]??'なし')+' / 死亡 '+r.deaths+'</div>'
    +(r.wants.length?'<div class="muted">ほしい: '+esc(r.wants.join('・'))+'</div>':'')
    +(r.assignment&&r.assignment.until>Date.now()?'<div class="muted">任された仕事: '+esc(r.assignment.task)+'</div>':'')
    +(r.diary.length?'<div class="muted">日記: '+esc(r.diary.at(-1).text)+'</div>':'')+'</div>').join('');
  const names=s.residents.map(r=>r.name);
  document.getElementById('rel').innerHTML='<tr><th></th>'+s.residents.map(r=>'<th>'+esc(r.call)+'</th>').join('')+'</tr>'
    +s.residents.map(r=>'<tr><th>'+esc(r.call)+'</th>'+names.map(n=>{const v=r.relations[n];return '<td style="background:'+color(v)+'">'+(n===r.name?'—':v===undefined?'':v)+'</td>'}).join('')+'</tr>').join('');
  document.getElementById('cnt').textContent=Object.entries(s.counts).map(([k,v])=>k+' '+v).join(' / ');
  document.getElementById('ev').innerHTML=s.events.slice(0,120).map(e=>'<div class="ev"><span class="muted">'+new Date(e.at).toLocaleTimeString()+'</span> '+esc(e.text)+'</div>').join('');
}
tick();setInterval(tick,3000);
</script></html>`;

http.createServer((req, res) => {
  if (req.url === '/state.json') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(state()));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(PAGE);
}).listen(port, '127.0.0.1', () => console.log(`社会実験ダッシュボード: http://localhost:${port}/`));
