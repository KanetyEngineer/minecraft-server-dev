package dev.kanety.solaria.client.xaero;

import dev.kanety.solaria.client.waypoint.ClientWaypoints;
import dev.kanety.solaria.client.waypoint.SharedWaypointsScreen;
import net.fabricmc.fabric.api.client.screen.v1.Screens;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.components.Button;
import net.minecraft.client.gui.components.Tooltip;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.network.chat.Component;

import java.util.List;

/**
 * Buttons on Xaero's screens: "サーバー地点" on the World Map, and "サーバーに共有" on the Minimap's waypoint list
 * (shares the waypoints selected there).
 */
public final class XaeroMapIntegration {
    public static final String GUI_MAP = "xaero.map.gui.GuiMap";
    public static final String GUI_WAYPOINTS = "xaero.common.gui.GuiWaypoints";

    private XaeroMapIntegration() {}

    public static void onScreenInit(Minecraft client, Screen screen, int width, int height) {
        String name = screen.getClass().getName();
        if (GUI_MAP.equals(name)) {
            Screens.getButtons(screen).add(Button.builder(Component.literal("サーバー地点"),
                            b -> client.setScreen(new SharedWaypointsScreen(screen)))
                    .bounds(width - 76, 2, 74, 16)
                    .tooltip(Tooltip.create(Component.literal("サーバーで共有している地点の一覧と、自分の地点の共有。\n地図を右クリック →「ここをサーバー地点に追加」、自分の地点を右クリック →「サーバーに共有」でも追加できます。")))
                    .build());
        } else if (GUI_WAYPOINTS.equals(name) && MinimapBridge.loaded()) {
            Screens.getButtons(screen).add(Button.builder(Component.literal("選んだ地点をサーバーに共有"), b -> shareSelected(client, screen))
                    .bounds(2, 2, 150, 16)
                    .tooltip(Tooltip.create(Component.literal("この一覧で選んでいる地点（Ctrl/Shift で複数）を、サーバーの共有地点にします。")))
                    .build());
        }
    }

    private static void shareSelected(Minecraft client, Screen screen) {
        List<MinimapBridge.LocalWaypoint> picked = MinimapBridge.selectedIn(screen);
        if (client.player == null) return;
        if (picked == null) {
            client.player.displayClientMessage(Component.literal("選んだ地点を読み取れませんでした。地図の「サーバー地点」→「自分の地点を共有」を使ってください"), false);
            return;
        }
        if (picked.isEmpty()) {
            client.player.displayClientMessage(Component.literal("共有する地点を一覧で選んでください"), true);
            return;
        }
        int sent = 0;
        for (MinimapBridge.LocalWaypoint w : picked) {
            if (ClientWaypoints.isShared(w.dim(), w.x(), w.y(), w.z(), w.name())) continue;
            ClientWaypoints.share(w.dim(), w.x(), w.y(), w.z(), w.color(), w.initials(), w.name());
            sent++;
        }
        client.player.displayClientMessage(Component.literal(sent + " 件をサーバーに共有しました" + (sent < picked.size() ? "（共有済みは除外）" : "")), true);
    }
}
