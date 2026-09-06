#!/usr/bin/env python3
"""Generate the PWA icons (public/icons/icon-192.png, icon-512.png, maskable-512.png).
Plain monogram on a solid tile — no logos.   python3 tools/make_icons.py"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

FONT = "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf"
BG = (31, 78, 121)  # --brand
FG = (255, 255, 255)


def make(size: int, maskable: bool) -> Image.Image:
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if maskable:
        d.rectangle((0, 0, size, size), fill=BG)
        pad = size * 0.2
    else:
        r = size * 0.22
        d.rounded_rectangle((0, 0, size - 1, size - 1), radius=r, fill=BG)
        pad = size * 0.12
    font = ImageFont.truetype(FONT, int(size * (0.34 if maskable else 0.40)))
    text = "MC"
    x0, y0, x1, y1 = d.textbbox((0, 0), text, font=font)
    tw, th = x1 - x0, y1 - y0
    d.text(((size - tw) / 2 - x0, (size - th) / 2 - y0 - size * 0.02), text, font=font, fill=FG)
    # a thin underline "door" mark
    lw = size * 0.36
    ly = size / 2 + th / 2 + size * 0.06
    d.rounded_rectangle(((size - lw) / 2, ly, (size + lw) / 2, ly + size * 0.035), radius=size * 0.02, fill=FG)
    _ = pad
    return img


def main() -> None:
    out = Path(__file__).resolve().parent.parent / "public" / "icons"
    out.mkdir(parents=True, exist_ok=True)
    make(192, False).save(out / "icon-192.png")
    make(512, False).save(out / "icon-512.png")
    make(512, True).save(out / "maskable-512.png")
    make(180, False).save(out / "apple-touch-icon.png")
    print("icons written to", out)


if __name__ == "__main__":
    main()
