#!/bin/bash
V=$1; R=/tmp/s$V
cd $R; echo "#### potion-ish projectile classes"; find . -path '*projectile*' -iname '*Potion*.java'
E=net/minecraft/world/entity
P=$E/projectile
if [ "$V" = "1.21.1" ]; then
python3 $GITHUB_WORKSPACE/research/decomp/extract.py $R \
  $P/ThrownPotion.java:'*' $P/ThrowableProjectile.java:'*' \
  $E/Entity.java:changeDimension,handlePortal,setAsInsidePortal,canChangeDimensions,restoreFrom,removeAfterChangingDimensions,isOnPortalCooldown,setPortalCooldown \
  $P/Projectile.java:tick,restoreFrom,onHit,shoot \
  net/minecraft/world/level/block/NetherPortalBlock.java:entityInside,getPortalDestination \
  net/minecraft/world/entity/PortalProcessor.java:'*'
else
python3 $GITHUB_WORKSPACE/research/decomp/extract.py $R \
  $P/AbstractThrownPotion.java:'*' $P/ThrowableProjectile.java:'*' \
  $E/Entity.java:teleport,teleportCrossDimension,teleportSameDimension,handlePortal,setAsInsidePortal,canTeleport,canUsePortal,restoreFrom,removeAfterChangingDimensions,isOnPortalCooldown \
  $P/Projectile.java:tick,restoreFrom,onHit,teleport \
  net/minecraft/world/level/block/NetherPortalBlock.java:entityInside,getPortalDestination \
  net/minecraft/world/entity/PortalProcessor.java:'*'
fi
