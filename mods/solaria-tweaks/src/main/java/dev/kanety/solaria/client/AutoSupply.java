package dev.kanety.solaria.client;

import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.screens.inventory.AbstractContainerScreen;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.core.component.DataComponents;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.food.FoodProperties;
import net.minecraft.world.inventory.AbstractContainerMenu;
import net.minecraft.world.inventory.ClickType;
import net.minecraft.world.inventory.ShulkerBoxMenu;
import net.minecraft.world.inventory.Slot;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;

import java.util.Set;
import java.util.function.Predicate;

/**
 * Auto eat: when the food level drops to the threshold, eats the best food from the hotbar (or swaps one in from the
 * main inventory for the duration). Refill: when a shulker box is opened, tops up firework and food stacks in the
 * inventory to a full stack from identical items in the box.
 */
public final class AutoSupply {
    /** Foods that hurt, teleport or are too valuable to eat without asking. */
    private static final Set<Item> NEVER_EAT = Set.of(Items.ROTTEN_FLESH, Items.SPIDER_EYE, Items.POISONOUS_POTATO, Items.PUFFERFISH,
            Items.CHORUS_FRUIT, Items.GOLDEN_APPLE, Items.ENCHANTED_GOLDEN_APPLE, Items.SUSPICIOUS_STEW);

    private static boolean eating;
    private static int eatTicks;
    private static int previousSlot = -1;
    /** Main inventory menu slot swapped into the hotbar for eating, or -1. */
    private static int swappedFrom = -1;
    private static int cooldown;

    private static AbstractContainerMenu refillMenu;
    private static int refillWait;

    private AutoSupply() {}

    /** While auto eat holds an item in use, the client must not release it just because the use key is up. */
    public static boolean holdingUse() {
        return eating;
    }

    public static void tick(Minecraft client) {
        tickEat(client);
        tickRefill(client);
    }

    // ---------------------------------------------------------------- auto eat

    private static void tickEat(Minecraft client) {
        LocalPlayer player = client.player;
        if (eating) {
            eatTicks++;
            boolean done = player == null || client.gameMode == null || client.screen != null
                    || (eatTicks > 2 && !player.isUsingItem()) || eatTicks > 100;
            if (done) stopEating(client);
            return;
        }
        if (cooldown > 0) {
            cooldown--;
            return;
        }
        ClientConfig cfg = ClientConfig.get();
        if (!cfg.autoEat || player == null || client.gameMode == null || client.screen != null) return;
        if (!player.isAlive() || player.isSpectator() || player.getAbilities().instabuild || player.isUsingItem()) return;
        if (client.options.keyUse.isDown() || client.options.keyAttack.isDown()) return;
        if (player.getFoodData().getFoodLevel() > cfg.autoEatThreshold || !player.canEat(false)) return;

        Inventory inv = player.getInventory();
        int best = -1;
        int bestScore = 0;
        for (int i = 0; i < 36; i++) {
            int score = foodScore(inv.getItem(i));
            // Prefer the hotbar so nothing has to be moved.
            if (score > 0 && i < 9) score += 1000;
            if (score > bestScore) {
                bestScore = score;
                best = i;
            }
        }
        if (best < 0) return;

        previousSlot = inv.getSelectedSlot();
        if (best < 9) {
            inv.setSelectedSlot(best);
        } else {
            // Inventory slot i (9..35) is menu slot i in the player's inventory menu.
            client.gameMode.handleInventoryMouseClick(player.inventoryMenu.containerId, best, previousSlot, ClickType.SWAP, player);
            swappedFrom = best;
        }
        eating = true;
        eatTicks = 0;
        client.gameMode.useItem(player, InteractionHand.MAIN_HAND);
    }

    private static void stopEating(Minecraft client) {
        eating = false;
        cooldown = 10;
        LocalPlayer player = client.player;
        if (player != null && client.gameMode != null) {
            if (player.isUsingItem()) client.gameMode.releaseUsingItem(player);
            if (swappedFrom >= 0 && client.screen == null) {
                client.gameMode.handleInventoryMouseClick(player.inventoryMenu.containerId, swappedFrom, previousSlot, ClickType.SWAP, player);
            }
            if (previousSlot >= 0) player.getInventory().setSelectedSlot(previousSlot);
        }
        swappedFrom = -1;
        previousSlot = -1;
    }

    private static int foodScore(ItemStack stack) {
        if (stack.isEmpty() || NEVER_EAT.contains(stack.getItem())) return 0;
        FoodProperties food = stack.get(DataComponents.FOOD);
        if (food == null) return 0;
        return 1 + food.nutrition() * 10 + Math.round(food.saturation());
    }

    // ---------------------------------------------------------------- shulker refill

    private static void tickRefill(Minecraft client) {
        if (!(client.screen instanceof AbstractContainerScreen<?> cs) || !(cs.getMenu() instanceof ShulkerBoxMenu menu)) {
            refillMenu = null;
            return;
        }
        if (menu == refillMenu) {
            if (refillWait < 0 || --refillWait > 0) return;
            refillWait = -1;
            refill(client, menu);
            return;
        }
        // The box contents arrive a moment after the screen opens.
        refillMenu = menu;
        refillWait = 3;
    }

    private static void refill(Minecraft client, AbstractContainerMenu menu) {
        ClientConfig cfg = ClientConfig.get();
        if (client.gameMode == null || client.player == null || !menu.getCarried().isEmpty()) return;
        for (Slot target : menu.slots) {
            if (!(target.container instanceof Inventory) || !target.hasItem()) continue;
            ItemStack stack = target.getItem();
            boolean wanted = (cfg.refillFireworks && stack.is(Items.FIREWORK_ROCKET))
                    || (cfg.refillFood && stack.has(DataComponents.FOOD));
            if (wanted) topUp(client, menu, target);
        }
    }

    /** Fills `target` to a full stack from identical items in the box. */
    private static void topUp(Minecraft client, AbstractContainerMenu menu, Slot target) {
        ItemStack want = target.getItem().copy();
        Predicate<ItemStack> same = s -> ItemStack.isSameItemSameComponents(s, want);
        int guard = 0;
        while (target.getItem().getCount() < target.getItem().getMaxStackSize() && guard++ < 27) {
            Slot source = null;
            for (Slot s : menu.slots) {
                if (!(s.container instanceof Inventory) && s.hasItem() && same.test(s.getItem())) {
                    source = s;
                    break;
                }
            }
            if (source == null) return;
            int before = target.getItem().getCount();
            click(client, menu, source.index);
            click(client, menu, target.index);
            if (!menu.getCarried().isEmpty()) click(client, menu, source.index);
            if (target.getItem().getCount() <= before) return;
        }
    }

    private static void click(Minecraft client, AbstractContainerMenu menu, int slot) {
        client.gameMode.handleInventoryMouseClick(menu.containerId, slot, 0, ClickType.PICKUP, client.player);
    }
}
