"""Patch the shipped ref2va workflow to load the same GGUF weights sd.cpp uses."""
import json, sys
src, dst = sys.argv[1], sys.argv[2]
d = json.load(open(src, encoding='utf-8'))
PROMPT = ("the exact same person as <Picture 1>, identical face, identical facial features, "
          "same skin tone and age, now with a chin-length blunt bob, sharp straight ends, "
          "platinum blonde hair. the person slowly turns the head left and right to show the "
          "haircut from different angles, shoulders-up portrait, neutral studio background, "
          "soft key light, photorealistic, 85mm lens, shallow depth of field, high detail hair strands")
by_id = {n['id']: n for n in d['nodes']}
def setw(nid, w):
    by_id[nid]['widgets_values'] = w
by_id[127]['type'] = 'UnetLoaderGGUF'; setw(127, ['minimax_h3_ref2va_pruned-Q4_K.gguf'])
by_id[128]['type'] = 'CLIPLoaderGGUF'; setw(128, ['qwen3vl_32b_minimax_h3-Q4_K_M.gguf', 'minimax'])
setw(119, ['minimax_h3_video_vae_fp16.safetensors'])
setw(120, ['minimax_h3_audio_vae_fp32.safetensors'])
setw(137, ['h3_portrait.jpg', 'image'])
setw(139, ['h3_ref2.jpg', 'image'])
setw(138, [PROMPT])
setw(132, [0.75])   # -> 22 frames
setw(143, [2])      # steps
setw(129, [42, 'fixed'])
setw(92, ['video/bench_comfy', 'auto', 'auto', 'auto'])
json.dump(d, open(dst, 'w', encoding='utf-8'), ensure_ascii=False)
print('patched ->', dst, 'nodes', len(d['nodes']))
