package dev.kanety.solaria.plan;

import com.mojang.brigadier.CommandDispatcher;
import com.mojang.brigadier.arguments.IntegerArgumentType;
import com.mojang.brigadier.arguments.StringArgumentType;
import com.mojang.brigadier.context.CommandContext;
import com.mojang.brigadier.exceptions.CommandSyntaxException;
import com.mojang.brigadier.exceptions.SimpleCommandExceptionType;
import com.mojang.brigadier.suggestion.SuggestionProvider;
import net.minecraft.ChatFormatting;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.commands.Commands;
import net.minecraft.commands.SharedSuggestionProvider;
import net.minecraft.commands.arguments.EntityArgument;
import net.minecraft.commands.arguments.coordinates.BlockPosArgument;
import net.minecraft.core.BlockPos;
import net.minecraft.network.chat.Component;
import net.minecraft.network.chat.MutableComponent;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.server.permissions.Permission;
import net.minecraft.server.permissions.PermissionLevel;
import net.minecraft.world.item.Item;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;

/** /bp — shared build plans for Syncmatica placements. Every GUI button maps to one of these commands. */
public final class BuildCommand {
    private static final SimpleCommandExceptionType NOT_RUNNING = new SimpleCommandExceptionType(Component.literal("建築計画の準備中です。少し待ってからもう一度試してください"));
    private static final SimpleCommandExceptionType NO_PROJECT = new SimpleCommandExceptionType(Component.literal("その名前の建築計画は見つかりません"));
    private static final SimpleCommandExceptionType NO_PLACEMENT = new SimpleCommandExceptionType(Component.literal("その Syncmatica の設計図は見つかりません（/bp placements で一覧を確認できます）"));
    private static final SimpleCommandExceptionType EXISTS = new SimpleCommandExceptionType(Component.literal("同じ名前の建築計画がすでにあります"));
    private static final SimpleCommandExceptionType NOT_ALLOWED = new SimpleCommandExceptionType(Component.literal("この操作は作成者か OP だけができます"));
    private static final SimpleCommandExceptionType NO_ITEM = new SimpleCommandExceptionType(Component.literal("そのアイテムはこの設計図の材料に含まれていません"));
    private static final SimpleCommandExceptionType NO_AREA = new SimpleCommandExceptionType(Component.literal("その区画は見つかりません"));
    private static final SimpleCommandExceptionType NOT_CONTAINER = new SimpleCommandExceptionType(Component.literal("そこは容器（チェスト・樽・シュルカーボックスなど）ではありません"));

    private BuildCommand() {}

    public static void register(CommandDispatcher<CommandSourceStack> d) {
        SuggestionProvider<CommandSourceStack> projects = (c, b) -> {
            BuildManager m = BuildManager.get();
            return SharedSuggestionProvider.suggest(m == null ? List.of() : m.projects().keySet(), b);
        };
        SuggestionProvider<CommandSourceStack> items = (c, b) -> {
            BuildProject p = projectOrNull(c);
            List<String> ids = new ArrayList<>();
            if (p != null) for (Item i : p.required.keySet()) ids.add(BuildProject.itemId(i));
            return SharedSuggestionProvider.suggest(ids, b);
        };
        SuggestionProvider<CommandSourceStack> areas = (c, b) -> {
            BuildProject p = projectOrNull(c);
            return SharedSuggestionProvider.suggest(p == null ? List.of() : p.areaIds, b);
        };
        SuggestionProvider<CommandSourceStack> placements = (c, b) -> {
            BuildManager m = BuildManager.get();
            List<String> ids = new ArrayList<>();
            if (m != null) for (SyncmaticaBridge.PlacementInfo p : m.placements()) ids.add(p.id().toString());
            return SharedSuggestionProvider.suggest(ids, b);
        };

        var root = Commands.literal("bp")
                .executes(BuildCommand::list)
                .then(Commands.literal("list").executes(BuildCommand::list))
                .then(Commands.literal("placements").executes(BuildCommand::placements))
                .then(Commands.literal("create")
                        .then(Commands.argument("name", StringArgumentType.word())
                                .then(Commands.argument("placement", StringArgumentType.string()).suggests(placements)
                                        .executes(BuildCommand::create))))
                .then(Commands.literal("delete")
                        .then(Commands.argument("project", StringArgumentType.word()).suggests(projects)
                                .executes(BuildCommand::delete)))
                .then(Commands.literal("info")
                        .then(Commands.argument("project", StringArgumentType.word()).suggests(projects)
                                .executes(BuildCommand::info)))
                .then(Commands.literal("materials")
                        .then(Commands.argument("project", StringArgumentType.word()).suggests(projects)
                                .executes(BuildCommand::materials)))
                .then(Commands.literal("areas")
                        .then(Commands.argument("project", StringArgumentType.word()).suggests(projects)
                                .executes(BuildCommand::areas)))
                .then(Commands.literal("join")
                        .then(Commands.argument("project", StringArgumentType.word()).suggests(projects)
                                .executes(c -> join(c, true))))
                .then(Commands.literal("leave")
                        .then(Commands.argument("project", StringArgumentType.word()).suggests(projects)
                                .executes(c -> join(c, false))))
                .then(Commands.literal("claim")
                        .then(Commands.argument("project", StringArgumentType.word()).suggests(projects)
                                .then(Commands.argument("item", StringArgumentType.greedyString()).suggests(items)
                                        .executes(c -> assignMaterial(c, c.getSource().getPlayerOrException(), false)))))
                .then(Commands.literal("unclaim")
                        .then(Commands.argument("project", StringArgumentType.word()).suggests(projects)
                                .then(Commands.argument("item", StringArgumentType.greedyString()).suggests(items)
                                        .executes(c -> assignMaterial(c, null, false)))))
                .then(Commands.literal("assign")
                        .then(Commands.argument("project", StringArgumentType.word()).suggests(projects)
                                .then(Commands.argument("player", EntityArgument.player())
                                        .then(Commands.argument("item", StringArgumentType.greedyString()).suggests(items)
                                                .executes(c -> assignMaterial(c, EntityArgument.getPlayer(c, "player"), true))))))
                .then(Commands.literal("areaclaim")
                        .then(Commands.argument("project", StringArgumentType.word()).suggests(projects)
                                .then(Commands.argument("area", StringArgumentType.word()).suggests(areas)
                                        .executes(c -> assignArea(c, c.getSource().getPlayerOrException(), false)))))
                .then(Commands.literal("areaunclaim")
                        .then(Commands.argument("project", StringArgumentType.word()).suggests(projects)
                                .then(Commands.argument("area", StringArgumentType.word()).suggests(areas)
                                        .executes(c -> assignArea(c, null, false)))))
                .then(Commands.literal("areaassign")
                        .then(Commands.argument("project", StringArgumentType.word()).suggests(projects)
                                .then(Commands.argument("area", StringArgumentType.word()).suggests(areas)
                                        .then(Commands.argument("player", EntityArgument.player())
                                                .executes(c -> assignArea(c, EntityArgument.getPlayer(c, "player"), true))))))
                .then(Commands.literal("ignore")
                        .then(Commands.argument("project", StringArgumentType.word()).suggests(projects)
                                .then(Commands.argument("item", StringArgumentType.greedyString()).suggests(items)
                                        .executes(c -> ignoreMaterial(c, true)))))
                .then(Commands.literal("unignore")
                        .then(Commands.argument("project", StringArgumentType.word()).suggests(projects)
                                .then(Commands.argument("item", StringArgumentType.greedyString()).suggests(items)
                                        .executes(c -> ignoreMaterial(c, false)))))
                .then(Commands.literal("areaignore")
                        .then(Commands.argument("project", StringArgumentType.word()).suggests(projects)
                                .then(Commands.argument("area", StringArgumentType.word()).suggests(areas)
                                        .executes(c -> ignoreArea(c, true)))))
                .then(Commands.literal("areaunignore")
                        .then(Commands.argument("project", StringArgumentType.word()).suggests(projects)
                                .then(Commands.argument("area", StringArgumentType.word()).suggests(areas)
                                        .executes(c -> ignoreArea(c, false)))))
                .then(Commands.literal("autoassign")
                        .then(Commands.argument("project", StringArgumentType.word()).suggests(projects)
                                .executes(BuildCommand::autoAssign)))
                .then(Commands.literal("areamode")
                        .then(Commands.argument("project", StringArgumentType.word()).suggests(projects)
                                .then(Commands.literal("grid")
                                        .then(Commands.argument("size", IntegerArgumentType.integer(4, 512))
                                                .executes(c -> areaMode(c, "grid", IntegerArgumentType.getInteger(c, "size")))))
                                .then(Commands.literal("subregions").executes(c -> areaMode(c, "subregions", 0)))))
                .then(Commands.literal("storage")
                        .then(Commands.argument("project", StringArgumentType.word()).suggests(projects)
                                .then(Commands.literal("add")
                                        .then(Commands.argument("pos", BlockPosArgument.blockPos()).executes(c -> storage(c, true))))
                                .then(Commands.literal("remove")
                                        .then(Commands.argument("pos", BlockPosArgument.blockPos()).executes(c -> storage(c, false))))
                                .then(Commands.literal("clear").executes(BuildCommand::storageClear))));
        d.register(root);
    }

    // ---------------------------------------------------------------- helpers

    private static BuildManager manager() throws CommandSyntaxException {
        BuildManager m = BuildManager.get();
        if (m == null) throw NOT_RUNNING.create();
        return m;
    }

    private static BuildProject projectOrNull(CommandContext<CommandSourceStack> c) {
        try {
            BuildManager m = BuildManager.get();
            return m == null ? null : m.projects().get(StringArgumentType.getString(c, "project"));
        } catch (IllegalArgumentException e) {
            return null;
        }
    }

    private static BuildProject project(CommandContext<CommandSourceStack> c) throws CommandSyntaxException {
        BuildProject p = manager().projects().get(StringArgumentType.getString(c, "project"));
        if (p == null) throw NO_PROJECT.create();
        return p;
    }

    private static boolean isOp(CommandSourceStack s) {
        return s.permissions().hasPermission(new Permission.HasCommandLevel(PermissionLevel.byId(2)));
    }

    private static void requireOwner(CommandSourceStack s, BuildProject p) throws CommandSyntaxException {
        if (isOp(s)) return;
        ServerPlayer pl = s.getPlayer();
        if (pl != null && (p.data.ownerUuid == null || pl.getStringUUID().equals(p.data.ownerUuid))) return;
        throw NOT_ALLOWED.create();
    }

    private static BuildProject.Person person(ServerPlayer p) {
        return new BuildProject.Person(p.getStringUUID(), p.getName().getString());
    }

    private static Item findItem(BuildProject p, String raw) throws CommandSyntaxException {
        String id = raw.trim();
        if (!id.contains(":")) id = "minecraft:" + id;
        for (Item i : p.required.keySet()) if (BuildProject.itemId(i).equals(id)) return i;
        throw NO_ITEM.create();
    }

    static String pct(double v) {
        return String.format("%.1f%%", v * 100);
    }

    private static void send(CommandSourceStack s, Component c) {
        s.sendSuccess(() -> c, false);
    }

    private static String statusText(BuildProject p) {
        return switch (p.status) {
            case "ready" -> "";
            case "loading", "parsing" -> "（読み込み中）";
            case "missing" -> "（Syncmatica の設計図が削除されています）";
            case "no-file" -> "（設計図ファイルがサーバーにありません）";
            case "no-syncmatica" -> "（サーバーに Syncmatica がありません）";
            default -> "（設計図を読み込めませんでした）";
        };
    }

    // ---------------------------------------------------------------- commands

    private static int list(CommandContext<CommandSourceStack> c) throws CommandSyntaxException {
        BuildManager m = manager();
        if (m.projects().isEmpty()) {
            send(c.getSource(), Component.literal("建築計画はまだありません。/bp placements で設計図を確認し、/bp create <名前> <番号> で作成できます。"));
            return 0;
        }
        send(c.getSource(), Component.literal("建築計画 " + m.projects().size() + " 件").withStyle(ChatFormatting.GOLD));
        for (BuildProject p : m.projects().values()) {
            send(c.getSource(), Component.literal(" " + p.data.name + " [" + p.placementName + "] 材料 " + pct(p.materialProgress())
                    + " / 建築 " + pct(p.buildProgress()) + " " + statusText(p)));
        }
        return m.projects().size();
    }

    private static int placements(CommandContext<CommandSourceStack> c) throws CommandSyntaxException {
        BuildManager m = manager();
        m.findPlacement("");
        List<SyncmaticaBridge.PlacementInfo> list = m.placements();
        if (list.isEmpty()) {
            send(c.getSource(), Component.literal(SyncmaticaBridge.isLoaded()
                    ? "Syncmatica で共有されている設計図はありません"
                    : "このサーバーには Syncmatica が入っていません"));
            return 0;
        }
        for (int i = 0; i < list.size(); i++) {
            SyncmaticaBridge.PlacementInfo p = list.get(i);
            BlockPos o = p.origin();
            send(c.getSource(), Component.literal((i + 1) + ". " + p.name() + " (" + p.owner() + ", " + p.dimension() + " "
                    + o.getX() + " " + o.getY() + " " + o.getZ() + ")"));
        }
        return list.size();
    }

    private static int create(CommandContext<CommandSourceStack> c) throws CommandSyntaxException {
        BuildManager m = manager();
        String name = StringArgumentType.getString(c, "name");
        if (m.projects().containsKey(name)) throw EXISTS.create();
        SyncmaticaBridge.PlacementInfo placement = m.findPlacement(StringArgumentType.getString(c, "placement"))
                .orElseThrow(NO_PLACEMENT::create);
        m.create(name, placement, c.getSource().getPlayer());
        send(c.getSource(), Component.literal("建築計画「" + name + "」を作成しました（" + placement.name() + "）。"
                + "材料と区画は数秒後に表示されます。").withStyle(ChatFormatting.GREEN));
        return 1;
    }

    private static int delete(CommandContext<CommandSourceStack> c) throws CommandSyntaxException {
        BuildProject p = project(c);
        requireOwner(c.getSource(), p);
        manager().delete(p.data.name);
        send(c.getSource(), Component.literal("建築計画「" + p.data.name + "」を削除しました"));
        return 1;
    }

    private static int info(CommandContext<CommandSourceStack> c) throws CommandSyntaxException {
        BuildProject p = project(c);
        CommandSourceStack s = c.getSource();
        send(s, Component.literal("「" + p.data.name + "」 " + p.placementName + " " + statusText(p)).withStyle(ChatFormatting.GOLD));
        send(s, Component.literal(" 材料 " + pct(p.materialProgress()) + " / 建築 " + pct(p.buildProgress())
                + "（" + p.countedDone() + " / " + p.countedTotal() + " ブロック）"));
        StringBuilder members = new StringBuilder();
        for (BuildProject.Person m : p.data.members) members.append(members.isEmpty() ? "" : ", ").append(m.name);
        send(s, Component.literal(" 参加者: " + (members.isEmpty() ? "なし" : members) + " / 倉庫 " + p.data.storages.size() + " 個"
                + " / 区画 " + p.areaIds.size() + " 個"));
        return 1;
    }

    private static int materials(CommandContext<CommandSourceStack> c) throws CommandSyntaxException {
        BuildProject p = project(c);
        CommandSourceStack s = c.getSource();
        send(s, Component.literal("「" + p.data.name + "」の材料（残りが多い順に上位15件）").withStyle(ChatFormatting.GOLD));
        List<Map.Entry<Item, Integer>> rows = new ArrayList<>(p.required.entrySet());
        rows.sort(Comparator.comparingInt((Map.Entry<Item, Integer> e) -> remaining(p, e.getKey(), e.getValue())).reversed());
        int shown = 0;
        rows.removeIf(e -> p.isIgnored(e.getKey()));
        for (Map.Entry<Item, Integer> e : rows) {
            if (shown++ >= 15) break;
            Item item = e.getKey();
            BuildProject.Person a = p.data.materialAssign.get(BuildProject.itemId(item));
            MutableComponent line = Component.literal(" ").append(item.getDefaultInstance().getHoverName())
                    .append(Component.literal(" 必要 " + e.getValue() + " / 設置 " + p.placed.getOrDefault(item, 0)
                            + " / 倉庫 " + p.stock.getOrDefault(item, 0) + " / 手持ち " + p.held.getOrDefault(item, 0)
                            + " / 残り " + remaining(p, item, e.getValue())
                            + " / 担当 " + (a == null ? "なし" : a.name)));
            send(s, line);
        }
        return rows.size();
    }

    static int remaining(BuildProject p, Item item, int req) {
        return Math.max(0, req - p.placed.getOrDefault(item, 0) - p.stock.getOrDefault(item, 0) - p.held.getOrDefault(item, 0));
    }

    private static int areas(CommandContext<CommandSourceStack> c) throws CommandSyntaxException {
        BuildProject p = project(c);
        CommandSourceStack s = c.getSource();
        send(s, Component.literal("「" + p.data.name + "」の区画").withStyle(ChatFormatting.GOLD));
        for (int i = 0; i < p.areaIds.size(); i++) {
            String id = p.areaIds.get(i);
            BuildProject.Person a = p.data.areaAssign.get(id);
            double prog = p.areaTotal[i] == 0 ? 0 : (double) p.areaDone[i] / p.areaTotal[i];
            send(s, Component.literal(" " + id + " (" + p.areaBounds[i * 4] + "," + p.areaBounds[i * 4 + 1] + " 〜 "
                    + p.areaBounds[i * 4 + 2] + "," + p.areaBounds[i * 4 + 3] + ") " + pct(prog)
                    + (p.isAreaIgnored(id) ? " （対象外）" : " 担当 " + (a == null ? "なし" : a.name))));
        }
        return p.areaIds.size();
    }

    private static int join(CommandContext<CommandSourceStack> c, boolean join) throws CommandSyntaxException {
        BuildProject p = project(c);
        ServerPlayer pl = c.getSource().getPlayerOrException();
        String uuid = pl.getStringUUID();
        p.data.members.removeIf(m -> m.uuid.equals(uuid));
        if (join) p.data.members.add(person(pl));
        manager().save();
        send(c.getSource(), Component.literal(join ? "「" + p.data.name + "」に参加しました" : "「" + p.data.name + "」から抜けました"));
        return 1;
    }

    private static int assignMaterial(CommandContext<CommandSourceStack> c, ServerPlayer target, boolean ownerOnly) throws CommandSyntaxException {
        BuildProject p = project(c);
        if (ownerOnly) requireOwner(c.getSource(), p);
        Item item = findItem(p, StringArgumentType.getString(c, "item"));
        String id = BuildProject.itemId(item);
        if (target == null) {
            p.data.materialAssign.remove(id);
        } else {
            p.data.materialAssign.put(id, person(target));
            if (!p.isMember(target.getStringUUID())) p.data.members.add(person(target));
        }
        manager().save();
        send(c.getSource(), Component.literal(item.getDefaultInstance().getHoverName().getString() + " の担当: "
                + (target == null ? "なし" : target.getName().getString())));
        return 1;
    }

    private static int assignArea(CommandContext<CommandSourceStack> c, ServerPlayer target, boolean ownerOnly) throws CommandSyntaxException {
        BuildProject p = project(c);
        if (ownerOnly) requireOwner(c.getSource(), p);
        String area = StringArgumentType.getString(c, "area");
        if (!p.areaIds.contains(area)) throw NO_AREA.create();
        if (target == null) {
            p.data.areaAssign.remove(area);
        } else {
            p.data.areaAssign.put(area, person(target));
            if (!p.isMember(target.getStringUUID())) p.data.members.add(person(target));
        }
        manager().save();
        send(c.getSource(), Component.literal("区画 " + area + " の担当: " + (target == null ? "なし" : target.getName().getString())));
        return 1;
    }

    private static int ignoreMaterial(CommandContext<CommandSourceStack> c, boolean ignore) throws CommandSyntaxException {
        BuildProject p = project(c);
        requireOwner(c.getSource(), p);
        Item item = findItem(p, StringArgumentType.getString(c, "item"));
        p.setIgnored(false, BuildProject.itemId(item), ignore);
        manager().save();
        send(c.getSource(), Component.literal(item.getDefaultInstance().getHoverName().getString()
                + (ignore ? " を材料から外しました（集める対象と進捗に入りません）" : " を材料に戻しました")));
        return 1;
    }

    private static int ignoreArea(CommandContext<CommandSourceStack> c, boolean ignore) throws CommandSyntaxException {
        BuildProject p = project(c);
        requireOwner(c.getSource(), p);
        String area = StringArgumentType.getString(c, "area");
        if (!p.areaIds.contains(area)) throw NO_AREA.create();
        p.setIgnored(true, area, ignore);
        manager().save();
        send(c.getSource(), Component.literal("区画 " + area + (ignore ? " を建築の対象から外しました（進捗に入りません）" : " を建築の対象に戻しました")));
        return 1;
    }

    private static int autoAssign(CommandContext<CommandSourceStack> c) throws CommandSyntaxException {
        BuildProject p = project(c);
        requireOwner(c.getSource(), p);
        List<BuildProject.Person> people = new ArrayList<>(p.data.members);
        if (people.isEmpty()) {
            for (ServerPlayer pl : manager().server().getPlayerList().getPlayers()) people.add(person(pl));
        }
        if (people.isEmpty()) return 0;
        // materials: biggest remaining amount goes to whoever has the least so far
        long[] load = new long[people.size()];
        p.data.materialAssign.clear();
        List<Map.Entry<Item, Integer>> rows = new ArrayList<>(p.required.entrySet());
        rows.sort(Comparator.comparingInt((Map.Entry<Item, Integer> e) -> remaining(p, e.getKey(), e.getValue())).reversed());
        for (Map.Entry<Item, Integer> e : rows) {
            int rem = remaining(p, e.getKey(), e.getValue());
            if (rem <= 0 || p.isIgnored(e.getKey())) continue;
            int best = 0;
            for (int i = 1; i < load.length; i++) if (load[i] < load[best]) best = i;
            load[best] += rem;
            p.data.materialAssign.put(BuildProject.itemId(e.getKey()), people.get(best));
        }
        // areas: unfinished areas, balanced by blocks left
        long[] areaLoad = new long[people.size()];
        p.data.areaAssign.clear();
        for (int a = 0; a < p.areaIds.size(); a++) {
            int left = p.areaTotal[a] - p.areaDone[a];
            if (left <= 0 || p.isAreaIgnored(p.areaIds.get(a))) continue;
            int best = 0;
            for (int i = 1; i < areaLoad.length; i++) if (areaLoad[i] < areaLoad[best]) best = i;
            areaLoad[best] += left;
            p.data.areaAssign.put(p.areaIds.get(a), people.get(best));
        }
        manager().save();
        send(c.getSource(), Component.literal(people.size() + " 人に材料 " + p.data.materialAssign.size() + " 種類と区画 "
                + p.data.areaAssign.size() + " 個を割り当てました").withStyle(ChatFormatting.GREEN));
        return 1;
    }

    private static int areaMode(CommandContext<CommandSourceStack> c, String mode, int size) throws CommandSyntaxException {
        BuildProject p = project(c);
        requireOwner(c.getSource(), p);
        p.data.areaMode = mode;
        if (size > 0) p.data.gridSize = size;
        p.data.areaAssign.clear();
        p.rebuildAreas();
        manager().save();
        send(c.getSource(), Component.literal("区画を" + ("grid".equals(mode) ? size + "×" + size + "マスごと" : "サブリージョンごと")
                + "に分けました（" + p.areaIds.size() + "区画。担当はリセットされました）"));
        return 1;
    }

    private static int storage(CommandContext<CommandSourceStack> c, boolean add) throws CommandSyntaxException {
        BuildProject p = project(c);
        BlockPos pos = BlockPosArgument.getBlockPos(c, "pos");
        long packed = pos.asLong();
        if (add) {
            if (!(c.getSource().getLevel().getBlockEntity(pos) instanceof net.minecraft.world.Container)) throw NOT_CONTAINER.create();
            if (!p.data.storages.contains(packed)) p.data.storages.add(packed);
        } else {
            p.data.storages.remove(Long.valueOf(packed));
        }
        manager().save();
        send(c.getSource(), Component.literal((add ? "倉庫に追加しました: " : "倉庫から外しました: ") + pos.getX() + " " + pos.getY() + " " + pos.getZ()
                + "（倉庫 " + p.data.storages.size() + " 個）"));
        return 1;
    }

    private static int storageClear(CommandContext<CommandSourceStack> c) throws CommandSyntaxException {
        BuildProject p = project(c);
        requireOwner(c.getSource(), p);
        p.data.storages.clear();
        manager().save();
        send(c.getSource(), Component.literal("倉庫の登録をすべて解除しました"));
        return 1;
    }
}
