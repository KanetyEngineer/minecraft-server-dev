package dev.kanety.solariacarpet.mixin;

import dev.kanety.solariacarpet.PotionDupeRules;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.projectile.ProjectileUtil;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

@Mixin(ProjectileUtil.class)
public abstract class ProjectileUtilMixin {
    /** 1.21.1 always used a 0.3 entity hit margin; newer versions ramp it up from 0 over the first ticks. */
    @Inject(method = "computeMargin", at = @At("HEAD"), cancellable = true)
    private static void solariacarpet$legacyMargin(Entity entity, CallbackInfoReturnable<Float> cir) {
        if (PotionDupeRules.legacyPhysics(entity)) {
            cir.setReturnValue(0.3F);
        }
    }
}
