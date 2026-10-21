package dev.kanety.solaria.waypoint;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.reflect.TypeToken;
import dev.kanety.solaria.SolariaTweaks;
import dev.kanety.solaria.net.WaypointSyncPayload;
import net.fabricmc.fabric.api.networking.v1.ServerPlayNetworking;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.level.storage.LevelResource;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

/** Waypoints shared with everyone on the server (world/solariatweaks/waypoints.json). */
public final class SharedWaypoints {
    private static final Gson GSON = new GsonBuilder().setPrettyPrinting().disableHtmlEscaping().create();
    private static SharedWaypoints instance;

    public static final class Entry {
        public int id;
        public String name;
        public String initials;
        /** Dimension id, e.g. minecraft:the_nether. */
        public String dim;
        public int x, y, z;
        /** Xaero waypoint color index (0-15). */
        public int color;
        public String owner;
        public String ownerUuid;
        public long created;
    }

    private final MinecraftServer server;
    private final Path file;
    private final List<Entry> entries = new ArrayList<>();
    private int nextId = 1;

    private SharedWaypoints(MinecraftServer server) {
        this.server = server;
        this.file = server.getWorldPath(LevelResource.ROOT).resolve("solariatweaks").resolve("waypoints.json");
    }

    public static SharedWaypoints get() {
        return instance;
    }

    public static void start(MinecraftServer server) {
        instance = new SharedWaypoints(server);
        instance.load();
    }

    public static void stop() {
        instance = null;
    }

    public List<Entry> entries() {
        return entries;
    }

    public Entry find(int id) {
        for (Entry e : entries) if (e.id == id) return e;
        return null;
    }

    public Entry add(String name, String initials, String dim, int x, int y, int z, int color, ServerPlayer owner) {
        Entry e = new Entry();
        e.id = nextId++;
        e.name = name;
        e.initials = initials == null || initials.isBlank() ? initialsOf(name) : initials;
        e.dim = dim;
        e.x = x;
        e.y = y;
        e.z = z;
        e.color = Math.floorMod(color, 16);
        e.owner = owner != null ? owner.getName().getString() : "server";
        e.ownerUuid = owner != null ? owner.getStringUUID() : null;
        e.created = System.currentTimeMillis();
        entries.add(e);
        changed();
        return e;
    }

    public void remove(Entry e) {
        entries.remove(e);
        changed();
    }

    public void changed() {
        save();
        broadcast();
    }

    public static String initialsOf(String name) {
        String n = name.strip();
        if (n.isEmpty()) return "X";
        int end = n.offsetByCodePoints(0, 1);
        return n.substring(0, end).toUpperCase();
    }

    // ---------------------------------------------------------------- sync

    public String toJson() {
        return GSON.toJson(entries);
    }

    public void send(ServerPlayer player) {
        if (ServerPlayNetworking.canSend(player, WaypointSyncPayload.TYPE)) {
            ServerPlayNetworking.send(player, new WaypointSyncPayload(toJson()));
        }
    }

    private void broadcast() {
        for (ServerPlayer player : server.getPlayerList().getPlayers()) send(player);
    }

    // ---------------------------------------------------------------- persistence

    private void load() {
        if (!Files.exists(file)) return;
        try {
            List<Entry> list = GSON.fromJson(Files.readString(file, StandardCharsets.UTF_8), new TypeToken<List<Entry>>() {}.getType());
            if (list != null) entries.addAll(list);
            for (Entry e : entries) nextId = Math.max(nextId, e.id + 1);
        } catch (Exception e) {
            SolariaTweaks.LOGGER.error("Could not read {}", file, e);
        }
    }

    private void save() {
        try {
            Files.createDirectories(file.getParent());
            Files.writeString(file, GSON.toJson(entries), StandardCharsets.UTF_8);
        } catch (IOException e) {
            SolariaTweaks.LOGGER.error("Could not write {}", file, e);
        }
    }
}
