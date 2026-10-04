package dev.kanety.solaria.potion.mixin;

import dev.kanety.solaria.potion.PotionDupeConfig;
import net.minecraft.world.entity.projectile.Projectile;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

@Mixin(Projectile.class)
public abstract class ProjectileMixin {
    /** 1.21.1 used the generic 300 tick portal cooldown for projectiles; 1.21.2+ returns 2. */
    @Inject(method = "getDimensionChangingDelay", at = @At("HEAD"), cancellable = true)
    private void potiondupe$legacyCooldown(CallbackInfoReturnable<Integer> cir) {
        if (PotionDupeConfig.legacyPortalCooldown((Projectile) (Object) this)) {
            cir.setReturnValue(300);
        }
    }
}
