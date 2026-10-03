package dev.kanety.network;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;

import java.io.IOException;
import java.io.InputStream;
import java.io.Reader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** plugins/network-core/config.json の内容。 */
final class NetworkConfig {

    private static final Gson GSON = new GsonBuilder().setPrettyPrinting().create();

    /** 無人になってから自動停止するまでの分数。 */
    int idleStopMinutes = 5;
    /** 起動してから接続可能になるまで待つ最大秒数。 */
    int startTimeoutSeconds = 180;
    /** stop を送ってから強制終了するまでの秒数。 */
    int stopTimeoutSeconds = 90;
    /** 管理者の UUID（ハイフンあり）。network.admin 権限を持つプレイヤーも管理者扱い。 */
    List<String> admins = new ArrayList<>();
    /** キーは velocity.toml の [servers] の名前と同じにする。 */
    Map<String, ServerEntry> servers = new LinkedHashMap<>();

    static final class ServerEntry {
        /** Velocity の作業ディレクトリから見た鯖のフォルダ。 */
        String directory;
        /** 鯖を起動するコマンド（例: java -Xmx2G -jar server.jar nogui）。 */
        List<String> command = new ArrayList<>();
        /** プロキシ起動時に一緒に起動する（lobby 用）。 */
        boolean startOnProxyStart;
        /** 無人が idleStopMinutes 続いたら停止する。 */
        boolean autoStop;
        /** 管理者だけが移動・起動できる（dev 用）。 */
        boolean adminOnly;
    }

    static NetworkConfig load(Path dataDirectory) throws IOException {
        Path file = dataDirectory.resolve("config.json");
        if (Files.notExists(file)) {
            Files.createDirectories(dataDirectory);
            try (InputStream in = NetworkConfig.class.getResourceAsStream("/config.json")) {
                if (in == null) {
                    throw new IOException("既定の config.json が jar に含まれていません");
                }
                Files.copy(in, file);
            }
        }
        try (Reader reader = Files.newBufferedReader(file, StandardCharsets.UTF_8)) {
            NetworkConfig config = GSON.fromJson(reader, NetworkConfig.class);
            if (config == null) {
                throw new IOException("config.json が空です");
            }
            return config;
        }
    }
}
