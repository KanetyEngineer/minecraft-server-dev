package dev.kanety.solaria.client.malilib;

import dev.kanety.solaria.SolariaTweaks;
import dev.kanety.solaria.client.SolariaTweaksClient;
import fi.dy.masa.malilib.config.ConfigManager;
import fi.dy.masa.malilib.event.InitializationHandler;
import fi.dy.masa.malilib.event.InputEventHandler;
import fi.dy.masa.malilib.gui.GuiBase;
import fi.dy.masa.malilib.hotkeys.IHotkey;
import fi.dy.masa.malilib.hotkeys.IKeybindManager;
import fi.dy.masa.malilib.hotkeys.IKeybindProvider;
import fi.dy.masa.malilib.interfaces.IInitializationHandler;
import fi.dy.masa.malilib.registry.Registry;
import fi.dy.masa.malilib.util.data.ModInfo;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.screens.Screen;

/** Only loaded when MaLiLib is installed. */
public final class MalilibCompat {
    private MalilibCompat() {}

    public static void init() {
        InitializationHandler.getInstance().registerInitializationHandler(new IInitializationHandler() {
            @Override
            public void registerModHandlers() {
            ConfigManager.getInstance().registerConfigHandler(SolariaTweaks.MOD_ID, new MalilibConfigs());
            Registry.CONFIG_SCREEN.registerConfigScreenFactory(new ModInfo(SolariaTweaks.MOD_ID, "Solaria Tweaks", GuiConfigs::new));
            MalilibConfigs.hookCallbacks();
            InputEventHandler.getKeybindManager().registerKeybindProvider(new IKeybindProvider() {
                @Override
                public void addKeysToMap(IKeybindManager manager) {
                    for (IHotkey h : MalilibConfigs.HOTKEY_LIST) manager.addKeybindToMap(h.getKeybind());
                }

                @Override
                public void addHotkeys(IKeybindManager manager) {
                    manager.addHotkeysForCategory("Solaria Tweaks", "solariatweaks.hotkeys.category.hotkeys", MalilibConfigs.HOTKEY_LIST);
                }
            });
            MalilibConfigs.OPEN_CONFIG.getKeybind().setCallback((action, key) -> {
                GuiBase.openGui(new GuiConfigs());
                return true;
            });
            MalilibConfigs.OPEN_BUILD_PLANS.getKeybind().setCallback((action, key) -> SolariaTweaksClient.openBuildPlans(Minecraft.getInstance()));
            MalilibConfigs.OPEN_SHARED_WAYPOINTS.getKeybind().setCallback((action, key) -> SolariaTweaksClient.openSharedWaypoints(Minecraft.getInstance()));
            MalilibConfigs.CYCLE_OBSERVER_GUARD.getKeybind().setCallback((action, key) -> {
                SolariaTweaksClient.cycleObserverGuard(Minecraft.getInstance());
                return true;
            });
            }
        });
    }

    /** For Mod Menu. */
    public static Screen configScreen(Screen parent) {
        GuiConfigs gui = new GuiConfigs();
        gui.setParent(parent);
        return gui;
    }
}
