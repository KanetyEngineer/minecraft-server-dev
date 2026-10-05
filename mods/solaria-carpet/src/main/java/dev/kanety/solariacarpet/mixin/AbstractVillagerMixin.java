package dev.kanety.solariacarpet.mixin;

import dev.kanety.solariacarpet.SolariaCarpetSettings;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.npc.villager.AbstractVillager;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.level.portal.TeleportTransition;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.Redirect;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

/**
 * voidTrading: since 1.20.5 the trade screen closes as soon as the villager is unloaded or changes dimension
 * (stillValid checks isAlive() and the reach, and teleport() calls stopTrading()). With the rule on, a villager that
 * left through a portal or was unloaded keeps its trade screen open, so trades go to the copy that is no longer in
 * the world: they are never saved, do not lock, and special prices are not reset.
 */
@Mixin(AbstractVillager.class)
public abstract class AbstractVillagerMixin {
    @Inject(method = "stillValid", at = @At("HEAD"), cancellable = true)
    private void solariacarpet$voidTrading(Player player, CallbackInfoReturnable<Boolean> cir) {
        if (!SolariaCarpetSettings.voidTrading) return;
        AbstractVillager self = (AbstractVillager) (Object) this;
        Entity.RemovalReason reason = self.getRemovalReason();
        if (reason == null || reason == Entity.RemovalReason.KILLED || reason == Entity.RemovalReason.DISCARDED) return;
        if (self.getTradingPlayer() == player) cir.setReturnValue(true);
    }

    @Redirect(method = "teleport", at = @At(value = "INVOKE",
            target = "Lnet/minecraft/world/entity/npc/villager/AbstractVillager;stopTrading()V"))
    private void solariacarpet$keepTradingThroughPortal(AbstractVillager villager, TeleportTransition transition) {
        if (!SolariaCarpetSettings.voidTrading) ((AbstractVillagerAccessor) villager).solariacarpet$stopTrading();
    }
}
