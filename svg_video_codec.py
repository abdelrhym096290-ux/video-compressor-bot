#!/usr/bin/env python3
"""
svg_video_codec.py
تحويل فيديو أنمي إلى تمثيل SVG + CSS Animations بحركة حقيقية.
يقارن الحجم مع AV1 على المقطع كاملًا.
"""
import argparse
import json
import os
import subprocess
import sys
import time

import cv2
import numpy as np


def get_dimensions(video_path):
    probe = subprocess.run([
        'ffprobe', '-v', 'error', '-select_streams', 'v:0',
        '-show_entries', 'stream=width,height,r_frame_rate',
        '-of', 'json', video_path
    ], capture_output=True, text=True, check=True)
    info = json.loads(probe.stdout)
    stream = info['streams'][0]
    
    W = int(stream['width'])
    H = int(stream['height'])
    fps_num, fps_den = stream.get('r_frame_rate', '24/1').split('/')
    fps = float(fps_num) / float(fps_den)
    
    return W, H, fps


def decode_video(video_path, target_w=None, target_h=None):
    W, H, fps = get_dimensions(video_path)
    
    if target_w is None or target_h is None:
        target_w, target_h = W, H
    
    cmd = [
        'ffmpeg', '-hide_banner', '-loglevel', 'error', '-nostdin', '-i', video_path,
        '-vf', f'scale={target_w}:{target_h}',
        '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'
    ]
    
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE)
    
    frame_bytes = target_w * target_h * 3
    frames = []
    
    while True:
        raw = proc.stdout.read(frame_bytes)
        if len(raw) < frame_bytes:
            break
        frame = np.frombuffer(raw, dtype=np.uint8).reshape(target_h, target_w, 3)
        frames.append(frame)
    
    proc.stdout.close()
    proc.wait()
    
    return frames, {'width': target_w, 'height': target_h, 'fps': fps, 'n_frames': len(frames)}


def build_palette(frames, palette_size=16):
    all_pixels = []
    step = max(1, (frames[0].shape[0] * frames[0].shape[1]) // 5000)
    for f in frames:
        all_pixels.append(f.reshape(-1, 3)[::step])
    pixels = np.concatenate(all_pixels, axis=0).astype(np.float32)
    
    cv2.setRNGSeed(20260829)
    criteria = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 50, 0.1)
    _, _, centers = cv2.kmeans(
        pixels, palette_size, None, criteria, 3, cv2.KMEANS_PP_CENTERS
    )
    palette = np.clip(np.rint(centers), 0, 255).astype(np.uint8)
    return palette


def encode_curve(polygon, epsilon=1.5):
    peri = cv2.arcLength(polygon.astype(np.float32), True)
    if peri <= 0:
        return []
    eps = max(0.75, epsilon * peri / 1000.0)
    approx = cv2.approxPolyDP(polygon.astype(np.float32), eps, True)
    return approx.reshape(-1, 2).astype(np.int16).tolist()


def extract_curves(frame_rgb, palette, epsilon=1.5, min_area=20):
    H, W = frame_rgb.shape[:2]
    pixels = frame_rgb.reshape(-1, 3).astype(np.int32)
    palette_int = palette.astype(np.int32)
    
    dists = np.sum((pixels[:, None, :] - palette_int[None, :, :]) ** 2, axis=2)
    labels = np.argmin(dists, axis=1).reshape(H, W)
    
    curves = []
    for lid in range(len(palette)):
        mask = (labels == lid)
        if mask.sum() < min_area:
            continue
        
        contours, _ = cv2.findContours(
            mask.astype(np.uint8) * 255,
            cv2.RETR_EXTERNAL,
            cv2.CHAIN_APPROX_SIMPLE
        )
        
        for cnt in contours:
            if cv2.contourArea(cnt) < min_area:
                continue
            poly = encode_curve(cnt.reshape(-1, 2), epsilon)
            if len(poly) >= 3:
                curves.append({
                    'fill_id': int(lid),
                    'points': poly,
                    'n_points': len(poly),
                    'cx': float(np.mean([p[0] for p in poly])),
                    'cy': float(np.mean([p[1] for p in poly])),
                    'area': float(cv2.contourArea(np.array(poly, dtype=np.int32).reshape(-1, 1, 2)))
                })
    
    return curves


def match_curves(prev_curves, curr_curves, max_dist=30):
    """مطابقة المنحنيات بين إطارين لتتبع الحركة."""
    matches = []
    used_curr = set()
    
    for pc in prev_curves:
        best_match = None
        best_dist = float('inf')
        
        for i, cc in enumerate(curr_curves):
            if i in used_curr:
                continue
            
            # مطابقة باللون والمسافة
            if cc['fill_id'] != pc['fill_id']:
                continue
            
            dist = np.sqrt((pc['cx'] - cc['cx'])**2 + (pc['cy'] - cc['cy'])**2)
            
            if dist < best_dist:
                best_dist = dist
                best_match = (i, cc)
        
        if best_match and best_dist < max_dist:
            i, cc = best_match
            used_curr.add(i)
            matches.append({
                'prev': pc,
                'curr': cc,
                'dx': cc['cx'] - pc['cx'],
                'dy': cc['cy'] - pc['cy'],
                'area_ratio': cc['area'] / max(pc['area'], 1)
            })
    
    return matches


def curves_to_svg_path(curve, palette):
    """تحويل منحنى واحد إلى SVG path."""
    color = palette[curve['fill_id']]
    color_hex = '#{:02x}{:02x}{:02x}'.format(
        int(color[0]), int(color[1]), int(color[2])
    )
    
    pts = curve['points']
    if len(pts) < 3:
        return None
    
    path = f"M {pts[0][0]},{pts[0][1]}"
    for i in range(1, len(pts)):
        path += f" L {pts[i][0]},{pts[i][1]}"
    path += " Z"
    
    return f'<path d="{path}" fill="{color_hex}" stroke="none"/>'


def build_svg_with_real_motion(frames, palette, curves_list, W, H, fps):
    """بناء SVG مع حركة حقيقية مستخرجة من الإطارات."""
    
    # استخدام أول إطار كأساس
    base_curves = curves_list[0]
    
    # تتبع الحركة عبر الإطارات
    motion_data = []
    prev_curves = base_curves
    
    for i in range(1, len(frames)):
        curr_curves = curves_list[i]
        matches = match_curves(prev_curves, curr_curves)
        
        for m in matches:
            motion_data.append({
                'curve_id': f"curve_{m['prev']['fill_id']}_{int(m['prev']['cx'])}_{int(m['prev']['cy'])}",
                'frame': i,
                'dx': m['dx'],
                'dy': m['dy'],
                'area_ratio': m['area_ratio']
            })
        
        prev_curves = curr_curves
    
    # بناء SVG مع عناصر قابلة للتحريك
    svg_elements = []
    animations = []
    
    for idx, curve in enumerate(base_curves):
        path = curves_to_svg_path(curve, palette)
        if path is None:
            continue
        
        curve_id = f"curve_{curve['fill_id']}_{int(curve['cx'])}_{int(curve['cy'])}"
        
        # إضافة عنصر مع id للتحريك
        svg_elements.append(
            path.replace('<path ', f'<path id="{curve_id}" ')
        )
        
        # حساب الحركة لهذا العنصر
        curve_motions = [m for m in motion_data if m['curve_id'] == curve_id]
        
        if curve_motions:
            # توليد keyframes للحركة
            total_frames = len(frames)
            duration = total_frames / fps
            
            keyframes = []
            for m in curve_motions:
                frame_pct = (m['frame'] / total_frames) * 100
                keyframes.append(f"{frame_pct}% {{ transform: translate({m['dx']}px, {m['dy']}px); }}")
            
            if keyframes:
                anim = f"""
@keyframes move_{idx} {{
  from {{ transform: translate(0, 0); }}
  {chr(10).join(keyframes)}
  to {{ transform: translate(0, 0); }}
}}
#{curve_id} {{{
  animation: move_{idx} {duration}s linear infinite;
  transform-origin: center;
}}"""
                animations.append(anim)
    
    # بناء الملف النهائي
    svg_body = '\n'.join(svg_elements)
    css_animations = '\n'.join(animations)
    
    html = f"""<!DOCTYPE html>
<html>
<head>
<style>
  body {{ margin:0; padding:0; background:#000; overflow:hidden; }}
  svg {{ width:100vw; height:100vh; }}
  {css_animations}
</style>
</head>
<body>
<svg viewBox="0 0 {W} {H}" preserveAspectRatio="xMidYMid meet">
{svg_body}
</svg>
</body>
</html>"""
    
    return html


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('input_video', help='مسار فيديو الأنمي')
    ap.add_argument('output_dir', help='مجلد النتائج')
    ap.add_argument('--palette-size', type=int, default=16)
    ap.add_argument('--epsilon', type=float, default=1.5)
    ap.add_argument('--min-area', type=int, default=20)
    ap.add_argument('--crf', type=int, default=30)
    ap.add_argument('--preset', type=int, default=8)
    args = ap.parse_args()
    
    os.makedirs(args.output_dir, exist_ok=True)
    
    print(f"=== بدء المعالجة: {args.input_video} ===")
    
    # 1. فك الفيديو كاملًا
    t0 = time.time()
    frames, info = decode_video(args.input_video)
    decode_time = time.time() - t0
    W, H = info['width'], info['height']
    n_frames = info['n_frames']
    fps = info['fps']
    print(f"تم فك {n_frames} إطارًا ({W}x{H}) في {decode_time:.1f} ثانية")
    
    if n_frames == 0:
        print("خطأ: لا توجد إطارات", file=sys.stderr)
        sys.exit(1)
    
    # 2. بناء القاموس
    t0 = time.time()
    sample_indices = np.linspace(0, n_frames - 1, min(10, n_frames), dtype=int)
    sample_frames = [frames[i] for i in sample_indices]
    palette = build_palette(sample_frames, args.palette_size)
    palette_time = time.time() - t0
    print(f"تم بناء القاموس ({args.palette_size} لونًا)")
    
    # 3. استخراج المنحنيات لكل الإطارات
    t0 = time.time()
    curves_list = []
    for frame in frames:
        curves = extract_curves(frame, palette, args.epsilon, args.min_area)
        curves_list.append(curves)
    extract_time = time.time() - t0
    print(f"تم استخراج المنحنيات في {extract_time:.1f} ثانية")
    
    # 4. بناء SVG بحركة حقيقية
    t0 = time.time()
    svg_html = build_svg_with_real_motion(frames, palette, curves_list, W, H, fps)
    svg_time = time.time() - t0
    
    svg_path = os.path.join(args.output_dir, 'animation.html')
    with open(svg_path, 'w', encoding='utf-8') as f:
        f.write(svg_html)
    
    size_svg = os.path.getsize(svg_path)
    print(f"حجم SVG/HTML: {size_svg} بايت")
    
    # 5. ترميز AV1
    t0 = time.time()
    av1_output = os.path.join(args.output_dir, 'reference_av1.mkv')
    ffmpeg_cmd = [
        'ffmpeg', '-hide_banner', '-nostdin', '-y',
        '-i', args.input_video,
        '-c:v', 'libsvtav1',
        '-preset', str(args.preset),
        '-crf', str(args.crf),
        '-g', '240',
        '-svtav1-params', 'tune=0',
        '-an',
        av1_output
    ]
    subprocess.run(ffmpeg_cmd, check=True, capture_output=True)
    av1_time = time.time() - t0
    
    size_av1 = os.path.getsize(av1_output)
    print(f"حجم AV1: {size_av1} بايت")
    
    # 6. النتائج
    results = {
        'input': args.input_video,
        'resolution': f"{W}x{H}",
        'n_frames': n_frames,
        'fps': fps,
        'size_svg': size_svg,
        'size_av1': size_av1,
        'svg_smaller': size_svg < size_av1,
        'ratio_svg_to_av1': size_svg / max(size_av1, 1),
        'decode_time': decode_time,
        'extract_time': extract_time,
        'svg_time': svg_time,
        'av1_time': av1_time
    }
    
    with open(os.path.join(args.output_dir, 'results.json'), 'w', encoding='utf-8') as f:
        json.dump(results, f, indent=2, ensure_ascii=False)
    
    print("\n=== النتائج ===")
    print(f"SVG/HTML: {size_svg} بايت")
    print(f"AV1: {size_av1} بايت")
    print(f"النسبة: {results['ratio_svg_to_av1']:.4f}")
    print(f"الأصغر: {'SVG' if results['svg_smaller'] else 'AV1'}")


if __name__ == '__main__':
    main()