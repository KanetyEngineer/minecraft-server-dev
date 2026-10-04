package dev.kanety.solaria.plan;

import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.nbt.ListTag;
import net.minecraft.nbt.NbtAccounter;
import net.minecraft.nbt.NbtIo;
import net.minecraft.nbt.NbtUtils;
import net.minecraft.world.level.block.Mirror;
import net.minecraft.world.level.block.Rotation;
import net.minecraft.world.level.block.state.BlockState;

import java.io.IOException;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Every non-air block of a placed .litematic, in world coordinates.
 * Placement math follows Litematica's SchematicPlacingUtils / PositionUtils.
 */
public final class Schematic {
    public final long[] positions;
    public final int[] states;
    public final int[] regions;
    public final List<BlockState> palette;
    public final List<String> regionNames;
    public final int minX, minY, minZ, maxX, maxY, maxZ;

    private Schematic(long[] positions, int[] states, int[] regions, List<BlockState> palette, List<String> regionNames) {
        this.positions = positions;
        this.states = states;
        this.regions = regions;
        this.palette = palette;
        this.regionNames = regionNames;
        int x0 = Integer.MAX_VALUE, y0 = Integer.MAX_VALUE, z0 = Integer.MAX_VALUE;
        int x1 = Integer.MIN_VALUE, y1 = Integer.MIN_VALUE, z1 = Integer.MIN_VALUE;
        for (long p : positions) {
            int x = BlockPos.getX(p), y = BlockPos.getY(p), z = BlockPos.getZ(p);
            x0 = Math.min(x0, x); y0 = Math.min(y0, y); z0 = Math.min(z0, z);
            x1 = Math.max(x1, x); y1 = Math.max(y1, y); z1 = Math.max(z1, z);
        }
        if (positions.length == 0) { x0 = y0 = z0 = x1 = y1 = z1 = 0; }
        minX = x0; minY = y0; minZ = z0; maxX = x1; maxY = y1; maxZ = z1;
    }

    public int size() {
        return positions.length;
    }

    public static Schematic load(Path file, SyncmaticaBridge.PlacementInfo placement) throws IOException {
        CompoundTag root = NbtIo.readCompressed(file, NbtAccounter.unlimitedHeap());
        CompoundTag regionsTag = root.getCompoundOrEmpty("Regions");

        List<BlockState> palette = new ArrayList<>();
        Map<BlockState, Integer> paletteIndex = new HashMap<>();
        List<String> regionNames = new ArrayList<>();
        LongList pos = new LongList();
        IntList st = new IntList();
        IntList rg = new IntList();

        Mirror mainMirror = placement.mirror();
        Rotation mainRot = placement.rotation();
        BlockPos origin = placement.origin();

        for (String name : regionsTag.keySet()) {
            CompoundTag r = regionsTag.getCompoundOrEmpty(name);
            CompoundTag pT = r.getCompoundOrEmpty("Position");
            CompoundTag sT = r.getCompoundOrEmpty("Size");
            int sx = sT.getIntOr("x", 0), sy = sT.getIntOr("y", 0), sz = sT.getIntOr("z", 0);
            int ax = Math.abs(sx), ay = Math.abs(sy), az = Math.abs(sz);
            if (ax == 0 || ay == 0 || az == 0) continue;

            BlockPos regionPos = new BlockPos(pT.getIntOr("x", 0), pT.getIntOr("y", 0), pT.getIntOr("z", 0));
            Mirror subMirror = Mirror.NONE;
            Rotation subRot = Rotation.NONE;
            SyncmaticaBridge.SubPlacement sub = placement.subRegions().get(name);
            if (sub != null) {
                regionPos = sub.pos();
                subMirror = sub.mirror();
                subRot = sub.rotation();
            }
            BlockPos regionOffset = transform(regionPos, mainMirror, mainRot).offset(origin);

            ListTag palTag = r.getListOrEmpty("BlockStatePalette");
            int[] localToGlobal = new int[Math.max(1, palTag.size())];
            boolean[] isAir = new boolean[localToGlobal.length];
            for (int i = 0; i < palTag.size(); i++) {
                BlockState state = NbtUtils.readBlockState(BuiltInRegistries.BLOCK, palTag.getCompoundOrEmpty(i));
                isAir[i] = state.isAir();
                Integer g = paletteIndex.get(state);
                if (g == null) {
                    g = palette.size();
                    palette.add(state);
                    paletteIndex.put(state, g);
                }
                localToGlobal[i] = g;
            }
            long[] data = r.getLongArray("BlockStates").orElse(new long[0]);
            int bits = Math.max(2, 32 - Integer.numberOfLeadingZeros(Math.max(1, palTag.size()) - 1));
            long mask = (1L << bits) - 1L;
            int regionIndex = regionNames.size();
            regionNames.add(name);

            int offX = sx < 0 ? sx + 1 : 0, offY = sy < 0 ? sy + 1 : 0, offZ = sz < 0 ? sz + 1 : 0;
            long total = (long) ax * ay * az;
            for (long index = 0; index < total; index++) {
                int v = get(data, index, bits, mask);
                if (v < 0 || v >= palTag.size() || isAir[v]) continue;
                int x = (int) (index % ax);
                int z = (int) ((index / ax) % az);
                int y = (int) (index / ((long) ax * az));
                BlockPos rel = new BlockPos(x + offX, y + offY, z + offZ);
                rel = transform(rel, mainMirror, mainRot);
                rel = transform(rel, subMirror, subRot);
                pos.add(rel.offset(regionOffset).asLong());
                st.add(localToGlobal[v]);
                rg.add(regionIndex);
            }
        }
        return new Schematic(pos.toArray(), st.toArray(), rg.toArray(), palette, regionNames);
    }

    /** Litematica's LitematicaBitArray#getAt (entries may span two longs). */
    private static int get(long[] data, long index, int bits, long mask) {
        long startOffset = index * bits;
        int startArr = (int) (startOffset >> 6);
        int endArr = (int) (((index + 1) * bits - 1) >> 6);
        int startBit = (int) (startOffset & 0x3F);
        if (endArr >= data.length) return -1;
        if (startArr == endArr) return (int) (data[startArr] >>> startBit & mask);
        int endOffset = 64 - startBit;
        return (int) ((data[startArr] >>> startBit | data[endArr] << endOffset) & mask);
    }

    /** Litematica's PositionUtils#getTransformedBlockPos. */
    static BlockPos transform(BlockPos pos, Mirror mirror, Rotation rotation) {
        int x = pos.getX(), y = pos.getY(), z = pos.getZ();
        switch (mirror) {
            case LEFT_RIGHT -> z = -z;
            case FRONT_BACK -> x = -x;
            default -> { }
        }
        return switch (rotation) {
            case CLOCKWISE_90 -> new BlockPos(-z, y, x);
            case COUNTERCLOCKWISE_90 -> new BlockPos(z, y, -x);
            case CLOCKWISE_180 -> new BlockPos(-x, y, -z);
            default -> new BlockPos(x, y, z);
        };
    }

    private static final class LongList {
        long[] a = new long[1024];
        int n;
        void add(long v) { if (n == a.length) a = java.util.Arrays.copyOf(a, n * 2); a[n++] = v; }
        long[] toArray() { return java.util.Arrays.copyOf(a, n); }
    }

    private static final class IntList {
        int[] a = new int[1024];
        int n;
        void add(int v) { if (n == a.length) a = java.util.Arrays.copyOf(a, n * 2); a[n++] = v; }
        int[] toArray() { return java.util.Arrays.copyOf(a, n); }
    }
}
