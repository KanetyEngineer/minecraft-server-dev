#!/bin/bash
V=$1; R=/tmp/s$V
cd $R
E=net/minecraft/world/entity
X="python3 $GITHUB_WORKSPACE/research/decomp/extract.py $R"
$X net/minecraft/world/level/block/BubbleColumnBlock.java:entityInside \
   $E/Entity.java:onInsideBubbleColumn,onAboveBubbleColumn,getEntityInsideCollisionShape \
   net/minecraft/world/level/block/state/BlockBehaviour.java:getEntityInsideCollisionShape
if [ "$V" = "1.21.11" ]; then
grep -n "public boolean hasPermission\|permissions()\|public static.*hasPermission\|LEVEL_GAMEMASTERS\|PermissionCheck" net/minecraft/commands/CommandSourceStack.java net/minecraft/commands/Commands.java | head -20
ls net/minecraft/server/permissions 2>/dev/null | head -30
fi
