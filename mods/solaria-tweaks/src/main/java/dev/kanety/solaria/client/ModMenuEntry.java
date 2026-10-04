package dev.kanety.solaria.client;

import com.terraformersmc.modmenu.api.ConfigScreenFactory;
import com.terraformersmc.modmenu.api.ModMenuApi;
import net.fabricmc.loader.api.FabricLoader;

/** Mod Menu's config button opens the MaLiLib screen (only when MaLiLib is installed). */
public class ModMenuEntry implements ModMenuApi {
    @Override
    public ConfigScreenFactory<?> getModConfigScreenFactory() {
        if (!FabricLoader.getInstance().isModLoaded("malilib")) return parent -> null;
        return parent -> dev.kanety.solaria.client.malilib.MalilibCompat.configScreen(parent);
    }
}
