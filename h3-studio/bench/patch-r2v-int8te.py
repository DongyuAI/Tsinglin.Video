"""ref2va workflow: official int8 text encoder + the same Q4_K DiT/VAE sd.cpp loads."""
import json, sys
src, dst = sys.argv[1], sys.argv[2]
d = json.load(open(src, encoding='utf-8'))
by_id = {n['id']: n for n in d['nodes']}
def setw(nid, w): by_id[nid]['widgets_values'] = w
by_id[127]['type'] = 'UnetLoaderGGUF'; setw(127, ['minimax_h3_ref2va_pruned-Q4_K.gguf'])
by_id[128]['type'] = 'CLIPLoader'
setw(128, ['qwen3vl_32b_minimax_h3_int8_convrot.safetensors', 'minimax', 'default'])
setw(119, ['minimax_h3_video_vae_fp16.safetensors'])
setw(120, ['minimax_h3_audio_vae_fp32.safetensors'])
setw(137, ['h3_portrait.jpg', 'image'])
setw(139, ['h3_ref2.jpg', 'image'])
setw(132, [0.75]); setw(143, [2]); setw(129, [42, 'fixed'])
setw(92, ['video/bench_comfy', 'auto', 'auto', 'auto'])
json.dump(d, open(dst, 'w', encoding='utf-8'), ensure_ascii=False)
print('patched ->', dst)
