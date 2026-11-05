#!/usr/bin/env python3
"""Render a detected quad as a binary ink map, so the lettering can be seen.

Max-pooled ASCII hides everything — it shows the brightest pixel in each
cell, so a few stray white pixels look like content. This renders the
actual INK: the crop's background is found from its interior, and the
cells show the ink coverage.

Usage: python3 scripts/see_ink.py <volume-id> <page-index> [block] [line]
"""
import json
import sys
import pathlib

import numpy as np
from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parent.parent
DATA = ROOT / "data" / "_volumes"


def quad_box(quad):
    xs = [p[0] for p in quad]
    ys = [p[1] for p in quad]
    return min(xs), min(ys), max(xs), max(ys)


def render(arr, quad, cell_x=6, cell_y=10):
    x0, y0, x1, y1 = (int(v) for v in quad_box(quad))
    crop = arr[y0:y1, x0:x1]
    h, w = crop.shape

    # The background: the crop's median. Ink is what departs from it.
    bg = int(np.median(crop))
    dark = (bg - crop) > 40
    light = (crop - bg) > 40
    ink = dark if dark.sum() >= light.sum() else light

    cols = max(1, w // cell_x)
    rows = max(1, h // cell_y)
    out = []
    for r in range(rows):
        line = ""
        for c in range(cols):
            band = ink[r * cell_y:(r + 1) * cell_y, c * cell_x:(c + 1) * cell_x]
            frac = band.mean() if band.size else 0
            if frac > 0.45:
                line += "@"
            elif frac > 0.25:
                line += "#"
            elif frac > 0.10:
                line += "+"
            elif frac > 0.02:
                line += "."
            else:
                line += " "
        out.append(line)
    return out, w, h, bg


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        return 1
    volume_id, page_index = sys.argv[1], int(sys.argv[2])
    block = int(sys.argv[3]) if len(sys.argv) > 3 else 0
    line = int(sys.argv[4]) if len(sys.argv) > 4 else 0

    doc = json.loads(list((DATA / volume_id).glob("*.mokuro"))[0].read_text())
    page = doc["pages"][page_index]
    blk = page["blocks"][block]
    quad = blk["lines_coords"][line]
    p = DATA / volume_id / "pages" / pathlib.Path(page.get("img_path", "")).name
    arr = np.asarray(Image.open(p).convert("L")).astype(np.int16)

    text = blk["lines"][line] if line < len(blk["lines"]) else ""
    print(f"page {page_index} block {block} line {line}  "
          f"{'VERT' if blk.get('vertical') else 'horz'}  text={text!r}")
    print(f"  quad = {quad_box(quad)}  fs={blk.get('font_size')}")
    rows, w, h, bg = render(arr, quad)
    print(f"  crop {w}x{h}  background={bg}")
    print("")
    for i, L in enumerate(rows):
        print(f"  {i * 10:>4}|{L}")
    print("")
    return 0


if __name__ == "__main__":
    sys.exit(main())
