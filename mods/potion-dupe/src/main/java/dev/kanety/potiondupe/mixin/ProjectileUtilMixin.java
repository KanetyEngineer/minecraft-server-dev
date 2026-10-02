package dev.kanety.potiondupe.mixin;

import dev.kanety.potiondupe.PotionDupeConfig;
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
    private static void potiondupe$legacyMargin(Entity entity, CallbackInfoReturnable<Float> cir) {
        if (PotionDupeConfig.legacyPhysics(entity)) {
            cir.setReturnValue(0.3F);
        }
    }
}
