// TikTok's gift catalog (names, coin prices, pictures) for the gift list and the editor.
// The list comes from TikTok's public web gift list (no API key needed) and is kept in state/gift-catalog.json,
// so it also works offline after the first fetch. Gifts that arrive on a LIVE add / refresh their entry too.
// Pictures are fetched once through the hub and kept in state/gift-img/, so the OBS list can draw them
// on a canvas (same origin) and still be saved as a PNG.
import fs from 'node:fs';
import path from 'node:path';
import { readJson } from './util.js';
import { KNOWN_GIFTS } from './gifts.js';

const LIST_URL = 'https://webcast.tiktok.com/webcast/gift/list/?aid=1988&app_name=tiktok_web&device_platform=web_pc&app_language=ja-JP&language=ja&region=JP';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';
const DAY = 24 * 3600 * 1000;
const lc = (s) => String(s ?? '').trim().toLowerCase();

export function createGiftCatalog({ stateDir, log }) {
  const file = path.join(stateDir, 'gift-catalog.json');
  const imgDir = path.join(stateDir, 'gift-img');
  fs.mkdirSync(imgDir, { recursive: true });
  // { at, gifts: { <id>: { id, name, coins, img } } }
  const cat = readJson(file, null) ?? { at: 0, gifts: {} };
  let byName = new Map();
  const reindex = () => {
    byName = new Map();
    // the cheapest gift wins when two share a name
    for (const g of Object.values(cat.gifts).sort((a, b) => b.coins - a.coins)) byName.set(lc(g.name), g);
  };
  reindex();
  const save = () => {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cat), 'utf8');
    fs.renameSync(tmp, file);
  };

  async function refresh() {
    try {
      const r = await fetch(LIST_URL, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30000) });
      const j = await r.json();
      const list = j?.data?.gifts;
      if (!Array.isArray(list) || !list.length) throw new Error('一覧が空でした');
      for (const g of list) {
        const img = g.image?.url_list?.[0] ?? g.icon?.url_list?.[0];
        if (!g.id || !g.name) continue;
        cat.gifts[g.id] = { id: String(g.id), name: String(g.name), coins: Number(g.diamond_count) || 0, img: img || cat.gifts[g.id]?.img || '' };
      }
      cat.at = Date.now();
      save();
      reindex();
      log('info', `TikTok のギフト一覧を読み込みました（${list.length} 種）`);
    } catch (err) {
      log('warn', `TikTok のギフト一覧を読み込めませんでした（${err.message}）。${Object.keys(cat.gifts).length ? '前に読んだ一覧を使います' : '画像なしで表示します'}`);
    }
  }

  // a gift that arrived on a LIVE (its picture may be newer than the list, or it may not be in the list)
  function learn(d) {
    const g = d?.gift ?? d?.giftDetails ?? {};
    const id = String(d?.giftId ?? g.id ?? '');
    const name = g.name ?? g.giftName ?? d?.extendedGiftInfo?.name;
    const img = g.image?.url_list?.[0] ?? g.image?.urlList?.[0] ?? g.giftImage?.giftPictureUrl ?? d?.giftPictureUrl ?? '';
    if (!id || id === 'undefined' || !name || !img || cat.gifts[id]?.img === img) return;
    cat.gifts[id] = { id, name: String(name), coins: Number(g.diamondCount ?? g.diamond_count) || cat.gifts[id]?.coins || 0, img };
    reindex();
    save();
  }

  // a gift name as written in the gift rules (English or Japanese) -> catalog entry
  function find(name) {
    const hit = byName.get(lc(name));
    if (hit) return hit;
    const k = KNOWN_GIFTS.find((x) => x.ja === name || lc(x.en) === lc(name));
    return k ? byName.get(lc(k.en)) ?? null : null;
  }

  // GET /gift-img/<id>: the picture, from the cache or fetched once
  async function serveImage(res, id) {
    if (!/^\d{1,20}$/.test(id)) { res.writeHead(404); return res.end(); }
    const cached = fs.readdirSync(imgDir).find((f) => f.startsWith(`${id}.`));
    const types = { webp: 'image/webp', png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif' };
    if (cached) {
      res.writeHead(200, { 'Content-Type': types[cached.split('.').pop()] ?? 'application/octet-stream', 'Cache-Control': 'max-age=86400' });
      return res.end(fs.readFileSync(path.join(imgDir, cached)));
    }
    const url = cat.gifts[id]?.img;
    if (!url) { res.writeHead(404); return res.end(); }
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const type = (r.headers.get('content-type') ?? '').split(';')[0];
      const ext = Object.entries(types).find(([, t]) => t === type)?.[0] ?? 'webp';
      const buf = Buffer.from(await r.arrayBuffer());
      fs.writeFileSync(path.join(imgDir, `${id}.${ext}`), buf);
      res.writeHead(200, { 'Content-Type': types[ext], 'Cache-Control': 'max-age=86400' });
      return res.end(buf);
    } catch (err) {
      log('warn', `ギフトの画像を読み込めませんでした（${cat.gifts[id].name}: ${err.message}）`);
      res.writeHead(404);
      return res.end();
    }
  }

  // the whole catalog for the editor's gift picker (cheapest first)
  const list = () => Object.values(cat.gifts).map(({ id, name, coins }) => ({ id, name, coins, ja: KNOWN_GIFTS.find((k) => lc(k.en) === lc(name))?.ja ?? '' }))
    .sort((a, b) => a.coins - b.coins || a.name.localeCompare(b.name));

  return {
    find, learn, list, serveImage,
    start() {
      if (Date.now() - cat.at > DAY / 2) refresh();
      setInterval(refresh, DAY).unref?.();
    },
  };
}
