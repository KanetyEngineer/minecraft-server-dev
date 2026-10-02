#!/bin/bash
V=$1; R=/tmp/s$V
cd $R
E=net/minecraft/world/entity
P=$E/projectile
X="python3 $GITHUB_WORKSPACE/research/decomp/extract.py $R"
$X $E/Entity.java:tick,applyGravity,getGravity,isAffectedByBlocks,oldPosition,setOldPosAndRot \
   $P/ProjectileUtil.java:getHitResultOnMoveVector,getHitResult,computeMargin \
   $P/Projectile.java:getDimensionChangingDelay,checkLeftOwner,canHitEntity \
   net/minecraft/world/level/block/HoneyBlock.java:getOldDeltaY,getNewDeltaY
grep -n "class ThrownEnderpearl\|public void tick\|teleport" $P/ThrownEnderpearl.java $P/throwableitemprojectile/ThrownEnderpearl.java 2>/dev/null | head
