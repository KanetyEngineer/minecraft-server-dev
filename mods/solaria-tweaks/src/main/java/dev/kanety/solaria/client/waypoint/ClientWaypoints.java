package dev.kanety.solaria.client.waypoint;

import com.google.gson.Gson;
import com.google.gson.reflect.TypeToken;
import net.minecraft.client.Minecraft;

import java.util.ArrayList;
import java.util.List;

/** Shared waypoints as last received from the server. */
public final class ClientWaypoints {
    private static final Gson GSON = new Gson();

    public record Entry(int id, String name, String initials, String dim, int x, int y, int z, int color, String owner, String ownerUuid) {}

    private static List<Entry> entries = List.of();
    private static int version;
    public static boolean received;

    private ClientWaypoints() {}

    public static void apply(String json) {
        List<Entry> list = GSON.fromJson(json, new TypeToken<List<Entry>>() {}.getType());
        entries = list == null ? List.of() : List.copyOf(list);
        received = true;
        version++;
    }

    public static void reset() {
        entries = List.of();
        received = false;
        version++;
    }

    public static List<Entry> entries() {
        return entries;
    }

    public static int version() {
        return version;
    }

    public static boolean isShared(String dim, int x, int y, int z, String name) {
        for (Entry e : entries) {
            if (e.dim().equals(dim) && e.x() == x && e.y() == y && e.z() == z && e.name().equals(name)) return true;
        }
        return false;
    }

    /** Sends /swp share for one waypoint. */
    public static void share(String dim, int x, int y, int z, int color, String initials, String name) {
        Minecraft mc = Minecraft.getInstance();
        if (mc.player == null) return;
        String n = name.replace('\n', ' ').strip();
        if (n.isEmpty()) n = "地点";
        String ini = initials == null || initials.isBlank() ? n.substring(0, n.offsetByCodePoints(0, 1)) : initials.strip();
        mc.player.connection.sendCommand("swp share " + dim + " " + x + " " + y + " " + z + " " + Math.floorMod(color, 16) + " "
                + quote(ini) + " " + n);
    }

    public static void remove(int id) {
        Minecraft mc = Minecraft.getInstance();
        if (mc.player != null) mc.player.connection.sendCommand("swp remove " + id);
    }

    private static String quote(String s) {
        return "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"") + "\"";
    }

    public static String shortDim(String dim) {
        return switch (dim) {
            case "minecraft:overworld" -> "オーバーワールド";
            case "minecraft:the_nether" -> "ネザー";
            case "minecraft:the_end" -> "エンド";
            default -> dim;
        };
    }

    public static List<Entry> copy() {
        return new ArrayList<>(entries);
    }
}
