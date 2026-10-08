package dev.kanety.lobby;

import com.viaversion.viaversion.api.Via;
import com.viaversion.viaversion.api.protocol.version.ProtocolVersion;
import net.kyori.adventure.text.Component;
import net.kyori.adventure.text.format.NamedTextColor;
import net.kyori.adventure.text.format.TextDecoration;
import net.kyori.adventure.text.minimessage.MiniMessage;
import net.kyori.adventure.title.Title;
import org.bukkit.*;
import org.bukkit.block.Block;
import org.bukkit.block.BlockFace;
import org.bukkit.command.Command;
import org.bukkit.command.CommandSender;
import org.bukkit.configuration.ConfigurationSection;
import org.bukkit.entity.*;
import org.bukkit.event.EventHandler;
import org.bukkit.event.Listener;
import org.bukkit.event.block.Action;
import org.bukkit.event.block.BlockBreakEvent;
import org.bukkit.event.block.BlockPlaceEvent;
import org.bukkit.event.entity.EntityDamageEvent;
import org.bukkit.event.entity.FoodLevelChangeEvent;
import org.bukkit.event.inventory.InventoryClickEvent;
import org.bukkit.event.inventory.InventoryDragEvent;
import org.bukkit.event.player.*;
import org.bukkit.inventory.Inventory;
import org.bukkit.inventory.InventoryHolder;
import org.bukkit.inventory.ItemStack;
import org.bukkit.inventory.meta.ItemMeta;
import org.bukkit.persistence.PersistentDataType;
import org.bukkit.plugin.java.JavaPlugin;
import org.bukkit.util.Vector;

import java.util.*;

public final class GameLobby extends JavaPlugin implements Listener {

    record Destination(String id, String name, List<String> description, Material icon, Material pad,
                       Material frame, Particle particle, String host, int port, String version,
                       String brand, String info, boolean enabled, String theme, boolean paid) {
        boolean ready() {
            return enabled && host != null && !host.isBlank();
        }
    }

    /** Gate on the plaza ring. angle: around the center (0 = south/+Z); first gate straight north of spawn. */
    record Gate(Destination dest, double angle) {
        double dx() { return Math.sin(angle); }
        double dz() { return Math.cos(angle); }
        double px() { return Math.cos(angle); }
        double pz() { return -Math.sin(angle); }
        /** Local sideways / outwards coordinates of a world column, rounded like Frame.stamp(). */
        int u(int x, int z) { return (int) Math.round(x * px() + z * pz()); }
        int w(int x, int z) { return (int) Math.round(x * dx() + z * dz()); }
    }

    /** Particles that float around a decoration. */
    record Ambient(Location loc, Particle particle, double spread) {}

    static final int Y = 64;
    static final int RADIUS = 32;
    static final int GATE_DIST = 24;
    static final int ISLAND_W = 52;
    static final int CLEAR = 84;
    static final String LABEL_TAG = "lobby_label";
    /** Bump when the plaza layout changes, so a running world gets rebuilt once on the next start. */
    static final String BUILD_VERSION = "3-grand";
    static final MiniMessage MM = MiniMessage.miniMessage();

    private final Map<String, Destination> destinations = new LinkedHashMap<>();
    private final List<Gate> gates = new ArrayList<>();
    private final List<Ambient> ambient = new ArrayList<>();
    private final Map<UUID, Long> cooldown = new HashMap<>();
    private NamespacedKey menuKey;
    private World world;

    @Override
    public void onEnable() {
        saveDefaultConfig();
        menuKey = new NamespacedKey(this, "menu");
        world = Bukkit.getWorlds().getFirst();
        loadDestinations();
        setupWorld();
        if (!BUILD_VERSION.equals(readFlag())) {
            buildPlaza();
        } else {
            layoutGates();
        }
        getServer().getPluginManager().registerEvents(this, this);
        Bukkit.getScheduler().runTaskTimer(this, this::tickParticles, 20L, 5L);
        // config.yml を書き換えたら自動で読み直してゲートを作り直す（公開アドレスの追加などをコンソールなしで反映するため）
        configStamp = configFile().lastModified();
        Bukkit.getScheduler().runTaskTimer(this, this::watchConfig, 100L, 100L);
        Bukkit.getScheduler().runTaskTimerAsynchronously(this, this::loadPaid, 0L, 100L);
    }

    // ---------- 参加券（paid: true の行き先は購入者だけ通す） ----------

    /** UUIDs of players who bought the pass; written by paid-access/sync/sync.js. Null until the file exists (then nobody is blocked). */
    private volatile java.util.Set<UUID> paidPlayers;
    private long paidStamp = -1;

    private void loadPaid() {
        java.io.File f = new java.io.File(getDataFolder(), getConfig().getString("paid-list-file", "paid-players.txt"));
        long m = f.exists() ? f.lastModified() : 0;
        if (m == paidStamp) return;
        paidStamp = m;
        if (m == 0) {
            paidPlayers = null;
            return;
        }
        try {
            java.util.Set<UUID> set = new java.util.HashSet<>();
            for (String line : java.nio.file.Files.readAllLines(f.toPath())) {
                line = line.trim();
                if (!line.isEmpty()) {
                    try {
                        set.add(UUID.fromString(line));
                    } catch (IllegalArgumentException ignored) {
                    }
                }
            }
            paidPlayers = set;
            getLogger().info("paid list: " + set.size() + " players");
        } catch (java.io.IOException e) {
            getLogger().warning("paid list: " + e.getMessage());
        }
    }

    private boolean hasPass(Player p) {
        java.util.Set<UUID> set = paidPlayers;
        return set == null || p.isOp() || set.contains(p.getUniqueId());
    }

    private void showPassInfo(Player p, Destination d) {
        String url = getConfig().getString("pass-url", "https://pass.sharytech.com/");
        String link = url + (url.contains("?") ? "&" : "?") + "name=" + p.getName();
        p.sendMessage(Component.text("━━━━━━━━━━━━━━━━", NamedTextColor.DARK_GRAY));
        p.sendMessage(MM.deserialize(d.name()).append(Component.text(" に入るには参加券が必要です", NamedTextColor.YELLOW)));
        p.sendMessage(Component.text("購入すると1分ほどで入れるようになります（Kanety SMP は無料のまま）", NamedTextColor.GRAY));
        p.sendMessage(Component.text("▶ 参加券のページを開く", NamedTextColor.GREEN, TextDecoration.UNDERLINED)
                .clickEvent(net.kyori.adventure.text.event.ClickEvent.openUrl(link))
                .hoverEvent(net.kyori.adventure.text.event.HoverEvent.showText(Component.text(url))));
        p.sendMessage(Component.text("━━━━━━━━━━━━━━━━", NamedTextColor.DARK_GRAY));
        p.playSound(p, Sound.BLOCK_NOTE_BLOCK_BASS, 1f, 0.6f);
    }

    private long configStamp;

    private String readFlag() {
        try {
            return java.nio.file.Files.readString(new java.io.File(getDataFolder(), "built.flag").toPath()).trim();
        } catch (java.io.IOException e) {
            return "";
        }
    }

    private java.io.File configFile() {
        return new java.io.File(getDataFolder(), "config.yml");
    }

    private void watchConfig() {
        long m = configFile().lastModified();
        if (m == configStamp) return;
        configStamp = m;
        loadDestinations();
        buildPlaza();
        getLogger().info("config.yml changed: reloaded " + destinations.size() + " destinations and rebuilt the plaza");
    }

    // ---------- config ----------

    private void loadDestinations() {
        reloadConfig();
        destinations.clear();
        ConfigurationSection sec = getConfig().getConfigurationSection("destinations");
        if (sec == null) return;
        for (String id : sec.getKeys(false)) {
            ConfigurationSection d = sec.getConfigurationSection(id);
            if (d == null) continue;
            destinations.put(id, new Destination(id,
                    d.getString("name", id),
                    d.getStringList("description"),
                    material(d.getString("icon"), Material.COMPASS),
                    material(d.getString("pad-block"), Material.WHITE_CONCRETE),
                    material(d.getString("frame-block"), Material.QUARTZ_BLOCK),
                    particle(d.getString("particle")),
                    d.getString("host", ""),
                    d.getInt("port", 25565),
                    d.getString("version", ""),
                    d.getString("require-brand", ""),
                    d.getString("info", ""),
                    d.getBoolean("enabled", false),
                    d.getString("theme", id),
                    d.getBoolean("paid", false)));
        }
    }

    private static Material material(String name, Material def) {
        Material m = name == null ? null : Material.matchMaterial(name);
        return m == null ? def : m;
    }

    private static Particle particle(String name) {
        try {
            return name == null ? Particle.END_ROD : Particle.valueOf(name);
        } catch (IllegalArgumentException e) {
            return Particle.END_ROD;
        }
    }

    // ---------- world / plaza ----------

    private void setupWorld() {
        world.setSpawnLocation(new Location(world, 0.5, Y + 1, 0.5, 180f, 0f));
        world.setGameRule(GameRules.ADVANCE_TIME, false);
        world.setGameRule(GameRules.ADVANCE_WEATHER, false);
        world.setGameRule(GameRules.SPAWN_MOBS, false);
        world.setGameRule(GameRules.SHOW_ADVANCEMENT_MESSAGES, false);
        world.setGameRule(GameRules.IMMEDIATE_RESPAWN, true);
        world.setTime(18000);
        world.setStorm(false);
    }

    private void layoutGates() {
        gates.clear();
        List<Destination> list = new ArrayList<>(destinations.values());
        int n = list.size();
        // first gate straight ahead (north, -Z) of spawn, the rest spread clockwise
        for (int i = 0; i < n; i++) gates.add(new Gate(list.get(i), Math.PI + 2 * Math.PI * i / n));
        ambient.clear();
        for (Gate g : gates) {
            Frame f = new Frame(g.angle());
            switch (g.dest().theme()) {
                case "halloween" -> {
                    ambient.add(new Ambient(f.loc(0, 49, 11), Particle.SOUL_FIRE_FLAME, 6));
                    ambient.add(new Ambient(f.loc(0, 40, 2), Particle.SOUL, 10));
                    ambient.add(new Ambient(f.loc(0, 54, 16), Particle.WITCH, 12));
                }
                case "tiktok-defense" -> {
                    for (int s = -1; s <= 1; s += 2) {
                        ambient.add(new Ambient(f.loc(17 * s, 41, 19), Particle.FLAME, 0.8));
                        ambient.add(new Ambient(f.loc(12 * s, 62, 17), Particle.FLAME, 0.8));
                    }
                    ambient.add(new Ambient(f.loc(0, 52, 9), Particle.ELECTRIC_SPARK, 3));
                }
                case "clash-royale" -> {
                    ambient.add(new Ambient(f.loc(0, 62, 19), Particle.WAX_ON, 4));
                    ambient.add(new Ambient(f.loc(-16, 58, 14), Particle.END_ROD, 2.5));
                    ambient.add(new Ambient(f.loc(16, 58, 14), Particle.END_ROD, 2.5));
                }
                case "anime-umetate" -> {
                    for (int[] t : SAKURA) ambient.add(new Ambient(f.loc(t[0], t[1], 9), Particle.CHERRY_LEAVES, 5));
                    ambient.add(new Ambient(f.loc(0, 50, 24), Particle.ELECTRIC_SPARK, 6));
                    ambient.add(new Ambient(f.loc(0, 50, 24), Particle.END_ROD, 7));
                }
                default -> {
                    ambient.add(new Ambient(f.loc(0, 52, 3), Particle.HAPPY_VILLAGER, 12));
                    ambient.add(new Ambient(f.loc(0, 58, 13), Particle.SPORE_BLOSSOM_AIR, 6));
                }
            }
        }
        for (int i = 0; i < n; i++) {
            Frame f = new Frame(Math.PI + 2 * Math.PI * (i + 0.5) / Math.max(n, 1));
            ambient.add(new Ambient(f.loc(0, 47, 11), Particle.END_ROD, 3));
        }
    }

    private void buildPlaza() {
        long started = System.currentTimeMillis();
        world.getEntitiesByClass(TextDisplay.class).stream()
                .filter(e -> e.getScoreboardTags().contains(LABEL_TAG)).forEach(Entity::remove);
        for (int x = -CLEAR; x <= CLEAR; x++)
            for (int z = -CLEAR; z <= CLEAR; z++)
                for (int y = Y - 30; y <= Y + 40; y++) {
                    Block b = world.getBlockAt(x, y, z);
                    if (!b.getType().isAir()) b.setType(Material.AIR, false);
                }

        // the plaza is the top of a floating island: patterned floor, a rock underside, a rim wall with lamps
        for (int x = -RADIUS; x <= RADIUS; x++) {
            for (int z = -RADIUS; z <= RADIUS; z++) {
                double r = Math.sqrt(x * x + z * z);
                if (r > RADIUS + 0.5) continue;
                Material m;
                if (r > RADIUS - 0.7) m = Material.POLISHED_BLACKSTONE_BRICKS;
                else if (r < 4.5) m = Material.CHISELED_QUARTZ_BLOCK;
                else if (r < 5.5) m = Material.GOLD_BLOCK;
                else if (r >= 7 && r < 8.5) m = Material.LIGHT_BLUE_STAINED_GLASS;
                else if (r >= 8.5 && r < 9.5) m = Material.QUARTZ_BRICKS;
                else if (((int) r) % 8 == 0) m = Material.DEEPSLATE_TILES;
                else m = ((x + z) & 1) == 0 ? Material.POLISHED_DEEPSLATE : Material.POLISHED_BLACKSTONE;
                world.getBlockAt(x, Y, z).setType(m, false);
                if (r >= 7 && r < 8.5) world.getBlockAt(x, Y - 1, z).setType(Material.SEA_LANTERN, false);
                if (r > RADIUS - 0.7) world.getBlockAt(x, Y + 1, z).setType(Material.POLISHED_BLACKSTONE_WALL, true);
                int depth = 2 + (int) ((RADIUS + 1 - r) * 0.55 + RNG.nextDouble() * 2);
                for (int k = (r < 7 ? 3 : r < 8.5 ? 2 : 1); k <= depth; k++) {
                    double q = RNG.nextDouble();
                    world.getBlockAt(x, Y - k, z).setType(k <= 2 ? Material.POLISHED_BLACKSTONE
                            : q < 0.08 ? Material.GILDED_BLACKSTONE : q < 0.5 ? Material.DEEPSLATE : Material.BLACKSTONE, false);
                }
            }
        }
        // lamps on the rim
        for (int i = 0; i < 32; i++) {
            double a = 2 * Math.PI * i / 32;
            int x = (int) Math.round(Math.sin(a) * (RADIUS - 2));
            int z = (int) Math.round(Math.cos(a) * (RADIUS - 2));
            for (int y = 1; y <= 3; y++) world.getBlockAt(x, Y + y, z).setType(Material.POLISHED_BLACKSTONE_WALL, true);
            world.getBlockAt(x, Y + 4, z).setType((i & 1) == 0 ? Material.LANTERN : Material.SOUL_LANTERN, false);
            // lanterns hanging under the rim
            int hx = (int) Math.round(Math.sin(a) * (RADIUS - 1)), hz = (int) Math.round(Math.cos(a) * (RADIUS - 1));
            int bottom = Y - 2;
            while (bottom > Y - 30 && !world.getBlockAt(hx, bottom - 1, hz).getType().isAir()) bottom--;
            for (int k = 1; k <= 2; k++) world.getBlockAt(hx, bottom - k, hz).setType(CHAIN, false);
            var hang = (org.bukkit.block.data.type.Lantern) Material.LANTERN.createBlockData();
            hang.setHanging(true);
            world.getBlockAt(hx, bottom - 3, hz).setBlockData(hang, false);
        }
        // beacon under the spawn point: its beam shoots up through the glass the players spawn on
        for (int x = -1; x <= 1; x++)
            for (int z = -1; z <= 1; z++)
                world.getBlockAt(x, Y - 2, z).setType(Material.GOLD_BLOCK, false);
        world.getBlockAt(0, Y - 1, 0).setType(Material.BEACON, false);
        world.getBlockAt(0, Y, 0).setType(Material.YELLOW_STAINED_GLASS, false);
        // a golden halo floating high above the center
        for (int x = -14; x <= 14; x++)
            for (int z = -14; z <= 14; z++) {
                double r = Math.sqrt(x * x + z * z);
                if (r >= 11.5 && r < 12.6) world.getBlockAt(x, Y + 27, z).setType(Material.YELLOW_STAINED_GLASS, false);
                if (r >= 11.5 && r < 12.6 && ((x * 7 + z * 13) & 7) == 0) world.getBlockAt(x, Y + 26, z).setType(Material.END_ROD, false);
            }

        layoutGates();
        int n = gates.size();
        for (int i = 0; i < n; i++) {
            // obelisks and small floating crystal isles between the gates
            Frame f = new Frame(Math.PI + 2 * Math.PI * (i + 0.5) / n);
            obelisk(f, 16);
            obelisk(f, RADIUS - 5);
            crystalIsle(f);
            f.stamp();
        }
        for (Gate g : gates) {
            Frame f = new Frame(g.angle());
            buildGate(g, f);
            decorate(g, f);
            f.stamp();
            Component text = MM.deserialize(g.dest().name()).append(Component.newline());
            for (String line : g.dest().description()) text = text.append(MM.deserialize(line)).append(Component.newline());
            text = text.append(g.dest().ready() ? Component.text("▶ 乗ると移動", NamedTextColor.GREEN, TextDecoration.BOLD)
                    : Component.text("準備中", NamedTextColor.YELLOW, TextDecoration.BOLD));
            label(f.loc(0, GATE_DIST - 2.5, 13.2), text, 1.8f);
        }

        label(new Location(world, 0.5, Y + 3.5, -4.5),
                MM.deserialize(getConfig().getString("lobby-name", "GAME LOBBY"))
                        .append(Component.newline())
                        .append(Component.text("ゲートに乗るか、コンパスを右クリック", NamedTextColor.GRAY))
                        .append(Component.newline())
                        .append(Component.text("配布物とあそび方: games.sharytech.com", NamedTextColor.AQUA)), 2.4f);
        label(new Location(world, 0.5, Y + 19, 0.5),
                MM.deserialize(getConfig().getString("lobby-name", "GAME LOBBY")), 9.0f);

        try {
            java.nio.file.Files.writeString(new java.io.File(getDataFolder(), "built.flag").toPath(), BUILD_VERSION);
        } catch (java.io.IOException ignored) {
        }
        getLogger().info("plaza built in " + (System.currentTimeMillis() - started) + " ms");
    }

    private void buildGate(Gate g, Frame f) {
        Destination d = g.dest();
        int c = GATE_DIST;
        // a lit path from the center ring to the gate
        for (int w = 10; w <= c - 3; w++) {
            f.set(0, w, 0, d.pad());
            f.set(-1, w, 0, Material.SMOOTH_QUARTZ);
            f.set(1, w, 0, Material.SMOOTH_QUARTZ);
            f.set(-2, w, 0, w % 4 == 0 ? Material.SEA_LANTERN : Material.POLISHED_BLACKSTONE_BRICKS);
            f.set(2, w, 0, w % 4 == 0 ? Material.SEA_LANTERN : Material.POLISHED_BLACKSTONE_BRICKS);
        }
        // pad 5x5 under the arch
        f.box(-2, 2, c - 2, c + 2, 0, 0, d.pad());
        f.set(0, c, 0, Material.GLOWSTONE);
        // a tall double arch
        for (int s = -1; s <= 1; s += 2) {
            f.box(4 * s, 5 * s, c, c, 1, 9, d.frame());
            f.set(3 * s, c, 9, d.frame());
            f.set(4 * s, c, 9, Material.SEA_LANTERN);
            f.set(5 * s, c, 0, Material.POLISHED_BLACKSTONE_BRICKS);
            f.set(4 * s, c, 0, Material.POLISHED_BLACKSTONE_BRICKS);
        }
        f.box(-5, 5, c, c, 10, 10, d.frame());
        f.box(-4, 4, c, c, 11, 11, d.frame());
        f.set(0, c, 11, Material.SEA_LANTERN);
        f.set(0, c, 12, d.frame());
    }

    private void obelisk(Frame f, int w) {
        f.box(-1, 1, w - 1, w + 1, 1, 1, Material.POLISHED_BLACKSTONE_BRICKS);
        f.set(0, w, 2, Material.CHISELED_QUARTZ_BLOCK);
        for (int y = 3; y <= 9; y++) f.set(0, w, y, Material.QUARTZ_PILLAR);
        f.set(0, w, 10, Material.GOLD_BLOCK);
        f.set(0, w, 11, Material.END_ROD);
        for (int s = -1; s <= 1; s += 2) {
            f.set(s, w, 1, Material.LANTERN);
            f.set(0, w + s, 1, Material.LANTERN);
        }
    }

    /** A small rock floating between two themed islands, with amethyst crystals and hanging lanterns. */
    private void crystalIsle(Frame f) {
        int cw = 47, base = 6;
        for (int u = -6; u <= 6; u++)
            for (int w = cw - 6; w <= cw + 6; w++) {
                double d = Math.hypot(u, w - cw);
                if (d > 5.8) continue;
                f.set(u, w, base, d < 4 ? Material.MOSS_BLOCK : Material.STONE);
                int depth = 1 + (int) ((6 - d) * 1.1 + RNG.nextDouble());
                for (int k = 1; k <= depth; k++) f.set(u, w, base - k, k > 3 ? Material.DEEPSLATE : Material.STONE);
            }
        int[][] spikes = {{0, 0, 7}, {-2, 1, 4}, {2, -1, 5}, {1, 2, 3}, {-1, -2, 3}};
        for (int[] s : spikes) {
            for (int y = 1; y <= s[2]; y++) f.set(s[0], cw + s[1], base + y, Material.AMETHYST_BLOCK);
            f.set(s[0], cw + s[1], base + s[2] + 1, Material.AMETHYST_CLUSTER);
        }
        for (int s = -1; s <= 1; s += 2) {
            for (int k = 1; k <= 3; k++) f.set(3 * s, cw, base - 5 - k, CHAIN);
            f.set(3 * s, cw, base - 9, hangingLantern());
        }
    }

    // ---------- decorations ----------

    /** Blocks drawn in a rotated local frame (u = sideways, w = outwards from the plaza center, y = height above the floor), then copied into the world. */
    final class Frame {
        final double dx, dz, px, pz;
        /** the cardinal face closest to "towards the plaza center" */
        final BlockFace face;
        final Map<Long, org.bukkit.block.data.BlockData> blocks = new HashMap<>();
        int u0 = Integer.MAX_VALUE, u1 = Integer.MIN_VALUE, w0 = Integer.MAX_VALUE, w1 = Integer.MIN_VALUE,
                y0 = Integer.MAX_VALUE, y1 = Integer.MIN_VALUE;

        Frame(double angle) {
            dx = Math.sin(angle);
            dz = Math.cos(angle);
            px = Math.cos(angle);
            pz = -Math.sin(angle);
            if (Math.abs(dx) > Math.abs(dz)) face = dx > 0 ? BlockFace.WEST : BlockFace.EAST;
            else face = dz > 0 ? BlockFace.NORTH : BlockFace.SOUTH;
        }

        private static long key(int u, int w, int y) {
            return ((u + 1024L) << 24) | ((w + 1024L) << 12) | (y + 2048L);
        }

        void set(int u, int w, int y, org.bukkit.block.data.BlockData d) {
            blocks.put(key(u, w, y), d);
            u0 = Math.min(u0, u);
            u1 = Math.max(u1, u);
            w0 = Math.min(w0, w);
            w1 = Math.max(w1, w);
            y0 = Math.min(y0, y);
            y1 = Math.max(y1, y);
        }

        void set(int u, int w, int y, Material m) {
            set(u, w, y, data(m));
        }

        Material get(int u, int w, int y) {
            var d = blocks.get(key(u, w, y));
            return d == null ? null : d.getMaterial();
        }

        boolean solid(int u, int w, int y) {
            Material m = get(u, w, y);
            return m != null && !m.isAir();
        }

        void box(int ua, int ub, int wa, int wb, int ya, int yb, Material m) {
            for (int u = Math.min(ua, ub); u <= Math.max(ua, ub); u++)
                for (int w = Math.min(wa, wb); w <= Math.max(wa, wb); w++)
                    for (int y = Math.min(ya, yb); y <= Math.max(ya, yb); y++) set(u, w, y, m);
        }

        /** Replaces the ground block where the island has ground. */
        void ground(int u, int w, Material m) {
            if (solid(u, w, 0) && solid(u, w, -1)) set(u, w, 0, m);
        }

        /** Puts something on top of the ground (flowers, heads) where there is ground and nothing yet. */
        void onTop(int u, int w, org.bukkit.block.data.BlockData d) {
            if (solid(u, w, 0) && get(u, w, 1) == null) set(u, w, 1, d);
        }

        boolean overPlaza(int u, int w) {
            double x = w * dx + u * px, z = w * dz + u * pz;
            return x * x + z * z <= sq(RADIUS + 0.5);
        }

        Location loc(double u, double w, double y) {
            return new Location(world, w * dx + u * px + 0.5, Y + y, w * dz + u * pz + 0.5);
        }

        org.bukkit.block.data.BlockData facing(Material m) {
            var d = m.createBlockData();
            if (d instanceof org.bukkit.block.data.Directional dir && dir.getFaces().contains(face)) dir.setFacing(face);
            if (d instanceof org.bukkit.block.data.Rotatable rot) rot.setRotation(face);
            return d;
        }

        /** Copies the blocks into the world, walking every world column under the rotated bounds so nothing gets holes. */
        void stamp() {
            if (blocks.isEmpty()) return;
            double minX = Double.MAX_VALUE, maxX = -Double.MAX_VALUE, minZ = Double.MAX_VALUE, maxZ = -Double.MAX_VALUE;
            for (int u : new int[]{u0 - 1, u1 + 1})
                for (int w : new int[]{w0 - 1, w1 + 1}) {
                    double x = w * dx + u * px, z = w * dz + u * pz;
                    minX = Math.min(minX, x);
                    maxX = Math.max(maxX, x);
                    minZ = Math.min(minZ, z);
                    maxZ = Math.max(maxZ, z);
                }
            for (int x = (int) Math.floor(minX); x <= (int) Math.ceil(maxX); x++)
                for (int z = (int) Math.floor(minZ); z <= (int) Math.ceil(maxZ); z++) {
                    int u = (int) Math.round(x * px + z * pz), w = (int) Math.round(x * dx + z * dz);
                    if (u < u0 || u > u1 || w < w0 || w > w1) continue;
                    for (int y = y0; y <= y1; y++) {
                        var d = blocks.get(key(u, w, y));
                        if (d != null) world.getBlockAt(x, Y + y, z).setBlockData(d, false);
                    }
                }
        }
    }

    private final Map<Material, org.bukkit.block.data.BlockData> dataCache = new HashMap<>();

    private org.bukkit.block.data.BlockData data(Material m) {
        return dataCache.computeIfAbsent(m, Material::createBlockData);
    }

    static final Material CHAIN = firstMaterial("IRON_CHAIN", "CHAIN");

    private static Material firstMaterial(String... names) {
        for (String n : names) {
            Material m = Material.matchMaterial(n);
            if (m != null) return m;
        }
        return Material.IRON_BARS;
    }

    private static org.bukkit.block.data.BlockData leaves(Material m) {
        var d = m.createBlockData();
        if (d instanceof org.bukkit.block.data.type.Leaves l) l.setPersistent(true);
        return d;
    }

    private static org.bukkit.block.data.BlockData hangingLantern() {
        var d = (org.bukkit.block.data.type.Lantern) Material.LANTERN.createBlockData();
        d.setHanging(true);
        return d;
    }

    private static final Random RNG = new Random(7);

    /** Floating island with a ragged edge and a rocky underside that tapers to a point. */
    private void island(Frame f, int cw, int r, Material top, Material fill) {
        double p1 = RNG.nextDouble() * 6, p2 = RNG.nextDouble() * 6;
        for (int u = -r - 3; u <= r + 3; u++) {
            for (int w = cw - r - 3; w <= cw + r + 3; w++) {
                double d = Math.hypot(u, w - cw), th = Math.atan2(u, w - cw);
                double rr = r + 1.6 * Math.sin(3 * th + p1) + 0.9 * Math.cos(5 * th + p2);
                if (d > rr || f.overPlaza(u, w)) continue;
                f.set(u, w, 0, top);
                int depth = 1 + (int) (Math.pow((rr - d) / rr, 0.8) * r * 0.9 + RNG.nextDouble() * 2);
                for (int k = 1; k <= depth; k++) {
                    double q = RNG.nextDouble();
                    f.set(u, w, -k, k <= 2 ? fill : k > depth - 2 && q < 0.5 ? Material.TUFF
                            : q < 0.15 ? Material.ANDESITE : q < 0.3 ? Material.DEEPSLATE : Material.STONE);
                }
            }
        }
    }

    private void scatter(Frame f, int cw, int r, int count, Material... ms) {
        for (int i = 0; i < count; i++)
            f.ground(RNG.nextInt(2 * r + 1) - r, cw + RNG.nextInt(2 * r + 1) - r, ms[RNG.nextInt(ms.length)]);
    }

    private void ellipsoid(Frame f, double cu, double cw, double cy, double ru, double rw, double ry, Material m, double shell) {
        for (int u = (int) Math.floor(cu - ru); u <= Math.ceil(cu + ru); u++)
            for (int w = (int) Math.floor(cw - rw); w <= Math.ceil(cw + rw); w++)
                for (int y = (int) Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) {
                    double e = sq((u - cu) / ru) + sq((w - cw) / rw) + sq((y - cy) / ry);
                    if (e > 1) continue;
                    if (shell > 0 && sq((u - cu) / (ru - shell)) + sq((w - cw) / (rw - shell)) + sq((y - cy) / (ry - shell)) <= 1) continue;
                    f.set(u, w, y, m);
                }
    }

    private void cylinder(Frame f, int cu, int cw, double r, int ya, int yb, Material m, boolean hollow) {
        for (int u = (int) Math.floor(cu - r); u <= Math.ceil(cu + r); u++)
            for (int w = (int) Math.floor(cw - r); w <= Math.ceil(cw + r); w++) {
                double d = Math.hypot(u - cu, w - cw);
                if (d > r || (hollow && d < r - 1.2)) continue;
                for (int y = ya; y <= yb; y++) f.set(u, w, y, m);
            }
    }

    /** Ring of blocks around (cu, cw) at height y; every other block when alternate is given. */
    private void ring(Frame f, int cu, int cw, double r, int y, Material m, Material alternate) {
        int i = 0;
        for (int u = (int) Math.floor(cu - r); u <= Math.ceil(cu + r); u++)
            for (int w = (int) Math.floor(cw - r); w <= Math.ceil(cw + r); w++) {
                double d = Math.hypot(u - cu, w - cw);
                if (d > r || d < r - 1.2) continue;
                f.set(u, w, y, alternate != null && ((u + w) & 1) == 0 ? alternate : m);
                i++;
            }
    }

    private void decorate(Gate g, Frame f) {
        switch (g.dest().theme()) {
            case "halloween" -> halloween(f);
            case "tiktok-defense" -> defense(f);
            case "clash-royale" -> clash(f);
            case "anime-umetate" -> anime(f);
            default -> village(f);
        }
    }

    // ---- Halloween: a giant jack o'lantern behind a graveyard, dead trees and ghosts ----
    private void halloween(Frame f) {
        int cw = ISLAND_W;
        island(f, cw, 19, Material.PODZOL, Material.DIRT);
        scatter(f, cw, 18, 160, Material.SOUL_SOIL, Material.COARSE_DIRT, Material.ROOTED_DIRT, Material.MUD);
        for (int w = 30; w <= 49; w++) for (int u = -1; u <= 1; u++) f.ground(u, w, Material.GRAVEL);
        // the pumpkin
        double pw = 59, py = 10, ru = 10.5, rw = 9.5, ry = 9;
        ellipsoid(f, 0, pw, py, ru, rw, ry, Material.PUMPKIN, 1.6);
        String[] face = {
                "..#...#..",
                ".###.###.",
                "....#....",
                "#.......#",
                "##.#.#.##",
                ".#######.",
        };
        for (int row = 0; row < face.length; row++)
            for (int col = 0; col < 9; col++) {
                if (face[row].charAt(col) != '#') continue;
                for (int du = 0; du < 2; du++)
                    for (int dy = 0; dy < 2; dy++) {
                        int u = (col - 4) * 2 + du, y = (int) py + 5 - row * 2 - dy;
                        for (int w = (int) (pw - rw) - 1; w <= pw; w++) {
                            if (sq(u / ru) + sq((w - pw) / rw) + sq((y - py) / ry) <= 1) {
                                f.set(u, w, y, Material.SHROOMLIGHT);
                                f.set(u, w + 1, y, Material.SHROOMLIGHT);
                                break;
                            }
                        }
                    }
            }
        f.box(-1, 0, 59, 60, 1, 1, Material.GLOWSTONE);
        f.box(0, 1, 58, 59, (int) (py + ry), (int) (py + ry) + 4, Material.DARK_OAK_LOG);
        ellipsoid(f, 3, 58, py + ry + 3, 2.5, 1.6, 1.4, Material.MOSS_BLOCK, 0);
        // graveyard in front of the pumpkin
        for (int u : new int[]{-13, -9, -5, 5, 9, 13})
            for (int w : new int[]{36, 40, 44}) {
                f.ground(u, w + 1, Material.COARSE_DIRT);
                f.set(u, w, 1, Material.MOSSY_STONE_BRICK_WALL);
                f.set(u, w, 2, Material.MOSSY_STONE_BRICK_WALL);
                if (((u + w) & 1) == 0) f.set(u, w, 3, Material.MOSSY_COBBLESTONE_WALL);
            }
        for (int u = -16; u <= 16; u++) {
            if (Math.abs(u) <= 2 || !f.solid(u, 34, 0)) continue;
            f.set(u, 34, 1, Material.DARK_OAK_FENCE);
            if (u % 4 == 0) {
                f.set(u, 34, 2, Material.DARK_OAK_FENCE);
                f.set(u, 34, 3, Material.SOUL_LANTERN);
            }
        }
        for (int s = -1; s <= 1; s += 2) {
            f.box(3 * s, 3 * s, 34, 34, 1, 5, Material.DARK_OAK_LOG);
            f.set(3 * s, 34, 6, f.facing(Material.JACK_O_LANTERN));
            f.set(3 * s, 40, 1, Material.SOUL_CAMPFIRE);
            f.set(3 * s, 46, 1, Material.SOUL_CAMPFIRE);
        }
        f.box(-2, 2, 34, 34, 6, 6, Material.DARK_OAK_PLANKS);
        // dead trees
        for (int[] t : new int[][]{{-16, 46}, {16, 46}, {-14, 62}, {14, 62}, {-6, 66}, {7, 67}}) deadTree(f, t[0], t[1], 11 + RNG.nextInt(4));
        // ghosts
        ghost(f, -19, 50, 16);
        ghost(f, 18, 57, 20);
        ghost(f, -9, 68, 23);
        // lantern posts beside the gate
        for (int s = -1; s <= 1; s += 2) {
            f.box(7 * s, 7 * s, GATE_DIST, GATE_DIST, 1, 3, Material.DARK_OAK_FENCE);
            f.set(7 * s, GATE_DIST, 4, f.facing(Material.JACK_O_LANTERN));
            f.set(8 * s, GATE_DIST - 1, 1, Material.CARVED_PUMPKIN);
            f.set(8 * s, GATE_DIST + 1, 1, Material.PUMPKIN);
            f.set(3 * s, GATE_DIST, 8, Material.COBWEB);
        }
    }

    private void deadTree(Frame f, int u, int w, int h) {
        for (int y = 1; y <= h; y++) f.set(u, w, y, Material.DARK_OAK_LOG);
        int[][] dirs = {{1, 0}, {-1, 0}, {0, 1}, {0, -1}, {1, 1}, {-1, -1}};
        for (int b = 0; b < 4; b++) {
            int[] d = dirs[RNG.nextInt(dirs.length)];
            int y = h / 2 + RNG.nextInt(h / 2), len = 2 + RNG.nextInt(3);
            for (int k = 1; k <= len; k++) f.set(u + d[0] * k, w + d[1] * k, y + k / 2, Material.DARK_OAK_WOOD);
            int eu = u + d[0] * len, ew = w + d[1] * len, ey = y + len / 2;
            f.set(eu, ew, ey + 1, Material.DARK_OAK_FENCE);
            if (RNG.nextBoolean()) {
                f.set(eu, ew, ey - 1, CHAIN);
                f.set(eu, ew, ey - 2, f.facing(Material.JACK_O_LANTERN));
            } else {
                f.set(eu, ew, ey - 1, Material.COBWEB);
            }
        }
    }

    private void ghost(Frame f, int u, int w, int y) {
        ellipsoid(f, u, w, y, 2.2, 2.2, 2.6, Material.WHITE_WOOL, 0);
        for (int k = -1; k <= 1; k++) f.set(u + k * 2, w, y - 3, Material.WHITE_WOOL);
        f.set(u - 1, w - 2, y + 1, Material.BLACK_CONCRETE);
        f.set(u + 1, w - 2, y + 1, Material.BLACK_CONCRETE);
        f.set(u, w - 2, y - 1, Material.BLACK_CONCRETE);
    }

    // ---- TikTok Defense: a fortress wall with neon stripes, watchtowers, the core and a horde at the gate ----
    private void defense(Frame f) {
        int cw = ISLAND_W;
        island(f, cw, 19, Material.ANDESITE, Material.STONE);
        scatter(f, cw, 18, 160, Material.GRAVEL, Material.COBBLESTONE, Material.TUFF, Material.STONE);
        // curtain wall with a gate and a portcullis
        for (int u = -15; u <= 15; u++) {
            for (int w = 40; w <= 42; w++) {
                for (int y = 1; y <= 12; y++) {
                    double r = RNG.nextDouble();
                    f.set(u, w, y, r < 0.18 ? Material.CRACKED_STONE_BRICKS : r < 0.28 ? Material.MOSSY_STONE_BRICKS : Material.STONE_BRICKS);
                }
                if ((u & 1) == 0) f.set(u, w, 13, Material.STONE_BRICKS);
            }
            f.set(u, 40, 8, Material.CYAN_CONCRETE);
            f.set(u, 40, 9, Material.RED_CONCRETE);
            f.set(u, 40, 11, u % 3 == 0 ? Material.SEA_LANTERN : Material.POLISHED_BLACKSTONE_BRICKS);
        }
        f.box(-3, 3, 40, 42, 1, 7, Material.AIR);
        f.box(-3, 3, 40, 40, 6, 7, Material.IRON_BARS);
        f.box(-4, 4, 40, 40, 8, 8, Material.POLISHED_BLACKSTONE_BRICKS);
        for (int u : new int[]{-14, -10, -6, 6, 10, 14}) f.set(u, 40, 4, Material.TARGET);
        for (int u : new int[]{-12, -8, 8, 12}) f.box(u, u, 40, 40, 5, 6, Material.IRON_BARS);
        // side walls of the keep
        for (int s = -1; s <= 1; s += 2)
            for (int w = 43; w <= 61; w++) {
                f.box(14 * s, 14 * s, w, w, 1, 6, Material.STONE_BRICKS);
                if ((w & 1) == 0) f.set(14 * s, w, 7, Material.STONE_BRICKS);
            }
        // towers
        for (int s = -1; s <= 1; s += 2) {
            tower(f, 17 * s, 41, 3.6, 17);
            tower(f, 12 * s, 62, 3.1, 15);
        }
        // the core the players defend
        cylinder(f, 0, cw, 3.2, 1, 2, Material.QUARTZ_BLOCK, false);
        cylinder(f, 0, cw, 2.2, 3, 3, Material.GOLD_BLOCK, false);
        for (int u = -4; u <= 4; u++)
            for (int w = -4; w <= 4; w++)
                for (int y = -6; y <= 6; y++) {
                    double o = Math.abs(u) + Math.abs(w) + Math.abs(y) * 0.6;
                    if (o <= 1.9) f.set(u, cw + w, 10 + y, Material.SEA_LANTERN);
                    else if (o <= 4) f.set(u, cw + w, 10 + y, Material.LIGHT_BLUE_STAINED_GLASS);
                }
        // the horde coming at the wall
        for (int i = 0; i < 26; i++) {
            int u = RNG.nextInt(29) - 14, w = 33 + RNG.nextInt(6);
            if (Math.abs(u) <= 1) continue;
            f.onTop(u, w, f.facing(i % 6 == 0 ? Material.SKELETON_SKULL : i % 9 == 0 ? Material.CREEPER_HEAD : Material.ZOMBIE_HEAD));
        }
        // sandbags beside the gate
        for (int s = -1; s <= 1; s += 2) {
            f.box(6 * s, 9 * s, GATE_DIST, GATE_DIST, 1, 1, Material.MUD_BRICKS);
            f.box(6 * s, 6 * s, GATE_DIST - 1, GATE_DIST - 1, 1, 1, Material.MUD_BRICKS);
            f.box(7 * s, 8 * s, GATE_DIST, GATE_DIST, 2, 2, Material.MUD_BRICK_WALL);
            f.set(6 * s, GATE_DIST, 2, Material.TARGET);
            f.set(9 * s, GATE_DIST, 2, Material.LANTERN);
        }
    }

    private void tower(Frame f, int cu, int cw, double r, int h) {
        cylinder(f, cu, cw, r, 1, h, Material.POLISHED_BLACKSTONE_BRICKS, false);
        cylinder(f, cu, cw, r, h - 4, h - 4, Material.CYAN_CONCRETE, false);
        cylinder(f, cu, cw, r, h - 3, h - 3, Material.RED_CONCRETE, false);
        cylinder(f, cu, cw, r + 1, h, h, Material.POLISHED_BLACKSTONE_BRICKS, false);
        ring(f, cu, cw, r + 1, h + 1, Material.POLISHED_BLACKSTONE_BRICK_WALL, Material.AIR);
        f.set(cu, cw, h, Material.SEA_LANTERN);
        f.set(cu, cw, h + 1, Material.END_ROD);
        f.set(cu, cw, h + 2, Material.END_ROD);
        for (int y = 4; y < h - 5; y += 4) f.set(cu, cw - (int) Math.round(r), y, Material.IRON_BARS);
    }

    // ---- Clash Royale: the arena with a river, princess towers, the king tower with a crown and elixir drops ----
    private void clash(Frame f) {
        int cw = ISLAND_W;
        island(f, cw, 20, Material.GRASS_BLOCK, Material.DIRT);
        for (int u = -15; u <= 15; u++)
            for (int w = 34; w <= 70; w++) if ((w / 2 & 1) == 0) f.ground(u, w, Material.MOSS_BLOCK);
        for (int u = -22; u <= 22; u++) {
            f.ground(u, 40, Material.BLUE_CONCRETE);
            f.ground(u, 41, Material.LIGHT_BLUE_CONCRETE);
            f.ground(u, 42, Material.BLUE_CONCRETE);
        }
        for (int s = -1; s <= 1; s += 2) {
            for (int u = 9 * s - 2; u <= 9 * s + 2; u++)
                for (int w = 39; w <= 43; w++) f.set(u, w, 0, Material.SPRUCE_PLANKS);
            for (int w = 39; w <= 43; w++) {
                f.set(9 * s - 2, w, 1, Material.SPRUCE_FENCE);
                f.set(9 * s + 2, w, 1, Material.SPRUCE_FENCE);
            }
            f.set(9 * s - 2, 39, 2, Material.LANTERN);
            f.set(9 * s + 2, 43, 2, Material.LANTERN);
        }
        // princess towers
        for (int s = -1; s <= 1; s += 2) {
            int cu = 13 * s, tw = 47;
            for (int u = cu - 2; u <= cu + 2; u++)
                for (int w = tw - 2; w <= tw + 2; w++) {
                    for (int y = 1; y <= 10; y++) f.set(u, w, y, y == 8 ? Material.BLUE_CONCRETE : Material.STONE_BRICKS);
                    boolean edge = Math.abs(u - cu) == 2 || Math.abs(w - tw) == 2;
                    if (edge && ((u + w) & 1) == 0) f.set(u, w, 11, Material.GOLD_BLOCK);
                }
            f.set(cu, tw, 11, Material.PINK_CONCRETE);
            f.set(cu, tw, 12, Material.LANTERN);
            f.set(cu, tw - 2, 5, Material.BLUE_STAINED_GLASS);
            f.set(cu, tw - 3, 9, f.facing(Material.BLUE_BANNER));
        }
        // king tower
        int k0 = 55, k1 = 67;
        for (int u = -6; u <= 6; u++)
            for (int w = k0; w <= k1; w++) {
                boolean edge = Math.abs(u) == 6 || w == k0 || w == k1;
                for (int y = 1; y <= 15; y++) {
                    if (!edge && y < 15) continue;
                    Material m = y == 12 ? Material.BLUE_CONCRETE : y == 13 ? Material.GOLD_BLOCK
                            : Math.abs(u) == 6 && (w == k0 || w == k1) ? Material.POLISHED_ANDESITE : Material.STONE_BRICKS;
                    f.set(u, w, y, m);
                }
                if (edge) f.set(u, w, 16, ((u + w) & 1) == 0 ? Material.GOLD_BLOCK : Material.STONE_BRICKS);
            }
        f.box(-1, 1, k0, k0, 1, 3, Material.AIR);
        f.set(0, k0, 4, Material.GOLD_BLOCK);
        for (int u : new int[]{-4, -3, 3, 4}) f.box(u, u, k0, k0, 6, 8, Material.BLUE_STAINED_GLASS);
        for (int u = -6; u <= 6; u += 12)
            for (int w : new int[]{k0, k1}) f.set(u, w, 17, f.facing(Material.BLUE_BANNER));
        // the crown
        int cc = 61;
        ring(f, 0, cc, 3.6, 16, Material.GOLD_BLOCK, null);
        ring(f, 0, cc, 3.6, 17, Material.GOLD_BLOCK, null);
        ring(f, 0, cc, 3.6, 18, Material.GOLD_BLOCK, null);
        for (int i = 0; i < 5; i++) {
            double a = 2 * Math.PI * i / 5 + Math.PI;
            int u = (int) Math.round(Math.sin(a) * 3), w = cc + (int) Math.round(Math.cos(a) * 3);
            f.set(u, w, 19, Material.GOLD_BLOCK);
            f.set(u, w, 20, Material.GOLD_BLOCK);
            f.set(u, w, 21, Material.YELLOW_STAINED_GLASS);
        }
        f.set(0, cc - 3, 17, Material.REDSTONE_BLOCK);
        f.set(-3, cc, 17, Material.LAPIS_BLOCK);
        f.set(3, cc, 17, Material.LAPIS_BLOCK);
        f.set(0, cc, 16, Material.GLOWSTONE);
        // elixir drops floating beside the king tower
        for (int s = -1; s <= 1; s += 2) {
            ellipsoid(f, 16 * s, 58, 13, 2.4, 2.4, 3, Material.MAGENTA_STAINED_GLASS, 1);
            ellipsoid(f, 16 * s, 58, 12.5, 1.3, 1.3, 1.8, Material.PEARLESCENT_FROGLIGHT, 0);
            f.set(16 * s, 58, 17, Material.MAGENTA_STAINED_GLASS);
        }
        // banners beside the gate
        for (int s = -1; s <= 1; s += 2) {
            f.box(7 * s, 7 * s, GATE_DIST, GATE_DIST, 1, 2, Material.GOLD_BLOCK);
            f.set(7 * s, GATE_DIST, 3, f.facing(Material.BLUE_BANNER));
            f.set(9 * s, GATE_DIST, 1, Material.GOLD_BLOCK);
            f.set(9 * s, GATE_DIST, 2, f.facing(Material.RED_BANNER));
        }
    }

    // ---- anime: a grand torii and a row of small ones, stone lanterns, cherry trees, a pagoda and a giant energy ball ----
    static final int[][] SAKURA = {{-12, 44}, {12, 44}, {-16, 55}, {16, 55}, {-11, 66}, {11, 66}};

    private void anime(Frame f) {
        int cw = ISLAND_W;
        island(f, cw, 19, Material.GRASS_BLOCK, Material.DIRT);
        scatter(f, cw, 18, 90, Material.MOSS_BLOCK);
        for (int w = 30; w <= 70; w++) {
            for (int u = -2; u <= 2; u++) f.ground(u, w, Material.GRAVEL);
            f.ground(-3, w, Material.POLISHED_ANDESITE);
            f.ground(3, w, Material.POLISHED_ANDESITE);
        }
        torii(f, 37, 8, 13);
        torii(f, 44, 5, 8);
        torii(f, 48, 5, 8);
        for (int w : new int[]{41, 47, 52})
            for (int s = -1; s <= 1; s += 2) {
                f.set(6 * s, w, 1, Material.STONE_BRICKS);
                f.set(6 * s, w, 2, Material.STONE_BRICK_WALL);
                f.set(6 * s, w, 3, Material.OCHRE_FROGLIGHT);
                f.set(6 * s, w, 4, Material.STONE_BRICK_SLAB);
            }
        pagoda(f, 0, 61);
        for (int[] t : SAKURA) cherry(f, t[0], t[1], 7 + RNG.nextInt(3));
        // a giant energy ball with a halo floating above the shrine
        ellipsoid(f, 0, 50, 24, 5, 5, 5, Material.LIGHT_BLUE_STAINED_GLASS, 1.6);
        ellipsoid(f, 0, 50, 24, 3.4, 3.4, 3.4, Material.SEA_LANTERN, 0);
        ring(f, 0, 50, 8, 24, Material.WHITE_STAINED_GLASS, null);
        // stone lanterns beside the gate
        for (int s = -1; s <= 1; s += 2) {
            f.set(7 * s, GATE_DIST, 1, Material.STONE_BRICKS);
            f.set(7 * s, GATE_DIST, 2, Material.STONE_BRICK_WALL);
            f.set(7 * s, GATE_DIST, 3, Material.OCHRE_FROGLIGHT);
            f.set(7 * s, GATE_DIST, 4, Material.STONE_BRICK_SLAB);
            f.set(9 * s, GATE_DIST, 1, leaves(Material.CHERRY_LEAVES));
        }
    }

    private void torii(Frame f, int w, int half, int h) {
        for (int s = -1; s <= 1; s += 2) {
            f.box(half * s, half * s, w, w, 1, h, Material.RED_CONCRETE);
            f.set(half * s, w, 1, Material.BLACK_CONCRETE);
        }
        f.box(-half - 2, half + 2, w, w, h - 3, h - 3, Material.RED_CONCRETE);
        f.box(-half - 1, half + 1, w, w, h, h, Material.RED_CONCRETE);
        f.box(-half - 3, half + 3, w, w, h + 1, h + 1, Material.BLACK_CONCRETE);
        f.set(-half - 4, w, h + 2, Material.BLACK_CONCRETE);
        f.set(half + 4, w, h + 2, Material.BLACK_CONCRETE);
        f.box(0, 0, w, w, h - 2, h - 1, Material.GOLD_BLOCK);
    }

    private void pagoda(Frame f, int cu, int cw) {
        for (int i = 0; i < 3; i++) {
            int half = 5 - i, b = 1 + i * 6;
            for (int u = -half; u <= half; u++)
                for (int w = -half; w <= half; w++) {
                    boolean corner = Math.abs(u) == half && Math.abs(w) == half;
                    boolean edge = Math.abs(u) == half || Math.abs(w) == half;
                    for (int y = b; y <= b + 3; y++) {
                        if (corner) f.set(cu + u, cw + w, y, Material.RED_CONCRETE);
                        else if (edge) f.set(cu + u, cw + w, y, y == b + 3 ? Material.DARK_OAK_PLANKS : Material.WHITE_CONCRETE);
                    }
                    if (i > 0) f.set(cu + u, cw + w, b - 1, Material.DARK_OAK_PLANKS);
                }
            for (int y = b + 1; y <= b + 2; y++) f.set(cu, cw - half, y, Material.ORANGE_STAINED_GLASS);
            f.set(cu, cw, b, Material.GLOWSTONE);
            f.box(cu - half - 2, cu + half + 2, cw - half - 2, cw + half + 2, b + 4, b + 4, Material.DEEPSLATE_TILES);
            f.box(cu - half - 1, cu + half + 1, cw - half - 1, cw + half + 1, b + 5, b + 5, Material.DEEPSLATE_TILES);
            for (int su = -1; su <= 1; su += 2)
                for (int sw = -1; sw <= 1; sw += 2) {
                    f.set(cu + su * (half + 2), cw + sw * (half + 2), b + 5, Material.DEEPSLATE_TILES);
                    f.set(cu + su * (half + 2), cw + sw * (half + 2), b + 3, hangingLantern());
                }
        }
        f.box(cu - 1, cu + 1, cw - 1, cw + 1, 19, 19, Material.DEEPSLATE_TILES);
        f.set(cu, cw, 20, Material.GOLD_BLOCK);
        for (int y = 21; y <= 24; y++) f.set(cu, cw, y, (y & 1) == 0 ? Material.GOLD_BLOCK : CHAIN);
        f.set(cu, cw, 25, Material.END_ROD);
    }

    private void cherry(Frame f, int u, int w, int h) {
        for (int y = 1; y <= h; y++) f.set(u, w, y, Material.CHERRY_LOG);
        f.set(u + 1, w, h - 1, Material.CHERRY_WOOD);
        f.set(u - 1, w + 1, h - 2, Material.CHERRY_WOOD);
        var lv = leaves(Material.CHERRY_LEAVES);
        for (int du = -5; du <= 5; du++)
            for (int dw = -5; dw <= 5; dw++)
                for (int dy = -3; dy <= 3; dy++)
                    if (sq(du / 4.8) + sq(dw / 4.8) + sq(dy / 3.0) <= 1 && RNG.nextDouble() < 0.9 && f.get(u + du, w + dw, h + 1 + dy) == null)
                        f.set(u + du, w + dw, h + 1 + dy, lv);
        for (int k = 0; k < 10; k++) f.onTop(u + RNG.nextInt(9) - 4, w + RNG.nextInt(9) - 4, data(Material.PINK_PETALS));
    }

    // ---- Kanety SMP (and any destination without its own theme): a little village under a big oak ----
    private void village(Frame f) {
        int cw = ISLAND_W;
        island(f, cw, 19, Material.GRASS_BLOCK, Material.DIRT);
        for (int w = 30; w <= 70; w++) for (int u = -1; u <= 1; u++) f.ground(u, w, Material.DIRT_PATH);
        for (int u = -16; u <= 16; u++) for (int w = 50; w <= 52; w++) f.ground(u, w, Material.DIRT_PATH);
        // big oak
        f.box(-1, 0, 59, 60, 1, 11, Material.OAK_LOG);
        var oak = leaves(Material.OAK_LEAVES);
        for (int du = -8; du <= 8; du++)
            for (int dw = -8; dw <= 8; dw++)
                for (int dy = -4; dy <= 5; dy++)
                    if (sq(du / 7.5) + sq(dw / 7.5) + sq(dy / 5.0) <= 1 && RNG.nextDouble() < 0.93 && f.get(du, 60 + dw, 14 + dy) == null)
                        f.set(du, 60 + dw, 14 + dy, oak);
        for (int k = 0; k < 6; k++) {
            int u = RNG.nextInt(11) - 5, w = 60 + RNG.nextInt(11) - 5;
            for (int y = 9; y >= 6; y--) if (f.get(u, w, y) == null) f.set(u, w, y, Material.VINE);
        }
        // cottages, a well, hay and lamp posts
        cottage(f, -11, 43);
        cottage(f, 11, 43);
        cottage(f, -13, 60);
        cottage(f, 13, 60);
        f.box(-2, 2, 50, 54, 0, 1, Material.COBBLESTONE);
        f.box(-1, 1, 51, 53, 0, 1, Material.AIR);
        f.box(-1, 1, 51, 53, -1, -1, Material.STONE);
        f.box(-1, 1, 51, 53, 0, 0, Material.BLUE_STAINED_GLASS);
        for (int s = -1; s <= 1; s += 2)
            for (int t = -1; t <= 1; t += 2) f.box(2 * s, 2 * s, 52 + 2 * t, 52 + 2 * t, 2, 3, Material.OAK_FENCE);
        f.box(-2, 2, 50, 54, 4, 4, Material.SPRUCE_SLAB);
        f.set(0, 52, 3, hangingLantern());
        for (int w : new int[]{34, 40, 46})
            for (int s = -1; s <= 1; s += 2) {
                f.box(3 * s, 3 * s, w, w, 1, 3, Material.OAK_FENCE);
                f.set(3 * s, w, 4, Material.LANTERN);
            }
        for (int[] h : new int[][]{{-6, 66, 2}, {6, 67, 1}, {-17, 52, 2}, {17, 52, 1}})
            for (int y = 1; y <= h[2]; y++) f.set(h[0], h[1], y, Material.HAY_BLOCK);
        Material[] flowers = {Material.POPPY, Material.DANDELION, Material.CORNFLOWER, Material.AZURE_BLUET, Material.OXEYE_DAISY,
                Material.SHORT_GRASS, Material.SHORT_GRASS, Material.SHORT_GRASS};
        for (int i = 0; i < 220; i++)
            f.onTop(RNG.nextInt(37) - 18, cw + RNG.nextInt(37) - 18, data(flowers[RNG.nextInt(flowers.length)]));
        // flower beds beside the gate
        for (int s = -1; s <= 1; s += 2) {
            f.box(7 * s, 7 * s, GATE_DIST, GATE_DIST, 1, 3, Material.OAK_FENCE);
            f.set(7 * s, GATE_DIST, 4, Material.LANTERN);
            f.set(9 * s, GATE_DIST, 1, leaves(Material.FLOWERING_AZALEA_LEAVES));
            f.set(9 * s, GATE_DIST, 2, leaves(Material.AZALEA_LEAVES));
        }
    }

    private void cottage(Frame f, int cu, int cw) {
        for (int u = -3; u <= 3; u++)
            for (int w = -3; w <= 3; w++) {
                boolean edge = Math.abs(u) == 3 || Math.abs(w) == 3;
                boolean corner = Math.abs(u) == 3 && Math.abs(w) == 3;
                f.set(cu + u, cw + w, 0, Material.OAK_PLANKS);
                if (!edge) continue;
                f.set(cu + u, cw + w, 1, Material.COBBLESTONE);
                for (int y = 2; y <= 4; y++) f.set(cu + u, cw + w, y, corner ? Material.OAK_LOG : Material.WHITE_TERRACOTTA);
            }
        for (int s = -1; s <= 1; s += 2) {
            f.set(cu + 3 * s, cw, 3, Material.GLASS);
            f.set(cu, cw + 3 * s, 3, Material.GLASS);
        }
        f.box(cu, cu, cw - 3, cw - 3, 1, 2, Material.AIR);
        f.set(cu, cw, 1, Material.GLOWSTONE);
        for (int k = 0; k <= 4; k++) {
            for (int u = -4 + k; u <= 4 - k; u++)
                for (int w = -4; w <= 4; w++) {
                    boolean outer = Math.abs(u) == 4 - k || Math.abs(w) == 4;
                    f.set(cu + u, cw + w, 5 + k, outer && Math.abs(w) != 4 ? Material.DARK_OAK_PLANKS
                            : Math.abs(w) == 4 && Math.abs(u) == 4 - k ? Material.DARK_OAK_PLANKS : Math.abs(w) >= 3 ? Material.OAK_PLANKS : Material.AIR);
                }
        }
        f.set(cu + 1, cw - 4, 2, Material.LANTERN);
        f.set(cu + 2, cw + 1, 9, Material.BRICKS);
        f.set(cu + 2, cw + 1, 10, Material.BRICKS);
        f.set(cu + 2, cw + 1, 11, Material.CAMPFIRE);
    }

    private static double sq(double v) {
        return v * v;
    }

    private void label(Location l, Component text, float scale) {
        world.spawn(l, TextDisplay.class, td -> {
            td.text(text);
            td.setBillboard(Display.Billboard.CENTER);
            td.setAlignment(TextDisplay.TextAlignment.CENTER);
            td.setShadowed(true);
            td.setPersistent(true);
            td.addScoreboardTag(LABEL_TAG);
            td.setTransformation(new org.bukkit.util.Transformation(new org.joml.Vector3f(),
                    new org.joml.Quaternionf(), new org.joml.Vector3f(scale, scale, scale), new org.joml.Quaternionf()));
        });
    }

    private void tickParticles() {
        if (world.getPlayers().isEmpty()) return;
        for (Ambient a : ambient) {
            for (int k = 0; k < 2; k++) {
                world.spawnParticle(a.particle(), a.loc().clone().add((Math.random() - 0.5) * 2 * a.spread(),
                        (Math.random() - 0.5) * a.spread(), (Math.random() - 0.5) * 2 * a.spread()), 1, 0, 0, 0, 0.01);
            }
        }
        for (Gate g : gates) {
            Particle p = g.dest().ready() ? g.dest().particle() : Particle.SMOKE;
            for (int k = 0; k < 6; k++) {
                double s = Math.random() * 6 - 3;
                world.spawnParticle(p, GATE_DIST * g.dx() + s * g.px() + 0.5, Y + 1 + Math.random() * 8,
                        GATE_DIST * g.dz() + s * g.pz() + 0.5, 1, 0, 0.05, 0, 0.01);
            }
        }
    }

    // ---------- transfer ----------

    private void send(Player p, Destination d) {
        long now = System.currentTimeMillis();
        if (cooldown.getOrDefault(p.getUniqueId(), 0L) > now) return;
        cooldown.put(p.getUniqueId(), now + 3000);

        if (!d.ready()) {
            p.sendMessage(MM.deserialize(d.name()).append(Component.text(" はまだ準備中です", NamedTextColor.YELLOW)));
            p.playSound(p, Sound.BLOCK_NOTE_BLOCK_BASS, 1f, 0.6f);
            pushBack(p);
            return;
        }
        if (d.paid() && !hasPass(p)) {
            showPassInfo(p, d);
            pushBack(p);
            return;
        }
        String problem = checkClient(p, d);
        if (problem != null) {
            p.sendMessage(Component.text("━━━━━━━━━━━━━━━━", NamedTextColor.DARK_GRAY));
            p.sendMessage(MM.deserialize(d.name()).append(Component.text(" には今のクライアントでは入れません", NamedTextColor.RED)));
            p.sendMessage(Component.text(problem, NamedTextColor.GRAY));
            if (!d.info().isBlank()) p.sendMessage(MM.deserialize(d.info()));
            String addr = d.host() + (d.port() == 25565 ? "" : ":" + d.port());
            p.sendMessage(Component.text("直接のアドレス: ", NamedTextColor.GRAY)
                    .append(Component.text(addr, NamedTextColor.AQUA, TextDecoration.UNDERLINED)
                            .clickEvent(net.kyori.adventure.text.event.ClickEvent.copyToClipboard(addr))
                            .hoverEvent(net.kyori.adventure.text.event.HoverEvent.showText(Component.text("クリックでコピー")))));
            p.sendMessage(Component.text("━━━━━━━━━━━━━━━━", NamedTextColor.DARK_GRAY));
            p.playSound(p, Sound.BLOCK_NOTE_BLOCK_BASS, 1f, 0.6f);
            pushBack(p);
            return;
        }
        p.showTitle(Title.title(MM.deserialize(d.name()), Component.text("移動中…", NamedTextColor.GRAY)));
        p.playSound(p, Sound.ENTITY_ENDERMAN_TELEPORT, 1f, 1.2f);
        // 行き先が閉まっているのに転送すると切断されてしまうので、先につながるか確かめる
        Bukkit.getScheduler().runTaskAsynchronously(this, () -> {
            Reach r = reach(d.host(), d.port());
            Bukkit.getScheduler().runTask(this, () -> {
                if (!p.isOnline()) return;
                if (r == Reach.SLEEPING) {
                    waitForWake(p, d);
                    return;
                }
                if (r == Reach.DOWN) {
                    p.clearTitle();
                    p.sendMessage(MM.deserialize(d.name()).append(Component.text(" は今閉まっています。少し待ってからもう一度どうぞ", NamedTextColor.YELLOW)));
                    p.playSound(p, Sound.BLOCK_NOTE_BLOCK_BASS, 1f, 0.6f);
                    pushBack(p);
                    return;
                }
                getLogger().info("transfer " + p.getName() + " -> " + d.id() + " (" + d.host() + ":" + d.port() + ")");
                p.transfer(d.host(), d.port());
            });
        });
    }

    // 30分無人の鯖は idle-sleeper（autostart\idle-sleeper）が止めて、代わりにポートで待っている。
    // そのときサーバーリストの version.name が「💤 スリープ中」になり、ログインを受けると起動が始まる
    enum Reach { UP, SLEEPING, DOWN }
    static final String SLEEP_VERSION = "💤 スリープ中";
    private final java.util.Set<UUID> waking = new java.util.HashSet<>();

    /** スリープ中の行き先を起こし、ロビーで待たせて、起動したら自動で転送する。 */
    private void waitForWake(Player p, Destination d) {
        if (!waking.add(p.getUniqueId())) return;
        p.showTitle(Title.title(MM.deserialize(d.name()), Component.text("💤 スリープ中なので起動しています…", NamedTextColor.GRAY)));
        p.sendMessage(MM.deserialize(d.name()).append(Component.text(
                " は30分だれもいなかったので休んでいました。今起動しているので、ここで待っていてください（1分ほど）。準備ができたら自動で移動します",
                NamedTextColor.YELLOW)));
        long deadline = System.currentTimeMillis() + 180_000;
        Bukkit.getScheduler().runTaskAsynchronously(this, () -> {
            wake(d.host(), d.port());
            Reach r = Reach.SLEEPING;
            while (System.currentTimeMillis() < deadline) {
                try { Thread.sleep(5000); } catch (InterruptedException e) { break; }
                Player now = Bukkit.getPlayer(p.getUniqueId());
                if (now == null || !now.isOnline()) break;
                r = reach(d.host(), d.port());
                if (r == Reach.UP) break;
            }
            Reach result = r;
            Bukkit.getScheduler().runTask(this, () -> {
                waking.remove(p.getUniqueId());
                if (!p.isOnline()) return;
                if (result != Reach.UP) {
                    p.clearTitle();
                    p.sendMessage(MM.deserialize(d.name()).append(Component.text(" の起動に時間がかかっています。少し待ってからもう一度ゲートに乗ってください", NamedTextColor.YELLOW)));
                    return;
                }
                p.showTitle(Title.title(MM.deserialize(d.name()), Component.text("移動中…", NamedTextColor.GRAY)));
                p.playSound(p, Sound.ENTITY_ENDERMAN_TELEPORT, 1f, 1.2f);
                getLogger().info("transfer (woke) " + p.getName() + " -> " + d.id() + " (" + d.host() + ":" + d.port() + ")");
                p.transfer(d.host(), d.port());
            });
        });
    }

    /** ログインを始めるだけの接続を送って、スリープ中の鯖に起動させる（すぐ切られる）。 */
    private static void wake(String host, int port) {
        try (java.net.Socket s = new java.net.Socket()) {
            s.connect(new java.net.InetSocketAddress(host, port), 3000);
            s.setSoTimeout(3000);
            var out = new java.io.DataOutputStream(s.getOutputStream());
            out.write(handshake(host, port, 2));
            var ls = new java.io.ByteArrayOutputStream();
            var l = new java.io.DataOutputStream(ls);
            l.writeByte(0x00);              // login start
            byte[] name = "lobby-wake".getBytes(java.nio.charset.StandardCharsets.UTF_8);
            writeVarInt(l, name.length);
            l.write(name);
            l.write(new byte[16]);          // uuid
            writeVarInt(out, ls.size());
            out.write(ls.toByteArray());
            out.flush();
            s.getInputStream().read();
        } catch (java.io.IOException ignored) {
        }
    }

    private static byte[] handshake(String host, int port, int next) throws java.io.IOException {
        var hs = new java.io.ByteArrayOutputStream();
        var h = new java.io.DataOutputStream(hs);
        h.writeByte(0x00);              // handshake packet id
        writeVarInt(h, 775);            // protocol (any value works for status)
        byte[] hb = host.getBytes(java.nio.charset.StandardCharsets.UTF_8);
        writeVarInt(h, hb.length);
        h.write(hb);
        h.writeShort(port);
        writeVarInt(h, next);
        var packet = new java.io.ByteArrayOutputStream();
        var o = new java.io.DataOutputStream(packet);
        writeVarInt(o, hs.size());
        o.write(hs.toByteArray());
        return packet.toByteArray();
    }

    private static int readVarInt(java.io.InputStream in) throws java.io.IOException {
        int v = 0;
        for (int i = 0; i < 5; i++) {
            int b = in.read();
            if (b < 0) throw new java.io.EOFException();
            v |= (b & 0x7F) << (7 * i);
            if ((b & 0x80) == 0) return v;
        }
        throw new java.io.IOException("varint too long");
    }

    /** Asks the destination for its server list status, so a tunnel that is up but has no server behind it counts as closed. */
    private static Reach reach(String host, int port) {
        try (java.net.Socket s = new java.net.Socket()) {
            s.connect(new java.net.InetSocketAddress(host, port), 3000);
            s.setSoTimeout(3000);
            var out = new java.io.DataOutputStream(s.getOutputStream());
            out.write(handshake(host, port, 1));
            out.writeByte(1);               // status request: length 1
            out.writeByte(0x00);
            out.flush();
            var in = new java.io.DataInputStream(s.getInputStream());
            readVarInt(in);                 // packet length
            readVarInt(in);                 // packet id
            byte[] json = new byte[readVarInt(in)];
            in.readFully(json);
            return new String(json, java.nio.charset.StandardCharsets.UTF_8).contains(SLEEP_VERSION) ? Reach.SLEEPING : Reach.UP;
        } catch (java.io.IOException e) {
            return Reach.DOWN;
        }
    }

    private static void writeVarInt(java.io.DataOutputStream out, int v) throws java.io.IOException {
        while ((v & ~0x7F) != 0) {
            out.writeByte((v & 0x7F) | 0x80);
            v >>>= 7;
        }
        out.writeByte(v);
    }

    /** Returns why this client cannot join the destination, or null when it can. */
    private String checkClient(Player p, Destination d) {
        if (!d.version().isBlank()) {
            ProtocolVersion pv = Via.getAPI().getPlayerProtocolVersion(p.getUniqueId());
            if (pv != null && !pv.getIncludedVersions().contains(d.version()) && !pv.getName().equals(d.version())) {
                return "あなたの版: " + pv.getName() + " / 必要な版: " + d.version();
            }
        }
        if (!d.brand().isBlank()) {
            String b = p.getClientBrandName();
            if (b == null || !b.toLowerCase(Locale.ROOT).contains(d.brand().toLowerCase(Locale.ROOT))) {
                return "必要なクライアント: " + d.brand() + "（今: " + (b == null ? "不明" : b) + "）";
            }
        }
        return null;
    }

    private void pushBack(Player p) {
        Vector v = p.getLocation().toVector().setY(0);
        Vector toCenter = new Vector(0.5, 0, 0.5).subtract(v);
        if (toCenter.lengthSquared() > 0.01) p.setVelocity(toCenter.normalize().multiply(0.9).setY(0.35));
    }

    // ---------- menu ----------

    static final class MenuHolder implements InventoryHolder {
        final Map<Integer, Destination> slots = new HashMap<>();
        Inventory inv;

        @Override
        public Inventory getInventory() {
            return inv;
        }
    }

    private void openMenu(Player p) {
        MenuHolder h = new MenuHolder();
        h.inv = Bukkit.createInventory(h, 27, Component.text("行き先をえらぶ"));
        ItemStack filler = new ItemStack(Material.BLACK_STAINED_GLASS_PANE);
        filler.editMeta(m -> m.displayName(Component.empty()));
        for (int i = 0; i < 27; i++) h.inv.setItem(i, filler);
        List<Destination> list = new ArrayList<>(destinations.values());
        int[] slots = slotLayout(list.size());
        for (int i = 0; i < list.size() && i < slots.length; i++) {
            Destination d = list.get(i);
            ItemStack it = new ItemStack(d.icon());
            it.editMeta(m -> {
                m.displayName(MM.deserialize(d.name()).decoration(TextDecoration.ITALIC, false));
                List<Component> lore = new ArrayList<>();
                for (String line : d.description()) lore.add(MM.deserialize(line).decoration(TextDecoration.ITALIC, false));
                lore.add(Component.empty());
                String problem = d.ready() ? checkClient(p, d) : null;
                if (!d.ready()) lore.add(Component.text("準備中", NamedTextColor.YELLOW).decoration(TextDecoration.ITALIC, false));
                else if (problem != null) lore.add(Component.text(problem, NamedTextColor.RED).decoration(TextDecoration.ITALIC, false));
                else lore.add(Component.text("クリックで移動", NamedTextColor.GREEN).decoration(TextDecoration.ITALIC, false));
                m.lore(lore);
            });
            h.inv.setItem(slots[i], it);
            h.slots.put(slots[i], d);
        }
        p.openInventory(h.inv);
    }

    private static int[] slotLayout(int n) {
        return switch (n) {
            case 1 -> new int[]{13};
            case 2 -> new int[]{11, 15};
            case 3 -> new int[]{11, 13, 15};
            case 4 -> new int[]{10, 12, 14, 16};
            default -> new int[]{9, 10, 11, 12, 13, 14, 15, 16, 17};
        };
    }

    private ItemStack menuItem() {
        ItemStack it = new ItemStack(Material.RECOVERY_COMPASS);
        ItemMeta m = it.getItemMeta();
        m.displayName(Component.text("行き先メニュー（右クリック）", NamedTextColor.GOLD).decoration(TextDecoration.ITALIC, false));
        m.getPersistentDataContainer().set(menuKey, PersistentDataType.BYTE, (byte) 1);
        it.setItemMeta(m);
        return it;
    }

    private boolean isMenuItem(ItemStack it) {
        return it != null && it.hasItemMeta()
                && it.getItemMeta().getPersistentDataContainer().has(menuKey, PersistentDataType.BYTE);
    }

    // ---------- events ----------

    @EventHandler
    public void onJoin(PlayerJoinEvent e) {
        Player p = e.getPlayer();
        p.getInventory().clear();
        p.getInventory().setItem(4, menuItem());
        p.getInventory().setHeldItemSlot(4);
        p.teleport(world.getSpawnLocation());
        p.setGameMode(GameMode.ADVENTURE);
        p.setFoodLevel(20);
        p.setHealth(p.getAttribute(org.bukkit.attribute.Attribute.MAX_HEALTH).getValue());
        p.sendMessage(MM.deserialize(getConfig().getString("lobby-name", "GAME LOBBY"))
                .append(Component.text(" へようこそ。ゲートに乗るか、コンパスを右クリックして行き先をえらんでね", NamedTextColor.GRAY)));
    }

    @EventHandler
    public void onMove(PlayerMoveEvent e) {
        Location to = e.getTo();
        if (to.getBlockX() == e.getFrom().getBlockX() && to.getBlockZ() == e.getFrom().getBlockZ()
                && to.getBlockY() == e.getFrom().getBlockY()) return;
        Player p = e.getPlayer();
        if (to.getY() < Y - 20) {
            p.teleport(world.getSpawnLocation());
            return;
        }
        Block under = to.clone().subtract(0, 0.1, 0).getBlock();
        if (under.getY() != Y) return;
        for (Gate g : gates) {
            int u = g.u(under.getX(), under.getZ()), w = g.w(under.getX(), under.getZ());
            if (Math.abs(u) <= 2 && Math.abs(w - GATE_DIST) <= 2) {
                send(p, g.dest());
                return;
            }
        }
    }

    @EventHandler
    public void onInteract(PlayerInteractEvent e) {
        if (e.getAction() == Action.PHYSICAL) return;
        if (isMenuItem(e.getItem())) {
            e.setCancelled(true);
            openMenu(e.getPlayer());
        }
    }

    @EventHandler
    public void onClick(InventoryClickEvent e) {
        if (e.getInventory().getHolder() instanceof MenuHolder h) {
            e.setCancelled(true);
            Destination d = h.slots.get(e.getRawSlot());
            if (d != null && e.getWhoClicked() instanceof Player p) {
                p.closeInventory();
                send(p, d);
            }
            return;
        }
        if (e.getWhoClicked().getGameMode() != GameMode.CREATIVE) e.setCancelled(true);
    }

    @EventHandler
    public void onDrag(InventoryDragEvent e) {
        if (e.getWhoClicked().getGameMode() != GameMode.CREATIVE) e.setCancelled(true);
    }

    @EventHandler
    public void onDrop(PlayerDropItemEvent e) {
        e.setCancelled(true);
    }

    @EventHandler
    public void onSwap(PlayerSwapHandItemsEvent e) {
        e.setCancelled(true);
    }

    @EventHandler
    public void onDamage(EntityDamageEvent e) {
        if (e.getEntity() instanceof Player) e.setCancelled(true);
    }

    @EventHandler
    public void onFood(FoodLevelChangeEvent e) {
        e.setCancelled(true);
    }

    @EventHandler
    public void onBreak(BlockBreakEvent e) {
        if (e.getPlayer().getGameMode() != GameMode.CREATIVE) e.setCancelled(true);
    }

    @EventHandler
    public void onPlace(BlockPlaceEvent e) {
        if (e.getPlayer().getGameMode() != GameMode.CREATIVE) e.setCancelled(true);
    }

    @EventHandler
    public void onQuit(PlayerQuitEvent e) {
        cooldown.remove(e.getPlayer().getUniqueId());
    }

    // ---------- commands ----------

    @Override
    public boolean onCommand(CommandSender sender, Command cmd, String label, String[] args) {
        switch (cmd.getName()) {
            case "menu" -> {
                if (sender instanceof Player p) openMenu(p);
            }
            case "go" -> {
                if (!(sender instanceof Player p)) return true;
                if (args.length == 0 || !destinations.containsKey(args[0])) {
                    p.sendMessage(Component.text("行き先: " + String.join(", ", destinations.keySet()), NamedTextColor.GRAY));
                    return true;
                }
                cooldown.remove(p.getUniqueId());
                send(p, destinations.get(args[0]));
            }
            case "lobbyadmin" -> {
                String sub = args.length > 0 ? args[0] : "list";
                switch (sub) {
                    case "reload" -> {
                        loadDestinations();
                        layoutGates();
                        sender.sendMessage("reloaded (" + destinations.size() + " destinations). /lobbyadmin rebuild でゲートを作り直す");
                    }
                    case "rebuild" -> {
                        loadDestinations();
                        buildPlaza();
                        sender.sendMessage("plaza rebuilt");
                    }
                    default -> destinations.values().forEach(d -> sender.sendMessage(
                            d.id() + " " + (d.ready() ? "ready" : "not-ready") + " " + d.host() + ":" + d.port()
                                    + " v" + d.version() + (d.brand().isBlank() ? "" : " brand=" + d.brand())));
                }
            }
        }
        return true;
    }

    @Override
    public List<String> onTabComplete(CommandSender sender, Command cmd, String alias, String[] args) {
        if (cmd.getName().equals("go") && args.length == 1) return new ArrayList<>(destinations.keySet());
        if (cmd.getName().equals("lobbyadmin") && args.length == 1) return List.of("reload", "rebuild", "list");
        return List.of();
    }
}
