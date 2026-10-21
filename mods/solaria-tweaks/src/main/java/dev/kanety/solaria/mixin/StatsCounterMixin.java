package dev.kanety.solaria.mixin;

import dev.kanety.solaria.board.Leaderboard;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.stats.Stat;
import net.minecraft.stats.StatsCounter;
import net.minecraft.world.entity.player.Player;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/** Pushes every statistic change of a server player to the leaderboard right away. */
@Mixin(StatsCounter.class)
public abstract class StatsCounterMixin {
    @Inject(method = "setValue", at = @At("TAIL"))
    private void solariatweaks$onSetValue(Player player, Stat<?> stat, int value, CallbackInfo ci) {
        if (player instanceof ServerPlayer serverPlayer) {
            Leaderboard board = Leaderboard.get();
            if (board != null) board.onStat(serverPlayer, stat, value);
        }
    }
}
