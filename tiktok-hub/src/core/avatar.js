// Viewer avatar -> pixel-art text component for a Minecraft text_display (shared by every game).
// Each pixel is the glyph U+E000 of the game's pixel font (a 10x10 white square in that game's resource pack)
// followed by U+E001 (a -1 space) so the squares touch; the text colour paints the square.
// createAvatar({ storage, font, svg, bg }) gives each game its own storage / font / placeholder picture.
import sharp from 'sharp';

export const SIZE = 24;
const PX = '';

function hex(r, g, b) {
  // 4 bits per channel: neighbours merge into longer runs, which keeps each RCON command short
  const q = (v) => Math.min(255, Math.round(v / 17) * 17);
  return '#' + [q(r), q(g), q(b)].map((v) => v.toString(16).padStart(2, '0')).join('');
}

async function toRows(input, bg) {
  const { data } = await sharp(input)
    .resize(SIZE, SIZE, { fit: 'cover' })
    .flatten({ background: bg })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const rows = [];
  for (let y = 0; y < SIZE; y++) {
    const parts = [];
    let color = null;
    let run = 0;
    for (let x = 0; x <= SIZE; x++) {
      const c = x < SIZE ? hex(data[(y * SIZE + x) * 3], data[(y * SIZE + x) * 3 + 1], data[(y * SIZE + x) * 3 + 2]) : null;
      if (c === color) { run++; continue; }
      if (color) parts.push(`{text:"${PX.repeat(run)}",color:"${color}"}`);
      color = c;
      run = 1;
    }
    rows.push(`[${parts.join(',')}]`);
  }
  return rows;
}

export function avatarUrl(user) {
  return user?.avatarThumb?.urlList?.[0] ?? user?.avatarMedium?.urlList?.[0]
    ?? user?.profilePicture?.url?.[0] ?? user?.profilePicture?.urls?.[0] ?? null;
}

// downloaded pictures are shared by every game (only the conversion differs by background colour)
const downloads = new Map(); // url -> Buffer
async function download(url) {
  if (downloads.has(url)) return downloads.get(url);
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  downloads.set(url, buf);
  if (downloads.size > 300) downloads.delete(downloads.keys().next().value);
  return buf;
}

export function createAvatar({ storage, font, svg, bg }) {
  const cache = new Map(); // url -> rows
  const PLACEHOLDER = '#placeholder';

  // rows of SNBT text components, one per pixel row; falls back to the game's placeholder picture
  async function avatarRows(url) {
    const key = url || PLACEHOLDER;
    if (cache.has(key)) return cache.get(key);
    let rows;
    try {
      if (!url) throw new Error('no url');
      rows = await toRows(await download(url), bg);
    } catch {
      rows = cache.get(PLACEHOLDER) ?? await toRows(Buffer.from(svg), bg);
      cache.set(PLACEHOLDER, rows);
      if (url) return rows; // don't cache a failed download, try again next time
    }
    cache.set(key, rows);
    if (cache.size > 300) cache.delete(cache.keys().next().value);
    return rows;
  }

  // RCON commands that put the avatar into storage <storage> text
  function avatarCommands(rows) {
    const cmds = [`data modify storage ${storage} text set value {text:"",font:"${font}",extra:[]}`];
    rows.forEach((row, i) => {
      cmds.push(`data modify storage ${storage} text.extra append value {text:"${i ? '\\n' : ''}",extra:${row}}`);
    });
    return cmds;
  }

  return { avatarRows, avatarCommands };
}
