"""BlockMotion - マイクラ風 3D アニメーションを Blender で自動生成するデスクトップアプリ。

PC にインストールされた Blender をバックグラウンドで動かし、
キャラクター（スキン・モーション）、カメラのカット割り、背景（マイクラのワールドも可）、
字幕などの設定から .blend と動画を書き出す。
"""
import copy
import gzip
import json
import os
import queue
import re
import shutil
import struct
import subprocess
import sys
import threading
import tkinter as tk
from tkinter import colorchooser, filedialog, messagebox, ttk

try:
    from PIL import Image, ImageTk
except ImportError:  # the preview pictures are optional
    Image = ImageTk = None

APP_NAME = "BlockMotion"
VERSION = "2.1.0"


def resource_dir():
    if getattr(sys, "frozen", False):
        return getattr(sys, "_MEIPASS", os.path.dirname(sys.executable))
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


RES = resource_dir()
SCRIPT = os.path.join(RES, "blender", "generate.py")
ASSETS = os.path.join(RES, "assets")
sys.path.insert(0, os.path.join(RES, "blender"))
import bm_motions  # noqa: E402  (pure Python, shared with the Blender side)

if os.name == "nt":
    CONF_DIR = os.path.join(os.environ.get("APPDATA", os.path.expanduser("~")), APP_NAME)
else:
    CONF_DIR = os.path.join(os.path.expanduser("~"), ".config", APP_NAME)
CONF = os.path.join(CONF_DIR, "settings.json")
import bm_i18n  # noqa: E402
bm_i18n.init(CONF)
T = bm_i18n.T

MOTION_LABEL = {m[0]: T(m[1]) for m in bm_motions.MOTION_INFO}
MOTION_CATS = []
for _mid, _label, _cat in bm_motions.MOTION_INFO:
    if _cat not in MOTION_CATS:
        MOTION_CATS.append(_cat)
ITEMS = [
    ("none", T("なし")), ("iron_sword", T("鉄の剣")), ("diamond_sword", T("ダイヤの剣")),
    ("iron_pickaxe", T("鉄のツルハシ")), ("diamond_pickaxe", T("ダイヤのツルハシ")),
    ("iron_axe", T("鉄の斧")), ("iron_shovel", T("鉄のシャベル")), ("torch", T("松明")), ("bow", T("弓")),
]
BACKGROUNDS = [
    ("grass", T("草原")), ("desert", T("砂漠")), ("snow", T("雪原")), ("cave", T("洞窟")), ("nether", T("ネザー")),
    ("end", T("エンド")), ("world", T("マイクラのワールドを読み込む")), ("studio", T("スタジオ（単色）")),
    ("greenscreen", T("グリーンバック")), ("transparent", T("透過（PNG連番）")),
]
TIMES = [("day", T("昼")), ("sunset", T("夕焼け")), ("night", T("夜"))]
WEATHERS = [("clear", T("晴れ")), ("rain", T("雨")), ("snow", T("雪"))]
DIMENSIONS = [("overworld", T("オーバーワールド")), ("nether", T("ネザー")), ("end", T("エンド"))]
CAMERAS = [
    ("diagonal", T("ななめ前")), ("front", T("正面")), ("side", T("真横")), ("back", T("後ろ")),
    ("closeup", T("アップ")), ("low", T("ローアングル")), ("high", T("見下ろし")), ("wide", T("遠景")),
    ("top", T("真上")), ("orbit", T("ぐるっと回る")), ("dolly_in", T("ズームイン")), ("dolly_out", T("ズームアウト")),
    ("crane", T("上昇（クレーン）")), ("track", T("横移動")), ("pov", T("主観（目線）")), ("over_shoulder", T("肩越し")),
]
FACINGS = [(0, T("南")), (90, T("西")), (180, T("北")), (-90, T("東"))]
RESOLUTIONS = [
    ("横長 1920×1080（YouTube）", (1920, 1080)),
    ("縦長 1080×1920（TikTok・ショート）", (1080, 1920)),
    ("正方形 1080×1080", (1080, 1080)),
    ("横長 1280×720（軽い）", (1280, 720)),
    ("横長 3840×2160（4K）", (3840, 2160)),
]
ENGINES = [
    ("eevee", T("標準（EEVEE・速い）")), ("cycles", T("高画質（Cycles・遅い）")), ("workbench", T("下書き（Workbench・最速）")),
]
ARMS = [("auto", T("自動判定")), ("classic", T("通常（Steve 型）")), ("slim", T("細め（Alex 型）"))]

DEFAULT_ACTOR = {"skin": "", "arms": "auto", "item": "none", "x": 0.0, "z": 0.0, "yaw": 0.0, "move": True,
                 "motions": [["walk", 4.0], ["wave", 3.0]]}
DEFAULT_PROJECT = {
    "actors": [copy.deepcopy(DEFAULT_ACTOR)],
    "shots": [],
    "camera": "diagonal", "follow": True, "zoom": 1.0, "dof": False,
    "background": "grass", "bg_color": [0.85, 0.87, 0.9], "time": "day", "weather": "clear",
    "world": {"path": "", "dimension": "overworld", "x": 0.0, "y": 64.0, "z": 0.0,
              "radius": 32, "down": 16, "up": 40, "client_jar": "", "resource_pack": ""},
    "title": "", "title_seconds": 2.5, "letterbox": False, "subtitles": [],
    "resolution": RESOLUTIONS[0][0], "fps": 30, "engine": "eevee", "samples": 32,
    "output_dir": os.path.join(os.path.expanduser("~"), "Videos", APP_NAME),
    "name": "minecraft_anim",
}


# --------------------------------------------------------------------------
# Blender / Minecraft discovery
# --------------------------------------------------------------------------
def _version_key(path):
    m = re.search(r"(\d+)\.(\d+)", path)
    return (int(m.group(1)), int(m.group(2))) if m else (0, 0)


def find_blender():
    cands = []
    if os.name == "nt":
        roots = [os.environ.get("ProgramFiles", r"C:\Program Files"),
                 os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)"),
                 os.path.join(os.environ.get("LOCALAPPDATA", ""), "Programs")]
        for root in roots:
            base = os.path.join(root, "Blender Foundation")
            if os.path.isdir(base):
                for d in os.listdir(base):
                    exe = os.path.join(base, d, "blender.exe")
                    if os.path.isfile(exe):
                        cands.append(exe)
        for steam in (r"C:\Program Files (x86)\Steam\steamapps\common\Blender\blender.exe",
                      r"C:\Program Files\Steam\steamapps\common\Blender\blender.exe"):
            if os.path.isfile(steam):
                cands.append(steam)
        wa = os.path.join(os.environ.get("ProgramFiles", r"C:\Program Files"), "WindowsApps")
        try:
            for d in os.listdir(wa):
                if d.startswith("BlenderFoundation.Blender"):
                    exe = os.path.join(wa, d, "Blender", "blender.exe")
                    if os.path.isfile(exe):
                        cands.append(exe)
        except OSError:
            pass
    elif sys.platform == "darwin":
        exe = "/Applications/Blender.app/Contents/MacOS/Blender"
        if os.path.isfile(exe):
            cands.append(exe)
    w = shutil.which("blender")
    if w:
        cands.append(w)
    cands.sort(key=_version_key, reverse=True)
    return cands[0] if cands else ""


def find_client_jar():
    appdata = os.environ.get("APPDATA", "")
    home = os.path.expanduser("~")
    roots = [os.path.join(appdata, ".minecraft", "versions"), os.path.join(home, ".minecraft", "versions")]
    for launcher in ("PrismLauncher", "MultiMC", "PolyMC"):
        roots.append(os.path.join(appdata, launcher, "libraries", "com", "mojang", "minecraft"))
    found = []
    for r in roots:
        if not os.path.isdir(r):
            continue
        for d in os.listdir(r):
            sub = os.path.join(r, d)
            if os.path.isdir(sub):
                for f in os.listdir(sub):
                    if f.endswith(".jar") and ("client" in f or f == d + ".jar"):
                        found.append(os.path.join(sub, f))
    found.sort(key=os.path.getmtime, reverse=True)
    return found[0] if found else ""


def find_saves():
    appdata = os.environ.get("APPDATA", "")
    for p in (os.path.join(appdata, ".minecraft", "saves"), os.path.join(os.path.expanduser("~"), ".minecraft", "saves")):
        if os.path.isdir(p):
            return p
    return os.path.expanduser("~")


def read_player_pos(world_dir):
    """Single-player position from level.dat (Data.Player.Pos / Rotation), or None."""
    p = os.path.join(world_dir, "level.dat")
    if not os.path.isfile(p):
        return None
    data = gzip.open(p).read()
    i = [0]

    def rd(fmt, n):
        v = struct.unpack_from(fmt, data, i[0])[0]
        i[0] += n
        return v

    def string():
        n = rd(">H", 2)
        s = data[i[0]:i[0] + n].decode("utf-8", "replace")
        i[0] += n
        return s

    def payload(t):
        sizes = {1: (">b", 1), 2: (">h", 2), 3: (">i", 4), 4: (">q", 8), 5: (">f", 4), 6: (">d", 8)}
        if t in sizes:
            return rd(*sizes[t])
        if t == 7:
            n = rd(">i", 4); i[0] += n; return None
        if t == 8:
            return string()
        if t == 9:
            et = rd(">b", 1); n = rd(">i", 4)
            return [payload(et) for _ in range(n)]
        if t == 10:
            out = {}
            while True:
                tt = rd(">b", 1)
                if tt == 0:
                    return out
                name = string()
                out[name] = payload(tt)
        if t == 11:
            n = rd(">i", 4); i[0] += 4 * n; return None
        if t == 12:
            n = rd(">i", 4); i[0] += 8 * n; return None
        raise ValueError(t)
    t = rd(">b", 1)
    string()
    root = payload(t)
    pl = root.get("Data", {}).get("Player")
    if not pl or "Pos" not in pl:
        return None
    x, y, z = pl["Pos"]
    yaw = (pl.get("Rotation") or [0, 0])[0]
    dim = str(pl.get("Dimension", "minecraft:overworld"))
    dim = "nether" if "nether" in dim else "end" if "end" in dim else "overworld"
    return x, y, z, yaw, dim


# --------------------------------------------------------------------------
# skin preview (front view drawn from the skin layout)
# --------------------------------------------------------------------------
def skin_front(path, arms="auto", scale=6):
    im = Image.open(path).convert("RGBA")
    w, h = im.size
    if w != 64:
        im = im.resize((64, 64 * h // w), Image.NEAREST)
    legacy = im.size[1] == 32
    if arms == "auto":
        arms = "classic"
        if not legacy and im.getpixel((54, 20))[3] == 0 and im.getpixel((55, 31))[3] == 0:
            arms = "slim"
    aw = 3 if arms == "slim" else 4
    out = Image.new("RGBA", (16, 32), (0, 0, 0, 0))

    def put(src, dst):
        x, y, cw, ch = src
        out.alpha_composite(im.crop((x, y, x + cw, y + ch)), dst)

    put((8, 8, 8, 8), (4, 0))
    put((20, 20, 8, 12), (4, 8))
    put((44, 20, aw, 12), (4 - aw, 8))
    put((4, 20, 4, 12), (4, 20))
    if legacy:
        put((44, 20, aw, 12), (12, 8))
        put((4, 20, 4, 12), (8, 20))
    else:
        put((36, 52, aw, 12), (12, 8))
        put((20, 52, 4, 12), (8, 20))
        put((20, 36, 8, 12), (4, 8))
        put((44, 36, aw, 12), (4 - aw, 8))
        put((52, 52, aw, 12), (12, 8))
        put((4, 36, 4, 12), (4, 20))
        put((4, 52, 4, 12), (8, 20))
    put((40, 8, 8, 8), (4, 0))
    return out.resize((16 * scale, 32 * scale), Image.NEAREST), arms


# --------------------------------------------------------------------------
# small widgets
# --------------------------------------------------------------------------
class Choice(ttk.Combobox):
    """Read-only combobox showing labels for (key, label) pairs."""

    def __init__(self, parent, pairs, on_change=None, width=None, **kw):
        super().__init__(parent, values=[p[1] for p in pairs], state="readonly", width=width, **kw)
        self.pairs = list(pairs)
        self.on_change = on_change
        self.bind("<<ComboboxSelected>>", lambda e: on_change and on_change())

    def get_key(self):
        i = self.current()
        return self.pairs[i][0] if i >= 0 else self.pairs[0][0]

    def set_key(self, key):
        for i, (k, _) in enumerate(self.pairs):
            if k == key:
                self.current(i)
                return
        self.current(0)

    def set_pairs(self, pairs):
        key = self.get_key() if self.current() >= 0 else None
        self.pairs = list(pairs)
        self.config(values=[p[1] for p in pairs])
        if key is not None:
            self.set_key(key)


def num(var, default=0.0):
    try:
        return float(var.get())
    except (tk.TclError, ValueError):
        return default


# --------------------------------------------------------------------------
# main window
# --------------------------------------------------------------------------
class App(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title(T("{app} {ver} - マイクラ3Dアニメ自動生成").format(app=APP_NAME, ver=VERSION))
        self.geometry("1360x900")
        self.minsize(1000, 640)
        try:
            self._icon = tk.PhotoImage(file=os.path.join(ASSETS, "icon.png"))
            self.iconphoto(True, self._icon)
        except tk.TclError:
            pass
        self.settings = self.load_settings()
        self.project = self.settings["project"]
        self.project_path = None
        self.cur_actor = 0
        self.proc = None
        self.q = queue.Queue()
        self.last_files = {}
        self._photo = None
        self._preview_photo = None
        self._loading = False
        self.setup_style()
        self.build()
        self.load_project_into_ui()
        self.after(100, self.poll)
        self.protocol("WM_DELETE_WINDOW", self.on_close)

    # ---------------- settings
    def load_settings(self):
        s = {"blender": "", "project": copy.deepcopy(DEFAULT_PROJECT)}
        try:
            with open(CONF, encoding="utf-8") as f:
                saved = json.load(f)
            s["blender"] = saved.get("blender", "")
            if "project" in saved:
                s["project"] = self.migrate(saved["project"])
            elif "sequence" in saved:  # settings from 1.0
                p = s["project"]
                a = p["actors"][0]
                a.update(skin=saved.get("skin", ""), arms=saved.get("arms", "auto"), item=saved.get("item", "none"),
                         move=saved.get("move", True), motions=saved.get("sequence", a["motions"]))
                for k in ("camera", "follow", "zoom", "bg_color", "resolution", "fps", "engine", "samples",
                          "output_dir", "name"):
                    if k in saved:
                        p[k] = saved[k]
                bg = saved.get("background", "grass")
                p["background"], p["time"] = ("grass", "night") if bg == "night" else (bg, "day")
        except (OSError, ValueError):
            pass
        if not s["blender"] or not os.path.isfile(s["blender"]):
            s["blender"] = find_blender()
        return s

    @staticmethod
    def migrate(p):
        out = copy.deepcopy(DEFAULT_PROJECT)
        out.update({k: v for k, v in p.items() if k in out})
        out["world"] = dict(DEFAULT_PROJECT["world"], **(p.get("world") or {}))
        out["actors"] = [dict(copy.deepcopy(DEFAULT_ACTOR), **a) for a in (p.get("actors") or [])] or \
            [copy.deepcopy(DEFAULT_ACTOR)]
        return out

    def save_settings(self):
        try:
            os.makedirs(CONF_DIR, exist_ok=True)
            self.collect()
            with open(CONF, "w", encoding="utf-8") as f:
                json.dump({"blender": self.v_blender.get().strip(), "lang": bm_i18n.LANG, "project": self.project}, f,
                          ensure_ascii=False, indent=2)
        except OSError:
            pass

    # ---------------- layout
    def setup_style(self):
        st = ttk.Style(self)
        if "vista" in st.theme_names():
            st.theme_use("vista")
        elif "clam" in st.theme_names():
            st.theme_use("clam")
        font = ("Yu Gothic UI", 10) if os.name == "nt" else ("Noto Sans CJK JP", 10)
        self.option_add("*Font", font)
        st.configure(".", font=font)
        st.configure("Big.TButton", font=(font[0], 12, "bold"), padding=8)
        st.configure("Treeview", rowheight=24)

    def build(self):
        menubar = tk.Menu(self)
        fm = tk.Menu(menubar, tearoff=0)
        fm.add_command(label=T("新しいプロジェクト"), command=self.new_project)
        fm.add_command(label=T("プロジェクトを開く…"), command=self.open_project)
        fm.add_command(label=T("プロジェクトを保存…"), command=self.save_project)
        fm.add_separator()
        fm.add_command(label=T("終了"), command=self.on_close)
        menubar.add_cascade(label=T("ファイル"), menu=fm)
        lm = tk.Menu(menubar, tearoff=0)
        self.v_lang = tk.StringVar(value=bm_i18n.LANG)
        for code, label in (("ja", "日本語"), ("en", "English")):
            lm.add_radiobutton(label=label, value=code, variable=self.v_lang, command=self.change_lang)
        menubar.add_cascade(label=T("言語 / Language"), menu=lm)
        self.config(menu=menubar)

        root = ttk.Frame(self, padding=8)
        root.pack(fill="both", expand=True)
        root.columnconfigure(0, weight=3)
        root.columnconfigure(1, weight=2)
        root.rowconfigure(1, weight=1)

        top = ttk.Frame(root)
        top.grid(row=0, column=0, columnspan=2, sticky="ew", pady=(0, 6))
        ttk.Label(top, text="Blender:").pack(side="left")
        self.v_blender = tk.StringVar(value=self.settings["blender"])
        ttk.Entry(top, textvariable=self.v_blender).pack(side="left", fill="x", expand=True, padx=6)
        ttk.Button(top, text=T("参照…"), command=self.pick_blender).pack(side="left")
        ttk.Button(top, text=T("自動検出"), command=self.detect_blender).pack(side="left", padx=(6, 0))

        self.nb = ttk.Notebook(root)
        self.nb.grid(row=1, column=0, sticky="nsew", padx=(0, 8))
        self.build_actor_tab()
        self.build_camera_tab()
        self.build_background_tab()
        self.build_effects_tab()
        self.build_output_tab()

        right = ttk.Frame(root)
        right.grid(row=1, column=1, sticky="nsew")
        right.rowconfigure(0, weight=3)
        right.rowconfigure(1, weight=2)
        right.columnconfigure(0, weight=1)
        pv = ttk.LabelFrame(right, text=T("プレビュー"), padding=6)
        pv.grid(row=0, column=0, sticky="nsew")
        self.preview = tk.Label(pv, text=T("「プレビュー」で 1 コマだけ描いて確認できます\n（再生リストで選んだ行のあたりを描きます）"),
                                bg="#2b2f36", fg="#cfd6e0")
        self.preview.pack(fill="both", expand=True)
        lf = ttk.LabelFrame(right, text=T("ログ"), padding=4)
        lf.grid(row=1, column=0, sticky="nsew", pady=(8, 0))
        self.log = tk.Text(lf, height=5, bg="#1e2127", fg="#c8d0da", insertbackground="#fff", relief="flat", wrap="char")
        self.log.pack(fill="both", expand=True)
        self.pb = ttk.Progressbar(right, mode="determinate")
        self.pb.grid(row=2, column=0, sticky="ew", pady=(6, 0))

        bot = ttk.Frame(root)
        bot.grid(row=2, column=0, columnspan=2, sticky="ew", pady=(8, 0))
        bot.columnconfigure(4, weight=1)
        self.btn_preview = ttk.Button(bot, text=T("プレビュー"), command=lambda: self.start(preview=True))
        self.btn_preview.grid(row=0, column=0)
        self.btn_go = ttk.Button(bot, text=T("▶ アニメを生成"), style="Big.TButton", command=self.start)
        self.btn_go.grid(row=0, column=1, padx=8)
        self.btn_stop = ttk.Button(bot, text=T("停止"), command=self.stop, state="disabled")
        self.btn_stop.grid(row=0, column=2)
        ttk.Button(bot, text=T("保存先を開く"), command=self.open_out).grid(row=0, column=3, padx=8)
        self.lbl_status = ttk.Label(bot, text=T("準備OK"), width=1)
        self.lbl_status.grid(row=0, column=4, sticky="ew", padx=8)
        self.btn_video = ttk.Button(bot, text=T("動画を再生"), command=lambda: self.open_last("video"), state="disabled")
        self.btn_video.grid(row=0, column=5)
        self.btn_blend = ttk.Button(bot, text=T("Blender で開く"), command=self.open_blend, state="disabled")
        self.btn_blend.grid(row=0, column=6, padx=(8, 0))

    # ---------------- tab: actors
    def build_actor_tab(self):
        tab = ttk.Frame(self.nb, padding=8)
        self.nb.add(tab, text=T("① キャラクター"))
        tab.columnconfigure(2, weight=1)
        tab.rowconfigure(0, weight=1)

        left = ttk.Frame(tab)
        left.grid(row=0, column=0, sticky="ns", padx=(0, 8))
        ttk.Label(left, text=T("出演者")).pack(anchor="w")
        self.lb_actors = tk.Listbox(left, height=8, width=16, exportselection=False, activestyle="none")
        self.lb_actors.pack(fill="y")
        self.lb_actors.bind("<<ListboxSelect>>", lambda e: self.select_actor())
        ttk.Button(left, text=T("＋ 追加"), command=self.add_actor).pack(fill="x", pady=(6, 2))
        ttk.Button(left, text=T("複製"), command=self.dup_actor).pack(fill="x", pady=2)
        ttk.Button(left, text=T("削除"), command=self.remove_actor).pack(fill="x", pady=2)

        mid = ttk.Frame(tab)
        mid.grid(row=0, column=1, sticky="ns", padx=(0, 8))
        self.skin_canvas = tk.Canvas(mid, width=130, height=150, bg="#2b2f36", highlightthickness=0)
        self.skin_canvas.pack()
        ttk.Button(mid, text=T("スキン画像を選ぶ…"), command=self.pick_skin).pack(fill="x", pady=(6, 0))
        self.lbl_skin = ttk.Label(mid, text="", wraplength=160)
        self.lbl_skin.pack(fill="x", pady=2)
        ttk.Label(mid, text=T("腕の太さ")).pack(anchor="w", pady=(4, 0))
        self.c_arms = Choice(mid, ARMS, self.on_actor_field, width=16)
        self.c_arms.pack(fill="x")
        ttk.Label(mid, text=T("持ち物")).pack(anchor="w", pady=(6, 0))
        self.c_item = Choice(mid, ITEMS, self.on_actor_field, width=16)
        self.c_item.pack(fill="x")
        pos = ttk.LabelFrame(mid, text=T("立ち位置（ブロック）"), padding=4)
        pos.pack(fill="x", pady=(8, 0))
        self.v_ax, self.v_az, self.v_ayaw = tk.DoubleVar(), tk.DoubleVar(), tk.DoubleVar()
        for r, (lab, var) in enumerate(((T("X（東+）"), self.v_ax), (T("Z（南+）"), self.v_az))):
            ttk.Label(pos, text=lab).grid(row=r, column=0, sticky="w")
            sp = ttk.Spinbox(pos, from_=-500, to=500, increment=0.5, textvariable=var, width=7, command=self.on_actor_field)
            sp.grid(row=r, column=1, sticky="w", padx=4, pady=1)
            sp.bind("<FocusOut>", lambda e: self.on_actor_field())
        ttk.Label(pos, text=T("向き")).grid(row=2, column=0, sticky="w")
        self.c_face = Choice(pos, [(str(a), l) for a, l in FACINGS], self.on_facing, width=5)
        self.c_face.grid(row=2, column=1, sticky="w", padx=4)
        sp = ttk.Spinbox(pos, from_=-180, to=180, increment=15, textvariable=self.v_ayaw, width=7, command=self.on_actor_field)
        sp.grid(row=3, column=1, sticky="w", padx=4, pady=1)
        sp.bind("<FocusOut>", lambda e: self.on_actor_field())
        ttk.Label(pos, text=T("角度°")).grid(row=3, column=0, sticky="w")
        self.v_amove = tk.BooleanVar()
        ttk.Checkbutton(mid, text=T("歩く・走るで前に進む"), variable=self.v_amove, command=self.on_actor_field).pack(anchor="w", pady=(6, 0))

        right = ttk.Frame(tab)
        right.grid(row=0, column=2, sticky="nsew")
        right.columnconfigure(0, weight=1)
        right.columnconfigure(2, weight=1, minsize=170)
        right.rowconfigure(1, weight=1)
        ttk.Label(right, text=T("モーション（{n}種類）").format(n=len(bm_motions.MOTION_INFO))).grid(row=0, column=0, sticky="w")
        ttk.Label(right, text=T("再生リスト")).grid(row=0, column=2, sticky="w")
        fr = ttk.Frame(right)
        fr.grid(row=1, column=0, sticky="nsew")
        self.tv_all = ttk.Treeview(fr, show="tree", selectmode="browse")
        sb = ttk.Scrollbar(fr, orient="vertical", command=self.tv_all.yview)
        self.tv_all.configure(yscrollcommand=sb.set)
        self.tv_all.pack(side="left", fill="both", expand=True)
        sb.pack(side="right", fill="y")
        for cat in MOTION_CATS:
            node = self.tv_all.insert("", "end", text=T(cat, "Turning" if cat == "向き" else None), open=cat in ("移動", "基本", "気持ち"))
            for mid_, label, c in bm_motions.MOTION_INFO:
                if c == cat:
                    self.tv_all.insert(node, "end", iid="m_" + mid_, text=MOTION_LABEL[mid_])
        self.tv_all.bind("<Double-Button-1>", lambda e: self.add_motion())
        btns = ttk.Frame(right)
        btns.grid(row=1, column=1, padx=6)
        ttk.Button(btns, text=T("追加 →"), width=8, command=self.add_motion).pack(pady=2)
        ttk.Button(btns, text="↑", width=8, command=lambda: self.move_row(self.tv_seq, -1, self.save_actor_seq)).pack(pady=(14, 2))
        ttk.Button(btns, text="↓", width=8, command=lambda: self.move_row(self.tv_seq, 1, self.save_actor_seq)).pack(pady=2)
        ttk.Button(btns, text=T("削除"), width=8, command=lambda: self.del_rows(self.tv_seq, self.save_actor_seq)).pack(pady=(14, 2))
        ttk.Button(btns, text=T("全消去"), width=8, command=lambda: self.clear_rows(self.tv_seq, self.save_actor_seq)).pack(pady=2)
        self.tv_seq = ttk.Treeview(right, columns=("motion", "sec"), show="headings", selectmode="browse")
        self.tv_seq.heading("motion", text=T("モーション"))
        self.tv_seq.heading("sec", text=T("秒数"))
        self.tv_seq.column("motion", width=110)
        self.tv_seq.column("sec", width=50, anchor="center", stretch=False)
        self.tv_seq.grid(row=1, column=2, sticky="nsew")
        self.tv_seq.bind("<<TreeviewSelect>>", self.on_seq_select)
        row = ttk.Frame(right)
        row.grid(row=2, column=2, sticky="ew", pady=(6, 0))
        ttk.Label(row, text=T("選んだ行の秒数")).pack(side="left")
        self.v_sec = tk.DoubleVar(value=3.0)
        sp = ttk.Spinbox(row, from_=0.2, to=120, increment=0.5, textvariable=self.v_sec, width=6, command=self.set_seconds)
        sp.pack(side="left", padx=6)
        sp.bind("<Return>", lambda e: self.set_seconds())
        sp.bind("<FocusOut>", lambda e: self.set_seconds())
        self.lbl_total = ttk.Label(right, text="")
        self.lbl_total.grid(row=2, column=0, sticky="w", pady=(6, 0))

    # ---------------- tab: camera
    def build_camera_tab(self):
        tab = ttk.Frame(self.nb, padding=8)
        self.nb.add(tab, text=T("② カメラ"))
        tab.columnconfigure(0, weight=1)
        tab.rowconfigure(1, weight=1)
        top = ttk.LabelFrame(tab, text=T("カット割りが空のときのカメラ"), padding=6)
        top.grid(row=0, column=0, sticky="ew")
        self.c_cam = Choice(top, CAMERAS, width=18)
        self.c_cam.grid(row=0, column=0, sticky="w")
        self.v_follow = tk.BooleanVar()
        ttk.Checkbutton(top, text=T("カメラがキャラについていく"), variable=self.v_follow).grid(row=0, column=1, padx=10)
        ttk.Label(top, text=T("ズーム")).grid(row=0, column=2)
        self.v_zoom = tk.DoubleVar()
        ttk.Spinbox(top, from_=0.3, to=4, increment=0.1, textvariable=self.v_zoom, width=5).grid(row=0, column=3, padx=4)
        self.v_dof = tk.BooleanVar()
        ttk.Checkbutton(top, text=T("背景をぼかす（被写界深度）"), variable=self.v_dof).grid(row=0, column=4, padx=10)

        box = ttk.LabelFrame(tab, text=T("カット割り（上から順に切り替わる。動画の長さはキャラの再生リストで決まり、最後のカットが最後まで続きます）"), padding=6)
        box.grid(row=1, column=0, sticky="nsew", pady=(8, 0))
        box.columnconfigure(0, weight=1)
        box.rowconfigure(0, weight=1)
        self.tv_shots = ttk.Treeview(box, columns=("cam", "target", "sec", "zoom"), show="headings", selectmode="browse")
        for c, t, w in (("cam", T("カメラ"), 160), ("target", T("映す相手"), 120), ("sec", T("秒数"), 60), ("zoom", T("ズーム"), 60)):
            self.tv_shots.heading(c, text=t)
            self.tv_shots.column(c, width=w, anchor="w" if c in ("cam", "target") else "center")
        self.tv_shots.grid(row=0, column=0, sticky="nsew")
        self.tv_shots.bind("<<TreeviewSelect>>", self.on_shot_select)
        b = ttk.Frame(box)
        b.grid(row=0, column=1, padx=6, sticky="n")
        ttk.Button(b, text=T("＋ カット追加"), command=self.add_shot).pack(fill="x", pady=2)
        ttk.Button(b, text="↑", command=lambda: self.move_row(self.tv_shots, -1)).pack(fill="x", pady=(12, 2))
        ttk.Button(b, text="↓", command=lambda: self.move_row(self.tv_shots, 1)).pack(fill="x", pady=2)
        ttk.Button(b, text=T("削除"), command=lambda: self.del_rows(self.tv_shots)).pack(fill="x", pady=(12, 2))
        ttk.Button(b, text=T("全消去"), command=lambda: self.clear_rows(self.tv_shots)).pack(fill="x", pady=2)
        ed = ttk.Frame(box)
        ed.grid(row=1, column=0, columnspan=2, sticky="ew", pady=(6, 0))
        ttk.Label(ed, text=T("選んだカット:")).pack(side="left")
        self.c_shot_cam = Choice(ed, CAMERAS, self.update_shot, width=16)
        self.c_shot_cam.pack(side="left", padx=4)
        self.c_shot_target = Choice(ed, [("all", T("全員"))], self.update_shot, width=10)
        self.c_shot_target.pack(side="left", padx=4)
        ttk.Label(ed, text=T("秒数")).pack(side="left", padx=(8, 0))
        self.v_shot_sec = tk.DoubleVar(value=3)
        s1 = ttk.Spinbox(ed, from_=0.2, to=120, increment=0.5, textvariable=self.v_shot_sec, width=6, command=self.update_shot)
        s1.pack(side="left", padx=4)
        s1.bind("<FocusOut>", lambda e: self.update_shot())
        ttk.Label(ed, text=T("ズーム")).pack(side="left", padx=(8, 0))
        self.v_shot_zoom = tk.DoubleVar(value=1)
        s2 = ttk.Spinbox(ed, from_=0.3, to=4, increment=0.1, textvariable=self.v_shot_zoom, width=5, command=self.update_shot)
        s2.pack(side="left", padx=4)
        s2.bind("<FocusOut>", lambda e: self.update_shot())

    # ---------------- tab: background
    def build_background_tab(self):
        tab = ttk.Frame(self.nb, padding=8)
        self.nb.add(tab, text=T("③ 背景"))
        tab.columnconfigure(1, weight=1)
        ttk.Label(tab, text=T("背景")).grid(row=0, column=0, sticky="w")
        self.c_bg = Choice(tab, BACKGROUNDS, self.on_bg, width=28)
        self.c_bg.grid(row=0, column=1, sticky="w")
        self.btn_color = tk.Button(tab, text=T("色"), width=4, command=self.pick_color, relief="groove")
        self.btn_color.grid(row=0, column=2, padx=6)
        ttk.Label(tab, text=T("時間帯")).grid(row=1, column=0, sticky="w", pady=(6, 0))
        self.c_time = Choice(tab, TIMES, width=10)
        self.c_time.grid(row=1, column=1, sticky="w", pady=(6, 0))
        ttk.Label(tab, text=T("天気")).grid(row=2, column=0, sticky="w", pady=(6, 0))
        self.c_weather = Choice(tab, WEATHERS, width=10)
        self.c_weather.grid(row=2, column=1, sticky="w", pady=(6, 0))

        self.wf = ttk.LabelFrame(tab, text=T("マイクラのワールド"), padding=8)
        self.wf.grid(row=3, column=0, columnspan=3, sticky="ew", pady=(12, 0))
        self.wf.columnconfigure(1, weight=1)
        self.v_wpath = tk.StringVar()
        ttk.Label(self.wf, text=T("ワールドフォルダ")).grid(row=0, column=0, sticky="w")
        ttk.Entry(self.wf, textvariable=self.v_wpath).grid(row=0, column=1, columnspan=5, sticky="ew", padx=4)
        ttk.Button(self.wf, text=T("選ぶ…"), command=self.pick_world).grid(row=0, column=6)
        ttk.Label(self.wf, text=T("ディメンション")).grid(row=1, column=0, sticky="w", pady=(6, 0))
        self.c_dim = Choice(self.wf, DIMENSIONS, width=18)
        self.c_dim.grid(row=1, column=1, sticky="w", padx=4, pady=(6, 0))
        ttk.Button(self.wf, text=T("プレイヤーの位置を読み込む"), command=self.load_player_pos).grid(row=1, column=2, columnspan=3, sticky="w", pady=(6, 0))
        ttk.Label(self.wf, text=T("中心の座標（F3 の XYZ）")).grid(row=2, column=0, sticky="w", pady=(6, 0))
        self.v_wx, self.v_wy, self.v_wz = tk.DoubleVar(), tk.DoubleVar(), tk.DoubleVar()
        cf = ttk.Frame(self.wf)
        cf.grid(row=2, column=1, columnspan=5, sticky="w", pady=(6, 0))
        for lab, var in (("X", self.v_wx), ("Y", self.v_wy), ("Z", self.v_wz)):
            ttk.Label(cf, text=lab).pack(side="left", padx=(6, 2))
            ttk.Entry(cf, textvariable=var, width=10).pack(side="left")
        ttk.Label(self.wf, text=T("読み込む範囲（ブロック）")).grid(row=3, column=0, sticky="w", pady=(6, 0))
        rf = ttk.Frame(self.wf)
        rf.grid(row=3, column=1, columnspan=5, sticky="w", pady=(6, 0))
        self.v_wr, self.v_wdown, self.v_wup = tk.IntVar(), tk.IntVar(), tk.IntVar()
        for lab, var, hi in ((T("半径"), self.v_wr, 128), (T("下"), self.v_wdown, 64), (T("上"), self.v_wup, 128)):
            ttk.Label(rf, text=lab).pack(side="left", padx=(6, 2))
            ttk.Spinbox(rf, from_=4, to=hi, increment=4, textvariable=var, width=5).pack(side="left")
        ttk.Label(self.wf, text=T("テクスチャ（Minecraft の jar）")).grid(row=4, column=0, sticky="w", pady=(6, 0))
        self.v_wjar = tk.StringVar()
        ttk.Entry(self.wf, textvariable=self.v_wjar).grid(row=4, column=1, columnspan=4, sticky="ew", padx=4, pady=(6, 0))
        ttk.Button(self.wf, text=T("選ぶ…"), command=self.pick_jar).grid(row=4, column=5, pady=(6, 0))
        ttk.Button(self.wf, text=T("自動検出"), command=self.detect_jar).grid(row=4, column=6, pady=(6, 0))
        ttk.Label(self.wf, text=T("リソースパック（任意）")).grid(row=5, column=0, sticky="w", pady=(6, 0))
        self.v_wrp = tk.StringVar()
        ttk.Entry(self.wf, textvariable=self.v_wrp).grid(row=5, column=1, columnspan=4, sticky="ew", padx=4, pady=(6, 0))
        ttk.Button(self.wf, text=T("選ぶ…"), command=self.pick_rp).grid(row=5, column=5, pady=(6, 0))
        ttk.Label(self.wf, foreground="#666", wraplength=640, justify="left",
                  text=T("キャラの立ち位置（キャラクタータブの X / Z）は、この中心座標からのずれです。")
                       + T("キャラは足元の地面の高さに自動で立ちます。範囲を広げると読み込みと描画に時間がかかります。")
                       + T("サーバーのワールドはサーバーフォルダの world を選んでください。")).grid(row=6, column=0, columnspan=7, sticky="w", pady=(8, 0))

    # ---------------- tab: effects
    def build_effects_tab(self):
        tab = ttk.Frame(self.nb, padding=8)
        self.nb.add(tab, text=T("④ 演出"))
        tab.columnconfigure(1, weight=1)
        tab.rowconfigure(3, weight=1)
        ttk.Label(tab, text=T("タイトル（最初に表示）")).grid(row=0, column=0, sticky="w")
        self.v_title = tk.StringVar()
        ttk.Entry(tab, textvariable=self.v_title).grid(row=0, column=1, sticky="ew", padx=4)
        ttk.Label(tab, text=T("秒数")).grid(row=0, column=2)
        self.v_title_sec = tk.DoubleVar()
        ttk.Spinbox(tab, from_=0.5, to=20, increment=0.5, textvariable=self.v_title_sec, width=5).grid(row=0, column=3, padx=4)
        self.v_letterbox = tk.BooleanVar()
        ttk.Checkbutton(tab, text=T("映画風の黒帯（シネマスコープ）"), variable=self.v_letterbox).grid(row=1, column=0, columnspan=4, sticky="w", pady=(8, 0))
        ttk.Label(tab, text=T("字幕（開始と終了は秒）")).grid(row=2, column=0, sticky="w", pady=(12, 0))
        self.tv_subs = ttk.Treeview(tab, columns=("start", "end", "text"), show="headings", selectmode="browse")
        for c, t, w in (("start", T("開始"), 60), ("end", T("終了", "End"), 60), ("text", T("セリフ"), 400)):
            self.tv_subs.heading(c, text=t)
            self.tv_subs.column(c, width=w, anchor="center" if c != "text" else "w")
        self.tv_subs.grid(row=3, column=0, columnspan=4, sticky="nsew")
        self.tv_subs.bind("<<TreeviewSelect>>", self.on_sub_select)
        ed = ttk.Frame(tab)
        ed.grid(row=4, column=0, columnspan=4, sticky="ew", pady=(6, 0))
        self.v_sub_start, self.v_sub_end, self.v_sub_text = tk.DoubleVar(value=0), tk.DoubleVar(value=2), tk.StringVar()
        ttk.Label(ed, text=T("開始")).pack(side="left")
        ttk.Spinbox(ed, from_=0, to=600, increment=0.5, textvariable=self.v_sub_start, width=6).pack(side="left", padx=4)
        ttk.Label(ed, text=T("終了", "End")).pack(side="left")
        ttk.Spinbox(ed, from_=0, to=600, increment=0.5, textvariable=self.v_sub_end, width=6).pack(side="left", padx=4)
        ttk.Entry(ed, textvariable=self.v_sub_text).pack(side="left", fill="x", expand=True, padx=4)
        ttk.Button(ed, text=T("追加"), command=self.add_sub).pack(side="left")
        ttk.Button(ed, text=T("更新"), command=self.update_sub).pack(side="left", padx=4)
        ttk.Button(ed, text=T("削除"), command=lambda: self.del_rows(self.tv_subs)).pack(side="left")

    # ---------------- tab: output
    def build_output_tab(self):
        tab = ttk.Frame(self.nb, padding=8)
        self.nb.add(tab, text=T("⑤ 書き出し"))
        tab.columnconfigure(1, weight=1)
        ttk.Label(tab, text=T("サイズ")).grid(row=0, column=0, sticky="w")
        self.c_res = Choice(tab, [(r[0], T(r[0])) for r in RESOLUTIONS], width=34)
        self.c_res.grid(row=0, column=1, sticky="w")
        ttk.Label(tab, text=T("画質")).grid(row=1, column=0, sticky="w", pady=(6, 0))
        self.c_engine = Choice(tab, ENGINES, width=30)
        self.c_engine.grid(row=1, column=1, sticky="w", pady=(6, 0))
        ttk.Label(tab, text="FPS").grid(row=2, column=0, sticky="w", pady=(6, 0))
        self.c_fps = Choice(tab, [(24, "24"), (30, "30"), (60, "60")], width=6)
        self.c_fps.grid(row=2, column=1, sticky="w", pady=(6, 0))
        ttk.Label(tab, text=T("サンプル数")).grid(row=3, column=0, sticky="w", pady=(6, 0))
        self.v_samples = tk.IntVar()
        ttk.Spinbox(tab, from_=1, to=1024, textvariable=self.v_samples, width=6).grid(row=3, column=1, sticky="w", pady=(6, 0))
        ttk.Label(tab, text=T("保存先")).grid(row=4, column=0, sticky="w", pady=(6, 0))
        self.v_out = tk.StringVar()
        of = ttk.Frame(tab)
        of.grid(row=4, column=1, sticky="ew", pady=(6, 0))
        ttk.Entry(of, textvariable=self.v_out).pack(side="left", fill="x", expand=True)
        ttk.Button(of, text="…", width=3, command=self.pick_out).pack(side="left", padx=4)
        ttk.Label(tab, text=T("ファイル名")).grid(row=5, column=0, sticky="w", pady=(6, 0))
        self.v_name = tk.StringVar()
        ttk.Entry(tab, textvariable=self.v_name).grid(row=5, column=1, sticky="ew", pady=(6, 0))

    # ---------------- project <-> widgets
    def load_project_into_ui(self):
        self._loading = True
        p = self.project
        self.refresh_actor_list()
        self.select_actor(0)
        self.c_cam.set_key(p["camera"])
        self.v_follow.set(p["follow"])
        self.v_zoom.set(p["zoom"])
        self.v_dof.set(p["dof"])
        self.refresh_targets()
        self.tv_shots.delete(*self.tv_shots.get_children())
        for s in p["shots"]:
            self.insert_shot(s)
        self.c_bg.set_key(p["background"])
        self.bg_color = list(p["bg_color"])
        self.c_time.set_key(p["time"])
        self.c_weather.set_key(p["weather"])
        w = p["world"]
        self.v_wpath.set(w["path"])
        self.c_dim.set_key(w["dimension"])
        self.v_wx.set(w["x"]); self.v_wy.set(w["y"]); self.v_wz.set(w["z"])
        self.v_wr.set(w["radius"]); self.v_wdown.set(w["down"]); self.v_wup.set(w["up"])
        self.v_wjar.set(w.get("client_jar") or find_client_jar())
        self.v_wrp.set(w.get("resource_pack", ""))
        self.v_title.set(p["title"])
        self.v_title_sec.set(p["title_seconds"])
        self.v_letterbox.set(p["letterbox"])
        self.tv_subs.delete(*self.tv_subs.get_children())
        for s in p["subtitles"]:
            self.tv_subs.insert("", "end", values=(s["start"], s["end"], s["text"]))
        self.c_res.set_key(p["resolution"] if p["resolution"] in dict(RESOLUTIONS) else RESOLUTIONS[0][0])
        self.c_engine.set_key(p["engine"])
        self.c_fps.set_key(int(p["fps"]))
        self.v_samples.set(p["samples"])
        self.v_out.set(p["output_dir"])
        self.v_name.set(p["name"])
        self.on_bg()
        self._loading = False

    def collect(self):
        p = self.project
        self.save_actor_fields()
        p["camera"] = self.c_cam.get_key()
        p["follow"] = self.v_follow.get()
        p["zoom"] = num(self.v_zoom, 1.0)
        p["dof"] = self.v_dof.get()
        p["shots"] = [self.shot_from_row(i) for i in self.tv_shots.get_children()]
        p["background"] = self.c_bg.get_key()
        p["bg_color"] = self.bg_color
        p["time"] = self.c_time.get_key()
        p["weather"] = self.c_weather.get_key()
        p["world"] = {"path": self.v_wpath.get().strip(), "dimension": self.c_dim.get_key(),
                      "x": num(self.v_wx), "y": num(self.v_wy, 64), "z": num(self.v_wz),
                      "radius": int(num(self.v_wr, 32)), "down": int(num(self.v_wdown, 16)), "up": int(num(self.v_wup, 40)),
                      "client_jar": self.v_wjar.get().strip(), "resource_pack": self.v_wrp.get().strip()}
        p["title"] = self.v_title.get()
        p["title_seconds"] = num(self.v_title_sec, 2.5)
        p["letterbox"] = self.v_letterbox.get()
        p["subtitles"] = [{"start": float(v[0]), "end": float(v[1]), "text": str(v[2])}
                          for v in (self.tv_subs.item(i, "values") for i in self.tv_subs.get_children())]
        p["resolution"] = self.c_res.get_key()
        p["engine"] = self.c_engine.get_key()
        p["fps"] = int(self.c_fps.get_key())
        p["samples"] = int(num(self.v_samples, 32))
        p["output_dir"] = self.v_out.get().strip()
        p["name"] = self.v_name.get().strip() or "minecraft_anim"
        return p

    # ---------------- actors
    def actor(self):
        return self.project["actors"][self.cur_actor]

    def refresh_actor_list(self):
        self.lb_actors.delete(0, "end")
        for i, a in enumerate(self.project["actors"]):
            name = os.path.splitext(os.path.basename(a["skin"]))[0] if a["skin"] else T("同梱スキン")
            self.lb_actors.insert("end", f"{i + 1}. {name}")
        self.refresh_targets()

    def refresh_targets(self):
        pairs = [("all", T("全員"))] + [(str(i), T("キャラ{n}").format(n=i + 1)) for i in range(len(self.project["actors"]))]
        self.c_shot_target.set_pairs(pairs)

    def select_actor(self, idx=None):
        if idx is None:
            sel = self.lb_actors.curselection()
            if not sel:
                return
            idx = sel[0]
        if not self._loading:
            self.save_actor_fields()
        self.cur_actor = max(0, min(idx, len(self.project["actors"]) - 1))
        self.lb_actors.selection_clear(0, "end")
        self.lb_actors.selection_set(self.cur_actor)
        a = self.actor()
        was = self._loading
        self._loading = True
        self.c_arms.set_key(a["arms"])
        self.c_item.set_key(a["item"])
        self.v_ax.set(a["x"]); self.v_az.set(a["z"]); self.v_ayaw.set(a["yaw"])
        self.c_face.set_key(str(int(a["yaw"])) if int(a["yaw"]) in (0, 90, 180, -90) else "0")
        self.v_amove.set(a["move"])
        self.tv_seq.delete(*self.tv_seq.get_children())
        for mid, sec in a["motions"]:
            if mid in MOTION_LABEL:
                self.tv_seq.insert("", "end", values=(MOTION_LABEL[mid], sec), tags=(mid,))
        self._loading = was
        self.update_total()
        self.update_skin_preview()

    def save_actor_fields(self):
        if not self.project["actors"]:
            return
        a = self.actor()
        a["arms"] = self.c_arms.get_key()
        a["item"] = self.c_item.get_key()
        a["x"], a["z"], a["yaw"] = num(self.v_ax), num(self.v_az), num(self.v_ayaw)
        a["move"] = self.v_amove.get()
        self.save_actor_seq()

    def save_actor_seq(self):
        a = self.actor()
        a["motions"] = [[self.tv_seq.item(i, "tags")[0], float(self.tv_seq.item(i, "values")[1])]
                        for i in self.tv_seq.get_children()]
        self.update_total()

    def on_actor_field(self):
        if not self._loading:
            self.save_actor_fields()
            self.update_skin_preview()

    def on_facing(self):
        self.v_ayaw.set(float(self.c_face.get_key()))
        self.on_actor_field()

    def add_actor(self):
        if len(self.project["actors"]) >= 8:
            messagebox.showinfo(APP_NAME, T("出演者は 8 人までです。"))
            return
        self.save_actor_fields()
        a = copy.deepcopy(DEFAULT_ACTOR)
        n = len(self.project["actors"])
        a["x"] = 2.0 * n
        a["motions"] = [["idle", 4.0]]
        self.project["actors"].append(a)
        self.refresh_actor_list()
        self.select_actor(n)

    def dup_actor(self):
        if len(self.project["actors"]) >= 8:
            return
        self.save_actor_fields()
        a = copy.deepcopy(self.actor())
        a["x"] += 2.0
        self.project["actors"].append(a)
        self.refresh_actor_list()
        self.select_actor(len(self.project["actors"]) - 1)

    def remove_actor(self):
        if len(self.project["actors"]) <= 1:
            return
        del self.project["actors"][self.cur_actor]
        self.cur_actor = 0
        self.refresh_actor_list()
        self._loading = True
        self.select_actor(0)
        self._loading = False

    def pick_skin(self):
        p = filedialog.askopenfilename(title=T("スキン画像（64×64 PNG）"), filetypes=[("PNG", "*.png")])
        if p:
            self.actor()["skin"] = p
            self.refresh_actor_list()
            self.lb_actors.selection_set(self.cur_actor)
            self.update_skin_preview()

    def update_skin_preview(self):
        a = self.actor()
        path = a["skin"] or os.path.join(ASSETS, "default_skin.png")
        text = os.path.basename(a["skin"]) if a["skin"] else T("（同梱スキン）")
        self.skin_canvas.delete("all")
        if Image is not None and os.path.isfile(path):
            try:
                img, arms = skin_front(path, self.c_arms.get_key(), scale=4)
                self._photo = ImageTk.PhotoImage(img)
                self.skin_canvas.create_image(65, 75, image=self._photo)
                if self.c_arms.get_key() == "auto":
                    text += T("\n腕: {arms}（自動）").format(arms=T("細め") if arms == "slim" else T("通常"))
            except Exception as e:
                self.skin_canvas.create_text(65, 75, text=T("読めない画像"), fill="#f88")
                self.write_log(T("スキン読み込み失敗: {e}").format(e=e))
        self.lbl_skin.config(text=text)

    # ---------------- motion list
    def add_motion(self):
        sel = self.tv_all.selection()
        if not sel or not sel[0].startswith("m_"):
            return
        mid = sel[0][2:]
        sec = 4.0 if mid in ("walk", "run", "sneak", "walk_back", "zombie", "crawl", "swim", "fly", "skip") else \
            1.0 if mid in bm_motions.TURNS else 3.0
        iid = self.tv_seq.insert("", "end", values=(MOTION_LABEL[mid], sec), tags=(mid,))
        self.tv_seq.selection_set(iid)
        self.save_actor_seq()

    def move_row(self, tv, d, after=None):
        sel = tv.selection()
        if sel:
            tv.move(sel[0], "", max(0, tv.index(sel[0]) + d))
            if after:
                after()

    def del_rows(self, tv, after=None):
        for iid in tv.selection():
            tv.delete(iid)
        if after:
            after()

    def clear_rows(self, tv, after=None):
        tv.delete(*tv.get_children())
        if after:
            after()

    def on_seq_select(self, _=None):
        sel = self.tv_seq.selection()
        if sel:
            self.v_sec.set(float(self.tv_seq.item(sel[0], "values")[1]))

    def set_seconds(self):
        sel = self.tv_seq.selection()
        sec = max(0.2, min(120.0, num(self.v_sec, 3.0)))
        if sel:
            vals = self.tv_seq.item(sel[0], "values")
            self.tv_seq.item(sel[0], values=(vals[0], sec))
        self.save_actor_seq()

    def update_total(self):
        own = sum(s for _, s in self.actor()["motions"]) if self.project["actors"] else 0
        total = max((sum(s for _, s in a["motions"]) for a in self.project["actors"]), default=0)
        self.lbl_total.config(text=T("このキャラ {own:.1f} 秒 / 動画 {total:.1f} 秒").format(own=own, total=total))

    # ---------------- shots
    def insert_shot(self, s):
        tg = s.get("target", "all")
        tlabel = T("全員") if tg in ("all", None) else T("キャラ{n}").format(n=int(tg) + 1)
        self.tv_shots.insert("", "end", values=(dict(CAMERAS).get(s["camera"], s["camera"]), tlabel,
                                                s.get("seconds", 3), s.get("zoom", 1.0)),
                             tags=(s["camera"], str(tg)))

    def shot_from_row(self, iid):
        cam, tg = self.tv_shots.item(iid, "tags")[:2]
        v = self.tv_shots.item(iid, "values")
        return {"camera": cam, "target": "all" if tg == "all" else int(tg), "seconds": float(v[2]),
                "zoom": float(v[3]), "follow": True}

    def add_shot(self):
        s = {"camera": self.c_shot_cam.get_key() if self.c_shot_cam.current() >= 0 else "diagonal",
             "target": self.c_shot_target.get_key() if self.c_shot_target.current() >= 0 else "all",
             "seconds": max(0.2, num(self.v_shot_sec, 3)), "zoom": num(self.v_shot_zoom, 1)}
        self.insert_shot(s)
        kids = self.tv_shots.get_children()
        self.tv_shots.selection_set(kids[-1])

    def on_shot_select(self, _=None):
        sel = self.tv_shots.selection()
        if sel:
            s = self.shot_from_row(sel[0])
            self._loading = True
            self.c_shot_cam.set_key(s["camera"])
            self.c_shot_target.set_key(str(s["target"]))
            self.v_shot_sec.set(s["seconds"])
            self.v_shot_zoom.set(s["zoom"])
            self._loading = False

    def update_shot(self):
        if self._loading:
            return
        sel = self.tv_shots.selection()
        if not sel:
            return
        idx = self.tv_shots.index(sel[0])
        s = {"camera": self.c_shot_cam.get_key(), "target": self.c_shot_target.get_key(),
             "seconds": max(0.2, num(self.v_shot_sec, 3)), "zoom": num(self.v_shot_zoom, 1)}
        self.tv_shots.delete(sel[0])
        self.insert_shot(s)
        new = self.tv_shots.get_children()[-1]
        self.tv_shots.move(new, "", idx)
        self.tv_shots.selection_set(new)

    # ---------------- subtitles
    def add_sub(self):
        if self.v_sub_text.get().strip():
            self.tv_subs.insert("", "end", values=(num(self.v_sub_start), num(self.v_sub_end, 2), self.v_sub_text.get()))
            dur = num(self.v_sub_end, 2) - num(self.v_sub_start)
            self.v_sub_start.set(num(self.v_sub_end, 2))
            self.v_sub_end.set(num(self.v_sub_end, 2) + max(1.0, dur))
            self.v_sub_text.set("")

    def on_sub_select(self, _=None):
        sel = self.tv_subs.selection()
        if sel:
            v = self.tv_subs.item(sel[0], "values")
            self.v_sub_start.set(float(v[0])); self.v_sub_end.set(float(v[1])); self.v_sub_text.set(v[2])

    def update_sub(self):
        sel = self.tv_subs.selection()
        if sel:
            self.tv_subs.item(sel[0], values=(num(self.v_sub_start), num(self.v_sub_end, 2), self.v_sub_text.get()))

    # ---------------- background
    def on_bg(self):
        bg = self.c_bg.get_key()
        self.btn_color.config(state="normal" if bg == "studio" else "disabled")
        r, g, b = (int(max(0, min(1, c)) ** (1 / 2.2) * 255) for c in self.bg_color)
        self.btn_color.config(bg=f"#{r:02x}{g:02x}{b:02x}" if bg == "studio" else
                              ("SystemButtonFace" if os.name == "nt" else "#d9d9d9"))
        state = "normal" if bg == "world" else "disabled"
        for child in self.wf.winfo_children():
            self._set_state(child, state)

    def _set_state(self, w, state):
        try:
            w.configure(state=state if not isinstance(w, ttk.Combobox) else ("readonly" if state == "normal" else "disabled"))
        except tk.TclError:
            pass
        for c in w.winfo_children():
            self._set_state(c, state)

    def pick_color(self):
        r, g, b = (int(max(0, min(1, c)) ** (1 / 2.2) * 255) for c in self.bg_color)
        res = colorchooser.askcolor(color=f"#{r:02x}{g:02x}{b:02x}", title=T("背景の色"))
        if res and res[0]:
            self.bg_color = [round((c / 255) ** 2.2, 4) for c in res[0]]
            self.on_bg()

    def pick_world(self):
        p = filedialog.askdirectory(title=T("ワールドフォルダ（level.dat がある所）"), initialdir=find_saves())
        if p:
            self.v_wpath.set(p)
            if read_player_pos(p):
                if messagebox.askyesno(APP_NAME, T("このワールドのプレイヤーの位置を中心座標にしますか？")):
                    self.load_player_pos()

    def load_player_pos(self):
        try:
            pos = read_player_pos(self.v_wpath.get())
        except Exception as e:
            pos = None
            self.write_log(T("level.dat を読めませんでした: {e}").format(e=e))
        if not pos:
            messagebox.showinfo(APP_NAME, T("level.dat にプレイヤーの位置がありませんでした（サーバーのワールドなど）。座標を入力してください。"))
            return
        x, y, z, yaw, dim = pos
        self.v_wx.set(round(x, 1)); self.v_wy.set(round(y, 1)); self.v_wz.set(round(z, 1))
        self.c_dim.set_key(dim)
        self.status(T("プレイヤーの位置 X {x:.1f} / Y {y:.1f} / Z {z:.1f}（向き {yaw:.0f}°）を読み込みました").format(x=x, y=y, z=z, yaw=yaw))

    def pick_jar(self):
        p = filedialog.askopenfilename(title=T("Minecraft の jar（例: versions\\1.21.11\\1.21.11.jar）"),
                                       filetypes=[("jar / zip", "*.jar *.zip"), (T("すべて"), "*")])
        if p:
            self.v_wjar.set(p)

    def detect_jar(self):
        p = find_client_jar()
        if p:
            self.v_wjar.set(p)
        else:
            messagebox.showinfo(APP_NAME, T("Minecraft の jar が見つかりませんでした。一度ゲームを起動するか、jar を選んでください。"))

    def pick_rp(self):
        p = filedialog.askopenfilename(title=T("リソースパック（zip）"), filetypes=[("zip", "*.zip"), (T("すべて"), "*")])
        if p:
            self.v_wrp.set(p)

    # ---------------- misc callbacks
    def pick_blender(self):
        p = filedialog.askopenfilename(title=T("blender.exe を選ぶ"),
                                       filetypes=[("Blender", "blender.exe blender Blender"), (T("すべて"), "*")])
        if p:
            self.v_blender.set(p)

    def detect_blender(self):
        p = find_blender()
        if p:
            self.v_blender.set(p)
            self.status(T("Blender を見つけました: {p}").format(p=p))
        else:
            messagebox.showwarning(APP_NAME, T("Blender が見つかりませんでした。\nblender.org から 4.2 以降をインストールするか、「参照…」で blender.exe を選んでください。"))

    def pick_out(self):
        p = filedialog.askdirectory(title=T("保存先フォルダ"), initialdir=self.v_out.get() or None)
        if p:
            self.v_out.set(p)

    def open_path(self, p):
        if not p or not os.path.exists(p):
            return
        if os.name == "nt":
            os.startfile(p)
        elif sys.platform == "darwin":
            subprocess.Popen(["open", p])
        else:
            subprocess.Popen(["xdg-open", p])

    def open_out(self):
        d = self.v_out.get()
        os.makedirs(d, exist_ok=True)
        self.open_path(d)

    def open_last(self, kind):
        self.open_path(self.last_files.get(kind) or self.last_files.get("frames"))

    def open_blend(self):
        p = self.last_files.get("blend")
        if p and os.path.isfile(p):
            subprocess.Popen([self.v_blender.get(), p])

    # ---------------- project files
    def new_project(self):
        if not messagebox.askyesno(APP_NAME, T("今の設定を消して新しいプロジェクトにしますか？")):
            return
        self.project = copy.deepcopy(DEFAULT_PROJECT)
        self.project_path = None
        self.cur_actor = 0
        self.load_project_into_ui()

    def open_project(self):
        p = filedialog.askopenfilename(title=T("プロジェクトを開く"), filetypes=[(T("BlockMotion プロジェクト"), "*.bmproj *.json")])
        if not p:
            return
        try:
            with open(p, encoding="utf-8") as f:
                self.project = self.migrate(json.load(f))
        except (OSError, ValueError) as e:
            messagebox.showerror(APP_NAME, T("開けませんでした:\n{e}").format(e=e))
            return
        self.project_path = p
        self.cur_actor = 0
        self.load_project_into_ui()
        self.status(T("開きました: {p}").format(p=p))

    def save_project(self):
        p = filedialog.asksaveasfilename(title=T("プロジェクトを保存"), defaultextension=".bmproj",
                                         initialfile=os.path.basename(self.project_path or (self.v_name.get() + ".bmproj")),
                                         filetypes=[(T("BlockMotion プロジェクト"), "*.bmproj")])
        if not p:
            return
        with open(p, "w", encoding="utf-8") as f:
            json.dump(self.collect(), f, ensure_ascii=False, indent=2)
        self.project_path = p
        self.status(T("保存しました: {p}").format(p=p))

    # ---------------- running Blender
    def build_config(self, preview):
        p = copy.deepcopy(self.collect())
        actors = []
        for a in p["actors"]:
            if not a["motions"]:
                continue
            actors.append({"skin": a["skin"], "arms": a["arms"], "item": a["item"], "x": a["x"], "z": a["z"],
                           "yaw": a["yaw"], "move": a["move"],
                           "motions": [{"id": m, "seconds": s} for m, s in a["motions"]]})
        if not actors:
            raise ValueError(T("再生リストにモーションを1つ以上追加してください。"))
        if p["background"] == "world":
            if not p["world"]["path"] or not os.path.isdir(p["world"]["path"]):
                raise ValueError(T("背景タブでワールドフォルダを選んでください。"))
        res = dict(RESOLUTIONS).get(p["resolution"], (1920, 1080))
        total = max(sum(m["seconds"] for m in a["motions"]) for a in actors)
        world = dict(p["world"])
        world["resource_packs"] = [world.pop("resource_pack")] if world.get("resource_pack") else []
        cfg = {
            "actors": actors, "shots": p["shots"], "camera": p["camera"], "follow": p["follow"], "zoom": p["zoom"],
            "dof": p["dof"], "background": p["background"], "bg_color": p["bg_color"], "time": p["time"],
            "weather": p["weather"], "world": world, "title": p["title"], "title_seconds": p["title_seconds"],
            "letterbox": p["letterbox"], "subtitles": p["subtitles"],
            "resolution": list(res), "fps": p["fps"], "engine": p["engine"], "samples": p["samples"],
            "output_dir": p["output_dir"], "name": p["name"], "assets": ASSETS,
            "video": True, "save_blend": True,
        }
        if preview:
            t = total / 2
            sel = self.tv_seq.selection()
            if sel:  # preview the middle of the selected motion of the current actor
                start = 0.0
                for iid in self.tv_seq.get_children():
                    sec = float(self.tv_seq.item(iid, "values")[1])
                    if iid == sel[0]:
                        t = start + sec * 0.4
                        break
                    start += sec
            cfg["preview_frame"] = int(t * p["fps"]) + 1
            cfg["resolution"] = [max(2, res[0] // 2), max(2, res[1] // 2)]
            cfg["samples"] = min(p["samples"], 16)
        return cfg

    def start(self, preview=False):
        if self.proc:
            return
        blender = self.v_blender.get().strip()
        if not blender or not os.path.isfile(blender):
            messagebox.showerror(APP_NAME, T("Blender の場所が設定されていません。\n「自動検出」か「参照…」で blender.exe を選んでください。"))
            return
        try:
            cfg = self.build_config(preview)
        except ValueError as e:
            messagebox.showwarning(APP_NAME, str(e))
            return
        os.makedirs(cfg["output_dir"], exist_ok=True)
        self.save_settings()
        cfg_path = os.path.join(CONF_DIR, "last_job.json")
        os.makedirs(CONF_DIR, exist_ok=True)
        with open(cfg_path, "w", encoding="utf-8") as f:
            json.dump(cfg, f, ensure_ascii=False, indent=2)
        cmd = [blender, "-b", "--factory-startup", "-noaudio", "-P", SCRIPT, "--", cfg_path]
        self.log.delete("1.0", "end")
        self.write_log(" ".join(f'"{c}"' if " " in c else c for c in cmd))
        self.pb.config(value=0, maximum=1)
        self.preview_mode = preview
        self.last_files = {}
        self.set_running(True)
        self.status(T("Blender を起動中…"))
        flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
        try:
            self.proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                         stdin=subprocess.DEVNULL, creationflags=flags,
                                         text=True, encoding="utf-8", errors="replace", bufsize=1)
        except OSError as e:
            self.set_running(False)
            messagebox.showerror(APP_NAME, T("Blender を起動できませんでした:\n{e}").format(e=e))
            return
        threading.Thread(target=self.reader, args=(self.proc,), daemon=True).start()

    def reader(self, proc):
        for line in proc.stdout:
            self.q.put(("line", line.rstrip()))
        proc.wait()
        self.q.put(("exit", proc.returncode))

    def stop(self):
        if self.proc:
            self.proc.terminate()
            self.status(T("停止しました"))

    def set_running(self, on):
        st = "disabled" if on else "normal"
        self.btn_go.config(state=st)
        self.btn_preview.config(state=st)
        self.btn_stop.config(state="normal" if on else "disabled")

    def poll(self):
        try:
            while True:
                kind, val = self.q.get_nowait()
                if kind == "line":
                    self.handle_line(val)
                else:
                    self.finish(val)
        except queue.Empty:
            pass
        self.after(100, self.poll)

    STAGES = {
        "reading world": T("ワールドを読み込み中"), "animating": T("モーションを作成中"),
        "placing camera": T("カメラを配置中"), "building background": T("背景を作成中"),
        "building world mesh": T("ワールドを組み立て中"), "rendering preview": T("プレビューを描画中"),
        "rendering": T("動画を描画中"),
    }

    def handle_line(self, line):
        if line.startswith("BM_PROGRESS"):
            _, i, n = line.split()
            self.pb.config(maximum=int(n), value=int(i))
            self.status(T("描画中… {i} / {n} コマ").format(i=i, n=n))
            return
        if line.startswith("BM_STAGE"):
            text = line[9:]
            for k, v in self.STAGES.items():
                if text.startswith(k):
                    self.status(v + "…")
                    break
        elif line.startswith("BM_FILE"):
            _, kind, path = line.split(" ", 2)
            self.last_files[kind] = path
        if line.startswith("Error: Not freed memory") or "WARNING" in line:
            return
        if line.startswith("BM_") or "Error" in line or "Traceback" in line or line.startswith("  File") \
                or line.startswith(("RuntimeError", "FileNotFoundError", "ValueError", "KeyError")):
            self.write_log(line)

    def finish(self, code):
        self.proc = None
        self.set_running(False)
        if code == 0 and any(k in self.last_files for k in ("video", "frames", "preview")):
            if self.preview_mode:
                self.show_preview(self.last_files.get("preview"))
                self.status(T("プレビューを描きました"))
            else:
                self.pb.config(value=self.pb.cget("maximum"))
                out = self.last_files.get("video") or self.last_files.get("frames")
                self.status(T("完成: {out}").format(out=out))
                self.btn_video.config(state="normal")
            if "blend" in self.last_files:
                self.btn_blend.config(state="normal")
        else:
            self.status(T("失敗しました（終了コード {code}）。ログを確認してください。").format(code=code))

    def show_preview(self, path):
        if not path or Image is None or not os.path.isfile(path):
            return
        im = Image.open(path)
        if im.mode == "RGBA":  # checkerboard behind transparent previews
            bg = Image.new("RGBA", im.size, (200, 200, 200, 255))
            for y in range(0, im.size[1], 16):
                for x in range((y // 16 % 2) * 16, im.size[0], 32):
                    bg.paste((150, 150, 150, 255), (x, y, x + 16, y + 16))
            bg.alpha_composite(im)
            im = bg
        w = max(100, self.preview.winfo_width() - 4)
        h = max(100, self.preview.winfo_height() - 4)
        im.thumbnail((w, h))
        self._preview_photo = ImageTk.PhotoImage(im)
        self.preview.config(image=self._preview_photo, text="")

    def status(self, text):
        self.lbl_status.config(text=text)

    def write_log(self, text):
        self.log.insert("end", text + "\n")
        self.log.see("end")

    def change_lang(self):
        new = self.v_lang.get()
        if new == bm_i18n.LANG:
            return
        if self.proc or not messagebox.askyesno(APP_NAME, T("言語を切り替えるとアプリを再起動します。よろしいですか？")):
            self.v_lang.set(bm_i18n.LANG)
            return
        bm_i18n.LANG = new
        self.save_settings()
        cmd = [sys.executable] if getattr(sys, "frozen", False) else [sys.executable, os.path.abspath(__file__)]
        subprocess.Popen(cmd)
        self.destroy()

    def on_close(self):
        if self.proc and not messagebox.askyesno(APP_NAME, T("生成中です。止めて終了しますか？")):
            return
        if self.proc:
            self.proc.terminate()
        self.save_settings()
        self.destroy()


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "--version":
        print(VERSION)
        return
    App().mainloop()


if __name__ == "__main__":
    main()
