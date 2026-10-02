package dev.kanety.solaria.client.xaero;

import _959.server_waypoint.common.client.WaypointClientMod;
import _959.server_waypoint.common.client.gui.screens.WaypointAddScreen;
import _959.server_waypoint.common.client.gui.screens.WaypointManagerScreen;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.screens.Screen;

/** Touches Server Waypoint's client classes; only loaded when that mod is present. */
final class ServerWaypointImpl {
    private ServerWaypointImpl() {}

    static boolean openManager() {
        Minecraft mc = Minecraft.getInstance();
        return WaypointClientMod.ifPresent(mod -> mc.setScreen(new WaypointManagerScreen(mod)));
    }

    static void openAdd(Screen parent, String dimension, int x, int y, int z) {
        Minecraft.getInstance().setScreen(new PrefilledAddScreen(parent, dimension, x, y, z));
    }

    /** Server Waypoint's add screen, pre-filled with the coordinates the map was right-clicked at. */
    private static final class PrefilledAddScreen extends WaypointAddScreen {
        PrefilledAddScreen(Screen parent, String dimension, int x, int y, int z) {
            super(parent, dimension, "");
            this.xEditBox.setDefaultValue(x);
            this.yEditBox.setDefaultValue(y);
            this.zEditBox.setDefaultValue(z);
            this.xEditBox.setValue(Integer.toString(x));
            this.yEditBox.setValue(Integer.toString(y));
            this.zEditBox.setValue(Integer.toString(z));
        }
    }
}
