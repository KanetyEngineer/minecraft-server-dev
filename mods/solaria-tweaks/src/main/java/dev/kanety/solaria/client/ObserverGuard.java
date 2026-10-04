package dev.kanety.solaria.client;

import net.fabricmc.fabric.api.event.player.UseBlockCallback;
import net.minecraft.ChatFormatting;
import net.minecraft.client.Minecraft;
import net.minecraft.client.resources.sounds.SimpleSoundInstance;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.network.chat.Component;
import net.minecraft.sounds.SoundEvents;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.InteractionResult;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.item.BlockItem;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.context.BlockPlaceContext;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.ObserverBlock;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.BlockHitResult;

/**
 * Stops placing a block where an observer is looking (a block there fires the observer). Mode "diff" only stops
 * blocks that differ from the Litematica schematic, mode "all" stops every block. Placing again within 3 seconds
 * goes through.
 */
public final class ObserverGuard {
    private static BlockPos lastPos;
    private static long lastTime;

    private ObserverGuard() {}

    public static void register() {
        UseBlockCallback.EVENT.register(ObserverGuard::onUse);
    }

    private static InteractionResult onUse(Player player, Level level, InteractionHand hand, BlockHitResult hit) {
        ClientConfig.GuardMode mode = ClientConfig.get().guardMode();
        if (!level.isClientSide() || mode == ClientConfig.GuardMode.OFF || player.isSpectator()) return InteractionResult.PASS;
        ItemStack stack = player.getItemInHand(hand);
        if (!(stack.getItem() instanceof BlockItem blockItem)) return InteractionResult.PASS;
        BlockPlaceContext ctx = new BlockPlaceContext(player, hand, stack, hit);
        if (!ctx.canPlace()) return InteractionResult.PASS;
        BlockPos target = ctx.getClickedPos();
        if (!watchedByObserver(level, target)) return InteractionResult.PASS;
        BlockState expected = LitematicaBridge.expectedState(target);
        if (mode == ClientConfig.GuardMode.DIFF && (expected == null || expected.getBlock() == blockItem.getBlock())) {
            return InteractionResult.PASS;
        }

        long now = System.currentTimeMillis();
        if (target.equals(lastPos) && now - lastTime < 3000) {
            lastPos = null;
            return InteractionResult.PASS;
        }
        lastPos = target.immutable();
        lastTime = now;
        Component message;
        if (expected == null) {
            message = Component.literal("⚠ オブザーバーの前です（3秒以内にもう一度で設置）");
        } else if (expected.getBlock() == blockItem.getBlock()) {
            message = Component.literal("⚠ オブザーバーの前です。設計図どおりの「").append(expected.getBlock().getName())
                    .append("」です（3秒以内にもう一度で設置）");
        } else {
            message = Component.literal("⚠ オブザーバーの前です。設計図は「").append(expected.getBlock().getName())
                    .append("」です（3秒以内にもう一度で設置）");
        }
        player.displayClientMessage(message.copy().withStyle(ChatFormatting.RED), true);
        Minecraft.getInstance().getSoundManager().play(SimpleSoundInstance.forUI(SoundEvents.NOTE_BLOCK_BASS.value(), 0.6f));
        return InteractionResult.FAIL;
    }

    /** True when an observer next to pos has its face (detection side) pointed at pos. */
    static boolean watchedByObserver(Level level, BlockPos pos) {
        for (Direction d : Direction.values()) {
            BlockState s = level.getBlockState(pos.relative(d));
            if (s.is(Blocks.OBSERVER) && s.getValue(ObserverBlock.FACING) == d.getOpposite()) return true;
        }
        return false;
    }
}
