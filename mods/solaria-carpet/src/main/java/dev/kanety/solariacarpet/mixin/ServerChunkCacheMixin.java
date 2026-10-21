package dev.kanety.solariacarpet.mixin;

import dev.kanety.solariacarpet.LightSuppression;
import net.minecraft.server.level.ServerChunkCache;
import net.minecraft.world.level.chunk.ChunkAccess;
import net.minecraft.world.level.chunk.status.ChunkStatus;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

/** Tells LightSuppression when the server thread may be blocked waiting for a chunk. */
@Mixin(ServerChunkCache.class)
public abstract class ServerChunkCacheMixin {
    @Inject(method = "getChunk(IILnet/minecraft/world/level/chunk/status/ChunkStatus;Z)Lnet/minecraft/world/level/chunk/ChunkAccess;",
            at = @At("HEAD"))
    private void solariacarpet$enter(int x, int z, ChunkStatus status, boolean load, CallbackInfoReturnable<ChunkAccess> cir) {
        LightSuppression.enterGetChunk();
    }

    @Inject(method = "getChunk(IILnet/minecraft/world/level/chunk/status/ChunkStatus;Z)Lnet/minecraft/world/level/chunk/ChunkAccess;",
            at = @At("RETURN"))
    private void solariacarpet$exit(int x, int z, ChunkStatus status, boolean load, CallbackInfoReturnable<ChunkAccess> cir) {
        LightSuppression.exitGetChunk();
    }
}
