package dev.kanety.solaria.mixin.client;

import dev.kanety.solaria.client.AutoSupply;
import dev.kanety.solaria.client.FilterFill;
import dev.kanety.solaria.client.ObserverGuard;
import net.minecraft.client.multiplayer.MultiPlayerGameMode;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.InteractionResult;
import net.minecraft.world.phys.BlockHitResult;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;
import net.minecraft.world.entity.player.Player;

/** Every block placement on the client, including Litematica's Easy Place, goes through useItemOn. */
@Mixin(MultiPlayerGameMode.class)
public abstract class MultiPlayerGameModeMixin {
    @Inject(method = "useItemOn", at = @At("HEAD"), cancellable = true, require = 1)
    private void solariatweaks$observerGuard(LocalPlayer player, InteractionHand hand, BlockHitResult hit,
                                             CallbackInfoReturnable<InteractionResult> cir) {
        if (ObserverGuard.shouldBlock(player, hand, hit)) {
            cir.setReturnValue(InteractionResult.FAIL);
            return;
        }
        FilterFill.lastUsedPos = hit.getBlockPos();
    }

    /** Auto eat keeps eating although the use key is not held (Minecraft#handleKeybinds releases it otherwise). */
    @Inject(method = "releaseUsingItem", at = @At("HEAD"), cancellable = true, require = 1)
    private void solariatweaks$keepEating(Player player, CallbackInfo ci) {
        if (AutoSupply.holdingUse()) ci.cancel();
    }
}
