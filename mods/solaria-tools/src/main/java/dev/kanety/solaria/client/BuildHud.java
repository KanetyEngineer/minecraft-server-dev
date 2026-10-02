package dev.kanety.solaria.client;

import net.minecraft.client.DeltaTracker;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.Font;
import net.minecraft.client.gui.GuiGraphics;

import java.util.ArrayList;
import java.util.List;

/** Small progress overlay: your build plans and what is assigned to you. */
public final class BuildHud {
    private BuildHud() {}

    public static void render(GuiGraphics g, DeltaTracker delta) {
        Minecraft mc = Minecraft.getInstance();
        ClientConfig cfg = ClientConfig.get();
        if (!cfg.hudEnabled || mc.player == null || !ClientBuildState.received || mc.options.hideGui) return;
        if (mc.getDebugOverlay().showDebugScreen()) return;
        String me = mc.player.getStringUUID();
        List<String> lines = new ArrayList<>();
        List<Integer> colors = new ArrayList<>();
        for (ClientBuildState.Project p : ClientBuildState.projects) {
            if (!cfg.hudProject.isEmpty() ? !cfg.hudProject.equals(p.name()) : !p.isMember(me)) continue;
            lines.add("■ " + p.name() + "  材料 " + pct(p.materialProgress()) + "  建築 " + pct(p.buildProgress()));
            colors.add(0xFFFFD27F);
            int shown = 0;
            for (ClientBuildState.Material m : p.materials()) {
                if (m.assignee() == null || !m.assignee().uuid().equals(me) || m.remaining() <= 0) continue;
                if (shown++ >= cfg.hudMaxLines) break;
                lines.add("  " + BuildScreen.itemName(m.item()) + " あと " + BuildScreen.stacks(m.remaining()));
                colors.add(0xFFFFFFFF);
            }
            for (ClientBuildState.Area a : p.areas()) {
                if (a.assignee() == null || !a.assignee().uuid().equals(me)) continue;
                lines.add("  区画 " + a.id() + "  " + pct(a.progress()) + "  (" + a.x1() + "," + a.z1() + ")");
                colors.add(a.done() >= a.total() ? 0xFF7FFF7F : 0xFF9FD7FF);
            }
        }
        if (lines.isEmpty()) return;
        Font font = mc.font;
        int w = 0;
        for (String l : lines) w = Math.max(w, font.width(l));
        int x = g.guiWidth() - w - 6;
        int y = g.guiHeight() / 3;
        g.fill(x - 3, y - 3, x + w + 3, y + lines.size() * 10 + 1, 0x80000000);
        for (int i = 0; i < lines.size(); i++) g.drawString(font, lines.get(i), x, y + i * 10, colors.get(i), true);
    }

    static String pct(double v) {
        return String.format("%.0f%%", v * 100);
    }
}
