import test from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import { nearDanger } from '../src/skills/common.js';

test('廃坑として記録した場所から 24 マス以内は危険とみなす', () => {
  const ctx = { state: { dangerZones: [new Vec3(0, -20, 0)] } };
  assert.equal(nearDanger(ctx, new Vec3(10, -20, 10)), true);
  assert.equal(nearDanger(ctx, new Vec3(30, -20, 0)), false);
  assert.equal(nearDanger({ state: {} }, new Vec3(0, 0, 0)), false);
});
