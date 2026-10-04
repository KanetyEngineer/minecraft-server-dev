"""Motion library for BlockMotion (pure Python, no bpy: the desktop app imports it too).

Each motion is f(t) -> pose, t in seconds since the motion started.
  bones: {bone: (x, y, z) degrees}  X = pitch, Y = roll (sideways), Z = yaw
  "lift": vertical offset of the whole body (m), "speed": forward speed (m/s)
  "pitch" / "roll": tilt the whole body (deg) about the feet, "oy": extra back offset (m)
Sign conventions (character faces -Y):
  legs / arms: x < 0 swings forward      body / head: x > 0 leans / looks down
  Arm.R: y > 0 raises it sideways        Arm.L: y < 0 raises it sideways
  z > 0 turns to the character's left
"""
import math

def sm(x):
    x = max(0.0, min(1.0, x))
    return x * x * (3 - 2 * x)


def m_idle(t):
    return {"Arm.R": (0, 3 + 2 * math.sin(t * 1.3), 0), "Arm.L": (0, -3 - 2 * math.sin(t * 1.3), 0),
            "Head": (4 * math.sin(t * 0.7), 0, 14 * math.sin(t * 0.45)),
            "Body": (1.0 * math.sin(t * 1.3), 0, 0)}


def walk_like(t, period, leg, arm, speed, bob=0.0, lean=0.0):
    ph = 2 * math.pi * t / period
    s = math.sin(ph)
    return {"Leg.R": (-leg * s, 0, 0), "Leg.L": (leg * s, 0, 0),
            "Arm.R": (arm * s, 2, 0), "Arm.L": (-arm * s, -2, 0),
            "Body": (lean, 0, 0), "Head": (-lean * 0.8, 0, 0),
            "lift": bob * abs(math.cos(ph)), "speed": speed}


def m_walk(t):
    return walk_like(t, 1.0, 34, 30, 1.7, bob=0.015)


def m_run(t):
    return walk_like(t, 0.62, 52, 58, 4.0, bob=0.05, lean=8)


def m_sneak(t):
    p = walk_like(t, 1.3, 20, 12, 0.8)
    p["Body"] = (28, 0, 0)
    p["Head"] = (-22, 0, 0)
    p["Arm.R"] = (p["Arm.R"][0] - 14, 3, 0)
    p["Arm.L"] = (p["Arm.L"][0] - 14, -3, 0)
    p["lift"] = -0.12
    return p


def m_wave(t):
    w = math.sin(2 * math.pi * t * 1.8)
    p = m_idle(t)
    p["Arm.R"] = (-15, 150 + 22 * w, 0)
    p["Head"] = (-4, -6, 8)
    return p


def m_look(t):
    k = (t % 4.0) / 4.0
    yaw = 55 * math.sin(2 * math.pi * k)
    p = m_idle(t)
    p["Head"] = (6 * math.sin(4 * math.pi * k), 0, yaw)
    p["Body"] = (0, 0, yaw * 0.15)
    return p


def swing(t, period):
    k = (t % period) / period
    if k < 0.45:  # wind-up
        return sm(k / 0.45)
    return 1 - sm((k - 0.45) / 0.3)  # strike, then hold low


def m_mine(t):
    a = swing(t, 0.42)
    return {"Arm.R": (-(25 + 95 * a), 4, 4), "Arm.L": (-10, -3, 0),
            "Head": (22, 0, 4), "Body": (4 + 4 * (1 - a), 0, 6 - 6 * a)}


def m_attack(t):
    a = swing(t, 0.6)
    return {"Arm.R": (-(15 + 100 * a), 10 + 20 * a, -25 + 50 * a), "Arm.L": (-8, -6, 0),
            "Head": (6, 0, -10 + 20 * a), "Body": (3, 0, -18 + 36 * a)}


def m_jump(t):
    period = 1.1
    k = (t % period) / period
    lift, crouch, arms = 0.0, 0.0, 0.0
    if k < 0.2:
        crouch = sm(k / 0.2)
    elif k < 0.8:
        u = (k - 0.2) / 0.6
        lift = 1.25 * 4 * u * (1 - u)
        crouch = 1 - sm(u / 0.25)
        arms = math.sin(math.pi * u)
    else:
        crouch = math.sin(math.pi * (k - 0.8) / 0.2) * 0.6
    return {"Body": (14 * crouch, 0, 0), "Head": (-10 * crouch, 0, 0),
            "Arm.R": (20 * crouch - 30 * arms, 25 * arms, 0), "Arm.L": (20 * crouch - 30 * arms, -25 * arms, 0),
            "Leg.R": (-25 * crouch - 15 * arms, 0, 0), "Leg.L": (-25 * crouch + 15 * arms, 0, 0),
            "lift": lift - 0.08 * crouch}


def m_cheer(t):
    p = m_jump(t * 1.4)
    p["lift"] *= 0.45
    sh = 12 * math.sin(2 * math.pi * t * 3)
    p["Arm.R"] = (-10, 160 + sh, 0)
    p["Arm.L"] = (-10, -160 + sh, 0)
    p["Head"] = (-15, 0, 0)
    return p


def m_dance(t):
    ph = 2 * math.pi * t / 0.5
    s = math.sin(ph)
    return {"Arm.R": (-20, 90 + 65 * s, 0), "Arm.L": (-20, -(90 - 65 * s), 0),
            "Body": (0, 8 * math.sin(ph / 2), 15 * math.sin(ph / 2)),
            "Head": (10 * math.sin(2 * ph), -8 * math.sin(ph / 2), 0),
            "Leg.R": (-18 * max(0, s), 0, 0), "Leg.L": (-18 * max(0, -s), 0, 0),
            "lift": 0.05 * abs(s)}


def m_sit(t):
    p = m_idle(t)
    p["Leg.R"] = (-90, 0, 8)
    p["Leg.L"] = (-90, 0, -8)
    p["Arm.R"] = (-28, 4, 0)
    p["Arm.L"] = (-28, -4, 0)
    p["lift"] = -0.62
    return p


def m_bow(t):
    k = (t % 2.5) / 2.5
    a = sm(k / 0.3) if k < 0.6 else 1 - sm((k - 0.6) / 0.3)
    return {"Body": (45 * a, 0, 0), "Head": (10 * a, 0, 0),
            "Arm.R": (-8 * a, 2, 0), "Arm.L": (-8 * a, -2, 0)}


def m_spin(t):
    p = m_idle(t)
    p["Arm.R"] = (0, 70, 0)
    p["Arm.L"] = (0, -70, 0)
    return p



# ---- whole-body helpers --------------------------------------------------
#   "pitch" / "roll": tilt the whole body (deg) about the feet, X then Y axis
#   "oy": extra forward/back offset of the body (m, +Y = backwards)
def ph_of(t, period):
    return 2 * math.pi * t / period


def flip_about_center(theta_deg, h=1.0):
    """Offsets that make a pitch rotation turn about the waist instead of the feet."""
    th = math.radians(theta_deg)
    return h * math.sin(th), h * (1 - math.cos(th))


def lying(t, face_down=True, lift=0.22):
    return {"pitch": 90 if face_down else -90, "lift": lift}


def m_walk_back(t):
    p = walk_like(t, 1.1, 28, 22, -1.2)
    p["Head"] = (5, 0, 0)
    return p


def m_crouch(t):
    p = m_idle(t)
    p["Body"] = (28, 0, 0)
    p["Head"] = (-22, 0, 10 * math.sin(t * 0.6))
    p["Arm.R"] = (-14, 3, 0)
    p["Arm.L"] = (-14, -3, 0)
    p["lift"] = -0.12
    return p


def m_crawl(t):
    s = math.sin(ph_of(t, 1.0))
    p = lying(t, True, 0.2)
    p.update({"Arm.R": (-150 - 30 * s, 10, 0), "Arm.L": (-150 + 30 * s, -10, 0),
              "Leg.R": (15 * s, 0, 0), "Leg.L": (-15 * s, 0, 0),
              "Head": (-60, 0, 0), "speed": 0.6})
    return p


def m_swim(t):
    k = (t % 1.2) / 1.2
    p = lying(t, True, 0.55 + 0.04 * math.sin(ph_of(t, 0.6)))
    f = 15 * math.sin(ph_of(t, 0.3))
    p.update({"Arm.R": (-360 * k, 6, 0), "Arm.L": (-360 * k - 180, -6, 0),
              "Leg.R": (f, 0, 0), "Leg.L": (-f, 0, 0),
              "Head": (-55, 0, 25 * math.sin(ph_of(t, 1.2))), "speed": 1.5})
    return p


def m_fly(t):
    b = math.sin(ph_of(t, 2.0))
    return {"pitch": 75, "lift": 1.3 + 0.12 * b, "roll": 6 * b,
            "Arm.R": (-175, 8, 0), "Arm.L": (-10, -12, 0),
            "Leg.R": (4, 3, 0), "Leg.L": (10, -3, 0), "Head": (-55, 0, 0), "speed": 5.0}


def m_lie_down(t):
    p = lying(t, False, 0.25)
    br = math.sin(ph_of(t, 3.0))
    p.update({"Arm.R": (0, 8, 0), "Arm.L": (0, -8, 0), "Body": (-1.5 * br, 0, 0),
              "Head": (-2 * br, 0, 25 * math.sin(t * 0.3)), "Leg.R": (0, 4, 0), "Leg.L": (0, -4, 0)})
    return p


def m_fall_down(t):
    a = sm(t / 0.7)
    bounce = 0.06 * math.sin(math.pi * min(1, max(0, (t - 0.7) / 0.25)))
    return {"pitch": -90 * a, "lift": 0.25 * a + bounce,
            "Arm.R": (-60 * a, 30 * a, 0), "Arm.L": (-60 * a, -30 * a, 0),
            "Leg.R": (-20 * a, 0, 0), "Leg.L": (-10 * a, 0, 0), "Head": (-20 * a, 0, 0)}


def m_die(t):
    a = sm(t / 0.5)
    return {"roll": 90 * a, "lift": 0.27 * a,
            "Arm.R": (0, 20 * a, 0), "Arm.L": (0, -5 * a, 0), "Head": (0, 10 * a, 0)}


def m_jumping_jacks(t):
    k = (t % 0.8) / 0.8
    o = math.sin(math.pi * k)  # closed -> open -> closed
    return {"Arm.R": (0, 10 + 160 * o, 0), "Arm.L": (0, -10 - 160 * o, 0),
            "Leg.R": (0, 18 * o, 0), "Leg.L": (0, -18 * o, 0),
            "lift": 0.15 * abs(math.sin(2 * math.pi * k))}


def m_stretch(t):
    a = 0.5 - 0.5 * math.cos(ph_of(t, 3.0))
    return {"Arm.R": (-10, 30 + 140 * a, 0), "Arm.L": (-10, -30 - 140 * a, 0),
            "Body": (-10 * a, 8 * math.sin(ph_of(t, 6.0)) * a, 0), "Head": (-20 * a, 0, 0),
            "lift": 0.03 * a}


def m_clap(t):
    c = abs(math.sin(ph_of(t, 0.8)))
    return {"Arm.R": (-75, 0, 8 + 18 * c), "Arm.L": (-75, 0, -8 - 18 * c),
            "Head": (-5 + 4 * c, 0, 0), "Body": (2 * c, 0, 0)}


def m_point(t):
    p = m_idle(t)
    p["Arm.R"] = (-90, 0, -10 + 6 * math.sin(t * 1.5))
    p["Head"] = (0, 0, -8)
    p["Body"] = (0, 0, -6)
    return p


def m_salute(t):
    p = m_idle(t)
    a = sm(t / 0.4)
    p["Arm.R"] = (-60 * a, 115 * a, 25 * a)
    p["Head"] = (-6 * a, 0, 0)
    p["Arm.L"] = (0, -2, 0)
    return p


def m_facepalm(t):
    sh = 4 * math.sin(ph_of(t, 0.5))
    return {"Arm.R": (-150, 25, 0), "Arm.L": (-150, -25, 0),
            "Head": (25, 0, sh * 3), "Body": (12, 0, sh)}


def m_shrug(t):
    k = (t % 1.6) / 1.6
    a = math.sin(math.pi * min(1, k / 0.6))
    return {"Arm.R": (-40 * a, 35 * a, -30 * a), "Arm.L": (-40 * a, -35 * a, 30 * a),
            "Head": (0, 12 * a, 0), "Body": (0, 0, 0), "lift": 0.02 * a}


def m_nod(t):
    p = m_idle(t)
    p["Head"] = (18 * max(0, math.sin(ph_of(t, 0.7))), 0, 0)
    return p


def m_shake_head(t):
    p = m_idle(t)
    p["Head"] = (5, 0, 35 * math.sin(ph_of(t, 0.6)))
    return p


def m_laugh(t):
    b = abs(math.sin(ph_of(t, 0.35)))
    return {"Body": (-10 + 6 * b, 0, 0), "Head": (-20 - 8 * b, 0, 0),
            "Arm.R": (-40, 0, 35), "Arm.L": (-40, 0, -35), "lift": 0.03 * b}


def m_cry(t):
    sob = math.sin(ph_of(t, 0.4))
    return {"Arm.R": (-140, 10, 25), "Arm.L": (-140, -10, -25),
            "Head": (28 + 4 * sob, 0, 0), "Body": (14 + 3 * sob, 0, 0), "lift": -0.02}


def m_angry(t):
    k = (t % 0.6) / 0.6
    r = math.sin(math.pi * k / 0.5) if k < 0.5 else 0.0
    l = math.sin(math.pi * (k - 0.5) / 0.5) if k >= 0.5 else 0.0
    return {"Leg.R": (-35 * r, 0, 0), "Leg.L": (-35 * l, 0, 0),
            "Arm.R": (10, 25, 0), "Arm.L": (10, -25, 0),
            "Body": (10, 0, 0), "Head": (-10, 0, 8 * math.sin(ph_of(t, 0.3))), "lift": 0.04 * (r + l)}


def m_scared(t):
    j = math.sin(ph_of(t, 0.12))
    return {"Arm.R": (-120, 10, 30 + 4 * j), "Arm.L": (-120, -10, -30 - 4 * j),
            "Body": (20, 0, 2 * j), "Head": (10, 0, 6 * math.sin(ph_of(t, 1.5))),
            "Leg.R": (-10, 4, 0), "Leg.L": (-10, -4, 0), "lift": -0.06 + 0.01 * j}


def m_eat(t):
    b = math.sin(ph_of(t, 0.25))
    return {"Arm.R": (-105 + 8 * b, -5, 35), "Arm.L": (-5, -3, 0),
            "Head": (6 + 4 * b, 0, -6), "Body": (2, 0, 0)}


def m_throw(t):
    k = (t % 1.2) / 1.2
    if k < 0.45:  # wind up: arm goes up and back
        w = sm(k / 0.45)
        arm, yaw, lean = 150 * w, -20 * w, -6 * w
    else:  # release: whip forward
        a = sm((k - 0.45) / 0.18)
        back = sm((k - 0.7) / 0.3)
        arm, yaw, lean = 150 - 210 * a + 60 * back, -20 + 40 * a - 20 * back, -6 + 18 * a - 12 * back
    return {"Arm.R": (arm, 12, 0), "Arm.L": (-30 if k < 0.45 else -10, -12, 0),
            "Body": (lean, 0, yaw), "Head": (0, 0, -yaw * 0.6),
            "Leg.R": (12, 0, 0), "Leg.L": (-15, 0, 0)}


def m_punch(t):
    k = (t % 0.7) / 0.7
    r = math.sin(math.pi * k / 0.5) if k < 0.5 else 0.0
    l = math.sin(math.pi * (k - 0.5) / 0.5) if k >= 0.5 else 0.0
    return {"Arm.R": (-40 - 50 * r, 5, 20 * r), "Arm.L": (-40 - 50 * l, -5, -20 * l),
            "Body": (6, 0, 15 * r - 15 * l), "Head": (-6, 0, -8 * r + 8 * l),
            "Leg.R": (12, 0, 0), "Leg.L": (-12, 0, 0)}


def m_kick(t):
    k = (t % 1.2) / 1.2
    a = math.sin(math.pi * min(1, k / 0.45)) if k < 0.45 else 0.0
    return {"Leg.R": (-95 * a, 0, 0), "Body": (-12 * a, 0, 0), "Head": (10 * a, 0, 0),
            "Arm.R": (20 * a, 30 * a, 0), "Arm.L": (-30 * a, -40 * a, 0)}


def m_shield(t):
    p = {"Arm.L": (-80, 0, -35), "Arm.R": (-20, 5, 0),
         "Body": (12, 0, -10), "Head": (-6, 0, 0), "Leg.R": (12, 0, 0), "Leg.L": (-15, 0, 0),
         "lift": -0.05 + 0.01 * math.sin(t * 3)}
    return p


def m_bow_shoot(t):
    k = (t % 2.0) / 2.0
    draw = sm(k / 0.6) if k < 0.8 else 0.0
    return {"Arm.L": (-90, 0, 12), "Arm.R": (-90, 0, 12 + 25 * draw),
            "Head": (0, 0, 10), "Body": (0, 0, -15 - 6 * draw),
            "Leg.R": (10, 0, 0), "Leg.L": (-10, 0, 0)}


def m_climb(t):
    s = math.sin(ph_of(t, 0.9))
    return {"Arm.R": (-150 - 25 * s, 6, 0), "Arm.L": (-150 + 25 * s, -6, 0),
            "Leg.R": (-45 * max(0, s), 0, 0), "Leg.L": (-45 * max(0, -s), 0, 0),
            "Head": (-25, 0, 0), "Body": (4, 0, 0), "lift": 0.05 * abs(s)}


def m_dab(t):
    k = (t % 1.5) / 1.5
    a = sm(k / 0.2) if k < 0.7 else 1 - sm((k - 0.7) / 0.2)
    return {"Arm.R": (-30 * a, 135 * a, 0), "Arm.L": (-110 * a, -10 * a, -55 * a),
            "Head": (35 * a, 0, -25 * a), "Body": (8 * a, 0, -10 * a)}


def m_floss(t):
    s = math.sin(ph_of(t, 0.6))
    c = math.cos(ph_of(t, 0.3))
    return {"Arm.R": (30 * c, 20 * s, 0), "Arm.L": (30 * c, 20 * s, 0),
            "Body": (0, -12 * s, 0), "Head": (0, 6 * s, 0),
            "Leg.R": (0, 6 * s, 0), "Leg.L": (0, 6 * s, 0), "lift": 0.02 * abs(s)}


def m_victory(t):
    k = (t % 0.7) / 0.7
    a = math.sin(math.pi * k)
    return {"Arm.R": (-20, 120 + 40 * a, 0), "Arm.L": (-10, -6, 0),
            "Head": (-15, 0, 0), "Body": (-4, 0, 0), "lift": 0.08 * a}


def m_sad(t):
    br = math.sin(t * 0.9)
    return {"Head": (35 + 2 * br, 0, 0), "Body": (14, 0, 0),
            "Arm.R": (-4, 1, 0), "Arm.L": (-4, -1, 0), "lift": -0.03}


def m_tpose(t):
    return {"Arm.R": (0, 90, 0), "Arm.L": (0, -90, 0)}


def m_zombie(t):
    p = walk_like(t, 1.4, 22, 0, 0.7)
    sw = 4 * math.sin(ph_of(t, 1.4))
    p["Arm.R"] = (-90 + sw, 4, 0)
    p["Arm.L"] = (-90 - sw, -4, 0)
    p["Head"] = (8, 10, 0)
    p["Body"] = (6, 4 * math.sin(ph_of(t, 2.8)), 0)
    return p


def m_skip(t):
    k = (t % 0.8) / 0.8
    s = math.sin(2 * math.pi * k)
    hop = abs(math.sin(2 * math.pi * k))
    return {"Leg.R": (-45 * max(0, s), 0, 0), "Leg.L": (-45 * max(0, -s), 0, 0),
            "Arm.R": (40 * s, 10, 0), "Arm.L": (-40 * s, -10, 0),
            "Head": (-5, 0, 0), "lift": 0.18 * hop, "speed": 2.2}


def m_backflip(t):
    k = (t % 1.4) / 1.4
    crouch = 0.0
    lift, rot, tuck = 0.0, 0.0, 0.0
    if k < 0.2:
        crouch = sm(k / 0.2)
    elif k < 0.8:
        u = (k - 0.2) / 0.6
        lift = 1.4 * 4 * u * (1 - u)
        rot = -360 * sm(u)
        tuck = math.sin(math.pi * u)
    else:
        crouch = 0.6 * math.sin(math.pi * (k - 0.8) / 0.2)
    oy, dz = flip_about_center(rot)
    return {"pitch": rot, "oy": oy, "lift": lift + dz - 0.08 * crouch,
            "Body": (14 * crouch, 0, 0), "Head": (-10 * crouch, 0, 0),
            "Arm.R": (20 * crouch - 160 * tuck, 10, 0), "Arm.L": (20 * crouch - 160 * tuck, -10, 0),
            "Leg.R": (-25 * crouch - 80 * tuck, 0, 0), "Leg.L": (-25 * crouch - 80 * tuck, 0, 0)}


def m_turn(t):
    """Turning in place; the heading change itself is handled by the baker (see TURNS)."""
    s = math.sin(ph_of(t, 0.5))
    return {"Leg.R": (-15 * max(0, s), 0, 0), "Leg.L": (-15 * max(0, -s), 0, 0),
            "Head": (0, 0, 0), "Arm.R": (0, 3, 0), "Arm.L": (0, -3, 0)}



# id, Japanese label, category
MOTION_INFO = [
    ("walk", "歩く", "移動"), ("run", "走る", "移動"), ("walk_back", "後ろ歩き", "移動"),
    ("sneak", "スニーク歩き", "移動"), ("skip", "スキップ", "移動"), ("zombie", "ゾンビ歩き", "移動"),
    ("crawl", "ほふく前進", "移動"), ("swim", "泳ぐ", "移動"), ("fly", "空を飛ぶ", "移動"),
    ("climb", "よじ登る", "移動"),
    ("turn_left", "左を向く", "向き"), ("turn_right", "右を向く", "向き"), ("turn_around", "振り返る", "向き"),
    ("spin", "くるっと回る", "向き"),
    ("idle", "待機", "基本"), ("look", "見回す", "基本"), ("crouch", "しゃがむ", "基本"),
    ("sit", "座る", "基本"), ("lie_down", "寝転ぶ", "基本"), ("tpose", "Tポーズ", "基本"),
    ("stretch", "伸び", "基本"), ("jumping_jacks", "ジャンピングジャック", "基本"),
    ("wave", "手を振る", "気持ち"), ("bow", "お辞儀", "気持ち"), ("nod", "うなずく", "気持ち"),
    ("shake_head", "首を横に振る", "気持ち"), ("clap", "拍手", "気持ち"), ("cheer", "バンザイ", "気持ち"),
    ("victory", "ガッツポーズ", "気持ち"), ("laugh", "大笑い", "気持ち"), ("cry", "泣く", "気持ち"),
    ("sad", "落ち込む", "気持ち"), ("angry", "地団駄", "気持ち"), ("scared", "怖がる", "気持ち"),
    ("facepalm", "頭を抱える", "気持ち"), ("shrug", "肩をすくめる", "気持ち"),
    ("point", "指さす", "気持ち"), ("salute", "敬礼", "気持ち"),
    ("mine", "採掘", "作業"), ("eat", "食べる", "作業"), ("throw", "投げる", "作業"),
    ("attack", "剣を振る", "戦闘"), ("punch", "パンチ", "戦闘"), ("kick", "キック", "戦闘"),
    ("shield", "盾で防ぐ", "戦闘"), ("bow_shoot", "弓を引く", "戦闘"),
    ("fall_down", "倒れる", "戦闘"), ("die", "やられる", "戦闘"),
    ("jump", "ジャンプ", "アクション"), ("backflip", "バク宙", "アクション"),
    ("dance", "ダンス", "ダンス"), ("floss", "フロス", "ダンス"), ("dab", "ダブ", "ダンス"),
]

MOTIONS = {
    "idle": m_idle, "walk": m_walk, "run": m_run, "sneak": m_sneak, "wave": m_wave,
    "look": m_look, "mine": m_mine, "attack": m_attack, "jump": m_jump, "cheer": m_cheer,
    "dance": m_dance, "sit": m_sit, "bow": m_bow, "spin": m_spin,
    "walk_back": m_walk_back, "crouch": m_crouch, "crawl": m_crawl, "swim": m_swim, "fly": m_fly,
    "lie_down": m_lie_down, "fall_down": m_fall_down, "die": m_die, "jumping_jacks": m_jumping_jacks,
    "stretch": m_stretch, "clap": m_clap, "point": m_point, "salute": m_salute, "facepalm": m_facepalm,
    "shrug": m_shrug, "nod": m_nod, "shake_head": m_shake_head, "laugh": m_laugh, "cry": m_cry,
    "angry": m_angry, "scared": m_scared, "eat": m_eat, "throw": m_throw, "punch": m_punch,
    "kick": m_kick, "shield": m_shield, "bow_shoot": m_bow_shoot, "climb": m_climb, "dab": m_dab,
    "floss": m_floss, "victory": m_victory, "sad": m_sad, "tpose": m_tpose, "zombie": m_zombie,
    "skip": m_skip, "backflip": m_backflip,
    "turn_left": m_turn, "turn_right": m_turn, "turn_around": m_turn,
}
# motions that change the heading for everything that follows (degrees, + = left)
TURNS = {"turn_left": 90.0, "turn_right": -90.0, "turn_around": 180.0}
# motions whose end pose would not blend well into the next one get no "hold" special-casing;
# whole-turn motions are normalised by the baker
BONES = ["Body", "Head", "Arm.R", "Arm.L", "Leg.R", "Leg.L"]
ROOT_KEYS = ("lift", "speed", "turn", "pitch", "roll", "oy")
ANGLE_KEYS = ("turn", "pitch", "roll")
BLEND_S = 0.35


def _ang(a, b, f):
    d = (b - a + 180.0) % 360.0 - 180.0  # shortest way round
    return a + d * f


def lerp_pose(a, b, f):
    out = {}
    for k in BONES:
        va, vb = a.get(k, (0, 0, 0)), b.get(k, (0, 0, 0))
        out[k] = tuple(_ang(x, y, f) for x, y in zip(va, vb))
    for k in ROOT_KEYS:
        x, y = a.get(k, 0.0), b.get(k, 0.0)
        out[k] = _ang(x, y, f) if k in ANGLE_KEYS else x + (y - x) * f
    return out


def motion_pose(mid, local, dur):
    p = lerp_pose(MOTIONS[mid](local), {}, 0)
    if mid == "spin":  # whole turns only, so the next motion faces forward again
        p["turn"] = 360.0 * max(1, round(dur / 1.2)) * min(1.0, local / dur)
    return p


assert set(MOTIONS) == {m[0] for m in MOTION_INFO}, set(MOTIONS) ^ {m[0] for m in MOTION_INFO}
