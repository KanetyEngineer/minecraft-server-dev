package dev.kanety.solaria.mixin.client;

import dev.kanety.solaria.client.xaero.GuiMapDimAccess;
import dev.kanety.solaria.client.xaero.MinimapBridge;
import dev.kanety.solaria.client.xaero.ShareMapWaypointOption;
import net.minecraft.client.Minecraft;
import net.minecraft.resources.ResourceKey;
import net.minecraft.world.level.Level;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;
import xaero.map.gui.IRightClickableElement;
import xaero.map.gui.dropdown.rightclick.RightClickOption;
import xaero.map.mods.gui.Waypoint;

import java.util.ArrayList;

/** Right-clicking a waypoint on Xaero's World Map: "share with the server" for your own, "remove" for a shared one. */
@Mixin(targets = "xaero.map.mods.gui.WaypointReader", remap = false)
public abstract class XaeroWaypointReaderMixin {
    @Inject(method = "getRightClickOptions(Lxaero/map/mods/gui/Waypoint;Lxaero/map/gui/IRightClickableElement;)Ljava/util/ArrayList;",
            at = @At("RETURN"), remap = false)
    private void solariatweaks$shareOption(Waypoint waypoint, IRightClickableElement target,
                                          CallbackInfoReturnable<ArrayList<RightClickOption>> cir) {
        ArrayList<RightClickOption> options = cir.getReturnValue();
        if (options == null || waypoint == null) return;
        if (waypoint.isThirdParty()) {
            int id = MinimapBridge.sharedIdOf(waypoint.getOriginal());
            if (id >= 0) options.add(ShareMapWaypointOption.remove(options.size(), target, id, waypoint.getName()));
            return;
        }
        if (waypoint.isTemporary()) return;
        Minecraft mc = Minecraft.getInstance();
        ResourceKey<Level> dimKey = target instanceof GuiMapDimAccess access ? access.solariatweaks$rightClickDim() : null;
        if (dimKey == null) dimKey = mc.level != null ? mc.level.dimension() : Level.OVERWORLD;
        int x = (int) Math.floor(waypoint.getRenderX());
        int z = (int) Math.floor(waypoint.getRenderZ());
        int y = waypoint.isyIncluded() ? waypoint.getY() : (mc.player != null ? mc.player.getBlockY() : 64);
        int color = MinimapBridge.colorOf(waypoint.getOriginal());
        options.add(ShareMapWaypointOption.share(options.size(), target, dimKey.identifier().toString(), x, y, z, waypoint.getName(), color));
    }
}
