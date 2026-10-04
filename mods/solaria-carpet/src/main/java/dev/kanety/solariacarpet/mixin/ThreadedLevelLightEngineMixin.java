package dev.kanety.solariacarpet.mixin;

import dev.kanety.solariacarpet.LightSuppression;
import dev.kanety.solariacarpet.SolariaCarpetSettings;
import net.minecraft.server.level.ThreadedLevelLightEngine;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Unique;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/**
 * runUpdate handles one batch of up to 1000 queued light tasks. It runs once per tick from tryScheduleUpdate and
 * again inline whenever 1000 tasks are queued, so in vanilla the queue can never build up. With lightSuppression on,
 * batches beyond the per-tick budget are skipped and their tasks stay queued.
 */
@Mixin(ThreadedLevelLightEngine.class)
public abstract class ThreadedLevelLightEngineMixin {
    @Unique private long solariacarpet$tick = -1;
    @Unique private int solariacarpet$batches;

    @Inject(method = "runUpdate", at = @At("HEAD"), cancellable = true)
    private void solariacarpet$budget(CallbackInfo ci) {
        if (!SolariaCarpetSettings.lightSuppression) return;
        long now = LightSuppression.tick();
        if (now != solariacarpet$tick) {
            solariacarpet$tick = now;
            solariacarpet$batches = 0;
        }
        if (solariacarpet$batches >= LightSuppression.batchesPerTick()) {
            ci.cancel();
            return;
        }
        solariacarpet$batches++;
    }
}
