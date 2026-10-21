package dev.kanety.solaria.board;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.kanety.solaria.SolariaTweaks;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.resources.Identifier;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.stats.Stat;
import net.minecraft.world.level.storage.LevelResource;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;

/**
 * Rankings built from vanilla statistics, for /lb top, /lb server and the OBS overlay. Bots (Carpet fake players and
 * players marked with /lb bot add) are left out. The sidebar display was removed in 1.6.0.
 */
public final class Leaderboard {
    private static final Gson GSON = new GsonBuilder().setPrettyPrinting().disableHtmlEscaping().create();
    private static final String OFF = "off";
    private static Leaderboard instance;

    /** Saved to world/solariatweaks/leaderboard.json. */
    private static final class Saved {
        /** 2 = the sidebar is off until a player picks something (1.4.0); older files defaulted to "mined". */
        int version;
        String defaultCriterion = OFF;
        Map<String, String> choices = new HashMap<>();
        Set<String> bots = new HashSet<>();
        Map<String, String> names = new HashMap<>();
    }

    /** Raw statistics of one player: type id -> (value id -> count), plus per-type totals. */
    private static final class PlayerStats {
        final Map<String, Map<String, Integer>> raw = new HashMap<>();
        final Map<String, Long> totals = new HashMap<>();

        void set(String type, String value, int count) {
            Integer old = raw.computeIfAbsent(type, k -> new HashMap<>()).put(value, count);
            totals.merge(type, (long) count - (old == null ? 0 : old), Long::sum);
        }

        long get(Criterion c) {
            if (c.all()) return totals.getOrDefault(c.type(), 0L);
            Map<String, Integer> m = raw.get(c.type());
            if (c.value().startsWith("*")) {
                // "*_one_cm": sum of every value with that suffix (all ways of moving)
                if (m == null) return 0;
                String suffix = c.value().substring(1);
                long sum = 0;
                for (Map.Entry<String, Integer> e : m.entrySet()) if (e.getKey().endsWith(suffix)) sum += e.getValue();
                return sum;
            }
            return m == null ? 0 : m.getOrDefault(c.value(), 0);
        }
    }

    private final MinecraftServer server;
    private final Path file;
    private Saved saved = new Saved();
    private final Map<UUID, PlayerStats> stats = new HashMap<>();
    private final Set<String> dirtyTypes = new HashSet<>();
    private int counter;
    private boolean serverDirty = true;

    private Leaderboard(MinecraftServer server) {
        this.server = server;
        this.file = server.getWorldPath(LevelResource.ROOT).resolve("solariatweaks").resolve("leaderboard.json");
    }

    public static Leaderboard get() {
        return instance;
    }

    public static void start(MinecraftServer server) {
        instance = new Leaderboard(server);
        instance.load();
        instance.loadStatFiles();
    }

    public static void stop() {
        if (instance != null) instance.save();
        instance = null;
    }

    // ---------------------------------------------------------------- bots

    public static boolean isFakePlayer(ServerPlayer player) {
        // Carpet (and addons such as GCA) spawn bots as subclasses of ServerPlayer.
        return player.getClass() != ServerPlayer.class;
    }

    public boolean isBot(UUID uuid) {
        return saved.bots.contains(uuid.toString());
    }

    public boolean isBot(ServerPlayer player) {
        if (isFakePlayer(player)) {
            if (saved.bots.add(player.getStringUUID())) {
                saved.names.put(player.getStringUUID(), player.getName().getString());
                save();
                markAllDirty();
            }
            return true;
        }
        return isBot(player.getUUID());
    }

    public boolean setBot(UUID uuid, boolean bot) {
        boolean changed = bot ? saved.bots.add(uuid.toString()) : saved.bots.remove(uuid.toString());
        if (changed) {
            if (bot) stats.remove(uuid);
            else readStatFile(uuid, server.getWorldPath(LevelResource.PLAYER_STATS_DIR).resolve(uuid + ".json"));
            save();
            markAllDirty();
        }
        return changed;
    }

    public List<String> botNames() {
        List<String> out = new ArrayList<>();
        for (String id : saved.bots) out.add(saved.names.getOrDefault(id, id));
        return out;
    }

    // ---------------------------------------------------------------- statistics

    /** Called from StatsCounterMixin whenever a server player's statistic changes. */
    public void onStat(ServerPlayer player, Stat<?> stat, int value) {
        if (!server.isSameThread() || isBot(player)) return;
        Identifier typeId = BuiltInRegistries.STAT_TYPE.getKey(stat.getType());
        Identifier valueId = valueKey(stat);
        if (typeId == null || valueId == null) return;
        PlayerStats ps = stats.computeIfAbsent(player.getUUID(), k -> new PlayerStats());
        String type = typeId.toString();
        String v = valueId.toString();
        Map<String, Integer> m = ps.raw.get(type);
        if (m != null && Objects.equals(m.get(v), value)) return;
        ps.set(type, v, value);
        dirtyTypes.add(type);
    }

    private static <T> Identifier valueKey(Stat<T> stat) {
        return stat.getType().getRegistry().getKey(stat.getValue());
    }

    public void onJoin(ServerPlayer player) {
        saved.names.put(player.getStringUUID(), player.getName().getString());
        if (isBot(player)) {
            if (stats.remove(player.getUUID()) != null) markAllDirty();
        } else if (!stats.containsKey(player.getUUID())) {
            readStatFile(player.getUUID(), server.getWorldPath(LevelResource.PLAYER_STATS_DIR).resolve(player.getStringUUID() + ".json"));
            markAllDirty();
        }
    }

    public void onLeave(ServerPlayer player) {
    }

    private void loadStatFiles() {
        Path dir = server.getWorldPath(LevelResource.PLAYER_STATS_DIR);
        if (Files.isDirectory(dir)) {
            try (DirectoryStream<Path> files = Files.newDirectoryStream(dir, "*.json")) {
                for (Path f : files) {
                    String name = f.getFileName().toString();
                    try {
                        UUID uuid = UUID.fromString(name.substring(0, name.length() - 5));
                        if (!isBot(uuid)) readStatFile(uuid, f);
                    } catch (IllegalArgumentException ignored) {
                    }
                }
            } catch (IOException e) {
                SolariaTweaks.LOGGER.warn("Could not list {}", dir, e);
            }
        }
        // Names of players who have not joined since this mod was installed.
        Path cache = Paths.get("usercache.json");
        if (Files.exists(cache)) {
            try {
                JsonArray arr = JsonParser.parseString(Files.readString(cache, StandardCharsets.UTF_8)).getAsJsonArray();
                for (JsonElement el : arr) {
                    JsonObject o = el.getAsJsonObject();
                    if (o.has("uuid") && o.has("name")) saved.names.putIfAbsent(o.get("uuid").getAsString(), o.get("name").getAsString());
                }
            } catch (Exception e) {
                SolariaTweaks.LOGGER.warn("Could not read usercache.json", e);
            }
        }
    }

    private void readStatFile(UUID uuid, Path f) {
        if (!Files.exists(f)) return;
        try {
            JsonObject root = JsonParser.parseString(Files.readString(f, StandardCharsets.UTF_8)).getAsJsonObject();
            JsonObject all = root.getAsJsonObject("stats");
            if (all == null) return;
            PlayerStats ps = new PlayerStats();
            for (Map.Entry<String, JsonElement> type : all.entrySet()) {
                if (!type.getValue().isJsonObject()) continue;
                for (Map.Entry<String, JsonElement> v : type.getValue().getAsJsonObject().entrySet()) {
                    ps.set(type.getKey(), v.getKey(), v.getValue().getAsInt());
                }
            }
            stats.put(uuid, ps);
        } catch (Exception e) {
            SolariaTweaks.LOGGER.warn("Could not read statistics {}", f, e);
        }
    }

    // ---------------------------------------------------------------- choices

    public record Rank(String name, long value) {}

    public List<Rank> ranking(Criterion c) {
        List<Rank> out = new ArrayList<>();
        for (Map.Entry<UUID, PlayerStats> e : stats.entrySet()) {
            if (isBot(e.getKey())) continue;
            long v = e.getValue().get(c);
            if (v <= 0) continue;
            String name = saved.names.get(e.getKey().toString());
            if (name == null) continue;
            out.add(new Rank(name, v));
        }
        out.sort((a, b) -> a.value != b.value ? Long.compare(b.value, a.value) : a.name.compareToIgnoreCase(b.name));
        return out;
    }

    /** Server-wide total of a criterion (every player except bots, offline players included). */
    public long total(Criterion c) {
        long sum = 0;
        for (Map.Entry<UUID, PlayerStats> e : stats.entrySet()) {
            if (!isBot(e.getKey())) sum += e.getValue().get(c);
        }
        return sum;
    }

    /** One player's value of a criterion (0 if unknown). */
    public long value(UUID uuid, Criterion c) {
        PlayerStats ps = stats.get(uuid);
        return ps == null ? 0 : ps.get(c);
    }

    /** Last known name of a player. */
    public String nameOf(UUID uuid) {
        return saved.names.get(uuid.toString());
    }

    /** Players (not bots) the leaderboard knows statistics for. */
    public int playerCount() {
        int n = 0;
        for (UUID id : stats.keySet()) if (!isBot(id)) n++;
        return n;
    }

    // ---------------------------------------------------------------- sidebar

    private void markAllDirty() {
        serverDirty = true;
    }

    public void tick() {
        if (++counter % 6000 == 0) save();
        if (!dirtyTypes.isEmpty()) serverDirty = true;
        // The server-wide view changes almost every tick (play time), so it is refreshed once a second.
        boolean serverTick = serverDirty && counter % 20 == 0;
        if (serverTick) serverDirty = false;
        dirtyTypes.clear();
    }

    // ---------------------------------------------------------------- persistence

    private void load() {
        if (!Files.exists(file)) return;
        try {
            Saved s = GSON.fromJson(Files.readString(file, StandardCharsets.UTF_8), Saved.class);
            if (s != null) {
                if (s.choices == null) s.choices = new HashMap<>();
                if (s.bots == null) s.bots = new HashSet<>();
                if (s.names == null) s.names = new HashMap<>();
                if (s.version < 2) {
                    // The mining sidebar was shown to everyone by default before; the server has its own one.
                    if ("mined".equals(s.defaultCriterion)) s.defaultCriterion = OFF;
                    s.version = 2;
                }
                saved = s;
            }
        } catch (Exception e) {
            SolariaTweaks.LOGGER.error("Could not read {}", file, e);
        }
    }

    public void save() {
        try {
            Files.createDirectories(file.getParent());
            Files.writeString(file, GSON.toJson(saved), StandardCharsets.UTF_8);
        } catch (IOException e) {
            SolariaTweaks.LOGGER.error("Could not write {}", file, e);
        }
    }

    /** UUID for a player name known to the leaderboard (online, in usercache or seen before). */
    public UUID uuidOf(String name) {
        ServerPlayer online = server.getPlayerList().getPlayerByName(name);
        if (online != null) return online.getUUID();
        for (Map.Entry<String, String> e : saved.names.entrySet()) {
            if (e.getValue().equalsIgnoreCase(name)) return UUID.fromString(e.getKey());
        }
        return null;
    }

    public java.util.Collection<String> knownNames() {
        return saved.names.values();
    }

}
