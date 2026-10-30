package dev.kanety.solariacarpet.mixin;

import net.minecraft.world.entity.npc.villager.AbstractVillager;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.gen.Invoker;

@Mixin(AbstractVillager.class)
public interface AbstractVillagerAccessor {
    @Invoker("stopTrading")
    void solariacarpet$stopTrading();
}
