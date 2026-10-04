package dev.kanety.solariacarpet.mixin;

import dev.kanety.solariacarpet.LightSuppression;
import dev.kanety.solariacarpet.SolariaCarpetSettings;
import net.minecraft.server.level.ThreadedLevelLightEngine;
import it.unimi.dsi.fastutil.objects.ObjectList;
import net.minecraft.util.thread.ConsecutiveExecutor;
import org.spongepowered.asm.mixin.Final;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Shadow;
import org.spongepowered.asm.mixin.Unique;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/**
 * runUpdate handles one batch of up to 1000 queued light tasks. It runs from tryScheduleUpdate and again inline
 * whenever 1000 tasks are queued, so in vanilla the queue can never build up. With lightSuppression on, batches
 * beyond the budget of the current 50 ms window are skipped and their tasks stay queued.
 */
@Mixin(ThreadedLevelLightEngine.class)
public abstract class ThreadedLevelLightEngineMixin {
    @Shadow @Final private ConsecutiveExecutor consecutiveExecutor;
    @Shadow @Final private ObjectList<?> lightTasks;

    @Shadow
    private void runUpdate() {
        throw new AssertionError();
    }

    @Unique private long solariacarpet$windowStart;
    @Unique private int solariacarpet$batches;

    @Inject(method = "runUpdate", at = @At("HEAD"), cancellable = true)
    private void solariacarpet$budget(CallbackInfo ci) {
        if (!SolariaCarpetSettings.lightSuppression) return;
        long now = System.nanoTime();
        if (now - solariacarpet$windowStart >= LightSuppression.WINDOW_NANOS) {
            solariacarpet$windowStart = now;
            solariacarpet$batches = 0;
        }
        if (solariacarpet$batches >= LightSuppression.batchesPerWindow()) {
            ci.cancel();
            return;
        }
        solariacarpet$batches++;
    }

    /** After the rule is turned off, keep going until a backlog left over from suppression is gone. */
    @Inject(method = "runUpdate", at = @At("TAIL"))
    private void solariacarpet$drain(CallbackInfo ci) {
        if (!SolariaCarpetSettings.lightSuppression && lightTasks.size() >= 1000) {
            consecutiveExecutor.schedule(this::runUpdate);
        }
    }
}
