package dev.kanety.solaria.client.xaero;

import dev.kanety.solaria.client.waypoint.ShareWaypointScreen;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.screens.Screen;
import xaero.map.gui.IRightClickableElement;
import xaero.map.gui.dropdown.rightclick.RightClickOption;

/** "Add here as a server waypoint" entry in Xaero's World Map right-click menu. */
public final class AddServerWaypointOption extends RightClickOption {
    private final String dimension;
    private final int x, y, z;

    public AddServerWaypointOption(int index, IRightClickableElement target, String dimension, int x, int y, int z) {
        super("ここをサーバー地点に追加", index, target);
        this.dimension = dimension;
        this.x = x;
        this.y = y;
        this.z = z;
    }

    @Override
    public void onAction(Screen screen) {
        Minecraft.getInstance().setScreen(new ShareWaypointScreen(screen, dimension, x, y, z, "", -1));
    }
}
