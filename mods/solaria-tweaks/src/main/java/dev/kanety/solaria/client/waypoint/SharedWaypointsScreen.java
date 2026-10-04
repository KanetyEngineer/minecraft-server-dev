package dev.kanety.solaria.client.waypoint;

import dev.kanety.solaria.client.xaero.MinimapBridge;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.GuiGraphics;
import net.minecraft.client.gui.components.Button;
import net.minecraft.client.gui.components.Tooltip;
import net.minecraft.client.gui.screens.ConfirmScreen;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.network.chat.Component;

import java.util.List;

/**
 * Shared waypoints of the server, and the player's own Xaero waypoints with a "share" button each.
 * Opened from the "サーバー地点" button of Xaero's World Map.
 */
public class SharedWaypointsScreen extends Screen {
    private static boolean localTab;

    private final Screen parent;
    private int scroll;
    private int builtVersion;
    private List<MinimapBridge.LocalWaypoint> local = List.of();

    private static final int ROW = 20;
    private static final int TOP = 44;

    public SharedWaypointsScreen(Screen parent) {
        super(Component.literal("サーバー共有の地点"));
        this.parent = parent;
    }

    private int visible() {
        return Math.max(1, (height - TOP - 34) / ROW);
    }

    private int rowCount() {
        return localTab ? local.size() : ClientWaypoints.entries().size();
    }

    @Override
    protected void init() {
        builtVersion = ClientWaypoints.version();
        if (localTab) local = MinimapBridge.localWaypoints();
        int tw = 120;
        addRenderableWidget(Button.builder(Component.literal((localTab ? "" : "▶ ") + "サーバー共有 (" + ClientWaypoints.entries().size() + ")"), b -> {
            localTab = false;
            scroll = 0;
            rebuildWidgets();
        }).bounds(width / 2 - tw - 2, 22, tw, 18).build());
        addRenderableWidget(Button.builder(Component.literal((localTab ? "▶ " : "") + "自分の地点を共有"), b -> {
            localTab = true;
            scroll = 0;
            rebuildWidgets();
        }).bounds(width / 2 + 2, 22, tw, 18)
                .tooltip(Tooltip.create(Component.literal("Xaero's Minimap に登録した自分の地点（今いるワールドとディメンションの全セット）から選んで共有します")))
                .build());

        String me = minecraft != null && minecraft.player != null ? minecraft.player.getStringUUID() : "";
        int n = visible();
        if (localTab) {
            for (int i = 0; i < n && scroll + i < local.size(); i++) {
                MinimapBridge.LocalWaypoint w = local.get(scroll + i);
                boolean shared = ClientWaypoints.isShared(w.dim(), w.x(), w.y(), w.z(), w.name());
                Button b = Button.builder(Component.literal(shared ? "共有済み" : "共有"),
                        btn -> ClientWaypoints.share(w.dim(), w.x(), w.y(), w.z(), w.color(), w.initials(), w.name()))
                        .bounds(width - 70, TOP + i * ROW, 60, 18).build();
                b.active = !shared;
                addRenderableWidget(b);
            }
            Button all = Button.builder(Component.literal("まとめて共有"), b -> {
                for (MinimapBridge.LocalWaypoint w : local) {
                    if (!ClientWaypoints.isShared(w.dim(), w.x(), w.y(), w.z(), w.name())) {
                        ClientWaypoints.share(w.dim(), w.x(), w.y(), w.z(), w.color(), w.initials(), w.name());
                    }
                }
            }).bounds(10, height - 26, 100, 20).build();
            all.active = !local.isEmpty();
            addRenderableWidget(all);
        } else {
            List<ClientWaypoints.Entry> entries = ClientWaypoints.entries();
            for (int i = 0; i < n && scroll + i < entries.size(); i++) {
                ClientWaypoints.Entry e = entries.get(scroll + i);
                Button b = Button.builder(Component.literal("削除"), btn -> minecraft.setScreen(new ConfirmScreen(ok -> {
                    if (ok) ClientWaypoints.remove(e.id());
                    minecraft.setScreen(this);
                }, Component.literal("共有地点「" + e.name() + "」を削除しますか？"), Component.literal("全員の地図から消えます。"))))
                        .bounds(width - 70, TOP + i * ROW, 60, 18)
                        .tooltip(Tooltip.create(Component.literal(me.equals(e.ownerUuid()) ? "自分が追加した地点です" : "追加した人か OP だけが削除できます")))
                        .build();
                addRenderableWidget(b);
            }
            addRenderableWidget(Button.builder(Component.literal("今いる場所を共有"), b -> {
                Minecraft mc = Minecraft.getInstance();
                if (mc.player == null || mc.level == null) return;
                mc.setScreen(new ShareWaypointScreen(this, mc.level.dimension().identifier().toString(),
                        mc.player.getBlockX(), mc.player.getBlockY(), mc.player.getBlockZ(), "", -1));
            }).bounds(10, height - 26, 110, 20).build());
        }
        addRenderableWidget(Button.builder(Component.literal("閉じる"), b -> onClose()).bounds(width / 2 - 50, height - 26, 100, 20).build());
    }

    @Override
    public void tick() {
        if (builtVersion != ClientWaypoints.version()) rebuildWidgets();
    }

    @Override
    public boolean mouseScrolled(double mouseX, double mouseY, double scrollX, double scrollY) {
        int max = Math.max(0, rowCount() - visible());
        int next = Math.max(0, Math.min(max, scroll - (int) Math.signum(scrollY) * 3));
        if (next != scroll) {
            scroll = next;
            rebuildWidgets();
        }
        return true;
    }

    @Override
    public void render(GuiGraphics g, int mouseX, int mouseY, float partialTick) {
        super.render(g, mouseX, mouseY, partialTick);
        g.drawCenteredString(font, title, width / 2, 8, 0xFFFFFFFF);
        int n = visible();
        int textW = width - 90;
        if (localTab) {
            if (!MinimapBridge.loaded()) {
                g.drawCenteredString(font, "Xaero's Minimap が入っていません", width / 2, TOP + 4, 0xFFFF9F9F);
                return;
            }
            if (local.isEmpty()) {
                g.drawCenteredString(font, "このワールドとディメンションには自分の地点がありません", width / 2, TOP + 4, 0xFFAAAAAA);
                return;
            }
            for (int i = 0; i < n && scroll + i < local.size(); i++) {
                MinimapBridge.LocalWaypoint w = local.get(scroll + i);
                int y = TOP + i * ROW + 5;
                String line = "[" + w.initials() + "] " + w.name() + "   " + w.x() + " " + w.y() + " " + w.z()
                        + "  " + ClientWaypoints.shortDim(w.dim()) + "  セット: " + w.set();
                g.drawString(font, font.plainSubstrByWidth(line, textW), 10, y, 0xFFFFFFFF, true);
            }
        } else {
            List<ClientWaypoints.Entry> entries = ClientWaypoints.entries();
            if (!ClientWaypoints.received) {
                g.drawCenteredString(font, "サーバーに Solaria Tweaks が入っていないか、まだデータを受け取っていません", width / 2, TOP + 4, 0xFFFF9F9F);
                return;
            }
            if (entries.isEmpty()) {
                g.drawCenteredString(font, "共有地点はまだありません。「自分の地点を共有」か、地図の右クリックメニューから追加できます", width / 2, TOP + 4, 0xFFAAAAAA);
                return;
            }
            for (int i = 0; i < n && scroll + i < entries.size(); i++) {
                ClientWaypoints.Entry e = entries.get(scroll + i);
                int y = TOP + i * ROW + 5;
                String line = "#" + e.id() + " [" + e.initials() + "] " + e.name() + "   " + e.x() + " " + e.y() + " " + e.z()
                        + "  " + ClientWaypoints.shortDim(e.dim()) + "  by " + e.owner();
                g.drawString(font, font.plainSubstrByWidth(line, textW), 10, y, 0xFFFFFFFF, true);
            }
        }
    }

    @Override
    public void onClose() {
        if (minecraft != null) minecraft.setScreen(parent);
    }
}
