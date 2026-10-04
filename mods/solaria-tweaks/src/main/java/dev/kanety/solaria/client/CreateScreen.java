package dev.kanety.solaria.client;

import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.GuiGraphics;
import net.minecraft.client.gui.components.Button;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.network.chat.Component;

import java.util.ArrayList;
import java.util.List;

/** Pick a Syncmatica placement to start a build plan from. */
public class CreateScreen extends Screen {
    private final Screen parent;
    private int scroll;

    public CreateScreen(Screen parent) {
        super(Component.literal("Syncmatica の設計図から建築計画を作る"));
        this.parent = parent;
    }

    private List<ClientBuildState.Placement> rows() {
        List<ClientBuildState.Placement> rows = new ArrayList<>();
        for (ClientBuildState.Placement p : ClientBuildState.placements) {
            boolean used = ClientBuildState.projects.stream().anyMatch(pr -> pr.placement().equals(p.id()));
            if (!used) rows.add(p);
        }
        return rows;
    }

    @Override
    protected void init() {
        List<ClientBuildState.Placement> rows = rows();
        int n = Math.max(1, (height - 70) / 22);
        for (int i = 0; i < n && scroll + i < rows.size(); i++) {
            ClientBuildState.Placement p = rows.get(scroll + i);
            int y = 40 + i * 22;
            addRenderableWidget(Button.builder(Component.literal("作成"), b -> {
                Minecraft mc = Minecraft.getInstance();
                if (mc.player != null) mc.player.connection.sendCommand("bp create " + uniqueName(p.name()) + " " + p.id());
                mc.setScreen(parent);
            }).bounds(width - 60, y, 50, 18).build());
        }
        addRenderableWidget(Button.builder(Component.literal("戻る"), b -> onClose()).bounds(width / 2 - 50, height - 26, 100, 20).build());
    }

    static String uniqueName(String placementName) {
        String base = placementName.replaceAll("[^A-Za-z0-9_\\-.+]", "");
        if (base.isEmpty()) base = "build";
        if (base.length() > 24) base = base.substring(0, 24);
        String name = base;
        int i = 2;
        while (ClientBuildState.find(name) != null) name = base + (i++);
        return name;
    }

    @Override
    public boolean mouseScrolled(double mouseX, double mouseY, double scrollX, double scrollY) {
        int max = Math.max(0, rows().size() - Math.max(1, (height - 70) / 22));
        int next = Math.max(0, Math.min(max, scroll - (int) Math.signum(scrollY)));
        if (next != scroll) {
            scroll = next;
            rebuildWidgets();
        }
        return true;
    }

    @Override
    public void render(GuiGraphics g, int mouseX, int mouseY, float partialTick) {
        super.render(g, mouseX, mouseY, partialTick);
        g.drawCenteredString(font, title, width / 2, 12, 0xFFFFFFFF);
        List<ClientBuildState.Placement> rows = rows();
        if (rows.isEmpty()) {
            g.drawCenteredString(font, ClientBuildState.syncmatica
                    ? "計画になっていない共有設計図はありません（Litematica の Syncmatica メニューから共有できます）"
                    : "サーバーに Syncmatica が入っていません", width / 2, 44, 0xFFAAAAAA);
            return;
        }
        int n = Math.max(1, (height - 70) / 22);
        for (int i = 0; i < n && scroll + i < rows.size(); i++) {
            ClientBuildState.Placement p = rows.get(scroll + i);
            int y = 40 + i * 22;
            g.drawString(font, p.name(), 12, y + 1, 0xFFFFFFFF, true);
            g.drawString(font, p.owner() + "  " + p.dim() + "  " + p.x() + " " + p.y() + " " + p.z(), 12, y + 10, 0xFFAAAAAA, false);
        }
    }

    @Override
    public void onClose() {
        minecraft.setScreen(parent);
    }

    @Override
    public boolean isPauseScreen() {
        return false;
    }
}
