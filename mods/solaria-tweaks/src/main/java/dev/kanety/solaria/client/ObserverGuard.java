package dev.kanety.solaria.client;

import net.minecraft.ChatFormatting;
import net.minecraft.client.Minecraft;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.client.resources.sounds.SimpleSoundInstance;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.network.chat.Component;
import net.minecraft.sounds.SoundEvents;
import net.minecraft.world.InteractionHand;
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
 * blocks that differ from the Litematica schematic, mode "all" stops every block. Called from
 * MultiPlayerGameModeMixin, so placements made by other mods (Litematica's Easy Place, Tweakeroo) are checked too.
 * The placement goes through only when the use key was released after the warning and pressed again within
 * 3 seconds, so holding the key (or Easy Place repeating) never slips past.
 */
public final class ObserverGuard {
    private static final long RETRY_MS = 3000;
    private static BlockPos lastPos;
    private static long lastTime;
    private static boolean released;

    private ObserverGuard() {}

    /** Client tick: remembers that the use key was let go after a warning. */
    public static void tick(Minecraft mc) {
        if (lastPos != null && !mc.options.keyUse.isDown()) released = true;
    }

    /** True when this placement must be cancelled. */
    public static boolean shouldBlock(LocalPlayer player, InteractionHand hand, BlockHitResult hit) {
        ClientConfig.GuardMode mode = ClientConfig.get().guardMode();
        if (mode == ClientConfig.GuardMode.OFF || player.isSpectator()) return false;
        ItemStack stack = player.getItemInHand(hand);
        if (!(stack.getItem() instanceof BlockItem blockItem)) return false;
        Level level = player.level();
        BlockPos target;
        try {
            BlockPlaceContext ctx = new BlockPlaceContext(player, hand, stack, hit);
            if (!ctx.canPlace()) return false;
            target = ctx.getClickedPos();
        } catch (RuntimeException e) {
            return false;
        }
        if (!watchedByObserver(level, target)) return false;
        BlockState expected = LitematicaBridge.expectedState(target);
        if (mode == ClientConfig.GuardMode.DIFF && (expected == null || expected.getBlock() == blockItem.getBlock())) {
            return false;
        }

        long now = System.currentTimeMillis();
        if (target.equals(lastPos) && now - lastTime < RETRY_MS) {
            if (released) {
                lastPos = null;
                return false;
            }
            return true; // still holding the key: keep blocking without repeating the warning
        }
        lastPos = target.immutable();
        lastTime = now;
        released = false;
        Component message;
        String retry = "（右クリックを離して3秒以内に押し直すと設置します）";
        if (expected == null) {
            message = Component.literal("⚠ オブザーバーの検知面の前です" + retry);
        } else if (expected.getBlock() == blockItem.getBlock()) {
            message = Component.literal("⚠ オブザーバーの検知面の前です。設計図どおり「").append(expected.getBlock().getName())
                    .append("」です" + retry);
        } else {
            message = Component.literal("⚠ オブザーバーの検知面の前です。設計図では「").append(expected.getBlock().getName())
                    .append("」です" + retry);
        }
        player.displayClientMessage(message.copy().withStyle(ChatFormatting.RED), true);
        Minecraft.getInstance().getSoundManager().play(SimpleSoundInstance.forUI(SoundEvents.NOTE_BLOCK_BASS.value(), 0.6f));
        return true;
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
