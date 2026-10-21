package dev.kanety.buildplan.client;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import net.fabricmc.loader.api.FabricLoader;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

/** Per-player client settings (config/sharedbuildplan-client.json). */
public final class ClientConfig {
    private static final Gson GSON = new GsonBuilder().setPrettyPrinting().create();
    private static final Path FILE = FabricLoader.getInstance().getConfigDir().resolve("sharedbuildplan-client.json");

    public boolean hudEnabled = true;
    /** Project shown on the HUD; empty = every plan you take part in. */
    public String hudProject = "";
    public int hudMaxLines = 6;

    private static ClientConfig instance = new ClientConfig();

    public static ClientConfig get() {
        return instance;
    }

    public static void load() {
        // The HUD settings of Solaria Tweaks carry over (unknown fields are ignored).
        Path source = Files.exists(FILE) ? FILE : FILE.resolveSibling("solariatweaks-client.json");
        try {
            if (Files.exists(source)) {
                ClientConfig c = GSON.fromJson(Files.readString(source, StandardCharsets.UTF_8), ClientConfig.class);
                if (c != null) instance = c;
            }
        } catch (Exception ignored) {
        }
    }

    public static void save() {
        try {
            Files.writeString(FILE, GSON.toJson(instance), StandardCharsets.UTF_8);
        } catch (Exception ignored) {
        }
    }
}
