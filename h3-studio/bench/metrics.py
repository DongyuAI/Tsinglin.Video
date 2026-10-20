"""Frame metrics between two webm renders: PSNR / SSIM / temporal stability / CLIP text-image score."""
import json, sys, os
import numpy as np
import av

def read_frames(path, n=None):
    c = av.open(path)
    out = []
    for f in c.decode(video=0):
        a = f.to_ndarray(format='rgb24')
        out.append(a)
        if n and len(out) >= n: break
    c.close()
    return out

def psnr(a, b):
    mse = np.mean((a.astype(np.float64) - b.astype(np.float64)) ** 2)
    return 99.0 if mse == 0 else 10 * np.log10(255.0 ** 2 / mse)

def ssim(a, b):
    from scipy.ndimage import gaussian_filter
    x = a.astype(np.float64); y = b.astype(np.float64)
    C1, C2 = (0.01 * 255) ** 2, (0.03 * 255) ** 2
    mx = gaussian_filter(x, 1.5); my = gaussian_filter(y, 1.5)
    sxx = gaussian_filter(x * x, 1.5) - mx * mx
    syy = gaussian_filter(y * y, 1.5) - my * my
    sxy = gaussian_filter(x * y, 1.5) - mx * my
    num = (2 * mx * my + C1) * (2 * sxy + C2)
    den = (mx ** 2 + my ** 2 + C1) * (sxx + syy + C2)
    return float(np.mean(num / den))

def temporal(frames):
    if len(frames) < 2: return 0.0
    d = [np.mean(np.abs(frames[i].astype(np.float64) - frames[i-1].astype(np.float64))) for i in range(1, len(frames))]
    return float(np.mean(d))

def clip_scores(frames, prompts):
    import torch
    from transformers import CLIPModel, CLIPProcessor
    from PIL import Image
    name = 'openai/clip-vit-base-patch32'
    model = CLIPModel.from_pretrained(name)
    proc = CLIPProcessor.from_pretrained(name)
    model.eval()
    imgs = [Image.fromarray(f) for f in frames[::4]][:6]
    with torch.no_grad():
        ii = model.get_image_features(**proc(images=imgs, return_tensors='pt'))
        tt = model.get_text_features(**proc(text=prompts, return_tensors='pt', padding=True))
        if not torch.is_tensor(ii): ii = ii.pooler_output
        if not torch.is_tensor(tt): tt = tt.pooler_output
        ii = ii / ii.norm(dim=-1, keepdim=True); tt = tt / tt.norm(dim=-1, keepdim=True)
        sim = (ii @ tt.T).cpu().numpy()
    return {p: float(sim[:, i].mean()) for i, p in enumerate(prompts)}

if __name__ == '__main__':
    a_path, b_path, out = sys.argv[1], sys.argv[2], sys.argv[3]
    prompts = json.loads(sys.argv[4]) if len(sys.argv) > 4 else []
    A, B = read_frames(a_path), read_frames(b_path)
    n = min(len(A), len(B))
    res = {'a': a_path, 'b': b_path, 'frames_a': len(A), 'frames_b': len(B), 'shape': list(A[0].shape)}
    res['psnr_mean'] = float(np.mean([psnr(A[i], B[i]) for i in range(n)]))
    res['ssim_mean'] = float(np.mean([ssim(A[i], B[i]) for i in range(n)]))
    res['psnr_min'] = float(np.min([psnr(A[i], B[i]) for i in range(n)]))
    res['temporal_a'] = temporal(A); res['temporal_b'] = temporal(B)
    if prompts:
        try:
            res['clip_a'] = clip_scores(A, prompts)
            res['clip_b'] = clip_scores(B, prompts)
        except Exception as e:
            res['clip_error'] = repr(e)
    print(json.dumps(res, indent=1, ensure_ascii=False))
    json.dump(res, open(out, 'w'), indent=1, ensure_ascii=False)
