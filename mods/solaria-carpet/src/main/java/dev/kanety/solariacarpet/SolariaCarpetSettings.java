package dev.kanety.solariacarpet;

import carpet.api.settings.Rule;
import carpet.api.settings.RuleCategory;
import carpet.api.settings.Validators;

/** Carpet rules of Solaria Carpet. Change them with /carpet <rule> <value>, keep them with /carpet setDefault. */
public final class SolariaCarpetSettings {
    public static final String SOLARIA = "solaria";

    private SolariaCarpetSettings() {}

    public enum PotionDupeScope { POTIONS, ALL }

    @Rule(categories = {SOLARIA, RuleCategory.SURVIVAL, RuleCategory.EXPERIMENTAL})
    public static boolean potionDupe = false;

    @Rule(categories = {SOLARIA, RuleCategory.SURVIVAL})
    public static PotionDupeScope potionDupeScope = PotionDupeScope.POTIONS;

    @Rule(categories = {SOLARIA, RuleCategory.SURVIVAL})
    public static boolean potionDupeHitAfterPortal = true;

    @Rule(categories = {SOLARIA, RuleCategory.SURVIVAL})
    public static boolean potionDupeLegacyPortalCooldown = true;

    @Rule(categories = {SOLARIA, RuleCategory.SURVIVAL})
    public static boolean potionDupeLegacyPhysics = true;

    @Rule(categories = {SOLARIA, RuleCategory.SURVIVAL, RuleCategory.EXPERIMENTAL})
    public static boolean lightSuppression = false;

    @Rule(categories = {SOLARIA, RuleCategory.EXPERIMENTAL}, options = {"1000", "2000", "5000", "10000"}, strict = false,
            validators = Validators.NonNegativeNumber.class)
    public static int lightSuppressionTasksPerTick = 2000;

    @Rule(categories = {SOLARIA, RuleCategory.EXPERIMENTAL}, options = {"100000", "300000", "500000"}, strict = false,
            validators = Validators.NonNegativeNumber.class)
    public static int lightSuppressionMaxQueue = 300000;

    @Rule(categories = {SOLARIA, RuleCategory.EXPERIMENTAL}, options = {"1", "5", "10", "20"}, strict = false,
            validators = Validators.NonNegativeNumber.class)
    public static int lightSuppressionSlowdown = 10;

    @Rule(categories = {SOLARIA, RuleCategory.SURVIVAL, RuleCategory.FEATURE})
    public static boolean voidTrading = false;
}
