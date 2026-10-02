package dev.kanety.solaria.net;

import dev.kanety.solaria.SolariaTools;
import net.minecraft.network.RegistryFriendlyByteBuf;
import net.minecraft.network.codec.ByteBufCodecs;
import net.minecraft.network.codec.StreamCodec;
import net.minecraft.network.protocol.common.custom.CustomPacketPayload;

/** Server -> client: the whole build-plan state as JSON (see BuildManager#toJson). */
public record BuildSyncPayload(String json) implements CustomPacketPayload {
    public static final Type<BuildSyncPayload> TYPE = new Type<>(SolariaTools.id("build_sync"));
    public static final StreamCodec<RegistryFriendlyByteBuf, BuildSyncPayload> CODEC =
            StreamCodec.composite(ByteBufCodecs.stringUtf8(1 << 20), BuildSyncPayload::json, BuildSyncPayload::new);

    @Override
    public Type<? extends CustomPacketPayload> type() {
        return TYPE;
    }
}
