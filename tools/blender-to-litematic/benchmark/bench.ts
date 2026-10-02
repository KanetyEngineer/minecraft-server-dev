import fs from 'fs';
import { PALETTE_ALL_RELEASE } from '../res/palettes/all';
import { StatusHandler } from '../src/status';
import { ColourSpace } from '../src/util';
import { AppPaths, PathUtil } from '../src/util/path_util';
import { Vector3 } from '../src/vector';
import { WorkerClient } from '../src/worker_client';

// usage: bench.ts <model.glb> <size> <voxeliser> <dithering> <out.litematic>
void (async function main() {
    AppPaths.Get.setBaseDir(PathUtil.join(__dirname, '../..'));
    const [model, size, voxeliser, dithering, out] = process.argv.slice(2);
    const buf = fs.readFileSync(model);
    const worker = WorkerClient.Get;
    const t: Record<string, number> = {};
    let t0 = performance.now();
    await worker.import({ file: new File([buf], model.split('/').pop()!), rotation: new Vector3(0, 0, 0) });
    t.import = performance.now() - t0; StatusHandler.Get.dump().clear();
    t0 = performance.now();
    worker.voxelise({
        constraintAxis: 'y', voxeliser: voxeliser as any, size: Number(size),
        useMultisampleColouring: true, voxelOverlapRule: 'average', enableAmbientOcclusion: false,
    });
    t.voxelise = performance.now() - t0; StatusHandler.Get.dump().clear();
    t0 = performance.now();
    worker.assign({
        textureAtlas: 'vanilla', blockPalette: PALETTE_ALL_RELEASE, dithering: dithering as any,
        ditheringMagnitude: 32, colourSpace: ColourSpace.RGB, fallable: 'replace-falling',
        resolution: 32, calculateLighting: false, lightThreshold: 0, contextualAveraging: true, errorWeight: 0.2,
    });
    t.assign = performance.now() - t0; StatusHandler.Get.dump().clear();
    t0 = performance.now();
    const res = worker.export({ exporter: 'litematic' });
    t.export = performance.now() - t0;
    const f: any = res.files;
    fs.writeFileSync(out, f.content);
    console.log(JSON.stringify({ times_ms: t, file: out }));
})();
