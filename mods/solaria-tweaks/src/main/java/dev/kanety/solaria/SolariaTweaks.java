package dev.kanety.solaria;

import dev.kanety.solaria.board.Leaderboard;
import dev.kanety.solaria.board.LeaderboardCommand;
import dev.kanety.solaria.light.LightSuppression;
import dev.kanety.solaria.net.BuildSyncPayload;
import dev.kanety.solaria.net.WaypointSyncPayload;
import dev.kanety.solaria.plan.BuildCommand;
import dev.kanety.solaria.plan.BuildManager;
import dev.kanety.solaria.potion.PotionDupe;
import dev.kanety.solaria.waypoint.SharedWaypoints;
import dev.kanety.solaria.waypoint.WaypointCommand;
import net.fabricmc.api.ModInitializer;
import net.fabricmc.fabric.api.command.v2.CommandRegistrationCallback;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerTickEvents;
import net.fabricmc.fabric.api.networking.v1.PayloadTypeRegistry;
import net.fabricmc.fabric.api.networking.v1.ServerPlayConnectionEvents;
import net.minecraft.resources.Identifier;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

public class SolariaTweaks implements ModInitializer {
    public static final String MOD_ID = "solariatweaks";
    public static final Logger LOGGER = LoggerFactory.getLogger("Solaria Tweaks");

    public static Identifier id(String path) {
        return Identifier.fromNamespaceAndPath(MOD_ID, path);
    }

    @Override
    public void onInitialize() {
        PayloadTypeRegistry.playS2C().register(BuildSyncPayload.TYPE, BuildSyncPayload.CODEC);
        PayloadTypeRegistry.playS2C().register(WaypointSyncPayload.TYPE, WaypointSyncPayload.CODEC);
        PotionDupe.init();

        CommandRegistrationCallback.EVENT.register((dispatcher, registryAccess, environment) -> {
            BuildCommand.register(dispatcher);
            WaypointCommand.register(dispatcher);
            LeaderboardCommand.register(dispatcher);
            LightSuppression.register(dispatcher);
            PotionDupe.register(dispatcher);
        });
        ServerLifecycleEvents.SERVER_STARTED.register(server -> {
            BuildManager.start(server);
            SharedWaypoints.start(server);
            Leaderboard.start(server);
        });
        ServerLifecycleEvents.SERVER_STOPPING.register(server -> {
            LightSuppression.serverStopping();
            BuildManager.stop();
            SharedWaypoints.stop();
            Leaderboard.stop();
        });
        ServerTickEvents.END_SERVER_TICK.register(server -> {
            BuildManager manager = BuildManager.get();
            if (manager != null) manager.tick();
            Leaderboard board = Leaderboard.get();
            if (board != null) board.tick();
            LightSuppression.tick(server);
        });
        ServerPlayConnectionEvents.JOIN.register((handler, sender, server) -> {
            BuildManager manager = BuildManager.get();
            if (manager != null) manager.markSyncNeeded();
            SharedWaypoints waypoints = SharedWaypoints.get();
            if (waypoints != null) waypoints.send(handler.player);
            Leaderboard board = Leaderboard.get();
            if (board != null) board.onJoin(handler.player);
        });
        ServerPlayConnectionEvents.DISCONNECT.register((handler, server) -> {
            Leaderboard board = Leaderboard.get();
            if (board != null) board.onLeave(handler.player);
        });
    }
}
