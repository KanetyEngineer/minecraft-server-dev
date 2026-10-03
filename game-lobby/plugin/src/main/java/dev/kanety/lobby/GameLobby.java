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
                       String brand, String info, boolean enabled) {
        boolean ready() {
            return enabled && host != null && !host.isBlank();
        }
    }

    /** Gate placed on the plaza: pad center and the direction the arch faces (towards the plaza center). */
    record Gate(Destination dest, int x, int z, int dx, int dz) {}

    static final int Y = 64;
    static final int RADIUS = 16;
    static final int GATE_DIST = 12;
    static final String LABEL_TAG = "lobby_label";
    static final MiniMessage MM = MiniMessage.miniMessage();

    private final Map<String, Destination> destinations = new LinkedHashMap<>();
    private final List<Gate> gates = new ArrayList<>();
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
        if (!new java.io.File(getDataFolder(), "built.flag").exists()) {
            buildPlaza();
        } else {
            layoutGates();
        }
        getServer().getPluginManager().registerEvents(this, this);
        Bukkit.getScheduler().runTaskTimer(this, this::tickParticles, 20L, 5L);
        // config.yml を書き換えたら自動で読み直してゲートを作り直す（公開アドレスの追加などをコンソールなしで反映するため）
        configStamp = configFile().lastModified();
        Bukkit.getScheduler().runTaskTimer(this, this::watchConfig, 100L, 100L);
    }

    private long configStamp;

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
                    d.getBoolean("enabled", false)));
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
    }

    private void buildPlaza() {
        world.getEntitiesByClass(TextDisplay.class).stream()
                .filter(e -> e.getScoreboardTags().contains(LABEL_TAG)).forEach(Entity::remove);
        for (int x = -RADIUS - 2; x <= RADIUS + 2; x++)
            for (int z = -RADIUS - 2; z <= RADIUS + 2; z++)
                for (int y = Y; y <= Y + 8; y++)
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
        world.getBlockAt(0, Y, 0).setType(Material.SEA_LANTERN, false);
        label(new Location(world, 0.5, Y + 3.2, -2.5),
                MM.deserialize(getConfig().getString("lobby-name", "GAME LOBBY"))
                        .append(Component.newline())
                        .append(Component.text("ゲートに乗るか、コンパスを右クリック", NamedTextColor.GRAY)), 2.0f);

        layoutGates();
        for (Gate g : gates) buildGate(g);

        try {
            new java.io.File(getDataFolder(), "built.flag").createNewFile();
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
