package dev.kanety.solaria.plan;

import ch.endte.syncmatica.Context;
import ch.endte.syncmatica.Syncmatica;
import ch.endte.syncmatica.data.ServerPlacement;
import ch.endte.syncmatica.extended_core.SubRegionData;
import ch.endte.syncmatica.extended_core.SubRegionPlacementModification;
import dev.kanety.solaria.SolariaTweaks;
import net.fabricmc.loader.api.FabricLoader;
import net.minecraft.core.BlockPos;
import net.minecraft.world.level.block.Mirror;
import net.minecraft.world.level.block.Rotation;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/** Reads the placements Syncmatica shares on this server. Only this class touches Syncmatica classes. */
public final class SyncmaticaBridge {
    private static boolean warned;

    public record SubPlacement(BlockPos pos, Rotation rotation, Mirror mirror) {}

    public record PlacementInfo(UUID id, String name, String dimension, BlockPos origin, Rotation rotation,
                                Mirror mirror, Map<String, SubPlacement> subRegions, Path file, String owner) {
        /** Changes whenever the placement is moved, rotated or its schematic is replaced. */
        public String signature() {
            return dimension + "|" + origin.asLong() + "|" + rotation + "|" + mirror + "|" + subRegions + "|" + file;
        }
    }

    private SyncmaticaBridge() {}

    public static boolean isLoaded() {
        return FabricLoader.getInstance().isModLoaded("syncmatica");
    }

    public static List<PlacementInfo> placements() {
        List<PlacementInfo> out = new ArrayList<>();
        if (!isLoaded()) return out;
        try {
            Context ctx = Syncmatica.getContext(Syncmatica.SERVER_CONTEXT);
            if (ctx == null || !ctx.isStarted()) return out;
            for (ServerPlacement p : ctx.getSyncmaticManager().getAll()) {
                Map<String, SubPlacement> subs = new HashMap<>();
                SubRegionData data = p.getSubRegionData();
                if (data != null && data.isModified()) {
                    for (Map.Entry<String, SubRegionPlacementModification> e : data.getModificationData().entrySet()) {
                        SubRegionPlacementModification m = e.getValue();
                        subs.put(e.getKey(), new SubPlacement(m.position, m.rotation, m.mirror));
                    }
                }
                Path file = null;
                try {
                    file = ctx.getFileStorage().getLocalLitematic(p);
                } catch (Throwable ignored) {
                }
                String owner = p.getOwner() != null ? p.getOwner().getName() : "?";
                out.add(new PlacementInfo(p.getId(), p.getName(), p.getDimension(), p.getPosition(),
                        p.getRotation(), p.getMirror(), subs, file, owner));
            }
        } catch (Throwable t) {
            if (!warned) {
                warned = true;
                SolariaTweaks.LOGGER.warn("Could not read Syncmatica placements", t);
            }
        }
        return out;
    }
}
