package dev.kanety.solaria.board;

import com.mojang.brigadier.CommandDispatcher;
import com.mojang.brigadier.arguments.IntegerArgumentType;
import com.mojang.brigadier.arguments.StringArgumentType;
import com.mojang.brigadier.context.CommandContext;
import com.mojang.brigadier.exceptions.CommandSyntaxException;
import com.mojang.brigadier.exceptions.SimpleCommandExceptionType;
import com.mojang.brigadier.suggestion.SuggestionProvider;
import com.mojang.brigadier.suggestion.Suggestions;
import com.mojang.brigadier.suggestion.SuggestionsBuilder;
import net.minecraft.ChatFormatting;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.commands.Commands;
import net.minecraft.commands.SharedSuggestionProvider;
import net.minecraft.core.Registry;
import net.minecraft.network.chat.Component;
import net.minecraft.resources.Identifier;
import net.minecraft.server.level.ServerPlayer;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;

/** /lb — choose what your own sidebar leaderboard shows. */
public final class LeaderboardCommand {
    private static final SimpleCommandExceptionType NOT_RUNNING = new SimpleCommandExceptionType(Component.literal("順位表はまだ準備中です"));
    private static final SimpleCommandExceptionType UNKNOWN = new SimpleCommandExceptionType(Component.literal("その項目はありません（/lb list で一覧）"));
    private static final SimpleCommandExceptionType NO_PLAYER = new SimpleCommandExceptionType(Component.literal("そのプレイヤーは見つかりません"));

    private static final SuggestionProvider<CommandSourceStack> CRITERIA = LeaderboardCommand::suggestCriteria;

    private LeaderboardCommand() {}

    public static void register(CommandDispatcher<CommandSourceStack> d) {
        d.register(Commands.literal("lb")
                .executes(LeaderboardCommand::help)
                .then(Commands.literal("list").executes(LeaderboardCommand::help))
                .then(Commands.literal("show")
                        .then(Commands.argument("criterion", StringArgumentType.greedyString()).suggests(CRITERIA).executes(LeaderboardCommand::show)))
                .then(Commands.literal("hide").executes(LeaderboardCommand::hide))
                .then(Commands.literal("top")
                        .then(Commands.argument("criterion", StringArgumentType.greedyString()).suggests(CRITERIA).executes(LeaderboardCommand::top)))
                .then(Commands.literal("default").requires(Commands.hasPermission(Commands.LEVEL_GAMEMASTERS))
                        .then(Commands.literal("off").executes(c -> setDefault(c, null)))
                        .then(Commands.argument("criterion", StringArgumentType.greedyString()).suggests(CRITERIA)
                                .executes(c -> setDefault(c, parse(StringArgumentType.getString(c, "criterion"))))))
                .then(Commands.literal("bot").requires(Commands.hasPermission(Commands.LEVEL_GAMEMASTERS))
                        .then(Commands.literal("list").executes(LeaderboardCommand::botList))
                        .then(Commands.literal("add").then(Commands.argument("name", StringArgumentType.word())
                                .suggests((c, b) -> SharedSuggestionProvider.suggest(board().knownNames(), b))
                                .executes(c -> bot(c, true))))
                        .then(Commands.literal("remove").then(Commands.argument("name", StringArgumentType.word())
                                .suggests((c, b) -> SharedSuggestionProvider.suggest(board().botNames(), b))
                                .executes(c -> bot(c, false))))));
    }

    private static Leaderboard board() {
        Leaderboard b = Leaderboard.get();
        if (b == null) throw new IllegalStateException("leaderboard not running");
        return b;
    }

    private static Leaderboard running() throws CommandSyntaxException {
        Leaderboard b = Leaderboard.get();
        if (b == null) throw NOT_RUNNING.create();
        return b;
    }

    private static Criterion parse(String raw) throws CommandSyntaxException {
        Criterion c = Criterion.parse(raw);
        if (c == null) throw UNKNOWN.create();
        return c;
    }

    private static CompletableFuture<Suggestions> suggestCriteria(CommandContext<CommandSourceStack> c, SuggestionsBuilder b) {
        String rest = b.getRemaining().toLowerCase(Locale.ROOT);
        int colon = rest.indexOf(':');
        if (colon < 0) {
            List<String> out = new ArrayList<>(Criterion.PRESETS.keySet());
            for (String t : Criterion.TYPES.keySet()) out.add(t + ":");
            return SharedSuggestionProvider.suggest(out, b);
        }
        String type = rest.substring(0, colon);
        Registry<?> registry = Criterion.registryOf(type);
        if (registry == null) return b.buildFuture();
        List<String> out = new ArrayList<>();
        out.add(type + ":all");
        for (Identifier id : registry.keySet()) {
            String s = type + ":" + (id.getNamespace().equals("minecraft") ? id.getPath() : id.toString());
            if (s.startsWith(rest)) out.add(s);
            if (out.size() > 300) break;
        }
        return SharedSuggestionProvider.suggest(out, b);
    }

    private static int help(CommandContext<CommandSourceStack> c) throws CommandSyntaxException {
        Leaderboard board = running();
        CommandSourceStack s = c.getSource();
        ServerPlayer p = s.getPlayer();
        Criterion cur = p == null ? null : board.chosen(p.getUUID());
        s.sendSuccess(() -> Component.literal("順位表（右側のサイドバー）  いま: " + (cur == null ? "非表示" : cur.label())).withStyle(ChatFormatting.GOLD), false);
        s.sendSuccess(() -> Component.literal("/lb show <項目> で表示、/lb hide で非表示、/lb top <項目> でチャットに全順位。表示は自分にだけ変わります。"), false);
        StringBuilder sb = new StringBuilder("項目: ");
        for (Criterion pr : Criterion.PRESETS.values()) sb.append(pr.key()).append("(").append(pr.label()).append(") ");
        String presets = sb.toString();
        s.sendSuccess(() -> Component.literal(presets).withStyle(ChatFormatting.GRAY), false);
        s.sendSuccess(() -> Component.literal("ほかに mined:diamond_ore、killed:zombie、used:all、custom:<統計> のように個別の統計も選べます。ボットは数えません。")
                .withStyle(ChatFormatting.GRAY), false);
        return 1;
    }

    private static int show(CommandContext<CommandSourceStack> c) throws CommandSyntaxException {
        Criterion criterion = parse(StringArgumentType.getString(c, "criterion"));
        running().choose(c.getSource().getPlayerOrException(), criterion);
        c.getSource().sendSuccess(() -> Component.literal("順位表を「" + criterion.label() + "」にしました"), false);
        return 1;
    }

    private static int hide(CommandContext<CommandSourceStack> c) throws CommandSyntaxException {
        running().choose(c.getSource().getPlayerOrException(), null);
        c.getSource().sendSuccess(() -> Component.literal("順位表を非表示にしました（/lb show <項目> で戻せます）"), false);
        return 1;
    }

    private static int top(CommandContext<CommandSourceStack> c) throws CommandSyntaxException {
        Criterion criterion = parse(StringArgumentType.getString(c, "criterion"));
        List<Leaderboard.Rank> ranks = running().ranking(criterion);
        CommandSourceStack s = c.getSource();
        s.sendSuccess(() -> Component.literal("★ " + criterion.label() + "（" + ranks.size() + "人）").withStyle(ChatFormatting.GOLD), false);
        for (int i = 0; i < ranks.size() && i < 50; i++) {
            Leaderboard.Rank r = ranks.get(i);
            int n = i + 1;
            s.sendSuccess(() -> Component.literal(n + ". " + r.name() + "  " + criterion.formatValue(r.value())), false);
        }
        return ranks.size();
    }

    private static int setDefault(CommandContext<CommandSourceStack> c, Criterion criterion) throws CommandSyntaxException {
        running().setDefault(criterion);
        c.getSource().sendSuccess(() -> Component.literal("まだ選んでいない人の順位表を「" + (criterion == null ? "非表示" : criterion.label()) + "」にしました"), true);
        return 1;
    }

    private static int botList(CommandContext<CommandSourceStack> c) throws CommandSyntaxException {
        List<String> bots = running().botNames();
        c.getSource().sendSuccess(() -> Component.literal("順位表から外しているボット: " + (bots.isEmpty() ? "なし" : String.join(", ", bots))
                + "\nCarpet の /player で出したボットは自動で外れます。"), false);
        return bots.size();
    }

    private static int bot(CommandContext<CommandSourceStack> c, boolean add) throws CommandSyntaxException {
        String name = StringArgumentType.getString(c, "name");
        UUID uuid = running().uuidOf(name);
        if (uuid == null) throw NO_PLAYER.create();
        running().setBot(uuid, add);
        c.getSource().sendSuccess(() -> Component.literal(name + (add ? " をボットとして順位表から外しました" : " を順位表に戻しました")), true);
        return 1;
    }
}
