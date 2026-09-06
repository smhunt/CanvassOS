#!/usr/bin/env python3
"""Generate MapLibre glyph PBFs (SDF, range 0-255) from a local TTF so the map never
fetches fonts from a third party. Output: public/fonts/<stack>/0-255.pbf

Follows the tiny-sdf / fontnik conventions MapLibre expects: 24 px font, 3 px buffer,
radius 8, cutoff 0.25, `top` relative to a 27 px ascender line.

    python3 tools/make_glyphs.py
"""
from __future__ import annotations

import math
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

FONT_SIZE = 24
BUFFER = 3
RADIUS = 8.0
CUTOFF = 0.25
INF = 1e20

STACKS = {
    "Sans Bold": "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    "Sans Regular": "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
}


# ---------------------------------------------------------------- protobuf (hand-rolled)
def varint(n: int) -> bytes:
    out = bytearray()
    while True:
        b = n & 0x7F
        n >>= 7
        if n:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)


def zigzag(n: int) -> int:
    return (n << 1) ^ (n >> 31) if n < 0 else n << 1


def field_varint(num: int, val: int) -> bytes:
    return varint((num << 3) | 0) + varint(val)


def field_bytes(num: int, val: bytes) -> bytes:
    return varint((num << 3) | 2) + varint(len(val)) + val


# ---------------------------------------------------------------- distance transform (tiny-sdf port)
def edt1d(grid: list[float], offset: int, stride: int, length: int) -> None:
    f = [0.0] * length
    v = [0] * length
    z = [0.0] * (length + 1)
    v[0] = 0
    z[0] = -INF
    z[1] = INF
    f[0] = grid[offset]
    k = 0
    for q in range(1, length):
        f[q] = grid[offset + q * stride]
        q2 = q * q
        while True:
            r = v[k]
            s = (f[q] - f[r] + q2 - r * r) / (q - r) / 2
            if s <= z[k]:
                k -= 1
                if k > -1:
                    continue
            break
        k += 1
        v[k] = q
        z[k] = s
        z[k + 1] = INF
    k = 0
    for q in range(length):
        while z[k + 1] < q:
            k += 1
        r = v[k]
        qr = q - r
        grid[offset + q * stride] = f[r] + qr * qr


def edt(grid: list[float], width: int, height: int) -> None:
    for x in range(width):
        edt1d(grid, x, width, height)
    for y in range(height):
        edt1d(grid, y * width, 1, width)


# ---------------------------------------------------------------- glyph rendering
def render_glyph(font: ImageFont.FreeTypeFont, ch: str) -> bytes | None:
    try:
        x0, y0, x1, y1 = font.getbbox(ch, anchor="ls")
    except Exception:
        return None
    advance = font.getlength(ch)
    glyph_w = max(0, min(FONT_SIZE + BUFFER, x1 - x0))
    glyph_top = max(0, -y0)
    glyph_h = max(0, min(FONT_SIZE + BUFFER, glyph_top + max(0, y1)))
    if glyph_w == 0 or glyph_h == 0:
        # whitespace: advance only, no bitmap
        return (
            field_varint(1, ord(ch))
            + field_varint(3, 0)
            + field_varint(4, 0)
            + field_varint(5, zigzag(0))
            + field_varint(6, zigzag(-27))
            + field_varint(7, int(round(advance)))
        )
    width = glyph_w + 2 * BUFFER
    height = glyph_h + 2 * BUFFER
    img = Image.new("L", (width, height), 0)
    draw = ImageDraw.Draw(img)
    draw.text((BUFFER - x0, BUFFER + glyph_top), ch, font=font, fill=255, anchor="ls")
    px = img.load()
    n = width * height
    outer = [0.0] * n
    inner = [0.0] * n
    for y in range(height):
        for x in range(width):
            a = px[x, y] / 255.0
            i = y * width + x
            if a == 1.0:
                outer[i] = 0.0
                inner[i] = INF
            elif a == 0.0:
                outer[i] = INF
                inner[i] = 0.0
            else:
                outer[i] = max(0.0, 0.5 - a) ** 2
                inner[i] = max(0.0, a - 0.5) ** 2
    edt(outer, width, height)
    edt(inner, width, height)
    data = bytearray(n)
    for i in range(n):
        d = math.sqrt(outer[i]) - math.sqrt(inner[i])
        v = round(255 - 255 * (d / RADIUS + CUTOFF))
        data[i] = 0 if v < 0 else 255 if v > 255 else int(v)
    return (
        field_varint(1, ord(ch))
        + field_bytes(2, bytes(data))
        + field_varint(3, glyph_w)
        + field_varint(4, glyph_h)
        + field_varint(5, zigzag(x0))
        + field_varint(6, zigzag(glyph_top - 27))
        + field_varint(7, int(round(advance)))
    )


def build_stack(name: str, path: str, lo: int, hi: int) -> bytes:
    font = ImageFont.truetype(path, FONT_SIZE)
    glyphs = b""
    count = 0
    for code in range(lo, hi + 1):
        if code < 32 or 127 <= code < 160:
            continue
        g = render_glyph(font, chr(code))
        if g is None:
            continue
        glyphs += field_bytes(3, g)
        count += 1
    stack = field_bytes(1, name.encode()) + field_bytes(2, f"{lo}-{hi}".encode()) + glyphs
    print(f"{name}: {count} glyphs", file=sys.stderr)
    return field_bytes(1, stack)


def main() -> None:
    root = Path(__file__).resolve().parent.parent
    for name, path in STACKS.items():
        out_dir = root / "public" / "fonts" / name
        out_dir.mkdir(parents=True, exist_ok=True)
        out = out_dir / "0-255.pbf"
        out.write_bytes(build_stack(name, path, 0, 255))
        print(f"wrote {out} ({out.stat().st_size} bytes)", file=sys.stderr)


if __name__ == "__main__":
    main()
