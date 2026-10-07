package dev.kanety.solaria.plan;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.reflect.TypeToken;
import dev.kanety.solaria.SolariaTweaks;
import dev.kanety.solaria.net.BuildSyncPayload;
import net.fabricmc.fabric.api.networking.v1.ServerPlayNetworking;
import net.minecraft.core.BlockPos;
import net.minecraft.core.component.DataComponents;
import net.minecraft.core.registries.Registries;
import net.minecraft.resources.Identifier;
import net.minecraft.resources.ResourceKey;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.Container;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.component.ItemContainerContents;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.storage.LevelResource;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;

/** Server side of the shared build plans: persistence, world scanning, stock counting and client sync. */
public final class BuildManager {
    private static final Gson GSON = new GsonBuilder().setPrettyPrinting().create();
    private static final int SCAN_BUDGET_PER_TICK = 6000;
    private static BuildManager instance;

    private final MinecraftServer server;
    private final Path file;
    private final Map<String, BuildProject> projects = new LinkedHashMap<>();
    private List<SyncmaticaBridge.PlacementInfo> placements = new ArrayList<>();
    private long ticks;
    private String lastSyncJson;

    private BuildManager(MinecraftServer server) {
        this.server = server;
        this.file = server.getWorldPath(LevelResource.ROOT).resolve("solariatweaks").resolve("builds.json");
    }

    public static BuildManager get() {
        return instance;
    }

    public static void start(MinecraftServer server) {
        instance = new BuildManager(server);
        instance.load();
    }

    public static void stop() {
        if (instance != null) instance.save();
        instance = null;
    }

    public MinecraftServer server() {
        return server;
    }

    public Map<String, BuildProject> projects() {
        return projects;
    }

    public List<SyncmaticaBridge.PlacementInfo> placements() {
        return placements;
    }

    public void markSyncNeeded() {
        lastSyncJson = null;
    }

    // ---------------------------------------------------------------- persistence

    private void load() {
        Path source = file;
        if (!Files.exists(source)) {
            // Data written by the earlier "Solaria Tools" build.
            source = server.getWorldPath(LevelResource.ROOT).resolve("solariatools").resolve("builds.json");
            if (!Files.exists(source)) return;
        }
        try {
            String json = Files.readString(source, StandardCharsets.UTF_8);
            List<BuildProject.Data> list = GSON.fromJson(json, new TypeToken<List<BuildProject.Data>>() {}.getType());
            if (list != null) for (BuildProject.Data d : list) projects.put(d.name, new BuildProject(d));
        } catch (Exception e) {
            SolariaTweaks.LOGGER.error("Could not read {}", file, e);
        }
    }

    public void save() {
        try {
            Files.createDirectories(file.getParent());
            List<BuildProject.Data> list = new ArrayList<>();
            for (BuildProject p : projects.values()) list.add(p.data);
            Files.writeString(file, GSON.toJson(list), StandardCharsets.UTF_8);
        } catch (IOException e) {
            SolariaTweaks.LOGGER.error("Could not write {}", file, e);
        }
        markSyncNeeded();
    }

    // ---------------------------------------------------------------- projects

    public Optional<SyncmaticaBridge.PlacementInfo> findPlacement(String key) {
        refreshPlacements();
        for (SyncmaticaBridge.PlacementInfo p : placements) if (p.id().toString().equals(key)) return Optional.of(p);
        for (SyncmaticaBridge.PlacementInfo p : placements) if (p.name().equalsIgnoreCase(key)) return Optional.of(p);
        try {
            int index = Integer.parseInt(key) - 1;
            if (index >= 0 && index < placements.size()) return Optional.of(placements.get(index));
        } catch (NumberFormatException ignored) {
        }
        return Optional.empty();
    }

    public BuildProject create(String name, SyncmaticaBridge.PlacementInfo placement, ServerPlayer owner) {
        BuildProject.Data d = new BuildProject.Data();
        d.name = name;
        d.placementId = placement.id().toString();
        if (owner != null) {
            d.ownerUuid = owner.getStringUUID();
            d.ownerName = owner.getName().getString();
            d.members.add(new BuildProject.Person(d.ownerUuid, d.ownerName));
        }
        BuildProject p = new BuildProject(d);
        projects.put(name, p);
        save();
        return p;
    }

    public void delete(String name) {
        projects.remove(name);
        save();
    }

    private void refreshPlacements() {
        placements = SyncmaticaBridge.placements();
    }

    private void refreshProjects() {
        refreshPlacements();
        Map<String, SyncmaticaBridge.PlacementInfo> byId = new HashMap<>();
        for (SyncmaticaBridge.PlacementInfo p : placements) byId.put(p.id().toString(), p);
        for (BuildProject project : projects.values()) {
            SyncmaticaBridge.PlacementInfo info = byId.get(project.data.placementId);
            if (info == null) {
                if (!"missing".equals(project.status)) {
                    project.status = SyncmaticaBridge.isLoaded() ? "missing" : "no-syncmatica";
                    project.signature = null;
                }
                continue;
            }
            project.placementName = info.name();
            project.dimension = info.dimension();
            String sig = info.signature();
            if (sig.equals(project.signature) || "parsing".equals(project.status)) continue;
            if (info.file() == null || !Files.exists(info.file())) {
                project.status = "no-file";
                continue;
            }
            project.status = "parsing";
            CompletableFuture.supplyAsync(() -> {
                try {
                    return Schematic.load(info.file(), info);
                } catch (Exception e) {
                    SolariaTweaks.LOGGER.error("Could not read schematic {}", info.file(), e);
                    return null;
                }
            }).thenAccept(schem -> server.execute(() -> {
                if (projects.get(project.data.name) != project) return;
                if (schem == null) {
                    project.status = "error";
                    project.signature = sig;
                } else {
                    project.attach(schem, sig);
                }
                markSyncNeeded();
            }));
        }
    }

    // ---------------------------------------------------------------- tick

    public void tick() {
        ticks++;
        if (ticks % 100 == 1) refreshProjects();
        scan();
        if (ticks % 40 == 0) countStock();
        if (ticks % 20 == 0) sync();
    }

    private ServerLevel level(String dimension) {
        Identifier id = Identifier.tryParse(dimension);
        if (id == null) return null;
        return server.getLevel(ResourceKey.create(Registries.DIMENSION, id));
    }

    private void scan() {
        List<BuildProject> ready = new ArrayList<>();
        for (BuildProject p : projects.values()) if ("ready".equals(p.status) && p.totalBlocks() > 0) ready.add(p);
        if (ready.isEmpty()) return;
        int budget = SCAN_BUDGET_PER_TICK / ready.size();
        BlockPos.MutableBlockPos pos = new BlockPos.MutableBlockPos();
        for (BuildProject p : ready) {
            ServerLevel level = level(p.dimension);
            if (level == null) continue;
            Schematic s = p.schematic;
            int n = s.size();
            for (int k = 0; k < budget && k < n; k++) {
                int i = p.scanCursor;
                p.scanCursor = (i + 1) % n;
                long packed = s.positions[i];
                int x = BlockPos.getX(packed), z = BlockPos.getZ(packed);
                if (!level.hasChunk(x >> 4, z >> 4)) continue;
                pos.set(x, BlockPos.getY(packed), z);
                boolean ok = level.getBlockState(pos).getBlock() == s.palette.get(s.states[i]).getBlock();
                p.setMatched(i, ok);
            }
        }
    }

    private void countStock() {
        for (BuildProject p : projects.values()) {
            if (!"ready".equals(p.status)) continue;
            Map<Item, Integer> stock = new HashMap<>();
            ServerLevel level = level(p.dimension);
            if (level != null) {
                for (long packed : p.data.storages) {
                    BlockPos pos = BlockPos.of(packed);
                    if (!level.hasChunk(pos.getX() >> 4, pos.getZ() >> 4)) continue;
                    BlockEntity be = level.getBlockEntity(pos);
                    if (be instanceof Container c) {
                        for (int i = 0; i < c.getContainerSize(); i++) addStack(stock, c.getItem(i), p);
                    }
                }
            }
            Map<Item, Integer> held = new HashMap<>();
            for (BuildProject.Person m : p.data.members) {
                ServerPlayer pl = server.getPlayerList().getPlayer(UUID.fromString(m.uuid));
                if (pl == null) continue;
                var inv = pl.getInventory();
                for (int i = 0; i < inv.getContainerSize(); i++) addStack(held, inv.getItem(i), p);
            }
            p.stock = stock;
            p.held = held;
        }
    }

    private static void addStack(Map<Item, Integer> into, ItemStack stack, BuildProject p) {
        if (stack.isEmpty()) return;
        if (p.required.containsKey(stack.getItem())) into.merge(stack.getItem(), stack.getCount(), Integer::sum);
        ItemContainerContents contents = stack.get(DataComponents.CONTAINER);
        if (contents != null) {
            for (ItemStack inner : contents.nonEmptyItems()) {
                if (p.required.containsKey(inner.getItem())) into.merge(inner.getItem(), inner.getCount(), Integer::sum);
            }
        }
    }

    // ---------------------------------------------------------------- sync

    public JsonObject toJson() {
        JsonObject root = new JsonObject();
        root.addProperty("syncmatica", SyncmaticaBridge.isLoaded());
        JsonArray pl = new JsonArray();
        for (SyncmaticaBridge.PlacementInfo p : placements) {
            JsonObject o = new JsonObject();
            o.addProperty("id", p.id().toString());
            o.addProperty("name", p.name());
            o.addProperty("dim", p.dimension());
            o.addProperty("owner", p.owner());
            o.addProperty("x", p.origin().getX());
            o.addProperty("y", p.origin().getY());
            o.addProperty("z", p.origin().getZ());
            pl.add(o);
        }
        root.add("placements", pl);
        JsonArray arr = new JsonArray();
        for (BuildProject p : projects.values()) arr.add(p.toJson());
        root.add("projects", arr);
        return root;
    }

    private void sync() {
        String json = toJson().toString();
        if (json.equals(lastSyncJson)) return;
        lastSyncJson = json;
        BuildSyncPayload payload = new BuildSyncPayload(json);
        for (ServerPlayer player : server.getPlayerList().getPlayers()) {
            if (ServerPlayNetworking.canSend(player, BuildSyncPayload.TYPE)) ServerPlayNetworking.send(player, payload);
        }
    }

    public static boolean sameLevel(Level level, String dimension) {
        return level.dimension().identifier().toString().equals(dimension);
    }
}
