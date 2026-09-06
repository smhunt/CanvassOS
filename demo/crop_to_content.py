#!/usr/bin/env python3
"""Crop a screenshot down to the app itself.

The tablet captures were taken by rendering the app in an iframe at an exact device width inside a
wider window, so each one carries a large dead margin. ffmpeg's cropdetect only finds *black*
borders and the dead area here is the page's dark background, so this finds the bounding box of
everything that differs from the corner colour instead.
"""
import sys
from PIL import Image

def content_box(im: Image.Image, tol: int = 18):
    im = im.convert("RGB")
    w, h = im.size
    bg = im.getpixel((w - 2, h - 2))          # bottom-right is dead space in these captures
    px = im.load()
    def differs(x, y):
        r, g, b = px[x, y]
        return abs(r - bg[0]) > tol or abs(g - bg[1]) > tol or abs(b - bg[2]) > tol
    step = max(1, min(w, h) // 400)           # sampling grid; exact edges are not needed
    xs, ys = [], []
    for y in range(0, h, step):
        for x in range(0, w, step):
            if differs(x, y):
                xs.append(x); ys.append(y)
    if not xs:
        return (0, 0, w, h)
    pad = 8
    return (max(0, min(xs) - pad), max(0, min(ys) - pad),
            min(w, max(xs) + pad), min(h, max(ys) + pad))

if __name__ == "__main__":
    src, dst = sys.argv[1], sys.argv[2]
    im = Image.open(src)
    box = content_box(im)
    im.crop(box).save(dst)
    print(f"{im.size} -> {(box[2]-box[0], box[3]-box[1])}  {dst.split('/')[-1]}")
