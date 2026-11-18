"""Build MapLibre SDF glyph ranges (PBF) for map labels from the bundled Inter font.

The map style has no font server, so its glyphs ship in public/glyphs/<stack>/<start>-<end>.pbf.
Usage: python3 scripts/glyphs/build.py   (needs freetype-py, numpy, scipy, fonttools, brotli)
"""
import io
import os
import sys

import freetype
import numpy as np
from fontTools.ttLib import TTFont
from scipy.ndimage import distance_transform_edt

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
STACK = 'Inter SemiBold'
SOURCES = [
    os.path.join(ROOT, 'node_modules/@fontsource/inter/files/inter-latin-600-normal.woff2'),
    os.path.join(ROOT, 'node_modules/@fontsource/inter/files/inter-latin-ext-600-normal.woff2'),
]
SIZE = 24  # px, what MapLibre expects
BUFFER = 3
RADIUS = 8
CUTOFF = 0.25
RANGES = [0, 256, 8192]  # Basic Latin + Latin-1, Latin Extended-A, General Punctuation


def varint(n):
    out = bytearray()
    while True:
        b = n & 0x7F
        n >>= 7
        if n:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)


def zigzag(n):
    return (n << 1) ^ (n >> 31)


def field(num, wire, payload):
    key = varint((num << 3) | wire)
    if wire == 0:
        return key + varint(payload)
    return key + varint(len(payload)) + payload


def load_faces():
    faces = []
    for path in SOURCES:
        f = TTFont(path)
        f.flavor = None
        buf = io.BytesIO()
        f.save(buf)
        face = freetype.Face(io.BytesIO(buf.getvalue()))
        face.set_pixel_sizes(0, SIZE)
        faces.append(face)
    return faces


def sdf(bitmap):
    h, w = bitmap.shape
    padded = np.zeros((h + 2 * BUFFER, w + 2 * BUFFER), dtype=np.float64)
    padded[BUFFER:BUFFER + h, BUFFER:BUFFER + w] = bitmap / 255.0
    inside = padded > 0.5
    outer = distance_transform_edt(~inside)
    inner = distance_transform_edt(inside)
    d = outer - inner
    v = 255 - 255 * (d / RADIUS + CUTOFF)
    return np.clip(np.round(v), 0, 255).astype(np.uint8)


def glyph(face, code):
    if face.get_char_index(code) == 0:
        return None
    face.load_char(chr(code), freetype.FT_LOAD_RENDER | freetype.FT_LOAD_TARGET_NORMAL)
    g = face.glyph
    bm = g.bitmap
    w, h = bm.width, bm.rows
    msg = field(1, 0, code)
    if w > 0 and h > 0:
        arr = np.array(bm.buffer, dtype=np.uint8).reshape(h, bm.pitch)[:, :w]
        msg += field(2, 2, sdf(arr).tobytes())
    msg += field(3, 0, w) + field(4, 0, h)
    msg += field(5, 0, zigzag(g.bitmap_left)) + field(6, 0, zigzag(g.bitmap_top - SIZE))
    msg += field(7, 0, round(g.advance.x / 64))
    return msg


def main():
    faces = load_faces()
    out_dir = os.path.join(ROOT, 'public/glyphs', STACK)
    os.makedirs(out_dir, exist_ok=True)
    for start in RANGES:
        end = start + 255
        stack = field(1, 2, STACK.encode()) + field(2, 2, f'{start}-{end}'.encode())
        n = 0
        for code in range(start, end + 1):
            for face in faces:
                g = glyph(face, code)
                if g:
                    stack += field(3, 2, g)
                    n += 1
                    break
        with open(os.path.join(out_dir, f'{start}-{end}.pbf'), 'wb') as fh:
            fh.write(field(1, 2, stack))
        print(f'{start}-{end}: {n} glyphs', file=sys.stderr)


if __name__ == '__main__':
    main()
