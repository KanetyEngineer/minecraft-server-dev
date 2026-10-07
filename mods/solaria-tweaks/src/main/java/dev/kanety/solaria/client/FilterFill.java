package dev.kanety.solaria.client;

import com.google.gson.JsonElement;
import com.mojang.serialization.JsonOps;
import net.fabricmc.fabric.api.client.screen.v1.Screens;
import net.minecraft.ChatFormatting;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.components.Button;
import net.minecraft.client.gui.components.Tooltip;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.client.gui.screens.inventory.AbstractContainerScreen;
import net.minecraft.client.gui.screens.inventory.CreativeModeInventoryScreen;
import net.minecraft.client.gui.screens.inventory.InventoryScreen;
import net.minecraft.core.BlockPos;
import net.minecraft.core.component.DataComponents;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.network.chat.Component;
import net.minecraft.resources.Identifier;
import net.minecraft.resources.RegistryOps;
import net.minecraft.world.Container;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.inventory.AbstractContainerMenu;
import net.minecraft.world.inventory.ClickType;
import net.minecraft.world.inventory.Slot;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.entity.BlockEntity;

import java.util.ArrayList;
import java.util.List;
import java.util.function.Predicate;

/**
 * Fills a container (usually a hopper for an item sorter) from your inventory with a few clicks:
 * a remembered layout, the layout in the Litematica schematic, or a sorter filter (the item in your hand × N in the
 * first slot and filler items in the rest). Only empty slots or slots that already hold the right item are filled.
 */
public final class FilterFill {
    /** Block the player last right-clicked, i.e. the container that is open now. Set from MultiPlayerGameModeMixin. */
    public static volatile BlockPos lastUsedPos;

    private FilterFill() {}

    public static void onScreenInit(Minecraft client, Screen screen, int width, int height) {
        if (!(screen instanceof AbstractContainerScreen<?> cs) || screen instanceof InventoryScreen
                || screen instanceof CreativeModeInventoryScreen) return;
        List<Slot> target = containerSlots(cs.getMenu());
        if (target.isEmpty() || target.size() > 27) return;
        int x = Math.min(width / 2 + 92, width - 122);
        int y = height / 2 - 64;
        List<Button> buttons = new ArrayList<>();
        if (target.size() == 5) {
            buttons.add(Button.builder(Component.literal("フィルターを詰める"), b -> fillFilter(client, cs))
                    .tooltip(Tooltip.create(Component.literal("仕分け機のフィルター用に、1枠目へ手に持っているアイテムを "
                            + ClientConfig.get().filterCount + " 個、残りの枠へ埋め物を " + ClientConfig.get().fillerCount
                            + " 個ずつ入れます。\n埋め物: " + fillerLabel() + "\n個数と埋め物は設定で変えられます。")))
                    .bounds(x, y, 120, 18).build());
        }
        buttons.add(Button.builder(Component.literal("覚えた配置で詰める"), b -> fillTemplate(client, cs))
                .tooltip(Tooltip.create(Component.literal("「この配置を覚える」で覚えた中身と同じになるように、手持ちから詰めます。")))
                .bounds(x, y, 120, 18).build());
        buttons.add(Button.builder(Component.literal("この配置を覚える"), b -> remember(client, cs))
                .tooltip(Tooltip.create(Component.literal("いま開いている容器の中身（アイテム・個数・名前）を覚えます。")))
                .bounds(x, y, 120, 18).build());
        if (LitematicaBridge.available()) {
            buttons.add(Button.builder(Component.literal("設計図どおりに詰める"), b -> fillSchematic(client, cs))
                    .tooltip(Tooltip.create(Component.literal("Litematica の設計図でこの容器に入っているアイテムを、手持ちから詰めます。")))
                    .bounds(x, y, 120, 18).build());
        }
        for (int i = 0; i < buttons.size(); i++) {
            Button b = buttons.get(i);
            b.setY(y + i * 20);
            Screens.getButtons(screen).add(b);
        }
    }

    // ---------------------------------------------------------------- actions

    private static void fillFilter(Minecraft client, AbstractContainerScreen<?> cs) {
        if (client.player == null) return;
        ItemStack held = client.player.getMainHandItem();
        if (held.isEmpty()) {
            message(client, "フィルターにするアイテムを手に持ってから開いてください", true);
            return;
        }
        ItemStack filter = held.copy();
        List<Slot> slots = containerSlots(cs.getMenu());
        ClientConfig cfg = ClientConfig.get();
        List<String> problems = new ArrayList<>();
        place(client, cs.getMenu(), slots.get(0), s -> ItemStack.isSameItemSameComponents(s, filter), cfg.filterCount, problems);
        Predicate<ItemStack> filler = fillerMatcher(filter);
        for (int i = 1; i < slots.size(); i++) place(client, cs.getMenu(), slots.get(i), filler, cfg.fillerCount, problems);
        report(client, problems);
    }

    private static void remember(Minecraft client, AbstractContainerScreen<?> cs) {
        if (client.level == null) return;
        RegistryOps<JsonElement> ops = RegistryOps.create(JsonOps.INSTANCE, client.level.registryAccess());
        List<JsonElement> out = new ArrayList<>();
        int count = 0;
        for (Slot slot : containerSlots(cs.getMenu())) {
            out.add(ItemStack.OPTIONAL_CODEC.encodeStart(ops, slot.getItem()).result().orElse(null));
            if (slot.hasItem()) count++;
        }
        ClientConfig.get().fillTemplate = out;
        ClientConfig.save();
        message(client, "配置を覚えました（" + out.size() + " 枠中 " + count + " 枠）", false);
    }

    private static void fillTemplate(Minecraft client, AbstractContainerScreen<?> cs) {
        List<JsonElement> saved = ClientConfig.get().fillTemplate;
        if (client.level == null || saved == null || saved.isEmpty()) {
            message(client, "まだ配置を覚えていません。お手本の容器を開いて「この配置を覚える」を押してください", true);
            return;
        }
        RegistryOps<JsonElement> ops = RegistryOps.create(JsonOps.INSTANCE, client.level.registryAccess());
        List<ItemStack> layout = new ArrayList<>();
        for (JsonElement el : saved) {
            layout.add(el == null ? ItemStack.EMPTY : ItemStack.OPTIONAL_CODEC.parse(ops, el).result().orElse(ItemStack.EMPTY));
        }
        fillLayout(client, cs, layout);
    }

    private static void fillSchematic(Minecraft client, AbstractContainerScreen<?> cs) {
        BlockPos pos = lastUsedPos;
        Level world = LitematicaBridge.schematicWorld();
        BlockEntity be = pos == null || world == null ? null : world.getBlockEntity(pos);
        if (!(be instanceof Container container) || container.isEmpty()) {
            message(client, "設計図のこの場所に、中身の入った容器がありません", true);
            return;
        }
        List<ItemStack> layout = new ArrayList<>();
        for (int i = 0; i < container.getContainerSize(); i++) layout.add(container.getItem(i).copy());
        fillLayout(client, cs, layout);
    }

    private static void fillLayout(Minecraft client, AbstractContainerScreen<?> cs, List<ItemStack> layout) {
        List<Slot> slots = containerSlots(cs.getMenu());
        List<String> problems = new ArrayList<>();
        for (int i = 0; i < slots.size() && i < layout.size(); i++) {
            ItemStack want = layout.get(i);
            if (want.isEmpty()) continue;
            place(client, cs.getMenu(), slots.get(i), s -> ItemStack.isSameItemSameComponents(s, want), want.getCount(), problems);
        }
        report(client, problems);
    }

    // ---------------------------------------------------------------- clicking

    /** Moves items matching `match` from the player's inventory into `target` until it holds `count`. */
    private static void place(Minecraft client, AbstractContainerMenu menu, Slot target, Predicate<ItemStack> match, int count,
                              List<String> problems) {
        if (client.gameMode == null || client.player == null) return;
        if (!menu.getCarried().isEmpty()) {
            problems.add("カーソルにアイテムを持ったままです");
            return;
        }
        ItemStack current = target.getItem();
        if (!current.isEmpty() && !match.test(current)) {
            problems.add(slotName(target) + "に別のアイテムが入っています");
            return;
        }
        int need = count - current.getCount();
        int guard = 0;
        while (need > 0 && guard++ < 64) {
            Slot source = findSource(menu, match);
            if (source == null) {
                problems.add(slotName(target) + "の分が手持ちに足りません（あと " + need + " 個）");
                return;
            }
            click(client, menu, source.index, 0);
            int carried = menu.getCarried().getCount();
            if (carried <= need) {
                click(client, menu, target.index, 0);
            } else {
                for (int i = 0; i < need; i++) click(client, menu, target.index, 1);
            }
            int placed = carried - menu.getCarried().getCount();
            if (!menu.getCarried().isEmpty()) click(client, menu, source.index, 0);
            if (placed <= 0) {
                problems.add(slotName(target) + "にこれ以上入りません");
                return;
            }
            need -= placed;
        }
    }

    private static String slotName(Slot slot) {
        return (slot.getContainerSlot() + 1) + "枠目";
    }

    private static Slot findSource(AbstractContainerMenu menu, Predicate<ItemStack> match) {
        for (Slot s : menu.slots) {
            if (s.container instanceof Inventory && s.hasItem() && match.test(s.getItem())) return s;
        }
        return null;
    }

    private static void click(Minecraft client, AbstractContainerMenu menu, int slot, int button) {
        client.gameMode.handleInventoryMouseClick(menu.containerId, slot, button, ClickType.PICKUP, client.player);
    }

    static List<Slot> containerSlots(AbstractContainerMenu menu) {
        List<Slot> out = new ArrayList<>();
        for (Slot s : menu.slots) if (!(s.container instanceof Inventory)) out.add(s);
        return out;
    }

    // ---------------------------------------------------------------- filler

    private static Predicate<ItemStack> fillerMatcher(ItemStack filter) {
        Item item = fillerItem();
        if (item != null) return s -> s.is(item) && !ItemStack.isSameItemSameComponents(s, filter);
        // default: any item renamed on an anvil, as sorter fillers usually are
        return s -> s.has(DataComponents.CUSTOM_NAME) && !ItemStack.isSameItemSameComponents(s, filter);
    }

    private static Item fillerItem() {
        String id = ClientConfig.get().fillerItem;
        if (id == null || id.isBlank()) return null;
        Identifier key = Identifier.tryParse(id.contains(":") ? id : "minecraft:" + id);
        return key == null ? null : BuiltInRegistries.ITEM.getOptional(key).orElse(null);
    }

    private static String fillerLabel() {
        Item item = fillerItem();
        return item == null ? "名前を付けたアイテム（金床で改名したもの）" : item.getName().getString();
    }

    // ---------------------------------------------------------------- messages

    private static void report(Minecraft client, List<String> problems) {
        if (problems.isEmpty()) message(client, "詰め終わりました", false);
        else message(client, String.join(" / ", problems), true);
    }

    private static void message(Minecraft client, String text, boolean error) {
        if (client.player != null) {
            client.player.displayClientMessage(Component.literal(text).withStyle(error ? ChatFormatting.RED : ChatFormatting.GREEN), true);
        }
    }
}
