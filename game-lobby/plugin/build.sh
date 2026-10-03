#!/bin/sh
# Compiles GameLobby against the jars the Paper server downloaded on first start, and copies it into server/plugins
set -e
cd "$(dirname "$0")"
J="/c/Program Files/Eclipse Adoptium/jdk-25.0.4.101-hotspot/bin"
S=../server
CP="$S/versions/26.2/paper-26.2.jar;$S/plugins/ViaVersion-5.12.0.jar"
for f in $(find $S/libraries -name '*.jar'); do CP="$CP;$f"; done
rm -rf build && mkdir -p build/classes
"$J/javac" --release 25 -encoding UTF-8 -proc:none -cp "$CP" -d build/classes $(find src/main/java -name '*.java')
cp -r src/main/resources/* build/classes/
"$J/jar" --create --file build/GameLobby.jar -C build/classes .
cp build/GameLobby.jar $S/plugins/GameLobby.jar
echo built
