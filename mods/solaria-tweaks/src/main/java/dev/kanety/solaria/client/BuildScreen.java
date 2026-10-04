package dev.kanety.solaria.client;

import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.GuiGraphics;
import net.minecraft.client.gui.components.Button;
import net.minecraft.client.gui.components.Tooltip;
import net.minecraft.client.gui.screens.ConfirmScreen;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.network.chat.Component;
import net.minecraft.resources.Identifier;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.HitResult;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;

/**
 * Build plans screen (default key: B). Every action runs a /bp command, so the server stays the
 * single source of truth and players without the mod can do the same from chat.
 */
public class BuildScreen extends Screen {
    private enum Tab { MATERIALS, AREAS, SETTINGS }

    private static String lastProject = "";
    private static Tab lastTab = Tab.MATERIALS;
    private static boolean onlyMine;

    private final Screen parent;
    private String selected;
    private Tab tab = lastTab;
    private int scroll;
    private List<ClientBuildState.Project> builtFrom;

    private static final int ROW = 20;
    private int left, top, right, bottom, listTop;

    public BuildScreen(Screen parent) {
        super(Component.literal("建築計画"));
        this.parent = parent;
        this.selected = lastProject;
    }

    private ClientBuildState.Project project() {
        ClientBuildState.Project p = ClientBuildState.find(selected);
        if (p == null && !ClientBuildState.projects.isEmpty()) {
            p = ClientBuildState.projects.getFirst();
            selected = p.name();
        }
        return p;
    }

    private String me() {
        return minecraft != null && minecraft.player != null ? minecraft.player.getStringUUID() : "";
    }

    private static void run(String command) {
        Minecraft mc = Minecraft.getInstance();
        if (mc.player != null) mc.player.connection.sendCommand(command);
    }

    @Override
    protected void init() {
        builtFrom = ClientBuildState.projects;
        left = 8;
        right = width - 8;
        top = 24;
        bottom = height - 8;
        int sideW = Math.min(110, width / 4);
        int x = left;
        int y = top;
        // project list
        for (ClientBuildState.Project p : ClientBuildState.projects) {
            boolean sel = p.name().equals(selected) || (selected.isEmpty() && p == project());
            addRenderableWidget(Button.builder(Component.literal((sel ? "▶ " : "") + p.name()), b -> {
                selected = p.name();
                lastProject = selected;
                scroll = 0;
                rebuildWidgets();
            }).bounds(x, y, sideW, 18).tooltip(Tooltip.create(Component.literal(p.placementName() + "\n材料 "
                    + BuildHud.pct(p.materialProgress()) + " / 建築 " + BuildHud.pct(p.buildProgress())))).build());
            y += 20;
            if (y > bottom - 40) break;
        }
        addRenderableWidget(Button.builder(Component.literal("＋ 設計図から作成"), b -> minecraft.setScreen(new CreateScreen(this)))
                .bounds(x, Math.max(y + 4, bottom - 18), sideW, 18).build());

        ClientConfig.GuardMode mode = ClientConfig.get().guardMode();
        addRenderableWidget(Button.builder(Component.literal("オブザーバー警告: " + mode.label), b -> {
            ClientConfig.get().setGuardMode(mode.next());
            rebuildWidgets();
        }).bounds(right - 170, 3, 170, 16)
                .tooltip(Tooltip.create(Component.literal("オブザーバーが見ている場所にブロックを置こうとすると止めて警告します。\n設計図と違うものだけ: Litematica の設計図と違うブロックのとき\nすべてのブロック: 何を置くときでも\n3秒以内にもう一度置くと設置されます。")))
                .build());

        int cx = left + sideW + 8;
        listTop = top + 22;
        ClientBuildState.Project p = project();
        if (p == null) return;
        int tw = 56;
        addRenderableWidget(tabButton("材料", Tab.MATERIALS, cx, tw));
        addRenderableWidget(tabButton("区画", Tab.AREAS, cx + tw + 2, tw));
        addRenderableWidget(tabButton("設定", Tab.SETTINGS, cx + (tw + 2) * 2, tw));
        if (tab == Tab.MATERIALS || tab == Tab.AREAS) {
            addRenderableWidget(Button.builder(Component.literal(onlyMine ? "自分の担当だけ" : "すべて表示"), b -> {
                onlyMine = !onlyMine;
                scroll = 0;
                rebuildWidgets();
            }).bounds(right - 84, top, 84, 18).build());
        }
        switch (tab) {
            case MATERIALS -> initMaterials(p, cx);
            case AREAS -> initAreas(p, cx);
            case SETTINGS -> initSettings(p, cx);
        }
    }

    private Button tabButton(String label, Tab t, int x, int w) {
        Button b = Button.builder(Component.literal(t == tab ? "[" + label + "]" : label), btn -> {
            tab = t;
            lastTab = t;
            scroll = 0;
            rebuildWidgets();
        }).bounds(x, top, w, 18).build();
        return b;
    }

    private int visibleRows() {
        return Math.max(1, (bottom - listTop) / ROW);
    }

    private List<ClientBuildState.Material> materialRows(ClientBuildState.Project p) {
        String me = me();
        List<ClientBuildState.Material> rows = new ArrayList<>();
        for (ClientBuildState.Material m : p.materials()) {
            if (onlyMine && (m.assignee() == null || !m.assignee().uuid().equals(me))) continue;
            rows.add(m);
        }
        rows.sort(Comparator.comparingInt(ClientBuildState.Material::remaining).reversed());
        return rows;
    }

    private List<ClientBuildState.Area> areaRows(ClientBuildState.Project p) {
        String me = me();
        List<ClientBuildState.Area> rows = new ArrayList<>();
        for (ClientBuildState.Area a : p.areas()) {
            if (onlyMine && (a.assignee() == null || !a.assignee().uuid().equals(me))) continue;
            rows.add(a);
        }
        return rows;
    }

    private void initMaterials(ClientBuildState.Project p, int cx) {
        List<ClientBuildState.Material> rows = materialRows(p);
        String me = me();
        java.util.Map<String, ChestTrackerBridge.Found> remembered = ChestTrackerBridge.find(p);
        int n = visibleRows();
        for (int i = 0; i < n && scroll + i < rows.size(); i++) {
            ClientBuildState.Material m = rows.get(scroll + i);
            int y = listTop + i * ROW;
            ChestTrackerBridge.Found f = remembered.get(m.item());
            String ct = f == null ? "" : "\nChest Tracker の記憶（倉庫以外）: " + f.count() + "（最寄り "
                    + f.nearest().getX() + " " + f.nearest().getY() + " " + f.nearest().getZ() + "）";
            boolean mine = m.assignee() != null && m.assignee().uuid().equals(me);
            String cmd = (mine ? "bp unclaim " : "bp claim ") + p.name() + " " + m.item();
            addRenderableWidget(Button.builder(Component.literal(mine ? "外す" : "担当"), b -> run(cmd))
                    .bounds(right - 36, y, 36, 18)
                    .tooltip(Tooltip.create(Component.literal(itemName(m.item()) + "\n必要 " + m.req() + "（" + stacks(m.req()) + "）"
                            + "\n設置済み " + m.placed() + "\n倉庫 " + m.stock() + "\n参加者の手持ち " + m.held()
                            + "\n残り " + m.remaining() + "（" + stacks(m.remaining()) + "）"
                            + "\n担当 " + (m.assignee() == null ? "なし" : m.assignee().name()) + ct)))
                    .build());
        }
    }

    private void initAreas(ClientBuildState.Project p, int cx) {
        List<ClientBuildState.Area> rows = areaRows(p);
        String me = me();
        int n = visibleRows();
        for (int i = 0; i < n && scroll + i < rows.size(); i++) {
            ClientBuildState.Area a = rows.get(scroll + i);
            int y = listTop + i * ROW;
            boolean mine = a.assignee() != null && a.assignee().uuid().equals(me);
            String cmd = (mine ? "bp areaunclaim " : "bp areaclaim ") + p.name() + " " + a.id();
            addRenderableWidget(Button.builder(Component.literal(mine ? "外す" : "担当"), b -> run(cmd))
                    .bounds(right - 36, y, 36, 18).build());
        }
    }

    private void initSettings(ClientBuildState.Project p, int cx) {
        int w = Math.min(150, (right - cx - 6) / 2);
        int x2 = cx + w + 6;
        int y = listTop;
        boolean member = p.isMember(me());
        addRenderableWidget(Button.builder(Component.literal(member ? "この計画から抜ける" : "この計画に参加する"),
                b -> run("bp " + (member ? "leave " : "join ") + p.name())).bounds(cx, y, w, 18).build());
        addRenderableWidget(Button.builder(Component.literal("自動で割り当てる"), b -> run("bp autoassign " + p.name()))
                .bounds(x2, y, w, 18)
                .tooltip(Tooltip.create(Component.literal("参加者（いなければオンラインの全員）に、残りの材料と未完成の区画を均等に配ります。作成者と OP のみ。")))
                .build());
        y += 22;
        addRenderableWidget(Button.builder(Component.literal("見ている容器を倉庫に追加"), b -> lookedAt().ifPresent(pos ->
                run("bp storage " + p.name() + " add " + pos.getX() + " " + pos.getY() + " " + pos.getZ())))
                .bounds(cx, y, w, 18)
                .tooltip(Tooltip.create(Component.literal("画面を閉じる前に見ていたチェスト・樽・シュルカーボックスを、この計画の倉庫にします。中身が在庫として数えられます。")))
                .build());
        addRenderableWidget(Button.builder(Component.literal("見ている容器を倉庫から外す"), b -> lookedAt().ifPresent(pos ->
                run("bp storage " + p.name() + " remove " + pos.getX() + " " + pos.getY() + " " + pos.getZ())))
                .bounds(x2, y, w, 18).build());
        y += 26;
        int bw = Math.max(40, (right - cx - 18) / 4);
        int[] sizes = {16, 32, 64};
        for (int i = 0; i < sizes.length; i++) {
            int s = sizes[i];
            boolean cur = "grid".equals(p.areaMode()) && p.gridSize() == s;
            addRenderableWidget(Button.builder(Component.literal((cur ? "▶ " : "") + s + "マス"), b -> run("bp areamode " + p.name() + " grid " + s))
                    .bounds(cx + i * (bw + 6), y + 12, bw, 18).build());
        }
        boolean sub = "subregions".equals(p.areaMode());
        addRenderableWidget(Button.builder(Component.literal((sub ? "▶ " : "") + "サブリージョン"), b -> run("bp areamode " + p.name() + " subregions"))
                .bounds(cx + 3 * (bw + 6), y + 12, bw, 18).build());
        y += 38;
        ClientConfig cfg = ClientConfig.get();
        addRenderableWidget(Button.builder(Component.literal("HUD: " + (cfg.hudEnabled ? "表示" : "非表示")), b -> {
            cfg.hudEnabled = !cfg.hudEnabled;
            ClientConfig.save();
            rebuildWidgets();
        }).bounds(cx, y, w, 18).build());
        boolean pinned = p.name().equals(cfg.hudProject);
        addRenderableWidget(Button.builder(Component.literal(pinned ? "HUD: 参加中の計画すべて" : "HUD: この計画だけ"), b -> {
            cfg.hudProject = pinned ? "" : p.name();
            ClientConfig.save();
            rebuildWidgets();
        }).bounds(x2, y, w, 18).build());
        y += 30;
        addRenderableWidget(Button.builder(Component.literal("この建築計画を削除"), b -> minecraft.setScreen(new ConfirmScreen(ok -> {
            if (ok) run("bp delete " + p.name());
            minecraft.setScreen(this);
        }, Component.literal("「" + p.name() + "」を削除しますか？"), Component.literal("割り当てと倉庫の登録が消えます。Syncmatica の設計図は消えません。"))))
                .bounds(cx, y, w, 18).build());
    }

    private java.util.Optional<BlockPos> lookedAt() {
        HitResult hit = minecraft.hitResult;
        if (hit instanceof BlockHitResult bhr && hit.getType() == HitResult.Type.BLOCK) return java.util.Optional.of(bhr.getBlockPos());
        if (minecraft.player != null) minecraft.player.displayClientMessage(Component.literal("容器を見ながら B キーでこの画面を開いてください"), false);
        return java.util.Optional.empty();
    }

    @Override
    public void tick() {
        if (builtFrom != ClientBuildState.projects) rebuildWidgets();
    }

    @Override
    public boolean mouseScrolled(double mouseX, double mouseY, double scrollX, double scrollY) {
        ClientBuildState.Project p = project();
        if (p == null || tab == Tab.SETTINGS) return false;
        int total = tab == Tab.MATERIALS ? materialRows(p).size() : areaRows(p).size();
        int max = Math.max(0, total - visibleRows());
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
        g.drawString(font, title, left, 8, 0xFFFFFFFF, true);
        int sideW = Math.min(110, width / 4);
        int cx = left + sideW + 8;
        ClientBuildState.Project p = project();
        if (!ClientBuildState.received) {
            g.drawString(font, "サーバーに Solaria Tweaks が入っていないか、まだ受信していません。", cx, top + 4, 0xFFFF9F9F, true);
            return;
        }
        if (p == null) {
            g.drawString(font, "建築計画はまだありません。左下の「＋ 設計図から作成」から作れます。", cx, top + 4, 0xFFFFFFFF, true);
            return;
        }
        String head = p.placementName() + "  材料 " + BuildHud.pct(p.materialProgress()) + "  建築 " + BuildHud.pct(p.buildProgress())
                + " (" + p.done() + "/" + p.total() + ")" + statusText(p.status());
        g.drawString(font, font.plainSubstrByWidth(head, right - cx - 90 - 3 * 58), cx + 3 * 58 + 4, top + 5, 0xFFFFD27F, true);
        switch (tab) {
            case MATERIALS -> renderMaterials(g, p, cx);
            case AREAS -> renderAreas(g, p, cx);
            case SETTINGS -> renderSettings(g, p, cx);
        }
    }

    private static String statusText(String status) {
        return switch (status) {
            case "ready" -> "";
            case "loading", "parsing" -> "  読み込み中…";
            case "missing" -> "  設計図が削除されています";
            case "no-file" -> "  設計図ファイルがサーバーにありません";
            case "no-syncmatica" -> "  サーバーに Syncmatica がありません";
            default -> "  設計図を読めませんでした";
        };
    }

    private void renderMaterials(GuiGraphics g, ClientBuildState.Project p, int cx) {
        List<ClientBuildState.Material> rows = materialRows(p);
        java.util.Map<String, ChestTrackerBridge.Found> remembered = ChestTrackerBridge.find(p);
        if (rows.isEmpty()) {
            g.drawString(font, onlyMine ? "あなたの担当の材料はありません" : "材料はありません", cx, listTop + 4, 0xFFAAAAAA, true);
            return;
        }
        int n = visibleRows();
        int barW = 70;
        int assigneeX = right - 36 - 4 - 64;
        int barX = assigneeX - 6 - barW;
        int nameW = barX - (cx + 20) - 64;
        for (int i = 0; i < n && scroll + i < rows.size(); i++) {
            ClientBuildState.Material m = rows.get(scroll + i);
            int y = listTop + i * ROW;
            if (i % 2 == 0) g.fill(cx, y - 1, right, y + ROW - 1, 0x22FFFFFF);
            g.renderItem(stack(m.item()), cx + 1, y + 1);
            g.drawString(font, font.plainSubstrByWidth(itemName(m.item()), nameW), cx + 20, y + 5, 0xFFFFFFFF, true);
            String rem = m.remaining() == 0 ? "そろった" : "あと " + stacks(m.remaining());
            ChestTrackerBridge.Found f = remembered.get(m.item());
            if (f != null && m.remaining() > 0) rem = "箱に" + f.count() + " " + rem;
            g.drawString(font, rem, barX - 4 - font.width(rem), y + 5, m.remaining() == 0 ? 0xFF7FFF7F : 0xFFFFFFFF, true);
            bar(g, barX, y + 3, barW, 12, m.req() == 0 ? 1 : (double) m.placed() / m.req(), m.progress(),
                    (m.placed() + m.stock() + m.held()) + "/" + m.req());
            String who = m.assignee() == null ? "-" : m.assignee().name();
            g.drawString(font, font.plainSubstrByWidth(who, 64), assigneeX, y + 5, m.assignee() == null ? 0xFF888888 : 0xFF9FD7FF, true);
        }
        scrollHint(g, rows.size());
    }

    private void renderAreas(GuiGraphics g, ClientBuildState.Project p, int cx) {
        List<ClientBuildState.Area> rows = areaRows(p);
        if (rows.isEmpty()) {
            g.drawString(font, onlyMine ? "あなたの担当の区画はありません" : "区画はありません", cx, listTop + 4, 0xFFAAAAAA, true);
            return;
        }
        int n = visibleRows();
        int assigneeX = right - 36 - 4 - 64;
        int barW = 90;
        int barX = assigneeX - 6 - barW;
        for (int i = 0; i < n && scroll + i < rows.size(); i++) {
            ClientBuildState.Area a = rows.get(scroll + i);
            int y = listTop + i * ROW;
            if (i % 2 == 0) g.fill(cx, y - 1, right, y + ROW - 1, 0x22FFFFFF);
            g.drawString(font, a.id(), cx + 2, y + 5, 0xFFFFD27F, true);
            String range = "X " + a.x1() + "〜" + a.x2() + "  Z " + a.z1() + "〜" + a.z2();
            g.drawString(font, font.plainSubstrByWidth(range, barX - cx - 40), cx + 36, y + 5, 0xFFDDDDDD, true);
            bar(g, barX, y + 3, barW, 12, a.progress(), a.progress(), BuildHud.pct(a.progress()));
            String who = a.assignee() == null ? "-" : a.assignee().name();
            g.drawString(font, font.plainSubstrByWidth(who, 64), assigneeX, y + 5, a.assignee() == null ? 0xFF888888 : 0xFF9FD7FF, true);
        }
        scrollHint(g, rows.size());
    }

    private void renderSettings(GuiGraphics g, ClientBuildState.Project p, int cx) {
        int y = listTop + 22 + 26;
        g.drawString(font, "区画の分け方（変えると区画の担当はリセット）", cx, y, 0xFFDDDDDD, true);
        y = listTop + 22 + 26 + 38 + 30 + 26;
        StringBuilder members = new StringBuilder();
        for (ClientBuildState.Person m : p.members()) members.append(members.isEmpty() ? "" : ", ").append(m.name());
        g.drawString(font, font.plainSubstrByWidth("作成者: " + p.owner() + "   参加者: " + (members.isEmpty() ? "なし" : members), right - cx), cx, y, 0xFFDDDDDD, true);
        y += 12;
        g.drawString(font, "倉庫 " + p.storages().size() + " 個", cx, y, 0xFFDDDDDD, true);
        y += 10;
        for (int[] s : p.storages()) {
            if (y > bottom - 10) break;
            g.drawString(font, "  " + s[0] + " " + s[1] + " " + s[2], cx, y, 0xFFAAAAAA, false);
            y += 10;
        }
    }

    private void scrollHint(GuiGraphics g, int total) {
        int n = visibleRows();
        if (total > n) {
            String t = (scroll + 1) + "-" + Math.min(total, scroll + n) + " / " + total + "（ホイールでスクロール）";
            g.drawString(font, t, right - font.width(t), 10, 0xFF888888, false);
        }
    }

    /** Two-tone bar: dark green = already placed, light green = placed + collected. */
    private void bar(GuiGraphics g, int x, int y, int w, int h, double placed, double collected, String label) {
        g.fill(x, y, x + w, y + h, 0xFF333333);
        int c = (int) Math.round(w * Math.min(1, collected));
        int pl = (int) Math.round(w * Math.min(1, placed));
        g.fill(x, y, x + c, y + h, 0xFF4E9A4E);
        g.fill(x, y, x + pl, y + h, 0xFF2E6B2E);
        g.drawCenteredString(font, label, x + w / 2, y + 2, 0xFFFFFFFF);
    }

    static ItemStack stack(String id) {
        Identifier rl = Identifier.tryParse(id);
        Item item = rl == null ? Items.BARRIER : BuiltInRegistries.ITEM.getValue(rl);
        return new ItemStack(item);
    }

    static String itemName(String id) {
        return stack(id).getHoverName().getString();
    }

    static String stacks(int count) {
        if (count < 64) return Integer.toString(count);
        int st = count / 64, rest = count % 64;
        if (count >= 64 * 27) {
            double boxes = count / (64.0 * 27);
            return count + "（" + String.format("%.1f", boxes) + "箱）";
        }
        return count + "（" + st + "st" + (rest > 0 ? "+" + rest : "") + "）";
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
