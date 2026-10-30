package dev.kanety.solaria.plan;

import net.minecraft.world.item.Item;
import net.minecraft.world.item.Items;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.LiquidBlock;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.properties.BedPart;
import net.minecraft.world.level.block.state.properties.BlockStateProperties;
import net.minecraft.world.level.block.state.properties.DoubleBlockHalf;
import net.minecraft.world.level.block.state.properties.SlabType;

/** Which item (and how many) a placed block costs, roughly like Litematica's material list. */
public final class MaterialRules {
    public record Cost(Item item, int count) {}

    private MaterialRules() {}

    public static Cost costOf(BlockState state) {
        Block block = state.getBlock();
        if (state.isAir() || block instanceof LiquidBlock) return null;
        if (block == Blocks.PISTON_HEAD || block == Blocks.MOVING_PISTON || block == Blocks.FIRE
                || block == Blocks.SOUL_FIRE || block == Blocks.NETHER_PORTAL || block == Blocks.END_PORTAL
                || block == Blocks.END_GATEWAY || block == Blocks.BUBBLE_COLUMN) return null;
        if (state.hasProperty(BlockStateProperties.DOUBLE_BLOCK_HALF)
                && state.getValue(BlockStateProperties.DOUBLE_BLOCK_HALF) == DoubleBlockHalf.UPPER) return null;
        if (state.hasProperty(BlockStateProperties.BED_PART)
                && state.getValue(BlockStateProperties.BED_PART) == BedPart.HEAD) return null;

        if (block == Blocks.FARMLAND || block == Blocks.DIRT_PATH) return new Cost(Items.DIRT, 1);
        if (block == Blocks.WATER_CAULDRON || block == Blocks.LAVA_CAULDRON || block == Blocks.POWDER_SNOW_CAULDRON)
            return new Cost(Items.CAULDRON, 1);
        if (block == Blocks.REDSTONE_WIRE) return new Cost(Items.REDSTONE, 1);
        if (block == Blocks.TRIPWIRE) return new Cost(Items.STRING, 1);

        Item item = block.asItem();
        if (item == Items.AIR) return null;
        int count = 1;
        if (state.hasProperty(BlockStateProperties.SLAB_TYPE) && state.getValue(BlockStateProperties.SLAB_TYPE) == SlabType.DOUBLE) count = 2;
        else if (state.hasProperty(BlockStateProperties.CANDLES)) count = state.getValue(BlockStateProperties.CANDLES);
        else if (state.hasProperty(BlockStateProperties.PICKLES)) count = state.getValue(BlockStateProperties.PICKLES);
        else if (state.hasProperty(BlockStateProperties.EGGS)) count = state.getValue(BlockStateProperties.EGGS);
        else if (block == Blocks.SNOW && state.hasProperty(BlockStateProperties.LAYERS)) count = state.getValue(BlockStateProperties.LAYERS);
        else if (state.hasProperty(BlockStateProperties.FLOWER_AMOUNT)) count = state.getValue(BlockStateProperties.FLOWER_AMOUNT);
        return new Cost(item, count);
    }
}
