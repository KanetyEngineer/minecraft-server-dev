package dev.kanety.solaria.mixin.client;

import dev.kanety.solaria.client.xaero.AddServerWaypointOption;
import dev.kanety.solaria.client.xaero.GuiMapDimAccess;
import net.minecraft.client.Minecraft;
import net.minecraft.resources.ResourceKey;
import net.minecraft.world.level.Level;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Shadow;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;
import xaero.map.gui.IRightClickableElement;
import xaero.map.gui.dropdown.rightclick.RightClickOption;

import java.util.ArrayList;

/** Adds "add as server waypoint" to the right-click menu of Xaero's World Map. */
@Mixin(targets = "xaero.map.gui.GuiMap", remap = false)
public abstract class XaeroGuiMapMixin implements GuiMapDimAccess {
    @Shadow(remap = false) private int rightClickX;
    @Shadow(remap = false) private int rightClickY;
    @Shadow(remap = false) private int rightClickZ;
    @Shadow(remap = false) private ResourceKey<Level> rightClickDim;

    @Override
    public ResourceKey<Level> solariatweaks$rightClickDim() {
        return rightClickDim;
    }

    @Inject(method = "getRightClickOptions", at = @At("RETURN"), remap = false)
    private void solariatweaks$addServerWaypointOption(CallbackInfoReturnable<ArrayList<RightClickOption>> cir) {
        ArrayList<RightClickOption> options = cir.getReturnValue();
        if (options == null) return;
        final int x = rightClickX, z = rightClickZ;
        int y = rightClickY;
        Minecraft mc = Minecraft.getInstance();
        if ((y == Integer.MAX_VALUE || y == Short.MAX_VALUE || y == -1) && mc.player != null) y = mc.player.getBlockY();
        final int fy = y;
        ResourceKey<Level> dimKey = rightClickDim != null ? rightClickDim : (mc.level != null ? mc.level.dimension() : Level.OVERWORLD);
        final String dim = dimKey.identifier().toString();
        options.add(new AddServerWaypointOption(options.size(), (IRightClickableElement) this, dim, x, fy, z));
    }
}
