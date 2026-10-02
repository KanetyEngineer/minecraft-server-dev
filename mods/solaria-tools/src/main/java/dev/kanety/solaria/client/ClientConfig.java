package dev.kanety.solaria.client;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import net.fabricmc.loader.api.FabricLoader;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

/** Per-player client settings (config/solariatools-client.json). */
public final class ClientConfig {
    private static final Gson GSON = new GsonBuilder().setPrettyPrinting().create();
    private static final Path FILE = FabricLoader.getInstance().getConfigDir().resolve("solariatools-client.json");

    public boolean hudEnabled = true;
    /** Project shown on the HUD; empty = every plan you take part in. */
    public String hudProject = "";
    public int hudMaxLines = 6;

    private static ClientConfig instance = new ClientConfig();

    public static ClientConfig get() {
        return instance;
    }

    public static void load() {
        try {
            if (Files.exists(FILE)) {
                ClientConfig c = GSON.fromJson(Files.readString(FILE, StandardCharsets.UTF_8), ClientConfig.class);
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
