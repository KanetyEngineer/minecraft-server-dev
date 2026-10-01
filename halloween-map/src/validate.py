"""Validate generated mcfunctions against the 26.2 brigadier command tree + registries (from misode/mcmeta)."""
import json, os, re, sys

SCR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "mcdata")
if not os.path.exists(SCR):
    SCR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TREE = json.load(open(os.path.join(SCR, "cmds.json")))
REG = json.load(open(os.path.join(SCR, "reg.json")))
BLOCKS = json.load(open(os.path.join(SCR, "blocks.json")))
REGS = {k: set(v) for k, v in REG.items()}

PACK = sys.argv[1]
NS = "halloween"
FUNCS = set()
FDIR = os.path.join(PACK, "data", NS, "function")
for dp, dn, fns in os.walk(FDIR):
    for f in fns:
        FUNCS.add(NS + ":" + os.path.relpath(os.path.join(dp, f), FDIR)[:-len(".mcfunction")].replace(os.sep, "/"))

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from logic import OBJECTIVES
OBJS = {o for o, _, _ in OBJECTIVES}
USED_OBJ = set()


class PErr(Exception):
    pass


def strip_ns(i):
    return i[10:] if i.startswith("minecraft:") else i


# ---------------------------------------------------------------- SNBT
class SNBT:
    def __init__(self, s, i):
        self.s, self.i = s, i

    def ws(self):
        while self.i < len(self.s) and self.s[self.i] in " \t":
            self.i += 1

    def peek(self):
        return self.s[self.i] if self.i < len(self.s) else ""

    def value(self):
        self.ws()
        c = self.peek()
        if c == "{":
            return self.compound()
        if c == "[":
            return self.lst()
        if c in "\"'":
            return self.qstr()
        return self.unquoted()

    def qstr(self):
        q = self.s[self.i]; self.i += 1
        out = ""
        while self.i < len(self.s):
            c = self.s[self.i]
            if c == "\\":
                out += self.s[self.i + 1]; self.i += 2; continue
            if c == q:
                self.i += 1
                return ("str", out)
            out += c; self.i += 1
        raise PErr("unterminated string")

    def unquoted(self):
        m = re.compile(r"[0-9A-Za-z_\-.+]+").match(self.s, self.i)
        if not m:
            raise PErr(f"bad snbt value at {self.s[self.i:self.i+20]!r}")
        self.i = m.end()
        return ("raw", m.group(0))

    def compound(self):
        self.i += 1
        d = {}
        self.ws()
        if self.peek() == "}":
            self.i += 1
            return ("compound", d)
        while True:
            self.ws()
            if self.peek() in "\"'":
                k = self.qstr()[1]
            else:
                m = re.compile(r"[0-9A-Za-z_\-.+]+").match(self.s, self.i)
                if not m:
                    raise PErr(f"bad key at {self.s[self.i:self.i+20]!r}")
                k = m.group(0); self.i = m.end()
            self.ws()
            if self.peek() != ":":
                raise PErr(f"expected ':' after key {k}")
            self.i += 1
            if k in d:
                raise PErr(f"duplicate key {k}")
            d[k] = self.value()
            self.ws()
            c = self.peek()
            if c == ",":
                self.i += 1; continue
            if c == "}":
                self.i += 1
                return ("compound", d)
            raise PErr(f"expected , or }} got {self.s[self.i:self.i+20]!r}")

    def lst(self):
        self.i += 1
        self.ws()
        if re.match(r"[BIL];", self.s[self.i:self.i + 2]):
            self.i += 2
        items = []
        self.ws()
        if self.peek() == "]":
            self.i += 1
            return ("list", items)
        while True:
            items.append(self.value())
            self.ws()
            c = self.peek()
            if c == ",":
                self.i += 1; continue
            if c == "]":
                self.i += 1
                return ("list", items)
            raise PErr(f"expected , or ] got {self.s[self.i:self.i+20]!r}")


TEXT_KEYS = {"text", "color", "bold", "italic", "underlined", "strikethrough", "obfuscated", "extra", "score", "selector",
             "click_event", "hover_event", "translate", "with", "font", "insertion", "keybind", "nbt", "type", "shadow_color", "separator", "fallback"}
COLORS = {"black", "dark_blue", "dark_green", "dark_aqua", "dark_red", "dark_purple", "gold", "gray", "dark_gray", "blue", "green", "aqua", "red", "light_purple", "yellow", "white"}


def check_text(v, where):
    t, x = v
    if t in ("str", "raw"):
        return
    if t == "list":
        for it in x:
            check_text(it, where)
        return
    if t == "compound":
        for k, val in x.items():
            if k not in TEXT_KEYS:
                raise PErr(f"unknown text component key '{k}' in {where}")
        if "color" in x:
            c = x["color"][1]
            if c not in COLORS and not re.fullmatch(r"#[0-9a-fA-F]{6}", c):
                raise PErr(f"bad color {c}")
        if "score" in x:
            sc_ = x["score"][1]
            ob = sc_["objective"][1]
            USED_OBJ.add(ob)
        if "extra" in x:
            check_text(x["extra"], where)
        if "click_event" in x:
            ce = x["click_event"][1]
            if ce["action"][1] in ("run_command", "suggest_command") and "command" not in ce:
                raise PErr("click_event needs 'command'")
            if "command" in ce:
                cmd = ce["command"][1].lstrip("/")
                validate_command(cmd, "click_event")
        if "hover_event" in x:
            he = x["hover_event"][1]
            if he["action"][1] == "show_text":
                check_text(he["value"], where)


def snbt_at(s, i):
    p = SNBT(s, i)
    v = p.value()
    return v, p.i


# ---------------------------------------------------------------- arguments
NUM = re.compile(r"-?(\d+\.?\d*|\.\d+)")
WORD = re.compile(r"[0-9A-Za-z_\-.+]+")
ID = re.compile(r"(#)?[a-z0-9_.\-]+(:[a-z0-9_./\-]+)?")
SEL_KEYS = {"x", "y", "z", "distance", "dx", "dy", "dz", "scores", "tag", "team", "limit", "sort", "level", "gamemode", "name",
            "x_rotation", "y_rotation", "type", "nbt", "advancements", "predicate"}
SLOTS = {"armor.head", "armor.chest", "armor.legs", "armor.feet", "weapon.mainhand", "weapon.offhand", "weapon", "armor.body"}


def tok_end(s, i):
    j = i
    while j < len(s) and s[j] != " ":
        j += 1
    return j


def balanced(s, i, o, c):
    depth = 0
    q = None
    j = i
    while j < len(s):
        ch = s[j]
        if q:
            if ch == "\\":
                j += 2; continue
            if ch == q:
                q = None
        elif ch in "\"'":
            q = ch
        elif ch == o:
            depth += 1
        elif ch == c:
            depth -= 1
            if depth == 0:
                return j + 1
        j += 1
    raise PErr("unbalanced " + o)


def parse_range(v, intonly=True):
    pat = r"-?\d+" if intonly else r"-?(\d+\.?\d*|\.\d+)"
    if not re.fullmatch(rf"({pat})?(\.\.)?({pat})?", v) or v in ("", ".."):
        raise PErr(f"bad range {v}")


def p_entity(s, i, props, ctx):
    single = props.get("amount") == "single"
    players = props.get("type") == "players"
    if s.startswith("@", i):
        if i + 1 >= len(s) or s[i + 1] not in "aeprsn":
            raise PErr("bad selector")
        kind = s[i + 1]
        j = i + 2
        args = {}
        if j < len(s) and s[j] == "[":
            e = balanced(s, j, "[", "]")
            body = s[j + 1:e - 1]
            k = 0
            while k < len(body):
                m = re.compile(r"([a-z_]+)=").match(body, k)
                if not m:
                    raise PErr(f"bad selector arg near {body[k:k+15]!r}")
                key = m.group(1)
                if key not in SEL_KEYS:
                    raise PErr(f"unknown selector key {key}")
                k = m.end()
                neg = body.startswith("!", k)
                if neg:
                    k += 1
                if body.startswith("{", k):
                    e2 = balanced(body, k, "{", "}")
                else:
                    e2 = k
                    while e2 < len(body) and body[e2] != ",":
                        e2 += 1
                val = body[k:e2]
                args.setdefault(key, []).append(val)
                if key == "type" and strip_ns(val) not in REGS["entity_type"]:
                    raise PErr(f"unknown entity type {val}")
                if key == "scores":
                    for pair in val[1:-1].split(","):
                        ob, rg = pair.split("=")
                        USED_OBJ.add(ob)
                        parse_range(rg)
                if key in ("distance",):
                    parse_range(val, False)
                if key in ("x", "y", "z", "dx", "dy", "dz") and not NUM.fullmatch(val):
                    raise PErr(f"bad number {key}={val}")
                if key == "gamemode" and val not in ("survival", "creative", "adventure", "spectator"):
                    raise PErr("bad gamemode")
                if key == "nbt":
                    snbt_at(val, 0)
                k = e2
                if k < len(body):
                    if body[k] != ",":
                        raise PErr("expected , in selector")
                    k += 1
            j = e
        lim = args.get("limit", [None])[0]
        if single and kind in "ae" and lim != "1":
            raise PErr("selector must be limited to one entity")
        if players and kind == "e" and "player" not in [strip_ns(t) for t in args.get("type", [])]:
            raise PErr("selector must be players only")
        return j
    m = WORD.match(s, i)
    if not m:
        raise PErr("bad entity")
    return m.end()


def p_score_holder(s, i, props, ctx):
    if s.startswith("*", i):
        if props.get("amount") == "single":
            raise PErr("* not allowed")
        return i + 1
    if s.startswith("@", i):
        return p_entity(s, i, {"amount": props.get("amount")}, ctx)
    j = tok_end(s, i)
    if j == i:
        raise PErr("empty score holder")
    return j


def coord(t, allow_float):
    if t.startswith("~") or t.startswith("^"):
        r = t[1:]
        if r and not NUM.fullmatch(r):
            raise PErr(f"bad coord {t}")
        return t[0]
    if not NUM.fullmatch(t):
        raise PErr(f"bad coord {t}")
    if not allow_float and "." in t:
        raise PErr(f"block pos must be int: {t}")
    return "a"


def p_coords(n, allow_float):
    def f(s, i, props, ctx):
        j = i
        kinds = []
        for k in range(n):
            e = tok_end(s, j)
            kinds.append(coord(s[j:e], allow_float))
            j = e
            if k < n - 1:
                if j >= len(s) or s[j] != " ":
                    raise PErr("missing coordinate")
                j += 1
        if "^" in kinds and any(k_ != "^" for k_ in kinds):
            raise PErr("mixed local coords")
        return j
    return f


def p_block_state(s, i, props, ctx, predicate=False):
    m = ID.match(s, i)
    if not m:
        raise PErr("bad block id")
    bid = m.group(0)
    j = m.end()
    tag = bid.startswith("#")
    if not tag and strip_ns(bid) not in BLOCKS:
        raise PErr(f"unknown block {bid}")
    if tag and not predicate:
        raise PErr("tag not allowed")
    if j < len(s) and s[j] == "[":
        e = balanced(s, j, "[", "]")
        body = s[j + 1:e - 1]
        if body and not tag:
            spec = BLOCKS[strip_ns(bid)][0]
            for pair in body.split(","):
                k, v = pair.split("=")
                if k not in spec:
                    raise PErr(f"block {bid} has no property {k}")
                if v not in spec[k]:
                    raise PErr(f"block {bid} property {k} has no value {v}")
        j = e
    if j < len(s) and s[j] == "{":
        v, j = snbt_at(s, j)
    return j


def p_block_pred(s, i, props, ctx):
    return p_block_state(s, i, props, ctx, True)


def check_components(body, predicate):
    k = 0
    comps = REGS["data_component_type"]
    while k < len(body):
        m = re.compile(r"(!)?([a-z0-9_:]+)").match(body, k)
        if not m:
            raise PErr(f"bad component list near {body[k:k+20]!r}")
        name = strip_ns(m.group(2))
        if name not in comps and not (predicate and name in ("count", "damage", "custom_data", "enchantments", "potion_contents")):
            raise PErr(f"unknown component {m.group(2)}")
        k = m.end()
        if k < len(body) and body[k] in "=~":
            k += 1
            v, k = snbt_at(body, k)
            if name in ("custom_name", "item_name"):
                check_text(v, "component")
        if k < len(body):
            if body[k] not in ",|":
                raise PErr(f"expected , in components near {body[k:k+20]!r}")
            k += 1


def p_item(s, i, props, ctx, predicate=False):
    m = ID.match(s, i)
    if not m:
        raise PErr("bad item id")
    iid = m.group(0)
    if not iid.startswith("#") and strip_ns(iid) not in REGS["item"]:
        raise PErr(f"unknown item {iid}")
    j = m.end()
    if j < len(s) and s[j] == "[":
        e = balanced(s, j, "[", "]")
        check_components(s[j + 1:e - 1], predicate)
        j = e
    return j


def p_item_pred(s, i, props, ctx):
    return p_item(s, i, props, ctx, True)


def p_text(s, i, props, ctx):
    v, j = snbt_at(s, i)
    check_text(v, ctx)
    return j


def p_snbt_compound(s, i, props, ctx):
    if not s.startswith("{", i):
        raise PErr("expected compound")
    v, j = snbt_at(s, i)
    check_entity_nbt(v, ctx)
    return j


def check_entity_nbt(v, ctx):
    t, d = v
    if t != "compound":
        return
    for key in ("CustomName",):
        if key in d:
            if d[key][0] == "str" and d[key][1].startswith("{"):
                raise PErr("CustomName must be a component, not a JSON string")
            check_text(d[key], "CustomName")
    if "text" in d:
        check_text(d["text"], "display text")
    for old in ("ArmorItems", "HandItems", "ArmorDropChances", "HandDropChances", "Attributes"):
        if old in d:
            raise PErr(f"outdated NBT key {old}")
    if "attributes" in d:
        for a in d["attributes"][1]:
            aid = strip_ns(a[1]["id"][1])
            if aid not in REGS["attribute"]:
                raise PErr(f"unknown attribute {aid}")
    if "equipment" in d:
        for slot, it in d["equipment"][1].items():
            iid = strip_ns(it[1]["id"][1])
            if iid not in REGS["item"]:
                raise PErr(f"unknown item {iid}")
    if "item" in d:
        iid = strip_ns(d["item"][1]["id"][1])
        if iid not in REGS["item"]:
            raise PErr(f"unknown item {iid}")
    if "block_state" in d:
        bid = strip_ns(d["block_state"][1]["Name"][1])
        if bid not in BLOCKS:
            raise PErr(f"unknown block {bid}")
    if "Tags" in d:
        for tg in d["Tags"][1]:
            if tg[1] == "hw.mob":
                pass


def p_snbt_any(s, i, props, ctx):
    v, j = snbt_at(s, i)
    return j


def p_nbt_path(s, i, props, ctx):
    j = i
    while j < len(s) and s[j] != " ":
        if s[j] == "{":
            j = balanced(s, j, "{", "}")
        elif s[j] == "[":
            j = balanced(s, j, "[", "]")
        else:
            j += 1
    return j


def p_word_set(options):
    def f(s, i, props, ctx):
        j = tok_end(s, i)
        if s[i:j] not in options:
            raise PErr(f"expected one of {sorted(options)[:8]}, got {s[i:j]!r}")
        return j
    return f


def p_objective(s, i, props, ctx):
    j = tok_end(s, i)
    USED_OBJ.add(s[i:j])
    if not re.fullmatch(r"[A-Za-z0-9_.\-+]+", s[i:j]):
        raise PErr("bad objective")
    return j


def p_criteria(s, i, props, ctx):
    j = tok_end(s, i)
    c = s[i:j]
    if c in ("dummy", "deathCount", "trigger", "playerKillCount", "totalKillCount", "health", "xp", "level", "food", "air", "armor"):
        return j
    m = re.fullmatch(r"minecraft\.(custom|killed|killed_by|used|mined|crafted|picked_up|dropped|broken):minecraft\.([a-z0-9_]+)", c)
    if not m:
        raise PErr(f"bad criteria {c}")
    reg = {"custom": "custom_stat", "killed": "entity_type", "killed_by": "entity_type"}.get(m.group(1), "item")
    if m.group(2) not in REGS[reg]:
        raise PErr(f"unknown criteria id {c}")
    return j


def p_particle(s, i, props, ctx):
    m = ID.match(s, i)
    pid = strip_ns(m.group(0))
    if pid not in REGS["particle_type"]:
        raise PErr(f"unknown particle {pid}")
    j = m.end()
    if pid in ("block", "dust", "item", "falling_dust", "block_marker", "dust_color_transition", "entity_effect", "vibration", "trail"):
        if j >= len(s) or s[j] != "{":
            raise PErr(f"particle {pid} needs options")
    if j < len(s) and s[j] == "{":
        v, j = snbt_at(s, j)
        if pid == "block":
            bs = v[1]["block_state"]
            if bs[0] != "compound" or strip_ns(bs[1]["Name"][1]) not in BLOCKS:
                raise PErr("bad block particle")
    return j


REGMAP = {"minecraft:mob_effect": "mob_effect", "minecraft:entity_type": "entity_type", "minecraft:attribute": "attribute",
          "minecraft:worldgen/biome": "worldgen/biome", "minecraft:damage_type": "damage_type"}


def p_resource(s, i, props, ctx):
    m = ID.match(s, i)
    if not m:
        raise PErr("bad id")
    reg = props.get("registry")
    rid = strip_ns(m.group(0))
    key = reg.replace("minecraft:", "") if reg else None
    if key in REGS and rid not in REGS[key]:
        raise PErr(f"unknown {key} {rid}")
    return m.end()


def p_resloc(s, i, props, ctx):
    m = ID.match(s, i)
    if not m:
        raise PErr("bad id")
    if ctx.get("argname") == "sound" and strip_ns(m.group(0)) not in REGS["sound_event"]:
        raise PErr(f"unknown sound {m.group(0)}")
    return m.end()


def p_function(s, i, props, ctx):
    m = ID.match(s, i)
    fid = m.group(0)
    if not fid.startswith("#") and fid not in FUNCS:
        raise PErr(f"unknown function {fid}")
    return m.end()


def p_time(s, i, props, ctx):
    j = tok_end(s, i)
    if not re.fullmatch(r"\d+(\.\d+)?[dst]?", s[i:j]):
        raise PErr("bad time")
    return j


def p_num(kind):
    def f(s, i, props, ctx):
        j = tok_end(s, i)
        t = s[i:j]
        if kind == "int":
            if not re.fullmatch(r"-?\d+", t):
                raise PErr(f"expected int got {t!r}")
            v = int(t)
        else:
            if not NUM.fullmatch(t):
                raise PErr(f"expected number got {t!r}")
            v = float(t)
        if "min" in props and v < props["min"]:
            raise PErr(f"{v} below min {props['min']}")
        if "max" in props and v > props["max"]:
            raise PErr(f"{v} above max {props['max']}")
        return j
    return f


def p_string(s, i, props, ctx):
    t = props.get("type")
    if t == "greedy":
        return len(s)
    if t == "phrase" and s[i] in "\"'":
        return balanced_quote(s, i)
    m = WORD.match(s, i)
    if not m:
        raise PErr("bad word")
    return m.end()


def balanced_quote(s, i):
    p = SNBT(s, i); p.qstr(); return p.i


def p_range(intonly):
    def f(s, i, props, ctx):
        j = tok_end(s, i)
        parse_range(s[i:j], intonly)
        return j
    return f


def p_rest(s, i, props, ctx):
    return len(s)


def p_token(s, i, props, ctx):
    j = tok_end(s, i)
    if j == i:
        raise PErr("empty")
    return j


def p_dialog(s, i, props, ctx):
    if s.startswith("{", i):
        v, j = snbt_at(s, i)
        d = v[1]
        if strip_ns(d["type"][1]) not in REGS["dialog_type"]:
            raise PErr("bad dialog type")
        check_text(d["title"], "dialog")
        for bd in d.get("body", ("list", []))[1]:
            if strip_ns(bd[1]["type"][1]) not in REGS["dialog_body_type"]:
                raise PErr("bad dialog body")
            check_text(bd[1]["contents"], "dialog body")
        return j
    return p_token(s, i, props, ctx)


PARSERS = {
    "brigadier:bool": p_word_set({"true", "false"}),
    "brigadier:integer": p_num("int"), "brigadier:float": p_num("float"), "brigadier:double": p_num("float"),
    "brigadier:string": p_string,
    "minecraft:entity": p_entity, "minecraft:score_holder": p_score_holder, "minecraft:game_profile": p_entity,
    "minecraft:block_pos": p_coords(3, False), "minecraft:vec3": p_coords(3, True), "minecraft:vec2": p_coords(2, True),
    "minecraft:rotation": p_coords(2, True), "minecraft:column_pos": p_coords(2, False),
    "minecraft:block_state": p_block_state, "minecraft:block_predicate": p_block_pred,
    "minecraft:item_stack": p_item, "minecraft:item_predicate": p_item_pred,
    "minecraft:component": p_text, "minecraft:nbt_compound_tag": p_snbt_compound, "minecraft:nbt_tag": p_snbt_any,
    "minecraft:nbt_path": p_nbt_path, "minecraft:objective": p_objective, "minecraft:objective_criteria": p_criteria,
    "minecraft:operation": p_word_set({"=", "+=", "-=", "*=", "/=", "%=", "<", ">", "><"}),
    "minecraft:particle": p_particle, "minecraft:resource": p_resource, "minecraft:resource_key": p_resource,
    "minecraft:resource_or_tag": p_resource, "minecraft:resource_location": p_resloc, "minecraft:function": p_function,
    "minecraft:time": p_time, "minecraft:int_range": p_range(True), "minecraft:float_range": p_range(False),
    "minecraft:entity_anchor": p_word_set({"eyes", "feet"}), "minecraft:swizzle": p_word_set({"x", "y", "z", "xy", "xz", "yz", "xyz"}),
    "minecraft:gamemode": p_word_set({"survival", "creative", "adventure", "spectator"}),
    "minecraft:heightmap": p_word_set({"world_surface", "motion_blocking", "motion_blocking_no_leaves", "ocean_floor"}),
    "minecraft:template_rotation": p_word_set({"none", "clockwise_90", "counterclockwise_90", "180"}),
    "minecraft:template_mirror": p_word_set({"none", "left_right", "front_back"}),
    "minecraft:message": p_rest, "minecraft:dialog": p_dialog,
    "minecraft:scoreboard_slot": p_token, "minecraft:item_slot": p_word_set(SLOTS), "minecraft:item_slots": p_token,
    "minecraft:team": p_token, "minecraft:team_color": p_token, "minecraft:hex_color": p_token, "minecraft:uuid": p_token,
    "minecraft:style": p_snbt_any, "minecraft:dimension": p_resloc, "minecraft:loot_table": p_token,
    "minecraft:loot_predicate": p_token, "minecraft:loot_modifier": p_token, "minecraft:resource_selector": p_token,
}
ROOT = TREE
NAMED = TREE["children"]


def resolve(node):
    if "redirect" in node:
        r = node["redirect"]
        return ROOT if not r else NAMED[r[0]] if len(r) == 1 else ROOT
    return node


def walk(s, i, node, depth=0):
    """returns True if s[i:] parses from node; raises PErr with deepest message otherwise"""
    errs = []
    if i >= len(s):
        if node.get("executable"):
            return True
        raise PErr("incomplete command")
    kids = node.get("children")
    if not kids and node.get("type") == "literal" and "redirect" not in node and not node.get("executable"):
        kids = ROOT["children"]
    if not kids:
        raise PErr(f"unexpected trailing text {s[i:i+30]!r}")
    # literals first
    word_end = tok_end(s, i)
    word = s[i:word_end]
    for name, ch in kids.items():
        if ch["type"] == "literal" and name == word:
            try:
                return advance(s, word_end, ch, depth)
            except PErr as e:
                errs.append(e)
                if errs:
                    raise
    for name, ch in kids.items():
        if ch["type"] != "argument":
            continue
        p = PARSERS.get(ch["parser"])
        if p is None:
            raise PErr("no parser " + ch["parser"])
        try:
            j = p(s, i, ch.get("properties", {}), {"argname": name})
        except (PErr, KeyError, IndexError, ValueError) as e:
            errs.append(PErr(f"{name}: {e}"))
            continue
        try:
            return advance(s, j, ch, depth)
        except PErr as e:
            errs.append(e)
    if errs:
        raise errs[-1]
    raise PErr(f"no match for {word!r}")


def advance(s, j, ch, depth):
    if j >= len(s):
        if ch.get("executable"):
            return True
        node = resolve(ch)
        if node is not ch and node.get("executable"):
            return True
        raise PErr("incomplete command")
    if s[j] != " ":
        raise PErr(f"expected space at {s[j:j+20]!r}")
    nxt = resolve(ch)
    return walk(s, j + 1, nxt, depth + 1)


def validate_command(c, where):
    walk(c, 0, ROOT)


MACRO_SAMPLE = {"x": "-60", "y": "66", "z": "4"}
errors = 0
count = 0
for f in sorted(FUNCS):
    path = os.path.join(FDIR, f.split(":")[1] + ".mcfunction")
    for ln, line in enumerate(open(path, encoding="utf-8"), 1):
        line = line.rstrip("\n")
        if not line.strip() or line.startswith("#"):
            continue
        if line.startswith("$"):
            line = re.sub(r"\$\(([a-z]+)\)", lambda m: MACRO_SAMPLE[m.group(1)], line[1:])
        count += 1
        try:
            validate_command(line, f)
        except PErr as e:
            errors += 1
            if errors < 60:
                print(f"{f}:{ln}: {e}\n    {line[:220]}")
missing = USED_OBJ - OBJS - {"hw.st"}
print(f"checked {count} commands, {errors} errors")
print("objectives used but not defined:", missing)
print("objectives defined but unused:", OBJS - USED_OBJ)
