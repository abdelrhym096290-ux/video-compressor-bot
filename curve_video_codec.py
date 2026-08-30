#!/usr/bin/env python3
"""
curve_video_codec.py
النسخة المعدلة: تعمل على فيديو أنمي حقيقي.
تطبق البروتوكول الكامل (مناطق + دلتا + نقاط + zlib) وتقارن مع AV1 حقيقي.
"""
from __future__ import annotations
import argparse
import json
import os
import struct
import subprocess
import sys
import zlib
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np
from sklearn.cluster import KMeans


def decode_video_frames(video_path, max_frames=None, resolution=None):
    """فك فيديو إلى إطارات RGB."""
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
    
    vf = []
    if resolution and resolution < H:
        out_h = resolution
        out_w = int(round(W * (out_h / H) / 2) * 2)
        vf.append(f'scale={out_w}:{out_h}')
    else:
        out_w, out_h = W, H
    
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
        
        if max_frames and len(frames) >= max_frames:
            break
    
    proc.stdout.close()
    proc.wait()
    
    return frames, {'width': out_w, 'height': out_h, 'fps': fps, 'n_frames': len(frames)}


def build_global_palette(frames, k):
    """قاموس ألوان مشترك عبر كل الإطارات."""
    samples = []
    for frame in frames:
        lab = cv2.cvtColor(frame, cv2.COLOR_RGB2LAB)
        flat = lab.reshape(-1, 3)
        idx = np.random.choice(len(flat), size=min(5000, len(flat)), replace=False)
        samples.append(flat[idx])
    all_samples = np.concatenate(samples, axis=0).astype(np.float64)
    km = KMeans(n_clusters=k, n_init=4, random_state=0)
    km.fit(all_samples)
    palette_lab = km.cluster_centers_.astype(np.uint8).reshape(1, k, 3)
    return cv2.cvtColor(palette_lab, cv2.COLOR_LAB2RGB).reshape(k, 3)


def quantize_frame(frame, palette_rgb):
    """يعيد صورة فهرس (H, W): لكل بكسل، رقم أقرب لون في القاموس."""
    h, w, _ = frame.shape
    flat = frame.reshape(-1, 3).astype(np.float32)
    pal = palette_rgb.astype(np.float32)
    dists = ((flat[:, None, :] - pal[None, :, :]) ** 2).sum(axis=2)
    return dists.argmin(axis=1).astype(np.uint8).reshape(h, w)


def extract_contours_for_color(index_map, color_idx, epsilon, min_area):
    mask = (index_map == color_idx).astype(np.uint8) * 255
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    polygons = []
    for c in contours:
        if cv2.contourArea(c) < min_area:
            continue
        approx = cv2.approxPolyDP(c, epsilon, True)
        polygons.append(approx.reshape(-1, 2))
    return polygons


@dataclass
class Shape:
    color_idx: int
    points: np.ndarray
    area: float
    centroid: tuple


def extract_shapes(index_map, k, epsilon, min_area):
    shapes = []
    for color_idx in range(k):
        mask = (index_map == color_idx).astype(np.uint8) * 255
        if not mask.any():
            continue
        contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        for c in contours:
            area = cv2.contourArea(c)
            if area < min_area:
                continue
            approx = cv2.approxPolyDP(c, epsilon, True).reshape(-1, 2)
            m = cv2.moments(c)
            cx = m["m10"] / m["m00"] if m["m00"] != 0 else approx[:, 0].mean()
            cy = m["m01"] / m["m00"] if m["m00"] != 0 else approx[:, 1].mean()
            shapes.append(Shape(color_idx, approx, area, (cx, cy)))
    return shapes


def diff_shapes(prev_shapes, curr_shapes, area_tolerance=0.25, centroid_tolerance=40.0):
    """يطابق أشكال إطارين متتاليين، ويصنّف كل شكل، ويحسب تكلفة أوامر الدلتا."""
    matched_prev, matched_curr = set(), set()
    events = {"unchanged": 0, "recolored": 0, "moved": 0, "added": 0, "removed": 0}
    cost = {"unchanged": 0, "recolored": 0, "moved": 0, "added": 0, "removed": 0}
    
    pairs = []
    for i, cs in enumerate(curr_shapes):
        for j, ps in enumerate(prev_shapes):
            area_diff = abs(cs.area - ps.area) / max(cs.area, ps.area, 1e-6)
            if area_diff > area_tolerance:
                continue
            dist = ((cs.centroid[0]-ps.centroid[0])**2 + (cs.centroid[1]-ps.centroid[1])**2) ** 0.5
            if dist > centroid_tolerance:
                continue
            pairs.append((dist, i, j))
    
    pairs.sort(key=lambda t: t[0])
    
    for dist, i, j in pairs:
        if i in matched_curr or j in matched_prev:
            continue
        matched_curr.add(i); matched_prev.add(j)
        cs, ps = curr_shapes[i], prev_shapes[j]
        moved = dist > 2.0
        recolored = cs.color_idx != ps.color_idx
        
        if moved:
            events["moved"] += 1; cost["moved"] += 6
        if recolored:
            events["recolored"] += 1; cost["recolored"] += 3
        if not moved and not recolored:
            events["unchanged"] += 1; cost["unchanged"] += 1
    
    for i, cs in enumerate(curr_shapes):
        if i not in matched_curr:
            events["added"] += 1
            cost["added"] += 3 + 4 * len(cs.points)
    
    for j, ps in enumerate(prev_shapes):
        if j not in matched_prev:
            events["removed"] += 1; cost["removed"] += 2
    
    return {"events": events, "cost_bytes": cost, "total_bytes": sum(cost.values())}


def psnr(a, b):
    mse = np.mean((a.astype(np.float64) - b.astype(np.float64)) ** 2)
    return float("inf") if mse == 0 else 20 * np.log10(255.0) - 10 * np.log10(mse)


def protocol_point_3_delta_stream(frames, k, epsilon, min_area, centroid_tolerance=40.0):
    """دلتا حقيقية بين الإطارات + ضغط zlib."""
    palette = build_global_palette(frames, k)
    all_shapes = [extract_shapes(quantize_frame(f, palette), k, epsilon, min_area) for f in frames]
    
    stream = bytearray()
    stream += struct.pack(">B", k)
    for c in palette:
        stream += struct.pack(">BBB", *[int(v) for v in c])
    
    for s in all_shapes[0]:
        stream += struct.pack(">BH", s.color_idx, len(s.points))
        for (x, y) in s.points:
            stream += struct.pack(">hh", int(x), int(y))
    
    per_frame_costs = []
    for i in range(1, len(all_shapes)):
        result = diff_shapes(all_shapes[i-1], all_shapes[i], centroid_tolerance=centroid_tolerance)
        per_frame_costs.append(result)
        stream += struct.pack(">H", result["total_bytes"])
    
    raw_bytes = bytes(stream)
    compressed = zlib.compress(raw_bytes, level=9)
    
    return {
        "palette": palette,
        "shapes": all_shapes,
        "raw_bytes": len(raw_bytes),
        "compressed_bytes": len(compressed),
        "per_frame_deltas": per_frame_costs,
    }


def run_full_protocol_on_video(video_path, k=12, epsilon=1.5, min_area=8.0, 
                                centroid_tolerance=40.0, crf_list=(28, 45, 55, 63),
                                max_frames=None, resolution=None):
    """البروتوكول الكامل على فيديو حقيقي."""
    
    frames, info = decode_video_frames(video_path, max_frames=max_frames, resolution=resolution)
    n_frames = len(frames)
    
    if n_frames == 0:
        raise ValueError("No frames decoded")
    
    delta_result = protocol_point_3_delta_stream(frames, k, epsilon, min_area, centroid_tolerance)
    
    our_total_bytes = delta_result["compressed_bytes"]
    
    palette = delta_result["palette"]
    recon_frames = []
    for frame in frames:
        idx_map = quantize_frame(frame, palette)
        recon = np.zeros_like(frame)
        for color_idx in range(k):
            if not (idx_map == color_idx).any():
                continue
            for poly in extract_contours_for_color(idx_map, color_idx, epsilon, min_area):
                if len(poly) < 3:
                    continue
                cv2.fillPoly(recon, [poly.astype(np.int32)], tuple(int(v) for v in palette[color_idx]))
        recon_frames.append(recon)
    
    our_psnr = sum(psnr(f, r) for f, r in zip(frames, recon_frames)) / len(frames)
    
    av1_results = []
    for crf in crf_list:
        out_mkv = f"av1_crf{crf}.mkv"
        subprocess.run([
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-i", video_path,
            "-c:v", "libsvtav1",
            "-preset", "8",
            "-crf", str(crf),
            "-g", "240",
            "-svtav1-params", "tune=0",
            "-an",
            out_mkv
        ], check=True)
        
        raw_size = os.path.getsize(out_mkv)
        compressed_size = len(zlib.compress(Path(out_mkv).read_bytes(), level=9))
        
        result = subprocess.run([
            "ffmpeg", "-hide_banner", "-loglevel", "info",
            "-i", out_mkv, "-i", video_path,
            "-lavfi", "[0:v][1:v]psnr",
            "-f", "null", "-",
        ], capture_output=True, text=True)
        
        av1_psnr = float("nan")
        for line in result.stderr.splitlines():
            if "average:" in line:
                for part in line.split():
                    if part.startswith("average:"):
                        av1_psnr = float(part.split(":")[1])
        
        av1_results.append({
            "crf": crf,
            "raw_size": raw_size,
            "compressed_size": compressed_size,
            "psnr": av1_psnr
        })
        
        os.remove(out_mkv)
    
    return {
        "n_frames": n_frames,
        "resolution": f"{info['width']}x{info['height']}",
        "fps": info['fps'],
        "our_total_bytes": our_total_bytes,
        "our_psnr": our_psnr,
        "delta_detail": delta_result["per_frame_deltas"],
        "av1_results": av1_results,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('input_video', help='مسار فيديو الأنمي الحقيقي')
    ap.add_argument('output_dir', help='مجلد النتائج')
    ap.add_argument('--k', type=int, default=12, help='حجم القاموس')
    ap.add_argument('--epsilon', type=float, default=1.5)
    ap.add_argument('--min-area', type=float, default=8.0)
    ap.add_argument('--centroid-tolerance', type=float, default=40.0)
    ap.add_argument('--max-frames', type=int, default=None)
    ap.add_argument('--resolution', type=int, default=None)
    args = ap.parse_args()
    
    os.makedirs(args.output_dir, exist_ok=True)
    
    print(f"=== بدء البروتوكول الكامل على: {args.input_video} ===")
    
    result = run_full_protocol_on_video(
        args.input_video,
        k=args.k,
        epsilon=args.epsilon,
        min_area=args.min_area,
        centroid_tolerance=args.centroid_tolerance,
        max_frames=args.max_frames,
        resolution=args.resolution
    )
    
    print("\n=== النتائج النهائية ===")
    print(f"الإطارات: {result['n_frames']}")
    print(f"الدقة: {result['resolution']}")
    print(f"تمثيلنا: {result['our_total_bytes']} بايت, PSNR={result['our_psnr']:.2f}dB")
    
    for av1 in result['av1_results']:
        print(f"  AV1 CRF={av1['crf']}: خام={av1['raw_size']} بايت, "
              f"بعد zlib={av1['compressed_size']} بايت, PSNR={av1['psnr']:.2f}dB")
    
    with open(os.path.join(args.output_dir, 'results.json'), 'w', encoding='utf-8') as f:
        json.dump(result, f, indent=2, ensure_ascii=False, default=str)
    
    print(f"\nالنتائج محفوظة في: {args.output_dir}")


if __name__ == "__main__":
    main()