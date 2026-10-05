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

    /** Gate placed on the plaza: pad center and the direction the arch faces (towards the plaza center). */
    record Gate(Destination dest, int x, int z, int dx, int dz) {}

    /** Particles that float around a decoration. */
    record Ambient(Location loc, Particle particle, double spread) {}

    static final int Y = 64;
    static final int RADIUS = 16;
    static final int GATE_DIST = 12;
    static final int CLEAR = 40;
    static final String LABEL_TAG = "lobby_label";
    /** Bump when the plaza layout changes, so a running world gets rebuilt once on the next start. */
    static final String BUILD_VERSION = "2-decor";
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
        for (int i = 0; i < n; i++) {
            // first gate straight ahead (north, -Z) of spawn, the rest spread clockwise
            double a = Math.PI + 2 * Math.PI * i / n;
            int x = (int) Math.round(Math.sin(a) * GATE_DIST);
            int z = (int) Math.round(Math.cos(a) * GATE_DIST);
            int dx = Math.abs(x) >= Math.abs(z) ? -Integer.signum(x) : 0;
            int dz = dx == 0 ? -Integer.signum(z) : 0;
            gates.add(new Gate(list.get(i), x, z, dx, dz));
        }
        ambient.clear();
        for (Gate g : gates) {
            switch (g.dest().theme()) {
                case "halloween" -> {
                    ambient.add(new Ambient(at(g, 0, 21, 5).getLocation().add(0.5, 0.5, 0.5), Particle.SOUL_FIRE_FLAME, 2.5));
                    ambient.add(new Ambient(at(g, 0, 18, 2).getLocation().add(0.5, 0.5, 0.5), Particle.SOUL, 4));
                }
                case "tiktok-defense" -> {
                    ambient.add(new Ambient(at(g, -9, 22, 12).getLocation().add(0.5, 0.5, 0.5), Particle.FLAME, 0.6));
                    ambient.add(new Ambient(at(g, 9, 22, 12).getLocation().add(0.5, 0.5, 0.5), Particle.FLAME, 0.6));
                }
                case "clash-royale" ->
                        ambient.add(new Ambient(at(g, 0, 27, 12).getLocation().add(0.5, 0.5, 0.5), Particle.WAX_ON, 2));
                case "anime-umetate" -> {
                    ambient.add(new Ambient(at(g, -6, 25, 7).getLocation().add(0.5, 0.5, 0.5), Particle.CHERRY_LEAVES, 3));
                    ambient.add(new Ambient(at(g, 6, 25, 7).getLocation().add(0.5, 0.5, 0.5), Particle.CHERRY_LEAVES, 3));
                    ambient.add(new Ambient(at(g, 0, 28, 7).getLocation().add(0.5, 0.5, 0.5), Particle.ELECTRIC_SPARK, 2.5));
                }
                default -> {
                }
            }
        }
    }

    private void buildPlaza() {
        world.getEntitiesByClass(TextDisplay.class).stream()
                .filter(e -> e.getScoreboardTags().contains(LABEL_TAG)).forEach(Entity::remove);
        for (int x = -CLEAR; x <= CLEAR; x++)
            for (int z = -CLEAR; z <= CLEAR; z++)
                for (int y = Y - 12; y <= Y + 24; y++)
                    world.getBlockAt(x, y, z).setType(Material.AIR, false);

        for (int x = -RADIUS; x <= RADIUS; x++) {
            for (int z = -RADIUS; z <= RADIUS; z++) {
                double r = Math.sqrt(x * x + z * z);
                if (r > RADIUS + 0.5) continue;
                Material m;
                if (r > RADIUS - 0.7) m = Material.POLISHED_BLACKSTONE_BRICKS;
                else if (r < 2.5) m = Material.CHISELED_QUARTZ_BLOCK;
                else if (((int) r) % 4 == 0) m = Material.DEEPSLATE_TILES;
                else m = ((x + z) & 1) == 0 ? Material.POLISHED_DEEPSLATE : Material.POLISHED_BLACKSTONE;
                world.getBlockAt(x, Y, z).setType(m, false);
                if (r > RADIUS - 0.7) {
                    world.getBlockAt(x, Y + 1, z).setType(Material.POLISHED_BLACKSTONE_WALL, true);
                }
            }
        }
        // lamps on the rim
        for (int i = 0; i < 16; i++) {
            double a = 2 * Math.PI * i / 16;
            int x = (int) Math.round(Math.sin(a) * (RADIUS - 1.5));
            int z = (int) Math.round(Math.cos(a) * (RADIUS - 1.5));
            world.getBlockAt(x, Y + 1, z).setType(Material.POLISHED_BLACKSTONE_WALL, true);
            world.getBlockAt(x, Y + 2, z).setType(Material.SOUL_LANTERN, false);
        }
        // center beacon-like pillar with welcome text
        // beacon under the spawn point: its beam shoots up through the glass the players spawn on
        for (int x = -1; x <= 1; x++)
            for (int z = -1; z <= 1; z++)
                world.getBlockAt(x, Y - 2, z).setType(Material.GOLD_BLOCK, false);
        world.getBlockAt(0, Y - 1, 0).setType(Material.BEACON, false);
        world.getBlockAt(0, Y, 0).setType(Material.YELLOW_STAINED_GLASS, false);
        label(new Location(world, 0.5, Y + 3.2, -2.5),
                MM.deserialize(getConfig().getString("lobby-name", "GAME LOBBY"))
                        .append(Component.newline())
                        .append(Component.text("ゲートに乗るか、コンパスを右クリック", NamedTextColor.GRAY))
                        .append(Component.newline())
                        .append(Component.text("配布物とあそび方: games.sharytech.com", NamedTextColor.AQUA)), 2.0f);
        label(new Location(world, 0.5, Y + 13, 0.5),
                MM.deserialize(getConfig().getString("lobby-name", "GAME LOBBY")), 6.0f);

        layoutGates();
        for (Gate g : gates) {
            buildGate(g);
            decorate(g);
        }

        try {
            java.nio.file.Files.writeString(new java.io.File(getDataFolder(), "built.flag").toPath(), BUILD_VERSION);
        } catch (java.io.IOException ignored) {
        }
    }

    private void buildGate(Gate g) {
        Destination d = g.dest();
        // pad 3x3 under the arch
        for (int i = -1; i <= 1; i++)
            for (int j = -1; j <= 1; j++)
                world.getBlockAt(g.x() + i, Y, g.z() + j).setType(d.pad(), false);
        world.getBlockAt(g.x(), Y, g.z()).setType(Material.GLOWSTONE, false);
        // arch perpendicular to the facing direction
        int px = g.dz() != 0 ? 1 : 0, pz = g.dx() != 0 ? 1 : 0;
        for (int s = -2; s <= 2; s += 4) {
            for (int y = 1; y <= 4; y++) {
                world.getBlockAt(g.x() + px * s, Y + y, g.z() + pz * s).setType(d.frame(), false);
            }
        }
        for (int s = -2; s <= 2; s++) {
            world.getBlockAt(g.x() + px * s, Y + 5, g.z() + pz * s).setType(d.frame(), false);
        }
        world.getBlockAt(g.x(), Y + 5, g.z()).setType(Material.SEA_LANTERN, false);
        // label in front of the arch, facing the plaza center
        Location l = new Location(world, g.x() + 0.5 + g.dx() * 1.6, Y + 6.3, g.z() + 0.5 + g.dz() * 1.6);
        Component text = MM.deserialize(d.name()).append(Component.newline());
        for (String line : d.description()) text = text.append(MM.deserialize(line)).append(Component.newline());
        text = text.append(d.ready() ? Component.text("▶ 乗ると移動", NamedTextColor.GREEN, TextDecoration.BOLD)
                : Component.text("準備中", NamedTextColor.YELLOW, TextDecoration.BOLD));
        label(l, text, 1.4f);
    }

    // ---------- decorations ----------
    // Each gate gets a themed floating island behind it, built in gate-local coordinates:
    // u = sideways, w = distance from the plaza center along the gate's axis, y = height above the floor.

    private Block at(Gate g, int u, int w, int y) {
        return world.getBlockAt(g.x() - g.dx() * (w - GATE_DIST) + g.dz() * u, Y + y,
                g.z() - g.dz() * (w - GATE_DIST) - g.dx() * u);
    }

    private void put(Gate g, int u, int w, int y, Material m) {
        at(g, u, w, y).setType(m, false);
    }

    private void put(Gate g, int u, int w, int y, org.bukkit.block.data.BlockData d) {
        at(g, u, w, y).setBlockData(d, false);
    }

    /** Puts a block only where the island has ground, so paths do not stick out into the void. */
    private void onGround(Gate g, int u, int w, Material m) {
        if (!at(g, u, w, 0).getType().isAir() && !at(g, u, w, -1).getType().isAir()) put(g, u, w, 0, m);
    }

    private BlockFace towardsCenter(Gate g) {
        if (g.dx() > 0) return BlockFace.EAST;
        if (g.dx() < 0) return BlockFace.WEST;
        return g.dz() > 0 ? BlockFace.SOUTH : BlockFace.NORTH;
    }

    private org.bukkit.block.data.BlockData facing(Material m, Gate g) {
        var d = m.createBlockData();
        if (d instanceof org.bukkit.block.data.Directional dir) dir.setFacing(towardsCenter(g));
        if (d instanceof org.bukkit.block.data.Rotatable rot) rot.setRotation(towardsCenter(g));
        return d;
    }

    private static final Random RNG = new Random(7);

    private void island(Gate g, int cw, int r, Material top, Material fill) {
        for (int u = -r; u <= r; u++) {
            for (int w = cw - r; w <= cw + r; w++) {
                double d = Math.hypot(u, w - cw);
                if (d > r + 0.3) continue;
                Block b = at(g, u, w, 0);
                if (Math.hypot(b.getX(), b.getZ()) <= RADIUS + 0.5) continue;
                b.setType(top, false);
                int depth = 1 + (int) ((r - d) * 0.9 + RNG.nextDouble());
                for (int k = 1; k <= depth; k++) put(g, u, w, -k, k <= 2 ? fill : Material.STONE);
            }
        }
    }

    private void decorate(Gate g) {
        // a strip in the gate's color leads from the center to the gate
        for (int w = 3; w <= GATE_DIST - 2; w++) put(g, 0, w, 0, g.dest().pad());
        switch (g.dest().theme()) {
            case "halloween" -> halloween(g);
            case "tiktok-defense" -> defense(g);
            case "clash-royale" -> clash(g);
            case "anime-umetate" -> anime(g);
            default -> island(g, 24, 8, Material.GRASS_BLOCK, Material.DIRT);
        }
    }

    private void halloween(Gate g) {
        island(g, 25, 9, Material.PODZOL, Material.DIRT);
        for (int i = 0; i < 25; i++) onGround(g, RNG.nextInt(15) - 7, 18 + RNG.nextInt(14),
                RNG.nextBoolean() ? Material.SOUL_SOIL : Material.COARSE_DIRT);
        // giant jack o'lantern with a glowing face towards the plaza
        int cw = 26, cy = 5;
        double ru = 5.2, ry = 4.3, rw = 4.6;
        for (int u = -6; u <= 6; u++)
            for (int y = 0; y <= 10; y++)
                for (int w = cw - 5; w <= cw + 5; w++) {
                    double e = sq(u / ru) + sq((y - cy) / ry) + sq((w - cw) / rw);
                    if (e <= 1 && e > 0.45) put(g, u, w, y, Material.PUMPKIN);
                }
        String[] face = {
                // y = cy+2 .. cy-3, u = -4 .. 4
                "..#...#..",
                ".###.###.",
                "....#....",
                "#.......#",
                "##.#.#.##",
                ".#######.",
        };
        for (int row = 0; row < face.length; row++) {
            int y = cy + 2 - row;
            for (int col = 0; col < 9; col++) {
                if (face[row].charAt(col) != '#') continue;
                int u = col - 4;
                for (int w = cw - 5; w <= cw; w++) {
                    if (sq(u / ru) + sq((y - cy) / ry) + sq((w - cw) / rw) <= 1) {
                        put(g, u, w, y, Material.SHROOMLIGHT);
                        put(g, u, w + 1, y, Material.SHROOMLIGHT);
                        break;
                    }
                }
            }
        }
        put(g, 0, cw, cy + 5, Material.DARK_OAK_LOG);
        put(g, 0, cw, cy + 6, Material.DARK_OAK_LOG);
        put(g, 1, cw, cy + 6, Material.MOSS_BLOCK);
        put(g, -1, cw + 1, cy + 5, Material.MOSS_BLOCK);
        // dead trees with cobwebs
        for (int s = -1; s <= 1; s += 2) {
            int u = 7 * s, w = 21;
            for (int y = 1; y <= 7; y++) put(g, u, w, y, Material.DARK_OAK_LOG);
            put(g, u + s, w, 4, Material.DARK_OAK_WOOD);
            put(g, u + 2 * s, w, 5, Material.DARK_OAK_WOOD);
            put(g, u + 2 * s, w, 6, Material.DARK_OAK_FENCE);
            put(g, u - s, w, 6, Material.DARK_OAK_WOOD);
            put(g, u - 2 * s, w, 7, Material.DARK_OAK_FENCE);
            put(g, u, w + 1, 7, Material.DARK_OAK_WOOD);
            put(g, u + 2 * s, w, 4, Material.COBWEB);
            put(g, u - s, w, 5, Material.COBWEB);
            put(g, u + s, w, 1, facing(Material.JACK_O_LANTERN, g));
        }
        // graves and soul fires
        for (int u : new int[]{-5, -2, 2, 5}) {
            put(g, u, 18, 1, Material.MOSSY_STONE_BRICK_WALL);
            put(g, u, 18, 2, Material.MOSSY_STONE_BRICK_WALL);
        }
        put(g, -3, 20, 1, Material.SOUL_CAMPFIRE);
        put(g, 3, 20, 1, Material.SOUL_CAMPFIRE);
        // lantern posts beside the gate and cobwebs in its corners
        for (int s = -1; s <= 1; s += 2) {
            put(g, 4 * s, GATE_DIST, 1, Material.DARK_OAK_FENCE);
            put(g, 4 * s, GATE_DIST, 2, Material.DARK_OAK_FENCE);
            put(g, 4 * s, GATE_DIST, 3, facing(Material.JACK_O_LANTERN, g));
            put(g, s, GATE_DIST, 4, Material.COBWEB);
        }
    }

    private void defense(Gate g) {
        island(g, 24, 9, Material.ANDESITE, Material.STONE);
        for (int i = 0; i < 25; i++) onGround(g, RNG.nextInt(17) - 8, 17 + RNG.nextInt(14),
                RNG.nextBoolean() ? Material.GRAVEL : Material.COBBLESTONE);
        // fortress wall with TikTok-colored neon stripes
        for (int u = -7; u <= 7; u++) {
            for (int w = 21; w <= 22; w++) {
                for (int y = 1; y <= 6; y++) {
                    double r = RNG.nextDouble();
                    put(g, u, w, y, r < 0.2 ? Material.CRACKED_STONE_BRICKS : r < 0.3 ? Material.MOSSY_STONE_BRICKS : Material.STONE_BRICKS);
                }
                if ((u & 1) == 0) put(g, u, w, 7, Material.STONE_BRICKS);
            }
            put(g, u, 21, 4, Material.CYAN_CONCRETE);
            put(g, u, 21, 5, Material.RED_CONCRETE);
            if (u % 3 == 0) put(g, u, 21, 6, Material.SEA_LANTERN);
        }
        for (int u : new int[]{-4, 0, 4}) put(g, u, 21, 2, Material.TARGET);
        for (int u : new int[]{-5, -1, 3}) put(g, u, 21, 7, facing(Material.ZOMBIE_HEAD, g));
        put(g, 5, 21, 7, facing(Material.SKELETON_SKULL, g));
        // watchtowers
        for (int s = -1; s <= 1; s += 2) {
            int cu = 9 * s;
            for (int u = cu - 1; u <= cu + 1; u++)
                for (int w = 21; w <= 23; w++) {
                    for (int y = 1; y <= 9; y++) put(g, u, w, y, Material.POLISHED_BLACKSTONE_BRICKS);
                    put(g, u, w, 7, Material.CYAN_CONCRETE);
                    put(g, u, w, 10, Material.RED_CONCRETE);
                    if (u != cu && w != 22) put(g, u, w, 11, Material.POLISHED_BLACKSTONE_BRICK_WALL);
                }
            put(g, cu, 22, 10, Material.SEA_LANTERN);
            put(g, cu, 22, 11, Material.END_ROD);
            put(g, cu, 21, 4, Material.IRON_BARS);
        }
        // sandbag barricades beside the gate
        for (int s = -1; s <= 1; s += 2) {
            put(g, 4 * s, GATE_DIST, 1, Material.MUD_BRICKS);
            put(g, 5 * s, GATE_DIST, 1, Material.MUD_BRICKS);
            put(g, 4 * s, GATE_DIST - 1, 1, Material.MUD_BRICKS);
            put(g, 4 * s, GATE_DIST, 2, Material.MUD_BRICK_WALL);
            put(g, 4 * s, GATE_DIST, 3, Material.LANTERN);
            put(g, 5 * s, GATE_DIST, 2, Material.TARGET);
        }
    }

    private void clash(Gate g) {
        island(g, 25, 10, Material.GRASS_BLOCK, Material.DIRT);
        // river with two bridges, like the arena
        for (int u = -10; u <= 10; u++)
            for (int w = 19; w <= 20; w++)
                onGround(g, u, w, Math.abs(Math.abs(u) - 5) <= 1 ? Material.SPRUCE_PLANKS : Material.LIGHT_BLUE_CONCRETE);
        // king tower
        for (int u = -3; u <= 3; u++)
            for (int w = 24; w <= 30; w++) {
                boolean edge = Math.abs(u) == 3 || w == 24 || w == 30;
                for (int y = 1; y <= 8; y++) {
                    if (!edge && y < 8) continue;
                    put(g, u, w, y, y == 6 && edge ? Material.BLUE_CONCRETE : Material.STONE_BRICKS);
                }
                if (edge) put(g, u, w, 9, ((u + w) & 1) == 0 ? Material.GOLD_BLOCK : Material.STONE_BRICKS);
            }
        put(g, 0, 24, 1, Material.AIR);
        put(g, 0, 24, 2, Material.AIR);
        put(g, -2, 24, 4, Material.BLUE_STAINED_GLASS);
        put(g, 2, 24, 4, Material.BLUE_STAINED_GLASS);
        for (int u = -1; u <= 1; u++)
            for (int w = 26; w <= 28; w++) {
                if (u == 0 && w == 27) continue;
                put(g, u, w, 9, Material.GOLD_BLOCK);
                put(g, u, w, 10, Material.GOLD_BLOCK);
                if (u != 0 && w != 27) put(g, u, w, 11, Material.GOLD_BLOCK);
            }
        put(g, 0, 26, 10, Material.REDSTONE_BLOCK);
        put(g, 0, 27, 9, Material.GLOWSTONE);
        for (int u = -3; u <= 3; u += 6)
            for (int w = 24; w <= 30; w += 6) put(g, u, w, 10, facing(Material.BLUE_BANNER, g));
        // princess towers
        for (int s = -1; s <= 1; s += 2) {
            int cu = 7 * s;
            for (int u = cu - 1; u <= cu + 1; u++)
                for (int w = 22; w <= 24; w++) {
                    for (int y = 1; y <= 6; y++) put(g, u, w, y, y == 5 ? Material.BLUE_CONCRETE : Material.STONE_BRICKS);
                    if (u != cu && w != 23) put(g, u, w, 7, Material.GOLD_BLOCK);
                }
            put(g, cu, 23, 7, Material.LANTERN);
            put(g, cu, 22, 8, facing(Material.BLUE_BANNER, g));
        }
        // banners beside the gate
        for (int s = -1; s <= 1; s += 2) {
            put(g, 4 * s, GATE_DIST, 1, Material.GOLD_BLOCK);
            put(g, 4 * s, GATE_DIST, 2, facing(Material.BLUE_BANNER, g));
        }
    }

    private void anime(Gate g) {
        island(g, 25, 9, Material.GRASS_BLOCK, Material.DIRT);
        for (int i = 0; i < 25; i++) onGround(g, RNG.nextInt(15) - 7, 18 + RNG.nextInt(14), Material.MOSS_BLOCK);
        for (int w = 16; w <= 31; w++) onGround(g, 0, w, Material.GRAVEL);
        // torii
        int tw = 19;
        for (int s = -1; s <= 1; s += 2) {
            put(g, 3 * s, tw, 1, Material.BLACK_CONCRETE);
            for (int y = 2; y <= 7; y++) put(g, 3 * s, tw, y, Material.RED_CONCRETE);
        }
        for (int u = -4; u <= 4; u++) put(g, u, tw, 5, Material.RED_CONCRETE);
        for (int u = -5; u <= 5; u++) put(g, u, tw, 7, Material.RED_CONCRETE);
        for (int u = -6; u <= 6; u++) put(g, u, tw, 8, Material.BLACK_CONCRETE);
        put(g, -7, tw, 9, Material.BLACK_CONCRETE);
        put(g, 7, tw, 9, Material.BLACK_CONCRETE);
        put(g, 0, tw, 6, Material.GOLD_BLOCK);
        // stone lanterns along the approach
        for (int s = -1; s <= 1; s += 2)
            for (int w : new int[]{22, 26}) {
                put(g, 2 * s, w, 1, Material.STONE_BRICK_WALL);
                put(g, 2 * s, w, 2, Material.LANTERN);
                put(g, 2 * s, w, 3, Material.STONE_BRICK_SLAB);
            }
        // cherry trees
        var leaves = (org.bukkit.block.data.type.Leaves) Material.CHERRY_LEAVES.createBlockData();
        leaves.setPersistent(true);
        for (int[] t : new int[][]{{-6, 25}, {6, 25}, {-5, 30}, {5, 30}}) {
            for (int u = -3; u <= 3; u++)
                for (int w = -3; w <= 3; w++)
                    for (int y = -2; y <= 2; y++)
                        if (sq(u / 3.2) + sq(w / 3.2) + sq(y / 2.2) <= 1 && RNG.nextDouble() < 0.92)
                            put(g, t[0] + u, t[1] + w, 7 + y, leaves);
            for (int y = 1; y <= 6; y++) put(g, t[0], t[1], y, Material.CHERRY_LOG);
            for (int k = 0; k < 4; k++) onGround(g, t[0] + RNG.nextInt(5) - 2, t[1] + RNG.nextInt(5) - 2, Material.PINK_PETALS);
        }
        // a charged energy ball (kamehameha) floating behind the torii
        for (int u = -3; u <= 3; u++)
            for (int w = -3; w <= 3; w++)
                for (int y = -3; y <= 3; y++) {
                    double d = Math.sqrt(u * u + w * w + y * y);
                    if (d <= 1.5) put(g, u, 28 + w, 7 + y, Material.SEA_LANTERN);
                    else if (d <= 2.7) put(g, u, 28 + w, 7 + y, Material.LIGHT_BLUE_STAINED_GLASS);
                }
        // small stone lanterns beside the gate
        for (int s = -1; s <= 1; s += 2) {
            put(g, 4 * s, GATE_DIST, 1, Material.STONE_BRICK_WALL);
            put(g, 4 * s, GATE_DIST, 2, Material.LANTERN);
            put(g, 4 * s, GATE_DIST, 3, Material.STONE_BRICK_SLAB);
        }
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
            int px = g.dz() != 0 ? 1 : 0, pz = g.dx() != 0 ? 1 : 0;
            Particle p = g.dest().ready() ? g.dest().particle() : Particle.SMOKE;
            for (int k = 0; k < 4; k++) {
                double s = (Math.random() * 3) - 1.5;
                world.spawnParticle(p, g.x() + 0.5 + px * s, Y + 1 + Math.random() * 3.8,
                        g.z() + 0.5 + pz * s, 1, 0, 0.05, 0, 0.01);
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
            boolean up = reachable(d.host(), d.port());
            Bukkit.getScheduler().runTask(this, () -> {
                if (!p.isOnline()) return;
                if (!up) {
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

    /** Asks the destination for its server list status, so a tunnel that is up but has no server behind it counts as closed. */
    private static boolean reachable(String host, int port) {
        try (java.net.Socket s = new java.net.Socket()) {
            s.connect(new java.net.InetSocketAddress(host, port), 3000);
            s.setSoTimeout(3000);
            var out = new java.io.DataOutputStream(s.getOutputStream());
            var hs = new java.io.ByteArrayOutputStream();
            var h = new java.io.DataOutputStream(hs);
            h.writeByte(0x00);              // handshake packet id
            writeVarInt(h, 775);            // protocol (any value works for status)
            byte[] hb = host.getBytes(java.nio.charset.StandardCharsets.UTF_8);
            writeVarInt(h, hb.length);
            h.write(hb);
            h.writeShort(port);
            writeVarInt(h, 1);              // next state: status
            writeVarInt(out, hs.size());
            out.write(hs.toByteArray());
            out.writeByte(1);               // status request: length 1
            out.writeByte(0x00);
            out.flush();
            return s.getInputStream().read() != -1;
        } catch (java.io.IOException e) {
            return false;
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
            if (Math.abs(under.getX() - g.x()) <= 1 && Math.abs(under.getZ() - g.z()) <= 1) {
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
