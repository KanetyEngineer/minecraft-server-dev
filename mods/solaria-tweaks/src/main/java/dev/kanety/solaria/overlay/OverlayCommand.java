package dev.kanety.solaria.overlay;

import com.mojang.brigadier.CommandDispatcher;
import com.mojang.brigadier.arguments.IntegerArgumentType;
import com.mojang.brigadier.arguments.StringArgumentType;
import com.mojang.brigadier.context.CommandContext;
import net.minecraft.ChatFormatting;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.commands.Commands;
import net.minecraft.network.chat.Component;

/** /overlay — turn the OBS overlay web server on or off (OP) and show its address. */
public final class OverlayCommand {
    private OverlayCommand() {}

    public static void register(CommandDispatcher<CommandSourceStack> d) {
        d.register(Commands.literal("overlay")
                .executes(OverlayCommand::status)
                .then(Commands.literal("on").requires(Commands.hasPermission(Commands.LEVEL_ADMINS))
                        .executes(c -> on(c, OverlayServer.config().port))
                        .then(Commands.argument("port", IntegerArgumentType.integer(1, 65535))
                                .executes(c -> on(c, IntegerArgumentType.getInteger(c, "port")))))
                .then(Commands.literal("off").requires(Commands.hasPermission(Commands.LEVEL_ADMINS))
                        .executes(OverlayCommand::off))
                .then(Commands.literal("address").requires(Commands.hasPermission(Commands.LEVEL_ADMINS))
                        .then(Commands.argument("address", StringArgumentType.greedyString())
                                .executes(OverlayCommand::address))));
    }

    private static String base(CommandSourceStack s) {
        OverlayServer.Config cfg = OverlayServer.config();
        if (!cfg.publicAddress.isBlank()) {
            String a = cfg.publicAddress.strip();
            return a.startsWith("http") ? a : "http://" + a;
        }
        String host = s.getServer().getLocalIp();
        if (host == null || host.isBlank()) host = "<サーバーのIP>";
        return "http://" + host + ":" + cfg.port;
    }

    private static int status(CommandContext<CommandSourceStack> c) {
        CommandSourceStack s = c.getSource();
        if (!OverlayServer.running()) {
            s.sendSuccess(() -> Component.literal("OBS オーバーレイは停止中です。OP が /overlay on [ポート] で開始できます。").withStyle(ChatFormatting.GRAY), false);
            return 0;
        }
        String b = base(s);
        s.sendSuccess(() -> Component.literal("OBS オーバーレイ（ブラウザソースに貼る URL）").withStyle(ChatFormatting.GOLD), false);
        s.sendSuccess(() -> Component.literal("採掘数の合計: ").append(Component.literal(b + "/overlay").withStyle(ChatFormatting.AQUA)), false);
        s.sendSuccess(() -> Component.literal("見た目や項目を選ぶ: ").append(Component.literal(b + "/").withStyle(ChatFormatting.AQUA)), false);
        return 1;
    }

    private static int on(CommandContext<CommandSourceStack> c, int port) {
        OverlayServer.Config cfg = OverlayServer.config();
        cfg.port = port;
        String err = OverlayServer.open();
        if (err != null) {
            c.getSource().sendFailure(Component.literal("ポート " + port + " を開けませんでした: " + err));
            return 0;
        }
        cfg.enabled = true;
        OverlayServer.save();
        c.getSource().sendSuccess(() -> Component.literal("OBS オーバーレイをポート " + port + " で開始しました（次の起動時も自動で開始）"), true);
        return status(c);
    }

    private static int off(CommandContext<CommandSourceStack> c) {
        OverlayServer.close();
        OverlayServer.config().enabled = false;
        OverlayServer.save();
        c.getSource().sendSuccess(() -> Component.literal("OBS オーバーレイを停止しました"), true);
        return 1;
    }

    private static int address(CommandContext<CommandSourceStack> c) {
        String a = StringArgumentType.getString(c, "address").strip();
        OverlayServer.config().publicAddress = a.equals("-") ? "" : a;
        OverlayServer.save();
        c.getSource().sendSuccess(() -> Component.literal("案内する URL の住所を「" + (a.equals("-") ? "自動" : a) + "」にしました"), true);
        return status(c);
    }
}
