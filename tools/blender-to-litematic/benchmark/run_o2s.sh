#!/bin/bash
cd "$(dirname "$0")/../o2s"
for m in skull scene; do for s in 64 128 256; do for v in ray-based bvh-ray; do
  node -r ./tools/hooks.js -r ts-node/register/transpile-only tools/bench.ts ../bench/models/$m.glb $s $v ordered ../bench/out/o2s_${m}_${s}_${v}.litematic 2>/dev/null | grep times_ms > ../bench/out/o2s_${m}_${s}_${v}.json
  echo "$m $s $v $(cat ../bench/out/o2s_${m}_${s}_${v}.json)"
done; done; done
