# /transfer は権限レベル 3 が必要なので、server.properties の function-permission-level=3 が要る
scoreboard players reset @s lobby
tellraw @s {"text":"ゲームロビーへ移動します…","color":"gold"}
transfer stamina-proves.tun.ply.gg 14610 @s
