"""色合わせに使うブロックの一覧。

各要素は (ブロックID, 代表テクスチャ名, カテゴリ, フラグ)。
代表テクスチャは横から見たときの面 (textures/block/<名前>.png)。
平均色は palette_data.py に入っていて、tools/gen_palette.py で再生成する。
アドオンからはクライアント jar を指定して作り直すこともできる。

フラグ:
  gravity  重力で落ちる (砂・砂利・コンクリートパウダー)
  light    光る
  glass    半透明 (色付きガラス)
"""

COLORS = [
    "white", "light_gray", "gray", "black", "brown", "red", "orange", "yellow",
    "lime", "green", "cyan", "light_blue", "blue", "purple", "magenta", "pink",
]

CATEGORIES = [
    ("concrete", "コンクリート"),
    ("wool", "羊毛"),
    ("terracotta", "テラコッタ"),
    ("wood", "木材"),
    ("stone", "石・レンガ"),
    ("nature", "土・自然"),
    ("mineral", "鉱物ブロック"),
    ("nether_end", "ネザー・エンド"),
    ("glass", "色付きガラス"),
    ("gravity", "落下するブロック"),
]


def _defs():
    out = []
    for c in COLORS:
        out.append((f"minecraft:{c}_concrete", f"{c}_concrete", "concrete", ()))
        out.append((f"minecraft:{c}_wool", f"{c}_wool", "wool", ()))
        out.append((f"minecraft:{c}_terracotta", f"{c}_terracotta", "terracotta", ()))
        out.append((f"minecraft:{c}_stained_glass", f"{c}_stained_glass", "glass", ("glass",)))
        out.append((f"minecraft:{c}_concrete_powder", f"{c}_concrete_powder", "gravity", ("gravity",)))
    out.append(("minecraft:terracotta", "terracotta", "terracotta", ()))

    for w in ("oak", "spruce", "birch", "jungle", "acacia", "dark_oak", "mangrove",
              "cherry", "pale_oak"):
        out.append((f"minecraft:{w}_planks", f"{w}_planks", "wood", ()))
        out.append((f"minecraft:{w}_log", f"{w}_log", "wood", ()))
        out.append((f"minecraft:stripped_{w}_log", f"stripped_{w}_log", "wood", ()))
    out += [
        ("minecraft:bamboo_planks", "bamboo_planks", "wood", ()),
        ("minecraft:bamboo_block", "bamboo_block", "wood", ()),
        ("minecraft:stripped_bamboo_block", "stripped_bamboo_block", "wood", ()),
        ("minecraft:crimson_planks", "crimson_planks", "wood", ()),
        ("minecraft:warped_planks", "warped_planks", "wood", ()),
        ("minecraft:crimson_stem", "crimson_stem", "wood", ()),
        ("minecraft:warped_stem", "warped_stem", "wood", ()),
        ("minecraft:stripped_crimson_stem", "stripped_crimson_stem", "wood", ()),
        ("minecraft:stripped_warped_stem", "stripped_warped_stem", "wood", ()),
        ("minecraft:mushroom_stem", "mushroom_stem", "wood", ()),
        ("minecraft:brown_mushroom_block", "brown_mushroom_block", "wood", ()),
        ("minecraft:red_mushroom_block", "red_mushroom_block", "wood", ()),
    ]

    stone = [
        "stone", "cobblestone", "mossy_cobblestone", "smooth_stone", "stone_bricks",
        "mossy_stone_bricks", "cracked_stone_bricks", "andesite", "polished_andesite",
        "diorite", "polished_diorite", "granite", "polished_granite",
        "cobbled_deepslate", "polished_deepslate", "deepslate_bricks", "deepslate_tiles",
        "tuff", "polished_tuff", "tuff_bricks", "calcite", "dripstone_block",
        "bricks", "mud_bricks", "packed_mud", "prismarine", "prismarine_bricks",
        "dark_prismarine", "sandstone", "red_sandstone", "resin_bricks",
    ]
    out += [(f"minecraft:{s}", s, "stone", ()) for s in stone]
    out += [
        ("minecraft:deepslate", "deepslate", "stone", ()),
        ("minecraft:smooth_sandstone", "sandstone_top", "stone", ()),
        ("minecraft:smooth_red_sandstone", "red_sandstone_top", "stone", ()),
        ("minecraft:quartz_block", "quartz_block_side", "stone", ()),
        ("minecraft:smooth_quartz", "quartz_block_bottom", "stone", ()),
        ("minecraft:quartz_bricks", "quartz_bricks", "stone", ()),
    ]

    out += [
        ("minecraft:dirt", "dirt", "nature", ()),
        ("minecraft:coarse_dirt", "coarse_dirt", "nature", ()),
        ("minecraft:rooted_dirt", "rooted_dirt", "nature", ()),
        ("minecraft:mud", "mud", "nature", ()),
        ("minecraft:clay", "clay", "nature", ()),
        ("minecraft:moss_block", "moss_block", "nature", ()),
        ("minecraft:pale_moss_block", "pale_moss_block", "nature", ()),
        ("minecraft:snow_block", "snow", "nature", ()),
        ("minecraft:packed_ice", "packed_ice", "nature", ()),
        ("minecraft:blue_ice", "blue_ice", "nature", ()),
        ("minecraft:hay_block", "hay_block_side", "nature", ()),
        ("minecraft:bone_block", "bone_block_side", "nature", ()),
        ("minecraft:dried_kelp_block", "dried_kelp_side", "nature", ()),
        ("minecraft:honeycomb_block", "honeycomb_block", "nature", ()),
        ("minecraft:resin_block", "resin_block", "nature", ()),
        ("minecraft:sponge", "sponge", "nature", ()),
        ("minecraft:sand", "sand", "gravity", ("gravity",)),
        ("minecraft:red_sand", "red_sand", "gravity", ("gravity",)),
        ("minecraft:gravel", "gravel", "gravity", ("gravity",)),
    ]

    out += [
        ("minecraft:iron_block", "iron_block", "mineral", ()),
        ("minecraft:gold_block", "gold_block", "mineral", ()),
        ("minecraft:diamond_block", "diamond_block", "mineral", ()),
        ("minecraft:emerald_block", "emerald_block", "mineral", ()),
        ("minecraft:lapis_block", "lapis_block", "mineral", ()),
        ("minecraft:coal_block", "coal_block", "mineral", ()),
        ("minecraft:netherite_block", "netherite_block", "mineral", ()),
        ("minecraft:amethyst_block", "amethyst_block", "mineral", ()),
        ("minecraft:raw_iron_block", "raw_iron_block", "mineral", ()),
        ("minecraft:raw_copper_block", "raw_copper_block", "mineral", ()),
        ("minecraft:raw_gold_block", "raw_gold_block", "mineral", ()),
        # 酸化しないように錆止め済み (waxed) の ID を使う
        ("minecraft:waxed_copper_block", "copper_block", "mineral", ()),
        ("minecraft:waxed_exposed_copper", "exposed_copper", "mineral", ()),
        ("minecraft:waxed_weathered_copper", "weathered_copper", "mineral", ()),
        ("minecraft:waxed_oxidized_copper", "oxidized_copper", "mineral", ()),
        ("minecraft:waxed_cut_copper", "cut_copper", "mineral", ()),
        ("minecraft:waxed_exposed_cut_copper", "exposed_cut_copper", "mineral", ()),
        ("minecraft:waxed_weathered_cut_copper", "weathered_cut_copper", "mineral", ()),
        ("minecraft:waxed_oxidized_cut_copper", "oxidized_cut_copper", "mineral", ()),
    ]

    out += [
        ("minecraft:netherrack", "netherrack", "nether_end", ()),
        ("minecraft:nether_bricks", "nether_bricks", "nether_end", ()),
        ("minecraft:red_nether_bricks", "red_nether_bricks", "nether_end", ()),
        ("minecraft:nether_wart_block", "nether_wart_block", "nether_end", ()),
        ("minecraft:warped_wart_block", "warped_wart_block", "nether_end", ()),
        ("minecraft:blackstone", "blackstone", "nether_end", ()),
        ("minecraft:polished_blackstone", "polished_blackstone", "nether_end", ()),
        ("minecraft:polished_blackstone_bricks", "polished_blackstone_bricks", "nether_end", ()),
        ("minecraft:basalt", "basalt_side", "nether_end", ()),
        ("minecraft:polished_basalt", "polished_basalt_side", "nether_end", ()),
        ("minecraft:smooth_basalt", "smooth_basalt", "nether_end", ()),
        ("minecraft:soul_soil", "soul_soil", "nether_end", ()),
        ("minecraft:obsidian", "obsidian", "nether_end", ()),
        ("minecraft:end_stone", "end_stone", "nether_end", ()),
        ("minecraft:end_stone_bricks", "end_stone_bricks", "nether_end", ()),
        ("minecraft:purpur_block", "purpur_block", "nether_end", ()),
        ("minecraft:glowstone", "glowstone", "nether_end", ("light",)),
        ("minecraft:shroomlight", "shroomlight", "nether_end", ("light",)),
        ("minecraft:sea_lantern", "sea_lantern", "nether_end", ("light",)),
        ("minecraft:ochre_froglight", "ochre_froglight_side", "nether_end", ("light",)),
        ("minecraft:verdant_froglight", "verdant_froglight_side", "nether_end", ("light",)),
        ("minecraft:pearlescent_froglight", "pearlescent_froglight_side", "nether_end", ("light",)),
    ]
    return out


BLOCK_DEFS = _defs()
