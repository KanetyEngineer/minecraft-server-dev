package dev.kanety.solaria.client;

import net.fabricmc.loader.api.FabricLoader;
import net.minecraft.core.BlockPos;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.state.BlockState;

import java.lang.reflect.Method;

/** Reads Litematica's schematic world (the ghost blocks) by reflection, so Litematica stays optional. */
public final class LitematicaBridge {
    private static Method getSchematicWorld;
    private static boolean failed;

    private LitematicaBridge() {}

    /** The block the visible schematic wants at this position, or null if Litematica has nothing there. */
    public static BlockState expectedState(BlockPos pos) {
        if (failed || !FabricLoader.getInstance().isModLoaded("litematica")) return null;
        try {
            if (getSchematicWorld == null) {
                getSchematicWorld = Class.forName("fi.dy.masa.litematica.world.SchematicWorldHandler").getMethod("getSchematicWorld");
            }
            Object world = getSchematicWorld.invoke(null);
            if (!(world instanceof Level level)) return null;
            BlockState state = level.getBlockState(pos);
            return state.isAir() ? null : state;
        } catch (Throwable t) {
            failed = true;
            return null;
        }
    }
}
