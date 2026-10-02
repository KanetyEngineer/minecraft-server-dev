#!/bin/bash
V=$1; R=/tmp/s$V
cd $R
E=net/minecraft/world/entity
P=$E/projectile
grep -rn "getDimensionChangingDelay" --include=*.java . | head -20
X="python3 $GITHUB_WORKSPACE/research/decomp/extract.py $R"
$X $E/Entity.java:baseTick,getDimensionChangingDelay,processPortalCooldown \
   net/minecraft/world/level/block/HoneyBlock.java:entityInside,isSlidingDown,doSlideMovement,maybeDoSlideEffects
if [ "$V" = "1.21.11" ]; then
  $X $P/throwableitemprojectile/AbstractThrownPotion.java:onHit,onHitBlock,onHitAsPotion \
     $P/throwableitemprojectile/ThrownSplashPotion.java:'*' \
     $E/Entity.java:applyEffectsFromBlocks,checkInsideBlocks \
     $P/Projectile.java:hitTargetOrDeflectSelf
else
  $X $E/Entity.java:checkInsideBlocks $P/Projectile.java:hitTargetOrDeflectSelf
fi
