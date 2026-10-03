import pickle, sys, numpy as np
from PIL import Image, ImageDraw, ImageFont
from builder import XMIN, YMIN, ZMIN

d = pickle.load(open(sys.argv[1], "rb"))
vox, pal, labels = d["vox"], d["palette"], d["labels"]
out = sys.argv[2]

RULES = [
    ("shroomlight", (255, 170, 60)), ("jack_o_lantern", (255, 150, 30)), ("pumpkin", (220, 120, 20)), ("orange_concrete", (235, 110, 15)),
    ("orange_terracotta", (170, 85, 40)), ("orange_wool", (240, 120, 20)), ("orange_stained", (240, 140, 60)), ("orange", (230, 120, 30)),
    ("purple_stained", (130, 60, 170)), ("purple", (110, 50, 150)), ("black", (30, 30, 34)), ("white", (220, 220, 220)),
    ("red", (150, 40, 40)), ("soul_lantern", (90, 220, 230)), ("soul_fire", (90, 220, 230)), ("soul_campfire", (90, 200, 220)),
    ("soul_soil", (80, 62, 50)), ("soul_sand", (85, 66, 52)), ("lava", (230, 90, 20)), ("water", (60, 90, 200)),
    ("dirt_path", (150, 125, 75)), ("gravel", (125, 120, 118)), ("coarse_dirt", (110, 80, 55)), ("rooted_dirt", (130, 95, 70)),
    ("podzol", (90, 65, 30)), ("mud_bricks", (140, 110, 85)), ("packed_mud", (140, 105, 80)), ("mud", (60, 55, 60)),
    ("pale_moss", (120, 130, 115)), ("moss", (85, 110, 45)), ("grass_block", (95, 125, 70)), ("dirt", (120, 85, 60)),
    ("pale_oak_leaves", (170, 175, 165)), ("dark_oak_leaves", (45, 75, 30)), ("spruce_leaves", (50, 80, 50)), ("leaves", (60, 100, 40)),
    ("cobweb", (230, 230, 230)), ("hay", (200, 170, 50)), ("bookshelf", (120, 80, 50)), ("deepslate_tile", (55, 55, 60)),
    ("deepslate", (75, 75, 80)), ("polished_blackstone", (45, 40, 48)), ("blackstone", (40, 36, 42)), ("gilded", (120, 90, 40)),
    ("crimson", (130, 30, 30)), ("netherrack", (110, 50, 50)), ("nether", (60, 30, 35)), ("mossy", (100, 115, 90)),
    ("stone_brick", (120, 120, 120)), ("cobble", (115, 115, 115)), ("andesite", (130, 130, 130)), ("smooth_stone", (160, 160, 160)),
    ("stone", (125, 125, 125)), ("bricks", (150, 80, 65)), ("sandstone", (215, 200, 150)), ("bone", (220, 215, 190)),
    ("dark_oak", (65, 45, 25)), ("pale_oak", (220, 210, 205)), ("spruce", (110, 80, 45)), ("mangrove", (115, 50, 45)),
    ("iron_bars", (150, 150, 155)), ("lantern", (240, 200, 90)), ("candle", (240, 220, 160)), ("cake", (240, 230, 220)),
    ("chest", (160, 110, 40)), ("lodestone", (140, 140, 145)), ("barrel", (130, 95, 55)), ("cauldron", (60, 60, 70)),
    ("skull", (200, 200, 190)), ("lever", (100, 90, 80)), ("glass", (180, 200, 220)), ("campfire", (240, 140, 40)),
    ("concrete", (120, 120, 120)), ("wool", (200, 200, 200)), ("log", (90, 70, 40)), ("planks", (140, 105, 65)),
]


def color(b):
    for k, c in RULES:
        if k in b:
            return c
    return (200, 0, 200)


cols = np.array([color(p) for p in pal], dtype=np.float32)
cols[0] = (14, 12, 22)

# ---------- top-down
X, Y, Z = vox.shape
solid = vox != 0
top = np.where(solid.any(axis=1), Y - 1 - np.argmax(solid[:, ::-1, :], axis=1), -1)
ids = np.take_along_axis(vox, np.clip(top, 0, None)[:, None, :], axis=1)[:, 0, :]
img = cols[ids]
h = (top + YMIN).astype(np.float32)
shade = np.clip(0.75 + (h - 63) * 0.012, 0.6, 1.35)[..., None]
img = np.where((top >= 0)[..., None], img * shade, cols[0])
# simple hill-shading by height difference
dz = np.zeros_like(h); dz[:, 1:] = h[:, 1:] - h[:, :-1]
img = np.clip(img * (1 + np.clip(dz, -3, 3)[..., None] * 0.05), 0, 255)
S = 4
im = Image.fromarray(img.transpose(1, 0, 2).astype(np.uint8)).resize((X * S, Z * S), Image.NEAREST)
draw = ImageDraw.Draw(im)
font = ImageFont.truetype("/usr/share/fonts/opentype/ipafont-gothic/ipag.ttf", 22)
for (x, z, t) in labels:
    px, pz = (x - XMIN) * S, (z - ZMIN) * S
    w = draw.textlength(t, font=font)
    draw.rectangle([px - w / 2 - 5, pz - 15, px + w / 2 + 5, pz + 15], fill=(0, 0, 0, 160))
    draw.text((px - w / 2, pz - 12), t, font=font, fill=(255, 210, 120))
# compass + grid
draw.text((20, 20), "N ↑   1マス=1ブロック  (x:-112..112, z:-160..112)", font=font, fill=(230, 230, 230))
im.save(out + "_top.png")

# ---------- isometric close-ups
def iso(x1, x2, z1, z2, y1, y2, scale, name):
    sub = vox[x1 - XMIN:x2 - XMIN + 1, y1 - YMIN:y2 - YMIN + 1, z1 - ZMIN:z2 - ZMIN + 1]
    sx, sy, sz = sub.shape
    W = int((sx + sz) * scale * 0.87) + 40
    H = int(((sx + sz) * 0.5 + sy) * scale) + 40
    can = Image.new("RGB", (W, H), (14, 12, 22))
    dr = ImageDraw.Draw(can)
    idx = np.argwhere(sub != 0)
    # painter's order: far to near (view from south-east looking north-west)
    order = np.lexsort((idx[:, 1], idx[:, 0] + idx[:, 2]))
    ox = sz * scale * 0.87 + 20
    oy = 20 + sy * scale
    for k in order:
        x, y, z = idx[k]
        c = cols[sub[x, y, z]]
        cx = ox + (x - z) * scale * 0.87
        cy = oy + (x + z) * scale * 0.5 - y * scale
        s = scale
        topf = [(cx, cy - s * 0.5), (cx + s * 0.87, cy), (cx, cy + s * 0.5), (cx - s * 0.87, cy)]
        left = [(cx - s * 0.87, cy), (cx, cy + s * 0.5), (cx, cy + s * 1.5), (cx - s * 0.87, cy + s)]
        right = [(cx + s * 0.87, cy), (cx, cy + s * 0.5), (cx, cy + s * 1.5), (cx + s * 0.87, cy + s)]
        dr.polygon(left, fill=tuple(int(v * 0.7) for v in c))
        dr.polygon(right, fill=tuple(int(v * 0.85) for v in c))
        dr.polygon(topf, fill=tuple(int(v) for v in c))
    can.save(f"{out}_{name}.png")


if len(sys.argv) > 3:
    iso(-20, 20, -20, 20, 60, 90, 9, "plaza")
    iso(-18, 18, -68, -40, 60, 92, 8, "mansion")
    iso(48, 72, 48, 72, 60, 112, 7, "tower")
    iso(-26, 26, -152, -84, 60, 76, 5, "arena")
    iso(-34, 34, 40, 82, 60, 76, 6, "village")
