#!/usr/bin/env python3
"""Render the opening title card.  usage: title_card.py out.png [width] [height]

PIL rather than ffmpeg's drawtext: the ffmpeg on this machine is built without freetype, so
drawtext does not exist. PIL is already a dependency of the crop step.
"""
import sys
from PIL import Image, ImageDraw, ImageFont

out = sys.argv[1]
W, H = int(sys.argv[2]) if len(sys.argv) > 2 else 1920, int(sys.argv[3]) if len(sys.argv) > 3 else 1080
BG, FG, MUTED, DIM = (13, 22, 34), (232, 238, 246), (159, 179, 204), (111, 131, 153)

def font(size: int):
    for path in ("/System/Library/Fonts/Supplemental/Arial Bold.ttf",
                 "/System/Library/Fonts/Supplemental/Arial.ttf",
                 "/System/Library/Fonts/Helvetica.ttc"):
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            continue
    return ImageFont.load_default()

im = Image.new("RGB", (W, H), BG)
d = ImageDraw.Draw(im)
lines = [("CanvassOS", 96, FG, -150), ("Door-knocking for a municipal campaign", 44, MUTED, -10),
         ("Middlesex Centre, Ontario", 34, DIM, 70)]
for text, size, colour, dy in lines:
    f = font(size)
    w = d.textbbox((0, 0), text, font=f)[2]
    d.text(((W - w) / 2, H / 2 + dy), text, font=f, fill=colour)
# a hairline under the wordmark, so the card is not three floating strings
d.rectangle([(W / 2 - 120, H / 2 - 40), (W / 2 + 120, H / 2 - 37)], fill=(47, 111, 221))
im.save(out)
