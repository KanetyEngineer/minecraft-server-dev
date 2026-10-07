package dev.kanety.solariacarpet.mixin;

import dev.kanety.solariacarpet.PotionDupeRules;
import net.minecraft.world.entity.projectile.Projectile;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

@Mixin(Projectile.class)
public abstract class ProjectileMixin {
    /** 1.21.1 used the generic 300 tick portal cooldown for projectiles; 1.21.2+ returns 2. */
    @Inject(method = "getDimensionChangingDelay", at = @At("HEAD"), cancellable = true)
    private void solariacarpet$legacyCooldown(CallbackInfoReturnable<Integer> cir) {
        if (PotionDupeRules.legacyPortalCooldown((Projectile) (Object) this)) {
            cir.setReturnValue(300);
        }
    }
}
