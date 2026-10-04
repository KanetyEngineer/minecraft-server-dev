import json, zipfile, sys, random
from PIL import Image
skin, out = sys.argv[1], sys.argv[2]
im = Image.open(skin).convert("RGBA")
# hair color: average of opaque pixels of the hat back face (56..64, 8..16)
px = [im.getpixel((x, y)) for x in range(56, 64) for y in range(8, 16)]
px = [p for p in px if p[3] > 0]
r, g, b = (sum(p[i] for p in px) // len(px) for i in range(3))
hair = "%02x%02x%02x" % (r, g, b)
dark = "%02x%02x%02x" % (r * 8 // 10, g * 8 // 10, b * 8 // 10)
V = lambda x, y, z: {"x": float(x), "y": float(y), "z": float(z)}
def cube(name, pos, offset, size, color, rot=(0, 0, 0)):
    return {"name": name, "show": True, "texture": False, "textureSize": 1,
            "offset": V(*offset), "pos": V(*pos), "rotation": V(*rot), "size": V(*size),
            "rscale": V(1, 1, 1), "scale": V(1, 1, 1), "u": 0, "v": 0, "color": color,
            "mirror": False, "mcScale": 0.0, "glow": False, "recolor": False, "hidden": False,
            "singleTex": False, "extrude": False, "locked": False, "nameColor": 0,
            "storeID": random.getrandbits(62)}
# MC model space: y down, body pivot at neck (y=0), body y 0..12, front = -z
children = {
    "head": [
        # long back hair hanging from the back of the head, follows head turns
        cube("hair_back", (0, 0, 0), (-4.5, -6, 4.0), (9, 15, 1.2), hair),
        # strands in front of the shoulders
        cube("hair_front_r", (0, 0, 0), (-4.6, -2, -2.4), (1.4, 9, 1.4), dark),
        cube("hair_front_l", (0, 0, 0), (3.2, -2, -2.4), (1.4, 9, 1.4), dark),
    ],
}
elements = []
for pid in ["head", "body", "left_arm", "right_arm", "left_leg", "right_leg"]:
    e = {"id": pid, "show": True, "showInEditor": True, "locked": False,
         "pos": V(0, 0, 0), "rotation": V(0, 0, 0), "dup": False,
         "disableVanillaAnim": False, "name": "", "nameColor": 0}
    if pid in children:
        e["children"] = children[pid]
    elements.append(e)
cfg = {"version": 1, "skinType": "default", "elements": elements, "scaling": 0.0,
       "removeArmorOffset": True, "hideHeadIfSkull": True, "removeBedOffset": False,
       "enableInvisGlow": False, "armor1Tex": True, "armor2Tex": True,
       "skinSize": {"x": 64, "y": 64},
       "textures": {"skin": {"customGridSize": False, "anim": []}}}
desc = {"name": "VRM sample", "desc": "VRM1_Constraint_Twist_Sample (c) 2022 pixiv Inc. converted",
        "cam": {"pos": V(0.5, 1, 0.5), "zoom": 64.0, "copyProt": "normal", "look": V(0.25, 0.5, 0.25)}}
with zipfile.ZipFile(out, "w") as z:
    z.writestr("config.json", json.dumps(cfg, indent=1))
    z.writestr("description.json", json.dumps(desc, indent=1))
    z.write(skin, "skin.png")
print("hair", hair, dark)
