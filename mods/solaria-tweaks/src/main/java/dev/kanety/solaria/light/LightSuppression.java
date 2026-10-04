package dev.kanety.solaria.light;

import com.mojang.brigadier.CommandDispatcher;
import com.mojang.brigadier.arguments.IntegerArgumentType;
import com.mojang.brigadier.context.CommandContext;
import net.minecraft.ChatFormatting;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.commands.Commands;
import net.minecraft.network.chat.Component;
import net.minecraft.server.MinecraftServer;

/**
 * /lightsuppress — holds back every light update on the server, the way a light suppressor does. Queued updates run
 * as soon as it is turned off. Chunks that still need lighting do not finish loading while it is on, so it turns
 * itself off when the server stops and can be given a time limit.
 */
public final class LightSuppression {
    private static volatile boolean active;
    private static long offAtTick = -1;

    private LightSuppression() {}

    public static boolean active() {
        return active;
    }

    public static void register(CommandDispatcher<CommandSourceStack> d) {
        d.register(Commands.literal("lightsuppress").requires(Commands.hasPermission(Commands.LEVEL_GAMEMASTERS))
                .executes(LightSuppression::status)
                .then(Commands.literal("on").executes(c -> set(c, true, -1))
                        .then(Commands.argument("seconds", IntegerArgumentType.integer(1, 86400))
                                .executes(c -> set(c, true, IntegerArgumentType.getInteger(c, "seconds")))))
                .then(Commands.literal("off").executes(c -> set(c, false, -1)))
                .then(Commands.literal("status").executes(LightSuppression::status)));
    }

    private static int set(CommandContext<CommandSourceStack> c, boolean on, int seconds) {
        MinecraftServer server = c.getSource().getServer();
        active = on;
        offAtTick = on && seconds > 0 ? server.getTickCount() + seconds * 20L : -1;
        String msg = on
                ? "光の更新を止めました（光抑制 ON" + (seconds > 0 ? "、" + seconds + "秒後に自動で OFF" : "") + "）。止めている間は新しいチャンクの読み込みも止まります"
                : "光の更新を再開しました（光抑制 OFF）";
        c.getSource().sendSuccess(() -> Component.literal(msg).withStyle(on ? ChatFormatting.YELLOW : ChatFormatting.GREEN), true);
        return 1;
    }

    private static int status(CommandContext<CommandSourceStack> c) {
        c.getSource().sendSuccess(() -> Component.literal("光抑制: " + (active ? "ON" : "OFF")
                + "  （/lightsuppress on [秒] / off）"), false);
        return active ? 1 : 0;
    }

    public static void tick(MinecraftServer server) {
        if (active && offAtTick >= 0 && server.getTickCount() >= offAtTick) {
            active = false;
            offAtTick = -1;
            server.getPlayerList().broadcastSystemMessage(Component.literal("[光抑制] 時間になったので OFF にしました").withStyle(ChatFormatting.GREEN), false);
        }
    }

    public static void serverStopping() {
        active = false;
        offAtTick = -1;
    }
}
