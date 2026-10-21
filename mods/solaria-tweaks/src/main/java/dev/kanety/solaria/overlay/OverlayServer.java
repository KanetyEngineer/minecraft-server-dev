package dev.kanety.solaria.overlay;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import dev.kanety.solaria.SolariaTweaks;
import dev.kanety.solaria.board.Criterion;
import dev.kanety.solaria.board.Leaderboard;
import net.fabricmc.loader.api.FabricLoader;
import net.minecraft.server.MinecraftServer;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

/**
 * Small web server for OBS browser sources: /overlay shows a live counter (by default the server-wide blocks mined),
 * /api returns the numbers as JSON and / is a page that builds the overlay URL. Off until an OP turns it on with
 * /overlay on; the setting lives in config/solariatweaks-overlay.json. Read-only, it never changes the game.
 */
public final class OverlayServer {
    private static final Gson GSON = new GsonBuilder().setPrettyPrinting().disableHtmlEscaping().create();
    private static final Path FILE = FabricLoader.getInstance().getConfigDir().resolve("solariatweaks-overlay.json");

    public static final class Config {
        public boolean enabled = false;
        public String bind = "0.0.0.0";
        public int port = 8770;
        /** Address shown in /overlay url, e.g. "play.example.com:8770". Empty: the server's own address. */
        public String publicAddress = "";
    }

    private static Config config = new Config();
    private static HttpServer http;
    private static MinecraftServer server;

    private OverlayServer() {}

    public static Config config() {
        return config;
    }

    public static boolean running() {
        return http != null;
    }

    public static void start(MinecraftServer mc) {
        server = mc;
        load();
        if (config.enabled) open();
    }

    public static void stop() {
        close();
        server = null;
    }

    /** Opens the web server with the current config. Returns an error message, or null when it is running. */
    public static String open() {
        close();
        try {
            HttpServer s = HttpServer.create(new InetSocketAddress(config.bind, config.port), 0);
            s.createContext("/", OverlayServer::handle);
            s.setExecutor(Executors.newFixedThreadPool(2, r -> {
                Thread t = new Thread(r, "Solaria Overlay");
                t.setDaemon(true);
                return t;
            }));
            s.start();
            http = s;
            SolariaTweaks.LOGGER.info("Overlay web server on {}:{}", config.bind, config.port);
            return null;
        } catch (IOException | RuntimeException e) {
            SolariaTweaks.LOGGER.warn("Could not open the overlay web server on {}:{}", config.bind, config.port, e);
            return e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage();
        }
    }

    public static void close() {
        if (http != null) {
            http.stop(0);
            http = null;
        }
    }

    public static void load() {
        try {
            if (Files.exists(FILE)) {
                Config c = GSON.fromJson(Files.readString(FILE, StandardCharsets.UTF_8), Config.class);
                if (c != null) config = c;
            }
        } catch (IOException | RuntimeException e) {
            SolariaTweaks.LOGGER.warn("Could not read {}", FILE, e);
        }
        save();
    }

    public static void save() {
        try {
            Files.createDirectories(FILE.getParent());
            Files.writeString(FILE, GSON.toJson(config), StandardCharsets.UTF_8);
        } catch (IOException e) {
            SolariaTweaks.LOGGER.warn("Could not write {}", FILE, e);
        }
    }

    // ---------------------------------------------------------------- http

    private static void handle(HttpExchange ex) throws IOException {
        try {
            String path = ex.getRequestURI().getPath();
            Map<String, String> q = query(ex.getRequestURI().getRawQuery());
            switch (path) {
                case "/", "/index.html" -> send(ex, 200, "text/html", resource("index.html"));
                case "/overlay", "/overlay.html" -> send(ex, 200, "text/html", resource("overlay.html"));
                case "/api" -> {
                    String json = snapshot(q);
                    send(ex, json == null ? 503 : 200, "application/json", (json == null ? "{\"error\":\"starting\"}" : json).getBytes(StandardCharsets.UTF_8));
                }
                case "/api/criteria" -> send(ex, 200, "application/json", criteria().getBytes(StandardCharsets.UTF_8));
                default -> send(ex, 404, "text/plain", "not found".getBytes(StandardCharsets.UTF_8));
            }
        } finally {
            ex.close();
        }
    }

    private static void send(HttpExchange ex, int status, String type, byte[] body) throws IOException {
        ex.getResponseHeaders().set("Content-Type", type + "; charset=utf-8");
        ex.getResponseHeaders().set("Cache-Control", "no-store");
        ex.getResponseHeaders().set("Access-Control-Allow-Origin", "*");
        ex.sendResponseHeaders(status, body.length);
        try (OutputStream out = ex.getResponseBody()) {
            out.write(body);
        }
    }

    private static byte[] resource(String name) throws IOException {
        try (InputStream in = OverlayServer.class.getResourceAsStream("/solariatweaks-overlay/" + name)) {
            if (in == null) throw new IOException("missing " + name);
            return in.readAllBytes();
        }
    }

    private static Map<String, String> query(String raw) {
        Map<String, String> out = new HashMap<>();
        if (raw == null) return out;
        for (String part : raw.split("&")) {
            int eq = part.indexOf('=');
            String k = URLDecoder.decode(eq < 0 ? part : part.substring(0, eq), StandardCharsets.UTF_8);
            String v = eq < 0 ? "" : URLDecoder.decode(part.substring(eq + 1), StandardCharsets.UTF_8);
            out.put(k, v);
        }
        return out;
    }

    /** Reads the leaderboard on the server thread (its maps are not thread-safe). */
    private static String snapshot(Map<String, String> q) {
        MinecraftServer mc = server;
        if (mc == null) return null;
        try {
            return mc.submit(() -> build(q)).get(3, TimeUnit.SECONDS);
        } catch (Exception e) {
            return null;
        }
    }

    private static String build(Map<String, String> q) {
        Leaderboard board = Leaderboard.get();
        if (board == null) return null;
        Criterion c = Criterion.parse(q.getOrDefault("c", "mined"));
        if (c == null || c.isServer()) c = Criterion.PRESETS.get("mined");
        int top = 0;
        try {
            top = Math.max(0, Math.min(20, Integer.parseInt(q.getOrDefault("top", "0"))));
        } catch (NumberFormatException ignored) {
        }
        JsonObject o = new JsonObject();
        o.addProperty("key", c.key());
        o.addProperty("label", c.label());
        o.addProperty("format", c.format().name());
        long total = board.total(c);
        o.addProperty("total", total);
        o.addProperty("totalText", c.formatValue(total));
        o.addProperty("players", board.playerCount());
        String name = q.getOrDefault("player", "");
        if (!name.isBlank()) {
            UUID id = board.uuidOf(name);
            JsonObject p = new JsonObject();
            long v = id == null ? 0 : board.value(id, c);
            p.addProperty("name", id == null ? name : board.nameOf(id) == null ? name : board.nameOf(id));
            p.addProperty("found", id != null);
            p.addProperty("value", v);
            p.addProperty("text", c.formatValue(v));
            o.add("player", p);
        }
        JsonArray arr = new JsonArray();
        List<Leaderboard.Rank> ranks = board.ranking(c);
        for (int i = 0; i < ranks.size() && i < top; i++) {
            JsonObject r = new JsonObject();
            r.addProperty("rank", i + 1);
            r.addProperty("name", ranks.get(i).name());
            r.addProperty("value", ranks.get(i).value());
            r.addProperty("text", c.formatValue(ranks.get(i).value()));
            arr.add(r);
        }
        o.add("top", arr);
        o.addProperty("time", System.currentTimeMillis());
        return GSON.toJson(o);
    }

    private static String criteria() {
        JsonArray arr = new JsonArray();
        for (Criterion c : Criterion.PRESETS.values()) {
            JsonObject o = new JsonObject();
            o.addProperty("key", c.key());
            o.addProperty("label", c.label());
            arr.add(o);
        }
        return GSON.toJson(arr);
    }
}
