package dev.kanety.potiondupe;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import net.fabricmc.loader.api.FabricLoader;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.projectile.ThrowableProjectile;
import net.minecraft.world.entity.projectile.throwableitemprojectile.AbstractThrownPotion;
import net.minecraft.world.entity.projectile.throwableitemprojectile.ThrownEnderpearl;

import java.io.IOException;
import java.io.Reader;
import java.io.Writer;
import java.nio.file.Files;
import java.nio.file.Path;

/** Settings stored in config/potiondupe.json and changed with /potiondupe. */
public final class PotionDupeConfig {
    private static final Gson GSON = new GsonBuilder().setPrettyPrinting().create();
    private static final Path PATH = FabricLoader.getInstance().getConfigDir().resolve("potiondupe.json");

    /** Master switch. Off means fully vanilla 1.21.11. */
    public boolean enabled = true;
    /** "potions" = splash/lingering potions only, "all" = every thrown projectile except ender pearls. */
    public String scope = "potions";
    /** Let a projectile still hit in the tick it went through a portal (the duplication itself). */
    public boolean hitAfterPortal = true;
    /** 300 tick portal cooldown for projectiles, as in 1.21.1 (1.21.2+ uses 2). */
    public boolean legacyPortalCooldown = true;
    /** 1.21.1 tick order, honey block sliding and hit margin for projectiles. */
    public boolean legacyPhysics = true;

    private static PotionDupeConfig instance = new PotionDupeConfig();

    public static PotionDupeConfig get() {
        return instance;
    }

    public static void load() {
        if (Files.exists(PATH)) {
            try (Reader reader = Files.newBufferedReader(PATH)) {
                PotionDupeConfig loaded = GSON.fromJson(reader, PotionDupeConfig.class);
                if (loaded != null) {
                    instance = loaded;
                }
            } catch (IOException | RuntimeException e) {
                PotionDupe.LOGGER.error("Failed to read {}, using defaults", PATH, e);
            }
        }
        save();
    }

    public static void save() {
        try {
            Files.createDirectories(PATH.getParent());
            try (Writer writer = Files.newBufferedWriter(PATH)) {
                GSON.toJson(instance, writer);
            }
        } catch (IOException e) {
            PotionDupe.LOGGER.error("Failed to write {}", PATH, e);
        }
    }

    public boolean allScope() {
        return "all".equalsIgnoreCase(scope);
    }

    private static boolean inScope(Entity entity) {
        PotionDupeConfig c = instance;
        if (!c.enabled) {
            return false;
        }
        if (entity instanceof AbstractThrownPotion) {
            return true;
        }
        return c.allScope() && entity instanceof ThrowableProjectile && !(entity instanceof ThrownEnderpearl);
    }

    public static boolean hitAfterPortal(Entity entity) {
        return instance.hitAfterPortal && inScope(entity);
    }

    public static boolean legacyPortalCooldown(Entity entity) {
        return instance.legacyPortalCooldown && inScope(entity);
    }

    public static boolean legacyPhysics(Entity entity) {
        return instance.legacyPhysics && inScope(entity);
    }
}
