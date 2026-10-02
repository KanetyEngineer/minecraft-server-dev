#!/bin/bash
A=/tmp/s1.21.1; B=/tmp/s1.21.11
cd /tmp
find s1.21.1 s1.21.11 -iname '*Potion*.java' -path '*projectile*' | sort
for f in ThrowableProjectile ThrowableItemProjectile Projectile; do
  diff -u $A/net/minecraft/world/entity/projectile/$f.java $B/net/minecraft/world/entity/projectile/$f.java | diffstat 2>/dev/null || diff $A/net/minecraft/world/entity/projectile/$f.java $B/net/minecraft/world/entity/projectile/$f.java | wc -l
done
echo "######## A ThrownPotion"; cat $A/net/minecraft/world/entity/projectile/ThrownPotion.java | grep -v '^import'
echo "######## A ThrowableProjectile"; grep -v '^import' $A/net/minecraft/world/entity/projectile/ThrowableProjectile.java
echo "######## A Entity portal"
awk '/public Entity changeDimension/,/^    }$/' $A/net/minecraft/world/entity/Entity.java
awk '/protected void handlePortal/,/^    }$/' $A/net/minecraft/world/entity/Entity.java
awk '/public void setAsInsidePortal/,/^    }$/' $A/net/minecraft/world/entity/Entity.java
awk '/public boolean canChangeDimensions/,/^    }$/' $A/net/minecraft/world/entity/Entity.java
echo "######## A Projectile changeDimension etc"
grep -n -E "changeDimension|restoreFrom|hasBeenShot|leftOwner|ownerUUID|cachedOwner" $A/net/minecraft/world/entity/projectile/Projectile.java
