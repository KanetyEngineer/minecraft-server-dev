package dev.kanety.solaria.client.xaero;

import dev.kanety.solaria.client.waypoint.ClientWaypoints;
import dev.kanety.solaria.client.waypoint.ShareWaypointScreen;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.screens.ConfirmScreen;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.network.chat.Component;
import xaero.map.gui.IRightClickableElement;
import xaero.map.gui.dropdown.rightclick.RightClickOption;

/** Right-click entries on a waypoint in Xaero's World Map: share your own waypoint, or remove a shared one. */
public final class ShareMapWaypointOption extends RightClickOption {
    private final Runnable action;

    private ShareMapWaypointOption(String name, int index, IRightClickableElement target, Runnable action) {
        super(name, index, target);
        this.action = action;
    }

    public static ShareMapWaypointOption share(int index, IRightClickableElement target, String dim, int x, int y, int z, String name, int color) {
        return new ShareMapWaypointOption("サーバーに共有", index, target, () -> {
            Minecraft mc = Minecraft.getInstance();
            mc.setScreen(new ShareWaypointScreen(mc.screen, dim, x, y, z, name, color));
        });
    }

    public static ShareMapWaypointOption remove(int index, IRightClickableElement target, int id, String name) {
        return new ShareMapWaypointOption("共有地点を削除", index, target, () -> {
            Minecraft mc = Minecraft.getInstance();
            Screen back = mc.screen;
            mc.setScreen(new ConfirmScreen(ok -> {
                if (ok) ClientWaypoints.remove(id);
                mc.setScreen(back);
            }, Component.literal("共有地点「" + name + "」を削除しますか？"), Component.literal("全員の地図から消えます（削除できるのは追加した本人か OP だけです）。")));
        });
    }

    @Override
    public void onAction(Screen screen) {
        action.run();
    }
}
