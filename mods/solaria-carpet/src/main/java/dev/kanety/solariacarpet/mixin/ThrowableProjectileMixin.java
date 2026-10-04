package dev.kanety.solariacarpet.mixin;

import dev.kanety.solariacarpet.PotionDupeRules;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.EntityType;
import net.minecraft.world.entity.projectile.Projectile;
import net.minecraft.world.entity.projectile.ProjectileUtil;
import net.minecraft.world.entity.projectile.ThrowableProjectile;
import net.minecraft.world.level.Level;
import net.minecraft.world.phys.HitResult;
import net.minecraft.world.phys.Vec3;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.Redirect;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(ThrowableProjectile.class)
public abstract class ThrowableProjectileMixin extends Projectile {
    protected ThrowableProjectileMixin(EntityType<? extends Projectile> entityType, Level level) {
        super(entityType, level);
    }

    /**
     * 1.21.1 ThrowableProjectile#tick: portal handling first, then the hit check with no "still alive"
     * condition, then block effects at the pre-move position, then movement, drag and gravity.
     * A projectile that changes dimension in this tick therefore still hits (splashes) in the old
     * dimension while its copy carries on in the new one.
     */
    @Inject(method = "tick", at = @At("HEAD"), cancellable = true)
    private void solariacarpet$legacyTick(CallbackInfo ci) {
        if (!PotionDupeRules.legacyPhysics(this)) {
            return;
        }
        ci.cancel();
        super.tick();
        HitResult hitResult = ProjectileUtil.getHitResultOnMoveVector(this, this::canHitEntity);
        if (hitResult.getType() != HitResult.Type.MISS && solariacarpet$canHit()) {
            this.hitTargetOrDeflectSelf(hitResult);
        }

        this.applyEffectsFromBlocks();
        Vec3 movement = this.getDeltaMovement();
        double x = this.getX() + movement.x;
        double y = this.getY() + movement.y;
        double z = this.getZ() + movement.z;
        this.updateRotation();
        this.setDeltaMovement(movement.scale(this.isInWater() ? 0.8F : 0.99F));
        this.applyGravity();
        this.setPos(x, y, z);
    }

    private boolean solariacarpet$canHit() {
        return this.isAlive()
            || this.getRemovalReason() == Entity.RemovalReason.CHANGED_DIMENSION && PotionDupeRules.hitAfterPortal(this);
    }

    /** With legacyPhysics off, still let the projectile hit after it went through a portal this tick. */
    @Redirect(method = "tick", at = @At(value = "INVOKE",
        target = "Lnet/minecraft/world/entity/projectile/ThrowableProjectile;isAlive()Z"))
    private boolean solariacarpet$hitAfterPortal(ThrowableProjectile self) {
        return self.isAlive()
            || self.getRemovalReason() == Entity.RemovalReason.CHANGED_DIMENSION && PotionDupeRules.hitAfterPortal(self);
    }
}
