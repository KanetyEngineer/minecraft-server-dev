package dev.kanety.solaria;

import dev.kanety.solaria.plan.BuildCommand;
import dev.kanety.solaria.plan.BuildManager;
import dev.kanety.solaria.net.BuildSyncPayload;
import net.fabricmc.api.ModInitializer;
import net.fabricmc.fabric.api.command.v2.CommandRegistrationCallback;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerTickEvents;
import net.fabricmc.fabric.api.networking.v1.PayloadTypeRegistry;
import net.fabricmc.fabric.api.networking.v1.ServerPlayConnectionEvents;
import net.minecraft.resources.Identifier;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

public class SolariaTools implements ModInitializer {
    public static final String MOD_ID = "solariatools";
    public static final Logger LOGGER = LoggerFactory.getLogger("Solaria Tools");

    public static Identifier id(String path) {
        return Identifier.fromNamespaceAndPath(MOD_ID, path);
    }

    @Override
    public void onInitialize() {
        PayloadTypeRegistry.playS2C().register(BuildSyncPayload.TYPE, BuildSyncPayload.CODEC);

        CommandRegistrationCallback.EVENT.register((dispatcher, registryAccess, environment) -> BuildCommand.register(dispatcher));
        ServerLifecycleEvents.SERVER_STARTED.register(BuildManager::start);
        ServerLifecycleEvents.SERVER_STOPPING.register(server -> BuildManager.stop());
        ServerTickEvents.END_SERVER_TICK.register(server -> {
            BuildManager manager = BuildManager.get();
            if (manager != null) manager.tick();
        });
        ServerPlayConnectionEvents.JOIN.register((handler, sender, server) -> {
            BuildManager manager = BuildManager.get();
            if (manager != null) manager.markSyncNeeded();
        });
    }
}
