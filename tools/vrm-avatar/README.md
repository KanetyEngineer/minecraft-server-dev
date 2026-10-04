# MODなしで3Dアバター（リソースパック＋表示エンティティ）試作（2026-10-04）

素材: VRM1_Constraint_Twist_Sample（(c) 2022 pixiv Inc.、改変・再配布可）。対象: Minecraft 26.2（データパック形式 107）。

## ファイル
- sample_detail_resourcepack.zip … 細かい版（頭1.25cm・体2cmの箱、面 約14,000枚）
- sample_light_resourcepack.zip … 軽量版（頭2.5cm・体4cm、面 約3,700枚）※複数人ならこちら
- sample_datapack.zip … プレイヤーに着せるデータパック（どちらのリソースパックでも共通）
- preview/compare_detail_vs_light.png … 上段: 細かい版、下段: 軽量版（Blender での見本）

## 使い方（バニラ 26.2、シングルでも可）
1. リソースパックを入れる（サーバーなら server.properties の resource-pack で自動配布）
2. データパックを world/datapacks/ に入れて /reload
3. `/execute as <名前> run function vrmav:equip_sample` で着る、`/execute as <名前> run function vrmav:unequip` で脱ぐ

## 仕組み
- 頭・胴・両腕・両脚を item_display 6体に分け、毎tick プレイヤーの位置へ tp（頭は首を軸に上下の向きも追従）。
- 歩いた距離で8コマの歩きモーション（腕・脚の振り）を切り替え、補間で滑らかに。コマが変わったときだけ更新。
- 本人は透明化（防具・手持ちアイテムと名札は見える）。

## 未確認（実機で見る点）
- item_display の向き（表示が後ろ向きなら equip とpose の FLIP を外す）
- リソースパックの min_format 65〜max 999 が 26.2 で受け付けられるか
- 多人数時の描画負荷（面の数がそのまま効く）

## 元データ並みの解像度版（2026-10-04 追加）
1.21.11 以降はモデルの箱を自由な角度に回せるので、元の三角形1枚ずつを「回転した板1枚」にし、その三角形の絵を 4096×4096 の1枚のテクスチャに焼き直した（三角形の外は透明）。データパックは上と同じ sample_datapack.zip を使う。
- sample_full_resourcepack.zip … 元の三角形 36,470 枚そのまま（面 約56,000：髪と服は裏面も）。テクスチャの細かさは元の約66%
- sample_mid_resourcepack.zip … 三角形を35%に減らした版（面 約20,000）。見た目はほぼ同じ（preview/compare_full_vs_mid.png）
- 面は shade:false（陰影なし＝トゥーン調）。裏面は 0.02 単位ずらした別の板にして重なりのちらつきを防止。
- 未確認: 回転の向き・順序（x→y→z、右手系と仮定）、裏面の向き、4096 のテクスチャがアイテム用アトラスに入るときの VRAM（推定 64〜85MB 増）。
