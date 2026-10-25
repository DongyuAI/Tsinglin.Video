"""Per-hairstyle editorial copy + SEO landing pages.

Each style gets an indexable page (/style/<id>) because that is what actually
ranks: people search "狼尾 适合什么脸型", not "AI 换发型".
"""
from __future__ import annotations

import html
from pathlib import Path

# id -> editorial fields.  Keep the voice plain and concrete: a real person
# deciding whether to cut their hair, not a marketing brochure.
SEO: dict[str, dict[str, str]] = {
    "bob_blunt": {
        "cat": "短发",
        "alias": "Blunt Bob / 齐脸短发",
        "intro": "发尾一刀剪平、长度卡在下巴，没有层次也没有碎发。是最省事的短发，也是最考验脸型的一款。",
        "face": "下颌线清晰、脖子偏长的人最占便宜；圆脸建议把长度放到下颌以下 2cm，方脸选侧分而不是中分。",
        "tell": "发尾一刀切平，不要打薄；长度到下巴，能扎起来的位置不要留；中分，两侧长度必须完全一致。",
        "care": "每天早上用直板夹带一下发尾就行，三分钟。头发自然卷的人要先做柔顺，否则剪完会炸。",
    },
    "bob_french": {
        "cat": "短发",
        "alias": "French Bob / 法式短发",
        "intro": "长度到下颌、带一点空气刘海的法式短发，比一刀切松、比狼尾乖，是这两年最好上手的一款。",
        "face": "几乎不挑脸型。额头高、发际线后移的人靠刘海修饰；脸偏长的人把刘海留到眉毛以下。",
        "tell": "长度到下颌，发尾稍微内扣；前面剪空气刘海，不要太厚；整体要有一点碎，不要剪成一刀切。",
        "care": "洗完吹到八成干，用手指抓松就行。刘海容易出油，早上单独洗一次刘海最快。",
    },
    "wolf_cut": {
        "cat": "中短发",
        "alias": "Wolf Cut / 狼尾短发",
        "intro": "头顶短碎、后颈留长，前后有明显落差的层次剪。动静之间头发会跟着走，是拍照最出片的一款。",
        "face": "鹅蛋脸、心形脸最好看；圆脸要靠头顶的蓬松度拉长比例，下颌宽的人把两侧留到下颌以下。",
        "tell": "头顶剪短打碎、要有层次；后颈留长，跟上面断开；刘海留成八字或者碎刘海，不要齐。",
        "care": "需要一点造型。吹干时把头低下来吹头顶，再用发蜡抓出纹理，不然会塌成普通短发。",
    },
    "pixie": {
        "cat": "超短发",
        "alias": "Pixie Cut / 精灵短发",
        "intro": "耳朵露出来、后颈推干净的超短发，五官会被完全放大。剪对了非常高级，剪错了很难救。",
        "face": "小脸、五官立体、脖子细长的人最合适；脸偏圆或下颌偏方的人，前面留一点碎刘海会更柔和。",
        "tell": "两侧盖住耳朵一半、后颈推干净；头顶留长度做纹理；前面留斜刘海，不要剪成男头。",
        "care": "每三到四周就要修一次，不然形状会散。每天出门前用一点发泥抓纹理。",
    },
    "curtain": {
        "cat": "中长发",
        "alias": "Curtain Bangs / 八字刘海",
        "intro": "中分、往两侧扫开的八字刘海，长度落在颧骨附近。是修饰颧骨和太阳穴最有效的一款。",
        "face": "颧骨高、太阳穴凹、脸偏宽的人效果最明显；额头特别窄的人把分线稍微偏一点。",
        "tell": "中分八字刘海，长度到颧骨下方；发尾要往外走，不要内扣；后面保留长度做层次。",
        "care": "刘海要用圆梳往外带，或者用夹板往外翻。不造型的话会贴脸，效果差一半。",
    },
    "long_layers": {
        "cat": "长发",
        "alias": "Long Layers / 长层次",
        "intro": "过胸长发加脸周层次，是最不挑人、最容易出氛围感的一款。头发会显得比实际更多。",
        "face": "所有脸型都能用。脸偏长的人在颧骨处加层次；发量少的人层次不要打太高，否则更塌。",
        "tell": "长度过胸，脸周剪层次修饰脸型；发尾不要剪齐，要有一点碎；整体保留重量，不要打薄太多。",
        "care": "吹干时把发根吹起来，发尾用大圆梳带一个弧度。发质干的人每周做一次发膜。",
    },
    "hime": {
        "cat": "长发",
        "alias": "Hime Cut / 姬发式",
        "intro": "齐刘海 + 两侧齐耳垂的直角侧发 + 后面长直发，日本平安时代传下来的轮廓，辨识度极高。",
        "face": "脸小、五官清淡的人最合适；脸偏宽的人把侧发留长到下颌以下，不然会显脸方。",
        "tell": "前面齐刘海、两侧剪到耳垂下方一刀齐，后面长直发不剪层次；三个部分的长度要分明。",
        "care": "必须直。自然卷的人要先做离子烫，否则侧发会翘，整个轮廓就散了。",
    },
    "shag": {
        "cat": "中短发",
        "alias": "Shag / 碎盖头",
        "intro": "七十年代传下来的高碎层次剪，刘海短、层次多、发尾碎。发量多的人剪完会轻一大截。",
        "face": "鹅蛋脸、长脸最合适；圆脸要靠头顶蓬松拉高，方脸把两侧留长一点盖住下颌角。",
        "tell": "整体打高层次、发尾要碎；刘海剪短到眉毛以上；两侧不要剪齐，要有参差。",
        "care": "越乱越好看，洗完抓点海盐喷雾吹干就行。头发太顺的人需要靠产品做出毛躁感。",
    },
    "mullet": {
        "cat": "男士",
        "alias": "Mullet / 鲻鱼头",
        "intro": "两侧推短、头顶留长、后面拖一条尾巴。复古回潮的一款，个性最强。",
        "face": "长脸、方脸都能压得住；脸偏圆的人把两侧推得更干净，视觉上收窄。",
        "tell": "两侧推短做渐变，头顶留长度打碎，后面留一条尾巴到脖子；上下要有明显断层。",
        "care": "两侧长得快，三周就要修一次。头顶用发蜡往后抓，尾巴吹顺。",
    },
    "lob_wavy": {
        "cat": "中长发",
        "alias": "Wavy Lob / 锁骨发",
        "intro": "长度到锁骨的中长发，配一点自然的波浪。是短发过渡期最安全的选择，也是最好打理的一款。",
        "face": "圆脸、方脸都合适，长度刚好落在下颌和锁骨之间，能把脸型切得很好看。",
        "tell": "长度到锁骨，发尾自然内扣；整体做一点大卷，不要小卷；脸周留一点碎发。",
        "care": "用卷发棒卷完再用手拨散，或者直接扎半丸子头留出波浪。比直发省事。",
    },
    "ponytail_high": {
        "cat": "盘发",
        "alias": "High Ponytail / 高马尾",
        "intro": "扎在头顶偏后位置的高马尾，两侧梳紧。最直接的显脸小、提气色的一款。",
        "face": "几乎所有脸型都能用；额头高、发际线后移的人前面留一点碎发修饰。",
        "tell": "扎在头顶最高点偏后一点，两侧梳紧不要鼓包；马尾要有重量，长度不够就接一点。",
        "care": "长期扎同一个位置会拉扯发际线，记得换位置。扎之前先用一点发油把碎发压下去。",
    },
    "bun_messy": {
        "cat": "盘发",
        "alias": "Messy Bun / 丸子头",
        "intro": "低位置、故意留碎发的丸子头。比高马尾松弛，适合不想露额头又想显脸小的人。",
        "face": "圆脸、方脸都合适；脸偏长的人把丸子扎低一点，两侧留碎发。",
        "tell": "扎在脑后偏低的位置，不要扎太紧；两侧和耳前各留几缕碎发；丸子要松，不要圆得像包子。",
        "care": "越乱越好，用手抓不用梳子。碎发用一点点发蜡捏出形状。",
    },
    "twin_tails": {
        "cat": "盘发",
        "alias": "Twin Tails / 双马尾",
        "intro": "两侧各扎一条的高双马尾，减龄效果最强，也最考验发量和长度。",
        "face": "小脸、下巴尖的人最好看；脸偏宽的人把马尾扎高、位置靠后，视觉上收窄。",
        "tell": "扎在耳朵斜上方，两边高度必须对称；马尾要直、发尾齐；前面留一点碎刘海。",
        "care": "头发要够长够多，不够的话接发。每天扎完记得松一松发根。",
    },
    "braid_french": {
        "cat": "编发",
        "alias": "French Braid / 法式编发",
        "intro": "从头顶开始贴着头皮往下编的辫子，干净、利落，适合通勤和运动。",
        "face": "不挑脸型。额头高的人从发际线开始编；后脑扁的人编之前先把后脑抓蓬。",
        "tell": "从头顶开始贴头皮编，每一股都要收紧；辫子顺着后脑往下走，不要歪；发尾留一小截。",
        "care": "洗完头吹干再编最服帖。编之前抹一点发油，碎发不会到处飞。",
    },
    "crop_textured": {
        "cat": "男士",
        "alias": "Textured Crop / 纹理碎盖",
        "intro": "刘海往前压、顶部打碎、两侧推短的男士短发，亚洲男生最稳的一款。",
        "face": "额头高、发际线后移的人靠刘海修饰；脸偏长的人刘海留长一点。",
        "tell": "两侧推短做渐变，顶部留 3-4cm 打碎，刘海往前压到额头中间；不要剪平。",
        "care": "每天用发蜡往前抓出纹理，两周修一次两侧。",
    },
    "fade_side": {
        "cat": "男士",
        "alias": "Side Part Fade / 侧分背头",
        "intro": "两侧渐变推短、头顶侧分往后梳的经典款。正式场合最稳，也最显精神。",
        "face": "方脸、长脸都合适；脸偏圆的人把分线做高一点，视觉上拉长。",
        "tell": "两侧渐变推短，头顶留长度侧分往后梳；分线要清晰，用推子刻出来。",
        "care": "必须用发油或者发蜡，不然撑不住。每天洗头后重新梳。",
    },
    "buzz": {
        "cat": "男士",
        "alias": "Buzz Cut / 圆寸",
        "intro": "全头推成同一个长度，最省事的一款。头型和五官会被完全暴露。",
        "face": "头型圆、后脑饱满、五官立体的人最合适；后脑扁的人让理发师后面留一点长度。",
        "tell": "全头 6mm，两侧可以再短一点；发际线推干净，不要留碎发。",
        "care": "完全不用打理，一个月推一次。头皮会晒，夏天记得防晒。",
    },
    "man_bun": {
        "cat": "男士",
        "alias": "Man Bun / 男士丸子头",
        "intro": "男士把长发在脑后扎成一个丸子，两侧收干净。文艺和硬朗之间的那一款。",
        "face": "脸型偏方、下颌线明显的人最好看；脸偏圆的人两侧要推干净。",
        "tell": "两侧推短或者收干净，后面留长扎起来；丸子位置在脑后偏上，不要太高。",
        "care": "头发要留到能扎起来，中间有半年尴尬期。扎的时候用发圈不要用皮筋。",
    },
    "korean_perm": {
        "cat": "男士",
        "alias": "Korean Perm / 韩式纹理烫",
        "intro": "顶部烫出 C 字弧度、保留自然分线的男士烫发，亚洲男生的标准答案。",
        "face": "几乎不挑脸型；额头宽的人留一点刘海，脸偏长的人顶部不要烫太高。",
        "tell": "顶部烫 C 字卷，卷度要大不要小；保留三七分；两侧推短但不要推光。",
        "care": "烫完三个月内形状最好。每天用一点发蜡抓出纹理，不要用梳子。",
    },
    "slick_back": {
        "cat": "男士",
        "alias": "Slicked Back / 湿发背头",
        "intro": "全部往后梳、带高光的湿发背头，气场最强的一款，也最挑发际线。",
        "face": "额头饱满、发际线整齐的人最合适；发际线后移的人改成侧分会更稳。",
        "tell": "全部往后梳，两侧收干净；要有光泽感，不要梳得太贴头皮。",
        "care": "需要发油或者湿发膏，每天洗头重做。出汗多的话撑不住一整天。",
    },
}

RELATED = {
    "短发": ["bob_french", "wolf_cut", "pixie"],
    "超短发": ["pixie", "bob_blunt", "crop_textured"],
    "中短发": ["wolf_cut", "shag", "lob_wavy"],
    "中长发": ["curtain", "lob_wavy", "long_layers"],
    "长发": ["long_layers", "hime", "curtain"],
    "盘发": ["ponytail_high", "bun_messy", "twin_tails"],
    "编发": ["braid_french", "bun_messy", "ponytail_high"],
    "男士": ["crop_textured", "korean_perm", "fade_side"],
}


def page(style: dict[str, str], base: str = "") -> str:
    """Render one indexable hairstyle page."""
    sid = style["id"]
    s = SEO.get(sid, {})
    zh, en = style["zh"], style["en"]
    cat = s.get("cat", "发型")
    alias = s.get("alias", en)
    img = f"/lookbook/{sid}.jpg"
    title = f"{zh}（{en.title()}）适合什么脸型？先看效果再剪 | 发型先看"
    desc = (f"{zh}适合什么脸型、怎么跟理发师说、日常怎么打理。"
            f"{s.get('face', '')[:60]}上传自拍即可看到自己剪这款的效果。")
    from .stylist import STYLES
    names = {x["id"]: x["zh"] for x in STYLES}
    rel = RELATED.get(cat, [])
    rel_html = "".join(
        f'<a class="rel" href="/style/{r}"><img src="/lookbook/{r}.jpg" alt="{names.get(r, r)}" '
        f'loading="lazy"><span>{names.get(r, r)}</span></a>' for r in rel)
    ld = (
        '{"@context":"https://schema.org","@type":"Article",'
        f'"headline":"{html.escape(title)}","image":"{img}",'
        '"author":{"@type":"Organization","name":"发型先看"},'
        '"publisher":{"@type":"Organization","name":"发型先看"},'
        f'"about":"{html.escape(zh)}","inLanguage":"zh-CN"}}'
    )
    faq = (
        '{"@context":"https://schema.org","@type":"FAQPage","mainEntity":['
        f'{{"@type":"Question","name":"{html.escape(zh)}适合什么脸型？",'
        f'"acceptedAnswer":{{"@type":"Answer","text":"{html.escape(s.get("face",""))}"}}}},'
        f'{{"@type":"Question","name":"怎么跟理发师说？",'
        f'"acceptedAnswer":{{"@type":"Answer","text":"{html.escape(s.get("tell",""))}"}}}}]}}'
    )
    return f"""<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />
<title>{html.escape(title)}</title>
<meta name="description" content="{html.escape(desc)}" />
<meta property="og:title" content="{html.escape(zh)} · 先看效果再剪" />
<meta property="og:description" content="{html.escape(s.get('intro',''))}" />
<meta property="og:image" content="{img}" />
<meta property="og:type" content="article" />
<link rel="canonical" href="{base}/style/{sid}" />
<style>
:root{{--ink:#141110;--ink2:#3d3733;--muted:#8a8079;--line:#e8e1d8;--paper:#fbf8f3;--accent:#b4472f}}
*{{box-sizing:border-box}}
body{{margin:0;background:var(--paper);color:var(--ink);
 font:16px/1.7 -apple-system,BlinkMacSystemFont,"PingFang SC","Noto Sans SC",sans-serif}}
.wrap{{max-width:640px;margin:0 auto;padding:18px 18px 90px}}
header{{position:sticky;top:0;background:rgba(251,248,243,.92);backdrop-filter:blur(12px);
 border-bottom:1px solid var(--line);z-index:10}}
.nav{{max-width:640px;margin:0 auto;padding:11px 18px;display:flex;align-items:center;gap:8px;font-weight:800}}
.nav a{{color:var(--ink);text-decoration:none}}
.nav i{{color:var(--accent);font-style:normal}}
.crumb{{font-size:12px;color:var(--muted);margin:14px 0 6px}}
h1{{font-size:28px;line-height:1.25;margin:6px 0 8px;letter-spacing:-.02em}}
h1 small{{display:block;font-size:14px;color:var(--muted);font-weight:500;letter-spacing:0;margin-top:6px}}
.hero{{border-radius:18px;overflow:hidden;background:#e9e2d8;aspect-ratio:3/4;max-width:420px;margin:16px auto}}
.hero img{{width:100%;height:100%;object-fit:cover;display:block}}
.cta{{display:flex;align-items:center;justify-content:center;gap:8px;background:var(--accent);color:#fff;
 text-decoration:none;border-radius:999px;padding:15px;font-weight:800;margin:16px auto;max-width:420px}}
h2{{font-size:18px;margin:28px 0 8px}}
p{{color:var(--ink2);margin:0 0 10px}}
ul{{margin:0 0 10px;padding-left:20px;color:var(--ink2)}}
li{{margin:4px 0}}
.tell li{{margin:6px 0}}
.rel-grid{{display:grid;grid-template-columns:repeat(3,1fr);gap:9px;margin-top:10px}}
.rel{{text-decoration:none;color:var(--ink);font-size:12px;text-align:center}}
.rel img{{width:100%;aspect-ratio:3/4;object-fit:cover;border-radius:12px;background:#e9e2d8;display:block;margin-bottom:5px}}
footer{{color:var(--muted);font-size:11px;text-align:center;margin-top:34px}}
</style>
<script type="application/ld+json">{ld}</script>
<script type="application/ld+json">{faq}</script>
</head>
<body>
<header><div class="nav"><a href="/studio">发型<i>先看</i></a></div></header>
<div class="wrap">
<div class="crumb"><a href="/studio" style="color:inherit">首页</a> › {cat} › {zh}</div>
<h1>{zh}<small>{alias}</small></h1>
<div class="hero"><img src="{img}" alt="{zh} 发型效果参考图" /></div>
<a class="cta" href="/studio?style={sid}">上传自拍，看自己剪{zh}的样子 →</a>
<h2>这是什么发型</h2>
<p>{s.get('intro','')}</p>
<h2>适合什么脸型</h2>
<p>{s.get('face','')}</p>
<h2>怎么跟理发师说</h2>
<ul class="tell"><li>{s.get('tell','').replace('；','</li><li>')}</li></ul>
<h2>日常怎么打理</h2>
<p>{s.get('care','')}</p>
<h2>看看别的{cat}</h2>
<div class="rel-grid">{rel_html}</div>
<footer>示例图为 AI 生成，非真实人物 · 发型先看</footer>
</div>
</body>
</html>"""
