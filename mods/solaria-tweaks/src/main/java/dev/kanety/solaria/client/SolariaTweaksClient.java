package dev.kanety.solaria.client;

import com.mojang.blaze3d.platform.InputConstants;
import com.mojang.brigadier.arguments.IntegerArgumentType;
import com.mojang.brigadier.arguments.StringArgumentType;
import dev.kanety.solaria.SolariaTweaks;
import dev.kanety.solaria.client.malilib.MalilibCompat;
import dev.kanety.solaria.client.waypoint.ClientWaypoints;
import dev.kanety.solaria.client.waypoint.SharedWaypointsScreen;
import dev.kanety.solaria.client.xaero.MinimapBridge;
import dev.kanety.solaria.client.xaero.XaeroMapIntegration;
import dev.kanety.solaria.net.BuildSyncPayload;
import dev.kanety.solaria.net.WaypointSyncPayload;
import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.command.v2.ClientCommandManager;
import net.fabricmc.fabric.api.client.command.v2.ClientCommandRegistrationCallback;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientTickEvents;
import net.fabricmc.fabric.api.client.keybinding.v1.KeyBindingHelper;
import net.fabricmc.fabric.api.client.networking.v1.ClientPlayConnectionEvents;
import net.fabricmc.fabric.api.client.networking.v1.ClientPlayNetworking;
import net.fabricmc.fabric.api.client.rendering.v1.hud.HudElementRegistry;
import net.fabricmc.fabric.api.client.screen.v1.ScreenEvents;
import net.fabricmc.loader.api.FabricLoader;
import net.minecraft.client.KeyMapping;
import net.minecraft.client.Minecraft;
import net.minecraft.network.chat.Component;
import org.lwjgl.glfw.GLFW;

public class SolariaTweaksClient implements ClientModInitializer {
    public static boolean openBuildPlans(Minecraft client) {
        if (client.screen != null || client.player == null) return false;
        client.setScreen(new BuildScreen(null));
        return true;
    }

    public static boolean openSharedWaypoints(Minecraft client) {
        if (client.screen != null || client.player == null) return false;
        client.setScreen(new SharedWaypointsScreen(null));
        return true;
    }

    public static void cycleObserverGuard(Minecraft client) {
        ClientConfig.GuardMode next = ClientConfig.get().guardMode().next();
        ClientConfig.get().setGuardMode(next);
        if (client.player != null) client.player.displayClientMessage(Component.literal("オブザーバー警告: " + next.label), true);
    }

    public static void toggleBuildHud(Minecraft client) {
        ClientConfig cfg = ClientConfig.get();
        cfg.hudEnabled = !cfg.hudEnabled;
        ClientConfig.save();
        if (client.player != null) client.player.displayClientMessage(Component.literal("建築計画 HUD: " + (cfg.hudEnabled ? "表示" : "非表示")), true);
    }

    public static final KeyMapping.Category CATEGORY = KeyMapping.Category.register(SolariaTweaks.id("main"));
    public static KeyMapping openBuildScreen;
    public static KeyMapping cycleObserverGuard;
    public static KeyMapping toggleBuildHud;

    @Override
    public void onInitializeClient() {
        ClientConfig.load();
        if (FabricLoader.getInstance().isModLoaded("malilib")) {
            MalilibCompat.init();
        } else {
            openBuildScreen = KeyBindingHelper.registerKeyBinding(new KeyMapping(
                    "key.solariatweaks.build_plans", InputConstants.Type.KEYSYM, GLFW.GLFW_KEY_B, CATEGORY));
            cycleObserverGuard = KeyBindingHelper.registerKeyBinding(new KeyMapping(
                    "key.solariatweaks.observer_guard", InputConstants.Type.KEYSYM, GLFW.GLFW_KEY_UNKNOWN, CATEGORY));
            toggleBuildHud = KeyBindingHelper.registerKeyBinding(new KeyMapping(
                    "key.solariatweaks.toggle_hud", InputConstants.Type.KEYSYM, GLFW.GLFW_KEY_UNKNOWN, CATEGORY));
        }

        ClientTickEvents.END_CLIENT_TICK.register(client -> {
            if (openBuildScreen != null) {
                while (openBuildScreen.consumeClick()) openBuildPlans(client);
                while (cycleObserverGuard.consumeClick()) cycleObserverGuard(client);
                while (toggleBuildHud.consumeClick()) toggleBuildHud(client);
            }
            ObserverGuard.tick(client);
            MinimapBridge.tick();
        });
        ClientPlayNetworking.registerGlobalReceiver(BuildSyncPayload.TYPE, (payload, context) -> {
            try {
                ClientBuildState.apply(payload.json());
            } catch (Exception e) {
                SolariaTweaks.LOGGER.warn("Bad build sync payload", e);
            }
        });
        ClientPlayNetworking.registerGlobalReceiver(WaypointSyncPayload.TYPE, (payload, context) -> {
            try {
                ClientWaypoints.apply(payload.json());
            } catch (Exception e) {
                SolariaTweaks.LOGGER.warn("Bad waypoint sync payload", e);
            }
        });
        ClientPlayConnectionEvents.DISCONNECT.register((handler, client) -> {
            ClientBuildState.reset();
            ClientWaypoints.reset();
        });
        ClientCommandRegistrationCallback.EVENT.register((dispatcher, registryAccess) -> dispatcher.register(
                ClientCommandManager.literal("filterfill")
                        .executes(c -> {
                            ClientConfig cfg = ClientConfig.get();
                            c.getSource().sendFeedback(Component.literal("フィルター詰め: 1枠目 " + cfg.filterCount + " 個、埋め物 "
                                    + cfg.fillerCount + " 個ずつ（" + (cfg.fillerItem.isBlank() ? "名前を付けたアイテム" : cfg.fillerItem) + "）\n"
                                    + "/filterfill count <個数>、/filterfill filler <個数>、/filterfill item <アイテムID|renamed> で変更できます"));
                            return 1;
                        })
                        .then(ClientCommandManager.literal("count").then(ClientCommandManager.argument("n", IntegerArgumentType.integer(1, 64))
                                .executes(c -> {
                                    ClientConfig.get().filterCount = IntegerArgumentType.getInteger(c, "n");
                                    ClientConfig.save();
                                    c.getSource().sendFeedback(Component.literal("1枠目に入れる数を " + ClientConfig.get().filterCount + " 個にしました"));
                                    return 1;
                                })))
                        .then(ClientCommandManager.literal("filler").then(ClientCommandManager.argument("n", IntegerArgumentType.integer(1, 64))
                                .executes(c -> {
                                    ClientConfig.get().fillerCount = IntegerArgumentType.getInteger(c, "n");
                                    ClientConfig.save();
                                    c.getSource().sendFeedback(Component.literal("埋め物を 1 枠に " + ClientConfig.get().fillerCount + " 個ずつ入れます"));
                                    return 1;
                                })))
                        .then(ClientCommandManager.literal("item").then(ClientCommandManager.argument("id", StringArgumentType.greedyString())
                                .executes(c -> {
                                    String id = StringArgumentType.getString(c, "id").strip();
                                    ClientConfig.get().fillerItem = id.equalsIgnoreCase("renamed") ? "" : id;
                                    ClientConfig.save();
                                    c.getSource().sendFeedback(Component.literal("埋め物を「" + (ClientConfig.get().fillerItem.isBlank()
                                            ? "名前を付けたアイテム" : ClientConfig.get().fillerItem) + "」にしました"));
                                    return 1;
                                })))));
        ClientCommandRegistrationCallback.EVENT.register((dispatcher, registryAccess) -> dispatcher.register(
                ClientCommandManager.literal("observerguard")
                        .executes(c -> {
                            c.getSource().sendFeedback(Component.literal("オブザーバー警告: " + ClientConfig.get().guardMode().label
                                    + "（/observerguard off|diff|all）"));
                            return 1;
                        })
                        .then(ClientCommandManager.argument("mode", StringArgumentType.word())
                                .suggests((c, b) -> {
                                    for (ClientConfig.GuardMode m : ClientConfig.GuardMode.values()) b.suggest(m.id);
                                    return b.buildFuture();
                                })
                                .executes(c -> {
                                    ClientConfig.GuardMode m = ClientConfig.GuardMode.of(StringArgumentType.getString(c, "mode"));
                                    if (m == null) {
                                        c.getSource().sendError(Component.literal("off / diff / all のどれかを指定してください"));
                                        return 0;
                                    }
                                    ClientConfig.get().setGuardMode(m);
                                    c.getSource().sendFeedback(Component.literal("オブザーバー警告: " + m.label));
                                    return 1;
                                }))));
        HudElementRegistry.addLast(SolariaTweaks.id("build_hud"), BuildHud::render);
        ScreenEvents.AFTER_INIT.register(XaeroMapIntegration::onScreenInit);
        ScreenEvents.AFTER_INIT.register(FilterFill::onScreenInit);
    }
}
