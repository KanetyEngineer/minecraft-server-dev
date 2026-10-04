package dev.kanety.solariacarpet;

import carpet.CarpetExtension;
import carpet.CarpetServer;
import carpet.utils.Translations;
import net.fabricmc.api.ModInitializer;
import net.minecraft.server.MinecraftServer;

import java.util.Map;

/** Carpet extension with the Solaria SMP rules (potion duplication, light suppression). */
public class SolariaCarpet implements ModInitializer, CarpetExtension {
    @Override
    public void onInitialize() {
        CarpetServer.manageExtension(this);
    }

    @Override
    public String version() {
        return "solaria-carpet";
    }

    @Override
    public void onGameStarted() {
        CarpetServer.settingsManager.parseSettingsClass(SolariaCarpetSettings.class);
    }

    @Override
    public void onTick(MinecraftServer server) {
        LightSuppression.onServerTick();
    }

    @Override
    public Map<String, String> canHasTranslations(String lang) {
        return Translations.getTranslationFromResourcePath("assets/solariacarpet/lang/%s.json".formatted(lang));
    }
}
