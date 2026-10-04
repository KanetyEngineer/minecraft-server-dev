package dev.kanety.solaria.client.xaero;

import net.fabricmc.loader.api.FabricLoader;

import java.util.List;

/** Safe entry point to Xaero's Minimap: its classes are only touched (in MinimapAccess) when the mod is installed. */
public final class MinimapBridge {
    private static final boolean LOADED = FabricLoader.getInstance().isModLoaded("xaerominimap");

    /** One of the player's own Xaero waypoints. */
    public record LocalWaypoint(String set, String name, String initials, String dim, int x, int y, int z, int color) {}

    private MinimapBridge() {}

    public static boolean loaded() {
        return LOADED;
    }

    public static void tick() {
        if (!LOADED) return;
        try {
            MinimapAccess.tick();
        } catch (Throwable t) {
            MinimapAccess.failed(t);
        }
    }

    public static List<LocalWaypoint> localWaypoints() {
        if (!LOADED) return List.of();
        try {
            return MinimapAccess.localWaypoints();
        } catch (Throwable t) {
            MinimapAccess.failed(t);
            return List.of();
        }
    }

    /** Waypoints selected in Xaero's waypoint list screen; null if that could not be read. */
    public static List<LocalWaypoint> selectedIn(Object guiWaypoints) {
        if (!LOADED) return null;
        try {
            return MinimapAccess.selectedIn(guiWaypoints);
        } catch (Throwable t) {
            MinimapAccess.failed(t);
            return null;
        }
    }

    /** Xaero color index of a minimap waypoint object, or -1. */
    public static int colorOf(Object xaeroWaypoint) {
        if (!LOADED || xaeroWaypoint == null) return -1;
        return MinimapAccess.colorOf(xaeroWaypoint);
    }

    /** Shared-waypoint id behind a waypoint object shown by Xaero, or -1. */
    public static int sharedIdOf(Object xaeroWaypoint) {
        if (!LOADED || xaeroWaypoint == null) return -1;
        return MinimapAccess.sharedIdOf(xaeroWaypoint);
    }
}
