package dev.kanety.solaria.board;

import net.minecraft.core.Registry;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.resources.Identifier;
import net.minecraft.stats.StatType;

import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;

/**
 * What a leaderboard ranks: one vanilla statistic ("mined:stone") or the sum of a whole statistic type ("mined:all").
 * Presets give the common ones a short name.
 */
public record Criterion(String key, String label, String type, String value, Format format) {
    public enum Format { NUMBER, TICKS, CENTIMETERS }

    /** Short type names accepted before the colon. */
    public static final Map<String, String> TYPES = new LinkedHashMap<>();
    public static final Map<String, Criterion> PRESETS = new LinkedHashMap<>();

    static {
        TYPES.put("mined", "minecraft:mined");
        TYPES.put("used", "minecraft:used");
        TYPES.put("crafted", "minecraft:crafted");
        TYPES.put("broken", "minecraft:broken");
        TYPES.put("picked_up", "minecraft:picked_up");
        TYPES.put("dropped", "minecraft:dropped");
        TYPES.put("killed", "minecraft:killed");
        TYPES.put("killed_by", "minecraft:killed_by");
        TYPES.put("custom", "minecraft:custom");

        preset("mined", "採掘数", "minecraft:mined", null, Format.NUMBER);
        preset("used", "使用回数（設置など）", "minecraft:used", null, Format.NUMBER);
        preset("crafted", "クラフト数", "minecraft:crafted", null, Format.NUMBER);
        preset("kills", "モブ討伐数", "minecraft:custom", "minecraft:mob_kills", Format.NUMBER);
        preset("deaths", "死亡数", "minecraft:custom", "minecraft:deaths", Format.NUMBER);
        preset("playtime", "プレイ時間", "minecraft:custom", "minecraft:play_time", Format.TICKS);
        preset("walk", "歩いた距離", "minecraft:custom", "minecraft:walk_one_cm", Format.CENTIMETERS);
        preset("fly", "エリトラ飛行距離", "minecraft:custom", "minecraft:aviate_one_cm", Format.CENTIMETERS);
        preset("fish", "釣った数", "minecraft:custom", "minecraft:fish_caught", Format.NUMBER);
        preset("trades", "村人との取引", "minecraft:custom", "minecraft:traded_with_villager", Format.NUMBER);
        preset("jumps", "ジャンプ", "minecraft:custom", "minecraft:jump", Format.NUMBER);
        preset("damage", "与えたダメージ", "minecraft:custom", "minecraft:damage_dealt", Format.NUMBER);
    }

    private static void preset(String key, String label, String type, String value, Format format) {
        PRESETS.put(key, new Criterion(key, label, type, value, format));
    }

    public boolean all() {
        return value == null;
    }

    /** Parses a preset name, "type:all" or "type:id" (namespace optional). Returns null if unknown. */
    public static Criterion parse(String raw) {
        String s = raw.strip().toLowerCase(Locale.ROOT);
        Criterion preset = PRESETS.get(s);
        if (preset != null) return preset;
        int colon = s.indexOf(':');
        if (colon <= 0) return null;
        String typeName = s.substring(0, colon);
        String rest = s.substring(colon + 1);
        String type = TYPES.get(typeName);
        if (type == null) return null;
        if (rest.isEmpty() || rest.equals("all")) {
            return new Criterion(typeName + ":all", typeLabel(typeName) + "（合計）", type, null, Format.NUMBER);
        }
        Identifier id = Identifier.tryParse(rest.contains(":") ? rest : "minecraft:" + rest);
        if (id == null) return null;
        StatType<?> statType = BuiltInRegistries.STAT_TYPE.getValue(Identifier.parse(type));
        if (statType == null || !statType.getRegistry().containsKey(id)) return null;
        Format format = Format.NUMBER;
        if (typeName.equals("custom")) {
            if (id.getPath().endsWith("_one_cm")) format = Format.CENTIMETERS;
            else if (id.getPath().equals("play_time") || id.getPath().equals("total_world_time") || id.getPath().startsWith("time_since")
                    || id.getPath().equals("sneak_time")) format = Format.TICKS;
        }
        String shortId = id.getNamespace().equals("minecraft") ? id.getPath() : id.toString();
        return new Criterion(typeName + ":" + shortId, typeLabel(typeName) + " " + shortId, type, id.toString(), format);
    }

    static String typeLabel(String typeName) {
        return switch (typeName) {
            case "mined" -> "採掘";
            case "used" -> "使用";
            case "crafted" -> "クラフト";
            case "broken" -> "壊した道具";
            case "picked_up" -> "拾った";
            case "dropped" -> "捨てた";
            case "killed" -> "倒した";
            case "killed_by" -> "倒された";
            default -> "統計";
        };
    }

    /** Registry behind a short type name, for command suggestions. */
    static Registry<?> registryOf(String typeName) {
        String type = TYPES.get(typeName);
        if (type == null) return null;
        StatType<?> statType = BuiltInRegistries.STAT_TYPE.getValue(Identifier.parse(type));
        return statType == null ? null : statType.getRegistry();
    }

    public String formatValue(long v) {
        return switch (format) {
            case TICKS -> String.format(Locale.ROOT, "%.1f時間", v / 72000.0);
            case CENTIMETERS -> v >= 100000 ? String.format(Locale.ROOT, "%.1fkm", v / 100000.0) : (v / 100) + "m";
            case NUMBER -> Long.toString(v);
        };
    }
}
