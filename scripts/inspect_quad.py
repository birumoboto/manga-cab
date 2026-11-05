#!/usr/bin/env python3
"""What is inside a detected quad? Print the crop's structure.

This answers the question the whole layout depends on: is mokuro's
quad the TEXT's bounding box, or does it also contain the speech bubble
and the page around it?

Usage: python3 scripts/inspect_quad.py <volume-id> <page-index> [block]
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


def show(arr, cols=110):
    h, w = arr.shape[:2]
    rows = max(1, min(40, int(cols * h / w / 2.0)))
    out = []
    for r in range(rows):
        line = ""
        for c in range(cols):
            best = 0
            for yy in range(int(r * h / rows), max(int(r * h / rows) + 1, int((r + 1) * h / rows))):
                for xx in range(int(c * w / cols), max(int(c * w / cols) + 1, int((c + 1) * w / cols))):
                    best = max(best, int(arr[yy, xx]))
            line += " " if best > 205 else ("." if best > 155 else ("+" if best > 95 else ("#" if best > 45 else "@")))
        out.append(line)
    return out


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        return 1
    volume_id, page_index = sys.argv[1], int(sys.argv[2])
    block = int(sys.argv[3]) if len(sys.argv) > 3 else 0

    doc = json.loads(list((DATA / volume_id).glob("*.mokuro"))[0].read_text())
    page = doc["pages"][page_index]
    blk = page["blocks"][block]
    quad = blk["lines_coords"][0]
    p = DATA / volume_id / "pages" / pathlib.Path(page.get("img_path", "")).name
    img = Image.open(p).convert("L")
    a = np.asarray(img).astype(int)

    x0, y0, x1, y1 = (int(v) for v in quad_box(quad))
    crop = a[y0:y1, x0:x1]
    h, w = crop.shape
    print(f"page {page_index} block {block}  {'VERT' if blk.get('vertical') else 'horz'}")
    print(f"  quad = {w}x{h} at ({x0},{y0})   fs={blk.get('font_size')}")
    print(f"  text = {blk['lines'][0][:40]!r}")
    print(f"  crop histogram: " + ", ".join(
        f"{lo}-{hi}:{(crop >= lo).sum() * 100 // crop.size}%"
        for lo, hi in ((0, 32), (32, 96), (96, 160), (160, 224), (224, 256))))
    print("")

    # The ROW profile: how much ink is on each row of the crop?
    rowvar = crop.std(axis=1)
    print("  row std (high = content):")
    for i in range(0, h, max(1, h // 24)):
        bar = "#" * int(rowvar[i:i + max(1, h // 24)].mean() / 4)
        print(f"    y={i:>4} {bar}")
    print("")
    print("  the crop:")
    for L in show(crop):
        print("    " + L)
    return 0


if __name__ == "__main__":
    sys.exit(main())
