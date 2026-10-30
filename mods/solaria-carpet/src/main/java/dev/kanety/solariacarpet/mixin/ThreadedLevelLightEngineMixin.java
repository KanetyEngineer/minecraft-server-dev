package dev.kanety.solariacarpet.mixin;

import com.mojang.datafixers.util.Pair;
import dev.kanety.solariacarpet.LightSuppression;
import dev.kanety.solariacarpet.SolariaCarpetSettings;
import it.unimi.dsi.fastutil.objects.ObjectList;
import it.unimi.dsi.fastutil.objects.ObjectListIterator;
import net.minecraft.server.level.ThreadedLevelLightEngine;
import net.minecraft.util.thread.ConsecutiveExecutor;
import net.minecraft.world.level.chunk.LightChunkGetter;
import net.minecraft.world.level.lighting.LevelLightEngine;
import org.spongepowered.asm.mixin.Final;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Shadow;
import org.spongepowered.asm.mixin.Unique;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/**
 * runUpdate handles one batch of up to 1000 queued light tasks with a single propagation pass. It runs from
 * tryScheduleUpdate and again inline whenever 1000 tasks are queued, so in vanilla the queue can never build up.
 *
 * Since 1.20 the 1000 tasks share one propagation, so a light source that a suppressor turns on and off many times
 * inside a batch costs next to nothing (the changes cancel out before anything is propagated). Up to 1.19 the batch
 * was 5 tasks (taskPerBatch), so every toggle was propagated on its own, and that is what made suppressors heavy.
 * With lightSuppression on, the batch is worked off in groups of 5 with a propagation pass after each group, at most
 * lightSuppressionTasksPerTick tasks per 50 ms window, and then the light thread rests for (slowdown - 1) times the
 * time it just spent. Whatever does not fit stays queued.
 */
@Mixin(ThreadedLevelLightEngine.class)
public abstract class ThreadedLevelLightEngineMixin extends LevelLightEngine {
    @Unique private static final int OLD_BATCH = 5;
    @Unique private static final int MAX_BATCH = 1000;

    @Shadow @Final private ConsecutiveExecutor consecutiveExecutor;
    @Shadow @Final private ObjectList<?> lightTasks;

    @Shadow
    private void runUpdate() {
        throw new AssertionError();
    }

    @Unique private long solariacarpet$windowStart;
    @Unique private int solariacarpet$used;
    @Unique private long solariacarpet$busyUntil;

    private ThreadedLevelLightEngineMixin(LightChunkGetter getter, boolean blockLight, boolean skyLight) {
        super(getter, blockLight, skyLight);
    }

    @Inject(method = "runUpdate", at = @At("HEAD"), cancellable = true)
    private void solariacarpet$suppressed(CallbackInfo ci) {
        if (!SolariaCarpetSettings.lightSuppression) return;
        // Above the cap the backlog is worked off at full speed, so a chunk load never waits for an endless queue.
        int cap = SolariaCarpetSettings.lightSuppressionMaxQueue;
        if (cap > 0 && lightTasks.size() >= cap) return;
        ci.cancel();
        boolean waiting = LightSuppression.serverWaiting();
        long now = System.nanoTime();
        if (now < solariacarpet$busyUntil && !waiting) return;
        if (now - solariacarpet$windowStart >= LightSuppression.WINDOW_NANOS) {
            solariacarpet$windowStart = now;
            solariacarpet$used = 0;
        }
        int budget = Math.max(OLD_BATCH, SolariaCarpetSettings.lightSuppressionTasksPerTick) * (waiting ? 10 : 1);
        int todo = Math.min(Math.min(lightTasks.size(), MAX_BATCH), budget - solariacarpet$used);
        if (todo <= 0) {
            // Nothing queued but propagation left over (hasLightWork): finish it like vanilla does.
            if (lightTasks.isEmpty()) super.runLightUpdates();
            return;
        }
        for (int done = 0; done < todo; ) {
            int n = Math.min(OLD_BATCH, todo - done);
            solariacarpet$runGroup(n);
            done += n;
        }
        solariacarpet$used += todo;
        int slowdown = SolariaCarpetSettings.lightSuppressionSlowdown;
        long end = System.nanoTime();
        solariacarpet$busyUntil = slowdown > 1 ? end + (end - now) * (slowdown - 1) : 0;
    }

    /** Vanilla runUpdate for the first n tasks: PRE_UPDATE tasks, one propagation pass, then POST_UPDATE tasks. */
    @Unique
    @SuppressWarnings("unchecked")
    private void solariacarpet$runGroup(int n) {
        ObjectListIterator<Pair<Enum<?>, Runnable>> it = ((ObjectList<Pair<Enum<?>, Runnable>>) lightTasks).iterator();
        int j;
        for (j = 0; it.hasNext() && j < n; j++) {
            Pair<Enum<?>, Runnable> pair = it.next();
            if (pair.getFirst().ordinal() == 0) pair.getSecond().run(); // PRE_UPDATE
        }
        it.back(j);
        super.runLightUpdates();
        for (int k = 0; it.hasNext() && k < n; k++) {
            Pair<Enum<?>, Runnable> pair = it.next();
            if (pair.getFirst().ordinal() == 1) pair.getSecond().run(); // POST_UPDATE
            it.remove();
        }
    }

    /** After the rule is turned off, keep going until a backlog left over from suppression is gone. */
    @Inject(method = "runUpdate", at = @At("TAIL"))
    private void solariacarpet$drain(CallbackInfo ci) {
        if (!SolariaCarpetSettings.lightSuppression && lightTasks.size() >= MAX_BATCH) {
            consecutiveExecutor.schedule(this::runUpdate);
        }
    }
}
