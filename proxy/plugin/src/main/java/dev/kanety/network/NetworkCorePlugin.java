package dev.kanety.network;

import com.google.inject.Inject;
import com.velocitypowered.api.command.CommandSource;
import com.velocitypowered.api.command.SimpleCommand;
import com.velocitypowered.api.event.Subscribe;
import com.velocitypowered.api.event.player.ServerPreConnectEvent;
import com.velocitypowered.api.event.proxy.ProxyInitializeEvent;
import com.velocitypowered.api.event.proxy.ProxyShutdownEvent;
import com.velocitypowered.api.plugin.Plugin;
import com.velocitypowered.api.plugin.annotation.DataDirectory;
import com.velocitypowered.api.proxy.Player;
import com.velocitypowered.api.proxy.ProxyServer;
import com.velocitypowered.api.proxy.server.RegisteredServer;
import net.kyori.adventure.text.Component;
import net.kyori.adventure.text.format.NamedTextColor;
import org.slf4j.Logger;

import java.io.IOException;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

@Plugin(
        id = "network-core",
        name = "NetworkCore",
        version = "0.1.0",
        description = "/[サーバー名] での移動と、鯖の自動起動・自動停止",
        authors = {"kanety"}
)
public final class NetworkCorePlugin {

    private static final String ADMIN_PERMISSION = "network.admin";

    private final ProxyServer proxy;
    private final Logger logger;
    private final Path dataDirectory;
    private final Map<String, ManagedServer> managed = new LinkedHashMap<>();
    private NetworkConfig config;

    @Inject
    public NetworkCorePlugin(ProxyServer proxy, Logger logger, @DataDirectory Path dataDirectory) {
        this.proxy = proxy;
        this.logger = logger;
        this.dataDirectory = dataDirectory;
    }

    @Subscribe
    public void onProxyInitialize(ProxyInitializeEvent event) {
        try {
            config = NetworkConfig.load(dataDirectory);
        } catch (IOException e) {
            logger.error("config.json を読み込めませんでした。NetworkCore は無効です", e);
            return;
        }

        Path workingDirectory = Path.of("").toAbsolutePath();
        for (Map.Entry<String, NetworkConfig.ServerEntry> entry : config.servers.entrySet()) {
            String name = entry.getKey();
            Optional<RegisteredServer> registered = proxy.getServer(name);
            if (registered.isEmpty()) {
                logger.warn("velocity.toml の [servers] に {} がないため無視します", name);
                continue;
            }
            Path directory = workingDirectory.resolve(entry.getValue().directory).normalize();
            ManagedServer server = new ManagedServer(name, entry.getValue(), directory, registered.get(),
                    proxy, this, logger);
            managed.put(name, server);
            proxy.getCommandManager().register(
                    proxy.getCommandManager().metaBuilder(name).plugin(this).build(),
                    new ServerCommand(server));
            if (entry.getValue().startOnProxyStart) {
                server.start(config.startTimeoutSeconds).exceptionally(error -> {
                    logger.error("{} を起動できませんでした", name, error);
                    return null;
                });
            }
        }

        proxy.getCommandManager().register(
                proxy.getCommandManager().metaBuilder("network").plugin(this).build(),
                new AdminCommand());

        long idleMillis = TimeUnit.MINUTES.toMillis(config.idleStopMinutes);
        proxy.getScheduler().buildTask(this, () -> {
            long now = System.currentTimeMillis();
            for (ManagedServer server : managed.values()) {
                server.checkIdle(now, idleMillis, config.stopTimeoutSeconds);
            }
        }).repeat(30, TimeUnit.SECONDS).schedule();
    }

    @Subscribe
    public void onProxyShutdown(ProxyShutdownEvent event) {
        List<CompletableFuture<Void>> stopping = new ArrayList<>();
        for (ManagedServer server : managed.values()) {
            stopping.add(server.stop(config.stopTimeoutSeconds));
        }
        try {
            CompletableFuture.allOf(stopping.toArray(CompletableFuture[]::new))
                    .get(config.stopTimeoutSeconds + 10L, TimeUnit.SECONDS);
        } catch (Exception e) {
            logger.warn("停止を待ちきれなかった鯖があります", e);
        }
    }

    /** /server や鯖のフォールバックで停止中の鯖に行こうとした場合も、起動してから送る。 */
    @Subscribe
    public void onServerPreConnect(ServerPreConnectEvent event) {
        RegisteredServer target = event.getResult().getServer().orElse(null);
        if (target == null) {
            return;
        }
        ManagedServer server = managed.get(target.getServerInfo().getName());
        if (server == null || server.isReady()) {
            return;
        }
        Player player = event.getPlayer();
        event.setResult(ServerPreConnectEvent.ServerResult.denied());
        if (player.getCurrentServer().isEmpty()) {
            // ログイン直後で行き先の鯖（通常は lobby）がまだ準備できていない
            player.disconnect(Component.text(
                    server.name() + " を起動中です。少し待ってから入り直してください。", NamedTextColor.YELLOW));
            if (!server.isStarting() && canUse(player, server)) {
                server.start(config.startTimeoutSeconds);
            }
            return;
        }
        if (!canUse(player, server)) {
            player.sendMessage(Component.text(server.name() + " には管理者だけが入れます。", NamedTextColor.RED));
            return;
        }
        sendTo(player, server);
    }

    private boolean isAdmin(CommandSource source) {
        if (source instanceof Player player) {
            return config.admins.contains(player.getUniqueId().toString())
                    || player.hasPermission(ADMIN_PERMISSION);
        }
        return true;
    }

    private boolean canUse(Player player, ManagedServer server) {
        return !server.adminOnly() || isAdmin(player);
    }

    private void sendTo(Player player, ManagedServer server) {
        boolean alreadyThere = player.getCurrentServer()
                .map(connection -> connection.getServerInfo().getName().equals(server.name()))
                .orElse(false);
        if (alreadyThere) {
            player.sendMessage(Component.text("すでに " + server.name() + " にいます。", NamedTextColor.GRAY));
            return;
        }
        if (server.isReady()) {
            player.createConnectionRequest(server.server()).fireAndForget();
            return;
        }
        player.sendMessage(Component.text(
                server.name() + " を起動しています。準備ができたら自動で移動します。", NamedTextColor.YELLOW));
        server.start(config.startTimeoutSeconds).whenComplete((ignored, error) -> {
            if (!player.isActive()) {
                return;
            }
            if (error != null) {
                logger.error("{} を起動できませんでした", server.name(), error);
                player.sendMessage(Component.text(
                        server.name() + " の起動に失敗しました。管理者に連絡してください。", NamedTextColor.RED));
                return;
            }
            player.createConnectionRequest(server.server()).fireAndForget();
        });
    }

    /** /lobby, /s1, /c1, /dev など。鯖ごとに1つ登録する。 */
    private final class ServerCommand implements SimpleCommand {

        private final ManagedServer server;

        private ServerCommand(ManagedServer server) {
            this.server = server;
        }

        @Override
        public void execute(Invocation invocation) {
            if (!(invocation.source() instanceof Player player)) {
                invocation.source().sendMessage(Component.text("このコマンドはプレイヤーだけが使えます。"));
                return;
            }
            sendTo(player, server);
        }

        @Override
        public boolean hasPermission(Invocation invocation) {
            return !(invocation.source() instanceof Player player) || canUse(player, server);
        }
    }

    /** /network start|stop|status [鯖名]（管理者用）。 */
    private final class AdminCommand implements SimpleCommand {

        @Override
        public void execute(Invocation invocation) {
            CommandSource source = invocation.source();
            String[] args = invocation.arguments();
            if (args.length == 0 || args[0].equals("status")) {
                for (ManagedServer server : managed.values()) {
                    String state = server.isReady() ? "稼働中"
                            : server.isStarting() ? "起動中"
                            : server.isRunning() ? "準備中" : "停止中";
                    source.sendMessage(Component.text(server.name() + ": " + state + " ("
                            + server.server().getPlayersConnected().size() + "人)"));
                }
                return;
            }
            if (args.length < 2 || !managed.containsKey(args[1])) {
                source.sendMessage(Component.text("使い方: /network <start|stop|status> <" +
                        String.join("|", managed.keySet()) + ">", NamedTextColor.RED));
                return;
            }
            ManagedServer server = managed.get(args[1]);
            switch (args[0]) {
                case "start" -> {
                    source.sendMessage(Component.text(server.name() + " を起動します。"));
                    server.start(config.startTimeoutSeconds).whenComplete((ignored, error) ->
                            source.sendMessage(error == null
                                    ? Component.text(server.name() + " が起動しました。", NamedTextColor.GREEN)
                                    : Component.text(server.name() + " の起動に失敗しました: "
                                            + error.getMessage(), NamedTextColor.RED)));
                }
                case "stop" -> {
                    source.sendMessage(Component.text(server.name() + " を停止します。"));
                    server.stop(config.stopTimeoutSeconds).thenRun(() ->
                            source.sendMessage(Component.text(server.name() + " を停止しました。",
                                    NamedTextColor.GREEN)));
                }
                default -> source.sendMessage(Component.text("使い方: /network <start|stop|status> <鯖名>",
                        NamedTextColor.RED));
            }
        }

        @Override
        public boolean hasPermission(Invocation invocation) {
            return isAdmin(invocation.source());
        }

        @Override
        public List<String> suggest(Invocation invocation) {
            String[] args = invocation.arguments();
            if (args.length <= 1) {
                return List.of("start", "stop", "status");
            }
            return new ArrayList<>(managed.keySet());
        }
    }
}
