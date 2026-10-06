// Small helpers shared by the hub and every game module.
import fs from 'node:fs';

export function send(res, code, type, body) {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

export const json = (res, obj, code = 200) => send(res, code, 'application/json; charset=utf-8', JSON.stringify(obj));

// the request body as JSON ({} when empty or broken); the parsed body is kept so it can be read twice
export function readBody(req, limit = 400000) {
  if (req._body) return Promise.resolve(req._body);
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > limit) req.destroy(); });
    req.on('end', () => {
      try { req._body = JSON.parse(b || '{}'); } catch { req._body = {}; }
      resolve(req._body);
    });
  });
}

// names go into a JSON text inside a macro: keep them short and free of quoting characters
export function clean(s, max = 24) {
  return String(s ?? '').replace(/["\\$\u0000-\u001f{}]/g, '').trim().slice(0, max) || '視聴者';
}

export function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

// gift -> actions: a gift with its own rule repeats (combo) up to repeatSmallUpTo; anything else goes by the
// coin total into the highest tier it reaches ("random" = one of them, "all" = every one)
export function actionsForGift(rules, giftName, coinsEach, repeat) {
  const named = rules.byName?.[giftName];
  if (named) return Array(Math.max(1, Math.min(repeat, rules.repeatSmallUpTo ?? 1))).fill(named);
  const total = coinsEach * repeat;
  const tier = [...rules.tiers].reverse().find((t) => total >= t.minCoins);
  if (!tier) return [];
  return tier.pick === 'all' ? [...tier.actions] : [pick(tier.actions)];
}

// a big gift's action goes ahead of the ordinary ones still waiting (but after other big ones)
export function pushQueued(q, item, first) {
  item.first = Boolean(first);
  const i = first ? q.findIndex((x) => !x.first) : -1;
  if (i < 0) q.push(item); else q.splice(i, 0, item);
}

export const readJson = (file, def) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return def; }
};

export const cleanTikTok = (v) => String(v ?? '').trim().slice(0, 64)
  .replace(/^https?:\/\/(www\.)?tiktok\.com\//, '').replace(/^@/, '').replace(/\/live\/?$/, '').replace(/\/$/, '');

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
