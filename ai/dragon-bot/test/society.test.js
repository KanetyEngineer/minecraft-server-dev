import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fakeBot } from './fakebot.js';
import { PERSONAS, traitsOf, compatibility, personaByName } from '../src/society/personas.js';
import { Town, Relations, plotCenter } from '../src/society/town.js';
import { Society } from '../src/society/core.js';
import { options } from '../src/society/planner.js';
import { housePlan } from '../src/society/skills.js';
import { voice } from '../src/society/dialogue.js';
import { SOCIETY_SKILL_MAP } from '../src/society/skillset.js';

function makeSociety(name, dir) {
  const persona = personaByName(name);
  const data = { places: {}, notes: [], deaths: [], flags: {} };
  const memory = { data, save() {}, setFlag() {}, flag: () => undefined };
  const town = new Town({ dir, name, persona });
  const rel = new Relations(memory, persona);
  const cfg = { llm: { chat: false, model: 'x', effort: 'low' } };
  return new Society({ persona, town, rel, cfg });
}

function botWith(items, { isDay = true, food = 20 } = {}) {
  const b = fakeBot(items, { isDay });
  b.food = food;
  b.username = 'me';
  b.players = {};
  b.entity = { position: { x: 0, y: 64, z: 0, distanceTo: () => 0 } };
  return b;
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'society-'));

test('10 人の名前は 16 文字以内で、MBTI がすべて違う', () => {
  assert.equal(PERSONAS.length, 10);
  assert.equal(new Set(PERSONAS.map((p) => p.mbti)).size, 10);
  for (const p of PERSONAS) assert.match(p.name, /^[A-Za-z0-9_]{3,16}$/);
});

test('MBTI から傾向を出す', () => {
  assert.ok(traitsOf('ENFP').extraversion > traitsOf('INTJ').extraversion);
  assert.ok(traitsOf('ESTJ').leadership >= 0.8);
  assert.ok(compatibility('INFJ', 'ENFP') > compatibility('INFJ', 'ESTP'));
});

test('区画は広場のまわりに重ならず並ぶ', () => {
  const plaza = { x: 100, z: -50 };
  const cs = PERSONAS.map((p) => plotCenter(plaza, p.id));
  for (let i = 0; i < cs.length; i++) for (let j = i + 1; j < cs.length; j++) {
    assert.ok(Math.hypot(cs[i].x - cs[j].x, cs[i].z - cs[j].z) > 8, '家どうしが近すぎる');
  }
});

test('家の設計: 壁 46・屋根 25・扉 2 マス', () => {
  const plan = housePlan({ x: 0, y: 64, z: 0, door: [0, -1] });
  assert.equal(plan.walls.length, 46);
  assert.equal(plan.roof.length, 25);
  assert.equal(plan.doorCells.length, 2);
  assert.ok(plan.doorCells.every((p) => p.z === -2 && p.x === 0));
});

test('夜で家があれば帰る、道具が無ければ木から', () => {
  const dir = tmp();
  const soc = makeSociety('Kenji_ISTJ', dir);
  soc.town.profile.house = { x: 0, y: 64, z: 0, door: [0, 1], stage: 'done' };
  assert.equal(options(botWith({ stone_pickaxe: 1 }, { isDay: false }), soc)[0].skill, 'goHome');
  soc.town.profile.house = null;
  assert.equal(options(botWith({}), soc)[0].skill, 'gatherWood');
});

test('外向的な人は話さないでいると話したくなる', () => {
  const dir = tmp();
  const ext = makeSociety('Hinata_ENFP', dir);
  const intro = makeSociety('Takumi_ISTP', dir);
  ext.town.publish(botWith({}));
  intro.town.publish(botWith({}));
  ext.rel.data.lastTalkAt = Date.now() - 20 * 60_000;
  intro.rel.data.lastTalkAt = Date.now() - 20 * 60_000;
  const s = (soc) => options(botWith({ stone_pickaxe: 1, cooked_beef: 10 }), soc).find((o) => o.skill === 'socialize')?.score ?? 0;
  assert.ok(s(ext) > s(intro));
});

test('集会で仕事を任されたら、引き受けるか断るかを返す', async () => {
  const dir = tmp();
  const soc = makeSociety('Mio_ESFJ', dir);
  const b = botWith({});
  const r = await soc.onChat(b, 'Daichi_ESTJ', '📋 ミオは食料集めをお願い！');
  assert.ok(r);
  const a = soc.rel.data.assignment;
  if (a) assert.equal(a.task, 'food');
});

test('口調: 一人称と語尾', () => {
  const nana = personaByName('Nana_ESFP');
  assert.equal(voice(nana, '{I}も行く。'), 'ナナも行く〜！');
});

test('社会モードのスキル表にエンドラ専用スキルが無い', () => {
  assert.ok(SOCIETY_SKILL_MAP.buildHouse && SOCIETY_SKILL_MAP.gatherWood && SOCIETY_SKILL_MAP.socialize);
  assert.equal(SOCIETY_SKILL_MAP.fightDragon, undefined);
});
