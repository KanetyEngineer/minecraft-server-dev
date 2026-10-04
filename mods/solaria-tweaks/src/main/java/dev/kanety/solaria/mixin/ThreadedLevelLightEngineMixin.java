package dev.kanety.solaria.mixin;

import dev.kanety.solaria.light.LightSuppression;
import net.minecraft.server.level.ThreadedLevelLightEngine;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/** While light suppression is on, queued light tasks are left in the queue instead of being run. */
@Mixin(ThreadedLevelLightEngine.class)
public abstract class ThreadedLevelLightEngineMixin {
    @Inject(method = "runUpdate", at = @At("HEAD"), cancellable = true)
    private void solariatweaks$suppress(CallbackInfo ci) {
        if (LightSuppression.active()) ci.cancel();
    }
}
