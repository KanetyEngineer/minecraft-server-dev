"""BlockMotion - マイクラ風 3D アニメーションを Blender で自動生成するデスクトップアプリ。

PC にインストールされた Blender をバックグラウンドで動かし、
スキン画像とモーションの並びから .blend と動画を書き出す。
"""
import json
import os
import queue
import re
import shutil
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
VERSION = "1.0.0"


def resource_dir():
    if getattr(sys, "frozen", False):
        return getattr(sys, "_MEIPASS", os.path.dirname(sys.executable))
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


RES = resource_dir()
SCRIPT = os.path.join(RES, "blender", "generate.py")
ASSETS = os.path.join(RES, "assets")

if os.name == "nt":
    CONF_DIR = os.path.join(os.environ.get("APPDATA", os.path.expanduser("~")), APP_NAME)
else:
    CONF_DIR = os.path.join(os.path.expanduser("~"), ".config", APP_NAME)
CONF = os.path.join(CONF_DIR, "settings.json")

MOTIONS = [
    ("walk", "歩く"), ("run", "走る"), ("idle", "待機"), ("wave", "手を振る"),
    ("mine", "採掘"), ("attack", "剣を振る"), ("jump", "ジャンプ"), ("cheer", "バンザイ"),
    ("dance", "ダンス"), ("sneak", "スニーク"), ("look", "見回す"), ("sit", "座る"),
    ("bow", "お辞儀"), ("spin", "くるっと回る"),
]
ITEMS = [
    ("none", "なし"), ("iron_sword", "鉄の剣"), ("diamond_sword", "ダイヤの剣"),
    ("iron_pickaxe", "鉄のツルハシ"), ("diamond_pickaxe", "ダイヤのツルハシ"),
    ("iron_axe", "鉄の斧"), ("iron_shovel", "鉄のシャベル"), ("torch", "松明"),
]
BACKGROUNDS = [
    ("grass", "昼の草原"), ("night", "夜の草原"), ("cave", "洞窟"),
    ("studio", "スタジオ（単色）"), ("greenscreen", "グリーンバック"), ("transparent", "透過（PNG連番）"),
]
CAMERAS = [
    ("diagonal", "ななめ前"), ("front", "正面"), ("side", "真横"), ("back", "後ろ"),
    ("closeup", "アップ"), ("low", "ローアングル"), ("high", "見下ろし"), ("orbit", "ぐるっと回る"),
]
RESOLUTIONS = [
    ("横長 1920×1080（YouTube）", (1920, 1080)),
    ("縦長 1080×1920（TikTok・ショート）", (1080, 1920)),
    ("正方形 1080×1080", (1080, 1080)),
    ("横長 1280×720（軽い）", (1280, 720)),
]
ENGINES = [
    ("eevee", "標準（EEVEE・速い）"), ("cycles", "高画質（Cycles・遅い）"), ("workbench", "下書き（Workbench・最速）"),
]
ARMS = [("auto", "自動判定"), ("classic", "通常（Steve 型）"), ("slim", "細め（Alex 型）")]
MOTION_LABEL = dict(MOTIONS)

DEFAULT_SETTINGS = {
    "blender": "",
    "skin": "",
    "arms": "auto",
    "sequence": [["walk", 4.0], ["wave", 3.0]],
    "move": True,
    "item": "none",
    "background": "grass",
    "bg_color": [0.85, 0.87, 0.9],
    "camera": "diagonal",
    "follow": True,
    "zoom": 1.0,
    "resolution": RESOLUTIONS[0][0],
    "fps": 30,
    "engine": "eevee",
    "samples": 32,
    "output_dir": os.path.join(os.path.expanduser("~"), "Videos", APP_NAME),
    "name": "minecraft_anim",
}


# --------------------------------------------------------------------------
# Blender discovery
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
        # Microsoft Store / winget installs
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

    def put(src, dst, layer=True):
        x, y, cw, ch = src
        part = im.crop((x, y, x + cw, y + ch))
        out.alpha_composite(part, dst) if layer else out.paste(part, dst)

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
# GUI
# --------------------------------------------------------------------------
class App(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title(f"{APP_NAME} {VERSION} - マイクラ3Dアニメ自動生成")
        self.geometry("1280x900")
        self.minsize(1100, 820)
        self.settings = self.load_settings()
        self.proc = None
        self.q = queue.Queue()
        self.last_files = {}
        self._photo = None
        self._preview_photo = None
        try:
            self._icon = tk.PhotoImage(file=os.path.join(ASSETS, "icon.png"))
            self.iconphoto(True, self._icon)
        except tk.TclError:
            pass
        self.setup_style()
        self.build()
        self.apply_settings()
        self.after(100, self.poll)
        self.protocol("WM_DELETE_WINDOW", self.on_close)

    # ---------------- settings
    def load_settings(self):
        s = dict(DEFAULT_SETTINGS)
        try:
            with open(CONF, encoding="utf-8") as f:
                s.update(json.load(f))
        except (OSError, ValueError):
            pass
        if not s["blender"] or not os.path.isfile(s["blender"]):
            s["blender"] = find_blender()
        return s

    def save_settings(self):
        try:
            os.makedirs(CONF_DIR, exist_ok=True)
            with open(CONF, "w", encoding="utf-8") as f:
                json.dump(self.collect(), f, ensure_ascii=False, indent=2)
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
        st.configure("Title.TLabel", font=(font[0], 11, "bold"))
        st.configure("Big.TButton", font=(font[0], 12, "bold"), padding=8)

    def build(self):
        root = ttk.Frame(self, padding=10)
        root.pack(fill="both", expand=True)
        root.columnconfigure(0, weight=0)
        root.columnconfigure(1, weight=1)
        root.columnconfigure(2, weight=1)
        root.rowconfigure(2, weight=1)

        # Blender path row
        top = ttk.Frame(root)
        top.grid(row=0, column=0, columnspan=3, sticky="ew", pady=(0, 8))
        ttk.Label(top, text="Blender:").pack(side="left")
        self.v_blender = tk.StringVar()
        ttk.Entry(top, textvariable=self.v_blender).pack(side="left", fill="x", expand=True, padx=6)
        ttk.Button(top, text="参照…", command=self.pick_blender).pack(side="left")
        ttk.Button(top, text="自動検出", command=self.detect_blender).pack(side="left", padx=(6, 0))

        # ---- column 0: skin
        c0 = ttk.LabelFrame(root, text="① スキン", padding=8)
        c0.grid(row=1, column=0, sticky="nsew", padx=(0, 8))
        self.skin_canvas = tk.Canvas(c0, width=150, height=230, bg="#2b2f36", highlightthickness=0)
        self.skin_canvas.pack(pady=(0, 6))
        self.v_skin = tk.StringVar()
        ttk.Button(c0, text="スキン画像を選ぶ…", command=self.pick_skin).pack(fill="x")
        self.lbl_skin = ttk.Label(c0, text="（未選択なら同梱スキン）", wraplength=170)
        self.lbl_skin.pack(fill="x", pady=4)
        ttk.Label(c0, text="腕の太さ").pack(anchor="w", pady=(6, 0))
        self.v_arms = tk.StringVar()
        self.cb_arms = self.combo(c0, ARMS, self.v_arms, self.update_skin_preview)
        self.cb_arms.pack(fill="x")
        ttk.Label(c0, text="持ち物").pack(anchor="w", pady=(10, 0))
        self.v_item = tk.StringVar()
        self.combo(c0, ITEMS, self.v_item).pack(fill="x")

        # ---- column 1: motions
        c1 = ttk.LabelFrame(root, text="② モーション（上から順に再生）", padding=8)
        c1.grid(row=1, column=1, sticky="nsew", padx=(0, 8))
        c1.columnconfigure(0, weight=1)
        c1.columnconfigure(2, weight=1)
        c1.rowconfigure(1, weight=1)
        ttk.Label(c1, text="モーション一覧").grid(row=0, column=0, sticky="w")
        ttk.Label(c1, text="再生リスト").grid(row=0, column=2, sticky="w")
        self.lb_all = tk.Listbox(c1, height=11, exportselection=False, activestyle="none")
        for _, label in MOTIONS:
            self.lb_all.insert("end", label)
        self.lb_all.grid(row=1, column=0, sticky="nsew")
        self.lb_all.bind("<Double-Button-1>", lambda e: self.add_motion())
        mid = ttk.Frame(c1)
        mid.grid(row=1, column=1, padx=6)
        ttk.Button(mid, text="追加 →", width=8, command=self.add_motion).pack(pady=2)
        ttk.Button(mid, text="↑", width=8, command=lambda: self.move_motion(-1)).pack(pady=(14, 2))
        ttk.Button(mid, text="↓", width=8, command=lambda: self.move_motion(1)).pack(pady=2)
        ttk.Button(mid, text="削除", width=8, command=self.remove_motion).pack(pady=(14, 2))
        ttk.Button(mid, text="全消去", width=8, command=self.clear_motions).pack(pady=2)
        self.tv_seq = ttk.Treeview(c1, columns=("motion", "sec"), show="headings", height=10, selectmode="browse")
        self.tv_seq.heading("motion", text="モーション")
        self.tv_seq.heading("sec", text="秒数")
        self.tv_seq.column("motion", width=120)
        self.tv_seq.column("sec", width=60, anchor="center")
        self.tv_seq.grid(row=1, column=2, sticky="nsew")
        self.tv_seq.bind("<<TreeviewSelect>>", self.on_seq_select)
        secrow = ttk.Frame(c1)
        secrow.grid(row=2, column=2, sticky="ew", pady=(6, 0))
        ttk.Label(secrow, text="選んだ行の秒数").pack(side="left")
        self.v_sec = tk.DoubleVar(value=3.0)
        sp = ttk.Spinbox(secrow, from_=0.5, to=60, increment=0.5, textvariable=self.v_sec, width=6,
                         command=self.set_seconds)
        sp.pack(side="left", padx=6)
        sp.bind("<Return>", lambda e: self.set_seconds())
        sp.bind("<FocusOut>", lambda e: self.set_seconds())
        self.lbl_total = ttk.Label(c1, text="")
        self.lbl_total.grid(row=2, column=0, sticky="w", pady=(6, 0))
        self.v_move = tk.BooleanVar()
        ttk.Checkbutton(c1, text="歩く・走るで前に進む（オフでその場）", variable=self.v_move).grid(
            row=3, column=0, columnspan=3, sticky="w", pady=(8, 0))

        # ---- column 2: scene & output
        c2 = ttk.Frame(root)
        c2.grid(row=1, column=2, sticky="nsew")
        c2.columnconfigure(0, weight=1)
        sc = ttk.LabelFrame(c2, text="③ 背景とカメラ", padding=8)
        sc.grid(row=0, column=0, sticky="ew")
        sc.columnconfigure(1, weight=1)
        ttk.Label(sc, text="背景").grid(row=0, column=0, sticky="w")
        self.v_bg = tk.StringVar()
        self.combo(sc, BACKGROUNDS, self.v_bg, self.on_bg).grid(row=0, column=1, sticky="ew")
        self.btn_color = tk.Button(sc, text="色", width=4, command=self.pick_color, relief="groove")
        self.btn_color.grid(row=0, column=2, padx=(6, 0))
        ttk.Label(sc, text="カメラ").grid(row=1, column=0, sticky="w", pady=(6, 0))
        self.v_cam = tk.StringVar()
        self.combo(sc, CAMERAS, self.v_cam).grid(row=1, column=1, columnspan=2, sticky="ew", pady=(6, 0))
        ttk.Label(sc, text="ズーム").grid(row=2, column=0, sticky="w", pady=(6, 0))
        self.v_zoom = tk.DoubleVar()
        zf = ttk.Frame(sc)
        zf.grid(row=2, column=1, columnspan=2, sticky="ew", pady=(6, 0))
        ttk.Scale(zf, from_=0.5, to=2.5, variable=self.v_zoom,
                  command=lambda v: self.lbl_zoom.config(text=f"{float(v):.1f}x")).pack(side="left", fill="x", expand=True)
        self.lbl_zoom = ttk.Label(zf, text="1.0x", width=5)
        self.lbl_zoom.pack(side="left")
        self.v_follow = tk.BooleanVar()
        ttk.Checkbutton(sc, text="カメラがキャラについていく", variable=self.v_follow).grid(
            row=3, column=0, columnspan=3, sticky="w", pady=(6, 0))

        oc = ttk.LabelFrame(c2, text="④ 書き出し", padding=8)
        oc.grid(row=1, column=0, sticky="ew", pady=(8, 0))
        oc.columnconfigure(1, weight=1)
        ttk.Label(oc, text="サイズ").grid(row=0, column=0, sticky="w")
        self.v_res = tk.StringVar()
        ttk.Combobox(oc, textvariable=self.v_res, values=[r[0] for r in RESOLUTIONS], state="readonly").grid(
            row=0, column=1, columnspan=3, sticky="ew")
        ttk.Label(oc, text="画質").grid(row=1, column=0, sticky="w", pady=(6, 0))
        self.v_engine = tk.StringVar()
        self.combo(oc, ENGINES, self.v_engine).grid(row=1, column=1, columnspan=3, sticky="ew", pady=(6, 0))
        ttk.Label(oc, text="FPS").grid(row=2, column=0, sticky="w", pady=(6, 0))
        self.v_fps = tk.IntVar()
        ttk.Combobox(oc, textvariable=self.v_fps, values=[24, 30, 60], width=5, state="readonly").grid(
            row=2, column=1, sticky="w", pady=(6, 0))
        ttk.Label(oc, text="サンプル数").grid(row=2, column=2, sticky="e", pady=(6, 0))
        self.v_samples = tk.IntVar()
        ttk.Spinbox(oc, from_=1, to=1024, textvariable=self.v_samples, width=6).grid(
            row=2, column=3, sticky="w", padx=(6, 0), pady=(6, 0))
        ttk.Label(oc, text="保存先").grid(row=3, column=0, sticky="w", pady=(6, 0))
        self.v_out = tk.StringVar()
        ttk.Entry(oc, textvariable=self.v_out).grid(row=3, column=1, columnspan=2, sticky="ew", pady=(6, 0))
        ttk.Button(oc, text="…", width=3, command=self.pick_out).grid(row=3, column=3, sticky="w", padx=(6, 0), pady=(6, 0))
        ttk.Label(oc, text="ファイル名").grid(row=4, column=0, sticky="w", pady=(6, 0))
        self.v_name = tk.StringVar()
        ttk.Entry(oc, textvariable=self.v_name).grid(row=4, column=1, columnspan=3, sticky="ew", pady=(6, 0))

        pv = ttk.LabelFrame(root, text="プレビュー", padding=6)
        pv.grid(row=2, column=0, columnspan=2, sticky="nsew", pady=(8, 0), padx=(0, 8))
        pv.grid_propagate(False)
        pv.configure(height=300)
        self.preview = tk.Label(pv, text="「プレビュー」で 1 コマだけ描いて確認できます", bg="#2b2f36", fg="#cfd6e0")
        self.preview.pack(fill="both", expand=True)

        # ---- bottom: actions + log
        bot = ttk.Frame(root)
        bot.grid(row=3, column=0, columnspan=3, sticky="ew", pady=(10, 0))
        bot.columnconfigure(4, weight=1)
        self.btn_preview = ttk.Button(bot, text="プレビュー", command=lambda: self.start(preview=True))
        self.btn_preview.grid(row=0, column=0)
        self.btn_go = ttk.Button(bot, text="▶ アニメを生成", style="Big.TButton", command=self.start)
        self.btn_go.grid(row=0, column=1, padx=8)
        self.btn_stop = ttk.Button(bot, text="停止", command=self.stop, state="disabled")
        self.btn_stop.grid(row=0, column=2)
        ttk.Button(bot, text="保存先を開く", command=self.open_out).grid(row=0, column=3, padx=8)
        self.pb = ttk.Progressbar(bot, mode="determinate")
        self.pb.grid(row=0, column=4, sticky="ew", padx=8)
        self.btn_video = ttk.Button(bot, text="動画を再生", command=lambda: self.open_last("video"), state="disabled")
        self.btn_video.grid(row=0, column=5)
        self.btn_blend = ttk.Button(bot, text="Blender で開く", command=self.open_blend, state="disabled")
        self.btn_blend.grid(row=0, column=6, padx=(8, 0))
        self.lbl_status = ttk.Label(bot, text="準備OK")
        self.lbl_status.grid(row=1, column=0, columnspan=7, sticky="w", pady=(4, 0))
        lf = ttk.LabelFrame(root, text="ログ", padding=4)
        lf.grid(row=2, column=2, sticky="nsew", pady=(8, 0))
        lf.grid_propagate(False)
        lf.configure(height=300)
        self.log = tk.Text(lf, bg="#1e2127", fg="#c8d0da", insertbackground="#fff", relief="flat", wrap="char")
        self.log.pack(fill="both", expand=True)

    def combo(self, parent, pairs, var, on_change=None):
        labels = [p[1] for p in pairs]
        cb = ttk.Combobox(parent, values=labels, state="readonly")
        cb._pairs = pairs
        cb._var = var

        def changed(_=None):
            var.set(pairs[cb.current()][0])
            if on_change:
                on_change()
        cb.bind("<<ComboboxSelected>>", changed)

        def sync(*_):
            for i, (k, _) in enumerate(pairs):
                if k == var.get():
                    cb.current(i)
        var.trace_add("write", sync)
        return cb

    # ---------------- state <-> widgets
    def apply_settings(self):
        s = self.settings
        self.v_blender.set(s["blender"])
        self.v_skin.set(s["skin"])
        self.v_arms.set(s["arms"])
        self.v_item.set(s["item"])
        self.v_move.set(s["move"])
        self.v_bg.set(s["background"])
        self.bg_color = list(s["bg_color"])
        self.v_cam.set(s["camera"])
        self.v_follow.set(s["follow"])
        self.v_zoom.set(s["zoom"])
        self.lbl_zoom.config(text=f"{s['zoom']:.1f}x")
        self.v_res.set(s["resolution"] if s["resolution"] in dict(RESOLUTIONS) else RESOLUTIONS[0][0])
        self.v_fps.set(s["fps"])
        self.v_engine.set(s["engine"])
        self.v_samples.set(s["samples"])
        self.v_out.set(s["output_dir"])
        self.v_name.set(s["name"])
        for mid, sec in s["sequence"]:
            if mid in MOTION_LABEL:
                self.tv_seq.insert("", "end", values=(MOTION_LABEL[mid], sec), tags=(mid,))
        self.update_total()
        self.update_skin_preview()
        self.on_bg()

    def sequence(self):
        out = []
        for iid in self.tv_seq.get_children():
            mid = self.tv_seq.item(iid, "tags")[0]
            sec = float(self.tv_seq.item(iid, "values")[1])
            out.append([mid, sec])
        return out

    def collect(self):
        return {
            "blender": self.v_blender.get().strip(),
            "skin": self.v_skin.get(),
            "arms": self.v_arms.get(),
            "sequence": self.sequence(),
            "move": self.v_move.get(),
            "item": self.v_item.get(),
            "background": self.v_bg.get(),
            "bg_color": self.bg_color,
            "camera": self.v_cam.get(),
            "follow": self.v_follow.get(),
            "zoom": round(float(self.v_zoom.get()), 2),
            "resolution": self.v_res.get(),
            "fps": int(self.v_fps.get()),
            "engine": self.v_engine.get(),
            "samples": int(self.v_samples.get()),
            "output_dir": self.v_out.get().strip(),
            "name": self.v_name.get().strip() or "minecraft_anim",
        }

    # ---------------- callbacks
    def pick_blender(self):
        p = filedialog.askopenfilename(title="blender.exe を選ぶ",
                                       filetypes=[("Blender", "blender.exe blender Blender"), ("すべて", "*")])
        if p:
            self.v_blender.set(p)

    def detect_blender(self):
        p = find_blender()
        if p:
            self.v_blender.set(p)
            self.status(f"Blender を見つけました: {p}")
        else:
            messagebox.showwarning(APP_NAME, "Blender が見つかりませんでした。\nblender.org から 4.2 以降をインストールするか、「参照…」で blender.exe を選んでください。")

    def pick_skin(self):
        p = filedialog.askopenfilename(title="スキン画像（64×64 PNG）", filetypes=[("PNG", "*.png")])
        if p:
            self.v_skin.set(p)
            self.update_skin_preview()

    def update_skin_preview(self):
        path = self.v_skin.get() or os.path.join(ASSETS, "default_skin.png")
        self.lbl_skin.config(text=os.path.basename(self.v_skin.get()) if self.v_skin.get() else "（同梱スキン）")
        self.skin_canvas.delete("all")
        if Image is None or not os.path.isfile(path):
            return
        try:
            img, arms = skin_front(path, self.v_arms.get(), scale=7)
        except Exception as e:
            self.skin_canvas.create_text(75, 115, text="読めない画像", fill="#f88")
            self.write_log(f"スキン読み込み失敗: {e}")
            return
        self._photo = ImageTk.PhotoImage(img)
        self.skin_canvas.create_image(75, 115, image=self._photo)
        if self.v_arms.get() == "auto":
            self.lbl_skin.config(text=self.lbl_skin.cget("text") + f"\n腕: {'細め' if arms == 'slim' else '通常'}（自動）")

    def add_motion(self):
        sel = self.lb_all.curselection()
        if not sel:
            return
        mid, label = MOTIONS[sel[0]]
        sec = 4.0 if mid in ("walk", "run", "sneak") else 3.0
        iid = self.tv_seq.insert("", "end", values=(label, sec), tags=(mid,))
        self.tv_seq.selection_set(iid)
        self.update_total()

    def move_motion(self, d):
        sel = self.tv_seq.selection()
        if sel:
            idx = self.tv_seq.index(sel[0]) + d
            self.tv_seq.move(sel[0], "", max(0, idx))

    def remove_motion(self):
        for iid in self.tv_seq.selection():
            self.tv_seq.delete(iid)
        self.update_total()

    def clear_motions(self):
        for iid in self.tv_seq.get_children():
            self.tv_seq.delete(iid)
        self.update_total()

    def on_seq_select(self, _=None):
        sel = self.tv_seq.selection()
        if sel:
            self.v_sec.set(float(self.tv_seq.item(sel[0], "values")[1]))

    def set_seconds(self):
        sel = self.tv_seq.selection()
        try:
            sec = max(0.5, min(120.0, float(self.v_sec.get())))
        except (tk.TclError, ValueError):
            return
        if sel:
            vals = self.tv_seq.item(sel[0], "values")
            self.tv_seq.item(sel[0], values=(vals[0], sec))
        self.update_total()

    def update_total(self):
        total = sum(s for _, s in self.sequence())
        self.lbl_total.config(text=f"合計 {total:.1f} 秒")

    def on_bg(self):
        bg = self.v_bg.get()
        self.btn_color.config(state="normal" if bg == "studio" else "disabled")
        r, g, b = (int(max(0, min(1, c)) ** (1 / 2.2) * 255) for c in self.bg_color)
        self.btn_color.config(bg=f"#{r:02x}{g:02x}{b:02x}" if bg == "studio" else "SystemButtonFace" if os.name == "nt" else "#d9d9d9")

    def pick_color(self):
        r, g, b = (int(max(0, min(1, c)) ** (1 / 2.2) * 255) for c in self.bg_color)
        res = colorchooser.askcolor(color=f"#{r:02x}{g:02x}{b:02x}", title="背景の色")
        if res and res[0]:
            self.bg_color = [round((c / 255) ** 2.2, 4) for c in res[0]]
            self.on_bg()

    def pick_out(self):
        p = filedialog.askdirectory(title="保存先フォルダ", initialdir=self.v_out.get() or None)
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

    # ---------------- running Blender
    def build_config(self, preview):
        s = self.collect()
        seq = s["sequence"]
        if not seq:
            raise ValueError("再生リストにモーションを1つ以上追加してください。")
        res = dict(RESOLUTIONS).get(s["resolution"], (1920, 1080))
        total = sum(sec for _, sec in seq)
        cfg = {
            "skin": s["skin"], "arms": s["arms"],
            "motions": [{"id": m, "seconds": sec} for m, sec in seq],
            "move": s["move"], "item": s["item"], "camera": s["camera"], "follow": s["follow"],
            "zoom": s["zoom"], "background": s["background"], "bg_color": s["bg_color"],
            "resolution": list(res), "fps": s["fps"], "engine": s["engine"], "samples": s["samples"],
            "output_dir": s["output_dir"], "name": s["name"], "assets": ASSETS,
            "video": True, "save_blend": True,
        }
        if preview:
            sel = self.tv_seq.selection()
            t = total / 2
            if sel:  # preview the middle of the selected motion
                start = 0.0
                for iid in self.tv_seq.get_children():
                    sec = float(self.tv_seq.item(iid, "values")[1])
                    if iid == sel[0]:
                        t = start + sec * 0.4
                        break
                    start += sec
            cfg["preview_frame"] = int(t * s["fps"]) + 1
            cfg["resolution"] = [max(2, res[0] // 2), max(2, res[1] // 2)]
            cfg["samples"] = min(s["samples"], 16)
        return cfg

    def start(self, preview=False):
        if self.proc:
            return
        blender = self.v_blender.get().strip()
        if not blender or not os.path.isfile(blender):
            messagebox.showerror(APP_NAME, "Blender の場所が設定されていません。\n「自動検出」か「参照…」で blender.exe を選んでください。")
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
        self.set_running(True)
        self.status("Blender を起動中…")
        flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
        try:
            self.proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                         stdin=subprocess.DEVNULL, creationflags=flags,
                                         text=True, encoding="utf-8", errors="replace", bufsize=1)
        except OSError as e:
            self.set_running(False)
            messagebox.showerror(APP_NAME, f"Blender を起動できませんでした:\n{e}")
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
            self.status("停止しました")

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
        "animating": "モーションを作成中", "building background": "背景を作成中",
        "rendering preview": "プレビューを描画中", "rendering": "動画を描画中",
    }

    def handle_line(self, line):
        if line.startswith("BM_PROGRESS"):
            _, i, n = line.split()
            self.pb.config(maximum=int(n), value=int(i))
            self.status(f"描画中… {i} / {n} コマ")
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
        if line.startswith("Fra:") and "Sample" not in line and "Rendering" not in line:
            return
        if line.startswith("Error: Not freed memory"):
            return
        if line.startswith("BM_") or "Error" in line or "Traceback" in line or line.startswith("  File"):
            self.write_log(line)

    def finish(self, code):
        self.proc = None
        self.set_running(False)
        if code == 0 and any(k in self.last_files for k in ("video", "frames", "preview")):
            if self.preview_mode:
                self.show_preview(self.last_files.get("preview"))
                self.status("プレビューを描きました")
            else:
                self.pb.config(value=self.pb.cget("maximum"))
                out = self.last_files.get("video") or self.last_files.get("frames")
                self.status(f"完成: {out}")
                self.btn_video.config(state="normal")
            if "blend" in self.last_files:
                self.btn_blend.config(state="normal")
        else:
            self.status(f"失敗しました（終了コード {code}）。下のログを確認してください。")

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

    def on_close(self):
        if self.proc and not messagebox.askyesno(APP_NAME, "生成中です。止めて終了しますか？"):
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
