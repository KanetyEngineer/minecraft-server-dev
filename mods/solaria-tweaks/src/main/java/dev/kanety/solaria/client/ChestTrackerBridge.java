package dev.kanety.solaria.client;

import net.fabricmc.loader.api.FabricLoader;
import net.minecraft.client.Minecraft;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.resources.Identifier;
import net.minecraft.world.item.ItemStack;

import java.lang.reflect.Method;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

/**
 * What Chest Tracker remembers on this client: item counts in containers you have opened, outside the plan's
 * registered storages. Reflection keeps Chest Tracker optional.
 */
public final class ChestTrackerBridge {
    public record Found(int count, BlockPos nearest) {}

    private static boolean failed;
    private static long lastRefresh;
    private static String lastKey = "";
    private static Map<String, Found> cache = Map.of();

    private ChestTrackerBridge() {}

    public static boolean available() {
        return !failed && FabricLoader.getInstance().isModLoaded("chesttracker");
    }

    /** item id -> remembered amount (cached for 2 seconds). */
    public static Map<String, Found> find(ClientBuildState.Project project) {
        if (!available() || project == null) return Map.of();
        long now = System.currentTimeMillis();
        if (project.name().equals(lastKey) && now - lastRefresh < 2000) return cache;
        lastKey = project.name();
        lastRefresh = now;
        cache = compute(project);
        return cache;
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Found> compute(ClientBuildState.Project project) {
        Minecraft mc = Minecraft.getInstance();
        if (mc.player == null) return Map.of();
        Set<String> wanted = new HashSet<>();
        for (ClientBuildState.Material m : project.materials()) wanted.add(m.item());
        Set<BlockPos> storages = new HashSet<>();
        for (int[] s : project.storages()) storages.add(new BlockPos(s[0], s[1], s[2]));
        try {
            Class<?> accessClass = Class.forName("red.jackf.chesttracker.api.memory.MemoryBankAccess");
            Object access = accessClass.getField("INSTANCE").get(null);
            Optional<?> bank = (Optional<?>) accessClass.getMethod("getLoaded").invoke(access);
            if (bank.isEmpty()) return Map.of();
            Class<?> bankClass = Class.forName("red.jackf.chesttracker.api.memory.MemoryBank");
            Method getKey = null;
            for (Method m : bankClass.getMethods()) {
                if (m.getName().equals("getKey") && m.getParameterCount() == 1
                        && m.getParameterTypes()[0].isAssignableFrom(Identifier.class)) getKey = m;
            }
            if (getKey == null) return Map.of();
            Identifier dim = Identifier.tryParse(project.dim());
            Optional<?> key = (Optional<?>) getKey.invoke(bank.get(), dim);
            if (key.isEmpty()) return Map.of();
            Method getMemories = Class.forName("red.jackf.chesttracker.api.memory.MemoryKey").getMethod("getMemories");
            Class<?> memoryClass = Class.forName("red.jackf.chesttracker.api.memory.Memory");
            Method items = memoryClass.getMethod("items");
            Method others = memoryClass.getMethod("otherPositions");
            Map<BlockPos, ?> memories = (Map<BlockPos, ?>) getMemories.invoke(key.get());
            BlockPos here = mc.player.blockPosition();
            Map<String, Integer> counts = new HashMap<>();
            Map<String, BlockPos> nearest = new HashMap<>();
            for (Map.Entry<BlockPos, ?> e : memories.entrySet()) {
                if (storages.contains(e.getKey())) continue;
                List<BlockPos> other = (List<BlockPos>) others.invoke(e.getValue());
                if (other != null && other.stream().anyMatch(storages::contains)) continue;
                for (ItemStack stack : (List<ItemStack>) items.invoke(e.getValue())) {
                    String id = BuiltInRegistries.ITEM.getKey(stack.getItem()).toString();
                    if (!wanted.contains(id)) continue;
                    counts.merge(id, stack.getCount(), Integer::sum);
                    BlockPos best = nearest.get(id);
                    if (best == null || e.getKey().distSqr(here) < best.distSqr(here)) nearest.put(id, e.getKey());
                }
            }
            Map<String, Found> out = new HashMap<>();
            for (Map.Entry<String, Integer> e : counts.entrySet()) out.put(e.getKey(), new Found(e.getValue(), nearest.get(e.getKey())));
            return out;
        } catch (Throwable t) {
            failed = true;
            return Map.of();
        }
    }
}
