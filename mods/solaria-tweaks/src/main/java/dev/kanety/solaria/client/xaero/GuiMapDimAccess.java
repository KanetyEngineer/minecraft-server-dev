package dev.kanety.solaria.client.xaero;

import net.minecraft.resources.ResourceKey;
import net.minecraft.world.level.Level;

/** Implemented on Xaero's GuiMap by XaeroGuiMapMixin: the dimension the map was last right-clicked in. */
public interface GuiMapDimAccess {
    ResourceKey<Level> solariatweaks$rightClickDim();
}
