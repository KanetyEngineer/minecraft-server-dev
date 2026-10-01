// エンダーアイの飛んだ方向 2 本から要塞の位置を推定する（三角測量）。
// 各 throw は { x, z, dx, dz }（投げた地点と水平方向ベクトル）。

export function intersectRays(a, b) {
  const det = a.dx * b.dz - a.dz * b.dx;
  if (Math.abs(det) < 1e-6) return null; // ほぼ平行
  const t = ((b.x - a.x) * b.dz - (b.z - a.z) * b.dx) / det;
  const u = ((b.x - a.x) * a.dz - (b.z - a.z) * a.dx) / det;
  if (t < 0 || u < 0) return null; // 後ろ側で交わる
  return { x: a.x + a.dx * t, z: a.z + a.dz * t };
}

// 3 本以上あれば全ペアの交点の中央値をとって誤差を減らす
export function estimateStronghold(throws) {
  const pts = [];
  for (let i = 0; i < throws.length; i++) {
    for (let j = i + 1; j < throws.length; j++) {
      const p = intersectRays(throws[i], throws[j]);
      if (p) pts.push(p);
    }
  }
  if (pts.length === 0) return null;
  const med = (arr) => {
    const s = [...arr].sort((m, n) => m - n);
    return s[Math.floor(s.length / 2)];
  };
  return { x: Math.round(med(pts.map((p) => p.x))), z: Math.round(med(pts.map((p) => p.z))) };
}

// 2 本の測定線のなす角（度）。小さすぎる場合はもう一度横に移動して測り直す。
export function rayAngleDeg(a, b) {
  const la = Math.hypot(a.dx, a.dz);
  const lb = Math.hypot(b.dx, b.dz);
  const c = (a.dx * b.dx + a.dz * b.dz) / (la * lb);
  return (Math.acos(Math.max(-1, Math.min(1, c))) * 180) / Math.PI;
}
