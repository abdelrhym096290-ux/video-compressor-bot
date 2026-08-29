#!/usr/bin/env python3
"""
image_compare.py
مقارنة عادلة بين تمثيلين لصورة حقيقية:
1. بكسلات خام
2. منحنيات فقط (كل منحنى يحمل لونه)
بدون ضغط، بدون قاموس ألوان.
"""
import argparse
import json
import os
import subprocess
import sys
import time
import urllib.request

import cv2
import numpy as np


def download_image(url, output_path):
    """تحميل صورة من رابط مباشر."""
    urllib.request.urlretrieve(url, output_path)


def encode_curve(polygon, epsilon=1.5):
    """تبسيط مضلع بحدود منحنية."""
    peri = cv2.arcLength(polygon.astype(np.float32), True)
    if peri <= 0:
        return []
    eps = max(0.5, epsilon * peri / 1000.0)
    approx = cv2.approxPolyDP(polygon.astype(np.float32), eps, True)
    return approx.reshape(-1, 2).astype(np.int16).tolist()


def extract_curves_from_image(image_bgr, epsilon=1.5):
    """
    استخراج منحنيات من صورة حقيقية.
    كل منحنى يحمل لونه الخاص.
    """
    H, W = image_bgr.shape[:2]
    
    # تحويل إلى RGB
    rgb = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2RGB)
    
    # تجميع الألوان المتشابهة
    # نستخدم تكميمًا بسيطًا لتقليل عدد الألوان
    quantized = (rgb // 32 * 32 + 16).astype(np.uint8)
    
    # استخراج المنحنيات لكل لون فريد
    curves = []
    unique_colors = np.unique(quantized.reshape(-1, 3), axis=0)
    
    for color in unique_colors:
        # إنشاء قناع لهذا اللون
        mask = np.all(quantized == color, axis=2).astype(np.uint8)
        
        if mask.sum() < 10:
            continue
        
        # استخراج الحدود
        contours, _ = cv2.findContours(
            mask * 255,
            cv2.RETR_EXTERNAL,
            cv2.CHAIN_APPROX_SIMPLE
        )
        
        for cnt in contours:
            if cv2.contourArea(cnt) < 10:
                continue
            
            poly = encode_curve(cnt.reshape(-1, 2), epsilon)
            if len(poly) >= 3:
                curves.append({
                    'color': [int(c) for c in color],
                    'points': poly,
                    'n_points': len(poly)
                })
    
    return curves


def measure_raw_size_pixels(image_bgr):
    """حجم الصورة كبكسلات خام."""
    H, W, C = image_bgr.shape
    return H * W * C


def measure_raw_size_curves(curves):
    """
    حجم التمثيل المنحني الخام.
    كل منحنى: لون (3 قيم) + نقاط (كل نقطة x,y)
    """
    total = 0
    for curve in curves:
        # اللون: 3 قيم
        total += 3
        # النقاط: عدد النقاط × 2
        total += curve['n_points'] * 2
    
    return total


def reconstruct_from_curves(curves, H, W):
    """إعادة بناء صورة من المنحنيات فقط."""
    reconstructed = np.zeros((H, W, 3), dtype=np.uint8)
    
    for curve in curves:
        color = tuple(curve['color'])
        pts = np.array(curve['points'], dtype=np.int32).reshape(-1, 1, 2)
        cv2.fillPoly(reconstructed, [pts], color)
    
    return reconstructed


def compute_psnr(orig, recon):
    """حساب PSNR بين صورتين."""
    mse = np.mean((orig.astype(np.float64) - recon.astype(np.float64)) ** 2)
    if mse == 0:
        return float('inf')
    return 10 * np.log10((255.0 ** 2) / mse)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('image_url', help='رابط الصورة الحقيقية')
    ap.add_argument('output_dir', help='مجلد النتائج')
    ap.add_argument('--epsilon', type=float, default=1.5, help='دقة المنحنيات')
    args = ap.parse_args()
    
    os.makedirs(args.output_dir, exist_ok=True)
    
    print(f"=== بدء المقارنة ===")
    
    # 1. تحميل الصورة
    image_path = os.path.join(args.output_dir, 'input_image.png')
    t0 = time.time()
    download_image(args.image_url, image_path)
    download_time = time.time() - t0
    print(f"تم تحميل الصورة في {download_time:.1f} ثانية")
    
    # 2. قراءة الصورة
    img_bgr = cv2.imread(image_path)
    if img_bgr is None:
        print(f"خطأ: تعذر قراءة الصورة: {image_path}", file=sys.stderr)
        sys.exit(1)
    
    H, W = img_bgr.shape[:2]
    print(f"أبعاد الصورة: {W}x{H}")
    
    # 3. قياس حجم البكسلات الخام
    t0 = time.time()
    size_pixels = measure_raw_size_pixels(img_bgr)
    pixels_time = time.time() - t0
    print(f"حجم البكسلات الخام: {size_pixels} وحدة")
    
    # 4. استخراج المنحنيات
    t0 = time.time()
    curves = extract_curves_from_image(img_bgr, args.epsilon)
    extract_time = time.time() - t0
    print(f"تم استخراج {len(curves)} منحنى في {extract_time:.1f} ثانية")
    
    # 5. قياس حجم المنحنيات
    size_curves = measure_raw_size_curves(curves)
    print(f"حجم المنحنيات الخام: {size_curves} وحدة")
    
    # 6. إعادة البناء
    t0 = time.time()
    reconstructed = reconstruct_from_curves(curves, H, W)
    recon_time = time.time() - t0
    
    # 7. قياس الجودة
    psnr = compute_psnr(img_bgr, reconstructed)
    print(f"PSNR لإعادة البناء: {psnr:.2f} dB")
    
    # 8. حفظ النتائج
    results = {
        'image_dimensions': f"{W}x{H}",
        'size_pixels_raw': size_pixels,
        'size_curves_raw': size_curves,
        'n_curves': len(curves),
        'n_curve_points': sum(c['n_points'] for c in curves),
        'ratio_curves_to_pixels': size_curves / max(size_pixels, 1),
        'pixels_smaller': size_pixels < size_curves,
        'curves_smaller': size_curves < size_pixels,
        'psnr': psnr,
        'epsilon': args.epsilon
    }
    
    with open(os.path.join(args.output_dir, 'results.json'), 'w', encoding='utf-8') as f:
        json.dump(results, f, indent=2, ensure_ascii=False)
    
    # حفظ إعادة البناء
    cv2.imwrite(
        os.path.join(args.output_dir, 'reconstructed.png'),
        reconstructed
    )
    cv2.imwrite(
        os.path.join(args.output_dir, 'original.png'),
        img_bgr
    )
    
    # حفظ منحنيات كملف
    with open(os.path.join(args.output_dir, 'curves.json'), 'w', encoding='utf-8') as f:
        json.dump({
            'width': W,
            'height': H,
            'curves': curves
        }, f, indent=2)
    
    print("\n=== النتائج ===")
    print(f"البكسلات: {size_pixels} وحدة")
    print(f"المنحنيات: {size_curves} وحدة")
    print(f"النسبة: {results['ratio_curves_to_pixels']:.4f}")
    print(f"الأصغر: {'بكسلات' if results['pixels_smaller'] else 'منحنيات'}")
    print(f"PSNR: {psnr:.2f} dB")


if __name__ == '__main__':
    main()