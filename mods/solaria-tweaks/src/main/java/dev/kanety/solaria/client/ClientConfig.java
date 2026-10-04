package dev.kanety.solaria.client;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import net.fabricmc.loader.api.FabricLoader;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

/** Per-player client settings (config/solariatweaks-client.json). */
public final class ClientConfig {
    private static final Gson GSON = new GsonBuilder().setPrettyPrinting().create();
    private static final Path FILE = FabricLoader.getInstance().getConfigDir().resolve("solariatweaks-client.json");

    public boolean hudEnabled = true;
    /** Project shown on the HUD; empty = every plan you take part in. */
    public String hudProject = "";
    public int hudMaxLines = 6;
    /** Old on/off switch from Solaria Tools, only read to migrate to observerGuardMode. */
    public Boolean observerGuard;
    /** Warn before placing a block where an observer is looking: "off", "diff" (only blocks unlike the schematic) or "all". */
    public String observerGuardMode;

    public enum GuardMode {
        OFF("off", "OFF"), DIFF("diff", "設計図と違うものだけ"), ALL("all", "すべてのブロック");

        public final String id;
        public final String label;

        GuardMode(String id, String label) {
            this.id = id;
            this.label = label;
        }

        public GuardMode next() {
            return values()[(ordinal() + 1) % values().length];
        }

        public static GuardMode of(String id) {
            for (GuardMode m : values()) if (m.id.equalsIgnoreCase(id)) return m;
            return null;
        }
    }

    public GuardMode guardMode() {
        GuardMode m = GuardMode.of(observerGuardMode == null ? "" : observerGuardMode);
        return m != null ? m : GuardMode.DIFF;
    }

    public void setGuardMode(GuardMode mode) {
        observerGuardMode = mode.id;
        save();
    }

    /** Called after every save, so the MaLiLib config screen can pick up changes made elsewhere. */
    public static Runnable onChange = () -> {};

    private static ClientConfig instance = new ClientConfig();

    public static ClientConfig get() {
        return instance;
    }

    public static void load() {
        Path source = Files.exists(FILE) ? FILE : FILE.resolveSibling("solariatools-client.json");
        try {
            if (Files.exists(source)) {
                ClientConfig c = GSON.fromJson(Files.readString(source, StandardCharsets.UTF_8), ClientConfig.class);
                if (c != null) instance = c;
            }
        } catch (Exception ignored) {
        }
        if (instance.observerGuardMode == null) {
            instance.observerGuardMode = Boolean.FALSE.equals(instance.observerGuard) ? "off" : "diff";
        }
        instance.observerGuard = null;
    }

    public static void save() {
        try {
            Files.writeString(FILE, GSON.toJson(instance), StandardCharsets.UTF_8);
        } catch (Exception ignored) {
        }
        onChange.run();
    }
}
