package dev.kanety.solaria.potion;

import com.mojang.brigadier.arguments.BoolArgumentType;
import com.mojang.brigadier.context.CommandContext;
import com.mojang.brigadier.CommandDispatcher;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.commands.Commands;
import net.minecraft.network.chat.Component;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.function.BiConsumer;

/** Potion Dupe Restore (KanetyEngineer/potion-dupe-restore), bundled into Solaria Tweaks. */
public final class PotionDupe {
    public static final Logger LOGGER = LoggerFactory.getLogger("potiondupe");

    private PotionDupe() {}

    public static void init() {
        PotionDupeConfig.load();
        LOGGER.info("Potion Dupe Restore loaded (enabled={})", PotionDupeConfig.get().enabled);
    }

    public static void register(CommandDispatcher<CommandSourceStack> dispatcher) {
        dispatcher.register(
            Commands.literal("potiondupe")
                .requires(Commands.hasPermission(Commands.LEVEL_GAMEMASTERS))
                .executes(PotionDupe::status)
                .then(Commands.literal("on").executes(ctx -> setEnabled(ctx, true)))
                .then(Commands.literal("off").executes(ctx -> setEnabled(ctx, false)))
                .then(Commands.literal("scope")
                    .then(Commands.literal("potions").executes(ctx -> setScope(ctx, "potions")))
                    .then(Commands.literal("all").executes(ctx -> setScope(ctx, "all"))))
                .then(option("hitAfterPortal", (c, v) -> c.hitAfterPortal = v))
                .then(option("legacyPortalCooldown", (c, v) -> c.legacyPortalCooldown = v))
                .then(option("legacyPhysics", (c, v) -> c.legacyPhysics = v))
                .then(Commands.literal("reload").executes(ctx -> {
                    PotionDupeConfig.load();
                    return status(ctx);
                }))
        );
    }

    private static com.mojang.brigadier.builder.LiteralArgumentBuilder<CommandSourceStack> option(
        String name, BiConsumer<PotionDupeConfig, Boolean> setter) {
        return Commands.literal(name).then(Commands.argument("value", BoolArgumentType.bool()).executes(ctx -> {
            setter.accept(PotionDupeConfig.get(), BoolArgumentType.getBool(ctx, "value"));
            PotionDupeConfig.save();
            return status(ctx);
        }));
    }

    private static int setEnabled(CommandContext<CommandSourceStack> ctx, boolean value) {
        PotionDupeConfig.get().enabled = value;
        PotionDupeConfig.save();
        return status(ctx);
    }

    private static int setScope(CommandContext<CommandSourceStack> ctx, String value) {
        PotionDupeConfig.get().scope = value;
        PotionDupeConfig.save();
        return status(ctx);
    }

    private static int status(CommandContext<CommandSourceStack> ctx) {
        PotionDupeConfig c = PotionDupeConfig.get();
        ctx.getSource().sendSuccess(() -> Component.literal(
            "[PotionDupe] " + (c.enabled ? "ON" : "OFF")
                + " scope=" + c.scope
                + " hitAfterPortal=" + c.hitAfterPortal
                + " legacyPortalCooldown=" + c.legacyPortalCooldown
                + " legacyPhysics=" + c.legacyPhysics), true);
        return c.enabled ? 1 : 0;
    }
}
