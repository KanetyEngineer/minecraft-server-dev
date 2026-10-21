package dev.kanety.buildplan.client;

import com.mojang.blaze3d.platform.InputConstants;
import dev.kanety.buildplan.SharedBuildPlan;
import dev.kanety.buildplan.net.BuildSyncPayload;
import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientTickEvents;
import net.fabricmc.fabric.api.client.keybinding.v1.KeyBindingHelper;
import net.fabricmc.fabric.api.client.networking.v1.ClientPlayConnectionEvents;
import net.fabricmc.fabric.api.client.networking.v1.ClientPlayNetworking;
import net.fabricmc.fabric.api.client.rendering.v1.hud.HudElementRegistry;
import net.minecraft.client.KeyMapping;
import net.minecraft.client.Minecraft;
import net.minecraft.network.chat.Component;
import org.lwjgl.glfw.GLFW;

public class SharedBuildPlanClient implements ClientModInitializer {
    public static final KeyMapping.Category CATEGORY = KeyMapping.Category.register(SharedBuildPlan.id("main"));
    public static KeyMapping openBuildScreen;
    public static KeyMapping toggleBuildHud;

    public static boolean openBuildPlans(Minecraft client) {
        if (client.screen != null || client.player == null) return false;
        client.setScreen(new BuildScreen(null));
        return true;
    }

    public static void toggleBuildHud(Minecraft client) {
        ClientConfig cfg = ClientConfig.get();
        cfg.hudEnabled = !cfg.hudEnabled;
        ClientConfig.save();
        if (client.player != null) client.player.displayClientMessage(Component.literal("建築計画 HUD: " + (cfg.hudEnabled ? "表示" : "非表示")), true);
    }

    @Override
    public void onInitializeClient() {
        ClientConfig.load();
        openBuildScreen = KeyBindingHelper.registerKeyBinding(new KeyMapping(
                "key.sharedbuildplan.build_plans", InputConstants.Type.KEYSYM, GLFW.GLFW_KEY_B, CATEGORY));
        toggleBuildHud = KeyBindingHelper.registerKeyBinding(new KeyMapping(
                "key.sharedbuildplan.toggle_hud", InputConstants.Type.KEYSYM, GLFW.GLFW_KEY_UNKNOWN, CATEGORY));

        ClientTickEvents.END_CLIENT_TICK.register(client -> {
            while (openBuildScreen.consumeClick()) openBuildPlans(client);
            while (toggleBuildHud.consumeClick()) toggleBuildHud(client);
        });
        ClientPlayNetworking.registerGlobalReceiver(BuildSyncPayload.TYPE, (payload, context) -> {
            try {
                ClientBuildState.apply(payload.json());
            } catch (Exception e) {
                SharedBuildPlan.LOGGER.warn("Bad build sync payload", e);
            }
        });
        ClientPlayConnectionEvents.DISCONNECT.register((handler, client) -> ClientBuildState.reset());
        HudElementRegistry.addLast(SharedBuildPlan.id("build_hud"), BuildHud::render);
    }
}
