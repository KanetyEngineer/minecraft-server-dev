// http://localhost:3008/ で建築の進み具合を確認できる簡単なページ（ローカルのみ）
import http from 'node:http';
import { recentLog } from './log.js';

export function startStatusServer(port, getAgent) {
  if (!port) return null;
  const server = http.createServer((req, res) => {
    const agent = getAgent();
    if (req.url === '/state.json') {
      let body = { connected: false };
      if (agent?.bot?.entity) {
        const b = agent.builder;
        body = {
          connected: true,
          status: agent.status,
          job: agent.job,
          position: agent.bot.entity.position.floored(),
          health: agent.bot.health,
          food: agent.bot.food,
          progress: b ? b.progress() : null,
          layer: b ? `${b.layer + 1}/${b.size.y}` : null,
          missing: b ? Object.fromEntries(b.missing) : null,
          inventory: agent.bot.inventory.items().map((i) => `${i.name}×${i.count}`),
        };
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body, null, 2));
      return;
    }
    if (req.url?.startsWith('/log')) {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(recentLog().join('\n'));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><meta charset="utf-8"><title>BuilderBot</title>
<style>body{font-family:system-ui,sans-serif;margin:16px;background:#111;color:#eee}pre{white-space:pre-wrap;background:#1c1c1c;padding:12px;border-radius:8px}</style>
<h1>BuilderBot の状態</h1><pre id="s">読み込み中…</pre>
<h2>ログ（直近 400 行）</h2><pre id="l" style="max-height:60vh;overflow:auto">読み込み中…</pre>
<script>
async function t(){try{const r=await fetch('/state.json');document.getElementById('s').textContent=JSON.stringify(await r.json(),null,2)}catch(e){}}
async function g(){try{const r=await fetch('/log.txt');const el=document.getElementById('l');const atEnd=el.scrollTop+el.clientHeight>=el.scrollHeight-20;el.textContent=await r.text();if(atEnd)el.scrollTop=el.scrollHeight}catch(e){}}
t();g();setInterval(t,2000);setInterval(g,2000)</script>`);
  });
  server.listen(port, '127.0.0.1');
  return server;
}
