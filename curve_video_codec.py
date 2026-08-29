#!/usr/bin/env python3
"""
curve_video_codec.py
ترميز منحني زمني كامل لفيديو حقيقي.
يعالج المقطع كاملًا.
يضبط جودة المنحنيات تلقائيًا لتقترب من جودة AV1 عند نفس CRF.
"""
import argparse
import gzip
import json
import os
import subprocess
import sys
import time

import cv2
import numpy as np


def encode_curve(polygon, epsilon=1.5):
    peri = cv2.arcLength(polygon.astype(np.float32), True)
    if peri <= 0:
        return []
    eps = max(0.75, epsilon * peri / 1000.0)
    approx = cv2.approxPolyDP(polygon.astype(np.float32), eps, True)
    return approx.reshape(-1, 2).astype(np.int16).tolist()


def polygon_from_mask(mask, epsilon=1.5, min_area=20):
    contours, _ = cv2.findContours(
        mask.astype(np.uint8) * 255,
        cv2.RETR_EXTERNAL,
        cv2.CHAIN_APPROX_SIMPLE
    )
    polygons = []
    for cnt in contours:
        if cv2.contourArea(cnt) < min_area:
            continue
        poly = encode_curve(cnt.reshape(-1, 2), epsilon)
        if len(poly) >= 3:
            polygons.append(poly)
    return polygons


def build_global_palette(frames_rgb, palette_size=16):
    all_pixels = []
    step = max(1, (frames_rgb[0].shape[0] * frames_rgb[0].shape[1]) // 5000)
    for f in frames_rgb:
        all_pixels.append(f.reshape(-1, 3)[::step])
    pixels = np.concatenate(all_pixels, axis=0).astype(np.float32)

    cv2.setRNGSeed(20260829)
    criteria = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 50, 0.1)
    _, _, centers = cv2.kmeans(
        pixels, palette_size, None, criteria, 3, cv2.KMEANS_PP_CENTERS
    )
    palette = np.clip(np.rint(centers), 0, 255).astype(np.uint8)
    return palette


def extract_frame_regions(frame_rgb, palette, curve_epsilon=1.5, min_area=20):
    H, W = frame_rgb.shape[:2]
    pixels = frame_rgb.reshape(-1, 3).astype(np.int32)
    palette_int = palette.astype(np.int32)

    dists = np.sum((pixels[:, None, :] - palette_int[None, :, :]) ** 2, axis=2)
    labels = np.argmin(dists, axis=1).reshape(H, W)

    regions = []
    for lid in range(len(palette)):
        mask = (labels == lid)
        if mask.sum() < min_area:
            continue
        polygons = polygon_from_mask(mask, curve_epsilon, min_area)
        if polygons:
            regions.append({
                'fill_id': int(lid),
                'polygons': polygons
            })

    return regions, labels


def compare_regions(prev_regions, curr_regions, motion_threshold=0.30):
    commands = []

    prev_by_id = {r['fill_id']: r for r in prev_regions}
    curr_by_id = {r['fill_id']: r for r in curr_regions}

    all_ids = set(list(prev_by_id.keys()) + list(curr_by_id.keys()))

    for fid in all_ids:
        if fid not in prev_by_id:
            for poly in curr_by_id[fid]['polygons']:
                commands.append({
                    'op': 'add',
                    'fill_id': fid,
                    'polygons': [poly]
                })
        elif fid not in curr_by_id:
            commands.append({
                'op': 'remove',
                'fill_id': fid
            })
        else:
            prev_polys = prev_by_id[fid]['polygons']
            curr_polys = curr_by_id[fid]['polygons']

            prev_area = sum(
                cv2.contourArea(np.array(p, dtype=np.int32).reshape(-1, 1, 2))
                for p in prev_polys
            )
            curr_area = sum(
                cv2.contourArea(np.array(p, dtype=np.int32).reshape(-1, 1, 2))
                for p in curr_polys
            )

            if abs(prev_area - curr_area) / max(prev_area, 1) < motion_threshold:
                commands.append({
                    'op': 'keep',
                    'fill_id': fid
                })
            else:
                for poly in curr_polys:
                    commands.append({
                        'op': 'update',
                        'fill_id': fid,
                        'polygons': [poly]
                    })

    return commands


def get_video_dimensions(video_path, resolution=None):
    """قراءة أبعاد الفيديو بعد تطبيق scale=-2 إن لزم."""
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

    if resolution and resolution < H:
        out_h = resolution
        out_w = int(round(W * (out_h / H) / 2) * 2)
        if out_w < 2:
            out_w = 2
    else:
        out_w, out_h = W, H

    return out_w, out_h, fps


def decode_video_frames(video_path, resolution=None):
    out_w, out_h, fps = get_video_dimensions(video_path, resolution)

    vf = []
    if resolution and resolution < out_h:
        vf.append(f'scale={out_w}:{out_h}')

    cmd = ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-nostdin', '-i', video_path]
    if vf:
        cmd += ['-vf', ','.join(vf)]
    cmd += ['-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']

    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE)

    frame_bytes = out_w * out_h * 3
    frames = []

    while True:
        raw = proc.stdout.read(frame_bytes)
        if len(raw) < frame_bytes:
            break
        frame = np.frombuffer(raw, dtype=np.uint8).reshape(out_h, out_w, 3)
        frames.append(frame)

    proc.stdout.close()
    proc.wait()

    return frames, {'width': out_w, 'height': out_h, 'fps': fps, 'n_frames': len(frames)}


def measure_size(data):
    raw = json.dumps(data, separators=(',', ':')).encode('utf-8')
    compressed = gzip.compress(raw, compresslevel=9)
    return len(compressed)


def reconstruct_frame(base_regions, palette, commands, H, W):
    reconstructed = np.zeros((H, W, 3), dtype=np.uint8)

    regions = [r.copy() for r in base_regions]

    for cmd in commands:
        if cmd['op'] == 'add':
            regions.append({'fill_id': cmd['fill_id'], 'polygons': cmd['polygons']})
        elif cmd['op'] == 'remove':
            regions = [r for r in regions if r['fill_id'] != cmd['fill_id']]
        elif cmd['op'] == 'update':
            regions = [r for r in regions if r['fill_id'] != cmd['fill_id']]
            regions.append({'fill_id': cmd['fill_id'], 'polygons': cmd['polygons']})

    for region in regions:
        color = tuple(int(c) for c in palette[region['fill_id']])
        for poly in region['polygons']:
            pts = np.array(poly, dtype=np.int32).reshape(-1, 1, 2)
            cv2.fillPoly(reconstructed, [pts], color)

    return reconstructed


def compute_psnr(orig, recon):
    mse = np.mean((orig.astype(np.float64) - recon.astype(np.float64)) ** 2)
    if mse == 0:
        return float('inf')
    return 10 * np.log10((255.0 ** 2) / mse)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('input_video', help='مسار الفيديو الحقيقي')
    ap.add_argument('output_dir', help='مجلد النتائج')
    ap.add_argument('--resolution', type=int, default=None)
    ap.add_argument('--crf', type=int, default=30)
    ap.add_argument('--preset', type=int, default=8)
    ap.add_argument('--quality-levels', type=str, default='8,16,32,64',
                    help='مستويات palette للتجريب مفصولة بفواصل')
    args = ap.parse_args()

    os.makedirs(args.output_dir, exist_ok=True)

    print(f"=== بدء المعالجة: {args.input_video} ===")

    # 1. فك الفيديو كاملًا
    t0 = time.time()
    frames, info = decode_video_frames(
        args.input_video,
        resolution=args.resolution
    )
    decode_time = time.time() - t0
    H, W = info['height'], info['width']
    n_frames = info['n_frames']
    print(f"تم فك {n_frames} إطارًا ({W}x{H}) في {decode_time:.1f} ثانية")

    if n_frames == 0:
        print("خطأ: لا توجد إطارات مفكوكة", file=sys.stderr)
        sys.exit(1)

    # 2. ترميز AV1 المرجعي
    t0 = time.time()
    av1_output = os.path.join(args.output_dir, 'reference_av1.mkv')
    ffmpeg_cmd = [
        'ffmpeg', '-hide_banner', '-nostdin', '-y',
        '-i', args.input_video,
    ]
    if args.resolution and args.resolution < info['height']:
        ffmpeg_cmd += ['-vf', f'scale={W}:{H}']
    ffmpeg_cmd += [
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
    print(f"AV1 المرجعي: {size_av1} بايت في {av1_time:.1f} ثانية")

    # 3. فك AV1 المرجعي لقياس جودته بنفس الأبعاد
    av1_frames, _ = decode_video_frames(
        av1_output,
        resolution=None  # لا نغير الأبعاد لأننا بالفعل ضبطناها
    )
    av1_frames = av1_frames[:n_frames]

    # 4. قياس PSNR لـ AV1 المرجعي
    psnr_av1_list = []
    for orig, recon in zip(frames, av1_frames):
        psnr_av1_list.append(compute_psnr(orig, recon))
    psnr_av1 = np.mean([p for p in psnr_av1_list if p != float('inf')])
    print(f"PSNR لـ AV1 المرجعي: {psnr_av1:.2f} dB")

    # 5. تجربة مستويات جودة مختلفة للتمثيل المنحني
    quality_levels = [int(x) for x in args.quality_levels.split(',')]
    best_result = None

    for palette_size in quality_levels:
        # ضبط curve_epsilon حسب palette_size
        if palette_size >= 64:
            curve_epsilon = 0.5
        elif palette_size >= 32:
            curve_epsilon = 1.0
        elif palette_size >= 16:
            curve_epsilon = 1.5
        else:
            curve_epsilon = 2.5

        min_area = max(5, int(200 / palette_size))

        print(f"\n--- تجربة: palette={palette_size}, epsilon={curve_epsilon}, min_area={min_area} ---")

        t0 = time.time()
        sample_indices = np.linspace(0, n_frames - 1, min(10, n_frames), dtype=int)
        sample_frames = [frames[i] for i in sample_indices]
        palette = build_global_palette(sample_frames, palette_size)
        palette_time = time.time() - t0

        t0 = time.time()
        all_commands = []
        prev_regions = None

        for i, frame in enumerate(frames):
            regions, labels = extract_frame_regions(
                frame, palette, curve_epsilon, min_area
            )

            if i == 0:
                frame_data = {
                    'type': 'I',
                    'index': i,
                    'regions': regions
                }
                prev_regions = regions
            else:
                commands = compare_regions(prev_regions, regions)
                frame_data = {
                    'type': 'P',
                    'index': i,
                    'commands': commands
                }
                prev_regions = regions

            all_commands.append(frame_data)

        rep_time = time.time() - t0

        full_rep = {
            'version': 1,
            'width': W,
            'height': H,
            'fps': info['fps'],
            'n_frames': n_frames,
            'palette_rgb': palette.tolist(),
            'palette_size': palette_size,
            'curve_epsilon': curve_epsilon,
            'min_area': min_area,
            'frames': all_commands
        }

        size_rep = measure_size(full_rep)

        # إعادة بناء وقياس الجودة
        t0 = time.time()
        reconstructed_frames = []
        base_regions = all_commands[0]['regions']

        for frame_data in all_commands:
            if frame_data['type'] == 'I':
                commands = []
                base_regions = frame_data['regions']
            else:
                commands = frame_data['commands']

            recon = reconstruct_frame(
                base_regions,
                palette,
                commands,
                H, W
            )
            reconstructed_frames.append(recon)

        recon_time = time.time() - t0

        psnr_list = []
        for orig, recon in zip(frames, reconstructed_frames):
            psnr_list.append(compute_psnr(orig, recon))
        psnr_curve = np.mean([p for p in psnr_list if p != float('inf')])

        print(f"الحجم: {size_rep} بايت, PSNR: {psnr_curve:.2f} dB")

        # اختيار الأقرب لـ PSNR الخاص بـ AV1
        if best_result is None or abs(psnr_curve - psnr_av1) < abs(best_result['psnr'] - psnr_av1):
            best_result = {
                'palette_size': palette_size,
                'curve_epsilon': curve_epsilon,
                'min_area': min_area,
                'size_rep': size_rep,
                'psnr': psnr_curve,
                'rep': full_rep,
                'reconstructed': reconstructed_frames,
                'decode_time': decode_time,
                'palette_time': palette_time,
                'rep_time': rep_time,
                'recon_time': recon_time
            }

    # 6. النتيجة النهائية
    best = best_result
    print("\n=== النتائج النهائية ===")
    print(f"AV1: {size_av1} بايت, PSNR: {psnr_av1:.2f} dB")
    print(f"منحني: {best['size_rep']} بايت, PSNR: {best['psnr']:.2f} dB")
    print(f"المستوى المختار: palette={best['palette_size']}, epsilon={best['curve_epsilon']}, min_area={best['min_area']}")
    print(f"نسبة التوفير: {((size_av1 - best['size_rep']) / size_av1) * 100:.1f}%")

    # حفظ النتائج
    results = {
        'input': args.input_video,
        'resolution': f"{W}x{H}",
        'n_frames': n_frames,
        'crf': args.crf,
        'size_av1': size_av1,
        'psnr_av1': psnr_av1,
        'size_curve_rep': best['size_rep'],
        'psnr_curve': best['psnr'],
        'selected_palette_size': best['palette_size'],
        'selected_curve_epsilon': best['curve_epsilon'],
        'selected_min_area': best['min_area'],
        'compression_ratio': size_av1 / max(best['size_rep'], 1),
        'size_reduction_percent': ((size_av1 - best['size_rep']) / max(size_av1, 1)) * 100,
        'decode_time': decode_time,
        'av1_time': av1_time,
        'rep_time': best['rep_time'],
        'recon_time': best['recon_time']
    }

    with open(os.path.join(args.output_dir, 'results.json'), 'w', encoding='utf-8') as f:
        json.dump(results, f, indent=2, ensure_ascii=False)

    with gzip.open(os.path.join(args.output_dir, 'curve_rep.json.gz'), 'wb', compresslevel=9) as f:
        f.write(json.dumps(best['rep'], separators=(',', ':')).encode('utf-8'))

    if best['reconstructed']:
        cv2.imwrite(
            os.path.join(args.output_dir, 'reconstructed_frame.png'),
            cv2.cvtColor(best['reconstructed'][0], cv2.COLOR_RGB2BGR)
        )
        cv2.imwrite(
            os.path.join(args.output_dir, 'original_frame.png'),
            cv2.cvtColor(frames[0], cv2.COLOR_RGB2BGR)
        )

    print(f"\nالنتائج محفوظة في: {args.output_dir}")


if __name__ == '__main__':
    main()