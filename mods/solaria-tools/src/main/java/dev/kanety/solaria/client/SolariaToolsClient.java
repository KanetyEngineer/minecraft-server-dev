package dev.kanety.solaria.client;

import com.mojang.blaze3d.platform.InputConstants;
import dev.kanety.solaria.SolariaTools;
import dev.kanety.solaria.client.xaero.XaeroMapIntegration;
import dev.kanety.solaria.net.BuildSyncPayload;
import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientTickEvents;
import net.fabricmc.fabric.api.client.keybinding.v1.KeyBindingHelper;
import net.fabricmc.fabric.api.client.networking.v1.ClientPlayConnectionEvents;
import net.fabricmc.fabric.api.client.networking.v1.ClientPlayNetworking;
import net.fabricmc.fabric.api.client.rendering.v1.hud.HudElementRegistry;
import net.fabricmc.fabric.api.client.screen.v1.ScreenEvents;
import net.fabricmc.loader.api.FabricLoader;
import net.minecraft.client.KeyMapping;
import org.lwjgl.glfw.GLFW;

public class SolariaToolsClient implements ClientModInitializer {
    public static final KeyMapping.Category CATEGORY = KeyMapping.Category.register(SolariaTools.id("main"));
    public static KeyMapping openBuildScreen;

    @Override
    public void onInitializeClient() {
        ClientConfig.load();
        openBuildScreen = KeyBindingHelper.registerKeyBinding(new KeyMapping(
                "key.solariatools.build_plans", InputConstants.Type.KEYSYM, GLFW.GLFW_KEY_B, CATEGORY));

        ClientTickEvents.END_CLIENT_TICK.register(client -> {
            while (openBuildScreen.consumeClick()) {
                if (client.screen == null) client.setScreen(new BuildScreen(null));
            }
        });
        ClientPlayNetworking.registerGlobalReceiver(BuildSyncPayload.TYPE, (payload, context) -> {
            try {
                ClientBuildState.apply(payload.json());
            } catch (Exception e) {
                SolariaTools.LOGGER.warn("Bad build sync payload", e);
            }
        });
        ClientPlayConnectionEvents.DISCONNECT.register((handler, client) -> ClientBuildState.reset());
        HudElementRegistry.addLast(SolariaTools.id("build_hud"), BuildHud::render);

        if (FabricLoader.getInstance().isModLoaded("xaeroworldmap")) {
            ScreenEvents.AFTER_INIT.register(XaeroMapIntegration::onScreenInit);
        }
    }
}
