#!/bin/sh
# ロゴとオープニングで使うフォント Inter（Google Fonts、SIL Open Font License）を fonts/ に入れる
cd "$(dirname "$0")" && mkdir -p fonts && cd fonts
[ -f 'Inter[opsz,wght].ttf' ] || curl -fsSL -o 'Inter[opsz,wght].ttf' 'https://raw.githubusercontent.com/google/fonts/main/ofl/inter/Inter%5Bopsz,wght%5D.ttf'
ls -l
