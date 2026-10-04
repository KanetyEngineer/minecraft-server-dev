package dev.kanety.solariacarpet;

import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.projectile.ThrowableProjectile;
import net.minecraft.world.entity.projectile.throwableitemprojectile.AbstractThrownPotion;
import net.minecraft.world.entity.projectile.throwableitemprojectile.ThrownEnderpearl;

/** Which projectiles get the 1.21.1 behavior, from the potionDupe* rules. */
public final class PotionDupeRules {
    private PotionDupeRules() {}

    private static boolean inScope(Entity entity) {
        if (!SolariaCarpetSettings.potionDupe) return false;
        if (entity instanceof AbstractThrownPotion) return true;
        return SolariaCarpetSettings.potionDupeScope == SolariaCarpetSettings.PotionDupeScope.ALL
                && entity instanceof ThrowableProjectile && !(entity instanceof ThrownEnderpearl);
    }

    public static boolean hitAfterPortal(Entity entity) {
        return SolariaCarpetSettings.potionDupeHitAfterPortal && inScope(entity);
    }

    public static boolean legacyPortalCooldown(Entity entity) {
        return SolariaCarpetSettings.potionDupeLegacyPortalCooldown && inScope(entity);
    }

    public static boolean legacyPhysics(Entity entity) {
        return SolariaCarpetSettings.potionDupeLegacyPhysics && inScope(entity);
    }
}
