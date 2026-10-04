import test from 'node:test';
import assert from 'node:assert/strict';
import { intersectRays, estimateStronghold, rayAngleDeg } from '../src/util/geometry.js';

const ray = (x, z, tx, tz) => {
  const dx = tx - x; const dz = tz - z; const l = Math.hypot(dx, dz);
  return { x, z, dx: dx / l, dz: dz / l };
};

test('2 本の測定線から要塞の位置を求める', () => {
  const target = { x: 1200, z: -800 };
  const p = intersectRays(ray(0, 0, target.x, target.z), ray(150, 150, target.x, target.z));
  assert.ok(Math.abs(p.x - target.x) < 1e-6 && Math.abs(p.z - target.z) < 1e-6);
});

test('平行・後ろ向きの線は null', () => {
  assert.equal(intersectRays({ x: 0, z: 0, dx: 1, dz: 0 }, { x: 0, z: 5, dx: 1, dz: 0 }), null);
  assert.equal(intersectRays({ x: 0, z: 0, dx: 1, dz: 0 }, { x: 10, z: 5, dx: 0, dz: 1 }), null);
});

test('3 本以上は中央値で誤差に強い', () => {
  const t = { x: -500, z: 1500 };
  const throws = [ray(0, 0, t.x, t.z), ray(200, 0, t.x, t.z), ray(0, 200, t.x + 40, t.z)];
  const est = estimateStronghold(throws);
  assert.ok(Math.hypot(est.x - t.x, est.z - t.z) < 60);
});

test('角度', () => {
  assert.equal(Math.round(rayAngleDeg({ dx: 1, dz: 0 }, { dx: 0, dz: 1 })), 90);
});

test('要塞の推定位置はチャンク内の (4, 4)（スターター階段）に合わせる', async () => {
  const { toStarterStaircase } = await import('../src/skills/stronghold.js');
  assert.deepEqual(toStarterStaircase({ x: 1000, z: -1000 }), { x: 996, z: -1004 });
  assert.deepEqual(toStarterStaircase({ x: 15, z: 16 }), { x: 4, z: 20 });
});