package dev.kanety.network;

import com.velocitypowered.api.proxy.ProxyServer;
import com.velocitypowered.api.proxy.server.RegisteredServer;
import org.slf4j.Logger;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.nio.charset.Charset;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

/** Velocity から起動・停止する1つのバックエンド鯖（Fabric サーバーのプロセス）。 */
final class ManagedServer {

    private static final long PING_INTERVAL_SECONDS = 2;
    /** コマンドを送ってから、鯖の出力を Velocity のコンソールに表示し続けるミリ秒数。 */
    private static final long ECHO_MILLIS = 3000;
    /** 子プロセスの標準出力の文字コード（Windows 日本語環境なら MS932）。 */
    private static final Charset CONSOLE_CHARSET =
            Charset.forName(System.getProperty("native.encoding", "UTF-8"));

    private final String name;
    private final NetworkConfig.ServerEntry entry;
    private final Path directory;
    private final RegisteredServer server;
    private final ProxyServer proxy;
    private final Object plugin;
    private final Logger logger;

    private Process process;
    private volatile boolean ready;
    private CompletableFuture<Void> starting;
    private long emptySince = -1;
    private volatile long echoUntil;

    ManagedServer(String name, NetworkConfig.ServerEntry entry, Path directory, RegisteredServer server,
                  ProxyServer proxy, Object plugin, Logger logger) {
        this.name = name;
        this.entry = entry;
        this.directory = directory;
        this.server = server;
        this.proxy = proxy;
        this.plugin = plugin;
        this.logger = logger;
    }

    String name() {
        return name;
    }

    RegisteredServer server() {
        return server;
    }

    boolean adminOnly() {
        return entry.adminOnly;
    }

    synchronized boolean isRunning() {
        return process != null && process.isAlive();
    }

    /** プロセスが動いていて、プロキシから接続できることを確認済み。 */
    boolean isReady() {
        return ready && isRunning();
    }

    synchronized boolean isStarting() {
        return starting != null && !starting.isDone();
    }

    /** 鯖を起動し、接続できるようになったら完了する。起動中なら同じ処理を待つ。 */
    synchronized CompletableFuture<Void> start(int timeoutSeconds) {
        if (isStarting()) {
            return starting;
        }
        if (isReady()) {
            return CompletableFuture.completedFuture(null);
        }
        if (!isRunning()) {
            if (entry.command == null || entry.command.isEmpty() || !Files.isDirectory(directory)) {
                return CompletableFuture.failedFuture(
                        new IOException(name + " のフォルダまたは起動コマンドが見つかりません: " + directory));
            }
            try {
                Process started = new ProcessBuilder(entry.command)
                        .directory(directory.toFile())
                        .redirectErrorStream(true)
                        .start();
                process = started;
                startOutputReader(started);
                started.onExit().thenRun(() -> onExit(started));
                logger.info("{} を起動しました (pid {})", name, started.pid());
            } catch (IOException e) {
                return CompletableFuture.failedFuture(e);
            }
        }
        ready = false;
        emptySince = -1;
        starting = new CompletableFuture<>();
        long deadline = System.currentTimeMillis() + TimeUnit.SECONDS.toMillis(timeoutSeconds);
        schedulePing(starting, deadline);
        return starting;
    }

    /** 鯖の出力を読み捨てる。コマンドを送った直後だけ Velocity のコンソールに表示する。 */
    private void startOutputReader(Process started) {
        Thread reader = new Thread(() -> {
            try (BufferedReader in = new BufferedReader(
                    new InputStreamReader(started.getInputStream(), CONSOLE_CHARSET))) {
                String line;
                while ((line = in.readLine()) != null) {
                    if (System.currentTimeMillis() < echoUntil) {
                        logger.info("[{}] {}", name, line);
                    }
                }
            } catch (IOException ignored) {
                // プロセス終了時にストリームが閉じられる
            }
        }, "network-core-" + name + "-output");
        reader.setDaemon(true);
        reader.start();
    }

    /** 鯖のコンソールにコマンドを1行送る。動いていなければ false。 */
    synchronized boolean sendCommand(String command) {
        Process current = process;
        if (current == null || !current.isAlive()) {
            return false;
        }
        try {
            writeLine(current, command);
        } catch (IOException e) {
            logger.warn("{} にコマンドを送れませんでした", name, e);
            return false;
        }
        echoUntil = System.currentTimeMillis() + ECHO_MILLIS;
        return true;
    }

    private static void writeLine(Process target, String line) throws IOException {
        OutputStream stdin = target.getOutputStream();
        stdin.write((line + "\n").getBytes(CONSOLE_CHARSET));
        stdin.flush();
    }

    private void schedulePing(CompletableFuture<Void> future, long deadline) {
        proxy.getScheduler().buildTask(plugin, () -> server.ping().whenComplete((ping, error) -> {
            if (error == null) {
                ready = true;
                logger.info("{} に接続できるようになりました", name);
                future.complete(null);
            } else if (!isRunning()) {
                future.completeExceptionally(new IOException(name + " が起動中に終了しました"));
            } else if (System.currentTimeMillis() > deadline) {
                future.completeExceptionally(new IOException(name + " の起動がタイムアウトしました"));
            } else {
                schedulePing(future, deadline);
            }
        })).delay(PING_INTERVAL_SECONDS, TimeUnit.SECONDS).schedule();
    }

    /** コンソールに stop を送って保存・終了させる。時間内に終わらなければ強制終了する。 */
    synchronized CompletableFuture<Void> stop(int timeoutSeconds) {
        Process current = process;
        if (current == null || !current.isAlive()) {
            return CompletableFuture.completedFuture(null);
        }
        ready = false;
        logger.info("{} を停止します", name);
        try {
            writeLine(current, "stop");
        } catch (IOException e) {
            logger.warn("{} に stop を送れなかったため強制終了します", name, e);
            current.destroyForcibly();
        }
        return current.onExit()
                .orTimeout(timeoutSeconds, TimeUnit.SECONDS)
                .exceptionally(error -> {
                    logger.warn("{} が {} 秒以内に終了しなかったため強制終了します", name, timeoutSeconds);
                    current.destroyForcibly();
                    return current;
                })
                .thenApply(exited -> null);
    }

    /** 定期的に呼ばれ、無人が続いた自動停止対象の鯖を止める。 */
    synchronized void checkIdle(long now, long idleMillis, int stopTimeoutSeconds) {
        if (!entry.autoStop || !isReady()) {
            emptySince = -1;
            return;
        }
        if (!server.getPlayersConnected().isEmpty()) {
            emptySince = -1;
            return;
        }
        if (emptySince < 0) {
            emptySince = now;
        } else if (now - emptySince >= idleMillis) {
            logger.info("{} が無人のため停止します", name);
            emptySince = -1;
            stop(stopTimeoutSeconds);
        }
    }

    private synchronized void onExit(Process exited) {
        if (process == exited) {
            process = null;
            ready = false;
            logger.info("{} が終了しました (終了コード {})", name, exited.exitValue());
        }
    }
}
