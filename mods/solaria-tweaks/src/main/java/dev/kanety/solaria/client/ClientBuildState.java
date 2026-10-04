package dev.kanety.solaria.client;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.util.ArrayList;
import java.util.List;

/** Client copy of the server's build plans (from BuildSyncPayload). */
public final class ClientBuildState {
    public record Person(String uuid, String name) {}

    public record Placement(String id, String name, String dim, String owner, int x, int y, int z) {}

    public record Material(String item, int req, int placed, int stock, int held, Person assignee) {
        public int remaining() {
            return Math.max(0, req - placed - stock - held);
        }

        public double progress() {
            return req == 0 ? 1 : Math.min(1.0, (double) (placed + stock + held) / req);
        }
    }

    public record Area(String id, int total, int done, int x1, int z1, int x2, int z2, Person assignee) {
        public double progress() {
            return total == 0 ? 0 : (double) done / total;
        }
    }

    public record Project(String name, String placement, String placementName, String dim, String status, String owner,
                          String ownerUuid, String areaMode, int gridSize, int total, int done, double materialProgress,
                          List<Person> members, List<int[]> storages, List<Material> materials, List<Area> areas) {
        public double buildProgress() {
            return total == 0 ? 0 : (double) done / total;
        }

        public boolean isMember(String uuid) {
            return members.stream().anyMatch(p -> p.uuid().equals(uuid));
        }
    }

    public static boolean received;
    public static boolean syncmatica;
    public static List<Placement> placements = List.of();
    public static List<Project> projects = List.of();

    private ClientBuildState() {}

    public static void reset() {
        received = false;
        placements = List.of();
        projects = List.of();
    }

    public static Project find(String name) {
        for (Project p : projects) if (p.name().equals(name)) return p;
        return null;
    }

    public static void apply(String json) {
        JsonObject root = JsonParser.parseString(json).getAsJsonObject();
        syncmatica = root.has("syncmatica") && root.get("syncmatica").getAsBoolean();
        List<Placement> pl = new ArrayList<>();
        for (JsonElement e : root.getAsJsonArray("placements")) {
            JsonObject o = e.getAsJsonObject();
            pl.add(new Placement(str(o, "id"), str(o, "name"), str(o, "dim"), str(o, "owner"),
                    o.get("x").getAsInt(), o.get("y").getAsInt(), o.get("z").getAsInt()));
        }
        List<Project> pr = new ArrayList<>();
        for (JsonElement e : root.getAsJsonArray("projects")) {
            JsonObject o = e.getAsJsonObject();
            List<Person> members = new ArrayList<>();
            for (JsonElement m : o.getAsJsonArray("members")) members.add(person(m));
            List<int[]> storages = new ArrayList<>();
            for (JsonElement s : o.getAsJsonArray("storages")) {
                JsonArray a = s.getAsJsonArray();
                storages.add(new int[]{a.get(0).getAsInt(), a.get(1).getAsInt(), a.get(2).getAsInt()});
            }
            List<Material> mats = new ArrayList<>();
            for (JsonElement m : o.getAsJsonArray("materials")) {
                JsonObject mo = m.getAsJsonObject();
                mats.add(new Material(str(mo, "item"), mo.get("req").getAsInt(), mo.get("placed").getAsInt(),
                        mo.get("stock").getAsInt(), mo.get("held").getAsInt(), person(mo.get("assignee"))));
            }
            List<Area> areas = new ArrayList<>();
            for (JsonElement a : o.getAsJsonArray("areas")) {
                JsonObject ao = a.getAsJsonObject();
                areas.add(new Area(str(ao, "id"), ao.get("total").getAsInt(), ao.get("done").getAsInt(),
                        ao.get("x1").getAsInt(), ao.get("z1").getAsInt(), ao.get("x2").getAsInt(), ao.get("z2").getAsInt(),
                        person(ao.get("assignee"))));
            }
            pr.add(new Project(str(o, "name"), str(o, "placement"), str(o, "placementName"), str(o, "dim"),
                    str(o, "status"), str(o, "owner"), str(o, "ownerUuid"), str(o, "areaMode"), o.get("gridSize").getAsInt(),
                    o.get("total").getAsInt(), o.get("done").getAsInt(), o.get("materialProgress").getAsDouble(),
                    members, storages, mats, areas));
        }
        placements = pl;
        projects = pr;
        received = true;
    }

    private static String str(JsonObject o, String key) {
        JsonElement e = o.get(key);
        return e == null || e.isJsonNull() ? "" : e.getAsString();
    }

    private static Person person(JsonElement e) {
        if (e == null || e.isJsonNull()) return null;
        JsonObject o = e.getAsJsonObject();
        return new Person(str(o, "uuid"), str(o, "name"));
    }
}
