package dev.kanety.solaria.plan;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.world.item.Item;

import java.util.ArrayList;
import java.util.BitSet;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** One shared build plan tied to one Syncmatica placement. */
public final class BuildProject {
    /** Saved to world/solariatools/builds.json. */
    public static final class Data {
        public String name;
        public String placementId;
        public String ownerUuid;
        public String ownerName;
        public String areaMode = "grid";
        public int gridSize = 16;
        public List<Person> members = new ArrayList<>();
        public Map<String, Person> materialAssign = new LinkedHashMap<>();
        public Map<String, Person> areaAssign = new LinkedHashMap<>();
        public List<Long> storages = new ArrayList<>();
    }

    public static final class Person {
        public String uuid;
        public String name;

        public Person() {}

        public Person(String uuid, String name) {
            this.uuid = uuid;
            this.name = name;
        }
    }

    public final Data data;

    // runtime state, rebuilt from the schematic
    public String status = "loading";
    public String signature;
    public String placementName = "?";
    public String dimension = "minecraft:overworld";
    public Schematic schematic;
    BitSet matched = new BitSet();
    int scanCursor;
    int[] entryArea = new int[0];
    List<String> areaIds = new ArrayList<>();
    int[] areaTotal = new int[0];
    int[] areaDone = new int[0];
    int[] areaBounds = new int[0]; // minX,minZ,maxX,maxZ per area
    Item[] paletteItem = new Item[0];
    int[] paletteCount = new int[0];
    Map<Item, Integer> required = new LinkedHashMap<>();
    Map<Item, Integer> placed = new HashMap<>();
    Map<Item, Integer> stock = new HashMap<>();
    Map<Item, Integer> held = new HashMap<>();
    int doneBlocks;

    public BuildProject(Data data) {
        this.data = data;
    }

    void attach(Schematic schematic, String signature) {
        this.schematic = schematic;
        this.signature = signature;
        int n = schematic.palette.size();
        paletteItem = new Item[n];
        paletteCount = new int[n];
        for (int i = 0; i < n; i++) {
            MaterialRules.Cost cost = MaterialRules.costOf(schematic.palette.get(i));
            if (cost != null) {
                paletteItem[i] = cost.item();
                paletteCount[i] = cost.count();
            }
        }
        Map<Item, Integer> req = new HashMap<>();
        for (int i = 0; i < schematic.size(); i++) {
            int s = schematic.states[i];
            if (paletteItem[s] != null) req.merge(paletteItem[s], paletteCount[s], Integer::sum);
        }
        required = new LinkedHashMap<>();
        req.entrySet().stream()
                .sorted((a, b) -> Integer.compare(b.getValue(), a.getValue()))
                .forEach(e -> required.put(e.getKey(), e.getValue()));
        matched = new BitSet(schematic.size());
        placed = new HashMap<>();
        doneBlocks = 0;
        scanCursor = 0;
        rebuildAreas();
        status = "ready";
    }

    void rebuildAreas() {
        if (schematic == null) return;
        Map<String, Integer> index = new LinkedHashMap<>();
        entryArea = new int[schematic.size()];
        boolean subregions = "subregions".equals(data.areaMode);
        int size = Math.max(4, data.gridSize);
        for (int i = 0; i < schematic.size(); i++) {
            String id;
            if (subregions) {
                id = schematic.regionNames.get(schematic.regions[i]);
            } else {
                long p = schematic.positions[i];
                int col = Math.floorDiv(BlockPos.getX(p) - schematic.minX, size);
                int row = Math.floorDiv(BlockPos.getZ(p) - schematic.minZ, size);
                id = rowName(row) + (col + 1);
            }
            entryArea[i] = index.computeIfAbsent(id, k -> index.size());
        }
        List<String> ids = new ArrayList<>(index.keySet());
        if (!subregions) ids.sort(BuildProject::compareGridIds);
        Map<String, Integer> sortedIndex = new HashMap<>();
        for (int i = 0; i < ids.size(); i++) sortedIndex.put(ids.get(i), i);
        int[] remap = new int[ids.size()];
        for (Map.Entry<String, Integer> e : index.entrySet()) remap[e.getValue()] = sortedIndex.get(e.getKey());
        areaIds = ids;
        areaTotal = new int[ids.size()];
        areaDone = new int[ids.size()];
        areaBounds = new int[ids.size() * 4];
        for (int a = 0; a < ids.size(); a++) {
            areaBounds[a * 4] = Integer.MAX_VALUE;
            areaBounds[a * 4 + 1] = Integer.MAX_VALUE;
            areaBounds[a * 4 + 2] = Integer.MIN_VALUE;
            areaBounds[a * 4 + 3] = Integer.MIN_VALUE;
        }
        for (int i = 0; i < entryArea.length; i++) {
            int a = remap[entryArea[i]];
            entryArea[i] = a;
            areaTotal[a]++;
            if (matched.get(i)) areaDone[a]++;
            long p = schematic.positions[i];
            int x = BlockPos.getX(p), z = BlockPos.getZ(p);
            areaBounds[a * 4] = Math.min(areaBounds[a * 4], x);
            areaBounds[a * 4 + 1] = Math.min(areaBounds[a * 4 + 1], z);
            areaBounds[a * 4 + 2] = Math.max(areaBounds[a * 4 + 2], x);
            areaBounds[a * 4 + 3] = Math.max(areaBounds[a * 4 + 3], z);
        }
        data.areaAssign.keySet().retainAll(ids);
    }

    private static String rowName(int row) {
        StringBuilder sb = new StringBuilder();
        int r = row;
        do {
            sb.insert(0, (char) ('A' + r % 26));
            r = r / 26 - 1;
        } while (r >= 0);
        return sb.toString();
    }

    private static int compareGridIds(String a, String b) {
        String la = a.replaceAll("[0-9]", ""), lb = b.replaceAll("[0-9]", "");
        if (la.length() != lb.length()) return Integer.compare(la.length(), lb.length());
        int c = la.compareTo(lb);
        if (c != 0) return c;
        return Integer.compare(Integer.parseInt(a.substring(la.length())), Integer.parseInt(b.substring(lb.length())));
    }

    void setMatched(int i, boolean value) {
        if (matched.get(i) == value) return;
        matched.set(i, value);
        int d = value ? 1 : -1;
        doneBlocks += d;
        areaDone[entryArea[i]] += d;
        int s = schematic.states[i];
        if (paletteItem[s] != null) placed.merge(paletteItem[s], d * paletteCount[s], Integer::sum);
    }

    public int totalBlocks() {
        return schematic == null ? 0 : schematic.size();
    }

    public boolean isMember(String uuid) {
        return data.members.stream().anyMatch(p -> p.uuid.equals(uuid));
    }

    public static String itemId(Item item) {
        return BuiltInRegistries.ITEM.getKey(item).toString();
    }

    /** Material progress: placed + in storage + carried by members, capped by requirement. */
    public double materialProgress() {
        long req = 0, have = 0;
        for (Map.Entry<Item, Integer> e : required.entrySet()) {
            int r = e.getValue();
            req += r;
            have += Math.min(r, placed.getOrDefault(e.getKey(), 0) + stock.getOrDefault(e.getKey(), 0) + held.getOrDefault(e.getKey(), 0));
        }
        return req == 0 ? 1.0 : (double) have / req;
    }

    public double buildProgress() {
        int total = totalBlocks();
        return total == 0 ? 0.0 : (double) doneBlocks / total;
    }

    JsonObject toJson() {
        JsonObject o = new JsonObject();
        o.addProperty("name", data.name);
        o.addProperty("placement", data.placementId);
        o.addProperty("placementName", placementName);
        o.addProperty("dim", dimension);
        o.addProperty("status", status);
        o.addProperty("owner", data.ownerName);
        o.addProperty("ownerUuid", data.ownerUuid);
        o.addProperty("areaMode", data.areaMode);
        o.addProperty("gridSize", data.gridSize);
        o.addProperty("total", totalBlocks());
        o.addProperty("done", doneBlocks);
        o.addProperty("materialProgress", materialProgress());
        JsonArray members = new JsonArray();
        for (Person p : data.members) members.add(person(p));
        o.add("members", members);
        JsonArray storages = new JsonArray();
        for (long s : data.storages) {
            JsonArray a = new JsonArray();
            a.add(BlockPos.getX(s));
            a.add(BlockPos.getY(s));
            a.add(BlockPos.getZ(s));
            storages.add(a);
        }
        o.add("storages", storages);
        JsonArray mats = new JsonArray();
        for (Map.Entry<Item, Integer> e : required.entrySet()) {
            JsonObject m = new JsonObject();
            String id = itemId(e.getKey());
            m.addProperty("item", id);
            m.addProperty("req", e.getValue());
            m.addProperty("placed", placed.getOrDefault(e.getKey(), 0));
            m.addProperty("stock", stock.getOrDefault(e.getKey(), 0));
            m.addProperty("held", held.getOrDefault(e.getKey(), 0));
            Person a = data.materialAssign.get(id);
            if (a != null) m.add("assignee", person(a));
            mats.add(m);
        }
        o.add("materials", mats);
        JsonArray areas = new JsonArray();
        for (int i = 0; i < areaIds.size(); i++) {
            JsonObject a = new JsonObject();
            String id = areaIds.get(i);
            a.addProperty("id", id);
            a.addProperty("total", areaTotal[i]);
            a.addProperty("done", areaDone[i]);
            a.addProperty("x1", areaBounds[i * 4]);
            a.addProperty("z1", areaBounds[i * 4 + 1]);
            a.addProperty("x2", areaBounds[i * 4 + 2]);
            a.addProperty("z2", areaBounds[i * 4 + 3]);
            Person p = data.areaAssign.get(id);
            if (p != null) a.add("assignee", person(p));
            areas.add(a);
        }
        o.add("areas", areas);
        return o;
    }

    private static JsonObject person(Person p) {
        JsonObject o = new JsonObject();
        o.addProperty("uuid", p.uuid);
        o.addProperty("name", p.name);
        return o;
    }
}
