package dev.kanety.solariacarpet;

/**
 * lightSuppression rule: the light thread may only run a limited number of task batches (1000 tasks each) per server
 * tick, as the old light engine effectively could. A light suppressor that floods the queue with more updates than
 * that builds a backlog again, so other light updates wait behind it, and whatever is still queued when the server
 * stops is never applied (the server does not wait for the light queue on shutdown).
 */
public final class LightSuppression {
    private static volatile long tick;

    private LightSuppression() {}

    public static void onServerTick() {
        tick++;
    }

    public static long tick() {
        return tick;
    }

    public static int batchesPerTick() {
        return Math.max(1, (SolariaCarpetSettings.lightSuppressionTasksPerTick + 999) / 1000);
    }
}
