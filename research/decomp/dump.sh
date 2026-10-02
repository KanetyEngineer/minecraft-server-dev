#!/bin/bash
# Print files relevant to the thrown-potion portal duplication for both versions.
A=/tmp/s1.21.1; B=/tmp/s1.21.11
echo "### potion classes"; find $A $B -iname '*ThrownPotion*' -o -iname '*Potion*Projectile*' | sort
F="net/minecraft/world/entity/projectile/ThrowableProjectile.java
net/minecraft/world/entity/projectile/ThrowableItemProjectile.java
net/minecraft/world/entity/projectile/Projectile.java
net/minecraft/world/entity/projectile/ThrownPotion.java
net/minecraft/world/level/block/HoneyBlock.java
net/minecraft/world/entity/PortalProcessor.java
net/minecraft/world/level/block/NetherPortalBlock.java"
for f in $F; do
  echo; echo "########## DIFF $f"
  diff -u $A/$f $B/$f
done
echo "########## 1.21.1 Entity teleport/changeDimension"
grep -n -E "changeDimension|PortalProcessor|portalProcess|handlePortal|removeAfterChangingDimensions|restoreFrom|canChangeDimensions|setAsInsidePortal|isInsidePortal|teleport\(" $A/net/minecraft/world/entity/Entity.java
awk '/public Entity changeDimension/,/^    }$/' $A/net/minecraft/world/entity/Entity.java
awk '/protected void handlePortal/,/^    }$/' $A/net/minecraft/world/entity/Entity.java
echo "########## 1.21.11 Entity teleport"
grep -n -E "teleport\(|PortalProcessor|handlePortal|removeAfterChangingDimensions|restoreFrom|canTeleport|canUsePortal|setAsInsidePortal" $B/net/minecraft/world/entity/Entity.java
awk '/public Entity teleport\(TeleportTransition/,/^    }$/' $B/net/minecraft/world/entity/Entity.java
awk '/private Entity teleportCrossDimension/,/^    }$/' $B/net/minecraft/world/entity/Entity.java
awk '/protected void handlePortal/,/^    }$/' $B/net/minecraft/world/entity/Entity.java
awk '/public void setAsInsidePortal/,/^    }$/' $A/net/minecraft/world/entity/Entity.java $B/net/minecraft/world/entity/Entity.java
awk '/public boolean canUsePortal/,/^    }$/' $A/net/minecraft/world/entity/Entity.java $B/net/minecraft/world/entity/Entity.java
awk '/public boolean canChangeDimensions/,/^    }$/' $A/net/minecraft/world/entity/Entity.java $B/net/minecraft/world/entity/Entity.java
