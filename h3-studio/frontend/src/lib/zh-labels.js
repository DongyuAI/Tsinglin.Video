/**
 * Hand-maintained English -> Chinese glossary for every *variable* (port and
 * widget name) the MiniMax-H3 templates use.
 *
 * ComfyUI only localises a subset of names, and it never localises a socket
 * that a subgraph promotes (those stay `first_frame`, `duration`, ...). The UI
 * shows every variable as `english (中文)`, so this table fills the gaps.
 */
export const ZH_LABELS = {
  // ---- MiniMax-H3 conditioning ----
  prompt: '提示词',
  negative_prompt: '负面提示词',
  first_frame: '首帧',
  last_frame: '尾帧',
  ref_image_size: '参考图像尺寸',
  model: '模型',
  'model.prompt': '提示词',
  'model.resolution': '分辨率',
  'model.duration': '时长',
  duration: '时长',
  resolution: '分辨率',

  // ---- model / loaders ----
  clip: '文本编码器',
  vae: 'VAE',
  audio_vae: '音频VAE',
  vae_name: 'VAE名称',
  vae_name_1: 'VAE名称',
  unet_name: 'UNet名称',
  clip_name: 'CLIP名称',
  weight_dtype: '数据类型',
  type: '类型',
  device: '设备',
  lora_name: 'LoRA名称',
  strength_model: '模型强度',
  strength_model_1: '模型强度',

  // ---- geometry / sampling ----
  width: '宽度',
  height: '高度',
  length: '长度',
  aspect_ratio: '宽高比',
  megapixels: '百万像素',
  multiple: '倍数',
  resolution_steps: '分辨率步数',
  upscale_method: '缩放算法',
  fps: '帧率',
  steps: '步数',
  denoise: '降噪',
  sampler_name: '采样器名称',
  sampler: '采样器',
  scheduler: '调度器',
  seed: '随机种子',
  noise_seed: '噪波随机种',
  control_after_generate: '生成后控制',
  fixed: '固定',
  expression: '表达式',
  value: '值',
  value_1: '值',
  value_2: '值',
  switch: '切换',
  on_true: '为真时',
  on_false: '为假时',
  preview: '预览',
  text: '文本',
  watermark: '水印',

  // ---- media / io ----
  image: '图像',
  images: '图像',
  upload: '选择文件上传',
  video: '视频',
  audio: '音频',
  filename_prefix: '文件名前缀',
  format: '格式',
  'format.codec': '编解码器',
  codec: '编码器',
  bit_depth: '位深',
  color_space: '色彩空间',

  // ---- latents / conditioning plumbing ----
  samples: 'Latent',
  latent_image: 'Latent图像',
  conditioning: '条件',
  noise: '噪波',
  guider: '引导器',
  sigmas: '西格玛',
  positive: '正向',
  denoised_output: '降噪Latent',
  output: '输出',
  batch_size: '批处理大小',

  // ---- reference media ----
  ref_image_0: '参考图像1',
  ref_image_1: '参考图像2',
  ref_image_2: '参考图像3',
  ref_video_0: '参考视频1',
  ref_video_audio_0: '参考视频音频1',
  ref_audio_0: '参考音频1',
  ref_audio_1: '参考音频2',
  ref_audio_2: '参考音频3',

  // ---- socket types (mostly on outputs) ----
  MODEL: '模型',
  CLIP: '文本编码器',
  VAE: 'VAE',
  CONDITIONING: '条件',
  LATENT: 'Latent',
  IMAGE: '图像',
  MASK: '遮罩',
  AUDIO: '音频',
  VIDEO: '视频',
  SAMPLER: '采样器',
  SIGMAS: 'Sigmas',
  GUIDER: '引导器',
  NOISE: '噪波',
  FLOAT: '浮点',
  INT: '整数',
  BOOL: '布尔值',
  BOOLEAN: '布尔',
  STRING: '字符串',
};

/** Chinese for a variable name, tolerating `prefix.name` forms. */
export function zhFor(name) {
  if (!name) return null;
  if (ZH_LABELS[name]) return ZH_LABELS[name];
  const short = name.includes('.') ? name.split('.').pop() : name;
  return ZH_LABELS[short] || null;
}

/** Render a variable as `english (中文)`; falls back to the bare name. */
export function labelEnZh(en, zh) {
  if (!en) return en;
  const z = zh && zh !== en ? zh : null;
  return z ? `${en} (${z})` : en;
}
