package dev.kanety.solaria.client.xaero;

import net.fabricmc.fabric.api.client.screen.v1.Screens;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.components.Button;
import net.minecraft.client.gui.components.Tooltip;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.network.chat.Component;

/** Adds a "Server waypoints" button to Xaero's World Map screen. */
public final class XaeroMapIntegration {
    public static final String GUI_MAP = "xaero.map.gui.GuiMap";

    private XaeroMapIntegration() {}

    public static void onScreenInit(Minecraft client, Screen screen, int width, int height) {
        if (!GUI_MAP.equals(screen.getClass().getName())) return;
        Button button = Button.builder(Component.literal("サーバー地点"), b -> ServerWaypointBridge.openManager(screen))
                .bounds(width - 76, 2, 74, 16)
                .tooltip(Tooltip.create(Component.literal("サーバー共有の地点一覧（Server Waypoint）を開きます。\n地図を右クリック →「ここをサーバー地点に追加」でも追加できます。")))
                .build();
        Screens.getButtons(screen).add(button);
    }
}
