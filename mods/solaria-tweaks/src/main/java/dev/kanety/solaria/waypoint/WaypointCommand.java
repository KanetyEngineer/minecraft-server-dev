package dev.kanety.solaria.waypoint;

import com.mojang.brigadier.CommandDispatcher;
import com.mojang.brigadier.arguments.IntegerArgumentType;
import com.mojang.brigadier.arguments.StringArgumentType;
import com.mojang.brigadier.context.CommandContext;
import com.mojang.brigadier.exceptions.CommandSyntaxException;
import com.mojang.brigadier.exceptions.SimpleCommandExceptionType;
import net.minecraft.ChatFormatting;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.commands.Commands;
import net.minecraft.commands.arguments.DimensionArgument;
import net.minecraft.network.chat.Component;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.server.permissions.Permission;
import net.minecraft.server.permissions.PermissionLevel;

import java.util.concurrent.ThreadLocalRandom;

/** /swp — waypoints shared with everyone. The Xaero buttons of Solaria Tweaks run these commands. */
public final class WaypointCommand {
    private static final SimpleCommandExceptionType NOT_RUNNING = new SimpleCommandExceptionType(Component.literal("共有地点はまだ準備中です"));
    private static final SimpleCommandExceptionType NOT_FOUND = new SimpleCommandExceptionType(Component.literal("その番号の共有地点はありません（/swp list で一覧）"));
    private static final SimpleCommandExceptionType NOT_ALLOWED = new SimpleCommandExceptionType(Component.literal("追加した人か OP だけができます"));
    private static final SimpleCommandExceptionType DUPLICATE = new SimpleCommandExceptionType(Component.literal("同じ名前・同じ場所の共有地点がもうあります"));

    private WaypointCommand() {}

    public static void register(CommandDispatcher<CommandSourceStack> d) {
        d.register(Commands.literal("swp")
                .executes(WaypointCommand::list)
                .then(Commands.literal("list").executes(WaypointCommand::list))
                .then(Commands.literal("add")
                        .then(Commands.argument("name", StringArgumentType.greedyString()).executes(WaypointCommand::addHere)))
                .then(Commands.literal("share")
                        .then(Commands.argument("dimension", DimensionArgument.dimension())
                        .then(Commands.argument("x", IntegerArgumentType.integer())
                        .then(Commands.argument("y", IntegerArgumentType.integer())
                        .then(Commands.argument("z", IntegerArgumentType.integer())
                        .then(Commands.argument("color", IntegerArgumentType.integer(0, 15))
                        .then(Commands.argument("initials", StringArgumentType.string())
                        .then(Commands.argument("name", StringArgumentType.greedyString()).executes(WaypointCommand::share)))))))))
                .then(Commands.literal("remove")
                        .then(Commands.argument("id", IntegerArgumentType.integer(1)).executes(WaypointCommand::remove)))
                .then(Commands.literal("rename")
                        .then(Commands.argument("id", IntegerArgumentType.integer(1))
                        .then(Commands.argument("name", StringArgumentType.greedyString()).executes(WaypointCommand::rename)))));
    }

    private static SharedWaypoints store() throws CommandSyntaxException {
        SharedWaypoints s = SharedWaypoints.get();
        if (s == null) throw NOT_RUNNING.create();
        return s;
    }

    private static int list(CommandContext<CommandSourceStack> c) throws CommandSyntaxException {
        SharedWaypoints s = store();
        if (s.entries().isEmpty()) {
            c.getSource().sendSuccess(() -> Component.literal("共有地点はまだありません。/swp add <名前> で今いる場所を追加できます"), false);
            return 0;
        }
        c.getSource().sendSuccess(() -> Component.literal("共有地点 " + s.entries().size() + " 件").withStyle(ChatFormatting.GOLD), false);
        for (SharedWaypoints.Entry e : s.entries()) {
            c.getSource().sendSuccess(() -> Component.literal("#" + e.id + " ").withStyle(ChatFormatting.GRAY)
                    .append(Component.literal(e.name).withStyle(ChatFormatting.WHITE))
                    .append(Component.literal("  " + e.x + " " + e.y + " " + e.z + "  " + shortDim(e.dim) + "  by " + e.owner)
                            .withStyle(ChatFormatting.GRAY)), false);
        }
        return s.entries().size();
    }

    private static int addHere(CommandContext<CommandSourceStack> c) throws CommandSyntaxException {
        ServerPlayer p = c.getSource().getPlayerOrException();
        String name = StringArgumentType.getString(c, "name").strip();
        String dim = p.level().dimension().identifier().toString();
        return add(c, name, "", dim, p.getBlockX(), p.getBlockY(), p.getBlockZ(), ThreadLocalRandom.current().nextInt(16));
    }

    private static int share(CommandContext<CommandSourceStack> c) throws CommandSyntaxException {
        String dim = DimensionArgument.getDimension(c, "dimension").dimension().identifier().toString();
        return add(c, StringArgumentType.getString(c, "name").strip(), StringArgumentType.getString(c, "initials").strip(), dim,
                IntegerArgumentType.getInteger(c, "x"), IntegerArgumentType.getInteger(c, "y"), IntegerArgumentType.getInteger(c, "z"),
                IntegerArgumentType.getInteger(c, "color"));
    }

    private static int add(CommandContext<CommandSourceStack> c, String name, String initials, String dim, int x, int y, int z, int color)
            throws CommandSyntaxException {
        SharedWaypoints s = store();
        for (SharedWaypoints.Entry e : s.entries()) {
            if (e.name.equals(name) && e.dim.equals(dim) && e.x == x && e.y == y && e.z == z) throw DUPLICATE.create();
        }
        if (initials.codePointCount(0, initials.length()) > 2) initials = initials.substring(0, initials.offsetByCodePoints(0, 2));
        SharedWaypoints.Entry e = s.add(name, initials, dim, x, y, z, color, c.getSource().getPlayer());
        c.getSource().getServer().getPlayerList().broadcastSystemMessage(Component.literal("[共有地点] ").withStyle(ChatFormatting.GOLD)
                .append(Component.literal(e.owner + " が「" + e.name + "」(" + e.x + " " + e.y + " " + e.z + " " + shortDim(e.dim) + ") を共有しました")
                        .withStyle(ChatFormatting.WHITE)), false);
        return e.id;
    }

    private static SharedWaypoints.Entry editable(CommandContext<CommandSourceStack> c) throws CommandSyntaxException {
        SharedWaypoints.Entry e = store().find(IntegerArgumentType.getInteger(c, "id"));
        if (e == null) throw NOT_FOUND.create();
        CommandSourceStack s = c.getSource();
        if (s.permissions().hasPermission(new Permission.HasCommandLevel(PermissionLevel.byId(2)))) return e;
        ServerPlayer p = s.getPlayer();
        if (p != null && p.getStringUUID().equals(e.ownerUuid)) return e;
        throw NOT_ALLOWED.create();
    }

    private static int remove(CommandContext<CommandSourceStack> c) throws CommandSyntaxException {
        SharedWaypoints.Entry e = editable(c);
        store().remove(e);
        c.getSource().sendSuccess(() -> Component.literal("共有地点「" + e.name + "」を削除しました"), false);
        return 1;
    }

    private static int rename(CommandContext<CommandSourceStack> c) throws CommandSyntaxException {
        SharedWaypoints.Entry e = editable(c);
        e.name = StringArgumentType.getString(c, "name").strip();
        e.initials = SharedWaypoints.initialsOf(e.name);
        store().changed();
        c.getSource().sendSuccess(() -> Component.literal("共有地点 #" + e.id + " を「" + e.name + "」にしました"), false);
        return 1;
    }

    public static String shortDim(String dim) {
        return switch (dim) {
            case "minecraft:overworld" -> "オーバーワールド";
            case "minecraft:the_nether" -> "ネザー";
            case "minecraft:the_end" -> "エンド";
            default -> dim;
        };
    }
}
