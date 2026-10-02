package dev.kanety.solaria.client.xaero;

import net.fabricmc.loader.api.FabricLoader;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.network.chat.Component;

/** Safe entry point: Server Waypoint classes are only touched (in ServerWaypointImpl) when the mod is installed. */
public final class ServerWaypointBridge {
    private ServerWaypointBridge() {}

    public static boolean isLoaded() {
        return FabricLoader.getInstance().isModLoaded("server_waypoint");
    }

    private static boolean ready() {
        if (isLoaded()) return true;
        Minecraft mc = Minecraft.getInstance();
        if (mc.player != null) mc.player.displayClientMessage(Component.literal("サーバー地点を使うには Server Waypoint MOD が必要です"), false);
        return false;
    }

    public static void openManager(Screen parent) {
        if (!ready()) return;
        if (!ServerWaypointImpl.openManager()) {
            Minecraft mc = Minecraft.getInstance();
            if (mc.player != null) mc.player.displayClientMessage(Component.literal("Server Waypoint がまだ準備できていません（サーバー側にも必要です）"), false);
        }
    }

    public static void openAdd(Screen parent, String dimension, int x, int y, int z) {
        if (ready()) ServerWaypointImpl.openAdd(parent, dimension, x, y, z);
    }
}
