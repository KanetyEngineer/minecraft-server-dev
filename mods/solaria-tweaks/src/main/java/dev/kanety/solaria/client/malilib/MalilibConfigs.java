package dev.kanety.solaria.client.malilib;

import com.google.common.collect.ImmutableList;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import dev.kanety.solaria.SolariaTweaks;
import dev.kanety.solaria.client.ClientConfig;
import fi.dy.masa.malilib.config.ConfigUtils;
import fi.dy.masa.malilib.config.IConfigBase;
import fi.dy.masa.malilib.config.IConfigHandler;
import fi.dy.masa.malilib.config.options.ConfigBoolean;
import fi.dy.masa.malilib.config.options.ConfigHotkey;
import fi.dy.masa.malilib.config.options.ConfigInteger;
import fi.dy.masa.malilib.config.options.ConfigOptionList;
import fi.dy.masa.malilib.config.options.ConfigString;
import fi.dy.masa.malilib.hotkeys.IHotkey;
import fi.dy.masa.malilib.util.FileUtils;
import fi.dy.masa.malilib.util.data.json.JsonUtils;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

/**
 * MaLiLib options and hotkeys. The settings themselves still live in ClientConfig (solariatweaks-client.json) so the
 * mod works the same without MaLiLib; only the hotkeys are stored in config/solariatweaks-malilib.json.
 */
public final class MalilibConfigs implements IConfigHandler {
    private static final String FILE = "solariatweaks-malilib.json";
    private static final String GENERIC = SolariaTweaks.MOD_ID + ".config.generic";
    private static final String HOTKEYS = SolariaTweaks.MOD_ID + ".config.hotkeys";

    public static final ConfigOptionList OBSERVER_GUARD = new ConfigOptionList("observerGuardMode", GuardModeEntry.DIFF).apply(GENERIC);
    public static final ConfigBoolean HUD_ENABLED = new ConfigBoolean("hudEnabled", true).apply(GENERIC);
    public static final ConfigInteger HUD_MAX_LINES = new ConfigInteger("hudMaxLines", 6, 1, 20).apply(GENERIC);
    public static final ConfigInteger FILTER_COUNT = new ConfigInteger("filterCount", 18, 1, 64).apply(GENERIC);
    public static final ConfigInteger FILLER_COUNT = new ConfigInteger("fillerCount", 1, 1, 64).apply(GENERIC);
    public static final ConfigString FILLER_ITEM = new ConfigString("fillerItem", "").apply(GENERIC);
    public static final List<IConfigBase> OPTIONS = ImmutableList.of(OBSERVER_GUARD, HUD_ENABLED, HUD_MAX_LINES,
            FILTER_COUNT, FILLER_COUNT, FILLER_ITEM);

    public static final ConfigHotkey OPEN_CONFIG = new ConfigHotkey("openConfigGui", "LEFT_CONTROL,B").apply(HOTKEYS);
    public static final ConfigHotkey OPEN_BUILD_PLANS = new ConfigHotkey("openBuildPlans", "B").apply(HOTKEYS);
    public static final ConfigHotkey OPEN_SHARED_WAYPOINTS = new ConfigHotkey("openSharedWaypoints", "").apply(HOTKEYS);
    public static final ConfigHotkey CYCLE_OBSERVER_GUARD = new ConfigHotkey("cycleObserverGuard", "").apply(HOTKEYS);
    public static final List<IHotkey> HOTKEY_LIST = ImmutableList.of(OPEN_CONFIG, OPEN_BUILD_PLANS, OPEN_SHARED_WAYPOINTS, CYCLE_OBSERVER_GUARD);

    private static boolean pulling;

    static void hookCallbacks() {
        OBSERVER_GUARD.setValueChangeCallback(c -> {
            if (!pulling) ClientConfig.get().setGuardMode(((GuardModeEntry) c.getOptionListValue()).mode);
        });
        HUD_ENABLED.setValueChangeCallback(c -> {
            if (pulling) return;
            ClientConfig.get().hudEnabled = c.getBooleanValue();
            ClientConfig.save();
        });
        HUD_MAX_LINES.setValueChangeCallback(c -> {
            if (pulling) return;
            ClientConfig.get().hudMaxLines = c.getIntegerValue();
            ClientConfig.save();
        });
        FILTER_COUNT.setValueChangeCallback(c -> {
            if (pulling) return;
            ClientConfig.get().filterCount = c.getIntegerValue();
            ClientConfig.save();
        });
        FILLER_COUNT.setValueChangeCallback(c -> {
            if (pulling) return;
            ClientConfig.get().fillerCount = c.getIntegerValue();
            ClientConfig.save();
        });
        FILLER_ITEM.setValueChangeCallback(c -> {
            if (pulling) return;
            ClientConfig.get().fillerItem = c.getStringValue().strip();
            ClientConfig.save();
        });
        ClientConfig.onChange = MalilibConfigs::pull;
    }

    /** Copies the current ClientConfig values into the MaLiLib options. */
    public static void pull() {
        if (pulling) return;
        pulling = true;
        try {
            ClientConfig cfg = ClientConfig.get();
            OBSERVER_GUARD.setOptionListValue(GuardModeEntry.of(cfg.guardMode()));
            HUD_ENABLED.setBooleanValue(cfg.hudEnabled);
            HUD_MAX_LINES.setIntegerValue(cfg.hudMaxLines);
            FILTER_COUNT.setIntegerValue(cfg.filterCount);
            FILLER_COUNT.setIntegerValue(cfg.fillerCount);
            FILLER_ITEM.setValueFromString(cfg.fillerItem == null ? "" : cfg.fillerItem);
        } finally {
            pulling = false;
        }
    }

    @Override
    public void load() {
        Path file = FileUtils.getConfigDirectoryAsPath().resolve(FILE);
        if (Files.isReadable(file)) {
            JsonElement el = JsonUtils.parseJsonFileAsPath(file);
            if (el != null && el.isJsonObject()) ConfigUtils.readConfigBase(el.getAsJsonObject(), "Hotkeys", HOTKEY_LIST);
        }
        pull();
    }

    @Override
    public void save() {
        Path dir = FileUtils.getConfigDirectoryAsPath();
        try {
            Files.createDirectories(dir);
        } catch (Exception ignored) {
        }
        JsonObject root = new JsonObject();
        ConfigUtils.writeConfigBase(root, "Hotkeys", HOTKEY_LIST);
        JsonUtils.writeJsonToFileAsPath(root, dir.resolve(FILE));
    }
}
