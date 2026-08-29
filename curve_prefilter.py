#!/usr/bin/env python3
import argparse, gzip, json, os, subprocess, sys
import cv2
import numpy as np

p = argparse.ArgumentParser()
p.add_argument('input')
p.add_argument('output')
p.add_argument('--palette-size', type=int, default=16, choices=[8,16,32])
p.add_argument('--curve-epsilon', type=float, default=0.002)
p.add_argument('--metadata', required=True)
p.add_argument('--block-size', type=int, default=16)
p.add_argument('--flat-threshold', type=float, default=6.0)
args = p.parse_args()

# Probe video geometry and frame rate.
probe = subprocess.run([
    'ffprobe','-v','error','-select_streams','v:0',
    '-show_entries','stream=width,height,r_frame_rate', '-of','csv=p=0', args.input
], capture_output=True, text=True, check=True).stdout.strip().split(',')
W, H = int(probe[0]), int(probe[1])
num, den = (probe[2].split('/') + ['1'])[:2]
fps = float(num) / float(den)
frame_bytes = W * H * 3

# Sample only an initial bounded number of frames to build a global palette.
sample_count = max(1, min(240, int(fps * 20)))
sample_cmd = ['ffmpeg','-hide_banner','-loglevel','error','-nostdin','-i',args.input,
              '-frames:v',str(sample_count),'-f','rawvideo','-pix_fmt','rgb24','-']
sample_raw = subprocess.run(sample_cmd, capture_output=True, check=True).stdout
sample = np.frombuffer(sample_raw, dtype=np.uint8)
if sample.size < frame_bytes:
    raise SystemExit('could not decode sample frames')
sample = sample[:sample.size // frame_bytes * frame_bytes].reshape(-1, H, W, 3)
pixels = np.concatenate([f.reshape(-1,3)[::max(1,(W*H)//5000)] for f in sample], axis=0).astype(np.float32)
cv2.setRNGSeed(20260829)
criteria=(cv2.TERM_CRITERIA_EPS+cv2.TERM_CRITERIA_MAX_ITER,40,0.2)
_, _, centers = cv2.kmeans(pixels, args.palette_size, None, criteria, 3, cv2.KMEANS_PP_CENTERS)
palette=np.clip(np.rint(centers),0,255).astype(np.uint8)

# Decode the input once and encode the adaptive output once.
dec = subprocess.Popen(['ffmpeg','-hide_banner','-loglevel','error','-nostdin','-i',args.input,
                        '-f','rawvideo','-pix_fmt','rgb24','-'], stdout=subprocess.PIPE)
os.makedirs(os.path.dirname(os.path.abspath(args.output)) or '.', exist_ok=True)
enc = subprocess.Popen(['ffmpeg','-hide_banner','-loglevel','error','-y','-f','rawvideo','-pix_fmt','rgb24',
                        '-s',f'{W}x{H}','-r',str(fps),'-i','-', '-an','-c:v','libx264','-preset','ultrafast','-crf','0',
                        '-pix_fmt','yuv444p', args.output], stdin=subprocess.PIPE)
records=[]; count=0
try:
    while True:
        raw=dec.stdout.read(frame_bytes)
        if len(raw) < frame_bytes: break
        frame=np.frombuffer(raw,dtype=np.uint8).reshape(H,W,3).copy()
        flat=frame.reshape(-1,3).astype(np.int16)
        dist=((flat[:,None,:]-palette[None,:,:].astype(np.int16))**2).sum(axis=2)
        labels=np.argmin(dist,axis=1).reshape(H,W)
        nearest=palette[labels]
        err=np.sqrt(np.mean((frame.astype(np.float32)-nearest.astype(np.float32))**2,axis=2))
        # Only simple blocks are replaced. Complex blocks retain original pixels.
        accepted=np.zeros((H,W),dtype=np.uint8)
        bs=args.block_size
        for y in range(0,H,bs):
            for x in range(0,W,bs):
                yy=min(H,y+bs); xx=min(W,x+bs)
                if float(err[y:yy,x:xx].mean()) <= args.flat_threshold:
                    accepted[y:yy,x:xx]=1
        out=frame.copy()
        out[accepted.astype(bool)]=nearest[accepted.astype(bool)]
        enc.stdin.write(out.tobytes())
        regions=[]
        for lid in range(args.palette_size):
            mask=((labels==lid)&(accepted>0)).astype(np.uint8)*255
            cs,_=cv2.findContours(mask,cv2.RETR_EXTERNAL,cv2.CHAIN_APPROX_SIMPLE)
            curves=[]
            for c in cs:
                if cv2.contourArea(c)<4: continue
                eps=max(0.75,args.curve_epsilon*cv2.arcLength(c,True))
                poly=cv2.approxPolyDP(c,eps,True).reshape(-1,2)
                if len(poly)>=3: curves.append(poly.tolist())
            if curves: regions.append({'fill_id':int(lid),'curves':curves})
        records.append({'type':'I' if count==0 else 'P','index':count,'accepted_ratio':float(accepted.mean()),'regions':regions})
        count+=1
finally:
    if enc.stdin: enc.stdin.close()
    enc.wait(); dec.stdout.close(); dec.wait()
if count==0 or enc.returncode!=0:
    raise SystemExit('encoding failed or no frames decoded')

package={'version':1,'mode':'adaptive-curve-prefilter','width':W,'height':H,'fps':fps,
         'palette_rgb':palette.tolist(),'frames':records,
         'parameters':{'palette_size':args.palette_size,'curve_epsilon':args.curve_epsilon,
                       'block_size':args.block_size,'flat_threshold':args.flat_threshold}}
raw=json.dumps(package,separators=(',',':')).encode('utf-8')
with gzip.open(args.metadata,'wb',compresslevel=9) as f: f.write(raw)
print(json.dumps({'frames':count,'width':W,'height':H,'fps':fps,'metadata_bytes':os.path.getsize(args.metadata)},ensure_ascii=False))
