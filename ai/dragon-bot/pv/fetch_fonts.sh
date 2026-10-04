#!/bin/sh
# ロゴとオープニングで使うフォント（Google Fonts、SIL Open Font License）を fonts/ に入れる
cd "$(dirname "$0")" && mkdir -p fonts && cd fonts
B=https://raw.githubusercontent.com/google/fonts/main/ofl
for f in shipporiminchob1/ShipporiMinchoB1-ExtraBold.ttf orbitron/Orbitron%5Bwght%5D.ttf michroma/Michroma-Regular.ttf delagothicone/DelaGothicOne-Regular.ttf; do
  name=$(basename "$f" | sed 's/%5B/[/; s/%5D/]/')
  [ -f "$name" ] || curl -fsSL -o "$name" "$B/$f"
done
ls -l
