package dev.kanety.solaria.client.waypoint;

import net.minecraft.client.gui.GuiGraphics;
import net.minecraft.client.gui.components.Button;
import net.minecraft.client.gui.components.EditBox;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.network.chat.Component;

import java.util.concurrent.ThreadLocalRandom;

/** Name and color for a new shared waypoint at given coordinates (map right-click, or "今いる場所を共有"). */
public class ShareWaypointScreen extends Screen {
    private static final String[] COLOR_NAMES = {"黒", "紺", "緑", "青緑", "赤茶", "紫", "金", "灰", "濃灰", "青", "黄緑", "水色", "赤", "ピンク", "黄", "白"};
    private static final int[] COLOR_RGB = {0x000000, 0x0000AA, 0x00AA00, 0x00AAAA, 0xAA0000, 0xAA00AA, 0xFFAA00, 0xAAAAAA,
            0x555555, 0x5555FF, 0x55FF55, 0x55FFFF, 0xFF5555, 0xFF55FF, 0xFFFF55, 0xFFFFFF};

    private final Screen parent;
    private final String dim;
    private final int x, y, z;
    private String name;
    private int color;
    private EditBox nameBox;
    private EditBox yBox;

    public ShareWaypointScreen(Screen parent, String dim, int x, int y, int z, String name, int color) {
        super(Component.literal("サーバー地点を追加"));
        this.parent = parent;
        this.dim = dim;
        this.x = x;
        this.y = y;
        this.z = z;
        this.name = name;
        this.color = color >= 0 ? color : ThreadLocalRandom.current().nextInt(16);
    }

    @Override
    protected void init() {
        int cx = width / 2;
        int top = height / 2 - 50;
        nameBox = new EditBox(font, cx - 100, top + 20, 200, 20, Component.literal("名前"));
        nameBox.setMaxLength(64);
        nameBox.setValue(name);
        nameBox.setResponder(v -> name = v);
        addRenderableWidget(nameBox);
        setInitialFocus(nameBox);
        yBox = new EditBox(font, cx - 100, top + 56, 60, 20, Component.literal("Y"));
        yBox.setMaxLength(6);
        yBox.setValue(Integer.toString(y));
        addRenderableWidget(yBox);
        addRenderableWidget(Button.builder(Component.literal("色: " + COLOR_NAMES[color]), b -> {
            color = (color + 1) % 16;
            rebuildWidgets();
        }).bounds(cx - 30, top + 56, 130, 20).build());
        addRenderableWidget(Button.builder(Component.literal("共有する"), b -> {
            int fy = y;
            try {
                fy = Integer.parseInt(yBox.getValue().strip());
            } catch (NumberFormatException ignored) {
            }
            ClientWaypoints.share(dim, x, fy, z, color, "", name);
            onClose();
        }).bounds(cx - 100, top + 90, 96, 20).build());
        addRenderableWidget(Button.builder(Component.literal("やめる"), b -> onClose()).bounds(cx + 4, top + 90, 96, 20).build());
    }

    @Override
    public void render(GuiGraphics g, int mouseX, int mouseY, float partialTick) {
        super.render(g, mouseX, mouseY, partialTick);
        int cx = width / 2;
        int top = height / 2 - 50;
        g.drawCenteredString(font, title, cx, top - 14, 0xFFFFFFFF);
        g.drawString(font, "名前", cx - 100, top + 8, 0xFFDDDDDD, true);
        g.drawString(font, "X " + x + "   Z " + z + "   " + ClientWaypoints.shortDim(dim) + "   Y:", cx - 100, top + 44, 0xFFDDDDDD, true);
        g.fill(cx + 104, top + 58, cx + 120, top + 74, 0xFF000000 | COLOR_RGB[color]);
    }

    @Override
    public void onClose() {
        if (minecraft != null) minecraft.setScreen(parent);
    }
}
