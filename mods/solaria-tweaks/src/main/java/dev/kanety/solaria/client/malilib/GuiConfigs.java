package dev.kanety.solaria.client.malilib;

import dev.kanety.solaria.SolariaTweaks;
import fi.dy.masa.malilib.gui.GuiConfigsBase;

import java.util.ArrayList;
import java.util.List;

/** MaLiLib config screen: settings first, then hotkeys. */
public class GuiConfigs extends GuiConfigsBase {
    public GuiConfigs() {
        super(10, 40, SolariaTweaks.MOD_ID, null, "solariatweaks.gui.title.configs");
        MalilibConfigs.pull();
    }

    @Override
    protected boolean useKeybindSearch() {
        return true;
    }

    @Override
    public List<ConfigOptionWrapper> getConfigs() {
        List<ConfigOptionWrapper> out = new ArrayList<>(ConfigOptionWrapper.createFor(MalilibConfigs.OPTIONS));
        out.addAll(ConfigOptionWrapper.createFor(MalilibConfigs.HOTKEY_LIST));
        return out;
    }
}
