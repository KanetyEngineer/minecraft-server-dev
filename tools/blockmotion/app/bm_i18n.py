"""UI language for BlockMotion: Japanese strings in the code are the keys, English is looked up here.

The language comes from settings.json ("lang": "ja" | "en"); without one, Japanese Windows / locales get
Japanese and everything else English.
"""
import json
import locale
import os

LANG = "ja"


def system_lang():
    try:
        import ctypes
        if ctypes.windll.kernel32.GetUserDefaultUILanguage() & 0x3FF == 0x11:
            return "ja"
        return "en"
    except Exception:
        pass
    for v in (os.environ.get("LANG", ""), (locale.getlocale()[0] or "")):
        if v.lower().startswith(("ja", "japanese")):
            return "ja"
    return "en"


def init(conf_path):
    global LANG
    lang = None
    try:
        with open(conf_path, encoding="utf-8") as f:
            lang = json.load(f).get("lang")
    except Exception:
        pass
    LANG = lang if lang in ("ja", "en") else system_lang()
    return LANG


def T(s, en=None):
    """Translate a Japanese UI string; `en` overrides the table where one Japanese word has two meanings."""
    if LANG == "ja":
        return s
    return en if en is not None else EN.get(s, s)


EN = {
    # items
    "なし": "None", "鉄の剣": "Iron sword", "ダイヤの剣": "Diamond sword", "鉄のツルハシ": "Iron pickaxe",
    "ダイヤのツルハシ": "Diamond pickaxe", "鉄の斧": "Iron axe", "鉄のシャベル": "Iron shovel", "松明": "Torch",
    "弓": "Bow",
    # backgrounds / time / weather / dimensions
    "草原": "Grassland", "砂漠": "Desert", "雪原": "Snowfield", "洞窟": "Cave", "ネザー": "Nether", "エンド": "The End",
    "マイクラのワールドを読み込む": "Load a Minecraft world", "スタジオ（単色）": "Studio (solid colour)",
    "グリーンバック": "Green screen", "透過（PNG連番）": "Transparent (PNG sequence)",
    "昼": "Day", "夕焼け": "Sunset", "夜": "Night", "晴れ": "Clear", "雨": "Rain", "雪": "Snow",
    "オーバーワールド": "Overworld",
    # cameras
    "ななめ前": "Front diagonal", "正面": "Front", "真横": "Side", "後ろ": "Back", "アップ": "Close-up",
    "ローアングル": "Low angle", "見下ろし": "High angle", "遠景": "Wide", "真上": "Top down",
    "ぐるっと回る": "Orbit", "ズームイン": "Dolly in", "ズームアウト": "Dolly out", "上昇（クレーン）": "Crane up",
    "横移動": "Tracking", "主観（目線）": "POV (eye level)", "肩越し": "Over the shoulder",
    "南": "South", "西": "West", "北": "North", "東": "East",
    # output
    "横長 1920×1080（YouTube）": "Landscape 1920×1080 (YouTube)",
    "縦長 1080×1920（TikTok・ショート）": "Portrait 1080×1920 (TikTok / Shorts)",
    "正方形 1080×1080": "Square 1080×1080", "横長 1280×720（軽い）": "Landscape 1280×720 (light)",
    "横長 3840×2160（4K）": "Landscape 3840×2160 (4K)",
    "標準（EEVEE・速い）": "Standard (EEVEE, fast)", "高画質（Cycles・遅い）": "High quality (Cycles, slow)",
    "下書き（Workbench・最速）": "Draft (Workbench, fastest)",
    "自動判定": "Auto detect", "通常（Steve 型）": "Classic (Steve)", "細め（Alex 型）": "Slim (Alex)",
    # window / menu / buttons
    "{app} {ver} - マイクラ3Dアニメ自動生成": "{app} {ver} - Minecraft 3D animation maker",
    "新しいプロジェクト": "New project", "プロジェクトを開く…": "Open project…", "プロジェクトを保存…": "Save project…",
    "終了": "Exit", "ファイル": "File", "言語 / Language": "Language / 言語", "参照…": "Browse…", "自動検出": "Detect",
    "プレビュー": "Preview",
    "「プレビュー」で 1 コマだけ描いて確認できます\n（再生リストで選んだ行のあたりを描きます）":
        "Press \"Preview\" to render a single frame\n(around the row selected in the playlist)",
    "ログ": "Log", "▶ アニメを生成": "▶ Render animation", "停止": "Stop", "保存先を開く": "Open output folder",
    "準備OK": "Ready", "動画を再生": "Play video", "Blender で開く": "Open in Blender",
    "言語を切り替えるとアプリを再起動します。よろしいですか？":
        "BlockMotion will restart to change the language. Continue?",
    # actors tab
    "① キャラクター": "① Characters", "出演者": "Cast", "＋ 追加": "+ Add", "複製": "Duplicate", "削除": "Remove",
    "スキン画像を選ぶ…": "Choose skin…", "腕の太さ": "Arms", "持ち物": "Held item", "立ち位置（ブロック）": "Position (blocks)",
    "X（東+）": "X (east +)", "Z（南+）": "Z (south +)", "向き": "Facing", "角度°": "Angle °",
    "歩く・走るで前に進む": "Walk / run moves forward",
    "モーション（{n}種類）": "Motions ({n})", "再生リスト": "Playlist", "追加 →": "Add →", "全消去": "Clear",
    "モーション": "Motion", "秒数": "Sec", "選んだ行の秒数": "Row seconds",
    "同梱スキン": "Bundled skin", "キャラ{n}": "Char {n}", "出演者は 8 人までです。": "Up to 8 characters.",
    "スキン画像（64×64 PNG）": "Skin image (64×64 PNG)", "（同梱スキン）": "(bundled skin)",
    "\n腕: {arms}（自動）": "\nArms: {arms} (auto)", "細め": "slim", "通常": "classic",
    "読めない画像": "Unreadable image", "スキン読み込み失敗: {e}": "Could not read skin: {e}",
    "このキャラ {own:.1f} 秒 / 動画 {total:.1f} 秒": "{own:.1f} s (video {total:.1f} s)",
    # camera tab
    "② カメラ": "② Camera", "カット割りが空のときのカメラ": "Camera when the shot list is empty",
    "カメラがキャラについていく": "Camera follows the character", "ズーム": "Zoom",
    "背景をぼかす（被写界深度）": "Blur background (depth of field)",
    "カット割り（上から順に切り替わる。動画の長さはキャラの再生リストで決まり、最後のカットが最後まで続きます）":
        "Shot list (top to bottom. The video length comes from the playlists; the last shot runs to the end)",
    "カメラ": "Camera", "映す相手": "Subject", "＋ カット追加": "+ Add shot", "選んだカット:": "Selected shot:",
    "全員": "Everyone",
    # background tab
    "③ 背景": "③ Background", "背景": "Background", "色": "Colour", "時間帯": "Time", "天気": "Weather",
    "マイクラのワールド": "Minecraft world", "ワールドフォルダ": "World folder", "選ぶ…": "Choose…",
    "ディメンション": "Dimension", "プレイヤーの位置を読み込む": "Use player position",
    "中心の座標（F3 の XYZ）": "Centre (XYZ from F3)", "読み込む範囲（ブロック）": "Area to load (blocks)",
    "半径": "Radius", "下": "Down", "上": "Up", "テクスチャ（Minecraft の jar）": "Textures (Minecraft jar)",
    "リソースパック（任意）": "Resource pack (optional)",
    "キャラの立ち位置（キャラクタータブの X / Z）は、この中心座標からのずれです。":
        "Character positions (X / Z on the Characters tab) are offsets from this centre. ",
    "キャラは足元の地面の高さに自動で立ちます。範囲を広げると読み込みと描画に時間がかかります。":
        "Characters stand on the ground automatically. A larger area takes longer to load and render. ",
    "サーバーのワールドはサーバーフォルダの world を選んでください。":
        "For a server world, choose the world folder inside the server folder.",
    "背景の色": "Background colour", "ワールドフォルダ（level.dat がある所）": "World folder (the one with level.dat)",
    "このワールドのプレイヤーの位置を中心座標にしますか？": "Use this world's player position as the centre?",
    "level.dat を読めませんでした: {e}": "Could not read level.dat: {e}",
    "level.dat にプレイヤーの位置がありませんでした（サーバーのワールドなど）。座標を入力してください。":
        "level.dat has no player position (e.g. a server world). Please enter the coordinates.",
    "プレイヤーの位置 X {x:.1f} / Y {y:.1f} / Z {z:.1f}（向き {yaw:.0f}°）を読み込みました":
        "Loaded player position X {x:.1f} / Y {y:.1f} / Z {z:.1f} (facing {yaw:.0f}°)",
    "Minecraft の jar（例: versions\\1.21.11\\1.21.11.jar）": "Minecraft jar (e.g. versions\\1.21.11\\1.21.11.jar)",
    "すべて": "All files",
    "Minecraft の jar が見つかりませんでした。一度ゲームを起動するか、jar を選んでください。":
        "No Minecraft jar found. Launch the game once, or choose the jar.",
    "リソースパック（zip）": "Resource pack (zip)",
    # effects / output tabs
    "④ 演出": "④ Effects", "タイトル（最初に表示）": "Title (shown first)",
    "映画風の黒帯（シネマスコープ）": "Cinematic black bars (letterbox)", "字幕（開始と終了は秒）": "Subtitles (start / end in seconds)",
    "開始": "Start", "セリフ": "Line", "追加": "Add", "更新": "Update",
    "⑤ 書き出し": "⑤ Output", "サイズ": "Size", "画質": "Quality", "サンプル数": "Samples", "保存先": "Output folder",
    "ファイル名": "File name",
    # blender / files
    "blender.exe を選ぶ": "Choose blender.exe", "Blender を見つけました: {p}": "Found Blender: {p}",
    "Blender が見つかりませんでした。\nblender.org から 4.2 以降をインストールするか、「参照…」で blender.exe を選んでください。":
        "Blender was not found.\nInstall Blender 4.2 or later from blender.org, or choose blender.exe with \"Browse…\".",
    "保存先フォルダ": "Output folder", "今の設定を消して新しいプロジェクトにしますか？": "Discard the current settings and start a new project?",
    "プロジェクトを開く": "Open project", "BlockMotion プロジェクト": "BlockMotion project",
    "開けませんでした:\n{e}": "Could not open:\n{e}", "開きました: {p}": "Opened: {p}",
    "プロジェクトを保存": "Save project", "保存しました: {p}": "Saved: {p}",
    "再生リストにモーションを1つ以上追加してください。": "Add at least one motion to a playlist.",
    "背景タブでワールドフォルダを選んでください。": "Choose a world folder on the Background tab.",
    "Blender の場所が設定されていません。\n「自動検出」か「参照…」で blender.exe を選んでください。":
        "Blender is not set.\nUse \"Detect\" or \"Browse…\" to choose blender.exe.",
    "Blender を起動中…": "Starting Blender…", "Blender を起動できませんでした:\n{e}": "Could not start Blender:\n{e}",
    "停止しました": "Stopped",
    # progress
    "ワールドを読み込み中": "Reading the world", "モーションを作成中": "Building motions", "カメラを配置中": "Placing cameras",
    "背景を作成中": "Building the background", "ワールドを組み立て中": "Building the world mesh",
    "プレビューを描画中": "Rendering preview", "動画を描画中": "Rendering video",
    "描画中… {i} / {n} コマ": "Rendering… frame {i} / {n}", "プレビューを描きました": "Preview rendered",
    "完成: {out}": "Done: {out}", "失敗しました（終了コード {code}）。ログを確認してください。":
        "Failed (exit code {code}). Please check the log.",
    "生成中です。止めて終了しますか？": "Rendering is in progress. Stop and exit?",
    # motion categories and names (bm_motions.MOTION_INFO)
    "移動": "Movement", "基本": "Basics", "気持ち": "Emotions", "作業": "Work", "戦闘": "Combat",
    "アクション": "Action", "ダンス": "Dance",
    "歩く": "Walk", "走る": "Run", "後ろ歩き": "Walk backwards", "スニーク歩き": "Sneak", "スキップ": "Skip",
    "ゾンビ歩き": "Zombie walk", "ほふく前進": "Crawl", "泳ぐ": "Swim", "空を飛ぶ": "Fly", "よじ登る": "Climb",
    "左を向く": "Turn left", "右を向く": "Turn right", "振り返る": "Turn around", "くるっと回る": "Spin",
    "待機": "Idle", "見回す": "Look around", "しゃがむ": "Crouch", "座る": "Sit", "寝転ぶ": "Lie down",
    "Tポーズ": "T-pose", "伸び": "Stretch", "ジャンピングジャック": "Jumping jacks",
    "手を振る": "Wave", "お辞儀": "Bow", "うなずく": "Nod", "首を横に振る": "Shake head", "拍手": "Clap",
    "バンザイ": "Cheer", "ガッツポーズ": "Victory pose", "大笑い": "Laugh", "泣く": "Cry", "落ち込む": "Sad",
    "地団駄": "Stomp (angry)", "怖がる": "Scared", "頭を抱える": "Facepalm", "肩をすくめる": "Shrug",
    "指さす": "Point", "敬礼": "Salute", "採掘": "Mine", "食べる": "Eat", "投げる": "Throw",
    "剣を振る": "Swing sword", "パンチ": "Punch", "キック": "Kick", "盾で防ぐ": "Block with shield",
    "弓を引く": "Draw bow", "倒れる": "Fall down", "やられる": "Die", "ジャンプ": "Jump", "バク宙": "Backflip",
    "フロス": "Floss", "ダブ": "Dab",
}
