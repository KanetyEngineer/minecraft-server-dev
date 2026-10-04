package dev.kanety.solaria.client.xaero;

import dev.kanety.solaria.SolariaTweaks;
import dev.kanety.solaria.client.waypoint.ClientWaypoints;
import net.minecraft.client.Minecraft;
import net.minecraft.core.registries.Registries;
import net.minecraft.resources.Identifier;
import net.minecraft.resources.ResourceKey;
import net.minecraft.world.level.Level;
import xaero.common.minimap.waypoints.Waypoint;
import xaero.hud.minimap.BuiltInHudModules;
import xaero.hud.minimap.module.MinimapSession;
import xaero.hud.minimap.waypoint.WaypointColor;
import xaero.hud.minimap.waypoint.WaypointPurpose;
import xaero.hud.minimap.waypoint.set.WaypointSet;
import xaero.hud.minimap.waypoint.thirdparty.ThirdPartyWaypoints;
import xaero.hud.minimap.world.MinimapWorld;
import xaero.hud.minimap.world.container.MinimapWorldContainer;
import xaero.hud.minimap.world.container.MinimapWorldRootContainer;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Map;

/**
 * Shows the server's shared waypoints in Xaero's Minimap and World Map through Xaero's third-party waypoint support
 * (the same way it shows Waystones), so they appear on the map whatever waypoint set is selected and stay out of the
 * player's own waypoint files.
 */
final class MinimapAccess {
    static final Identifier ORIGIN = SolariaTweaks.id("shared");

    private static Object pushedRoot;
    private static int pushedVersion = -1;
    private static int ticks;
    private static boolean warned;
    private static final Map<Waypoint, Integer> ids = new IdentityHashMap<>();

    private MinimapAccess() {}

    static void failed(Throwable t) {
        if (!warned) {
            warned = true;
            SolariaTweaks.LOGGER.warn("Xaero's Minimap integration failed", t);
        }
    }

    private static MinimapSession session() {
        Object s = BuiltInHudModules.MINIMAP.getCurrentSession();
        return s instanceof MinimapSession ms ? ms : null;
    }

    static void tick() {
        if (++ticks % 20 != 0) return;
        MinimapSession session = session();
        if (session == null || Minecraft.getInstance().level == null) {
            pushedRoot = null;
            return;
        }
        MinimapWorldRootContainer root = session.getWorldManager().getAutoRootContainer();
        if (root == null) return;
        if (root == pushedRoot && pushedVersion == ClientWaypoints.version() && intact(session, root)) return;
        push(session, root);
    }

    private static MinimapWorldContainer container(MinimapSession session, MinimapWorldRootContainer root, String dim) {
        ResourceKey<Level> key = ResourceKey.create(Registries.DIMENSION, Identifier.parse(dim));
        String dir = session.getDimensionHelper().getDimensionDirectoryName(key);
        return root.addSubContainer(root.getPath().resolve(dir));
    }

    /** True when every dimension still holds what was pushed (Xaero may rebuild its containers). */
    private static boolean intact(MinimapSession session, MinimapWorldRootContainer root) {
        Map<String, Integer> expected = new HashMap<>();
        for (ClientWaypoints.Entry e : ClientWaypoints.entries()) expected.merge(e.dim(), 1, Integer::sum);
        for (Map.Entry<String, Integer> e : expected.entrySet()) {
            if (container(session, root, e.getKey()).getThirdPartyWaypointManager().get(ORIGIN).getCount() != e.getValue()) return false;
        }
        return true;
    }

    private static void push(MinimapSession session, MinimapWorldRootContainer root) {
        for (MinimapWorldContainer sub : root.getSubContainers()) sub.getThirdPartyWaypointManager().clearOrigin(ORIGIN);
        ids.clear();
        for (ClientWaypoints.Entry e : ClientWaypoints.entries()) {
            ThirdPartyWaypoints group = container(session, root, e.dim()).getThirdPartyWaypointManager().get(ORIGIN);
            String initials = e.initials() == null || e.initials().isBlank() ? "S" : e.initials();
            Waypoint w = new Waypoint(e.x(), e.y(), e.z(), e.name(), initials, WaypointColor.fromIndex(Math.floorMod(e.color(), 16)),
                    WaypointPurpose.NORMAL);
            group.add(Integer.toString(e.id()), w);
            ids.put(w, e.id());
        }
        pushedRoot = root;
        pushedVersion = ClientWaypoints.version();
    }

    static int colorOf(Object xaeroWaypoint) {
        return xaeroWaypoint instanceof Waypoint w ? w.getColor() : -1;
    }

    static int sharedIdOf(Object xaeroWaypoint) {
        Integer id = xaeroWaypoint instanceof Waypoint w ? ids.get(w) : null;
        return id == null ? -1 : id;
    }

    static List<MinimapBridge.LocalWaypoint> localWaypoints() {
        List<MinimapBridge.LocalWaypoint> out = new ArrayList<>();
        MinimapSession session = session();
        if (session == null) return out;
        MinimapWorld world = session.getWorldManager().getCurrentWorld();
        if (world == null) return out;
        Minecraft mc = Minecraft.getInstance();
        ResourceKey<Level> dimKey = world.getDimId() != null ? world.getDimId() : (mc.level != null ? mc.level.dimension() : Level.OVERWORLD);
        String dim = dimKey.identifier().toString();
        for (WaypointSet set : world.getIterableWaypointSets()) {
            for (Waypoint w : set.getWaypoints()) {
                if (w.isTemporary() || w.isThirdParty()) continue;
                out.add(new MinimapBridge.LocalWaypoint(set.getName(), w.getLocalizedName(), w.getInitials(), dim, w.getX(), w.getY(), w.getZ(), w.getColor()));
            }
        }
        return out;
    }

    /** The waypoints selected in Xaero's own waypoint list screen (GuiWaypoints), read reflectively. */
    @SuppressWarnings("unchecked")
    static List<MinimapBridge.LocalWaypoint> selectedIn(Object guiWaypoints) throws ReflectiveOperationException {
        Class<?> cls = guiWaypoints.getClass();
        java.lang.reflect.Method selected = cls.getDeclaredMethod("getSelectedWaypointsList");
        selected.setAccessible(true);
        java.lang.reflect.Field displayed = cls.getDeclaredField("displayedWorld");
        displayed.setAccessible(true);
        MinimapWorld world = (MinimapWorld) displayed.get(guiWaypoints);
        Minecraft mc = Minecraft.getInstance();
        ResourceKey<Level> dimKey = world != null && world.getDimId() != null ? world.getDimId()
                : (mc.level != null ? mc.level.dimension() : Level.OVERWORLD);
        String dim = dimKey.identifier().toString();
        List<MinimapBridge.LocalWaypoint> out = new ArrayList<>();
        for (Waypoint w : (List<Waypoint>) selected.invoke(guiWaypoints)) {
            if (w.isTemporary() || w.isThirdParty()) continue;
            out.add(new MinimapBridge.LocalWaypoint("", w.getLocalizedName(), w.getInitials(), dim, w.getX(), w.getY(), w.getZ(), w.getColor()));
        }
        return out;
    }
}
