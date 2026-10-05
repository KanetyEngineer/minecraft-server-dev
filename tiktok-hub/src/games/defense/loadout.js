// Loadout sets ("装備セット"): what a defender gets when a game starts, on joining mid-game and on "配り直す".
// The streamer prepares sets in the panel (guns, grenades, armor, extra items, endless effects) and picks one per field.
// The app writes each field's list to storage td:cfg lo.fN; td:loadout_self (data pack) gives it.

export const ARMOR_MATERIALS = {
  '': 'なし', leather: '革', golden: '金', chainmail: 'チェーン', copper: '銅', iron: '鉄', diamond: 'ダイヤ', netherite: 'ネザライト',
};
export const ARMOR_SLOTS = [
  ['head', 'armor.head', 'helmet', '頭'], ['chest', 'armor.chest', 'chestplate', '胴'],
  ['legs', 'armor.legs', 'leggings', '脚'], ['feet', 'armor.feet', 'boots', '足'],
];
export const EFFECTS = {
  speed: '移動速度上昇', resistance: '耐性', strength: '攻撃力上昇', regeneration: '再生能力', health_boost: '体力増強',
  absorption: '衝撃吸収', jump_boost: '跳躍力上昇', night_vision: '暗視', fire_resistance: '火炎耐性', haste: '採掘速度上昇',
};
export const ITEM_SLOTS = { '': '持ち物', 'weapon.offhand': 'オフハンド' };
// handy picks for the "その他のアイテム" rows (any item id can still be typed)
export const ITEM_SUGGESTIONS = {
  'minecraft:golden_apple': '金のリンゴ', 'minecraft:enchanted_golden_apple': 'エンチャントされた金のリンゴ',
  'minecraft:cooked_beef': 'ステーキ', 'minecraft:bread': 'パン', 'minecraft:shield': '盾', 'minecraft:totem_of_undying': '不死のトーテム',
  'minecraft:netherite_sword': 'ネザライトの剣', 'minecraft:diamond_sword': 'ダイヤの剣', 'minecraft:netherite_axe': 'ネザライトの斧',
  'minecraft:mace': 'メイス', 'minecraft:trident': 'トライデント', 'minecraft:bow': '弓', 'minecraft:crossbow': 'クロスボウ',
  'minecraft:arrow': '矢', 'minecraft:ender_pearl': 'エンダーパール', 'minecraft:snowball': '雪玉', 'minecraft:cobweb': 'クモの巣',
  'minecraft:wind_charge': 'ウィンドチャージ', 'minecraft:spyglass': '望遠鏡',
};
export const MAX_PRESETS = 20;
export const MAX_ITEMS = 12;
export const MAX_EFFECTS = 6;

const int = (v, min, max, def) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
};
const str = (v, max = 200) => String(v ?? '').trim().slice(0, max);
const ITEM_ID = /^([a-z0-9_.-]+:)?[a-z0-9_./-]+$/;
const ENCH = /^[a-z_]+:\d{1,3}(,[a-z_]+:\d{1,3})*$/;
const armorItem = (mat, piece) => `minecraft:${mat}_${piece}`;

export function defaultPresets(weapons, legacy = {}) {
  const has = (w) => Object.hasOwn(weapons, w);
  const guns = (...ids) => ids.filter(has);
  const p = (id, name, more) => ({
    id, name, guns: [], grenades: 0, ammoMags: 8, armor: { head: '', chest: '', legs: '', feet: '' },
    protection: 0, unbreakable: false, items: [], effects: [], ...more,
  });
  return [
    p('standard', '標準', {
      guns: legacy.loadout?.length ? legacy.loadout.filter(has) : guns('pointblank:m4a1', 'pointblank:glock17'),
      grenades: legacy.grenades ?? 4, ammoMags: legacy.ammoMags ?? 8,
    }),
    p('sniper', 'スナイパー', {
      guns: guns('pointblank:l96a1', 'pointblank:mk14ebr', 'pointblank:m9'), grenades: 2, ammoMags: 10,
      armor: { head: 'leather', chest: 'leather', legs: 'leather', feet: 'leather' },
      effects: [{ id: 'night_vision', amp: 0 }],
    }),
    p('assault', '突撃（ショットガン）', {
      guns: guns('pointblank:spas12', 'pointblank:mp7', 'pointblank:deserteagle'), grenades: 6, ammoMags: 10,
      armor: { head: 'iron', chest: 'iron', legs: 'iron', feet: 'iron' }, effects: [{ id: 'speed', amp: 0 }],
    }),
    p('melee', '近接', {
      guns: guns('pointblank:glock17'), grenades: 2, ammoMags: 6,
      armor: { head: 'diamond', chest: 'diamond', legs: 'diamond', feet: 'diamond' }, protection: 2,
      items: [
        { id: 'minecraft:netherite_sword', count: 1, ench: 'sharpness:5,sweeping_edge:3', slot: '' },
        { id: 'minecraft:shield', count: 1, ench: '', slot: 'weapon.offhand' },
        { id: 'minecraft:golden_apple', count: 8, ench: '', slot: '' },
      ],
      effects: [{ id: 'speed', amp: 1 }, { id: 'strength', amp: 0 }],
    }),
    p('heavy', '重装（機関銃）', {
      guns: guns('pointblank:m249', 'pointblank:m32mgl', 'pointblank:m1911a1'), grenades: 8, ammoMags: 6,
      armor: { head: 'netherite', chest: 'netherite', legs: 'netherite', feet: 'netherite' }, protection: 4, unbreakable: true,
      items: [{ id: 'minecraft:cooked_beef', count: 32, ench: '', slot: '' }],
      effects: [{ id: 'resistance', amp: 0 }],
    }),
  ];
}

function validatePreset(raw, weapons, i) {
  const r = raw ?? {};
  const name = str(r.name, 24) || `セット${i + 1}`;
  const id = str(r.id, 32).replace(/[^\w-]/g, '') || `set${i + 1}`;
  const isGun = (w) => typeof w === 'string' && Object.hasOwn(weapons, w) && weapons[w].type === 'gun';
  const armor = {};
  for (const [k] of ARMOR_SLOTS) armor[k] = Object.hasOwn(ARMOR_MATERIALS, r.armor?.[k]) ? r.armor[k] : '';
  const items = [];
  for (const it of (r.items ?? []).slice(0, MAX_ITEMS)) {
    let itemId = str(it?.id, 80).toLowerCase();
    if (!itemId) continue;
    if (!ITEM_ID.test(itemId)) throw new Error(`装備セット「${name}」のアイテム "${itemId}" の書き方が違います（例: minecraft:golden_apple）`);
    if (!itemId.includes(':')) itemId = `minecraft:${itemId}`;
    const ench = str(it.ench, 120).replace(/\s+/g, '').replace(/minecraft:/g, '').toLowerCase();
    if (ench && !ENCH.test(ench)) throw new Error(`装備セット「${name}」の ${itemId} のエンチャントは「sharpness:5,unbreaking:3」の形で書いてください`);
    items.push({ id: itemId, count: int(it.count, 1, 256, 1), ench, slot: Object.hasOwn(ITEM_SLOTS, it.slot) ? it.slot : '' });
  }
  const effects = [];
  for (const e of (r.effects ?? []).slice(0, MAX_EFFECTS)) {
    if (Object.hasOwn(EFFECTS, e?.id) && !effects.some((x) => x.id === e.id)) effects.push({ id: e.id, amp: int(e.amp, 0, 4, 0) });
  }
  return {
    id, name, guns: [...new Set((r.guns ?? []).filter(isGun))].slice(0, 9),
    grenades: int(r.grenades, 0, 64, 0), ammoMags: int(r.ammoMags, 1, 64, 8), armor,
    protection: int(r.protection, 0, 4, 0), unbreakable: Boolean(r.unbreakable), items, effects,
  };
}

// fills out.weapons.presets / fieldPresets (and the old loadout/grenades = the first field's set)
export function validateLoadouts(c, out, weapons, maxF) {
  let presets = Array.isArray(c.weapons?.presets) && c.weapons.presets.length
    ? c.weapons.presets.slice(0, MAX_PRESETS).map((p, i) => validatePreset(p, weapons, i))
    : defaultPresets(weapons, { loadout: c.weapons?.loadout, grenades: c.weapons?.grenades, ammoMags: c.weapons?.ammoMags }).map((p, i) => validatePreset(p, weapons, i));
  const seen = new Set();
  presets = presets.map((p, i) => {
    let id = p.id;
    while (seen.has(id)) id = `${p.id}-${i + 1}`;
    seen.add(id);
    return { ...p, id };
  });
  const ids = presets.map((p) => p.id);
  const fp = Array.isArray(c.weapons?.fieldPresets) ? c.weapons.fieldPresets : [];
  out.weapons.presets = presets;
  out.weapons.fieldPresets = Array.from({ length: maxF }, (_, i) => (ids.includes(fp[i]) ? fp[i] : ids[0]));
  const first = presets.find((p) => p.id === out.weapons.fieldPresets[0]);
  out.weapons.loadout = first.guns;
  out.weapons.grenades = first.grenades;
}

// the list the data pack gives: [{id,count}|{id,count,slot}|{eff,amp}]
export function presetEntries(p, weapons) {
  const out = [];
  const order = [...p.guns].sort((a, b) => (weapons[b].mag ?? 0) - (weapons[a].mag ?? 0));
  for (const w of order) out.push(`{id:"${w}",count:1}`);
  if (p.grenades > 0) out.push(`{id:"pointblank:grenade",count:${p.grenades}}`);
  const ammo = new Map();
  for (const w of p.guns) if (weapons[w].ammo) ammo.set(weapons[w].ammo, (ammo.get(weapons[w].ammo) ?? 0) + Math.max(1, (weapons[w].mag ?? 1) * p.ammoMags));
  for (const it of p.items) if (!it.slot) out.push(`{id:"${it.id}${comps(it.ench, false)}",count:${it.count}}`);
  for (const [a, n] of ammo) out.push(`{id:"${a}",count:${n}}`);
  for (const [k, slot, piece] of ARMOR_SLOTS) {
    const mat = p.armor[k];
    if (!mat) continue;
    const ench = p.protection ? `protection:${p.protection}` : '';
    out.push(`{id:"${armorItem(mat, piece)}${comps(ench, p.unbreakable)}",count:1,slot:"${slot}"}`);
  }
  for (const it of p.items) if (it.slot) out.push(`{id:"${it.id}${comps(it.ench, false)}",count:${it.count},slot:"${it.slot}"}`);
  for (const e of p.effects) out.push(`{eff:"minecraft:${e.id}",amp:${e.amp}}`);
  return out;
}

function comps(ench, unbreakable) {
  const c = [];
  if (ench) c.push(`enchantments={${ench}}`);
  if (unbreakable) c.push('unbreakable={}');
  return c.length ? `[${c.join(',')}]` : '';
}

// one line per preset for the panel / logs
export function presetSummary(p, weapons) {
  const parts = [];
  if (p.guns.length) parts.push(p.guns.map((w) => weapons[w]?.label ?? w).join('・'));
  if (p.grenades) parts.push(`手りゅう弾×${p.grenades}`);
  const mats = ARMOR_SLOTS.map(([k]) => p.armor[k]).filter(Boolean);
  if (mats.length) parts.push(`防具: ${[...new Set(mats)].map((m) => ARMOR_MATERIALS[m]).join('・')}${p.protection ? ` 軽減${p.protection}` : ''}`);
  if (p.items.length) parts.push(p.items.map((it) => `${ITEM_SUGGESTIONS[it.id] ?? it.id.replace('minecraft:', '')}×${it.count}`).join('・'));
  if (p.effects.length) parts.push(p.effects.map((e) => `${EFFECTS[e.id]}${e.amp ? e.amp + 1 : ''}`).join('・'));
  return parts.join(' / ') || '何も持たない';
}
