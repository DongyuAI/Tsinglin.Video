# 发型先看 · h3-studio

输入脸型发质 → 挑一款**带结构参数**的发型 → 看到自己换上的样子。

系统的核心不是"生成一张好看的头发图"，而是把一款发型拆成理发师能复述的结构
（长度 / 层次 / 分缝 / 刘海 / 卷度 / 发尾 / 颅顶），用这套结构同时驱动
**参考样片**和**本人换发**，让用户选的时候看到的就是剪出来的。

```
┌──────────────────────┐   HTTP   ┌──────────────────────┐   HTTP   ┌────────────────┐
│ Astro 前端  :4321    │─────────▶│ FastAPI BFF  :8199   │─────────▶│ sd-server:1234 │
│ ComfyUI 风格节点画布 │          │ 图执行 / 任务队列     │          │ MiniMax-H3     │
└──────────────────────┘          │ 发型目录 / 样片       │          │ 常驻显存       │
                                  └──────────────────────┘          └────────────────┘
                                             │
                                  ComfyUI :8188  ← 静态样片出图（Qwen-Image-2.1）
```

## 仓库里有什么

| 路径 | 是什么 |
|---|---|
| `h3-studio/` | 产品本体：前端、BFF、发型目录、50 张样片 |
| `h3-studio/backend/app/lookbook/hairstyles_2026.json` | **发型目录，唯一数据源**（50 款） |
| `h3-studio/backend/app/lookbook/<id>.jpg` | 每款一张样片，与目录 id 一一对应 |
| `h3-studio/tools/prompt_builder.py` | 样片提示词构造器 |
| `h3-studio/tools/lookbook_comfy.py` | 样片出图 / 审图联系表 / 落库 的 CLI |
| `research/` | 小红书 / 抖音 / B 站等社区发型的原始抓取与提炼 |
| `temp/` | 临时脚本和中间产物，**不进版本库**，可随时删 |
| 根目录 `*.gguf` `*.safetensors` | MiniMax-H3 引擎权重，约 40 GB，不进版本库 |

## 快速开始

```bat
:: 后端 8199 + 前端 4321
h3-studio\start.bat
```

打开 <http://127.0.0.1:4321>，点顶栏 **Start engine** 加载引擎（约 29 GB 权重，首次较慢）。

只跑样片出图（不需要 H3 引擎，只要 ComfyUI）：

```bat
ComfyUI_windows_portable\python_embeded\python.exe -s ComfyUI\main.py --windows-standalone-build
```

## 发型目录

50 款，覆盖短发 / 中长发 / 长发 / 刘海 / 扎发 / 男士六类。每款字段：

| 字段 | 用途 |
|---|---|
| `len` `layer` `part` `bang` `curl` `end` `crown` | 结构参数，出图和换发都读这几个 |
| `order` | **理发师话术**——用户进店能原样念出来的那一句 |
| `gen` | 出图规格串（结构与参数的紧凑串接） |
| `face` `hair` `care` | 适配脸型、适配发质、日常打理成本 |
| `cat` `g` | 分类、性别 |

`stylist.py` 直接从这个 JSON 派生 `STYLES`，所以目录改一处，样片、换发提示词、
SEO 落地页同时跟着变。旧 id（`bob_blunt`、`wolf_cut` …）通过 `LEGACY_IDS`
仍然可用，老链接不会 404。

## 样片出图

```bat
:: 全部 50 款
python h3-studio/tools/lookbook_comfy.py gen

:: 指定几款，并套用 prompt_fixes.json 里的改写
python h3-studio/tools/lookbook_comfy.py gen --ids wool_roll,claw_clip --fix

:: 拼联系表看效果
python h3-studio/tools/lookbook_comfy.py sheet --ids wolf_short,hime_cut --out research/shots/a.jpg

:: 挑好的落进 lookbook/，再出一张 10×5 总览
python h3-studio/tools/lookbook_comfy.py assemble
python h3-studio/tools/lookbook_comfy.py grid
```

固定参数：896×1152，euler + simple，25 步，cfg 1.0，单卡约 3.5 分钟一张。
50 款全量约 3 小时。

样片必须是**同一套布光和构图**（白衬衫、浅灰无缝背景、85mm f2.0、半身），
否则用户比较的是灯光而不是发型。

## 提示词怎么写的

一条约 1200 字的棚拍 brief，四段：

1. **【发型硬性要求｜最高优先级】** —— 结构参数逐条列出，含绝对长度（下巴 30cm /
   锁骨 38cm / 胸 58cm）
2. **【禁止出现】** —— 由结构参数反推的对抗项（平齐的禁止"参差"，无卷的禁止"内扣"）
3. 人物 / 妆造 / 布光 / 镜头 —— 只描述拍摄，不抢发型
4. **【再次强调】** —— 末尾复述发型名与关键结构

一条实测结论：**写数字没用，写能看见的物理事实才有用。**

| 无效 | 有效 |
|---|---|
| 卷径 4cm 的大卷 | 一道波纹横跨大半个头，起伏很浅 |
| 发尾平齐 | 所有发尾在同一高度结束，断面是平的 |
| 鲨鱼夹盘发 | 一只带牙齿的黑色鲨鱼夹横向夹在脑后，清晰可见 |

`prompt_fixes.json` 存的就是这些改写。第一轮 50 张里有 12 张没命中结构，
换措辞后 11 张一次修好。

## 已知限制

- **内扣（发尾向内 C 形）** 是最顽固的一项，改了 4 轮、换 5 个 seed 才勉强成立，
  仍会时不时画成外翻。
- **近似款会塌在一起**：齐刘海 / 漫画刘海、水波纹 / 法式羊毛卷，只能靠
  "厚实不透光"这类次级特征拉开，仍有同质化。
- **Turbo 8 步 cfg 1.0 完全不听结构约束**，只会画"齐肩层次波波"。要控结构必须
  用 base 模型 25 步；cfg 提到 3.0 没有收益，只是慢一倍。
- **stable-diffusion.cpp 跑不了 Qwen-Image-2.1**：它的 64 通道 latent VAE 走了
  `wan_vae` 分支，输出全白。样片出图必须走 ComfyUI。

## 环境依赖

样片出图（ComfyUI）：

| 位置 | 文件 |
|---|---|
| `models/diffusion_models/` | `qwen_image_2.1_int8_convrot.safetensors` |
| `models/text_encoders/` | `qwen3vl_8b_int8_convrot.safetensors` |
| `models/vae/` | `qwen_image_2.1_vae_bf16.safetensors` |

换发视频（sd-server，权重放仓库根目录）：

`minimax_h3_ref2va_pruned-Q4_K.gguf`、`qwen3vl_32b_minimax_h3-Q4_K_M.gguf`、
`minimax_h3_video_vae_fp16.safetensors`、`minimax_h3_audio_vae_fp32.safetensors`。

注意 text encoder 必须用 safetensors 版：GGUF 的融合 QKV 会被读成 12288 维，
直接报 `LayerNorm(4096)` 维度错。

## 约定

- `temp/` 是垃圾场，任何一次性脚本、联系表、探针输出都丢这里，已 gitignore。
- 模型权重、`ComfyUI_windows_portable/`、`stable-diffusion.cpp/` 都是环境，不进库。
- 样片本身（`lookbook/*.jpg`，约 7 MB）**进库**——它是产品的一部分，不是构建产物。
