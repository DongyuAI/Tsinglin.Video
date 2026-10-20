# H3 Studio 实测评估 & AI 造型/妆造市场调研报告

日期：2026-10-20 · 硬件：2× Tesla P40 24GB（SM 6.1）· 引擎：stable-diffusion.cpp 3f8527a（CUDA 12）· ComfyUI 0.33.0

---

## 0. 结论先行

**1）h3-studio 确实更省显存，但省的不是"框架"，是"量化"。**

- 实测常驻显存 **33.87 GB**（TE 17.38 + DiT 10.94 + VAE 5.56），RAM 卸载 **0.00 MB**，46.08 GB 总显存下仍有 12.2 GB 余量。
- 原版 ComfyUI 工作流指向的官方权重组合（ref2va_int8_convrot + qwen3vl_nvfp4_awq + vae_int8）合计 **40.08 GB**；若文本编码器用 int8_convrot 则是 **51.53 GB**，直接超过 46.08 GB。
- 但 P40 是 Pascal（SM 6.1），**没有 FP4 张量核心**，官方 nvfp4 文本编码器在这台机器上根本跑不了；唯一能跑的 int8 组合又装不下。
- 所以在这台机器上"h3-studio 更省"成立，原因是它用 **Q4_K（≈4.5 bit）** 替代了官方的 **int8（≈8 bit）**，加上没有 PyTorch/Python 运行时开销——**不是**因为 sd.cpp 的显存管理比 ComfyUI 聪明。换到支持 FP4 的 Blackwell 上，官方 nvfp4 组合只要 40.08 GB，而我们的 Q4_K 仍是 33.87 GB，优势会缩小到 ~15%。

**2）量化确实改变了生成结果，但没有证据表明它稳定降低质量。**

- Q4_K_M → Q2_K_M（文本编码器，省 4.88 GB）：两段 prompt 的 CLIP 提示词贴合度一胜一负（A：Q4 领先 0.070 vs 0.040；B：Q4 0.124 vs Q2 0.168），**没有单调下降**。
- 同 seed 下 Q4 与 Q2 输出的 PSNR 13.09 dB / SSIM 0.497；而**仅换 seed** 的对照组是 PSNR 8.22 dB / SSIM 0.193。也就是说，量化带来的差异**小于**换一个随机种子带来的差异。
- 代价是"换了一张脸/一个构图"，而不是"变糊"。A 组里 Q2 的运动幅度从 10.27 掉到 5.05（画面明显更静），这是唯一一个方向明确的退化信号。

**3）市场：AI 发型已经是一片红海，但"能免费用、能出视频、能保脸"的三角没人占住。**

- 27 个站点无头浏览器实测（25 个完成结构化抓取）：**11 个可判定为"生成前必须登录"**，**6 个按次/订阅收费**，**5 个从国内网络不可达**（Fotor / Picsart / FaceApp / VEED / YouCam Online），1 个域名已变成成人站（youcam.com）。
- 真实注册并跑通流程的 best-haircut.com：邮箱验证通过后，点生成直接报 **"Generation failed · Insufficient credits"**——官网写的"新用户送 10 credits"没有兑现。
- 社媒 22 个账号/笔记的真实反馈集中在三点：**"不像自己"**、**"头发像假发套"**、**"要会员/要付费"**。
- 我们手上的 H3 是**参考生视频**模型：能直接输出"同一个人换发型后转头展示"的短视频，这是静态换发型产品给不了的，也是目前唯一可差异化的点。

---

## 1. 测试环境与方法

| 项 | 值 |
|---|---|
| GPU | 2× Tesla P40，23040 MiB/卡，合计 46080 MiB（46.08 GB），compute capability 6.1 |
| 驱动/后端 | CUDA 12，sd.cpp CUDA backend，ggml-cuda.dll |
| 引擎 | `sd-server.exe`（stable-diffusion.cpp 3f8527a），`--backend te=cuda0,diffusion=cuda1,vae=cuda1 --auto-fit off` |
| 权重 | DiT `minimax_h3_ref2va_pruned-Q4_K.gguf`、TE `qwen3vl_32b_minimax_h3-Q4_K_M.gguf`、VAE fp16、audio VAE fp32 |
| 采样 | 22 帧 / 24fps，res_multistep + simple，cfg 1.0，seed 42（量化实验为 12345） |
| 显存采样 | `nvidia-smi --query-gpu=memory.used` 每 300 ms 一次，取全程峰值 |
| 复现脚本 | `h3-studio/bench/vram-bench.mjs`、`bench/metrics.py`、`bench/eval_style.py` |

> 显存是**实测**；ComfyUI 一侧因为权重不可得/硬件不支持，采用**官方仓库文件体积 + 本机实测激活开销**推算，下面会逐项标注。

---

## 2. 显存实测

### 2.1 h3-studio（sd.cpp，Q4_K）

| 分辨率（对齐后） | cuda0 | cuda1 | 合计 | 耗时 |
|---|---|---|---|---|
| 864×480 | 16493 | 16854 | **33347 MiB** | 98 s |
| 1280×736（请求 720p） | 16489 | 18366 | **34855 MiB** | 167 s |
| 1920×1088（请求 1080p） | 16501 | 21095 | **37596 MiB** | 440 s |

- 空载基线：58 / 147 MiB。
- 权重常驻：**33872.22 MB，RAM 0.00 MB**（引擎日志 `diffusion_engine.cpp:1342`）。
- 2 步与 4 步的峰值差异 < 100 MiB，峰值由分辨率（激活）决定。
- 1080p 的 440 s 里，**VAE 解码占 159 s**（60 个 tile × 2.6 s），是长尾。

### 2.2 原版 ComfyUI 的官方配置（文件体积，HF `Comfy-Org/MiniMax-H3`）

| 角色 | 文件 | 体积 |
|---|---|---|
| DiT | `minimax_h3_ref2va_pruned_int8_convrot` | 20.97 GB |
| DiT（更小） | `..._pruned_w6a8` | 15.98 GB |
| TE | `qwen3vl_32b_minimax_h3_nvfp4_awq` | 15.69 GB |
| TE（P40 可用） | `qwen3vl_32b_minimax_h3_int8_convrot` | 27.14 GB |
| VAE | `minimax_h3_video_vae_int8_convrot` | 2.81 GB |
| Audio VAE | `minimax_h3_audio_vae_fp32` | 0.61 GB |

- 官方工作流（nvfp4 + int8）合计 **40.08 GB**；
- 换成 int8 文本编码器合计 **51.53 GB**；
- 我们的 Q4_K 组合合计 **33.87 GB**。

### 2.3 三种运行方式，别混为一谈

| 方式 | 权重驻留 | 峰值显存 | 单次生成代价 |
|---|---|---|---|
| h3-studio（本仓库） | 全部常驻 VRAM | **33.9 GB** | 无重复加载 |
| ComfyUI `--highvram` | 全部常驻 VRAM | **40.1 GB（nvfp4）/ 51.5 GB（int8）** | 无重复加载，但本机装不下/不支持 |
| ComfyUI 默认（dynamic vram） | 用完卸载到 CPU | 峰值可低于 33.9 GB | **每次重跑都要把 20–50 GB 权重搬一遍** |

ComfyUI 自己的 `comfy/cli_args.py:169` 写得很清楚：*"By default models will be unloaded to CPU memory after being used."* 所以"ComfyUI 更省显存"和"ComfyUI 更慢"是同一件事的两面。h3-studio 选择了"常驻换速度"，而这个选择只有在 4-bit 量化下才成立。

**结论：** 在 46.08 GB 的 P40 机器上，官方精度路径无法全常驻；h3-studio 用 Q4_K 把 51.5 GB 压到 33.9 GB，才换来"一次加载、反复生成"。这是量化的功劳，不是框架的功劳。

---

## 3. 量化质量评估

### 3.1 设计

只改**文本编码器**精度（Q4_K_M ↔ Q2_K_M），DiT/VAE/seed/步数/分辨率全部固定，比较输出视频。

| 组 | Prompt | Q4 | Q2 |
|---|---|---|---|
| A | platinum blonde blunt bob + straight bangs，缓慢转头 | `A_q4.webm` | `A_q2.webm` |
| B | black textured crop fade，转头微笑 | `B_q4.webm` | `B_q2.webm` |
| 对照 | 与 A 完全相同，仅 seed 42→999 | `A_seed999.webm` | — |

指标：逐帧 PSNR/SSIM、时序稳定性（相邻帧平均绝对差）、CLIP 图文相似度（正确描述 vs 两个干扰描述）。

### 3.2 结果

| 组 | PSNR | SSIM | 时序差(Q4/Q2) | CLIP 正确项 | 干扰项 | 贴合度余量 |
|---|---|---|---|---|---|---|
| A | 13.09 dB | 0.497 | 10.27 / **5.05** | 0.2674 / 0.2350 | 0.1975 / 0.1952 | **0.0699 / 0.0398** |
| B | 13.02 dB | 0.528 | 9.55 / 9.73 | 0.2864 / 0.3154 | 0.1994 / 0.1956 | **0.1239 / 0.1679** |
| 对照（换 seed） | **8.22 dB** | **0.193** | — | — | — | — |

### 3.3 怎么读这组数

1. **量化差异 < 采样差异。** 同 seed 换精度是 13 dB，换 seed 是 8 dB。4-bit→2.6-bit 的扰动没有跳出"换一个样本"的范围。
2. **提示词贴合度没有单调退化。** A 组 Q4 明显更好（余量 0.070 vs 0.040），B 组 Q2 反而更好（0.124 vs 0.168）。n=1，不能下"Q4 更好"的结论，但足以否定"Q2 一定更差"。
3. **唯一明确的退化是运动。** A 组 Q2 的时序差只有 Q4 的一半，画面更"静"。低精度文本编码器可能压低了动作幅度，这对"转头展示发型"是硬伤。
4. **绝对损失无法在本机测量。** bf16 参考需要 TE 51.5 GB + DiT 40.2 GB ≈ 92 GB，P40 装不下。所以"Q4 离满精度有多远"没有直接答案，只能用 Q4↔Q2 的敏感度曲线外推。

**工程建议：** 默认用 Q4_K_M；Q2_K_M 只作为"显存不够时"的降级档，并且要接受动作幅度下降。

---

## 4. 市场调研

### 4.1 方法

- **无头浏览器实测**：Chrome 155 headless + CDP，1440×960，逐站抓取 DOM 文本、按钮、上传控件、价格、截图，共 **27 个站点**（25 个完成结构化抓取）（`research/data/*.json` + `research/shots/*.png`）。
- **真实走流程**：对 3 个声称"免费/无需登录"的站做了上传+生成尝试；其中 best-haircut.com 用 Agent Mail（devlink@agent.qq.com）完成邮箱注册与验证。
- **规模数据**：中国区 App Store 公开评分人数（iTunes Search API），作为"用户规模"的代理指标。
- **社媒**：B 站搜索页 + 公开 API（播放/评论）、抖音视频页、百度/必应索引的小红书笔记，共 **22 个账号/笔记**。

### 4.2 TOP 10（按"规模 × 造型能力 × 可触达性"综合排序，非营收排名）

| # | 产品 | 类型 | 规模证据（CN App Store 评分数） | 造型能力 | 实测结论 |
|---|---|---|---|---|---|
| 1 | 剪映 / CapCut | 剪辑+AI 特效 | 22,046,037 | 换发型特效、模板 | Web 可访问，功能埋在编辑器内，需客户端 |
| 2 | 美图秀秀 | 修图+AI 人像 | 12,693,313 | 发型/妆容/写真 | 官网只做产品导流，能力在 App |
| 3 | 轻颜相机 | 美颜相机 | 4,925,532 | 美颜/妆效 | App only |
| 4 | 美颜相机 | 美颜相机 | 1,033,392 | 妆容/发型 | App only |
| 5 | 醒图 | 修图 | 631,041 | 人像精修 | App only（注意：xingtu.cn 是巨量星图，不是醒图） |
| 6 | 可灵 AI | 视频生成 | 81,535 | 参考生视频，可做发型迁移 | Web 可访问，生成需登录/会员（¥5.99 起） |
| 7 | 即梦 AI | 图/视频生成 | 23,142 | 参考生图/视频 | Web 可访问，需登录 |
| 8 | 妙鸭相机 | AI 写真 | 16,034 | 写真模板，非精准换发 | 仅 App |
| 9 | Perfect Corp / YouCam | AR 试妆（B2B） | 205（CN） | AR 发色/妆容，非生成式 | youcam-online 国内不可达；B2B API 为主 |
| 10 | Picsart | 通用编辑 | 19,931 | AI Hairstyle | 国内不可达 |
| 11 | Remini | 画质修复 | 5,339 | 顺带美颜 | Web 可访问，需登录 |
| 12 | Hairstyle AI / TryHair / SeeMyCut / HairChanger | 垂直换发型 | 0–1 | 生成式换发型 | 全部"免费"但生成前要登录/额度 |

> 说明：FaceApp、Fotor 在国内网络不可达，未纳入主榜；L'Oréal / Garnier 的 Virtual Try-On 是**染发 AR**，不是生成式换发型，单列为"传统美妆品牌方案"。

### 4.3 25 站实测记录（节选）

| 站点 | 可达 | 上传控件 | 生成前是否要登录 | 价格信号 | 备注 |
|---|---|---|---|---|---|
| best-haircut.com | ✅ | 有 | 是（已注册验证） | $1 / $4.9 / $9.9 | 验证后生成报 **Insufficient credits** |
| tryhair.ai | ✅ | 有 | 是 | $9.99 | 上传后进入 Studio，无登录不出图 |
| aihairstyle.cn | ✅ | 有 | 宣称"无需登录" | 免费 | 上传+点生成后 2 分钟无结果 |
| hairchanger.ai | ✅ | 落地页无 | 是 | 订阅 | 静态展示为主 |
| seemycut.com | ✅ | 无（需进工具） | 是 | 1 credit 新人礼 | 文案完整，漏斗前置登录 |
| hairstyleai.com | ✅ | 无 | 是 | $9 | "1,298 happy customers" |
| beautyplus.com | ✅ | 有 | 是 | 订阅 | 染发为主 |
| lorealparisusa.com | ✅ | 无（进 AR 组件） | 否 | 免费 | 200+ 色号，官方称 88% 色彩准确率 |
| garnier.co.uk | ✅ | 无（进 AR 组件） | 否 | 免费 | 同上，ModiFace 类 |
| sephora.com/virtual-artist | ❌ 403 | — | — | — | 反爬 |
| fotor / picsart / faceapp / veed / youcam-online | ❌ | — | — | — | 国内网络超时 |
| klingai / jimeng / hailuo / wanxiang | ✅ | 有 | 是 | ¥5.99–¥42/月 | 通用视频生成，非垂直造型 |
| meitu / miaoya / perfectcorp | ✅ | 无 | — | — | 官网只做导流 |

**三个可直接引用的行业事实：**

1. **"免费"是获客话术。** 11/25 站在点击生成前要求登录；best-haircut 明确写"新用户 10 free credits"，实际生成返回额度不足。
2. **静态图是绝对主流。** 25 站里只有可灵/即梦/海螺/万相这类通用视频模型能出视频，垂直发型产品**全部只出静态图**。
3. **同质化严重。** hairchanger / tryhair / seemycut / best-haircut / hairstyleaichanger 的页面结构、定价（$9.9 左右）、文案几乎同构，是同一套"套壳+API"打法。

### 4.4 社媒 22 个账号/笔记（真实发言节选）

| # | 平台 | 账号 | 量级 | 关键发言/观察 |
|---|---|---|---|---|
| 1 | B站 | 邻家小伙100 | 1,539 播放 | 教程型："给出九种发型设计…保持人脸不变" |
| 2 | B站 | 孤海FOTO | 5,764 | "Klein 最强换发型工作流…支持手动遮罩精准控制" |
| 3 | B站 | 跟着星星学PS | 41,319 | PS 手工换发，评论在问"光线不一致怎么自然" |
| 4 | B站 | AusLook | 505 | "照着 AI 给我的设计去换发型，好成功啊！" |
| 5 | B站 | 栗子味的面团 | 26,145 | "菲比一键换发型"，评论问"怎么没有这个发型" |
| 6 | B站 | 南风AI笔记 | 370 | "这个 AI 换发型 APP，3 个月做到月入 21 万" |
| 7 | B站 | 哈基米AI造梗机 | 153 | "自测脸型找到本命发型" |
| 8 | B站 | 瑞琪在剪辑 | 3,916 | 剪映换发型；评论："**骗人的 花会员的**" |
| 9 | B站 | AI风暴_ | 3,575 | "comfyui 不改变脸 换发型 可做小程序" |
| 10 | B站 | 阿羽in | 3,102,000 | "男生两步脸型自测"（需求侧验证） |
| 11 | B站 | 田逾欢sirius | 2,560,000 | "拒绝发型盲盒！找准脸型" |
| 12 | B站 | 太帅而被肘击 | 40 | "AI 测脸型选发型（VQA）" |
| 13 | B站 | pro-photo-AI | 17,000 | "Ai 一键换发型" |
| 14 | B站 | 啦啦网络LALAFace | 218 | 直播实时换脸换发型（灰产边缘） |
| 15 | 抖音 | 文心APP | 9.1 万粉 | "上传照片就行，手残党也能会"，评论："AI 给 AI 自己生成头发" |
| 16 | 抖音 | 农村小霞 | — | #AI理发翻车名场面，"AI 制作仅供娱乐" |
| 17 | 抖音 | 发型师水哥 | — | 真人剪发对比，专业侧供给 |
| 18 | 抖音 | 痞怼怼 | 9,234 粉 | 踩雷视频下评论："姐，我的秃头被你发现了" |
| 19 | 抖音 | 兔美美 | — | #AI设计发型踩雷现场 |
| 20 | 抖音 | 大炮记录生活 | — | 剃光头实测，真实决策场景 |
| 21 | 微博 | 吐槽AI换脸换发型后认不出 | — | "AI 生成的换发型类内容千篇一律" |
| 22 | 微博 | 财财说科技 | — | AI 换脸带货翻车，消费者可主张退一赔三 |

**归纳出的四个痛点：**

1. **保脸**：换完不像自己，是最高频吐槽。
2. **假发感**：发际线、发丝走向、光照不匹配，"像扣了个假发套"。
3. **付费墙**：免费额度名不副实，点生成才告诉你没额度。
4. **只有静态图**：用户真正想看的是"我转头时这个发型什么样"，静态图给不了。

### 4.5 市场空位

```
             能保脸
               ▲
               │   ● 我们的 H3 ref2v（视频 + 参考图）
               │
   静态图 ◄────┼────► 视频
               │        ● 可灵/即梦（通用，非垂直）
               │
             不能保脸
```

**没有人同时做到：免费试 + 保脸 + 出视频 + 发型可控。** 这就是切入点。

---

## 5. 用现有模型实现

### 5.1 为什么是 H3 ref2va

- H3 是**参考生视频**（ref2va）：一张人像作为身份参考，一段文本描述目标发型，直接输出"这个人转头展示新发型"的短视频。
- 相比静态换发型（inpainting/ID-adapter），它天然解决"假发感"——头发是**重新生成的**，有运动、有光照、有发丝走向。
- 相比通用视频模型（可灵/即梦），它已经在本机常驻，边际成本只有电费。

### 5.2 已实现

新增"AI 造型间"，不破坏原有 ComfyUI 画布：

| 文件 | 作用 |
|---|---|
| `backend/app/stylist.py` | 20 款发型目录 + 发色 + 提示词构造 + 负面词 + payload 构造 |
| `backend/app/main.py` | `GET /api/style/styles`、`POST /api/style/run`、`GET /api/style/jobs/{id}`、`GET /studio` |
| `backend/app/studio.html` | 单页 UI：上传人像/发型参考、选款、发色、时长/步数/尺寸、进度条、视频播放 |

调用方式：

```bash
# 1. 上传人像
curl -F "file=@portrait.jpg" http://127.0.0.1:8199/api/upload
# → {"ref":"h3studio:xxxx.jpg", ...}

# 2. 生成
curl -X POST http://127.0.0.1:8199/api/style/run -H 'Content-Type: application/json' -d '{
  "portrait":"h3studio:xxxx.jpg","style_id":"wolf_cut","color":"platinum",
  "frames":22,"steps":4,"seed":7
}'
```

提示词模板（`stylist.build_prompt`）：

```
the exact same person as the reference photo, identical face, identical facial
features, same skin tone and age, now with wolf cut, short choppy layers on top,
longer mullet at the back, platinum blonde hair. the person slowly turns the head
left and right to show the haircut from different angles, shoulders-up portrait,
neutral studio background, soft key light, photorealistic, 85mm lens, shallow
depth of field, high detail hair strands
```

负面词专门压"换脸/假发边/塑料皮肤"：`different person, face swap, ... helmet hair, wig edge visible`。

### 5.3 实测结果

| 项 | 值 |
|---|---|
| 任务 | 864×480，22 帧，4 步，seed 7，wolf cut + 铂金色 |
| 耗时 | **190.7 s**（含参考图视觉编码） |
| 产物 | `outputs/46cba7f52ade/46cba7f52ade.webm`（3.59 MB） |
| CLIP | "short platinum blonde wolf cut" **0.2915** vs "long dark hair" **0.2368** |
| 但 | "blonde bob" 0.2947 > wolf cut 0.2915 |

**读法：** 方向和发色**确实变了**（短 + 铂金），但**具体款型不够准**（狼尾被判成波波）。原因是文本编码器对"wolf cut"这种细粒度发型词不敏感，且只有一张人像参考、没有发型参考图。

### 5.4 下一步（按性价比排序）

1. **加发型参考图**（接口已支持 `style_ref`）：用目标发型照片做第二张 ref，比纯文本描述准得多。
2. **发型 LoRA**：Comfy-Org 已有 ref2v turbo LoRA（1.96 GB），4 步可用；社区也有换发型 LoRA，可把 20 步压到 4 步，单条从 ~16 分钟降到 ~3 分钟。
3. **脸部相似度闸门**：生成后用 CLIP/ArcFace 比对原图，低于阈值自动重跑，解决"不像自己"。
4. **两段式**：先用 H3 出 4 个角度的关键帧，再拼成"四视图"给理发师看（现有 `MiniMaxH3辅助四视图生成流-k2.json` 的思路）。

---

## 6. 局限

1. **ComfyUI 侧没有实跑。** 官方 nvfp4 权重在 P40 上不可执行，int8 组合 51.5 GB 超过 46.08 GB；本报告的 ComfyUI 数字是"官方文件体积 + 本机实测激活"的推算，已在文中标注。
2. **绝对量化损失不可测。** 需要 ~92 GB 的 bf16 权重，本机装不下。
3. **样本量小。** 量化实验每个 prompt 只有 1 个 seed；CLIP 差值在 ±0.03 内不宜过度解读。
4. **竞品真实生成覆盖不足。** 25 站中只有 3 家走到"上传+点生成"，且都被登录/额度拦住；竞品效果主要来自官方示例与社媒反馈。
5. **小红书/抖音搜索需登录。** 社媒数据来自可匿名访问的视频页、公开 API 与搜索引擎索引，不是平台内全量检索。

---

## 7. 复现

```bash
# 显存
cd h3-studio && node bench/vram-bench.mjs --w 864 --h 480 --frames 22 --steps 2 --tag h3_480p

# 量化对比（先起 Q4 服务，再换 Q2 重启）
node tools/gen.mjs bench/quant/A_q4.webm --w 864 --h 480 --frames 22 --steps 4 --seed 12345 --prompt "..."
HF_ENDPOINT=https://hf-mirror.com python bench/metrics.py bench/quant/A_q4.webm bench/quant/A_q2.webm bench/quant/A_metrics.json '["..."]'

# 造型
python backend/run.py
open http://127.0.0.1:8199/studio
```
