"""Long-form prompt builder for the 2026 hairstyle lookbook.

The prompt is a ~1200-character Chinese studio-photography brief whose first
paragraph is a hard constraint block (length / layers / parting / bangs / curl /
ends / crown / colour) taken straight from hairstyles_2026.json. Everything after
that block only describes the shoot (model, make-up, light, lens), so the
hairstyle stays the subject of the picture instead of the face.

    from prompt_builder import build, BY, forbid_for
    prompt = build(BY["wolf_short"], view=BACK_VIEW)
    negative = forbid_for(BY["wolf_short"])

Design note: numbers do not work, visible facts do. A curl diameter of 4cm is
ignored by the model; a wave that spans half the head is obeyed.
prompt_fixes.json keeps the overrides that had to be rewritten for that reason.
"""
from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CATALOG = ROOT / "h3-studio" / "backend" / "app" / "lookbook" / "hairstyles_2026.json"

CAT = json.loads(CATALOG.read_text(encoding="utf-8"))["styles"]
BY = {s["id"]: s for s in CAT}

FRONT_VIEW = "正面看向镜头，露出完整发型轮廓"
BACK_VIEW = "四分之三侧后方视角，能同时看清侧脸与后脑的发型结构"
BACK_IDS = {"wolf_short", "jp_wolf_perm", "collarbone_wolf", "m_wolf", "m_fade", "ear_tuck_short"}

FACE_F=("主体：一位25岁的中国女性，鹅蛋脸，三庭五眼比例标准，面部轮廓柔和；皮肤白皙细腻、通透有光泽，"
        "能看到真实的毛孔与细小的绒毛，鼻梁挺直、鼻头小巧，眼型细长、双眼皮褶皱自然，眼白干净、眼神清澈有光，"
        "唇形饱满、唇色自然偏粉；淡妆，底妆轻薄服帖，眉形为野生眉、眉峰柔和，睫毛根根分明，"
        "面颊有淡淡的腮红，神情平静放松、嘴角微微上扬，气质干净清爽。")
FACE_M=("主体：一位27岁的中国男性，面部轮廓清晰，下颌线利落；皮肤干净有真实纹理，眉形自然浓密，鼻梁挺直，"
        "眼神平静，神情放松，气质干净利落。")


LEN_CM=[("耳朵以上",18),("耳下",22),("下巴",30),("锁骨",38),("肩",45),("胸",58),("腰",72)]
def len_cm(s):
    t=s["len"]+s.get("end","")
    for k,v in LEN_CM:
        if k in t: return v
    return 40

def forbid_for(s):
    f=[]
    if "零层次" in s["layer"]: f += ["层次感","碎发","参差的发尾"]
    if "无卷" in s["curl"] or "完全直" in s["curl"] or "直发" == s["curl"]: f += ["卷发","波浪","内扣"]
    if "无刘海" in s["bang"]: f += ["刘海遮住额头","碎刘海"]
    if "平齐" in s["end"]: f += ["参差不齐的发尾","毛边"]
    if "中分" in s["part"]: f += ["侧分","分线歪斜"]
    if "高颅顶" in (s.get("crown") or ""): f += ["贴头皮","颅顶塌陷"]
    f += ["假发感","发际线不自然","炸毛","头发糊成一片","油头"]
    seen=[]; [seen.append(x) for x in f if x not in seen]
    return "、".join(seen)

def hair_lines(s):
    L=[f"发型名称：{s['zh']}（{s['en']}）",
       f"长度：{s['len']}，从发际线到发尾约 {len_cm(s)} 厘米",
       f"层次与剪裁：{s['layer']}",
       f"分缝：{s['part']}",
       f"刘海：{s['bang']}",
       f"卷度：{s['curl']}",
       f"发尾：{s['end']}"]
    if s.get("crown") and s["crown"] not in ("-",""):
        L.append(f"颅顶：{s['crown']}")
    L += [f"发色：{s['color']}", f"发量发质：{s.get('hair','中等发量')}"]
    return L

def hair_tail(s):
    base=("发丝细节：发际线清晰自然、边缘有细小胎毛，没有假发感；分缝两侧头发服帖不翘起；"
          "每一缕发丝都有独立走向与层次投影，头发表面有柔和的镜面高光带；发根自然立起不贴头皮；"
          "头发有真实的重量感与垂坠感；轮廓边缘干净利落。")
    _t=s["layer"]+s["end"]
    if ("不碎" not in _t) and any(k in _t for k in ("碎","参差","外翘","外翻")):
        base += "碎发是这个发型设计的一部分，但要成束、有方向、有层次，不能散乱成毛躁的一团。"
    else:
        base += "没有炸毛、没有飞散的碎发、没有糊成一片的色块。"
    return base

MAKEUP=("妆容细节：底妆是轻薄的奶油肌质感，T 区与鼻梁有克制的自然高光，不油不亮；眼妆只用大地色轻扫，"
        "眼尾不拉长；唇部是自然的豆沙色，边缘柔和；整体妆感服从发型，不抢戏。")
OUTFIT="服装：简约白色棉质衬衫，领口干净平整，肩线利落，颜色不抢发色。"
POSE="姿态：正面偏侧约十五度，肩膀放松自然下沉，双手自然垂放在身体两侧，完全不遮挡头发。"
COMP="构图：半身构图，头顶上方留出充足空间让完整发型入画，人物居中略微偏侧，画面干净。"
LIGHT=("光线：柔光箱作为主光从侧前方四十五度打亮面部，光比柔和、阴影通透；侧后方加一盏轮廓光，"
       "勾出头发外轮廓的高光边缘，让发丝在光里透亮；背景灯把背景提亮到浅灰，人物与背景分离干净。")
BG="背景：浅灰色纯色影棚背景，干净无杂物，轻微虚化，不出现任何道具与文字。"
LENS="镜头：85mm 定焦人像镜头，光圈 f/2.0，浅景深，焦点落在眼睛与发型轮廓上，边缘自然过渡。"
QUAL=("画质：8K 超高清，真实照片质感，皮肤保留真实纹理、不做过度磨皮，发丝锐利可数，"
      "色彩自然不过饱和，轻微胶片颗粒，专业商业摄影棚出片。"
      "masterpiece, best quality, ultra detailed, photorealistic, sharp focus, natural skin texture, film grain.")


EN_RULES=[
 ("零层次","one-length, zero layers"),
 ("高层次","high disconnected layers"),
 ("多层次","soft internal layers"),
 ("平齐","blunt even ends"),
 ("直角切断","blunt chin-length side locks with a sharp horizontal cut"),
 ("密集小卷","tight small curls on 2cm rods"),
 ("松散自然大卷","loose large waves on 4cm rods"),
 ("大卷","large waves"),
 ("中分","center part"),
 ("三七分","side part"),
 ("空气刘海","wispy see-through bangs"),
 ("八字刘海","curtain bangs swept to the cheekbones"),
 ("法式刘海","french bangs"),
 ("齐刘海","blunt bangs"),
 ("无刘海","no bangs"),
 ("高颅顶","high crown volume"),
 ("贴顺","sleek flat"),
]
def en_struct(s):
    t="；".join([s["len"],s["layer"],s["part"],s["bang"],s["curl"],s["end"],s.get("crown") or ""])
    out=[]
    for k,v in EN_RULES:
        if k in t and v not in out: out.append(v)
    out.append("natural hairline, visible individual strands")
    return "English structural terms: " + ", ".join(out) + "."

def build(s, view="正面看向镜头，露出完整发型轮廓", outfit=OUTFIT, extra=""):
    face = FACE_M if s["g"]=="M" else FACE_F
    head = "【发型硬性要求｜最高优先级，必须严格遵守】" + "；".join(hair_lines(s)) + "。"
    forbid = "【禁止出现】" + forbid_for(s) + "。"
    tail_repeat = f"【再次强调】画面主体是这个发型：{s['zh']}，{s['len']}，{s['layer']}，{s['bang']}，发色{s['color']}。"
    parts=["一张商业美发沙龙发型样片，超高清人像摄影", head, forbid, face, hair_tail(s)]
    if s["g"]!="M": parts.append(MAKEUP)
    parts += [en_struct(s), outfit, POSE, f"视角：{view}", COMP, LIGHT, BG, LENS]
    if extra: parts.append(extra)
    parts += [QUAL, tail_repeat]
    parts=[p.rstrip("。") for p in parts]
    return "。".join(parts)+"。"

if __name__=="__main__":
    for sid in ["blunt_bob","layer_collarbone","wool_roll","hime_cut","wolf_short","m_textured_crop"]:
        p=build(BY[sid]); print(sid, len(p))
    print(); print(build(BY["blunt_bob"]))
