package dev.kanety.solariacarpet.mixin;

import dev.kanety.solariacarpet.PotionDupeRules;
import net.minecraft.core.BlockPos;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.InsideBlockEffectApplier;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.HoneyBlock;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.Vec3;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(HoneyBlock.class)
public abstract class HoneyBlockMixin {
    /**
     * 1.21.2+ converts the velocity with living-entity gravity constants (getOldDeltaY/getNewDeltaY),
     * which makes potions slide about 3.5x faster. Use the raw 1.21.1 check for projectiles that
     * already run the 1.21.1 tick order.
     */
    @Inject(method = "entityInside", at = @At("HEAD"), cancellable = true)
    private void solariacarpet$legacySlide(BlockState state, Level level, BlockPos pos, Entity entity,
                                        InsideBlockEffectApplier applier, boolean intersects, CallbackInfo ci) {
        if (!PotionDupeRules.legacyPhysics(entity)) {
            return;
        }
        ci.cancel();
        if (entity.onGround() || entity.getY() > pos.getY() + 0.9375 - 1.0E-7) {
            return;
        }
        Vec3 movement = entity.getDeltaMovement();
        if (movement.y >= -0.08) {
            return;
        }
        double dx = Math.abs(pos.getX() + 0.5 - entity.getX());
        double dz = Math.abs(pos.getZ() + 0.5 - entity.getZ());
        double edge = 0.4375 + entity.getBbWidth() / 2.0F;
        if (dx + 1.0E-7 <= edge && dz + 1.0E-7 <= edge) {
            return;
        }
        if (movement.y < -0.13) {
            double scale = -0.05 / movement.y;
            entity.setDeltaMovement(new Vec3(movement.x * scale, -0.05, movement.z * scale));
        } else {
            entity.setDeltaMovement(new Vec3(movement.x, -0.05, movement.z));
        }
        entity.resetFallDistance();
    }
}
