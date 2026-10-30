package dev.kanety.solaria.net;

import dev.kanety.solaria.SolariaTweaks;
import net.minecraft.network.RegistryFriendlyByteBuf;
import net.minecraft.network.codec.ByteBufCodecs;
import net.minecraft.network.codec.StreamCodec;
import net.minecraft.network.protocol.common.custom.CustomPacketPayload;

/** Server -> client: every shared waypoint as JSON (see SharedWaypoints#toJson). */
public record WaypointSyncPayload(String json) implements CustomPacketPayload {
    public static final Type<WaypointSyncPayload> TYPE = new Type<>(SolariaTweaks.id("waypoint_sync"));
    public static final StreamCodec<RegistryFriendlyByteBuf, WaypointSyncPayload> CODEC =
            StreamCodec.composite(ByteBufCodecs.stringUtf8(1 << 20), WaypointSyncPayload::json, WaypointSyncPayload::new);

    @Override
    public Type<? extends CustomPacketPayload> type() {
        return TYPE;
    }
}
