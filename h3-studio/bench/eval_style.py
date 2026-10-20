import sys, json
import numpy as np, av
from PIL import Image
import torch
from transformers import CLIPModel, CLIPProcessor

video, out_png = sys.argv[1], sys.argv[2]
prompts = json.loads(sys.argv[3])
c = av.open(video); frames = []
for f in c.decode(video=0):
    frames.append(f.to_ndarray(format='rgb24'))
c.close()
mid = frames[len(frames)//2]
Image.fromarray(mid).save(out_png)

name = 'openai/clip-vit-base-patch32'
m = CLIPModel.from_pretrained(name).eval(); pr = CLIPProcessor.from_pretrained(name)
imgs = [Image.fromarray(f) for f in frames[::4]][:6]
with torch.no_grad():
    ii = m.get_image_features(**pr(images=imgs, return_tensors='pt'))
    tt = m.get_text_features(**pr(text=prompts, return_tensors='pt', padding=True))
    if not torch.is_tensor(ii): ii = ii.pooler_output
    if not torch.is_tensor(tt): tt = tt.pooler_output
    ii = ii/ii.norm(dim=-1, keepdim=True); tt = tt/tt.norm(dim=-1, keepdim=True)
    sim = (ii @ tt.T).numpy()
print(json.dumps({'video': video, 'frames': len(frames), 'size': [frames[0].shape[1], frames[0].shape[0]],
                  'clip': {p: round(float(sim[:,i].mean()), 4) for i,p in enumerate(prompts)}}, indent=1, ensure_ascii=False))
