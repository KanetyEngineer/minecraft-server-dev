// http://localhost:3007/ で今の状態を確認できる簡単なページ（ローカルのみ）
import http from 'node:http';
import { snapshot } from './world/perception.js';

export function startStatusServer(port, getAgent) {
  if (!port) return null;
  const server = http.createServer((req, res) => {
    const agent = getAgent();
    if (req.url === '/state.json') {
      let body = { connected: false };
      if (agent?.bot?.entity) {
        body = {
          connected: true,
          current: agent.current?.name ?? null,
          lastDecision: agent.lastDecision,
          history: agent.history.slice(-15),
          planner: agent.planner.usingLLM ? 'llm' : 'rules',
          snapshot: snapshot(agent.bot, agent.memory, agent.cfg),
        };
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body, null, 2));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><meta charset="utf-8"><title>DragonBot</title>
<style>body{font-family:system-ui,sans-serif;margin:16px;background:#111;color:#eee}pre{white-space:pre-wrap;background:#1c1c1c;padding:12px;border-radius:8px}</style>
<h1>DragonBot の状態</h1><pre id="s">読み込み中…</pre>
<script>async function t(){try{const r=await fetch('/state.json');document.getElementById('s').textContent=JSON.stringify(await r.json(),null,2)}catch(e){}}t();setInterval(t,2000)</script>`);
  });
  server.listen(port, '127.0.0.1');
  return server;
}
