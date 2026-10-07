package dev.kanety.solariacarpet;

import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;

/**
 * lightSuppression rule: the light thread may only run a limited number of task batches (1000 tasks each) per
 * 50 ms, as the old light engine effectively could. A light suppressor that floods the queue with more updates than
 * that builds a backlog again, so other light updates wait behind it, and whatever is still queued when the server
 * stops is never applied (the server does not wait for the light queue on shutdown).
 *
 * The budget is counted in real time, not in ticks, so it keeps refilling while the server thread is stuck waiting
 * for a chunk (a bot or a teleport loading a new chunk needs its light done first). While the server thread waits
 * like that, the budget is ten times larger so the wait stays short.
 *
 * On top of that the light thread is made as slow as the pre-1.20 engine (lightSuppressionSlowdown): after a batch
 * that took t, the next one waits (slowdown - 1) * t. Old suppressors relied on how long the propagation itself took
 * (a push floor or a portal loader makes few but expensive updates), which a task count alone does not capture.
 */
public final class LightSuppression {
    public static final long WINDOW_NANOS = 50_000_000L;
    private static volatile MinecraftServer server;
    private static volatile int waiting;

    private LightSuppression() {}

    public static void onServerTick(MinecraftServer s) {
        server = s;
        waiting = 0; // getChunk is never running at this point; also heals a counter left over by an exception
        // Make sure a skipped batch is retried every tick, so a backlog drains at the configured rate (and keeps
        // draining after the rule is turned off). Does nothing when the queue is empty.
        for (ServerLevel level : s.getAllLevels()) level.getChunkSource().getLightEngine().tryScheduleUpdate();
    }

    /** Called around ServerChunkCache#getChunk. */
    public static void enterGetChunk() {
        MinecraftServer s = server;
        if (s != null && s.isSameThread()) waiting++;
    }

    public static void exitGetChunk() {
        MinecraftServer s = server;
        if (s != null && s.isSameThread() && waiting > 0) waiting--;
    }

    public static boolean serverWaiting() {
        return waiting > 0;
    }

    public static int batchesPerWindow() {
        int base = Math.max(1, (SolariaCarpetSettings.lightSuppressionTasksPerTick + 999) / 1000);
        return waiting > 0 ? base * 10 : base;
    }
}
