package dev.kanety.potiondupe;

import com.mojang.brigadier.arguments.BoolArgumentType;
import com.mojang.brigadier.context.CommandContext;
import net.fabricmc.api.ModInitializer;
import net.fabricmc.fabric.api.command.v2.CommandRegistrationCallback;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.commands.Commands;
import net.minecraft.network.chat.Component;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.function.BiConsumer;

public class PotionDupe implements ModInitializer {
    public static final Logger LOGGER = LoggerFactory.getLogger("potiondupe");

    @Override
    public void onInitialize() {
        PotionDupeConfig.load();
        CommandRegistrationCallback.EVENT.register((dispatcher, registryAccess, environment) -> dispatcher.register(
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
        ));
        LOGGER.info("Potion Dupe Restore loaded (enabled={})", PotionDupeConfig.get().enabled);
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
